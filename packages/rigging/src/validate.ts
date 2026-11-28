// The pose checker: for any body fitted with `fitAnatomy`, which joints of a pose or of every frame of a clip pass their
// measured stops, by how much they miss, and which look wrong inside them (an elbow or knee past straight, a hinge
// bending sideways, a bone that stretched, a foot through the ground, a limb through another, a foot sliding while
// planted, a joint that jumps faster than any body turns). It reads only the species table, so a horse table checks a
// horse. Every issue names the joint, the measured value, the limit, the limit's source and where to read more.
//
// Method, written clean room from these papers, standards and data (no other engine's or tool's source was read):
// - Ranges and their two tiers: the species table (`@margoengine/rigging/anatomy`), held by `clampPose`; a pose is
//   checked on a copy, so the checker measures what the clamp would change. Clinical tier: a warning. Stop: an error.
// - Limb volumes: each segment a capsule of the measured mean girth (ANSUR II, Gordon et al. 2014, NATICK/TR-15/007),
//   radius = circumference / 2 pi; the closest points of two segments as in Ericson, "Real-Time Collision Detection",
//   Morgan Kaufmann 2005, section 5.1.9. Only a pass deeper than `1 - shrink` of the two radii counts, so soft
//   contact (an arm against the side, crossed arms) is not a fault.
// - Planted feet that slide: footskate, as Kovar, Schreiner and Gleicher name and clean it ("Footskate cleanup for
//   motion capture editing", ACM SIGGRAPH/Eurographics Symposium on Computer Animation 2002,
//   https://doi.org/10.1145/545261.545277). A foot is planted while it stays within `contact` of its lowest height for
//   three frames running; it slides when it moves faster than `slide` along the ground then.
// - The fastest joint motion people make: shoulder internal rotation in throwing, peak means of 6,594 to 6,756 degrees
//   per second, standard deviations 743 to 893, and elbow extension 2,305 to 2,326 (Fleisig et al., "Biomechanical
//   analysis of weighted-ball exercises for baseball pitchers", Sports Health 9(3):210-215, 2017,
//   https://pmc.ncbi.nlm.nih.gov/articles/PMC5435148/). The default `maxSpeed` of 9,000 is their mean plus three
//   standard deviations; a capture pop (a joint flipping in one frame) is also caught as a lone spike between slower
//   neighbours at any frame rate.
import { margoError } from '../../shared/errors.js';
import {
  clampPose,
  readJointAngles,
  type AnatomicalRig,
  type ClampIssue,
  type JointSpec,
  type Tier,
  type Vec3,
} from './anatomy.js';
import { bodyVolumes, closestSegments, type BodyVolume } from './body-volumes.js';
import { parentOrder, worldFrames } from './rig.js';

/** What an issue is. */
export type PoseIssueCode =
  /** A swing past the joint's range. */
  | 'out-of-range'
  /** A hinge (elbow, knee, finger) bent past straight the wrong way. */
  | 'hinge-reversed'
  /** A hinge bent sideways, across its one axis. */
  | 'hinge-sideways'
  /** A twist past the joint's range. */
  | 'twist-out-of-range'
  /** A bone longer or shorter than at rest, or scaled. */
  | 'bone-stretch'
  /** A joint, or a point of the skin, below the ground. */
  | 'ground-penetration'
  /** A joint that should bear weight held off the ground. */
  | 'floating'
  /** Two limb volumes through each other. */
  | 'self-penetration'
  /** A planted foot moving along the ground. */
  | 'foot-slide'
  /** A joint turning faster than any body turns, or jumping in one frame. */
  | 'pop'
  /** A body measure outside what people measure. */
  | 'proportion'
  /** The left and right of a measure differing. */
  | 'asymmetry';

/** `error`: no body does this. `warning`: inside the stops but outside the clinical range or what looks right. */
export type PoseSeverity = 'error' | 'warning';

