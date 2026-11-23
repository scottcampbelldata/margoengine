// A horse built in code as a glTF 2.0 document: a skinned body lofted over measured cross-sections, four jointed legs,
// ears, eyes, hooves, a mane and forelock of hair cards and a tail of hair cards, with a jointed rig and baked gait clips.
// Proportions come from ./anatomy.js, gait timing from ./gaits.js. The legs are posed by two-bone inverse kinematics
// in the sagittal plane: a stance hoof stays where it struck while the body passes over it at the clip's speed, a swing
// hoof lifts and folds at the fetlock. The hind thigh, stifle and hock flex together, as the reciprocal apparatus ties
// them (Back and Clayton, "Equine Locomotion", 2nd ed., Saunders 2013, chapter 4).
// Axes are glTF's: +Y up, the horse faces +Z, its left side is +X; metres.
import { GLB_BIN, GLB_JSON, GLB_MAGIC } from '../../shared/glb.js';
import { horseBody, type HorseBody, type HorseBodyOptions } from './anatomy.js';
import { trunkMotion, hoofPhase, type Gait, type Stride } from './gaits.js';
import { horseClipPlan } from './clip-plan.js';

type V3 = [number, number, number];
type Q = [number, number, number, number];

/** One joint of the rig: its name, parent index (-1 for the root) and rest position in model space. */
export interface HorseJoint {
  readonly name: string;
  readonly parent: number;
  readonly rest: readonly [number, number, number];
}

/** The rig of one horse: joints in parent-first order, and the leg chains by hoof. */
export interface HorseSkeleton {
  readonly body: HorseBody;
  readonly joints: readonly HorseJoint[];
  /**
   * Joint indices of each leg, top to bottom, LH LF RH RF: hind thigh, gaskin, cannon, pastern, hoof; fore scapula,
   * arm, forearm, cannon, pastern, hoof. The hoof is always last.
   */
  readonly legs: readonly (readonly number[])[];
  /** Where each hoof touches the ground standing, model space, LH LF RH RF. */
  readonly ground: readonly (readonly [number, number, number])[];
  /** The saddle seat point (lowest point of the seat, behind the withers), model space at rest. */
  readonly saddle: readonly [number, number, number];
  /** Index of a joint by name. */
  index(name: string): number;
}

/** Joint names of a leg, top to bottom, by hoof. */
const LEG_NAMES: Record<string, string[]> = {
  LH: ['pelvisL', 'thighL', 'gaskinL', 'hindCannonL', 'hindPasternL', 'hindHoofL'],
  LF: ['scapulaL', 'armL', 'forearmL', 'foreCannonL', 'forePasternL', 'foreHoofL'],
  RH: ['pelvisR', 'thighR', 'gaskinR', 'hindCannonR', 'hindPasternR', 'hindHoofR'],
  RF: ['scapulaR', 'armR', 'forearmR', 'foreCannonR', 'forePasternR', 'foreHoofR'],
};
const TAIL = ['tail1', 'tail2', 'tail3', 'tailHair1', 'tailHair2', 'tailHair3', 'tailHair4', 'tailHair5'] as const;

/** The rig for a body: joint rest positions from its measurements. */
export function horseSkeleton(body: HorseBody, tailLength?: number): HorseSkeleton {
  if (!body || !(body.withers > 0)) throw new TypeError('horseSkeleton needs a horseBody()');
  const H = body.withers,
    L = body.bodyLength,
    hairLength = tailLength ?? 0.55 * H,
    joints: HorseJoint[] = [],
    add = (name: string, parent: string | null, rest: V3) => {
      joints.push({ name, parent: parent === null ? -1 : joints.findIndex((j) => j.name === parent), rest });
    };
  if (!(hairLength > 0 && Number.isFinite(hairLength)))
    throw new RangeError('Horse tail length must be finite and positive');
  add('root', null, [0, 0, 0]);
  add('body', 'root', [0, H - body.chestDepth / 2, 0]);
  const neckBase: V3 = [0, 0.79 * H, 0.47 * L],
    poll = neckPoll(body);
  add('neck1', 'body', neckBase);
  add('neck2', 'neck1', [0, (neckBase[1] + poll[1]) / 2, (neckBase[2] + poll[2]) / 2]);
  add('head', 'neck2', poll);
  add('tail1', 'body', [0, 0.94 * H, -0.5 * L - 0.02 * H]);
  add('tail2', 'tail1', [0, 0.94 * H - 0.45 * body.dock, -0.5 * L - 0.02 * H - 0.25 * body.dock]);
  add('tail3', 'tail2', [0, 0.94 * H - 0.9 * body.dock, -0.5 * L - 0.02 * H - 0.4 * body.dock]);
  const legs: number[][] = [],
    ground: V3[] = [];
  for (const hoof of ['LH', 'LF', 'RH', 'RF']) {
    const s = hoof[0] === 'L' ? 1 : -1,
      names = LEG_NAMES[hoof]!,
      start = joints.length;
    if (hoof[1] === 'F') {
      const x = s * 0.08 * H,
        z = 0.31 * L;
      // The scapula's top sits below the withers; the limb swings from there (Back and Clayton 2013).
      add(names[0]!, 'body', [x * 0.8, 0.9 * H, 0.27 * L]);
      add(names[1]!, names[0]!, [x, 0.64 * H, 0.5 * L - 0.03 * H]);
      add(names[2]!, names[1]!, [x, body.elbow, z]);
      add(names[3]!, names[2]!, [x, body.knee, z]);
      add(names[4]!, names[3]!, [x, body.foreFetlock, z]);
      add(names[5]!, names[4]!, [x, 0.045 * H, z + 0.08 * H]);
      ground.push([x, 0, z + 0.095 * H]);
    } else {
      const x = s * 0.09 * H;
      // The pelvis tips at the lumbosacral joint as the hind limb reaches under (Back and Clayton 2013).
      add(names[0]!, 'body', [x * 0.6, 0.95 * H, -0.18 * L]);
      add(names[1]!, names[0]!, [x, body.hipJoint, -0.3 * L]);
      add(names[2]!, names[1]!, [x, body.stifle, -0.17 * L]);
      add(names[3]!, names[2]!, [x, body.hock, -0.37 * L]);
      add(names[4]!, names[3]!, [x, body.hindFetlock, -0.35 * L]);
      add(names[5]!, names[4]!, [x, 0.045 * H, -0.35 * L + 0.075 * H]);
      ground.push([x, 0, -0.35 * L + 0.09 * H]);
    }
    legs.push(names.map((_, k) => start + k));
  }
  // Keep the original 32 joint indices. The trailing hair joints extend the bony dock as a flexible chain.
  const dock = joints.find((joint) => joint.name === 'tail3')!.rest;
  for (let i = 3; i < TAIL.length; i++) {
    const t = (i - 2) / (TAIL.length - 3);
    add(TAIL[i]!, TAIL[i - 1]!, [0, dock[1] - 0.92 * hairLength * t, dock[2] - hairLength * (0.18 * t + 0.08 * t * t)]);
  }
  const byName = new Map(joints.map((j, i) => [j.name, i]));
  return {
    body,
    joints,
    legs,
    ground,
    saddle: [0, H - 0.01 * H, 0.1 * L],
    index(name: string) {
      const i = byName.get(name);
      if (i === undefined) throw new RangeError(`No horse joint "${name}"; use a name from the skeleton's joints`);
      return i;
    },
  };
}

function neckPoll(body: HorseBody): V3 {
  const H = body.withers,
    L = body.bodyLength,
    N = body.neckLength;
  return [0, 0.79 * H + 0.62 * N, 0.47 * L + 0.5 * N];
}
/** Unit direction of the head from the poll toward the muzzle, 50 degrees below horizontal. */
const HEAD_DIR: V3 = [0, -Math.sin((50 * Math.PI) / 180), Math.cos((50 * Math.PI) / 180)];

// ----- small vector and quaternion helpers -----
const qx = (a: number): Q => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const qz = (a: number): Q => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const inverse = ([x, y, z, w]: Q): Q => [-x, -y, -z, w];
const plus = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const minus = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q: Q, v: readonly number[]): V3 => {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
};
/** Angle in the YZ plane measured from +Y toward +Z: a rotation about +X adds to it. */
const ang = (y: number, z: number): number => Math.atan2(z, y);

/** A pose: each joint's local rotation (quaternion x, y, z, w) and the body joint's offset from rest. */
export interface HorsePose {
  readonly rotations: readonly (readonly [number, number, number, number])[];
  /** Added to the body joint's rest translation. */
  readonly bodyOffset: readonly [number, number, number];
  /** Left and right scapula displacement on the thorax, in the body's local frame. */
  readonly scapulaOffsets?: readonly [Readonly<V3>, Readonly<V3>];
}

