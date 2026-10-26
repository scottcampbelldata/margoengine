// SPZ (compressed Gaussian splat) reader for versions 1-3. Written from the public SPZ format description (Niantic
// Spatial's SPZ documentation and the Khronos glTF extension notes); no other implementation was read.
import { MargoError } from '@margoengine/math/errors';
import type { SplatData } from './data.js';
import { type GaussianAttributes, splatsFromAttributes } from './ply.js';
import { inflate } from './zip.js';

/** Options for {@link parseSpz}. */
export interface ParseSpzOptions {
  /** Aborts decoding; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** SH coefficients per colour channel for SPZ degrees 0-3 (the degree-0 term lives in the colour). */
const REST_PER_CHANNEL = [0, 3, 8, 15];

/**
 * Decodes an SPZ file (versions 2 and 3, the gzip-compressed layout) to {@link SplatData}. Positions are 24-bit fixed
 * point, scales and colours are byte-quantised, rotations are 3 bytes (version 2) or the smallest-three 10-bit
 * packing (version 3), spherical harmonics are signed bytes. Splats keep the file's coordinate frame (SPZ stores
 * right-up-back, the same as Margo).
 * @throws TypeError when `input` is not bytes; RangeError for a damaged file, a wrong magic number or an unknown
 * version (version 1 stored float16 positions and is not read); MargoError `unsupported` for version 4 (Zstandard-compressed), which needs a Zstandard decoder this
 * package does not carry; convert it to version 3 first.
 * @example
 * const splats = await parseSpz(await (await fetch('scene.spz')).arrayBuffer());
 */
export async function parseSpz(
  input: ArrayBuffer | ArrayBufferView,
  options: ParseSpzOptions = {},
): Promise<SplatData> {
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input))
    throw new TypeError('Expected .spz bytes; pass an ArrayBuffer or typed array of the file');
  const file =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (file.length >= 8 && new DataView(file.buffer, file.byteOffset).getUint32(0, true) === 0x5053474e)
    throw new MargoError(
      'unsupported',
      'SPZ version 4 files are Zstandard-compressed and cannot be read here; re-export the scene as SPZ version 3 or 2.',
    );
  if (file.length < 2 || file[0] !== 0x1f || file[1] !== 0x8b)
    throw new RangeError('Not an SPZ file: versions 2 and 3 are gzip-compressed; check that the file is complete.');
  const bytes = await inflate(file, 'gzip', options.signal),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || view.getUint32(0, true) !== 0x5053474e)
    throw new RangeError('Not an SPZ file: the magic number is wrong; check that the file is complete.');
  const version = view.getUint32(4, true),
    count = view.getUint32(8, true),
    degree = bytes[12],
    fractionalBits = bytes[13];
  if (version < 2 || version > 3)
    throw new RangeError(`SPZ version ${version} is not supported; re-export the scene as SPZ version 3.`);
  if (!Number.isInteger(count) || count < 1 || count > 3_000_000)
    throw new RangeError('An SPZ file needs 1 to 3,000,000 splats.');
  if (degree > 3)
    throw new RangeError(`SPZ spherical-harmonic degree ${degree} is not supported; Margo draws degrees 0 to 3.`);
  const rest = REST_PER_CHANNEL[degree] * 3,
    rotationBytes = version === 3 ? 4 : 3;
  if (bytes.length < 16 + count * (9 + 1 + 3 + 3 + rotationBytes + rest))
    throw new RangeError('The SPZ data is shorter than its header promises; check that the file is complete.');
  const raw: GaussianAttributes = {
    count,
    positions: new Float32Array(count * 3),
    logScales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    dc: new Float32Array(count * 3),
    alphas: new Float32Array(count),
    rest: rest ? new Float32Array(count * rest) : undefined,
  };
  const alphaAt = 16 + count * 9,
    colorAt = alphaAt + count,
    scaleAt = colorAt + count * 3,
    rotationAt = scaleAt + count * 3,
    shAt = rotationAt + count * rotationBytes,
    unit = 1 / 2 ** fractionalBits;
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const p = 16 + i * 9 + a * 3,
        fixed = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
      raw.positions[i * 3 + a] = ((fixed << 8) >> 8) * unit;
      raw.dc[i * 3 + a] = (bytes[colorAt + i * 3 + a] / 255 - 0.5) / 0.15;
      raw.logScales[i * 3 + a] = bytes[scaleAt + i * 3 + a] / 16 - 10;
    }
    raw.alphas[i] = bytes[alphaAt + i] / 255;
    const r = rotationAt + i * rotationBytes;
    if (version === 3) {
      // Bits 31..30 name the dropped (largest) component (0 x, 1 y, 2 z, 3 w); the other three follow as 10-bit
      // sign-magnitude values, the highest-index component in the lowest bits.
      let packed = view.getUint32(r, true);
      const largest = packed >>> 30,
        q = [0, 0, 0, 0];
      let sum = 0;
      for (let k = 3; k >= 0; k--) {
        if (k === largest) continue;
        const magnitude = packed & 0x1ff,
          negative = (packed >>> 9) & 1;
        packed >>>= 10;
        const v = (Math.SQRT1_2 * magnitude) / 511;
        q[k] = negative ? -v : v;
        sum += v * v;
      }
      q[largest] = Math.sqrt(Math.max(0, 1 - sum));
      raw.rotations.set([q[3], q[0], q[1], q[2]], i * 4);
    } else {
      const x = bytes[r] / 127.5 - 1,
        y = bytes[r + 1] / 127.5 - 1,
        z = bytes[r + 2] / 127.5 - 1;
      raw.rotations.set([Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)), x, y, z], i * 4);
    }
    if (raw.rest) for (let k = 0; k < rest; k++) raw.rest[i * rest + k] = (bytes[shAt + i * rest + k] - 128) / 128;
  }
  return splatsFromAttributes(raw);
}
