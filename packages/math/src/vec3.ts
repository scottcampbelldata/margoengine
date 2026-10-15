// 3-vectors as plain [x, y, z] arrays, shared by the packages (bundled into each). Results are new arrays. Keep the
// operand order: the packages rely on bit-identical results (examples/package-benchmarks/proofs/math-consolidation.proof.js).
import type { MutableVec3 } from './types.js';

type In = ArrayLike<number>;

/** a + b as a new array (reads the first three elements of each). */
export const add = (a: In, b: In): MutableVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** a - b as a new array. */
export const sub = (a: In, b: In): MutableVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** a * s as a new array. */
export const scale = (a: In, s: number): MutableVec3 => [a[0] * s, a[1] * s, a[2] * s];
/** Dot product a · b. */
export const dot = (a: In, b: In): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Cross product a × b (right-handed) as a new array. */
export const cross = (a: In, b: In): MutableVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Euclidean length |a| (`Math.hypot`, so no overflow for large components). */
export const length = (a: In): number => Math.hypot(a[0], a[1], a[2]);
/** Unit vector, or [0, 0, 0] when the length is 0 or NaN. */
export const normalize = (a: In): MutableVec3 => {
  const l = length(a);
  return l ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
