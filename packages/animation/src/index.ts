/// <reference lib="esnext.disposable" preserve="true" />
import type { PBRModel, PBRPrimitive, PBRDeformationContext } from '@margoengine/gltf-pro';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { ordinaryWeightBuffer } from './weight-buffer.js';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { sampleTrackInto, type Interpolation } from './sampling.js';
import { deformationShader, deformationShader8 } from './shader.js';
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
export { sampleTrack, sampleTrackInto, multiplyMatrices, type Interpolation } from './sampling.js';
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
}
interface Clip {
  name: string;
  duration: number;
  tracks: Track[];
}
interface Deformation {
  primitive: PBRPrimitive;
  buffers: GPUBuffer[];
  group: GPUBindGroup;
  output: GPUBuffer;
  weights: GPUBuffer;
  bones: GPUBuffer;
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
  pipeline: GPUComputePipeline;
}
export interface AnimationOptions {
  loop?: boolean;
  speed?: number;
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
  values: Float32Array<ArrayBuffer>,
): void {
  const args = r.uploadArgs;
  args[0] = buffer;
  args[2] = values;
  try {
    Reflect.apply(writer, queue, args);
  } finally {
    // A caller-owned morph view need not stay retained between renders.
    args[2] = undefined!;
  }
}
export class Animation implements EnginePlugin {
  readonly name: string;
  readonly clips: readonly Clip[];
  playing = true;
  time = 0;
  clip = 0;
  private device?: GPUDevice;
  private pipeline?: GPUComputePipeline;
  private pipeline8?: GPUComputePipeline;
  private resources: Deformation[] = [];
  private readonly inverse = new Float32Array(16);
  private readonly joint = new Float32Array(16);
  private readonly product = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly samples: Float32Array[][];
  private readonly quaternion: number[] = [0, 0, 0, 1];
  private disposed = false;
  private unsubscribe?: () => void;
  private readonly prepareDeformation = (context: PBRDeformationContext) => this.deform(context);
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
    this.rest = model.nodes.map((node) => {
      const t = node.engine.store.transforms,
        id = node.id;
      return {
        position: [t.x[id], t.y[id], t.z[id]],
        scale: [t.sx[id], t.sy[id], t.sz[id]],
        rotation: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
      };
    });
    const doc = animationDocument(model.asset.doc);
    this.clips = doc.animations.map((value, id) => {
      const def = animationDefinition(value);
      const destinations = new Set<string>();
      const tracks: Track[] = def.channels.map((value) => {
        const channel = animationChannel(value),
          node = animationIndex(channel.target.node, model.nodes.length, 'node'),
          path = animationPath(channel.target.path);
        if (animationNode(doc.nodes[node]).matrix) throw new TypeError('Invalid animation target');
        const key = node + ':' + path;
        if (destinations.has(key)) throw new Error('Duplicate animation target');
        destinations.add(key);
        const sampler = animationSampler(def.samplers[animationIndex(channel.sampler, def.samplers.length, 'sampler')]),
          times = model.asset.accessor(sampler.input, 'SCALAR'),
          interpolation = animationInterpolation(sampler.interpolation);
        if (times.some((v, i) => v < 0 || (i > 0 && v <= times[i - 1])))
          throw new RangeError('Invalid animation time/interpolation');
        if (
          animationAccessor(doc, sampler.input)?.componentType !== 5126 ||
          animationAccessor(doc, sampler.output)?.componentType !== 5126
        )
          throw new TypeError('Animation accessors must be Float32');
        const weights = model.primitives.find((p) => p.nodeIndex === node)?.weights.length;
        const width = path === 'rotation' ? 4 : path === 'weights' ? (weights ?? 0) : 3;
        if (!width) throw new TypeError('Animation target has no morph weights');
        const values = model.asset.accessor(
            sampler.output,
            path === 'weights' ? 'SCALAR' : path === 'rotation' ? 'VEC4' : 'VEC3',
          ),
          factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
        if (values.length !== times.length * width * factor) throw new RangeError('Animation output count mismatch');
        return {
          node,
          path,
          times,
          values,
          width,
          interpolation,
          sample: new Float32Array(width),
          ...(path === 'rotation' ? { rotation: [0, 0, 0, 1] } : {}),
        };
      });
      return {
        name: def.name ?? 'Animation ' + id,
        duration: Math.max(0, ...tracks.map((t) => t.times.at(-1)!)),
        tracks,
      };
    });
    this.samples = this.clips.map((clip) => clip.tracks.map((track) => new Float32Array(track.width)));
  }
  static attach(model: PBRModel, options: AnimationOptions = {}): Animation {
    const animation = new Animation(model, options);
    model.root.engine.use(animation);
    return animation;
  }
  private validate(): void {
    const widths = new Map<number, number>();
    for (const primitive of this.model.primitives) {
      const width = widths.get(primitive.nodeIndex);
      if (width !== undefined && width !== primitive.weights.length)
        throw new RangeError("Morph target counts must match across a node's primitives");
      widths.set(primitive.nodeIndex, primitive.weights.length);
    }
    if (
      (this.options.loop !== undefined && typeof this.options.loop !== 'boolean') ||
      !Number.isFinite(this.options.speed ?? 1) ||
      (this.options.speed ?? 1) < 0
    )
      throw new RangeError('Invalid animation options');
  }
  play(clip: string | number = 0): this {
    if (this.disposed) throw new Error('Animation is disposed');
    const id = typeof clip === 'string' ? this.clips.findIndex((c) => c.name === clip) : clip;
    if (!Number.isInteger(id) || id < 0 || id >= this.clips.length) throw new RangeError('Unknown animation clip');
    for (const [i, rest] of this.rest.entries())
      this.model.nodes[i].setPosition(rest.position).setScale(rest.scale).setQuaternion(rest.rotation);
    this.clip = id;
    this.time = 0;
    this.playing = true;
    this.apply(0);
    return this;
  }
  seek(time: number): this {
    if (!Number.isFinite(time) || time < 0 || this.disposed) throw new RangeError('Invalid animation time');
    this.time = time;
    this.apply(time);
    return this;
  }
  setMorph(node: number, target: number, weight: number): void {
    const primitives = this.model.primitives.filter((p) => p.nodeIndex === node);
    if (
      !primitives.length ||
      !Number.isInteger(target) ||
      target < 0 ||
      primitives.some((p) => target >= p.weights.length) ||
      !Number.isFinite(Math.fround(weight)) ||
      this.disposed
    )
      throw new RangeError('Invalid morph target/weight');
    for (const p of primitives) p.weights[target] = weight;
  }
  private apply(time: number): void {
    const clip = this.clips[this.clip];
    if (!clip) return;
    const t = (this.options.loop ?? true) && clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
    for (let i = 0; i < clip.tracks.length; i++) {
      const track = clip.tracks[i];
      const value = sampleTrackInto(
          track.times,
          track.values,
          track.width,
          t,
          track.interpolation,
          track.path === 'rotation',
          this.samples[this.clip]?.[i],
        ),
        node = this.model.nodes[track.node];
      node.check();
      if (track.path === 'translation') node.setPosition(value as unknown as [number, number, number]);
      else if (track.path === 'scale') node.setScale(value as unknown as [number, number, number]);
      else if (track.path === 'rotation') {
        if (value.length !== 4) node.setQuaternion(Array.from(value));
        else {
          for (let c = 0; c < 4; c++) this.quaternion[c] = value[c];
          node.setQuaternion(this.quaternion);
        }
      } else for (const p of this.model.primitives) if (p.nodeIndex === track.node) p.weights.set(value);
    }
  }
  setup(engine: Engine, device = engine.gpu): void {
    if (engine !== this.model.root.engine || this.model.disposed || this.disposed)
      throw new Error('Animation model is disposed or belongs to another engine');
    if (!device) throw new Error('Animation requires WebGPU');
    this.device = device;
    this.unsubscribe?.();
    this.unsubscribe = this.model.onDispose(() => this.destroy());
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code: deformationShader }), entryPoint: 'main' },
    });
    const doc = animationDocument(this.model.asset.doc);
    for (const p of this.model.primitives) {
      const definition = morphDefinition(p.definition),
        targets = definition.targets,
        skinId = animationNode(doc.nodes[p.nodeIndex]).skin;
      const skinValue = typeof skinId === 'number' ? doc.skins[skinId] : undefined;
      if (skinId !== undefined && (typeof skinId !== 'number' || !Number.isInteger(skinId) || skinId < 0 || !skinValue))
        throw new TypeError('Missing glTF skin');
      if (!targets.length && skinId === undefined) continue;
      const count = p.vertices.length / 20,
        buffers: GPUBuffer[] = [],
        record: Deformation = {
          primitive: p,
          buffers,
          group: undefined!,
          output: undefined!,
          weights: undefined!,
          bones: undefined!,
          palette: new Float32Array(),
          paletteBits: new Uint32Array(),
          uploadedPalette: new Uint32Array(),
          uploadedWeights: new Float32Array(p.weights.length),
          bonesUploaded: false,
          weightsUploaded: false,
          uploadArgs: [undefined!, 0, undefined!],
          joints: [],
          inverseBind: [],
          pipeline: this.pipeline,
        };
      this.resources.push(record);
      const upload = (data: Float32Array | Uint32Array, usage = GPUBufferUsage.STORAGE) => {
        const size = Math.max(16, data.byteLength);
        if (
          size > this.device!.limits.maxBufferSize ||
          (usage & GPUBufferUsage.STORAGE && size > this.device!.limits.maxStorageBufferBindingSize)
        )
          throw new RangeError('Animation buffer exceeds device limit');
        const b = this.device!.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
        buffers.push(b);
        if (data.byteLength) this.device!.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
        return b;
      };
      if (count * targets.length * 48 > this.device.limits.maxStorageBufferBindingSize)
        throw new RangeError('Morph deltas exceed device limit');
      const deltas = new Float32Array(Math.max(12, count * targets.length * 12));
      targets.forEach((target, t) => {
        for (const [name, at] of [
          ['POSITION', 0],
          ['NORMAL', 4],
          ['TANGENT', 8],
        ] as const)
          if (target[name] !== undefined) {
            const data = this.model.asset.accessor(target[name], 'VEC3');
            if (data.length !== count * 3) throw new RangeError('Morph target count mismatch');
            for (let i = 0; i < count; i++) deltas.set(data.subarray(i * 3, i * 3 + 3), (t * count + i) * 12 + at);
          }
      });
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
          throw new TypeError('Inverse bind matrices must be Float32');
        if (inverseBind.length !== joints.length * 16) throw new RangeError('Inverse bind matrix count mismatch');
        for (const name of Object.keys(attributes))
          if (/^(JOINTS|WEIGHTS)_/.test(name) && !/^(JOINTS|WEIGHTS)_[01]$/.test(name))
            throw new Error('More than eight joint influences are unsupported');
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
            throw new TypeError('Invalid skin attributes');
          const weightAccessor = animationAccessor(doc, weightIndex);
          if (
            !weightAccessor ||
            (weightAccessor.componentType !== 5126 &&
              weightAccessor.componentType !== 5121 &&
              weightAccessor.componentType !== 5123) ||
            (weightAccessor.componentType !== 5126 && !weightAccessor.normalized)
          )
            throw new TypeError('Invalid skin weight component type');
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
                throw new RangeError('Invalid skin joint/weight');
              jointIds[base + c] = ids[at];
              influenceFloats[base + 4 + c] = weights[at] / sum;
            }
        }
        if (extra)
          record.pipeline = this.pipeline8 ??= this.device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.device.createShaderModule({ code: deformationShader8 }), entryPoint: 'main' },
          });
      }
      record.joints = joints;
      record.inverseBind = joints.map((_, i) => inverseBind.subarray(i * 16, i * 16 + 16));
      record.palette = Float32Array.from(joints.length ? joints.flatMap(() => Array.from(identity)) : identity);
      record.paletteBits = new Uint32Array(record.palette.buffer);
      record.uploadedPalette = new Uint32Array(record.palette.length);
      const source = upload(p.vertices),
        output = upload(p.vertices, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC),
        morph = upload(deltas),
        weights = upload(p.weights),
        bones = upload(record.palette),
        influences = upload(jointIds),
        counts = upload(new Uint32Array([count, targets.length, joints.length, 0]), GPUBufferUsage.UNIFORM);
      record.output = output;
      record.weights = weights;
      record.bones = bones;
      record.group = this.device.createBindGroup({
        layout: record.pipeline.getBindGroupLayout(0),
        entries: [source, output, morph, weights, bones, influences, counts].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
      p.deformed = output;
    }
    this.model.prepareDeformation = this.prepareDeformation;
    this.model.createDeformationRenderer = this.createDeformationRenderer;
  }
  onPreUpdate(delta: number): void {
    if (this.model.disposed) {
      this.model.root.engine.removePlugin(this.name);
      return;
    }
    this.validate();
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid animation delta');
    if (this.playing) {
      this.time += delta * (this.options.speed ?? 1);
      this.apply(this.time);
      if (this.options.loop === false && this.time >= (this.clips[this.clip]?.duration ?? Infinity))
        this.playing = false;
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: -10, execute: (c) => this.deform(c) });
  }
  private deform(context: PassContext | PBRDeformationContext): void {
    if (context.backend !== 'webgpu' || this.model.disposed) return;
    for (const r of this.resources) {
      const weights = r.primitive.weights;
      for (let i = 0; i < weights.length; i++)
        if (!Number.isFinite(weights[i])) throw new RangeError('Invalid morph weights');
      if (r.joints.length) {
        if (!invertMatrixStable(r.primitive.node.matrix, this.inverse, this.workspace))
          throw new Error('Singular skinned mesh transform');
        for (let i = 0; i < r.joints.length; i++) {
          multiplyMatrices(this.model.nodes[r.joints[i]].matrix, r.inverseBind[i], this.joint);
          multiplyMatrices(this.inverse, this.joint, this.product);
          r.palette.set(this.product, i * 16);
        }
        for (let i = 0; i < r.palette.length; i++)
          if (!Number.isFinite(r.palette[i])) throw new RangeError('Skin matrix overflow');
        const queue = context.device.queue,
          writer = queue.writeBuffer,
          reusable = reusableWriter(queue, writer);
        let changed = !reusable || !r.bonesUploaded || r.bonesQueue !== queue;
        for (let i = 0; i < r.paletteBits.length; i++) if (r.paletteBits[i] !== r.uploadedPalette[i]) changed = true;
        if (changed) {
          let uploaded = false;
          r.bonesUploaded = false;
          try {
            writeInput(queue, writer, r, r.bones, r.palette as Float32Array<ArrayBuffer>);
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
          reusable = reusableWriter(queue, writer);
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
            writeInput(queue, writer, r, r.weights, values as Float32Array<ArrayBuffer>);
          } finally {
            r.weightsUploaded = false;
          }
        } else {
          let changed = !r.weightsUploaded || r.weightsQueue !== queue;
          for (let i = 0; i < values.length; i++)
            // Finite Float32 values differ in bits exactly when SameValue differs.
            if (!Object.is(values[i], r.uploadedWeights[i])) changed = true;
          if (changed) {
            r.weightsUploaded = false;
            writeInput(queue, writer, r, r.weights, values as Float32Array<ArrayBuffer>);
            r.uploadedWeights.set(values);
            r.weightsQueue = queue;
            r.weightsUploaded = true;
          }
        }
      }
    }
    if (!this.resources.length) return;
    // One pass for every skinned or morphed primitive. Each dispatch writes its own output buffer.
    const pass = context.encoder.beginComputePass();
    try {
      for (const r of this.resources) {
        pass.setPipeline(r.pipeline);
        pass.setBindGroup(0, r.group);
        pass.dispatchWorkgroups(Math.ceil(r.primitive.vertices.length / 20 / 64));
      }
    } finally {
      pass.end();
    }
  }
  private release(): void {
    if (this.model.createDeformationRenderer === this.createDeformationRenderer)
      this.model.createDeformationRenderer = undefined;
    if (this.model.prepareDeformation === this.prepareDeformation) this.model.prepareDeformation = undefined;
    for (const r of this.resources) {
      if (r.primitive.deformed === r.output) r.primitive.deformed = undefined;
      for (const b of r.buffers) b.destroy();
    }
    this.resources = [];
    this.pipeline = undefined;
    this.pipeline8 = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.model.root.engine.removePlugin(this.name);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.release();
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
