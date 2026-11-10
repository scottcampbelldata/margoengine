// KV6 and Cube World CUB byte layouts, clean room from public notes and black-box
// byte probes. VMAX lives in vmax.ts to keep archive decoding optional at call time.
import type { Vec3 } from '@margoengine/math';
import { Colors, rgba, short, view } from './file-colors.js';
import type { VoxelFile } from './formats.js';
import { cellIndex, cellLimit, type GridLimits } from './grid.js';

export { parseVMAX, type VMAXFile, type VMAXNode, type VMAXModel, type VMAXOptions } from './vmax.js';

/** One KV6 model with the floating-point pivot retained in Y-up cell coordinates. */
export interface KV6File extends VoxelFile {
  pivot: Vec3;
}

/**
 * Reads KV6 surface records and implicit solid column interiors. File X stays X,
 * downward Z becomes upward Y, file Y becomes Z. BGRA colour words are opaque;
 * the fourth byte is lighting metadata, not alpha. Position is the negative pivot.
 */
export function parseKV6(input: Uint8Array | ArrayBuffer, limits: GridLimits = {}): KV6File {
  const bytes = view(input, 'parseKV6'),
    dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 32) short('KV6 header');
  if (dv.getUint32(0, true) !== 0x6c78764b) throw new TypeError('parseKV6 needs a Kvxl file; pass a KV6 document');
  const sx = dv.getUint32(4, true),
    sy = dv.getUint32(8, true),
    sz = dv.getUint32(12, true),
    count = dv.getUint32(28, true),
    columns = 32 + 8 * count,
    rows = columns + sx * 4,
    size: Vec3 = [sx, sz, sy],
    pivot: Vec3 = [dv.getFloat32(16, true), sz - dv.getFloat32(24, true), dv.getFloat32(20, true)];
  if (rows + sx * sy * 2 > bytes.length) short('KV6 columns');
  if (pivot.some((n) => !Number.isFinite(n)) || sz > 65536)
    throw new RangeError('KV6 pivot or height is invalid; save the file again');
  const colors = new Colors(cellLimit(limits)),
    cells = colors.add(size, pivot.map((n) => -n) as unknown as Vec3, undefined, 'KV6');
  let record = 0;
  for (let x = 0; x < sx; x++) {
    let plane = 0;
    for (let y = 0; y < sy; y++) {
      const n = dv.getUint16(rows + (x * sy + y) * 2, true);
      if (record + n > count) short('KV6 voxel records');
      plane += n;
      let previous = -1,
        previousColor = 0,
        bottom = true;
      for (let k = 0; k < n; k++, record++) {
        const at = 32 + 8 * record,
          z = dv.getUint16(at + 4, true),
          flags = bytes[at + 6],
          color = rgba(bytes[at + 2], bytes[at + 1], bytes[at], 255);
        if (z <= previous || z >= sz)
          throw new RangeError('KV6 heights are unsorted or outside the model; save the file again');
        if (!bottom)
          for (let fill = previous + 1; fill < z; fill++) cells[cellIndex(size, x, sz - 1 - fill, y)] = previousColor;
        cells[cellIndex(size, x, sz - 1 - z, y)] = color;
        previous = z;
        previousColor = color;
        bottom = !!(flags & 32);
      }
    }
    if (plane !== dv.getUint32(columns + x * 4, true))
      throw new RangeError('KV6 plane and column counts disagree; save the file again');
  }
  if (record !== count) throw new RangeError('KV6 voxel count disagrees with columns; save the file again');
  const end = rows + sx * sy * 2;
  if (end !== bytes.length && !(bytes.length === end + 772 && dv.getUint32(end, true) === 0x6c615053))
    throw new RangeError('KV6 trailer is damaged; save the file again');
  return { ...colors.finish(), pivot };
}

/**
 * Reads Cube World `.cub`: LE X/Y/Z sizes then RGB triples, X fastest,
 * Y next and Z last; black is air. The file and grid are both Y up.
 * CUB has no pivot or object placement, and no alpha channel.
 */
export function parseCUB(input: Uint8Array | ArrayBuffer, limits: GridLimits = {}): VoxelFile {
  const bytes = view(input, 'parseCUB'),
    dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) short('CUB header');
  const sx = dv.getUint32(0, true),
    sy = dv.getUint32(4, true),
    sz = dv.getUint32(8, true),
    size: Vec3 = [sx, sy, sz],
    colors = new Colors(cellLimit(limits));
  if (12 + sx * sy * sz * 3 !== bytes.length)
    throw new RangeError('CUB size does not match its RGB data; pass the complete file');
  const cells = colors.add(size, [0, 0, 0], undefined, 'CUB');
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const at = 12 + 3 * (x + sx * (y + sy * z)),
          r = bytes[at],
          g = bytes[at + 1],
          b = bytes[at + 2];
        if (r || g || b) cells[cellIndex(size, x, y, z)] = rgba(r, g, b, 255);
      }
  return colors.finish();
}
