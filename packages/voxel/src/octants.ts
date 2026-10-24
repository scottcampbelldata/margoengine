// The half-block boxes of slabs and stairs, shared by the block types, the mesher, light, physics and queries (a module
// of its own so those entries load these tables alone).
//
// Slab state data: bit 2 the upper half, bit 3 both halves (a double slab). Stair state data: bits 0-1 the side its
// full-height back faces (+x, -x, +z, -z), bit 2 upside down, bits 3-4 the corner (0 straight, 1 inner, 2 outer), bit
// 5 the corner's side on the other horizontal axis (0 its - side, 1 its + side), bit 6 a corner set by hand (which
// connectStairs keeps). Bit 15 of either: waterlogged.
import type { BlockShape } from './blocks.js';

/** Slab data bits: the upper half, both halves. */
export const SLAB_TOP = 4,
  SLAB_DOUBLE = 8,
  /** Stair data: the corner bits (3-5) and the hand-set corner bit. */
  STAIR_CORNER = 0x38,
  STAIR_FIXED = 64,
  /** Waterlogged: the block type's `waterlog` liquid fills the rest of its cell. */
  WATERLOGGED = 0x8000;

// Octant masks (bit x + 2y + 4z for the half cell at (x, y, z), each 0 low or 1 high) per state data.
const SLABS = Uint8Array.from({ length: 16 }, (_, d) => (d & SLAB_DOUBLE ? 255 : d & SLAB_TOP ? 0xcc : 0x33)),
  STAIRS = Uint8Array.from({ length: 64 }, (_, d) => {
    // The back's axis (x: bit shift 0, z: 2), the other horizontal axis, the back's half on it, the slab's half.
    const along = d & 2 ? 2 : 0,
      across = 2 - along,
      back = d & 1 ? 0 : 1,
      slab = d & 4 ? 1 : 0,
      corner = (d >> 3) & 3,
      side = (d >> 5) & 1;
    let mask = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k >> along) & 1,
        b = (k >> across) & 1;
      // The slab, then in the other half: the back's half (straight), that and the corner's quarter in front (inner),
      // or only the back's quarter on the corner's side (outer).
      if (((k >> 1) & 1) === slab) mask |= 1 << k;
      else if (corner === 2 ? a === back && b === side : corner === 1 ? a === back || b === side : a === back)
        mask |= 1 << k;
    }
    return mask;
  });

/** Octant mask of a slab with state data `data`. */
export const slabOctants = (data: number): number => SLABS[data & 15];
/** Octant mask of a stair with state data `data`. */
export const stairOctants = (data: number): number => STAIRS[data & 63];

/**
 * Octant mask of a block shape with state data `data`: 255 for a cube, 0 for shapes without a box (cross, liquid),
 * else the half cells a slab or stair fills (see `shapeOctants`).
 */
export const octants = (shape: BlockShape, data: number): number =>
  shape === 'cube' ? 255 : shape === 'slab' ? SLABS[data & 15] : shape === 'stair' ? STAIRS[data & 63] : 0;
