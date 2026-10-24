// The half-block boxes of slabs and stairs, shared by the block types, the mesher, light, physics and queries (a module
// of its own so those entries load this table alone).
import type { BlockShape } from './blocks.js';

// Octant masks (bit x + 2y + 4z for the half cell at (x, y, z), each 0 low or 1 high) per state data & 7: slabs
// (bottom, top), then stairs (+x, -x, +z, -z; then the same upside down).
const SLABS = [0x33, 0xcc],
  STAIRS = [0xbb, 0x77, 0xf3, 0x3f, 0xee, 0xdd, 0xfc, 0xcf];

/**
 * Octant mask of a block shape with state data `data`: 255 for a cube, 0 for shapes without a box (cross, liquid),
 * else the half cells a slab or stair fills (see `shapeOctants`).
 */
export const octants = (shape: BlockShape, data: number): number =>
  shape === 'cube' ? 255 : shape === 'slab' ? SLABS[(data >> 2) & 1] : shape === 'stair' ? STAIRS[data & 7] : 0;
