"""Independent numerical oracle for the three recorded public scientific regions.
Uses binary numcodecs and Pillow installations only as black-box readers, never their source.
"""
import sys, json, gzip, struct, io
from pathlib import Path
sys.path.insert(0, str(Path('test-results/batch175-tools').resolve()))
import numpy as np
from numcodecs import Zstd, Blosc
from PIL import Image

root = Path('packages/sciviz/tests/fixtures/cloud-volumes')
for name in ['idr-lightsheet', 'openorganelle', 'hemibrain']:
    directory = root / name
    m = json.loads((directory / 'manifest.json').read_text())
    records = m['requests']
    def get(key, offset=None, length=None):
        matches = [r for r in records if r['key'] == key and r.get('range', {}).get('offset') == offset and r.get('range', {}).get('length') == length]
        if not matches:
            raise ValueError((key, offset, length))
        return (directory / matches[0]['file']).read_bytes() if matches[0]['file'] else None
    def metadata(key):
        return json.loads(get(key))
    output = np.empty(tuple(reversed(m['size'])), dtype='<f4')
    cache = {}
    if name == 'idr-lightsheet':
        group = metadata('zarr.json')['attributes']['ome']['multiscales'][0]
        selected = group['datasets'][m['selected']]['path']
        meta = metadata(selected + '/zarr.json')
        outer = meta['chunk_grid']['configuration']['chunk_shape']
        sharding = meta['codecs'][0]['configuration']
        chunk = sharding['chunk_shape']
        per_shard = [n // c for n, c in zip(outer, chunk)]
        codec = [c['name'] for c in sharding['codecs'] if c['name'] not in ['bytes']]
        dtype = np.dtype('<u2')
        def voxel(x, y, z):
            coordinates = [z, y, x]
            grid = tuple(p // n for p, n in zip(coordinates, chunk))
            if grid not in cache:
                shard_cell = [p // n for p, n in zip(grid, per_shard)]
                key = selected + '/c/' + '/'.join(map(str, shard_cell))
                index_bytes = np.prod(per_shard).item() * 16 + 4
                index = np.frombuffer(get(key, -index_bytes, index_bytes)[:-4], dtype='<u8').reshape(tuple(per_shard) + (2,))
                entry = index[tuple(p % n for p, n in zip(grid, per_shard))]
                raw = get(key, int(entry[0]), int(entry[1]))
                for c in reversed(codec):
                    raw = Zstd().decode(raw) if c == 'zstd' else Blosc().decode(raw)
                cache[grid] = np.frombuffer(raw, dtype=dtype).reshape(chunk)
            return cache[grid][tuple(p % n for p, n in zip(coordinates, chunk))]
    elif name == 'openorganelle':
        group = metadata('attributes.json')['multiscales'][0]
        selected = group['datasets'][m['selected']]['path']
        meta = metadata(selected + '/attributes.json')
        chunk = meta['blockSize']
        def voxel(x, y, z):
            grid = tuple(p // n for p, n in zip([x, y, z], chunk))
            if grid not in cache:
                raw = get(selected + '/' + '/'.join(map(str, grid)))
                rank = struct.unpack('>H', raw[2:4])[0]
                actual = struct.unpack('>' + 'I' * rank, raw[4:4 + rank * 4])
                payload = gzip.decompress(raw[4 + rank * 4:])
                cache[grid] = np.frombuffer(payload, dtype='>u2').reshape(tuple(reversed(actual)))
            return cache[grid][z % chunk[2], y % chunk[1], x % chunk[0]]
    else:
        meta = metadata('info')['scales'][m['selected']]
        chunk = meta['chunk_sizes'][0]
        grid_shape = [(n + c - 1) // c for n, c in zip(meta['size'], chunk)]
        sharding = meta['sharding']
        def voxel(x, y, z):
            cell = tuple(p // n for p, n in zip([x, y, z], chunk))
            if cell not in cache:
                morton, next_bit = 0, 0
                for bit in range(53):
                    for axis in range(3):
                        if 2 ** bit < grid_shape[axis]:
                            morton |= ((cell[axis] >> bit) & 1) << next_bit
                            next_bit += 1
                hashed = morton >> sharding['preshift_bits']
                mini = hashed & ((1 << sharding['minishard_bits']) - 1)
                shard = (hashed >> sharding['minishard_bits']) & ((1 << sharding['shard_bits']) - 1)
                key = meta['key'] + '/' + format(shard, 'x').zfill((sharding['shard_bits'] + 3) // 4) + '.shard'
                first, last = struct.unpack('<QQ', get(key, mini * 16, 16))
                index_end = (1 << sharding['minishard_bits']) * 16
                packed = get(key, first + index_end, last - first)
                index = np.frombuffer(gzip.decompress(packed), dtype='<u8').reshape(3, -1)
                ids = np.cumsum(index[0], dtype=np.uint64)
                position = list(map(int, ids)).index(morton)
                offset = index_end + sum(map(int, index[1, :position + 1])) + sum(map(int, index[2, :position]))
                payload = get(key, offset, int(index[2, position]))
                image = np.array(Image.open(io.BytesIO(payload)).convert('L'))
                actual = [min(c, n - p * c) for c, n, p in zip(chunk, meta['size'], cell)]
                cache[cell] = image.reshape(tuple(reversed(actual)))
            return cache[cell][z % chunk[2], y % chunk[1], x % chunk[0]]
    for z in range(m['size'][2]):
        for y in range(m['size'][1]):
            for x in range(m['size'][0]):
                output[z, y, x] = voxel(x + m['origin'][0], y + m['origin'][1], z + m['origin'][2])
    previous = np.frombuffer((directory / 'expected.f32').read_bytes(), dtype='<f4').reshape(output.shape)
    difference = float(np.max(np.abs(output - previous)))
    if name != 'hemibrain':
        assert np.array_equal(output, previous), (name, difference)
    else:
        # The existing direct floating IDCT and Pillow's integer IDCT round some values differently.
        # This measured lossy-decoder difference is recorded, not an exact pixel parity claim.
        assert difference == 1.0, (name, difference)
        (directory / 'reference.f32').write_bytes(output.tobytes())
    m['reference'] = dict(reader='Independent Python numcodecs/Pillow', maxSampleDifference=difference, samples=output.size)
    if name == 'idr-lightsheet':
        m['attribution'] = 'IDR idr0066, Voigt et al., mesoSPIM light-sheet microscopy'
    (directory / 'manifest.json').write_text(json.dumps(m, indent=2) + '\n')
    print(name, 'independent samples', output.size, 'max difference', difference, 'decoded chunks', len(cache))
