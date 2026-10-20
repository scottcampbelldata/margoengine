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
// A square root, not Math.hypot: hypot is several times slower in V8 and these run millions of times an operation; the
// kernel's lengths (metres) are far from where squaring would overflow or underflow.
export const length = (a: readonly number[]): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const distance = (a: readonly number[], b: readonly number[]): number => {
  const x = a[0] - b[0],
    y = a[1] - b[1],
    z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
};
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
