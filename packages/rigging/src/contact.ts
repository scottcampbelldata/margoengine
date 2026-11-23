import type { Animator } from '@margoengine/animator';
import { type CCDJointLimit, CCDSolver } from '@margoengine/animator/ccd';
import type { Vec3 } from '@margoengine/math';
import {
  conjugateQuaternion,
  interpolateQuaternions,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import { add, cross, dot, length, normalize, scale, sub } from '@margoengine/math/vec3';
import {
  grip,
  type HandRig,
  handRotations,
  type HandSide,
  type MeasuredHand,
  measureHands,
  poseTable,
  relaxed,
} from './hands.js';
import type { IKPose } from './ik.js';
import type { HumanoidBone, SkeletonPreset } from './retarget.js';
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

/** Per-character calibration for reaching, planting and gripping with one hand. */
export interface PalmContactCalibration {
  /** The authored side of the skeleton. */
  readonly side: HandSide;
  /** Contiguous arm chain ending at the mapped wrist. Include twist or shoulder helpers that can move. */
  readonly joints: readonly number[];
  /** Override the detected skeleton naming, or provide a map for a custom skeleton. */
  readonly preset?: SkeletonPreset;
  /** Names to indices for custom rigs, including the wrist and measured finger bones. */
  readonly bones?: ReadonlyMap<HumanoidBone, number>;
  /** Calibrated arm limits. An explicit wrist entry overrides the inferred wrist limit. */
  readonly limits?: readonly ContactJointLimit[];
  /** Optional elbow hinge and forearm roll calibrated relative to the imported rest pose. */
  readonly elbow?: PalmElbowCalibration;
  /** Exact skin contact point in wrist-local coordinates. Default uses the measured palm centre and pad depth. */
  readonly anchor?: Vec3;
  /** Maximum palm gap in skeleton units for grip engagement. Default 0.003. */
  readonly tolerance?: number;
  /** Maximum palm angle error in radians for grip engagement. Default 0.0873 (five degrees). */
  readonly angleTolerance?: number;
}

/** Calibrates the positive side of an elbow joint's flexion in skeleton space at rest. */
export interface PalmElbowCalibration {
  /** An intermediate joint of the arm chain. */
  readonly joint: number;
  /** Direction in which the forearm bends in flexion, relative to the bind pose. */
  readonly flexDirection: Vec3;
  /** Minimum angle in radians from the bind pose. Default −0.035. */
  readonly min?: number;
  /** Maximum angle in radians from the bind pose. Default 2.55. */
  readonly max?: number;
  /** Signed forearm roll in radians, default [−1.25, 1.25]. Pass false when a separate calibrated twist joint drives roll. */
  readonly roll?: readonly [number, number] | false;
}

/** A palm target with geometric orientation and a cylindrical grip. Positions and directions use skeleton space. */
export interface PalmContactTarget {
  /** Actual surface point where the palm pad lands. */
  readonly point: Vec3;
  /** Outward normal of the surface, pointing toward the approaching hand. */
  readonly normal: Vec3;
  /** Direction from wrist to fingers along the surface. Projected onto the normal plane. */
  readonly towardsFingers: Vec3;
  /** Diameter of the grip in skeleton units. */
  readonly diameter: number;
  /** Requested finger closure 0–1, default 1. Contact confidence may reduce this. */
  readonly close?: number;
  /** Reach weight 0–1, default 1. Zero leaves the current pose intact. */
  readonly weight?: number;
  /** A point toward which the elbow bends, in skeleton space. */
  readonly elbowPole?: Vec3;
}

/** Measured palm registration and the applied finger closure for one sample. */
export interface PalmContactResult extends ContactIKResult {
  /** Final weight of the cylindrical finger pose, from zero to one. */
  readonly gripWeight: number;
}

function palmFrame(forward: Vec3, normal: Vec3): Quaternion {
  const n = normalize(normal),
    tangent = normalize(sub(forward, scale(n, dot(forward, n))));
  if (length(n) < 0.9 || length(tangent) < 0.9 || length(cross(normalize(forward), n)) < 1e-5)
    throw new RangeError('Palm orientation needs a nonzero normal and a finger direction across that normal');
  return normalizeQuaternion(rotationToQuaternion([...tangent, ...n, ...cross(tangent, n)]));
}

function finiteVector(v: Vec3, label: string): void {
  if (v?.length !== 3 || !v.every(Number.isFinite)) throw new RangeError(`${label} needs three finite coordinates`);
}

function restRotation(rig: HandRig, joint: number): Quaternion {
  const at = joint * 10 + 3;
  return unitRotation([rig.rest[at], rig.rest[at + 1], rig.rest[at + 2], rig.rest[at + 3]], 'local rest rotation');
}

function elbowLimit(
  rig: HandRig,
  hand: MeasuredHand,
  chain: readonly number[],
  elbow: PalmElbowCalibration,
): ContactJointLimit {
  const { joint, flexDirection, min = -0.035, max = 2.55, roll = [-1.25, 1.25] } = elbow,
    slot = chain.indexOf(joint);
  if (slot <= 0 || slot >= chain.length - 1)
    throw new RangeError('Elbow calibration needs an intermediate joint of the arm chain');
  finiteVector(flexDirection, 'Elbow flexion direction');
  const frame = hand.world(joint),
    along = normalize(sub(hand.world(hand.hand).position, frame.position)),
    axis = cross(along, normalize(flexDirection)),
    inverse = conjugateQuaternion(frame.rotation);
  if (length(axis) < 1e-5) throw new RangeError('Elbow flexion needs a direction across the forearm');
  return {
    joint,
    neutral: restRotation(rig, joint),
    limit: {
      type: 'hinge',
      axis: rotateByQuaternion(normalize(axis), inverse),
      min,
      max,
      twist: roll === false ? undefined : { axis: rotateByQuaternion(along, inverse), range: roll },
    },
  };
}

/**
 * Maps a real surface frame to a measured wrist and finger rig. The arm solver respects its authored joint limits.
 * Finger closure is computed from the achieved palm pose and eases to zero at the contact boundary. The solver is
 * independent of playback history, so contact can be baked, played forward or evaluated out of order.
 */
export class PalmContactRig {
  private readonly hand: MeasuredHand;
  private readonly inversePalm: Quaternion;
  private readonly arm: readonly number[];
  private readonly limits: readonly ContactJointLimit[];
  private readonly tolerance: number;
  private readonly angleTolerance: number;
  private readonly open: Map<number, number[]>;
  private closed?: { diameter: number; rotations: Map<number, number[]> };
  /** Calibrated surface point in the wrist's local coordinates. */
  readonly anchor: Vec3;
  /** Arm and finger joints which this solve can rotate. */
  readonly joints: readonly number[];

  /** Prepares one calibrated contact rig from its rest skeleton. */
  constructor(
    private readonly rig: HandRig,
    calibration: PalmContactCalibration,
  ) {
    const { side, preset, bones, joints, limits = [], anchor, elbow } = calibration;
    if (side !== 'left' && side !== 'right') throw new RangeError('Choose left or right for the palm calibration');
    // Validate the tree before walking the rest landmarks.
    if (rig.parents.some((p) => !Number.isInteger(p) || p < -1 || p >= rig.parents.length))
      throw new RangeError('Palm calibration needs parents with valid joint indices or −1');
    const order = parentOrder(rig.parents, 'Palm calibration');
    const hand = measureHands(rig, preset, bones)[side],
      middle = hand?.fingers.middle?.bones[0];
    if (!hand || middle === undefined)
      throw new RangeError('Palm calibration needs an index, middle and outer finger mapped on the requested hand');
    if (
      !Array.isArray(joints) ||
      joints.length < 2 ||
      joints.length > 256 ||
      joints.at(-1) !== hand.hand ||
      !joints.every(
        (j, i) => Number.isInteger(j) && j >= 0 && j < rig.parents.length && (!i || rig.parents[j] === joints[i - 1]),
      )
    )
      throw new RangeError('Palm calibration needs a consecutive 2–256 joint arm ending at the mapped wrist');
    const wrist = hand.world(hand.hand),
      inv = conjugateQuaternion(unitRotation(wrist.rotation as Quaternion, 'wrist rest rotation')),
      forward = rotateByQuaternion(sub(hand.world(middle).position, wrist.position), inv),
      normal = rotateByQuaternion(hand.palm, inv),
      pad = scale(normal, length(forward) * 0.085);
    this.inversePalm = conjugateQuaternion(palmFrame(forward, normal));
    const frame = worldFrames(rig.parents, rig.rest, order).linear,
      basis = hand.hand * 9;
    const local = add(scale(forward, 0.56), pad).map((n, axis) => {
      const offset = basis + axis * 3;
      return n / Math.hypot(frame[offset], frame[offset + 1], frame[offset + 2]);
    }) as [number, number, number];
    this.anchor = anchor ? [...anchor] : local;
    finiteVector(this.anchor, 'Palm anchor');
    this.hand = hand;
    this.arm = [...joints];
    const calibrated = [...limits];
    if (elbow && !calibrated.some(({ joint }) => joint === elbow.joint))
      calibrated.push(elbowLimit(rig, hand, joints, elbow));
    if (!calibrated.some(({ joint }) => joint === hand.hand))
      calibrated.push({
        joint: hand.hand,
        neutral: restRotation(rig, hand.hand),
        limit: { type: 'cone', axis: normalize(forward), angle: 1.15, twist: [-0.22, 0.22] },
      });
    this.limits = calibrated;
    this.tolerance = calibration.tolerance ?? 0.003;
    this.angleTolerance = calibration.angleTolerance ?? Math.PI / 36;
    if (
      !(
        this.tolerance > 0 &&
        Number.isFinite(this.tolerance) &&
        this.angleTolerance > 0 &&
        this.angleTolerance <= Math.PI
      )
    )
      throw new RangeError('Palm tolerances need a finite positive distance and an angle between zero and π');
    this.open = handRotations(hand, poseTable(relaxed(), hand));
    for (const [bone, q] of hand.rest) if (!this.open.has(bone)) this.open.set(bone, [...q]);
    this.joints = [...this.arm, ...this.open.keys()];
  }

  /** Rotates the arm and fingers for one surface sample, leaving all other local transforms intact. */
  solve(local: Float64Array, target: PalmContactTarget): PalmContactResult {
    const { point, normal, towardsFingers, diameter, close = 1, weight = 1, elbowPole } = target;
    finiteVector(normal, 'Surface normal');
    finiteVector(towardsFingers, 'Direction toward fingers');
    if (elbowPole) finiteVector(elbowPole, 'Elbow pole');
    if (!(close >= 0 && close <= 1 && weight >= 0 && weight <= 1))
      throw new RangeError('Hand closure and reach weight must be from zero to one');
    if (this.closed?.diameter !== diameter)
      this.closed = { diameter, rotations: handRotations(this.hand, poseTable(grip(diameter), this.hand)) };
    const orientation = normalizeQuaternion(
      multiplyQuaternions(palmFrame(towardsFingers, scale(normal, -1)), this.inversePalm),
    );
    const result = solveContactIK(
      { parents: this.rig.parents, local },
      {
        joints: this.arm,
        point,
        anchor: this.anchor,
        rotation: orientation,
        weight,
        pole: elbowPole,
        limits: this.limits,
        // Solve tighter than the acceptance region so a reachable wrist can enter its full-grip centre.
        tolerance: this.tolerance * 0.05,
        angleTolerance: this.angleTolerance * 0.05,
      },
    );
    const error = Math.max(result.distance / this.tolerance, result.angle / this.angleTolerance),
      confidence = Math.max(0, 1 - error),
      gripWeight = weight === 0 ? 0 : close * confidence * confidence * (3 - 2 * confidence);
    if (weight > 0) {
      for (const [bone, open] of this.open) {
        const goal = interpolateQuaternions(open, this.closed.rotations.get(bone) ?? open, gripWeight, 0.9995);
        local.set(goal, bone * 10 + 3);
      }
    }
    return { ...result, locked: error <= 1, gripWeight };
  }
}

/**
 * Runs calibrated palm contact after the Animator's pose and other solvers. Supply the current target in model
 * space or return undefined to release the procedural layer. Returns a function that removes the solver.
 */
export function addPalmContact(
  animator: Animator,
  calibration: PalmContactCalibration,
  target: () => PalmContactTarget | undefined,
  onSolve?: (result: PalmContactResult) => void,
): () => void {
  const model = animator.animation.model,
    nodes = model.nodes,
    store = model.root.engine.store,
    index = new Map(nodes.map((node, i) => [node.id, i])),
    parents = nodes.map((node) => index.get(store.parents[node.id]) ?? -1),
    rest = new Float64Array(nodes.length * 10);
  nodes.forEach((_, i) => {
    rest.set(animator.restPosition(i), i * 10);
    rest.set(animator.restRotation(i), i * 10 + 3);
    rest.set(animator.restScale(i), i * 10 + 7);
  });
  const hand = new PalmContactRig({ names: nodes.map((node) => node.name ?? ''), parents, rest }, calibration),
    local = new Float64Array(rest.length),
    rotation = [0, 0, 0, 1];
  return animator.addSolver(() => {
    const contact = target();
    if (!contact) return;
    const t = store.transforms;
    nodes.forEach(({ id }, i) => {
      const at = i * 10;
      local[at] = t.x[id];
      local[at + 1] = t.y[id];
      local[at + 2] = t.z[id];
      local[at + 3] = t.qx[id];
      local[at + 4] = t.qy[id];
      local[at + 5] = t.qz[id];
      local[at + 6] = t.qw[id];
      local[at + 7] = t.sx[id];
      local[at + 8] = t.sy[id];
      local[at + 9] = t.sz[id];
    });
    const result = hand.solve(local, contact);
    for (const i of hand.joints) {
      for (let k = 0; k < 4; k++) rotation[k] = local[i * 10 + 3 + k];
      animator.writeNodeRotation(nodes[i], rotation);
    }
    store.tick(false);
    onSolve?.(result);
  });
}
