import { rangeError } from '../../shared/errors.js';
import type { PosePredicate } from './AvoidanceSolver.js';
import type { Vec3View } from './types.js';

/** Local rotation bounds, relative to the joint's rest frame; angles are radians. */
export type JointLimit =
  | { type: 'euler'; min: Vec3View; max: Vec3View }
  | { type: 'hinge'; axis: Vec3View; min?: number; max?: number }
  | { type: 'cone'; axis?: Vec3View; angle: number; twist?: readonly [number, number] };

type Compiled = { type: JointLimit['type']; axis: number[]; min: number[]; max: number[]; angle: number };
const pi = Math.PI;
function axisOf(value: Vec3View): number[] {
  if (value.length !== 3 || !Array.from(value).every(Number.isFinite))
    throw rangeError('Supply a finite three-component limit axis', 'kinematics');
  const n = Math.hypot(value[0], value[1], value[2]);
  if (!(n > 0 && Number.isFinite(n))) throw rangeError('Supply a nonzero finite limit axis', 'kinematics');
  return Array.from(value, (v) => v / n);
}
function bounds(min: number[], max: number[]): void {
  if (
    min.length !== max.length ||
    min.some((v, i) => !Number.isFinite(v) || !Number.isFinite(max[i]) || v < -pi || max[i] > pi || v > max[i])
  )
    throw rangeError('Supply ordered finite joint bounds within -pi..pi', 'kinematics');
}
/**
 * Compiled Euler XYZ, hinge and cone/swing-twist bounds. Checks, rather than clamps, complete candidate rotations.
 * Quaternions are local [x,y,z,w] in the rest frame. Null bounds allow that joint to rotate freely.
 */
export class JointLimitSet {
  private readonly limits: readonly (Compiled | null)[];
  private readonly tolerance: number;
  /** Copies bounds. Angular tolerance defaults to 1e-7 radians; it must be finite and nonnegative. */
  constructor(limits: readonly (JointLimit | null)[], tolerance = 1e-7) {
    if (!(tolerance >= 0 && Number.isFinite(tolerance)))
      throw rangeError('Supply a finite nonnegative limit tolerance', 'kinematics');
    this.tolerance = tolerance;
    this.limits = limits.map((limit) => {
      if (limit === null) return null;
      if (limit.type === 'euler') {
        const min = Array.from(limit.min),
          max = Array.from(limit.max);
        if (min.length !== 3 || max.length !== 3) throw rangeError('Supply three Euler bounds per joint', 'kinematics');
        bounds(min, max);
        return { type: limit.type, axis: [], min, max, angle: 0 };
      }
      if (limit.type !== 'hinge' && limit.type !== 'cone')
        throw rangeError('Choose an Euler, hinge or cone joint limit', 'kinematics');
      const axis = axisOf(limit.axis ?? [0, 1, 0]);
      const min = [limit.type === 'hinge' ? (limit.min ?? -pi) : (limit.twist?.[0] ?? -pi)];
      const max = [limit.type === 'hinge' ? (limit.max ?? pi) : (limit.twist?.[1] ?? pi)];
      bounds(min, max);
      const angle = limit.type === 'cone' ? limit.angle : 0;
      if (!(angle >= 0 && angle <= pi)) throw rangeError('Supply a cone angle from zero to pi', 'kinematics');
      return { type: limit.type, axis, min, max, angle };
    });
  }
  /** Rejects missing, nonfinite, zero or out-of-bound rotations, without modifying any rotation or limit. */
  accepts(rotations: readonly ArrayLike<number>[]): boolean {
    if (rotations.length !== this.limits.length) return false;
    const tol = this.tolerance;
    for (let i = 0; i < this.limits.length; i++) {
      const q = rotations[i];
      if (!q || q.length !== 4 || !Array.from(q).every(Number.isFinite)) return false;
      const length = Math.hypot(q[0], q[1], q[2], q[3]);
      if (!(length > 0 && Number.isFinite(length))) return false;
      const x = q[0] / length,
        y = q[1] / length,
        z = q[2] / length,
        w = q[3] / length;
      const limit = this.limits[i];
      if (!limit) continue;
      const { axis, min, max } = limit;
      if (limit.type === 'euler') {
        // R = Rx Ry Rz, derived by multiplying those three rotation matrices.
        const r13 = Math.max(-1, Math.min(1, 2 * (x * z + y * w)));
        const beta = Math.asin(r13);
        let alpha: number, gamma: number;
        if (Math.abs(r13) < 1 - 1e-12) {
          alpha = Math.atan2(2 * (x * w - y * z), 1 - 2 * (x * x + y * y));
          gamma = Math.atan2(2 * (z * w - x * y), 1 - 2 * (y * y + z * z));
        } else {
          // At gimbal lock alpha +/- gamma is observable; test whether any equivalent pair satisfies the box.
          const combined = Math.atan2(2 * (x * w + y * z), 1 - 2 * (x * x + z * z));
          if (beta < min[1] - tol || beta > max[1] + tol) return false;
          const low = min[0] + (r13 > 0 ? min[2] : -max[2]);
          const high = max[0] + (r13 > 0 ? max[2] : -min[2]);
          if (![-2 * pi, 0, 2 * pi].some((shift) => combined + shift >= low - tol && combined + shift <= high + tol))
            return false;
          continue;
        }
        const values = [alpha, beta, gamma];
        // XYZ also has the equivalent branch (x+pi, pi-y, z+pi).
        const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
        const alternate = [wrap(alpha + pi), wrap(pi - beta), wrap(gamma + pi)];
        if (
          ![values, alternate].some((v) =>
            v.every((a, k) => [-2 * pi, 0, 2 * pi].some((s) => a + s >= min[k] - tol && a + s <= max[k] + tol)),
          )
        )
          return false;
      } else {
        const projection = x * axis[0] + y * axis[1] + z * axis[2];
        const swing = 2 * Math.acos(Math.min(1, Math.hypot(projection, w)));
        if (swing > limit.angle + tol) return false;
        // The twist at a 180-degree swing is undefined; accept only an unrestricted twist interval.
        if (Math.hypot(projection, w) < 1e-12) {
          if (min[0] > -pi || max[0] < pi) return false;
          continue;
        }
        const twist = 2 * Math.atan2(projection, w);
        const angle = Math.atan2(Math.sin(twist), Math.cos(twist));
        const atPi = Math.abs(Math.abs(angle) - pi) <= tol;
        if (
          !(angle >= min[0] - tol && angle <= max[0] + tol) &&
          !(atPi && -angle >= min[0] - tol && -angle <= max[0] + tol)
        )
          return false;
      }
    }
    return true;
  }
}

/** Reads each candidate's local, rest-relative joint rotations, in the same order as its limit set. */
export type CandidateRotations = (
  root: Vec3View,
  elbow: Vec3View,
  target: Vec3View,
  poleAngle: number,
) => readonly ArrayLike<number>[];

/** Builds SolveOptions.acceptPose; the regular obstacle search continues past clear but illegal candidates. */
export function jointLimitPredicate(limits: JointLimitSet, rotations: CandidateRotations): PosePredicate {
  return (root, elbow, target, angle) => limits.accepts(rotations(root, elbow, target, angle));
}
