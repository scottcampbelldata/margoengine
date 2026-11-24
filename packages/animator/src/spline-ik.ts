// Spline IK: a joint chain follows a curve. Each joint lands on the curve at exactly one bone's length, in a straight
// line, from the joint before, found by bisection along the curve's arc length, so bones keep their lengths and joints
// stay on the curve however tightly it bends. Twist comes from the curve's rotation-minimising frames: each bone turns
// from the animated chain's frame to the curve's, so a curl past half a turn does not flip, and a chain lying along the
// curve is not twisted. Reuses @margoengine/splines for the curve, its arc lengths and its frames.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { multiplyQuaternions, normalizeQuaternion, rotationToQuaternion } from '@margoengine/math/quat';
import { Spline } from '@margoengine/splines';
import { SplineFrames } from '@margoengine/splines/frames';
import { quaternionBlend } from './blend.js';
import type { Animator } from './index.js';
import { position, poseTools, subtract } from './pose-tools.js';

/** A chain on a curve ({@link addSplineIK}). The Animator keeps the object and reads it every frame. */
export interface SplineIKChain {
  /** glTF node indices from the first joint to the last (2-256), each the child of the one before. */
  joints: readonly number[];
  /** The curve, or the points of a Catmull-Rom curve through them (2 or more); world space unless `space` is set. */
  curve: Spline | readonly Vec3[];
  /** Node whose local space the curve is in, so a tail's curve travels with its body. Default world space. */
  space?: Mesh | null;
  /** `curve` (default) moves the first joint to the curve's start; `root` keeps it animated and moves the curve to it. */
  anchor?: 'curve' | 'root';
  /** Distance along the curve the first joint starts at, world units (default 0), to slide a chain along a path. */
  offset?: number;
  /** Twist added along the chain, radians, at its first and last joint (default none). */
  twist?: readonly [number, number];
  /** Blend from the animated pose (0) to the chain on the curve (1); default 1. */
  weight?: number;
  /** Intervals the curve's frames are built at, 2-4,096 (default 64). */
  samples?: number;
}

