// Clean-room VRM 0.x adapter. Sources and migration choices: docs/rigging-vrm0.md.
// Geometry, inverse binds and animation buffers stay in their original local spaces.
// A parent turn normalizes model forward; extension vectors have their own legacy handedness.
import type { EngineKernel } from '@margoengine/core';
import type { GLTFLoadOptions, PBRModel } from '@margoengine/gltf-pro';
import type { Vec3 } from '@margoengine/math';
import { fault } from '../../shared/errors.js';
import { GLB_JSON, GLB_MAGIC, glbChunks } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import { readResponse } from '../../shared/loading.js';
import { Matrix4 } from '@margoengine/math';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { checkVRM, type VRMAvatar, type VRMDocument, type VRMExpression, type VRMPresetExpression } from './vrm.js';

/** VRM 0.x uses object vectors in Unity's left-handed extension fields. */
export interface VRM0Vector {
  x?: number;
  y?: number;
  z?: number;
}
/** Original permissions are retained verbatim; conversion never grants a new licence. */
export interface VRM0Meta {
  title?: string;
  version?: string;
  author?: string;
  contactInformation?: string;
  reference?: string;
  texture?: number;
  allowedUserName?: string;
  violentUssageName?: string;
  sexualUssageName?: string;
  commercialUssageName?: string;
  otherPermissionUrl?: string;
  licenseName?: string;
  otherLicenseUrl?: string;
  [key: string]: unknown;
}
/** The published VRM 0.x extension. Unknown properties survive in `legacy`. */
export interface VRM0Data {
  specVersion?: string;
  meta?: VRM0Meta;
  humanoid?: { humanBones?: { bone: string; node: number; [key: string]: unknown }[]; [key: string]: unknown };
  blendShapeMaster?: {
    blendShapeGroups?: {
      name?: string;
      presetName?: string;
      isBinary?: boolean;
      binds?: { mesh: number; index: number; weight: number }[];
      materialValues?: { materialName: string; propertyName: string; targetValue: number[] }[];
    }[];
  };
  firstPerson?: {
    firstPersonBone?: number;
    firstPersonBoneOffset?: VRM0Vector;
    meshAnnotations?: { mesh: number; firstPersonFlag?: string }[];
    lookAtTypeName?: string;
    lookAtHorizontalInner?: VRM0DegreeMap;
    lookAtHorizontalOuter?: VRM0DegreeMap;
    lookAtVerticalUp?: VRM0DegreeMap;
    lookAtVerticalDown?: VRM0DegreeMap;
  };
  secondaryAnimation?: {
    colliderGroups?: { node: number; colliders?: { offset?: VRM0Vector; radius?: number }[] }[];
    boneGroups?: {
      comment?: string;
      bones?: number[];
      center?: number;
      colliderGroups?: number[];
      stiffiness?: number;
      gravityPower?: number;
      gravityDir?: VRM0Vector;
      dragForce?: number;
      hitRadius?: number;
    }[];
  };
  materialProperties?: VRM0Material[];
  [key: string]: unknown;
}
/** Legacy gaze curve. VRM 1.0 retains the end points and uses a linear range. */
export interface VRM0DegreeMap {
  xRange?: number;
  yRange?: number;
  curve?: number[];
}
/** Legacy material parameters, retained for the optional MToon renderer. */
export interface VRM0Material {
  name?: string;
  shader?: string;
  renderQueue?: number;
  floatProperties?: Record<string, number>;
  vectorProperties?: Record<string, number[]>;
  textureProperties?: Record<string, number>;
  keywordMap?: Record<string, boolean>;
  tagMap?: Record<string, string>;
}
/** A copy of the glTF with a 1.0 runtime avatar. No source objects or binary chunks are modified. */
export interface VRM0Conversion {
  document: VRMDocument;
  avatar: VRMAvatar;
  legacy: VRM0Data;
  /** Differences that have no exact 1.0 representation, including legacy licence and gaze curves. */
  differences: string[];
}
type Node = NonNullable<VRMDocument['nodes']>[number] & { name?: string; translation?: number[] };
type Material = { name?: string; [key: string]: unknown };
const bad = (message: string) => fault('failed', `VRM 0.x: ${message}; repair the avatar before loading`);
const vector = (v: VRM0Vector | undefined, fallback: Vec3 = [0, 0, 0]): Vec3 =>
  v ? [v.x ?? 0, v.y ?? 0, -(v.z ?? 0)] : fallback;
