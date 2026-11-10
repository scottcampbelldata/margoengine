import { MargoError } from '@margoengine/math/errors';
import type { RGBAImage } from './ktx2-encode.js';
import { resizeTexture, type ResizeTextureOptions } from './texture-resize.js';

export { resizeTexture } from './texture-resize.js';
export type { ResizeTextureOptions, TextureFilter } from './texture-resize.js';
export type { RGBAImage } from './ktx2-encode.js';
export { transformTextures } from './textures-glb.js';
export type { TransformTexturesOptions, TransformTexturesResult } from './textures-glb.js';

/** Image format produced by the runtime's own canvas encoder. */
export type TextureFormat = 'png' | 'jpeg' | 'webp' | 'avif';

/** Resize and encoding settings. */
export interface EncodeTextureOptions extends ResizeTextureOptions {
  /** Requested format. Unsupported formats reject rather than silently producing PNG. Default 'webp'. */
  format?: TextureFormat;
  /** Platform lossy quality in [0, 1]. Default 0.9. */
  quality?: number;
}

/** Encoded image and its post-resize dimensions. */
export interface EncodedTexture {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

const HELP = 'https://margoengine.com/docs/exporters#textures';
function mime(format: TextureFormat): string {
  if (!['png', 'jpeg', 'webp', 'avif'].includes(format))
    throw new RangeError('Texture format is unknown; use png, jpeg, webp or avif');
  return `image/${format}`;
}
const unavailable = (type: string): MargoError => new MargoError('unsupported', `Platform cannot encode ${type}; use a runtime with this canvas encoder. ${HELP}`);

function canvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | undefined {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return undefined;
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

// The platform may silently serialize PNG for an unsupported MIME type. Never label that PNG WebP/AVIF.
async function blobOf(target: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  let abort: () => void = () => {}, timer: ReturnType<typeof setTimeout>;
  const pending = new Promise<Blob>((resolve, reject) => {
    abort = () => reject(signal!.reason);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new MargoError('timeout', `Platform ${type} encode exceeded 30 seconds; use a smaller texture. ${HELP}`)), 30_000);
    const complete = (blob: Blob | null): void => {
      if (!blob) reject(new MargoError('failed', `Platform ${type} encoder returned no image; try a smaller texture. ${HELP}`));
      else if (blob.type !== type) reject(unavailable(type));
      else resolve(blob);
    };
    if ('convertToBlob' in target) target.convertToBlob({ type, quality }).then(complete, reject);
    else target.toBlob(complete, type, quality);
  });
  try { return await pending; }
  finally { clearTimeout(timer!); signal?.removeEventListener('abort', abort); }
}

/**
 * Tests actual platform serialization, including its returned MIME type. No cache or import-time probing.
 * @throws MargoError for an encoder failure or timeout; use a working runtime encoder.
 * @throws RangeError for an unknown format; use png/jpeg/webp/avif.
 */
export async function textureFormatSupported(format: TextureFormat, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const type = mime(format), target = canvas(1, 1);
  if (!target) return false;
  if (!target.getContext('2d')) return false;
  try { await blobOf(target, type, 0.9, signal); return true; }
  catch (error) {
    if (error instanceof MargoError && error.code === 'unsupported') return false;
    throw error;
  }
}

/**
 * Decodes encoded image bytes lazily, resizes in linear light and encodes through the platform canvas.
 * PNG uses Margo's clean-room writer and also works without canvas when pixels are supplied.
 * @throws MargoError `unsupported` naming the requested MIME type when no platform encoder exists; choose a supported format.
 * @throws RangeError for invalid resize/quality options; supply documented values.
 */
export async function encodeTexture(source: RGBAImage | Uint8Array, options: EncodeTextureOptions = {}): Promise<EncodedTexture> {
  options.signal?.throwIfAborted();
  const type = mime(options.format ?? 'webp'), quality = options.quality ?? 0.9;
  if (!Number.isFinite(quality) || quality < 0 || quality > 1)
    throw new RangeError('Texture quality must be from 0 to 1; use a finite value in that range');
  const decoded = source instanceof Uint8Array ? await (await import('./texture-decode.js')).decodeTexture(source, options.signal) : source;
  const pixels = resizeTexture(decoded, options);
  let data: Uint8Array;
  if (type === 'image/png') data = await (await import('./png.js')).png(pixels, Infinity, false);
  else {
    const target = canvas(pixels.width, pixels.height);
    if (!target) throw unavailable(type);
    const context = target.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw unavailable(type);
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
    data = new Uint8Array(await (await blobOf(target, type, quality, options.signal)).arrayBuffer());
  }
  options.signal?.throwIfAborted();
  return { data, mimeType: type, width: pixels.width, height: pixels.height };
}
