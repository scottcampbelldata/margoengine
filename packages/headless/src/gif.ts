import { encodeGIFFrames, type GIFOptions } from '@margoengine/exporters/capture';
import type { HeadlessPixels } from './index.js';

/** GIF frame: RGBA pixels and optionally a per-frame delay. */
export interface GIFFrame extends HeadlessPixels {
  /** Seconds, 0.02..655.35. Default 1/fps. */
  duration?: number;
}

/** Options for animated GIF output. */
export interface EncodeGIFOptions extends GIFOptions {}

/**
 * Encodes renderFrames output or any sync/async RGBA stream to GIF89a bytes.
 * Defaults: fps 30, no dithering, loop 0 (forever), no signal. loop -1 plays
 * once; positive values repeat that many times. Explicit frame durations take
 * precedence over fps. Pixels below alpha 128 are transparent; others opaque.
 * Uses the same quantization as @margoengine/exporters/palette and the existing
 * exporter LZW writer, keeping at most one raw frame plus compressed output.
 */
export function encodeGIF(
  frames: AsyncIterable<GIFFrame> | Iterable<GIFFrame>,
  options: EncodeGIFOptions = {},
): Promise<Uint8Array> {
  return encodeGIFFrames(frames, options);
}
