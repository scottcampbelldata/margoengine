import type { Animator } from '@margoengine/animator';
import { type CCDJointLimit, CCDSolver } from '@margoengine/animator/ccd';
import {
  axisAngleToQuaternion,
  conjugateQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
} from '@margoengine/math/quat';
import { dot, length, normalize } from '@margoengine/math/vec3';

type Quaternion = readonly [number, number, number, number];

/** One calibrated local rotation constraint, applied to an animation or to an IK chain. */
export interface PoseJointLimit {
  /** Index in the pose or glTF model. */
  readonly joint: number;
  /** The neutral local rotation, [x, y, z, w], in the joint's authored axes. */
  readonly neutral: Quaternion;
  /** Limits relative to neutral. A cone must specify its local bone axis for a standalone pose. */
  readonly limit: CCDJointLimit;
}

function unitJointRotation(q: ArrayLike<number>, label: string): [number, number, number, number] {
  if (!(q?.length === 4 && Array.from(q).every(Number.isFinite) && Math.hypot(...Array.from(q)) > 0))
    throw new RangeError(`${label} needs a finite, nonzero quaternion`);
  return normalizeQuaternion(q);
}

/**
 * Projects the authored joints of a sampled pose into their calibrated ranges. Uses the same hinge, cone and Euler
 * limits as the contact solver, so ordinary animation and contact obey the same anatomy. The layout is reusable and
 * supports dense rigs without packing an entire skeleton into one IK chain.
 */
export class PoseJointLimits {
  private readonly groups: { offsets: number[]; solver: CCDSolver }[] = [];

  /**
   * Compiles the joint limits once for a pose with `jointCount` bones.
   * @throws RangeError for an invalid bone index, duplicate joint, rotation or joint count.
   */
  constructor(
    readonly jointCount: number,
    limits: readonly PoseJointLimit[],
  ) {
    if (!Number.isInteger(jointCount) || jointCount < 1 || jointCount > 65_536)
      throw new RangeError('Pose joint count must be an integer from 1 to 65,536');
    const used = new Set<number>();
    for (let start = 0; start < limits.length; start += 256) {
      const batch = limits.slice(start, start + 256),
        solver = new CCDSolver(batch.map(() => [0, 0, 0]));
      const offsets = batch.map(({ joint, neutral, limit }, i) => {
        if (!Number.isInteger(joint) || joint < 0 || joint >= jointCount || used.has(joint))
          throw new RangeError('Pose limits must name distinct joint indices in the pose');
        if (limit.type === 'cone' && !limit.axis) throw new RangeError('Pose cone limits need an explicit local axis');
        used.add(joint);
        solver.rest.set(unitJointRotation(neutral, 'Pose limit neutral rotation'), i * 4);
        solver.setLimit(i, limit);
        return joint * 10 + 3;
      });
      this.groups.push({ offsets, solver });
    }
  }

  /** Edits only the limited rotations in a local pose, with 10 values per joint (translation, rotation and scale). */
  apply(local: Float64Array): void {
    if (!(local instanceof Float64Array) || local.length !== this.jointCount * 10)
      throw new TypeError('Pose joint limits need a Float64Array with 10 values per joint');
    // Load and check all groups before writing to the pose, so an invalid joint leaves the input unchanged.
    for (const { offsets, solver } of this.groups) {
      offsets.forEach((at, i) =>
        solver.rotations.set(unitJointRotation(local.subarray(at, at + 4), 'Sampled pose rotation'), i * 4),
      );
      solver.projectRotations();
    }
    for (const { offsets, solver } of this.groups)
      offsets.forEach((at, i) => local.set(solver.rotations.subarray(i * 4, i * 4 + 4), at));
  }
}

/**
 * Applies one calibrated limit profile to an Animator after the pose and earlier solvers. Register after contact or
 * look-at solvers if they must also obey these limits. Returns the remover.
 */
