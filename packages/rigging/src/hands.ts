/// <reference lib="esnext.disposable" preserve="true" />
// Hand poses: named poses as joint flexion tables (relaxed, fist, flat, point, pinch, and a power grip solved for a bar
// of a given diameter), put on any humanoid rig whose fingers a retarget preset names (Mixamo, VRM, MPFB, Godot), and
// a per-hand Animator layer that blends them over time.
//
// Clean room, from the papers (no code read):
// - Rijpkema and Girard, "Computer animation of knowledge-based human grasping", SIGGRAPH 1991,
//   https://doi.org/10.1145/127719.127748: grasps from a small set of hand shapes; fingers close joint by joint until a
//   segment meets the object; the distal joint follows the middle one (DIP about 2/3 of PIP).
// - ElKoura and Singh, "Handrix: animating the human hand", SCA 2003, https://doi.org/10.2312/SCA03/110-119: coupled
//   finger joints and the natural hand postures between keyed grasps.
// - Santello, Flanders and Soechting, "Postural hand synergies for tool use", J. Neuroscience 18(23) 1998,
//   https://doi.org/10.1523/JNEUROSCI.18-23-10105.1998: finger flexion moves together and grows from index to little.
// - Feix, Romero, Schmiedmayer, Dollar and Kragic, "The GRASP taxonomy of human grasp types", IEEE THMS 46(1) 2016,
//   https://doi.org/10.1109/THMS.2015.2470657: power (cylinder) grip, pinch, pointing and the rest posture as classes.
// - Joerg, Hodgins and Safonova, "Data-driven finger motion synthesis for gesturing characters", SIGGRAPH Asia 2012,
//   https://doi.org/10.1145/2366145.2366208: body clips with flat or missing finger tracks read as dead hands; a rest
//   posture blended in fixes most of it.
// - Wheatland, Wang, Song, Neff, Zordan and Joerg, "State of the art in hand and finger modeling and animation",
//   Computer Graphics Forum 34(2) 2015, https://doi.org/10.1111/cgf.12595: joint ranges and the rest posture's cascade.
import { multiplyQuaternions, normalizeQuaternion, axisAngleToQuaternion, conjugateQuaternion, rotateByQuaternion, interpolateQuaternions } from '@margoengine/math/quat';
import type { Animator } from '@margoengine/animator';
import { detectSkeleton, humanoidBones, type HumanoidBone, type SkeletonPreset } from './retarget.js';

/** The five digits, thumb first. */
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'] as const;
/** One of {@link FINGERS}. */
export type FingerName = (typeof FINGERS)[number];
/** A hand. */
export type HandSide = 'left' | 'right';
/**
 * Joint flexion in degrees, per digit: base, middle and tip joints (for the thumb its metacarpal, proximal and distal
 * bones), toward the palm from the rig's rest pose; and `spread` in degrees, away from the middle finger (negative
 * draws a finger in). A digit left out keeps its rest pose.
 */
export interface HandPoseTable {
  readonly flex: Partial<Record<FingerName, readonly [number, number, number]>>;
  readonly spread?: Partial<Record<FingerName, number>>;
}
/** A hand pose: a named one from this module, a power grip of a bar's diameter, or a table of your own. */
export type HandPose =
  | { readonly name: 'relaxed' | 'fist' | 'flat' | 'point' | 'pinch' }
  | { readonly name: 'grip'; readonly diameter: number }
  | { readonly name: 'table'; readonly table: HandPoseTable };

