// IK chains with pole targets, solved by FABRIK (A. Aristidou and J. Lasenby, "FABRIK: a fast, iterative solver for
// the inverse kinematics problem", Graphical Models 73(5), 2011): alternate backward and forward passes that move each
// joint onto the line to its neighbour at the bone's length. After each pair of passes every inner joint turns about
// the line through its two neighbours (which keeps both bone lengths) toward the pole. Results become joint rotations
// by turning each bone from its old direction to its new one with the shortest arc.
//
// On a fitted body (`setAnatomy`, or `body` on the chain) the chain obeys anatomy. An arm or a leg (a shoulder or
// hip, a hinge, an end) is solved in closed form by its swivel angle (D. Tolani, A. Goswami and N. Badler, "Real-time
// inverse kinematics techniques for anthropomorphic limbs", Graphical Models 62(5):353-388, 2000; M. Kallmann,
// "Analytical inverse kinematics with body posture control", Computer Animation and Virtual Worlds 19(2):79-91, 2008):
// the hinge turns about its own axis inside its range, and the pole picks the swivel inside the range of the joint
// above. A longer chain is solved by FABRIK and each joint is then brought to the nearest rotation its range allows
// (its swing inside the reach of its quadrant, J. Wilhelms and A. Van Gelder, "Fast and easy reach-cone joint
// limits", J Graphics Tools 6(2):27-41, 2001; its twist inside its range, P. Baerlocher, EPFL thesis 2392, 2001), the
// two steps taking turns until the end stops gaining, as A. Aristidou, Y. Chrysanthou and J. Lasenby move each joint to
// its nearest allowed place between passes ("Extending FABRIK with model constraints", Computer Animation and Virtual
// Worlds 27(1):35-57, 2016). A chain that ends in an arm or a leg finishes with the closed-form limb.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import {
  axisAngleToQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import type { Animator } from '@margoengine/animator';
import type { ElbowEvaluator } from '@margoengine/kinematics-constraints';
import {
  type Anatomy,
  type AnatomyJoint,
  anatomyOf,
  clampTurn,
  jointOf,
  jointTurn,
  limitBones,
  solveLimbIK,
  turnRotation,
} from '@margoengine/animator/ik';
import { parentOrder } from './rig.js';

// A fitted body is named with `setAnatomy` of `@margoengine/animator/ik`, which owns it; it is not exported again here.
export type { Anatomy } from '@margoengine/animator/ik';

/** Settings shared by every FABRIK solve. */
export interface FABRIKOptions {
  /** World point the chain bends toward (a knee or elbow hint); null or absent for none. */
  pole?: Vec3 | null;
  /** Most backward-and-forward iterations (1-1,024, default 32). */
  iterations?: number;
  /** Distance from the target that counts as reached, in the chain's units (default 1e-4). */
  tolerance?: number;
}

/** What a FABRIK solve did. */
export interface FABRIKResult {
  /** The end joint is within `tolerance` of the target. */
  reached: boolean;
  /** Distance from the end joint to the target after the solve. */
  distance: number;
  /** Iterations run. */
  iterations: number;
  /** On a fitted body: a joint stopped at its range and the end is short of the target. */
  held?: boolean;
}

const settings = (options: FABRIKOptions = {}) => {
  const iterations = options.iterations ?? 32,
    tolerance = options.tolerance ?? 1e-4,
    pole = options.pole ?? null;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1024)
    throw new RangeError('IK iterations must be an integer from 1 to 1,024');
  if (!(tolerance > 0 && tolerance < Infinity)) throw new RangeError('IK tolerance must be finite and above 0');
  if (pole !== null) vector(pole, 'IK pole');
  return { iterations, tolerance, pole };
};

function vector(value: unknown, label: string): void {
  const v = value as ArrayLike<number> | undefined;
  if (!v || v.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2]))
    throw new RangeError(`${label} must be three finite numbers`);
}

/**
 * Moves joint positions (`points`, xyz per joint, at least two joints, the first fixed) so the last reaches `target`,
 * keeping every bone's length; FABRIK (Aristidou and Lasenby 2011) with an optional pole. Unreachable targets
 * straighten the chain toward them.
 * @throws RangeError for fewer than two joints, a zero-length bone or non-finite input.
 */
