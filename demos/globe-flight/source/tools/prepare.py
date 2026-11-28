"""Rebuild the display maps and metre grids from the documented public inputs."""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent.parent

def bounds(source, samples):
    im = Image.open(source)
    assert im.mode == "F" and im.width == im.height == 512
    west, north = im.tag_v2[33922][3:5]
    step = im.tag_v2[33550][0]
    z = np.array(im)
    valid = np.isfinite(z) & (z >= -20) & (z < 4500)
    assert valid.mean() > .99 and z[valid].max() > 4100
    w, n = west + step / 2, north - step / 2
    return np.where(valid, z.clip(0, 4500), 0), dict(
        west=w, north=n, width=step * 511, height=step * 511, pixels=512, samples=samples
    )

def interp(grid, rows):
    span = np.linspace(0, grid.shape[0] - 1, rows)
    horizontal = np.stack([np.interp(span, np.arange(grid.shape[0]), line) for line in grid])
    return np.stack([np.interp(span, np.arange(grid.shape[0]), line) for line in horizontal.T], axis=-1)

def altitude_map(height, base, interval, run):
    dz_s, dz_e = np.gradient(height, run, run * .942)
    diagonal = np.hypot(dz_s, dz_e)
    shade = np.clip((-.53 * dz_s - .54 * dz_e + .66) /
                    np.sqrt(1 + diagonal * diagonal), .10, 1)
    # Avoid muddy aerial shadows while emphasizing the measured valleys.
    result = base * (.77 + shade * .34)[..., None]
    phase = np.abs((height + interval / 2) % interval - interval / 2)
    lines = np.clip(1 - phase / (interval * .048 + run * diagonal * .62), 0, 1) * (height > 25)
    contour = result * (1 - lines[..., None] * .49) + np.array([247, 221, 158]) * (lines[..., None] * .49)
    return result, contour

def rgb(image, size):
    return np.asarray(Image.open(image).convert("RGB").resize((size, size), Image.Resampling.LANCZOS), dtype=float)

def world_window(globe, frame, size):
    w = frame["west"] - frame["width"] / 1022
    n = frame["north"] + frame["height"] / 1022
    e = w + frame["width"] * 512 / 511
    s = n - frame["height"] * 512 / 511
    box = ((w + 180) * 15, (90 - n) * 15, (e + 180) * 15, (90 - s) * 15)
    return np.asarray(globe.transform((size, size), Image.Transform.EXTENT, box, Image.Resampling.BICUBIC), dtype=float)

def write_maps(output, prefix, base, contours, quality, opacity=None):
    for name, image in [("relief", base), ("contours", contours)]:
        tile = Image.fromarray(image.clip(0, 255).astype(np.uint8), "RGB")
        if opacity is not None:
            tile.putalpha(Image.fromarray(np.uint8(opacity * 255)))
        tile.save(output / f"{prefix}-{name}.webp", quality=quality)

def write_height(output, name, height, samples):
    pixels = np.rint(interp(height, samples)).astype("<i2").tobytes()
    (output / f"{name}-metres.bin").write_bytes(gzip.compress(pixels, mtime=0))

def main():
    parser = argparse.ArgumentParser()
    for name in ["world", "elevation", "imagery", "summit_elevation", "summit_imagery"]:
        parser.add_argument(name)
    args = parser.parse_args()
    output = HERE / "imagery"
    output.mkdir(exist_ok=True)
    globe = Image.open(args.world).convert("RGB")
    assert globe.size == (5400, 2700)
    globe.resize((768, 384), Image.Resampling.LANCZOS).save(output / "earth-start.webp", quality=76)
    globe.resize((2304, 1152), Image.Resampling.LANCZOS).save(output / "earth-detail.webp", quality=83)
    region, frame = bounds(args.elevation, 257)
    island_photos = rgb(args.imagery, 512)
    # Only carry imagery in cells confirmed as land by the elevation raster.
    oak = np.asarray(Image.fromarray(np.uint8(region > 1) * 255).filter(ImageFilter.MedianFilter(3)), dtype=float) / 255
    region *= oak
    valid = (island_photos.mean(axis=2) < 229) & (island_photos.mean(axis=2) > 9)
    island_photos = np.where(valid[..., None], island_photos, [.55*120,.66*120,.46*120])
    # Keep the patch's sea continuous with the orbit image beyond its bounds.
    island_map, region_lines = altitude_map(region, np.clip(island_photos * 1.16 + [4, 8, 4], 0, 255), 250, frame["width"] * 111120 / 511)
    ocean = world_window(globe, frame, 512)
    island_map = np.where(oak[..., None] > 0, island_map, ocean)
    region_lines = np.where(oak[..., None] > 0, region_lines, ocean)
    write_maps(output, "hawaii", island_map, region_lines, 80, oak)
    write_height(output, "hawaii", region, frame["samples"])

    summit, peak = bounds(args.summit_elevation, 193)
    size = 768
    peak_data = rgb(args.summit_imagery, size)
    peak_heights = interp(summit, size)
    detailed, detailed_lines = altitude_map(peak_heights, peak_data * 1.14 + [9, 8, 4], 250, peak["width"] * 111120 / (size - 1))
    # Blend the high-resolution orthophoto into the regional orthophoto in the outer 11%.
    a = (peak["west"] - frame["west"]) / frame["width"] * 511 + .5
    b = (frame["north"] - peak["north"]) / frame["height"] * 511 + .5
    c = a + peak["width"] / frame["width"] * 511
    d = b + peak["height"] / frame["height"] * 511
    center = np.linspace(0, 1, size)
    edge = np.clip(np.minimum(center, 1 - center) / .11, 0, 1)
    feather = np.minimum(edge[:,None], edge[None,:])[..., None]
    feather = feather * feather * (3 - 2 * feather)
    def regional_sample(image):
        return np.asarray(Image.fromarray(np.uint8(image.clip(0,255)), "RGB").transform(
            (size,size), Image.Transform.EXTENT, (a,b,c,d), Image.Resampling.BICUBIC), dtype=float)
    detailed = detailed * feather + regional_sample(island_map) * (1 - feather)
    detailed_lines = detailed_lines * feather + regional_sample(region_lines) * (1 - feather)
    write_maps(output, "summit", detailed, detailed_lines, 83)
    write_height(output, "summit", summit, peak["samples"])
    (HERE / "tools" / "georeference.json").write_text(json.dumps({"island": frame, "summit": peak}, indent=2) + "\n")

if __name__ == "__main__":
    main()
