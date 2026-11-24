// Saved ragdoll profiles: tuned bones, limits, masses and shapes as plain JSON, bound to a skeleton by bone name, and a
// humanoid preset to start from. Segment mass shares are P. de Leva, "Adjustments to Zatsiorsky-Seluyanov's segment
// inertia parameters", J. Biomechanics 1996; segment lengths are D. Drillis, R. Contini, "Body Segment Parameters", 1966.
// The joint ranges are the common published ranges of motion, narrowed to one cone per joint. Our own design.
import type { Mesh } from '@margoengine/core/extension';
import { conjugateQuaternion, normalizeQuaternion, rotateByQuaternion, rotationToQuaternion } from '@margoengine/math/quat';
import { detectSkeleton, humanoidBones, type HumanoidBone } from '@margoengine/rigging/retarget';
import type { Ragdoll, RagdollBone, RagdollJoint, RagdollOptions, RagdollSettings, RagdollShape } from './ragdoll.js';

const FORMAT = 'margoengine-ragdoll';
const VERSION = 1;

/** One bone of a {@link RagdollProfile}. Everything but `name` falls back to the ragdoll's defaults. */
export interface RagdollProfileBone {
  /** The node's name in the skeleton. */
  name: string;
  /** Joint to the parent bone; left out on the root bone. */
  joint?: RagdollJoint;
  /** Bone length in world units. */
  length?: number;
  /** Capsule radius in world units. */
  radius?: number;
  /** Mass in kilograms. */
  mass?: number;
  /** The collider, in the bone's own frame. */
  shape?: RagdollShape;
}

/** A ragdoll as data: `JSON.stringify` it, ship it, and bind it to a skeleton with {@link ragdollOptions}. */
export interface RagdollProfile {
  /** Always `'margoengine-ragdoll'`. */
  format: string;
  /** Format version, 1. */
  version: number;
  /** Body settings shared by every bone. */
  settings?: Partial<RagdollSettings>;
  /** The bones. */
  bones: RagdollProfileBone[];
}

/** Options of {@link humanoidProfile}. */
export interface HumanoidProfileOptions {
  /** Whole body mass in kilograms. Default 70. */
  mass?: number;
  /** Which node is which bone, for a rig whose names no preset knows. Default: detected from the node names. */
  bones?: Partial<Record<HumanoidBone, Mesh>>;
}

type Vec3 = [number, number, number];

/** A body segment: its share of the body's mass, and the joint its bones get. */
interface Segment {
  share: number;
  joint: RagdollJoint | 'knee' | 'elbow';
  /** Segment length as a share of stature, for a bone whose children do not measure it. */
  length?: number;
}
const cone = (swing: number, twist: number): RagdollJoint => ({ type: 'cone', swing, twist: [-twist, twist] });
const SEGMENTS: Record<string, Segment> = {
  trunk: { share: 0.4346, joint: cone(0.35, 0.35) },
  head: { share: 0.0694, joint: cone(0.7, 0.9), length: 0.13 },
  upperArm: { share: 0.0271, joint: cone(1.75, 1.2) },
  lowerArm: { share: 0.0162, joint: 'elbow' },
  hand: { share: 0.0061, joint: cone(0.9, 0.3), length: 0.108 },
  upperLeg: { share: 0.1416, joint: cone(1.3, 0.5) },
  lowerLeg: { share: 0.0433, joint: 'knee' },
  foot: { share: 0.0137, joint: cone(0.6, 0.2), length: 0.152 },
};
const KNEE_RANGE = 2.4;
const ELBOW_RANGE = 2.5;
/** Hip height as a share of stature (Drillis and Contini). */
const HIP_HEIGHT = 0.53;
const REQUIRED: readonly HumanoidBone[] = [
  'hips',
  'head',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
];
/** Each humanoid bone a ragdoll uses, with its segment and which group of the same segment it shares mass with. */
const USED: readonly [HumanoidBone, string, string][] = [
  ['hips', 'trunk', 'trunk'],
  ['spine', 'trunk', 'trunk'],
  ['chest', 'trunk', 'trunk'],
  ['upperChest', 'trunk', 'trunk'],
  ['neck', 'head', 'head'],
  ['head', 'head', 'head'],
  ...(['left', 'right'] as const).flatMap((s): [HumanoidBone, string, string][] => [
    [`${s}Shoulder`, 'trunk', 'trunk'],
    [`${s}UpperArm`, 'upperArm', `${s}UpperArm`],
    [`${s}LowerArm`, 'lowerArm', `${s}LowerArm`],
    [`${s}Hand`, 'hand', `${s}Hand`],
    [`${s}UpperLeg`, 'upperLeg', `${s}UpperLeg`],
    [`${s}LowerLeg`, 'lowerLeg', `${s}LowerLeg`],
    [`${s}Foot`, 'foot', `${s}Foot`],
  ]),
];

