// Gaussian-splat PLY (the layout 3D Gaussian Splatting training writes: x y z, f_dc_0..2, f_rest_*, opacity,
// scale_0..2, rot_0..3) and the 32-byte .splat writer. Written from the PLY format description (Turk 1994) and the
// attribute meanings in Kerbl et al. 2023; no other implementation was read.
import { MargoError } from '@margoengine/math/errors';
import { SRGBToLinear as linear } from '@margoengine/math/color';
import { validateSplats, type SplatData } from './data.js';

/** Band-0 SH constant: colour = 0.5 + C0 * f_dc. */
const C0 = 0.2820947918;
const TYPES: Record<string, [size: number, read: (view: DataView, at: number) => number]> = {
  char: [1, (v, a) => v.getInt8(a)],
  int8: [1, (v, a) => v.getInt8(a)],
  uchar: [1, (v, a) => v.getUint8(a)],
  uint8: [1, (v, a) => v.getUint8(a)],
  short: [2, (v, a) => v.getInt16(a, true)],
  int16: [2, (v, a) => v.getInt16(a, true)],
  ushort: [2, (v, a) => v.getUint16(a, true)],
  uint16: [2, (v, a) => v.getUint16(a, true)],
  int: [4, (v, a) => v.getInt32(a, true)],
  int32: [4, (v, a) => v.getInt32(a, true)],
  uint: [4, (v, a) => v.getUint32(a, true)],
  uint32: [4, (v, a) => v.getUint32(a, true)],
  float: [4, (v, a) => v.getFloat32(a, true)],
  float32: [4, (v, a) => v.getFloat32(a, true)],
  double: [8, (v, a) => v.getFloat64(a, true)],
  float64: [8, (v, a) => v.getFloat64(a, true)],
};

/** Derivative of the sRGB-to-linear curve at `c` (0..1). */
const slope = (c: number): number => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.04045 ? 1 / 12.92 : (2.4 / 1.055) * ((x + 0.055) / 1.055) ** 1.4;
};

/**
 * Decodes a Gaussian-splat PLY (`format binary_little_endian` or `ascii`, one `vertex` element with `x y z`,
 * `f_dc_0..2`, optional `f_rest_*` (degree 1-3), `opacity` (logit), `scale_0..2` (log) and `rot_0..3` (w x y z)).
 * Opacity goes through the sigmoid, scales through exp, and rotation and scale become a covariance. Colours are
 * display (sRGB) values in these files, so the base colour is converted to linear exactly and the view-dependent
 * terms to first order around it (Margo's splat renderer works in linear). Coordinates are kept as stored: captures
 * trained in a Y-down camera frame need `transformSplats` with a 180-degree turn about X to stand up in Margo's Y-up.
 * @throws TypeError when `input` is not bytes; RangeError for a file that is not a splat PLY, names the missing
 * properties, or fails `validateSplats`; MargoError `unsupported` for big-endian or packed (chunked) PLY files.
 */
