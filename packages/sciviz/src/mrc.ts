import { rangeError } from '../../shared/errors.js';
import { scientificBytes } from './scientific-bytes.js';
import type { FileInput, FileOptions } from './file-source.js';
import type { ScientificImage } from './scientific-image.js';
export { imageGrid as mrcGrid, imageVolume as volumeFromMRC } from './scientific-image.js';

/** MRC2014 and CCP4 scalar, complex Fourier or packed density map, in file column/row/section order. */
export interface MRCMap extends ScientificImage {
  readonly data: Float32Array;
  readonly mode: number;
  readonly components: 1 | 2;
  readonly starts: readonly number[];
  readonly origin: readonly number[];
  readonly axisOrder: readonly number[];
  readonly cell: readonly number[];
  readonly angles: readonly number[];
  readonly sampling: readonly number[];
  readonly extendedHeader: Uint8Array;
  readonly labels: readonly string[];
  readonly statistics: { readonly min: number; readonly max: number; readonly mean: number; readonly rms: number };
  /** Select real, imaginary or magnitude for complex modes. Default magnitude. */
  image(component?: 'real' | 'imaginary' | 'magnitude'): ScientificImage;
}
const bad = (s: string): never => {
  throw rangeError(`MRC/CCP4: ${s}; check the MRC2014 header and payload`, 'sciviz');
};
const half = (v: number): number => {
  const s = v & 32768 ? -1 : 1,
    e = (v >> 10) & 31,
    m = v & 1023;
  return e === 31 ? (m ? NaN : s * Infinity) : s * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24);
};
/** Reads both endian orders, modes 0/1/2/3/4/6/12/101, axis mapping and triclinic cell geometry. */
export function parseMRC(bytes: Uint8Array, options: FileOptions = {}): MRCMap {
  options.signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array) || bytes.length < 1024 || bytes.length > (options.maxBytes ?? 64 * 1024 * 1024))
    bad('invalid bytes or maxBytes');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    modes = [0, 1, 2, 3, 4, 6, 12, 101];
  let little = bytes[212] === 68 || bytes[212] === 65;
  if (bytes[212] !== 17 && !little) {
    const plausible = (le: boolean) =>
      modes.includes(v.getInt32(12, le)) &&
      [0, 4, 8].every((p) => v.getInt32(p, le) > 0 && v.getInt32(p, le) < 2 ** 24);
    if (plausible(true) === plausible(false)) bad('ambiguous byte order');
    little = plausible(true);
  }
  const i = (p: number) => v.getInt32(p, little),
    f = (p: number) => v.getFloat32(p, little),
    dims: [number, number, number] = [i(0), i(4), i(8)],
    mode = i(12),
    components: 1 | 2 = mode === 3 || mode === 4 ? 2 : 1,
    starts = [i(16), i(20), i(24)],
    sampling = [i(28), i(32), i(36)],
    cell = [f(40), f(44), f(48)],
    angles = [f(52), f(56), f(60)],
    axisOrder = [i(64), i(68), i(72)];
  if (
    !modes.includes(mode) ||
    dims.some((n) => n <= 0) ||
    new Set(axisOrder).size !== 3 ||
    axisOrder.some((n) => n < 1 || n > 3) ||
    sampling.some((n) => n <= 0)
  )
    bad('dimensions, mode or axis mapping');
  if (cell.some((n) => !Number.isFinite(n) || n <= 0) || angles.some((n) => !Number.isFinite(n) || n <= 0 || n >= 180))
    bad('unit cell');
  const count = dims.reduce((a, b) => a * b, 1) * components,
    bpp = mode === 0 ? 1 : mode === 1 || mode === 3 || mode === 6 || mode === 12 ? 2 : mode === 101 ? 0.5 : 4,
    start = 1024 + i(92),
    rowBytes = Math.ceil(dims[0] / 2),
    payloadBytes = mode === 101 ? rowBytes * dims[1] * dims[2] : count * bpp;
  if (
    start < 1024 ||
    !Number.isSafeInteger(count) ||
    start + payloadBytes > bytes.length ||
    count * 4 > (options.maxBytes ?? 64 * 1024 * 1024)
  )
    bad('truncated or oversized data');
  const data = new Float32Array(count);
  for (let n = 0; n < count; n++) {
    if (!(n & 65535)) options.signal?.throwIfAborted();
    const x = n % dims[0],
      p = start + (mode === 101 ? Math.floor(n / dims[0]) * rowBytes + (x >> 1) : Math.floor(n * bpp));
    data[n] =
      mode === 0
        ? v.getInt8(p)
        : mode === 1 || mode === 3
          ? v.getInt16(p, little)
          : mode === 6
            ? v.getUint16(p, little)
            : mode === 12
              ? half(v.getUint16(p, little))
              : mode === 101
                ? (bytes[p] >> ((x & 1) * 4)) & 15
                : v.getFloat32(p, little);
  }
  const rad = Math.PI / 180,
    ca = Math.cos(angles[0] * rad),
    cb = Math.cos(angles[1] * rad),
    cg = Math.cos(angles[2] * rad),
    sg = Math.sin(angles[2] * rad),
    cy = (ca - cb * cg) / sg,
    cz2 = 1 - cb * cb - cy * cy;
  if (cz2 <= 0) bad('degenerate cell');
  const basis = [
    [cell[0] / sampling[0], 0, 0],
    [(cell[1] * cg) / sampling[1], (cell[1] * sg) / sampling[1], 0],
    [(cell[2] * cb) / sampling[2], (cell[2] * cy) / sampling[2], (cell[2] * Math.sqrt(cz2)) / sampling[2]],
  ];
  const origin = [f(196), f(200), f(204)];
  if (origin.some((n) => !Number.isFinite(n))) bad('nonfinite origin');
  const world = (index: readonly number[]) => {
    if (index.length < 3 || index.some((n) => !Number.isFinite(n))) bad('incomplete map index');
    return origin.map((o, j) => o + axisOrder.reduce((sum, a, k) => sum + (index[k] + starts[k]) * basis[a - 1][j], 0));
  };
  const labels = Array.from({ length: Math.max(0, Math.min(10, i(220))) }, (_, n) =>
    new TextDecoder().decode(bytes.subarray(224 + n * 80, 304 + n * 80)).replace(/[\0 ]+$/, ''),
  );
  return {
    data,
    dims,
    mode,
    components,
    starts,
    origin,
    axisOrder,
    cell,
    angles,
    sampling,
    world,
    extendedHeader: bytes.slice(1024, start),
    labels,
    statistics: { min: f(76), max: f(80), mean: f(84), rms: f(216) },
    image(component = 'magnitude') {
      if (!['real', 'imaginary', 'magnitude'].includes(component)) bad('unknown complex component');
      if (components === 1) return { data, dims, world };
      const out = new Float32Array(count / 2);
      for (let n = 0; n < out.length; n++)
        out[n] =
          component === 'real'
            ? data[2 * n]
            : component === 'imaginary'
              ? data[2 * n + 1]
              : Math.hypot(data[2 * n], data[2 * n + 1]);
      return { data: out, dims, world };
    },
  };
}
/** Loads a complete map, optionally gzip wrapped, within maxBytes. */
export async function readMRC(input: FileInput, options: FileOptions = {}): Promise<MRCMap> {
  return parseMRC(await scientificBytes(input, options), options);
}
