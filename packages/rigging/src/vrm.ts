// VRM 1.0 avatars from the VRM Consortium's published specifications: VRMC_vrm (humanoid, expressions, lookAt, meta,
// firstPerson) and VRMC_springBone. An avatar is the extension's own JSON, checked and with defaults, so nothing a file
// holds is lost and names match the specification. The rest of this file runs it: expressions by the specification's
// override and accumulation rules, gaze by its LookAt space and range maps, spring bones through ./springs.js, in the
// order the specification recommends (LookAt, expressions, spring bones).
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import {
  axisAngleToQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  splitTRS,
} from '@margoengine/math/quat';
import type { Animator } from '@margoengine/animator';
import { GLB_BIN, GLB_JSON, GLB_MAGIC, glbChunks, isGLB } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import type { HumanoidBone } from './retarget.js';
import { SpringBones, springAccess, type SpringBonesOptions, type SpringChain } from './springs.js';

/** The expressions the specification names. */
export type VRMPresetExpression =
  | 'happy'
  | 'angry'
  | 'sad'
  | 'relaxed'
  | 'surprised'
  | 'aa'
  | 'ih'
  | 'ou'
  | 'ee'
  | 'oh'
  | 'blink'
  | 'blinkLeft'
  | 'blinkRight'
  | 'lookUp'
  | 'lookDown'
  | 'lookLeft'
  | 'lookRight'
  | 'neutral';

/** How an expression holds back lip sync, blinking or gaze: not at all, fully, or in step with its own value. */
export type VRMOverride = 'none' | 'block' | 'blend';

/** One expression, with the specification's field names. */
export interface VRMExpression {
  /** Values above 0.5 count as 1, the rest as 0. */
  isBinary?: boolean;
  /** Morph targets: `node` (with a mesh), target `index`, `weight` at full value. */
  morphTargetBinds?: { node: number; index: number; weight: number }[];
  /** Material colours: `material`, `type`, `targetValue` at full value. */
  materialColorBinds?: {
    material: number;
    type: 'color' | 'emissionColor' | 'shadeColor' | 'matcapColor' | 'rimColor' | 'outlineColor';
    targetValue: [number, number, number, number];
  }[];
  /** Texture moves: `material`, `scale` and `offset` at full value. */
  textureTransformBinds?: { material: number; scale?: [number, number]; offset?: [number, number] }[];
  overrideBlink?: VRMOverride;
  overrideLookAt?: VRMOverride;
  overrideMouth?: VRMOverride;
  [field: string]: unknown;
}

/** A gaze range: gaze up to `inputMaxValue` degrees maps onto 0 to `outputScale`. */
export interface VRMRangeMap {
  inputMaxValue: number;
  outputScale: number;
}

/** `VRMC_vrm.lookAt`. */
export interface VRMLookAtData {
  /** `bone` turns the eye bones, `expression` drives lookUp, lookDown, lookLeft and lookRight. */
  type: 'bone' | 'expression';
  /** LookAt space's origin in the head bone's space (between the eyes). */
  offsetFromHeadBone?: Vec3;
  rangeMapHorizontalInner?: VRMRangeMap;
  rangeMapHorizontalOuter?: VRMRangeMap;
  rangeMapVerticalDown?: VRMRangeMap;
  rangeMapVerticalUp?: VRMRangeMap;
  [field: string]: unknown;
}

/** `VRMC_vrm.meta`: who made the model and what may be done with it. */
export interface VRMMeta {
  name: string;
  authors: string[];
  licenseUrl: string;
  version?: string;
  [field: string]: unknown;
}

/** `VRMC_springBone`, as in the file. */
export interface VRMSpringBoneData {
  specVersion?: string;
  colliders?: {
    node: number;
    shape: {
      sphere?: { offset?: Vec3; radius?: number };
      capsule?: { offset?: Vec3; radius?: number; tail?: Vec3 };
    };
  }[];
  colliderGroups?: { name?: string; colliders: number[] }[];
  springs?: {
    name?: string;
    joints: {
      node: number;
      hitRadius?: number;
      stiffness?: number;
      gravityPower?: number;
      gravityDir?: Vec3;
      dragForce?: number;
    }[];
    colliderGroups?: number[];
    center?: number;
  }[];
  [field: string]: unknown;
}

/** A VRM 1.0 avatar: `VRMC_vrm` as in the file, with `VRMC_springBone` beside it when the file has one. */
export interface VRMAvatar {
  specVersion: string;
  meta: VRMMeta;
  humanoid: { humanBones: Partial<Record<HumanoidBone, { node: number }>>; [field: string]: unknown };
  expressions?: {
    preset?: Partial<Record<VRMPresetExpression, VRMExpression>>;
    custom?: Record<string, VRMExpression>;
    [field: string]: unknown;
  };
  lookAt?: VRMLookAtData;
  firstPerson?: { meshAnnotations?: { node: number; type: string }[]; [field: string]: unknown };
  /** `VRMC_springBone`. */
  springBone?: VRMSpringBoneData;
  [field: string]: unknown;
}