export function parsePly(input: ArrayBuffer | ArrayBufferView): SplatData {
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input))
    throw new TypeError('Expected .ply bytes; pass an ArrayBuffer or typed array of the file');
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  // The header is ASCII lines up to "end_header".
  const limit = Math.min(bytes.length, 65536);
  let headerEnd = -1;
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, limit));
  const marker = text.indexOf('end_header');
  if (text.startsWith('ply') && marker >= 0) headerEnd = text.indexOf('\n', marker) + 1;
  if (headerEnd <= 0) throw new RangeError('Not a PLY file: it must start with "ply" and have an end_header line.');
  const lines = text.slice(0, headerEnd).split(/\r?\n/);
  let format = '',
    count = -1,
    inVertex = false;
  const properties: { name: string; type: string }[] = [];
  for (const line of lines) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'format') format = words[1];
    else if (words[0] === 'element') {
      inVertex = words[1] === 'vertex';
      if (inVertex) count = Number(words[2]);
      else if (words[1] === 'chunk')
        throw new MargoError(
          'unsupported',
          'Packed (chunked) splat PLY files are not supported; export an uncompressed Gaussian-splat PLY.',
        );
    } else if (words[0] === 'property' && inVertex) {
      if (words[1] === 'list') throw new RangeError('Splat PLY vertex properties must be scalars, not lists.');
      if (!TYPES[words[1]])
        throw new RangeError(`Unknown PLY property type ${words[1]}; use float, double or an integer type.`);
      properties.push({ type: words[1], name: words[2] });
    }
  }
  if (format === 'binary_big_endian')
    throw new MargoError(
      'unsupported',
      'Big-endian PLY files are not supported; export binary_little_endian or ascii.',
    );
  if (format !== 'binary_little_endian' && format !== 'ascii')
    throw new RangeError(`Unknown PLY format ${format}; use binary_little_endian or ascii.`);
  if (!Number.isInteger(count) || count < 1 || count > 3_000_000)
    throw new RangeError('A splat PLY needs 1 to 3,000,000 vertices.');
  const index = new Map(properties.map((p, i) => [p.name, i]));
  const required = [
    'x',
    'y',
    'z',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
  ];
  const missing = required.filter((name) => !index.has(name));
  if (missing.length)
    throw new RangeError(`Not a Gaussian-splat PLY: missing ${missing.join(', ')}; export the splat attributes.`);
  let rest = 0;
  while (index.has(`f_rest_${rest}`)) rest++;
  const perChannel = rest / 3 + 1;
  if (rest % 3 || ![1, 4, 9, 16].includes(perChannel))
    throw new RangeError('Splat PLY f_rest_* must hold 3, 8 or 15 coefficients per colour channel (SH degree 1-3).');
  // Read every vertex's properties as numbers, from binary records or ascii lines.
  const width = properties.length,
    values = new Float64Array(count * width);
  if (format === 'ascii') {
    const body = new TextDecoder('latin1').decode(bytes.subarray(headerEnd)).trim().split(/\s+/);
    if (body.length < count * width)
      throw new RangeError('The ascii PLY has fewer values than its header promises; check that the file is complete.');
    for (let i = 0; i < count * width; i++) values[i] = Number(body[i]);
  } else {
    const offsets: number[] = [];
    let stride = 0;
    for (const p of properties) {
      offsets.push(stride);
      stride += TYPES[p.type][0];
    }
    if (bytes.length - headerEnd < count * stride)
      throw new RangeError('The PLY file is shorter than its header promises; check that it downloaded completely.');
    const view = new DataView(bytes.buffer, bytes.byteOffset + headerEnd, count * stride),
      readers = properties.map((p) => TYPES[p.type][1]);
    for (let i = 0; i < count; i++)
      for (let k = 0; k < width; k++) values[i * width + k] = readers[k](view, i * stride + offsets[k]);
  }
  const at = (name: string) => index.get(name)!,
    px = at('x'),
    dc = at('f_dc_0'),
    op = at('opacity'),
    sc = at('scale_0'),
    ro = at('rot_0'),
    restAt = rest ? at('f_rest_0') : 0,
    coefficients = perChannel - 1;
  const raw: GaussianAttributes = {
    count,
    positions: new Float32Array(count * 3),
    logScales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    dc: new Float32Array(count * 3),
    alphas: new Float32Array(count),
    rest: coefficients ? new Float32Array(count * coefficients * 3) : undefined,
  };
  for (let i = 0; i < count; i++) {
    const v = (k: number) => values[i * width + k];
    raw.positions.set([v(px), v(at('y')), v(at('z'))], i * 3);
    raw.rotations.set([v(ro), v(ro + 1), v(ro + 2), v(ro + 3)], i * 4);
    raw.logScales.set([v(sc), v(sc + 1), v(sc + 2)], i * 3);
    raw.dc.set([v(dc), v(dc + 1), v(dc + 2)], i * 3);
    raw.alphas[i] = 1 / (1 + Math.exp(-v(op)));
    // f_rest is channel-major (all of R, then G, then B); the shared layout puts the channel innermost.
    if (raw.rest)
      for (let c = 0; c < 3; c++)
        for (let j = 0; j < coefficients; j++)
          raw.rest[(i * coefficients + j) * 3 + c] = v(restAt + c * coefficients + j);
  }
  return splatsFromAttributes(raw);
}

/**
 * Gaussian-splat attributes as stored by the training PLY and the compressed formats, before they become
 * {@link SplatData}. Shared by the PLY, SPZ and SOG readers.
 */
export interface GaussianAttributes {
  count: number;
  /** Centres, 3 floats per splat. */
  positions: Float32Array;
  /** Natural log of the three axis scales, 3 floats per splat. */
  logScales: Float32Array;
  /** Rotations as (w, x, y, z), 4 floats per splat; normalised on conversion. */
  rotations: Float32Array;
  /** Band-0 spherical-harmonic coefficients (display colour = 0.5 + C0 * dc), 3 floats per splat. */
  dc: Float32Array;
  /** Opacity 0..1. */
  alphas: Float32Array;
  /** Bands 1 and up: `(perChannel - 1) * 3` floats per splat, coefficient-major with the colour channel innermost. */
  rest?: Float32Array;
}

/**
 * Converts raw Gaussian attributes to {@link SplatData}: normalised rotations, covariance from rotation and scale,
 * display-space colour to linear (exactly for the base band, to first order for the view-dependent terms). With
 * `linear: true` the stored colour is linear already and only clamps.
 * @throws RangeError for a zero rotation, an unsupported SH size, or a cloud that fails `validateSplats`.
 */
