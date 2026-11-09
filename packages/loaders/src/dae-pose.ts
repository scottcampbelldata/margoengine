// Playback of a parsed COLLADA document: posing nodes and morph weights at a time, CPU morphing and skinning, skin
// bindings for the animation package's Skeleton and Skin, and keyframe clips for its createKeyframeClip.
import type { MutableVec3 } from '@margoengine/math';
import { splitTRS } from '@margoengine/math/quat';
import { LoaderError } from './types.js';
import { computeVertexNormals } from './normals.js';
import {
  cofactors,
  converter,
  F,
  IDENTITY,
  invert,
  multiply,
  stackMatrix,
  transformInto,
  type Matrix,
} from './dae-common.js';
import { animateTransforms, sampleDAESampler, type DAEAnimationChannel } from './dae-animation.js';
import { positionCount } from './dae-controllers.js';
import type { DAEGeometry, DAEGroup, DAEInstance, DAENode, LoadedDAE } from './dae.js';

/** A parsed COLLADA scene posed at one time by {@link poseDAE}. */
export interface DAEPose {
  /** Local matrix of every node (column-major, Y-up meters): animated where channels address it, else `node.matrix`. */
  local: Map<DAENode, number[]>;
  /** World matrix of every node. */
  world: Map<DAENode, number[]>;
  /** Weights of every morph, by index into `LoadedDAE.morphs`: animated where channels address them, else defaults. */
  weights: number[][];
}

/** Options of {@link poseDAE} and {@link daeKeyframeClip}. */
export interface DAEPoseOptions {
  /** Play only this `LoadedDAE.clips` entry, with time 0 at its start (held at its end). Default: every animation. */
  clip?: number;
}

/**
 * A mesh with normals, ready for a materials `createMesh` or `mesh.setGeometry`. Its groups number the primitives
 * (`materialIndex` 0, 1, ...) for a material array; a single material ignores them.
 */
export type DAEMeshGeometry = Omit<DAEGeometry, 'groups'> & {
  normals: Float32Array;
  groups: (DAEGroup & { materialIndex: number })[];
};

function selection(dae: LoadedDAE, clip: number | undefined) {
  let included: (index: number) => boolean = () => true,
    start = 0,
    end = Infinity,
    name = '';
  if (clip !== undefined) {
    const found = Number.isInteger(clip) ? dae.clips[clip] : undefined;
    if (!found) throw new RangeError(`DAE clip ${clip} does not exist; pass an index below ${dae.clips.length}`);
    // Parents come before their nested animations, so one pass marks every descendant.
    const marked = dae.animations.map(() => false);
    dae.animations.forEach((a, i) => {
      marked[i] = found.animations.includes(i) || (a.parent >= 0 && marked[a.parent]);
    });
    included = (index) => marked[index];
    start = found.start;
    end = found.end ?? Infinity;
    name = found.name ?? found.id ?? '';
  }
  const channels: DAEAnimationChannel[] = [];
  dae.animations.forEach((a, i) => included(i) && channels.push(...a.channels));
  const byNode = new Map<string, DAEAnimationChannel[]>();
  for (const channel of channels)
    if (channel.node !== undefined) {
      const list = byNode.get(channel.node);
      if (list) list.push(channel);
      else byNode.set(channel.node, [channel]);
    }
  return { channels, byNode, start, end, name };
}

function weightsAt(dae: LoadedDAE, channels: readonly DAEAnimationChannel[], time: number): number[][] {
  const weights = dae.morphs.map((m) => [...m.weights]);
  for (const channel of channels) {
    if (channel.morph === undefined) continue;
    const value = sampleDAESampler(channel.sampler, time),
      target = weights[channel.morph];
    if (channel.index === undefined) for (let k = 0; k < target.length; k++) target[k] = value[k];
    else target[channel.index] = value[0];
  }
  return weights;
}

const finiteTime = (time: number): void => {
  if (typeof time !== 'number' || !Number.isFinite(time))
    throw new RangeError(`DAE pose time ${time} is invalid; pass finite seconds`);
};

