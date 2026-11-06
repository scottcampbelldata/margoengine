// Full-body IK: hands, feet and head reach their targets together, and the body moves to let them.
//
// The torso is the solved part: the pelvis's position and turn, and a turn at each spine joint, as one small least-squares
// problem. Each limb gives it one wish: its root must come within the limb's reach of the limb's target. A limb in reach
// asks for nothing, so a hand in range leaves the body alone, and a pinned foot stops the pelvis going further than the
// leg allows. A head target wishes its head to the point, and balance wishes the centre of mass over the feet. Each step
// is a damped Gauss-Newton step (Levenberg 1944, Marquardt 1963) on the turn and move that best meets every wish at once,
// weighted, from the animated pose. The damping only steadies the step: a reachable set of targets is met exactly, by
// close to the smallest change. When the torso is settled, each limb is finished by the analytic two-bone solver, so its
// bones keep their lengths and the bend follows its pole.
//
// The centre of mass uses a fixed share of the body per segment (D. A. Winter, "Biomechanics and Motor Control of Human
// Movement", segment masses): head 8.1 percent, trunk 49.7, each arm 5, each leg 16.1.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import { finiteVector } from '@margoengine/math/validate';
import { quaternionBlend } from './blend.js';
import type { Animator } from './index.js';
import { position, poseTools, subtract } from './pose-tools.js';

/** One arm or leg of {@link FullBodyIK}: a direct chain of three joints. Everything but the joints is read every frame. */
export interface FullBodyLimb {
  /** glTF node index of the shoulder or hip joint (the limb's root), below the pelvis. */
  upper: number;
  /** glTF node index of the elbow or knee; a child of `upper`. */
  lower: number;
  /** glTF node index of the wrist or ankle; a child of `lower`. */
  end: number;
  /** World point the end reaches for. Null or absent: it holds its animated place if `pinned`, else rides with the body. */
  target?: Vec3 | null;
  /** World rotation (x, y, z, w) the end takes. Default: its animated world rotation. */
  rotation?: ArrayLike<number> | null;
  /** World point the elbow or knee bends toward. Default: the way it bends in the animated pose. */
  pole?: Vec3 | null;
  /** How strongly the target counts, 0-1 (default 1); 0 is the animated place. */
  weight?: number;
  /** Holds its animated place when it has no target. Default true for legs, false for arms. */
  pinned?: boolean;
  /** Bears weight, so balance counts it. Default true for legs, false for arms. */
  support?: boolean;
}

/** The head of {@link FullBodyIK}. */
export interface FullBodyHead {
  /** glTF node index of the head joint, below the last spine joint. */
  joint: number;
  /** World point the head reaches for, by bending the body. Null or absent for none. */
  target?: Vec3 | null;
  /** World rotation (x, y, z, w) the head takes. Default: its animated rotation, carried with the body. */
  rotation?: ArrayLike<number> | null;
  /** How strongly the target counts, 0-1 (default 1). */
  weight?: number;
}

/** Options of {@link addFullBodyIK}. The Animator keeps the object and reads its targets and settings every frame. */
export interface FullBodyIK {
  /** glTF node index of the pelvis, the bone that moves. */
  pelvis: number;
  /** Joints from the pelvis up to the chest, each below the one before (0-16). */
  spine: readonly number[];
  /** The legs (0-8). */
  legs?: readonly FullBodyLimb[];
  /** The arms (0-8). */
  arms?: readonly FullBodyLimb[];
  /** The head; default none. */
  head?: FullBodyHead | null;
  /** Keep the centre of mass over what bears weight (default true). */
  balance?: boolean;
  /** How far the centre of mass may stand outside the supports, world units. Default a tenth of the first leg's length: the size of a foot. */
  supportRadius?: number;
  /** Most a spine joint turns from the animated pose, radians (default 0.8). */
  maxBend?: number;
  /** Fraction of a limb's length the torso plans for, 0.5-1 (default 0.98), so a limb is not left locked straight. */
  reach?: number;
  /** Most torso steps per frame, 1-64 (default 12). */
  iterations?: number;
  /** Distance left that counts as reached, world units (default 0.001). */
  tolerance?: number;
  /** Blend from the animated pose (0) to fully solved (1); default 1. */
  weight?: number;
  /** Called after each frame's solve with the reused result. */
  onSolve?: (result: FullBodyResult) => void;
}

