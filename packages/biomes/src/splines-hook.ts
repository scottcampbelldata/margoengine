// How the region entry and the editor reach path maths: the splines entry (`@margoengine/biomes/splines`) sets these
// when it loads, so neither holds its code and a world without paths never loads it.
import type { BrushFalloff } from './editor.js';
import type { Heights } from './height.js';
import type { PathOptions } from './splines.js';

/** Set by the splines entry. Positions are world millimetres. */
export const splinesHook: {
  /** Wraps a world's heights (minimum corner `origin`, mm) in the carve of `paths`. */
  carve?: (base: Heights, paths: readonly PathOptions[], origin: readonly [number, number]) => Heights;
  /** Checks the path of an edit and returns its frozen settings with every default filled in. */
  check?: (path: PathOptions) => PathOptions;
  /** The rectangle `[x0, z0, x1, z1]` a path's edge reaches. */
  box?: (path: PathOptions) => readonly [number, number, number, number];
  /** Path weights (Q16: 1 inside the width, falling to 0 across the edge) of `count` x `rows` samples `step` apart from (x0, z0). */
  raster?: (
    path: PathOptions,
    falloff: BrushFalloff,
    x0: number,
    z0: number,
    step: number,
    count: number,
    rows: number,
  ) => Int32Array;
} = {};