export function solveFABRIK(points: Float64Array | number[], target: Vec3, options: FABRIKOptions = {}): FABRIKResult {
  const n = points?.length / 3;
  if (!Number.isInteger(n) || n < 2 || n > 256) throw new RangeError('A FABRIK chain needs 2 to 256 joints, xyz each');
  vector(target, 'IK target');
  const { iterations, tolerance, pole } = settings(options);
  for (let i = 0; i < points.length; i++)
    if (!Number.isFinite(points[i])) throw new RangeError(`IK joint coordinate ${i} is not finite; fix the pose`);
  const lengths = new Float64Array(n - 1);
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    lengths[i] = Math.hypot(
      points[i * 3 + 3] - points[i * 3],
      points[i * 3 + 4] - points[i * 3 + 1],
      points[i * 3 + 5] - points[i * 3 + 2],
    );
    if (!(lengths[i] > 0)) throw new RangeError(`IK bone ${i} has zero length; separate its joints`);
    total += lengths[i];
  }
  const rx = points[0],
    ry = points[1],
    rz = points[2],
    tx = target[0],
    ty = target[1],
    tz = target[2],
    end = (n - 1) * 3;
  // Puts joint `to` on the line from joint `from` toward it, `length` away.
  const place = (from: number, to: number, length: number) => {
    let dx = points[to * 3] - points[from * 3],
      dy = points[to * 3 + 1] - points[from * 3 + 1],
      dz = points[to * 3 + 2] - points[from * 3 + 2],
      d = Math.hypot(dx, dy, dz);
    // Coincident joints (a chain folded onto itself) leave the line toward the target, else any axis.
    if (!(d > 1e-12)) {
      dx = tx - rx;
      dy = ty - ry;
      dz = tz - rz;
      d = Math.hypot(dx, dy, dz);
      if (!(d > 1e-12)) (dx = 0), (dy = 1), (dz = 0), (d = 1);
    }
    points[to * 3] = points[from * 3] + (dx / d) * length;
    points[to * 3 + 1] = points[from * 3 + 1] + (dy / d) * length;
    points[to * 3 + 2] = points[from * 3 + 2] + (dz / d) * length;
  };
  const gap = () => Math.hypot(points[end] - tx, points[end + 1] - ty, points[end + 2] - tz);
  if (Math.hypot(tx - rx, ty - ry, tz - rz) >= total) {
    // Out of reach: the straight chain pointing at the target is the closest it gets.
    const dx = tx - rx,
      dy = ty - ry,
      dz = tz - rz,
      d = Math.hypot(dx, dy, dz) || 1;
    let along = 0;
    for (let i = 1; i < n; i++) {
      along += lengths[i - 1];
      points[i * 3] = rx + (dx / d) * along;
      points[i * 3 + 1] = ry + (dy / d) * along;
      points[i * 3 + 2] = rz + (dz / d) * along;
    }
    const distance = gap();
    return { reached: distance <= tolerance, distance, iterations: 0 };
  }
  // Inside the inner reach: the end cannot come nearer the root than the longest bone less all the others (the hole
  // of the reachable shell; FABRIK, Aristidou and Lasenby 2011, only treats the outer bound). The closest pose points
  // the longest bone at the target and folds every other bone straight back along the same line.
  let longest = 0;
  for (let i = 1; i < n - 1; i++) if (lengths[i] > lengths[longest]) longest = i;
  const inner = 2 * lengths[longest] - total,
    reach = Math.hypot(tx - rx, ty - ry, tz - rz);
  if (inner > 0 && reach < inner) {
    let dx = tx - rx,
      dy = ty - ry,
      dz = tz - rz,
      d = reach;
    if (!(d > 1e-12)) {
      // The target is on the root: any line is as close; keep the chain's own root-to-end line.
      (dx = points[end] - rx), (dy = points[end + 1] - ry), (dz = points[end + 2] - rz), (d = Math.hypot(dx, dy, dz));
      if (!(d > 1e-12)) (dx = 0), (dy = 1), (dz = 0), (d = 1);
    }
    let along = 0;
    for (let i = 1; i < n; i++) {
      along += i - 1 === longest ? lengths[i - 1] : -lengths[i - 1];
      points[i * 3] = rx + (dx / d) * along;
      points[i * 3 + 1] = ry + (dy / d) * along;
      points[i * 3 + 2] = rz + (dz / d) * along;
    }
    const distance = gap();
    return { reached: distance <= tolerance, distance, iterations: 0 };
  }
  let iteration = 0;
  if (pole) bendToward(points, n, pole);
  // A straight chain has no side to fold to, and a pole on its line gives none either (bendToward skips it).
  if (n > 2) {
    // Start a straight chain bent a hair toward a fixed perpendicular of its line.
    const ax = points[end] - rx,
      ay = points[end + 1] - ry,
      az = points[end + 2] - rz,
      length = Math.hypot(ax, ay, az);
    let straightLine = length > 0;
    for (let i = 1; i < n - 1 && straightLine; i++) {
      const jx = points[i * 3] - rx,
        jy = points[i * 3 + 1] - ry,
        jz = points[i * 3 + 2] - rz;
      straightLine = Math.hypot(jy * az - jz * ay, jz * ax - jx * az, jx * ay - jy * ax) <= 1e-9 * length * length;
    }
    if (straightLine) {
      const side = Math.abs(ax) <= Math.abs(ay) ? [1, 0, 0] : [0, 1, 0];
      bendToward(points, n, [rx + side[0] * length, ry + side[1] * length, rz + side[2] * length]);
    }
  }
  for (; iteration < iterations && gap() > tolerance; iteration++) {
    // Backward: the end on the target, each joint back toward its child.
    points[end] = tx;
    points[end + 1] = ty;
    points[end + 2] = tz;
    for (let i = n - 2; i >= 0; i--) place(i + 1, i, lengths[i]);
    // Forward: the root back home, each joint out toward its parent.
    points[0] = rx;
    points[1] = ry;
    points[2] = rz;
    for (let i = 1; i < n; i++) place(i - 1, i, lengths[i - 1]);
    if (pole) bendToward(points, n, pole);
  }
  const distance = gap();
  return { reached: distance <= tolerance, distance, iterations: iteration };
}

