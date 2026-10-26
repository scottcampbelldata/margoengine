// Lazy entry points for the compressed formats: the SPZ, SOG and WebP decoders load only when first called, so
// importing `@margoengine/splats` or `/data` for PLY or `.splat` files does not pay for them.
import type { SplatData } from './data.js';
import type { ParseSogOptions, SogFiles } from './sog.js';
import type { ParseSpzOptions } from './spz.js';

/**
 * Decodes an SPZ file (versions 2 and 3) to {@link SplatData}. Loads the decoder on first use.
 * @throws TypeError when `input` is not bytes; RangeError for a damaged file or unknown version; MargoError
 * `unsupported` for SPZ version 4 (Zstandard), which needs exporting as version 3.
 * @example
 * const splats = await parseSpz(await (await fetch('scene.spz')).arrayBuffer());
 */
export async function parseSpz(input: ArrayBuffer | ArrayBufferView, options?: ParseSpzOptions): Promise<SplatData> {
  return (await import('./spz.js')).parseSpz(input, options);
}

/**
 * Decodes a SOG scene (version 2, bundled `.sog` or loose files) to {@link SplatData}. Loads the decoder on first use.
 * @throws TypeError when `input` is not bytes or a file map; RangeError for a damaged archive, texture or `meta.json`;
 * MargoError `unsupported` for lossy textures or ZIP64.
 * @example
 * const splats = await parseSog(await (await fetch('scene.sog')).arrayBuffer());
 */
export async function parseSog(
  input: ArrayBuffer | ArrayBufferView | SogFiles,
  options?: ParseSogOptions,
): Promise<SplatData> {
  return (await import('./sog.js')).parseSog(input, options);
}

export type { ParseSogOptions, ParseSpzOptions, SogFiles };
