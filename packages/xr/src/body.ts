// WebXR body tracking (W3C WebXR Body Tracking Module, Level 1 draft): 83 joint spaces on `frame.body`, read each frame
// as poses in the session's reference space, plus a mapping to the humanoid bone names of `@margoengine/rigging`.
import { margoError } from '../../shared/errors.js';
import type { XRNativeFrame, XRNativeSession, XRSpace } from './types.js';

/** The session feature descriptor that asks the browser for body tracking. */
export const BODY_TRACKING_FEATURE = 'body-tracking';

type Side = 'left' | 'right';
const FINGERS = ['index', 'middle', 'ring', 'little'] as const;
const hand = (s: Side): string[] => [
  `${s}-hand-palm`,
  `${s}-hand-wrist`,
  ...['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'].map((b) => `${s}-hand-thumb-${b}`),
  ...FINGERS.flatMap((f) =>
    ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((b) =>
      // The spec spells the middle finger's metacarpal 'middle-phalanx-metacarpal'.
      f === 'middle' && b === 'metacarpal' ? `${s}-hand-middle-phalanx-metacarpal` : `${s}-hand-${f}-${b}`,
    ),
  ),
];
const arm = (s: Side) => ['shoulder', 'scapula', 'arm-upper', 'arm-lower', 'hand-wrist-twist'].map((b) => `${s}-${b}`);
const leg = (s: Side) =>
  ['upper-leg', 'lower-leg', 'foot-ankle-twist', 'foot-ankle', 'foot-subtalar', 'foot-transverse', 'foot-ball'].map(
    (b) => `${s}-${b}`,
  );

/** The 83 XRBodyJoint names, in the spec's order. */
export const BODY_JOINT_NAMES: readonly string[] = Object.freeze([
  'hips',
  'spine-lower',
  'spine-middle',
  'spine-upper',
  'chest',
  'neck',
  'head',
  ...arm('left'),
  ...arm('right'),
  ...hand('left'),
  ...hand('right'),
  ...leg('left'),
  ...leg('right'),
]);

const TORSO: Record<string, string> = {
  hips: 'hips',
  'spine-lower': 'spine',
  'spine-middle': 'chest',
  'spine-upper': 'upperChest',
  neck: 'neck',
  head: 'head',
};
const LIMBS: Record<string, string> = {
  shoulder: 'Shoulder',
  'arm-upper': 'UpperArm',
  'arm-lower': 'LowerArm',
  'hand-wrist': 'Hand',
  'upper-leg': 'UpperLeg',
  'lower-leg': 'LowerLeg',
  'foot-ankle': 'Foot',
  'foot-ball': 'Toes',
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** XRBodyJoint to the humanoid bone name `@margoengine/rigging` uses (`HumanoidBone`); joints with no bone are absent. */
export const BODY_JOINT_TO_HUMANOID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    BODY_JOINT_NAMES.flatMap((joint): [string, string][] => {
      if (TORSO[joint]) return [[joint, TORSO[joint]]];
      const m = /^(left|right)-(.+)$/.exec(joint);
      if (!m) return [];
      const [, s, rest] = m;
      if (LIMBS[rest]) return [[joint, s + LIMBS[rest]]];
      const f = /^hand-(thumb|index|middle|ring|little)-(?:phalanx-)?(metacarpal|proximal|intermediate|distal)$/.exec(
        rest.replace('middle-phalanx-metacarpal', 'middle-metacarpal'),
      );
      // Humanoid bones keep a metacarpal only for the thumb.
      if (!f || (f[2] === 'metacarpal' && f[1] !== 'thumb')) return [];
      return [[joint, s + cap(f[1]) + cap(f[2])]];
    }),
  ),
);

/** What `BodyTracking.create` needs of an `XR`: its session and reference space. */
export interface BodyTrackingHost {
  readonly session: XRNativeSession | null;
  readonly referenceSpace: XRSpace | undefined;
}
/** Options for {@link BodyTracking.create}. */
export interface BodyTrackingOptions {
  /** Throw MargoError 'unsupported' instead of reporting `available: false` when body tracking is missing. Default false. */
  required?: boolean;
}
/** One frame of body joint poses in the session's reference space; the object is reused, so copy what you keep. */
export interface BodyPose {
  /** Joint order is {@link BODY_JOINT_NAMES}: 83 x [x, y, z] in metres. */
  readonly positions: Float32Array;
  /** 83 x unit quaternion [x, y, z, w]. */
  readonly rotations: Float32Array;
  /** True when the device emulated (guessed) any joint position. */
  emulated: boolean;
  /** A joint's [x, y, z] (a view into `positions`), or undefined for an unknown name. */
  position(joint: string): Float32Array | undefined;
  /** A joint's [x, y, z, w] (a view into `rotations`), or undefined for an unknown name. */
  rotation(joint: string): Float32Array | undefined;
}
/** One humanoid bone's world pose. */
export interface HumanoidBonePose {
  position: [number, number, number];
  rotation: [number, number, number, number];
}
const index = new Map(BODY_JOINT_NAMES.map((name, i) => [name, i]));

