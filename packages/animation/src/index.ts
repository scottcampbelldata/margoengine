/// <reference lib="esnext.disposable" preserve="true" />
import type { PBRModel, PBRPrimitive } from '@margoengine/gltf-pro';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { sampleTrackInto, type Interpolation } from './sampling.js';
import { deformationShader } from './shader.js';
import { ordinaryWeightBuffer } from './weight-buffer.js';
export { sampleTrack, sampleTrackInto, multiplyMatrices, type Interpolation } from './sampling.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; COPY_DST: number; COPY_SRC: number; UNIFORM: number };
interface Track {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  times: Float32Array;
  values: Float32Array;
  width: number;
  interpolation: Interpolation;
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
  private resources: Deformation[] = [];
  private readonly inverse = new Float32Array(16);
  private readonly joint = new Float32Array(16);
  private readonly product = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly samples: Float32Array[][];
  private readonly quaternion: number[] = [0, 0, 0, 1];
  private disposed = false;
  private unsubscribe?: () => void;
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
    const doc = model.asset.doc,
      index = (n: any, length: number, label: string) => {
        if (!Number.isInteger(n) || n < 0 || n >= length) throw new TypeError('Invalid animation ' + label);
        return n;
      };
    this.clips = (doc.animations ?? []).map((def: any, id: number) => {
      if (!Array.isArray(def.channels) || !Array.isArray(def.samplers)) throw new TypeError('Invalid glTF animation');
      const destinations = new Set<string>();
      const tracks: Track[] = def.channels.map((channel: any) => {
        const node = index(channel.target?.node, model.nodes.length, 'node'),
          path = channel.target?.path;
        if (!['translation', 'rotation', 'scale', 'weights'].includes(path) || doc.nodes[node].matrix)
          throw new TypeError('Invalid animation target');
        const key = node + ':' + path;
        if (destinations.has(key)) throw new Error('Duplicate animation target');
        destinations.add(key);
        const sampler = def.samplers[index(channel.sampler, def.samplers.length, 'sampler')],
          times = model.asset.accessor(sampler.input, 'SCALAR'),
          interpolation = sampler.interpolation ?? 'LINEAR';
        if (
          !['STEP', 'LINEAR', 'CUBICSPLINE'].includes(interpolation) ||
          times.some((v, i) => v < 0 || (i > 0 && v <= times[i - 1]))
        )
          throw new RangeError('Invalid animation time/interpolation');
        if (
          doc.accessors[sampler.input].componentType !== 5126 ||
          doc.accessors[sampler.output]?.componentType !== 5126
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
        return { node, path, times, values, width, interpolation };
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
  setup(engine: Engine): void {
    if (engine !== this.model.root.engine || this.model.disposed || this.disposed)
      throw new Error('Animation model is disposed or belongs to another engine');
    if (!engine.gpu) throw new Error('Animation requires WebGPU');
    this.device = engine.gpu;
    this.unsubscribe?.();
    this.unsubscribe = this.model.onDispose(() => this.destroy());
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code: deformationShader }), entryPoint: 'main' },
    });
    const doc = this.model.asset.doc;
    for (const p of this.model.primitives) {
      const targets = p.definition.targets ?? [],
        skinId = doc.nodes[p.nodeIndex].skin,
        skin = skinId === undefined ? null : doc.skins?.[skinId];
      if (skinId !== undefined && (!Number.isInteger(skinId) || skinId < 0 || !skin))
        throw new TypeError('Missing glTF skin');
      if (!targets.length && !skin) continue;
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
      targets.forEach((target: any, t: number) => {
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
      const influenceBytes = new ArrayBuffer(Math.max(32, count * 32)),
        jointIds = new Uint32Array(influenceBytes),
        influenceFloats = new Float32Array(influenceBytes);
      if (skin) {
        if (
          !Array.isArray(skin.joints) ||
          !skin.joints.length ||
          new Set(skin.joints).size !== skin.joints.length ||
          skin.joints.some((i: any) => !Number.isInteger(i) || i < 0 || i >= this.model.nodes.length)
        )
          throw new TypeError('Invalid skin joints');
        joints = skin.joints;
        inverseBind =
          skin.inverseBindMatrices === undefined
            ? Float32Array.from(joints.flatMap(() => Array.from(identity)))
            : this.model.asset.accessor(skin.inverseBindMatrices, 'MAT4');
        if (skin.inverseBindMatrices !== undefined && doc.accessors[skin.inverseBindMatrices].componentType !== 5126)
          throw new TypeError('Inverse bind matrices must be Float32');
        if (inverseBind.length !== joints.length * 16) throw new RangeError('Inverse bind matrix count mismatch');
        const attributes = p.definition.attributes;
        if (attributes.JOINTS_1 !== undefined || attributes.WEIGHTS_1 !== undefined)
          throw new Error('More than four joint influences require an extension');
        const ids = this.model.asset.accessor(attributes.JOINTS_0, 'VEC4'),
          weights = this.model.asset.accessor(attributes.WEIGHTS_0, 'VEC4');
        if (
          ids.length !== count * 4 ||
          weights.length !== count * 4 ||
          ![5121, 5123].includes(doc.accessors[attributes.JOINTS_0].componentType) ||
          doc.accessors[attributes.JOINTS_0].normalized
        )
          throw new TypeError('Invalid skin attributes');
        const weightAccessor = doc.accessors[attributes.WEIGHTS_0];
        if (
          ![5126, 5121, 5123].includes(weightAccessor.componentType) ||
          (weightAccessor.componentType !== 5126 && !weightAccessor.normalized)
        )
          throw new TypeError('Invalid skin weight component type');
        for (let i = 0; i < count; i++) {
          const sum = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
          if (sum <= 0) throw new RangeError('Skin weights must have a positive sum');
          for (let c = 0; c < 4; c++) {
            const at = i * 4 + c;
            if (!Number.isInteger(ids[at]) || ids[at] >= joints.length || weights[at] < 0)
              throw new RangeError('Invalid skin joint/weight');
            jointIds[i * 8 + c] = ids[at];
            influenceFloats[i * 8 + 4 + c] = weights[at] / sum;
          }
        }
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
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [source, output, morph, weights, bones, influences, counts].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
      p.deformed = output;
    }
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
  private deform(context: PassContext): void {
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
      const pass = context.encoder.beginComputePass();
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, r.group);
      pass.dispatchWorkgroups(Math.ceil(r.primitive.vertices.length / 20 / 64));
      pass.end();
    }
  }
  private release(): void {
    for (const r of this.resources) {
      if (r.primitive.deformed === r.output) r.primitive.deformed = undefined;
      for (const b of r.buffers) b.destroy();
    }
    this.resources = [];
    this.pipeline = undefined;
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
