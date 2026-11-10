import type { BlockType } from './blocks.js';
import { octants } from './octants.js';

/** One axis-aligned box in cell coordinates, with UV corners per face (+x,-x,+y,-y,+z,-z). */
export interface ModelBox {
  /** Minimum corner, in [0,1]. */
  readonly min: readonly [number, number, number];
  /** Maximum corner, in [0,1]. */
  readonly max: readonly [number, number, number];
  /** Four UV pairs per face, counter-clockwise from its first corner. */
  readonly uv: readonly (readonly number[])[];
  /** Texture layer per face. */
  readonly textures: readonly number[];
}
/** Precomputed model orientation, stored as plain data for workers. */
export interface ModelOrientation {
  /** Rotated boxes. */
  readonly boxes: readonly ModelBox[];
  /** Six-bit mask of cell boundary faces covered completely by the union. */
  readonly covered: number;
}

const UNIT: ModelBox = { min: [0, 0, 0], max: [1, 1, 1], uv: [], textures: [] };
/** Internal common shape adapter for collision and surface extraction. */
export function cellBoxes(type: BlockType, state: number): readonly ModelBox[] {
  if (type.model) return type.model[(state >>> 16) % type.model.length].boxes;
  if (type.shape !== 'slab' && type.shape !== 'stair') return [UNIT];
  const mask = octants(type.shape, state >>> 16),
    out: ModelBox[] = [];
  for (let i = 0; i < 8; i++)
    if (mask & (1 << i)) {
      const x = (i & 1) / 2,
        y = ((i >> 1) & 1) / 2,
        z = ((i >> 2) & 1) / 2;
      out.push({ min: [x, y, z], max: [x + 0.5, y + 0.5, z + 0.5], uv: [], textures: [] });
    }
  return out;
}
