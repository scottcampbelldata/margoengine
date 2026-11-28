// The body model every rigging solver reads: a species table of joints (kind, neutral pose, axes, ranges of motion in
// two tiers, every number with its source) and the fit of that table to any rig. Species tables live in their own
// entries (`@margoengine/rigging/anatomy/human`); this file knows no species.
//
// Joint frames are built from landmarks: the rig's joint positions and its facing, never its bone axes or its rest
// pose. So a T pose, an A pose and an arms-down pose of one body, with any bone roll, read the same clinical angles,
// and a straight elbow or knee still knows which way it bends.
//
// Method, written clean room from these papers and standards (no other engine's or tool's source was read):
// - Joint coordinate systems and the clinical naming of rotations: Wu et al., "ISB recommendation on definitions of
//   joint coordinate system of various joints for the reporting of human joint motion", part I (ankle, hip, spine),
//   J Biomech 35(4):543-548, 2002, and part II (shoulder, elbow, wrist, hand), J Biomech 38(5):981-992, 2005; Grood
//   and Suntay, "A joint coordinate system for the clinical description of three-dimensional motions", J Biomech Eng
//   105(2):136-144, 1983.
// - Swing and twist: a joint's turn is split into a swing of the bone's long axis and a twist about it (Baerlocher,
//   "Inverse kinematics techniques for the interactive posture control of articulated figures", EPFL thesis 2392,
//   2001; Dobrowolski, "Swing-twist decomposition in Clifford algebra", arXiv:1506.05481, 2015). The swing is read as
//   a rotation vector (Grassia, "Practical parameterization of rotations using the exponential map", J Graphics Tools
//   3(3):29-48, 1998), whose two parts are the clinical flexion and abduction.
// - Reach limits that differ by direction: the swing vector stays inside an ellipse per quadrant (Wilhelms and Van
//   Gelder, "Fast and easy reach-cone joint limits", J Graphics Tools 6(2):27-41, 2001). The nearest point of the
//   ellipse is found from the Lagrange condition of the distance, solved by bisection.
// - A range that depends on the pose (a knee twists only when it is bent): Akhter and Black, "Pose-conditioned joint
//   angle limits for 3D human pose reconstruction", CVPR 2015 (the idea only; no learned data).
import type { Animator } from '@margoengine/animator';
import type { CCDJointLimit } from '@margoengine/animator/ccd';
import type { PoseJointLimit } from './joint-limits.js';
import { checkRig, parentOrder, worldFrames, type RigJoint, type RigPose } from './rig.js';

/** Three numbers: a direction or an axis. */
export type Vec3 = readonly [number, number, number];
/** A rotation, [x, y, z, w]. */
export type Quat = readonly [number, number, number, number];
/**
 * How a number in a table was checked: `dataset` (read from a measured dataset held in a data file of this
 * repository), `print` (checked in the printed source), `online` (checked on a readable page this number names) or
 * `recalled` (from memory, to be confirmed before anyone relies on it).
 */
export type Provenance = 'dataset' | 'print' | 'online' | 'recalled';
/** `normal` is the clinical range, where a validator warns; `structural` is the stop no pose may pass. */
export type Tier = 'normal' | 'structural';
/** The anatomical kind of a joint. A `free` joint carries a segment and has no limit. */
export type JointKind = 'free' | 'hinge' | 'ball' | 'saddle' | 'condyloid' | 'pivot' | 'glide';
/** Which side of the body a joint is on. */
export type Side = 'left' | 'right' | 'centre';

/** One entry of a table's list of sources. */
export interface SourceEntry {
  /** The full citation. */
  readonly cite: string;
  /** Where to read it. */
  readonly url?: string;
}

/** One number as its source gives it. */
export interface SourceRow {
  /** Key into {@link SpeciesTable.sources}. */
  readonly source: string;
  /** The number, in degrees unless `what` says otherwise. */
  readonly value: number;
  /** What the source calls it, with the group it was measured on. */
  readonly what: string;
  /** How the number was checked. */
  readonly provenance: Provenance;
  /** The page it was read on, when that is not the source itself. */
  readonly via?: string;
  /** The data file that holds it, for `dataset` rows. */
  readonly file?: string;
}

/**
 * One end of a range, as degrees away from neutral in that direction. Unless `rule` says otherwise, `normal` is the
 * first row's value and `structural` is the largest row rounded up to 5 degrees plus `allowance`, at most 180.
 */
export interface Bound {
  /** Clinical range, degrees. */
  readonly normal: number;
  /** The stop, degrees. */
  readonly structural: number;
  /** Degrees added past the largest source value to reach the stop: tissue give and the spread between people. */
  readonly allowance: number;
  /** The source values. Empty for a direction the joint's kind does not allow. */
  readonly rows: readonly SourceRow[];
  /** How the two numbers come from the rows, when not by the default above. */
  readonly rule?: string;
}

/** A range that opens with another motion of the same joint: a knee twists only when it is bent. */
export interface Gate {
  /** The motion that opens it: 0 for the first swing, 1 for the second, 2 for the twist. */
  readonly by: 0 | 1 | 2;
  /** Degrees of that motion at which the range is still shut. */
  readonly from: number;
  /** Degrees of that motion at which the range is fully open. */
  readonly to: number;
  /** Degrees each way that stay free when shut. */
  readonly floor: number;
}

/** One motion of a joint. */
export interface DofSpec {
  /**
   * The axis in the body frame (x left, y up, z forward) at the neutral pose; a right-hand turn about it is the
   * `positive` motion. The first two axes are across the joint's long axis and across each other; the third is along it.
   */
  readonly axis: Vec3;
  /** Clinical name of the positive direction, such as `flexion`. */
  readonly positive: string;
  /** Clinical name of the negative direction, such as `extension`. */
  readonly negative: string;
  /** Range in the positive direction. */
  readonly max: Bound;
  /** Range in the negative direction. */
  readonly min: Bound;
  /** Makes the range depend on another motion of the joint. */
  readonly gate?: Gate;
  /** Twist only: turn past the range moves into the joint above it, which twists with it (a hand on a forearm). */
  readonly spill?: boolean;
}

/** One joint of a species. */
export interface JointSpec {
  /** Its name in the species' standard (H-Anim for humans). */
  readonly id: string;
  /** The joint above it in the body, null for the root. */
  readonly parent: string | null;
  /** The joint whose segment its angles are measured against, when that is not `parent`. */
  readonly reference?: string;
  /** The segment it carries. */
  readonly segment: string;
  /** Its kind. */
  readonly kind: JointKind;
  /** Its side. */
  readonly side: Side;
  /** The same joint on the other side. */
  readonly mirror?: string;
  /**
   * What counts as zero: `body` (the segment points along `long` in the reference segment's frame: an arm hanging
   * down), `straight` (the segment continues the line into the joint: a straight elbow) or `rest` (the rig's rest pose).
   */
  readonly neutral: 'body' | 'straight' | 'rest';
  /** Direction of its segment at neutral, in the body frame. */
  readonly long: Vec3;
  /** Joints whose position marks the far end of its segment, first found wins. */
  readonly distal?: readonly string[];
  /** Two joints that lie across its segment, to read the segment's roll (the knuckles of a hand). */
  readonly across?: { readonly pairs: readonly (readonly [string, string])[]; readonly neutral: Vec3 };
  /** Its three motions: two swings and the twist. Left out for a free joint. */
  readonly dofs?: readonly [DofSpec, DofSpec, DofSpec];
  /** The region it belongs to. */
  readonly region?: string;
}

/**
 * A run of joints along one chain, proximal first. A rig bone stands for every joint of the run nearest to it, and
 * their ranges add up. In a `shared` region (a spine) the whole run's range is one budget: each bone may use any part
 * of it, and the far end of the run stays within it.
 */
export interface RegionSpec {
  /** Its name. */
  readonly id: string;
  /** Its joints, proximal first. */
  readonly joints: readonly string[];
  /** Whether the range is one budget for the run. */
  readonly shared: boolean;
}

/** How to read a body's frame from its joints. */
export interface FrameSpec {
  /** Left and right joints whose line gives the body's left, first pair found wins. */
  readonly pairs: readonly (readonly [string, string])[];
  /** Joints above the first pair, to read up; first found wins. */
  readonly top: readonly string[];
  /** Joints below the first pair, read when no top joint is mapped. */
  readonly bottom: readonly string[];
  /** Pairs that point forward (ankle to toe). When they disagree with the left and right names, the rig is mirrored. */
  readonly ahead: readonly (readonly [string, string])[];
  /** A fixed up direction, for a body whose spine is not upright. */
  readonly up?: Vec3;
}

/** A proportion of the species, as a share of its stature. */
export interface ProportionNorm {
  /** Its name. */
  readonly id: string;
  /** What is measured. */
  readonly what: string;
  /** Mean share of stature. */
  readonly share: number;
  /** Shares by sex, where the source gives them. */
  readonly female?: number;
  /** Shares by sex, where the source gives them. */
  readonly male?: number;
  /** Standard deviation as a share of mean stature, where the source gives one. */
  readonly spread?: number;
  /** The source values. */
  readonly rows: readonly SourceRow[];
}

/** A body segment's share of the body's mass and where its centre of mass sits. */
export interface SegmentNorm {
  /** Its name. */
  readonly id: string;
  /** The joint or joints that carry it: one per side for a limb segment, whose numbers are for one limb. */
  readonly joints: readonly string[];
  /** Mean share of body mass, 0 to 1. */
  readonly mass: number;
  /** Mean centre of mass, 0 to 1 of the way from the near landmark to the far one. */
  readonly centre: number;
  /** [female, male] shares of body mass. */
  readonly massBySex?: readonly [number, number];
  /** [female, male] centres of mass. */
  readonly centreBySex?: readonly [number, number];
  /** The landmarks the centre is measured between. */
  readonly landmarks: readonly [string, string];
  /** The source values. */
  readonly rows: readonly SourceRow[];
}