/**
 * Every node's local and world matrix and every morph's weights at `time` seconds, from the document's animation
 * channels (or one clip's). Channels replace values of the node's transform stack as written, which is then converted
 * to Y-up meters like `node.matrix`.
 */
export function poseDAE(dae: LoadedDAE, time: number, options: DAEPoseOptions = {}): DAEPose {
  finiteTime(time);
  const { channels, byNode, start, end } = selection(dae, options.clip),
    at = options.clip === undefined ? time : Math.min(start + Math.max(0, time), end),
    convert = converter(dae.upAxis, dae.meter),
    local = new Map<DAENode, number[]>(),
    world = new Map<DAENode, number[]>();
  const walk = (node: DAENode, parent: Matrix): void => {
    const animated = node.id === undefined ? undefined : byNode.get(node.id),
      matrix = animated ? convert(stackMatrix(animateTransforms(node.transforms, animated, at))) : node.matrix,
      w = multiply(parent, matrix);
    local.set(node, matrix);
    world.set(node, w);
    for (const child of node.children) walk(child, w);
  };
  for (const node of dae.nodes) walk(node, IDENTITY);
  return { local, world, weights: weightsAt(dae, channels, at) };
}

/** The scene at rest: `node.matrix` everywhere and the morphs' default weights. */
export function restPose(dae: LoadedDAE): DAEPose {
  const local = new Map<DAENode, number[]>(),
    world = new Map<DAENode, number[]>();
  const walk = (node: DAENode, parent: Matrix): void => {
    const w = multiply(parent, node.matrix);
    local.set(node, node.matrix);
    world.set(node, w);
    for (const child of node.children) walk(child, w);
  };
  for (const node of dae.nodes) walk(node, IDENTITY);
  return { local, world, weights: dae.morphs.map((m) => [...m.weights]) };
}

function withNormals(geometry: DAEGeometry, positions: Float32Array, normals?: Float32Array): DAEMeshGeometry {
  return {
    ...geometry,
    positions,
    normals: normals ?? computeVertexNormals(positions, geometry.indices),
    groups: geometry.groups.map((group, materialIndex) => ({ ...group, materialIndex })),
  };
}

/**
 * A copy of a morph's base mesh with its targets blended at `weights` (default: the morph's own weights), position
 * by position: `NORMALIZED` (1 - sum w) base + sum w target, `RELATIVE` base + sum w target. Normals blend the same
 * way and are renormalised (computed when the base has none). Vertex order is the base mesh's, so the result can
 * replace a mesh's geometry every frame.
 */
export function morphDAE(dae: LoadedDAE, morph: number, weights?: ArrayLike<number>): DAEMeshGeometry {
  const m = Number.isInteger(morph) ? dae.morphs[morph] : undefined;
  if (!m) throw new RangeError(`DAE morph ${morph} does not exist; pass an index below ${dae.morphs.length}`);
  const w = weights ?? m.weights;
  if (w.length !== m.targets.length)
    throw new RangeError(`DAE morph "${m.id}" has ${m.targets.length} targets; pass one weight each`);
  for (let i = 0; i < w.length; i++)
    if (typeof w[i] !== 'number' || !Number.isFinite(w[i]))
      throw new RangeError(`DAE morph "${m.id}" weight ${i} is not finite; pass finite numbers`);
  const base = dae.geometries[m.base],
    count = base.positions.length / 3,
    positions = Float32Array.from(base.positions),
    normals = base.normals && Float32Array.from(base.normals),
    relative = m.method === 'RELATIVE';
  m.targets.forEach((t, i) => {
    const weight = w[i];
    if (!weight) return;
    const target = dae.geometries[t],
      // The first corner of each target position.
      corner = new Int32Array(positionCount(base.positionIndices)).fill(-1);
    target.positionIndices.forEach((p, c) => {
      if (p < corner.length && corner[p] < 0) corner[p] = c;
    });
    for (let v = 0; v < count; v++) {
      const c = corner[base.positionIndices[v]];
      for (let k = 0; k < 3; k++) {
        const b = base.positions[v * 3 + k],
          p = c < 0 ? (relative ? 0 : b) : target.positions[c * 3 + k];
        positions[v * 3 + k] += weight * (relative ? p : p - b);
        if (!normals || !base.normals) continue;
        const bn = base.normals[v * 3 + k],
          n = c < 0 || !target.normals ? (relative ? 0 : bn) : target.normals[c * 3 + k];
        normals[v * 3 + k] += weight * (relative ? n : n - bn);
      }
    }
  });
  if (normals)
    for (let v = 0; v < normals.length; v += 3) {
      const length = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
      normals[v] /= length;
      normals[v + 1] /= length;
      normals[v + 2] /= length;
    }
  return withNormals(base, positions, normals);
}