/** The parts of a glTF document this entry reads. */
export interface VRMDocument {
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  nodes?: {
    children?: number[];
    mesh?: number;
    scale?: readonly number[];
    rotation?: readonly number[];
    matrix?: readonly number[];
  }[];
  meshes?: { primitives: { targets?: unknown[] }[] }[];
  materials?: unknown[];
  [field: string]: unknown;
}

/** Humanoid bones a VRM must have. */
export const VRM_REQUIRED_BONES: readonly HumanoidBone[] = [
  'hips',
  'spine',
  'head',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
];

const PRESETS = new Set<string>([
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
  'neutral',
]);
const KINDS = {
  overrideMouth: ['aa', 'ih', 'ou', 'ee', 'oh'],
  overrideBlink: ['blink', 'blinkLeft', 'blinkRight'],
  overrideLookAt: ['lookUp', 'lookDown', 'lookLeft', 'lookRight'],
} as const;

// Each humanoid bone's nearest possible humanoid parents, nearest first: the specification's parent table, where a
// bone that need not exist is skipped. Sides are written once.
const LIMBS: [string, string][] = [
  ['UpperLeg', 'hips'],
  ['LowerLeg', '.UpperLeg'],
  ['Foot', '.LowerLeg'],
  ['Toes', '.Foot'],
  ['Shoulder', 'upperChest chest spine'],
  ['UpperArm', '.Shoulder upperChest chest spine'],
  ['LowerArm', '.UpperArm'],
  ['Hand', '.LowerArm'],
  ['Eye', 'head'],
];
function parentTable(): Map<string, string[]> {
  const table = new Map<string, string[]>([
    ['spine', ['hips']],
    ['chest', ['spine']],
    ['upperChest', ['chest']],
    ['neck', ['upperChest', 'chest', 'spine']],
    ['head', ['neck', 'upperChest', 'chest', 'spine']],
    ['jaw', ['head']],
  ]);
  for (const side of ['left', 'right']) {
    for (const [bone, parents] of LIMBS)
      table.set(
        side + bone,
        parents.split(' ').map((p) => (p[0] === '.' ? side + p.slice(1) : p)),
      );
    const finger = (name: string, parents: string[]): void => void table.set(side + name, parents);
    finger('ThumbMetacarpal', [side + 'Hand']);
    finger('ThumbProximal', [side + 'ThumbMetacarpal']);
    finger('ThumbDistal', [side + 'ThumbProximal']);
    for (const digit of ['Index', 'Middle', 'Ring', 'Little']) {
      finger(digit + 'Proximal', [side + 'Hand']);
      finger(digit + 'Intermediate', [side + digit + 'Proximal']);
      finger(digit + 'Distal', [side + digit + 'Intermediate']);
    }
  }
  return table;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The JSON document of a `.vrm` file, or `source` if it is one already. */
function documentOf(source: Uint8Array | VRMDocument): VRMDocument {
  if (source instanceof Uint8Array) {
    if (!isGLB(source)) throw new TypeError('A VRM file is a GLB; pass the bytes of a .vrm or .glb file');
    return parseJSON<VRMDocument>(new TextDecoder().decode(glbChunks(source)[0].data));
  }
  if (!object(source)) throw new TypeError('readVRM needs the bytes of a .vrm file or a parsed glTF document');
  return source;
}

/**
 * Reads the VRM 1.0 avatar of a `.vrm` file's bytes, or of a glTF document (`model.asset.doc`). The result is a copy,
 * so editing it does not touch the document.
 * @throws TypeError for something that is not a VRM, MargoError `unsupported` for VRM 0.x.
 */
export function readVRM(source: Uint8Array | VRMDocument): VRMAvatar {
  const doc = documentOf(source),
    extensions = doc.extensions ?? {},
    vrm = extensions.VRMC_vrm as VRMAvatar | undefined;
  if (!object(vrm)) {
    if (object(extensions.VRM))
      throw new MargoError('unsupported', 'This is a VRM 0.x file; export it as VRM 1.0, or convert it, to read it here');
    throw new TypeError('This glTF has no VRMC_vrm extension; pass a VRM 1.0 file');
  }
  if (typeof vrm.specVersion !== 'string' || !/^1(\.|$)/.test(vrm.specVersion))
    throw new MargoError('unsupported', `VRM specVersion ${String(vrm.specVersion)} is not 1.x; export it as VRM 1.0`);
  if (!object(vrm.meta) || !object(vrm.humanoid) || !object(vrm.humanoid.humanBones))
    throw new TypeError('VRMC_vrm needs meta and humanoid.humanBones; repair the file');
  const avatar = structuredClone(vrm),
    springBone = extensions.VRMC_springBone;
  if (object(springBone)) avatar.springBone = structuredClone(springBone) as VRMSpringBoneData;
  return avatar;
}

/** The expressions of `avatar`, presets and custom ones, by name. */
function expressionsOf(avatar: VRMAvatar): [string, VRMExpression][] {
  return [...Object.entries(avatar.expressions?.preset ?? {}), ...Object.entries(avatar.expressions?.custom ?? {})];
}

/**
 * Every way `avatar` breaks the specification against `doc`: required fields and bones, bone order, scales, binds that
 * point at nothing, spring chains that are not ancestor lines. Empty when it is valid. {@link writeVRM} refuses any.
 */
export function checkVRM(avatar: VRMAvatar, doc: VRMDocument): string[] {
  const issues: string[] = [],
    nodes = doc.nodes ?? [],
    parents = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((node, i) => node.children?.forEach((child) => (parents[child] = i)));
  const known = (node: unknown): boolean => Number.isInteger(node) && (node as number) >= 0 && (node as number) < nodes.length;
  const above = (low: number, high: number): boolean => {
    for (let b = parents[low]; b !== -1; b = parents[b]) if (b === high) return true;
    return false;
  };
  const meta = avatar.meta;
  if (!meta?.name) issues.push('meta.name is required');
  if (!Array.isArray(meta?.authors) || !meta.authors.length) issues.push('meta.authors needs at least one author');
  if (!meta?.licenseUrl) issues.push('meta.licenseUrl is required');
  const bones = (avatar.humanoid?.humanBones ?? {}) as Record<string, { node: number } | undefined>,
    table = parentTable(),
    seen = new Map<number, string>();
  for (const bone of VRM_REQUIRED_BONES) if (!bones[bone]) issues.push(`humanoid bone ${bone} is required`);
  for (const [bone, value] of Object.entries(bones)) {
    const node = value?.node;
    if (bone !== 'hips' && !table.has(bone)) issues.push(`${bone} is not a humanoid bone`);
    if (!known(node)) {
      issues.push(`humanoid bone ${bone} names node ${String(node)}, which does not exist`);
      continue;
    }
    if (seen.has(node!)) issues.push(`humanoid bones ${seen.get(node!)} and ${bone} share node ${node}`);
    seen.set(node!, bone);
    const scale = nodes[node!].scale;
    if (scale && scale.some((v) => !(v > 0))) issues.push(`humanoid bone ${bone} needs a positive scale`);
    const parent = table.get(bone)?.find((name) => bones[name]);
    if (parent && known(bones[parent]!.node) && !above(node!, bones[parent]!.node))
      issues.push(`humanoid bone ${bone} must descend from ${parent}`);
  }
  if (bones.upperChest && !bones.chest) issues.push('humanoid bone upperChest needs chest');
  for (const name of Object.keys(avatar.expressions?.custom ?? {}))
    if (PRESETS.has(name)) issues.push(`custom expression ${name} has a preset's name`);
  for (const [name, expression] of expressionsOf(avatar)) {
    for (const bind of expression.morphTargetBinds ?? []) {
      const mesh = known(bind.node) ? doc.meshes?.[nodes[bind.node].mesh ?? -1] : undefined,
        targets = mesh?.primitives?.[0]?.targets?.length ?? 0;
      if (!mesh) issues.push(`expression ${name} binds node ${bind.node}, which has no mesh`);
      else if (!(bind.index >= 0 && bind.index < targets))
        issues.push(`expression ${name} binds morph target ${bind.index} of node ${bind.node}, which has ${targets}`);
    }
    const materials = doc.materials?.length ?? 0;
    for (const bind of [...(expression.materialColorBinds ?? []), ...(expression.textureTransformBinds ?? [])])
      if (!(bind.material >= 0 && bind.material < materials))
        issues.push(`expression ${name} binds material ${bind.material}, which does not exist`);
  }
  if (avatar.lookAt && avatar.lookAt.type !== 'bone' && avatar.lookAt.type !== 'expression')
    issues.push(`lookAt.type ${String(avatar.lookAt.type)} must be bone or expression`);
  for (const annotation of avatar.firstPerson?.meshAnnotations ?? [])
    if (!known(annotation.node)) issues.push(`firstPerson names node ${annotation.node}, which does not exist`);
  const spring = avatar.springBone;
  for (const collider of spring?.colliders ?? [])
    if (!known(collider.node)) issues.push(`spring collider names node ${collider.node}, which does not exist`);
  spring?.springs?.forEach((chain, i) => {
    chain.joints.forEach((joint, j) => {
      if (!known(joint.node)) issues.push(`spring ${i} joint names node ${joint.node}, which does not exist`);
      else if (j && known(chain.joints[j - 1].node) && !above(joint.node, chain.joints[j - 1].node))
        issues.push(`spring ${i} joint ${joint.node} must descend from the joint before it`);
    });
  });
  return issues;
}

/**
 * Writes `avatar` into a GLB: `VRMC_vrm` and `VRMC_springBone` replace what the file had, and everything else, other
 * extensions, the BIN chunk and later chunks, stays as it was, byte for byte. Turns any rigged GLB into a `.vrm`.
 * @throws TypeError for bytes that are not a GLB, RangeError naming what {@link checkVRM} found.
 */
export function writeVRM(glb: Uint8Array, avatar: VRMAvatar): Uint8Array {
  if (!(glb instanceof Uint8Array) || !isGLB(glb)) throw new TypeError('writeVRM needs the bytes of a GLB file');
  const chunks = glbChunks(glb),
    doc = parseJSON<VRMDocument>(new TextDecoder().decode(chunks[0].data)),
    issues = checkVRM(avatar, doc);
  if (issues.length) throw new RangeError(`This VRM is invalid; fix it: ${issues.join('; ')}`);
  const { springBone, ...vrm } = avatar,
    extensions = (doc.extensions ??= {}),
    used = new Set(doc.extensionsUsed ?? []);
  extensions.VRMC_vrm = vrm;
  used.add('VRMC_vrm');
  if (springBone) {
    extensions.VRMC_springBone = springBone;
    used.add('VRMC_springBone');
  } else {
    delete extensions.VRMC_springBone;
    used.delete('VRMC_springBone');
  }
  doc.extensionsUsed = [...used];
  const text = new TextEncoder().encode(JSON.stringify(doc)),
    padded = (text.length + 3) & ~3,
    rest = chunks.slice(1),
    total = 12 + 8 + padded + rest.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0),
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, GLB_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + padded);
  let at = 20 + padded;
  for (const chunk of rest) {
    view.setUint32(at, chunk.data.length, true);
    view.setUint32(at + 4, chunk.type, true);
    out.set(chunk.data, at + 8);
    at += 8 + chunk.data.length;
  }
  return out;
}