/** A joint's local translation in a pose, including the shoulder blades' slide on the thorax. */
export function horseJointTranslation(skeleton: HorseSkeleton, pose: HorsePose, index: number): V3 {
  const joint = skeleton.joints[index]!,
    parent = skeleton.joints[joint.parent];
  if (!parent) return [...joint.rest];
  const offset =
    joint.name === 'body'
      ? pose.bodyOffset
      : joint.name === 'scapulaL'
        ? pose.scapulaOffsets?.[0]
        : joint.name === 'scapulaR'
          ? pose.scapulaOffsets?.[1]
          : undefined;
  return [0, 1, 2].map((axis) => joint.rest[axis]! - parent.rest[axis]! + (offset?.[axis] ?? 0)) as V3;
}

/** Each joint's model-space position in a pose (forward kinematics), as [x, y, z] per joint. */
export function poseJoints(skeleton: HorseSkeleton, pose: HorsePose): [number, number, number][] {
  const out: V3[] = [],
    world: Q[] = [];
  skeleton.joints.forEach((j, i) => {
    const q = pose.rotations[i] as Q;
    if (j.parent < 0) {
      out.push([...j.rest] as V3);
      world.push(q);
      return;
    }
    const off = qrot(world[j.parent]!, horseJointTranslation(skeleton, pose, i)),
      base = out[j.parent]!;
    out.push([base[0] + off[0], base[1] + off[1], base[2] + off[2]]);
    world.push(qmul(world[j.parent]!, q));
  });
  return out;
}

/** World rotation of every joint in a pose. */
function worldRotations(skeleton: HorseSkeleton, pose: HorsePose): Q[] {
  const world: Q[] = [];
  skeleton.joints.forEach((j, i) =>
    world.push(j.parent < 0 ? (pose.rotations[i] as Q) : qmul(world[j.parent]!, pose.rotations[i] as Q)),
  );
  return world;
}

/** Where each hoof's ground point is in a pose, model space, LH LF RH RF. */
export function poseHooves(skeleton: HorseSkeleton, pose: HorsePose): [number, number, number][] {
  const at = poseJoints(skeleton, pose),
    world = worldRotations(skeleton, pose);
  return skeleton.legs.map((leg, i) => {
    const hoof = leg[leg.length - 1]!,
      j = skeleton.joints[hoof]!,
      g = skeleton.ground[i]!,
      off = qrot(world[hoof]!, [g[0] - j.rest[0], g[1] - j.rest[1], g[2] - j.rest[2]]);
    return [at[hoof]![0] + off[0], at[hoof]![1] + off[1], at[hoof]![2] + off[2]];
  });
}

/** The saddle seat in a pose: its position and the trunk's rotation (model space). */
export function poseSaddle(
  skeleton: HorseSkeleton,
  pose: HorsePose,
): { position: [number, number, number]; rotation: [number, number, number, number] } {
  const at = poseJoints(skeleton, pose),
    world = worldRotations(skeleton, pose),
    b = skeleton.index('body'),
    rest = skeleton.joints[b]!.rest,
    off = qrot(world[b]!, [skeleton.saddle[0] - rest[0], skeleton.saddle[1] - rest[1], skeleton.saddle[2] - rest[2]]);
  return { position: [at[b]![0] + off[0], at[b]![1] + off[1], at[b]![2] + off[2]], rotation: world[b]! };
}

const signedAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));

/** The elbow or stifle sits where the upper chain can reach and the lower chain can achieve its hinge angle. */
function limbPivot(
  top: readonly number[],
  end: V3,
  guideY: number,
  guideZ: number,
  upperMin: number,
  upperMax: number,
  lowerMin: number,
  lowerMax: number,
  desired: number,
): [number, number] {
  const distance = Math.hypot(top[1]! - end[1], top[2]! - end[2]);
  // Both chains' reach annuli must intersect. Use the desired lower reach wherever it can.
  const min = Math.max(lowerMin, distance - upperMax, upperMin - distance);
  const max = Math.min(lowerMax, distance + upperMax);
  // Leave the limb's pivot away from the tangency of the two reach circles when the gait has slack.
  const reserve = Math.min(Math.max(0, max - min) / 3, upperMax * 0.075);
  const reach = clamp(desired, min + reserve, max);
  const axis = ang(top[1]! - end[1], top[2]! - end[2]);
  const guide = signedAngle(ang(guideY - end[1], guideZ - end[2]) - axis);
  const angleAt = (radius: number) =>
    Math.acos(clamp((distance * distance + reach * reach - radius * radius) / (2 * distance * reach), -1, 1));
  // Keep the limb on its rest side of the reach axis when the guide crosses it.
  const direction = axis + clamp(guide, angleAt(upperMin), angleAt(upperMax));
  return [end[1] + Math.cos(direction) * reach, end[2] + Math.sin(direction) * reach];
}

/** A fast onset and measured early peak, then extension back into foot strike. */
function swingFlex(t: number, peak: number): number {
  return t < peak ? smooth(t / peak) : 1 - smooth((t - peak) / (1 - peak));
}

// Hodson, Clayton and Lanovaz (2000) used a full stride starting at fore-hoof impact.
// Keep separate phases for carpus, fetlock and coffin rather than applying one distal rotation.
function forePeak(stride: Stride, walk: number, faster: number): number {
  return stride.gait === 'walk' ? clamp((walk - stride.duty) / (1 - stride.duty), 0.23, 0.78) : faster;
}

/** Integrate the hoof velocity through swing, matching the backward stance velocity at both contacts. */
function swingTravel(stride: Stride, t: number): number {
  const edge = 0.065,
    sweep = stride.length * stride.duty,
    backward = -stride.length * (1 - stride.duty),
    forward = (sweep - edge * backward) / (1 - edge);
  const fromLift = (u: number) => {
    if (u >= edge) return (edge * (backward + forward)) / 2 + (u - edge) * forward;
    const x = u / edge;
    return backward * u + (forward - backward) * edge * (x ** 3 - 0.5 * x ** 4);
  };
  return t <= 0.5 ? fromLift(t) : sweep - fromLift(1 - t);
}

/** Two-bone IK in the YZ plane: absolute segment angles reaching from `root` to `target`, bending by `bend` (+1/-1). */
function twoBone(
  root: readonly number[],
  target: readonly number[],
  a: number,
  b: number,
  bend: number,
): [number, number] {
  const dy = target[1]! - root[1]!,
    dz = target[2]! - root[2]!,
    d = Math.min(a + b - 1e-6, Math.max(Math.abs(a - b) + 1e-6, Math.hypot(dy, dz))),
    base = ang(dy, dz),
    A = Math.acos(Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)))),
    first = base + bend * A,
    jy = root[1]! + a * Math.cos(first),
    jz = root[2]! + a * Math.sin(first);
  return [first, ang(target[1]! - jy, target[2]! - jz)];
}

/** Stance fraction where breakover starts. */
export const BREAKOVER = 0.8;
/** Toe ahead of the hoof's ground point, as a ratio of withers height. */
const TOE = 0.04;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const len2 = (a: readonly number[], b: readonly number[]): number => Math.hypot(b[1]! - a[1]!, b[2]! - a[2]!);
const restAng = (a: readonly number[], b: readonly number[]): number => ang(b[1]! - a[1]!, b[2]! - a[2]!);

function reachLeg(
  rest: readonly (readonly number[])[],
  top: V3,
  fetlock: V3,
  guideY: number,
  guideZ: number,
  lowerReach: number,
  fore: boolean,
): [number, number, number, number] {
  const shoulder = len2(rest[0]!, rest[1]!),
    upper = len2(rest[1]!, rest[2]!),
    aboveHinge = len2(rest[2]!, rest[3]!),
    belowHinge = len2(rest[3]!, rest[4]!),
    upperMax = Math.sqrt(shoulder ** 2 + upper ** 2 + 2 * shoulder * upper * Math.cos(0.3)),
    [ey, ez] = limbPivot(
      top,
      fetlock,
      guideY,
      guideZ,
      Math.abs(shoulder - upper) + 1e-6,
      upperMax,
      Math.abs(aboveHinge - belowHinge) + 1e-6,
      aboveHinge + belowHinge - 1e-6,
      lowerReach,
    ),
    bend = fore ? -1 : 1,
    [s1, s2] = twoBone(top, [0, ey, ez], shoulder, upper, bend),
    jy = top[1] + shoulder * Math.cos(s1) + upper * Math.cos(s2),
    jz = top[2] + shoulder * Math.sin(s1) + upper * Math.sin(s2),
    [a1, a2] = twoBone([0, jy, jz], fetlock, aboveHinge, belowHinge, bend);
  return [
    s1 - restAng(rest[0]!, rest[1]!),
    s2 - restAng(rest[1]!, rest[2]!),
    a1 - restAng(rest[2]!, rest[3]!),
    a2 - restAng(rest[3]!, rest[4]!),
  ];
}

