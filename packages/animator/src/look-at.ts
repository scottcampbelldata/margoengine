// Look-at and aim constraints on an Animator's skeleton: after the pose, a bone (or a spine-neck-head run of bones,
// each taking a share of the turn) turns so a local axis points at a world target, optionally rolled so a second axis
// stays toward world up. Kept out of the Animator class so an app that never adds one does not bundle it.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import {
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import { MargoError } from '@margoengine/math/errors';
import { quaternionBlend } from './blend.js';
import type { Animator } from './index.js';

/** A look-at constraint ({@link addLookAt}). The Animator keeps the object and reads it every frame. */
export interface LookAt {
  /**
   * glTF node indices of the bones that turn, from the first (a spine or neck bone) to the last (the head or eye),
   * each a descendant of the one before (1-32 bones). The last bone's `axis` ends up pointing at the target.
   */
  joints: readonly number[];
  /** World point to look at; mutate it per frame. */
  target: Vec3;
  /** Share of the turn each bone takes, index-aligned with `joints`, each >= 0 (default equal shares). */
  shares?: readonly number[];
  /** The last bone's local look direction (default [0, 0, 1], glTF's forward). */
  axis?: Vec3;
  /** The last bone's local up direction, rolled toward `worldUp` after aiming (default [0, 1, 0]); null skips the roll. */
  up?: Vec3 | null;
  /** World up for the roll (default [0, 1, 0]). */
  worldUp?: Vec3;
  /** Largest turn away from the animated look direction, radians (0-π, default π). */
  maxAngle?: number;
  /** Blend from the animated pose (0) to the full turn (1); default 1. */
  weight?: number;
}

/** An aim constraint on one bone ({@link addAimConstraint}): {@link LookAt} with a single joint. */
export interface AimConstraint extends Omit<LookAt, 'joints' | 'shares'> {
  /** glTF node index of the bone that turns. */
  joint: number;
}

