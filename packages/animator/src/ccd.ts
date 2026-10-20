// Cyclic Coordinate Descent inverse kinematics (L.-C. T. Wang and C. C. Chen, "A combined optimization method for solving
// the inverse kinematics problem of mechanical manipulators", IEEE Trans. Robotics and Automation 7(4), 1991). Each sweep
// visits the joints from the last to the first; every joint turns, on its own, by the rotation that best moves the end
// effector toward the target (for a hinge: the angle about its axis), then its limit is applied and the joints after it
// are moved with it. With an orientation target, a joint also turns about its joint-to-effector line, which keeps the
// effector where it is, by the part of the orientation error that line can remove (the twist of the error about it).
//
// No allocation per solve: every number lives in a preallocated Float64Array. Helpers take arrays and offsets, never
// numbers, because a number passed to or returned from a call that the optimizer does not inline is boxed on the heap.
// Lengths use Math.sqrt: Math.hypot boxes its arguments (measured: 244 collections per 2 million 4-argument calls).
import type { Vec3 } from '@margoengine/core/extension';

/**
 * Per-axis Euler limits: the joint's rotation from its rest rotation, written as qX(x)·qY(y)·qZ(z) (core's XYZ order),
 * has each angle clamped to `[min, max]` (radians, within ±π). Equal bounds lock an axis.
 */
export interface CCDEulerLimit {
  type: 'euler';
  min: Vec3;
  max: Vec3;
}
/** A revolute joint: it turns only about `axis` (in the rest frame) by an angle from `min` to `max` (radians, default ±π, a full turn). */
export interface CCDHingeLimit {
  type: 'hinge';
  axis: Vec3;
  min?: number;
  max?: number;
}
/**
 * A ball joint: the bone axis stays within `angle` (radians) of its rest direction (swing), and the turn about the bone
 * axis stays within `twist` (radians, default free). `axis` is the bone axis in the rest frame; by default it points at
 * the next joint (the tip for the last joint), or +Y when that offset is zero.
 */
export interface CCDConeLimit {
  type: 'cone';
  angle: number;
  axis?: Vec3;
  twist?: readonly [number, number];
}
/** Rotation limit of one {@link CCDSolver} joint, relative to its rest rotation ({@link CCDSolver.rest}). */
export type CCDJointLimit = CCDEulerLimit | CCDHingeLimit | CCDConeLimit;

/** Result of {@link CCDSolver.solve}; the solver reuses one object, so read it before the next solve. */
export interface CCDResult {
  /** Sweeps run (0 when the effector already met the tolerances). */
  iterations: number;
  /** Final effector-to-target distance, world units. */
  distance: number;
  /** Final angle between the last joint's rotation and the target rotation, radians (0 without one). */
  angle: number;
  /** True when `distance` (and `angle`, with a rotation target) are within tolerance. */
  reached: boolean;
}

const FREE = 0,
  EULER = 1,
  HINGE = 2,
  CONE = 3,
  EPSILON = 1e-9,
  MAX_JOINTS = 256,
  PI = Math.PI;
// Scratch slots: quaternions (4 wide), vectors (3 wide) and scalars.
const DELTA = 0,
  AXIS = 4,
  ERROR = 8,
  TURN = 12,
  WORLD = 16,
  LOCAL = 20,
  TWIST = 24,
  GOAL = 28,
  DIRECTION = 32,
  TARGET = 36,
  POLE = 40,
  ANGLE = 44,
  HINGE_ANGLE = 45,
  TOLERANCE = 46,
  ANGLE_TOLERANCE = 47,
  MAX_ANGLE = 48,
  SLOTS = 52;
const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const finiteArray = (v: ArrayLike<number> | null | undefined, size: number): boolean => {
  if (!v || v.length !== size) return false;
  for (let i = 0; i < size; i++) if (!finiteNumber(v[i])) return false;
  return true;
};