/** Turns each inner joint about the line through its neighbours toward the pole (both bone lengths are kept). */
function bendToward(points: Float64Array | number[], n: number, pole: Vec3): void {
  for (let i = 1; i < n - 1; i++) {
    const a = (i - 1) * 3,
      j = i * 3,
      b = (i + 1) * 3,
      ax = points[b] - points[a],
      ay = points[b + 1] - points[a + 1],
      az = points[b + 2] - points[a + 2],
      length = Math.hypot(ax, ay, az);
    if (!(length > 0)) continue;
    const ux = ax / length,
      uy = ay / length,
      uz = az / length;
    // Joint and pole relative to the axis, with their components along it removed.
    const jx = points[j] - points[a],
      jy = points[j + 1] - points[a + 1],
      jz = points[j + 2] - points[a + 2],
      jAlong = jx * ux + jy * uy + jz * uz,
      px = pole[0] - points[a],
      py = pole[1] - points[a + 1],
      pz = pole[2] - points[a + 2],
      pAlong = px * ux + py * uy + pz * uz,
      jr = [jx - ux * jAlong, jy - uy * jAlong, jz - uz * jAlong],
      pr = [px - ux * pAlong, py - uy * pAlong, pz - uz * pAlong],
      jLength = Math.hypot(jr[0], jr[1], jr[2]),
      pLength = Math.hypot(pr[0], pr[1], pr[2]);
    if (!(pLength > 1e-12)) continue; // the pole is on the axis: no side to prefer
    // The joint goes to the same distance from the axis, on the pole's side. A straight joint (on the axis) starts a
    // bend toward the pole a thousandth of the span off the axis, which the next pass grows to the bone lengths.
    const k = Math.max(jLength, length * 1e-3) / pLength;
    points[j] = points[a] + ux * jAlong + pr[0] * k;
    points[j + 1] = points[a + 1] + uy * jAlong + pr[1] * k;
    points[j + 2] = points[a + 2] + uz * jAlong + pr[2] * k;
  }
}

/**
 * The shortest-arc rotation (x, y, z, w) turning direction `from` to direction `to` (neither needs to be unit length).
 * @throws RangeError for a zero direction.
 */
export function rotationBetween(from: ArrayLike<number>, to: ArrayLike<number>): [number, number, number, number] {
  const a = Math.hypot(from[0], from[1], from[2]),
    b = Math.hypot(to[0], to[1], to[2]);
  if (!(a > 0) || !(b > 0)) throw new RangeError('A rotation between directions needs two nonzero directions');
  const fx = from[0] / a,
    fy = from[1] / a,
    fz = from[2] / a,
    tx = to[0] / b,
    ty = to[1] / b,
    tz = to[2] / b,
    dot = fx * tx + fy * ty + fz * tz;
  if (dot < -1 + 1e-12) {
    // Opposite: half a turn about any axis perpendicular to `from`.
    const ox = Math.abs(fx) < 0.9 ? 1 : 0,
      oy = 1 - ox,
      cx = fy * 0 - fz * oy,
      cy = fz * ox - fx * 0,
      cz = fx * oy - fy * ox,
      c = Math.hypot(cx, cy, cz);
    return [cx / c, cy / c, cz / c, 0];
  }
  return normalizeQuaternion([fy * tz - fz * ty, fz * tx - fx * tz, fx * ty - fy * tx, 1 + dot]);
}

/** One joint chain of a pose: what {@link solvePoseIK} turns. */
export interface IKChain extends FABRIKOptions {
  /** Joint indices from the first to the last, each the child of the one before (2-256 joints). */
  joints: readonly number[];
  /** World (model-space) point the last joint reaches for. */
  target: Vec3;
  /** Blend from the current pose (0) to the solved chain (1); default 1. */
  weight?: number;
  /**
   * Keep each bent inner joint (an elbow or knee bent more than 2 degrees in the pose being solved) on its own side:
   * when the pole would fold it the other way, it goes to the nearest allowed side instead, square to its bend
   * (default true). A straight inner joint follows the pole as before. False lets the pole fold any joint either way.
   */
  keepBend?: boolean;
  /**
   * The fitted body whose joint ranges the chain obeys (an `AnatomicalRig` from `fitAnatomy`). Default: the body
   * `setAnatomy` gave the pose, skeleton or Animator, else none.
   */
  body?: Anatomy | null;
  /** False solves as if there were no body. Default true: a fitted body's limits are on. */
  limits?: boolean;
  /**
   * On a fitted arm or leg: the share of the limb's length over which the reach eases in before full stretch, so the
   * elbow or knee does not snap straight (0-0.5, default 0: the end meets every target in reach exactly).
   */
  soft?: number;
}

/**
 * A pose to solve: parents and local transforms, 10 numbers per bone (translation xyz, rotation xyzw, scale xyz),
 * the layout of `@margoengine/animation`'s `retargetRig(...).rest` and {@link solveSkeletonIK}'s skeletons.
 */
export interface IKPose {
  readonly parents: readonly number[];
  readonly local: Float64Array;
  /** The fitted body of these bones; its limits are on unless the chain says `limits: false`. */
  readonly body?: Anatomy | null;
}

/**
 * Solves an IK chain on a pose without an engine: turns the chain's joints (all but the last) so the last reaches
 * `target`, bending toward `pole`. Writes the new rotations into `pose.local`. Bones need positive scales. An uneven
 * scale stretches the bones under it as they turn, so the last joint lands as close as that stretch allows.
 *
 * When the pose has a fitted body (`chain.body`, `pose.body` or `setAnatomy(pose, body)`) with limits on, the chain
 * obeys it: an elbow or knee bends only the anatomical way and stops at its range, even from a straight limb; the pole
 * only picks the limb's swivel inside the shoulder's or hip's range; every other joint of the chain stays inside its
 * range. A target the ranges do not allow is approached as closely as they allow, and `held` is true.
 * `limits: false` on the chain solves as if there were no body.
 * @throws RangeError for an invalid chain or pose.
 */