/** One thing wrong with a pose. */
export interface PoseIssue {
  /** What it is. */
  readonly code: PoseIssueCode;
  /** How bad. */
  readonly severity: PoseSeverity;
  /** The table joint, region or measure, or two volumes as `a + b`. */
  readonly joint: string;
  /** The rig bone's name, or null. */
  readonly bone: string | null;
  /** The clinical motion for an angle (such as `hyperextension`), or null. */
  readonly motion: string | null;
  /** What was measured, in `unit`. */
  readonly value: number;
  /** The limit it was measured against, in `unit`. */
  readonly limit: number;
  /** How far past the limit, in `unit`, never negative. */
  readonly excess: number;
  /** `deg`, `deg/s`, `stature` (a share of the body's height), `stature/s` or `ratio`. */
  readonly unit: 'deg' | 'deg/s' | 'stature' | 'stature/s' | 'ratio';
  /** The range tier, for an angle. */
  readonly tier: Tier | null;
  /** The key of the limit's first source in the species table, or null. */
  readonly source: string | null;
  /** The clip time in seconds, for a clip; null for one pose. */
  readonly time: number | null;
  /** The frame index, for a clip; null for one pose. */
  readonly frame: number | null;
  /** The issue in words. */
  readonly message: string;
  /** Where to read what it means and how to fix it. */
  readonly help: string;
}

/** Options of {@link checkPose}. */
export interface PoseCheckOptions {
  /** `normal` checks the clinical range only, `structural` the stops only, `both` (default) each with its severity. */
  readonly tier?: Tier | 'both';
  /** Degrees by which an angle may pass its limit before it counts, for noise. Default 0.5. */
  readonly tolerance?: number;
  /** Height of the ground along the body's up, in the rig's space, or null for no ground tests. Default null. */
  readonly ground?: number | null;
  /** Skin points in the rig's space (x, y, z, ...), tested against the ground as well as the joints. */
  readonly points?: ArrayLike<number>;
  /** Table joints that bear weight in this pose: each must be within `float` of the ground. Default none. */
  readonly supports?: readonly string[];
  /** Shares of stature a support may sit above the ground before it floats. Default 0.06. */
  readonly float?: number;
  /** Shares of stature below the ground a joint or point may sink before it counts. Default 0.002. */
  readonly sink?: number;
  /** Test limbs through limbs with the table's volumes. Default true. */
  readonly volumes?: boolean;
  /** Share of the two radii a pass must reach into before it counts as one limb through another. Default 0.7. */
  readonly shrink?: number;
  /** Share by which a bone's length or scale may differ from rest. Default 0.01. */
  readonly stretch?: number;
}

/** Options of {@link checkClip}. */
export interface ClipCheckOptions extends PoseCheckOptions {
  /** Frames per second the clip is sampled at. Default 30. */
  readonly fps?: number;
  /** Seconds, needed when `sample` is a function. */
  readonly duration?: number;
  /** Time of the first frame. Default 0. */
  readonly start?: number;
  /** How the body travels through the world (rig units per second), for a clip played in place. Default none. */
  readonly velocity?: Vec3;
  /** Degrees per second no joint reaches. Default 9,000. */
  readonly maxSpeed?: number;
  /** Shares of stature above its lowest a foot joint may be and still be planted. Default 0.02. */
  readonly contact?: number;
  /** Shares of stature per second a planted foot may move along the ground. Default 0.1. */
  readonly slide?: number;
}

/** One issue over a clip: how often it happens, when, and its worst frame. */
export interface ClipIssueSummary {
  readonly code: PoseIssueCode;
  readonly severity: PoseSeverity;
  readonly joint: string;
  readonly motion: string | null;
  /** Frames it happens in. */
  readonly frames: number;
  /** Time of the first and last of them. */
  readonly first: number;
  readonly last: number;
  /** The frame where it is furthest past its limit. */
  readonly worst: PoseIssue;
}

/** What {@link checkPose} returns. */
export interface PoseReport {
  /** True when no issue is an error. */
  readonly passed: boolean;
  readonly errors: number;
  readonly warnings: number;
  /** Every issue, worst first within each code. */
  readonly issues: readonly PoseIssue[];
}

/** What {@link checkClip} returns. */
export interface ClipReport extends PoseReport {
  /** Frames checked. */
  readonly frames: number;
  readonly fps: number;
  /** One row per joint, motion and code, errors first, then by how often. */
  readonly summary: readonly ClipIssueSummary[];
}

/** Options of {@link checkProportions}. */
export interface ProportionCheckOptions {
  /** The body's real standing height in rig units, when known (from its skin). Default: the fitted body's stature. */
  readonly stature?: number;
  /** Share by which a left and a right measure may differ. Default 0.05. */
  readonly asymmetry?: number;
}

/** The README section that explains each issue code. */
export const POSE_HELP = 'https://margoengine.com/llms/packages/rigging.md#pose-checks-margoengineriggingvalidate';

type V3 = [number, number, number];

