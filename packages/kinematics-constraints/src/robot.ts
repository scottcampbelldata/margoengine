// The `robot` entry: a tree of revolute, prismatic and fixed joints with collision shapes on its links. Forward
// kinematics is the plain product of each joint's fixed origin and its own motion. The swept check, the joint-limit
// solver, the planner and the URDF reader all work on this one model.
import { rangeError, typeError } from '../../shared/errors.js';
import { ConvexHullVolume, hullPoints } from './hull.js';
import type { ConstraintVolume, Vec3View } from './types.js';
import { validateVector } from './types.js';
import { closestPointsBetweenSegments, segmentVolumeInto, type SegmentDistanceResult } from './volumes.js';

/** How a joint moves: `continuous` is a revolute joint with no limits, `fixed` does not move. */
export type RobotJointType = 'revolute' | 'continuous' | 'prismatic' | 'fixed';

/** One joint of a {@link Robot}. */
export interface RobotJointOptions {
  /** Name the other joints and the shapes can use. Defaults to `joint<index>`. */
  name?: string;
  /** Default `'revolute'`. */
  type?: RobotJointType;
  /** Joint this one rides on, by index or name; `null` is the robot's base. It must come earlier. Defaults to the joint before. */
  parent?: number | string | null;
  /** Column-major affine matrix of 16 values: this joint's frame in its parent's frame at position zero, rigid. Defaults to the identity. */
  origin?: ArrayLike<number>;
  /** Axis of the motion in the joint's own frame. Defaults to `[0, 0, 1]`. */
  axis?: Vec3View;
  /** Lowest position: radians, or scene units on a prismatic joint. Required on `revolute` and `prismatic`. */
  lower?: number;
  /** Highest position, as `lower`. */
  upper?: number;
  /** This joint repeats another: its position is the other's times `multiplier` (default 1) plus `offset` (default 0). */
  mimic?: { joint: number | string; multiplier?: number; offset?: number };
}

/** A capsule, or with no `end` a sphere, in a joint's frame. */
export interface RobotCapsuleShape {
  /** Joint the shape rides on, by index or name; `null` is the base. */
  joint: number | string | null;
  /** Default the joint's origin. */
  start?: Vec3View;
  /** Default `start`, which makes a sphere. */
  end?: Vec3View;
  radius: number;
}
/** A convex hull in a joint's frame. */
export interface RobotHullShape {
  joint: number | string | null;
  /** Flat `x, y, z` hull corners in the joint's frame, or in `matrix`'s frame. */
  points: ArrayLike<number>;
  /** Column-major affine matrix of 16 values placing the points in the joint's frame. Defaults to the identity. */
  matrix?: ArrayLike<number>;
  /** As on `ConvexHullVolume`. Default the number of points given. */
  maxPoints?: number;
}
/** A collision shape on a link: {@link RobotCapsuleShape} or {@link RobotHullShape}. */
export type RobotShapeOptions = RobotCapsuleShape | RobotHullShape;

/** Options of {@link Robot}. */
export interface RobotOptions {
  /** In order, each after its parent. */
  joints: readonly RobotJointOptions[];
  /** Collision shapes. Default none. */
  shapes?: readonly RobotShapeOptions[];
  /** Column-major affine matrix of 16 values placing the base in the world. Defaults to the identity. */
  base?: ArrayLike<number>;
}

/** A {@link Robot} as plain numbers, for a kernel of your own: see {@link Robot.describe}. */
export interface RobotData {
  /** Per joint: 0 turns, 1 slides, 2 is fixed. */
  kinds: Uint8Array;
  /** Per joint: its parent joint; -1 is the base. */
  parents: Int32Array;
  /** Per joint: the configuration entry driving it; -1 on a fixed joint. */
  variable: Int32Array;
  /** Per joint: its position is the entry times this, plus {@link RobotData.offsets}. */
  multipliers: Float64Array;
  offsets: Float64Array;
  /** Twelve per joint: the columns of its 3x4 origin. */
  origins: Float64Array;
  /** Three per joint: its unit axis. */
  axes: Float64Array;
  /** The columns of the base's 3x4 matrix. */
  base: Float64Array;
  /** Per shape: its joint (-1 is the base), its radius, and its points in that joint's frame, flat. A capsule has two. */
  shapes: { joint: number; radius: number; points: Float64Array }[];
}