// The muscular sling lets the scapula slide on the thorax while the limb bears weight. Lawson and Marlin (2010)
// observed about 80 mm peak-to-peak in the direction of travel, and upward travel after hoof strike.
function scapulaSlide(height: number, stride: Stride, stance: boolean, progress: number): V3 {
  const phase = stance ? progress * stride.duty : stride.duty + progress * (1 - stride.duty);
  const load = stance ? Math.sin(Math.PI * progress) ** 2 : 0;
  const compression = stride.gait === 'walk' ? 0.011 : stride.gait === 'trot' ? 0.017 : 0.019;
  return [0, height * compression * load, height * 0.0245 * Math.cos(2 * Math.PI * (phase - 0.06))];
}

/**
 * The pose at stride phase `phase` (0 to 1) of a stride, or the standing pose at `time` seconds when `s` is null. The
 * root stays at the origin: in a stride the ground moves backward under the horse at `s.speed`, so a stance hoof keeps
 * still once the root moves forward at that speed. `amplitude` (0–1, default 1) scales the gait toward standing
 * while solving the hoof targets, including at the reduced stride lengths of a start or stop.
 * @throws RangeError if amplitude is outside 0–1.
 */
export function horsePose(skeleton: HorseSkeleton, s: Stride | null, phase = 0, time = 0, amplitude = 1): HorsePose {
  if (!(amplitude >= 0 && amplitude <= 1)) throw new RangeError('Use a horse pose amplitude from 0 to 1');
  const body = skeleton.body,
    H = body.withers,
    J = skeleton.joints,
    rotations: Q[] = J.map(() => [0, 0, 0, 1]),
    breathing = 0.002 * H * Math.sin((2 * Math.PI * time) / 4),
    gait = s ? trunkMotion(body, s, phase) : { rise: breathing, pitch: 0, nod: 0 },
    trunk = {
      rise: gait.rise * amplitude + breathing * (1 - amplitude),
      pitch: gait.pitch * amplitude,
      nod: gait.nod * amplitude,
    },
    bodyIndex = skeleton.index('body'),
    bodyRest = J[bodyIndex]!.rest,
    // Nose-down pitch is a rotation about +X.
    pitch = trunk.pitch;
  rotations[bodyIndex] = qx(pitch);
  const scapulaOffsets: [V3, V3] = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bodyY = bodyRest[1] + trunk.rise;
  // Ground point (model space, root frame) into the body's frame: undo the rise, then the pitch, about the body joint.
  const toBody = (p: readonly number[]): V3 => {
    const y = p[1]! - bodyY,
      z = p[2]! - bodyRest[2],
      c = Math.cos(-pitch),
      sn = Math.sin(-pitch);
    return [p[0]!, bodyRest[1] + y * c - z * sn, bodyRest[2] + y * sn + z * c];
  };
  skeleton.legs.forEach((leg, i) => {
    const fore = i === 1 || i === 3,
      j = leg.map((k) => J[k]!.rest),
      g0 = skeleton.ground[i]!;
    let target: V3,
      flex = 0,
      sink = 0,
      breakover = 0,
      coffinFlex = 0,
      elbowFlex = 0;
    // Pastern and hoof vectors at rest: fetlock to coronet, coronet to ground point.
    const n = leg.length,
      pastern = [0, j[n - 1]![1] - j[n - 2]![1], j[n - 1]![2] - j[n - 2]![2]],
      hoofVec = [0, g0[1] - j[n - 1]![1], g0[2] - j[n - 1]![2]];
    let lift = 0;
    // Model bind poses are often posed for skinning. Under weight a fore carpus is almost straight.
    const restHinge = fore ? 0.035 : Math.abs(signedAngle(restAng(j[3]!, j[4]!) - restAng(j[2]!, j[3]!)));
    let hinge = restHinge;
    const rollAtLift = fore ? 0.64 : 0.49;
    if (!s) target = [g0[0], 0, g0[2]];
    else {
      const h = hoofPhase(s, i, phase),
        sweep = s.length * s.duty * amplitude;
      if (h.stance) {
        target = [g0[0], 0, g0[2] + sweep / 2 - sweep * h.t];
        const loadPeak = fore && s.gait === 'walk' ? clamp(0.34 / s.duty, 0.42, 0.64) : 0.5;
        const load = fore ? swingFlex(h.t, loadPeak) : Math.sin(Math.PI * h.t);
        sink = (s.gait === 'walk' ? 0.12 : s.gait === 'trot' ? 0.25 : 0.32) * load;
        // Breakover: over the last fifth of the stance the heel lifts and the hoof rolls over its toe.
        if (h.t > BREAKOVER) breakover = rollAtLift * smooth((h.t - BREAKOVER) / (1 - BREAKOVER));
        // Under load the carpus is a near-straight strut. The hind tarsus keeps its rest bend.
        hinge += (fore ? 0.025 : 0.04) * Math.sin(Math.PI * h.t) ** 2 + (fore ? 0.19 : 0.31) * breakover;
      } else {
        target = [g0[0], 0, g0[2] - sweep / 2 + swingTravel(s, h.t) * amplitude];
        lift = s.pattern.lift[fore ? 0 : 1] * H * Math.sin(Math.PI * h.t) ** 2;
        breakover = rollAtLift * (1 - smooth(Math.min(1, h.t / 0.37)));
        if (fore) {
          // In the walk a healthy carpus folds about 55° from straight. At the trot the measured swing range
          // is 76° on average (Clayton et al., 2004). Leave the late-stance fold in the same continuous curve.
          const peakAngle = ((s.gait === 'walk' ? 55 : s.gait === 'trot' ? 76 : 82) * Math.PI) / 180;
          const peak = forePeak(s, 0.76, 0.4);
          const start = rollAtLift * 0.19;
          hinge =
            h.t < peak
              ? restHinge + start + (peakAngle - restHinge - start) * smooth(h.t / peak)
              : restHinge + (peakAngle - restHinge) * (1 - smooth((h.t - peak) / (1 - peak)));
          flex = (s.gait === 'walk' ? 0.56 : 0.72) * swingFlex(h.t, forePeak(s, 0.81, 0.5));
          const later = swingFlex(h.t, forePeak(s, 0.84, 0.51));
          coffinFlex = 0.095 * later;
          elbowFlex = 0.07 * H * later;
        } else {
          flex = 0.57 * swingFlex(h.t, 0.47);
          hinge += 0.56 * swingFlex(h.t, 0.38) + 0.31 * breakover;
        }
      }
      if (fore) scapulaOffsets[i === 1 ? 0 : 1] = scapulaSlide(H * amplitude, s, h.stance, h.t);
      lift *= amplitude;
      sink *= amplitude;
      flex *= amplitude;
      coffinFlex *= amplitude;
      elbowFlex *= amplitude;
      breakover *= amplitude;
      hinge = restHinge + (hinge - restHinge) * amplitude;
    }
    const G = toBody(target);
    // Pastern flattens (sink) under load and folds back (flex) in the swing; the hoof stays flat on the ground.
    const pAng = -pitch - sink + flex + breakover,
      hAng = -pitch + breakover + (fore ? flex - coffinFlex : 0.9 * flex),
      // In breakover the toe, a little ahead of the ground point, stays put while the hoof turns about it.
      toe = [0, 0, TOE * H],
      rotation = qx(hAng),
      ph = qrot(rotation, hoofVec),
      rolledToe = qrot(rotation, toe),
      toeWeight = breakover / rollAtLift,
      pp = qrot(qx(pAng), pastern),
      fetlock: V3 = [
        G[0],
        G[1] - ph[1] - toeWeight * rolledToe[1] - pp[1] + lift,
        G[2] - ph[2] - toeWeight * (rolledToe[2] - toe[2]!) - pp[2],
      ];
    // Limb protraction: the angle of the whole limb from its top joint to the hoof, against rest.
    const restTop = j[0]!,
      slide = fore ? scapulaOffsets[i === 1 ? 0 : 1] : undefined,
      top: V3 = slide ? [restTop[0], restTop[1] + slide[1], restTop[2] + slide[2]] : [...restTop],
      beta = signedAngle(ang(G[1] - top[1], G[2] - top[2]) - ang(g0[1] - top[1], g0[2] - top[2])),
      la = len2(j[2]!, j[3]!),
      lb = len2(j[3]!, j[4]!),
      c = Math.cos((fore ? 0.5 : 0.7) * beta),
      sn = Math.sin((fore ? 0.5 : 0.7) * beta),
      ry = j[2]![1] - restTop[1],
      rz = j[2]![2] - restTop[2],
      guideY = top[1] + ry * c - rz * sn + 0.18 * elbowFlex,
      guideZ = top[2] + ry * sn + rz * c - elbowFlex,
      desired = Math.sqrt(la * la + lb * lb + 2 * la * lb * Math.cos(hinge)),
      deltas: number[] = reachLeg(j, top, fetlock, guideY, guideZ, desired, fore);
    // Absolute pastern and hoof angles against their rest, in the body frame; locals are differences down the chain.
    deltas.push(pAng, hAng);
    deltas.forEach((d, k) => (rotations[leg[k]!] = qx(d - (k ? deltas[k - 1]! : 0))));
  });
  // Neck and head nod; the head keeps its carriage against the trunk's pitch.
  rotations[skeleton.index('neck1')] = qx(0.6 * trunk.nod - 0.5 * pitch);
  rotations[skeleton.index('head')] = qx(0.4 * trunk.nod - 0.3 * pitch);
  // Tail: carried higher and streaming with speed, swinging a little with each stride.
  const carry = s ? Math.min(0.9, 0.05 * s.speed) * amplitude : 0,
    idleSwing = 0.05 * Math.sin((2 * Math.PI * time) / 4),
    swing = s ? idleSwing * (1 - amplitude) + 0.12 * amplitude * Math.sin(2 * Math.PI * phase) : idleSwing;
  rotations[skeleton.index('tail1')] = qmul(qx(carry), qz(swing));
  rotations[skeleton.index('tail2')] = qmul(qx(carry * 0.6), qz(swing * 0.8));
  rotations[skeleton.index('tail3')] = qmul(qx(carry * 0.4), qz(swing * 0.6));
  for (let i = 3; i < TAIL.length; i++) {
    const along = (i - 2) / (TAIL.length - 3),
      idleWave = 0.016 * Math.sin(2 * Math.PI * (time / 4 - 0.15 * along)),
      wave = s
        ? idleWave * (1 - amplitude) + 0.036 * amplitude * Math.sin(2 * Math.PI * (phase - 0.17 * along))
        : idleWave;
    rotations[skeleton.index(TAIL[i]!)] = qmul(qx(carry * 0.11 * (1 - 0.55 * along)), qz(wave));
  }
  return { rotations, bodyOffset: [0, trunk.rise, 0], scapulaOffsets };
}

