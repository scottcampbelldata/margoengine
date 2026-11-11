// Internal CPU ecotone warp, extracted without changing the classifier's expression order.
import { rangeError } from '../../shared/errors.js';
import { divFloor, ONE } from './fixed.js';
import { fbm } from './hash.js';

/** Wavelength of Margo's existing ecotone warp, mm. */
const WARP = 700_000;

/** CPU-generated noise corners; both axes retain their own lattice phase. */
export interface WarpLattice {
  readonly a0: number;
  readonly b0: number;
  readonly span: number;
  readonly rows: number;
  readonly warpA: Int32Array;
  readonly warpB: Int32Array;
}

/**
 * Builds the existing two CPU fbm lattices over an n by depth rectangle.
 * @throws RangeError when a lattice point's millimetre coordinate in Q16 passes 2^53 - 1 or a cell index leaves the
 * 32-bit range the shifts work in: past about 137,000 km from the origin the integers would round and wrap.
 */
export function warpLattice(seed: number, cell: number, gx: number, gz: number, n: number, depth: number): WarpLattice {
  // The farthest lattice point is 8 cells past the rectangle's far corner (two extra lattice rows, rounded down to 8).
  const far = Math.max(Math.abs(gx), Math.abs(gz), Math.abs(gx + n), Math.abs(gz + depth)) + 16;
  if (!(far < 0x7ffffff0 && far * cell * ONE <= Number.MAX_SAFE_INTEGER))
    throw rangeError('Biome cells are exact only within 137,000 km', 'biomes');
  // Warp noise on the 8-cell lattice covering this grid: lattice point (a, b) is global cell (8 (a0 + a), 8 (b0 + b)).
  // The lattice spans both axes on their own: a point's grid (sample) need not start at the same lattice phase in x
  // and z (a tile's always does).
  const a0 = gx >> 3,
    b0 = gz >> 3,
    span = ((gx + n) >> 3) - a0 + 2,
    rows = ((gz + depth) >> 3) - b0 + 2,
    warpA = new Int32Array(span * rows),
    warpB = new Int32Array(span * rows);
  for (let b = 0; b < rows; b++)
    for (let a = 0; a < span; a++) {
      const lx = divFloor((a0 + a) * 8 * cell * ONE, WARP),
        lz = divFloor((b0 + b) * 8 * cell * ONE, WARP);
      warpA[b * span + a] = fbm(seed ^ 0x5eed, lx, lz, 2);
      warpB[b * span + a] = fbm(seed ^ 0x7a1e, lz, lx, 2);
    }
  return { a0, b0, span, rows, warpA, warpB };
}

/** Writes the existing x-then-z floor interpolants and temperature delta into caller-owned planes. */
export function warpPlanes(
  lattice: WarpLattice,
  originX: number,
  originZ: number,
  n: number,
  depth: number,
  n2: Int32Array,
  dT: Int32Array,
  n1s?: Int32Array,
): void {
  const { a0, b0, span, warpA, warpB } = lattice;
  for (let j = 0; j < depth; j++) {
    const gz = originZ + j - b0 * 8,
      fz = (gz & 7) << 13,
      row = (gz >> 3) * span;
    for (let i = 0; i < n; i++) {
      const k = j * n + i,
        gx = originX + i - a0 * 8,
        fx = (gx & 7) << 13,
        at = row + (gx >> 3),
        // The warp is smooth (700 m): noise on a global 8-cell lattice, bilinear between lattice points.
        topA = warpA[at] + Math.floor(((warpA[at + 1] - warpA[at]) * fx) / ONE),
        bottomA = warpA[at + span] + Math.floor(((warpA[at + span + 1] - warpA[at + span]) * fx) / ONE),
        topB = warpB[at] + Math.floor(((warpB[at + 1] - warpB[at]) * fx) / ONE),
        bottomB = warpB[at + span] + Math.floor(((warpB[at + span + 1] - warpB[at + span]) * fx) / ONE),
        n1 = topA + Math.floor(((bottomA - topA) * fz) / ONE) - 32768; // -0.5..0.5 in Q16
      n2[k] = topB + Math.floor(((bottomB - topB) * fz) / ONE) - 32768;
      if (n1s) n1s[k] = n1;
      dT[k] = Math.floor((n1 * 160) / 32768); // +-1.6 K at the extremes, cK
    }
  }
}
