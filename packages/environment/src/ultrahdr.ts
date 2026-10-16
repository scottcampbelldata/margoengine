// UltraHDR (gain-map JPEG, Adobe/Google hdrgm XMP) decoding: the Three.js UltraHDRLoader equivalent.
import { MAX_PIXELS, toBytes, type FloatImage } from './hdr.js';
import { SRGBToLinear as srgbToLinear } from '@margoengine/math/color';

/** Gain-map metadata from the hdrgm XMP, per RGB channel where the format allows it. Min, max and capacities are log2. */
export interface GainMapMetadata {
  gainMapMin: [number, number, number];
  gainMapMax: [number, number, number];
  gamma: [number, number, number];
  offsetSdr: [number, number, number];
  offsetHdr: [number, number, number];
  hdrCapacityMin: number;
  hdrCapacityMax: number;
}
/** The two embedded JPEG streams and their metadata. */
export interface UltraHDRParts {
  primary: Uint8Array;
  gainMap: Uint8Array;
  metadata: GainMapMetadata;
}
/** 8-bit RGBA pixels, row 0 at the top (ImageData fits). */
export interface RGBA8Image {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
export interface UltraHDROptions {
  /** JPEG decoder; default uses createImageBitmap and OffscreenCanvas (browsers and workers). Supply one in Node. */
  decode?: (jpeg: Uint8Array) => Promise<RGBA8Image> | RGBA8Image;
  /** Gain-map weight 0..1: 1 recovers the full HDR range (default, right for lighting), 0 returns the SDR image. */
  weight?: number;
}

const XMP = 'http://ns.adobe.com/xap/1.0/\0',
  text = /* @__PURE__ */ new TextDecoder();

// Returns the offset just past the EOI of the JPEG starting at `start`, collecting its XMP packets.
function jpegEnd(b: Uint8Array, start: number, xmp: string[]): number {
  if (b[start] !== 0xff || b[start + 1] !== 0xd8) throw new Error('Invalid JPEG stream');
  let p = start + 2;
  while (p + 1 < b.length) {
    if (b[p] !== 0xff) throw new Error('Corrupt JPEG marker');
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd9) return p + 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (p + 3 >= b.length) break;
    const length = (b[p + 2] << 8) | b[p + 3],
      end = p + 2 + length;
    if (length < 2 || end > b.length) break;
    if (marker === 0xe1 && length > XMP.length + 2 && text.decode(b.subarray(p + 4, p + 4 + XMP.length)) === XMP)
      xmp.push(text.decode(b.subarray(p + 4 + XMP.length, end)));
    p = end;
    // Entropy-coded data runs to the next marker other than a stuffed 0xFF00 or a restart marker.
    if (marker === 0xda)
      while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && (b[p + 1] < 0xd0 || b[p + 1] > 0xd7))) p++;
  }
  throw new Error('Truncated JPEG stream');
}