const position = (node: Mesh): Vec3 => [node.matrix[12], node.matrix[13], node.matrix[14]];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
};
/** The world rotation of `node`, as a quaternion. */
function rotationOf(node: Mesh): [number, number, number, number] {
  const m = node.matrix;
  return normalizeQuaternion(
    rotationToQuaternion(m, [0, 0, 0, 1], Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])),
  ) as [number, number, number, number];
}
const plainShape = (shape: RagdollShape): RagdollShape =>
  shape.type === 'hull' ? { type: 'hull', points: Array.from(shape.points) } : shape;

/**
 * The ragdoll as a profile, every value as built: tune it, save it, and {@link ragdollOptions} builds the same one.
 * @example
 * localStorage.setItem('hero', JSON.stringify(saveRagdollProfile(ragdoll)));
 * @throws TypeError without a ragdoll, RangeError for a bone with no name or two bones with one name.
 */
export function saveRagdollProfile(ragdoll: Ragdoll): RagdollProfile {
  if (!ragdoll?.bones) throw new TypeError('saveRagdollProfile needs a Ragdoll: saveRagdollProfile(ragdoll).');
  const seen = new Set<string>();
  return {
    format: FORMAT,
    version: VERSION,
    settings: { ...ragdoll.settings },
    bones: ragdoll.bones.map((part) => {
      const { name } = part.node;
      if (!name) throw new RangeError('A ragdoll profile finds bones by name; name every bone node before saving.');
      if (seen.has(name)) throw new RangeError(`Two ragdoll bones are named "${name}"; rename one, a profile finds bones by name.`);
      seen.add(name);
      return {
        name,
        ...(part.spec ? { joint: part.spec } : {}),
        length: part.length,
        radius: part.radius,
        mass: part.mass,
        shape: plainShape(part.shape),
      };
    }),
  };
}

/**
 * The options that build a profile's ragdoll on a skeleton, finding each bone among `nodes` by name.
 * @example
 * const ragdoll = Ragdoll.attach(physics, ragdollOptions(JSON.parse(saved), model.nodes));
 * @param profile A profile, parsed from JSON or made by {@link humanoidProfile}.
 * @param nodes The skeleton's nodes, such as `model.nodes`.
 * @throws TypeError without a profile or nodes, RangeError for another format, a newer version or a bone not in `nodes`.
 */
export function ragdollOptions(profile: RagdollProfile, nodes: readonly Mesh[]): RagdollOptions {
  if (!profile || !Array.isArray(nodes))
    throw new TypeError('ragdollOptions needs a profile and the nodes: ragdollOptions(profile, model.nodes).');
  if (profile.format !== FORMAT) throw new RangeError(`That is not a ragdoll profile: its format is not "${FORMAT}"; pass what saveRagdollProfile made.`);
  if (!(profile.version <= VERSION))
    throw new RangeError(`This profile is version ${profile.version}; this package reads up to ${VERSION}. Update it.`);
  if (!Array.isArray(profile.bones) || !profile.bones.length)
    throw new RangeError('A ragdoll profile needs a non-empty bones list; pass what saveRagdollProfile made.');
  const named = new Map<string, Mesh>(),
    twice = new Set<string>();
  for (const node of nodes) {
    if (named.has(node.name)) twice.add(node.name);
    named.set(node.name, node);
  }
  const bones = profile.bones.map(({ name, ...bone }): RagdollBone => {
    const node = named.get(name);
    if (!node) throw new RangeError(`The profile's bone "${name}" is not in this skeleton; pass its nodes.`);
    if (twice.has(name)) throw new RangeError(`Two nodes are named "${name}", so the profile cannot tell them apart; rename one.`);
    return { node, ...bone };
  });
  return { ...profile.settings, bones };
}

/**
 * A profile for a humanoid in a T or A pose, as a place to start: anatomical joint ranges, knees and elbows as hinges
 * that bend the right way, and each bone's share of `mass` from published body segment tables. Build the ragdoll in the
 * pose this reads.
 * @example
 * const ragdoll = Ragdoll.attach(physics, ragdollOptions(humanoidProfile(model.nodes), model.nodes));
 * @throws TypeError without nodes, RangeError for a bad mass or a rig missing hips, a head, or an arm or leg bone.
 */