const REVOLUTE = 0,
  PRISMATIC = 1,
  FIXED = 2;
const IDENTITY = /* @__PURE__ */ Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function matrix12(source: ArrayLike<number>, name: string): Float64Array {
  if (!source || source.length !== 16) throw typeError(`${name} must have 16 values`, 'kinematics');
  const out = new Float64Array(12);
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(source[i])) throw rangeError(`${name} must be finite`, 'kinematics');
    if (i % 4 < 3) out[i - Math.floor(i / 4)] = source[i];
  }
  if (source[3] !== 0 || source[7] !== 0 || source[11] !== 0 || source[15] !== 1)
    throw rangeError(`${name} must be affine; its last row must be 0, 0, 0, 1`, 'kinematics');
  return out;
}

/** out = a * b, for 3x4 column-major frames at the given element offsets. `out` may not overlap either input. */
function multiply(a: Float64Array, ao: number, b: Float64Array, bo: number, out: Float64Array, oo: number): void {
  for (let c = 0; c < 4; c++) {
    const x = b[bo + c * 3],
      y = b[bo + c * 3 + 1],
      z = b[bo + c * 3 + 2];
    for (let r = 0; r < 3; r++) {
      out[oo + c * 3 + r] = a[ao + r] * x + a[ao + 3 + r] * y + a[ao + 6 + r] * z + (c === 3 ? a[ao + 9 + r] : 0);
    }
  }
}

/** The local motion of one joint at `value`, as a 3x4 frame. */
function motion(type: number, axis: Float64Array, at: number, value: number, out: Float64Array): void {
  const x = axis[at],
    y = axis[at + 1],
    z = axis[at + 2];
  if (type === PRISMATIC) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 1;
    out[5] = 0;
    out[6] = 0;
    out[7] = 0;
    out[8] = 1;
    out[9] = x * value;
    out[10] = y * value;
    out[11] = z * value;
    return;
  }
  const c = Math.cos(value),
    s = Math.sin(value),
    k = 1 - c;
  out[0] = c + x * x * k;
  out[1] = y * x * k + z * s;
  out[2] = z * x * k - y * s;
  out[3] = x * y * k - z * s;
  out[4] = c + y * y * k;
  out[5] = z * y * k + x * s;
  out[6] = x * z * k + y * s;
  out[7] = y * z * k - x * s;
  out[8] = c + z * z * k;
  out[9] = 0;
  out[10] = 0;
  out[11] = 0;
}

const local = /* @__PURE__ */ new Float64Array(12);
const placed = /* @__PURE__ */ new Float64Array(12);
const matrix16 = /* @__PURE__ */ new Float64Array(16);
const distance = /* @__PURE__ */ new Float64Array(1);
const closest: SegmentDistanceResult = /* @__PURE__ */ (() => ({
  pointA: new Float64Array(3),
  pointB: new Float64Array(3),
  distance: 0,
  parameterA: 0,
  parameterB: 0,
}))();

interface PlacedShape {
  joint: number;
  /** Distance from the joint's origin to the farthest point of the shape. */
  extent: number;
  radius: number;
  /** Capsule ends in the joint's frame, then at the current pose in the world. */
  localEnds: Float64Array;
  start: Float64Array;
  end: Float64Array;
  /** Set on a hull: its matrix in the joint's frame and the hull itself. */
  offset: Float64Array | null;
  hull: ConvexHullVolume | null;
}

/**
 * A robot, or any tree of joints: forward kinematics, joint ranges, and collision shapes that follow the links. It is
 * plain data and maths; bind it to a skeleton or a scene yourself by reading {@link Robot.frameMatrix}.
 *
 * A configuration `q` holds one number per moving joint that repeats no other, in joint order. Results and frames are
 * reused between calls, so read them before the next one.
 *
 * @example
 * ```ts
 * import { SphereVolume } from 'margoengine/kinematics-constraints';
 * import { Robot } from 'margoengine/kinematics-constraints/robot';
 *
 * const up = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1]; // one unit along z
 * const arm = new Robot({
 *   joints: [{ lower: -3, upper: 3 }, { origin: up, axis: [0, 1, 0], lower: -2, upper: 2 }],
 *   shapes: [{ joint: 1, end: [0, 0, 1], radius: 0.1 }],
 * });
 * const gap = arm.clearance([0, 0.5], [new SphereVolume({ center: [2, 0, 1], radius: 0.25 })]);
 * ```
 */
