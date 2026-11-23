import { type CCDJointLimit, CCDSolver } from '@margoengine/animator/ccd';
import type { Vec3 } from '@margoengine/math';
import { interpolateQuaternions, normalizeQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { add, length, scale, sub } from '@margoengine/math/vec3';
import type { IKPose } from './ik.js';
import { parentOrder, worldFrames } from './rig.js';

type Quaternion = readonly [number, number, number, number];

/** Anatomical limit at one joint, calibrated in the same local axes as the pose. */
export interface ContactJointLimit {
  /** Bone index in the skeleton. The bone must belong to the contact chain. */
  readonly joint: number;
  /** The joint's local neutral rotation, [x, y, z, w], from which the limit is measured. */
  readonly neutral: Quaternion;
  /** A hinge, swing-twist cone or per-axis range, in radians, around the neutral rotation. */
  readonly limit: CCDJointLimit;
}

/** A palm, fingertip, sole or hoof landmark pinned to a point and an orientation in skeleton space. */
export interface ContactIKOptions {
  /** Contiguous joint indices from the first joint through the wrist, ankle or other end joint. */
  readonly joints: readonly number[];
  /** Point on the surface in skeleton space. */
  readonly point: Vec3;
  /** Target end-joint rotation in skeleton space, [x, y, z, w]. */
  readonly rotation: Quaternion;
  /** Landmark in the end joint's local coordinates, before the end joint's scale. */
  readonly anchor: Vec3;
  /** Blend toward the contact, default 1. Zero preserves the input pose exactly. */
  readonly weight?: number;
  /** Anatomical limits for the joints to constrain. Omitted joints are free. */
  readonly limits?: readonly ContactJointLimit[];
  /** Point on the desired elbow or knee bend side in skeleton space. */
  readonly pole?: Vec3 | null;
  /** Maximum CCD sweeps, from 1 to 1,024. Default 64. */
  readonly iterations?: number;
  /** Maximum positional error to accept for contact, in scene units. Default 0.0001. */
  readonly tolerance?: number;
  /** Maximum angular error to accept for contact, in radians. Default 0.02. */
  readonly angleTolerance?: number;
}

/** What the posed landmark achieved. Use `locked` to start a grasp or foot plant. */
export interface ContactIKResult {
  /** True when the posed landmark is within the position and orientation tolerances of the requested contact. */
  readonly locked: boolean;
  /** Gap between the posed landmark and the requested contact point. */
  readonly distance: number;
  /** Shortest angular distance from the posed end joint to the requested rotation, in radians. */
  readonly angle: number;
  /** The measured point on the final pose, in skeleton space. */
  readonly point: Vec3;
}

function unitRotation(q: Quaternion, label: string): [number, number, number, number] {
  if (!(q?.length === 4 && q.every(Number.isFinite) && Math.hypot(...q) > 0))
    throw new RangeError(`Contact IK ${label} needs a finite, nonzero quaternion`);
  return normalizeQuaternion(q);
}

/**
 * Solves at a physical point on the limb. The CCD solver applies joint limits throughout the solve, so reaching for
 * the contact cannot force a wrist to twist or an elbow to bend backwards past its calibrated range. Each segment
 * keeps its length. Contact is measured on the resulting pose, including when the point or orientation is unreachable.
 * @throws RangeError for invalid chain data, scales, limits, contact weights, landmarks, rotations or tolerances.
 * @throws TypeError for a malformed pose or chain.
 */
export function solveContactIK(pose: IKPose, options: ContactIKOptions): ContactIKResult {
  const { parents, local } = pose;
  const { joints, point, anchor, rotation, pole, limits = [] } = options;
  const { weight = 1, iterations = 64, tolerance = 1e-4, angleTolerance = 0.02 } = options;
  if (!Array.isArray(parents) || !(local instanceof Float64Array) || local.length !== parents.length * 10)
    throw new TypeError('Contact IK needs a pose with parents and 10 local values per joint');
  if (!Array.isArray(joints) || joints.length < 2 || joints.length > 256)
    throw new TypeError('Contact IK needs a chain of 2 to 256 joints');
  if (
    !joints.every(
      (joint, i) =>
        Number.isInteger(joint) &&
        joint >= 0 &&
        joint < parents.length &&
        (i === 0 || parents[joint] === joints[i - 1]),
    )
  )
    throw new RangeError('Contact IK joints must form a parent-child chain');
  if (parents.some((p) => !Number.isInteger(p) || p < -1 || p >= parents.length))
    throw new RangeError('Contact IK parents must be valid joint indices or -1');
  if (!(point?.length === 3 && anchor?.length === 3 && [...point, ...anchor].every(Number.isFinite)))
    throw new RangeError('Contact IK point and anchor need three finite coordinates each');
  if (
    !(
      weight >= 0 &&
      weight <= 1 &&
      tolerance > 0 &&
      Number.isFinite(tolerance) &&
      angleTolerance > 0 &&
      angleTolerance <= Math.PI &&
      Number.isInteger(iterations) &&
      iterations >= 1 &&
      iterations <= 1024
    )
  )
    throw new RangeError('Contact IK weight, tolerance or iteration count is out of range; use the supported ranges');

  const order = parentOrder(parents, 'Contact IK'),
    end = joints.at(-1)!,
    endAt = end * 10,
    requested = unitRotation(rotation, 'rotation'),
    base = parents[joints[0]],
    tip: Vec3 = [anchor[0] * local[endAt + 7], anchor[1] * local[endAt + 8], anchor[2] * local[endAt + 9]];
  let inheritedScale = 1,
    baseScale = 1;
  for (let joint = parents[end]; joint >= 0; joint = parents[joint]) {
    const at = joint * 10,
      s = local[at + 7];
    if (!(s > 0 && Number.isFinite(s) && local[at + 8] === s && local[at + 9] === s))
      throw new RangeError('Contact IK needs uniform positive ancestor scales; apply scale to the mesh before rigging');
    inheritedScale *= s;
  }
  for (let joint = base; joint >= 0; joint = parents[joint]) baseScale *= local[joint * 10 + 7];
  if (
    !(
      Number.isFinite(inheritedScale) &&
      inheritedScale > 0 &&
      tip.every(Number.isFinite) &&
      local.subarray(endAt + 7, endAt + 10).every((s) => s > 0 && Number.isFinite(s))
    )
  )
    throw new RangeError('Contact IK needs finite positive scales');

  const offset = scale(tip, inheritedScale),
    before = worldFrames(parents, local, order),
    animatedRotation = before.rotation.subarray(end * 4, end * 4 + 4),
    animatedPoint = add(before.position.subarray(end * 3, end * 3 + 3), rotateByQuaternion(offset, animatedRotation));
  if (weight === 0) return measure(animatedPoint, animatedRotation, point, requested, tolerance, angleTolerance);

  const solver = new CCDSolver(
    joints.map((joint): Vec3 => {
      const at = joint * 10;
      return [local[at], local[at + 1], local[at + 2]];
    }),
  );
  solver.iterations = iterations;
  solver.tolerance = tolerance;
  solver.angleTolerance = angleTolerance;
  if (base >= 0) {
    solver.parentPosition.set(before.position.subarray(base * 3, base * 3 + 3));
    solver.parentRotation.set(before.rotation.subarray(base * 4, base * 4 + 4));
    solver.parentScale[0] = baseScale;
  }
  joints.forEach((joint, slot) => {
    const at = joint * 10;
    solver.rotations.set(local.subarray(at + 3, at + 7), slot * 4);
    if (joint !== end) solver.scales[slot] = local[at + 7];
  });
  const constrained = new Set<number>();
  for (const { joint, neutral, limit } of limits) {
    const slot = joints.indexOf(joint);
    if (slot < 0 || constrained.has(joint))
      throw new RangeError('Contact IK limits must name distinct joints in the chain');
    constrained.add(joint);
    solver.rest.set(unitRotation(neutral, 'neutral rotation'), slot * 4);
    solver.setLimit(slot, limit);
  }
  const goal = interpolateQuaternions(animatedRotation, requested, weight, 0.9995);
  const blendedPoint = add(animatedPoint, scale(sub(point, animatedPoint), weight));
  // With a nonzero CCD tip, the final joint can trade swing for position. Aim the joint origin so the surface
  // position and orientation describe the same rigid frame, then measure the landmark with its solved rotation.
  solver.solve(sub(blendedPoint, rotateByQuaternion(offset, goal)), goal, pole);
  joints.forEach((joint, slot) => local.set(solver.rotations.subarray(slot * 4, slot * 4 + 4), joint * 10 + 3));
  const endSlot = joints.length - 1,
    actualRotation = solver.worldRotations.subarray(endSlot * 4, endSlot * 4 + 4),
    actualPoint = add(
      solver.positions.subarray(endSlot * 3, endSlot * 3 + 3),
      rotateByQuaternion(offset, actualRotation),
    );
  return measure(actualPoint, actualRotation, point, requested, tolerance, angleTolerance);
}

function measure(
  actual: Vec3,
  rotation: ArrayLike<number>,
  point: Vec3,
  requested: Quaternion,
  tolerance: number,
  angleTolerance: number,
): ContactIKResult {
  const distance = length(sub(actual, point));
  const alignment =
    rotation[0] * requested[0] + rotation[1] * requested[1] + rotation[2] * requested[2] + rotation[3] * requested[3];
  const angle = 2 * Math.acos(Math.min(1, Math.abs(alignment)));
  return { locked: distance <= tolerance && angle <= angleTolerance, distance, angle, point: actual };
}
