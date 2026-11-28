// Retarget presets: the bone names of common skeletons (Mixamo, Godot's humanoid profile, Roblox R15, MPFB's default rig and Margo's own
// humanoid) mapped onto one humanoid vocabulary, so a clip made for one plays on another with
// `@margoengine/animation`'s Retarget; plus rest-pose alignment, which turns the target's reference pose to match the
// source's (an A-pose character driven by T-pose clips) bone by bone.
import {
  axisAngleToQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
} from '@margoengine/math/quat';
import { cross, dot, length, normalize, scale, sub } from '@margoengine/math/vec3';
import { rotationBetween } from './ik.js';
import { parentOrder, worldFrames } from './rig.js';

/** Humanoid bones, by the names this package maps every preset to. */
export type HumanoidBone =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'jaw'
  | `${'left' | 'right'}${
      | 'Eye'
      | 'Shoulder'
      | 'UpperArm'
      | 'LowerArm'
      | 'Hand'
      | 'UpperLeg'
      | 'LowerLeg'
      | 'Foot'
      | 'Toes'
      | `${'Thumb'}${'Metacarpal' | 'Proximal' | 'Distal'}`
      | `${'Index' | 'Middle' | 'Ring' | 'Little'}${'Proximal' | 'Intermediate' | 'Distal'}`}`;

/** Skeleton naming conventions with a preset. */
export type SkeletonPreset = 'mixamo' | 'godot' | 'roblox' | 'margo' | 'cmu' | 'mpfb' | 'characterCreator' | 'humanoid';

const SIDES = ['left', 'right'] as const;
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const PHALANGES = ['Proximal', 'Intermediate', 'Distal'] as const;
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Every humanoid bone, parents before children. */
export const HUMANOID_BONES: readonly HumanoidBone[] = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'jaw',
  'leftEye',
  'rightEye',
  ...SIDES.flatMap((s) =>
    (['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'] as const)
      .map((b) => `${s}${b}` as HumanoidBone)
      .concat(FINGERS.flatMap((f) => PHALANGES.map((p) => `${s}${f}${p}` as HumanoidBone))),
  ),
  ...SIDES.flatMap((s) => (['UpperLeg', 'LowerLeg', 'Foot', 'Toes'] as const).map((b) => `${s}${b}` as HumanoidBone)),
];

/** The child each bone points at, for rest-pose alignment: the next bone down its limb. */
const AIM: Partial<Record<HumanoidBone, readonly HumanoidBone[]>> = {
  hips: ['spine'],
  spine: ['chest', 'upperChest', 'neck'],
  chest: ['upperChest', 'neck'],
  upperChest: ['neck'],
  neck: ['head'],
  ...Object.fromEntries(
    SIDES.flatMap((s) => [
      [`${s}Shoulder`, [`${s}UpperArm`]],
      [`${s}UpperArm`, [`${s}LowerArm`]],
      [`${s}LowerArm`, [`${s}Hand`]],
      [`${s}Hand`, [`${s}MiddleProximal`]],
      [`${s}ThumbMetacarpal`, [`${s}ThumbProximal`]],
      [`${s}ThumbProximal`, [`${s}ThumbDistal`]],
      ...FINGERS.flatMap((f) => [
        [`${s}${f}Proximal`, [`${s}${f}Intermediate`]],
        [`${s}${f}Intermediate`, [`${s}${f}Distal`]],
      ]),
      [`${s}UpperLeg`, [`${s}LowerLeg`]],
      [`${s}LowerLeg`, [`${s}Foot`]],
      [`${s}Foot`, [`${s}Toes`]],
    ]),
  ),
};

/**
 * Bones whose rest direction is the body's layout, not a pose: the trunk, neck and collarbones. Rest alignment leaves
 * them as the target has them (aiming them along a motion-capture skeleton's leaning trunk or rising collarbones would
 * hunch and shrug the target); it turns the limbs, hands and fingers, where T-pose and A-pose rigs differ.
 */
const LAYOUT: ReadonlySet<HumanoidBone> = new Set([
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'leftShoulder',
  'rightShoulder',
]);