export class Robot {
  /** Numbers in a configuration. */
  readonly dof: number;
  /** Joints, moving or not. */
  readonly jointCount: number;
  /** Collision shapes. */
  readonly shapeCount: number;
  /** Lowest value per configuration entry; `-Infinity` on a continuous joint. */
  readonly lower: Float64Array;
  /** Highest value per configuration entry; `Infinity` on a continuous joint. */
  readonly upper: Float64Array;
  /** Joint names, in joint order. */
  readonly jointNames: readonly string[];
  /** Name of the joint behind each configuration entry. */
  readonly variableNames: readonly string[];
  /** Index of each joint's parent; -1 is the base. */
  readonly parents: Int32Array;
  /** The joint each shape rides on; -1 is the base. */
  readonly shapeJoints: Int32Array;
  /** The world frames of the last pose: twelve numbers per joint, the columns of a 3x4 matrix. Read, do not write. */
  readonly frames: Float64Array;

  private readonly kinds: Uint8Array;
  private readonly origins: Float64Array;
  private readonly axes: Float64Array;
  /** Per joint: configuration entry driving it, or -1. */
  private readonly variable: Int32Array;
  private readonly multipliers: Float64Array;
  private readonly offsets: Float64Array;
  private readonly offsetLengths: Float64Array;
  private readonly base: Float64Array;
  private readonly shapes: PlacedShape[];
  /** Pairs of shapes that a self check tests, two indices each. */
  private selfPairs: Int32Array;
  /** Shape behind the last {@link clearance}, then the collider (-1 for a pair of shapes) or second shape. */
  private readonly nearest = new Int32Array(2);

