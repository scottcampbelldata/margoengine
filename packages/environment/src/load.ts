import {parseHDR, toBytes, type FloatImage} from './hdr.js';
import {parseEXR} from './exr.js';

/** Parses `.hdr` or `.exr` bytes, picked by file signature. */
export function parseEnvironmentImage(source: ArrayBuffer | ArrayBufferView): FloatImage {
  const bytes = toBytes(source);
  if (bytes.length >= 4 && bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return parseEXR(bytes);
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x3f) return parseHDR(bytes);
  throw new Error('Unrecognized environment image (expected Radiance .hdr or OpenEXR)');
}

/** Fetches and parses an `.hdr` or `.exr` file. */
export async function loadEnvironmentImage(url: string | URL, {signal}: {signal?: AbortSignal} = {}): Promise<FloatImage> {
  const response = await fetch(url, {signal});
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  return parseEnvironmentImage(await response.arrayBuffer());
}