export function humanoidProfile(nodes: readonly Mesh[], options: HumanoidProfileOptions = {}): RagdollProfile {
  if (!Array.isArray(nodes)) throw new TypeError('humanoidProfile needs the skeleton nodes: humanoidProfile(model.nodes).');
  const total = options.mass ?? 70;
  if (!(total > 0) || total === Infinity) throw new RangeError('Humanoid mass must be positive kilograms, e.g. 70.');
  const rig = options.bones ?? detected(nodes),
    missing = REQUIRED.filter((bone) => !rig[bone]);
  if (missing.length)
    throw new RangeError(`This rig has no ${missing.join(', ')}; pass them as options.bones: {hips: node, ...}.`);
  const hips = rig.hips!,
    { parents } = hips.engine.store;
  hips.engine.store.tick(false);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Every node from each used bone up to the hips: a ragdoll is one tree. A node between two bones joins the lower one.
  const groups = new Map<Mesh, { segment: string; group: string }>();
  for (const [bone, segment, group] of USED) {
    const top = rig[bone];
    if (!top) continue;
    groups.set(top, { segment, group });
  }
  for (const [bone, segment, group] of USED) {
    let node = rig[bone];
    while (node && node !== hips) {
      const above = byId.get(parents[node.id]);
      if (!above)
        throw new RangeError(`Humanoid bone ${bone} is not under the hips; check the bones passed as options.bones.`);
      if (!groups.has(above)) groups.set(above, { segment, group });
      node = above;
    }
  }
  // Facing: up from the hips to the head, left from the right leg to the left. x left, y up, z forward is right handed.
  const up = unit(minus(position(rig.head!), position(hips))),
    left = unit(minus(position(rig.leftUpperLeg!), position(rig.rightUpperLeg!))),
    forward = unit(cross(left, up)),
    sole = rig.leftFoot ?? rig.leftLowerLeg!,
    hipHeight = minus(position(hips), position(sole)).reduce((sum, v, k) => sum + v * up[k], 0),
    stature = hipHeight / HIP_HEIGHT;
  const hinge = (node: Mesh, end: Mesh | undefined, bend: Vec3, range: number): RagdollJoint => {
    // Turning about d x f takes the bone's direction d toward f.
    const toward = unit(minus(position(end ?? node), position(node))),
      axis = rotateByQuaternion(unit(cross(toward, bend)), conjugateQuaternion(rotationOf(node)));
    return { type: 'hinge', axis: [axis[0], axis[1], axis[2]], limits: [0, range] };
  };
  const counts = new Map<string, number>();
  for (const { group } of groups.values()) counts.set(group, (counts.get(group) ?? 0) + 1);
  const ends = new Map<Mesh, Mesh | undefined>();
  for (const side of ['left', 'right'] as const) {
    ends.set(rig[`${side}LowerLeg`]!, rig[`${side}Foot`]);
    ends.set(rig[`${side}LowerArm`]!, rig[`${side}Hand`]);
  }
  const bones = [...groups].map(([node, { segment: name, group }]): RagdollProfileBone => {
    const segment = SEGMENTS[name],
      used = USED.some(([bone]) => rig[bone] === node);
    // A node between two bones of a limb (a wrist before the hand, a twist bone) turns little.
    let joint = used ? segment.joint : cone(0.35, 0.35);
    if (joint === 'knee') joint = hinge(node, ends.get(node), [-forward[0], -forward[1], -forward[2]], KNEE_RANGE);
    else if (joint === 'elbow') joint = hinge(node, ends.get(node), forward, ELBOW_RANGE);
    return {
      name: node.name,
      ...(node === hips ? {} : { joint }),
      ...(used && segment.length !== undefined && node !== rig.neck ? { length: segment.length * stature } : {}),
      mass: segment.share / counts.get(group)!,
    };
  });
  // A rig with no hands or feet shares their mass among the rest.
  const shares = bones.reduce((sum, bone) => sum + bone.mass!, 0);
  for (const bone of bones) bone.mass = (bone.mass! / shares) * total;
  return { format: FORMAT, version: VERSION, bones };
}

/** The bones the names of `nodes` give, under the naming that fits best. */
function detected(nodes: readonly Mesh[]): Partial<Record<HumanoidBone, Mesh>> {
  const names = nodes.map((node) => node.name ?? ''),
    match = detectSkeleton(names),
    rig: Partial<Record<HumanoidBone, Mesh>> = {};
  if (match) for (const [bone, index] of humanoidBones(names, match.preset)) rig[bone] = nodes[index];
  return rig;
}
