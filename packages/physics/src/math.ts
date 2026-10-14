import {eulerToQuaternion} from '@margoengine/math/quat';

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export const vec = (v: Vec3 | undefined, fallback: Vec3 = [0, 0, 0]): {x: number; y: number; z: number} => {
  const [x, y, z] = v ?? fallback;
  return {x, y, z};
};
export const quat = (q: Quat | undefined): {x: number; y: number; z: number; w: number} => {
  const [x, y, z, w] = q ?? [0, 0, 0, 1];
  return {x, y, z, w};
};
export const tuple = (v: {x: number; y: number; z: number}): [number, number, number] => [v.x, v.y, v.z];
export const tuple4 = (q: {x: number; y: number; z: number; w: number}): [number, number, number, number] => [q.x, q.y, q.z, q.w];

export function checkVec(value: unknown, label: string): asserts value is Vec3 {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError(`${label} must be [x, y, z]`);
  const v = value as ArrayLike<number>;
  if (v.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) throw new RangeError(`${label} must be three finite numbers`);
}

/** Same XYZ Euler convention as core's `Mesh.setRotation` (`@margoengine/math/quat` eulerToQuaternion). */
export const eulerToQuat: (x: number, y: number, z: number) => [number, number, number, number] = eulerToQuaternion;

/** Shortest-arc spherical interpolation of quaternions stored at `a` and `b` in `source`, written to `out`. */
export function slerp(source: ArrayLike<number>, a: number, b: number, t: number, out: number[]): void {
  const ax = source[a], ay = source[a + 1], az = source[a + 2], aw = source[a + 3];
  let bx = source[b], by = source[b + 1], bz = source[b + 2], bw = source[b + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw;}
  let k0: number, k1: number;
  if (cos > 0.9995) {k0 = 1 - t; k1 = t;}
  else {const angle = Math.acos(cos), sin = Math.sin(angle); k0 = Math.sin((1 - t) * angle) / sin; k1 = Math.sin(t * angle) / sin;}
  out[0] = ax * k0 + bx * k1; out[1] = ay * k0 + by * k1; out[2] = az * k0 + bz * k1; out[3] = aw * k0 + bw * k1;
  const length = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  for (let i = 0; i < 4; i++) out[i] /= length;
}