const t3 = (a: number, b: number, c: number) => [a, b, c] as const;
// Flexion grows from the index to the little finger (Santello et al. 1998) and each tip joint is 2/3 of its middle
// joint (Rijpkema and Girard 1991). Rest posture ranges after Wheatland et al. 2015.
const TABLES: Record<'relaxed' | 'fist' | 'flat' | 'point' | 'pinch', HandPoseTable> = {
  relaxed: {
    // No thumb: a rig's bind pose splays the thumb out from the palm, so a table angle from rest would swing it off the
    // index; the clip's own thumb is kept (seen on the Kitty Hawk cast, r7 stills).
    flex: { index: t3(14, 26, 17), middle: t3(18, 32, 21), ring: t3(22, 37, 25), little: t3(26, 42, 28) },
    spread: { index: 3, ring: 3, little: 7 },
  },
  fist: {
    flex: { thumb: t3(30, 45, 35), index: t3(88, 100, 67), middle: t3(90, 102, 68), ring: t3(92, 104, 69), little: t3(94, 106, 71) },
    spread: { index: -2, ring: -2, little: -3 },
  },
  flat: { flex: { thumb: t3(0, 0, 0), index: t3(0, 0, 0), middle: t3(0, 0, 0), ring: t3(0, 0, 0), little: t3(0, 0, 0) }, spread: { index: 0, ring: 0, little: 0 } },
  point: {
    flex: { thumb: t3(25, 35, 30), index: t3(4, 5, 3), middle: t3(80, 100, 67), ring: t3(85, 103, 69), little: t3(90, 105, 70) },
    spread: { index: 2, ring: -2, little: -3 },
  },
  pinch: {
    flex: { thumb: t3(30, 25, 20), index: t3(40, 50, 33), middle: t3(32, 46, 31), ring: t3(36, 50, 33), little: t3(40, 54, 36) },
    spread: { index: 0, ring: 2, little: 5 },
  },
};
/** The rest posture of an idle hand: fingers a little curled, more toward the little finger. */
export const relaxed = (): HandPose => ({ name: 'relaxed' });
/** A closed fist, thumb over the middle phalanges. */
export const fist = (): HandPose => ({ name: 'fist' });
/** Straight fingers held together, as in a salute or a pushing palm. */
export const flat = (): HandPose => ({ name: 'flat' });
/** The index straight, the other fingers curled under the thumb. */
export const point = (): HandPose => ({ name: 'point' });
/** Thumb and index brought together to hold something small; the other fingers relaxed. */
export const pinch = (): HandPose => ({ name: 'pinch' });
/**
 * A power grip of a bar of `diameter` metres (Feix et al. 2016, medium wrap): each finger closes joint by joint until it
 * meets the bar, the bar lying across the palm at the knuckles. Default 0.035 (a tool handle or a wing upright).
 * @throws RangeError unless `diameter` is from 0.005 to 0.12 metres.
 */
export function grip(diameter = 0.035): HandPose {
  if (!(diameter >= 0.005 && diameter <= 0.12)) throw new RangeError('grip diameter must be from 0.005 to 0.12 metres');
  return { name: 'grip', diameter };
}
/** A pose of your own from a {@link HandPoseTable}. */
export function handPose(table: HandPoseTable): HandPose {
  checkTable(table);
  return { name: 'table', table };
}
function checkTable(table: HandPoseTable): void {
  if (!table || typeof table !== 'object' || !table.flex || typeof table.flex !== 'object')
    throw new TypeError('A hand pose table needs flex: {index: [base, middle, tip], ...} in degrees');
  for (const [finger, flex] of Object.entries(table.flex)) {
    if (!(FINGERS as readonly string[]).includes(finger)) throw new RangeError(`Unknown finger ${finger}; use ${FINGERS.join(', ')}`);
    if (!Array.isArray(flex) || flex.length !== 3 || !flex.every((v) => Number.isFinite(v) && v >= -30 && v <= 130))
      throw new RangeError(`Finger ${finger} flex must be three angles from -30 to 130 degrees`);
  }
  for (const [finger, spread] of Object.entries(table.spread ?? {}))
    if (!(FINGERS as readonly string[]).includes(finger) || !(Number.isFinite(spread) && Math.abs(spread as number) <= 40))
      throw new RangeError(`Finger ${finger} spread must be from -40 to 40 degrees`);
}