/** Fields of a new avatar. */
export interface CreateVRMOptions {
  /** Model name. */
  name: string;
  /** At least one author. */
  authors: string[];
  /** Humanoid bone to glTF node index; `humanoidBones` from `margoengine/rigging/retarget` makes it from node names. */
  bones: ReadonlyMap<HumanoidBone, number> | Partial<Record<HumanoidBone, number>>;
  /** Licence page. Default the VRM Public License 1.0. */
  licenseUrl?: string;
  expressions?: VRMAvatar['expressions'];
  lookAt?: VRMLookAtData;
  /** Spring bones, as in the file. */
  springBone?: VRMSpringBoneData;
}

/** A new avatar for {@link writeVRM}, from the fields a VRM must have. The other `meta` fields take their defaults. */
export function createVRM(options: CreateVRMOptions): VRMAvatar {
  const { name, authors, bones, licenseUrl = 'https://vrm.dev/licenses/1.0/', ...rest } = options ?? ({} as CreateVRMOptions),
    entries = bones instanceof Map ? [...bones] : Object.entries(bones ?? {}),
    humanBones = Object.fromEntries(entries.map(([bone, node]) => [bone, { node }]));
  return { specVersion: '1.0', meta: { name, authors, licenseUrl }, humanoid: { humanBones }, ...rest };
}

