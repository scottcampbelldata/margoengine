// The loader entry (`@margoengine/environment/load`): it imports the decoder a file needs, on first use, from its own
// built file (dist/hdr.js, exr.js or ultrahdr.js), so an app that loads one format downloads one decoder.
import type { FloatImage } from './hdr.js';
import type { UltraHDROptions } from './ultrahdr.js';
import { isEXR, isHDR, isJPEG, UNKNOWN_ERROR } from './signature.js';
import { MargoError } from '@margoengine/math/errors';

/**
 * Fetches and decodes an `.hdr`, `.exr` or UltraHDR (gain-map) `.jpg` file, picked by signature, through `fetch`
 * (default `globalThis.fetch`; for example an AssetCache's or a LoadingManager's `fetch`). Imported from
 * `@margoengine/environment/load`, only the decoder the file needs is loaded.
 * @throws MargoError `'failed'` when the server answers with an HTTP error; otherwise what the decoder throws.
 */
export async function loadEnvironmentImage(
  url: string | URL,
  {
    signal,
    fetch: get = globalThis.fetch,
    ...options
  }: { signal?: AbortSignal; fetch?: typeof fetch } & UltraHDROptions = {},
): Promise<FloatImage> {
  const response = await get(url, { signal });
  if (!response.ok) throw new MargoError('failed', `Failed to load ${url}: HTTP ${response.status}; check the URL`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (isJPEG(bytes)) return (await import('./ultrahdr.js')).decodeUltraHDR(bytes, options);
  // Through re-exports of the decoders, never the files parseEnvironmentImage imports itself (load-hdr.ts).
  if (isEXR(bytes)) return (await import('./load-exr.js')).parseEXR(bytes);
  if (isHDR(bytes)) return (await import('./load-hdr.js')).parseHDR(bytes);
  throw new TypeError(UNKNOWN_ERROR);
}
