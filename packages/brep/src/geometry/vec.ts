// Small 3D vector helpers on plain arrays (the kernel works in float64, in the file's length unit).
export type XYZ = [number, number, number];

export const add = (a: readonly number[], b: readonly number[]): XYZ => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: readonly number[], b: readonly number[]): XYZ => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: readonly number[], s: number): XYZ => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: readonly number[], b: readonly number[]): XYZ => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/**
 * |(x, y, z)|: a square root of the sum of squares, several times faster than Math.hypot in V8 (these run millions of
 * times an operation); Math.hypot where squaring would overflow or underflow (directions are dimensionless, so any
 * finite size reaches here).
 */
export const norm = (x: number, y: number, z: number): number => {
  const s = x * x + y * y + z * z;
  return s > 1e-280 && s < 1e280 ? Math.sqrt(s) : Math.hypot(x, y, z);
};
export const length = (a: readonly number[]): number => norm(a[0], a[1], a[2]);
export const distance = (a: readonly number[], b: readonly number[]): number =>
  norm(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** `a` scaled to unit length, or undefined when it has none. */
export const unit = (a: readonly number[]): XYZ | undefined => {
  const l = length(a);
  return l > 0 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : undefined;
};
/** Angle between two vectors in radians (0 when either is zero). */
export const angle = (a: readonly number[], b: readonly number[]): number => {
  const l = length(a) * length(b);
  return l > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(a, b) / l))) : 0;
};
/** `value` moved by whole periods to lie nearest `near`. */
export const nearest = (value: number, near: number, period: number): number =>
  period > 0 ? value + Math.round((near - value) / period) * period : value;
/**
 * The size a model's relative tolerances scale with: how far it reaches from the origin (its farthest point, or sphere
 * given as a centre and radius), but no more than the diagonal of its box, so the same wherever it sits. Its reach
 * alone lets a tolerance grow past the model's features far out (1e-6 of the reach of a part 1 km out on each axis is
 * 1.7 mm). No less than `rounding` (default `ROUNDING`) of its farthest coordinate, though: float64 rounds a coordinate
 * to 1.1e-16 of itself, and points computed twice far out part by many of those.
 */
export function modelSize(
  points: Iterable<readonly number[]>,
  spheres: Iterable<readonly [readonly number[], number]> = [],
  rounding = ROUNDING,
): number {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let reach = 0;
  const take = (p: readonly number[], r: number) => {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k] - r);
      max[k] = Math.max(max[k], p[k] + r);
    }
    reach = Math.max(reach, length(p) + r);
  };
  for (const p of points) take(p, 0);
  for (const [c, r] of spheres) take(c, Math.abs(r));
  if (!(max[0] >= min[0] && max[1] >= min[1] && max[2] >= min[2])) return 0;
  const far = Math.max(...min.map(Math.abs), ...max.map(Math.abs));
  return Math.max(Math.min(reach, norm(max[0] - min[0], max[1] - min[1], max[2] - min[2])), rounding * far);
}
/**
 * The least model size as a fraction of the farthest coordinate: 1e-9 of it (the Booleans' merge tolerance) is then
 * about 9 float64 roundings of that coordinate, and 1e-6 of it (where two points meet) about 9000.
 */
export const ROUNDING = 1e-6;