/** A motion that two or more joints share: data for the coupling solver, with its sources. */
export interface CouplingHook {
  /** Its name. */
  readonly id: string;
  /** What kind of rule it is. */
  readonly kind: string;
  /** The joints it ties together, the driver first. */
  readonly joints: readonly string[];
  /** The rule in words. */
  readonly note: string;
  /** Its numbers. */
  readonly values: Readonly<Record<string, number>>;
  /** The source values. */
  readonly rows: readonly SourceRow[];
}

/** What a naming finds in a rig. */
export interface JointNaming {
  /** The naming convention that matched. */
  readonly preset: string;
  /** Joint id to bone index. */
  readonly joints: ReadonlyMap<string, number>;
}

/** A species: its joints, parents first, and everything measured about it. */
export interface SpeciesTable {
  /** Its name, such as `human`. */
  readonly id: string;
  /** The naming standard its joint ids follow. */
  readonly standard: string;
  /** The joints, parents first; the first is the root. */
  readonly joints: readonly JointSpec[];
  /** The regions. */
  readonly regions: readonly RegionSpec[];
  /** How to read the body frame. */
  readonly frame: FrameSpec;
  /** Distances along up that give the stature: the first whose two joints are mapped wins. */
  readonly stature: readonly { readonly from: string; readonly to: string; readonly share: number }[];
  /** Proportions. */
  readonly proportions: readonly ProportionNorm[];
  /** Segment masses. */
  readonly segments: readonly SegmentNorm[];
  /** Coupled motions. */
  readonly couplings: readonly CouplingHook[];
  /** Every source a row names. */
  readonly sources: Readonly<Record<string, SourceEntry>>;
  /** Finds the joints among bone names, under one named convention or the one that fits best. */
  readonly naming?: (names: readonly string[], preset?: string) => JointNaming | null;
  /** Names the rest pose from the rest angles, such as `T`, `A` or `arms-down`. */
  readonly describeRest?: (rest: Readonly<Record<string, JointAngles>>) => string;
}

/** A joint's angles in degrees: the two swings and the twist, named by the joint's own motions. */
export interface JointAngles {
  /** The first swing: flexion for most joints. */
  flexion: number;
  /** The second swing: abduction for most joints. */
  abduction: number;
  /** The twist about the segment's long axis. */
  rotation: number;
}

/** One joint of a table as it sits on a rig. */
export interface AnatomicalJoint {
  /** The table joint the bone is mapped to. */
  readonly id: string;
  /** Its table entry. */
  readonly spec: JointSpec;
  /** The bone that turns at this joint. */
  readonly bone: number;
  /** The bone its angles are measured against, -1 for none. */
  readonly reference: number;
  /** Every table joint this bone stands for, itself included. */
  readonly covers: readonly string[];
  /** Its side once the facing is known: a mirrored rig swaps left and right. */
  readonly side: Side;
  /** Its kind. */
  readonly kind: JointKind;
  /** Its region, or null. */
  readonly region: string | null;
  /** Whether it has a range: false for a free joint. */
  readonly limited: boolean;
  /** The segment's long axis at neutral, in the reference segment's anatomical frame. */
  readonly long: Vec3;
  /** The three motion axes in that frame; a right-hand turn about each is the positive motion. */
  readonly axes: readonly [Vec3, Vec3, Vec3];
  /** The same three axes in the bone's own local frame. */
  readonly boneAxes: readonly [Vec3, Vec3, Vec3];
  /** The anatomical frame as a rotation in the bone's own local frame. */
  readonly frame: Quat;
  /** The reference segment's anatomical frame in the reference bone's local frame. */
  readonly referenceFrame: Quat;
  /** The bone's local rotation at anatomical zero, with the bones between it and its reference at rest. */
  readonly neutral: Quat;
  /** Its angles in the rest pose. */
  readonly rest: JointAngles;
  /** Clinical range: [min, max] of the first swing, the second swing and the twist, degrees. */
  readonly normal: readonly number[];
  /** The stops, in the same layout. */
  readonly structural: readonly number[];
}

/** A shared region as it sits on a rig. */
export interface AnatomicalRegion {
  /** Its name. */
  readonly id: string;
  /** Indices into {@link AnatomicalRig.joints}, proximal first. */
  readonly joints: readonly number[];
  /** The clinical range of the whole run. */
  readonly normal: readonly number[];
  /** The stops of the whole run. */
  readonly structural: readonly number[];
}

/** A rig with its anatomy: what {@link fitAnatomy} returns and every other function here reads. */
export interface AnatomicalRig {
  /** The species table. */
  readonly species: SpeciesTable;
  /** Bone names. */
  readonly names: readonly string[];
  /** Parent bone per bone, -1 at the top. */
  readonly parents: readonly number[];
  /** The rest pose, 10 numbers per bone: translation, rotation xyzw, scale. */
  readonly rest: Float64Array;
  /** The same pose with every fitted joint at anatomical zero. */
  readonly neutral: Float64Array;
  /** The body frame in the rig's rest space. */
  readonly frame: { readonly origin: Vec3; readonly left: Vec3; readonly up: Vec3; readonly forward: Vec3 };
  /** True when the left and right names disagree with the way the feet point; the feet win. */
  readonly mirrored: boolean;
  /** Standing height in the rig's units, 0 when no measure was mapped. */
  readonly stature: number;
  /** The rest pose as the species names it. */
  readonly restPose: string;
  /** The naming convention that matched, null when only `map` was used. */
  readonly preset: string | null;
  /** Whether limits apply. Pass `limits: false` to {@link fitAnatomy} to turn them off. */
  readonly limits: boolean;
  /** The fitted joints, parents first. */
  readonly joints: readonly AnatomicalJoint[];
  /** The shared regions that have a bone. */
  readonly regions: readonly AnatomicalRegion[];
  /** Table joint id to its index in `joints`, for every joint a bone stands for. */
  readonly index: ReadonlyMap<string, number>;
}

/** Options of {@link fitAnatomy}. */
export interface FitOptions {
  /** The species table, such as `human` from `@margoengine/rigging/anatomy/human`. */
  readonly species: SpeciesTable;
  /** A naming convention of the species to use. Default: the one that matches the most bones. */
  readonly preset?: string;
  /** Joint id to bone name or index, over what the naming found; null drops a joint. */
  readonly map?: Readonly<Record<string, string | number | null>>;
  /** False turns the limits off by name: {@link clampPose} and {@link addAnatomyLimits} then leave poses alone. Default true. */
  readonly limits?: boolean;
  /** The way the body faces in the rig's rest space, when the rig has no feet to read it from. */
  readonly forward?: Vec3;
  /**
   * Degrees of roll about its own length that a segment has in the rest pose, by joint id, added to what the landmarks
   * show. A straight arm with no knuckle bones cannot show how it is rolled, so its elbow is taken to bend the way an
   * unrolled arm does; a reader that knows better (from a capture file's own axes, or from the motion) passes it here.
   */
  readonly roll?: Readonly<Record<string, number>>;
}

/** One motion that {@link clampPose} brought back into range. */
export interface ClampIssue {
  /** The joint, or the region for a shared budget. */
  readonly joint: string;
  /** The bone that was turned, -1 for a region. */
  readonly bone: number;
  /** The clinical name of the motion that was out of range. */
  readonly motion: string;
  /** Degrees it had. */
  readonly value: number;
  /** Degrees it was brought to. */
  readonly limit: number;
  /** The tier that was applied. */
  readonly tier: Tier;
  /** The source of the limit's first row, or null. */
  readonly source: string | null;
}

/** Options of {@link clampPose}. */
export interface ClampOptions {
  /** Which range to hold. Default `structural`. */
  readonly tier?: Tier;
  /** An array that receives one entry per motion brought back. */
  readonly issues?: ClampIssue[];
  /** Clamp even when the body was fitted with `limits: false`. */
  readonly force?: boolean;
}

/** A joint limit in the shape `@margoengine/ragdoll` profiles take, relative to the rest pose. */
export interface RagdollJointLimit {
  /** The bone. */
  readonly bone: number;
  /** The bone's name. */
  readonly name: string;
  /** A hinge about `axis` in the bone's local frame, or a cone about the rest direction. Radians. */
  readonly joint:
    | { type: 'hinge'; axis: [number, number, number]; limits: [number, number] }
    | { type: 'cone'; swing: number; twist: [number, number] };
}

/** A joint limit in the shape `@margoengine/kinematics-constraints` `JointLimitSet` takes, relative to neutral. */
export type KinematicsJointLimit =
  | { type: 'hinge'; axis: [number, number, number]; min: number; max: number }
  | { type: 'cone'; axis: [number, number, number]; angle: number; twist: [number, number] };

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

const DEG = 180 / Math.PI,
  RAD = Math.PI / 180,
  /** Degrees below which a change is no change. */
  TOLERANCE = 1e-7,
  /** A hinge bent less than this in the rest pose is read as straight. */
  BEND_MIN = 5 * RAD,
  /** A hinge bent at least this much in the rest pose is flexed: nothing else bends a joint that far. */
  BEND_SURE = 20 * RAD,
  /** Between the two, the bend is trusted only when its axis is within this of where anatomy puts it. */
  TWIST_TRUST = 60 * RAD;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: Vec3, b: Vec3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaled = (a: Vec3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
/** The unit vector along `a`, or null when `a` is no longer than `tiny`. */
const unit = (a: Vec3, tiny = 1e-12): V3 | null => {
  const l = Math.sqrt(dot(a, a));
  return l > tiny ? scaled(a, 1 / l) : null;
};
/** `a` without its part along the unit vector `n`. */
const reject = (a: Vec3, n: Vec3): V3 => {
  const d = dot(a, n);
  return [a[0] - n[0] * d, a[1] - n[1] * d, a[2] - n[2] * d];
};
const qmul = (a: Quat, b: Quat): Q4 => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Q4 => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q: Quat, v: Vec3): V3 => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]),
    ty = 2 * (q[2] * v[0] - q[0] * v[2]),
    tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
    v[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
    v[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
};
const qaxis = (axis: Vec3, angle: number): Q4 => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
/** The shortest turn that takes the unit vector `a` onto the unit vector `b`. */
const qswing = (a: Vec3, b: Vec3): Q4 => {
  const d = dot(a, b);
  if (d > 1 - 1e-14) return [0, 0, 0, 1];
  if (d < -1 + 1e-10) {
    // Opposite directions: half a turn about any axis across them.
    const axis = unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))!;
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(a, b),
    w = 1 + d,
    l = Math.sqrt(dot(c, c) + w * w);
  return [c[0] / l, c[1] / l, c[2] / l, w / l];
};
/** The rotation whose matrix has the unit, right-handed columns x, y, z. */
const qbasis = (x: Vec3, y: Vec3, z: Vec3): Q4 => {
  const trace = x[0] + y[1] + z[2];
  let q: Q4;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, 0.25 / s];
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]);
    q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  } else if (y[1] > z[2]) {
    const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]);
    q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/** out = a * b at offsets into arrays, with either factor conjugated; out may alias a or b. */