/** Each preset's name for each humanoid bone it has (others are absent). */
const PRESETS: Record<SkeletonPreset, Partial<Record<HumanoidBone, string>>> = {
  humanoid: Object.fromEntries(HUMANOID_BONES.map((b) => [b, b])),
  // Mixamo's rig (the `mixamorig:` prefix is matched separately): Spine, Spine1, Spine2; Arm, ForeArm; UpLeg, Leg.
  mixamo: Object.fromEntries([
    ['hips', 'Hips'],
    ['spine', 'Spine'],
    ['chest', 'Spine1'],
    ['upperChest', 'Spine2'],
    ['neck', 'Neck'],
    ['head', 'Head'],
    ...SIDES.flatMap((s) => {
      const S = capital(s);
      return [
        [`${s}Eye`, `${S}Eye`],
        [`${s}Shoulder`, `${S}Shoulder`],
        [`${s}UpperArm`, `${S}Arm`],
        [`${s}LowerArm`, `${S}ForeArm`],
        [`${s}Hand`, `${S}Hand`],
        [`${s}ThumbMetacarpal`, `${S}HandThumb1`],
        [`${s}ThumbProximal`, `${S}HandThumb2`],
        [`${s}ThumbDistal`, `${S}HandThumb3`],
        ...FINGERS.flatMap((f) =>
          PHALANGES.map((p, i) => [`${s}${f}${p}`, `${S}Hand${f === 'Little' ? 'Pinky' : f}${i + 1}`]),
        ),
        [`${s}UpperLeg`, `${S}UpLeg`],
        [`${s}LowerLeg`, `${S}Leg`],
        [`${s}Foot`, `${S}Foot`],
        [`${s}Toes`, `${S}ToeBase`],
      ];
    }),
  ]),
  // Godot's SkeletonProfileHumanoid bone names (its Root is not a humanoid bone and stays at rest).
  godot: Object.fromEntries(HUMANOID_BONES.map((b) => [b, capital(b)])),
  // Roblox R15: LowerTorso and UpperTorso for the trunk, no neck, shoulders, toes or fingers. UpperTorso is the spine:
  // VRM 1.0 (humanoid.md) requires spine and makes chest optional, so the one trunk bone above the hips is spine.
  roblox: Object.fromEntries([
    ['hips', 'LowerTorso'],
    ['spine', 'UpperTorso'],
    ['head', 'Head'],
    ...SIDES.flatMap((s) => {
      const S = capital(s);
      return [
        [`${s}UpperArm`, `${S}UpperArm`],
        [`${s}LowerArm`, `${S}LowerArm`],
        [`${s}Hand`, `${S}Hand`],
        [`${s}UpperLeg`, `${S}UpperLeg`],
        [`${s}LowerLeg`, `${S}LowerLeg`],
        [`${s}Foot`, `${S}Foot`],
      ];
    }),
  ]),
  // The CMU Graphics Lab motion capture skeleton (Acclaim ASF, as `@margoengine/loaders/mocap`'s parseASF names its
  // joints: each at its bone's start). root is the pelvis; lowerback, upperback and thorax the trunk; lowerneck the
  // neck's base (upperneck stays at rest); lwrist the hand at the wrist and lfingers the knuckles it aims at. Thumbs are
  // one bone in CMU files and are left at rest.
  cmu: Object.fromEntries([
    ['hips', 'root'],
    ['spine', 'lowerback'],
    ['chest', 'upperback'],
    ['upperChest', 'thorax'],
    ['neck', 'lowerneck'],
    ['head', 'head'],
    ...SIDES.flatMap((s) => {
      const c = s[0];
      return [
        [`${s}Shoulder`, `${c}clavicle`],
        [`${s}UpperArm`, `${c}humerus`],
        [`${s}LowerArm`, `${c}radius`],
        [`${s}Hand`, `${c}wrist`],
        [`${s}MiddleProximal`, `${c}fingers`],
        [`${s}UpperLeg`, `${c}femur`],
        [`${s}LowerLeg`, `${c}tibia`],
        [`${s}Foot`, `${c}foot`],
        [`${s}Toes`, `${c}toes`],
      ];
    }),
  ]),
  // MPFB's (MakeHuman for Blender) default rig: root at the pelvis, spine05 up to spine01, neck01 to neck03, clavicle,
  // shoulder01 and upperarm01/02 (the second a twist bone), lowerarm01/02, wrist; fingerN-1 to -3 with finger1 the
  // thumb (metacarpal, proximal, distal) and finger2 to finger5 index to little; upperleg01, lowerleg01, foot, toe1-1.
  // Sides are the .L and .R suffixes.
  mpfb: Object.fromEntries([
    ['hips', 'root'],
    ['spine', 'spine05'],
    ['chest', 'spine03'],
    ['upperChest', 'spine01'],
    ['neck', 'neck01'],
    ['head', 'head'],
    ...SIDES.flatMap((s) => {
      const S = s === 'left' ? 'L' : 'R';
      return [
        [`${s}Shoulder`, `clavicle.${S}`],
        [`${s}UpperArm`, `upperarm01.${S}`],
        [`${s}LowerArm`, `lowerarm01.${S}`],
        [`${s}Hand`, `wrist.${S}`],
        [`${s}ThumbMetacarpal`, `finger1-1.${S}`],
        [`${s}ThumbProximal`, `finger1-2.${S}`],
        [`${s}ThumbDistal`, `finger1-3.${S}`],
        ...FINGERS.flatMap((f, n) => PHALANGES.map((p, i) => [`${s}${f}${p}`, `finger${n + 2}-${i + 1}.${S}`])),
        [`${s}UpperLeg`, `upperleg01.${S}`],
        [`${s}LowerLeg`, `lowerleg01.${S}`],
        [`${s}Foot`, `foot.${S}`],
        [`${s}Toes`, `toe1-1.${S}`],
      ];
    }),
  ]),
  // Character Creator's CC3+ skeleton (CC3, CC4 and CC5 export it; an Unreal or Unity export keeps the names):
  // CC_Base_Hip carries the body, CC_Base_Pelvis under it only the legs; Waist, Spine01 and Spine02 the trunk;
  // NeckTwist01 the neck; Thumb1 to 3 and Index, Mid, Ring, Pinky 1 to 3 the fingers. The twist and share bones
  // follow their limb in the file's own skin and stay at rest here.
  characterCreator: Object.fromEntries([
    ['hips', 'CC_Base_Hip'],
    ['spine', 'CC_Base_Waist'],
    ['chest', 'CC_Base_Spine01'],
    ['upperChest', 'CC_Base_Spine02'],
    ['neck', 'CC_Base_NeckTwist01'],
    ['head', 'CC_Base_Head'],
    ['jaw', 'CC_Base_JawRoot'],
    ...SIDES.flatMap((s) => {
      const S = `CC_Base_${s === 'left' ? 'L' : 'R'}_`;
      return [
        [`${s}Eye`, `${S}Eye`],
        [`${s}Shoulder`, `${S}Clavicle`],
        [`${s}UpperArm`, `${S}Upperarm`],
        [`${s}LowerArm`, `${S}Forearm`],
        [`${s}Hand`, `${S}Hand`],
        [`${s}ThumbMetacarpal`, `${S}Thumb1`],
        [`${s}ThumbProximal`, `${S}Thumb2`],
        [`${s}ThumbDistal`, `${S}Thumb3`],
        ...FINGERS.flatMap((f) =>
          PHALANGES.map((p, i) => [
            `${s}${f}${p}`,
            `${S}${f === 'Little' ? 'Pinky' : f === 'Middle' ? 'Mid' : f}${i + 1}`,
          ]),
        ),
        [`${s}UpperLeg`, `${S}Thigh`],
        [`${s}LowerLeg`, `${S}Calf`],
        [`${s}Foot`, `${S}Foot`],
        [`${s}Toes`, `${S}ToeBase`],
      ];
    }),
  ]),
  // @margoengine/exporters/skin's humanoidJoints(): a joint is named after where it sits (the elbow turns the forearm).
  margo: Object.fromEntries([
    ['hips', 'hips'],
    ['spine', 'spine'],
    ['chest', 'chest'],
    ['neck', 'neck'],
    ['head', 'head'],
    ...SIDES.flatMap((s) => [
      [`${s}UpperArm`, `${s}Shoulder`],
      [`${s}LowerArm`, `${s}Elbow`],
      [`${s}Hand`, `${s}Wrist`],
      [`${s}UpperLeg`, `${s}Hip`],
      [`${s}LowerLeg`, `${s}Knee`],
      [`${s}Foot`, `${s}Ankle`],
    ]),
  ]),
};