/**
 * Body tracking in a session started with the 'body-tracking' feature (an optional feature: few devices have it).
 * `BodyTracking.create(xr)` never throws without the feature: check `available`, or pass `{required: true}` for a
 * MargoError 'unsupported'. `read(frame)` gives all 83 joints or null (the spec reports every joint or none).
 */
export class BodyTracking {
  private readonly pose: BodyPose;
  private readonly spaces: (XRSpace | undefined)[] = [];
  private spacesFor?: object;
  private constructor(
    private readonly host: BodyTrackingHost,
    /** Whether the session was granted the 'body-tracking' feature. */
    readonly available: boolean,
  ) {
    const positions = new Float32Array(BODY_JOINT_NAMES.length * 3),
      rotations = new Float32Array(BODY_JOINT_NAMES.length * 4);
    this.pose = {
      positions,
      rotations,
      emulated: false,
      position: (j) => (index.has(j) ? positions.subarray(index.get(j)! * 3, index.get(j)! * 3 + 3) : undefined),
      rotation: (j) => (index.has(j) ? rotations.subarray(index.get(j)! * 4, index.get(j)! * 4 + 4) : undefined),
    };
  }
  /** Reads the session's granted features. Throws 'state' without a session, 'unsupported' only with `required`. */
  static create(xr: BodyTrackingHost, options: BodyTrackingOptions = {}): BodyTracking {
    const session = xr?.session;
    if (!session) throw margoError('state', 'BodyTracking needs an active XR session; await xr.requestSession first');
    const available = !session.enabledFeatures || session.enabledFeatures.includes(BODY_TRACKING_FEATURE);
    if (!available && options.required)
      throw margoError(
        'unsupported',
        "The XR session has no 'body-tracking' feature; request it in optionalFeatures and use a device that supports it",
      );
    return new BodyTracking(xr, available);
  }
  /**
   * This frame's joint poses, or null without the feature, for another session's frame, while tracking is lost or when
   * any joint has no pose.
   */
  read(frame: XRNativeFrame): BodyPose | null {
    const ref = this.host.referenceSpace,
      body = frame?.body;
    if (!this.available || !ref || !body || frame.session !== this.host.session) return null;
    if (this.spacesFor !== body) {
      this.spaces.length = 0;
      for (const name of BODY_JOINT_NAMES) this.spaces.push(body.get(name));
      this.spacesFor = body;
    }
    const { positions: p, rotations: r } = this.pose;
    let emulated = false;
    for (let i = 0; i < BODY_JOINT_NAMES.length; i++) {
      const space = this.spaces[i],
        pose = space && frame.getPose(space, ref);
      if (!pose) return null;
      const t = pose.transform;
      p[i * 3] = t.position.x;
      p[i * 3 + 1] = t.position.y;
      p[i * 3 + 2] = t.position.z;
      r[i * 4] = t.orientation.x;
      r[i * 4 + 1] = t.orientation.y;
      r[i * 4 + 2] = t.orientation.z;
      r[i * 4 + 3] = t.orientation.w;
      emulated ||= pose.emulatedPosition;
    }
    this.pose.emulated = emulated;
    return this.pose;
  }
}

/** A pose as world position and rotation per humanoid bone name, ready for `@margoengine/rigging` retargeting. */
export function humanoidPose(pose: BodyPose): Map<string, HumanoidBonePose> {
  const out = new Map<string, HumanoidBonePose>();
  for (const [joint, bone] of Object.entries(BODY_JOINT_TO_HUMANOID)) {
    const i = index.get(joint)!;
    out.set(bone, {
      position: [pose.positions[i * 3], pose.positions[i * 3 + 1], pose.positions[i * 3 + 2]],
      rotation: [
        pose.rotations[i * 4],
        pose.rotations[i * 4 + 1],
        pose.rotations[i * 4 + 2],
        pose.rotations[i * 4 + 3],
      ],
    });
  }
  return out;
}