export function solvePoseIK(pose: IKPose, chain: IKChain): FABRIKResult {
  const { parents, local } = pose ?? ({} as IKPose),
    count = parents?.length;
  if (!Array.isArray(parents) || !(local instanceof Float64Array) || local.length !== count * 10)
    throw new TypeError('solvePoseIK needs {parents, local} with 10 local numbers per bone');
  parents.forEach((p, i) => {
    if (!Number.isInteger(p) || p < -1 || p >= count || p === i)
      throw new RangeError(`IK pose bone ${i} parent ${p} is invalid; use -1 or another bone's index`);
  });
  parentOrder(parents, 'IK pose');
  const joints = checkChain(chain, count, (child, parent) => parents[child] === parent);
  // World transforms of every ancestor of the chain and the chain itself.
  const world = (bone: number): { position: number[]; rotation: number[] } => {
    const path: number[] = [];
    for (let at = bone; at >= 0; at = parents[at]) path.push(at);
    let position = [0, 0, 0],
      rotation = [0, 0, 0, 1],
      // The world axes of the frame so far, scales included: real rigs carry scales a little off uniform.
      axes = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
    const place = (v: ArrayLike<number>): number[] =>
      [0, 1, 2].map((c) => axes[0][c] * v[0] + axes[1][c] * v[1] + axes[2][c] * v[2]);
    for (let k = path.length - 1; k >= 0; k--) {
      const l = path[k] * 10,
        turn = [local[l + 3], local[l + 4], local[l + 5], local[l + 6]];
      if (!(local[l + 7] > 0 && local[l + 8] > 0 && local[l + 9] > 0))
        throw new RangeError(`IK bone ${path[k]} needs positive scales; remove its zero or mirrored scale`);
      const offset = place([local[l], local[l + 1], local[l + 2]]);
      position = [position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]];
      rotation = multiplyQuaternions(rotation, turn);
      axes = [0, 1, 2].map((a) =>
        place(
          rotateByQuaternion(
            [0, 1, 2].map((c) => (c === a ? local[l + 7 + a] : 0)),
            turn,
          ),
        ),
      );
    }
    return { position, rotation };
  };
  const body = chain.limits === false ? null : (chain.body ?? pose.body ?? anatomyOf(pose)),
    result = solveChain(
      {
        world,
        above: (bone) => (parents[bone] >= 0 ? world(parents[bone]).rotation : [0, 0, 0, 1]),
        local: (bone) => quaternionAt(local, bone * 10 + 3),
        write: (bone, rotation) => local.set(rotation, bone * 10 + 3),
        flush: () => {},
      },
      joints,
      chain,
      body,
    );
  // Under an uneven scale the posed bones stretch as they turn, so the end is measured on the posed skeleton, not on
  // FABRIK's points.
  const posed = world(joints[joints.length - 1]).position,
    t = chain.target,
    distance = Math.hypot(posed[0] - t[0], posed[1] - t[1], posed[2] - t[2]);
  return { ...result, reached: distance <= settings(chain).tolerance, distance };
}

/** What the chain solver needs of a posed skeleton: world frames to read and local rotations to write. */
interface ChainRig {
  /** A bone's world position and rotation in the pose as it is now. */
  world(bone: number): { position: ArrayLike<number>; rotation: number[] };
  /** The world rotation of a bone's parent, [0, 0, 0, 1] at the top. */
  above(bone: number): number[];
  /** A bone's local rotation. */
  local(bone: number): number[];
  /** Sets a bone's local rotation. */
  write(bone: number, rotation: number[]): void;
  /** Makes what was written show in `world`. */
  flush(): void;
}

type ChainSettings = FABRIKOptions & Pick<IKChain, 'target' | 'weight' | 'keepBend' | 'soft'>;

/** A hinge straighter than this many degrees is started this far bent, so the solve knows its side. */
const HINGE_SEED = 3;

/** The elbow or knee at `mid` with the shoulder or hip at `upper`, when the body has that limb. */
function limbOf(body: Anatomy, upper: number, mid: number): { hinge: AnatomyJoint; ball: AnatomyJoint | null } | null {
  const hinge = jointOf(body, mid);
  return hinge?.kind === 'hinge' && hinge.reference === upper ? { hinge, ball: jointOf(body, upper) } : null;
}

const inverse = (q: ArrayLike<number>): number[] => [-q[0], -q[1], -q[2], q[3]];

/**
 * Solves a chain on a posed skeleton: FABRIK alone without a body, and with a body the closed-form limb and the
 * joint ranges described at the top of this file.
 */
