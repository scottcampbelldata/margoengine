import type { RGBAImage } from './ktx2-encode.js';

/** Pixel reconstruction kernel. Lanczos uses three lobes. */
export type TextureFilter = 'box' | 'bilinear' | 'lanczos';

/** Settings for clean-room RGBA8 resampling. */
export interface ResizeTextureOptions {
  /** Exact output width; alone preserves aspect ratio. Default source width. */
  width?: number;
  /** Exact output height; alone preserves aspect ratio. Default source height. */
  height?: number;
  /** Fit inside this square without upscaling, after width/height. Default no cap. */
  maxSize?: number;
  /** Reconstruction kernel, widened for minification. Default 'lanczos'. */
  filter?: TextureFilter;
  /** Decode RGB to linear light before filtering. Data maps use 'linear'. Default 'srgb'. */
  colorSpace?: 'srgb' | 'linear';
  /** Filter associated RGB to avoid transparent fringes. Default true for sRGB, false for data. */
  premultiplyAlpha?: boolean;
  /** Rejects with the signal's reason. */
  signal?: AbortSignal;
}

const LIMIT = 16_777_216;
const clamp = (v: number): number => Math.min(1, Math.max(0, v));
const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
// Stabilize half-byte ties against accumulated double-precision filter roundoff.
const byte = (v: number): number => Math.floor(255 * v + 0.5 + 1e-12);

function side(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 16384)
    throw new RangeError('Texture dimensions must be integers from 1 to 16384; use a smaller image');
  return value;
}

function size(width: number, height: number): void {
  side(width);
  side(height);
  if (width * height > LIMIT)
    throw new RangeError('Texture exceeds 16777216 pixels; resize in smaller stages');
}

function kernel(x: number, filter: TextureFilter): number {
  const a = Math.abs(x);
  if (filter === 'bilinear') return Math.max(0, 1 - a);
  if (a >= 3) return 0;
  if (a < 1e-12) return 1;
  return (Math.sin(Math.PI * x) * Math.sin(Math.PI * x / 3)) / (Math.PI * Math.PI * x * x / 3);
}

// Pixel centres lie at i + 0.5. Box weights integrate the exact source-pixel footprint;
// the other kernels widen with the reduction ratio, preventing point-sampled aliasing.
function weights(source: number, target: number, filter: TextureFilter): { at: number[]; w: number[] }[] {
  const ratio = source / target, scale = Math.max(1, ratio), radius = filter === 'lanczos' ? 3 : 1;
  return Array.from({ length: target }, (_, j) => {
    const centre = (j + 0.5) * ratio - 0.5, map = new Map<number, number>();
    const lo = filter === 'box' ? j * ratio : centre - radius * scale;
    const hi = filter === 'box' ? (j + 1) * ratio : centre + radius * scale;
    for (let i = Math.floor(lo); i <= Math.ceil(hi); i++) {
      const w = filter === 'box' ? Math.max(0, Math.min(hi, i + 1) - Math.max(lo, i)) : kernel((i - centre) / scale, filter);
      if (!w) continue;
      const at = Math.min(source - 1, Math.max(0, i));
      map.set(at, (map.get(at) ?? 0) + w);
    }
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    return { at: [...map.keys()], w: [...map.values()].map(v => v / total) };
  });
}

/**
 * Resizes straight RGBA8 pixels using separable, antialiased filters in linear light.
 * Returns owned pixels, including when dimensions are unchanged. Alpha is always linear.
 * @throws RangeError for invalid dimensions, options or a mismatched RGBA8 byte count; supply valid pixels.
 * @throws TypeError for a non-byte pixel array; supply Uint8Array or Uint8ClampedArray.
 */
export function resizeTexture(source: RGBAImage, options: ResizeTextureOptions = {}): RGBAImage {
  options.signal?.throwIfAborted();
  size(source.width, source.height);
  if (!(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray))
    throw new TypeError('Texture pixels must be a byte array; supply RGBA8 pixels');
  if (source.data.length !== source.width * source.height * 4)
    throw new RangeError('Texture byte count does not match width * height * 4; supply complete RGBA8 pixels');
  const { filter = 'lanczos', colorSpace = 'srgb', premultiplyAlpha = colorSpace === 'srgb' } = options;
  if (!['box', 'bilinear', 'lanczos'].includes(filter) || !['srgb', 'linear'].includes(colorSpace))
    throw new RangeError('Texture filter or colorSpace is unknown; use box/bilinear/lanczos and srgb/linear');
  let width = options.width === undefined ? source.width : side(options.width);
  let height = options.height === undefined ? source.height : side(options.height);
  if (options.width !== undefined && options.height === undefined) height = Math.max(1, Math.round(width * source.height / source.width));
  if (options.height !== undefined && options.width === undefined) width = Math.max(1, Math.round(height * source.width / source.height));
  if (options.maxSize !== undefined) {
    const factor = Math.min(1, side(options.maxSize) / Math.max(width, height));
    width = Math.max(1, Math.round(width * factor));
    height = Math.max(1, Math.round(height * factor));
  }
  size(width, height);
  if (width === source.width && height === source.height) return { width, height, data: source.data.slice() };
  size(width, source.height);
  const horizontal = weights(source.width, width, filter), vertical = weights(source.height, height, filter);
  const middle = new Float64Array(width * source.height * 4), data = new Uint8Array(width * height * 4);
  // Convert just the 256 possible channel values once, rather than per tap.
  const lut = Float64Array.from({ length: 256 }, (_, i) => colorSpace === 'srgb' ? linear(i / 255) : i / 255);
  for (let y = 0; y < source.height; y++) {
    options.signal?.throwIfAborted();
    for (let x = 0; x < width; x++) {
      const { at, w } = horizontal[x], to = (y * width + x) * 4;
      for (let k = 0; k < at.length; k++) {
        const from = (y * source.width + at[k]) * 4, alpha = source.data[from + 3] / 255;
        for (let c = 0; c < 3; c++) middle[to + c] += lut[source.data[from + c]] * (premultiplyAlpha ? alpha : 1) * w[k];
        middle[to + 3] += alpha * w[k];
      }
    }
  }
  for (let y = 0; y < height; y++) {
    options.signal?.throwIfAborted();
    const { at, w } = vertical[y];
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0], to = (y * width + x) * 4;
      for (let k = 0; k < at.length; k++) {
        const from = (at[k] * width + x) * 4;
        for (let c = 0; c < 4; c++) sum[c] += middle[from + c] * w[k];
      }
      for (let c = 0; c < 3; c++) {
        const v = clamp(premultiplyAlpha ? (sum[3] > 1e-12 ? sum[c] / sum[3] : 0) : sum[c]);
        data[to + c] = byte(colorSpace === 'srgb' ? srgb(v) : v);
      }
      data[to + 3] = byte(clamp(sum[3]));
    }
  }
  return { width, height, data };
}
