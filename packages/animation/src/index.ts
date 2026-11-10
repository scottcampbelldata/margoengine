/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { rangeError } from '../../shared/errors.js';
import { hiddenInTree } from '../../shared/visibility.js';
import type { PBRModel, PBRPrimitive, PBRDeformationContext } from '@margoengine/gltf-pro';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { ordinaryWeightBuffer } from './weight-buffer.js';
import { multiplyMatrices } from '@margoengine/math/mat4';
import type { Interpolation } from './sampling.js';
import { sampleCursor } from './key-cursor.js';
import { DeformArena, weightRegion, type DispatchCache, type Slot, type SlotSpec } from './batch.js';
import type { SkinningMode } from './shader.js';
import type { PointerChannels, PointerPlan } from './pointer.js';
import { applyKeyframeClip, type KeyframeClip } from './keyframes.js';
export { createMaterialAnimation } from './material-animation.js';
import {
  animationDocument,
  animationDefinition,
  animationChannel,
  animationSampler,
  animationNode,
  animationAccessor,
  animationIndex,
  animationPath,
  animationInterpolation,
  skinDefinition,
  morphDefinition,
} from './gltf.js';
export { sampleTrack, sampleTrackInto, type ClipMarker, type Interpolation } from './sampling.js';
export type { SkinningMode } from './shader.js';
export { Skeleton, Skin, type BoneData, type BonePose } from './skin.js';
export {
  createKeyframeClip,
  sampleKeyframes,
  applyKeyframeClip,
  segmentTime,
  bakeKeyframeClip,
  bakeKeyframeTrack,
  type KeyInterpolation,
  type KeyframeBlend,
  type KeyframePath,
  type KeyframeModelTarget,
  type Keyframe,
  type KeyframeTrackData,
  type KeyframeClipData,
  type KeyframeTrack,
  type KeyframeClip,
  type BakedChannel,
  type BakedSampler,
  type PropertyValueType,
  type PropertyTrackData,
  type PropertyKeyframeTrack,
} from './keyframes.js';
export {
  compileRigidClip,
  type RigidBinding,
  type RigidBone,
  type RigidClipOptions,
  type RigidKey,
} from './rigid.js';
export {
  AnimationGroup,
  type AnimationGroupMember,
  type AnimationGroupOptions,
  type AnimationGroupPlayer,
} from './group.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; COPY_DST: number; COPY_SRC: number; UNIFORM: number };
interface Track {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  times: Float32Array;
  values: Float32Array;
  width: number;
  interpolation: Interpolation;
  sample: Float32Array;
  rotation?: number[];
  /** The key the previous frame's sample found (key-cursor.ts). */
  cursor: number;
}
interface Clip {
  name: string;
  duration: number;
  tracks: Track[];
  /** Binds the clip's KHR_animation_pointer material, light, camera and visibility channels on first playback. */
  bind?: () => KeyframeClip;
  bound?: KeyframeClip;
}
interface Deformation {
  primitive: PBRPrimitive;
  /** Where the primitive lives in the device's shared deformation buffers (batch.ts). */
  slot: Slot;
  /** The shared buffers holding its deformed vertices, morph weights and bone palette (at the slot's offsets). */
  readonly output: GPUBuffer;
  readonly weights: GPUBuffer;
  readonly bones: GPUBuffer;
  palette: Float32Array;
  // These private input buffers keep their last successfully queued upload.
  // The shared deformed output is still dispatched for every render.
  paletteBits: Uint32Array;
  uploadedPalette: Uint32Array;
  uploadedWeights: Float32Array;
  bonesUploaded: boolean;
  weightsUploaded: boolean;
  bonesQueue?: GPUQueue;
  weightsQueue?: GPUQueue;
  uploadArgs: [GPUBuffer, number, Float32Array<ArrayBuffer>];
  joints: number[];
  inverseBind: Float32Array[];
  /**
   * The record of an earlier primitive of the same skinned node whose bone range this one shares (batch.ts `add`): it
   * computes, checks and uploads the palette for both. Unset for the first primitive of a node, or one placed apart.
   */
  leader?: Deformation;
}
/** Portable clip playback; clip index disambiguates repeated names. */
export interface AnimationState {
  version: 1;
  clip: number;
  time: number;
  playing: boolean;
  loop: boolean;
  speed: number;
}
/** Options for {@link Animation}. */
export interface AnimationOptions {
  /** Wrap time at the end of the clip. Default true; false holds the last frame. */
  loop?: boolean;
  /** Playback rate multiplier, finite and >= 0. Default 1. */
  speed?: number;
  /**
   * KHR_animation_pointer playback, opt-in so apps without pointer channels do not ship it: pass `pointerChannels`
   * from `@margoengine/animation/pointer`. Without it, pointer channels are skipped (still counted in the clip's
   * duration) and listed in `warnings`.
   */
  pointers?: PointerChannels;
  /**
   * How bones blend, opt-in so apps that do not use it do not ship it: pass `dualQuaternionSkinning` from
   * `@margoengine/animation/dqs`. Unset blends matrices linearly. Fixed for the Animation's life.
   */
  skinning?: SkinningMode;
  /**
   * Another model of the same file whose nodes are the joints, so this model's skin follows that model's pose, whatever
   * moves it. This Animation then has no clips of its own. Default: the model's own nodes.
   */
  skeleton?: PBRModel;
}
// Without the pointer entry: keep ordinary channels, skip and report pointer channels.
function skipPointers(model: PBRModel, def: ReturnType<typeof animationDefinition>, clip: string): PointerPlan {
  const ordinary: unknown[] = [],
    warnings: string[] = [];
  let duration = 0;
  def.channels.forEach((value, c) => {
    const channel = value as { sampler?: unknown; target?: { path?: unknown; extensions?: Record<string, unknown> } },
      pointer = channel?.target?.extensions?.KHR_animation_pointer as { pointer?: unknown } | undefined;
    if (channel?.target?.path !== 'pointer' && pointer === undefined) {
      ordinary.push(value);
      return;
    }
    const sampler = animationSampler(def.samplers[animationIndex(channel.sampler, def.samplers.length, 'sampler')]);
    duration = Math.max(duration, model.asset.accessor(sampler.input, 'SCALAR').at(-1) ?? 0);
    warnings.push(
      `Animation ${clip} channel ${c}: pointer ${String(pointer?.pointer)} is not played; pass pointers from @margoengine/animation/pointer (Animation.attach(model, {pointers: pointerChannels}))`,
    );
  });
  return { ordinary, nodes: [], duration, warnings };
}
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// Only the ordinary same-realm native method has synchronous copy semantics
// known here. Custom writers may change inputs during the copy and restore
// them before returning, so comparing the input afterward cannot certify it.
function captureNativeQueue(): { prototype: object; writer: GPUQueue['writeBuffer'] } | undefined {
  try {
    const constructor = globalThis.GPUQueue,
      prototype = typeof constructor === 'function' ? constructor.prototype : undefined,
      writer = prototype && Object.getOwnPropertyDescriptor(prototype, 'writeBuffer')?.value;
    // A conservative host filter, not a security boundary for replaced intrinsics.
    if (
      prototype &&
      typeof writer === 'function' &&
      /^function writeBuffer\(\)\s*\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(writer))
    )
      return { prototype, writer };
  } catch {
    // Unknown host implementations keep the original unconditional upload path.
  }
}
const nativeQueue = /* @__PURE__ */ captureNativeQueue();
const lookupQueueGetter = Reflect.get(Object.prototype, '__lookupGetter__') as (
  this: object,
  property: string,
) => unknown;
function reusableWriter(queue: GPUQueue, writer: GPUQueue['writeBuffer']): boolean {
  return (
    !!nativeQueue &&
    writer === nativeQueue.writer &&
    Object.getPrototypeOf(queue) === nativeQueue.prototype &&
    !Object.hasOwn(queue, 'writeBuffer') &&
    typeof lookupQueueGetter === 'function' &&
    lookupQueueGetter.call(queue, 'writeBuffer') === undefined
  );
}
function writeInput(
  queue: GPUQueue,
  writer: GPUQueue['writeBuffer'],
  r: Deformation,
  buffer: GPUBuffer,
  offset: number,
  values: Float32Array<ArrayBuffer>,
): void {
  const args = r.uploadArgs;
  args[0] = buffer;
  args[1] = offset;
  args[2] = values;
  try {
    Reflect.apply(writer, queue, args);
  } finally {
    // A caller-owned morph view need not stay retained between renders.
    args[2] = undefined!;
  }
}
/** The Animations whose passes share a frame graph, and how many of those passes ran in the current execution. */
interface DeformGroup {
  members: Set<Animation>;
  ran: number;
  /** The batched dispatches of the members that last deformed together. */
  cache: DispatchCache;
}
const emptyCache = (): DispatchCache => ({ owners: [], version: -1, dispatches: [] });
const slotsOf = (owner: object): readonly Slot[] => (owner as Animation)['slots'];
const deformGroups = new WeakMap<FrameGraph, DeformGroup>();
const morphAttributes = ['POSITION', 'NORMAL', 'TANGENT'] as const;
/** A primitive's morph deltas, 12 floats per vertex and target (position, normal, tangent at 0, 4, 8). */
function morphDeltas(
  asset: PBRModel['asset'],
  targets: ReturnType<typeof morphDefinition>['targets'],
  count: number,
): Float32Array {
  const deltas = new Float32Array(count * targets.length * 12);
  targets.forEach((target, t) =>
    morphAttributes.forEach((name, k) => {
      if (target[name] === undefined) return;
      const data = asset.accessor(target[name], 'VEC3');
      for (let i = 0; i < count; i++) deltas.set(data.subarray(i * 3, i * 3 + 3), (t * count + i) * 12 + k * 4);
    }),
  );
  return deltas;
}
/** A deformation record; made outside setup's loop so it holds none of that loop's large temporaries. */
function deformationRecord(p: PBRPrimitive): Deformation {
  return {
    primitive: p,
    slot: undefined!,
    get output() {
      return this.slot.page.output.buffer!;
    },
    get weights() {
      return this.slot.page.weights.buffer!;
    },
    get bones() {
      return this.slot.page.bones.buffer!;
    },
    palette: new Float32Array(),
    paletteBits: new Uint32Array(),
    uploadedPalette: new Uint32Array(),
    uploadedWeights: new Float32Array(p.weights.length),
    bonesUploaded: false,
    weightsUploaded: false,
    uploadArgs: [undefined!, 0, undefined!],
    joints: [],
    inverseBind: [],
  };
}
function record(
  pass: GPUComputePassEncoder,
  d: { pipeline: GPUComputePipeline; group: GPUBindGroup; x: number; y: number },
): void {
  pass.setPipeline(d.pipeline);
  pass.setBindGroup(0, d.group);
  pass.dispatchWorkgroups(d.x, d.y);
}
/**
 * Plays a glTF model's animation clips on the GPU: node translation, rotation and scale, skinning and morph targets. Add it to the engine with {@link Animation.attach}; it advances each frame and removes itself when the model is disposed.
 *
 * Defaults: plays clip 0, looping, at speed 1 (see {@link AnimationOptions}).
 *
 * @example
 * ```ts
 * const model = await loadGLTF(engine, 'character.glb');
 * const animation = Animation.attach(model);
 * animation.play('Walk');
 * ```
 */