/**
 * @internal An instance's mesh in world space at a pose: morphed by the pose's weights, then skinned by its joints'
 * world matrices (sum w joint * inverseBind * bindShape) or moved by `world`. `flip` is set when the transform
 * mirrors, so the caller can keep outward winding.
 */
export function deformInstance(
  dae: LoadedDAE,
  instance: DAEInstance,
  world: Matrix,
  pose: DAEPose,
): { positions: Float32Array; normals?: Float32Array; flip: boolean } {
  const geometry = dae.geometries[instance.geometry];
  if (!geometry)
    throw new LoaderError(F, 'range', `instance names geometry ${instance.geometry}, which does not exist`);
  const source =
      instance.morph !== undefined && dae.morphs[instance.morph]
        ? morphDAE(dae, instance.morph, pose.weights[instance.morph])
        : geometry,
    count = source.positions.length / 3,
    positions = new Float32Array(count * 3),
    normals = source.normals && new Float32Array(count * 3),
    skin = instance.skin === undefined ? undefined : dae.skins[instance.skin];
  if (!skin || !instance.joints) {
    const co = cofactors(world);
    for (let v = 0; v < count; v++)
      transformInto(world, source.positions, source.normals, v * 3, positions, normals, v * 3, co);
    return { positions, normals, flip: co.determinant < 0 };
  }
  const joints = instance.joints.map((joint, j) =>
      multiply(
        multiply(pose.world.get(joint) ?? joint.matrix, skin.inverseBindMatrices.subarray(j * 16, j * 16 + 16)),
        skin.bindShapeMatrix,
      ),
    ),
    m = new Array<number>(16);
  let flip = false;
  for (let v = 0; v < count; v++) {
    const p = source.positionIndices[v];
    m.fill(0);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = skin.vertexWeights[p * 4 + k];
      if (!w) continue;
      const j = skin.vertexJoints[p * 4 + k],
        matrix = j < 0 ? skin.bindShapeMatrix : joints[j];
      for (let e = 0; e < 16; e++) m[e] += w * matrix[e];
      sum += w;
    }
    // A position without weights stays in the bind shape.
    if (!sum) for (let e = 0; e < 16; e++) m[e] = skin.bindShapeMatrix[e];
    const co = cofactors(m);
    if (!v) flip = co.determinant < 0;
    transformInto(m, source.positions, source.normals, v * 3, positions, normals, v * 3, co);
  }
  return { positions, normals, flip };
}

/**
 * A unique name for every node, depth first: its id, else its name, else `node`, with `#2`, `#3`... added to repeats
 * (copies made by `instance_node`). Bones of {@link bindDAESkin} and tracks of {@link daeKeyframeClip} use these.
 */
export function daeNodeNames(dae: LoadedDAE): Map<DAENode, string> {
  const names = new Map<DAENode, string>(),
    used = new Set<string>();
  const walk = (node: DAENode): void => {
    const base = node.id ?? node.name ?? 'node';
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}#${n}`;
    used.add(name);
    names.set(node, name);
    node.children.forEach(walk);
  };
  dae.nodes.forEach(walk);
  return names;
}