function solveChain(
  rig: ChainRig,
  joints: readonly number[],
  chain: ChainSettings,
  body: Anatomy | null,
): FABRIKResult {
  const n = joints.length,
    weight = chain.weight ?? 1,
    { tolerance } = settings(chain);
  const fabrik = (blend: number): FABRIKResult => {
    const frames = joints.map((joint) => rig.world(joint)),
      base = rig.above(joints[0]),
      points = new Float64Array(n * 3);
    frames.forEach((frame, i) => points.set(frame.position, i * 3));
    const before = points.slice(),
      bends = chain.keepBend === false ? null : bendSides(before, n),
      result = solveFABRIK(points, chain.target, chain);
    if (bends) keepBendSides(points, bends);
    const rotations = chainRotations(
      before,
      points,
      frames.map((f) => f.rotation),
      blend,
    );
    // Local rotation of each turned joint: inverse(parent's new world rotation) x its new world rotation.
    for (let i = 0; i < n - 1; i++)
      rig.write(
        joints[i],
        normalizeQuaternion(multiplyQuaternions(inverse(i === 0 ? base : rotations[i - 1]), rotations[i])),
      );
    rig.flush();
    return result;
  };
  if (!body?.limits) return fabrik(weight);
  const turning = joints.slice(0, n - 1),
    start = weight < 1 ? turning.map((joint) => rig.local(joint)) : null,
    end = joints[n - 1],
    gap = (): number => {
      const p = rig.world(end).position,
        t = chain.target;
      return Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    },
    referenceOf = (joint: AnatomyJoint): number[] =>
      joint.reference >= 0 ? rig.world(joint.reference).rotation : [0, 0, 0, 1],
    setWorld = (bone: number, rotation: ArrayLike<number>): void => {
      rig.write(bone, normalizeQuaternion(multiplyQuaternions(inverse(rig.above(bone)), rotation as number[])));
      rig.flush();
    },
    /**
     * Brings every turning joint of the chain inside its range, the nearest to the body first, and a trunk or neck
     * the chain runs along inside its range as a whole; true when one moved.
     */
    clamp = (): boolean =>
      limitBones(body, turning, {
        read: (bone, out) => {
          const q = rig.world(bone).rotation;
          out[0] = q[0];
          out[1] = q[1];
          out[2] = q[2];
          out[3] = q[3];
        },
        write: setWorld,
      }),
    limb = (upper: number, mid: number, tip: number, parts: NonNullable<ReturnType<typeof limbOf>>): boolean => {
      const u = rig.world(upper),
        m = rig.world(mid),
        solved = solveLimbIK({
          root: u.position,
          mid: m.position,
          end: rig.world(tip).position,
          upperRotation: u.rotation,
          lowerRotation: m.rotation,
          target: chain.target,
          pole: chain.pole ?? null,
          hinge: parts.hinge,
          ball: parts.ball,
          reference: parts.ball ? referenceOf(parts.ball) : undefined,
          soft: chain.soft,
          tolerance,
        });
      setWorld(upper, solved.upper);
      setWorld(mid, solved.lower);
      return solved.held;
    };
  let iterations = 0,
    stopped = false;
  const tail = n >= 3 ? limbOf(body, joints[n - 3], joints[n - 2]) : null;
  if (n === 3 && tail) stopped = limb(joints[0], joints[1], joints[2], tail);
  else {
    // A straight hinge has no side for FABRIK to keep: start it a little bent, the anatomical way.
    const v = [0, 0, 0],
      turn = [0, 0, 0, 1];
    for (let i = 1; i < n - 1; i++) {
      const joint = jointOf(body, joints[i]);
      if (joint?.kind !== 'hinge') continue;
      const reference = referenceOf(joint);
      jointTurn(joint, reference, rig.world(joints[i]).rotation, v);
      if (v[0] >= HINGE_SEED) continue;
      v[0] = HINGE_SEED;
      clampTurn(joint, v);
      turnRotation(joint, v, turn);
      setWorld(joints[i], multiplyQuaternions(reference, turn));
    }
    // FABRIK and the ranges take turns while the end keeps gaining; the best pose inside the ranges is kept.
    let best = Number.POSITIVE_INFINITY,
      kept: number[][] | null = null;
    for (let round = 0; round < 8; round++) {
      iterations += fabrik(1).iterations;
      const moved = clamp(),
        left = gap();
      stopped ||= moved;
      if (left < best - 1e-12) {
        best = left;
        kept = turning.map((joint) => rig.local(joint));
      } else break;
      if (!moved || left <= tolerance) break;
    }
    if (kept) {
      turning.forEach((joint, i) => rig.write(joint, kept![i]));
      rig.flush();
    }
    if (tail) stopped = limb(joints[n - 3], joints[n - 2], end, tail) || stopped;
  }
  if (start) {
    // Part of the way from the pose to the solve, then back inside the ranges.
    turning.forEach((joint, i) => {
      const solved = rig.local(joint),
        delta = partial(multiplyQuaternions(inverse(start[i]), solved), weight);
      rig.write(joint, normalizeQuaternion(multiplyQuaternions(start[i], delta)));
    });
    rig.flush();
    clamp();
  }
  const distance = gap();
  return { reached: distance <= tolerance, distance, iterations, held: stopped && distance > tolerance };
}

/**
 * Checks a chain: 2-256 joint indices below `count`, each a child of the one before. Returns the joints.
 * @throws TypeError / RangeError naming the fault.
 */
function checkChain(
  chain: IKChain,
  count: number,
  isChild: (child: number, parent: number) => boolean,
): readonly number[] {
  const joints = chain?.joints;
  if (!Array.isArray(joints) || joints.length < 2 || joints.length > 256)
    throw new TypeError('An IK chain needs joints: 2 to 256 indices from the first joint to the last');
  for (const j of joints)
    if (!Number.isInteger(j) || j < 0 || j >= count)
      throw new RangeError(`IK chain joint ${j} is not one of the ${count} bones; pass a valid index`);
  for (let i = 1; i < joints.length; i++)
    if (!isChild(joints[i], joints[i - 1]))
      throw new RangeError(`IK chain joint ${joints[i]} is not a child of ${joints[i - 1]}; list a parent-child line`);
  vector(chain.target, 'IK target');
  const weight = chain.weight ?? 1;
  if (!(weight >= 0 && weight <= 1)) throw new RangeError('IK weight must be from 0 to 1');
  return joints;
}

/** Smallest bend (sine of the angle between a joint's two bones' line and its first bone) that sets a bend side. */
const BEND_SIDE_MIN = Math.sin((2 * Math.PI) / 180);

/**
 * The bend side of each inner joint of the chain as posed (`points`, xyz per joint): the unit offset of the joint from
 * the line through its two neighbours, or null where the joint is near straight. These are world directions; the
 * chain's parent does not move during a solve, so they hold for the solved chain too.
 */
