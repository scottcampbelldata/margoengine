// The `swept` entry: is a whole motion clear, not just its two ends. It is conservative advancement (B. Mirtich, "Impulse-
// based dynamic simulation of rigid body systems", PhD thesis, UC Berkeley, 1996), with the per-link motion bound used to
// check robot paths by F. Schwarzer, M. Saha and J.-C. Latombe, "Exact collision checking of robot paths", WAFR 2002:
// if a shape stands `gap` from a static collider and no point of the shape moves faster than `speed`, the two cannot
// touch for `gap / speed` of the path's time, so the check may step that far and look again. No step can jump a wall,
// however thin. Written clean room from those publications.
import { rangeError, typeError } from '../../shared/errors.js';
import { ConvexHullVolume, hullPoints } from './hull.js';
import type { ConstraintVolume, Vec3View } from './types.js';
import { readVector, validateVector } from './types.js';
import { segmentVolumeInto, type SegmentDistanceResult } from './volumes.js';

/** Settings of every swept check. */
export interface SweepOptions {
  /** Gap the motion must keep from every collider, in scene units. Default 0: only a true contact stops it. */
  minClearance?: number;
  /** A gap this close to `minClearance` counts as reached; it also sets the smallest step. Default 1e-4. */
  tolerance?: number;
  /** Most poses tested; a motion that needs more ends `exhausted`, not clear. Default 4,096. */
  maxSteps?: number;
}
/** Settings of {@link sweepChain}. */
export interface ChainSweepOptions extends SweepOptions {
  /** Capsule radius of every link, or one per link. Required. */
  radius: number | readonly number[];
  /** Radius of a sphere on every joint, or one per joint, root first; 0 is none. Default 0. */
  jointRadius?: number | readonly number[];
}

/** What a swept check found. */
export interface SweepResult {
  /** The whole motion keeps the gap. False on a contact, and on `exhausted`. */
  clear: boolean;
  /** The step budget ran out first: nothing is known past `time`. */
  exhausted: boolean;
  /**
   * Where the check stopped, from 0 to 1 along the motion: the first contact, or 1 when clear. The motion is clear up
   * to here and no later than the true contact, so this is a safe place to stop.
   */
  time: number;
  /** Smallest gap beyond `minClearance` at any pose tested. A true gap between two poses can be smaller, never below 0. */
  clearance: number;
  /** Poses tested. */
  steps: number;
  /** Moving shape at the contact, or -1: a chain's link index, then its joints after its links; 0 for a hull. */
  shape: number;
  /** Index of the collider at the contact; -1 for none. */
  collider: number;
}

interface Motion {
  /** Moving shapes. */
  count: number;
  /** The most any point of each shape moves per unit of time. */
  speed: Float64Array;
  /** Puts the shapes at time `t`. */
  place(t: number): void;
  /** Signed gap of one shape to one collider. */
  gap(shape: number, volume: ConstraintVolume): number;
}

function settings(options: SweepOptions | undefined) {
  const minClearance = options?.minClearance ?? 0,
    tolerance = options?.tolerance ?? 1e-4,
    maxSteps = options?.maxSteps ?? 4096;
  if (!(minClearance >= 0) || !Number.isFinite(minClearance))
    throw rangeError('Sweep minClearance must be 0 or more', 'kinematics');
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw rangeError('Sweep tolerance must be above 0', 'kinematics');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
    throw rangeError('Sweep maxSteps must be a positive integer', 'kinematics');
  return { minClearance, tolerance, maxSteps };
}

function advance(
  motion: Motion,
  colliders: readonly ConstraintVolume[],
  minClearance: number,
  tolerance: number,
  maxSteps: number,
): SweepResult {
  const { count, speed } = motion,
    result: SweepResult = {
      clear: false,
      exhausted: false,
      time: 0,
      clearance: Infinity,
      steps: 0,
      shape: -1,
      collider: -1,
    };
  let t = 0;
  for (;;) {
    motion.place(t);
    result.steps++;
    let step = Infinity;
    for (let s = 0; s < count; s++) {
      const moving = speed[s];
      // A shape that does not move stands where it stood at the start.
      if (moving === 0 && t > 0) continue;
      let least = Infinity;
      for (let c = 0; c < colliders.length; c++) {
        const gap = motion.gap(s, colliders[c]) - minClearance;
        if (Number.isNaN(gap)) throw rangeError('A collider gave no finite clearance', 'kinematics');
        if (gap < result.clearance) result.clearance = gap;
        if (gap <= tolerance) {
          result.time = t;
          result.shape = s;
          result.collider = c;
          return result;
        }
        if (gap < least) least = gap;
      }
      if (moving > 0 && least / moving < step) step = least / moving;
    }
    result.time = t;
    if (t >= 1 || step === Infinity) {
      result.time = 1;
      result.clear = true;
      return result;
    }
    if (result.steps >= maxSteps) {
      result.exhausted = true;
      return result;
    }
    t = Math.min(1, t + step);
  }
}