/** A bone name without a namespace or rig prefix (`mixamorig:Hips`, `mixamorig1_Hips`, `Armature|Hips` give `Hips`). */
const bare = (name: string) => name.replace(/^.*[:|]/, '').replace(/^mixamorig\d*_?/i, '');

/** A preset's bone name -> humanoid bone, for matching (case-insensitive, prefixes removed). */
const lookup = (preset: SkeletonPreset) =>
  new Map(Object.entries(PRESETS[preset]).map(([bone, name]) => [bare(name!).toLowerCase(), bone as HumanoidBone]));

/**
 * Which humanoid bone each of `names` is under `preset`, as bone -> index into `names`. Matching ignores case and rig
 * prefixes (`mixamorig:`, `mixamorig1_`, `Armature|`); names the preset does not know are left out, and the first of
 * two names for one bone wins.
 * @throws TypeError unless `names` is an array; RangeError for an unknown preset.
 */
export function humanoidBones(names: readonly string[], preset: SkeletonPreset): Map<HumanoidBone, number> {
  if (!Array.isArray(names)) throw new TypeError('humanoidBones needs the skeleton bone names');
  if (!Object.hasOwn(PRESETS, preset))
    throw new RangeError(`Skeleton preset ${String(preset)} must be one of ${Object.keys(PRESETS).join(', ')}`);
  const table = lookup(preset),
    out = new Map<HumanoidBone, number>();
  names.forEach((name, i) => {
    const bone = typeof name === 'string' ? table.get(bare(name).toLowerCase()) : undefined;
    if (bone && !out.has(bone)) out.set(bone, i);
  });
  return out;
}

