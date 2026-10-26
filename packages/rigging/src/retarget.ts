// Retarget presets: the bone names of common skeletons (Mixamo, Godot's humanoid profile, Roblox R15 and Margo's own
// humanoid) mapped onto one humanoid vocabulary, so a clip made for one plays on another with
// `@margoengine/animation`'s Retarget; plus rest-pose alignment, which turns the target's reference pose to match the
// source's (an A-pose character driven by T-pose clips) bone by bone.
import { multiplyQuaternions, normalizeQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { rotationBetween } from './ik.js';

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
export type SkeletonPreset = 'mixamo' | 'godot' | 'roblox' | 'margo' | 'humanoid';

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
  // Roblox R15: LowerTorso and UpperTorso for the trunk, no neck, shoulders, toes or fingers.
  roblox: Object.fromEntries([
    ['hips', 'LowerTorso'],
    ['chest', 'UpperTorso'],
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
 * Roblox R15, Margo's humanoidJoints, or the humanoid names themselves), or null when none finds hips and a head.
 */
export function detectSkeleton(names: readonly string[]): SkeletonMatch | null {
  let best: SkeletonMatch | null = null,
    bestExact = -1;
  // Specific presets first, so a tie keeps the specific one; Godot's names are the humanoid ones capitalised, so
  // between equal counts the preset whose case the names use wins.
  for (const preset of ['mixamo', 'roblox', 'godot', 'margo', 'humanoid'] as const) {
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
   * Turn the target's reference pose so each mapped bone points the way its source bone does at rest (default true):
   * a T-pose source then drives an A-pose target into the same T-pose. False keeps the target's own rest pose.
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
      'Retarget source naming is not recognised; pass from (mixamo, godot, roblox, margo or humanoid)',
    );
  if (!to)
    throw new RangeError(
      'Retarget target naming is not recognised; pass to (mixamo, godot, roblox, margo or humanoid)',
    );
  const sourceBones = humanoidBones(source.names, from),
    targetBones = humanoidBones(target.names, to),
    names: Record<string, string> = {},
    unmapped: HumanoidBone[] = [];
  // Every target bone is listed: mapped ones to their source bone, the rest to '' (left at rest).
  for (const name of target.names) names[name] = '';
  for (const [bone, index] of targetBones) {
    const s = sourceBones.get(bone);
    if (s === undefined) unmapped.push(bone);
    else names[target.names[index]] = source.names[s];
  }
  if (!Object.values(names).some(Boolean))
    throw new RangeError(`Retarget maps no bones from ${from} to ${to}; check the presets`);
  const hip = targetBones.has('hips') && sourceBones.has('hips') ? target.names[targetBones.get('hips')!] : undefined;
  const aligned = options.alignRest === false ? target : alignRestPose(source, target, sourceBones, targetBones);
  return { target: aligned, names, ...(hip ? { hip } : {}), from, to, unmapped };
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
}

/** World rotation, position and scale of every bone of a local pose (10 per bone). */
function worldPose(rig: RetargetRigData, local: Float64Array) {
  const n = rig.names.length,
    rotation: number[][] = new Array(n),
    position: number[][] = new Array(n),
    scale: number[][] = new Array(n),
    done = new Uint8Array(n);
  const visit = (b: number): void => {
    if (done[b]) return;
    const p = rig.parents[b],
      l = b * 10,
      q = [local[l + 3], local[l + 4], local[l + 5], local[l + 6]],
      s = [local[l + 7], local[l + 8], local[l + 9]];
    if (p < 0) {
      rotation[b] = q;
      position[b] = [local[l], local[l + 1], local[l + 2]];
      scale[b] = s;
    } else {
      visit(p);
      const o = rotateByQuaternion(
        [local[l] * scale[p][0], local[l + 1] * scale[p][1], local[l + 2] * scale[p][2]],
        rotation[p],
      );
      rotation[b] = multiplyQuaternions(rotation[p], q);
      position[b] = [position[p][0] + o[0], position[p][1] + o[1], position[p][2] + o[2]];
      scale[b] = [scale[p][0] * s[0], scale[p][1] * s[1], scale[p][2] * s[2]];
    }
    done[b] = 1;
  };
  for (let b = 0; b < n; b++) visit(b);
  return { rotation, position };
}

/**
 * The target rig with its rest rotations turned, parents first, so every mapped bone points at its mapped child the
 * way the source's bone does at rest.
 */
function alignRestPose(
  source: RetargetRigData,
  target: RetargetRigData,
  sourceBones: Map<HumanoidBone, number>,
  targetBones: Map<HumanoidBone, number>,
): RetargetRigData {
  const rest = new Float64Array(target.rest),
    sourceWorld = worldPose(source, source.rest),
    order = HUMANOID_BONES.filter((bone) => targetBones.has(bone));
  for (const bone of order) {
    const aim = (AIM[bone] ?? []).find((child) => targetBones.has(child) && sourceBones.has(child));
    if (!aim || !sourceBones.has(bone)) continue;
    const t = targetBones.get(bone)!,
      tc = targetBones.get(aim)!,
      s = sourceBones.get(bone)!,
      sc = sourceBones.get(aim)!;
    const world = worldPose(target, rest),
      have = [0, 1, 2].map((c) => world.position[tc][c] - world.position[t][c]),
      want = [0, 1, 2].map((c) => sourceWorld.position[sc][c] - sourceWorld.position[s][c]);
    if (Math.hypot(...have) < 1e-9 || Math.hypot(...want) < 1e-9) continue;
    const turned = multiplyQuaternions(rotationBetween(have, want), world.rotation[t]),
      p = target.parents[t],
      parent = p < 0 ? [0, 0, 0, 1] : world.rotation[p];
    rest.set(
      normalizeQuaternion(multiplyQuaternions([-parent[0], -parent[1], -parent[2], parent[3]], turned)),
      t * 10 + 3,
    );
  }
  return { names: target.names, parents: target.parents, rest };
}