/**
 * The spring bones of `avatar` as {@link addSpringBones} options: joints and centers are glTF node indices, as in the
 * file. Null when it has none. A spring of one joint moves nothing and is left out, as the specification has it.
 */
export function vrmSprings(avatar: VRMAvatar): SpringBonesOptions | null {
  const data = avatar?.springBone;
  if (!data?.springs?.length) return null;
  const colliders = (data.colliders ?? []).map((collider) => {
      const { sphere, capsule } = collider.shape ?? {},
        shape = capsule ?? sphere;
      if (!shape) throw new TypeError('A VRM spring collider needs a sphere or a capsule shape; repair the file');
      return {
        node: collider.node,
        offset: shape.offset ?? ([0, 0, 0] as Vec3),
        tail: capsule ? (capsule.tail ?? ([0, 0, 0] as Vec3)) : null,
        // The schema allows 0, which touches nothing; a sliver keeps the shape's place in the list.
        radius: shape.radius || 1e-9,
      };
    }),
    groups = data.colliderGroups ?? [],
    chains: SpringChain[] = [];
  for (const spring of data.springs) {
    if (spring.joints.length < 2) continue;
    const hits = new Set<number>();
    for (const group of spring.colliderGroups ?? []) for (const index of groups[group]?.colliders ?? []) hits.add(index);
    chains.push({
      joints: spring.joints.map((joint) => joint.node),
      settings: spring.joints.map((joint) => ({
        stiffness: joint.stiffness ?? 1,
        drag: joint.dragForce ?? 0.5,
        gravity: joint.gravityPower ?? 0,
        gravityDirection: joint.gravityDir ?? [0, -1, 0],
        radius: joint.hitRadius ?? 0,
      })),
      center: spring.center ?? null,
      colliders: [...hits],
    });
  }
  return { chains, colliders };
}