/** What {@link gripFinger} returns: the joint angles and where the bar lies, in the finger's flexion plane. */
export interface FingerGrip {
  /** Base, middle and tip joint flexion, degrees. */
  readonly flex: readonly [number, number, number];
  /** The bar's centre: `along` the rest finger from the base joint and `depth` toward the palm side, metres. */
  readonly along: number;
  readonly depth: number;
  /** Joint centres in the plane, base joint at [0, 0], the rest finger along +x, the palm side toward -y; 4 points. */
  readonly points: readonly (readonly [number, number])[];
  /** How far the fingertip's skin is from the bar's surface, metres (negative inside it). */
  readonly tipGap: number;
  /** The deepest a finger's skin goes into the bar, metres (0 when nothing does). */
  readonly depthIn: number;
}
/** Options of {@link gripFinger}. */
export interface FingerGripOptions {
  /** Half the finger's thickness, from a bone's centre line to the skin, metres. Default 0.18 of the first length. */
  thickness?: number;
  /** From the base joint's centre to the palm's skin, metres. Default 0.25 of the first length. */
  palm?: number;
}
const LIMITS = [95, 110, 80];
const segmentDistance = (c: readonly number[], a: readonly number[], b: readonly number[]) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    s = Math.max(0, Math.min(1, ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a[0] + dx * s - c[0], a[1] + dy * s - c[1]);
};
const chain = (lengths: readonly number[], flex: readonly number[]) => {
  const points: [number, number][] = [[0, 0]];
  let angle = 0;
  for (let k = 0; k < 3; k++) {
    angle -= (flex[k] * Math.PI) / 180;
    const [x, y] = points[k];
    points.push([x + lengths[k] * Math.cos(angle), y + lengths[k] * Math.sin(angle)]);
  }
  return points;
};
/**
 * One finger's power grip in its flexion plane (Rijpkema and Girard 1991): with the bar against the palm, the base joint
 * closes until a segment meets it, then the middle joint with the tip joint following at 2/3, then the tip joint alone,
 * each within its range (95, 110 and 80 degrees). The bar lies as deep in the palm as it can with the fingertip on it.
 * @param lengths the three phalanges, base to tip, metres.
 * @param diameter the bar's, metres.
 */
export function gripFinger(lengths: readonly [number, number, number], diameter: number, options: FingerGripOptions = {}): FingerGrip {
  if (!Array.isArray(lengths) || lengths.length !== 3 || !lengths.every((l) => l > 0 && l < 1))
    throw new RangeError('gripFinger needs three phalanx lengths in metres, each above 0 and below 1');
  if (!(diameter > 0 && diameter < 1)) throw new RangeError('gripFinger diameter must be above 0 and below 1 metre');
  const r = diameter / 2,
    thickness = options.thickness ?? 0.18 * lengths[0],
    palm = options.palm ?? 0.25 * lengths[0],
    reach = r + thickness,
    depth = r + palm,
    step = 0.1;
  const close = (along: number) => {
    const c = [along, -depth],
      flex = [0, 0, 0],
      touching = (from: number) => {
        const p = chain(lengths, flex);
        for (let k = from; k < 3; k++) if (segmentDistance(c, p[k], p[k + 1]) <= reach) return k;
        return -1;
      };
    // The base joint, then the middle with the tip at 2/3, then the tip alone, each until a segment touches.
    while (flex[0] < LIMITS[0] && touching(0) < 0) flex[0] = Math.min(LIMITS[0], flex[0] + step);
    let hit = touching(1);
    while (hit < 0 && flex[1] < LIMITS[1]) {
      flex[1] = Math.min(LIMITS[1], flex[1] + step);
      flex[2] = Math.min(LIMITS[2], (flex[1] * 2) / 3);
      hit = touching(1);
    }
    while (hit < 2 && flex[2] < LIMITS[2]) {
      flex[2] = Math.min(LIMITS[2], flex[2] + step);
      if (touching(2) === 2) break;
    }
    const points = chain(lengths, flex);
    let deepest = 0;
    for (let k = 0; k < 3; k++) deepest = Math.max(deepest, reach - segmentDistance(c, points[k], points[k + 1]));
    const tipGap = Math.hypot(points[3][0] - c[0], points[3][1] - c[1]) - reach;
    return { flex: [flex[0], flex[1], flex[2]] as const, along, depth, points, tipGap, depthIn: deepest };
  };
  // Of the places that bring the fingertip onto the bar (within half a millimetre), the one deepest in the palm: a power
  // grip holds the bar against the palm, not hooked on the fingertips. With none, the closest the fingertip gets.
  let best: FingerGrip | undefined,
    nearest: FingerGrip | undefined;
  for (let along = -r; along <= lengths[0] && !best; along += 0.00025) {
    const g = close(along);
    if (Math.abs(g.tipGap) <= 0.0005) best = g;
    if (!nearest || Math.abs(g.tipGap) < Math.abs(nearest.tipGap)) nearest = g;
  }
  return best ?? nearest!;
}