function metadata(xmp: string): GainMapMetadata {
  const field = (name: string, fallback?: number): number[] => {
    const match =
      new RegExp(`hdrgm:${name}="([^"]*)"`).exec(xmp) ??
      new RegExp(`<hdrgm:${name}>([\\s\\S]*?)</hdrgm:${name}>`).exec(xmp);
    const values = match
      ? (match[1].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [])
      : fallback === undefined
        ? []
        : [fallback];
    if ((values.length !== 1 && values.length !== 3) || !values.every(Number.isFinite))
      throw new Error(`Invalid or missing hdrgm:${name}`);
    return values.length === 1 ? [values[0], values[0], values[0]] : values;
  };
  if (/hdrgm:BaseRenditionIsHDR(="|>)\s*True/i.test(xmp))
    throw new Error('UltraHDR files with an HDR base rendition are not supported');
  const rgb = (name: string, fallback?: number) => field(name, fallback) as [number, number, number];
  const result = {
    gainMapMin: rgb('GainMapMin', 0),
    gainMapMax: rgb('GainMapMax'),
    gamma: rgb('Gamma', 1),
    offsetSdr: rgb('OffsetSDR', 1 / 64),
    offsetHdr: rgb('OffsetHDR', 1 / 64),
    hdrCapacityMin: field('HDRCapacityMin', 0)[0],
    hdrCapacityMax: field('HDRCapacityMax')[0],
  };
  if (result.gamma.some((g) => g <= 0)) throw new Error('Invalid hdrgm:Gamma');
  return result;
}

/**
 * Splits an UltraHDR JPEG into its primary (SDR) JPEG, its gain-map JPEG (the next JPEG stream after the primary,
 * as listed by MPF) and the hdrgm gain-map metadata from either image's XMP. ISO 21496-1 binary-only metadata is not read.
 */
export function parseUltraHDR(source: ArrayBuffer | ArrayBufferView): UltraHDRParts {
  const bytes = toBytes(source),
    xmp: string[] = [];
  const primaryEnd = jpegEnd(bytes, 0, xmp);
  let start = primaryEnd;
  while (start + 2 < bytes.length && !(bytes[start] === 0xff && bytes[start + 1] === 0xd8 && bytes[start + 2] === 0xff))
    start++;
  if (start + 2 >= bytes.length) throw new Error('Not an UltraHDR JPEG: no gain-map image');
  const gainEnd = jpegEnd(bytes, start, xmp);
  const packet = xmp.find((value) => /hdrgm:GainMapMax/.test(value));
  if (!packet) throw new Error('Not an UltraHDR JPEG: no hdrgm gain-map metadata');
  return {
    primary: bytes.subarray(0, primaryEnd),
    gainMap: bytes.subarray(start, gainEnd),
    metadata: metadata(packet),
  };
}

/**
 * Recovers linear HDR radiance: `(sdr + offsetSdr) * 2^(weight * mix(min, max, gain^(1/gamma))) - offsetHdr` with the
 * base image decoded from sRGB and the gain map bilinearly upsampled. Returns float RGBA with alpha 1.
 */
export function applyGainMap(sdr: RGBA8Image, gain: RGBA8Image, meta: GainMapMetadata, weight = 1): FloatImage {
  const { width, height } = sdr,
    gw = gain.width,
    gh = gain.height;
  for (const image of [sdr, gain])
    if (
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.data.length < image.width * image.height * 4
    )
      throw new TypeError('Invalid RGBA8 image');
  if (width * height > MAX_PIXELS) throw new RangeError('UltraHDR image is too large');
  if (!(weight >= 0 && weight <= 1)) throw new RangeError('Invalid gain-map weight');
  // Boost factor per channel for each 8-bit gain value; fractional (upsampled) gains interpolate between entries.
  const linear = new Float32Array(256),
    boost = new Float32Array(768);
  for (let v = 0; v < 256; v++) {
    linear[v] = srgbToLinear(v / 255);
    for (let c = 0; c < 3; c++) {
      const r = (v / 255) ** (1 / meta.gamma[c]);
      boost[c * 256 + v] = 2 ** (weight * (meta.gainMapMin[c] * (1 - r) + meta.gainMapMax[c] * r));
    }
  }
  const out = new Float32Array(width * height * 4),
    g = gain.data,
    s = sdr.data;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(gh - 1, Math.max(0, ((y + 0.5) * gh) / height - 0.5)),
      y0 = Math.floor(fy),
      y1 = Math.min(gh - 1, y0 + 1),
      ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gw - 1, Math.max(0, ((x + 0.5) * gw) / width - 0.5)),
        x0 = Math.floor(fx),
        x1 = Math.min(gw - 1, x0 + 1),
        tx = fx - x0;
      const a = (y0 * gw + x0) * 4,
        b = (y0 * gw + x1) * 4,
        c0 = (y1 * gw + x0) * 4,
        d = (y1 * gw + x1) * 4,
        o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const value = (g[a + c] * (1 - tx) + g[b + c] * tx) * (1 - ty) + (g[c0 + c] * (1 - tx) + g[d + c] * tx) * ty,
          i = Math.min(254, Math.floor(value)),
          t = value - i;
        out[o + c] = Math.max(
          0,
          (linear[s[o + c]] + meta.offsetSdr[c]) * (boost[c * 256 + i] * (1 - t) + boost[c * 256 + i + 1] * t) -
            meta.offsetHdr[c],
        );
      }
      out[o + 3] = 1;
    }
  }
  return { width, height, data: out };
}

async function decodeJPEG(jpeg: Uint8Array): Promise<RGBA8Image> {
  const bitmap = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    if (!context) throw new Error('UltraHDR decoding needs a 2D OffscreenCanvas');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Decodes an UltraHDR JPEG into a linear FloatImage for `Environment.create`. */
export async function decodeUltraHDR(
  source: ArrayBuffer | ArrayBufferView,
  { decode = decodeJPEG, weight = 1 }: UltraHDROptions = {},
): Promise<FloatImage> {
  const { primary, gainMap, metadata } = parseUltraHDR(source);
  const [sdr, gain] = await Promise.all([decode(primary), decode(gainMap)]);
  return applyGainMap(sdr, gain, metadata, weight);
}
