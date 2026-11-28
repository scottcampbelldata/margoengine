from gzip import compress
from hashlib import sha256
from json import dumps
from pathlib import Path
from struct import pack
from statistics import mean

from PIL import Image

source = Path('qa-output/the-contour-map/st-helens-utm10.tif')
checksum = 'd13d9499307969fc90ab55bdbc2ee18d408e5e17631b9eb68bb3207b65f117b7'
assert sha256(source.read_bytes()).hexdigest() == checksum
dem = Image.open(source)
assert dem.size == (256, 256) and dem.mode == 'F'
assert dem.tag_v2[33550][:2] == (59.375, 59.375)
assert dem.tag_v2[33922][3:5] == (554500.0, 5122200.0)
samples = list(dem.get_flattened_data())
raw = []
extent = 128
for row in range(extent):
    for col in range(extent):
        top = row * 512 + col * 2
        raw.append(round(mean([samples[top], samples[top + 1], samples[top + 256], samples[top + 257]]) * 4))
catalog = Path('src/the-contour-map/assets')
catalog.mkdir(parents=True, exist_ok=True)
(catalog / 'dem-helens.dat').write_bytes(compress(pack('<' + 'H' * len(raw), *raw), compresslevel=9, mtime=0))
peak = raw.index(max(raw))
metadata = {
    'name': 'Mount St. Helens 3DEP DEM, The National Map', 'resolution': extent, 'metersPerCell': 118.75,
    'originEasting': 554500.0, 'originNorthing': 5122200.0, 'crs': 'WGS 84 / UTM zone 10N (EPSG:32610)',
    'min': min(raw) / 4, 'max': max(raw) / 4, 'highest': [peak % extent, peak // extent],
    'retrieved': '2026-11-27', 'checksum': checksum, 'license': 'Public domain', 'url': 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=554500%2C5107000%2C569700%2C5122200&bboxSR=32610&imageSR=32610&size=256%2C256&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image',
}
(catalog / 'record.json').write_text(dumps(metadata, indent=2) + '\n', 'utf-8')
print(dumps({**metadata, 'bytes': (catalog / 'dem-helens.dat').stat().st_size}))