/** Extra expressions that lip sync, blink or gaze overrides hold back, as the specification suggests for custom ones. */
export interface VRMExpressionsOptions {
  mouth?: readonly string[];
  blink?: readonly string[];
  lookAt?: readonly string[];
}

/** The morph, colour and texture values the expressions come to. */
export interface VRMExpressionOutput {
  /** Every morph target any expression binds: node, target index and weight. */
  readonly morphs: readonly { node: number; index: number; weight: number }[];
  /** Per bound colour: material, type, and each expression's share with its target, to add to the base value. */
  readonly colors: readonly {
    material: number;
    type: string;
    parts: readonly { value: number; target: readonly number[] }[];
  }[];
  /** Per bound material: each expression's share with its scale and offset. */
  readonly transforms: readonly {
    material: number;
    parts: readonly { value: number; scale: readonly number[]; offset: readonly number[] }[];
  }[];
}

/**
 * An avatar's expressions as plain data: set values, read what they come to under the specification's override rules.
 * {@link addVRM} applies them to a model.
 */
export class VRMExpressions {
  /** Expression names, presets and custom ones. */
  readonly names: readonly string[];
  private readonly list: Map<string, VRMExpression>;
  private readonly values = new Map<string, number>();
  private readonly kinds: [keyof typeof KINDS, Set<string>][];
  /** @param options custom expressions that overrides also hold back. */
  constructor(avatar: VRMAvatar, options: VRMExpressionsOptions = {}) {
    this.list = new Map(expressionsOf(avatar));
    this.names = [...this.list.keys()];
    this.kinds = [
      ['overrideMouth', new Set([...KINDS.overrideMouth, ...(options.mouth ?? [])])],
      ['overrideBlink', new Set([...KINDS.overrideBlink, ...(options.blink ?? [])])],
      ['overrideLookAt', new Set([...KINDS.overrideLookAt, ...(options.lookAt ?? [])])],
    ];
  }

  /**
   * Sets an expression's value, clamped to 0 to 1. A preset the avatar lacks is ignored, as every preset is optional.
   * @throws RangeError for a non-finite value or an unknown custom name.
   */
  set(name: VRMPresetExpression | (string & {}), value: number): this {
    if (!Number.isFinite(value)) throw new RangeError(`Expression ${name} value must be a finite number`);
    if (!this.list.has(name) && !PRESETS.has(name))
      throw new RangeError(`Expression ${name} is not on this avatar; see expressions.names`);
    this.values.set(name, Math.min(1, Math.max(0, value)));
    return this;
  }

  /** The value last set, 0 if none. */
  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  /** What each expression comes to after `isBinary` and the overrides, by name. */
  resolve(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [name, expression] of this.list) {
      const value = this.get(name);
      out.set(name, expression.isBinary ? (value > 0.5 ? 1 : 0) : value);
    }
    for (const [field, members] of this.kinds) {
      let blocked = false,
        blend = 0;
      for (const [name, expression] of this.list) {
        const value = out.get(name)!,
          mode = expression[field];
        // An expression cannot override its own kind.
        if (value <= 0 || members.has(name) || mode === undefined || mode === 'none') continue;
        if (mode === 'block') blocked = true;
        else blend += value;
      }
      const factor = blocked ? 0 : 1 - Math.min(1, blend);
      if (factor === 1) continue;
      for (const name of members) {
        const expression = this.list.get(name);
        if (expression) out.set(name, expression.isBinary ? 0 : out.get(name)! * factor);
      }
    }
    return out;
  }

  /** The morph weights, colours and texture moves of the current values, by the specification's accumulation. */
  evaluate(): VRMExpressionOutput {
    const resolved = this.resolve(),
      morphs = new Map<string, { node: number; index: number; weight: number }>(),
      colors = new Map<string, { material: number; type: string; parts: { value: number; target: number[] }[] }>(),
      transforms = new Map<
        number,
        { material: number; parts: { value: number; scale: number[]; offset: number[] }[] }
      >();
    for (const [name, expression] of this.list) {
      const value = resolved.get(name)!;
      for (const { node, index, weight } of expression.morphTargetBinds ?? []) {
        const key = `${node}:${index}`,
          entry = morphs.get(key) ?? { node, index, weight: 0 };
        morphs.set(key, entry);
        entry.weight += weight * value;
      }
      for (const { material, type, targetValue } of expression.materialColorBinds ?? []) {
        const key = `${material}:${type}`,
          entry = colors.get(key) ?? { material, type, parts: [] };
        colors.set(key, entry);
        if (value > 0) entry.parts.push({ value, target: targetValue });
      }
      for (const { material, scale = [1, 1], offset = [0, 0] } of expression.textureTransformBinds ?? []) {
        const entry = transforms.get(material) ?? { material, parts: [] };
        transforms.set(material, entry);
        if (value > 0) entry.parts.push({ value, scale, offset });
      }
    }
    return { morphs: [...morphs.values()], colors: [...colors.values()], transforms: [...transforms.values()] };
  }
}

