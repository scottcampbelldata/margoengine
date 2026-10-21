import { parseHDR, toBytes, type FloatImage } from './hdr.js';
import { parseEXR } from './exr.js';
import { decodeUltraHDR, type UltraHDROptions } from './ultrahdr.js';
import { MargoError } from '@margoengine/math/errors';

const isJPEG = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/**
 * Parses `.hdr` or `.exr` bytes, picked by file signature. UltraHDR JPEGs need the async `decodeUltraHDR`.
 * @throws TypeError for a JPEG or an unrecognized signature; otherwise what `parseHDR` or `parseEXR` throws.
 */
export function parseEnvironmentImage(source: ArrayBuffer | ArrayBufferView): FloatImage {
  const bytes = toBytes(source);
  if (bytes.length >= 4 && bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01)
    return parseEXR(bytes);
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x3f) return parseHDR(bytes);
  if (isJPEG(bytes))
    throw new TypeError('UltraHDR JPEGs decode asynchronously: use decodeUltraHDR or loadEnvironmentImage');
  throw new TypeError('Unrecognized environment image (expected Radiance .hdr or OpenEXR)');
}

/**
 * Fetches and decodes an `.hdr`, `.exr` or UltraHDR (gain-map) `.jpg` file, picked by signature.
 * @throws MargoError `'failed'` when the server answers with an HTTP error; otherwise what the decoder throws.
 */
export async function loadEnvironmentImage(
  url: string | URL,
  { signal, ...options }: { signal?: AbortSignal } & UltraHDROptions = {},
): Promise<FloatImage> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new MargoError('failed', `Failed to load ${url}: HTTP ${response.status}; check the URL`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return isJPEG(bytes) ? decodeUltraHDR(bytes, options) : parseEnvironmentImage(bytes);
}