function bendSides(points: Float64Array, n: number): (number[] | null)[] {
  const sides: (number[] | null)[] = [];
  for (let i = 1; i < n - 1; i++) {
    const a = (i - 1) * 3,
      j = i * 3,
      b = (i + 1) * 3,
      u = [points[b] - points[a], points[b + 1] - points[a + 1], points[b + 2] - points[a + 2]],
      v = [points[j] - points[a], points[j + 1] - points[a + 1], points[j + 2] - points[a + 2]],
      ul = Math.hypot(u[0], u[1], u[2]),
      vl = Math.hypot(v[0], v[1], v[2]);
    if (!(ul > 0 && vl > 0)) {
      sides.push(null);
      continue;
    }
    const along = (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (ul * ul),
      off = [v[0] - u[0] * along, v[1] - u[1] * along, v[2] - u[2] * along],
      ol = Math.hypot(off[0], off[1], off[2]);
    sides.push(ol > BEND_SIDE_MIN * vl ? [off[0] / ol, off[1] / ol, off[2] / ol] : null);
  }
  return sides;
}

/**
 * Moves each inner joint that the solve folded to the far side of its posed bend (`sides`, from {@link bendSides})
 * to the nearest allowed place: its offset from the line through its neighbours loses the part that points away from
 * the posed side, keeping its distance from the line, so both bone lengths and both neighbours stay put. A hinge
 * turned a quarter turn about its limb is the most a shoulder or hip allows (shoulder internal rotation about 70 and
 * external about 90 degrees, hip about 45 each way; Greene and Heckman, The Clinical Measurement of Joint Motion,
 * AAOS 1994), and FABRIK keeps a joint inside its allowed region by moving it to the closest allowed position
 * (Aristidou and Lasenby 2011, section 4; Aristidou, Chrysanthou and Lasenby, Extending FABRIK with model
 * constraints, Computer Animation and Virtual Worlds 27(1), 2016).
 */
function keepBendSides(points: Float64Array, sides: readonly (number[] | null)[]): void {
  for (let i = 1; i <= sides.length; i++) {
    const side = sides[i - 1];
    if (!side) continue;
    const a = (i - 1) * 3,
      j = i * 3,
      b = (i + 1) * 3,
      ax = points[b] - points[a],
      ay = points[b + 1] - points[a + 1],
      az = points[b + 2] - points[a + 2],
      length = Math.hypot(ax, ay, az);
    if (!(length > 0)) continue;
    const ux = ax / length,
      uy = ay / length,
      uz = az / length,
      jx = points[j] - points[a],
      jy = points[j + 1] - points[a + 1],
      jz = points[j + 2] - points[a + 2],
      along = jx * ux + jy * uy + jz * uz,
      px = jx - ux * along,
      py = jy - uy * along,
      pz = jz - uz * along,
      radius = Math.hypot(px, py, pz);
    // The posed side, square to the solved line.
    const sAlong = side[0] * ux + side[1] * uy + side[2] * uz;
    let sx = side[0] - ux * sAlong,
      sy = side[1] - uy * sAlong,
      sz = side[2] - uz * sAlong;
    const sl = Math.hypot(sx, sy, sz);
    if (!(sl > 1e-9) || !(radius > 0)) continue;
    (sx /= sl), (sy /= sl), (sz /= sl);
    const toward = px * sx + py * sy + pz * sz;
    if (toward >= 0) continue;
    let qx = px - sx * toward,
      qy = py - sy * toward,
      qz = pz - sz * toward;
    const ql = Math.hypot(qx, qy, qz);
    if (ql > radius * 1e-6) (qx *= radius / ql), (qy *= radius / ql), (qz *= radius / ql);
    else (qx = sx * radius), (qy = sy * radius), (qz = sz * radius); // folded straight back: take the posed side
    points[j] = points[a] + ux * along + qx;
    points[j + 1] = points[a + 1] + uy * along + qy;
    points[j + 2] = points[a + 2] + uz * along + qz;
  }
}

/**
 * New world rotations of a chain's joints (all but the last) that turn each bone from its old direction (`before`)
 * to its new one (`after`), blended by `weight`.
 */
function chainRotations(
  before: Float64Array,
  after: Float64Array,
  rotations: readonly number[][],
  weight: number,
): number[][] {
  const out: number[][] = [],
    bones = rotations.length - 1,
    bone = (points: Float64Array, i: number): number[] =>
      [0, 1, 2].map((c) => points[i * 3 + 3 + c] - points[i * 3 + c]);
  for (let i = 0; i < bones; i++) {
    const from = bone(before, i),
      to = bone(after, i);
    let turn: number[] = rotationBetween(from, to);
    // The bend this bone hinges in: at its far joint, or for the last bone at its near one.
    const joint = i + 1 < bones ? i + 1 : i;
    if (joint >= 1)
      turn = keepHinge(
        turn,
        to,
        bendAxis(bone(before, joint - 1), bone(before, joint)),
        bendAxis(bone(after, joint - 1), bone(after, joint)),
      );
    if (weight < 1) turn = partial(turn, weight);
    out.push(normalizeQuaternion(multiplyQuaternions(turn, rotations[i])));
  }
  out.push(rotations[rotations.length - 1]);
  return out;
}

/**
 * The unit axis of the bend between two consecutive bones (their cross product), or null when they are within 2
 * degrees of a straight line and the bend has no axis to keep.
 */
function bendAxis(a: readonly number[], b: readonly number[]): number[] | null {
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    length = Math.hypot(n[0], n[1], n[2]);
  return length > BEND_SIDE_MIN * Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2])
    ? [n[0] / length, n[1] / length, n[2] / length]
    : null;
}