/** What a frame's solve did; {@link addFullBodyIK} reuses one object, so read it before the next frame. */
export interface FullBodyResult {
  /** Every target met within `tolerance`. */
  reached: boolean;
  /** Largest distance from a limb's end or the head to its target, world units. */
  distance: number;
  /** The centre of mass is over the supports, or balance is off or has nothing to stand on. */
  balanced: boolean;
  /** How far the centre of mass stands outside the supports, world units (0 when balanced). */
  imbalance: number;
  /** Torso steps run. */
  iterations: number;
}

/** A full-body IK handle. */
export interface FullBodyHandle {
  /** Last frame's result. */
  readonly result: FullBodyResult;
  /** Removes the solve; the body plays its animated pose again. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const HEAD_MASS = 0.081,
  TRUNK_MASS = 0.497,
  ARM_MASS = 0.05,
  LEG_MASS = 0.161,
  DAMPING = 0.02,
  LEG_WISH = 30,
  ARM_WISH = 1,
  HEAD_WISH = 1,
  BALANCE_WISH = 4,
  // Most of a limb's length one step works on, so a far target pulls no harder than the legs can answer (Buss, "Selectively
  // damped least squares", 2005, clamps the error for the same reason).
  STEP_SHARE = 0.25,
  MAX_LINKS = 17;
type Point = [number, number, number];

const add = (a: ArrayLike<number>, b: ArrayLike<number>): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mixPoint = (a: ArrayLike<number>, b: ArrayLike<number>, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const unit = (v: Point): Point => {
  const size = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / size, v[1] / size, v[2] / size];
};
const conjugate = (q: ArrayLike<number>) => [-q[0], -q[1], -q[2], q[3]];
const rotationFrom = (x: number, y: number, z: number): number[] => {
  const angle = Math.hypot(x, y, z),
    s = angle > 1e-12 ? Math.sin(angle / 2) / angle : 0.5;
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
};
// The angle of a unit quaternion the short way round.
const angleOf = (q: ArrayLike<number>) => 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));
const scaleRotation = (q: number[], fraction: number): number[] => quaternionBlend([0, 0, 0, 1], q, fraction);

/**
 * Solves `a x = b` in place for a positive definite `a` (n by n, row major) by Cholesky factors; `b` becomes x. The
 * damped normal equations are positive definite by construction.
 */
function solveSymmetric(a: Float64Array, b: Float64Array, n: number): void {
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= a[i * n + k] * a[j * n + k];
      a[i * n + j] = i === j ? Math.sqrt(sum) : sum / a[j * n + j];
    }
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= a[i * n + k] * b[k];
    b[i] = sum / a[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let k = i + 1; k < n; k++) sum -= a[k * n + i] * b[k];
    b[i] = sum / a[i * n + i];
  }
}

/** The nearest point of the convex hull of `points` (x, z pairs) to (x, z). Wraps the hull from the leftmost point. */
function nearestSupport(points: readonly (readonly [number, number])[], x: number, z: number): [number, number] {
  const count = points.length;
  if (count === 1) return [points[0][0], points[0][1]];
  let start = 0;
  for (let i = 1; i < count; i++) if (points[i][0] < points[start][0]) start = i;
  const hull: number[] = [];
  let at = start;
  do {
    hull.push(at);
    let next = (at + 1) % count;
    for (let i = 0; i < count; i++) {
      const cross =
        (points[next][0] - points[at][0]) * (points[i][1] - points[at][1]) -
        (points[next][1] - points[at][1]) * (points[i][0] - points[at][0]);
      if (cross < 0) next = i;
    }
    at = next;
  } while (at !== start && hull.length <= count);
  let inside = hull.length >= 3,
    best: [number, number] = [points[hull[0]][0], points[hull[0]][1]],
    nearest = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = points[hull[i]],
      b = points[hull[(i + 1) % hull.length]],
      ex = b[0] - a[0],
      ez = b[1] - a[1],
      length = ex * ex + ez * ez,
      t = length > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / length)) : 0,
      px = a[0] + ex * t,
      pz = a[1] + ez * t,
      gap = Math.hypot(x - px, z - pz);
    if (ex * (z - a[1]) - ez * (x - a[0]) < 0) inside = false;
    if (gap < nearest) {
      nearest = gap;
      best = [px, pz];
    }
  }
  return inside ? [x, z] : best;
}