const closest: SegmentDistanceResult = /* @__PURE__ */ (() => ({
  pointA: new Float64Array(3),
  pointB: new Float64Array(3),
  distance: 0,
  parameterA: 0,
  parameterB: 0,
}))();
const scratch = /* @__PURE__ */ new Float64Array(1);

function flatPoints(points: readonly Vec3View[], name: string): Float64Array {
  if (!Array.isArray(points) || points.length < 2)
    throw typeError(`${name} must list at least two joint positions`, 'kinematics');
  const out = new Float64Array(points.length * 3);
  points.forEach((point: Vec3View, i: number) => {
    validateVector(point, `${name} joint ${i}`);
    readVector(point, out, i * 3);
  });
  return out;
}

function radii(value: number | readonly number[], count: number, name: string): Float64Array {
  const out = new Float64Array(count);
  if (typeof value === 'number') out.fill(value);
  else if (Array.isArray(value) && value.length === count) out.set(value);
  else throw typeError(`${name} must be a number or one number each for ${count}`, 'kinematics');
  for (const r of out) if (!(r >= 0) || !Number.isFinite(r)) throw rangeError(`${name} must be 0 or more`, 'kinematics');
  return out;
}

/** The unit direction of `at` in `points`, its length written to `lengths[i]`. */
function bone(points: Float64Array, at: number, dirs: Float64Array, lengths: Float64Array, i: number): void {
  const x = points[at + 3] - points[at],
    y = points[at + 4] - points[at + 1],
    z = points[at + 5] - points[at + 2],
    length = Math.hypot(x, y, z);
  lengths[i] = length;
  // A bone of no length has no direction of its own; +X stands in, and turning it moves nothing.
  dirs[i * 3] = length > 0 ? x / length : 1;
  dirs[i * 3 + 1] = length > 0 ? y / length : 0;
  dirs[i * 3 + 2] = length > 0 ? z / length : 0;
}

/**
 * Checks a chain of joints, such as the root, elbow and hand an `AvoidanceSolver` gives, moving between two poses. The
 * root moves on a straight line and each bone turns on the shortest arc from its old direction to its new one, its
 * length held (or eased between the two lengths), which is the motion of bones and not of loose points. `from` and
 * `to` list the joint positions in order. A collider that stands between the ends is found, however fast the motion:
 * the check never steps past a contact. Colliders hold still during the check.
 *
 * @example
 * ```ts
 * import { SphereVolume } from 'margoengine/kinematics-constraints';
 * import { sweepChain } from 'margoengine/kinematics-constraints/swept';
 *
 * const post = new SphereVolume({ center: [0, 1, 0], radius: 0.1 });
 * const hit = sweepChain(
 *   [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]],
 *   [[0, 0, 0], [-0.5, 0.1, 0], [-1, 0.2, 0]],
 *   [post],
 *   { radius: 0.05, minClearance: 0.01 },
 * );
 * ```
 */
