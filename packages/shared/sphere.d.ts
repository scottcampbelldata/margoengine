/**
 * Radius of a local sphere moved by the column-major 4x4 at `m[o]` (exact for rotation and scale, an upper bound under
 * shear), padded for float32 by 1e-5 of the world centre's (`cx`, `cy`, `cz`) distance from the origin plus the radius.
 */
export function worldRadius(
  m: ArrayLike<number>,
  o: number,
  radius: number,
  cx?: number,
  cy?: number,
  cz?: number,
): number;