/**
 * Adds full-body IK to `animator`, solved every frame after the pose, layers, foot IK and the solvers added before it:
 * arms, legs and head reach their targets together, moving and turning the pelvis and bending the spine as far as they
 * need to, while legs hold their ground and the centre of mass stays over them. For reaching, climbing and interactions.
 * Move a target by writing into it. Bones keep their lengths; a target beyond reach leaves the limb straight toward it.
 * Bones and their ancestors need positive scales. Returns the handle; dispose it to stop.
 * @throws RangeError for invalid joints or settings; TypeError for a limb that is not a direct chain below the pelvis.
 */
export function addFullBodyIK(animator: Animator, rig: FullBodyIK): FullBodyHandle {
  const model = animator.animation.model,
    nodes = model.nodes,
    parents = model.root.engine.store.parents,
    tools = poseTools(animator, 'Full-body IK');
  const node = (index: unknown, label: string): Mesh => {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= nodes.length)
      throw new RangeError(`Full-body IK ${label} ${index} is not one of the model's ${nodes.length} glTF nodes`);
    return nodes[index as number];
  };
  const pelvis = node(rig?.pelvis, 'pelvis');
  if (!Array.isArray(rig.spine) || rig.spine.length > MAX_LINKS - 1)
    throw new RangeError('Full-body IK spine must list 0-16 joints from the pelvis up to the chest');
  const links: Mesh[] = [pelvis, ...rig.spine.map((joint, i) => node(joint, `spine ${i}`))];
  /** Index of the deepest link `bone` hangs from, or -1. */
  const linkOf = (bone: Mesh): number => {
    for (let at = parents[bone.id]; at !== -1; at = parents[at]) {
      const found = links.findIndex((link) => link.id === at);
      if (found !== -1) return found;
    }
    return -1;
  };
  links.forEach((link, i) => {
    if (i && linkOf(link) !== i - 1)
      throw new TypeError(`Full-body IK spine ${i - 1} is not below the joint before it; list joints from the pelvis up`);
  });
  const limbsOf = (list: readonly FullBodyLimb[] | undefined, kind: string, isLeg: boolean) => {
    if (list !== undefined && (!Array.isArray(list) || list.length > 8))
      throw new RangeError(`Full-body IK ${kind}s must be 0-8 limbs`);
    return (list ?? []).map((limb, i) => {
      const upper = node(limb?.upper, `${kind} ${i} upper`),
        lower = node(limb.lower, `${kind} ${i} lower`),
        end = node(limb.end, `${kind} ${i} end`),
        link = linkOf(upper);
      if (parents[lower.id] !== upper.id || parents[end.id] !== lower.id)
        throw new TypeError(
          `Full-body IK ${kind} ${i} is not a direct chain; pass a lower joint that is a child of upper and an end that is a child of lower`,
        );
      if (link === -1) throw new TypeError(`Full-body IK ${kind} ${i} is not below the pelvis; pass a limb that hangs from it`);
      return {
        limb,
        isLeg,
        upper,
        lower,
        end,
        link,
        // This frame: the root's offset from its link, where the end goes, which way the limb bends, the end's animated
        // rotation, its length, its shortest and planned reach, and how strongly the torso must serve it (0 for not at all).
        offset: [0, 0, 0] as Point,
        aim: [0, 0, 0] as Point,
        bend: [0, 0, 0] as Point,
        rest: [0, 0, 0, 1] as ArrayLike<number>,
        length: 0,
        short: 0,
        far: 0,
        wish: 0,
      };
    });
  };
  const legs = limbsOf(rig.legs, 'leg', true),
    arms = limbsOf(rig.arms, 'arm', false),
    limbs = [...legs, ...arms];
  const headBone = rig.head ? node(rig.head.joint, 'head joint') : null,
    headLink = headBone ? linkOf(headBone) : -1;
  if (headBone && headLink === -1) throw new TypeError('Full-body IK head joint is not below the pelvis; pass a joint that hangs from it');
  const read = () => {
    const weight = rig.weight ?? 1,
      maxBend = rig.maxBend ?? 0.8,
      reach = rig.reach ?? 0.98,
      iterations = rig.iterations ?? 12,
      tolerance = rig.tolerance ?? 0.001;
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('Full-body IK weight must be from 0 to 1');
    if (!(maxBend >= 0 && maxBend <= Math.PI)) throw new RangeError('Full-body IK maxBend must be from 0 to pi radians');
    if (!(reach >= 0.5 && reach <= 1)) throw new RangeError('Full-body IK reach must be from 0.5 to 1');
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 64)
      throw new RangeError('Full-body IK iterations must be an integer from 1 to 64');
    if (!(tolerance > 0 && tolerance < Infinity)) throw new RangeError('Full-body IK tolerance must be above 0');
    if (rig.supportRadius !== undefined && !(rig.supportRadius >= 0 && rig.supportRadius < Infinity))
      throw new RangeError('Full-body IK supportRadius must be 0 or more');
    for (const { limb } of limbs) {
      if (!((limb.weight ?? 1) >= 0 && (limb.weight ?? 1) <= 1))
        throw new RangeError('Full-body IK limb weight must be from 0 to 1');
      if (limb.target) finiteVector(limb.target, 3, 'Full-body IK target');
      if (limb.pole) finiteVector(limb.pole, 3, 'Full-body IK pole');
    }
    if (rig.head?.target) finiteVector(rig.head.target, 3, 'Full-body IK head target');
    return { weight, maxBend, reach, iterations, tolerance };
  };
  read();
  if (rig.onSolve !== undefined && typeof rig.onSolve !== 'function')
    throw new TypeError('Full-body IK onSolve must be a function');
  const count = links.length,
    size = 3 + 3 * count,
    // Pelvis travel, then a world turn at each link: the unknowns of a step.
    normal = new Float64Array(size * size),
    gradient = new Float64Array(size),
    rows = new Float64Array(3 * size),
    centre = new Float64Array(3 * size),
    // Each link now: its place and its world turn from the animated pose; the animated place; the turn from its parent.
    places: Point[] = links.map(() => [0, 0, 0]),
    turns: number[][] = links.map(() => [0, 0, 0, 1]),
    start: Point[] = links.map(() => [0, 0, 0]),
    relative: number[][] = links.map(() => [0, 0, 0, 1]),
    worlds: number[][] = links.map(() => [0, 0, 0, 1]);
  const result: FullBodyResult = { reached: true, distance: 0, balanced: true, imbalance: 0, iterations: 0 };
  /** A point hanging from link `link` at `offset` from it in the animated pose, where the solve has it now. */
  const carried = (link: number, offset: ArrayLike<number>): Point =>
    add(places[link], rotateByQuaternion(offset as number[], turns[link]));
  /** The Jacobian rows of a point on link `link`: the change of each axis per unknown. */
  const jacobian = (link: number, point: ArrayLike<number>, out: Float64Array, weight: number): void => {
    for (let axis = 0; axis < 3; axis++) out[axis * size + axis] += weight;
    for (let j = 0; j <= link; j++) {
      const rx = point[0] - places[j][0],
        ry = point[1] - places[j][1],
        rz = point[2] - places[j][2],
        at = 3 + j * 3;
      // Turning about e_k moves the point by e_k x r.
      out[1 * size + at] -= weight * rz;
      out[2 * size + at] += weight * ry;
      out[0 * size + at + 1] += weight * rz;
      out[2 * size + at + 1] -= weight * rx;
      out[0 * size + at + 2] -= weight * ry;
      out[1 * size + at + 2] += weight * rx;
    }
  };
  /** Adds `wish` x (J^T J, J^T e) for the axes in `from` to `to` of rows `j`, the error being `e`. */
  const gather = (j: Float64Array, e: ArrayLike<number>, wish: number, from = 0, step = 1): void => {
    for (let axis = from; axis < 3; axis += step)
      for (let a = 0; a < size; a++) {
        const value = j[axis * size + a];
        if (!value) continue;
        gradient[a] += wish * value * e[axis];
        for (let b = 0; b < size; b++) normal[a * size + b] += wish * value * j[axis * size + b];
      }
  };
  /** Rebuilds every link from the pelvis's place and the turns between links, holding each within `maxBend`. */
  const rebuild = (maxBend: number): void => {
    for (let j = 1; j < count; j++) {
      const angle = angleOf(relative[j]);
      if (angle > maxBend) relative[j] = scaleRotation(relative[j], maxBend / angle);
      turns[j] = multiplyQuaternions(relative[j], turns[j - 1]);
      places[j] = add(places[j - 1], rotateByQuaternion(subtract(start[j], start[j - 1]), turns[j - 1]));
    }
  };
  let removed = false;
  const remove = animator.addSolver(() => {
    const { weight, maxBend, reach, iterations, tolerance } = read();
    result.reached = true;
    result.distance = 0;
    result.balanced = true;
    result.imbalance = 0;
    result.iterations = 0;
    if (weight === 0) return;
    // The animated pose.
    for (let j = 0; j < count; j++) {
      const place = position(links[j]);
      places[j] = place;
      start[j] = place;
      turns[j] = [0, 0, 0, 1];
      relative[j] = [0, 0, 0, 1];
      worlds[j] = tools.rotationOf(links[j].matrix);
    }
    const facing = model.root.matrix,
      forward: Point = [facing[8], facing[9], facing[10]],
      // Down and back: a straight arm's elbow, away from every reach but one down behind the body.
      elbow = unit([-forward[0], -1 - forward[1], -forward[2]]),
      supports: Array<readonly [number, number]> = [];
    let firstLeg = 0;
    for (const item of limbs) {
      const { limb, isLeg, upper, lower, end, link } = item,
        root = position(upper),
        knee = position(lower),
        tip = position(end),
        pinned = limb.pinned ?? isLeg,
        influence = (limb.weight ?? 1) * weight,
        // Where the limb's end goes. A target pulls by its weight from the animated place.
        place = limb.target ? mixPoint(tip, limb.target, influence) : pinned ? tip : null;
      item.offset = subtract(root, start[link]);
      item.length = distance(root, knee) + distance(knee, tip);
      item.short = Math.abs(distance(root, knee) - distance(knee, tip));
      // A limb held where the clip has it may stay as straight as the clip has it.
      item.far = Math.max(item.length * reach, limb.target ? distance(root, tip) * (1 - influence) : distance(root, tip));
      item.rest = tools.rotationOf(end.matrix);
      // Out from the line through the limb: the way it bends, or forward for a leg and down for an arm that is straight.
      const line = subtract(tip, root),
        along = (subtract(knee, root)[0] * line[0] + subtract(knee, root)[1] * line[1] + subtract(knee, root)[2] * line[2]) /
          Math.max(1e-12, line[0] * line[0] + line[1] * line[1] + line[2] * line[2]),
        side = subtract(knee, mixPoint(root, tip, along)),
        sideLength = Math.hypot(side[0], side[1], side[2]);
      item.bend =
        sideLength > 1e-3 * item.length
          ? [side[0] / sideLength, side[1] / sideLength, side[2] / sideLength]
          : isLeg
            ? forward
            : elbow;
      item.wish = place ? (isLeg ? LEG_WISH : ARM_WISH) : 0;
      item.aim = place ?? tip;
      if (isLeg && !firstLeg) firstLeg = item.length;
      if (place && (limb.support ?? isLeg)) supports.push([place[0], place[2]]);
    }
    const headStart = headBone ? position(headBone) : null,
      headOffset = headBone ? subtract(headStart!, start[headLink]) : null,
      headAim =
        headBone && rig.head!.target ? mixPoint(headStart!, rig.head!.target, (rig.head!.weight ?? 1) * weight) : null;
    const standing = (rig.balance ?? true) && supports.length > 0,
      radius = rig.supportRadius ?? firstLeg * 0.1,
      trunkShare = TRUNK_MASS / count;
    /** The centre of mass now, into `centre` as Jacobian rows when `rows` is true; returns its place. */
    const massCentre = (withRows: boolean): Point => {
      if (withRows) centre.fill(0);
      let x = 0,
        y = 0,
        z = 0;
      const mass = (share: number, link: number, point: ArrayLike<number>, carriedShare = 1) => {
        x += share * point[0];
        y += share * point[1];
        z += share * point[2];
        if (withRows) jacobian(link, point, centre, share * carriedShare);
      };
      for (let j = 0; j < count; j++) mass(trunkShare, j, places[j]);
      if (headBone) mass(HEAD_MASS, headLink, carried(headLink, headOffset!));
      for (const { limb, isLeg, link, offset, aim } of limbs) {
        const root = carried(link, offset),
          share = isLeg ? LEG_MASS : ARM_MASS,
          // A limb's mass sits half way down it; a held end does not move with the body.
          held = limb.target || (limb.pinned ?? isLeg);
        mass(share, link, mixPoint(root, aim, 0.5), held ? 0.5 : 1);
      }
      return [x, y, z];
    };
    /** How far the centre of mass stands outside the supports, as an x, y, z error toward them. */
    const offBalance = (point: ArrayLike<number>): Point => {
      const [nx, nz] = nearestSupport(supports, point[0], point[2]),
        ex = nx - point[0],
        ez = nz - point[2],
        gap = Math.hypot(ex, ez);
      if (gap <= radius) return [0, 0, 0];
      const k = (gap - radius) / gap;
      return [ex * k, 0, ez * k];
    };
    for (let step = 0; step < iterations; step++) {
      normal.fill(0);
      gradient.fill(0);
      let largest = 0;
      for (const { offset, link, aim, length, short, far, wish } of limbs) {
        if (!wish) continue;
        const root = carried(link, offset),
          toAim = subtract(aim, root),
          span = Math.hypot(toAim[0], toAim[1], toAim[2]),
          near = short * 1.02;
        if (span <= far && span >= near) continue;
        const gap = span - (span > far ? far : near),
          k = Math.sign(gap) * Math.min(Math.abs(gap), length * STEP_SHARE) / Math.max(span, 1e-9),
          error: Point = [toAim[0] * k, toAim[1] * k, toAim[2] * k];
        largest = Math.max(largest, Math.abs(gap));
        rows.fill(0);
        jacobian(link, root, rows, 1);
        gather(rows, error, wish);
      }
      if (headAim) {
        const point = carried(headLink, headOffset!),
          error = subtract(headAim, point);
        largest = Math.max(largest, Math.hypot(error[0], error[1], error[2]));
        rows.fill(0);
        jacobian(headLink, point, rows, 1);
        gather(rows, error, HEAD_WISH);
      }
      if (standing) {
        const error = offBalance(massCentre(true));
        const off = Math.hypot(error[0], error[2]);
        if (off > 0) {
          largest = Math.max(largest, off);
          gather(centre, error, BALANCE_WISH, 0, 2);
        }
      }
      if (largest <= tolerance) break;
      result.iterations = step + 1;
      for (let i = 0; i < size; i++) normal[i * size + i] += DAMPING;
      solveSymmetric(normal, gradient, size);
      // Apply the step: the pelvis moves, then each joint turns everything from it up.
      places[0] = add(places[0], gradient);
      for (let j = 0; j < count; j++) {
        const at = 3 + j * 3,
          turn = rotationFrom(gradient[at], gradient[at + 1], gradient[at + 2]);
        for (let k = j; k < count; k++) turns[k] = multiplyQuaternions(turn, turns[k]);
      }
      for (let j = 1; j < count; j++) relative[j] = multiplyQuaternions(turns[j], conjugate(turns[j - 1]));
      rebuild(maxBend);
    }
    // Write the torso back, from the pelvis up, then finish each limb on it.
    tools.moveBy(pelvis, subtract(places[0], start[0]));
    for (let j = 0; j < count; j++) tools.setWorldRotation(links[j], multiplyQuaternions(turns[j], worlds[j]));
    for (const { limb, upper, lower, end, link, aim, bend, rest, length, wish } of limbs) {
      if (wish) {
        const turned = rotateByQuaternion(bend as number[], turns[link]),
          knee = position(lower);
        tools.placeLimb(
          upper,
          lower,
          end,
          aim,
          limb.pole ?? [knee[0] + turned[0] * length, knee[1] + turned[1] * length, knee[2] + turned[2] * length],
        );
        const left = distance(position(end), aim);
        result.distance = Math.max(result.distance, left);
        if (left > tolerance) result.reached = false;
      }
      const wanted = limb.rotation ?? (wish ? rest : null);
      if (wanted) {
        const influence = limb.rotation ? (limb.weight ?? 1) * weight : 1;
        tools.setWorldRotation(end, influence < 1 ? quaternionBlend(rest, wanted, influence) : wanted);
      }
    }
    if (headBone) {
      if (rig.head!.rotation)
        tools.setWorldRotation(
          headBone,
          quaternionBlend(tools.rotationOf(headBone.matrix), rig.head!.rotation, (rig.head!.weight ?? 1) * weight),
        );
      if (headAim) {
        const left = distance(position(headBone), headAim);
        result.distance = Math.max(result.distance, left);
        if (left > tolerance) result.reached = false;
      }
    }
    if (standing) {
      const off = offBalance(massCentre(false));
      result.imbalance = Math.hypot(off[0], off[2]);
      result.balanced = result.imbalance <= tolerance;
    }
    rig.onSolve?.(result);
  });
  const dispose = () => {
    if (removed) return;
    removed = true;
    remove();
  };
  return { result, dispose, [Symbol.dispose]: dispose };
}
