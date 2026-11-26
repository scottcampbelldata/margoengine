// RGBM and LogLuv: HDR colour packed into ordinary 8-bit RGBA pictures (PNG, JPEG, WebP), decoded to linear floats and
// encoded back. Written from Brian Karis, "RGBM Color Encoding" (2009, graphicrants.blogspot.com/2009/04/rgbm-color-encoding.html)
// and Gregory Ward Larson, "LogLuv Encoding for Full-Gamut, High Dynamic Range Images" (Journal of Graphics Tools 3(1), 1998,
// anyhere.com/gward/papers/jgtlogluv.pdf). The HDR JPEG a camera writes (a gain-map JPEG) is `decodeUltraHDR`.
import type { FloatImage } from './hdr.js';
import type { RGBA8Image } from './ultrahdr.js';
import { MargoError } from '@margoengine/math/errors';

export { decodeUltraHDR as decodeHDRJPG } from './ultrahdr.js';
export type { UltraHDROptions as HDRJPGOptions } from './ultrahdr.js';

/** Options of the RGBM codec. */
export interface RGBMOptions {
  /** The brightest value the multiplier `a` represents (a = 1). Default 6, the range of Marmoset Toolbag's RGBM. */
  maxRange?: number;
  /**
   * The power the stored colour is raised to before the multiplier applies (`rgb^gamma * a * maxRange`): 1 (default)
   * for linear storage, 2.2 or 2 for the older gamma-space files.
   */
  gamma?: number;
}

const range = (maxRange: number): number => {
  if (!(maxRange > 0) || !Number.isFinite(maxRange))
    throw new RangeError(`RGBM maxRange ${maxRange} must be a positive number; pass a value above 0 (the default is 6)`);
  return maxRange;
};
const power = (gamma: number): number => {
  if (!(gamma > 0) || !Number.isFinite(gamma)) throw new RangeError(`RGBM gamma ${gamma} must be a positive number; pass a value above 0 (the default is 1)`);
  return gamma;
};
const check = (image: RGBA8Image, name: string): void => {
  if (!(image.width > 0 && image.height > 0) || image.data.length < image.width * image.height * 4)
    throw new MargoError('failed', `${name}: the image is empty or shorter than width x height x 4 bytes; pass RGBA pixels`);
};

/** Decodes an RGBM picture: linear `rgb^gamma * a * maxRange`, alpha 1. Row 0 stays the top row. */
export function decodeRGBM(image: RGBA8Image, { maxRange = 6, gamma = 1 }: RGBMOptions = {}): FloatImage {
  check(image, 'decodeRGBM');
  const scale = range(maxRange),
    g = power(gamma),
    n = image.width * image.height,
    out = new Float32Array(n * 4),
    src = image.data;
  for (let i = 0; i < n; i++) {
    const m = (src[i * 4 + 3] / 255) * scale;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = (g === 1 ? src[i * 4 + c] / 255 : (src[i * 4 + c] / 255) ** g) * m;
    out[i * 4 + 3] = 1;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Encodes linear RGBA floats as RGBM bytes: m = ceil(max(r,g,b) / maxRange * 255) / 255 (clamped to 1, so values past
 * `maxRange` clip), rgb = (value / (m * maxRange))^(1/gamma). The round-up keeps the stored colour within 1.
 */
export function encodeRGBM(image: FloatImage, { maxRange = 6, gamma = 1 }: RGBMOptions = {}): Uint8Array {
  const scale = range(maxRange),
    g = power(gamma),
    n = image.width * image.height;
  if (image.data.length < n * 4) throw new MargoError('failed', 'encodeRGBM: the image holds fewer than width x height RGBA floats; pass four floats per pixel');
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = Math.max(image.data[i * 4], 0),
      gr = Math.max(image.data[i * 4 + 1], 0),
      b = Math.max(image.data[i * 4 + 2], 0),
      peak = Math.max(r, gr, b, 1e-6),
      m = Math.min(1, Math.ceil((peak / scale) * 255) / 255),
      d = m * scale;
    out[i * 4] = Math.round(Math.min(1, (r / d) ** (1 / g)) * 255);
    out[i * 4 + 1] = Math.round(Math.min(1, (gr / d) ** (1 / g)) * 255);
    out[i * 4 + 2] = Math.round(Math.min(1, (b / d) ** (1 / g)) * 255);
    out[i * 4 + 3] = Math.round(m * 255);
  }
  return out;
}

// IEC 61966-2-1 sRGB primaries with the D65 white point.
const RGB_TO_XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const XYZ_TO_RGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];

/**
 * Decodes 32-bit LogLuv (Ward 1998) stored as RGBA bytes holding the big-endian word `LLLLLLLL LLLLLLLL uuuuuuuu vvvvvvvv`:
 * r = the high byte of the 16-bit log-luminance (its top bit is the sign), g = its low byte, b = u', a = v'.
 * Y = 2^((Le + 0.5) / 256 - 64) with Le the low 15 bits, u' = (ue + 0.5) / 410 and v' = (ve + 0.5) / 410; Le 0 is black.
 * The result is linear Rec. 709 (sRGB primaries), alpha 1. Pixels whose chromaticity is out of gamut keep any negative
 * component (they are not clamped), so a caller can tell.
 */
