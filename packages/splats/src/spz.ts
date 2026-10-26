// SPZ (compressed Gaussian splat) reader for versions 2-4. Written from the public SPZ format description (Niantic
// Spatial's SPZ documentation and the Khronos glTF extension notes); no other implementation was read.
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
 * Decodes an SPZ file (versions 2 and 3, the gzip-compressed layout, and version 4, a plain header, a table of
 * contents and one Zstandard stream per attribute) to {@link SplatData}. Positions are 24-bit fixed point, scales
 * and colours are byte-quantised, rotations are 3 bytes (version 2) or the smallest-three 10-bit packing (versions 3
 * and 4), spherical harmonics are signed bytes. Splats keep the file's coordinate frame (SPZ stores right-up-back,
 * the same as Margo). Version 4's Zstandard decoder is built in and loads only when a version 4 file is read.
 * @throws TypeError when `input` is not bytes; RangeError for a damaged file (including a failed Zstandard
 * checksum), a wrong magic number or an unknown version (version 1 stored float16 positions and is not read);
 * MargoError `unsupported` for a version 4 stream that needs a Zstandard dictionary.
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
    return decode(await unpackV4(file, options.signal), 4);
  if (file.length < 2 || file[0] !== 0x1f || file[1] !== 0x8b)
    throw new RangeError(
      'Not an SPZ file: it starts with neither gzip (versions 2-3) nor NGSP (version 4); check that the file is a complete .spz.',
    );
  return decode(await inflate(file, 'gzip', options.signal), 3);
}

/**
 * Unpacks an SPZ version 4 file (32-byte header, optional extensions, table of contents of `numStreams` entries of
 * compressed and uncompressed u64 sizes, then the Zstandard streams in order: positions, alphas, colours, scales,
 * rotations, spherical harmonics) into the version 3 body layout with a version 4 header, so one decoder reads both.
 */
async function unpackV4(file: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.length < 32) throw new RangeError('The SPZ header is truncated; check that the file is complete.');
  const version = view.getUint32(4, true),
    count = view.getUint32(8, true),
    degree = file[12],
    streams = file[15],
    toc = view.getUint32(16, true);
  if (version !== 4)
    throw new RangeError(
      `SPZ version ${version} with a plain header is not supported; re-export the scene as SPZ version 4 or 3.`,
    );
  checkHeader(count, degree);
  const rest = REST_PER_CHANNEL[degree] * 3,
    sizes = [count * 9, count, count * 3, count * 3, count * 4, count * rest],
    needed = rest ? 6 : 5;
  if (streams < needed)
    throw new RangeError(
      `This SPZ file holds ${streams} attribute streams where ${needed} are needed; check that the file is complete.`,
    );
  if (toc < 32 || toc + streams * 16 > file.length)
    throw new RangeError('The SPZ table of contents lies outside the file; check that the file is complete.');
  const body = new Uint8Array(16 + sizes.reduce((a, b) => a + b, 0));
  body.set(file.subarray(0, 16));
  const { decompressZstd } = await import('./zstd.js');
  let at = toc + streams * 16,
    to = 16;
  for (let i = 0; i < streams; i++) {
    const entry = toc + i * 16,
      compressed = u64(view, entry),
      size = u64(view, entry + 8);
    if (at + compressed > file.length)
      throw new RangeError('An SPZ attribute stream runs past the end of the file; check that the file is complete.');
    if (i < needed) {
      if (size !== sizes[i])
        throw new RangeError(
          `SPZ attribute stream ${i} holds ${size} bytes where ${sizes[i]} are needed; check that the file is complete.`,
        );
      const bytes = await decompressZstd(file.subarray(at, at + compressed), {
        signal,
        maxOutputSize: size,
        maxWindowSize: Math.max(size, 1 << 27),
      });
      if (bytes.length !== size)
        throw new RangeError(
          `SPZ attribute stream ${i} decodes to ${bytes.length} bytes where ${size} are needed; check that the file is complete.`,
        );
      body.set(bytes, to);
      to += size;
    }
    at += compressed;
  }
  return body;
}

/** A little-endian u64 that must fit a safe integer. */
function u64(view: DataView, at: number): number {
  const high = view.getUint32(at + 4, true);
  if (high > 0x1fffff) throw new RangeError('An SPZ stream size is too large; check that the file is complete.');
  return high * 2 ** 32 + view.getUint32(at, true);
}

function checkHeader(count: number, degree: number) {
  if (!Number.isInteger(count) || count < 1 || count > 3_000_000)
    throw new RangeError('An SPZ file needs 1 to 3,000,000 splats.');
  if (degree > 3)
    throw new RangeError(`SPZ spherical-harmonic degree ${degree} is not supported; Margo draws degrees 0 to 3.`);
}

/** Decodes the SPZ body (gzip bodies hold versions 2-3, unpacked version 4 files version 4): a 16-byte header (magic, version, count, degree, fractional bits) and the attributes. */
function decode(bytes: Uint8Array, newest: 3 | 4): SplatData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || view.getUint32(0, true) !== 0x5053474e)
    throw new RangeError('Not an SPZ file: the magic number is wrong; check that the file is complete.');
  const version = view.getUint32(4, true),
    count = view.getUint32(8, true),
    degree = bytes[12],
    fractionalBits = bytes[13];
  if (version < (newest === 4 ? 4 : 2) || version > newest)
    throw new RangeError(`SPZ version ${version} is not supported here; re-export the scene as SPZ version 3 or 4.`);
  checkHeader(count, degree);
  const rest = REST_PER_CHANNEL[degree] * 3,
    rotationBytes = version === 2 ? 3 : 4;
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
    if (version !== 2) {
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