/** {@link detectSkeleton}'s result. */
export interface SkeletonMatch {
  /** The preset whose names match best. */
  readonly preset: SkeletonPreset;
  /** Humanoid bones found under it. */
  readonly bones: number;
}

/** How many of `names` spell their preset bone name with the preset's own case (breaks Godot / humanoid ties). */
function exactCase(names: readonly string[], preset: SkeletonPreset, found: Map<HumanoidBone, number>): number {
  let exact = 0;
  for (const [bone, index] of found) if (bare(names[index]) === bare(PRESETS[preset][bone]!)) exact++;
  return exact;
}

/**
 * The preset whose bone names match the most of `names` (Mixamo with any `mixamorig` prefix, Godot's humanoid profile,
 * Roblox R15, Margo's humanoidJoints, the CMU motion capture skeleton, MPFB, Character Creator's CC3+ skeleton, or the humanoid names themselves), or null when none finds hips and a head.
 */
export function detectSkeleton(names: readonly string[]): SkeletonMatch | null {
  let best: SkeletonMatch | null = null,
    bestExact = -1;
  // Specific presets first, so a tie keeps the specific one; Godot's names are the humanoid ones capitalised, so
  // between equal counts the preset whose case the names use wins.
  for (const preset of ['mixamo', 'roblox', 'godot', 'margo', 'cmu', 'mpfb', 'characterCreator', 'humanoid'] as const) {
    const found = humanoidBones(names, preset);
    if (!found.has('hips') || !found.has('head')) continue;
    const exact = exactCase(names, preset, found);
    if (!best || found.size > best.bones || (found.size === best.bones && exact > bestExact)) {
      best = { preset, bones: found.size };
      bestExact = exact;
    }
  }
  return best;
}

/** A rig as `@margoengine/animation`'s `retargetRig` makes it: names, parents and a local rest pose (10 per bone). */
export interface RetargetRigData {
  /** Bone names; a bone's index is its position here. */
  readonly names: readonly string[];
  /** Parent bone per bone, -1 at the top. */
  readonly parents: readonly number[];
  /** Local rest pose, 10 numbers per bone: translation xyz, rotation quaternion xyzw, scale xyz. */
  readonly rest: Float64Array;
}

