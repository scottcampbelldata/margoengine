# Regenerates the synthetic EXR fixtures with the reference OpenEXR library (pip install OpenEXR numpy)
# and records reference digests for the downloaded real-world files.
#   python generate.py [folder-with-downloads]
import hashlib, json, os, struct, sys
import numpy as np
import OpenEXR

here = os.path.dirname(os.path.abspath(__file__))
W, H = 37, 45  # odd sizes so ZIP (16-line) and PIZ (32-line) blocks end with partial blocks
y, x = np.mgrid[0:H, 0:W].astype(np.float64)
rng = np.random.default_rng(7)
noise = rng.random((H, W))
# Smooth HDR gradients with a few hot pixels and exact zeros, plus noise so PIZ uses real Huffman tables.
r = (x / W) * 4 + noise * 0.01
g = np.exp2((y / H) * 20 - 8) * (1 + noise * 0.1)
b = np.where((x + y) % 7 == 0, 0.0, np.sin(x * 0.3) * np.cos(y * 0.2) * 3 + 3)
a = (x * y % 11) / 10
r[3, 5] = 60000.0; g[10, 20] = 1e6; b[44, 36] = 1e-6

configs = {
  'half-rgba': {'R': r.astype(np.float16), 'G': g.astype(np.float16), 'B': b.astype(np.float16), 'A': a.astype(np.float16)},
  'float-rgb': {'R': r.astype(np.float32), 'G': g.astype(np.float32), 'B': b.astype(np.float32)},
  'half-y': {'Y': g.astype(np.float16)},
  'mixed': {'R': r.astype(np.float16), 'G': g.astype(np.float32), 'B': (b * 1000).astype(np.uint32), 'A': a.astype(np.float16), 'Z': (r * 3).astype(np.float32)},
}
compressions = {'none': OpenEXR.NO_COMPRESSION, 'rle': OpenEXR.RLE_COMPRESSION, 'zips': OpenEXR.ZIPS_COMPRESSION, 'zip': OpenEXR.ZIP_COMPRESSION, 'piz': OpenEXR.PIZ_COMPRESSION}

def rgba(channels):
  if 'Y' in channels: c = [channels['Y']] * 3
  else: c = [channels['R'], channels['G'], channels['B']]
  c = [v.astype(np.float32) for v in c]
  c.append(channels['A'].astype(np.float32) if 'A' in channels else np.ones((H, W), np.float32))
  return np.stack(c, axis=-1).astype('<f4')

for name, channels in configs.items():
  rgba(channels).tofile(os.path.join(here, f'synthetic-{name}.f32'))
  for label, compression in compressions.items():
    header = {'compression': compression, 'type': OpenEXR.scanlineimage}
    with OpenEXR.File(header, {k: np.ascontiguousarray(v) for k, v in channels.items()}) as f:
      f.write(os.path.join(here, f'synthetic-{name}-{label}.exr'))

def digest(array):
  a = np.ascontiguousarray(array.astype('<f4'))
  bits = a.view('<u4').copy()
  bits[np.isnan(a)] = 0x7fc00000
  return hashlib.sha256(bits.tobytes()).hexdigest()

def rgbe_decode(path):
  # Independent reference RGBE decoder (adaptive RLE and flat scanlines).
  data = open(path, 'rb').read()
  pos = data.index(b'\n\n') + 2
  end = data.index(b'\n', pos)
  parts = data[pos:end].split()
  h, w = int(parts[1]), int(parts[3])
  pos = end + 1
  out = np.zeros((h, w, 4), np.float32)
  for row in range(h):
    scan = np.zeros((w, 4), np.uint8)
    if data[pos] == 2 and data[pos + 1] == 2:
      pos += 4
      for ch in range(4):
        xi = 0
        while xi < w:
          n = data[pos]; pos += 1
          if n > 128:
            scan[xi:xi + n - 128, ch] = data[pos]; pos += 1; xi += n - 128
          else:
            scan[xi:xi + n, ch] = np.frombuffer(data[pos:pos + n], np.uint8); pos += n; xi += n
    else:
      scan[:] = np.frombuffer(data[pos:pos + 4 * w], np.uint8).reshape(w, 4); pos += 4 * w
    e = scan[:, 3].astype(np.int32)
    scale = np.where(e == 0, 0.0, np.ldexp(1.0, e - 136))
    out[row, :, :3] = scan[:, :3] * scale[:, None]
    out[row, :, 3] = 1
  return out

downloads = sys.argv[1] if len(sys.argv) > 1 else here
reference = {}
for name in ['BrightRings.exr', 'AllHalfValues.exr']:
  path = os.path.join(downloads, name)
  if not os.path.exists(path): continue
  with OpenEXR.File(path) as f:
    ch = f.channels()
    rgb = ch['RGB'].pixels.astype(np.float32)
    hgt, wid = rgb.shape[:2]
    full = np.concatenate([rgb, np.ones((hgt, wid, 1), np.float32)], axis=-1)
    reference[name] = {'width': wid, 'height': hgt, 'compression': str(f.header()['compression']).split('.')[-1].replace('_COMPRESSION', ''), 'sha256': digest(full)}
path = os.path.join(downloads, 'spot1Lux.hdr')
if os.path.exists(path):
  img = rgbe_decode(path)
  reference['spot1Lux.hdr'] = {'width': img.shape[1], 'height': img.shape[0], 'sha256': digest(img), 'max': float(img[..., :3].max())}
if reference:
  json.dump(reference, open(os.path.join(here, 'reference.json'), 'w'), indent=2)
print('ok', sorted(os.listdir(here)))