export function decodeLogLuv(image: RGBA8Image): FloatImage {
  check(image, 'decodeLogLuv');
  const n = image.width * image.height,
    out = new Float32Array(n * 4),
    s = image.data;
  for (let i = 0; i < n; i++) {
    const word = (s[i * 4] << 8) | s[i * 4 + 1],
      le = word & 0x7fff;
    out[i * 4 + 3] = 1;
    if (le === 0) continue;
    const y = (word & 0x8000 ? -1 : 1) * 2 ** ((le + 0.5) / 256 - 64),
      u = (s[i * 4 + 2] + 0.5) / 410,
      v = (s[i * 4 + 3] + 0.5) / 410,
      x = (9 * u * y) / (4 * v),
      z = ((12 - 3 * u - 20 * v) * y) / (4 * v);
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = XYZ_TO_RGB[c * 3] * x + XYZ_TO_RGB[c * 3 + 1] * y + XYZ_TO_RGB[c * 3 + 2] * z;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Encodes linear Rec. 709 RGBA floats as 32-bit LogLuv bytes (the layout of {@link decodeLogLuv}). Luminance past 2^64 clips. */
export function encodeLogLuv(image: FloatImage): Uint8Array {
  const n = image.width * image.height;
  if (image.data.length < n * 4) throw new MargoError('failed', 'encodeLogLuv: the image holds fewer than width x height RGBA floats; pass four floats per pixel');
  const out = new Uint8Array(n * 4),
    d = image.data;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4],
      g = d[i * 4 + 1],
      b = d[i * 4 + 2],
      x = RGB_TO_XYZ[0] * r + RGB_TO_XYZ[1] * g + RGB_TO_XYZ[2] * b,
      y = RGB_TO_XYZ[3] * r + RGB_TO_XYZ[4] * g + RGB_TO_XYZ[5] * b,
      z = RGB_TO_XYZ[6] * r + RGB_TO_XYZ[7] * g + RGB_TO_XYZ[8] * b,
      sum = x + 15 * y + 3 * z;
    const mag = Math.abs(y);
    if (!(mag > 2 ** -64) || !(sum !== 0)) continue; // black: Le 0 (below the smallest representable luminance)
    const le = Math.min(0x7fff, Math.max(1, Math.floor(256 * (Math.log2(mag) + 64)))),
      word = le | (y < 0 ? 0x8000 : 0),
      ue = Math.min(255, Math.max(0, Math.floor((410 * 4 * x) / sum))),
      ve = Math.min(255, Math.max(0, Math.floor((410 * 9 * y) / sum)));
    out[i * 4] = word >> 8;
    out[i * 4 + 1] = word & 255;
    out[i * 4 + 2] = ue;
    out[i * 4 + 3] = ve;
  }
  return out;
}

/** Options of {@link loadRGBM} and {@link loadLogLuv}: RGBM settings plus the picture decoder. */
export interface EncodedHDRLoadOptions extends RGBMOptions {
  /** Picture decoder (PNG, WebP or JPEG bytes to RGBA8 pixels). Default: `createImageBitmap` and `OffscreenCanvas`, with no colour conversion. */
  decode?: (bytes: Uint8Array) => Promise<RGBA8Image> | RGBA8Image;
  /** Aborts the decode. */
  signal?: AbortSignal;
}

async function decodePicture(bytes: Uint8Array): Promise<RGBA8Image> {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  }).catch((error) => {
    throw new MargoError('failed', `the picture could not be decoded (${error?.message ?? error}); check the file`);
  });
  try {
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    if (!context) throw new MargoError('unsupported', 'decoding needs a 2D OffscreenCanvas; pass options.decode');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function load(
  source: ArrayBuffer | ArrayBufferView,
  options: EncodedHDRLoadOptions,
  decode: (image: RGBA8Image) => FloatImage,
): Promise<FloatImage> {
  options.signal?.throwIfAborted();
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const image = await (options.decode ?? decodePicture)(bytes);
  options.signal?.throwIfAborted();
  return decode(image);
}

/** Decodes a PNG, WebP or JPEG file that holds an RGBM picture to a linear {@link FloatImage}. */
export const loadRGBM = (source: ArrayBuffer | ArrayBufferView, options: EncodedHDRLoadOptions = {}): Promise<FloatImage> =>
  load(source, options, (image) => decodeRGBM(image, options));

/** Decodes a PNG or WebP file that holds a LogLuv picture (lossless only: JPEG breaks the log-luminance bytes) to a linear {@link FloatImage}. */
export const loadLogLuv = (source: ArrayBuffer | ArrayBufferView, options: EncodedHDRLoadOptions = {}): Promise<FloatImage> =>
  load(source, options, decodeLogLuv);
