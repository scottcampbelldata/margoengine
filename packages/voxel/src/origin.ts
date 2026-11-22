// Shared reading of a voxel `origin` (VoxelRendererOptions.origin): the float64 world point drawn at engine zero.
import type { VoxelOrigin } from './render.js';

/** Checks an `origin` option: null, undefined or an object with an `origin` array. */
export function checkOrigin(origin: unknown, who: string): VoxelOrigin | null {
  if (origin === undefined || origin === null) return null;
  if (typeof (origin as VoxelOrigin)?.origin?.length !== 'number')
    throw new TypeError(`${who} origin must be null or an object with origin [x, y, z], such as a FloatingOrigin`);
  return origin as VoxelOrigin;
}

/** The origin's point in float64, [0, 0, 0] for none. @throws RangeError for a value that is not a finite number. */
export function originPoint(origin: VoxelOrigin | null | undefined, who: string): [number, number, number] {
  const o = origin?.origin,
    p: [number, number, number] = [0, 0, 0];
  if (!o) return p;
  for (let a = 0; a < 3; a++) {
    const v = +o[a];
    if (!Number.isFinite(v))
      throw new RangeError(`${who} origin[${a}] ${o[a]} is not a finite number; pass three finite numbers`);
    p[a] = v;
  }
  return p;
}

/** `v` mod `n` in [0, n), in float64: where a world value falls in a wrapping window of `n` cells. */
export const wrap = (v: number, n: number): number => ((v % n) + n) % n;