// ---- the rig ----
/** A rig as {@link measureHands} reads it: names, parents and the local rest pose, 10 numbers per bone. */
export interface HandRig {
  readonly names: readonly string[];
  readonly parents: readonly number[];
  /** Translation xyz, rotation quaternion xyzw, scale xyz per bone. */
  readonly rest: ArrayLike<number>;
}
/** One digit of a measured hand. */
export interface MeasuredFinger {
  /** Bone indices, base to tip. */
  readonly bones: readonly [number, number, number];
  /** Phalanx lengths, metres in the rig's space; the last is estimated (3/4 of the middle one) when the rig has no tip bone. */
  readonly lengths: readonly [number, number, number];
  /** Per bone, the local axis a positive turn about which curls the digit toward the palm. */
  readonly curl: readonly (readonly [number, number, number])[];
  /** The local axis of the base bone a positive turn about which spreads it away from the middle finger; null for the middle finger. */
  readonly spread: readonly [number, number, number] | null;
}
/** A hand found on a rig by {@link measureHands}. */
export interface MeasuredHand {
  readonly side: HandSide;
  /** The hand (wrist) bone. */
  readonly hand: number;
  /** The digits it has. */
  readonly fingers: Partial<Record<FingerName, MeasuredFinger>>;
  /** Unit palm normal in the rig's space at rest, out of the palm. */
  readonly palm: readonly [number, number, number];
  /** Local rest rotation per finger bone. */
  readonly rest: ReadonlyMap<number, readonly number[]>;
  /** World rest frames of the bones (position, rotation), the rig's space. */
  readonly world: (bone: number) => { position: readonly number[]; rotation: readonly number[] };
}

