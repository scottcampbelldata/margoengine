// Lazy entry points for the compressed formats: the SPZ, SOG and WebP decoders load only when first called, so
// importing `@margoengine/splats` or `/data` for PLY or `.splat` files does not pay for them.
import type { SplatData } from './data.js';
import type { ParseSogOptions, SogFiles } from './sog.js';
import type { ParseSpzOptions } from './spz.js';
import type { EncodeSpzOptions } from './encode.js';

/**
 * Decodes an SPZ file (versions 2, 3 and 4) to {@link SplatData}. Loads the decoder on first use (the Zstandard
 * decoder only when a version 4 file is read).
 * @throws TypeError when `input` is not bytes; RangeError for a damaged file or unknown version; MargoError
 * `unsupported` for a version 4 stream that needs a Zstandard dictionary.
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

/**
 * Encodes a cloud as an SPZ file (version 3, gzip), which `parseSpz` and SPZ readers decode. Loads the writer on
 * first use. Positions are 24-bit fixed point, opacity, colour and log scale one byte each, rotations the
 * smallest-three 10-bit packing, spherical harmonics one byte per coefficient.
 * @throws RangeError when `data` fails `validateSplats` or a coordinate does not fit the fixed point; MargoError
 * `unsupported` without `CompressionStream`.
 * @example
 * const bytes = await encodeSpz(parsePly(await (await fetch('scene.ply')).arrayBuffer()));
 */
export async function encodeSpz(data: SplatData, options?: EncodeSpzOptions): Promise<Uint8Array<ArrayBuffer>> {
  return (await import('./encode.js')).encodeSpz(data, options);
}

/**
 * Encodes a cloud as a bundled SOG scene (version 2: a ZIP of `meta.json` and lossless WebP textures), which
 * `parseSog` and SOG version 2 readers decode. Loads the writer on first use.
 * @throws RangeError when `data` fails `validateSplats`.
 * @example
 * const bytes = await encodeSog(parsePly(await (await fetch('scene.ply')).arrayBuffer()));
 */
export async function encodeSog(data: SplatData): Promise<Uint8Array<ArrayBuffer>> {
  return (await import('./encode.js')).encodeSog(data);
}

export type { EncodeSpzOptions, ParseSogOptions, ParseSpzOptions, SogFiles };