const PRESETS: Record<string, VRMPresetExpression> = {
  neutral: 'neutral',
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
  blink: 'blink',
  joy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  fun: 'relaxed',
  lookup: 'lookUp',
  lookdown: 'lookDown',
  lookleft: 'lookLeft',
  lookright: 'lookRight',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
};
const COLOR: Record<string, NonNullable<VRMExpression['materialColorBinds']>[number]['type']> = {
  _Color: 'color',
  _EmissionColor: 'emissionColor',
  _ShadeColor: 'shadeColor',
  _RimColor: 'rimColor',
  _OutlineColor: 'outlineColor',
};

function parse(source: Uint8Array | VRMDocument): VRMDocument {
  return source instanceof Uint8Array
    ? parseJSON<VRMDocument>(new TextDecoder().decode(glbChunks(source)[0].data))
    : source;
}

/**
 * Converts the 0.x extension to the existing 1.0 runtime model, normalizing forward to +Z.
 * Retains original metadata/materials in `legacy` and `avatar.extras.vrm0`; does not relicense a model.
 * Gaze curves become 1.0 linear ranges, as the Consortium's migration specifies.
 */
export function convertVRM0(source: Uint8Array | VRMDocument): VRM0Conversion {
  const document = structuredClone(parse(source)),
    legacy = document?.extensions?.VRM as VRM0Data | undefined;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw bad('no VRM extension');
  if (document.extensions?.VRMC_vrm) throw bad('both VRM and VRMC_vrm are present; choose one version');
  if (legacy.specVersion && !/^0\./.test(legacy.specVersion)) throw bad(`unsupported version ${legacy.specVersion}`);
  const nodes = (document.nodes ??= []) as Node[],
    originalCount = nodes.length,
    parents = new Int32Array(originalCount).fill(-1),
    differences: string[] = [];
  const known = (n: number): void => {
    if (!Number.isInteger(n) || n < 0 || n >= originalCount) throw bad(`node ${n} does not exist`);
  };
  nodes.forEach((node, i) =>
    node.children?.forEach((c) => {
      known(c);
      if (parents[c] !== -1) throw bad(`node ${c} has multiple parents`);
      parents[c] = i;
    }),
  );
  const pending = Array.from(parents).flatMap((p, i) => (p === -1 ? [i] : []));
  let visited = 0;
  while (pending.length) {
    const n = pending.pop()!;
    visited++;
    for (const child of nodes[n].children ?? []) pending.push(child);
  }
  if (visited !== originalCount) throw bad('node hierarchy has a cycle');
  const bones: VRMAvatar['humanoid']['humanBones'] = {};
  for (const { bone, node } of legacy.humanoid?.humanBones ?? []) {
    known(node);
    const name = bone
      .replace(/ThumbProximal$/, 'ThumbMetacarpal')
      .replace(/ThumbIntermediate$/, 'ThumbProximal') as keyof typeof bones;
    if (bones[name]) throw bad(`duplicate humanoid bone ${name}`);
    bones[name] = { node };
  }
  const meta = legacy.meta ?? {},
    avatar: VRMAvatar = {
      specVersion: '1.0',
      meta: {
        name: meta.title || 'Untitled VRM 0.x',
        authors: [meta.author || 'Unknown'],
        version: meta.version,
        // An internal model, not a claim that the author licensed under the new VRM public licence.
        licenseUrl: meta.otherLicenseUrl || legacyLicense(meta.licenseName),
        contactInformation: meta.contactInformation,
        references: meta.reference ? [meta.reference] : [],
        avatarPermission:
          { OnlyAuthor: 'onlyAuthor', ExplicitlyLicensedPerson: 'onlySeparatelyLicensedPerson', Everyone: 'everyone' }[
            meta.allowedUserName ?? ''
          ] ?? 'onlyAuthor',
        allowExcessivelyViolentUsage: meta.violentUssageName === 'Allow',
        allowExcessivelySexualUsage: meta.sexualUssageName === 'Allow',
        commercialUsage: meta.commercialUssageName === 'Allow' ? 'corporation' : 'personalNonProfit',
        allowPoliticalOrReligiousUsage: false,
        allowAntisocialOrHateUsage: false,
        otherLicenseUrl: meta.otherPermissionUrl,
      },
      humanoid: { humanBones: bones },
      expressions: { preset: {}, custom: {} },
      extras: { vrm0: structuredClone(legacy) },
    };
  const textures = document.textures as { source?: number }[] | undefined;
  if (meta.texture !== undefined) avatar.meta.thumbnailImage = textures?.[meta.texture]?.source;
  differences.push('Original VRM 0.x licence remains authoritative; meta is a runtime projection, not a new licence.');
  const meshNodes = (mesh: number): number[] => {
    if (!Number.isInteger(mesh) || !document.meshes?.[mesh]) throw bad(`mesh ${mesh} does not exist`);
    return nodes.flatMap((n, i) => (n.mesh === mesh ? [i] : []));
  };
  const materials = (document.materials ?? []) as Material[];
  for (const [index, group] of (legacy.blendShapeMaster?.blendShapeGroups ?? []).entries()) {
    const preset = PRESETS[(group.presetName ?? '').toLowerCase()],
      name = preset ?? group.name ?? `expression${index}`,
      table = preset ? avatar.expressions!.preset! : avatar.expressions!.custom!;
    if (name in table || (!preset && Object.values(PRESETS).includes(name as VRMPresetExpression)))
      throw bad(`expression name ${name} is not unique`);
    const expression: VRMExpression = {
      isBinary: group.isBinary ?? false,
      morphTargetBinds: [],
      materialColorBinds: [],
      textureTransformBinds: [],
    };
    for (const bind of group.binds ?? []) {
      if (!Number.isFinite(bind.weight) || bind.weight < 0 || bind.weight > 100)
        throw bad('morph weights must be 0 to 100');
      for (const node of meshNodes(bind.mesh))
        expression.morphTargetBinds!.push({ node, index: bind.index, weight: bind.weight / 100 });
    }
    for (const bind of group.materialValues ?? []) {
      const matches = materials.flatMap((m, i) => (m.name === bind.materialName ? [i] : []));
      if (!matches.length) throw bad(`expression ${name} names missing material ${bind.materialName}`);
      const value = bind.targetValue;
      if (!Array.isArray(value) || value.some((v) => !Number.isFinite(v))) throw bad(`invalid material bind ${name}`);
      for (const material of matches) {
        if (COLOR[bind.propertyName]) {
          if (value.length < 3) throw bad(`colour bind ${name} needs RGB`);
          expression.materialColorBinds!.push({
            material,
            type: COLOR[bind.propertyName],
            targetValue: [value[0], value[1], value[2], value[3] ?? 1],
          });
        } else if (bind.propertyName === '_MainTex' || bind.propertyName === '_MainTex_ST') {
          if (value.length !== 4) throw bad(`texture bind ${name} needs scale and offset`);
          expression.textureTransformBinds!.push({
            material,
            scale: [value[0], value[1]],
            offset: [value[2], 1 - value[1] - value[3]],
          });
        } else
          differences.push(
            `Expression ${name}: legacy material property ${bind.propertyName} retained in extras.vrm0.`,
          );
      }
    }
    (table as Record<string, VRMExpression>)[name] = expression;
  }
  const first = legacy.firstPerson;
  if (first) {
    avatar.firstPerson = {
      meshAnnotations: (first.meshAnnotations ?? []).flatMap((a) =>
        meshNodes(a.mesh).map((node) => ({
          node,
          type:
            { Auto: 'auto', Both: 'both', FirstPersonOnly: 'firstPersonOnly', ThirdPersonOnly: 'thirdPersonOnly' }[
              a.firstPersonFlag ?? 'Auto'
            ] ?? 'auto',
        })),
      ),
    };
    let offset = vector(first.firstPersonBoneOffset);
    const head = bones.head?.node,
      anchor = first.firstPersonBone;
    if (head !== undefined && anchor !== undefined && anchor !== -1 && anchor !== head) {
      known(anchor);
      const world = (n: number): ArrayLike<number> => {
        const path: number[] = [];
        for (let at = n; at !== -1; at = parents[at]) path.push(at);
        let result: ArrayLike<number> = new Matrix4().elements;
        for (const at of path.reverse()) {
          const p = nodes[at].translation ?? [0, 0, 0],
            q = nodes[at].rotation ?? [0, 0, 0, 1],
            s = nodes[at].scale ?? [1, 1, 1];
          const local =
            nodes[at].matrix ??
            new Matrix4().compose(
              { x: p[0], y: p[1], z: p[2] },
              { x: q[0], y: q[1], z: q[2], w: q[3] },
              { x: s[0], y: s[1], z: s[2] },
            ).elements;
          result = multiplyMatrices(result, local);
        }
        return result;
      };
      const inv = invertMatrix(world(head));
      if (!inv) throw bad('head transform cannot be inverted');
      const matrix = multiplyMatrices(inv, world(anchor));
      const point = (k: number): number =>
        matrix[k] * offset[0] + matrix[k + 4] * offset[1] + matrix[k + 8] * offset[2] + matrix[k + 12];
      offset = [point(0), point(1), point(2)];
    }
    avatar.lookAt = { type: first.lookAtTypeName === 'BlendShape' ? 'expression' : 'bone', offsetFromHeadBone: offset };
    for (const direction of ['HorizontalInner', 'HorizontalOuter', 'VerticalUp', 'VerticalDown'] as const) {
      const map = first[`lookAt${direction}`];
      avatar.lookAt[`rangeMap${direction}`] = {
        inputMaxValue: map?.xRange ?? 90,
        outputScale: map?.yRange ?? (avatar.lookAt.type === 'bone' ? 10 : 1),
      };
      if (map?.curve) differences.push(`lookAt${direction}: curve retained in extras.vrm0; 1.0 uses a linear range.`);
    }
  }
  convertSprings(legacy, document, parents, known);
  const secondary = document.extensions?.VRMC_springBone;
  if (secondary) avatar.springBone = secondary as VRMAvatar['springBone'];
  // Wrap original roots once, shared by every scene that uses them; buffer and node indices stay stable.
  const roots = Array.from(parents).flatMap((parent, i) => (parent === -1 ? [i] : [])),
    wrappers = new Map<number, number>();
  for (const root of roots) {
    wrappers.set(root, nodes.length);
    nodes.push({ name: 'VRM 0.x forward', rotation: [0, 1, 0, 0], children: [root] });
  }
  const scenes = document.scenes as { nodes?: number[] }[] | undefined;
  if (scenes)
    for (const scene of scenes)
      scene.nodes = (scene.nodes ?? []).map((root) => {
        const wrapper = wrappers.get(root);
        if (wrapper === undefined) throw bad(`scene node ${root} is not a root`);
        return wrapper;
      });
  else {
    document.scenes = [{ nodes: [...wrappers.values()] }];
    document.scene = 0;
  }
  const { springBone: _, ...vrm } = avatar;
  document.extensions = { ...document.extensions, VRMC_vrm: vrm };
  delete document.extensions.VRM;
  document.extensionsUsed = [
    ...new Set([
      ...(document.extensionsUsed ?? []).filter((n) => n !== 'VRM'),
      'VRMC_vrm',
      ...(secondary ? ['VRMC_springBone'] : []),
    ]),
  ];
  if (Array.isArray(document.extensionsRequired))
    document.extensionsRequired = document.extensionsRequired.filter((n) => n !== 'VRM');
  const issues = checkVRM(avatar, document);
  if (issues.length) throw bad(issues.join('; '));
  return { document, avatar, legacy: structuredClone(legacy), differences };
}