/** One bone for the animation package's `Skeleton`: a node's local transform split into TRS. */
export interface DAEBone {
  /** The node's name from {@link daeNodeNames}, which keyframe tracks target. */
  name: string;
  /** Index of the parent bone, -1 for the root. */
  parent: number;
  translation: MutableVec3;
  rotation: [number, number, number, number];
  scale: MutableVec3;
}

/**
 * A skinned instance ready for the animation package: `new Skeleton(bones, inverseBindMatrices)` and
 * `Skin.attach(mesh, skeleton, joints, weights)` on a mesh made from `geometry`. Bones live in scene (world) space,
 * so put the mesh at the scene root with an identity transform.
 */
export interface DAESkinBinding {
  /** The node holding the `<instance_controller>`. */
  node: DAENode;
  instance: DAEInstance;
  /** The mesh in its bind shape (`bind_shape_matrix` applied, morphs at the given weights), in Y-up meters. */
  geometry: DAEMeshGeometry;
  /** Every joint node and its ancestors in scene order; an identity root bone is added when needed. */
  bones: DAEBone[];
  /** 16 column-major numbers per bone: the skin's for joints, the inverse rest world matrix for other bones. */
  inverseBindMatrices: Float64Array;
  /** Four bone indices per vertex of `geometry`. */
  joints: Uint32Array;
  /** Four weights per vertex, summing to 1 (all zero follows the root bone). */
  weights: Float32Array;
}

/** Options of {@link bindDAESkin}. */
export interface DAESkinBindingOptions {
  /** Weights for a skin over a morph (default: the morph's own). */
  weights?: ArrayLike<number>;
}

function trs(m: Matrix): Pick<DAEBone, 'translation' | 'rotation' | 'scale'> {
  const split = splitTRS(m, Infinity);
  if (split.ok) return { translation: split.position, rotation: split.rotation, scale: split.scale };
  return { translation: [m[12], m[13], m[14]], rotation: [0, 0, 0, 1], scale: [0, 0, 0] };
}

/**
 * Skeleton and skin data of a skinned instance (default: the first one in the scene) for the animation package's
 * `Skeleton` and `Skin`. Throws a `LoaderError` (`unsupported`) when the document has no skinned instance.
 */