/** Options for {@link prepareRetarget}. */
export interface PrepareRetargetOptions {
  /** The source's naming; detected from its bone names when omitted. */
  from?: SkeletonPreset;
  /** The target's naming; detected when omitted. */
  to?: SkeletonPreset;
  /**
   * Turn the target's reference pose so each mapped limb bone (arms, hands, fingers, legs, feet) points the way its source
   * bone does at rest (default true): a T-pose source then drives an A-pose target into the same T-pose. The trunk, neck
   * and collarbones keep the target's own rest, since their directions are body layout, not pose. A source hand with no
   * finger bones below it (a BVH End Site, an ASF or Xsens hand segment) is one rigid segment, so the target's hand and
   * long fingers are laid straight along it, in line with the source forearm when the source has no finger base at all;
   * thumbs keep the target's rest. False keeps the target's whole rest pose.
   */
  alignRest?: boolean;
}

/** {@link prepareRetarget}'s result: what `new Retarget(source, target, {names, hip})` takes. */
export interface PreparedRetarget {
  /** The target rig to pass to Retarget: the given one, or with its reference pose aligned to the source's. */
  readonly target: RetargetRigData;
  /** Target bone name -> source bone name; '' leaves a target bone at rest. */
  readonly names: Record<string, string>;
  /** The target's hip bone name, when both have hips. */
  readonly hip?: string;
  /** The source's naming, given or detected. */
  readonly from: SkeletonPreset;
  /** The target's naming, given or detected. */
  readonly to: SkeletonPreset;
  /** Humanoid bones the target has but the source does not (they stay at rest). */
  readonly unmapped: readonly HumanoidBone[];
  /**
   * Unmapped target bone names whose rest the alignment turned (fingers laid along a fingerless source hand). Retarget
   * reads this as its `hold` option and keeps them at the aligned rest, so they do not stay in the target's own pose.
   */
  readonly hold: readonly string[];
}

/**
 * Maps a source skeleton's bones onto a target's by their presets (detected from the names unless given) and, by
 * default, aligns the target's reference pose to the source's. Pass the result to `@margoengine/animation`'s
 * `Retarget`: `new Retarget(source, prepared.target, prepared)`. Both rigs' model spaces must face the same way.
 * @throws TypeError for a rig without names and parents; RangeError for a bad rest pose or parent, a naming that is
 * not recognised (pass `from` / `to`) or presets that map no bones.
 */
export function prepareRetarget(
  source: RetargetRigData,
  target: RetargetRigData,
  options: PrepareRetargetOptions = {},
): PreparedRetarget {
  checkRetargetRig(source, 'source');
  checkRetargetRig(target, 'target');
  const from = options.from ?? detectSkeleton(source.names)?.preset,
    to = options.to ?? detectSkeleton(target.names)?.preset;
  if (!from)
    throw new RangeError(
      'Retarget source naming is not recognised; pass from (mixamo, godot, roblox, margo, cmu or humanoid)',
    );
  if (!to)
    throw new RangeError(
      'Retarget target naming is not recognised; pass to (mixamo, godot, roblox, margo, cmu or humanoid)',
    );
  const sourceBones = humanoidBones(source.names, from),
    targetBones = humanoidBones(target.names, to),
    names: Record<string, string> = {},
    unmapped: HumanoidBone[] = [];
  // Every target bone is listed: mapped ones to their source bone, the rest to '' (left at rest).
  for (const name of target.names) names[name] = '';
  for (const [bone, index] of targetBones) {
    // A source with one finger segment (CMU's lfingers, mapped to the middle finger) drives every long finger.
    const one = /^(left|right)(Index|Ring|Little)Proximal$/.exec(bone)?.[1];
    const s = sourceBones.get(bone) ?? (one ? sourceBones.get(`${one}MiddleProximal` as HumanoidBone) : undefined);
    if (s === undefined) unmapped.push(bone);
    else names[target.names[index]] = source.names[s];
  }
  if (!Object.values(names).some(Boolean))
    throw new RangeError(`Retarget maps no bones from ${from} to ${to}; check the presets`);
  const hip = targetBones.has('hips') && sourceBones.has('hips') ? target.names[targetBones.get('hips')!] : undefined;
  const turned = new Set<number>(),
    aligned =
      options.alignRest === false ? target : alignRestPose(source, target, sourceBones, targetBones, turned),
    hold = [...turned].filter((b) => !names[target.names[b]]).map((b) => target.names[b]);
  return { target: aligned, names, ...(hip ? { hip } : {}), from, to, unmapped, hold };
}

