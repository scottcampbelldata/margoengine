from hashlib import sha256
from pathlib import Path
from struct import unpack_from
from zipfile import ZipFile

from PIL import Image, ImageDraw

directory = Path('qa-output/the-climate-globe')
archive = directory / 'ne_50m_coastline.zip'
expected = '640f805509b822f57f4840a2e18d9ff2412cf1cf6976124701c2789436166fde'
assert sha256(archive.read_bytes()).hexdigest() == expected
with ZipFile(archive) as source:
    record = source.read('ne_50m_coastline.shp')
assert unpack_from('>i', record, 0)[0] == 9994

width, height = 1024, 512
factor = 3
image = Image.new('L', (width * factor, height * factor), 0)
draw = ImageDraw.Draw(image)
cursor = 100
paths = vertices = 0
while cursor < len(record):
    _, words = unpack_from('>ii', record, cursor)
    end = cursor + 8 + 2 * words
    tag = unpack_from('<i', record, cursor + 8)[0]
    assert tag == 3 and end <= len(record)
    parts, points = unpack_from('<ii', record, cursor + 44)
    starts = [*unpack_from('<' + 'i' * parts, record, cursor + 52), points]
    coords = cursor + 52 + 4 * parts
    for i in range(parts):
        args = []
        for pt in range(starts[i], starts[i + 1]):
            lon, lat = unpack_from('<dd', record, coords + pt * 16)
            x = (lon + 180) / 360 * width * factor
            y = (90 - lat) / 180 * height * factor
            if args and abs(x - args[-1][0]) > width * factor / 2:
                draw.line(args, fill=255, width=4, joint='curve')
                args = []
            args.append((x, y))
        if len(args) >= 2:
            draw.line(args, fill=255, width=4, joint='curve')
            paths += 1
            vertices += len(args)
    cursor = end

assert cursor == len(record) and paths > 100 and vertices > 20000
resampled = image.resize((width, height), Image.Resampling.LANCZOS)
target = Path('src/the-climate-globe/assets/coast.png')
resampled.save(target, optimize=True)
print(paths, vertices, target.stat().st_size, sha256(target.read_bytes()).hexdigest())
