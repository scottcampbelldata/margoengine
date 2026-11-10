// Clean-room VRMC_vrm_animation 1.0 reader and FK retargeted playback. See docs/rigging-vrma.md.
import { MargoError } from '@margoengine/math/errors';
import { splitTRS } from '@margoengine/math/quat';
import { sampleTrack, type Interpolation } from '@margoengine/animation/sampling';
import type { RetargetRig } from '@margoengine/animation/skeleton-utils';
import type { Animation } from '@margoengine/animation';
import type { GLTFDocument } from '@margoengine/gltf-pro/asset';
import { glbChunks, isGLB, GLB_JSON, GLB_BIN } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import { readResponse } from '../../shared/loading.js';
import { assetURL, checkRedirect } from '../../shared/asset-url.js';
import { HUMANOID_BONES, type HumanoidBone } from './retarget.js';
import type { VRMAvatar, VRMHandle, VRMGaze } from './vrm.js';

/** VRMC_vrm_animation metadata, retained with extension fields and licensing extras. */
export interface VRMAExtension {
  specVersion: '1.0';
  humanoid?: { humanBones: Partial<Record<HumanoidBone, { node: number }>> };
  expressions?: { preset?: Record<string, { node: number }>; custom?: Record<string, { node: number }> };
  lookAt?: { node?: number; offsetFromHeadBone?: readonly number[] };
  [key: string]: unknown;
}
/** One checked glTF animation channel, using seconds and quaternion XYZW. */
export interface VRMATrack {
  readonly node: number;
  readonly path: 'rotation' | 'translation';
  readonly times: Float32Array;
  readonly values: Float32Array;
  readonly interpolation: Interpolation;
}
/** A file may carry several clips; playback defaults to the first. */
export interface VRMAClip {
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly VRMATrack[];
}
/** Decoded VRMA data, independent of a renderer or avatar. */
export interface VRMA {
  readonly document: GLTFDocument;
  readonly extension: VRMAExtension;
  readonly rig: RetargetRig;
  readonly clips: readonly VRMAClip[];
}
/** Loading limits and cancellation. Defaults: 64 MiB total and global fetch. */
export interface VRMALoadOptions {
  signal?: AbortSignal;
  maxDownloadBytes?: number;
  fetch?: typeof globalThis.fetch;
  /** External buffers for a parsed document or bytes, indexed as in glTF. */
  buffers?: Array<ArrayBuffer | ArrayBufferView>;
}
const fail = (message: string): never => {
  throw new RangeError(`Invalid VRMA: ${message}; check the file against VRMC_vrm_animation 1.0`);
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validNode = (value: unknown, count: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < count;

// Names use humanoid roles; every other node has a unique, unmatchable id. Retarget checks topology and rest data.
function rigOf(doc: GLTFDocument, bones: Partial<Record<HumanoidBone, { node: number }>>): RetargetRig {
  if (!Array.isArray(doc.nodes ?? []) || (doc.nodes?.length ?? 0) > 100_000)
    fail('nodes must be an array with at most 100000 entries');
  const nodes = doc.nodes ?? [],
    parents = nodes.map(() => -1),
    names = nodes.map((_, i) => `#${i}`),
    rest = new Float64Array(nodes.length * 10);
  for (const [name, bone] of Object.entries(bones)) {
    if (
      !HUMANOID_BONES.includes(name as HumanoidBone) ||
      !validNode(bone?.node, nodes.length) ||
      !names[bone.node].startsWith('#')
    )
      fail(`invalid or repeated bone ${name}`);
    names[bone.node] = name;
  }
  nodes.forEach((node, i) => {
    if (!object(node)) fail(`node ${i}`);
    for (const [field, width] of [
      ['translation', 3],
      ['rotation', 4],
      ['scale', 3],
      ['matrix', 16],
    ] as const) {
      const value = node[field];
      if (value !== undefined && (!Array.isArray(value) || value.length !== width || !value.every(Number.isFinite)))
        fail(`node ${i} ${field}`);
    }
    if (node.rotation && Math.abs(Math.hypot(...node.rotation) - 1) > 1e-5)
      fail(`node ${i} rotation must be normalized`);
    if (node.scale?.some((value) => value <= 0)) fail(`node ${i} scale must be positive`);
    const trs = node.matrix ? splitTRS(node.matrix) : null;
    if (trs && !trs.ok) fail(`node ${i} matrix is ${trs.reason}`);
    rest.set(trs?.ok ? trs.position : (node.translation ?? [0, 0, 0]), i * 10);
    rest.set(trs?.ok ? trs.rotation : (node.rotation ?? [0, 0, 0, 1]), i * 10 + 3);
    rest.set(trs?.ok ? trs.scale : (node.scale ?? [1, 1, 1]), i * 10 + 7);
    if (node.children !== undefined && !Array.isArray(node.children)) fail(`node ${i} children`);
    for (const child of node.children ?? []) {
      if (!validNode(child, nodes.length) || parents[child] !== -1) fail(`node ${i} child or multiple parent`);
      parents[child] = i;
    }
  });
  // Iterative path marks avoid stack overflow for large files and detect cycles before any playback.
  const marks = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    let p = i;
    while (p >= 0 && marks[p] === 0) {
      marks[p] = 1;
      p = parents[p];
    }
    if (p >= 0 && marks[p] === 1) fail('cyclic node hierarchy');
    p = i;
    while (p >= 0 && marks[p] === 1) {
      marks[p] = 2;
      p = parents[p];
    }
  }
  if (!rest.every(Number.isFinite)) fail('nonfinite rest transform');
  return { names, parents, rest };
}

/** Parse bytes or glTF JSON and supplied buffers. Sparse/interleaved accessors use the checked glTF asset reader. */
export async function readVRMA(source: Uint8Array | GLTFDocument, options: VRMALoadOptions = {}): Promise<VRMA> {
  options.signal?.throwIfAborted();
  const max = options.maxDownloadBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max <= 0) fail('maxDownloadBytes must be a positive integer');
  let doc: GLTFDocument, binary: Uint8Array | undefined;
  if (source instanceof Uint8Array) {
    if (source.byteLength > max) fail('download exceeds maxDownloadBytes');
    if (isGLB(source)) {
      const chunks = glbChunks(source);
      doc = parseJSON(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON)!.data));
      binary = chunks.find((c) => c.type === GLB_BIN)?.data;
    } else doc = parseJSON(new TextDecoder().decode(source));
  } else doc = structuredClone(source);
  const extension = doc?.extensions?.VRMC_vrm_animation as VRMAExtension;
  if (!object(extension) || extension.specVersion !== '1.0') fail('VRMC_vrm_animation specVersion must be 1.0');
  const bones = extension.humanoid?.humanBones ?? {};
  if (!object(bones)) fail('humanoid humanBones must be an object');
  if (bones.leftEye || bones.rightEye) fail('eye bones must use lookAt');
  const rig = rigOf(doc, bones),
    roles = new Map<number, string>();
  for (const [name, bone] of Object.entries(bones)) roles.set(bone.node, name);
  for (const group of [extension.expressions?.preset, extension.expressions?.custom]) {
    if (group !== undefined && !object(group)) fail('expressions must be objects');
    for (const [name, ref] of Object.entries(group ?? {})) {
      if (
        !validNode(ref?.node, rig.names.length) ||
        roles.has(ref.node) ||
        ['lookUp', 'lookDown', 'lookLeft', 'lookRight'].includes(name)
      )
        fail(`expression ${name}`);
      roles.set(ref.node, `expression:${name}`);
    }
  }
  const look = extension.lookAt?.node;
  if (look !== undefined) {
    if (!validNode(look, rig.names.length) || roles.has(look)) fail('lookAt node');
    roles.set(look, 'lookAt');
  }
  const { GLTFAsset } = await import('@margoengine/gltf-pro/asset');
  options.signal?.throwIfAborted();
  // This entry implements VRMA, so only its required-extension marker is consumed here.
  const asset = new GLTFAsset(
    { ...doc, extensionsRequired: doc.extensionsRequired?.filter((name) => name !== 'VRMC_vrm_animation') },
    options.buffers ?? [],
    binary,
    {},
    max,
  );
  const clips = (doc.animations ?? []).map((animation, index) => {
    const seen = new Set<string>();
    const tracks: VRMATrack[] = [];
    for (const channel of animation.channels) {
      const node = channel.target?.node,
        role = roles.get(node!),
        path = channel.target?.path;
      if (!validNode(node, rig.names.length)) fail('animation target node');
      if (!role) continue;
      if ((role === 'lookAt' && path !== 'rotation') || (role.startsWith('expression:') && path !== 'translation'))
        continue;
      if (
        role !== 'lookAt' &&
        !role.startsWith('expression:') &&
        (path === 'scale' || (path === 'translation' && role !== 'hips'))
      )
        fail(`forbidden ${path} track on ${role}`);
      if (path !== 'rotation' && path !== 'translation') continue;
      if (seen.has(`${node}:${path}`)) fail('duplicate animation channel');
      seen.add(`${node}:${path}`);
      const sampler = animation.samplers[channel.sampler];
      if (!sampler) fail('animation sampler');
      const interpolation = sampler.interpolation ?? 'LINEAR',
        width = path === 'rotation' ? 4 : 3;
      const times = asset.accessor(sampler.input, 'SCALAR'),
        values = asset.accessor(sampler.output, width === 4 ? 'VEC4' : 'VEC3');
      if (
        !times.length ||
        times.some((v, i) => !Number.isFinite(v) || v < 0 || (i > 0 && v <= times[i - 1])) ||
        !values.every(Number.isFinite)
      )
        fail('animation times or values');
      if (doc.accessors![sampler.input].componentType !== 5126 || doc.accessors![sampler.output].componentType !== 5126)
        fail('animation accessors must be FLOAT');
      if (width === 4) {
        const stride = interpolation === 'CUBICSPLINE' ? 12 : 4,
          start = interpolation === 'CUBICSPLINE' ? 4 : 0;
        for (let k = start; k < values.length; k += stride)
          if (Math.abs(Math.hypot(...values.subarray(k, k + 4)) - 1) > 1e-5) fail('rotation keys must be normalized');
      }
      sampleTrack(times, values, width, 0, interpolation as Interpolation, width === 4);
      tracks.push({
        node: node!,
        path,
        times: times.slice(),
        values: values.slice(),
        interpolation: interpolation as Interpolation,
      });
    }
    return {
      name: animation.name ?? `animation_${index}`,
      duration: tracks.reduce((last, t) => Math.max(last, t.times[t.times.length - 1]), 0),
      tracks,
    };
  });
  if (!clips.length) fail('file has no animations');
  return { document: doc, extension, rig, clips };
}