function checkRetargetRig(rig: RetargetRigData, label: string): void {
  const n = rig?.names?.length;
  if (!Array.isArray(rig?.names) || !Array.isArray(rig.parents) || rig.parents.length !== n)
    throw new TypeError(`Retarget ${label} needs a rig with names and parents; make it with retargetRig`);
  if (!(rig.rest instanceof Float64Array) || rig.rest.length !== n * 10 || !rig.rest.every(Number.isFinite))
    throw new RangeError(`Retarget ${label} rest pose needs 10 finite numbers per bone`);
  rig.parents.forEach((p, i) => {
    if (!Number.isInteger(p) || p < -1 || p >= n || p === i)
      throw new RangeError(`Retarget ${label} bone ${i} parent ${p} is invalid; use -1 or another bone's index`);
  });
  parentOrder(rig.parents, `Retarget ${label}`);
}

/** World rotation and position of every bone of a local pose (10 per bone), full matrices as glTF 2.0 3.5.3. */
function worldPose(rig: RetargetRigData, local: Float64Array) {
  const n = rig.names.length,
    frames = worldFrames(rig.parents, local, parentOrder(rig.parents, 'Retarget rig')),
    rotation: number[][] = new Array(n),
    position: number[][] = new Array(n);
  for (let b = 0; b < n; b++) {
    rotation[b] = Array.from(frames.rotation.subarray(b * 4, b * 4 + 4));
    position[b] = Array.from(frames.position.subarray(b * 3, b * 3 + 3));
  }
  return { rotation, position, linear: frames.linear };
}

/** `v` taken back through bone `b`'s 3x3 world part (column-major in `linear`), or null when it is singular. */
function unapply(linear: Float64Array, b: number, v: readonly number[]): number[] | null {
  const m = linear.subarray(b * 9, b * 9 + 9),
    det = (a: readonly number[], c: readonly number[], d: readonly number[]) =>
      a[0] * (c[1] * d[2] - c[2] * d[1]) - c[0] * (a[1] * d[2] - a[2] * d[1]) + d[0] * (a[1] * c[2] - a[2] * c[1]),
    x = [m[0], m[1], m[2]],
    y = [m[3], m[4], m[5]],
    z = [m[6], m[7], m[8]],
    whole = det(x, y, z);
  // Cramer's rule.
  if (!(Math.abs(whole) > 1e-300)) return null;
  return [det(v, y, z) / whole, det(x, v, z) / whole, det(x, y, v) / whole];
}

/** The direction across the palm, from the little finger's base to the index finger's base. */
function palmAcross(
  side: (typeof SIDES)[number],
  bones: Map<HumanoidBone, number>,
  positions: readonly number[][],
): [number, number, number] | null {
  const index = bones.get(`${side}IndexProximal`),
    little = bones.get(`${side}LittleProximal`);
  return index === undefined || little === undefined ? null : sub(positions[index], positions[little]);
}

/** Roll around the already aligned wrist-to-middle-finger axis, in the target parent's frame. */
function alignPalm(
  aim: readonly number[],
  swing: [number, number, number, number],
  from: readonly number[],
  to: readonly number[],
): [number, number, number, number] {
  const axis = normalize(aim),
    across = rotateByQuaternion(normalize(from), swing),
    desired = normalize(to),
    have = sub(across, scale(axis, dot(across, axis))),
    want = sub(desired, scale(axis, dot(desired, axis)));
  // A coincident or collinear pair of finger bases cannot tell us which way the palm faces.
  if (length(have) < 1e-9 || length(want) < 1e-9) return swing;
  const roll = Math.atan2(dot(axis, cross(have, want)), dot(have, want));
  return multiplyQuaternions(axisAngleToQuaternion(axis, roll), swing);
}

const FLAT_HAND = /^(left|right)(Hand|(Index|Middle|Ring|Little)(Proximal|Intermediate))$/;

/**
 * Where a target hand or finger bone points at rest when its source has no finger below it: along the source hand,
 * which is then one rigid segment. The source hand's direction is wrist to middle finger base when the source has that
 * bone, otherwise the forearm's continuation (a hand that ends in a BVH End Site or an ASF hand segment rests in line
 * with its forearm in the T-pose these files rest in). Null when the bone is not a hand or long finger, the source has
 * no hand on that side, or the target bone has no child to aim.
 */