export function sweepChain(
  from: readonly Vec3View[],
  to: readonly Vec3View[],
  colliders: readonly ConstraintVolume[],
  options: ChainSweepOptions,
): SweepResult {
  const { minClearance, tolerance, maxSteps } = settings(options),
    start = flatPoints(from, 'Sweep from'),
    end = flatPoints(to, 'Sweep to'),
    joints = start.length / 3,
    links = joints - 1;
  if (end.length !== start.length) throw rangeError('Sweep poses must have the same joints', 'kinematics');
  const linkRadius = radii(options?.radius, links, 'Sweep radius'),
    jointRadius = radii(options?.jointRadius ?? 0, joints, 'Sweep jointRadius');
  const startDirs = new Float64Array(links * 3),
    endDirs = new Float64Array(links * 3),
    startLengths = new Float64Array(links),
    endLengths = new Float64Array(links),
    axes = new Float64Array(links * 3),
    angles = new Float64Array(links);
  // Links first, then the joints with a sphere.
  const spheres: number[] = [];
  for (let j = 0; j < joints; j++) if (jointRadius[j] > 0) spheres.push(j);
  const speed = new Float64Array(links + spheres.length),
    rootTravel = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
    jointSpeed = new Float64Array(joints);
  jointSpeed[0] = rootTravel;
  for (let i = 0; i < links; i++) {
    bone(start, i * 3, startDirs, startLengths, i);
    bone(end, i * 3, endDirs, endLengths, i);
    const a = i * 3,
      ax = startDirs[a],
      ay = startDirs[a + 1],
      az = startDirs[a + 2],
      bx = endDirs[a],
      by = endDirs[a + 1],
      bz = endDirs[a + 2];
    let nx = ay * bz - az * by,
      ny = az * bx - ax * bz,
      nz = ax * by - ay * bx;
    let sine = Math.hypot(nx, ny, nz);
    const cosine = ax * bx + ay * by + az * bz;
    if (sine < 1e-12 && cosine < 0) {
      // Opposite directions: every axis square to the bone is a shortest arc. This one is repeatable.
      const small = Math.abs(ax) < 0.7 ? 0 : 1;
      nx = small === 0 ? 0 : -az;
      ny = small === 0 ? -az : 0;
      nz = small === 0 ? ay : ax;
      sine = Math.hypot(nx, ny, nz);
    }
    angles[i] = Math.atan2(Math.hypot(ax * by - ay * bx, ay * bz - az * by, az * bx - ax * bz), cosine);
    if (sine > 0) {
      axes[a] = nx / sine;
      axes[a + 1] = ny / sine;
      axes[a + 2] = nz / sine;
    }
    const longest = Math.max(startLengths[i], endLengths[i]);
    jointSpeed[i + 1] = jointSpeed[i] + longest * angles[i] + Math.abs(endLengths[i] - startLengths[i]);
    speed[i] = jointSpeed[i + 1];
  }
  spheres.forEach((j, k) => {
    speed[links + k] = jointSpeed[j];
  });
  const now = new Float64Array(joints * 3);
  const motion: Motion = {
    count: speed.length,
    speed,
    place(t) {
      for (let k = 0; k < 3; k++) now[k] = start[k] + (end[k] - start[k]) * t;
      for (let i = 0; i < links; i++) {
        const a = i * 3,
          angle = angles[i] * t,
          c = Math.cos(angle),
          s = Math.sin(angle),
          nx = axes[a],
          ny = axes[a + 1],
          nz = axes[a + 2],
          dx = startDirs[a],
          dy = startDirs[a + 1],
          dz = startDirs[a + 2],
          length = startLengths[i] + (endLengths[i] - startLengths[i]) * t,
          // The axis is square to the bone, so turning it needs no third term.
          rx = dx * c + (ny * dz - nz * dy) * s,
          ry = dy * c + (nz * dx - nx * dz) * s,
          rz = dz * c + (nx * dy - ny * dx) * s;
        now[a + 3] = now[a] + rx * length;
        now[a + 4] = now[a + 1] + ry * length;
        now[a + 5] = now[a + 2] + rz * length;
      }
    },
    gap(shape, volume) {
      const link = shape < links,
        at = link ? shape * 3 : spheres[shape - links] * 3,
        a = now.subarray(at, at + 3),
        b = link ? now.subarray(at + 3, at + 6) : a;
      segmentVolumeInto(
        volume,
        a,
        b,
        link ? linkRadius[shape] : jointRadius[spheres[shape - links]],
        scratch,
        closest,
      );
      return scratch[0];
    },
  };
  return advance(motion, colliders, minClearance, tolerance, maxSteps);
}

interface RigidPose {
  translation: Float64Array;
  /** Unit quaternion x, y, z, w. */
  rotation: Float64Array;
  scale: Float64Array;
}

function rigidPose(matrix: ArrayLike<number>, name: string): RigidPose {
  if (!matrix || matrix.length !== 16) throw typeError(`${name} must have 16 values`, 'kinematics');
  const columns = [0, 1, 2].map((c) => [matrix[c * 4], matrix[c * 4 + 1], matrix[c * 4 + 2]]);
  const scale = Float64Array.from(columns, ([x, y, z]) => Math.hypot(x, y, z));
  if (!(scale[0] > 0 && scale[1] > 0 && scale[2] > 0 && scale.every(Number.isFinite)))
    throw rangeError(`${name} must have finite, non-zero axes`, 'kinematics');
  const [x, y, z] = columns.map((column, c) => column.map((value) => value / scale[c]));
  const square =
    Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]) +
    Math.abs(x[0] * z[0] + x[1] * z[1] + x[2] * z[2]) +
    Math.abs(y[0] * z[0] + y[1] * z[1] + y[2] * z[2]);
  const handed =
    x[0] * (y[1] * z[2] - y[2] * z[1]) + x[1] * (y[2] * z[0] - y[0] * z[2]) + x[2] * (y[0] * z[1] - y[1] * z[0]);
  if (square > 1e-6 || handed < 0)
    throw rangeError(`${name} must be a rotation, a positive scale and a move: no shear, no mirror`, 'kinematics');
  // Largest of the four terms first, for a well-conditioned square root (K. Shoemake, SIGGRAPH 1985).
  const trace = x[0] + y[1] + z[2],
    q = new Float64Array(4);
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q[3] = s / 4;
    q[0] = (y[2] - z[1]) / s;
    q[1] = (z[0] - x[2]) / s;
    q[2] = (x[1] - y[0]) / s;
  } else if (x[0] >= y[1] && x[0] >= z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    q[3] = (y[2] - z[1]) / s;
    q[0] = s / 4;
    q[1] = (x[1] + y[0]) / s;
    q[2] = (z[0] + x[2]) / s;
  } else if (y[1] >= z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    q[3] = (z[0] - x[2]) / s;
    q[0] = (x[1] + y[0]) / s;
    q[1] = s / 4;
    q[2] = (y[2] + z[1]) / s;
  } else {
    const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
    q[3] = (x[1] - y[0]) / s;
    q[0] = (z[0] + x[2]) / s;
    q[1] = (y[2] + z[1]) / s;
    q[2] = s / 4;
  }
  return { translation: Float64Array.of(matrix[12], matrix[13], matrix[14]), rotation: q, scale };
}