function legacyLicense(name: string | undefined): string {
  const cc: Record<string, string> = {
    CC0: 'publicdomain/zero/1.0/',
    CC_BY: 'licenses/by/4.0/',
    CC_BY_NC: 'licenses/by-nc/4.0/',
    CC_BY_SA: 'licenses/by-sa/4.0/',
    CC_BY_NC_SA: 'licenses/by-nc-sa/4.0/',
    CC_BY_ND: 'licenses/by-nd/4.0/',
    CC_BY_NC_ND: 'licenses/by-nc-nd/4.0/',
  };
  return cc[name ?? ''] ? `https://creativecommons.org/${cc[name!]}` : 'https://vrm.dev/en/vrm0/';
}

function convertSprings(legacy: VRM0Data, doc: VRMDocument, parents: Int32Array, known: (n: number) => void): void {
  const data = legacy.secondaryAnimation;
  if (!data) return;
  const nodes = doc.nodes as Node[],
    spring: NonNullable<VRMAvatar['springBone']> = {
      specVersion: '1.0',
      colliders: [],
      colliderGroups: [],
      springs: [],
    };
  for (const group of data.colliderGroups ?? []) {
    known(group.node);
    const colliders: number[] = [];
    for (const collider of group.colliders ?? []) {
      colliders.push(spring.colliders!.length);
      spring.colliders!.push({
        node: group.node,
        shape: { sphere: { offset: vector(collider.offset), radius: collider.radius ?? 0 } },
      });
    }
    spring.colliderGroups!.push({ colliders });
  }
  const claimed = new Set<number>();
  for (const group of data.boneGroups ?? []) {
    const direction = vector(group.gravityDir, [0, -1, 0]);
    // Legacy world-space Unity direction -> right-handed glTF -> normalized model forward.
    const gravityDir: Vec3 = [-direction[0], direction[1], -direction[2]],
      settings = {
        hitRadius: group.hitRadius ?? 0,
        stiffness: group.stiffiness ?? 1,
        gravityPower: group.gravityPower ?? 0,
        gravityDir,
        dragForce: group.dragForce ?? 0.4,
      };
    const groups = group.colliderGroups ?? [];
    for (const index of groups)
      if (!Number.isInteger(index) || !spring.colliderGroups![index])
        throw bad(`collider group ${index} does not exist`);
    let center: number | undefined;
    if (group.center !== undefined && group.center !== -1) {
      known(group.center);
      center = group.center;
    }
    // A separate virtual tip for every original joint keeps branching joints unique in SpringBones.
    // The legacy direction comes from its first child; every child subtree still runs.
    const expand = (start: number): void => {
      const pending = [start];
      while (pending.length) {
        const at = pending.pop()!;
        if (claimed.has(at)) throw bad(`spring node ${at} belongs to multiple bone roots`);
        claimed.add(at);
        const children = (nodes[at].children ?? []).slice(),
          p = nodes[at].translation ?? [0, 0, 0],
          length = Math.hypot(...p),
          tail = children.length
            ? (nodes[children[0]].translation ?? [0, 0, 0])
            : length > 0
              ? p.map((v) => (v * 0.07) / length)
              : [0, 0.07, 0],
          end = nodes.length;
        nodes.push({ name: 'VRM 0.x spring tail', translation: tail.slice() });
        nodes[at].children = [...children, end];
        spring.springs!.push({
          name: group.comment,
          joints: [
            { node: at, ...settings },
            { node: end, ...settings },
          ],
          center,
          colliderGroups: groups.slice(),
        });
        pending.push(...children.slice().reverse());
      }
    };
    for (const root of group.bones ?? []) {
      known(root);
      expand(root);
    }
  }
  (doc.extensions ??= {}).VRMC_springBone = spring;
}