/** What the checker keeps per body. */
interface Fit {
  readonly order: number[];
  /** Per fitted joint: its spec by id (a region's first joint for a region). */
  readonly specs: Map<string, JointSpec>;
  /** Bones whose length is checked, with rest length and rest scale. */
  readonly bones: readonly { bone: number; joint: string; length: number; scale: V3 }[];
  /** Volumes on the rig: near bone, far bone and radii in rig units. */
  readonly volumes: Map<string, BodyVolume>;
  readonly pairs: readonly (readonly [string, string])[];
  /** Weight-bearing joints: id and bone, one per bone. */
  readonly feet: readonly { id: string; bone: number }[];
  readonly up: V3;
  readonly stature: number;
}
const FITS = new WeakMap<AnatomicalRig, Fit>();

function fitOf(body: AnatomicalRig): Fit {
  let fit = FITS.get(body);
  if (fit) return fit;
  if (!body || !body.species || !Array.isArray(body.joints) || !(body.rest instanceof Float64Array))
    throw new TypeError(
      `The pose checker needs an AnatomicalRig made by fitAnatomy(rig, { species }); see ${POSE_HELP}`,
    );
  const species = body.species,
    order = parentOrder(body.parents as number[], 'Pose checker'),
    specs = new Map<string, JointSpec>(),
    byId = new Map(species.joints.map((spec) => [spec.id, spec]));
  for (const joint of body.joints) specs.set(joint.id, joint.spec);
  for (const region of body.regions) specs.set(region.id, body.joints[region.joints[0]].spec);
  const stature = body.stature > 0 ? body.stature : 1,
    boneOf = (id: string): number | undefined => {
      const k = body.index.get(id);
      return k === undefined ? undefined : body.joints[k].bone;
    };
  const bones = body.joints
    .filter((joint) => joint.limited && body.parents[joint.bone] >= 0)
    .map((joint) => {
      const o = joint.bone * 10;
      return {
        bone: joint.bone,
        joint: joint.id,
        length: Math.hypot(body.rest[o], body.rest[o + 1], body.rest[o + 2]),
        scale: [body.rest[o + 7], body.rest[o + 8], body.rest[o + 9]] as V3,
      };
    })
    .filter((entry) => entry.length > 1e-4 * stature);
  const { volumes, pairs } = bodyVolumes(body);
  const seen = new Set<number>(),
    feet: { id: string; bone: number }[] = [];
  for (const id of species.feet ?? []) {
    const bone = boneOf(id);
    if (bone === undefined || seen.has(bone) || !byId.has(id)) continue;
    seen.add(bone);
    feet.push({ id, bone });
  }
  fit = { order, specs, bones, volumes, pairs, feet, up: [...body.frame.up] as V3, stature };
  FITS.set(body, fit);
  return fit;
}

const nameOf = (body: AnatomicalRig, bone: number): string | null => (bone >= 0 ? (body.names[bone] ?? null) : null);

function issue(
  fields: Omit<PoseIssue, 'excess' | 'help' | 'time' | 'frame'> & { excess?: number },
  time: number | null = null,
  frame: number | null = null,
): PoseIssue {
  return {
    ...fields,
    excess: fields.excess ?? Math.abs(fields.value - fields.limit),
    time,
    frame,
    help: POSE_HELP,
  };
}

const fixed = (n: number, digits = 1) => n.toFixed(digits);