/**
 * Checks a convex hull moving from one matrix to the other, for a link hull or any solid thing: its translation moves
 * on a straight line, its rotation on the shortest arc about the hull's own origin, and its scale eases between the
 * two. Matrices may hold rotation, positive scale and translation. The hull ends at `to`. See {@link sweepChain} for
 * what the check promises.
 */
export function sweepHull(
  hull: ConvexHullVolume,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  colliders: readonly ConstraintVolume[],
  options?: SweepOptions,
): SweepResult {
  if (!(hull instanceof ConvexHullVolume)) throw typeError('sweepHull needs a ConvexHullVolume', 'kinematics');
  const { minClearance, tolerance, maxSteps } = settings(options),
    a = rigidPose(from, 'Sweep from'),
    b = rigidPose(to, 'Sweep to');
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a.rotation[i] * b.rotation[i];
  const sign = dot < 0 ? -1 : 1,
    half = Math.acos(Math.min(1, Math.abs(dot))),
    sine = Math.sin(half);
  // Each point turns about the origin at most the arc's full angle, twice the quaternion's, with the scaled point's reach.
  let lever = 0,
    stretch = 0;
  const points = hullPoints(hull);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i],
      y = points[i + 1],
      z = points[i + 2];
    lever = Math.max(
      lever,
      Math.hypot(x * a.scale[0], y * a.scale[1], z * a.scale[2]),
      Math.hypot(x * b.scale[0], y * b.scale[1], z * b.scale[2]),
    );
    stretch = Math.max(
      stretch,
      Math.hypot(x * (b.scale[0] - a.scale[0]), y * (b.scale[1] - a.scale[1]), z * (b.scale[2] - a.scale[2])),
    );
  }
  const travel = Math.hypot(
      b.translation[0] - a.translation[0],
      b.translation[1] - a.translation[1],
      b.translation[2] - a.translation[2],
    ),
    speed = Float64Array.of(travel + 2 * half * lever + stretch),
    matrix = new Float64Array(16),
    q = new Float64Array(4),
    distance = new Float64Array(1);
  matrix[15] = 1;
  const motion: Motion = {
    count: 1,
    speed,
    place(t) {
      const wa = sine > 1e-9 ? Math.sin((1 - t) * half) / sine : 1 - t,
        wb = (sine > 1e-9 ? Math.sin(t * half) / sine : t) * sign;
      for (let i = 0; i < 4; i++) q[i] = a.rotation[i] * wa + b.rotation[i] * wb;
      const n = Math.hypot(q[0], q[1], q[2], q[3]),
        x = q[0] / n,
        y = q[1] / n,
        z = q[2] / n,
        w = q[3] / n,
        sx = a.scale[0] + (b.scale[0] - a.scale[0]) * t,
        sy = a.scale[1] + (b.scale[1] - a.scale[1]) * t,
        sz = a.scale[2] + (b.scale[2] - a.scale[2]) * t;
      matrix[0] = (1 - 2 * (y * y + z * z)) * sx;
      matrix[1] = 2 * (x * y + w * z) * sx;
      matrix[2] = 2 * (x * z - w * y) * sx;
      matrix[4] = 2 * (x * y - w * z) * sy;
      matrix[5] = (1 - 2 * (x * x + z * z)) * sy;
      matrix[6] = 2 * (y * z + w * x) * sy;
      matrix[8] = 2 * (x * z + w * y) * sz;
      matrix[9] = 2 * (y * z - w * x) * sz;
      matrix[10] = (1 - 2 * (x * x + y * y)) * sz;
      for (let k = 0; k < 3; k++) matrix[12 + k] = a.translation[k] + (b.translation[k] - a.translation[k]) * t;
      hull.setTransform(matrix);
    },
    gap(_shape, volume) {
      if (!volume.hullClearanceInto)
        throw typeError('sweepHull needs colliders with hullClearanceInto', 'kinematics');
      volume.hullClearanceInto(hull, distance);
      return distance[0];
    },
  };
  const result = advance(motion, colliders, minClearance, tolerance, maxSteps);
  hull.setTransform(to);
  return result;
}