const unit = (v: ArrayLike<number>, label: string): number[] => {
  const length = Math.hypot(v?.[0], v?.[1], v?.[2]);
  if (!(length > 0 && length < Infinity) || v.length !== 3)
    throw new RangeError(`${label} must be a nonzero direction of three finite numbers`);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Adds a look-at constraint to `animator`, solved every frame after the pose, additive layers, foot IK and the solvers
 * added before it: the bones in `lookAt.joints` turn in order, each taking its share of what is left of the turn, so
 * the last bone's `axis` points at `lookAt.target` (within `maxAngle` of the animated direction), then that bone rolls
 * about the look direction so its `up` axis is as close to `worldUp` as it can be. Bones and their ancestors need
 * positive uniform scales; rotations commit through the Animator's `writeRotation` when it has one. Returns a function
 * that removes the constraint.
 * @throws RangeError for invalid joints or settings.
 */
export function addLookAt(animator: Animator, lookAt: LookAt): () => void {
  const nodes = animator.animation.model.nodes,
    engine = animator.animation.model.root.engine,
    store = engine.store,
    parents = store.parents,
    joints = lookAt?.joints;
  if (!Array.isArray(joints) || joints.length < 1 || joints.length > 32)
    throw new TypeError('Look-at joints must be 1-32 glTF node indices from the first bone to the last');
  for (const j of joints)
    if (!Number.isInteger(j) || j < 0 || j >= nodes.length)
      throw new RangeError(`Look-at joint ${j} is not one of the model's ${nodes.length} glTF nodes`);
  const chain: Mesh[] = joints.map((j) => nodes[j]);
  for (let i = 1; i < chain.length; i++) {
    let at = parents[chain[i].id];
    while (at !== -1 && at !== chain[i - 1].id) at = parents[at];
    if (at === -1)
      throw new RangeError(`Look-at joint ${joints[i]} is not below ${joints[i - 1]}; list bones from first to last`);
  }
  const read = () => {
    const shares = lookAt.shares ?? joints.map(() => 1),
      weight = lookAt.weight ?? 1,
      maxAngle = lookAt.maxAngle ?? Math.PI;
    if (!Array.isArray(shares) || shares.length !== joints.length || !shares.every((s) => s >= 0 && s < Infinity))
      throw new RangeError('Look-at shares need one finite share >= 0 per joint');
    if (!shares.some((s) => s > 0)) throw new RangeError('Look-at shares must not all be 0; give a bone a share');
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('Look-at weight must be from 0 to 1');
    if (!(maxAngle >= 0 && maxAngle <= Math.PI)) throw new RangeError('Look-at maxAngle must be from 0 to π');
    const target = lookAt.target;
    if (!target || target.length !== 3 || !target.every(Number.isFinite))
      throw new RangeError('Look-at target must be three finite numbers');
    return {
      shares,
      weight,
      maxAngle,
      target,
      axis: unit(lookAt.axis ?? [0, 0, 1], 'Look-at axis'),
      up: lookAt.up === null ? null : unit(lookAt.up ?? [0, 1, 0], 'Look-at up'),
      worldUp: unit(lookAt.worldUp ?? [0, 1, 0], 'Look-at worldUp'),
    };
  };
  read();
  const last = chain[chain.length - 1];
  const before = chain.map(() => [0, 0, 0, 1]),
    blended = [0, 0, 0, 1];
  return animator.addSolver(() => {
    const { shares, weight, maxAngle, target, axis, up, worldUp } = read();
    if (weight === 0) return;
    // The animated look direction and the wanted one, from the last bone's world frame.
    const head = position(last),
      forward = rotateByQuaternion(axis, rotation(last.matrix)),
      toward = [target[0] - head[0], target[1] - head[1], target[2] - head[2]],
      distance = Math.hypot(toward[0], toward[1], toward[2]);
    if (!(distance > 1e-9)) return; // the target is at the bone: no direction to look in
    // The point aimed at: the target, or (beyond maxAngle) the point at its distance maxAngle from the animated look.
    let aim: ArrayLike<number> = target;
    const wanted = toward.map((v) => v / distance),
      angle = Math.acos(Math.min(1, Math.max(-1, dot(forward, wanted))));
    if (angle > maxAngle) {
      const clamped = turnToward(forward, wanted, maxAngle / angle);
      aim = [head[0] + clamped[0] * distance, head[1] + clamped[1] * distance, head[2] + clamped[2] * distance];
    }
    const t = store.transforms;
    chain.forEach((bone, i) => {
      const id = bone.id;
      before[i] = [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
    });
    let remaining = 0;
    for (const share of shares) remaining += share;
    for (let i = 0; i < chain.length; i++) {
      const share = shares[i];
      if (!(share > 0)) continue;
      // Each bone takes its share of what is left, measured from the last bone's current frame and position.
      const eye = position(last),
        from = rotateByQuaternion(axis, rotation(last.matrix)),
        to = unit([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]], 'Look-at direction');
      turnBone(chain[i], partial(between(from, to), share / remaining));
      remaining -= share;
    }
    if (up) {
      // Roll about the look direction so `up` points as near world up as it can.
      const now = rotation(last.matrix),
        look = rotateByQuaternion(axis, now),
        current = reject(rotateByQuaternion(up, now), look),
        goal = reject(worldUp, look);
      if (current && goal) turnBone(last, between(current, goal));
    }
    if (weight < 1) {
      // Blend each bone's local rotation from the animated one to the solved one.
      for (let i = 0; i < chain.length; i++) {
        const id = chain[i].id;
        quaternionBlend(before[i], [t.qx[id], t.qy[id], t.qz[id], t.qw[id]], weight, blended);
        animator.writeNodeRotation(chain[i], blended);
      }
      store.tick(false);
    }
  });
  function turnBone(bone: Mesh, turn: number[]): void {
    const parent = parents[bone.id],
      base = parent === -1 ? [0, 0, 0, 1] : rotation(engine.meshes.get(parent)!.matrix),
      world = multiplyQuaternions(turn, rotation(bone.matrix));
    animator.writeNodeRotation(
      bone,
      normalizeQuaternion(multiplyQuaternions([-base[0], -base[1], -base[2], base[3]], world)),
    );
    store.tick(false);
  }
}

/**
 * Adds an aim constraint to `animator`: one bone turns so its local `axis` points at `aim.target`, rolled so `up`
 * stays toward `worldUp` ({@link addLookAt} with one joint). Returns a function that removes it.
 */
export function addAimConstraint(animator: Animator, aim: AimConstraint): () => void {
  if (!aim || typeof aim !== 'object') throw new TypeError('Aim constraint needs {joint, target}');
  // A live view of the caller's object, so later writes to target, weight and the axes take effect.
  const lookAt: LookAt = {
    joints: [aim.joint],
    get target() {
      return aim.target;
    },
    get axis() {
      return aim.axis;
    },
    get up() {
      return aim.up;
    },
    get worldUp() {
      return aim.worldUp;
    },
    get maxAngle() {
      return aim.maxAngle;
    },
    get weight() {
      return aim.weight;
    },
  };
  return addLookAt(animator, lookAt);
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** `v` without its component along unit `axis`, normalised; null when nothing is left. */
function reject(v: ArrayLike<number>, axis: ArrayLike<number>): number[] | null {
  const d = dot(v, axis),
    r = [v[0] - axis[0] * d, v[1] - axis[1] * d, v[2] - axis[2] * d],
    length = Math.hypot(r[0], r[1], r[2]);
  return length > 1e-9 ? r.map((x) => x / length) : null;
}
/** Unit direction `fraction` of the way from unit `a` to unit `b` along the great circle. */
function turnToward(a: number[], b: number[], fraction: number): number[] {
  return rotateByQuaternion(a, partial(between(a, b), fraction));
}
/** Shortest-arc rotation from unit `a` to unit `b`. */
function between(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const d = dot(a, b);
  if (d < -1 + 1e-12) {
    const side = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
      axis = reject(side, a)!;
    return [axis[0], axis[1], axis[2], 0];
  }
  return normalizeQuaternion([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + d]);
}
/** `fraction` of a rotation (slerp from identity). */
function partial(q: number[], fraction: number): number[] {
  return fraction >= 1 ? q : quaternionBlend([0, 0, 0, 1], q, fraction);
}
/** World position of a node. */
function position(node: Mesh): number[] {
  const m = node.matrix;
  return [m[12], m[13], m[14]];
}
/** Rotation of a world matrix with a positive uniform scale. */
function rotation(m: ArrayLike<number>): number[] {
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]);
  if (!(sx > 0) || Math.abs(sx - sy) > 1e-5 * sx || Math.abs(sx - sz) > 1e-5 * sx)
    throw new MargoError('state', 'Look-at bones need positive uniform scales; remove non-uniform scales above them');
  return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 0], sx, sy, sz));
}