/** Angles past each tier, from what `clampPose` would change on a copy of the pose. */
function angleIssues(body: AnatomicalRig, fit: Fit, pose: ArrayLike<number>, options: PoseCheckOptions): PoseIssue[] {
  const tiers: Tier[] =
      options.tier === 'normal'
        ? ['normal']
        : options.tier === 'structural'
          ? ['structural']
          : ['structural', 'normal'],
    tolerance = options.tolerance ?? 0.5,
    out: PoseIssue[] = [],
    past = new Set<string>();
  for (const tier of tiers) {
    const raw: ClampIssue[] = [];
    clampPose(body, Float64Array.from(pose), { tier, issues: raw, force: true });
    for (const found of raw) {
      const excess = Math.abs(found.value - found.limit),
        key = `${found.joint}|${found.motion}`;
      if (excess <= tolerance || past.has(key)) continue;
      past.add(key);
      const spec = fit.specs.get(found.joint),
        dof = spec?.dofs?.findIndex((d) => d.positive === found.motion || d.negative === found.motion) ?? -1,
        hinge = spec?.kind === 'hinge' && !body.regions.some((region) => region.id === found.joint),
        code: PoseIssueCode =
          dof === 2
            ? 'twist-out-of-range'
            : hinge && dof === 1
              ? 'hinge-sideways'
              : hinge && dof === 0 && found.motion === spec!.dofs![0].negative
                ? 'hinge-reversed'
                : 'out-of-range',
        severity: PoseSeverity = tier === 'structural' ? 'error' : 'warning',
        what =
          code === 'hinge-reversed'
            ? `bent ${fixed(-found.value)} deg past straight`
            : `${found.motion} ${fixed(found.value)} deg`;
      out.push(
        issue({
          code,
          severity,
          joint: found.joint,
          bone: nameOf(body, found.bone),
          motion: found.motion,
          value: found.value,
          limit: found.limit,
          unit: 'deg',
          tier,
          source: found.source,
          message: `${found.joint} ${what}, ${fixed(excess)} past its ${tier === 'structural' ? 'stop' : 'clinical range'} of ${fixed(found.limit)}${found.source ? ` (${found.source})` : ''}`,
        }),
      );
    }
  }
  // A hinge that bends one way only (elbow, knee) held past straight looks locked back even inside its clinical range.
  if (options.tier !== 'structural') {
    const angles = readJointAngles(body, pose);
    body.joints.forEach((joint, k) => {
      const spec = joint.spec,
        flexion = angles[k * 3];
      if (
        joint.kind !== 'hinge' ||
        spec.neutral !== 'straight' ||
        !(joint.normal[0] > -10) ||
        !(flexion < -tolerance) ||
        past.has(`${joint.id}|${spec.dofs![0].negative}`)
      )
        return;
      out.push(
        issue({
          code: 'hinge-reversed',
          severity: 'warning',
          joint: joint.id,
          bone: nameOf(body, joint.bone),
          motion: spec.dofs![0].negative,
          value: flexion,
          limit: 0,
          unit: 'deg',
          tier: 'normal',
          source: null,
          message: `${joint.id} bent ${fixed(-flexion)} deg past straight: inside its clinical range of ${fixed(joint.normal[0])}, but it looks locked back`,
        }),
      );
    });
  }
  return out;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: readonly number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const at = (position: Float64Array, bone: number): V3 => [
  position[bone * 3],
  position[bone * 3 + 1],
  position[bone * 3 + 2],
];

/** Everything that is not an angle, on world positions of one pose. */
function placeIssues(
  body: AnatomicalRig,
  fit: Fit,
  pose: ArrayLike<number>,
  position: Float64Array,
  options: PoseCheckOptions,
): PoseIssue[] {
  const out: PoseIssue[] = [],
    H = fit.stature,
    stretch = options.stretch ?? 0.01;
  // Bone lengths and scales against rest.
  for (const entry of fit.bones) {
    const o = entry.bone * 10,
      length = Math.hypot(pose[o], pose[o + 1], pose[o + 2]),
      change = length / entry.length - 1,
      scaled = [0, 1, 2].reduce(
        (worst, c) => Math.max(worst, Math.abs(pose[o + 7 + c] / (entry.scale[c] || 1) - 1)),
        0,
      );
    if (Math.abs(change) > stretch)
      out.push(
        issue({
          code: 'bone-stretch',
          severity: 'error',
          joint: entry.joint,
          bone: nameOf(body, entry.bone),
          motion: null,
          value: length / H,
          limit: entry.length / H,
          unit: 'stature',
          tier: null,
          source: null,
          message: `${entry.joint}: the bone is ${fixed(Math.abs(change) * 100)} percent ${change > 0 ? 'longer' : 'shorter'} than at rest`,
        }),
      );
    if (scaled > stretch)
      out.push(
        issue({
          code: 'bone-stretch',
          severity: 'error',
          joint: entry.joint,
          bone: nameOf(body, entry.bone),
          motion: 'scale',
          value: 1 + scaled,
          limit: 1,
          unit: 'ratio',
          tier: null,
          source: null,
          message: `${entry.joint}: the bone is scaled ${fixed(scaled * 100)} percent from rest`,
        }),
      );
  }
  // The ground.
  const ground = options.ground;
  if (ground !== undefined && ground !== null) {
    const sink = (options.sink ?? 0.002) * H,
      up = fit.up;
    let lowest = -1,
      depth = sink;
    for (const joint of body.joints) {
      const h = dot(at(position, joint.bone), up) - ground;
      if (-h > depth) (depth = -h), (lowest = joint.bone);
    }
    if (lowest >= 0) {
      const joint = body.joints.find((entry) => entry.bone === lowest)!;
      out.push(
        issue({
          code: 'ground-penetration',
          severity: 'error',
          joint: joint.id,
          bone: nameOf(body, lowest),
          motion: null,
          value: -depth / H,
          limit: 0,
          unit: 'stature',
          tier: null,
          source: null,
          message: `${joint.id}: the joint is ${fixed((depth / H) * 100)} percent of stature below the ground`,
        }),
      );
    }
    const points = options.points;
    if (points && points.length >= 3) {
      let worst = sink,
        index = -1;
      for (let i = 0; i + 2 < points.length; i += 3) {
        const h = points[i] * up[0] + points[i + 1] * up[1] + points[i + 2] * up[2] - ground;
        if (-h > worst) (worst = -h), (index = i / 3);
      }
      if (index >= 0)
        out.push(
          issue({
            code: 'ground-penetration',
            severity: 'error',
            joint: `point ${index}`,
            bone: null,
            motion: null,
            value: -worst / H,
            limit: 0,
            unit: 'stature',
            tier: null,
            source: null,
            message: `skin point ${index} is ${fixed((worst / H) * 100)} percent of stature below the ground`,
          }),
        );
    }
    const float = (options.float ?? 0.06) * H;
    for (const id of options.supports ?? []) {
      const k = body.index.get(id);
      if (k === undefined)
        throw new RangeError(`checkPose: support "${id}" is not a joint of this body; see ${POSE_HELP}`);
      const bone = body.joints[k].bone,
        h = dot(at(position, bone), up) - ground;
      if (h > float)
        out.push(
          issue({
            code: 'floating',
            severity: 'error',
            joint: id,
            bone: nameOf(body, bone),
            motion: null,
            value: h / H,
            limit: float / H,
            unit: 'stature',
            tier: null,
            source: null,
            message: `${id} bears weight but is ${fixed((h / H) * 100)} percent of stature above the ground`,
          }),
        );
    }
  }
  // Limbs through limbs.
  if (options.volumes !== false && fit.pairs.length) {
    const shrink = options.shrink ?? 0.7;
    for (const [a, b] of fit.pairs) {
      const va = fit.volumes.get(a)!,
        vb = fit.volumes.get(b)!,
        [s, t, d2] = closestSegments(at(position, va.near), at(position, va.far), at(position, vb.near), at(position, vb.far)),
        reach = shrink * (va.r0 + (va.r1 - va.r0) * s + vb.r0 + (vb.r1 - vb.r0) * t),
        distance = Math.sqrt(d2);
      if (distance < reach)
        out.push(
          issue({
            code: 'self-penetration',
            severity: 'error',
            joint: `${a} + ${b}`,
            bone: null,
            motion: null,
            value: distance / H,
            limit: reach / H,
            unit: 'stature',
            tier: null,
            source: 'ansur2',
            message: `${a} passes through ${b}: their axes are ${fixed((distance / H) * 100)} percent of stature apart, ${fixed(((reach - distance) / H) * 100)} inside their girth`,
          }),
        );
    }
  }
  return out;
}

const SEVERITY: Record<PoseSeverity, number> = { error: 0, warning: 1 };
const sorted = (issues: PoseIssue[]) =>
  issues.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || y.excess - x.excess);
