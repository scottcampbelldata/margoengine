"""Writer-produced interoperability fixtures. No writer source is inspected or copied.
Run with Python 3.13 and numcodecs/numpy installed (or in test-results/batch175-tools).
"""
import sys
from pathlib import Path
import json
sys.path.insert(0, str(Path('test-results/batch175-tools').resolve()))
import numpy as np
from numcodecs import Blosc, LZ4, Zstd
import lz4.block
import xxhash
import struct

root = Path('packages/sciviz/tests/fixtures/cloud-codecs')
root.mkdir(parents=True, exist_ok=True)
data = (np.arange(4099, dtype=np.uint16) // 5).tobytes()
(root / 'expected.bin').write_bytes(data)
records = []
for codec in ['blosclz', 'lz4', 'lz4hc', 'zlib', 'zstd']:
    for shuffle in [0, 1, 2]:
        name = f'{codec}-{shuffle}.blosc'
        compressed = Blosc(cname=codec, clevel=5, shuffle=shuffle, blocksize=1024).encode(np.frombuffer(data, dtype=np.uint16))
        (root / name).write_bytes(compressed)
        records.append(dict(name=name, codec='blosc', bytes=len(compressed)))
for codec in [LZ4(), Zstd()]:
    name = codec.codec_id + '.bin'
    compressed = codec.encode(data)
    (root / name).write_bytes(compressed)
    records.append(dict(name=name, codec=codec.codec_id, bytes=len(compressed)))
(root / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n')
packed = lz4.block.compress(data, store_size=False)
header = b'LZ4Block' + bytes([0x24]) + struct.pack('<III', len(packed), len(data), xxhash.xxh32(data, seed=0x9747b28c).intdigest() & 0xfffffff)
(root / 'n5-lz4-java.bin').write_bytes(header + packed + b'LZ4Block' + bytes([0x14]) + bytes(12))
print('wrote', len(records), 'independent codec fixtures, expected bytes', len(data))