/** One hoof's contact goal in model space, with terrain pitch and roll in radians. */
export interface HorseHoofTarget {
  readonly point: Readonly<V3>;
  readonly pitch: number;
  readonly roll: number;
}

/**
 * Fits a gait pose to contact points in LH, LF, RH, RF order. Shoulder and hip splay is capped at 0.35 radians.
 * Each leg retains its six joint lengths and its original bending side. Reachable goals are solved exactly.
 * The trunk leans with the supplied ground plane while retaining the underlying gait and tail motion.
 */
export function fitHorseHooves(
  skeleton: HorseSkeleton,
  pose: HorsePose,
  targets: readonly HorseHoofTarget[],
  pitch = 0,
  roll = 0,
): HorsePose {
  if (targets.length !== skeleton.legs.length || !Number.isFinite(pitch) || !Number.isFinite(roll))
    throw new RangeError('Pass one target per hoof and finite trunk angles in radians');
  const initial = poseJoints(skeleton, pose),
    world = worldRotations(skeleton, pose),
    rotations = pose.rotations.slice(),
    bodyIndex = skeleton.index('body'),
    body = initial[bodyIndex]!,
    baseInverse = inverse(world[bodyIndex]!),
    bodyRotation = qmul(qmul(qz(roll), qx(pitch)), world[bodyIndex]!),
    bodyInverse = inverse(bodyRotation);
  rotations[bodyIndex] = qmul(inverse(world[skeleton.joints[bodyIndex]!.parent]!), bodyRotation);
  skeleton.legs.forEach((leg, i) => {
    const goal = targets[i];
    if (
      !goal ||
      goal.point.length !== 3 ||
      !goal.point.every(Number.isFinite) ||
      !Number.isFinite(goal.pitch) ||
      !Number.isFinite(goal.roll)
    )
      throw new RangeError('Pass a finite XYZ point and finite slope angles for each hoof');
    const fore = i % 2 === 1,
      rest = leg.map((joint) => skeleton.joints[joint]!.rest),
      bridge = qmul(qz(goal.roll), qx(goal.pitch)),
      hoofRotation = qmul(bridge, world[leg[5]!]!),
      pasternRotation = qmul(bridge, world[leg[4]!]!),
      hoofToPad = qrot(hoofRotation, minus(skeleton.ground[i]!, rest[5]!)),
      fetlockToHoof = qrot(pasternRotation, minus(rest[5]!, rest[4]!)),
      fetlock = qrot(bodyInverse, minus(minus(minus(goal.point, hoofToPad), fetlockToHoof), body)),
      top = horseJointTranslation(skeleton, pose, leg[0]!),
      offset = minus(fetlock, top),
      restX = rest[4]![0] - rest[0]![0],
      reachY = -Math.sqrt(Math.max(0, offset[0] ** 2 + offset[1] ** 2 - restX ** 2)),
      splay = clamp(ang(-offset[1], offset[0]) - ang(-reachY, restX), -0.35, 0.35),
      lateral = qz(splay),
      planar = plus(top, qrot(inverse(lateral), offset)),
      mid = qrot(baseInverse, minus(initial[leg[2]!]!, body)),
      end = qrot(baseInverse, minus(initial[leg[4]!]!, body)),
      angles = reachLeg(rest, top, planar, mid[1], mid[2], len2(mid, end), fore);
    rotations[leg[0]!] = qmul(lateral, qx(angles[0]));
    for (let j = 1; j < 4; j++) rotations[leg[j]!] = qx(angles[j]! - angles[j - 1]!);
    const cannonRotation = qmul(qmul(bodyRotation, lateral), qx(angles[3]));
    rotations[leg[4]!] = qmul(inverse(cannonRotation), pasternRotation);
    rotations[leg[5]!] = qmul(inverse(pasternRotation), hoofRotation);
  });
  return { ...pose, rotations };
}

/**
 * Layers one timed swat over a horse pose. The dock starts the turn and the hair follows with increasing delay.
 * `seconds` is time since the swat began. `strength` is 0–1. `side` is +1 left or -1 right.
 * @throws RangeError for a non-finite time, invalid strength, or invalid side.
 */
export function horseTailFlick(
  skeleton: HorseSkeleton,
  pose: HorsePose,
  seconds: number,
  strength = 1,
  side: -1 | 1 = 1,
): HorsePose {
  if (!Number.isFinite(seconds) || !(strength >= 0 && strength <= 1) || (side !== -1 && side !== 1))
    throw new RangeError('Horse tail flick needs finite time, strength 0 to 1 and side -1 or 1');
  if (seconds <= 0 || seconds >= 0.94 || strength === 0) return pose;
  const rotations = pose.rotations.slice();
  for (let i = 0; i < TAIL.length; i++) {
    const u = (seconds - 0.026 * i) / 0.75;
    if (u <= 0 || u >= 1) continue;
    const envelope = Math.sin(Math.PI * u) ** 2 * strength,
      lateral = side * envelope * Math.sin(2 * Math.PI * u + 0.85) * (i === 0 ? 0.48 : 0.17),
      joint = skeleton.index(TAIL[i]!);
    rotations[joint] = qmul(rotations[joint] as Q, qmul(qx(envelope * (i < 3 ? 0.075 : 0.034)), qz(lateral)));
  }
  return { ...pose, rotations };
}

// ----- coats -----