/**
 * Adds to a bone's shortest-arc `turn` the twist about its new direction `to` that carries its old bend axis onto the
 * new one, so both bones of an elbow or knee turn their bend axis the same way and the joint between them changes
 * only by a rotation about that axis, a true hinge in the bone's own frame. A shortest arc alone leaves the twist to
 * chance: when the bend plane swings, the lower bone's local rotation picks up swing about other axes and the forearm
 * or shin turns sideways or backward in the skin. A human elbow (humeroulnar) and knee flex about one axis fixed in
 * the bone (Kapandji, The Physiology of the Joints, vol. 1 and 2, 2007; Wu et al., ISB recommendation on definitions
 * of joint coordinate systems, Part II, J. Biomechanics 38, 2005), and analytic limb IK places the bend by turning the
 * upper limb about its own axis (the swivel angle of Tolani, Goswami and Badler, Real-time inverse kinematics
 * techniques for anthropomorphic limbs, Graphical Models 62, 2000). Either axis missing (a straight limb) leaves the
 * shortest arc as it was.
 */
function keepHinge(
  turn: readonly number[],
  to: readonly number[],
  oldAxis: number[] | null,
  newAxis: number[] | null,
): number[] {
  if (!oldAxis || !newAxis) return turn as number[];
  const length = Math.hypot(to[0], to[1], to[2]),
    u = [to[0] / length, to[1] / length, to[2] / length],
    m = rotateByQuaternion(oldAxis, turn),
    cos = m[0] * newAxis[0] + m[1] * newAxis[1] + m[2] * newAxis[2],
    sin =
      u[0] * (m[1] * newAxis[2] - m[2] * newAxis[1]) +
      u[1] * (m[2] * newAxis[0] - m[0] * newAxis[2]) +
      u[2] * (m[0] * newAxis[1] - m[1] * newAxis[0]),
    angle = Math.atan2(sin, cos);
  return normalizeQuaternion(multiplyQuaternions(axisAngleToQuaternion(u, angle), turn));
}

/** The same rotation about the same axis, `fraction` of the angle. */
function partial(q: readonly number[], fraction: number): [number, number, number, number] {
  const w = Math.min(1, Math.abs(q[3])),
    sign = q[3] < 0 ? -1 : 1,
    angle = 2 * Math.acos(w) * fraction,
    s = Math.sqrt(1 - w * w);
  if (s < 1e-12) return [0, 0, 0, 1];
  const k = (Math.sin(angle / 2) / s) * sign;
  return [q[0] * k, q[1] * k, q[2] * k, Math.cos(angle / 2)];
}

const quaternionAt = (values: Float64Array, at: number): [number, number, number, number] => [
  values[at],
  values[at + 1],
  values[at + 2],
  values[at + 3],
];

/** A skeleton {@link solveSkeletonIK} can pose: `@margoengine/animation`'s `Skeleton` fits. */
export interface IKSkeleton {
  readonly parents: readonly number[];
  readonly names: readonly string[];
  getPose(bone: number): { translation: ArrayLike<number>; rotation: ArrayLike<number>; scale: ArrayLike<number> };
  setPose(bone: number, pose: { rotation: readonly [number, number, number, number] }): unknown;
}

/**
 * Solves an IK chain on a `Skeleton` (`@margoengine/animation`): reads its current pose, turns the chain's joints so
 * the last reaches `target` (in skeleton space) bending toward `pole`, and sets their rotations. Joints may be bone
 * indices or names. A body given by `chain.body` or `setAnatomy(skeleton, body)` is obeyed as in {@link solvePoseIK}.
 */
export function solveSkeletonIK(
  skeleton: IKSkeleton,
  chain: Omit<IKChain, 'joints'> & { joints: readonly (number | string)[] },
): FABRIKResult {
  const { parents, names } = skeleton ?? ({} as IKSkeleton);
  if (!Array.isArray(parents) || typeof skeleton.getPose !== 'function' || typeof skeleton.setPose !== 'function')
    throw new TypeError('solveSkeletonIK needs a Skeleton from @margoengine/animation');
  const local = new Float64Array(parents.length * 10);
  for (let b = 0; b < parents.length; b++) {
    const { translation, rotation, scale } = skeleton.getPose(b);
    local.set(translation, b * 10);
    local.set(rotation, b * 10 + 3);
    local.set(scale, b * 10 + 7);
  }
  const joints = (chain?.joints ?? []).map((joint) => (typeof joint === 'string' ? names.indexOf(joint) : joint));
  const result = solvePoseIK({ parents, local, body: chain?.body ?? anatomyOf(skeleton) }, { ...chain, joints });
  for (let i = 0; i < joints.length - 1; i++)
    skeleton.setPose(joints[i], { rotation: quaternionAt(local, joints[i] * 10 + 3) });
  return result;
}

/**
 * An `ElbowEvaluator` for `@margoengine/kinematics-constraints`' `AvoidanceSolver`: the elbow of a two-bone arm of
 * these lengths reaching from `root` to `target`, turned `poleAngle` radians about the root-target line from the side
 * facing `pole` (a world point, or a function returning one each call). Unreachable targets put the elbow on the
 * straight (or fully folded) arm.
 */