function mulAt(
  out: Float64Array,
  o: number,
  a: ArrayLike<number>,
  i: number,
  b: ArrayLike<number>,
  j: number,
  conjA = false,
  conjB = false,
): void {
  const sa = conjA ? -1 : 1,
    sb = conjB ? -1 : 1,
    ax = a[i] * sa,
    ay = a[i + 1] * sa,
    az = a[i + 2] * sa,
    aw = a[i + 3],
    bx = b[j] * sb,
    by = b[j + 1] * sb,
    bz = b[j + 2] * sb,
    bw = b[j + 3];
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * A {@link Bound} from its source rows: `normal` is the first row's value and `structural` the largest row rounded up
 * to 5 degrees plus `allowance`, at most 180. With no rows both are `allowance` past zero: a direction the joint does
 * not move in, with what a solver may leave there.
 */
export function bound(allowance: number, ...rows: SourceRow[]): Bound {
  if (!(allowance >= 0 && allowance <= 180)) throw new RangeError('A bound allowance must be 0 to 180 degrees');
  let widest = 0;
  for (const row of rows) {
    // A source may print a small negative mean: a joint that on average stops short of straight.
    if (!(Math.abs(row.value) <= 360))
      throw new RangeError(`Source value ${row.value} (${row.what}) must be within 360 degrees`);
    widest = Math.max(widest, row.value);
  }
  return {
    normal: rows.length ? Math.min(180, Math.max(0, rows[0].value)) : 0,
    structural: Math.min(180, Math.ceil(widest / 5 - 1e-9) * 5 + allowance),
    allowance,
    rows,
  };
}

/**
 * The joint on the other side of the body: ids renamed by `rename`, directions reflected across the middle plane and
 * turning axes reflected as axes of rotation, so that the same motion names keep the same anatomical meaning.
 */
export function mirrorJoint(spec: JointSpec, rename: (id: string) => string): JointSpec {
  const flip = (v: Vec3): Vec3 => [-v[0] || 0, v[1], v[2]],
    spin = (v: Vec3): Vec3 => [v[0], -v[1] || 0, -v[2] || 0];
  return {
    ...spec,
    id: rename(spec.id),
    parent: spec.parent === null ? null : rename(spec.parent),
    ...(spec.reference ? { reference: rename(spec.reference) } : {}),
    segment: rename(spec.segment),
    side: spec.side === 'left' ? 'right' : spec.side === 'right' ? 'left' : 'centre',
    mirror: spec.id,
    long: flip(spec.long),
    ...(spec.distal ? { distal: spec.distal.map(rename) } : {}),
    ...(spec.across
      ? {
          across: {
            pairs: spec.across.pairs.map(([a, b]) => [rename(a), rename(b)] as const),
            neutral: flip(spec.across.neutral),
          },
        }
      : {}),
    ...(spec.dofs
      ? { dofs: spec.dofs.map((dof) => ({ ...dof, axis: spin(dof.axis) })) as unknown as [DofSpec, DofSpec, DofSpec] }
      : {}),
  };
}

/**
 * Checks a species table and returns it frozen: joints parents first with unique ids, every id another entry names
 * present, unit axes at right angles, ranges that hold zero with the stop outside the clinical range, every number's
 * source listed, and regions whose joints share their axes so their ranges can add up.
 * @throws TypeError for a malformed table, RangeError naming the joint and what to fix.
 */
export function defineSpecies<T extends SpeciesTable>(table: T): T {
  if (!table || typeof table.id !== 'string' || !Array.isArray(table.joints) || !table.joints.length)
    throw new TypeError('A species table needs an id and a nonempty joints list, parents first');
  const seen = new Map<string, JointSpec>(),
    near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const known = (id: string, from: string, what: string) => {
    if (!seen.has(id) && !table.joints.some((joint) => joint.id === id))
      throw new RangeError(`${from}: ${what} "${id}" is not a joint of the ${table.id} table`);
  };
  for (const joint of table.joints) {
    const at = `${table.id} joint ${joint?.id}`;
    if (!joint || typeof joint.id !== 'string' || !joint.id) throw new TypeError('Every joint needs a nonempty id');
    if (seen.has(joint.id)) throw new RangeError(`${at}: the id is used twice`);
    if (joint.parent !== null && !seen.has(joint.parent))
      throw new RangeError(`${at}: its parent "${joint.parent}" must come before it in the table`);
    if (joint.parent === null && seen.size) throw new RangeError(`${at}: only the first joint may have no parent`);
    if (!near(dot(joint.long, joint.long), 1)) throw new RangeError(`${at}: long must be a unit vector`);
    if (joint.kind !== 'free' && !joint.dofs)
      throw new RangeError(`${at}: a ${joint.kind} joint needs its three motions`);
    if (joint.dofs) {
      const [a, b, c] = joint.dofs;
      for (const dof of joint.dofs) {
        if (!near(dot(dof.axis, dof.axis), 1))
          throw new RangeError(`${at}: the ${dof.positive} axis must be a unit vector`);
        for (const [end, name] of [
          [dof.max, dof.positive],
          [dof.min, dof.negative],
        ] as const) {
          if (!(end.normal >= 0 && end.structural >= end.normal - 1e-9 && end.structural <= 180))
            throw new RangeError(`${at}: ${name} needs 0 <= normal <= structural <= 180 degrees`);
          for (const row of end.rows) {
            if (!Object.hasOwn(table.sources, row.source))
              throw new RangeError(`${at}: ${name} names the source "${row.source}", which the table does not list`);
            if (!['dataset', 'print', 'online', 'recalled'].includes(row.provenance))
              throw new RangeError(`${at}: ${name} has the unknown provenance "${String(row.provenance)}"`);
            if (row.provenance === 'dataset' && !row.file)
              throw new RangeError(`${at}: ${name} is a dataset row and must name its data file`);
          }
          if (!end.rule) {
            const expected = bound(end.allowance, ...end.rows);
            if (!near(expected.normal, end.normal) || !near(expected.structural, end.structural))
              throw new RangeError(
                `${at}: ${name} does not follow from its rows; build it with bound() or state its rule`,
              );
          }
        }
        if (dof.gate && !(dof.gate.to > dof.gate.from && dof.gate.floor >= 0))
          throw new RangeError(`${at}: the ${dof.positive} gate needs from < to and a floor of 0 or more`);
      }
      if (!near(dot(a.axis, joint.long), 0) || !near(dot(b.axis, joint.long), 0) || !near(dot(a.axis, b.axis), 0))
        throw new RangeError(`${at}: the two swing axes must be at right angles to long and to each other`);
      if (!near(Math.abs(dot(c.axis, joint.long)), 1))
        throw new RangeError(`${at}: the twist axis must lie along long`);
    }
    seen.set(joint.id, joint);
  }
  for (const joint of table.joints) {
    const at = `${table.id} joint ${joint.id}`;
    if (joint.reference) known(joint.reference, at, 'reference');
    if (joint.mirror) known(joint.mirror, at, 'mirror');
    for (const id of joint.distal ?? []) known(id, at, 'distal joint');
    for (const pair of joint.across?.pairs ?? []) for (const id of pair) known(id, at, 'across joint');
  }
  const regions = new Set<string>();
  for (const region of table.regions) {
    const at = `${table.id} region ${region.id}`;
    if (regions.has(region.id)) throw new RangeError(`${at}: the id is used twice`);
    regions.add(region.id);
    const first = seen.get(region.joints[0]);
    if (!first?.dofs) throw new RangeError(`${at}: needs at least one joint with motions`);
    for (const id of region.joints) {
      const joint = seen.get(id);
      if (!joint?.dofs || joint.region !== region.id)
        throw new RangeError(`${at}: joint "${id}" must exist, have motions and name this region`);
      for (let s = 0; s < 3; s++)
        if (!near(dot(joint.dofs[s].axis, first.dofs[s].axis), 1) || joint.dofs[s].positive !== first.dofs[s].positive)
          throw new RangeError(`${at}: joint "${id}" must share the axes and motion names of "${first.id}"`);
    }
  }
  for (const joint of table.joints)
    if (joint.region && !regions.has(joint.region))
      throw new RangeError(`${table.id} joint ${joint.id}: region "${joint.region}" is not in the table`);
  const frame = table.frame;
  for (const pair of [...frame.pairs, ...frame.ahead]) for (const id of pair) known(id, `${table.id} frame`, 'joint');
  for (const id of [...frame.top, ...frame.bottom]) known(id, `${table.id} frame`, 'joint');
  for (const measure of table.stature) {
    known(measure.from, `${table.id} stature`, 'joint');
    known(measure.to, `${table.id} stature`, 'joint');
    if (!(measure.share > 0)) throw new RangeError(`${table.id} stature: a share must be above 0`);
  }
  for (const norm of [...table.proportions, ...table.segments, ...table.couplings])
    for (const row of norm.rows)
      if (!Object.hasOwn(table.sources, row.source))
        throw new RangeError(`${table.id} ${norm.id}: source "${row.source}" is not listed`);
  return Object.freeze(table);
}

/** What the solvers keep per body between calls. */
interface Work {
  /** Fitted joints by bone depth, so a bone's ancestors are settled before it. */
  readonly order: readonly AnatomicalJoint[];
  /** Joints whose twist spills into the joint above, with that joint. */
  readonly spills: readonly (readonly [AnatomicalJoint, AnatomicalJoint])[];
  /** World rotations, 4 per bone, valid where `stamp` equals `tick`. */
  readonly world: Float64Array;
  readonly stamp: Uint32Array;
  readonly stack: Int32Array;
  /** Scratch quaternions. */
  readonly q: Float64Array;
  /** Scratch angles: measured, then the copy kept for the report. */
  readonly v: Float64Array;
  readonly w: Float64Array;
  tick: number;
}
const WORK = new WeakMap<AnatomicalRig, Work>();
const workOf = (body: AnatomicalRig): Work => {
  const work = WORK.get(body);
  if (!work) throw new TypeError('This needs an AnatomicalRig made by fitAnatomy(rig, { species })');
  return work;
};

/** Offset of bone `b`'s world rotation in `work.world`, computed from the pose when stale. */
function worldOf(body: AnatomicalRig, work: Work, pose: ArrayLike<number>, b: number): number {
  const { world, stamp, stack } = work,
    parents = body.parents;
  let n = 0;
  for (let x = b; x >= 0 && stamp[x] !== work.tick; x = parents[x]) stack[n++] = x;
  while (n > 0) {
    const c = stack[--n],
      p = parents[c],
      at = c * 10 + 3;
    if (p < 0) for (let k = 0; k < 4; k++) world[c * 4 + k] = pose[at + k];
    else mulAt(world, c * 4, world, p * 4, pose, at);
    stamp[c] = work.tick;
  }
  return b * 4;
}

/** What the measure of a turn needs: a joint, or a region's far end against its reference. */
interface Span {
  readonly bone: number;
  readonly reference: number;
  readonly frame: Quat;
  readonly referenceFrame: Quat;
  readonly axes: readonly [Vec3, Vec3, Vec3];
}

/** The turn of `span.bone` against its reference, as swing and twist angles in degrees, into `out`. */
function measure(body: AnatomicalRig, work: Work, pose: ArrayLike<number>, span: Span, out: Float64Array): void {
  const q = work.q,
    wb = worldOf(body, work, pose, span.bone),
    wr = worldOf(body, work, pose, span.reference);
  mulAt(q, 0, work.world, wr, work.world, wb, true);
  mulAt(q, 4, q, 0, span.frame, 0);
  mulAt(q, 0, span.referenceFrame, 0, q, 4, true);
  let x = q[0],
    y = q[1],
    z = q[2],
    w = q[3];
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const [F, A, T] = span.axes,
    p = x * T[0] + y * T[1] + z * T[2],
    n = Math.sqrt(p * p + w * w);
  let sx = x,
    sy = y,
    sz = z,
    sw = w,
    twist = 0;
  if (n > 1e-12) {
    // The twist is the part of the turn about the long axis; the swing is what is left: turn = swing * twist.
    twist = 2 * Math.atan2(p, w);
    const c = w / n,
      bx = (-T[0] * p) / n,
      by = (-T[1] * p) / n,
      bz = (-T[2] * p) / n;
    sx = w * bx + x * c + y * bz - z * by;
    sy = w * by - x * bz + y * c + z * bx;
    sz = w * bz + x * by - y * bx + z * c;
    sw = w * c - x * bx - y * by - z * bz;
  }
  const m = Math.sqrt(sx * sx + sy * sy + sz * sz),
    g = (m > 1e-12 ? (2 * Math.atan2(m, Math.abs(sw))) / m : 2) * DEG;
  out[0] = (sx * F[0] + sy * F[1] + sz * F[2]) * g;
  out[1] = (sx * A[0] + sy * A[1] + sz * A[2]) * g;
  out[2] = twist * DEG;
}

/** Sets `span.bone`'s local rotation in `pose` so its turn against its reference has the angles `v`. */
function write(body: AnatomicalRig, work: Work, pose: Float64Array, span: Span, v: ArrayLike<number>): void {
  const q = work.q,
    [F, A, T] = span.axes,
    f = v[0] * RAD,
    a = v[1] * RAD,
    sx = f * F[0] + a * A[0],
    sy = f * F[1] + a * A[1],
    sz = f * F[2] + a * A[2],
    angle = Math.sqrt(sx * sx + sy * sy + sz * sz),
    half = Math.min(angle, Math.PI) / 2,
    k = angle > 1e-12 ? Math.sin(half) / angle : 0.5,
    h = (v[2] * RAD) / 2,
    s = Math.sin(h);
  q[0] = sx * k;
  q[1] = sy * k;
  q[2] = sz * k;
  q[3] = Math.cos(half);
  q[4] = T[0] * s;
  q[5] = T[1] * s;
  q[6] = T[2] * s;
  q[7] = Math.cos(h);
  mulAt(q, 0, q, 0, q, 4);
  mulAt(q, 0, span.referenceFrame, 0, q, 0);
  mulAt(q, 0, q, 0, span.frame, 0, false, true);
  const wr = worldOf(body, work, pose, span.reference);
  mulAt(q, 0, work.world, wr, q, 0);
  const parent = body.parents[span.bone],
    at = span.bone * 10 + 3;
  if (parent < 0) for (let i = 0; i < 4; i++) q[4 + i] = q[i];
  else mulAt(q, 4, work.world, worldOf(body, work, pose, parent), q, 0, true);
  const l = Math.sqrt(q[4] * q[4] + q[5] * q[5] + q[6] * q[6] + q[7] * q[7]) || 1;
  for (let i = 0; i < 4; i++) {
    pose[at + i] = q[4 + i] / l;
    work.world[span.bone * 4 + i] = q[i];
  }
  work.stamp[span.bone] = work.tick;
}

/** The point of the ellipse with half axes a and b nearest to (p, q), all positive, into `near`. */
const near2 = [0, 0];
function nearestOnEllipse(p: number, q: number, a: number, b: number): void {
  // At the nearest point (x, y) the offset is along the ellipse's normal: x = a^2 p / (t + a^2), y = b^2 q / (t + b^2)
  // for one t >= 0, and (x/a)^2 + (y/b)^2 = 1 falls as t grows.
  let low = 0,
    high = Math.max(Math.SQRT2 * a * p - a * a, Math.SQRT2 * b * q - b * b, 0) + 1e-9;
  for (let i = 0; i < 64; i++) {
    const t = (low + high) / 2,
      x = (a * p) / (t + a * a),
      y = (b * q) / (t + b * b);
    if (x * x + y * y > 1) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  near2[0] = (a * a * p) / (t + a * a);
  near2[1] = (b * b * q) / (t + b * b);
}

/** Brings the angles `v` inside the range `r`; true when any changed. */
function clampAngles(v: Float64Array, r: ArrayLike<number>, gate: Gate | null, slot: number): boolean {
  let changed = false,
    low = r[4],
    high = r[5];
  if (gate && slot === 2) {
    const open = Math.min(1, Math.max(0, (v[gate.by] - gate.from) / (gate.to - gate.from)));
    low = -Math.min(-low, Math.max(gate.floor, -low * open));
    high = Math.min(high, Math.max(gate.floor, high * open));
  }
  const twist = v[2] < low ? low : v[2] > high ? high : v[2];
  if (Math.abs(twist - v[2]) > TOLERANCE) {
    v[2] = twist;
    changed = true;
  }
  // The swing stays inside an ellipse whose half axes are the ranges of the quadrant it is in.
  const f = v[0],
    a = v[1],
    rf = f >= 0 ? r[1] : -r[0],
    ra = a >= 0 ? r[3] : -r[2];
  let nf = f,
    na = a;
  if (rf <= 0 && ra <= 0) nf = na = 0;
  else if (ra <= 0) {
    na = 0;
    nf = f < r[0] ? r[0] : f > r[1] ? r[1] : f;
  } else if (rf <= 0) {
    nf = 0;
    na = a < r[2] ? r[2] : a > r[3] ? r[3] : a;
  } else if ((f / rf) ** 2 + (a / ra) ** 2 > 1 + 1e-12) {
    nearestOnEllipse(Math.abs(f), Math.abs(a), rf, ra);
    nf = f < 0 ? -near2[0] : near2[0];
    na = a < 0 ? -near2[1] : near2[1];
  }
  if (Math.abs(nf - f) > TOLERANCE || Math.abs(na - a) > TOLERANCE) {
    v[0] = nf;
    v[1] = na;
    changed = true;
  }
  return changed;
}

/** The bones and rest pose of either rig form, copied and checked. */
function poseOf(rig: RigPose | readonly RigJoint[]): { names: string[]; parents: number[]; rest: Float64Array } {
  if (Array.isArray(rig)) {
    const joints = rig as readonly RigJoint[];
    checkRig(joints);
    const rest = new Float64Array(joints.length * 10);
    joints.forEach((joint, i) => {
      const from = joint.parent < 0 ? [0, 0, 0] : joints[joint.parent].position;
      rest.set([joint.position[0] - from[0], joint.position[1] - from[1], joint.position[2] - from[2]], i * 10);
      rest.set([0, 0, 0, 1, 1, 1, 1], i * 10 + 3);
    });
    return { names: joints.map((joint) => joint.name), parents: joints.map((joint) => joint.parent), rest };
  }
  const pose = rig as RigPose,
    n = pose?.names?.length;
  if (
    !pose ||
    !Array.isArray(pose.names) ||
    !Array.isArray(pose.parents) ||
    !n ||
    pose.parents.length !== n ||
    pose.rest?.length !== n * 10
  )
    throw new TypeError(
      'fitAnatomy needs a rig: { names, parents, rest } with 10 rest numbers per bone, or an array of { name, parent, position }',
    );
  const rest = Float64Array.from(pose.rest);
  for (let i = 0; i < n; i++) {
    const p = pose.parents[i];
    if (!Number.isInteger(p) || p < -1 || p >= n || p === i)
      throw new RangeError(`Bone ${pose.names[i]} has the invalid parent ${p}`);
    const at = i * 10 + 3,
      l = Math.hypot(rest[at], rest[at + 1], rest[at + 2], rest[at + 3]);
    if (!(l > 0) || !rest.subarray(i * 10, i * 10 + 10).every(Number.isFinite))
      throw new RangeError(`Bone ${pose.names[i]} needs a finite rest pose with a nonzero rotation`);
    for (let k = 0; k < 4; k++) rest[at + k] /= l;
  }
  return { names: [...pose.names], parents: [...pose.parents], rest };
}

/** A joint while it is being fitted. */
interface Build {
  spec: JointSpec;
  bone: number;
  covers: string[];
  ref: number;
  frame: Q4;
  long: V3;
  axes: [V3, V3, V3] | null;
}

/**
 * Fits a species table to a rig. Finds each table joint's bone (by the species' naming conventions, by `map`, or both),
 * reads the body's frame, stature and rest pose from the joint positions, and gives every joint its anatomical axes
 * and ranges. A rig bone that stands for several joints of a region (one spine bone for five vertebrae) gets their
 * summed range. Limits are on unless `limits: false`. A joint whose zero is a direction in the body (shoulder, hip,
 * thumb base) needs the joint at the far end of its segment mapped too: without it nothing shows where the segment
 * points at rest, and the joint is left unlimited rather than guessed.
 * @example
 * import { fitAnatomy, jointAngles } from '@margoengine/rigging/anatomy';
 * import { human } from '@margoengine/rigging/anatomy/human';
 *
 * const body = fitAnatomy(rig, { species: human });
 * console.log(body.restPose, jointAngles(body).l_elbow.flexion);
 * @param rig `{ names, parents, rest }` (as `retargetRig` makes it) or an array of `{ name, parent, position }`.
 * @param options The species, and optionally a naming convention, a joint map, `limits: false` or the facing.
 * @throws TypeError for a malformed rig or no species; RangeError when the root, or a left and right joint, cannot be
 * found, when two joints claim one bone, or when `map` or `roll` names an unknown joint or bone.
 */
export function fitAnatomy(rig: RigPose | readonly RigJoint[], options: FitOptions): AnatomicalRig {
  const species = options?.species;
  if (!species || !Array.isArray(species.joints))
    throw new TypeError(
      "fitAnatomy needs a species table: fitAnatomy(rig, { species: human }), with human from '@margoengine/rigging/anatomy/human'",
    );
  const { names, parents, rest } = poseOf(rig),
    n = names.length,
    order = parentOrder(parents, 'Rig'),
    position = worldFrames(parents, rest, order).position,
    restWorld = new Float64Array(n * 4),
    depth = new Int32Array(n);
  for (const b of order) {
    const p = parents[b];
    if (p < 0) restWorld.set(rest.subarray(b * 10 + 3, b * 10 + 7), b * 4);
    else {
      mulAt(restWorld, b * 4, restWorld, p * 4, rest, b * 10 + 3);
      depth[b] = depth[p] + 1;
    }
  }
  const specs = new Map(species.joints.map((spec) => [spec.id, spec])),
    identity: Q4 = [0, 0, 0, 1];

  // Which bone is which joint.
  const bones = new Map<string, number>();
  let preset: string | null = null;
  const found = species.naming?.(names, options.preset) ?? null;
  if (found) {
    preset = found.preset;
    for (const [id, bone] of found.joints) if (specs.has(id)) bones.set(id, bone);
  } else if (options.preset !== undefined)
    throw new RangeError(`No bones of this rig match the "${options.preset}" naming of the ${species.id} table`);
  for (const [id, ref] of Object.entries(options.map ?? {})) {
    if (!specs.has(id)) throw new RangeError(`options.map: "${id}" is not a joint of the ${species.id} table`);
    if (ref === null) {
      bones.delete(id);
      continue;
    }
    const bone = typeof ref === 'number' ? ref : names.indexOf(ref);
    if (!Number.isInteger(bone) || bone < 0 || bone >= n)
      throw new RangeError(`options.map.${id}: this rig has no bone ${String(ref)}`);
    bones.set(id, bone);
  }
  for (const [id, degrees] of Object.entries(options.roll ?? {}))
    if (!specs.has(id) || !Number.isFinite(degrees))
      throw new RangeError(
        `options.roll: "${id}" must be a joint of the ${species.id} table with a finite number of degrees`,
      );
  const root = species.joints[0];
  if (!bones.has(root.id))
    throw new RangeError(
      `This rig has no bone for ${root.id}, the root of the ${species.id} table; pass options.map: { ${root.id}: 'bone name' }`,
    );
  const taken = new Map<number, string>();
  for (const [id, bone] of bones) {
    const other = taken.get(bone);
    if (other)
      throw new RangeError(`Bone ${names[bone]} is mapped to both ${other} and ${id}; one bone turns at one joint`);
    taken.set(bone, id);
  }

  // A bone stands for the unmapped joints of its region nearest to it: those after it, and those before the first.
  const cover = new Map<string, string>();
  for (const id of bones.keys()) cover.set(id, id);
  for (const region of species.regions) {
    let last: string | null = null;
    const pending: string[] = [];
    for (const id of region.joints) {
      if (bones.has(id)) {
        last = id;
        for (const earlier of pending) cover.set(earlier, id);
        pending.length = 0;
      } else if (last) cover.set(id, last);
      else pending.push(id);
    }
  }
  const fitted: Build[] = [],
    slot = new Map<string, number>();
  for (const spec of species.joints) {
    const bone = bones.get(spec.id);
    if (bone === undefined) continue;
    slot.set(spec.id, fitted.length);
    fitted.push({ spec, bone, covers: [], ref: -1, frame: [0, 0, 0, 1], long: [0, 1, 0], axes: null });
  }
  for (const spec of species.joints) {
    const anchor = cover.get(spec.id);
    if (anchor !== undefined) fitted[slot.get(anchor)!].covers.push(spec.id);
  }
  /** The fitted joint that stands for `id` or the nearest joint above it, other than `self`. */
  const above = (id: string | null | undefined, self: number): number => {
    for (let at = id ?? null; at; at = specs.get(at)!.parent) {
      const anchor = cover.get(at);
      if (anchor !== undefined && slot.get(anchor) !== self) return slot.get(anchor)!;
    }
    return -1;
  };
  fitted.forEach((joint, k) => {
    joint.ref = above(joint.spec.reference ?? joint.spec.parent, k);
  });

  // The body frame, from landmarks.
  const P = (bone: number): V3 => [position[bone * 3], position[bone * 3 + 1], position[bone * 3 + 2]],
    at = (id: string): V3 | null => {
      const bone = bones.get(id);
      return bone === undefined ? null : P(bone);
    },
    first = (ids: readonly string[]): V3 | null => {
      for (const id of ids) {
        const p = at(id);
        if (p) return p;
      }
      return null;
    };
  let leftAt: V3 | null = null,
    rightAt: V3 | null = null;
  for (const [l, r] of species.frame.pairs) {
    const a = at(l),
      b = at(r);
    if (a && b && unit(sub(a, b))) {
      leftAt = a;
      rightAt = b;
      break;
    }
  }
  if (!leftAt || !rightAt)
    throw new RangeError(
      `This rig needs a left and a right joint to read its facing, such as ${species.frame.pairs[0]?.join(' and ')}; map them with options.map`,
    );
  const origin: V3 = [(leftAt[0] + rightAt[0]) / 2, (leftAt[1] + rightAt[1]) / 2, (leftAt[2] + rightAt[2]) / 2],
    width = Math.sqrt(dot(sub(leftAt, rightAt), sub(leftAt, rightAt))),
    tiny = width * 1e-6;
  let up: V3 | null = species.frame.up ? unit(species.frame.up) : null;
  if (!up) {
    const top = first(species.frame.top),
      low = first(species.frame.bottom);
    up = (top && unit(sub(top, origin), tiny)) || (low && unit(sub(origin, low), tiny)) || null;
  }
  let left = up && unit(reject(sub(leftAt, rightAt), up), tiny);
  if (!up || !left)
    throw new RangeError(
      'This rig needs a joint above or below its hips to read which way is up; map one with options.map',
    );
  let forward = cross(left, up),
    mirrored = false,
    ahead: V3 = options.forward ? [...options.forward] : [0, 0, 0];
  if (!options.forward)
    for (const [from, to] of species.frame.ahead) {
      const a = at(from),
        b = at(to);
      if (a && b) ahead = sub(ahead, reject(sub(a, b), up));
    }
  if (dot(ahead, forward) < -tiny) {
    mirrored = true;
    left = scaled(left, -1);
    forward = scaled(forward, -1);
  }
  let stature = 0;
  for (const span of species.stature) {
    const a = at(span.from),
      b = at(span.to);
    if (a && b && Math.abs(dot(sub(b, a), up)) > tiny) {
      stature = Math.abs(dot(sub(b, a), up)) / span.share;
      break;
    }
  }

  // Each segment's anatomical frame in the rest pose, parents first.
  const base = qbasis(left, up, forward),
    geometry = (spec: JointSpec): JointSpec => (mirrored && spec.mirror ? specs.get(spec.mirror)! : spec),
    toward = (from: V3, ids: readonly string[] | undefined, self: number): V3 | null => {
      for (const id of ids ?? []) {
        const bone = bones.get(id),
          d = bone === undefined || bone === self ? null : unit(sub(P(bone), from), tiny);
        if (d) return d;
      }
      return null;
    };
  fitted.forEach((joint, k) => {
    const { spec, bone } = joint,
      shape = geometry(spec),
      parentFrame: Q4 = joint.ref >= 0 ? fitted[joint.ref].frame : base,
      p = P(bone),
      far = toward(p, spec.distal, bone);
    let frame = parentFrame,
      long: V3 = [...shape.long],
      zeroKnown = true;
    if (spec.neutral === 'rest') {
      // The rest pose is zero. The twist is measured about the segment as the rig has it, when that is close.
      const seen = far && qrot(qconj(parentFrame), far);
      if (seen && dot(seen, long) > 0.5) long = seen;
    } else {
      const into = spec.neutral === 'straight' && joint.ref >= 0 ? unit(sub(p, P(fitted[joint.ref].bone)), tiny) : null,
        zero = into ?? qrot(parentFrame, long),
        along = far ?? zero;
      if (far) frame = qmul(qswing(zero, far), parentFrame);
      if (spec.neutral === 'straight') long = unit(qrot(qconj(parentFrame), zero))!;
      // A hinge below that is bent in the rest pose shows how this segment is rolled: a joint bends about its axis.
      for (let c = k + 1; c < fitted.length; c++) {
        const child = fitted[c],
          below = child.spec;
        if (child.ref !== k || below.kind !== 'hinge' || below.neutral !== 'straight' || !below.dofs) continue;
        const pc = P(child.bone),
          into2 = unit(sub(pc, p), tiny),
          out = toward(pc, below.distal, child.bone);
        if (!into2 || !out) continue;
        const bend = Math.acos(Math.min(1, Math.max(-1, dot(into2, out))));
        if (bend < BEND_MIN) continue;
        const hinge = unit(cross(into2, out)),
          expected = unit(reject(qrot(frame, geometry(below).dofs![0].axis), into2));
        if (hinge && expected) {
          const roll = Math.atan2(dot(cross(expected, hinge), into2), dot(expected, hinge));
          if (bend >= BEND_SURE || Math.abs(roll) <= TWIST_TRUST) frame = qmul(qaxis(into2, roll), frame);
        }
        break;
      }
      // Two joints across the segment below (the knuckles) show the roll of this one: a wrist does not twist.
      for (let c = k + 1; c < fitted.length; c++) {
        const child = fitted[c],
          below = child.spec;
        if (child.ref !== k || !below.across) continue;
        let line: V3 | null = null;
        for (const [a, b] of below.across.pairs) {
          const pa = at(a),
            pb = at(b);
          if (pa && pb) {
            line = sub(pb, pa);
            break;
          }
        }
        if (!line) continue;
        const pc = P(child.bone),
          into2 = unit(sub(pc, p), tiny) ?? along,
          out = toward(pc, below.distal, child.bone) ?? into2,
          hand = qmul(qswing(into2, out), frame),
          want = unit(reject(qrot(hand, geometry(below).across!.neutral), out)),
          have = unit(reject(line, out), tiny);
        if (want && have) frame = qmul(qaxis(along, Math.atan2(dot(cross(want, have), out), dot(want, have))), frame);
        break;
      }
      const roll = options.roll?.[spec.id];
      if (roll) frame = qmul(qaxis(along, roll * RAD), frame);
      // A zero that is a direction in the body cannot be read without the far end of the segment.
      if (spec.neutral === 'body' && !far) zeroKnown = false;
    }
    joint.frame = frame;
    joint.long = long;
    if (shape.dofs && zeroKnown) {
      const flex = unit(reject(shape.dofs[0].axis, long));
      if (!flex)
        throw new RangeError(
          `${spec.id}: its segment lies along its own flexion axis in this rig; check the joint map`,
        );
      const side = cross(long, flex);
      joint.axes = [
        flex,
        dot(side, shape.dofs[1].axis) < 0 ? scaled(side, -1) : side,
        scaled(long, dot(shape.dofs[2].axis, long) < 0 ? -1 : 1),
      ];
    }
  });

  // The public joints.
  const regionOf = new Map(species.regions.map((region) => [region.id, region])),
    total = (ids: readonly string[], tier: Tier): number[] => {
      const r = [0, 0, 0, 0, 0, 0];
      for (const id of ids) {
        const dofs = specs.get(id)!.dofs;
        if (dofs)
          for (let s = 0; s < 3; s++) {
            r[s * 2] = Math.max(-180, r[s * 2] - dofs[s].min[tier]);
            r[s * 2 + 1] = Math.min(180, r[s * 2 + 1] + dofs[s].max[tier]);
          }
      }
      return r;
    },
    restQ = (bone: number): Q4 => [
      restWorld[bone * 4],
      restWorld[bone * 4 + 1],
      restWorld[bone * 4 + 2],
      restWorld[bone * 4 + 3],
    ],
    local = fitted.map((joint) => qmul(qconj(restQ(joint.bone)), joint.frame));
  const joints: AnatomicalJoint[] = fitted.map((joint, k) => {
    const { spec, bone, ref } = joint,
      region = spec.region ? regionOf.get(spec.region)! : null,
      limited = !!joint.axes && ref >= 0,
      axes: [V3, V3, V3] = joint.axes ?? [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      parentFrame: Q4 = ref >= 0 ? fitted[ref].frame : base,
      parentBone = parents[bone],
      zero = qmul(parentFrame, qconj(local[k])),
      atRest: Q4 = [rest[bone * 10 + 3], rest[bone * 10 + 4], rest[bone * 10 + 5], rest[bone * 10 + 6]],
      neutral: Q4 = !limited ? atRest : parentBone < 0 ? zero : qmul(qconj(restQ(parentBone)), zero),
      referenceFrame: Q4 = ref >= 0 ? local[ref] : identity,
      side: Side = mirrored && spec.side !== 'centre' ? (spec.side === 'left' ? 'right' : 'left') : spec.side;
    return {
      id: spec.id,
      spec,
      bone,
      reference: ref >= 0 ? fitted[ref].bone : -1,
      covers: joint.covers,
      side,
      kind: spec.kind,
      region: spec.region ?? null,
      limited,
      long: joint.long,
      axes,
      boneAxes: [qrot(local[k], axes[0]), qrot(local[k], axes[1]), qrot(local[k], axes[2])],
      frame: local[k],
      referenceFrame,
      neutral,
      rest: { flexion: 0, abduction: 0, rotation: 0 },
      normal: total(joint.covers, 'normal'),
      structural: total(region?.shared ? region.joints : joint.covers, 'structural'),
    };
  });
  const index = new Map<string, number>();
  joints.forEach((joint, k) => {
    for (const id of joint.covers) index.set(id, k);
  });
  const regions: AnatomicalRegion[] = [];
  for (const region of species.regions) {
    const members = region.joints.flatMap((id) => (slot.has(id) ? [slot.get(id)!] : []));
    if (region.shared && members.length && joints[members[0]].limited)
      regions.push({
        id: region.id,
        joints: members,
        normal: total(region.joints, 'normal'),
        structural: total(region.joints, 'structural'),
      });
  }

  const body: AnatomicalRig = {
    species,
    names,
    parents,
    rest,
    neutral: rest.slice(),
    frame: { origin, left, up, forward },
    mirrored,
    stature,
    restPose: '',
    preset,
    limits: options.limits !== false,
    joints,
    regions,
    index,
  };
  const sorted = joints
    .map((joint, k) => [joint, k] as const)
    .sort((a, b) => depth[a[0].bone] - depth[b[0].bone] || a[1] - b[1]);
  WORK.set(body, {
    order: sorted.map(([joint]) => joint),
    spills: joints.flatMap((joint, k) =>
      joint.limited && joint.spec.dofs![2].spill && fitted[k].ref >= 0 && joints[fitted[k].ref].limited
        ? [[joint, joints[fitted[k].ref]] as const]
        : [],
    ),
    world: new Float64Array(n * 4),
    stamp: new Uint32Array(n),
    stack: new Int32Array(n),
    q: new Float64Array(16),
    v: new Float64Array(3),
    w: new Float64Array(3),
    tick: 0,
  });
  const angles = jointAngles(body, rest);
  for (const joint of joints) if (joint.limited) Object.assign(joint.rest, angles[joint.id]);
  const zeros: Record<string, JointAngles> = {};
  for (const joint of joints) if (joint.limited) zeros[joint.id] = { flexion: 0, abduction: 0, rotation: 0 };
  body.neutral.set(poseFromAngles(body, zeros));
  (body as { restPose: string }).restPose = species.describeRest?.(angles) ?? 'rest';
  return body;
}

function checkPose(body: AnatomicalRig, pose: ArrayLike<number>, what: string): void {
  if (!pose || pose.length !== body.names.length * 10)
    throw new TypeError(`${what} needs a local pose with 10 numbers per bone (translation, rotation xyzw, scale)`);
}

/**
 * The angles of every limited joint in a pose, as a flat array for a solver that runs each frame: three numbers per
 * entry of `body.joints` (first swing, second swing, twist; degrees; zeros for a free joint). Allocates nothing when
 * `out` is passed.
 * @throws TypeError for a pose or `out` of the wrong length.
 */
export function readJointAngles(
  body: AnatomicalRig,
  pose: ArrayLike<number> = body.rest,
  out?: Float64Array,
): Float64Array {
  const work = workOf(body);
  checkPose(body, pose, 'readJointAngles');
  const result = out ?? new Float64Array(body.joints.length * 3);
  if (result.length !== body.joints.length * 3)
    throw new TypeError('readJointAngles: out needs 3 numbers per fitted joint');
  work.tick++;
  body.joints.forEach((joint, k) => {
    if (joint.limited) {
      measure(body, work, pose, joint, work.v);
      result.set(work.v, k * 3);
    } else result.fill(0, k * 3, k * 3 + 3);
  });
  return result;
}

/**
 * The clinical angles of every limited joint in a pose, in degrees, keyed by joint id. `flexion` and `abduction` are the
 * two parts of the swing away from neutral and `rotation` is the twist about the segment; each joint names them in its
 * own terms in `body.joints[i].spec.dofs` (a wrist's second swing is radial deviation). The same body reads the same
 * angles whatever its rest pose or bone axes.
 * @example
 * const { l_knee } = jointAngles(body, pose);
 * if (l_knee.flexion < 0) console.log('the left knee is past straight by', -l_knee.flexion, 'degrees');
 * @param pose A local pose, 10 numbers per bone. Default: the rest pose.
 * @throws TypeError for a pose of the wrong length or a body not made by {@link fitAnatomy}.
 */
export function jointAngles(body: AnatomicalRig, pose: ArrayLike<number> = body.rest): Record<string, JointAngles> {
  const flat = readJointAngles(body, pose),
    out: Record<string, JointAngles> = {};
  body.joints.forEach((joint, k) => {
    if (joint.limited) out[joint.id] = { flexion: flat[k * 3], abduction: flat[k * 3 + 1], rotation: flat[k * 3 + 2] };
  });
  return out;
}

/**
 * How each straight limb is rolled, read from motion. A hinge turns about one axis, so over a clip its swing lies along
 * one line; where that line leaves the flexion axis the fit took, the segment above the hinge is rolled by that angle in
 * the rest pose. A straight arm with no knuckle bones shows no roll in its joint positions, and motion capture
 * skeletons are often rolled (the CMU skeleton's upper arms by about 20 degrees). Returns degrees by the id of the joint
 * above each hinge whose swing reached 30 degrees somewhere in the poses: pass them as `roll` and fit again.
 * @example
 * const first = fitAnatomy(rig, { species: human });
 * const body = fitAnatomy(rig, { species: human, roll: hingeRolls(first, frames) });
 * @param poses Local poses of the motion, 10 numbers per bone each; one buffer may be reused between steps.
 * @throws TypeError for a pose of the wrong length.
 */
export function hingeRolls(body: AnatomicalRig, poses: Iterable<ArrayLike<number>>): Record<string, number> {
  const work = workOf(body),
    hinges = body.joints.filter(
      (joint) => joint.limited && joint.kind === 'hinge' && joint.spec.neutral === 'straight',
    ),
    // Per hinge: sums of f*a, f*f - a*a, f and a over the poses, and the largest swing seen.
    sums = hinges.map(() => [0, 0, 0, 0, 0]);
  for (const pose of poses) {
    checkPose(body, pose, 'hingeRolls');
    work.tick++;
    hinges.forEach((joint, k) => {
      measure(body, work, pose, joint, work.v);
      const f = work.v[0],
        a = work.v[1],
        sum = sums[k];
      sum[0] += f * a;
      sum[1] += f * f - a * a;
      sum[2] += f;
      sum[3] += a;
      sum[4] = Math.max(sum[4], Math.hypot(f, a));
    });
  }
  const out: Record<string, number> = {};
  hinges.forEach((joint, k) => {
    const above = body.joints.find((candidate) => candidate.bone === joint.reference),
      sum = sums[k];
    if (!above || above.spec.neutral === 'rest' || sum[4] < 30) return;
    // The line the swing lies along, as an angle from the flexion axis toward the second axis; a joint flexes forward
    // along it, so a line that points mostly backward is the same line turned half way round.
    let line = 0.5 * Math.atan2(2 * sum[0], sum[1]);
    if (sum[2] * Math.cos(line) + sum[3] * Math.sin(line) < 0) line += line > 0 ? -Math.PI : Math.PI;
    // Rolling the segment above about its length turns that line the other way in a right-handed pair of axes.
    const [flex, side] = joint.axes;
    out[above.id] = (dot(cross(joint.long, flex), side) >= 0 ? line : -line) * DEG;
  });
  return out;
}

/** The span from a region's reference to its last bone. */
const regionSpan = (body: AnatomicalRig, region: AnatomicalRegion): Span => {
  const firstJoint = body.joints[region.joints[0]],
    last = body.joints[region.joints.at(-1)!];
  return {
    bone: last.bone,
    reference: firstJoint.reference,
    frame: last.frame,
    referenceFrame: firstJoint.referenceFrame,
    axes: firstJoint.axes,
  };
};

/**
 * The angles of each shared region's far end against its reference: the head against the chest, the chest against the
 * pelvis. This is what a clinical table of the neck or trunk measures, whatever number of bones the rig spends on it.
 * @throws TypeError for a pose of the wrong length.
 */
export function regionAngles(body: AnatomicalRig, pose: ArrayLike<number> = body.rest): Record<string, JointAngles> {
  const work = workOf(body),
    out: Record<string, JointAngles> = {};
  checkPose(body, pose, 'regionAngles');
  work.tick++;
  for (const region of body.regions) {
    measure(body, work, pose, regionSpan(body, region), work.v);
    out[region.id] = { flexion: work.v[0], abduction: work.v[1], rotation: work.v[2] };
  }
  return out;
}

/**
 * The pose that has the given angles: the inverse of {@link jointAngles}. Joints left out keep the base pose, and so do
 * the motions left out of a joint.
 * @example
 * const pose = poseFromAngles(body, { r_elbow: { flexion: 90 }, r_shoulder: { abduction: 45 } });
 * @param angles Degrees per joint id.
 * @param base The pose to start from. Default: the rest pose.
 * @returns A new local pose, 10 numbers per bone.
 * @throws RangeError for an id that is not a limited joint of the body; TypeError for a base of the wrong length.
 */
export function poseFromAngles(
  body: AnatomicalRig,
  angles: Readonly<Record<string, Partial<JointAngles>>>,
  base: ArrayLike<number> = body.rest,
): Float64Array {
  const work = workOf(body);
  checkPose(body, base, 'poseFromAngles');
  for (const id of Object.keys(angles)) {
    const k = body.index.get(id);
    if (k === undefined || body.joints[k].id !== id || !body.joints[k].limited)
      throw new RangeError(
        `poseFromAngles: "${id}" is not a limited joint of this body; its joints are in body.joints`,
      );
  }
  const pose = Float64Array.from(base);
  work.tick++;
  for (const joint of work.order) {
    const want = angles[joint.id];
    if (!want || !joint.limited) continue;
    measure(body, work, pose, joint, work.v);
    if (want.flexion !== undefined) work.v[0] = want.flexion;
    if (want.abduction !== undefined) work.v[1] = want.abduction;
    if (want.rotation !== undefined) work.v[2] = want.rotation;
    if (!(Number.isFinite(work.v[0]) && Number.isFinite(work.v[1]) && Number.isFinite(work.v[2])))
      throw new RangeError(`poseFromAngles: ${joint.id} needs finite degrees`);
    write(body, work, pose, joint, work.v);
  }
  return pose;
}

const range = (item: AnatomicalJoint | AnatomicalRegion, tier: Tier): readonly number[] =>
  tier === 'normal' ? item.normal : item.structural;
const gateOf = (joint: AnatomicalJoint): Gate | null => joint.spec.dofs?.[2].gate ?? null;

/**
 * Brings a pose inside the body's ranges, in place: each joint's swing back inside its reach, its twist back inside its
 * range, a hinge back to its stop, and each shared region (neck, trunk) back inside its budget by easing every bone of
 * the run. A hand's twist past its wrist moves into the forearm, which leaves the hand where it was. The default tier
 * is `structural`: the stops no body passes. A pose already inside is not touched.
 * @example
 * const issues = [];
 * if (clampPose(body, pose, { issues })) console.warn(issues.map((issue) => `${issue.joint} ${issue.motion} ${issue.value.toFixed(1)}`));
 * @param pose A local pose, 10 numbers per bone, edited in place.
 * @returns How many motions were brought back; 0 when the body was fitted with `limits: false`.
 * @throws TypeError for a pose that is not a Float64Array of the right length.
 */
export function clampPose(body: AnatomicalRig, pose: Float64Array, options: ClampOptions = {}): number {
  const work = workOf(body),
    tier = options.tier ?? 'structural',
    { v, w } = work;
  if (!(pose instanceof Float64Array)) throw new TypeError('clampPose needs the pose as a Float64Array');
  checkPose(body, pose, 'clampPose');
  if (!body.limits && !options.force) return 0;
  let count = 0;
  const report = (item: AnatomicalJoint | AnatomicalRegion, bone: number, dofs: JointSpec['dofs']) => {
    for (let s = 0; s < 3; s++) {
      if (Math.abs(w[s] - v[s]) <= 1e-6) continue;
      count++;
      const dof = dofs![s];
      options.issues?.push({
        joint: item.id,
        bone,
        motion: w[s] >= 0 ? dof.positive : dof.negative,
        value: w[s],
        limit: v[s],
        tier,
        source: (w[s] >= 0 ? dof.max : dof.min).rows[0]?.source ?? null,
      });
    }
  };
  // 1. Twist past a wrist's range moves into the forearm: the hand keeps its place and the forearm turns with it.
  work.tick++;
  for (const [joint, above] of work.spills) {
    measure(body, work, pose, joint, v);
    const r = range(joint, tier),
      excess = v[2] - Math.min(r[5], Math.max(r[4], v[2]));
    if (Math.abs(excess) <= TOLERANCE) continue;
    count++;
    const twist = joint.spec.dofs![2];
    options.issues?.push({
      joint: joint.id,
      bone: joint.bone,
      motion: v[2] >= 0 ? twist.positive : twist.negative,
      value: v[2],
      limit: v[2] - excess,
      tier,
      source: (v[2] >= 0 ? twist.max : twist.min).rows[0]?.source ?? null,
    });
    const child = worldOf(body, work, pose, joint.bone),
      kept: Q4 = [work.world[child], work.world[child + 1], work.world[child + 2], work.world[child + 3]],
      turn = qmul(qmul(above.frame, qaxis(joint.axes[2], excess * RAD)), qconj(above.frame)),
      at = above.bone * 10 + 3;
    pose.set(qmul([pose[at], pose[at + 1], pose[at + 2], pose[at + 3]], turn), at);
    work.tick++;
    const parent = body.parents[joint.bone],
      over = parent < 0 ? null : worldOf(body, work, pose, parent);
    pose.set(
      over === null
        ? kept
        : qmul(qconj([work.world[over], work.world[over + 1], work.world[over + 2], work.world[over + 3]]), kept),
      joint.bone * 10 + 3,
    );
    work.tick++;
  }
  // 2. Each joint, ancestors first.
  work.tick++;
  for (const joint of work.order) {
    if (!joint.limited) continue;
    measure(body, work, pose, joint, v);
    w.set(v);
    if (!clampAngles(v, range(joint, tier), gateOf(joint), 2)) continue;
    write(body, work, pose, joint, v);
    report(joint, joint.bone, joint.spec.dofs);
  }
  // 3. Each shared region: the far end against the reference, eased across every bone of the run.
  for (const region of body.regions) {
    const span = regionSpan(body, region),
      dofs = body.joints[region.joints[0]].spec.dofs;
    for (let pass = 0; pass < 8; pass++) {
      work.tick++;
      measure(body, work, pose, span, v);
      w.set(v);
      if (!clampAngles(v, range(region, tier), null, 2)) break;
      if (pass === 0) report(region, -1, dofs);
      const ease = [0, 1, 2].map((s) => (Math.abs(w[s]) > 1e-9 ? v[s] / w[s] : 1));
      for (const k of region.joints) {
        const joint = body.joints[k];
        work.tick++;
        measure(body, work, pose, joint, v);
        for (let s = 0; s < 3; s++) v[s] *= ease[s];
        write(body, work, pose, joint, v);
      }
    }
  }
  return count;
}

/** A joint's limit in the hinge and cone forms the older solvers hold. */
function shaped(joint: AnatomicalJoint, tier: Tier): { neutral: Q4; limit: CCDJointLimit } {
  const r = range(joint, tier),
    [flex, , twist] = joint.boneAxes,
    twistRange: [number, number] = [r[4] * RAD, r[5] * RAD];
  if (joint.kind === 'hinge')
    return {
      neutral: [...joint.neutral],
      limit: {
        type: 'hinge',
        axis: [...flex],
        min: r[0] * RAD,
        max: r[1] * RAD,
        ...(twistRange[0] || twistRange[1] ? { twist: { axis: [...twist], range: twistRange } } : {}),
      },
    };
  // A cone about the middle of the reach, as wide as the wider half of it.
  const f = ((r[0] + r[1]) / 2) * RAD,
    a = ((r[2] + r[3]) / 2) * RAD,
    [F, A] = joint.axes,
    s: V3 = [f * F[0] + a * A[0], f * F[1] + a * A[1], f * F[2] + a * A[2]],
    angle = Math.sqrt(dot(s, s)),
    middle: Q4 = angle > 1e-12 ? qaxis(scaled(s, 1 / angle), angle) : [0, 0, 0, 1];
  return {
    neutral: qmul(joint.neutral, qmul(qmul(joint.frame, middle), qconj(joint.frame))),
    limit: {
      type: 'cone',
      angle: Math.min(Math.PI, (Math.max(r[1] - r[0], r[3] - r[2]) / 2) * RAD),
      axis: [...twist],
      twist: twistRange,
    },
  };
}

/**
 * The body's limits as `PoseJointLimit`s for `PoseJointLimits` and `addPoseJointLimits` in
 * `@margoengine/rigging/joint-limits`. A hinge (elbow, knee, finger joint) is exact, with its twist. A joint that
 * reaches further one way than the other is given the nearest cone those limits can hold: about the middle of its
 * reach, as wide as the wider half. {@link clampPose} holds the exact reach.
 * @param tier Which range. Default `structural`.
 */
export function poseLimits(body: AnatomicalRig, tier: Tier = 'structural'): PoseJointLimit[] {
  workOf(body);
  return body.joints.flatMap((joint) => (joint.limited ? [{ joint: joint.bone, ...shaped(joint, tier) }] : []));
}

/**
 * The limits of a chain of bones, in the chain's order, for an IK solver: one `PoseJointLimit` per bone (the rotation
 * the limit is measured from, and the limit), or null for a bone with no joint.
 * @param chain Bone indices or names.
 * @throws RangeError for a bone the rig does not have.
 */
export function ikLimits(
  body: AnatomicalRig,
  chain: readonly (number | string)[],
  tier: Tier = 'structural',
): (PoseJointLimit | null)[] {
  workOf(body);
  return chain.map((item) => {
    const bone = typeof item === 'number' ? item : body.names.indexOf(item);
    if (!Number.isInteger(bone) || bone < 0 || bone >= body.names.length)
      throw new RangeError(`ikLimits: this rig has no bone ${String(item)}`);
    const joint = body.joints.find((candidate) => candidate.bone === bone);
    return joint?.limited ? { joint: bone, ...shaped(joint, tier) } : null;
  });
}

/**
 * The body's limits for a ragdoll, relative to the rest pose the ragdoll is built in: a hinge about its anatomical axis
 * (so a knee folds back and an elbow forward whatever the rest pose), and for every other joint a cone about its rest
 * direction wide enough to hold its reach, with its twist range.
 */
export function ragdollJoints(body: AnatomicalRig, tier: Tier = 'structural'): RagdollJointLimit[] {
  workOf(body);
  return body.joints.flatMap((joint): RagdollJointLimit[] => {
    if (!joint.limited) return [];
    const r = range(joint, tier),
      { flexion, abduction, rotation } = joint.rest,
      twist: [number, number] = [(r[4] - rotation) * RAD, (r[5] - rotation) * RAD];
    if (joint.kind === 'hinge')
      return [
        {
          bone: joint.bone,
          name: body.names[joint.bone],
          joint: {
            type: 'hinge',
            axis: [...joint.boneAxes[0]],
            limits: [(r[0] - flexion) * RAD, (r[1] - flexion) * RAD],
          },
        },
      ];
    const swing = Math.max(
      Math.abs(r[0] - flexion),
      Math.abs(r[1] - flexion),
      Math.abs(r[2] - abduction),
      Math.abs(r[3] - abduction),
    );
    return [
      {
        bone: joint.bone,
        name: body.names[joint.bone],
        joint: { type: 'cone', swing: Math.min(180, swing) * RAD, twist },
      },
    ];
  });
}

/**
 * The body's limits for `JointLimitSet` in `@margoengine/kinematics-constraints`, one per bone asked for (null for a
 * bone with no joint), measured from the anatomical neutral: pass it rotations taken relative to `body.neutral`.
 * @param bones Bone indices or names. Default: every fitted joint's bone, in `body.joints` order.
 * @throws RangeError for a bone the rig does not have.
 */
export function kinematicsLimits(
  body: AnatomicalRig,
  bones: readonly (number | string)[] = body.joints.map((joint) => joint.bone),
  tier: Tier = 'structural',
): (KinematicsJointLimit | null)[] {
  workOf(body);
  return bones.map((item) => {
    const bone = typeof item === 'number' ? item : body.names.indexOf(item);
    if (!Number.isInteger(bone) || bone < 0 || bone >= body.names.length)
      throw new RangeError(`kinematicsLimits: this rig has no bone ${String(item)}`);
    const joint = body.joints.find((candidate) => candidate.bone === bone);
    if (!joint?.limited) return null;
    const r = range(joint, tier);
    if (joint.kind === 'hinge')
      return { type: 'hinge', axis: [...joint.boneAxes[0]], min: r[0] * RAD, max: r[1] * RAD };
    return {
      type: 'cone',
      axis: [...joint.boneAxes[2]],
      angle: Math.min(180, Math.max(-r[0], r[1], -r[2], r[3])) * RAD,
      twist: [r[4] * RAD, r[5] * RAD],
    };
  });
}

/**
 * Holds an Animator's pose inside the body's ranges every frame, after the pose and the solvers added before it. The
 * body must be fitted to the Animator's own model, bone for bone. Returns the remover.
 * @example
 * const stop = addAnatomyLimits(animator, body);
 * @param options `tier` (default `structural`) and `onClamp`, called with what was brought back on a frame that needed it.
 * @throws RangeError when the body and the Animator's model differ in bone count.
 */
export function addAnatomyLimits(
  animator: Animator,
  body: AnatomicalRig,
  options: { tier?: Tier; onClamp?: (issues: readonly ClampIssue[]) => void } = {},
): () => void {
  workOf(body);
  const nodes = animator.animation.model.nodes,
    n = nodes.length;
  if (n !== body.names.length)
    throw new RangeError(
      `addAnatomyLimits: the body has ${body.names.length} bones and the Animator's model ${n}; fit the body to that model`,
    );
  const store = animator.animation.model.root.engine.store,
    t = store.transforms,
    pose = body.rest.slice(),
    before = new Float64Array(n * 4),
    rotation = [0, 0, 0, 1],
    limited = body.joints.flatMap((joint) => (joint.limited ? [joint.bone] : [])),
    issues: ClampIssue[] = [];
  return animator.addSolver(() => {
    for (let i = 0; i < n; i++) {
      const { id } = nodes[i],
        at = i * 10 + 3;
      before[i * 4] = pose[at] = t.qx[id];
      before[i * 4 + 1] = pose[at + 1] = t.qy[id];
      before[i * 4 + 2] = pose[at + 2] = t.qz[id];
      before[i * 4 + 3] = pose[at + 3] = t.qw[id];
    }
    issues.length = 0;
    clampPose(body, pose, options.onClamp ? { tier: options.tier, issues } : { tier: options.tier });
    let wrote = false;
    for (const bone of limited) {
      const at = bone * 10 + 3;
      let same = true;
      for (let i = 0; i < 4; i++) if (pose[at + i] !== before[bone * 4 + i]) same = false;
      if (same) continue;
      for (let i = 0; i < 4; i++) rotation[i] = pose[at + i];
      animator.writeNodeRotation(nodes[bone], rotation);
      wrote = true;
    }
    if (wrote) store.tick(false);
    if (issues.length) options.onClamp?.(issues);
  });
}