export function bindDAESkin(
  dae: LoadedDAE,
  instance?: DAEInstance,
  options: DAESkinBindingOptions = {},
): DAESkinBinding {
  const parents = new Map<DAENode, DAENode | undefined>(),
    order: DAENode[] = [];
  let owner: DAENode | undefined;
  const walk = (node: DAENode, parent: DAENode | undefined): void => {
    parents.set(node, parent);
    order.push(node);
    for (const i of node.instances)
      if (!owner && (instance ? i === instance : i.skin !== undefined && i.joints)) {
        owner = node;
        instance ??= i;
      }
    for (const child of node.children) walk(child, node);
  };
  for (const node of dae.nodes) walk(node, undefined);
  if (!instance && !owner) throw new LoaderError(F, 'unsupported', 'the document has no skinned instance');
  const skin = instance?.skin === undefined ? undefined : dae.skins[instance.skin];
  if (!owner || !instance || !skin || !instance.joints)
    throw new TypeError(
      'bindDAESkin needs a skinned instance of this document; pass one whose skin and joints are set',
    );
  const joints = instance.joints,
    mesh = dae.geometries[instance.geometry],
    source =
      instance.morph !== undefined
        ? morphDAE(dae, instance.morph, options.weights)
        : withNormals(mesh, mesh.positions, mesh.normals);
  // The bind shape, applied once.
  const count = source.positions.length / 3,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    co = cofactors(skin.bindShapeMatrix);
  for (let v = 0; v < count; v++)
    transformInto(skin.bindShapeMatrix, source.positions, source.normals, v * 3, positions, normals, v * 3, co);
  let indices = source.indices;
  if (co.determinant < 0) {
    indices = Uint32Array.from(source.indices);
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  }
  // Bones: the joints and every ancestor, in scene order.
  const included = new Set<DAENode>();
  for (const joint of joints)
    for (let n: DAENode | undefined = joint; n && !included.has(n); n = parents.get(n)) included.add(n);
  const nodes = order.filter((n) => included.has(n)),
    roots = nodes.filter((n) => !parents.get(n)).length;
  let unweighted = false;
  for (let v = 0; v < count && !unweighted; v++) {
    const p = source.positionIndices[v];
    let sum = 0;
    for (let k = 0; k < 4; k++) if (skin.vertexJoints[p * 4 + k] >= 0) sum += skin.vertexWeights[p * 4 + k];
    unweighted = !(sum > 0.999999);
  }
  const extra = roots > 1 || unweighted ? 1 : 0,
    names = daeNodeNames(dae),
    taken = new Set(names.values());
  let rootName = skin.id || 'root';
  for (let n = 2; taken.has(rootName); n++) rootName = `${skin.id || 'root'}#${n}`;
  const bones: DAEBone[] = extra
    ? [{ name: rootName, parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]
    : [];
  const boneOf = new Map<DAENode, number>(),
    worlds = new Map<DAENode, Matrix>();
  for (const node of nodes) {
    const parent = parents.get(node),
      world = multiply(parent ? (worlds.get(parent) ?? IDENTITY) : IDENTITY, node.matrix);
    worlds.set(node, world);
    boneOf.set(node, bones.length);
    bones.push({
      name: names.get(node)!,
      parent: parent && boneOf.has(parent) ? boneOf.get(parent)! : extra ? 0 : -1,
      ...trs(node.matrix),
    });
  }
  const inverseBindMatrices = new Float64Array(bones.length * 16),
    bound = new Set<number>();
  if (extra) inverseBindMatrices.set(IDENTITY, 0);
  joints.forEach((joint, j) => {
    const bone = boneOf.get(joint)!;
    if (bound.has(bone)) return;
    bound.add(bone);
    inverseBindMatrices.set(skin.inverseBindMatrices.subarray(j * 16, j * 16 + 16), bone * 16);
  });
  for (const node of nodes) {
    const bone = boneOf.get(node)!;
    if (!bound.has(bone)) inverseBindMatrices.set(invert(worlds.get(node)!) ?? IDENTITY, bone * 16);
  }
  const vertexJoints = new Uint32Array(count * 4),
    vertexWeights = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const p = source.positionIndices[v];
    for (let k = 0; k < 4; k++) {
      const j = skin.vertexJoints[p * 4 + k],
        w = skin.vertexWeights[p * 4 + k];
      vertexJoints[v * 4 + k] = w && j >= 0 ? boneOf.get(joints[j])! : 0;
      vertexWeights[v * 4 + k] = w;
    }
  }
  return {
    node: owner,
    instance,
    geometry: { ...source, positions, normals, indices },
    bones,
    inverseBindMatrices,
    joints: vertexJoints,
    weights: vertexWeights,
  };
}

/** One key of a {@link DAEKeyframeTrack}: the shape of the animation package's `Keyframe`. */
export interface DAEKeyframe {
  /** Seconds from the clip's start. */
  time: number;
  /** [x, y, z] translation or scale, an [x, y, z, w] quaternion, or one weight per morph target. */
  value: number[];
  interpolation: 'linear' | 'discrete';
}

/** Keys for one property of one node: the shape of the animation package's `KeyframeTrackData`. */
export interface DAEKeyframeTrack {
  /** The node's name from {@link daeNodeNames} (a bone name of {@link bindDAESkin}). */
  target: string;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  keys: DAEKeyframe[];
}

/** A clip in the shape of the animation package's `KeyframeClipData`, for `createKeyframeClip`. */
export interface DAEKeyframeClip {
  name: string;
  tracks: DAEKeyframeTrack[];
}

/** Options of {@link daeKeyframeClip}. */
export interface DAEKeyframeClipOptions extends DAEPoseOptions {
  /** Samples per second between keys. Default 30. */
  fps?: number;
  /** Clip name. Default: the clip's name or id, else `''`. */
  name?: string;
}

