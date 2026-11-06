// IK chains with pole targets, solved by FABRIK (A. Aristidou and J. Lasenby, "FABRIK: a fast, iterative solver for
// the inverse kinematics problem", Graphical Models 73(5), 2011): alternate backward and forward passes that move each
// joint onto the line to its neighbour at the bone's length. After each pair of passes every inner joint turns about
// the line through its two neighbours (which keeps both bone lengths) toward the pole. Results become joint rotations
// by turning each bone from its old direction to its new one with the shortest arc.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import {
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import type { Mesh } from '@margoengine/core/extension';
import type { Animator } from '@margoengine/animator';
import type { ElbowEvaluator } from '@margoengine/kinematics-constraints';

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
  let iteration = 0;
  if (pole) bendToward(points, n, pole);
  else if (n > 2) {
    // A straight chain has no side to fold to: start it bent a hair toward a fixed perpendicular of its line.
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
}

/**
 * A pose to solve: parents and local transforms, 10 numbers per bone (translation xyz, rotation xyzw, scale xyz),
 * the layout of `@margoengine/animation`'s `retargetRig(...).rest` and {@link solveSkeletonIK}'s skeletons.
 */
export interface IKPose {
  readonly parents: readonly number[];
  readonly local: Float64Array;
}

/**
 * Solves an IK chain on a pose without an engine: turns the chain's joints (all but the last) so the last reaches
 * `target`, bending toward `pole`. Writes the new rotations into `pose.local`. Bones need positive scales. An uneven
 * scale stretches the bones under it as they turn, so the last joint lands as close as that stretch allows.
 * @throws RangeError for an invalid chain or pose.
 */
export function solvePoseIK(pose: IKPose, chain: IKChain): FABRIKResult {
  const { parents, local } = pose ?? ({} as IKPose),
    count = parents?.length;
  if (!Array.isArray(parents) || !(local instanceof Float64Array) || local.length !== count * 10)
    throw new TypeError('solvePoseIK needs {parents, local} with 10 local numbers per bone');
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
        place(rotateByQuaternion([0, 1, 2].map((c) => (c === a ? local[l + 7 + a] : 0)), turn)),
      );
    }
    return { position, rotation };
  };
  const frames = joints.map(world),
    parentOfFirst = parents[joints[0]],
    base = parentOfFirst >= 0 ? world(parentOfFirst).rotation : [0, 0, 0, 1],
    points = new Float64Array(joints.length * 3);
  frames.forEach((frame, i) => points.set(frame.position, i * 3));
  const before = points.slice(),
    result = solveFABRIK(points, chain.target, chain),
    rotations = chainRotations(
      before,
      points,
      frames.map((f) => f.rotation),
      chain.weight ?? 1,
    );
  // Local rotation of each turned joint: inverse(parent's new world rotation) x its new world rotation.
  for (let i = 0; i < joints.length - 1; i++) {
    const parent = i === 0 ? base : rotations[i - 1],
      l = joints[i] * 10,
      q = normalizeQuaternion(multiplyQuaternions([-parent[0], -parent[1], -parent[2], parent[3]], rotations[i]));
    local.set(q, l + 3);
  }
  return result;
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
  const out: number[][] = [];
  for (let i = 0; i < rotations.length - 1; i++) {
    const from = [0, 1, 2].map((c) => before[i * 3 + 3 + c] - before[i * 3 + c]),
      to = [0, 1, 2].map((c) => after[i * 3 + 3 + c] - after[i * 3 + c]);
    let turn = rotationBetween(from, to);
    if (weight < 1) turn = partial(turn, weight);
    out.push(normalizeQuaternion(multiplyQuaternions(turn, rotations[i])));
  }
  out.push(rotations[rotations.length - 1]);
  return out;
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

/** A skeleton {@link solveSkeletonIK} can pose: `@margoengine/animation`'s `Skeleton` fits. */
export interface IKSkeleton {
  readonly parents: readonly number[];
  readonly names: readonly string[];
  getPose(bone: number): { translation: ArrayLike<number>; rotation: ArrayLike<number>; scale: ArrayLike<number> };
  setPose(bone: number, pose: { rotation: readonly number[] }): unknown;
}

/**
 * Solves an IK chain on a `Skeleton` (`@margoengine/animation`): reads its current pose, turns the chain's joints so
 * the last reaches `target` (in skeleton space) bending toward `pole`, and sets their rotations. Joints may be bone
 * indices or names.
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
  const result = solvePoseIK({ parents, local }, { ...chain, joints });
  for (let i = 0; i < joints.length - 1; i++)
    skeleton.setPose(joints[i], { rotation: Array.from(local.subarray(joints[i] * 10 + 3, joints[i] * 10 + 7)) });
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
  /** Called after each frame's solve with its result. */
  onSolve?: (result: FABRIKResult) => void;
}

/**
 * Adds a FABRIK IK chain with an optional pole to `animator` (`@margoengine/animator`), solved every frame after the
 * pose, additive layers and foot IK: the chain's joints turn so the last joint reaches `chain.target`, the bend facing
 * `chain.pole`. The last joint keeps its animated local rotation. Joints and their ancestors need positive scales;
 * rotations commit through the Animator's `writeRotation` when it has one. Returns a function that removes
 * the chain. For joint limits, use `addCCDChain` from `@margoengine/animator`.
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
  const chainNodes: Mesh[] = joints.map((i) => nodes[i]),
    points = new Float64Array(joints.length * 3),
    before = new Float64Array(joints.length * 3);
  return animator.addSolver(() => {
    const weight = chain.weight ?? 1;
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('IK weight must be from 0 to 1');
    if (weight === 0) return;
    const rotations = chainNodes.map((node, i) => {
      const m = node.matrix;
      points.set([m[12], m[13], m[14]], i * 3);
      return worldRotation(m);
    });
    before.set(points);
    const result = solveFABRIK(points, chain.target, chain),
      turned = chainRotations(before, points, rotations, weight),
      parent = parents[chainNodes[0].id],
      base = parent === -1 ? [0, 0, 0, 1] : worldRotation(engine.meshes.get(parent)!.matrix);
    for (let i = 0; i < chainNodes.length - 1; i++) {
      const p = i === 0 ? base : turned[i - 1];
      animator.writeNodeRotation(
        chainNodes[i],
        normalizeQuaternion(multiplyQuaternions([-p[0], -p[1], -p[2], p[3]], turned[i])),
      );
    }
    store.tick(false);
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