// Quaternions are [x, y, z, w] at an offset into a Float64Array; out may alias a or b.
// out = a * b
function multiply(out: Float64Array, o: number, a: Float64Array, ao: number, b: Float64Array, bo: number): void {
  const ax = a[ao],
    ay = a[ao + 1],
    az = a[ao + 2],
    aw = a[ao + 3],
    bx = b[bo],
    by = b[bo + 1],
    bz = b[bo + 2],
    bw = b[bo + 3];
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
// out = conj(a) * b
function multiplyConjugate(
  out: Float64Array,
  o: number,
  a: Float64Array,
  ao: number,
  b: Float64Array,
  bo: number,
): void {
  const ax = -a[ao],
    ay = -a[ao + 1],
    az = -a[ao + 2],
    aw = a[ao + 3],
    bx = b[bo],
    by = b[bo + 1],
    bz = b[bo + 2],
    bw = b[bo + 3];
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
// out = a * conj(b)
function multiplyByConjugate(out: Float64Array, o: number, a: Float64Array, ao: number, b: Float64Array, bo: number) {
  const ax = a[ao],
    ay = a[ao + 1],
    az = a[ao + 2],
    aw = a[ao + 3],
    bx = -b[bo],
    by = -b[bo + 1],
    bz = -b[bo + 2],
    bw = b[bo + 3];
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
// out[o..o+2] = q v q^-1 for a unit q and the vector v[vo..vo+2]; out may alias v.
function rotate(out: Float64Array, o: number, q: Float64Array, qo: number, v: Float64Array, vo: number): void {
  const x = v[vo],
    y = v[vo + 1],
    z = v[vo + 2],
    qx = q[qo],
    qy = q[qo + 1],
    qz = q[qo + 2],
    qw = q[qo + 3],
    tx = 2 * (qy * z - qz * y),
    ty = 2 * (qz * x - qx * z),
    tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}
function normalize(q: Float64Array, o: number): void {
  const l = Math.sqrt(q[o] * q[o] + q[o + 1] * q[o + 1] + q[o + 2] * q[o + 2] + q[o + 3] * q[o + 3]);
  if (l < EPSILON) {
    q[o] = q[o + 1] = q[o + 2] = 0;
    q[o + 3] = 1;
    return;
  }
  q[o] /= l;
  q[o + 1] /= l;
  q[o + 2] /= l;
  q[o + 3] /= l;
}
// out = rotation by angle[ai] radians about the unit vector axis[ao..ao+2].
function axisAngle(out: Float64Array, o: number, axis: Float64Array, ao: number, angle: Float64Array, ai: number) {
  const s = Math.sin(angle[ai] / 2);
  out[o] = axis[ao] * s;
  out[o + 1] = axis[ao + 1] * s;
  out[o + 2] = axis[ao + 2] * s;
  out[o + 3] = Math.cos(angle[ai] / 2);
}
// a[i] wrapped to (-π, π].
function wrapAt(a: Float64Array, i: number): void {
  let v = a[i] % (2 * PI);
  if (v > PI) v -= 2 * PI;
  else if (v <= -PI) v += 2 * PI;
  a[i] = v;
}
// out[oi] = the signed angle (-π, π] of the rotation about unit axis[ao..] nearest to q (its twist about that axis).
function twistAngle(q: Float64Array, qo: number, axis: Float64Array, ao: number, out: Float64Array, oi: number) {
  out[oi] = 2 * Math.atan2(q[qo] * axis[ao] + q[qo + 1] * axis[ao + 1] + q[qo + 2] * axis[ao + 2], q[qo + 3]);
  wrapAt(out, oi);
}
// Shortens the unit rotation q to at most limit[li] radians about the same axis; q ends with w >= 0.
function limitAngle(q: Float64Array, o: number, limit: Float64Array, li: number): void {
  if (q[o + 3] < 0) for (let k = 0; k < 4; k++) q[o + k] = -q[o + k];
  const most = limit[li];
  if (most >= PI || 2 * Math.acos(Math.min(1, q[o + 3])) <= most) return;
  const s = Math.sqrt(q[o] * q[o] + q[o + 1] * q[o + 1] + q[o + 2] * q[o + 2]);
  if (s < EPSILON) return;
  const k = Math.sin(most / 2) / s;
  q[o] *= k;
  q[o + 1] *= k;
  q[o + 2] *= k;
  q[o + 3] = Math.cos(most / 2);
}

/**
 * Cyclic Coordinate Descent IK for a chain of any length (Wang and Chen 1991). Joint `i` sits at `offsets[i]` in the
 * frame of joint `i - 1` (joint 0: in the parent frame), turns by its local rotation `rotations[i]` and scales by
 * `scales[i]`; the end effector is `tip` in the last joint's frame. {@link solve} turns the joints in place so the
 * effector reaches the target, within per-joint limits ({@link setLimit}, relative to `rest`), and leaves the world
 * positions in `positions`. The solver owns all its storage and allocates nothing per solve.
 *
 * ```ts
 * const arm = new CCDSolver([[0, 0, 0], [0, 1, 0], [0, 1, 0]], [0, 0.5, 0]);
 * arm.setLimit(1, { type: 'hinge', axis: [0, 0, 1], min: 0, max: 2.6 });
 * arm.iterations = 24;
 * const result = arm.solve([1.2, 1.1, 0]); // arm.rotations now holds the solved local rotations
 * ```
 */
export class CCDSolver {
  /** Joint count. */
  readonly joints: number;
  /** Joint translations, x y z per joint: joint `i` in the frame of joint `i - 1` (joint 0 in the parent frame). */
  readonly offsets: Float64Array;
  /** Local joint rotations (x y z w per joint), read and written in place by {@link solve}. */
  readonly rotations: Float64Array;
  /** Uniform local joint scales (default 1). */
  readonly scales: Float64Array;
  /** Rest rotations the limits are measured from (x y z w per joint, default identity); see {@link captureRest}. */
  readonly rest: Float64Array;
  /** The end effector in the last joint's frame (default its origin). */
  readonly tip: Float64Array;
  /** World position of the chain's parent frame (default origin). */
  readonly parentPosition: Float64Array;
  /** World rotation of the chain's parent frame (x y z w, default identity). */
  readonly parentRotation: Float64Array;
  /** Uniform world scale of the chain's parent frame: element 0 (default 1). */
  readonly parentScale: Float64Array;
  /** World joint positions after {@link solve} or {@link update}: x y z per joint, then the end effector. */
  readonly positions: Float64Array;
  /** World joint rotations after {@link solve} or {@link update} (x y z w per joint). */
  readonly worldRotations: Float64Array;
  private readonly worldScales: Float64Array;
  private readonly types: Uint8Array;
  // 8 per joint. Euler: min xyz, max xyz. Hinge: axis xyz, min, max. Cone: axis xyz (NaN: default), angle, twist min, max.
  private readonly limits: Float64Array;
  private readonly scratch = new Float64Array(SLOTS);
  private readonly result: CCDResult = { iterations: 0, distance: 0.5, angle: 0.5, reached: false };
  /** Most sweeps per solve (0-1,024, default 16). */
  iterations = 16;
  /** Effector-to-target distance that counts as reached, world units (default 0.001). */
  tolerance = 0.001;
  /** Orientation error that counts as reached, radians (default 0.001). */
  angleTolerance = 0.001;
  /** Largest turn of one joint in one sweep, radians (default π: unlimited). Smaller steps spread the bend over the chain. */
  maxAngle = PI;

  /**
   * One joint per entry of `offsets` (1-256): its translation in the previous joint's frame (the first joint's in the
   * parent frame). `tip` is the end effector in the last joint's frame (default its origin, where only the last joint's
   * rotation is free for an orientation target).
   */
  constructor(offsets: readonly Vec3[], tip?: Vec3) {
    if (!Array.isArray(offsets) || offsets.length < 1 || offsets.length > MAX_JOINTS)
      throw new RangeError(`CCDSolver needs 1-${MAX_JOINTS} joint offsets; pass one [x, y, z] per joint`);
    const n = offsets.length;
    this.joints = n;
    this.offsets = new Float64Array(n * 3);
    this.rotations = new Float64Array(n * 4);
    this.rest = new Float64Array(n * 4);
    this.scales = new Float64Array(n).fill(1);
    this.positions = new Float64Array((n + 1) * 3);
    this.worldRotations = new Float64Array(n * 4);
    this.worldScales = new Float64Array(n);
    this.types = new Uint8Array(n);
    this.limits = new Float64Array(n * 8);
    this.tip = new Float64Array(3);
    this.parentPosition = new Float64Array(3);
    this.parentRotation = new Float64Array([0, 0, 0, 1]);
    this.parentScale = new Float64Array([1]);
    for (let i = 0; i < n; i++) {
      if (!finiteArray(offsets[i], 3))
        throw new TypeError(`CCDSolver offset ${i} must be 3 finite numbers; pass [x, y, z]`);
      this.offsets.set(offsets[i], i * 3);
      this.rotations[i * 4 + 3] = this.rest[i * 4 + 3] = 1;
    }
    if (tip !== undefined) {
      if (!finiteArray(tip, 3)) throw new TypeError('CCDSolver tip must be 3 finite numbers; pass [x, y, z]');
      this.tip.set(tip);
    }
    this.update();
  }

  /** Sets (or with null clears) joint `index`'s rotation limit, validated and copied; limits are relative to `rest`. */
  setLimit(index: number, limit: CCDJointLimit | null): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.joints)
      throw new RangeError(`CCD joint index must be an integer from 0 to ${this.joints - 1}`);
    const o = index * 8,
      l = this.limits;
    if (limit === null || limit === undefined) {
      this.types[index] = FREE;
      return;
    }
    const unit = (axis: unknown, label: string) => {
      const length = finiteArray(axis as Vec3, 3) ? Math.hypot(...(axis as Vec3)) : 0;
      if (length < EPSILON) throw new TypeError(`CCD ${label} must be a nonzero finite [x, y, z]`);
      for (let k = 0; k < 3; k++) l[o + k] = (axis as Vec3)[k] / length;
    };
    if (limit.type === 'euler') {
      if (
        !finiteArray(limit.min, 3) ||
        !finiteArray(limit.max, 3) ||
        [0, 1, 2].some((k) => limit.min[k] > limit.max[k] || limit.min[k] < -PI || limit.max[k] > PI)
      )
        throw new RangeError('CCD euler limit needs finite min <= max within [-π, π] on each axis');
      l.set(limit.min, o);
      l.set(limit.max, o + 3);
      this.types[index] = EULER;
    } else if (limit.type === 'hinge') {
      const min = limit.min ?? -PI,
        max = limit.max ?? PI;
      if (!finiteNumber(min) || !finiteNumber(max) || min > max || min < -PI || max > PI)
        throw new RangeError('CCD hinge limit needs finite min <= max within [-π, π]');
      unit(limit.axis, 'hinge axis');
      l[o + 3] = min;
      l[o + 4] = max;
      this.types[index] = HINGE;
    } else if (limit.type === 'cone') {
      const twist = limit.twist ?? [-PI, PI];
      if (!finiteNumber(limit.angle) || limit.angle < 0 || limit.angle > PI)
        throw new RangeError('CCD cone limit angle must be from 0 to π radians');
      if (!finiteArray(twist, 2) || twist[0] > twist[1] || twist[0] < -PI || twist[1] > PI)
        throw new RangeError('CCD cone twist must be [min, max] with min <= max within [-π, π]');
      if (limit.axis === undefined) l[o] = l[o + 1] = l[o + 2] = NaN;
      else unit(limit.axis, 'cone axis (or omit it)');
      l[o + 3] = limit.angle;
      l[o + 4] = twist[0];
      l[o + 5] = twist[1];
      this.types[index] = CONE;
    } else throw new TypeError("CCD limit type must be 'euler', 'hinge' or 'cone'");
  }
  /** Copies the current `rotations` into `rest`, so limits are measured from this pose. */
  captureRest(): void {
    this.rest.set(this.rotations);
  }
  /**
   * Sets the parent frame from a column-major world matrix with a positive uniform scale (a parent bone's matrix).
   * Throws RangeError for a sheared, mirrored or non-uniformly scaled matrix.
   */
  setParentMatrix(m: ArrayLike<number>): void {
    if (!finiteArray(m, 16)) throw new TypeError('CCD parent matrix must be 16 finite numbers (column-major)');
    const sx = Math.hypot(m[0], m[1], m[2]),
      sy = Math.hypot(m[4], m[5], m[6]),
      sz = Math.hypot(m[8], m[9], m[10]),
      det =
        m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (!(sx > EPSILON) || Math.abs(sy - sx) > 1e-4 * sx || Math.abs(sz - sx) > 1e-4 * sx || det <= 0)
      throw new RangeError('CCD parent frame needs a positive uniform scale; remove non-uniform or mirrored scales');
    // Rotation matrix (row, column) = m[column * 4 + row] / scale, to a quaternion (largest-component branch).
    const r00 = m[0] / sx,
      r10 = m[1] / sx,
      r20 = m[2] / sx,
      r01 = m[4] / sx,
      r11 = m[5] / sx,
      r21 = m[6] / sx,
      r02 = m[8] / sx,
      r12 = m[9] / sx,
      r22 = m[10] / sx,
      q = this.parentRotation,
      trace = r00 + r11 + r22;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      q[0] = (r21 - r12) / s;
      q[1] = (r02 - r20) / s;
      q[2] = (r10 - r01) / s;
      q[3] = 0.25 * s;
    } else if (r00 > r11 && r00 > r22) {
      const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
      q[0] = 0.25 * s;
      q[1] = (r01 + r10) / s;
      q[2] = (r02 + r20) / s;
      q[3] = (r21 - r12) / s;
    } else if (r11 > r22) {
      const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
      q[0] = (r01 + r10) / s;
      q[1] = 0.25 * s;
      q[2] = (r12 + r21) / s;
      q[3] = (r02 - r20) / s;
    } else {
      const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
      q[0] = (r02 + r20) / s;
      q[1] = (r12 + r21) / s;
      q[2] = 0.25 * s;
      q[3] = (r10 - r01) / s;
    }
    normalize(q, 0);
    this.parentPosition[0] = m[12];
    this.parentPosition[1] = m[13];
    this.parentPosition[2] = m[14];
    this.parentScale[0] = sx;
  }
  /** Recomputes `positions` and `worldRotations` from the current local data (forward kinematics). */
  update(): void {
    this.forward(0);
  }

  /**
   * Turns the joints so the end effector approaches `target` (world space), sweeping from the last joint to the first
   * until the tolerances are met or {@link iterations} sweeps ran. An unreachable target straightens the chain toward
   * it. `rotation` (x, y, z, w) is the world rotation the last joint should end with; `pole` is a world point the chain
   * bends toward (after each sweep the first joint turns the chain about its root-to-effector line to face it). Writes
   * `rotations` (each within its limit) and `positions`; returns the reused {@link CCDResult}. The settings are fields
   * of the solver, so a solve reads no numbers from caller objects and allocates nothing.
   */
  solve(target: Vec3, rotation: ArrayLike<number> | null = null, pole: Vec3 | null = null): CCDResult {
    if (!finiteArray(target, 3)) throw new TypeError('CCD target must be 3 finite numbers; pass [x, y, z]');
    const iterations = this.iterations,
      tolerance = this.tolerance,
      angleTolerance = this.angleTolerance,
      maxAngle = this.maxAngle,
      s = this.scratch;
    if (!Number.isInteger(iterations) || iterations < 0 || iterations > 1024)
      throw new RangeError('CCD iterations must be an integer from 0 to 1,024');
    if (!finiteNumber(tolerance) || tolerance < 0 || !finiteNumber(angleTolerance) || angleTolerance < 0)
      throw new RangeError('CCD tolerances must be finite and >= 0');
    if (!finiteNumber(maxAngle) || maxAngle <= 0) throw new RangeError('CCD maxAngle must be > 0 radians');
    if (pole !== null && pole !== undefined && !finiteArray(pole, 3))
      throw new TypeError('CCD pole must be 3 finite numbers or null');
    if (rotation !== null && rotation !== undefined) {
      if (!finiteArray(rotation, 4)) throw new TypeError('CCD rotation must be 4 finite numbers (x, y, z, w) or null');
      for (let k = 0; k < 4; k++) s[GOAL + k] = rotation[k];
      if (Math.abs(s[GOAL]) + Math.abs(s[GOAL + 1]) + Math.abs(s[GOAL + 2]) + Math.abs(s[GOAL + 3]) < EPSILON)
        throw new RangeError('CCD rotation must be a nonzero quaternion');
      normalize(s, GOAL);
    }
    const scale = this.parentScale[0];
    if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('CCD parentScale must be finite and > 0');
    for (let i = 0; i < this.joints; i++)
      if (!(this.scales[i] > 0) || !Number.isFinite(this.scales[i]))
        throw new RangeError(`CCD joint ${i} scale must be finite and > 0`);
    for (let k = 0; k < 3; k++) {
      s[TARGET + k] = target[k];
      if (pole) s[POLE + k] = pole[k];
    }
    s[TOLERANCE] = tolerance;
    s[ANGLE_TOLERANCE] = angleTolerance;
    s[MAX_ANGLE] = maxAngle;
    normalize(this.parentRotation, 0);
    // Start inside the limits.
    for (let i = 0; i < this.joints; i++) {
      normalize(this.rotations, i * 4);
      normalize(this.rest, i * 4);
      this.constrain(i);
    }
    this.forward(0);
    const oriented = rotation !== null && rotation !== undefined,
      bend = pole !== null && pole !== undefined;
    let done = 0;
    while (!this.measure(oriented) && done < iterations) {
      for (let i = this.joints - 1; i >= 0; i--) this.step(i, oriented);
      if (bend) this.bendToward();
      done++;
    }
    this.result.iterations = done;
    return this.result;
  }

  // Fills the result's distance and angle; true when both are within tolerance.
  private measure(oriented: boolean): boolean {
    const p = this.positions,
      s = this.scratch,
      e = this.joints * 3,
      result = this.result;
    const dx = p[e] - s[TARGET],
      dy = p[e + 1] - s[TARGET + 1],
      dz = p[e + 2] - s[TARGET + 2];
    result.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    result.angle = 0;
    if (oriented) {
      const w = this.worldRotations,
        o = (this.joints - 1) * 4,
        dot = Math.abs(w[o] * s[GOAL] + w[o + 1] * s[GOAL + 1] + w[o + 2] * s[GOAL + 2] + w[o + 3] * s[GOAL + 3]);
      result.angle = 2 * Math.acos(Math.min(1, dot));
    }
    result.reached = result.distance <= s[TOLERANCE] && result.angle <= s[ANGLE_TOLERANCE];
    return result.reached;
  }

  // One CCD joint update: turn joint i toward the target (and the orientation goal), limit it, move the joints after it.
  private step(i: number, oriented: boolean): void {
    const s = this.scratch,
      p = this.positions,
      w = this.worldRotations,
      n = this.joints,
      e = n * 3,
      last = (n - 1) * 4,
      io = i * 3,
      parent = i === 0 ? this.parentRotation : w,
      po = i === 0 ? 0 : (i - 1) * 4,
      ex = p[e] - p[io],
      ey = p[e + 1] - p[io + 1],
      ez = p[e + 2] - p[io + 2],
      tx = s[TARGET] - p[io],
      ty = s[TARGET + 1] - p[io + 1],
      tz = s[TARGET + 2] - p[io + 2],
      lever = Math.sqrt(ex * ex + ey * ey + ez * ez),
      reach = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (this.types[i] === HINGE) {
      // World hinge axis: parent * rest * axis.
      multiply(s, WORLD, parent, po, this.rest, i * 4);
      rotate(s, AXIS, s, WORLD, this.limits, i * 8);
      const wx = s[AXIS],
        wy = s[AXIS + 1],
        wz = s[AXIS + 2];
      let delta = 0;
      if (lever > EPSILON && reach > EPSILON) {
        // Both directions projected onto the plane of the turn; the signed angle between them is the turn.
        const de = ex * wx + ey * wy + ez * wz,
          dt = tx * wx + ty * wy + tz * wz,
          ax = ex - de * wx,
          ay = ey - de * wy,
          az = ez - de * wz,
          bx = tx - dt * wx,
          by = ty - dt * wy,
          bz = tz - dt * wz;
        if (Math.sqrt(ax * ax + ay * ay + az * az) < EPSILON || Math.sqrt(bx * bx + by * by + bz * bz) < EPSILON)
          return;
        delta = Math.atan2(
          wx * (ay * bz - az * by) + wy * (az * bx - ax * bz) + wz * (ax * by - ay * bx),
          ax * bx + ay * by + az * bz,
        );
      } else if (lever <= EPSILON && oriented) {
        multiplyByConjugate(s, ERROR, s, GOAL, w, last);
        twistAngle(s, ERROR, s, AXIS, s, ANGLE);
        delta = s[ANGLE];
      } else return;
      const most = s[MAX_ANGLE];
      delta = delta < -most ? -most : delta > most ? most : delta;
      multiplyConjugate(s, LOCAL, this.rest, i * 4, this.rotations, i * 4);
      twistAngle(s, LOCAL, this.limits, i * 8, s, HINGE_ANGLE);
      s[HINGE_ANGLE] += delta;
      this.setHinge(i, true);
      this.forward(i);
      return;
    }
    if (lever > EPSILON && reach > EPSILON) {
      // Shortest arc from the effector direction to the target direction.
      const d = (ex * tx + ey * ty + ez * tz) / (lever * reach);
      if (d < -1 + 1e-12) {
        // Opposite directions: half a turn about any axis perpendicular to the effector direction.
        let qx = 0,
          qy = -ez,
          qz = ey;
        if (Math.sqrt(qy * qy + qz * qz) < EPSILON * lever) {
          qx = ez;
          qy = 0;
          qz = -ex;
        }
        const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
        s[DELTA] = qx / l;
        s[DELTA + 1] = qy / l;
        s[DELTA + 2] = qz / l;
        s[DELTA + 3] = 0;
      } else {
        s[DELTA] = (ey * tz - ez * ty) / (lever * reach);
        s[DELTA + 1] = (ez * tx - ex * tz) / (lever * reach);
        s[DELTA + 2] = (ex * ty - ey * tx) / (lever * reach);
        s[DELTA + 3] = 1 + d;
        normalize(s, DELTA);
      }
      limitAngle(s, DELTA, s, MAX_ANGLE);
      if (oriented) {
        // Twist about the new joint-to-effector line toward the orientation goal; the effector stays put.
        s[DIRECTION] = ex / lever;
        s[DIRECTION + 1] = ey / lever;
        s[DIRECTION + 2] = ez / lever;
        rotate(s, AXIS, s, DELTA, s, DIRECTION);
        multiply(s, ERROR, s, DELTA, w, last);
        multiplyByConjugate(s, ERROR, s, GOAL, s, ERROR);
        twistAngle(s, ERROR, s, AXIS, s, ANGLE);
        axisAngle(s, TURN, s, AXIS, s, ANGLE);
        limitAngle(s, TURN, s, MAX_ANGLE);
        multiply(s, DELTA, s, TURN, s, DELTA);
      }
    } else if (lever <= EPSILON && oriented) {
      // The effector is at this joint: turning it only changes the orientation, so remove the whole error.
      multiplyByConjugate(s, DELTA, s, GOAL, w, last);
      normalize(s, DELTA);
      limitAngle(s, DELTA, s, MAX_ANGLE);
    } else return;
    // local' = conj(parent) * delta * world
    multiply(s, WORLD, s, DELTA, w, i * 4);
    multiplyConjugate(this.rotations, i * 4, parent, po, s, WORLD);
    normalize(this.rotations, i * 4);
    this.constrain(i);
    this.forward(i);
  }

  // Turns the first joint about the root-to-effector line so the chain's bend faces the pole (the effector stays put).
  private bendToward(): void {
    const p = this.positions,
      s = this.scratch,
      n = this.joints,
      e = n * 3,
      bends =
        Math.sqrt(this.tip[0] * this.tip[0] + this.tip[1] * this.tip[1] + this.tip[2] * this.tip[2]) > EPSILON
          ? n - 1
          : n - 2;
    if (bends < 1) return;
    let ax = p[e] - p[0],
      ay = p[e + 1] - p[1],
      az = p[e + 2] - p[2];
    const length = Math.sqrt(ax * ax + ay * ay + az * az);
    if (length < EPSILON) return;
    ax /= length;
    ay /= length;
    az /= length;
    // The bend: the joints between the root and the effector, less their part along the line.
    let bx = 0,
      by = 0,
      bz = 0;
    for (let j = 1; j <= bends; j++) {
      bx += p[j * 3] - p[0];
      by += p[j * 3 + 1] - p[1];
      bz += p[j * 3 + 2] - p[2];
    }
    const db = bx * ax + by * ay + bz * az,
      cx = s[POLE] - p[0],
      cy = s[POLE + 1] - p[1],
      cz = s[POLE + 2] - p[2],
      dc = cx * ax + cy * ay + cz * az;
    bx -= db * ax;
    by -= db * ay;
    bz -= db * az;
    const px = cx - dc * ax,
      py = cy - dc * ay,
      pz = cz - dc * az;
    if (Math.sqrt(bx * bx + by * by + bz * bz) < EPSILON || Math.sqrt(px * px + py * py + pz * pz) < EPSILON) return;
    s[ANGLE] = Math.atan2(
      ax * (by * pz - bz * py) + ay * (bz * px - bx * pz) + az * (bx * py - by * px),
      bx * px + by * py + bz * pz,
    );
    if (Math.abs(s[ANGLE]) < 1e-12) return;
    s[AXIS] = ax;
    s[AXIS + 1] = ay;
    s[AXIS + 2] = az;
    axisAngle(s, DELTA, s, AXIS, s, ANGLE);
    multiply(s, WORLD, s, DELTA, this.worldRotations, 0);
    multiplyConjugate(this.rotations, 0, this.parentRotation, 0, s, WORLD);
    normalize(this.rotations, 0);
    this.constrain(0);
    this.forward(0);
  }

  // Sets hinge joint i to the angle in scratch HINGE_ANGLE. A turn (`travel`) stops at the limit it runs into; a
  // projected pose takes the limit nearest around the circle; a full-turn hinge wraps.
  private setHinge(i: number, travel: boolean): void {
    const l = this.limits,
      o = i * 8,
      min = l[o + 3],
      max = l[o + 4],
      s = this.scratch,
      turned = s[HINGE_ANGLE];
    wrapAt(s, HINGE_ANGLE);
    if (min > -PI || max < PI) {
      if (travel) s[HINGE_ANGLE] = turned < min ? min : turned > max ? max : turned;
      else {
        const a = s[HINGE_ANGLE];
        if (a < min || a > max) {
          s[ANGLE] = a - min;
          wrapAt(s, ANGLE);
          const toMin = Math.abs(s[ANGLE]);
          s[ANGLE] = a - max;
          wrapAt(s, ANGLE);
          s[HINGE_ANGLE] = toMin <= Math.abs(s[ANGLE]) ? min : max;
        }
      }
    }
    axisAngle(s, TURN, l, o, s, HINGE_ANGLE);
    multiply(this.rotations, i * 4, this.rest, i * 4, s, TURN);
  }

  // Projects joint i's rotation into its limit: r = conj(rest) * q, limited, q = rest * r.
  private constrain(i: number): void {
    const type = this.types[i];
    if (type === FREE) return;
    const s = this.scratch,
      l = this.limits,
      o = i * 8,
      q = this.rotations,
      qo = i * 4;
    multiplyConjugate(s, LOCAL, this.rest, qo, q, qo);
    if (type === HINGE) {
      twistAngle(s, LOCAL, l, o, s, HINGE_ANGLE);
      this.setHinge(i, false);
      return;
    }
    if (type === EULER) {
      const x = s[LOCAL],
        y = s[LOCAL + 1],
        z = s[LOCAL + 2],
        w = s[LOCAL + 3],
        sinY = 2 * (x * z + w * y),
        rawX = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y)),
        rawY = Math.asin(sinY < -1 ? -1 : sinY > 1 ? 1 : sinY),
        rawZ = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z)),
        a = rawX < l[o] ? l[o] : rawX > l[o + 3] ? l[o + 3] : rawX,
        b = rawY < l[o + 1] ? l[o + 1] : rawY > l[o + 4] ? l[o + 4] : rawY,
        c = rawZ < l[o + 2] ? l[o + 2] : rawZ > l[o + 5] ? l[o + 5] : rawZ,
        sx = Math.sin(a / 2),
        cx = Math.cos(a / 2),
        sy = Math.sin(b / 2),
        cy = Math.cos(b / 2),
        sz = Math.sin(c / 2),
        cz = Math.cos(c / 2);
      // qX * qY * qZ, as @margoengine/math eulerToQuaternion.
      s[LOCAL] = sx * cy * cz + cx * sy * sz;
      s[LOCAL + 1] = cx * sy * cz - sx * cy * sz;
      s[LOCAL + 2] = cx * cy * sz + sx * sy * cz;
      s[LOCAL + 3] = cx * cy * cz - sx * sy * sz;
    } else {
      // Cone: r = swing * twist about the bone axis; clamp the twist angle, then the swing angle.
      if (Number.isNaN(l[o])) {
        const n = this.joints,
          v = i < n - 1 ? this.offsets : this.tip,
          vo = i < n - 1 ? (i + 1) * 3 : 0,
          length = Math.sqrt(v[vo] * v[vo] + v[vo + 1] * v[vo + 1] + v[vo + 2] * v[vo + 2]);
        if (length < EPSILON) {
          s[DIRECTION] = s[DIRECTION + 2] = 0;
          s[DIRECTION + 1] = 1;
        } else for (let k = 0; k < 3; k++) s[DIRECTION + k] = v[vo + k] / length;
      } else for (let k = 0; k < 3; k++) s[DIRECTION + k] = l[o + k];
      const ax = s[DIRECTION],
        ay = s[DIRECTION + 1],
        az = s[DIRECTION + 2],
        d = s[LOCAL] * ax + s[LOCAL + 1] * ay + s[LOCAL + 2] * az;
      twistAngle(s, LOCAL, s, DIRECTION, s, ANGLE);
      const twist = s[ANGLE];
      s[ANGLE] = twist < l[o + 4] ? l[o + 4] : twist > l[o + 5] ? l[o + 5] : twist;
      // swing = r * conj(raw twist), shortened to the cone; r = swing * clamped twist.
      s[TWIST] = d * ax;
      s[TWIST + 1] = d * ay;
      s[TWIST + 2] = d * az;
      s[TWIST + 3] = s[LOCAL + 3];
      normalize(s, TWIST);
      multiplyByConjugate(s, LOCAL, s, LOCAL, s, TWIST);
      limitAngle(s, LOCAL, l, o + 3);
      axisAngle(s, TWIST, s, DIRECTION, s, ANGLE);
      multiply(s, LOCAL, s, LOCAL, s, TWIST);
    }
    multiply(q, qo, this.rest, qo, s, LOCAL);
    normalize(q, qo);
  }

  // Forward kinematics from joint `from` to the end effector.
  private forward(from: number): void {
    const p = this.positions,
      w = this.worldRotations,
      ws = this.worldScales,
      n = this.joints;
    for (let i = from; i < n; i++) {
      const first = i === 0,
        pr = first ? this.parentRotation : w,
        po = first ? 0 : (i - 1) * 4,
        base = first ? this.parentPosition : p,
        bo = first ? 0 : (i - 1) * 3,
        scale = first ? this.parentScale[0] : ws[i - 1];
      rotate(p, i * 3, pr, po, this.offsets, i * 3);
      p[i * 3] = p[i * 3] * scale + base[bo];
      p[i * 3 + 1] = p[i * 3 + 1] * scale + base[bo + 1];
      p[i * 3 + 2] = p[i * 3 + 2] * scale + base[bo + 2];
      multiply(w, i * 4, pr, po, this.rotations, i * 4);
      ws[i] = scale * this.scales[i];
    }
    const e = n * 3,
      scale = ws[n - 1];
    rotate(p, e, w, (n - 1) * 4, this.tip, 0);
    p[e] = p[e] * scale + p[e - 3];
    p[e + 1] = p[e + 1] * scale + p[e - 2];
    p[e + 2] = p[e + 2] * scale + p[e - 1];
  }
}