function flatHand(
  bone: HumanoidBone,
  sourceBones: Map<HumanoidBone, number>,
  targetBones: Map<HumanoidBone, number>,
  positions: readonly number[][],
): { child: number; want: number[] } | null {
  const side = FLAT_HAND.exec(bone)?.[1],
    child = AIM[bone]?.[0];
  if (!side || !child || !targetBones.has(child)) return null;
  const hand = sourceBones.get(`${side}Hand` as HumanoidBone),
    base = sourceBones.get(`${side}MiddleProximal` as HumanoidBone),
    forearm = sourceBones.get(`${side}LowerArm` as HumanoidBone);
  if (hand === undefined) return null;
  const [from, to] = base !== undefined ? [hand, base] : forearm !== undefined ? [forearm, hand] : [];
  if (from === undefined || to === undefined) return null;
  return { child: targetBones.get(child)!, want: [0, 1, 2].map((c) => positions[to][c] - positions[from][c]) };
}

/**
 * The target rig with its rest rotations turned, parents first, so every mapped bone points at its mapped child the
 * way the source's bone does at rest, with the palms also facing the same way when the finger bases are mapped.
 */
function alignRestPose(
  source: RetargetRigData,
  target: RetargetRigData,
  sourceBones: Map<HumanoidBone, number>,
  targetBones: Map<HumanoidBone, number>,
  turned: Set<number>,
): RetargetRigData {
  const rest = new Float64Array(target.rest),
    sourceWorld = worldPose(source, source.rest),
    order = HUMANOID_BONES.filter((bone) => targetBones.has(bone));
  for (const bone of order) {
    if (LAYOUT.has(bone)) continue;
    const aim = (AIM[bone] ?? []).find((child) => targetBones.has(child) && sourceBones.has(child));
    let tc: number, want: number[];
    if (aim && sourceBones.has(bone)) {
      const s = sourceBones.get(bone)!,
        sc = sourceBones.get(aim)!;
      tc = targetBones.get(aim)!;
      want = [0, 1, 2].map((c) => sourceWorld.position[sc][c] - sourceWorld.position[s][c]);
    } else {
      // A source hand that ends without fingers is one rigid segment (Biovision BVH ends it with an End Site; Acclaim
      // ASF and Xsens hands are single segments): its target hand and the finger bones the source lacks lie along it.
      const flat = flatHand(bone, sourceBones, targetBones, sourceWorld.position);
      if (!flat) continue;
      tc = flat.child;
      want = flat.want;
    }
    const t = targetBones.get(bone)!;
    const world = worldPose(target, rest),
      have = [0, 1, 2].map((c) => world.position[tc][c] - world.position[t][c]);
    if (Math.hypot(...have) < 1e-9 || Math.hypot(...want) < 1e-9) continue;
    // Turn the bone in its parent's frame, before the parent's stretch: the child's offset there is the bone's local
    // rotation times a vector the rotation does not change, so turning it from `have` to `want` (both taken back
    // through the parent's full world matrix, glTF 2.0 3.5.3) aims the child exactly, uneven parent scales included.
    const p = target.parents[t],
      from = p < 0 ? have : unapply(world.linear, p, have),
      to = p < 0 ? want : unapply(world.linear, p, want);
    if (!from || !to) continue; // a flat parent scale: nothing below it can be aimed
    let turn = rotationBetween(from, to);
    if (bone === 'leftHand' || bone === 'rightHand') {
      const side = bone === 'leftHand' ? 'left' : 'right',
        targetPalm = palmAcross(side, targetBones, world.position),
        sourcePalm = palmAcross(side, sourceBones, sourceWorld.position);
      if (targetPalm && sourcePalm) {
        const across = p < 0 ? targetPalm : unapply(world.linear, p, targetPalm),
          desired = p < 0 ? sourcePalm : unapply(world.linear, p, sourcePalm);
        if (across && desired) turn = alignPalm(rotateByQuaternion(from, turn), turn, across, desired);
      }
    }
    const l = t * 10 + 3;
    rest.set(normalizeQuaternion(multiplyQuaternions(turn, [rest[l], rest[l + 1], rest[l + 2], rest[l + 3]])), l);
    turned.add(t);
  }
  return { names: target.names, parents: target.parents, rest };
}
