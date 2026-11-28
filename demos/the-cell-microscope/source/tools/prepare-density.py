"""Prepare the checked EMD-3164 display grid from the archived MRC file."""
from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
import gzip
import json
import struct

parser = ArgumentParser(description=__doc__)
parser.add_argument("archive", type=Path)
args = parser.parse_args()
compressed = args.archive.read_bytes()
data = gzip.decompress(compressed)
shape = struct.unpack_from("<10i", data)
lengths = struct.unpack_from("<3f", data, 40)
axes = struct.unpack_from("<3i", data, 64)
extra = struct.unpack_from("<i", data, 92)[0]
if shape != (256, 256, 256, 2, 0, 0, 0, 256, 256, 256) or axes != (1, 2, 3) or extra != 0:
    raise ValueError("Expected the EMD-3164 float32 volume in XYZ axis order")

x = list(range(68, 181, 4))
y = list(range(64, 185, 4))
z = list(range(44, 213, 4))
scale = 20000
step = [length / 64 for length in lengths]
values = [struct.unpack_from("<f", data, 1024 + 4 * (i + 256 * (j + 256 * k)))[0]
          for k in z for j in y for i in x]
integer = [round(value * scale) for value in values]
packed = bytes(value & 255 for value in integer) + bytes((value >> 8) & 255 for value in integer)
dest = Path(__file__).resolve().parent
asset = gzip.compress(packed, compresslevel=9, mtime=0)
(dest / "density.bin").write_bytes(asset)
record = {
    "id": "EMD-3164",
    "sample": "Bovine mitochondrial ATP synthase, state 1a",
    "source": "https://files.wwpdb.org/pub/emdb/structures/EMD-3164/map/emd_3164.map.gz",
    "license": "CC0-1.0",
    "sourceSha256": sha256(compressed).hexdigest(),
    "displaySha256": sha256(asset).hexdigest(),
    "originalShape": [256, 256, 256],
    "displayShape": [len(x), len(y), len(z)],
    "sampleCoordinates": [[x[0], x[-1], 4], [y[0], y[-1], 4], [z[0], z[-1], 4]],
    "fileToDisplayAxes": ["x", "y", "z"],
    "spacingAngstrom": step,
    "displayBoundsAngstrom": [dist for size, width in zip((x, y, z), step) for dist in (0, (len(size) - 1) * width)],
    "integerScale": scale,
    "maximumQuantizationError": max(abs(q / scale - v) for v, q in zip(values, integer)),
    "encoding": "gzip, signed little-endian int16 byte planes, display x fastest",
}
(dest / "density.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(len(asset), record)