export class Animation implements EnginePlugin {
  readonly name: string;
  readonly clips: readonly Clip[];
  /**
   * One line per KHR_animation_pointer channel the clips skip: valid pointers this player cannot drive (an extension
   * it does not know, `extras`, a property the asset leaves undefined, a target no scene node or primitive uses).
   */
  readonly warnings: readonly string[];
  playing = true;
  time = 0;
  clip = 0;
  private device?: GPUDevice;
  private arena?: DeformArena;
  private resources: Deformation[] = [];
  /** The distinct nodes of `resources`, so the hidden check walks each node's ancestry once. */
  private deformedNodes: PBRPrimitive['node'][] = [];
  /** The resources' slots, in order (the arena's view of this Animation). */
  private slots: Slot[] = [];
  /** This Animation's own dispatches, for deformation outside a shared frame-graph pass. */
  private readonly cache: DispatchCache = emptyCache();
  private readonly inverse = new Float32Array(16);
  private readonly joint = new Float32Array(16);
  private readonly product = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly quaternion: number[] = [0, 0, 0, 1];
  private disposed = false;
  /**
   * The model's primitives grouped by node: node n's are `primitives[groupItems[k]]` for k from groupStart[n] to
   * groupStart[n + 1]. Built by validate(); each frame re-checks it and the morph widths without allocating.
   */
  private groupStart = new Int32Array(1);
  private groupItems = new Int32Array(0);
  private unsubscribe?: () => void;
  /** The model whose nodes are the joints: this one, or `options.skeleton`. */
  private readonly joints: PBRModel;
  private readonly prepareDeformation = (context: PBRDeformationContext) => this.deform(context);
  /** The deformation group of the frame graph this Animation's pass is in. */
  private group?: DeformGroup;
  private readonly createDeformationRenderer = (model: PBRModel, device: GPUDevice) => {
    const renderer = new Animation(model, this.options);
    renderer.playing = false;
    try {
      renderer.setup(model.root.engine, device);
      return { prepare: renderer.prepareDeformation, dispose: () => renderer.dispose() };
    } catch (error) {
      renderer.dispose();
      throw error;
    }
  };
  private readonly rest: Array<{
    position: [number, number, number];
    scale: [number, number, number];
    rotation: number[];
  }>;
  constructor(
    readonly model: PBRModel,
    readonly options: AnimationOptions = {},
  ) {
    this.name = 'animation:' + model.name;
    this.validate();
    this.joints = options.skeleton ?? model;
    this.rest = model.nodes.map((node) => {
      const t = node.engine.store.transforms,
        id = node.id;
      return {
        position: [t.x[id], t.y[id], t.z[id]],
        scale: [t.sx[id], t.sy[id], t.sz[id]],
        rotation: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
      };
    });
    const doc = animationDocument(model.asset.doc),
      warnings: string[] = [];
    // A model on another's skeleton plays nothing itself: that model's player moves the joints.
    this.clips = (options.skeleton ? [] : doc.animations).map((value, id) => {
      const def = animationDefinition(value);
      const label = def.name ?? String(id),
        plan = options.pointers ? options.pointers(model, def, label) : skipPointers(model, def, label);
      warnings.push(...plan.warnings);
      const destinations = new Set<string>();
      const track = (node: number, path: Track['path'], samplerId: unknown): Track => {
        if (animationNode(doc.nodes[node]).matrix)
          throw new TypeError(
            'Invalid animation target; glTF animations cannot drive a node that has a matrix, give it translation/rotation/scale',
          );
        const key = node + ':' + path;
        if (destinations.has(key))
          throw new RangeError(
            'Duplicate animation target; give each node and path (translation, rotation, scale, weights) one channel per animation',
          );
        destinations.add(key);
        const sampler = animationSampler(def.samplers[animationIndex(samplerId, def.samplers.length, 'sampler')]),
          times = model.asset.accessor(sampler.input, 'SCALAR'),
          interpolation = animationInterpolation(sampler.interpolation);
        if (times.some((v, i) => v < 0 || (i > 0 && v <= times[i - 1])))
          throw new RangeError(
            'Invalid animation time/interpolation; keyframe times must be >= 0 and strictly increasing',
          );
        if (
          animationAccessor(doc, sampler.input)?.componentType !== 5126 ||
          animationAccessor(doc, sampler.output)?.componentType !== 5126
        )
          throw new TypeError(
            'Animation accessors must be Float32; re-export the glTF without quantised animation data',
          );
        const weights = model.primitives.find((p) => p.nodeIndex === node)?.weights.length;
        const width = path === 'rotation' ? 4 : path === 'weights' ? (weights ?? 0) : 3;
        if (!width)
          throw new TypeError(
            'Animation target has no morph weights; animate weights only on a node whose mesh has morph targets',
          );
        const values = model.asset.accessor(
            sampler.output,
            path === 'weights' ? 'SCALAR' : path === 'rotation' ? 'VEC4' : 'VEC3',
          ),
          factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
        if (values.length !== times.length * width * factor)
          throw new RangeError(
            'Animation output count mismatch; the output accessor needs one value per key (three per key for CUBICSPLINE)',
          );
        return {
          node,
          path,
          times,
          values,
          width,
          interpolation,
          sample: new Float32Array(width),
          ...(path === 'rotation' ? { rotation: [0, 0, 0, 1] } : {}),
          cursor: 0,
        };
      };
      const tracks: Track[] = plan.ordinary.map((value) => {
        const channel = animationChannel(value);
        return track(
          animationIndex(channel.target.node, model.nodes.length, 'node'),
          animationPath(channel.target.path),
          channel.sampler,
        );
      });
      // Pointer node channels: a node's TRS or weights by pointer and by an ordinary channel is a duplicate.
      for (const channel of plan.nodes) tracks.push(track(channel.node, channel.path, channel.sampler));
      return {
        name: def.name ?? 'Animation ' + id,
        duration: Math.max(plan.duration, ...tracks.map((t) => t.times.at(-1)!)),
        tracks,
        ...(plan.bind ? { bind: plan.bind } : {}),
      };
    });
    this.warnings = warnings;
  }
  static attach(model: PBRModel, options: AnimationOptions = {}): Animation {
    const animation = new Animation(model, options);
    model.root.engine.use(animation);
    return animation;
  }
  private validate(): void {
    this.groupPrimitives();
    this.checkWidths();
    this.checkOptions();
  }
  /** Groups the primitives by node (once, and again only if `model.primitives` changes). */
  private groupPrimitives(): void {
    const primitives = this.model.primitives,
      start = new Int32Array(this.model.nodes.length + 1),
      items = new Int32Array(primitives.length);
    for (const primitive of primitives) start[primitive.nodeIndex + 1]++;
    for (let n = 0; n < start.length - 1; n++) start[n + 1] += start[n];
    const fill = start.slice(0, -1);
    primitives.forEach((primitive, i) => (items[fill[primitive.nodeIndex]++] = i));
    this.groupStart = start;
    this.groupItems = items;
  }
  /** True when the grouping still names every primitive of the model under its current node. */
  private grouped(): boolean {
    const primitives = this.model.primitives,
      start = this.groupStart,
      items = this.groupItems;
    if (primitives.length !== items.length || start.length !== this.model.nodes.length + 1) return false;
    for (let n = 0; n + 1 < start.length; n++)
      for (let k = start[n]; k < start[n + 1]; k++) if (primitives[items[k]]?.nodeIndex !== n) return false;
    return true;
  }
  /** Every primitive of a node has as many morph weights as the node's first. */
  private checkWidths(): void {
    const primitives = this.model.primitives,
      start = this.groupStart,
      items = this.groupItems;
    for (let n = 0; n + 1 < start.length; n++)
      for (let k = start[n] + 1; k < start[n + 1]; k++)
        if (primitives[items[k]].weights.length !== primitives[items[start[n]]].weights.length)
          throw new RangeError(
            "Morph target counts must match across a node's primitives; give every primitive of the mesh the same targets",
          );
  }
  /** The per-frame form of validate(): the same checks and errors, with no allocation unless the primitives changed. */
  private checkFrame(): void {
    if (!this.grouped()) this.groupPrimitives();
    this.checkWidths();
    this.checkOptions();
  }
  private checkOptions(): void {
    if (
      (this.options.loop !== undefined && typeof this.options.loop !== 'boolean') ||
      !Number.isFinite(this.options.speed ?? 1) ||
      (this.options.speed ?? 1) < 0
    )
      throw new RangeError('Invalid animation options; loop must be a boolean and speed a finite number >= 0');
    const skeleton = this.options.skeleton;
    if (skeleton !== undefined && skeleton.nodes?.length !== this.model.nodes.length)
      throw new TypeError('Invalid skeleton option; pass a model of the same file, with the same nodes');
    const skinning = this.options.skinning;
    if (skinning !== undefined && (typeof skinning?.shader !== 'function' || typeof skinning.encode !== 'function'))
      throw new TypeError('Invalid skinning option; pass dualQuaternionSkinning from @margoengine/animation/dqs');
    if (this.options.pointers !== undefined && typeof this.options.pointers !== 'function')
      throw new TypeError(
        'Animation pointers option must be pointerChannels; import it from @margoengine/animation/pointer',
      );
  }
  play(clip: string | number = 0): this {
    if (this.disposed) throw new MargoError('disposed', 'Animation is disposed; create a new Animation');
    const id = typeof clip === 'string' ? this.clips.findIndex((c) => c.name === clip) : clip;
    if (!Number.isInteger(id) || id < 0 || id >= this.clips.length)
      throw new RangeError('Unknown animation clip; pass a clip name or an index from animation.clips');
    for (const [i, rest] of this.rest.entries())
      this.model.nodes[i].setPosition(rest.position).setScale(rest.scale).setQuaternion(rest.rotation);
    this.clip = id;
    this.time = 0;
    this.playing = true;
    this.apply(0);
    return this;
  }
  captureState(): AnimationState {
    if (this.disposed) throw new MargoError('disposed', 'Cannot capture a disposed Animation; use a live player');
    return {
      version: 1,
      clip: this.clip,
      time: this.time,
      playing: this.playing,
      loop: this.options.loop ?? true,
      speed: this.options.speed ?? 1,
    };
  }
  restoreState(state: AnimationState): this {
    if (
      this.disposed ||
      !state ||
      state.version !== 1 ||
      !Number.isInteger(state.clip) ||
      state.clip < 0 ||
      state.clip >= Math.max(1, this.clips.length) ||
      !Number.isFinite(state.time) ||
      state.time < 0 ||
      typeof state.playing !== 'boolean' ||
      typeof state.loop !== 'boolean' ||
      !Number.isFinite(state.speed) ||
      state.speed < 0
    )
      throw new MargoError('state', 'Invalid Animation state; restore a snapshot of this model');
    this.clip = state.clip;
    this.options.loop = state.loop;
    this.options.speed = state.speed;
    this.seek(state.time);
    this.playing = state.playing;
    return this;
  }
  seek(time: number): this {
    if (!Number.isFinite(time) || time < 0 || this.disposed)
      throw new RangeError('Invalid animation time; seek to a finite time >= 0 on a live Animation');
    this.time = time;
    this.apply(time);
    return this;
  }
  /** Set every model target with this glTF extras.targetNames name, across all mesh nodes. */
  setMorph(name: string, weight: number): void;
  /** Set one target on a specific glTF mesh node. */
  setMorph(node: number, target: number, weight: number): void;
  setMorph(node: number | string, target: number, weight = NaN): void {
    if (typeof node === 'string') {
      const matches: [PBRPrimitive, number][] = [];
      for (const p of this.model.primitives)
        for (let i = 0; i < p.targetNames.length; i++)
          if (p.targetNames[i] === node && i < p.weights.length) matches.push([p, i]);
      if (!matches.length || !Number.isFinite(Math.fround(target)) || this.disposed)
        throw this.morphError(`name ${JSON.stringify(node)}`);
      for (const [p, i] of matches) p.weights[i] = target;
      return;
    }
    // Index loops, no filtered copy: keyframe and group playback call this per weight per frame.
    const primitives = this.model.primitives;
    let found = false,
      fits = Number.isInteger(target) && target >= 0;
    for (let i = 0; i < primitives.length; i++)
      if (primitives[i].nodeIndex === node) {
        found = true;
        if (target >= primitives[i].weights.length) fits = false;
      }
    if (!found || !fits || !Number.isFinite(Math.fround(weight)) || this.disposed) {
      throw this.morphError(`node ${node}, target ${target}`);
    }
    for (let i = 0; i < primitives.length; i++)
      if (primitives[i].nodeIndex === node) primitives[i].weights[target] = weight;
  }
  private morphError(request: string): RangeError {
    const candidates = new Map<number, number>();
    for (const p of this.model.primitives) if (p.weights.length) candidates.set(p.nodeIndex, p.weights.length);
    return rangeError(
      'Invalid morph target/weight; pass a morph target index the node has and a finite weight, on a live Animation; ' +
        `requested ${request}; available ` +
        ([...candidates].map(([index, count]) => `node ${index}: ${count} targets`).join(', ') || 'no morphed nodes'),
      'geometry',
    );
  }
  private apply(time: number): void {
    const clip = this.clips[this.clip];
    if (!clip) return;
    const t = (this.options.loop ?? true) && clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
    if (!this.grouped()) this.groupPrimitives();
    for (let i = 0; i < clip.tracks.length; i++) {
      const track = clip.tracks[i];
      // Each track carries its own scratch, so filtering or reordering a clip's tracks keeps it allocation-free.
      const value = sampleCursor(track, t, track.path === 'rotation', track.sample),
        node = this.model.nodes[track.node];
      // The transform refs check the node and the values (the sampler leaves only finite Float32 values); their
      // setters write the same lanes as setPosition and setScale without those methods' per-call array scan.
      if (track.path === 'translation') node.position.set(value[0], value[1], value[2]);
      else if (track.path === 'scale') {
        // A zero scale gets core's own error from setScale.
        if (Math.fround(value[0]) === 0 || Math.fround(value[1]) === 0 || Math.fround(value[2]) === 0)
          node.setScale(value as unknown as [number, number, number]);
        else node.scale.set(value[0], value[1], value[2]);
      } else if (track.path === 'rotation') {
        if (value.length !== 4) node.setQuaternion(Array.from(value));
        else {
          for (let c = 0; c < 4; c++) this.quaternion[c] = value[c];
          node.setQuaternion(this.quaternion);
        }
      } else {
        node.check();
        const primitives = this.model.primitives,
          items = this.groupItems;
        for (let k = this.groupStart[track.node]; k < this.groupStart[track.node + 1]; k++)
          primitives[items[k]].weights.set(value);
      }
    }
    if (clip.bind) applyKeyframeClip((clip.bound ??= clip.bind()), t);
  }
  setup(engine: Engine, device = engine.gpu): void {
    if (engine !== this.model.root.engine || this.model.disposed || this.disposed)
      throw new MargoError(
        'attached',
        'Animation model is disposed or belongs to another engine; attach the Animation to the engine that loaded the model',
      );
    if (!device)
      throw new MargoError(
        'unsupported',
        'Animation requires WebGPU; use a browser with WebGPU or leave skinning and morphing out; see https://margoengine.com/errors#webgpu',
      );
    this.device = device;
    this.unsubscribe?.();
    this.unsubscribe = this.model.onDispose(() => this.destroy());
    const arena = (this.arena = DeformArena.of(device)),
      records: Deformation[] = [],
      specs: SlotSpec[] = [];
    const doc = animationDocument(this.model.asset.doc);
    for (const p of this.model.primitives) {
      const definition = morphDefinition(p.definition),
        targets = definition.targets,
        skinId = animationNode(doc.nodes[p.nodeIndex]).skin;
      const skinValue = typeof skinId === 'number' ? doc.skins[skinId] : undefined;
      if (skinId !== undefined && (typeof skinId !== 'number' || !Number.isInteger(skinId) || skinId < 0 || !skinValue))
        throw new TypeError(
          'Missing glTF skin; the node must reference a skin index that exists in the glTF skins array',
        );
      if (!targets.length && skinId === undefined) continue;
      const count = p.vertices.length / 20,
        record = deformationRecord(p),
        asset = this.model.asset;
      if (count * targets.length * 48 > this.device.limits.maxStorageBufferBindingSize)
        throw new RangeError('Morph deltas exceed device limit; reduce the vertex or morph target count');
      // Checked now; packed only for the first copy of the primitive placed on the device (the others share it).
      for (const target of targets)
        for (const name of morphAttributes)
          if (target[name] !== undefined && asset.accessor(target[name], 'VEC3').length !== count * 3)
            throw new RangeError('Morph target count mismatch; every morph attribute needs one VEC3 per vertex');
      let inverseBind: Float32Array = new Float32Array(identity),
        joints: number[] = [];
      const attributes = definition.attributes,
        extra = skinId !== undefined && (attributes.JOINTS_1 !== undefined || attributes.WEIGHTS_1 !== undefined),
        stride = extra ? 16 : 8;
      const influenceBytes = new ArrayBuffer(Math.max(32, count * stride * 4)),
        jointIds = new Uint32Array(influenceBytes),
        influenceFloats = new Float32Array(influenceBytes);
      if (skinId !== undefined) {
        const skin = skinDefinition(skinValue, this.model.nodes.length);
        joints = skin.joints;
        inverseBind =
          skin.inverseBindMatrices === undefined
            ? Float32Array.from(joints.flatMap(() => Array.from(identity)))
            : this.model.asset.accessor(skin.inverseBindMatrices, 'MAT4');
        if (
          skin.inverseBindMatrices !== undefined &&
          animationAccessor(doc, skin.inverseBindMatrices)?.componentType !== 5126
        )
          throw new TypeError('Inverse bind matrices must be Float32; re-export the glTF without quantised matrices');
        if (inverseBind.length !== joints.length * 16)
          throw new RangeError('Inverse bind matrix count mismatch; the skin needs one 4x4 matrix per joint');
        for (const name of Object.keys(attributes))
          if (/^(JOINTS|WEIGHTS)_/.test(name) && !/^(JOINTS|WEIGHTS)_[01]$/.test(name))
            throw new RangeError(
              'More than eight joint influences are unsupported; limit each vertex to JOINTS_0 and JOINTS_1',
            );
        const sets: Array<{ ids: Float32Array; weights: Float32Array }> = [];
        for (let set = 0; set < (extra ? 2 : 1); set++) {
          const jointIndex = attributes['JOINTS_' + set],
            weightIndex = attributes['WEIGHTS_' + set];
          if (jointIndex === undefined || weightIndex === undefined)
            throw new TypeError('Skin attributes require paired JOINTS_' + set + ' and WEIGHTS_' + set);
          const ids = this.model.asset.accessor(jointIndex, 'VEC4'),
            weights = this.model.asset.accessor(weightIndex, 'VEC4');
          const jointAccessor = animationAccessor(doc, jointIndex);
          if (
            ids.length !== count * 4 ||
            weights.length !== count * 4 ||
            (jointAccessor?.componentType !== 5121 && jointAccessor?.componentType !== 5123) ||
            jointAccessor?.normalized
          )
            throw new TypeError(
              'Invalid skin attributes; JOINTS_n must be unsigned byte or short VEC4, WEIGHTS_n VEC4, one per vertex',
            );
          const weightAccessor = animationAccessor(doc, weightIndex);
          if (
            !weightAccessor ||
            (weightAccessor.componentType !== 5126 &&
              weightAccessor.componentType !== 5121 &&
              weightAccessor.componentType !== 5123) ||
            (weightAccessor.componentType !== 5126 && !weightAccessor.normalized)
          )
            throw new TypeError(
              'Invalid skin weight component type; use float, or normalized unsigned byte or short weights',
            );
          sets.push({ ids, weights });
        }
        for (let i = 0; i < count; i++) {
          const weights = sets[0].weights;
          let sum = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
          if (extra) {
            const weights = sets[1].weights;
            sum += weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
          }
          if (sum <= 0) throw new RangeError('Skin weights must have a positive sum');
          for (let set = 0; set < sets.length; set++)
            for (let c = 0; c < 4; c++) {
              const { ids, weights } = sets[set],
                at = i * 4 + c,
                base = i * stride + set * 8;
              if (!Number.isInteger(ids[at]) || ids[at] < 0 || ids[at] >= joints.length || weights[at] < 0)
                throw new RangeError(
                  'Invalid skin joint/weight; joint indices must address the skin joints and weights must be >= 0',
                );
              jointIds[base + c] = ids[at];
              influenceFloats[base + 4 + c] = weights[at] / sum;
            }
        }
      }
      record.joints = joints;
      record.inverseBind = joints.map((_, i) => inverseBind.subarray(i * 16, i * 16 + 16));
      record.palette = Float32Array.from(joints.length ? joints.flatMap(() => Array.from(identity)) : identity);
      record.paletteBits = new Uint32Array(record.palette.buffer);
      record.uploadedPalette = new Uint32Array(record.palette.length);
      records.push(record);
      specs.push({
        primitive: p,
        count,
        targets: targets.length,
        joints: joints.length,
        extra,
        mode: joints.length ? this.options.skinning : undefined,
        asset: this.model.asset,
        definition: p.definition,
        skin: skinId,
        deltas: () => morphDeltas(asset, targets, count),
        influences: () => jointIds.subarray(0, joints.length ? count * stride : 0),
      });
    }
    // One placement for the whole model, so its primitives grow the shared buffers at most once. The bind-pose
    // vertices and current weights go up with them; bones are uploaded with the first deformation.
    const slots = arena.add(specs);
    this.slots.push(...slots);
    // Compile the pipelines the model needs while it loads, not on its first frame.
    for (const slot of slots) arena.pipeline(slot.extra, slot.mode);
    records.forEach((record, i) => {
      record.slot = slots[i];
      // A primitive sharing an earlier one's bone range shares its palette: same node, so same joints and binds.
      const leader = records.slice(0, i).find((r) => r.slot.bones === slots[i].bones && !r.leader);
      if (leader) {
        record.leader = leader;
        record.palette = leader.palette;
        record.paletteBits = leader.paletteBits;
        record.uploadedPalette = leader.uploadedPalette;
      }
      const weights = record.primitive.weights;
      if (weights.length && weights.byteLength <= weightRegion(slots[i].targets) * 4)
        device.queue.writeBuffer(record.weights, slots[i].weights.offset * 4, weights as Float32Array<ArrayBuffer>);
    });
    this.resources.push(...records);
    for (const record of records)
      if (!this.deformedNodes.includes(record.primitive.node)) this.deformedNodes.push(record.primitive.node);
    this.model.prepareDeformation = this.prepareDeformation;
    this.model.createDeformationRenderer = this.createDeformationRenderer;
  }
  onPreUpdate(delta: number): void {
    if (this.model.disposed) {
      this.model.root.engine.sceneOf(this)?.removePlugin(this.name);
      return;
    }
    this.checkFrame();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid animation delta; pass a finite delta >= 0 seconds');
    if (this.playing) {
      this.time += delta * (this.options.speed ?? 1);
      this.apply(this.time);
      if (this.options.loop === false && this.time >= (this.clips[this.clip]?.duration ?? Infinity))
        this.playing = false;
    }
  }
  registerPasses(graph: FrameGraph): void {
    let group = deformGroups.get(graph);
    if (!group) deformGroups.set(graph, (group = { members: new Set(), ran: 0, cache: emptyCache() }));
    group.members.add(this);
    this.group = group;
    graph.add({ name: this.name, order: -10, execute: (c) => this.deformAll(c) });
  }
  /**
   * Every Animation of a frame graph deforms in one compute pass: the first of their passes in each graph execution
   * uploads each one's weights and bones and encodes one batched dispatch per buffer page and pipeline for all of
   * them; the rest of that execution's passes skip. (A compute pass per model cost about 10 us of GPU time each, and a
   * dispatch per primitive about 6 us: 100 two-primitive models 1.3 ms.)
   */
  private deformAll(context: PassContext): void {
    const group = this.group;
    if (!group || context.backend !== 'webgpu') return this.deform(context);
    // The group's passes run back to back in each graph execution; the first does the work, the last resets.
    const first = group.ran === 0;
    group.ran = group.ran + 1 >= group.members.size ? 0 : group.ran + 1;
    if (!first) return;
    try {
      const members: Animation[] = [];
      for (const a of group.members) if (a.upload(context)) members.push(a);
      if (!members.length) return;
      const pass = context.encoder.beginComputePass();
      try {
        // Members of one graph render with one engine, so one device and arena.
        members[0].arena!.dispatches(members, slotsOf, group.cache).forEach((d) => record(pass, d));
      } finally {
        pass.end();
      }
    } catch (error) {
      // The graph stops here, so the other passes of this execution never run: the next one starts afresh.
      group.ran = 0;
      throw error;
    }
  }
  private deform(context: PassContext | PBRDeformationContext): void {
    if (!this.upload(context)) return;
    // One pass, one batched dispatch per buffer page and pipeline for every skinned or morphed primitive.
    const pass = context.encoder.beginComputePass();
    try {
      this.arena!.dispatches([this], slotsOf, this.cache).forEach((d) => record(pass, d));
    } finally {
      pass.end();
    }
  }
  /** Checks and uploads this frame's weights and bone palettes; false when there is nothing to dispatch. */
  private upload(
    context: PassContext | PBRDeformationContext,
  ): context is Extract<PassContext, { backend: 'webgpu' }> | PBRDeformationContext {
    if (context.backend !== 'webgpu' || this.model.disposed) return false;
    // A level of detail not on show, or another hidden model: no draw reads its vertices, so they wait until it shows.
    const { store } = this.model.root.engine;
    let shown = false;
    for (let i = 0; !shown && i < this.deformedNodes.length; i++)
      if (!hiddenInTree(store, this.deformedNodes[i].id)) shown = true;
    if (!shown) return false;
    for (const r of this.resources) {
      const weights = r.primitive.weights;
      for (let i = 0; i < weights.length; i++)
        if (!Number.isFinite(weights[i]))
          throw new RangeError('Invalid morph weights; set finite weights on the primitive');
      if (r.joints.length && !r.leader) {
        if (!invertMatrixStable(r.primitive.node.matrix, this.inverse, this.workspace))
          throw new RangeError('Singular skinned mesh transform; give the skinned node a non-zero scale');
        for (let i = 0; i < r.joints.length; i++) {
          multiplyMatrices(this.joints.nodes[r.joints[i]].matrix, r.inverseBind[i], this.joint);
          multiplyMatrices(this.inverse, this.joint, this.product);
          r.palette.set(this.product, i * 16);
        }
        for (let i = 0; i < r.palette.length; i++)
          if (!Number.isFinite(r.palette[i]))
            throw new RangeError('Skin matrix overflow; use finite joint transforms and inverse bind matrices');
        this.options.skinning?.encode(r.palette);
        const queue = context.device.queue,
          writer = queue.writeBuffer,
          reusable = reusableWriter(queue, writer);
        let changed = !reusable || !r.bonesUploaded || r.bonesQueue !== queue;
        // Stop at the first changed word: a playing clip changes the palette every frame, and comparing all of it
        // anyway was most of p-crossfade's upload time (100 RobotExpressive palettes, 1.2 ms a frame).
        for (let i = 0; !changed && i < r.paletteBits.length; i++)
          if (r.paletteBits[i] !== r.uploadedPalette[i]) changed = true;
        if (changed) {
          let uploaded = false;
          r.bonesUploaded = false;
          try {
            writeInput(queue, writer, r, r.bones, r.slot.bones.offset * 64, r.palette as Float32Array<ArrayBuffer>);
            if (reusable) {
              r.uploadedPalette.set(r.paletteBits);
              r.bonesQueue = queue;
              uploaded = true;
            }
          } finally {
            // A custom writer can reenter deformation; its outer call must not
            // inherit an inner call's certification of this shared buffer.
            r.bonesUploaded = uploaded;
          }
        }
      }
      if (r.primitive.weights.length) {
        const values = r.primitive.weights,
          queue = context.device.queue,
          writer = queue.writeBuffer,
          reusable = reusableWriter(queue, writer),
          at = r.slot.weights.offset * 4;
        // The weights share one buffer with other primitives': never write past this primitive's region.
        if ((values as ArrayBufferView).byteLength > weightRegion(r.slot.targets) * 4)
          throw new RangeError(
            'Morph weights longer than the primitive has morph targets; give primitive.weights one value per target',
          );
        if (
          !reusable ||
          !(values instanceof Float32Array) ||
          !ordinaryWeightBuffer(values) ||
          values.length !== r.uploadedWeights.length
        ) {
          // Preserve native writeBuffer validation and partial-write behavior
          // when callers replace a weight view with a different shape or type.
          // Shared memory can change while native writeBuffer copies its input.
          r.weightsUploaded = false;
          try {
            writeInput(queue, writer, r, r.weights, at, values as Float32Array<ArrayBuffer>);
          } finally {
            r.weightsUploaded = false;
          }
        } else {
          let changed = !r.weightsUploaded || r.weightsQueue !== queue;
          for (let i = 0; !changed && i < values.length; i++)
            // Finite Float32 values differ in bits exactly when SameValue differs.
            if (!Object.is(values[i], r.uploadedWeights[i])) changed = true;
          if (changed) {
            r.weightsUploaded = false;
            writeInput(queue, writer, r, r.weights, at, values as Float32Array<ArrayBuffer>);
            r.uploadedWeights.set(values);
            r.weightsQueue = queue;
            r.weightsUploaded = true;
          }
        }
      }
    }
    return this.resources.length > 0;
  }
  private release(): void {
    if (this.model.createDeformationRenderer === this.createDeformationRenderer)
      this.model.createDeformationRenderer = undefined;
    if (this.model.prepareDeformation === this.prepareDeformation) this.model.prepareDeformation = undefined;
    // The shared caches name this Animation's slots: drop them before the slots go.
    if (this.arena) {
      this.arena.drop(this.cache);
      if (this.group) this.arena.drop(this.group.cache);
      for (const slot of this.slots) this.arena.remove(slot);
    }
    this.resources = [];
    this.deformedNodes = [];
    this.slots = [];
    this.arena = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.model.root.engine.sceneOf(this)?.removePlugin(this.name);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.release();
    this.group?.members.delete(this);
    this.group = undefined;
    this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
