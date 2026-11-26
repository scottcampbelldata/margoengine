import { MargoError } from '@margoengine/math/errors';
import { BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';

/** Read-only Cartesian coordinates in X/Y/Z. */
export type CrushVector = readonly [number, number, number];
export const ZERO: CrushVector = [0, 0, 0];

export function vector(v: CrushVector, label: string): CrushVector {
  if (!v.every(Number.isFinite)) throw new MargoError('state', `Choose finite coordinates for the crush ${label}.`);
  return [v[0], v[1], v[2]];
}

export function rowIndex(row: number, capacity: number): number {
  if (!Number.isSafeInteger(row) || row < 0 || row >= capacity)
    throw new MargoError('state', 'Choose existing body rows within the crush RigidSolver capacity.');
  return row;
}

export const add = (a: CrushVector, b: CrushVector): CrushVector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: CrushVector, b: CrushVector): CrushVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: CrushVector, factor: number): CrushVector => [a[0] * factor, a[1] * factor, a[2] * factor];
export const dot = (a: CrushVector, b: CrushVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: CrushVector, b: CrushVector): CrushVector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const triple = (words: Float32Array | Float64Array, at: number): CrushVector => [
  words[at]!,
  words[at + 1]!,
  words[at + 2]!,
];

export function rotation(values: Float32Array, row: number): (v: CrushVector) => CrushVector {
  const at = row * BODY_WORDS + 3;
  const axis = triple(values, at);
  const w = values[at + 3]!;
  const q2 = dot(axis, axis) + w * w;
  if (!(q2 > 0 && Number.isFinite(q2)))
    throw new MargoError('state', 'Use a live RigidSolver body row to each crush surface.');
  return (v: CrushVector) => {
    const twice = scale(cross(axis, v), 2 / q2); // float division: normalize the quaternion product
    return add(v, add(scale(twice, w), cross(axis, twice)));
  };
}

export function inertiaProduct(bodies: Float32Array, at: number, w: CrushVector): CrushVector {
  const [x, y, z] = w;
  const xx = bodies[at + 17]!,
    xy = bodies[at + 18]!,
    xz = bodies[at + 19]!;
  const yy = bodies[at + 20]!,
    yz = bodies[at + 21]!,
    zz = bodies[at + 22]!;
  return [xx * x + xy * y + xz * z, xy * x + yy * y + yz * z, xz * x + yz * y + zz * z];
}

export interface AtContact {
  readonly arm: CrushVector;
  readonly velocity: CrushVector;
  readonly inverseMass: number;
}

/** The current angular velocity including the impulses staged earlier in this solver step. */
export function angularAt(bodies: Float32Array, applied: Float64Array, row: number): CrushVector {
  const at = row * BODY_WORDS;
  return add(triple(bodies, at + 13), inertiaProduct(bodies, at, triple(applied, row * IMPULSE_WORDS + 3)));
}

export function atContact(
  bodies: Float32Array,
  applied: Float64Array,
  row: number,
  point: CrushVector,
  normal: CrushVector,
): AtContact {
  const at = row * BODY_WORDS;
  const reaction = row * IMPULSE_WORDS;
  const arm = sub(point, triple(bodies, at + 7));
  const inverse = bodies[at + 16]!;
  const linear = add(triple(bodies, at + 10), scale(triple(applied, reaction), inverse));
  const angular = angularAt(bodies, applied, row);
  const angularImpulse = cross(arm, normal);
  return {
    arm,
    velocity: add(linear, cross(angular, arm)),
    inverseMass: inverse + dot(angularImpulse, inertiaProduct(bodies, at, angularImpulse)),
  };
}

/** Accumulates a pure couple at a rigid row, independent of the moment from its point impulse. */
export function applyCouple(out: Float64Array, row: number, couple: CrushVector): void {
  const at = row * IMPULSE_WORDS + 3;
  out.set(add(triple(out, at), couple), at);
}

export function impulseAt(out: Float64Array, row: number, force: CrushVector, arm: CrushVector): void {
  const at = row * IMPULSE_WORDS;
  out.set(add(triple(out, at), force), at);
  out.set(add(triple(out, at + 3), cross(arm, force)), at + 3);
}
