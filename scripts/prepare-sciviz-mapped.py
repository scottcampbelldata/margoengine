"""Offline NOAA demo subsets, clean room from WOA CSV and ROC ICD 2620002AA tables XVII-A/B.
Run from repository root: python scripts/prepare-sciviz-mapped.py. Network requests have 60s deadlines.
These are demo preparations, not general-purpose radar readers. Original files stay in the lane.
"""
import csv
import gzip
import hashlib
import json
import math
import pathlib
import struct
import urllib.request
import array

cache = pathlib.Path('test-results/batch173/job5')
out = pathlib.Path('examples/assets/sciviz')
cache.mkdir(parents=True, exist_ok=True)
out.mkdir(parents=True, exist_ok=True)


def download(name, url):
    path = cache / name
    if not path.exists():
        path.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    return path.read_bytes()


def emit(name, values, metadata, original):
    data = array.array('f', values).tobytes()
    (out / (name + '.bin')).write_bytes(data)
    metadata.update(license='Public domain, US Federal Government NOAA data; modified subset, no endorsement.',
                    originalSHA256=hashlib.sha256(original).hexdigest(),
                    dataSHA256=hashlib.sha256(data).hexdigest(), finite=sum(math.isfinite(v) for v in values))
    (out / (name + '.json')).write_text(json.dumps(metadata, indent=2) + '\n')
    print(name, metadata['finite'], 'finite samples', len(data), 'bytes')


woa_url = 'https://www.ncei.noaa.gov/data/oceans/woa/WOA23/DATA/temperature/csv/decav91C0/1.00/woa23_decav91C0_t00an01.csv.gz'
original = download('woa.csv.gz', woa_url)
lines = gzip.decompress(original).decode().splitlines()
depths = [float(v) for v in lines[1].split(':')[1].split(',')]
selected = [5500, 5000, 4000, 3000, 2000, 1000, 500, 200, 100, 50, 0]
lookup = {}
for row in csv.reader(lines[2:]):
    lat, lon = map(float, row[:2])
    lookup[lat, lon] = row[2:]
lats = [-79.5 + i * 5 for i in range(34)]
lons = [-179.5 + i * 5 for i in range(73)]
values = []
for depth in selected:
    index = depths.index(depth)
    for lat in lats:
        for lon in lons:
            row = lookup.get((lat, (lon + 180) % 360 - 180), [])
            values.append(float(row[index]) if index < len(row) and row[index].strip() else math.nan)
emit('woa23-shell', values, dict(source=woa_url, title='WOA23 1991-2020 annual analysed temperature (C)',
     longitude=[math.radians(v) for v in lons], latitude=[math.radians(v) for v in lats],
     radius=[1-depth/5500*.2 for depth in selected], depthMetres=selected,
     processing='Stride five degrees, 11 original depth levels, duplicated longitude seam. Radius depth exaggerated 231.67x, missing values remain NaN.'), original)

radar_url = 'https://unidata-nexrad-level2.s3.amazonaws.com/2013/05/20/KTLX/KTLX20130520_201643_V06.gz'
original = download('radar', radar_url)
raw = gzip.decompress(original)
sweeps = {}
offset = 24
while offset + 28 <= len(raw):
    size, channel, kind = struct.unpack_from('>HBB', raw, offset + 12)
    if kind == 31:
        start = offset + 28
        assert raw[start+16] == 0, 'This demo archive must have uncompressed Message 31 radials'
        azimuth = struct.unpack_from('>f', raw, start+12)[0]
        elevation = struct.unpack_from('>f', raw, start+24)[0]
        sweep = raw[start+22]
        count = struct.unpack_from('>H', raw, start+30)[0]
        for b in range(count):
            block = start + struct.unpack_from('>I', raw, start+32+b*4)[0]
            if raw[block:block+4] == b'DREF':
                gates, first, step = struct.unpack_from('>Hhh', raw, block+8)
                bits = raw[block+19]
                scale, bias = struct.unpack_from('>ff', raw, block+20)
                assert bits == 8 and scale > 0
                sweeps.setdefault(sweep, []).append((azimuth, elevation, first/1000, step/1000,
                                                    raw[block+28:block+28+gates], scale, bias))
    offset += 12+size*2 if kind == 31 else 2432
assert offset == len(raw)
# Distinct elevation sweeps, retaining actual measured ray geometry for each selected radial.
chosen = []
last = -100
for key, rays in sorted(sweeps.items()):
    mean = sum(r[1] for r in rays)/len(rays)
    if mean > last + .3:
        chosen.append(key)
        last = mean
    if len(chosen) == 6:
        break
assert len(chosen) == 6
azimuths = [200+i*3 for i in range(31)]
ranges = [10+i*2 for i in range(51)]
points, values = [], []
for key in chosen:
    rays = sweeps[key]
    for az in azimuths:
        ray = min(rays, key=lambda r: abs((r[0]-az+180)%360-180))
        angle, elev, first, step, gates, scale, bias = ray
        azr, elr = math.radians(angle), math.radians(elev)
        for distance in ranges:
            gate = round((distance-first)/step)
            value = gates[gate] if 0 <= gate < len(gates) else 0
            values.append((value-bias)/scale if value >= 2 else math.nan)
            points.extend([distance*math.cos(elr)*math.sin(azr), distance*math.cos(elr)*math.cos(azr), distance*math.sin(elr)])
point_data = array.array('f', points).tobytes()
(out / 'nexrad-curvilinear-points.bin').write_bytes(point_data)
emit('nexrad-curvilinear', values, dict(source=radar_url, title='KTLX 20 May 2013 20:16:43 UTC reflectivity (dBZ)',
     dims=[len(ranges), len(azimuths), len(chosen)], sweeps=chosen,
     pointsSHA256=hashlib.sha256(point_data).hexdigest(),
     processing='Nearest measured radials at 3 degree stride, exact measured azimuth/elevation per node, range 10..110 km stride 2 km. Scale/offset read per radial; below threshold and range folded gates are NaN. Straight rays, no atmospheric refraction or earth-curvature correction.'), original)
