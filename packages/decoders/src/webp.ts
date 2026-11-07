// WebP reading (`@margoengine/decoders/webp`), written from RFC 9649 (the container and the lossless format) and RFC 6386
// (VP8, through `vp8.ts`). Lossy, lossless, lossy with an ALPH chunk, and the extended VP8X form become RGBA8 rows, top
// row first. An animated file gives its first frame on the canvas.
import { decodeFailed } from './errors.js';
import { type VP8Frame, decodeVP8, vp8Size } from './vp8.js';
import { decodeAlphaStream, decodeVP8L } from './webp-lossless.js';

/** A decoded WebP image: RGBA8 rows, top row first, `width * height * 4` bytes, alpha not premultiplied. */
export interface DecodedWebP {
  width: number;
  height: number;
  data: Uint8Array;
  /** True when the file stores pixels without loss (VP8L). */
  lossless: boolean;
  /** True when the file holds more than one frame; `data` is then the first. */
  animated: boolean;
}

/** Limits for {@link parseWebP}. */
export interface WebPOptions {
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image), 256 MiB of RGBA8. */
  maxPixels?: number;
}

const corrupt = (problem: string): Error =>
  decodeFailed(`WebP ${problem}; pass the complete bytes of a valid WebP file`);

const tag = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
const u32 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
const u24 = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);

const tooLarge = (width: number, height: number, maxPixels: number): RangeError =>
  new RangeError(`WebP of ${width}x${height} exceeds maxPixels ${maxPixels}; pass a larger maxPixels`);

/** A 16.16 fixed-point colour value as a byte. */
const toByte = (v: number): number => {
  const b = (v + 32768) >> 16;
  return b < 0 ? 0 : b > 255 ? 255 : b;
};

/** Chroma at full size, one row: each output pixel weighs its four nearest samples 9, 3, 3 and 1. */
function upsampleRow(plane: Uint8Array, near: number, far: number, width: number, out: Int32Array): void {
  const half = (width + 1) >> 1;
  for (let x = 0; x < width; x++) {
    const c = x >> 1,
      o = x & 1 ? Math.min(c + 1, half - 1) : Math.max(c - 1, 0);
    out[x] = (9 * plane[near + c] + 3 * (plane[near + o] + plane[far + c]) + plane[far + o] + 8) >> 4;
  }
}

/** The planes of a frame as RGBA8 with opaque alpha: BT.601 limited range, the colour space VP8 defines. */
function toRGBA(f: VP8Frame): Uint8Array {
  const { width, height, y, u, v, yStride, yOffset, uvStride, uvOffset } = f,
    data = new Uint8Array(width * height * 4),
    uRow = new Int32Array(width),
    vRow = new Int32Array(width),
    lastRow = ((height + 1) >> 1) - 1;
  for (let row = 0; row < height; row++) {
    const c = row >> 1,
      other = row & 1 ? Math.min(c + 1, lastRow) : Math.max(c - 1, 0),
      near = uvOffset + c * uvStride,
      far = uvOffset + other * uvStride;
    upsampleRow(u, near, far, width, uRow);
    upsampleRow(v, near, far, width, vRow);
    for (let x = 0, at = row * width * 4; x < width; x++, at += 4) {
      const l = 76309 * (y[yOffset + row * yStride + x] - 16),
        cb = uRow[x] - 128,
        cr = vRow[x] - 128;
      data[at] = toByte(l + 104597 * cr);
      data[at + 1] = toByte(l - 25675 * cb - 53279 * cr);
      data[at + 2] = toByte(l + 132201 * cb);
      data[at + 3] = 255;
    }
  }
  return data;
}

/** RFC 9649 section 2.7.1.2: the transparency of an ALPH chunk, written into `rgba`. */
function applyAlpha(
  bytes: Uint8Array,
  start: number,
  end: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): void {
  if (end <= start) throw corrupt('ALPH chunk is empty');
  const header = bytes[start],
    method = header & 3,
    filter = (header >> 2) & 3,
    count = width * height;
  let alpha: Uint8Array;
  if (method === 0) {
    if (end - start - 1 < count) throw corrupt('ALPH chunk is shorter than the image');
    alpha = bytes.slice(start + 1, start + 1 + count);
  } else if (method === 1) alpha = decodeAlphaStream(bytes, start + 1, end, width, height);
  else throw corrupt('ALPH chunk names an unknown compression method');
  if (filter)
    for (let y = 0, i = 0; y < height; y++)
      for (let x = 0; x < width; x++, i++) {
        let predictor: number;
        if (x === 0) predictor = y === 0 ? 0 : alpha[i - width];
        else if (y === 0 || filter === 1) predictor = alpha[i - 1];
        else if (filter === 2) predictor = alpha[i - width];
        else {
          const g = alpha[i - 1] + alpha[i - width] - alpha[i - width - 1];
          predictor = g < 0 ? 0 : g > 255 ? 255 : g;
        }
        alpha[i] = (alpha[i] + predictor) & 255;
      }
  for (let i = 0; i < count; i++) rgba[i * 4 + 3] = alpha[i];
}