export function splatsFromAttributes(raw: GaussianAttributes, { linear: stored = false } = {}): SplatData {
  const { count } = raw,
    coefficients = raw.rest ? raw.rest.length / count / 3 : 0,
    perChannel = coefficients + 1;
  if (!Number.isInteger(coefficients) || ![0, 3, 8, 15].includes(coefficients))
    throw new RangeError(
      'Splat spherical harmonics must hold 3, 8 or 15 coefficients per colour channel (degree 1-3).',
    );
  const covariances = new Float32Array(count * 6),
    colors = new Float32Array(count * 4),
    sh = coefficients ? new Float32Array(count * perChannel * 3) : undefined;
  for (let i = 0; i < count; i++) {
    let w = raw.rotations[i * 4],
      x = raw.rotations[i * 4 + 1],
      y = raw.rotations[i * 4 + 2],
      z = raw.rotations[i * 4 + 3];
    const length = Math.hypot(w, x, y, z);
    if (!(length > 0)) throw new RangeError('A splat rotation is the zero quaternion; check the file.');
    w /= length;
    x /= length;
    y /= length;
    z /= length;
    writeCovariance(
      covariances,
      i,
      [x, y, z, w],
      [Math.exp(raw.logScales[i * 3]), Math.exp(raw.logScales[i * 3 + 1]), Math.exp(raw.logScales[i * 3 + 2])],
    );
    colors[i * 4 + 3] = raw.alphas[i];
    for (let c = 0; c < 3; c++) {
      // Display colour of the base band, converted to linear exactly.
      const display = 0.5 + C0 * raw.dc[i * 3 + c],
        clamped = Math.min(1, Math.max(0, display)),
        base = stored ? clamped : linear(clamped);
      colors[i * 4 + c] = base;
      if (!sh) continue;
      const k = stored ? 1 : slope(display);
      sh[i * perChannel * 3 + c] = (base - 0.5) / C0;
      for (let j = 1; j < perChannel; j++)
        sh[(i * perChannel + j) * 3 + c] = raw.rest![(i * coefficients + j - 1) * 3 + c] * k;
    }
  }
  const data: SplatData = sh
    ? { positions: raw.positions, covariances, colors, sphericalHarmonics: sh }
    : { positions: raw.positions, covariances, colors };
  validateSplats(data);
  return data;
}

/** Smallest axis variance a covariance keeps, as a share of its largest: above what Float32 rounding of the matrix moves. */
const FLATTEST = 2 ** -20;

/**
 * Covariance R S S^T R^T of splat `i` from a unit quaternion [x, y, z, w] and axis scales. Rounding to Float32 moves an
 * eigenvalue by up to 3 x 2^-24 of the largest, so a flatter splat, which training often leaves, would round to a matrix
 * that is not positive definite. An axis stays at FLATTEST of the largest: 1/1024 of its length, and at least a tiny
 * size for a splat of scale 0. Projection adds 0.3 px^2 to every ellipse, so the thin axis this lifts never shows.
 */
function writeCovariance(out: Float32Array, i: number, q: readonly number[], scale: readonly number[]): void {
  const [x, y, z, w] = q,
    r = [
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
    ],
    variance = [scale[0] * scale[0], scale[1] * scale[1], scale[2] * scale[2]],
    floor = Math.max(Math.max(...variance) * FLATTEST, 1e-30),
    s = variance.map((v) => Math.max(v, floor));
  let n = 0;
  for (let row = 0; row < 3; row++)
    for (let col = row; col < 3; col++)
      out[i * 6 + n++] =
        r[row * 3] * r[col * 3] * s[0] +
        r[row * 3 + 1] * r[col * 3 + 1] * s[1] +
        r[row * 3 + 2] * r[col * 3 + 2] * s[2];
}

/**
 * Eigen-decomposition of a symmetric 3x3 covariance (xx, xy, xz, yy, yz, zz) by cyclic Jacobi rotations: the axis
 * scales (square roots of the eigenvalues) and the rotation whose columns are the axes, as a unit quaternion.
 */