const report = (issues: PoseIssue[]) => {
  const errors = issues.filter((found) => found.severity === 'error').length;
  return { passed: errors === 0, errors, warnings: issues.length - errors, issues };
};

function checkLength(body: AnatomicalRig, pose: ArrayLike<number>, what: string) {
  if (!pose || typeof pose.length !== 'number' || pose.length !== body.names.length * 10)
    throw new TypeError(`${what} needs a local pose with 10 numbers per bone; see ${POSE_HELP}`);
}

/**
 * Checks one pose of a fitted body: each joint against its clinical range (warnings) and its stops (errors), with the
 * hinge faults named apart (`hinge-reversed`, `hinge-sideways`), bones stretched from rest, joints or skin points below
 * `ground`, weight-bearing `supports` off it, and limbs through limbs. Nothing is changed.
 * @example
 * const report = checkPose(body, pose, { ground: 0 });
 * for (const issue of report.issues) console.log(issue.severity, issue.message);
 * @param pose A local pose, 10 numbers per bone (translation, rotation xyzw, scale).
 * @throws TypeError for a body not made by `fitAnatomy` or a pose of the wrong length.
 */
export function checkPose(body: AnatomicalRig, pose: ArrayLike<number>, options: PoseCheckOptions = {}): PoseReport {
  const fit = fitOf(body);
  checkLength(body, pose, 'checkPose');
  const { position } = worldFrames(body.parents, pose, fit.order);
  return report(sorted([...angleIssues(body, fit, pose, options), ...placeIssues(body, fit, pose, position, options)]));
}

