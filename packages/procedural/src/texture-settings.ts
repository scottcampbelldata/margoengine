import type { TextureBakeOptions, TexturePattern } from './textures.js';
import { fault } from '../../shared/errors.js';
const patterns: TexturePattern[] = ['noise', 'bricks', 'tiles', 'wood', 'rust'];
const bounded = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
const integer = (v: number, lo: number, hi: number) => Number.isInteger(v) && bounded(v, lo, hi);
const tuple = (v: unknown, count: number, lo: number, hi: number): v is number[] =>
  Array.isArray(v) && v.length === count && v.every((x) => bounded(x, lo, hi));

export function textureSettings(options: TextureBakeOptions, maximumDimension: number) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fault('failed', 'Texture bake options must be an object', 'procedural');
  options?.signal?.throwIfAborted();
  const {
    width = 256,
    height = 256,
    seed = 1,
    pattern = 'bricks',
    repeat = [4, 8],
    detail = 0.2,
    grout = 0.08,
    stagger = 0.5,
    color = [0.55, 0.2, 0.08],
    secondary = [0.15, 0.12, 0.1],
    offset = [0, 0],
    signal,
  } = options;
  const kind = patterns.indexOf(pattern),
    maximum = Math.min(2048, maximumDimension);
  if (
    kind < 0 ||
    !integer(width, 16, maximum) ||
    !integer(height, 16, maximum) ||
    !integer(seed, 0, 0xffffffff) ||
    !tuple(repeat, 2, 1, 64) ||
    !repeat.every(Number.isInteger) ||
    (kind === 1 && repeat[1] % 2 !== 0) ||
    !bounded(detail, 0, 1) ||
    !bounded(grout, 0, 0.45) ||
    !bounded(stagger, 0, 1) ||
    !tuple(color, 3, 0, 1) ||
    !tuple(secondary, 3, 0, 1) ||
    !tuple(offset, 2, -1024, 1024)
  )
    throw fault(
      'failed',
      'Invalid texture bake settings; use bounded dimensions, colours and integer repeats (even brick rows)',
      'procedural',
    );
  return { width, height, seed, pattern, repeat, detail, grout, stagger, color, secondary, offset, signal, kind };
}
