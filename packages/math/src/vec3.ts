// 3-vectors as plain [x, y, z] arrays, shared by the packages (bundled into each). Results are new arrays. Keep the
// operand order: the packages rely on bit-identical results (examples/package-benchmarks/proofs/math-consolidation.proof.js).
type V3 = [number, number, number];
type In = ArrayLike<number>;

export const add = (a: In, b: In): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: In, b: In): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: In, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: In, b: In): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: In, b: In): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: In): number => Math.hypot(a[0], a[1], a[2]);
/** Unit vector, or [0, 0, 0] when the length is 0 or NaN. */
export const normalize = (a: In): V3 => {
  const l = length(a);
  return l ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