/**
 * The document's animation (or one clip) as keyframe tracks: translation, rotation and scale for every animated node
 * and weights for every node whose morph is animated. COLLADA channels address single transform elements, so each
 * node is sampled at every key time of its channels and every `1 / fps` second between them, then split into TRS
 * (exact at those times, linear between); a node whose channels all STEP keeps only its keys, held (`discrete`).
 */
export function daeKeyframeClip(dae: LoadedDAE, options: DAEKeyframeClipOptions = {}): DAEKeyframeClip {
  const fps = options.fps ?? 30;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0)
    throw new RangeError(`DAE keyframe fps ${fps} is invalid; pass samples per second > 0`);
  const selected = selection(dae, options.clip),
    keyTimes = (channels: readonly DAEAnimationChannel[]): number[] => channels.flatMap((c) => [...c.sampler.input]),
    all = keyTimes(selected.channels),
    first = all.reduce((a, b) => Math.min(a, b), 0),
    start = options.clip === undefined ? first : selected.start,
    end = Math.max(
      start,
      Math.min(
        selected.end,
        all.reduce((a, b) => Math.max(a, b), start),
      ),
    );
  if ((end - start) * fps > 1e6)
    throw new RangeError(`DAE keyframe clip of ${end - start} s at ${fps} fps exceeds 1,000,000 samples; lower fps`);
  const timesFor = (channels: readonly DAEAnimationChannel[], step: boolean): number[] => {
    const times = [start, end, ...keyTimes(channels)].filter((t) => t >= start && t <= end);
    if (!step) for (let k = 0; start + k / fps < end; k++) times.push(start + k / fps);
    times.sort((a, b) => a - b);
    return times.filter((t, i) => !i || t - times[i - 1] > 1e-9);
  };
  const convert = converter(dae.upAxis, dae.meter),
    names = daeNodeNames(dae),
    tracks: DAEKeyframeTrack[] = [],
    weighted = new Set<DAENode>(),
    morphChannels = selected.channels.filter((c) => c.morph !== undefined);
  const walk = (node: DAENode): void => {
    const channels = node.id === undefined ? undefined : selected.byNode.get(node.id),
      target = names.get(node)!;
    if (channels) {
      const step = channels.every((c) => c.sampler.interpolations.every((i) => i === 'STEP')),
        interpolation = step ? 'discrete' : 'linear',
        translation: DAEKeyframe[] = [],
        rotation: DAEKeyframe[] = [],
        scale: DAEKeyframe[] = [];
      let previous: number[] | undefined;
      for (const t of timesFor(channels, step)) {
        const split = trs(convert(stackMatrix(animateTransforms(node.transforms, channels, t)))),
          q = split.rotation;
        // Keep neighbouring quaternions in one hemisphere.
        if (previous && q[0] * previous[0] + q[1] * previous[1] + q[2] * previous[2] + q[3] * previous[3] < 0)
          for (let c = 0; c < 4; c++) q[c] = -q[c];
        previous = q;
        const time = t - start;
        translation.push({ time, value: split.translation, interpolation });
        rotation.push({ time, value: q, interpolation });
        scale.push({ time, value: split.scale, interpolation });
      }
      tracks.push(
        { target, path: 'translation', keys: translation },
        { target, path: 'rotation', keys: rotation },
        { target, path: 'scale', keys: scale },
      );
    }
    for (const instance of node.instances) {
      const morph = instance.morph;
      if (morph === undefined || weighted.has(node)) continue;
      const channels = morphChannels.filter((c) => c.morph === morph);
      if (!channels.length) continue;
      weighted.add(node);
      const step = channels.every((c) => c.sampler.interpolations.every((i) => i === 'STEP'));
      tracks.push({
        target,
        path: 'weights',
        keys: timesFor(channels, step).map((t) => ({
          time: t - start,
          value: weightsAt(dae, channels, t)[morph],
          interpolation: step ? 'discrete' : 'linear',
        })),
      });
    }
    node.children.forEach(walk);
  };
  dae.nodes.forEach(walk);
  return { name: options.name ?? selected.name, tracks };
}
