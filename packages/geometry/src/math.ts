/** A 2D point or vector, `[x, y]`. */
export type Vec2 = [number, number];
/** A 3D point or vector, `[x, y, z]`. */
export type Vec3 = [number, number, number];
/** Either dimension. Curves are generic over this. */
export type Vec = Vec2 | Vec3;

export const sub = <V extends Vec>(a: V, b: V): V => a.map((x, i) => x - b[i]) as V;
export const add = <V extends Vec>(a: V, b: V): V => a.map((x, i) => x + b[i]) as V;
export const scale = <V extends Vec>(a: V, s: number): V => a.map(x => x * s) as V;
export const lerp = <V extends Vec>(a: V, b: V, t: number): V => a.map((x, i) => x + (b[i] - x) * t) as V;
export const dot = (a: readonly number[], b: readonly number[]): number => {let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s;};
export const length = (a: readonly number[]): number => Math.sqrt(dot(a, a));
export const distance = (a: readonly number[], b: readonly number[]): number => {let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s);};
export const equals = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
export const normalize = <V extends Vec>(a: V): V => {const l = length(a); return (l > 0 ? scale(a, 1 / l) : a.slice()) as V;};
export const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const to3 = (a: readonly number[]): Vec3 => [a[0], a[1], a.length > 2 ? a[2] : 0];

/** Rotates `v` around the unit `axis` by `angle` radians (Rodrigues). */
export function rotateAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle), k = cross(axis, v), d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}