type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const scaled = (a: readonly number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const DIGIT_BONES: Record<FingerName, readonly string[]> = {
  thumb: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'],
  index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
  middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'],
  ring: ['RingProximal', 'RingIntermediate', 'RingDistal'],
  little: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'],
};

/**
 * Finds the hands of `rig` and measures them: finger bones through the retarget preset (`preset`, default the one
 * {@link detectSkeleton} finds), phalanx lengths, palm normal, and each joint's curl and spread axes from the rest pose,
 * so a pose turns the fingers the same on any rig. `map` (humanoid bone to bone index, such as a VRM's humanoid
 * section gives) replaces the preset for rigs whose names follow none. A hand without index, middle and little (or ring)
 * fingers is left out.
 * @throws TypeError for a malformed rig; RangeError when no preset matches.
 */
export function measureHands(
  rig: HandRig,
  preset?: SkeletonPreset,
  map?: ReadonlyMap<HumanoidBone, number>,
): Partial<Record<HandSide, MeasuredHand>> {
  const { names, parents, rest } = rig ?? ({} as HandRig);
  if (!Array.isArray(names) || !Array.isArray(parents) || parents.length !== names.length || !rest || rest.length !== names.length * 10)
    throw new TypeError('measureHands needs {names, parents, rest} with 10 rest numbers per bone');
  const chosen = map ? undefined : (preset ?? detectSkeleton(names)?.preset);
  if (!map && !chosen) throw new RangeError('measureHands found no skeleton preset for these bone names; pass one or a bone map');
  const bones = map ?? humanoidBones(names, chosen!);
  const frames: ({ position: V3; rotation: number[]; scale: V3 } | undefined)[] = [];
  const world = (i: number): { position: V3; rotation: number[]; scale: V3 } => {
    const known = frames[i];
    if (known) return known;
    const o = i * 10,
      p: V3 = [rest[o], rest[o + 1], rest[o + 2]],
      q = [rest[o + 3], rest[o + 4], rest[o + 5], rest[o + 6]],
      s: V3 = [rest[o + 7], rest[o + 8], rest[o + 9]],
      parent = parents[i];
    let frame;
    if (parent < 0) frame = { position: p, rotation: q, scale: s };
    else {
      const up = world(parent);
      frame = {
        position: [...up.position.map((v, k) => v + rotateByQuaternion([p[0] * up.scale[0], p[1] * up.scale[1], p[2] * up.scale[2]], up.rotation)[k])] as V3,
        rotation: normalizeQuaternion(multiplyQuaternions(up.rotation, q)),
        scale: [up.scale[0] * s[0], up.scale[1] * s[1], up.scale[2] * s[2]] as V3,
      };
    }
    frames[i] = frame;
    return frame;
  };
  const out: Partial<Record<HandSide, MeasuredHand>> = {};
  for (const side of ['left', 'right'] as const) {
    const bone = (name: string) => bones.get(`${side}${name}` as HumanoidBone),
      hand = bone('Hand'),
      index = bone('IndexProximal'),
      middle = bone('MiddleProximal'),
      outer = bone('LittleProximal') ?? bone('RingProximal');
    if (hand === undefined || index === undefined || middle === undefined || outer === undefined) continue;
    const at = (b: number) => world(b).position,
      forward = sub(at(middle), at(hand)),
      across = sub(at(index), at(outer));
    // A right hand's palm faces across x forward, a left hand's forward x across (a proper, unmirrored rig).
    const palm = unit(side === 'left' ? cross(forward, across) : cross(across, forward));
    const fingers: Partial<Record<FingerName, MeasuredFinger>> = {},
      restRotations = new Map<number, readonly number[]>();
    for (const finger of FINGERS) {
      const ids = DIGIT_BONES[finger].map((n) => bone(n));
      if (ids.some((b) => b === undefined)) continue;
      const [a, b, c] = ids as [number, number, number];
      const tip = names.findIndex((_, k) => parents[k] === c),
        l1 = Math.hypot(...sub(at(b), at(a))),
        l2 = Math.hypot(...sub(at(c), at(b))),
        l3 = tip >= 0 ? Math.hypot(...sub(at(tip), at(c))) : 0.75 * l2;
      const ends = [at(b), at(c), tip >= 0 ? at(tip) : null];
      const curl = [a, b, c].map((j, k) => {
        let along = ends[k] ? sub(ends[k]!, at(j)) : sub(at(c), at(b));
        along = unit(sub(along, scaled(palm, dot(along, palm))));
        // A turn about along x palm moves the bone toward the palm.
        return unit(rotateByQuaternion(cross(along, palm), conjugateQuaternion(world(j).rotation))) as readonly [number, number, number];
      });
      let spread: readonly [number, number, number] | null = null;
      if (finger !== 'middle' && finger !== 'thumb') {
        const along = unit(sub(at(b), at(a))),
          away = sub(at(a), at(middle)),
          side3 = unit(sub(sub(away, scaled(along, dot(away, along))), scaled(palm, dot(away, palm))));
        spread = unit(rotateByQuaternion(cross(along, side3), conjugateQuaternion(world(a).rotation))) as readonly [number, number, number];
      }
      for (const j of [a, b, c]) restRotations.set(j, [rest[j * 10 + 3], rest[j * 10 + 4], rest[j * 10 + 5], rest[j * 10 + 6]]);
      fingers[finger] = { bones: [a, b, c], lengths: [l1, l2, l3], curl, spread };
    }
    out[side] = { side, hand, fingers, palm, rest: restRotations, world: (b) => world(b) };
  }
  return out;
}

/** The flexion table `pose` gives on `hand` (a grip is solved for its fingers' lengths). */
export function poseTable(pose: HandPose, hand: MeasuredHand): HandPoseTable {
  if (!pose || typeof pose !== 'object') throw new TypeError('Pass a hand pose: relaxed(), fist(), grip(0.03) ...');
  if (pose.name === 'table') return pose.table;
  if (pose.name !== 'grip') {
    const table = TABLES[pose.name];
    if (!table) throw new RangeError(`Unknown hand pose ${String((pose as { name?: unknown }).name)}; pass relaxed(), fist(), grip(0.03) or another pose of this entry`);
    return table;
  }
  const flex: Record<string, readonly [number, number, number]> = { thumb: t3(35, 40, 30) };
  for (const finger of ['index', 'middle', 'ring', 'little'] as const) {
    const f = hand.fingers[finger];
    if (f) flex[finger] = gripFinger(f.lengths, pose.diameter).flex;
  }
  return { flex, spread: { index: 0, ring: 0, little: 0 } };
}

/**
 * The local rotations of `hand`'s finger bones for `table`: each bone's rest rotation turned by its flexion about its
 * curl axis, and the base bones first by their spread. Returns bone index to quaternion [x, y, z, w].
 */
export function handRotations(hand: MeasuredHand, table: HandPoseTable): Map<number, number[]> {
  const out = new Map<number, number[]>(),
    rad = Math.PI / 180;
  for (const finger of FINGERS) {
    const f = hand.fingers[finger],
      flex = table.flex[finger];
    if (!f || !flex) continue;
    f.bones.forEach((bone, k) => {
      let q = hand.rest.get(bone)!.slice();
      const spread = table.spread?.[finger] ?? 0;
      if (k === 0 && f.spread && spread) q = multiplyQuaternions(q, axisAngleToQuaternion(f.spread, spread * rad));
      out.set(bone, normalizeQuaternion(multiplyQuaternions(q, axisAngleToQuaternion(f.curl[k], flex[k] * rad))));
    });
  }
  return out;
}

/** How far a local rotation is turned from its rest rotation, degrees. */
export function turnFromRest(rotation: ArrayLike<number>, rest: ArrayLike<number>): number {
  const d = Math.abs(rotation[0] * rest[0] + rotation[1] * rest[1] + rotation[2] * rest[2] + rotation[3] * rest[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

/** A clip as {@link fingerTurn} reads it: `animation.clips[n]` fits. */
export interface FingerClip {
  readonly tracks: readonly { readonly node: number; readonly path: string; readonly values: ArrayLike<number> }[];
}
/**
 * The mean turn of `hand`'s 15 finger joints from rest over `clip`'s keys, degrees: a joint the clip does not key holds
 * its rest pose and counts 0. Mixamo's body clips measure 10 to 15 (near-flat boards), a keyed grip about 60.
 */
export function fingerTurn(clip: FingerClip, hand: MeasuredHand): number {
  let sum = 0,
    joints = 0;
  for (const finger of FINGERS) {
    const f = hand.fingers[finger];
    if (!f) continue;
    for (const bone of f.bones) {
      joints++;
      const track = clip.tracks.find((t) => t.node === bone && t.path === 'rotation');
      if (!track || track.values.length < 4) continue;
      const rest = hand.rest.get(bone)!;
      let total = 0;
      const keys = track.values.length >> 2;
      for (let k = 0; k < keys; k++) total += turnFromRest([track.values[k * 4], track.values[k * 4 + 1], track.values[k * 4 + 2], track.values[k * 4 + 3]], rest);
      sum += total / keys;
    }
  }
  return joints ? sum / joints : 0;
}

// ---- the Animator layer ----
/** A key of a hand's layer: from `time` (seconds on the layer's clock) the hand blends to `pose` over `blend` seconds. */
export interface HandKey {
  readonly time: number;
  /** The pose, or null to give the hand back to the clip (and the automatic rest posture). */
  readonly pose: HandPose | null;
  /** Seconds to reach it, 0 or more. Default 0.25. */
  readonly blend?: number;
  /** How much of the pose wins over the clip, 0 to 1. Default 1. */
  readonly weight?: number;
}
/** One hand's layer of {@link addHands}. */
export interface HandLayer {
  /** The measured hand, or undefined when the rig has none on this side. */
  readonly hand: MeasuredHand | undefined;
  /** The keys, sorted by time; edit them through {@link HandLayer.set} or replace the array. */
  keys: HandKey[];
  /** Blends to `pose` from the layer's current time (null gives the hand back to the clip). Returns the layer. */
  set(pose: HandPose | null, options?: { blend?: number; weight?: number }): this;
}
/** Options of {@link addHands}. */
export interface HandsOptions {
  /** Left hand's pose from the start, or null to leave it to the clip. Default null. */
  left?: HandPose | null;
  /** Right hand's pose from the start, or null to leave it to the clip. Default null. */
  right?: HandPose | null;
  /**
   * Blends the rest posture into clips whose finger joints turn less than `threshold` degrees on average (flat boards,
   * or no finger tracks at all), so no hand is ever a flat board. Default true.
   */
  auto?: boolean;
  /** Mean finger turn, degrees, below which a clip counts as flat. Default 15. */
  threshold?: number;
  /** The pose `auto` blends in. Default {@link relaxed}(). */
  rest?: HandPose;
  /** The rig's naming preset. Default the one `detectSkeleton` finds. */
  preset?: SkeletonPreset;
  /** Humanoid bone to glTF node index, for a rig no preset names (a VRM's humanoid section). Default none. */
  bones?: ReadonlyMap<HumanoidBone, number>;
}
/** A running {@link addHands}. */
export interface Hands {
  readonly left: HandLayer;
  readonly right: HandLayer;
  /**
   * Seconds on the layers' clock: advances with the Animator's time, and setting it seeks. A hand's pose is a pure
   * function of it and the Animator's state, so a seek gives what playing gives.
   */
  time: number;
  /** The clips `auto` blends the rest posture into, by name, per hand. */
  readonly flat: Readonly<Record<HandSide, readonly string[]>>;
  dispose(): void;
  [Symbol.dispose](): void;
}

// Each digit carries its own weight, so a digit a pose leaves out fades back to the clip instead of popping.
interface Evaluated {
  table: HandPoseTable | null;
  weights: Record<FingerName, number>;
}
const noWeights = (): Record<FingerName, number> => ({ thumb: 0, index: 0, middle: 0, ring: 0, little: 0 });
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const mixTables = (a: HandPoseTable, b: HandPoseTable, t: number): HandPoseTable => {
  const flex: Record<string, readonly [number, number, number]> = {},
    spread: Record<string, number> = {};
  for (const finger of FINGERS) {
    const fa = a.flex[finger],
      fb = b.flex[finger];
    if (fa && fb) flex[finger] = [fa[0] + (fb[0] - fa[0]) * t, fa[1] + (fb[1] - fa[1]) * t, fa[2] + (fb[2] - fa[2]) * t];
    else if (fa || fb) flex[finger] = (fa ?? fb)!; // the digit's weight fades it in or out
    spread[finger] = (a.spread?.[finger] ?? 0) + ((b.spread?.[finger] ?? 0) - (a.spread?.[finger] ?? 0)) * t;
  }
  return { flex, spread };
};
const checkKey = (key: HandKey) => {
  if (!key || !(key.time >= 0 && key.time < Infinity)) throw new RangeError('A hand key needs a time of 0 or more seconds');
  if (key.blend !== undefined && !(key.blend >= 0 && key.blend < Infinity)) throw new RangeError('A hand key blend must be 0 or more seconds');
  if (key.weight !== undefined && !(key.weight >= 0 && key.weight <= 1)) throw new RangeError('A hand key weight must be from 0 to 1');
  if (key.pose !== null && (!key.pose || typeof key.pose !== 'object')) throw new TypeError('A hand key pose must be a hand pose or null');
};

/**
 * Hand poses on `animator` (`@margoengine/animator`): one layer per hand, keyed over time, over the clip's finger tracks,
 * and by default the rest posture blended into every clip whose fingers are near flat. Runs on the finished pose, before
 * foot IK and the solvers. A rig whose bone names no preset knows, given no `bones` map, gets empty layers. Returns the
 * handle; dispose it to stop.
 * @example
 * const hands = addHands(animator, {right: grip(0.035)});
 * hands.left.set(point(), {blend: 0.4});
 * @throws RangeError for bad keys or options.
 */
export function addHands(animator: Animator, options: HandsOptions = {}): Hands {
  const threshold = options.threshold ?? 15;
  if (!(threshold >= 0 && threshold <= 90)) throw new RangeError('addHands threshold must be from 0 to 90 degrees');
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
  // A rig whose names no preset knows, given no bone map, has no hands to pose: the layers stand empty.
  const names = nodes.map((n) => n.name ?? ''),
    preset = options.bones ? undefined : (options.preset ?? detectSkeleton(names)?.preset),
    measured = options.bones || preset ? measureHands({ names, parents, rest }, preset, options.bones) : {},
    auto = options.auto ?? true,
    restPose = options.rest ?? relaxed(),
    clips = animator.animation.clips as unknown as readonly (FingerClip & { name: string })[],
    states = animator.options.states;
  const flat: Record<HandSide, string[]> = { left: [], right: [] };
  for (const side of ['left', 'right'] as const) {
    const hand = measured[side];
    if (hand && auto) for (const clip of clips) if (fingerTurn(clip, hand) < threshold) flat[side].push(clip.name);
  }
  // The share of the rest posture a state gets: 1 when its clip (every clip of a blend tree) is flat.
  const stateRest = (state: string, side: HandSide): number => {
    const tree = states[state];
    if (tree === undefined) return 0;
    const used = typeof tree === 'string' ? [tree] : tree.samples.map((s) => s.clip);
    return used.every((c) => flat[side].includes(c)) ? 1 : 0;
  };
  const cache = new Map<string, { table: HandPoseTable; rotations: Map<number, number[]> }>();
  const resolve = (hand: MeasuredHand, table: HandPoseTable) => {
    const key = hand.side + JSON.stringify(table);
    let hit = cache.get(key);
    if (!hit) {
      if (cache.size > 64) cache.clear();
      cache.set(key, (hit = { table, rotations: handRotations(hand, table) }));
    }
    return hit.rotations;
  };
  let clock = 0;
  const evaluate = (layer: HandLayer, hand: MeasuredHand, time: number): Evaluated => {
    let state: Evaluated = { table: null, weights: noWeights() };
    for (const key of layer.keys) {
      if (key.time > time) break;
      const table = key.pose ? poseTable(key.pose, hand) : state.table,
        weights = noWeights(),
        blend = key.blend ?? 0.25,
        t = blend > 0 ? smooth((time - key.time) / blend) : 1;
      if (key.pose && table) for (const finger of FINGERS) weights[finger] = table.flex[finger] ? (key.weight ?? 1) : 0;
      const from = state;
      for (const finger of FINGERS) weights[finger] = from.weights[finger] + (weights[finger] - from.weights[finger]) * t;
      state = { table: from.table && table ? mixTables(from.table, table, t) : (table ?? from.table), weights };
    }
    return state;
  };
  const layer = (side: HandSide): HandLayer => {
    const own: HandLayer = {
      hand: measured[side],
      keys: [],
      set(pose, { blend = 0.25, weight = 1 } = {}) {
        const key = { time: clock, pose, blend, weight };
        checkKey(key);
        own.keys = own.keys.filter((k) => k.time <= clock);
        own.keys.push(key);
        return own;
      },
    };
    const start = options[side];
    if (start) own.keys.push({ time: 0, pose: start, blend: 0 });
    return own;
  };
  const left = layer('left'),
    right = layer('right');
  let remove: (() => void) | null = animator.addLateStep((pose, step) => {
    clock += step;
    const fade = animator.transitionInfo;
    for (const own of [left, right]) {
      const hand = own.hand;
      if (!hand) continue;
      for (const key of own.keys) checkKey(key);
      own.keys.sort((a, b) => a.time - b.time);
      let restShare = auto ? stateRest(animator.state, hand.side) : 0;
      if (auto && fade && fade.duration > 0) {
        const t = Math.min(1, fade.elapsed / fade.duration);
        restShare = stateRest(fade.from, hand.side) * (1 - t) + restShare * t;
      }
      const keyed = evaluate(own, hand, clock);
      const keyedAny = FINGERS.some((finger) => keyed.weights[finger] > 0);
      if (restShare <= 0 && !keyedAny) continue;
      const restRotations = restShare > 0 ? resolve(hand, poseTable(restPose, hand)) : undefined,
        keyedRotations = keyedAny && keyed.table ? resolve(hand, keyed.table) : undefined;
      for (const finger of FINGERS) {
        const f = hand.fingers[finger];
        if (!f) continue;
        for (const bone of f.bones) {
          let q = pose.rotation[bone];
          if (restRotations?.has(bone)) q = interpolateQuaternions(q, restRotations.get(bone)!, restShare, 0.9995);
          if (keyedRotations?.has(bone) && keyed.weights[finger] > 0) q = interpolateQuaternions(q, keyedRotations.get(bone)!, keyed.weights[finger], 0.9995);
          pose.rotation[bone] = q;
        }
      }
    }
  });
  const dispose = () => {
    remove?.();
    remove = null;
  };
  animator.onDispose(dispose);
  return {
    left,
    right,
    get time() {
      return clock;
    },
    set time(value: number) {
      if (!(value >= 0 && value < Infinity)) throw new RangeError('Hands time must be a finite number of seconds, 0 or more');
      clock = value;
    },
    flat,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