  constructor(options: RobotOptions) {
    const joints = options?.joints;
    if (!Array.isArray(joints) || joints.length === 0)
      throw typeError('A Robot needs joints: pass at least one', 'kinematics');
    const count = joints.length,
      names: string[] = [],
      index = new Map<string, number>();
    this.kinds = new Uint8Array(count);
    this.origins = new Float64Array(count * 12);
    this.axes = new Float64Array(count * 3);
    this.variable = new Int32Array(count).fill(-1);
    this.multipliers = new Float64Array(count).fill(1);
    this.offsets = new Float64Array(count);
    this.offsetLengths = new Float64Array(count);
    this.parents = new Int32Array(count);
    const lower: number[] = [],
      upper: number[] = [],
      variables: string[] = [];
    const resolve = (ref: number | string, at: number, what: string): number => {
      const found = typeof ref === 'string' ? index.get(ref) : ref;
      if (found === undefined || !Number.isInteger(found) || found < 0 || found >= at)
        throw rangeError(`${what} ${String(ref)} must name an earlier joint`, 'kinematics');
      return found;
    };
    joints.forEach((joint: RobotJointOptions, j: number) => {
      const name = joint.name ?? `joint${j}`;
      if (index.has(name)) throw rangeError(`Two joints are named ${name}`, 'kinematics');
      index.set(name, j);
      names.push(name);
      const type = joint.type ?? 'revolute',
        kind = type === 'fixed' ? FIXED : type === 'prismatic' ? PRISMATIC : REVOLUTE;
      if (type !== 'revolute' && type !== 'continuous' && type !== 'prismatic' && type !== 'fixed')
        throw rangeError(
          `Unknown joint type ${String(type)}; use revolute, continuous, prismatic or fixed`,
          'kinematics',
        );
      this.kinds[j] = kind;
      const parent =
        joint.parent === undefined ? j - 1 : joint.parent === null ? -1 : resolve(joint.parent, j, 'Parent');
      this.parents[j] = parent;
      const origin = matrix12(joint.origin ?? IDENTITY, `Joint ${name} origin`);
      this.origins.set(origin, j * 12);
      this.offsetLengths[j] = Math.hypot(origin[9], origin[10], origin[11]);
      if (kind === FIXED) return;
      const axis = joint.axis ?? [0, 0, 1];
      validateVector(axis, `joint ${name} axis`);
      const length = Math.hypot(axis[0], axis[1], axis[2]);
      if (!(length > 0)) throw rangeError(`Joint ${name} needs a non-zero axis`, 'kinematics');
      this.axes[j * 3] = axis[0] / length;
      this.axes[j * 3 + 1] = axis[1] / length;
      this.axes[j * 3 + 2] = axis[2] / length;
      if (joint.mimic) {
        const source = resolve(joint.mimic.joint, j, 'Mimic joint'),
          multiplier = joint.mimic.multiplier ?? 1,
          offset = joint.mimic.offset ?? 0;
        if (this.variable[source] < 0)
          throw rangeError(`Joint ${name} repeats ${names[source]}, which does not move`, 'kinematics');
        if (!Number.isFinite(multiplier) || !Number.isFinite(offset))
          throw rangeError(`Joint ${name} needs a finite mimic multiplier and offset`, 'kinematics');
        this.variable[j] = this.variable[source];
        this.multipliers[j] = multiplier * this.multipliers[source];
        this.offsets[j] = multiplier * this.offsets[source] + offset;
        return;
      }
      const low = joint.lower ?? (type === 'continuous' ? -Infinity : NaN),
        high = joint.upper ?? (type === 'continuous' ? Infinity : NaN);
      if (Number.isNaN(low) || Number.isNaN(high) || low > high)
        throw rangeError(`Joint ${name} needs lower at or below upper`, 'kinematics');
      this.variable[j] = lower.length;
      lower.push(low);
      upper.push(high);
      variables.push(name);
    });
    this.jointCount = count;
    this.dof = lower.length;
    this.lower = new Float64Array(lower);
    this.upper = new Float64Array(upper);
    this.jointNames = Object.freeze(names);
    this.variableNames = Object.freeze(variables);
    this.frames = new Float64Array(count * 12);
    this.base = matrix12(options.base ?? IDENTITY, 'Robot base');
    this.shapes = (options.shapes ?? []).map((shape, i) => {
      const ref = shape.joint;
      if (ref === undefined) throw typeError(`Shape ${i} needs a joint, or null for the base`, 'kinematics');
      const joint = ref === null ? -1 : resolve(ref, count, 'Shape joint');
      return 'points' in shape ? hullShape(shape, joint) : capsuleShape(shape, joint);
    });
    this.shapeCount = this.shapes.length;
    this.shapeJoints = Int32Array.from(this.shapes, (shape) => shape.joint);
    this.selfPairs = this.adjacentFree();
  }

  /** Index of a joint by name, or -1. */
  jointIndex(name: string): number {
    return this.jointNames.indexOf(name);
  }

  /** Moves the base: a column-major affine matrix of 16 values. The next pose uses it. */
  setBase(matrix: ArrayLike<number>): this {
    this.base.set(matrix12(matrix, 'Robot base'));
    return this;
  }

  /** The robot as plain numbers, copied, for code that does this maths elsewhere, such as a GPU kernel. */
  describe(): RobotData {
    return {
      kinds: this.kinds.slice(),
      parents: this.parents.slice(),
      variable: this.variable.slice(),
      multipliers: this.multipliers.slice(),
      offsets: this.offsets.slice(),
      origins: this.origins.slice(),
      axes: this.axes.slice(),
      base: this.base.slice(),
      shapes: this.shapes.map((shape) => ({
        joint: shape.joint,
        radius: shape.radius,
        points: shape.hull ? hullInJoint(shape) : shape.localEnds.slice(),
      })),
    };
  }

  /** Whether every entry of `q` is within its joint's range, allowing `slack` beyond it. */
  within(q: ArrayLike<number>, slack = 0): boolean {
    this.check(q);
    for (let i = 0; i < this.dof; i++)
      if (!(q[i] >= this.lower[i] - slack && q[i] <= this.upper[i] + slack)) return false;
    return true;
  }

  /** Writes `q` limited to the joint ranges into `out`, which may be `q` itself. */
  clamp(q: ArrayLike<number>, out: Float64Array = new Float64Array(this.dof)): Float64Array {
    this.check(q);
    for (let i = 0; i < this.dof; i++) out[i] = Math.min(Math.max(q[i], this.lower[i]), this.upper[i]);
    return out;
  }