/** Fetch a .vrma/JSON glTF and its external buffers, with a single total byte budget and AbortSignal. */
export async function loadVRMA(url: string | URL, options: VRMALoadOptions = {}): Promise<VRMA> {
  const requested = new URL(String(url), typeof location === 'undefined' ? undefined : location.href),
    base = assetURL(requested.href, requested),
    max = options.maxDownloadBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max <= 0) fail('maxDownloadBytes must be a positive integer');
  let total = 0;
  const get = async (address: URL) => {
    options.signal?.throwIfAborted();
    const response = checkRedirect(await (options.fetch ?? fetch)(address, { signal: options.signal }), base);
    if (!response.ok)
      throw new MargoError('failed', `VRMA download failed: HTTP ${response.status}; check the URL and server access`);
    const bytes = await readResponse(response, { maxBytes: max - total, signal: options.signal, label: 'VRMA' });
    total += bytes.byteLength;
    return bytes;
  };
  const bytes = await get(base);
  const chunks = isGLB(bytes) ? glbChunks(bytes) : null;
  const doc = parseJSON<GLTFDocument>(
    new TextDecoder().decode(chunks ? chunks.find((c) => c.type === GLB_JSON)!.data : bytes),
  );
  if (!object(doc) || !Array.isArray(doc.buffers ?? [])) fail('document or buffers');
  const buffers = [...(options.buffers ?? [])];
  for (let i = 0; i < (doc.buffers?.length ?? 0); i++) {
    const uri = doc.buffers![i].uri;
    if (uri && !uri.startsWith('data:') && !buffers[i]) buffers[i] = await get(assetURL(uri, base));
  }
  return readVRMA(bytes, { ...options, buffers });
}