/** Gaze as the specification's yaw and pitch, in degrees: yaw above 0 is the model's left, pitch above 0 is down. */
export interface VRMGaze {
  readonly yaw: number;
  readonly pitch: number;
}

const DEFAULT_RANGE: VRMRangeMap = { inputMaxValue: 90, outputScale: 1 };

/** A gaze angle through a range map, as a magnitude. An input range of 0 gives all or nothing. */
function ranged(value: number, map: VRMRangeMap | undefined): number {
  const { inputMaxValue, outputScale } = map ?? DEFAULT_RANGE,
    size = Math.abs(value);
  if (!(inputMaxValue > 0)) return size > 0 ? outputScale : 0;
  return (Math.min(size, inputMaxValue) / inputMaxValue) * outputScale;
}

/**
 * Yaw and pitch to `target` from LookAt space: the head's world matrix, moved by `offsetFromHeadBone`, and turned back
 * by `headRest`, the head's rest rotation in model space, so that +Z is the model's forward.
 */
export function vrmGaze(
  lookAt: VRMLookAtData,
  head: ArrayLike<number>,
  headRest: readonly number[],
  target: Vec3,
): VRMGaze {
  const offset = lookAt.offsetFromHeadBone ?? [0, 0, 0],
    origin = [0, 1, 2].map((k) => head[k] * offset[0] + head[4 + k] * offset[1] + head[8 + k] * offset[2] + head[12 + k]),
    world = rotationOfMatrix(head),
    space = multiplyQuaternions(world, conjugate(headRest)),
    local = rotateByQuaternion(
      [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]],
      conjugate(space),
    ),
    degrees = 180 / Math.PI;
  return {
    yaw: Math.atan2(local[0], local[2]) * degrees,
    pitch: Math.atan2(-local[1], Math.hypot(local[0], local[2])) * degrees,
  };
}

/** Each eye's turn in degrees for a gaze, through the range maps. For `lookAt.type` `bone`. */
export function vrmEyeAngles(lookAt: VRMLookAtData, gaze: VRMGaze): { left: VRMGaze; right: VRMGaze } {
  const { yaw, pitch } = gaze,
    vertical = pitch > 0 ? lookAt.rangeMapVerticalDown : lookAt.rangeMapVerticalUp,
    turn = Math.sign(pitch) * ranged(pitch, vertical),
    sign = Math.sign(yaw);
  return {
    left: {
      yaw: sign * ranged(yaw, yaw > 0 ? lookAt.rangeMapHorizontalOuter : lookAt.rangeMapHorizontalInner),
      pitch: turn,
    },
    right: {
      yaw: sign * ranged(yaw, yaw > 0 ? lookAt.rangeMapHorizontalInner : lookAt.rangeMapHorizontalOuter),
      pitch: turn,
    },
  };
}

/** Weights of the four look expressions for a gaze, through the range maps. For `lookAt.type` `expression`. */
export function vrmLookWeights(lookAt: VRMLookAtData, gaze: VRMGaze): Record<string, number> {
  const { yaw, pitch } = gaze;
  return {
    lookLeft: yaw > 0 ? ranged(yaw, lookAt.rangeMapHorizontalOuter) : 0,
    lookRight: yaw < 0 ? ranged(yaw, lookAt.rangeMapHorizontalOuter) : 0,
    lookDown: pitch > 0 ? ranged(pitch, lookAt.rangeMapVerticalDown) : 0,
    lookUp: pitch < 0 ? ranged(pitch, lookAt.rangeMapVerticalUp) : 0,
  };
}

const conjugate = (q: ArrayLike<number>): number[] => [-q[0], -q[1], -q[2], q[3]];

function rotationOfMatrix(m: ArrayLike<number>): number[] {
  const split = splitTRS(m, 1e-3);
  if (typeof split === 'string') throw new MargoError('state', 'A VRM head matrix has no rotation; fix its scale');
  return split[1];
}

/** Rest rotation of every node in model space. */
function restRotations(doc: VRMDocument): { local: number[][]; model: number[][] } {
  const nodes = doc.nodes ?? [],
    local = nodes.map((node) => {
      if (node.matrix) return rotationOfMatrix(node.matrix);
      return node.rotation ? Array.from(node.rotation) : [0, 0, 0, 1];
    }),
    model: number[][] = new Array(nodes.length);
  const walk = (index: number, base: number[]): void => {
      model[index] = normalizeQuaternion(multiplyQuaternions(base, local[index]));
      for (const child of nodes[index].children ?? []) walk(child, model[index]);
    },
    children = new Set(nodes.flatMap((node) => node.children ?? []));
  nodes.forEach((_, i) => {
    if (!children.has(i)) walk(i, [0, 0, 0, 1]);
  });
  return { local, model };
}