  /** Computes every joint's world frame at `q` into {@link frames}, which it returns. */
  forward(q: ArrayLike<number>): Float64Array {
    this.check(q);
    const { kinds, origins, axes, variable, multipliers, offsets, parents, frames, base } = this;
    for (let j = 0; j < this.jointCount; j++) {
      const parent = parents[j],
        source = parent < 0 ? base : frames,
        at = parent < 0 ? 0 : parent * 12;
      if (kinds[j] === FIXED) multiply(source, at, origins, j * 12, frames, j * 12);
      else {
        const v = variable[j];
        motion(kinds[j], axes, j * 3, q[v] * multipliers[j] + offsets[j], local);
        multiply(source, at, origins, j * 12, placed, 0);
        multiply(placed, 0, local, 0, frames, j * 12);
      }
    }
    return frames;
  }

  /** The world matrix of a joint at the last pose, column-major, 16 values: what a bone or a mesh reads. */
  frameMatrix(joint: number, out: Float64Array = new Float64Array(16)): Float64Array {
    if (!Number.isInteger(joint) || joint < 0 || joint >= this.jointCount)
      throw rangeError(`Joint ${joint} is out of range`, 'kinematics');
    const f = this.frames,
      at = joint * 12;
    for (let c = 0; c < 4; c++) {
      out[c * 4] = f[at + c * 3];
      out[c * 4 + 1] = f[at + c * 3 + 1];
      out[c * 4 + 2] = f[at + c * 3 + 2];
      out[c * 4 + 3] = c === 3 ? 1 : 0;
    }
    return out;
  }

  /** Writes a point given in a joint's frame to `out` in the world, at the last pose. */
  pointOn(joint: number, point: Vec3View, out: Float64Array = new Float64Array(3)): Float64Array {
    const f = joint < 0 ? this.base : this.frames,
      at = joint < 0 ? 0 : joint * 12,
      x = point[0],
      y = point[1],
      z = point[2];
    for (let r = 0; r < 3; r++) out[r] = f[at + r] * x + f[at + 3 + r] * y + f[at + 6 + r] * z + f[at + 9 + r];
    return out;
  }

  /**
   * Writes how a point on a joint moves per unit of each configuration entry, at the last pose, into `out`: six rows of
   * `dof` numbers, row-major, the point's velocity then the link's angular velocity. `point` is in that joint's frame.
   */
  jacobian(joint: number, point: Vec3View, out: Float64Array = new Float64Array(6 * this.dof)): Float64Array {
    const n = this.dof,
      { frames, axes, kinds, variable, multipliers, parents } = this,
      p = this.pointOn(joint, point, matrix16);
    out.fill(0);
    for (let j = joint; j >= 0; j = parents[j]) {
      const v = variable[j];
      if (v < 0) continue;
      const at = j * 12,
        ax = axes[j * 3],
        ay = axes[j * 3 + 1],
        az = axes[j * 3 + 2],
        m = multipliers[j],
        wx = frames[at] * ax + frames[at + 3] * ay + frames[at + 6] * az,
        wy = frames[at + 1] * ax + frames[at + 4] * ay + frames[at + 7] * az,
        wz = frames[at + 2] * ax + frames[at + 5] * ay + frames[at + 8] * az;
      if (kinds[j] === PRISMATIC) {
        out[v] += wx * m;
        out[n + v] += wy * m;
        out[2 * n + v] += wz * m;
      } else {
        const rx = p[0] - frames[at + 9],
          ry = p[1] - frames[at + 10],
          rz = p[2] - frames[at + 11];
        out[v] += (wy * rz - wz * ry) * m;
        out[n + v] += (wz * rx - wx * rz) * m;
        out[2 * n + v] += (wx * ry - wy * rx) * m;
        out[3 * n + v] += wx * m;
        out[4 * n + v] += wy * m;
        out[5 * n + v] += wz * m;
      }
    }
    return out;
  }

