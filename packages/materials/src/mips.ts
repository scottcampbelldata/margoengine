// Mip chains you supply: artists paint far levels by hand (fading detail, keeping thin lines) and tools bake them, and a
// generated box filter would throw that away. Levels go to the GPU as given, largest first.
import { Texture, loadTexture, type TextureOptions } from './built-material.js';
import { toHalfArray } from './texture-kinds.js';

/** Raw texels of one level, row 0 first (at UV v = 0): bytes for rgba8unorm; half-float bits or floats for rgba16float. */
export interface MipData {
  data: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
  width: number;
  height: number;
}
/** One level: raw texels, or an image, canvas or bitmap, read as 8-bit RGBA. */
export type MipLevel = MipData | ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData;
/** Options of `mipTexture`: the Texture options a supplied chain leaves open, and its texel format. */
export interface MipTextureOptions extends Omit<TextureOptions, 'mipmaps' | 'dimension' | 'flipY'> {
  /** `'rgba8unorm'` (default) or `'rgba16float'` for values past 1. */
  format?: 'rgba8unorm' | 'rgba16float';
}
const sizeOf = (level: MipLevel): [number, number] => {
  const s = level as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  return [s.naturalWidth || (s.width ?? 0), s.naturalHeight || (s.height ?? 0)];
};
/** The bytes of a level: `count` texels of `format`. */
function texels(level: MipLevel, format: 'rgba8unorm' | 'rgba16float', count: number, k: number): Uint8Array {
  const data = (level as MipData).data;
  if (data === undefined) {
    if (format !== 'rgba8unorm')
      throw new TypeError(`mipTexture level ${k} must be raw data for rgba16float; an image holds 8-bit values`);
    const [width, height] = sizeOf(level),
      canvas = new OffscreenCanvas(width, height),
      context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(level as CanvasImageSource, 0, 0);
    return new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
  }
  if (data.length < count * 4)
    throw new RangeError(`mipTexture level ${k} needs ${count * 4} values, four per texel; pass a longer array`);
  if (format === 'rgba8unorm') {
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
      throw new TypeError(`mipTexture level ${k} must hold bytes for rgba8unorm; pass a Uint8Array`);
    return new Uint8Array(data.buffer, data.byteOffset, count * 4);
  }
  if (!(data instanceof Uint16Array || data instanceof Float32Array))
    throw new TypeError(`mipTexture level ${k} must be a Uint16Array of half-float bits or a Float32Array for rgba16float`);
  const half = data instanceof Float32Array ? toHalfArray(data.subarray(0, count * 4)) : data;
  return new Uint8Array(half.buffer, half.byteOffset, count * 8);
}
/**
 * A Texture from your own mip chain, largest level first: each level is half the one before, rounded down, at least 1.
 * The chain may stop before 1 x 1; nothing is generated past it, so a far surface keeps the last level given.
 * @throws TypeError for no levels or a wrong array type; RangeError for a level of the wrong size or too short.
 */
export function mipTexture(levels: readonly MipLevel[], { format = 'rgba8unorm', ...options }: MipTextureOptions = {}): Texture {
  if (!Array.isArray(levels) || !levels.length) throw new TypeError('mipTexture needs mip levels, largest first; pass an array');
  if (format !== 'rgba8unorm' && format !== 'rgba16float')
    throw new TypeError("mipTexture format must be 'rgba8unorm' or 'rgba16float'; pass one");
  if (format === 'rgba16float' && options.colorSpace !== undefined && options.colorSpace !== 'linear')
    throw new TypeError("mipTexture rgba16float texels are linear; omit colorSpace or pass 'linear'");
  const [width, height] = sizeOf(levels[0]);
  const mipmaps = levels.map((level, k) => {
    const w = Math.max(1, width >> k),
      h = Math.max(1, height >> k),
      [lw, lh] = sizeOf(level);
    if (lw !== w || lh !== h) throw new RangeError(`mipTexture level ${k} must be ${w} x ${h}, not ${lw} x ${lh}`);
    return { data: texels(level, format, w * h, k), width: w, height: h };
  });
  return new Texture({ width, height, mipmaps, format, target: 'rgba8', srgb: false }, options);
}
/** `mipTexture` of images at `urls`, largest level first, downloaded as `loadTexture` does. */
export async function loadMipTexture(
  urls: readonly (string | URL)[],
  { signal, fetch: get, ...options }: MipTextureOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<Texture> {
  const images = await Promise.all(urls.map((url) => loadTexture(url, { signal, fetch: get })));
  return mipTexture(
    images.map((image) => image.source as MipLevel),
    options,
  );
}