export function elbowEvaluator(upperLength: number, lowerLength: number, pole: Vec3 | (() => Vec3)): ElbowEvaluator {
  if (!(upperLength > 0 && upperLength < Infinity) || !(lowerLength > 0 && lowerLength < Infinity))
    throw new RangeError('Elbow evaluator bone lengths must be finite and above 0');
  if (typeof pole !== 'function') vector(pole, 'Elbow pole');
  return (root, target, poleAngle, out) => {
    const p = typeof pole === 'function' ? pole() : pole,
      ax = target[0] - root[0],
      ay = target[1] - root[1],
      az = target[2] - root[2],
      length = Math.hypot(ax, ay, az);
    if (!(length > 0)) throw new MargoError('state', 'Elbow evaluator target is at the root; move the target');
    const ux = ax / length,
      uy = ay / length,
      uz = az / length,
      d = Math.min(Math.max(length, Math.abs(upperLength - lowerLength)), upperLength + lowerLength),
      along = (d * d + upperLength * upperLength - lowerLength * lowerLength) / (2 * d),
      radius = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
    // Reference direction: the pole's offset from the line, or any perpendicular when the pole is on it.
    let rx = p[0] - root[0],
      ry = p[1] - root[1],
      rz = p[2] - root[2];
    const dot = rx * ux + ry * uy + rz * uz;
    rx -= ux * dot;
    ry -= uy * dot;
    rz -= uz * dot;
    let r = Math.hypot(rx, ry, rz);
    if (!(r > 1e-12)) {
      const ox = Math.abs(ux) < 0.9 ? 1 : 0,
        oy = 1 - ox;
      rx = -uz * oy;
      ry = uz * ox;
      rz = ux * oy - uy * ox;
      r = Math.hypot(rx, ry, rz);
    }
    rx /= r;
    ry /= r;
    rz /= r;
    // Rodrigues: turn the reference about the axis by poleAngle (it is perpendicular to the axis).
    const c = Math.cos(poleAngle),
      s = Math.sin(poleAngle),
      bx = uy * rz - uz * ry,
      by = uz * rx - ux * rz,
      bz = ux * ry - uy * rx;
    out[0] = root[0] + ux * along + (rx * c + bx * s) * radius;
    out[1] = root[1] + uy * along + (ry * c + by * s) * radius;
    out[2] = root[2] + uz * along + (rz * c + bz * s) * radius;
  };
}

/**
 * A FABRIK IK chain on an Animator's skeleton ({@link addIKChain}). The Animator keeps the object and reads it every
 * frame, so move `target` and `pole` by writing into them.
 */
export interface AnimatorIKChain extends FABRIKOptions {
  /** glTF node indices from the first joint to the last (2-256), each the child of the one before. */
  joints: readonly number[];
  /** World point the last joint reaches for. */
  target: Vec3;
  /** Blend from the animated pose (0) to the solved chain (1); default 1. */
  weight?: number;
  /** Keep each bent elbow or knee on the side the animation bends it to, as {@link IKChain.keepBend}; default true. */
  keepBend?: boolean;
  /** The fitted body the chain obeys, as {@link IKChain.body}. Default: the body `setAnatomy` gave the Animator. */
  body?: Anatomy | null;
  /** False solves as if there were no body, as {@link IKChain.limits}. */
  limits?: boolean;
  /** Eases a fitted limb's reach in before full stretch, as {@link IKChain.soft}. */
  soft?: number;
  /** Called after each frame's solve with its result. */
  onSolve?: (result: FABRIKResult) => void;
}

/**
 * Adds a FABRIK IK chain with an optional pole to `animator` (`@margoengine/animator`), solved every frame after the
 * pose, additive layers and foot IK: the chain's joints turn so the last joint reaches `chain.target`, the bend facing
 * `chain.pole`. The last joint keeps its animated local rotation. Joints and their ancestors need positive scales;
 * rotations commit through the Animator's `writeRotation` when it has one. Returns a function that removes
 * the chain.
 *
 * When the Animator has a fitted body (`chain.body`, or `setAnatomy(animator, body)`) with limits on, the chain obeys
 * it as {@link solvePoseIK} does: elbows and knees bend the anatomical way inside their range, the pole only picks the
 * swivel inside the shoulder's or hip's range, and every joint of the chain stays in range. `limits: false` on the
 * chain turns that off.
 */
export function addIKChain(animator: Animator, chain: AnimatorIKChain): () => void {
  const nodes = animator.animation.model.nodes,
    engine = animator.animation.model.root.engine,
    store = engine.store,
    parents = store.parents;
  const joints = checkChain(chain, nodes.length, (child, parent) => parents[nodes[child].id] === nodes[parent].id);
  settings(chain);
  if (chain.onSolve !== undefined && typeof chain.onSolve !== 'function')
    throw new TypeError('IK chain onSolve must be a function');
  const t = store.transforms,
    rig: ChainRig = {
      world: (bone) => {
        const m = nodes[bone].matrix;
        return { position: [m[12], m[13], m[14]], rotation: worldRotation(m) };
      },
      above: (bone) => {
        const parent = parents[nodes[bone].id];
        return parent === -1 ? [0, 0, 0, 1] : worldRotation(engine.meshes.get(parent)!.matrix);
      },
      local: (bone) => {
        const id = nodes[bone].id;
        return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
      },
      write: (bone, rotation) => animator.writeNodeRotation(nodes[bone], rotation),
      flush: () => store.tick(false),
    };
  return animator.addSolver(() => {
    const weight = chain.weight ?? 1;
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('IK weight must be from 0 to 1');
    if (weight === 0) return;
    const body = chain.limits === false ? null : (chain.body ?? anatomyOf(animator)),
      result = solveChain(rig, joints, chain, body);
    chain.onSolve?.(result);
  });
}

/** The rotation of a world matrix with positive scales, each column divided by its own. */
function worldRotation(m: ArrayLike<number>): number[] {
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]),
    det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (!(det > 0)) throw new RangeError('IK chain joints need positive scales; remove zero or mirrored joint scales');
  return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 0], sx, sy, sz));
}
