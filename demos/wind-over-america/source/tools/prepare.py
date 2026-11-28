"""Derive the chart and eight preserved NOAA U/V fields from their source files."""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import re
import struct
import zipfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

WEST, EAST, SOUTH, NORTH = -132.5, -60, 20, 57.5
NX, NY, DAYS = 30, 16, 8
WIND_UNIT = 0.025
SIZE = (1024, 512)
SOURCES = {
    "u.uwnd": "https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.dailyavgs/surface/uwnd.sig995.2024.nc",
    "v.vwnd": "https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.dailyavgs/surface/vwnd.sig995.2024.nc",
    "land.zip": "https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_land.zip",
    "lakes.zip": "https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_lakes.zip",
    "map.zip": "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_state_20m.zip",
}


def wind(source, var):
    text = source.read_text(encoding="ascii").replace("\r", "")
    declared = f"{var}.{var}[{DAYS}][{NY}][{NX}]"
    if declared not in text:
        raise ValueError(f"Unexpected NOAA dimensions in {source}")
    match = re.search(r"\ntime\[8\]\n([^\n]+)", text)
    start = dt.date(1800, 1, 1)
    dates = [start + dt.timedelta(hours=float(t)) for t in match[1].split(",")]
    if dates != [dt.date(2024, 1, j + 1) for j in range(DAYS)]:
        raise ValueError(f"Unexpected NOAA dates: {dates}")
    rows = re.findall(r"^\[(\d+)\]\[(\d+)\], (.*)$", text, re.MULTILINE)
    if len(rows) != DAYS * NY:
        raise ValueError(f"Incomplete NOAA rows in {source}")
    values = [None] * len(rows)
    for day, row, raw in rows:
        numbers = [float(val) for val in raw.split(",")]
        ints = [round(val / WIND_UNIT) for val in numbers]
        if len(numbers) != NX or max(abs(a - b * WIND_UNIT) for a, b in zip(numbers, ints)) >= .00003:
            raise ValueError(f"Unexpected precision in day {day} row {row}")
        values[int(day) * NY + NY - 1 - int(row)] = ints
    lat = [float(x) for x in re.search(r"\nlat\[16\]\n([^\n]+)", text)[1].split(",")]
    lon = [float(x) - 360 for x in re.search(r"\nlon\[30\]\n([^\n]+)", text)[1].split(",")]
    if lat[::-1] != [SOUTH+2.5*i for i in range(NY)] or lon != [WEST+2.5*i for i in range(NX)]:
        raise ValueError("Unexpected grid coordinates")
    return values, [day.isoformat() for day in dates]


def polygons(archive):
    with zipfile.ZipFile(archive) as files:
        path = next(path for path in files.namelist() if path.endswith(".shp"))
        data = files.read(path)
    if struct.unpack_from(">i", data)[0] != 9994:
        raise ValueError(f"Invalid ESRI shapefile: {archive}")
    offset = 100
    while offset + 8 < len(data):
        length = struct.unpack_from(">i", data, offset + 4)[0] * 2
        offset += 8
        end = offset + length
        if end > len(data):
            raise ValueError(f"Truncated shapefile: {archive}")
        loc = offset
        offset = end
        shape = struct.unpack_from("<i", data, loc)[0]
        if shape == 0:
            continue
        if shape not in (5, 15, 25):
            raise ValueError(f"Unexpected polygon type {shape} in {archive}")
        x0, y0, x1, y1, parts, count = struct.unpack_from("<4d2i", data, loc + 4)
        if x1 < WEST or x0 > EAST or y1 < SOUTH or y0 > NORTH:
            continue
        starts = struct.unpack_from(f"<{parts}i", data, loc + 44) + (count,)
        coords = struct.unpack_from(f"<{count * 2}d", data, loc + 44 + 4 * parts)
        for first, last in zip(starts[:-1], starts[1:]):
            ring = list(zip(coords[first * 2:last * 2:2], coords[first * 2 + 1:last * 2:2]))
            signed = sum(x * by - bx * y for (x, y), (bx, by) in zip(ring, ring[1:])) / 2
            if abs(signed) > .00035:
                yield ring, signed


def atlas(root, dest):
    scale = 2
    width, height = [side * scale for side in SIZE]

    def point(x, y):
        return ((x - WEST) * width / (EAST - WEST), (NORTH - y) * height / (NORTH - SOUTH))

    def mask(name):
        img = Image.new("L", (width, height))
        draw = ImageDraw.Draw(img)
        for ring, sign in sorted(polygons(root / name), key=lambda item: -abs(item[1])):
            draw.polygon([point(x, y) for x, y in ring], fill=255 if sign < 0 else 0)
        return img

    land = ImageChops.subtract(mask("land.zip"), mask("lakes.zip"))
    chart = Image.composite(Image.new("RGB", land.size, "#395049"), Image.new("RGB", land.size, "#102834"), land)
    coast = ImageChops.subtract(land.filter(ImageFilter.MaxFilter(7)), land.filter(ImageFilter.MinFilter(7)))
    chart.paste("#697b67", (0, 0), coast.point(lambda v: int(.69 * v)))
    boundaries = Image.new("L", land.size)
    draw = ImageDraw.Draw(boundaries)
    for ring, _ in polygons(root / "map.zip"):
        draw.line([point(x, y) for x, y in ring], fill=147, width=2)
    chart.paste("#85917a", (0, 0), ImageChops.multiply(boundaries, land))
    grid = Image.new("L", land.size)
    draw = ImageDraw.Draw(grid)
    for lon in range(-130, -59, 5):
        draw.line([point(lon, SOUTH), point(lon, NORTH)], fill=62 if lon % 10 == 0 else 32)
    for lat in range(20, 58, 5):
        draw.line([point(WEST, lat), point(EAST, lat)], fill=62 if lat % 10 == 0 else 32)
    chart.paste("#7f9490", (0, 0), grid)
    chart = chart.resize(SIZE, Image.Resampling.LANCZOS)
    chart.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(dest, optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path)
    parser.add_argument("assets", type=Path)
    args = parser.parse_args()
    u, dates = wind(args.sources / "u.uwnd", "uwnd")
    v, _ = wind(args.sources / "v.vwnd", "vwnd")
    packed = [
        value for day in range(DAYS) for field in (u, v)
        for row in field[day * NY:(day + 1) * NY] for value in row
    ]
    data = struct.pack(f"<{len(packed)}h", *packed)
    args.assets.mkdir(exist_ok=True, parents=True)
    (args.assets / "wind.bin").write_bytes(gzip.compress(data, mtime=0))
    atlas(args.sources, args.assets / "atlas.png")
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    record = {
        "dates": dates, "dims": [NX, NY], "extentDegrees": [WEST, EAST, SOUTH, NORTH],
        "velocityUnits": "m/s", "encodingStep": WIND_UNIT, "sigma": .995,
        "order": "per day U then V; longitude fastest; south to north; little-endian signed int16",
        "sources": {name: {"url": url, "sha256": sha(args.sources / name)} for name, url in SOURCES.items()},
        "derived": {p.name: sha(p) for p in args.assets.iterdir() if p.suffix in (".bin", ".png")},
    }
    (args.assets / "provenance.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