/** A coat colour. */
export type HorseCoat = 'bay' | 'chestnut' | 'black' | 'grey' | 'dun' | 'brown';
/** Every coat, in panel order. */
export const HORSE_COATS: readonly HorseCoat[] = ['bay', 'chestnut', 'black', 'grey', 'dun', 'brown'];
/** Linear RGB of a coat's body, points (lower legs, muzzle), mane and tail. */
export interface CoatColors {
  readonly body: readonly [number, number, number];
  readonly points: readonly [number, number, number];
  readonly mane: readonly [number, number, number];
}
/** The coats. Bay, dun and brown have black points, mane and tail; a dun carries a dorsal stripe. */
export const COAT_COLORS: Readonly<Record<HorseCoat, CoatColors>> = {
  bay: { body: [0.22, 0.085, 0.03], points: [0.018, 0.014, 0.012], mane: [0.015, 0.012, 0.01] },
  chestnut: { body: [0.3, 0.1, 0.03], points: [0.26, 0.085, 0.026], mane: [0.34, 0.12, 0.04] },
  black: { body: [0.02, 0.018, 0.017], points: [0.016, 0.014, 0.013], mane: [0.012, 0.011, 0.01] },
  grey: { body: [0.5, 0.5, 0.48], points: [0.22, 0.22, 0.21], mane: [0.42, 0.42, 0.4] },
  dun: { body: [0.42, 0.27, 0.12], points: [0.02, 0.016, 0.013], mane: [0.018, 0.014, 0.012] },
  brown: { body: [0.08, 0.035, 0.016], points: [0.017, 0.013, 0.011], mane: [0.014, 0.011, 0.01] },
};
const WHITE: V3 = [0.75, 0.74, 0.7];

/** White markings. */
export interface HorseMarkings {
  /** Height of a white sock on each leg in metres (0 none), LH LF RH RF. Default none. */
  socks?: readonly [number, number, number, number];
  /** A white blaze down the face. Default false. */
  blaze?: boolean;
}

/** Options of {@link horseDocument}. */
export interface HorseModelOptions extends HorseBodyOptions {
  /** The coat. Default `'bay'`. */
  coat?: HorseCoat;
  /** White markings. Default none. */
  markings?: HorseMarkings;
  /** Mane hair length in metres. Default 0.11 times the withers height (a pulled mane). */
  maneLength?: number;
  /** Tail hair length in metres from the dock. Default 0.55 times the withers height (to the hocks). */
  tailLength?: number;
  /** Speeds in m/s at which each gait's clip is baked. Default each gait's preferred speed for this horse. */
  speeds?: Partial<Record<Gait, number>>;
  /** Mesh detail: 2 film close-up, 1 middle, 0 far crowd. Default 2. */
  detail?: 0 | 1 | 2;
  /**
   * For a `bakeBones` crowd: texture coordinates point into a coat atlas (one column per coat, rows for body,
   * points, mane and hoof) instead of running along the hair. Default false.
   */
  atlas?: boolean;
}

/** One baked clip: its gait (or `'stand'`), speed, stride length, duration and duty factor. */
export interface HorseClip {
  readonly name: Gait | 'stand';
  readonly speed: number;
  readonly strideLength: number;
  readonly duration: number;
  readonly duty: number;
}

/** A horse as a glTF document and its binary buffers, for `parseGLTFAsync(engine, doc, buffers)`. */
export interface HorseDocument {
  readonly doc: Record<string, unknown>;
  readonly buffers: Uint8Array[];
  readonly body: HorseBody;
  readonly skeleton: HorseSkeleton;
  /** The baked clips, in the document's animation order. */
  readonly clips: readonly HorseClip[];
  /** Vertex count of all primitives. */
  readonly vertices: number;
}

// ----- mesh building -----

class Part {
  readonly positions: number[] = [];
  readonly uvs: number[] = [];
  readonly colors: number[] = [];
  readonly joints: number[] = [];
  readonly weights: number[] = [];
  readonly indices: number[] = [];
  constructor(
    readonly material: string,
    readonly doubleSided = false,
  ) {}
  vertex(
    p: readonly number[],
    uv: readonly number[],
    color: readonly number[],
    skin: readonly [number, number][],
  ): number {
    this.positions.push(p[0]!, p[1]!, p[2]!);
    this.uvs.push(uv[0]!, uv[1]!);
    this.colors.push(color[0]!, color[1]!, color[2]!);
    const s = skin.slice(0, 4),
      total = s.reduce((n, [, w]) => n + w, 0) || 1;
    for (let k = 0; k < 4; k++) {
      this.joints.push(s[k]?.[0] ?? 0);
      this.weights.push((s[k]?.[1] ?? 0) / total);
    }
    return this.positions.length / 3 - 1;
  }
  get count(): number {
    return this.positions.length / 3;
  }
  /** Quads between consecutive rings of `m` vertices starting at `start`; `closed` joins the ring's ends. */
  grid(start: number, rings: number, m: number, closed: boolean, flip = false): void {
    const span = closed ? m : m - 1;
    for (let r = 0; r < rings - 1; r++)
      for (let k = 0; k < span; k++) {
        const a = start + r * m + k,
          b = start + r * m + ((k + 1) % m),
          c = a + m,
          d = b + m;
        if (flip) this.indices.push(a, b, c, b, d, c);
        else this.indices.push(a, c, b, b, c, d);
      }
  }
  normals(): Float32Array {
    const n = new Float32Array(this.positions.length),
      p = this.positions;
    for (let i = 0; i < this.indices.length; i += 3) {
      const a = this.indices[i]! * 3,
        b = this.indices[i + 1]! * 3,
        c = this.indices[i + 2]! * 3,
        ux = p[b]! - p[a]!,
        uy = p[b + 1]! - p[a + 1]!,
        uz = p[b + 2]! - p[a + 2]!,
        vx = p[c]! - p[a]!,
        vy = p[c + 1]! - p[a + 1]!,
        vz = p[c + 2]! - p[a + 2]!,
        nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      for (const o of [a, b, c]) {
        n[o] = n[o]! + nx;
        n[o + 1] = n[o + 1]! + ny;
        n[o + 2] = n[o + 2]! + nz;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
      n[i] = n[i]! / l;
      n[i + 1] = n[i + 1]! / l;
      n[i + 2] = n[i + 2]! / l;
    }
    return n;
  }
}

/** Catmull-Rom through station values, `t` from 0 to stations - 1. */
function spline(values: readonly number[], t: number): number {
  const n = values.length,
    i = Math.min(n - 2, Math.max(0, Math.floor(t))),
    f = t - i,
    p0 = values[Math.max(0, i - 1)]!,
    p1 = values[i]!,
    p2 = values[i + 1]!,
    p3 = values[Math.min(n - 1, i + 2)]!;
  return (
    0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
  );
}
const mix3 = (a: readonly number[], b: readonly number[], t: number): V3 => [
  a[0]! + (b[0]! - a[0]!) * t,
  a[1]! + (b[1]! - a[1]!) * t,
  a[2]! + (b[2]! - a[2]!) * t,
];
/** Distance from p to segment ab. */
function segmentDistance(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!],
    ap = [p[0]! - a[0]!, p[1]! - a[1]!, p[2]! - a[2]!],
    l = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2,
    t = l > 0 ? Math.min(1, Math.max(0, (ap[0]! * ab[0]! + ap[1]! * ab[1]! + ap[2]! * ab[2]!) / l)) : 0;
  return Math.hypot(ap[0]! - ab[0]! * t, ap[1]! - ab[1]! * t, ap[2]! - ab[2]! * t);
}

/** Atlas texture coordinates for a crowd: column per coat, rows body, points, mane, hoof (centres of 4 x 6 cells). */
export function coatAtlasUV(coat: HorseCoat, row: 'body' | 'points' | 'mane' | 'hoof'): [number, number] {
  const c = HORSE_COATS.indexOf(coat),
    r = ['body', 'points', 'mane', 'hoof'].indexOf(row);
  if (c < 0 || r < 0) throw new RangeError('coatAtlasUV needs a coat from HORSE_COATS and a row');
  return [(c + 0.5) / HORSE_COATS.length, (r + 0.5) / 4];
}
/** The coat atlas as RGBA8 pixels (sRGB), 6 coats wide and 4 rows high, for a crowd's `map`. */
export function coatAtlas(): { data: Uint8Array; width: number; height: number } {
  const width = HORSE_COATS.length,
    height = 4,
    data = new Uint8Array(width * height * 4),
    srgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  HORSE_COATS.forEach((coat, c) => {
    const k = COAT_COLORS[coat],
      rows = [k.body, k.points, k.mane, [0.05, 0.045, 0.04]];
    rows.forEach((rgb, r) => {
      // Row 0 is the top of the image; texture v runs up, so row r sits at image row (3 - r).
      const o = ((3 - r) * width + c) * 4;
      data[o] = srgb(rgb[0]!);
      data[o + 1] = srgb(rgb[1]!);
      data[o + 2] = srgb(rgb[2]!);
      data[o + 3] = 255;
    });
  });
  return { data, width, height };
}