/** Explicit playback controls. Defaults: clip 0, looping, speed 1, automatic scene updates. */
export interface VRMAPlayerOptions {
  clip?: string | number;
  loop?: boolean;
  speed?: number;
  hipScale?: number;
  vrm?: VRMHandle;
  autoUpdate?: boolean;
}
/** A bound humanoid animation player. Dispose restores the transforms and expression values it owns. */
export interface VRMAPlayer {
  readonly clip: VRMAClip;
  readonly time: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  seek(time: number): void;
  update(delta: number): void;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Convert a glTF XYZW gaze quaternion to extrinsic ZXY yaw and pitch, in VRM degrees. */
export function vrmaGaze(q: ArrayLike<number>): VRMGaze {
  const [x, y, z, w] = Array.from(q),
    norm = Math.hypot(x, y, z, w);
  if (!(norm > 0) || !Number.isFinite(norm)) fail('gaze quaternion');
  const xx = x / norm,
    yy = y / norm,
    zz = z / norm,
    ww = w / norm;
  return {
    yaw: (Math.atan2(2 * (xx * zz + yy * ww), 1 - 2 * (xx * xx + yy * yy)) * 180) / Math.PI,
    pitch: (Math.asin(Math.max(-1, Math.min(1, 2 * (xx * ww - yy * zz)))) * 180) / Math.PI,
  };
}

/** Bind VRMA to a VRM model. Full rest world frames absorb arbitrary axes and missing optional bones. */
export async function playVRMA(
  data: VRMA,
  animation: Animation,
  avatar: VRMAvatar,
  options: VRMAPlayerOptions = {},
): Promise<VRMAPlayer> {
  const { Retarget } = await import('@margoengine/animation/skeleton-utils');
  const model = animation.model,
    target = rigOf(model.asset.doc, avatar.humanoid.humanBones);
  const index =
    typeof options.clip === 'string' ? data.clips.findIndex((c) => c.name === options.clip) : (options.clip ?? 0);
  const clip = data.clips[index];
  if (!clip) fail('unknown clip');
  const source = { ...data.rig, names: data.rig.names.map((name) => (name.startsWith('#') ? `source${name}` : name)) };
  const mapped = Object.keys(avatar.humanoid.humanBones).filter((name) => source.names.includes(name));
  const retarget = mapped.length
    ? new Retarget(source, target, { ...(mapped.includes('hips') ? { hip: 'hips', hipScale: options.hipScale } : {}) })
    : null;
  const input = source.rest.slice(),
    output = target.rest.slice(),
    scratch = [new Float32Array(3), new Float32Array(4)];
  const saved = mapped.map((name) => {
    const node = avatar.humanoid.humanBones[name as HumanoidBone]!.node,
      id = model.nodes[node].id,
      t = model.root.engine.store.transforms;
    return {
      node,
      q: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
      p: [t.x[id], t.y[id], t.z[id]] as [number, number, number],
    };
  });
  const expr = new Map<number, string>();
  for (const group of [data.extension.expressions?.preset, data.extension.expressions?.custom])
    for (const [name, ref] of Object.entries(group ?? {}))
      if (options.vrm?.expressions.names.includes(name)) expr.set(ref.node, name);
  const original = new Map([...expr.values()].map((name) => [name, options.vrm!.expressions.get(name)]));
  const originalGaze = options.vrm?.lookAtGaze ?? null;
  let time = 0,
    dead = false,
    speed = options.speed ?? 1,
    loop = options.loop ?? true,
    playing = true;
  const checkSpeed = (v: number) => {
    if (!Number.isFinite(v)) fail('speed must be finite');
    return v;
  };
  checkSpeed(speed);
  const seek = (seconds: number) => {
    if (dead) throw new MargoError('disposed', 'VRMA player is disposed; create a new player');
    if (!Number.isFinite(seconds) || seconds < 0) fail('time must be finite and nonnegative');
    time = Math.min(clip.duration, seconds);
    input.set(source.rest);
    for (const track of clip.tracks) {
      const value = sampleTrack(
        track.times,
        track.values,
        track.path === 'rotation' ? 4 : 3,
        time,
        track.interpolation,
        track.path === 'rotation',
        scratch[track.path === 'rotation' ? 1 : 0],
      );
      if (expr.has(track.node)) options.vrm!.expressions.set(expr.get(track.node)!, Math.max(0, Math.min(1, value[0])));
      else if (track.node === data.extension.lookAt?.node) {
        if (options.vrm) options.vrm.lookAtGaze = vrmaGaze(value);
      } else input.set(value, track.node * 10 + (track.path === 'rotation' ? 3 : 0));
    }
    retarget?.pose(input, output);
    for (const { node } of saved) {
      model.nodes[node].setQuaternion(Array.from(output.subarray(node * 10 + 3, node * 10 + 7)));
      if (target.names[node] === 'hips' && retarget?.hip === node)
        model.nodes[node].setPosition(
          Array.from(output.subarray(node * 10, node * 10 + 3)) as [number, number, number],
        );
    }
  };
  const update = (delta: number) => {
    if (!Number.isFinite(delta) || delta < 0) fail('delta must be finite and nonnegative');
    if (dead || !playing) return;
    let next = time + delta * speed;
    if (loop && clip.duration > 0) next = ((next % clip.duration) + clip.duration) % clip.duration;
    else if (next >= clip.duration || next < 0) {
      next = Math.max(0, Math.min(clip.duration, next));
      playing = false;
    }
    seek(next);
  };
  const owner = model.root.scene,
    name = `vrma:${model.root.id}`;
  let detach: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  const dispose = () => {
    if (dead) return;
    dead = true;
    playing = false;
    detach?.();
    unsubscribe?.();
    for (const { node, q, p } of saved) {
      model.nodes[node].setQuaternion(q);
      if (target.names[node] === 'hips') model.nodes[node].setPosition(p);
    }
    for (const [key, value] of original) options.vrm!.expressions.set(key, value);
    if (options.vrm) options.vrm.lookAtGaze = originalGaze;
  };
  if (options.autoUpdate !== false) {
    if (options.vrm) detach = options.vrm.addPoseSource(update);
    else {
      owner.use({ name, setup() {}, onPreUpdate: update });
      detach = () => owner.removePlugin(name);
    }
  }
  unsubscribe = model.onDispose(() => {
    if (!dead) {
      dead = true;
      playing = false;
      detach?.();
    }
  });
  seek(0);
  return {
    clip,
    get time() {
      return time;
    },
    get playing() {
      return playing;
    },
    set playing(v) {
      playing = v;
    },
    get speed() {
      return speed;
    },
    set speed(v) {
      speed = checkSpeed(v);
    },
    get loop() {
      return loop;
    },
    set loop(v) {
      loop = v;
    },
    seek,
    update,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