/** A spline IK handle. */
export interface SplineIKHandle {
  /** How much of the chain ran past the curve's end last frame and carried on straight, world units. */
  readonly overrun: number;
  /** Removes the chain from the curve. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const STEPS = 40;
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: number[]): number[] => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** The rotation of the frame with `tangent` along +Y and `normal` (made perpendicular to it) along +Z. */
function frameRotation(tangent: number[], normal: ArrayLike<number>): number[] {
  const along = dot(normal, tangent),
    z = unit([normal[0] - along * tangent[0], normal[1] - along * tangent[1], normal[2] - along * tangent[2]]),
    x = cross(tangent, z);
  return normalizeQuaternion(
    rotationToQuaternion([x[0], x[1], x[2], 0, tangent[0], tangent[1], tangent[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1], [0, 0, 0, 0], 1, 1, 1),
  );
}

/**
 * Bends `chain.joints` of `animator` along `chain.curve`, solved every frame after the pose, layers, foot IK and the
 * solvers added before it, for spines, tails and tentacles. Bones keep their lengths; past the curve's end the chain
 * carries on straight along its last tangent. Joints and their ancestors need positive scales. Returns the
 * handle; dispose it to stop.
 * @throws RangeError for invalid joints or settings; TypeError for joints that are not a parent-child line.
 */
export function addSplineIK(animator: Animator, chain: SplineIKChain): SplineIKHandle {
  const model = animator.animation.model,
    nodes = model.nodes,
    parents = model.root.engine.store.parents,
    tools = poseTools(animator, 'Spline IK'),
    joints = chain?.joints;
  if (
    !Array.isArray(joints) ||
    joints.length < 2 ||
    joints.length > 256 ||
    joints.some((i) => !Number.isInteger(i) || i < 0 || i >= nodes.length)
  )
    throw new RangeError("Spline IK joints must be 2-256 of this model's glTF node indices");
  const bones: Mesh[] = joints.map((i) => nodes[i]);
  for (let j = 1; j < bones.length; j++)
    if (parents[bones[j].id] !== bones[j - 1].id)
      throw new TypeError('Spline IK joints must each be the child of the joint before; list them from first to last');
  const read = () => {
    const weight = chain.weight ?? 1,
      samples = chain.samples ?? 64,
      offset = chain.offset ?? 0,
      anchor = chain.anchor ?? 'curve',
      twist = chain.twist ?? null;
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('Spline IK weight must be from 0 to 1');
    if (!Number.isInteger(samples) || samples < 2 || samples > 4096)
      throw new RangeError('Spline IK samples must be an integer from 2 to 4,096');
    if (!(offset >= 0 && offset < Infinity)) throw new RangeError('Spline IK offset must be 0 or more');
    if (anchor !== 'curve' && anchor !== 'root') throw new RangeError("Spline IK anchor must be 'curve' or 'root'");
    if (twist && (twist.length !== 2 || !twist.every(Number.isFinite)))
      throw new RangeError('Spline IK twist must be two finite angles: [first joint, last joint]');
    return { weight, samples, offset, anchor, twist };
  };
  read();
  if (chain.space !== undefined && chain.space !== null && !chain.space.matrix)
    throw new TypeError('Spline IK space must be a node, or null for world space');
  const curveOf = (): Spline => {
    const curve = chain.curve;
    if (Array.isArray(curve)) {
      if (curve.length < 2) throw new RangeError('Spline IK curve must be a Spline or 2 or more points');
      return new Spline(curve as readonly Vec3[]);
    }
    // By shape, not instanceof, so a second copy of the splines package still works.
    if (typeof (curve as Spline)?.atDistance !== 'function')
      throw new RangeError('Spline IK curve must be a Spline or 2 or more points');
    return curve as Spline;
  };
  curveOf();
  const count = bones.length,
    point = new Float64Array(3),
    placed: number[][] = bones.map(() => [0, 0, 0]),
    worlds: number[][] = bones.map(() => [0, 0, 0, 1]),
    bent: number[][] = bones.map(() => [0, 0, 0, 1]),
    stations = new Float64Array(count);
  let overrun = 0,
    removed = false;
  const remove = animator.addSolver(() => {
    const { weight, samples, offset, anchor, twist } = read(),
      spline = curveOf(),
      length = spline.length,
      space = chain.space?.matrix ?? null;
    overrun = 0;
    if (weight === 0) return;
    if (!(length > 0)) throw new RangeError('Spline IK curve has no length; give it two different points');
    // The curve's point in world space; moved so its start meets the first joint with anchor 'root'.
    const shift = [0, 0, 0],
      onCurve = (distance: number, out: number[]) => {
        spline.atDistance(distance, point);
        if (space) {
          const x = point[0],
            y = point[1],
            z = point[2];
          out[0] = space[0] * x + space[4] * y + space[8] * z + space[12];
          out[1] = space[1] * x + space[5] * y + space[9] * z + space[13];
          out[2] = space[2] * x + space[6] * y + space[10] * z + space[14];
        } else {
          out[0] = point[0];
          out[1] = point[1];
          out[2] = point[2];
        }
        out[0] += shift[0];
        out[1] += shift[1];
        out[2] += shift[2];
      };
    const first = Math.min(offset, length),
      start = position(bones[0]),
      place = [0, 0, 0],
      tip = [0, 0, 0],
      // World units in one curve unit, so the march along the arc steps a fraction of a bone.
      unitSize = space ? Math.hypot(space[0], space[1], space[2]) : 1;
    if (anchor === 'root') {
      onCurve(first, place);
      for (let c = 0; c < 3; c++) shift[c] = start[c] - place[c];
    }
    // Past its end the curve carries on along its last tangent, so a joint passes the end smoothly.
    onCurve(length, tip);
    onCurve(length * (1 - 1e-4), place);
    const end = unit(subtract(tip, place)),
      world = (distance: number, out: number[]) => {
        if (distance <= length) return onCurve(distance, out);
        const past = (distance - length) * unitSize;
        for (let c = 0; c < 3; c++) out[c] = tip[c] + end[c] * past;
      };
    const animated: number[][] = bones.map((bone) => position(bone));
    for (let j = 0; j < count; j++) worlds[j] = tools.rotationOf(bones[j].matrix);
    world(first, placed[0]);
    stations[0] = first;
    // Each joint: the first point along the curve one bone from the last. March along the arc, then bisect, so a curve
    // that comes back near this joint later is not taken for the next place.
    for (let j = 1; j < count; j++) {
      const bone = Math.hypot(...subtract(animated[j], animated[j - 1])),
        stride = bone / (2 * unitSize),
        last = placed[j - 1];
      let low = stations[j - 1],
        high = low;
      do {
        low = high;
        high = low + stride;
        world(high, place);
      } while (Math.hypot(...subtract(place, last)) < bone);
      for (let i = 0; i < STEPS; i++) {
        const mid = (low + high) / 2;
        world(mid, place);
        if (Math.hypot(...subtract(place, last)) < bone) low = mid;
        else high = mid;
      }
      world(high, placed[j]);
      stations[j] = high;
    }
    overrun = Math.max(0, stations[count - 1] - length) * unitSize;
    // Frames: the curve's, started from the animated chain's own normal so nothing twists on its own.
    const firstBone = unit(subtract(animated[1], animated[0])),
      helper = Math.abs(firstBone[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0],
      normal = unit(cross(firstBone, cross(helper, firstBone))),
      frames = new SplineFrames(spline, { samples, up: normal });
    // The animated chain's frames walk the same way along its bones.
    let reference = normal;
    for (let j = 0; j < count - 1; j++) {
      const before = unit(subtract(animated[j + 1], animated[j])),
        chord = unit(subtract(placed[j + 1], placed[j])),
        curveNormal = frames.frameAt(Math.min(length, (stations[j] + stations[j + 1]) / 2)).normal,
        // Twist turns the normal about the bone, shared out from the first bone to the last.
        angle = twist ? twist[0] + ((twist[1] - twist[0]) * j) / Math.max(1, count - 2) : 0,
        side = cross(chord, curveNormal),
        turned = [0, 1, 2].map((c) => curveNormal[c] * Math.cos(angle) + side[c] * Math.sin(angle)),
        solved = frameRotation(chord, turned),
        was = frameRotation(before, reference),
        delta = multiplyQuaternions(solved, [-was[0], -was[1], -was[2], was[3]]);
      bent[j] = multiplyQuaternions(delta, worlds[j]);
      if (j + 1 < count - 1) {
        // Carry the reference normal onto the next animated bone by the shortest turn.
        const next = unit(subtract(animated[j + 2], animated[j + 1])),
          across = cross(before, next),
          sin = Math.hypot(across[0], across[1], across[2]);
        if (sin > 1e-9) {
          const axis = [across[0] / sin, across[1] / sin, across[2] / sin],
            cos = dot(before, next),
            n = reference,
            k = cross(axis, n),
            d = dot(axis, n) * (1 - cos);
          reference = [
            n[0] * cos + k[0] * sin + axis[0] * d,
            n[1] * cos + k[1] * sin + axis[1] * d,
            n[2] * cos + k[2] * sin + axis[2] * d,
          ];
        }
      }
    }
    bent[count - 1] = multiplyQuaternions(
      multiplyQuaternions(bent[count - 2], [-worlds[count - 2][0], -worlds[count - 2][1], -worlds[count - 2][2], worlds[count - 2][3]]),
      worlds[count - 1],
    );
    // Write from the first joint out, blended by weight.
    if (anchor === 'curve') {
      const move = subtract(placed[0], start);
      tools.moveBy(bones[0], [move[0] * weight, move[1] * weight, move[2] * weight]);
    }
    for (let j = 0; j < count; j++)
      tools.setWorldRotation(bones[j], weight < 1 ? quaternionBlend(worlds[j], bent[j], weight) : bent[j]);
  });
  const dispose = () => {
    if (removed) return;
    removed = true;
    remove();
  };
  return {
    get overrun() {
      return overrun;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