export function addPoseJointLimits(animator: Animator, limits: readonly PoseJointLimit[]): () => void {
  const nodes = animator.animation.model.nodes,
    rig = new PoseJointLimits(nodes.length, limits),
    store = animator.animation.model.root.engine.store,
    t = store.transforms,
    local = new Float64Array(nodes.length * 10),
    rotation = [0, 0, 0, 1],
    affected = limits.map(({ joint }) => ({ node: nodes[joint], at: joint * 10 + 3 }));
  return animator.addSolver(() => {
    for (const { node, at } of affected) {
      const { id } = node;
      local[at] = t.qx[id];
      local[at + 1] = t.qy[id];
      local[at + 2] = t.qz[id];
      local[at + 3] = t.qw[id];
    }
    rig.apply(local);
    for (const { node, at } of affected) {
      for (let i = 0; i < 4; i++) rotation[i] = local[at + i];
      animator.writeNodeRotation(node, rotation);
    }
    store.tick(false);
  });
}

/**
 * Moves excess axial twist from a joint into its direct parent while preserving the child's world rotation and origin.
 * Used for a hand attached to an authored forearm: the forearm can pronate and the wrist's local twist stays within
 * `[min,max]` radians around `neutral`. The parent must have a positive uniform scale. A zero-length offset is invalid.
 * Returns the signed number of radians moved into the parent. Neighbouring child branches follow the parent as usual.
 * @throws RangeError for invalid joint indices, rotations, scales, axis or range.
 */
export function redistributeJointTwist(
  local: Float64Array,
  parents: readonly number[],
  joint: number,
  neutral: Quaternion,
  range: readonly [number, number],
): number {
  if (
    !(local instanceof Float64Array) ||
    local.length !== parents.length * 10 ||
    !Number.isInteger(joint) ||
    joint < 0 ||
    joint >= parents.length
  )
    throw new RangeError('Twist redistribution needs a valid joint in a local pose');
  const parent = parents[joint];
  if (!Number.isInteger(parent) || parent < 0 || parent >= parents.length || parent === joint)
    throw new RangeError('Twist redistribution needs a valid direct parent');
  const [min, max] = range;
  if (!(min >= -Math.PI && max <= Math.PI && min <= max))
    throw new RangeError('Twist range must be ordered within [-π, π]');
  const bone = joint * 10,
    upstream = parent * 10,
    s = local[upstream + 7];
  if (!(s > 0 && Number.isFinite(s) && local[upstream + 8] === s && local[upstream + 9] === s))
    throw new RangeError('Twist redistribution needs a finite positive uniform parent scale');
  const direction = local.subarray(bone, bone + 3),
    size = length(direction);
  if (!(size > 1e-9 && Number.isFinite(size)))
    throw new RangeError('Twist redistribution needs a nonzero child offset');
  const axis = normalize(direction),
    qNeutral = unitJointRotation(neutral, 'Neutral rotation'),
    qParent = unitJointRotation(local.subarray(upstream + 3, upstream + 7), 'Parent rotation'),
    qChild = unitJointRotation(local.subarray(bone + 3, bone + 7), 'Child rotation'),
    invNeutral = conjugateQuaternion(qNeutral),
    delta = multiplyQuaternions(invNeutral, qChild),
    axisInChild = rotateByQuaternion(axis, invNeutral),
    axial = dot(delta, axisInChild),
    // At a pure 180-degree swing the twist is indeterminate. Keep that component unchanged.
    angle = Math.hypot(axial, delta[3]) < 1e-9 ? 0 : 2 * Math.atan2(axial, delta[3]),
    twist = Math.atan2(Math.sin(angle), Math.cos(angle)),
    transfer = twist - Math.max(min, Math.min(max, twist));
  if (Math.abs(transfer) <= 1e-12) return 0;
  const turn = axisAngleToQuaternion(axis, transfer);
  local.set(normalizeQuaternion(multiplyQuaternions(qParent, turn)), upstream + 3);
  local.set(normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(turn), qChild)), bone + 3);
  return transfer;
}