/** Convert a binary .vrm to a GLB carrying the normalized runtime document; preserves all non-JSON chunks. */
export function convertVRM0Bytes(source: Uint8Array): Uint8Array {
  const chunks = glbChunks(source),
    { document } = convertVRM0(source),
    text = new TextEncoder().encode(JSON.stringify(document)),
    padded = (text.length + 3) & ~3,
    rest = chunks.slice(1),
    total = 20 + padded + rest.reduce((n, c) => n + 8 + c.data.length, 0),
    output = new Uint8Array(total),
    view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, GLB_JSON, true);
  output.set(text, 20);
  output.fill(32, 20 + text.length, 20 + padded);
  let offset = 20 + padded;
  for (const chunk of rest) {
    view.setUint32(offset, chunk.data.length, true);
    view.setUint32(offset + 4, chunk.type, true);
    output.set(chunk.data, offset + 8);
    offset += 8 + chunk.data.length;
  }
  return output;
}

/**
 * Loads a VRM 0.x URL/bytes as a PBRModel with a normalized 1.0 avatar in `model.asset.doc`.
 * Uses gltf-pro's bounded fetch and decoder options; `signal` cancels downloads and image decoding.
 * Geometry keeps the file's glTF material fallback until the optional MToon renderer is attached.
 */
export async function loadVRM0(
  engine: EngineKernel,
  source: string | URL | Uint8Array,
  options: GLTFLoadOptions = {},
): Promise<PBRModel> {
  options.signal?.throwIfAborted();
  const get = options.fetch ?? globalThis.fetch,
    limit = options.maxDownloadBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw bad('maxDownloadBytes must be a positive safe integer');
  const bytes =
    source instanceof Uint8Array
      ? source
      : await readResponse(await get(source, { signal: options.signal }), {
          maxBytes: limit,
          signal: options.signal,
          label: 'VRM 0.x',
        });
  if (bytes.byteLength > limit) throw bad('download exceeds maxDownloadBytes');
  const converted = convertVRM0Bytes(bytes),
    { parseGLTFAsync } = await import('@margoengine/gltf-pro');
  options.signal?.throwIfAborted();
  return parseGLTFAsync(engine, converted, options);
}

/** Read the converted runtime avatar for `addVRM`; use `convertVRM0` when the converted document is also needed. */
export const readVRM0 = (source: Uint8Array | VRMDocument): VRMAvatar => convertVRM0(source).avatar;
