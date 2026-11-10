import {
  conjugateQuaternion,
  interpolateQuaternions,
  multiplyQuaternions,
  normalizeQuaternion,
  rotationToQuaternion,
  rotateByQuaternion,
} from '@margoengine/math/quat';
import { MargoError } from '@margoengine/math/errors';
import type { Animation } from '@margoengine/animation';
import type { VRMAvatar, VRMHandle } from './vrm.js';
import { HUMANOID_BONES, type HumanoidBone } from './retarget.js';
import { rotationBetween } from './ik.js';

/** MediaPipe world or normalized landmark, with optional confidence. */
export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}
/** One body and up to two hands; legacy Holistic field names, with world body landmarks preferred. */
export interface PoseTrackingFrame {
  poseWorldLandmarks?: readonly PoseLandmark[];
  poseLandmarks?: readonly PoseLandmark[];
  leftHandWorldLandmarks?: readonly PoseLandmark[];
  rightHandWorldLandmarks?: readonly PoseLandmark[];
  leftHandLandmarks?: readonly PoseLandmark[];
  rightHandLandmarks?: readonly PoseLandmark[];
}
/** Structural MediaPipe Tasks results; no MediaPipe package is imported by this entry. */
export interface PoseTrackingResults {
  pose?: { worldLandmarks?: readonly (readonly PoseLandmark[])[]; landmarks?: readonly (readonly PoseLandmark[])[] };
  hands?: {
    worldLandmarks?: readonly (readonly PoseLandmark[])[];
    landmarks?: readonly (readonly PoseLandmark[])[];
    handedness?: readonly (readonly { categoryName: string; score: number }[])[];
  };
}
/** Adapt the first detected body and the highest-confidence hand of each side from MediaPipe Tasks. */
export function readPoseTrackingFrame(results: PoseTrackingResults): PoseTrackingFrame {
  if (!results || typeof results !== 'object')
    throw new TypeError('Tracking results must hold pose or hands Tasks results');
  const frame: PoseTrackingFrame = {
    poseWorldLandmarks: results.pose?.worldLandmarks?.[0],
    poseLandmarks: results.pose?.landmarks?.[0],
  };
  const hands = results.hands,
    selected = { left: -1, right: -1 };
  for (let i = 0; i < (hands?.handedness?.length ?? 0); i++) {
    const category = hands!.handedness![i][0],
      label = category?.categoryName?.toLowerCase();
    if (
      !category ||
      !Number.isFinite(category.score) ||
      category.score < 0 ||
      category.score > 1 ||
      (label !== 'left' && label !== 'right')
    )
      throw new RangeError('Hand results must provide Left or Right handedness and a confidence in [0,1]');
    const world = hands?.worldLandmarks?.[i],
      points = world ?? hands?.landmarks?.[i];
    if (points && category.score > selected[label]) {
      selected[label] = category.score;
      const field = world
        ? label === 'left'
          ? 'leftHandWorldLandmarks'
          : 'rightHandWorldLandmarks'
        : label === 'left'
          ? 'leftHandLandmarks'
          : 'rightHandLandmarks';
      frame[field] = points.map((point) => ({
        ...point,
        presence: Math.min(point.presence ?? 1, category.score),
      }));
    }
  }
  return frame;
}
/** Coordinate conversion and confidence. Defaults: MediaPipe coordinates, unmirrored, minimum confidence 0.5. */
export interface PoseSolveOptions {
  coordinateSpace?: 'mediapipe' | 'margo';
  mirror?: boolean;
  minConfidence?: number;
  /** Image width / height for normalized landmarks (default 1); x and z are scaled to image-height units. */
  aspect?: number;
  /** Disable the leg/foot outputs, useful for seated capture (default false). */
  upperBodyOnly?: boolean;
}
/** XYZW unit quaternion. */
export type PoseQuaternion = readonly [number, number, number, number];
/** A normalized humanoid pose: local rotations plus model-space orientations and per-bone confidence. */
export interface TrackedPose {
  readonly rotations: Partial<Record<HumanoidBone, PoseQuaternion>>;
  readonly worldRotations: Partial<Record<HumanoidBone, PoseQuaternion>>;
  /** Hips centre in input world units, converted to Margo coordinates; root-centred input remains root-centred. */
  readonly position: readonly [number, number, number] | null;
  readonly confidence: Partial<Record<HumanoidBone, number>>;
}
type V = [number, number, number];
type Q = [number, number, number, number];
const ID: Q = [0, 0, 0, 1];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V | null => {
  const length = Math.hypot(...a);
  return length > 1e-8 ? mul(a, 1 / length) : null;
};
const direction = (a: V): V | null => {
  const length = Math.hypot(...a);
  return length > 0 && Number.isFinite(length) ? mul(a, 1 / length) : null;
};
const midpoint = (a: V, b: V): V => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
// Orthogonalize two observed directions. Collinear input is unobservable, never a fabricated identity rotation.
function basis(xInput: V, yInput: V): Q | null {
  const x = direction(xInput),
    reference = direction(yInput);
  if (!x || !reference) return null;
  const y = unit(sub(reference, mul(x, dot(x, reference))));
  if (!y) return null;
  return normalizeQuaternion(rotationToQuaternion([...x, ...y, ...cross(x, y)]));
}
const parents: Partial<Record<HumanoidBone, HumanoidBone>> = {
  spine: 'hips',
  chest: 'spine',
  upperChest: 'chest',
  neck: 'upperChest',
  head: 'neck',
  jaw: 'head',
};
for (const side of ['left', 'right'] as const) {
  Object.assign(parents, {
    [`${side}Shoulder`]: 'upperChest',
    [`${side}UpperArm`]: `${side}Shoulder`,
    [`${side}LowerArm`]: `${side}UpperArm`,
    [`${side}Hand`]: `${side}LowerArm`,
    [`${side}UpperLeg`]: 'hips',
    [`${side}LowerLeg`]: `${side}UpperLeg`,
    [`${side}Foot`]: `${side}LowerLeg`,
    [`${side}Toes`]: `${side}Foot`,
  });
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    const joints = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    joints.forEach((joint, i) => {
      parents[`${side}${finger}${joint}` as HumanoidBone] = (
        i ? `${side}${finger}${joints[i - 1]}` : `${side}Hand`
      ) as HumanoidBone;
    });
  }
}
function localize(
  worldRotations: TrackedPose['worldRotations'],
  confidence: TrackedPose['confidence'],
  position: V | null = null,
): TrackedPose {
  const rotations: TrackedPose['rotations'] = {};
  for (const bone of HUMANOID_BONES) {
    const q = worldRotations[bone];
    if (!q) continue;
    let parent = parents[bone];
    while (parent && !worldRotations[parent]) parent = parents[parent];
    rotations[bone] = parent ? multiplyQuaternions(conjugateQuaternion(worldRotations[parent]!), q) : [...q];
  }
  return { rotations, worldRotations, position, confidence };
}
function optionsOf(options: PoseSolveOptions) {
  const threshold = options.minConfidence ?? 0.5,
    aspect = options.aspect ?? 1,
    space = options.coordinateSpace ?? 'mediapipe';
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1 ||
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    !['mediapipe', 'margo'].includes(space)
  )
    throw new RangeError(
      'Pose options must use confidence in [0,1], a positive aspect and mediapipe or margo coordinateSpace',
    );
  return { threshold, aspect, space, mirror: options.mirror ?? false };
}
function landmarks(
  input: readonly PoseLandmark[],
  count: number,
  options: PoseSolveOptions,
): { points: V[]; scores: number[]; threshold: number } {
  const { threshold, aspect, space, mirror } = optionsOf(options);
  if (!Array.isArray(input) || input.length !== count)
    throw new TypeError(`Pose landmarks must contain ${count} {x,y,z} points`);
  const points: V[] = [],
    scores: number[] = [];
  for (const p of input) {
    if (
      !p ||
      ![p.x, p.y, p.z].every(Number.isFinite) ||
      [p.visibility, p.presence].some((n) => n !== undefined && (!Number.isFinite(n) || n < 0 || n > 1))
    )
      throw new RangeError('Pose landmarks must have finite coordinates and confidence from 0 to 1');
    points.push([
      p.x * aspect * (mirror ? -1 : 1),
      p.y * (space === 'mediapipe' ? -1 : 1),
      p.z * aspect * (space === 'mediapipe' ? -1 : 1),
    ]);
    scores.push(Math.min(p.visibility ?? 1, p.presence ?? 1));
  }
  return { points, scores, threshold };
}
/** Solve MediaPipe's 33 body landmarks into hips, spine, head, arms, wrists, legs and feet. */
export function solveBodyPose(input: readonly PoseLandmark[], options: PoseSolveOptions = {}): TrackedPose {
  const { points: p, scores, threshold } = landmarks(input, 33, options);
  if (options.mirror)
    for (const [a, b] of [
      [1, 4],
      [2, 5],
      [3, 6],
      [7, 8],
      [9, 10],
      [11, 12],
      [13, 14],
      [15, 16],
      [17, 18],
      [19, 20],
      [21, 22],
      [23, 24],
      [25, 26],
      [27, 28],
      [29, 30],
      [31, 32],
    ]) {
      [p[a], p[b]] = [p[b], p[a]];
      [scores[a], scores[b]] = [scores[b], scores[a]];
    }
  const world: TrackedPose['worldRotations'] = {},
    confidence: TrackedPose['confidence'] = {};
  const put = (bone: HumanoidBone, q: Q | null, ids: number[]) => {
    const score = Math.min(...ids.map((i) => scores[i]));
    if (q && score >= threshold) {
      world[bone] = q;
      confidence[bone] = score;
    }
  };
  const hips = midpoint(p[23], p[24]),
    shoulders = midpoint(p[11], p[12]),
    up = sub(shoulders, hips),
    hipX = sub(p[23], p[24]),
    shoulderX = sub(p[11], p[12]);
  put('hips', basis(hipX, up), [23, 24, 11, 12]);
  const chest = basis(shoulderX, up);
  for (const name of ['spine', 'chest', 'upperChest', 'neck'] as const) put(name, chest, [11, 12, 23, 24]);
  put('head', basis(sub(p[7], p[8]), cross(sub(p[0], midpoint(p[7], p[8])), sub(p[7], p[8]))), [0, 7, 8]);
  for (const [side, sign, a] of [
    ['left', 1, 0],
    ['right', -1, 1],
  ] as const) {
    const upper = sub(p[13 + a], p[11 + a]),
      lower = sub(p[15 + a], p[13 + a]);
    const upperDirection = direction(upper),
      lowerDirection = direction(lower),
      bend =
        upperDirection && lowerDirection
          ? unit(sub(lowerDirection, mul(upperDirection, dot(lowerDirection, upperDirection))))
          : null;
    const yHint = bend ? cross(bend, mul(upper, sign)) : up;
    // Transport the torso frame by the shortest swing when the straight arm has no observable bend plane.
    const arm = (segment: V) => {
      const x = mul(segment, sign);
      if (!unit(x) || !unit(shoulderX)) return null;
      return basis(x, bend ? yHint : rotateByQuaternion(up, rotationBetween(shoulderX, x)));
    };
    put(`${side}Shoulder`, chest, [11, 12, 23, 24]);
    put(`${side}UpperArm`, arm(upper), [11 + a, 13 + a, 15 + a]);
    put(`${side}LowerArm`, arm(lower), [11 + a, 13 + a, 15 + a]);
    const handX = mul(sub(midpoint(p[17 + a], p[19 + a]), p[15 + a]), sign),
      handZ = sub(p[19 + a], p[17 + a]);
    put(`${side}Hand`, basis(handX, cross(handZ, handX)), [15 + a, 17 + a, 19 + a]);
    if (!options.upperBodyOnly) {
      const thigh = sub(p[25 + a], p[23 + a]),
        shin = sub(p[27 + a], p[25 + a]);
      const leg = (segment: V) => {
        const y = unit(mul(segment, -1));
        if (!y) return null;
        const x = unit(sub(hipX, mul(y, dot(hipX, y))));
        if (x) return basis(x, y);
        if (!unit(up) || !unit(hipX)) return null;
        return basis(rotateByQuaternion(hipX, rotationBetween(up, y)), y);
      };
      put(`${side}UpperLeg`, leg(thigh), [23, 24, 25 + a]);
      put(`${side}LowerLeg`, leg(shin), [23, 24, 25 + a, 27 + a]);
      const z = unit(sub(p[31 + a], p[29 + a]));
      const x = z ? unit(sub(hipX, mul(z, dot(hipX, z)))) : null;
      put(`${side}Foot`, x && z ? basis(x, cross(z, x)) : null, [23, 24, 29 + a, 31 + a]);
    }
  }
  return localize(world, confidence, world.hips ? hips : null);
}
/** Solve 21 MediaPipe hand landmarks into wrist and all fifteen finger joints, including thumb metacarpal. */
export function solveHandPose(
  input: readonly PoseLandmark[],
  handedness: 'left' | 'right',
  options: PoseSolveOptions = {},
): TrackedPose {
  if (handedness !== 'left' && handedness !== 'right') throw new RangeError('Handedness must be left or right');
  const { points: p, scores, threshold } = landmarks(input, 21, options),
    side = options.mirror ? (handedness === 'left' ? 'right' : 'left') : handedness,
    sign = side === 'left' ? 1 : -1;
  const world: TrackedPose['worldRotations'] = {},
    confidence: TrackedPose['confidence'] = {};
  const x = mul(sub(p[9], p[0]), sign),
    z = sub(p[5], p[17]),
    y = cross(z, x),
    palm = basis(x, y);
  const palmZ = palm ? rotateByQuaternion([0, 0, 1], palm) : ([0, 0, 0] as V);
  const palmY = palm ? rotateByQuaternion([0, 1, 0], palm) : ([0, 0, 0] as V);
  const put = (bone: HumanoidBone, q: Q | null, ids: number[]) => {
    const score = Math.min(...ids.map((i) => scores[i]));
    if (q && score >= threshold) {
      world[bone] = q;
      confidence[bone] = score;
    }
  };
  put(`${side}Hand`, palm, [0, 5, 9, 17]);
  for (const [finger, start] of [
    ['Thumb', 1],
    ['Index', 5],
    ['Middle', 9],
    ['Ring', 13],
    ['Little', 17],
  ] as const) {
    const joints = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    for (let j = 0; j < 3; j++) {
      const direction = mul(sub(p[start + j + 1], p[start + j]), sign);
      put(
        `${side}${finger}${joints[j]}` as HumanoidBone,
        basis(direction, cross(palmZ, direction)) ?? basis(direction, palmY),
        [0, 5, 17, start + j, start + j + 1],
      );
    }
  }
  return localize(world, confidence);
}
/** Smoothing and lost-input policy. Defaults: 0.05 second smoothing, 0.2 second hold then fade to neutral. */
export interface PoseTrackerOptions extends PoseSolveOptions {
  smoothing?: number;
  hold?: number;
}
/** Stateful body/hand solver with calibration, confidence gating, smoothing and loss recovery. No inference dependency. */
export class PoseTracker {
  private goal: TrackedPose = localize({}, {});
  private readonly current: TrackedPose['worldRotations'] = {};
  private readonly ages = new Map<HumanoidBone, number>();
  private calibration: TrackedPose['worldRotations'] = {};
  private origin: V = [0, 0, 0];
  private translation: V = [0, 0, 0];
  private hasPosition = false;
  readonly smoothing: number;
  readonly hold: number;
  constructor(readonly options: PoseTrackerOptions = {}) {
    optionsOf(options);
    this.smoothing = options.smoothing ?? 0.05;
    this.hold = options.hold ?? 0.2;
    if (!Number.isFinite(this.smoothing) || this.smoothing < 0 || !Number.isFinite(this.hold) || this.hold < 0)
      throw new RangeError('Pose smoothing and hold must be finite, nonnegative seconds');
    this.options = Object.freeze({ ...options });
  }
  /** Take a latest frame; null signals tracking loss. Validation completes before replacing the previous goal. */
  push(frame: PoseTrackingFrame | null): this {
    const world: TrackedPose['worldRotations'] = {},
      confidence: TrackedPose['confidence'] = {};
    let position: V | null = null;
    if (frame !== null) {
      if (!frame || typeof frame !== 'object')
        throw new TypeError('Pose frame must be a body/hand landmarks object or null');
      const body = frame.poseWorldLandmarks ?? frame.poseLandmarks;
      const parts: TrackedPose[] = [];
      if (body)
        parts.push(
          solveBodyPose(body, { ...this.options, aspect: frame.poseWorldLandmarks ? 1 : this.options.aspect }),
        );
      const left = frame.leftHandWorldLandmarks ?? frame.leftHandLandmarks,
        right = frame.rightHandWorldLandmarks ?? frame.rightHandLandmarks;
      if (left)
        parts.push(
          solveHandPose(left, 'left', {
            ...this.options,
            aspect: frame.leftHandWorldLandmarks ? 1 : this.options.aspect,
          }),
        );
      if (right)
        parts.push(
          solveHandPose(right, 'right', {
            ...this.options,
            aspect: frame.rightHandWorldLandmarks ? 1 : this.options.aspect,
          }),
        );
      for (const part of parts) {
        Object.assign(world, part.worldRotations);
        Object.assign(confidence, part.confidence);
        if (part.position) position = [...part.position];
      }
    }
    this.goal = localize(world, confidence, position);
    return this;
  }
  /** Use the current goal as neutral, so arbitrary camera/hand rest orientations map to the avatar's authored rest. */
  calibrate(): this {
    this.calibration = structuredClone(this.goal.worldRotations);
    this.origin = this.goal.position ? [...this.goal.position] : [0, 0, 0];
    return this.reset();
  }
  /** Clear the neutral calibration; subsequent input uses the documented canonical T-pose. */
  clearCalibration(): this {
    this.calibration = {};
    this.origin = [0, 0, 0];
    return this.reset();
  }
  /** Advance filtered rotations. Loss holds briefly, then returns to neutral; delta 0 never advances a fade. */
  update(delta: number): TrackedPose {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Pose delta must be finite and nonnegative seconds');
    const share = this.smoothing === 0 ? 1 : 1 - Math.exp(-delta / this.smoothing),
      confidence: TrackedPose['confidence'] = {};
    for (const bone of HUMANOID_BONES) {
      const measured = this.goal.worldRotations[bone];
      let next: PoseQuaternion;
      if (measured) {
        this.ages.set(bone, 0);
        next = this.calibration[bone]
          ? multiplyQuaternions(measured, conjugateQuaternion(this.calibration[bone]!))
          : measured;
        confidence[bone] = this.goal.confidence[bone];
      } else {
        const age = (this.ages.get(bone) ?? 0) + delta;
        this.ages.set(bone, age);
        if (!this.current[bone] || age <= this.hold) continue;
        next = ID;
        confidence[bone] = 0;
      }
      this.current[bone] = interpolateQuaternions(this.current[bone] ?? ID, next, share, 0.9995);
    }
    if (this.goal.position) {
      const position = sub([...this.goal.position], this.origin);
      for (let i = 0; i < 3; i++) this.translation[i] += (position[i] - this.translation[i]) * share;
      this.hasPosition = true;
    } else if ((this.ages.get('hips') ?? 0) > this.hold) for (let i = 0; i < 3; i++) this.translation[i] *= 1 - share;
    return localize(structuredClone(this.current), confidence, this.hasPosition ? [...this.translation] : null);
  }
  /** Return the filter to neutral; calibration and the latest goal remain available. */
  reset(): this {
    for (const key of Object.keys(this.current)) delete this.current[key as HumanoidBone];
    this.ages.clear();
    this.translation = [0, 0, 0];
    this.hasPosition = false;
    return this;
  }
}
/** Native binding options. VRM integration runs before gaze and springs; otherwise the owning scene updates it. */
export interface AddPoseTrackingOptions extends PoseTrackerOptions {
  /** Abort before the optional retarget module finishes loading or before attachment. */
  signal?: AbortSignal;
  vrm?: VRMHandle;
  autoUpdate?: boolean /** Proportional root motion scale; default target/source hips height. */;
  hipScale?: number;
}
/** Running tracker binding. Dispose restores every transform written by the tracker. */
export interface PoseTrackingHandle {
  readonly tracker: PoseTracker;
  push(frame: PoseTrackingFrame | null): void;
  update(delta: number): void;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Bind normalized body and hand motion to a VRM in its T-pose, absorbing the target's arbitrary rest axes. */
export async function addPoseTracking(
  animation: Animation,
  avatar: VRMAvatar,
  options: AddPoseTrackingOptions = {},
): Promise<PoseTrackingHandle> {
  options.signal?.throwIfAborted();
  const { Retarget, retargetRig } = await import('@margoengine/animation/skeleton-utils');
  options.signal?.throwIfAborted();
  const tracker = new PoseTracker(options),
    model = animation.model,
    target = retargetRig(model),
    bones = avatar.humanoid.humanBones;
  const names = target.names.map((_, i) => `target#${i}`);
  for (const [name, bone] of Object.entries(bones)) {
    if (!Number.isInteger(bone.node) || bone.node < 0 || bone.node >= names.length)
      throw new RangeError('Tracking bone node must name a node in this model');
    names[bone.node] = name;
  }
  const rest = new Float64Array(HUMANOID_BONES.length * 10);
  HUMANOID_BONES.forEach((name, i) => {
    rest[i * 10 + 6] = 1;
    rest.fill(1, i * 10 + 7, i * 10 + 10);
    if (name === 'hips') rest[i * 10 + 1] = 1;
  });
  const source = {
    names: HUMANOID_BONES,
    parents: HUMANOID_BONES.map((name) => (parents[name] ? HUMANOID_BONES.indexOf(parents[name]!) : -1)),
    rest,
  };
  const retarget = new Retarget(source, { ...target, names }, { hip: 'hips', hipScale: options.hipScale }),
    input = rest.slice(),
    output = target.rest.slice(),
    t = model.root.engine.store.transforms;
  const saved = new Map<number, { q: number[]; p: V }>();
  let dead = false,
    detach: (() => void) | undefined,
    unsubscribe: (() => void) | undefined;
  const update = (delta: number) => {
    if (dead) throw new MargoError('disposed', 'Pose tracking is disposed; create a new binding');
    const pose = tracker.update(delta);
    input.set(rest);
    for (const [name, q] of Object.entries(pose.rotations))
      input.set(q, HUMANOID_BONES.indexOf(name as HumanoidBone) * 10 + 3);
    if (pose.position) for (let i = 0; i < 3; i++) input[i] = rest[i] + pose.position[i];
    retarget.pose(input, output);
    for (const [name, bone] of Object.entries(bones))
      if (pose.worldRotations[name as HumanoidBone]) {
        const node = bone.node,
          mesh = model.nodes[node],
          id = mesh.id;
        if (!saved.has(node))
          saved.set(node, { q: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]], p: [t.x[id], t.y[id], t.z[id]] });
        mesh.setQuaternion(Array.from(output.subarray(node * 10 + 3, node * 10 + 7)));
        if (name === 'hips' && pose.position)
          mesh.setPosition(Array.from(output.subarray(node * 10, node * 10 + 3)) as V);
      }
  };
  const scene = model.root.scene,
    name = `pose-tracking:${model.root.id}`;
  const dispose = () => {
    if (dead) return;
    dead = true;
    detach?.();
    unsubscribe?.();
    for (const [node, pose] of saved) {
      model.nodes[node].setQuaternion(pose.q);
      if (node === bones.hips?.node) model.nodes[node].setPosition(pose.p);
    }
  };
  if (options.autoUpdate !== false) {
    if (options.vrm) detach = options.vrm.addPoseSource(update);
    else {
      scene.use({ name, setup() {}, onPreUpdate: update });
      detach = () => scene.removePlugin(name);
    }
  }
  unsubscribe = model.onDispose(() => {
    if (!dead) {
      dead = true;
      detach?.();
    }
  });
  return {
    tracker,
    push(frame) {
      if (dead) throw new MargoError('disposed', 'Pose tracking is disposed; create a new binding');
      tracker.push(frame);
    },
    update,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