/**
 * The horse as a glTF 2.0 document with a skinned mesh in five materials (`Coat`, `Hoof`, `Mane`, `Tail`, `Eye`), a
 * 37-joint rig, a `saddle` node on the trunk, and the clips `stand`, `walk`, `trot`, `canter` and `gallop` (left
 * lead), each one stride long at its speed. Load it with `parseGLTFAsync(engine, doc, buffers)` from
 * `@margoengine/gltf/pbr`, or take {@link horseGLB}.
 * @example
 * const {doc, buffers, clips} = horseDocument({type: 'draft', coat: 'grey'});
 * @throws TypeError or RangeError for bad options.
 */
export function horseDocument(options: HorseModelOptions = {}): HorseDocument {
  const body = horseBody(options),
    H = body.withers,
    L = body.bodyLength,
    coat = options.coat ?? 'bay',
    colors = COAT_COLORS[coat],
    detail = options.detail ?? 2,
    atlas = options.atlas === true,
    markings = options.markings ?? {},
    maneLength = options.maneLength ?? 0.11 * H,
    tailLength = options.tailLength ?? 0.55 * H;
  if (!colors || !Object.hasOwn(COAT_COLORS, coat))
    throw new TypeError(`horseDocument coat must be one of ${HORSE_COATS.join(', ')}`);
  if (detail !== 0 && detail !== 1 && detail !== 2) throw new RangeError('horseDocument detail must be 0, 1 or 2');
  if (!(maneLength >= 0.02 && maneLength <= 0.8))
    throw new RangeError('horseDocument maneLength must be 0.02 to 0.8 m');
  if (!(tailLength >= 0.1 && tailLength <= 1.6)) throw new RangeError('horseDocument tailLength must be 0.1 to 1.6 m');
  const skeleton = horseSkeleton(body, tailLength);
  const socks = markings.socks ?? [0, 0, 0, 0];
  if (!Array.isArray(socks) || socks.length !== 4 || socks.some((h) => !(h >= 0 && h <= H)))
    throw new RangeError('horseDocument markings.socks must be four heights in metres, 0 to the withers height');
  const around = [12, 20, 36][detail]!,
    along = [2, 4, 7][detail]!,
    J = skeleton.joints,
    at = (name: string) => J[skeleton.index(name)]!.rest,
    jid = (name: string) => skeleton.index(name);
  const coatPart = new Part('Coat'),
    hoofPart = new Part('Hoof'),
    manePart = new Part('Mane', true),
    tailPart = new Part('Tail', true),
    eyePart = new Part('Eye');
  const atlasUV = (row: 'body' | 'points' | 'mane' | 'hoof') => coatAtlasUV(coat, row);

  // Skin by nearest bone segments among candidates: the nearest two blend across a band.
  const segs = (names: string[]) =>
    names.map((n) => {
      const i = jid(n),
        child = J.findIndex((j) => j.parent === i && !j.name.startsWith('tail') === !n.startsWith('tail'));
      const a = J[i]!.rest,
        b =
          n === 'body'
            ? [0, a[1], 0.4 * L]
            : n === 'head'
              ? [0, a[1] + HEAD_DIR[1] * body.headLength, a[2] + HEAD_DIR[2] * body.headLength]
              : child >= 0
                ? J[child]!.rest
                : [a[0], a[1] - 0.1 * H, a[2]];
      const start = n === 'body' ? [0, a[1], -0.4 * L] : a;
      return { i, a: start, b };
    });
  const blendSkin = (p: readonly number[], cands: ReturnType<typeof segs>, band: number): [number, number][] => {
    const d = cands.map((c) => ({ i: c.i, d: segmentDistance(p, c.a, c.b) })).sort((x, y) => x.d - y.d);
    if (d.length < 2) return [[d[0]!.i, 1]];
    const w = Math.max(0, 1 - (d[1]!.d - d[0]!.d) / band) * 0.5;
    return [
      [d[0]!.i, 1 - w],
      [d[1]!.i, w],
    ];
  };

  // ----- trunk and neck: one loft from the tail head to the poll -----
  const bel = H - body.chestDepth,
    barrel = Math.max(0.1 * H, body.girth / Math.PI - body.chestDepth / 2),
    hw = body.hipWidth / 2,
    cw = body.chestWidth / 2;
  // Stations: z, top y, bottom y, half width.
  const trunk: [number, number, number, number][] = [
    [-0.5 * L - 0.035 * H, 0.95 * H, 0.89 * H, 0.03 * H],
    [-0.5 * L + 0.01 * H, 0.975 * H, 0.66 * H, hw * 0.62],
    [-0.42 * L, 0.995 * H, 0.6 * H, hw * 0.92],
    [-0.3 * L, H, bel + 0.03 * H, hw],
    [-0.15 * L, 0.975 * H, bel + 0.01 * H, barrel * 0.98],
    [0, 0.962 * H, bel - 0.012 * H, barrel * 1.03],
    [0.15 * L, 0.98 * H, bel - 0.005 * H, barrel],
    [0.27 * L, 1.0 * H, bel + 0.01 * H, cw + 0.01 * H],
    [0.38 * L, 0.965 * H, bel + 0.05 * H, cw],
    [0.47 * L, 0.9 * H, 0.64 * H, cw * 0.82],
  ];
  const neckBase = at('neck1'),
    poll = at('head'),
    stations: { c: V3; hh: number; hw: number }[] = trunk.map(([z, t, b, w]) => ({
      c: [0, (t + b) / 2, z],
      hh: (t - b) / 2,
      hw: w,
    }));
  for (const s of [0.25, 0.5, 0.75, 1.0]) {
    const c = mix3(neckBase, poll, s);
    stations.push({ c, hh: 0.14 * H * (1 - s) + 0.07 * H * s, hw: 0.092 * H * (1 - s) + 0.05 * H * s });
  }
  const loft = (
    part: Part,
    st: typeof stations,
    cands: ReturnType<typeof segs>,
    uFrom: number,
    uTo: number,
    color: (p: V3, f: number, k: number) => V3,
    row = 'body' as 'body' | 'points',
  ) => {
    const n = (st.length - 1) * along + 1,
      start = part.count,
      cy = st.map((s) => s.c[1]),
      cz = st.map((s) => s.c[2]),
      hh = st.map((s) => s.hh),
      ww = st.map((s) => s.hw);
    for (let r = 0; r < n; r++) {
      const t = r / along,
        c: V3 = [0, spline(cy, t), spline(cz, t)],
        e = 0.01,
        dy = spline(cy, Math.min(st.length - 1, t + e)) - spline(cy, Math.max(0, t - e)),
        dz = spline(cz, Math.min(st.length - 1, t + e)) - spline(cz, Math.max(0, t - e)),
        l = Math.hypot(dy, dz) || 1,
        up = [dz / l, -dy / l],
        h = Math.max(0.005, spline(hh, t)),
        w = Math.max(0.005, spline(ww, t)),
        // Close the ends to a point.
        cap = r === 0 || r === n - 1 ? 0.02 : 1;
      for (let k = 0; k < around; k++) {
        const a = (2 * Math.PI * k) / around,
          ca = Math.cos(a),
          sa = Math.sin(a),
          sx = Math.sign(ca) * Math.abs(ca) ** 0.8,
          sy = Math.sign(sa) * Math.abs(sa) ** 0.8,
          p: V3 = [w * sx * cap, c[1] + up[0]! * h * sy * cap, c[2] + up[1]! * h * sy * cap],
          f = r / (n - 1),
          uv = atlas ? atlasUV(row) : [uFrom + (uTo - uFrom) * f, k / around];
        part.vertex(p, uv, color(p, f, k), blendSkin(p, cands, 0.08 * H));
      }
    }
    part.grid(start, n, around, true, true);
  };
  const dorsal = coat === 'dun';
  loft(
    coatPart,
    stations,
    segs(['body', 'neck1', 'neck2', 'head', 'thighL', 'thighR', 'armL', 'armR']),
    0,
    0.8,
    (p) => (dorsal && Math.abs(p[0]) < 0.018 * H && p[1] > 0.9 * H && p[2] < 0.3 * L ? colors.mane : colors.body) as V3,
  );

  // ----- head: poll to muzzle, with a deep jowl -----
  const headStations: [number, number, number, number][] = [
    [-0.1, 0.05, 0.04, 0],
    [0.0, 0.075, 0.05, 0],
    [0.2, 0.092, 0.06, -0.018],
    [0.42, 0.068, 0.05, -0.01],
    [0.68, 0.052, 0.04, 0],
    [0.88, 0.05, 0.041, -0.004],
    [1.0, 0.026, 0.026, -0.008],
  ];
  const headUp = [HEAD_DIR[2], -HEAD_DIR[1]] as const; // perpendicular to the head axis in YZ, toward the forehead
  const hst = headStations.map(([s, h, w, drop]) => ({
    c: [
      0,
      poll[1] + HEAD_DIR[1] * s * body.headLength + headUp[0] * drop * H,
      poll[2] + HEAD_DIR[2] * s * body.headLength + headUp[1] * drop * H,
    ] as V3,
    hh: h * H,
    hw: w * H,
  }));
  loft(coatPart, hst, segs(['head']), 0.8, 1, (p, f, k) => {
    const blazed =
      markings.blaze === true &&
      f > 0.25 &&
      f < 0.95 &&
      Math.abs(p[0]) < 0.25 * 0.05 * H &&
      Math.sin((2 * Math.PI * k) / around) > 0;
    return (blazed ? WHITE : f > 0.84 ? colors.points.map((v, i) => (v + colors.body[i]!) / 2) : colors.body) as V3;
  });

  // ----- legs: tubes along each chain, hooves in their own material -----
  skeleton.legs.forEach((leg, li) => {
    const fore = li === 1 || li === 3,
      pts = [...leg.map((k) => J[k]!.rest), skeleton.ground[li]!],
      radii = fore
        ? [
            [0.05, 0.06],
            [0.085, 0.065],
            [0.062, 0.036],
            [body.cannon / (2 * Math.PI) / H + 0.004, body.cannon / (2 * Math.PI) / H],
            [0.03, 0.024],
            [0.03, 0.037],
          ]
        : [
            [0.05, 0.08],
            [0.11, 0.075],
            [0.058, 0.038],
            [body.cannon / (2 * Math.PI) / H + 0.006, body.cannon / (2 * Math.PI) / H + 0.002],
            [0.03, 0.024],
            [0.03, 0.037],
          ],
      sock = socks[li]!;
    const segments = leg.length;
    for (let sgi = 0; sgi < segments; sgi++) {
      const hoof = sgi === segments - 1,
        part = hoof ? hoofPart : coatPart,
        a = pts[sgi]!,
        b = pts[sgi + 1]!,
        dy = b[1] - a[1],
        dz = b[2] - a[2],
        l = Math.hypot(dy, dz) || 1,
        n = [dz / l, -dy / l],
        rings = sgi === 0 ? along + 1 : along,
        start = part.count,
        parent = sgi === 0 ? jid('body') : leg[sgi - 1]!;
      for (let r = 0; r < rings + (hoof ? 1 : 0); r++) {
        const f = Math.min(1, r / (rings - 1 || 1)),
          y = a[1] + dy * f,
          z = a[2] + dz * f,
          rad = (radii[sgi]![0]! + (radii[sgi]![1]! - radii[sgi]![0]!) * f) * H * (r === rings ? 0.02 : 1);
        // Joint knobs: the knee, hock and fetlock are wider than the bones between them.
        const knob = sgi >= segments - 3 && sgi <= segments - 2 && f < 0.15 ? 1.25 - f : 1;
        const blend = f < 0.15 ? 0.5 * (1 - f / 0.15) : 0;
        for (let k = 0; k < around; k++) {
          const ang2 = (2 * Math.PI * k) / around,
            p: V3 = [
              a[0] + Math.cos(ang2) * rad * knob * (fore ? 0.92 : 1),
              y + n[0]! * Math.sin(ang2) * rad * knob,
              z + n[1]! * Math.sin(ang2) * rad * knob,
            ],
            low = p[1] < (fore ? body.knee : body.hock) - 0.02 * H,
            color: V3 = hoof
              ? sock > 0
                ? [0.32, 0.27, 0.2]
                : [0.05, 0.045, 0.04]
              : p[1] < sock
                ? WHITE
                : low
                  ? (colors.points as V3)
                  : (colors.body as V3),
            uv = atlas ? atlasUV(hoof ? 'hoof' : low ? 'points' : 'body') : [f, k / around];
          part.vertex(
            p,
            uv,
            color,
            blend > 0
              ? [
                  [leg[sgi]!, 1 - blend],
                  [parent, blend],
                ]
              : [[leg[sgi]!, 1]],
          );
        }
      }
      part.grid(start, rings + (hoof ? 1 : 0), around, true, true);
    }
  });

  // ----- ears and eyes -----
  const headJ = jid('head');
  for (const side of [1, -1]) {
    const base: V3 = [side * 0.035 * H, poll[1] + 0.05 * H, poll[2] - 0.01 * H],
      tip: V3 = [side * 0.05 * H, base[1] + 0.09 * H, base[2] + 0.025 * H],
      m = Math.max(6, around / 3),
      start = coatPart.count;
    for (let r = 0; r <= 3; r++) {
      const f = r / 3,
        c = mix3(base, tip, f),
        rad = 0.022 * H * (1 - f) + 0.001;
      for (let k = 0; k < m; k++) {
        const a = (2 * Math.PI * k) / m,
          p: V3 = [c[0] + Math.cos(a) * rad, c[1], c[2] + Math.sin(a) * rad * 0.7];
        coatPart.vertex(p, atlas ? atlasUV('body') : [0.9, k / m], colors.body as V3, [[headJ, 1]]);
      }
    }
    coatPart.grid(start, 4, m, true);
    // The eye sits a fifth of the head down, on the side of the face.
    const e = mix3(poll, [0, poll[1] + HEAD_DIR[1] * body.headLength, poll[2] + HEAD_DIR[2] * body.headLength], 0.24),
      center: V3 = [side * 0.052 * H, e[1] + 0.012 * H, e[2]],
      er = 0.016 * H,
      lat = 6,
      lon = Math.max(8, around / 2),
      es = eyePart.count;
    for (let i = 0; i <= lat; i++)
      for (let k = 0; k < lon; k++) {
        const th = (Math.PI * i) / lat,
          ph = (2 * Math.PI * k) / lon,
          // The eye looks out to its side (+X on the left): v=0 at the pupil.
          d: V3 = [side * Math.cos(th), Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph)];
        eyePart.vertex(
          [center[0] + d[0] * er, center[1] + d[1] * er, center[2] + d[2] * er],
          atlas ? atlasUV('mane') : [k / lon, i / lat],
          [0.02, 0.015, 0.012],
          [[headJ, 1]],
        );
      }
    eyePart.grid(es, lat + 1, lon, true, side < 0);
  }

  // ----- hair cards: mane and forelock (neck and head), tail (dock) -----
  const card = (
    part: Part,
    root: V3,
    dir: V3,
    side: V3,
    length: number,
    width: number,
    bend: V3,
    skin: (f: number, center: V3) => [number, number][],
    color: V3,
    segsN = detail === 0 ? 2 : 4,
  ) => {
    const start = part.count;
    for (let r = 0; r <= segsN; r++) {
      const f = r / segsN,
        c: V3 = [
          root[0] + dir[0] * length * f + bend[0] * f * f * length,
          root[1] + dir[1] * length * f + bend[1] * f * f * length,
          root[2] + dir[2] * length * f + bend[2] * f * f * length,
        ],
        w = width * (1 - 0.6 * f);
      for (const k of [0, 1]) {
        const o = (k - 0.5) * w;
        part.vertex(
          [c[0] + side[0] * o, c[1] + side[1] * o, c[2] + side[2] * o],
          atlas ? atlasUV('mane') : [k, f],
          color,
          skin(f, c),
        );
      }
    }
    part.grid(start, segsN + 1, 2, false);
  };
  const maneCards = [8, 20, 36][detail]!,
    n1 = jid('neck1'),
    n2 = jid('neck2');
  for (let i = 0; i < maneCards; i++) {
    const s = (i + 0.5) / maneCards,
      c = mix3([0, at('body')[1] + body.chestDepth / 2, 0.3 * L], poll, s),
      // The crest: the top of the neck loft above the centre line.
      root: V3 = [-0.01 * H, c[1] + 0.06 * H * s - 0.01 * H, c[2]],
      ln = maneLength * (0.8 + 0.4 * Math.sin(i * 12.9898) ** 2);
    // The mane falls to the off (right) side.
    card(
      manePart,
      root,
      [-0.45, -0.89, 0],
      [0, 0.3, 0.95],
      ln,
      ((L * 0.6) / maneCards) * 1.8,
      [-0.1, -0.05, -0.05],
      () =>
        s < 0.5
          ? [
              [n1, 1 - s],
              [n2, s],
            ]
          : [
              [n2, 1.5 - s],
              [headJ, s - 0.5],
            ],
      colors.mane as V3,
    );
  }
  for (let i = 0; i < [2, 4, 6][detail]!; i++) {
    const x = (i / 5 - 0.5) * 0.04 * H;
    card(
      manePart,
      [x, poll[1] + 0.07 * H, poll[2] + 0.01 * H],
      [0, HEAD_DIR[1] + 0.2 * HEAD_DIR[2], HEAD_DIR[2] - 0.2 * HEAD_DIR[1]] as V3,
      [1, 0, 0],
      maneLength * 1.1,
      0.03 * H,
      [0, -0.15, 0.05],
      () => [[headJ, 1]],
      colors.mane as V3,
    );
  }
  const tailCards = [10, 24, 44][detail]!,
    t1 = at('tail1'),
    t3 = at('tail3'),
    tj = TAIL.map(jid);
  for (let i = 0; i < tailCards; i++) {
    const s = ((i * 7) % tailCards) / tailCards,
      root = mix3(t1, t3, 0.15 + 0.8 * s),
      a = 2 * Math.PI * ((i * 0.618) % 1),
      spread = 0.18,
      dir: V3 = [Math.cos(a) * spread, -1, -0.25 + Math.sin(a) * spread * 0.6],
      l = Math.hypot(...dir),
      ln = tailLength * (1 - 0.45 * s) * (0.85 + 0.3 * Math.sin(i * 78.233) ** 2);
    card(
      tailPart,
      root,
      [dir[0] / l, dir[1] / l, dir[2] / l],
      [Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2)],
      ln,
      0.045 * H,
      [Math.cos(a) * 0.08, 0, -0.06],
      (_, center) => {
        const lower = tj.findIndex((joint) => J[joint]!.rest[1] < center[1]);
        if (lower === 0) return [[tj[0]!, 1]];
        if (lower < 0) return [[tj[tj.length - 1]!, 1]];
        const above = tj[lower - 1]!,
          below = tj[lower]!,
          y = J[above]!.rest[1],
          t = (y - center[1]) / (y - J[below]!.rest[1]);
        return [
          [above, 1 - t],
          [below, t],
        ];
      },
      colors.mane as V3,
      [3, 6, 10][detail],
    );
  }

  // ----- clips -----
  const { clips, strides } = horseClipPlan(body, options.speeds);

  // ----- glTF assembly -----
  const buffers: Uint8Array[] = [],
    bufferViews: object[] = [],
    accessors: object[] = [];
  const accessor = (
    data: Float32Array | Uint16Array | Uint32Array,
    type: string,
    componentType: number,
    extra: object = {},
    target?: number,
  ) => {
    buffers.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength, ...(target ? { target } : {}) });
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: data.length / comps, type, ...extra });
    return accessors.length - 1;
  };
  const materials = [
    { name: 'Coat', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.62 } },
    { name: 'Hoof', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.55 } },
    {
      name: 'Mane',
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.5 },
    },
    {
      name: 'Tail',
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.5 },
    },
    { name: 'Eye', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.08 } },
  ];
  const parts = [coatPart, hoofPart, manePart, tailPart, eyePart],
    primitives = parts.map((part, m) => {
      const pos = new Float32Array(part.positions),
        min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, pos[i + k]!);
          max[k] = Math.max(max[k]!, pos[i + k]!);
        }
      return {
        attributes: {
          POSITION: accessor(pos, 'VEC3', 5126, { min, max }, 34962),
          NORMAL: accessor(part.normals(), 'VEC3', 5126, {}, 34962),
          TEXCOORD_0: accessor(new Float32Array(part.uvs), 'VEC2', 5126, {}, 34962),
          COLOR_0: accessor(new Float32Array(part.colors), 'VEC3', 5126, {}, 34962),
          JOINTS_0: accessor(new Uint16Array(part.joints), 'VEC4', 5123, {}, 34962),
          WEIGHTS_0: accessor(new Float32Array(part.weights), 'VEC4', 5126, {}, 34962),
        },
        indices: accessor(new Uint32Array(part.indices), 'SCALAR', 5125, {}, 34963),
        material: m,
      };
    });
  const ibm = new Float32Array(J.length * 16);
  J.forEach((j, i) => {
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j.rest[0], -j.rest[1], -j.rest[2], 1], i * 16);
  });
  const nodes: Record<string, unknown>[] = J.map((j) => {
    const p = j.parent >= 0 ? J[j.parent]!.rest : [0, 0, 0];
    return {
      name: j.name,
      translation: [j.rest[0] - p[0]!, j.rest[1] - p[1]!, j.rest[2] - p[2]!],
      children: [] as number[],
    };
  });
  J.forEach((j, i) => j.parent >= 0 && (nodes[j.parent]!.children as number[]).push(i));
  const bodyRest = at('body'),
    saddleNode = nodes.length;
  nodes.push({
    name: 'saddle',
    translation: [skeleton.saddle[0] - bodyRest[0], skeleton.saddle[1] - bodyRest[1], skeleton.saddle[2] - bodyRest[2]],
  });
  (nodes[jid('body')]!.children as number[]).push(saddleNode);
  for (const n of nodes) if ((n.children as number[] | undefined)?.length === 0) delete n.children;
  const meshNode = nodes.length;
  nodes.push({ name: 'horse', mesh: 0, skin: 0 });
  const skinDef = { joints: J.map((_, i) => i), inverseBindMatrices: accessor(ibm, 'MAT4', 5126), skeleton: 0 };

  const animations = clips.map((clip, ci) => {
    const s = strides[ci]!,
      keys = s ? [16, 24, 32][detail]! : 8,
      times = new Float32Array(keys + 1),
      rot = J.map(() => new Float32Array((keys + 1) * 4)),
      translations = ['body', 'scapulaL', 'scapulaR'].map((name) => ({
        joint: jid(name),
        values: new Float32Array((keys + 1) * 3),
      }));
    for (let k = 0; k <= keys; k++) {
      const f = k / keys;
      times[k] = f * clip.duration;
      const pose = s ? horsePose(skeleton, s, f) : horsePose(skeleton, null, 0, f * clip.duration);
      pose.rotations.forEach((q, i) => rot[i]!.set(q, k * 4));
      for (const { joint, values } of translations) values.set(horseJointTranslation(skeleton, pose, joint), k * 3);
    }
    const input = accessor(times, 'SCALAR', 5126, { min: [0], max: [clip.duration] }),
      samplers: object[] = [],
      channels: object[] = [];
    J.forEach((j, i) => {
      if (i === 0) return;
      samplers.push({ input, output: accessor(rot[i]!, 'VEC4', 5126) });
      channels.push({ sampler: samplers.length - 1, target: { node: i, path: 'rotation' } });
    });
    for (const { joint, values } of translations) {
      samplers.push({ input, output: accessor(values, 'VEC3', 5126) });
      channels.push({ sampler: samplers.length - 1, target: { node: joint, path: 'translation' } });
    }
    return {
      name: clip.name,
      samplers,
      channels,
      extras: { speed: clip.speed, strideLength: clip.strideLength, duty: clip.duty },
    };
  });

  const doc = {
    asset: { version: '2.0', generator: '@margoengine/horses' },
    scene: 0,
    scenes: [{ nodes: [0, meshNode] }],
    nodes,
    meshes: [{ name: 'horse', primitives }],
    skins: [skinDef],
    materials,
    animations,
    accessors,
    bufferViews,
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
    extras: { horse: { type: body.type, withers: body.withers, mass: body.mass, coat } },
  };
  return { doc, buffers, body, skeleton, clips, vertices: parts.reduce((n, p) => n + p.count, 0) };
}

/** The horse of {@link horseDocument} as one GLB file (one binary buffer), for `loadGLTF` or a download. */
export function horseGLB(options: HorseModelOptions = {}): Uint8Array {
  const { doc, buffers } = horseDocument(options);
  let offset = 0;
  const starts = buffers.map((b) => {
    const s = offset;
    offset += (b.byteLength + 3) & ~3;
    return s;
  });
  const bin = new Uint8Array(offset);
  buffers.forEach((b, i) => bin.set(b, starts[i]));
  const json = {
    ...doc,
    buffers: [{ byteLength: offset }],
    bufferViews: (doc.bufferViews as object[]).map((v, i) => ({ ...v, buffer: 0, byteOffset: starts[i] })),
  };
  const raw = new TextEncoder().encode(JSON.stringify(json)),
    text = new Uint8Array((raw.length + 3) & ~3).fill(0x20);
  text.set(raw);
  const out = new Uint8Array(28 + text.length + bin.length),
    view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, GLB_JSON, true);
  out.set(text, 20);
  view.setUint32(20 + text.length, bin.length, true);
  view.setUint32(24 + text.length, GLB_BIN, true);
  out.set(bin, 28 + text.length);
  return out;
}