/** One frame's chunks: an optional ALPH, then VP8 or VP8L, somewhere in `bytes[at..end]`. */
function readFrame(
  bytes: Uint8Array,
  at: number,
  end: number,
  maxPixels: number,
): { width: number; height: number; data: Uint8Array; lossless: boolean } {
  let alphaAt = -1,
    alphaEnd = 0;
  while (at + 8 <= end) {
    const name = tag(bytes, at),
      size = u32(bytes, at + 4),
      body = at + 8,
      next = body + size;
    if (next > end) throw corrupt(`${name.trim()} chunk runs past the end of the data`);
    if (name === 'ALPH') {
      alphaAt = body;
      alphaEnd = next;
    } else if (name === 'VP8L') {
      const width = 1 + (u24(bytes, body + 1) & 0x3fff),
        height = 1 + (((bytes[body + 2] >> 6) | (bytes[body + 3] << 2) | (bytes[body + 4] << 10)) & 0x3fff);
      if (width * height > maxPixels) throw tooLarge(width, height, maxPixels);
      return { ...decodeVP8L(bytes, body, next), lossless: true };
    } else if (name === 'VP8 ') {
      const { width, height } = vp8Size(bytes, body, next);
      if (width * height > maxPixels) throw tooLarge(width, height, maxPixels);
      const data = toRGBA(decodeVP8(bytes, body, next));
      if (alphaAt >= 0) applyAlpha(bytes, alphaAt, alphaEnd, width, height, data);
      return { width, height, data, lossless: false };
    }
    at = next + (size & 1);
  }
  throw corrupt('file holds no image');
}

/**
 * Decodes WebP bytes to RGBA8 pixels, top row first: lossy (VP8), lossless (VP8L), lossy with transparency, and the
 * first frame of an animation. ICC profiles and metadata are ignored, so colours come back as stored.
 *
 * @example
 * import {parseWebP} from 'margoengine/decoders/webp';
 * const file = new Uint8Array([]); // the bytes of a .webp file
 * if (file.length) console.log(parseWebP(file).width);
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` when the bytes are not a complete, valid WebP file.
 */
export function parseWebP(bytes: Uint8Array, options: WebPOptions = {}): DecodedWebP {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array; pass the WebP file's bytes");
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (bytes.length < 20 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WEBP') throw corrupt('header is missing');
  const end = Math.min(bytes.length, 8 + u32(bytes, 4));
  if (tag(bytes, 12) !== 'VP8X') return { ...readFrame(bytes, 12, end, maxPixels), animated: false };
  const animated = (bytes[20] & 2) !== 0,
    canvasWidth = 1 + u24(bytes, 24),
    canvasHeight = 1 + u24(bytes, 27);
  if (canvasWidth * canvasHeight > maxPixels) throw tooLarge(canvasWidth, canvasHeight, maxPixels);
  if (!animated) {
    const frame = readFrame(bytes, 30, end, maxPixels);
    if (frame.width !== canvasWidth || frame.height !== canvasHeight) throw corrupt('frame differs from its canvas');
    return { ...frame, animated: false };
  }
  for (let at = 30; at + 8 <= end; ) {
    const size = u32(bytes, at + 4);
    if (tag(bytes, at) === 'ANMF') {
      const left = u24(bytes, at + 8) * 2,
        top = u24(bytes, at + 11) * 2,
        frame = readFrame(bytes, at + 24, Math.min(end, at + 8 + size), maxPixels);
      if (left + frame.width > canvasWidth || top + frame.height > canvasHeight)
        throw corrupt('frame reaches past its canvas');
      const data = new Uint8Array(canvasWidth * canvasHeight * 4);
      for (let y = 0; y < frame.height; y++)
        data.set(
          frame.data.subarray(y * frame.width * 4, (y + 1) * frame.width * 4),
          ((top + y) * canvasWidth + left) * 4,
        );
      return { width: canvasWidth, height: canvasHeight, data, lossless: frame.lossless, animated: true };
    }
    at += 8 + size + (size & 1);
  }
  throw corrupt('animation holds no frame');
}