  /** Puts the joints and every shape at `q`. The gap methods read this pose. */
  place(q: ArrayLike<number>): void {
    this.forward(q);
    for (const shape of this.shapes) {
      const frame = shape.joint < 0 ? this.base : this.frames,
        at = shape.joint < 0 ? 0 : shape.joint * 12;
      if (shape.hull) {
        multiply(frame, at, shape.offset!, 0, placed, 0);
        for (let c = 0; c < 4; c++) {
          matrix16[c * 4] = placed[c * 3];
          matrix16[c * 4 + 1] = placed[c * 3 + 1];
          matrix16[c * 4 + 2] = placed[c * 3 + 2];
          matrix16[c * 4 + 3] = c === 3 ? 1 : 0;
        }
        shape.hull.setTransform(matrix16);
      } else {
        const e = shape.localEnds;
        for (let r = 0; r < 3; r++) {
          const a = frame[at + r],
            b = frame[at + 3 + r],
            c = frame[at + 6 + r],
            d = frame[at + 9 + r];
          shape.start[r] = a * e[0] + b * e[1] + c * e[2] + d;
          shape.end[r] = a * e[3] + b * e[4] + c * e[5] + d;
        }
      }
    }
  }

  /** Signed gap between a shape, at the last {@link place}, and a collider: negative when they overlap. */
  shapeGap(shape: number, volume: ConstraintVolume): number {
    const s = this.shapes[shape];
    if (s.hull) {
      if (!volume.hullClearanceInto)
        throw typeError(
          'A hull shape needs colliders with hullClearanceInto: spheres, capsules, hulls and mesh and field volumes have it',
          'kinematics',
        );
      volume.hullClearanceInto(s.hull, distance);
    } else segmentVolumeInto(volume, s.start, s.end, s.radius, distance, closest);
    return distance[0];
  }

  /** Signed gap between two shapes at the last {@link place}. */
  pairGap(a: number, b: number): number {
    const p = this.shapes[a],
      q = this.shapes[b];
    if (p.hull && q.hull) p.hull.hullClearanceInto(q.hull, distance);
    else if (p.hull) p.hull.segmentClearanceInto(q.start, q.end, q.radius, distance);
    else if (q.hull) q.hull.segmentClearanceInto(p.start, p.end, p.radius, distance);
    else return closestPointsBetweenSegments(p.start, p.end, q.start, q.end, closest).distance - p.radius - q.radius;
    return distance[0];
  }

  /** The pairs a self check tests, two shape indices each. */
  get selfCollisionPairs(): Int32Array {
    return this.selfPairs;
  }

  /**
   * Leaves out of the self check every pair of shapes within `gap` of each other at `q` (a safe pose, such as the
   * robot's home), so parts built to overlap do not read as a collision. Pairs on one link and on a joint and its
   * parent are never tested.
   */
  ignoreContactsAt(q: ArrayLike<number>, gap = 0): this {
    this.place(q);
    const kept: number[] = [];
    for (let i = 0; i < this.selfPairs.length; i += 2) {
      const a = this.selfPairs[i],
        b = this.selfPairs[i + 1];
      if (this.pairGap(a, b) > gap) kept.push(a, b);
    }
    this.selfPairs = Int32Array.from(kept);
    return this;
  }

  /**
   * Smallest signed gap at `q` between any shape and any collider, and with `selfCollision` between the robot's own
   * shapes. Infinity when there is nothing to test.
   */
  clearance(q: ArrayLike<number>, colliders: readonly ConstraintVolume[], selfCollision = false): number {
    this.place(q);
    let least = Infinity;
    for (let s = 0; s < this.shapeCount; s++) {
      for (let c = 0; c < colliders.length; c++) {
        const gap = this.shapeGap(s, colliders[c]);
        if (gap < least) {
          least = gap;
          this.nearest[0] = s;
          this.nearest[1] = c;
        }
      }
    }
    if (selfCollision) {
      const pairs = this.selfPairs;
      for (let i = 0; i < pairs.length; i += 2) {
        const gap = this.pairGap(pairs[i], pairs[i + 1]);
        if (gap < least) {
          least = gap;
          this.nearest[0] = pairs[i];
          this.nearest[1] = -1 - pairs[i + 1];
        }
      }
    }
    return least;
  }

  /** Shape behind the last {@link clearance}. */
  get nearestShape(): number {
    return this.nearest[0];
  }
  /** Collider behind the last {@link clearance}; a negative value `n` means shape `-1 - n` of this robot. */
  get nearestCollider(): number {
    return this.nearest[1];
  }