/**
 * Checks every frame of a clip, as {@link checkPose} does, and across frames: joints that turn faster than any body or
 * jump in one frame (`pop`), and planted feet that slide (`foot-slide`). `sample` is either the frames (local poses,
 * one buffer may be reused) or a function that writes the pose at a time into `out`. The summary has one row per joint,
 * motion and code with how many frames it lasts and its worst frame: the report for a capture or a retargeted take.
 * @example
 * const clip = checkClip(body, (time, out) => out.set(sampleMyClip(time)), { duration: 2.4, fps: 30, ground: 0 });
 * console.log(formatPoseReport(clip));
 * @throws TypeError for a pose of the wrong length or a function sampler without a duration.
 */
export function checkClip(
  body: AnatomicalRig,
  sample: Iterable<ArrayLike<number>> | ((time: number, out: Float64Array) => void),
  options: ClipCheckOptions = {},
): ClipReport {
  const fit = fitOf(body),
    fps = options.fps ?? 30,
    start = options.start ?? 0,
    H = fit.stature;
  if (!(fps > 0)) throw new RangeError(`checkClip fps must be above 0; see ${POSE_HELP}`);
  let frames: Iterable<ArrayLike<number>>;
  if (typeof sample === 'function') {
    const duration = options.duration;
    if (!(typeof duration === 'number' && duration >= 0))
      throw new TypeError(`checkClip needs options.duration when sample is a function; see ${POSE_HELP}`);
    const count = Math.floor(duration * fps + 1e-9) + 1,
      out = Float64Array.from(body.rest);
    frames = {
      *[Symbol.iterator]() {
        for (let i = 0; i < count; i++) {
          sample(start + i / fps, out);
          yield out;
        }
      },
    };
  } else frames = sample;
  const issues: PoseIssue[] = [],
    limited = body.joints.filter((joint) => joint.limited),
    speeds: Float64Array[] = [],
    rotations: Float64Array[] = [],
    feet: V3[][] = fit.feet.map(() => []),
    velocity = options.velocity ?? [0, 0, 0],
    previous = new Float64Array(limited.length * 4);
  let n = 0;
  for (const pose of frames) {
    checkLength(body, pose, 'checkClip');
    const time = start + n / fps,
      { position } = worldFrames(body.parents, pose, fit.order),
      stamp = (found: PoseIssue) => issues.push({ ...found, time, frame: n });
    for (const found of angleIssues(body, fit, pose, options)) stamp(found);
    for (const found of placeIssues(body, fit, pose, position, options)) stamp(found);
    const speed = new Float64Array(limited.length);
    limited.forEach((joint, k) => {
      const o = joint.bone * 10;
      if (n) {
        const d = Math.abs(
          pose[o + 3] * previous[k * 4] +
            pose[o + 4] * previous[k * 4 + 1] +
            pose[o + 5] * previous[k * 4 + 2] +
            pose[o + 6] * previous[k * 4 + 3],
        );
        speed[k] = ((2 * Math.acos(Math.min(1, d)) * 180) / Math.PI) * fps;
      }
      for (let c = 0; c < 4; c++) previous[k * 4 + c] = pose[o + 3 + c];
    });
    speeds.push(speed);
    rotations.push(Float64Array.from(previous));
    fit.feet.forEach((foot, k) => feet[k].push(add(at(position, foot.bone), scale(velocity, n / fps))));
    n++;
  }
  // Pops: past the fastest a body turns; a step, one fast frame between slower ones; or a blip, one frame far from both
  // its neighbours while they are close to each other (a capture flipping a joint for a frame and back).
  const maxSpeed = options.maxSpeed ?? 9000,
    between = (i: number, j: number, k: number) => {
      const p = rotations[i],
        q = rotations[j],
        d = Math.abs(
          p[k * 4] * q[k * 4] + p[k * 4 + 1] * q[k * 4 + 1] + p[k * 4 + 2] * q[k * 4 + 2] + p[k * 4 + 3] * q[k * 4 + 3],
        );
      return ((2 * Math.acos(Math.min(1, d)) * 180) / Math.PI) * fps;
    };
  for (let i = 1; i < n; i++)
    limited.forEach((joint, k) => {
      const v = speeds[i][k],
        before = i > 1 ? speeds[i - 1][k] : 0,
        after = i + 1 < n ? speeds[i + 1][k] : 0,
        step = v > 1000 && v > 4 * Math.max(before, after),
        blip = i + 1 < n && v > 1000 && after > 1000 && 4 * between(i - 1, i + 1, k) < Math.min(v, after);
      if (v <= maxSpeed && !step && !blip) return;
      if (blip && v <= maxSpeed) speeds[i + 1][k] = 0;
      issues.push(
        issue(
          {
            code: 'pop',
            severity: 'error',
            joint: joint.id,
            bone: nameOf(body, joint.bone),
            motion: null,
            value: v,
            limit: v > maxSpeed ? maxSpeed : step ? 4 * Math.max(before, after) : 4 * between(i - 1, i + 1, k),
            unit: 'deg/s',
            tier: null,
            source: null,
            message:
              v > maxSpeed
                ? `${joint.id} turns ${fixed(v, 0)} deg/s, faster than any body (${fixed(maxSpeed, 0)}, Fleisig et al. 2017)`
                : step
                  ? `${joint.id} jumps ${fixed(v / fps)} deg in one frame, ${fixed(v / Math.max(before, after, 1e-9))} times its neighbouring frames`
                  : `${joint.id} leaves its path by ${fixed(v / fps)} deg for one frame and comes back`,
          },
          start + i / fps,
          i,
        ),
      );
    });
  // Footskate: a planted foot moving along the ground.
  const contact = (options.contact ?? 0.02) * H,
    slide = (options.slide ?? 0.1) * H,
    up = fit.up;
  fit.feet.forEach((foot, k) => {
    const track = feet[k],
      heights = track.map((p) => dot(p, up)),
      low = Math.min(...heights);
    for (let i = 1; i + 1 < n; i++) {
      if (heights[i - 1] > low + contact || heights[i] > low + contact || heights[i + 1] > low + contact) continue;
      const move = sub(track[i + 1], track[i - 1]),
        along = sub(move, scale(up, dot(move, up))),
        speed = (Math.hypot(...along) * fps) / 2;
      if (speed <= slide) continue;
      issues.push(
        issue(
          {
            code: 'foot-slide',
            severity: 'error',
            joint: foot.id,
            bone: nameOf(body, foot.bone),
            motion: null,
            value: speed / H,
            limit: slide / H,
            unit: 'stature/s',
            tier: null,
            source: null,
            message: `${foot.id} is planted but slides ${fixed((speed / H) * 100)} percent of stature per second`,
          },
          start + i / fps,
          i,
        ),
      );
    }
  });
  const rows = new Map<string, ClipIssueSummary>();
  for (const found of issues) {
    const key = `${found.code}|${found.joint}|${found.motion}`,
      row = rows.get(key);
    if (!row)
      rows.set(key, {
        code: found.code,
        severity: found.severity,
        joint: found.joint,
        motion: found.motion,
        frames: 1,
        first: found.time!,
        last: found.time!,
        worst: found,
      });
    else
      rows.set(key, {
        ...row,
        severity: found.severity === 'error' ? 'error' : row.severity,
        frames: row.frames + 1,
        first: Math.min(row.first, found.time!),
        last: Math.max(row.last, found.time!),
        // An error outranks a warning; then the further past its limit.
        worst:
          SEVERITY[found.severity] < SEVERITY[row.worst.severity] ||
          (found.severity === row.worst.severity && found.excess > row.worst.excess)
            ? found
            : row.worst,
      });
  }
  const summary = [...rows.values()].sort(
    (x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || y.frames - x.frames || y.worst.excess - x.worst.excess,
  );
  issues.sort((x, y) => x.frame! - y.frame! || SEVERITY[x.severity] - SEVERITY[y.severity] || y.excess - x.excess);
  return { ...report(issues), frames: n, fps, summary };
}

/**
 * Checks a fitted body's build on its neutral pose (standing, arms down) against the species' measured proportions
 * that the table says how to read from joint centres (heights of the shoulder, elbow, wrist and knee, the length of
 * each long bone, the trunk), and the left side against the right. An arm too long or a knee too high is an error.
 * @example
 * for (const issue of checkProportions(body)) console.log(issue.message);
 * @throws TypeError for a body not made by `fitAnatomy`.
 */
export function checkProportions(body: AnatomicalRig, options: ProportionCheckOptions = {}): PoseIssue[] {
  const fit = fitOf(body),
    H = options.stature ?? fit.stature,
    lopsided = options.asymmetry ?? 0.05,
    { position } = worldFrames(body.parents, body.neutral, fit.order),
    byId = new Map(body.species.joints.map((spec) => [spec.id, spec])),
    out: PoseIssue[] = [];
  if (!(H > 0)) throw new RangeError(`checkProportions needs a stature above 0; see ${POSE_HELP}`);
  const read = (from: string, to: string, along: 'length' | 'up', offset: number): number | null => {
    const a = body.index.get(from),
      b = body.index.get(to);
    if (a === undefined || b === undefined) return null;
    const ba = body.joints[a].bone,
      bb = body.joints[b].bone;
    if (ba === bb) return null;
    const d = sub(at(position, bb), at(position, ba));
    return (along === 'length' ? Math.hypot(...d) : dot(d, fit.up)) / H + offset;
  };
  const mirror = (id: string) => byId.get(id)?.mirror ?? id;
  for (const norm of body.species.proportions) {
    const measure = norm.measure;
    if (!measure) continue;
    const sides: [string, number | null][] = [
      [norm.id, read(measure.from, measure.to, measure.along, measure.offset ?? 0)],
    ];
    const other = [mirror(measure.from), mirror(measure.to)] as const;
    if (other[0] !== measure.from || other[1] !== measure.to)
      sides.push([`${norm.id} (mirror)`, read(other[0], other[1], measure.along, measure.offset ?? 0)]);
    for (const [id, value] of sides) {
      if (value === null) continue;
      const [low, high] = measure.band;
      if (value >= low && value <= high) continue;
      const limit = value < low ? low : high;
      out.push(
        issue({
          code: 'proportion',
          severity: 'error',
          joint: id,
          bone: null,
          motion: null,
          value,
          limit,
          unit: 'stature',
          tier: null,
          source: norm.rows[0]?.source ?? null,
          message: `${id} (${norm.what}) is ${fixed(value, 3)} of stature, ${value < low ? 'under' : 'over'} ${fixed(limit, 3)}; people measure ${fixed(norm.share, 3)}`,
        }),
      );
    }
    const [left, right] = sides.map((side) => side[1]);
    if (left !== null && right !== null && right !== undefined && Math.abs(left - right) > lopsided * norm.share)
      out.push(
        issue({
          code: 'asymmetry',
          severity: 'warning',
          joint: norm.id,
          bone: null,
          motion: null,
          value: Math.abs(left - right) / norm.share,
          limit: lopsided,
          unit: 'ratio',
          tier: null,
          source: null,
          message: `${norm.id}: the two sides differ by ${fixed((Math.abs(left - right) / norm.share) * 100)} percent`,
        }),
      );
  }
  return sorted(out);
}

/** A report as lines of text: a header, then the clip summary or each issue. */
export function formatPoseReport(report: PoseReport | ClipReport): string {
  const clip = 'summary' in report,
    head = `${report.passed ? 'passed' : 'FAILED'}: ${report.errors} errors, ${report.warnings} warnings${clip ? ` over ${report.frames} frames at ${report.fps} fps` : ''}`;
  if (clip)
    return [
      head,
      ...report.summary.map(
        (row) =>
          `${row.severity.padEnd(7)} ${row.code.padEnd(18)} ${row.joint}${row.motion ? ` ${row.motion}` : ''}: ${row.frames} frames, ${fixed(row.first, 2)} to ${fixed(row.last, 2)} s; worst at ${fixed(row.worst.time!, 2)} s: ${row.worst.message}`,
      ),
    ].join('\n');
  return [
    head,
    ...report.issues.map((found) => `${found.severity.padEnd(7)} ${found.code.padEnd(18)} ${found.message}`),
  ].join('\n');
}

const fail = (what: string, result: PoseReport | ClipReport) =>
  Object.assign(margoError('failed', `${what} failed the pose checks\n${formatPoseReport(result)}\nSee ${POSE_HELP}`), {
    report: result,
  });

/**
 * {@link checkPose} that throws when any issue is an error, for a test.
 * @throws MargoError `failed` with the report as `error.report`.
 */
export function assertPose(body: AnatomicalRig, pose: ArrayLike<number>, options?: PoseCheckOptions): PoseReport {
  const result = checkPose(body, pose, options);
  if (!result.passed) throw fail('The pose', result);
  return result;
}

/**
 * {@link checkClip} that throws when any issue is an error, for a test of a capture or a retargeted take.
 * @throws MargoError `failed` with the report as `error.report`.
 */
export function assertClip(
  body: AnatomicalRig,
  sample: Iterable<ArrayLike<number>> | ((time: number, out: Float64Array) => void),
  options?: ClipCheckOptions,
): ClipReport {
  const result = checkClip(body, sample, options);
  if (!result.passed) throw fail('The clip', result);
  return result;
}
