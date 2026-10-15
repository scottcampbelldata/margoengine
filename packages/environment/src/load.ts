import { parseHDR, toBytes, type FloatImage } from './hdr.js';
import { parseEXR } from './exr.js';
import { decodeUltraHDR, type UltraHDROptions } from './ultrahdr.js';

const isJPEG = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Parses `.hdr` or `.exr` bytes, picked by file signature. UltraHDR JPEGs need the async `decodeUltraHDR`. */
export function parseEnvironmentImage(source: ArrayBuffer | ArrayBufferView): FloatImage {
  const bytes = toBytes(source);
  if (bytes.length >= 4 && bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01)
    return parseEXR(bytes);
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x3f) return parseHDR(bytes);
  if (isJPEG(bytes))
    throw new Error('UltraHDR JPEGs decode asynchronously: use decodeUltraHDR or loadEnvironmentImage');
  throw new Error('Unrecognized environment image (expected Radiance .hdr or OpenEXR)');
}

/** Fetches and decodes an `.hdr`, `.exr` or UltraHDR (gain-map) `.jpg` file, picked by signature. */
export async function loadEnvironmentImage(
  url: string | URL,
  { signal, ...options }: { signal?: AbortSignal } & UltraHDROptions = {},
): Promise<FloatImage> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return isJPEG(bytes) ? decodeUltraHDR(bytes, options) : parseEnvironmentImage(bytes);
}