  /**
   * The most any point of each shape can move on the straight path in joint space from `from` to `to`, per unit of the
   * path's time from 0 to 1, into `out`. Each joint adds its travel times its lever: the origin offsets from it down to
   * the shape, the prismatic travel on the way and the shape's extent, which together no point of the shape can be
   * farther than, in any pose on the path. This is the bound a swept check advances by.
   */
  motionBounds(
    from: ArrayLike<number>,
    to: ArrayLike<number>,
    out: Float64Array = new Float64Array(this.shapeCount),
  ): Float64Array {
    this.check(from);
    this.check(to);
    const { kinds, variable, multipliers, offsets, parents, offsetLengths } = this;
    for (let s = 0; s < this.shapeCount; s++) {
      const shape = this.shapes[s];
      let lever = shape.extent,
        speed = 0;
      for (let j = shape.joint; j >= 0; j = parents[j]) {
        const v = variable[j];
        if (v >= 0) {
          const start = from[v] * multipliers[j] + offsets[j],
            end = to[v] * multipliers[j] + offsets[j],
            travel = Math.abs(end - start);
          if (kinds[j] === PRISMATIC) {
            speed += travel;
            lever += Math.max(Math.abs(start), Math.abs(end));
          } else speed += travel * lever;
        }
        lever += offsetLengths[j];
      }
      out[s] = speed;
    }
    return out;
  }

  private check(q: ArrayLike<number>): void {
    if (!q || q.length !== this.dof)
      throw typeError(`A configuration of this robot has ${this.dof} numbers; got ${q?.length}`, 'kinematics');
  }

  private adjacentFree(): Int32Array {
    const pairs: number[] = [],
      { shapes, parents } = this;
    for (let a = 0; a < shapes.length; a++) {
      for (let b = a + 1; b < shapes.length; b++) {
        const p = shapes[a].joint,
          q = shapes[b].joint;
        if (p === q || (q >= 0 && parents[q] === p) || (p >= 0 && parents[p] === q)) continue;
        pairs.push(a, b);
      }
    }
    return Int32Array.from(pairs);
  }
}

/** A hull shape's points in its joint's frame. */
function hullInJoint(shape: PlacedShape): Float64Array {
  const points = hullPoints(shape.hull!),
    m = shape.offset!,
    out = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i],
      y = points[i + 1],
      z = points[i + 2];
    for (let r = 0; r < 3; r++) out[i + r] = m[r] * x + m[3 + r] * y + m[6 + r] * z + m[9 + r];
  }
  return out;
}

function capsuleShape(shape: RobotCapsuleShape, joint: number): PlacedShape {
  const start = shape.start ?? [0, 0, 0],
    end = shape.end ?? start,
    radius = shape.radius;
  validateVector(start, 'shape start');
  validateVector(end, 'shape end');
  if (!(radius >= 0) || !Number.isFinite(radius))
    throw rangeError('A capsule shape needs a radius of 0 or more', 'kinematics');
  return {
    joint,
    extent: Math.max(Math.hypot(start[0], start[1], start[2]), Math.hypot(end[0], end[1], end[2])) + radius,
    radius,
    localEnds: Float64Array.of(start[0], start[1], start[2], end[0], end[1], end[2]),
    start: new Float64Array(3),
    end: new Float64Array(3),
    offset: null,
    hull: null,
  };
}

function hullShape(shape: RobotHullShape, joint: number): PlacedShape {
  const hull = new ConvexHullVolume({
      points: shape.points,
      maxPoints: shape.maxPoints ?? Math.max(shape.points.length / 3, 1),
    }),
    offset = matrix12(shape.matrix ?? IDENTITY, 'Shape matrix'),
    points = hullPoints(hull);
  let extent = 0;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i],
      y = points[i + 1],
      z = points[i + 2];
    extent = Math.max(
      extent,
      Math.hypot(
        offset[0] * x + offset[3] * y + offset[6] * z + offset[9],
        offset[1] * x + offset[4] * y + offset[7] * z + offset[10],
        offset[2] * x + offset[5] * y + offset[8] * z + offset[11],
      ),
    );
  }
  return {
    joint,
    extent,
    radius: 0,
    localEnds: new Float64Array(0),
    start: new Float64Array(3),
    end: new Float64Array(3),
    offset,
    hull,
  };
}
