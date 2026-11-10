import type { RGBAImage } from './ktx2-encode.js';

/** Read an input texture using Margo's readers, including the exporters' existing JPEG reader. */
export async function decodeTexture(bytes: Uint8Array, signal?: AbortSignal): Promise<RGBAImage> {
  signal?.throwIfAborted();
  const image = bytes[0] === 0xff && bytes[1] === 0xd8
    ? (await import('./jpeg-read.js')).decodeJPEG(bytes)
    : await (await import('@margoengine/decoders/image')).decodeImage(bytes, { signal });
  signal?.throwIfAborted();
  return image;
}