/** Options of {@link addVRM}. */
export interface AddVRMOptions extends VRMExpressionsOptions {
  /**
   * The Animator playing clips on this model. Default none, for an avatar that stands still or is posed by hand: the
   * avatar then runs by itself as an engine plugin.
   */
  animator?: Animator;
  /** Run spring bones. Default true. */
  springs?: boolean;
}

/** A running {@link addVRM}. */
export interface VRMHandle {
  readonly avatar: VRMAvatar;
  readonly expressions: VRMExpressions;
  /** Spring bones, or null for an avatar with none. */
  readonly springs: SpringBones | null;
  /** World point the eyes follow; null looks ahead. Needs `lookAt` on the avatar. */
  lookAtTarget: Vec3 | null;
  /** Gaze of the last update, or null when not looking at anything. */
  readonly gaze: VRMGaze | null;
  /** What this model cannot show: MToon-only colour binds, by expression. Empty for most avatars. */
  readonly unsupported: readonly string[];
  /** Runs one frame by hand; the Animator or the engine does this each frame by itself. */
  update(delta: number): void;
  /** Puts expressions and eyes back to neutral and stops. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const TRANSFORM_ROW = 8;

/** Runs on `animation`'s model: the two-row texture transform of a map, as the model's shader reads it. */
function transformRows(offset: readonly number[], scale: readonly number[], turn: number, texCoord: number): number[] {
  const c = Math.cos(turn),
    s = Math.sin(turn);
  return [c * scale[0], s * scale[1], offset[0], texCoord, -s * scale[0], c * scale[1], offset[1], 0];
}

/**
 * Brings an avatar to life on a model: expressions, gaze and spring bones run every frame in the order the
 * specification recommends, after any clip. Pass the model's `Animation` (`@margoengine/animation`), which plays the
 * morph targets, and `options.animator` when an Animator poses the model. Colours bound to MToon-only fields are listed
 * in `unsupported`: the model draws MToon materials by their glTF fallback.
 * @throws RangeError when the avatar does not fit the model.
 */
export function addVRM(animation: Animator['animation'], avatar: VRMAvatar, options: AddVRMOptions = {}): VRMHandle {
  const model = animation.model,
    doc = model.asset.doc as unknown as VRMDocument,
    issues = checkVRM(avatar, doc);
  if (issues.length) throw new RangeError(`This VRM does not fit the model; fix it: ${issues.join('; ')}`);
  const { animator } = options,
    expressions = new VRMExpressions(avatar, options),
    nodes = model.nodes,
    engine = model.root.engine,
    store = engine.store,
    rest = restRotations(doc),
    lookAt = avatar.lookAt ?? null,
    bones = avatar.humanoid.humanBones,
    head = bones.head!.node,
    eyes = [bones.leftEye?.node, bones.rightEye?.node],
    springOptions = options.springs === false ? null : vrmSprings(avatar),
    index = new Map(nodes.map((node, i) => [node.id, i])),
    parents = nodes.map((node) => index.get(store.parents[node.id]) ?? -1),
    springs = springOptions ? new SpringBones(parents, springOptions) : null,
    writeRotation = (node: number, rotation: readonly number[]): void => {
      if (animator) animator.writeNodeRotation(nodes[node], rotation);
      else nodes[node].setQuaternion(rotation);
    },
    access = springs ? springAccess(model, writeRotation) : null,
    // Without an Animator nothing rewrites the pose each frame, so swung joints start from their rest.
    chainHeads = !animator && springs ? springs.bones() : [],
    unsupported: string[] = [];
  // The live materials of a glTF material, with their base values.
  const materialsOf = (material: number) => [
      ...new Set(model.primitives.filter((p) => p.definition.material === material).map((p) => p.material)),
    ],
    colorField = { color: 'base', emissionColor: 'emission' } as Record<string, 'base' | 'emission' | undefined>,
    bases = new Map<string, { live: { base: number[]; emission: number[] }[]; value: number[]; strength: number }>(),
    transforms = new Map<number, ReturnType<typeof transformBase>>();
  function transformBase(material: number) {
    return materialsOf(material).map((live) => ({
      live,
      rows: (live.uvt ?? []).slice(),
      maps: live.maps.map((map, slot) => {
        const own = map?.extensions?.KHR_texture_transform as
          | { offset?: number[]; scale?: number[]; rotation?: number }
          | undefined;
        return {
          slot,
          used: !!map,
          offset: own?.offset ?? [0, 0],
          scale: own?.scale ?? [1, 1],
          turn: own?.rotation ?? 0,
          texCoord: map?.texCoord ?? 0,
        };
      }),
    }));
  }
  for (const [name, expression] of expressionsOf(avatar)) {
    for (const bind of expression.materialColorBinds ?? []) {
      const field = colorField[bind.type];
      if (!field) {
        unsupported.push(`${name}: ${bind.type}`);
        continue;
      }
      const key = `${bind.material}:${bind.type}`;
      if (bases.has(key)) continue;
      const live = materialsOf(bind.material);
      const definition = (doc.materials?.[bind.material] ?? {}) as {
        extensions?: { KHR_materials_emissive_strength?: { emissiveStrength?: number } };
      };
      bases.set(key, {
        live,
        value: live[0] ? live[0][field].slice() : [],
        strength:
          field === 'emission'
            ? (definition.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1)
            : 1,
      });
    }
    for (const bind of expression.textureTransformBinds ?? [])
      if (!transforms.has(bind.material)) transforms.set(bind.material, transformBase(bind.material));
  }
  const state: { target: Vec3 | null; gaze: VRMGaze | null } = { target: null, gaze: null };
  const applyGaze = (): void => {
    if (!lookAt) return;
    const target = state.target;
    if (target) state.gaze = vrmGaze(lookAt, nodes[head].matrix, rest.model[head], target);
    else state.gaze = null;
    const gaze = state.gaze ?? { yaw: 0, pitch: 0 };
    if (lookAt.type === 'expression') {
      const weights = vrmLookWeights(lookAt, gaze);
      for (const name of Object.keys(weights)) expressions.set(name, weights[name]);
      return;
    }
    const angles = vrmEyeAngles(lookAt, gaze);
    eyes.forEach((eye, side) => {
      if (eye === undefined) return;
      const { yaw, pitch } = side ? angles.right : angles.left,
        radians = Math.PI / 180,
        turn = multiplyQuaternions(
          axisAngleToQuaternion([0, 1, 0], yaw * radians),
          axisAngleToQuaternion([1, 0, 0], pitch * radians),
        ),
        // The turn is about the model's axes: carried into the eye's own frame on top of its rest rotation.
        into = multiplyQuaternions(multiplyQuaternions(conjugate(rest.model[eye]), turn), rest.model[eye]);
      writeRotation(eye, normalizeQuaternion(multiplyQuaternions(rest.local[eye], into)));
    });
  };
  const applyExpressions = (): void => {
    const { morphs, colors, transforms: moves } = expressions.evaluate();
    for (const { node, index: target, weight } of morphs) animation.setMorph(node, target, weight);
    for (const { material, type, parts } of colors) {
      const base = bases.get(`${material}:${type}`);
      if (!base) continue;
      const field = colorField[type]!;
      for (const live of base.live)
        base.value.forEach((v, k) => {
          let next = v;
          for (const { value, target } of parts) next += (target[k] * base.strength - v) * value;
          live[field][k] = next;
        });
    }
    for (const { material, parts } of moves)
      for (const { live, rows, maps } of transforms.get(material) ?? []) {
        for (const map of maps) {
          if (!map.used) continue;
          const offset = [map.offset[0], map.offset[1]],
            scale = [map.scale[0], map.scale[1]];
          for (const part of parts)
            for (let k = 0; k < 2; k++) {
              offset[k] += (part.offset[k] - map.offset[k]) * part.value;
              scale[k] += (part.scale[k] - map.scale[k]) * part.value;
            }
          const next = transformRows(offset, scale, map.turn, map.texCoord);
          for (let k = 0; k < TRANSFORM_ROW; k++) live.uvt![map.slot * TRANSFORM_ROW + k] = next[k];
        }
        if (!rows.length) throw new MargoError('state', 'This material has no texture transform rows; rebuild the model');
      }
  };
  const update = (delta: number): void => {
    if (!animator) {
      for (const bone of chainHeads) nodes[bone].setQuaternion(rest.local[bone]);
      store.tick(false);
    }
    applyGaze();
    applyExpressions();
    if (springs) {
      store.tick(false);
      springs.step(delta, access!);
    } else store.tick(false);
  };
  const name = `vrm:${nodes[head].id}`;
  let remove: (() => void) | null;
  if (animator) remove = animator.addSolver(update);
  else {
    engine.use({ name, setup() {}, onPreUpdate: update });
    remove = () => engine.removePlugin(name);
  }
  const stop = (): void => {
    remove?.();
    remove = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  // A model disposed first takes the avatar with it: nothing is left to put back.
  let unsubscribe: (() => void) | null = model.onDispose(stop);
  const dispose = (): void => {
    if (!remove) return;
    stop();
    for (const expressionName of expressions.names) expressions.set(expressionName, 0);
    state.target = null;
    applyGaze();
    applyExpressions();
    store.tick(false);
  };
  return {
    avatar,
    expressions,
    springs,
    unsupported,
    get lookAtTarget() {
      return state.target;
    },
    set lookAtTarget(value) {
      if (value !== null && !(Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)))
        throw new RangeError('lookAtTarget must be three finite numbers or null');
      state.target = value;
    },
    get gaze() {
      return state.gaze;
    },
    update,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