export function decomposeCovariance(c: ArrayLike<number>, at = 0): { scale: number[]; rotation: number[] } {
  const a = [
    [c[at], c[at + 1], c[at + 2]],
    [c[at + 1], c[at + 3], c[at + 4]],
    [c[at + 2], c[at + 4], c[at + 5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-30 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]))) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (a[p][q] === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]),
        t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
        cos = 1 / Math.sqrt(t * t + 1),
        sin = t * cos;
      for (let k = 0; k < 3; k++) {
        const kp = a[k][p],
          kq = a[k][q];
        a[k][p] = cos * kp - sin * kq;
        a[k][q] = sin * kp + cos * kq;
      }
      for (let k = 0; k < 3; k++) {
        const pk = a[p][k],
          qk = a[q][k];
        a[p][k] = cos * pk - sin * qk;
        a[q][k] = sin * pk + cos * qk;
      }
      for (let k = 0; k < 3; k++) {
        const kp = v[k][p],
          kq = v[k][q];
        v[k][p] = cos * kp - sin * kq;
        v[k][q] = sin * kp + cos * kq;
      }
    }
  }
  // A proper rotation: flip one axis when the eigenvector basis is a reflection.
  const det =
    v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) -
    v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) +
    v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  return {
    scale: [0, 1, 2].map((k) => Math.sqrt(Math.max(a[k][k], 0))),
    rotation: matrixToQuaternion(v),
  };
}

function matrixToQuaternion(m: number[][]): number[] {
  const trace = m[0][0] + m[1][1] + m[2][2];
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m[2][1] - m[1][2]) / s;
    y = (m[0][2] - m[2][0]) / s;
    z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s;
    x = s / 4;
    y = (m[0][1] + m[1][0]) / s;
    z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s;
    x = (m[0][1] + m[1][0]) / s;
    y = s / 4;
    z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s;
    x = (m[0][2] + m[2][0]) / s;
    y = (m[1][2] + m[2][1]) / s;
    z = s / 4;
  }
  const length = Math.hypot(x, y, z, w);
  return [x / length, y / length, z / length, w / length];
}

const toSRGB = (c: number) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
};

/**
 * Encodes a cloud as the 32-byte `.splat` layout `parseSplat` reads (xyz, axis scales, byte sRGB RGBA, byte wxyz
 * quaternion), for saving a cropped or edited cloud. Covariances are split into axis scales and a rotation;
 * spherical harmonics are not stored by this format, so the base (view-independent) colour is written.
 * @throws RangeError when `data` fails `validateSplats`.
 */
export function encodeSplat(data: SplatData): Uint8Array<ArrayBuffer> {
  const count = validateSplats(data),
    bytes = new Uint8Array(count * 32),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    const at = i * 32;
    for (let j = 0; j < 3; j++) view.setFloat32(at + j * 4, data.positions[i * 3 + j], true);
    const { scale, rotation } = decomposeCovariance(data.covariances, i * 6);
    for (let j = 0; j < 3; j++) view.setFloat32(at + 12 + j * 4, Math.max(scale[j], 1e-12), true);
    for (let j = 0; j < 3; j++) bytes[at + 24 + j] = Math.round(toSRGB(data.colors[i * 4 + j]) * 255);
    bytes[at + 27] = Math.round(data.colors[i * 4 + 3] * 255);
    const [x, y, z, w] = rotation;
    [w, x, y, z].forEach((c, j) => (bytes[at + 28 + j] = Math.min(255, Math.max(0, Math.round(c * 128 + 128)))));
  }
  return bytes;
}

/**
 * The stored Gaussian attributes of a cloud, the inverse of `splatsFromAttributes`: axis scales and rotation from
 * the covariance (`decomposeCovariance`), display colour from linear (exactly for the base band, to first order for
 * the view-dependent terms), for the SPZ and SOG writers.
 * @throws RangeError when `data` fails `validateSplats`.
 */
export function attributesFromSplats(data: SplatData): GaussianAttributes {
  const count = validateSplats(data),
    sh = data.sphericalHarmonics,
    perChannel = sh ? sh.length / count / 3 : 1,
    raw: GaussianAttributes = {
      count,
      positions: data.positions.slice(),
      logScales: new Float32Array(count * 3),
      rotations: new Float32Array(count * 4),
      dc: new Float32Array(count * 3),
      alphas: new Float32Array(count),
      ...(sh ? { rest: new Float32Array(count * (perChannel - 1) * 3) } : {}),
    };
  for (let i = 0; i < count; i++) {
    const { scale, rotation } = decomposeCovariance(data.covariances, i * 6),
      [x, y, z, w] = rotation;
    for (let a = 0; a < 3; a++) raw.logScales[i * 3 + a] = Math.log(Math.max(scale[a], 1e-30));
    raw.rotations.set([w, x, y, z], i * 4);
    raw.alphas[i] = data.colors[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      const base = sh ? 0.5 + C0 * sh[i * perChannel * 3 + c] : data.colors[i * 4 + c],
        display = toSRGB(base),
        k = slope(display);
      raw.dc[i * 3 + c] = (display - 0.5) / C0;
      for (let j = 1; j < perChannel; j++)
        raw.rest![(i * (perChannel - 1) + j - 1) * 3 + c] = sh![(i * perChannel + j) * 3 + c] / k;
    }
  }
  return raw;
}
