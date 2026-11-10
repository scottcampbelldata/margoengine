/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Batch, Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { CulledInstances } from './index.js';
import type { CullableModel, CullablePrimitive } from './models.js';
import { localBox } from './software-depth.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const code = `
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
struct Key {depth:f32,index:u32}
struct Params {node:mat4x4f,center:vec4f,forward:vec4f,dims:vec4u,step:vec4u}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> source:array<Record>;
@group(0) @binding(2) var<storage,read> args:array<u32>;
@group(0) @binding(3) var<storage,read_write> keys:array<Key>;
@group(0) @binding(4) var<storage,read_write> output:array<Record>;
fn less(a:Key,b:Key)->bool {
 if(a.index==0xffffffffu){return false;}if(b.index==0xffffffffu){return true;}
 if(a.depth<b.depth){return true;}if(a.depth>b.depth){return false;}return a.index<b.index;
}
@compute @workgroup_size(64) fn seed(@builtin(global_invocation_id) g:vec3u){
 let i=g.x;if(i>=u.dims.y){return;}
 var k=Key(0.0,0xffffffffu);
 if(i<args[u.dims.z]){let p=u.node*source[u.dims.x+args[u.dims.z+3u]+i].m*vec4f(u.center.xyz,1.0);k=Key(dot(u.forward.xyz,p.xyz),i);}
 keys[i]=k;
}
@compute @workgroup_size(64) fn network(@builtin(global_invocation_id) g:vec3u){
 let i=g.x;let j=i^u.step.x;if(i>=u.dims.y||j>=u.dims.y||i>=j){return;}
 let a=keys[i];let b=keys[j];let ascending=(i&u.step.y)==0u;
 if((ascending&&less(b,a))||(!ascending&&less(a,b))){keys[i]=b;keys[j]=a;}
}
@compute @workgroup_size(64) fn gather(@builtin(global_invocation_id) g:vec3u){
 let i=g.x;if(i<args[u.dims.z]){let first=args[u.dims.z+3u];output[first+i]=source[u.dims.x+first+keys[i].index];}
}
`;
/** One compacted list of 96-byte instance records to order. All records must draw opaque surfaces. */
export interface SortRange {
  /** Original records, readable as storage. */
  instances: GPUBuffer;
  /** Indirect arguments, storage and COPY_SRC. Omitted: count and indexCount supply the arguments. */
  args?: GPUBuffer;
  /** Most records in this range including any firstInstance prefix, before culling; may be zero. */
  capacity: number;
  /** First record in instances. Default 0. */
  start?: number;
  /** Byte offset of the five indirect argument words. Default 0. */
  argsOffset?: number;
  /** Used when args is absent. */
  count?: number;
  /** Used when args is absent. */
  indexCount?: number;
  /** Local center for the depth key. Default origin. */
  center?: ArrayLike<number>;
  /** Node transform outside each instance matrix, for model instances. Default identity. */
  node?: ArrayLike<number>;
}
interface Slot {
  capacity: number;
  n: number;
  uniform: GPUBuffer;
  keys: GPUBuffer;
  instances: GPUBuffer;
  args: GPUBuffer;
  ownArgs: GPUBuffer;
  empty: GPUBuffer;
  data: ArrayBuffer;
}
/** Stable GPU bitonic ordering of already kept opaque rows; no readback or CPU per-instance work. */
export class InstanceSorter {
  private device?: GPUDevice;
  private layout?: GPUBindGroupLayout;
  private pipelines?: { seed: GPUComputePipeline; network: GPUComputePipeline; gather: GPUComputePipeline };
  private slots = new Map<object, Map<string, Slot>>();
  private args = new Uint32Array(5);
  disposed = false;
  /** Encode a front-to-back sort for one stable owner and view. Output counts and complete records are unchanged. */
  encode(c: Context, owner: object, range: SortRange): { instances: GPUBuffer; args: GPUBuffer } {
    if (this.disposed) throw new MargoError('disposed', 'Sorter is disposed; create a new InstanceSorter');
    const { capacity, start = 0, argsOffset = 0 } = range;
    if (
      !Number.isInteger(capacity) ||
      capacity < 0 ||
      capacity > 4194304 ||
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(argsOffset) ||
      argsOffset < 0 ||
      argsOffset % 4
    )
      throw new RangeError(
        'Sort range requires a nonnegative capacity up to 4194304, integer start and aligned argument offset; correct the range',
      );
    if ((start + capacity) * 96 > range.instances.size)
      throw new RangeError('Sort range exceeds instance storage; lower capacity or start');
    if (
      !range.args &&
      (!Number.isInteger(range.count) ||
        range.count! < 0 ||
        range.count! > capacity ||
        !Number.isInteger(range.indexCount) ||
        range.indexCount! < 0)
    )
      throw new RangeError('Without argument storage, provide count within capacity and a nonnegative indexCount');
    if (range.args && argsOffset + 20 > range.args.size)
      throw new RangeError('Sort arguments exceed their buffer; correct argsOffset');
    if (
      (range.center && (range.center.length < 3 || ![0, 1, 2].every((k) => Number.isFinite(range.center![k])))) ||
      (range.node && (range.node.length !== 16 || !Array.from(range.node).every(Number.isFinite)))
    )
      throw new TypeError('Sort center and node must be finite; pass three center values and a 16-value affine matrix');
    const d = c.device;
    if (this.device !== d) {
      this.release();
      this.device = d;
    }
    if (!this.pipelines) {
      const buffer = (type: GPUBufferBindingType, hasDynamicOffset = false) => ({
        visibility: 4,
        buffer: { type, hasDynamicOffset },
      });
      this.layout = d.createBindGroupLayout({
        entries: [
          buffer('uniform', true),
          buffer('read-only-storage'),
          buffer('read-only-storage'),
          buffer('storage'),
          buffer('storage'),
        ].map((e, binding) => ({ binding, ...e })),
      });
      const module = d.createShaderModule({ code }),
        layout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        entry = (entryPoint: string) => d.createComputePipeline({ layout, compute: { module, entryPoint } });
      this.pipelines = { seed: entry('seed'), network: entry('network'), gather: entry('gather') };
    }
    let views = this.slots.get(owner);
    if (!views) this.slots.set(owner, (views = new Map()));
    const id = c.view?.id ?? '';
    let slot = views.get(id);
    const n = 2 ** Math.ceil(Math.log2(Math.max(1, capacity))),
      levels = Math.log2(n),
      stages = (levels * (levels + 1)) / 2 + 2;
    if (!slot || slot.capacity < capacity) {
      if (slot) this.drop(slot);
      const make = (size: number, usage: number) => d.createBuffer({ size: Math.max(16, size), usage: usage | 8 });
      slot = {
        capacity,
        n,
        uniform: make(stages * 256, 64),
        keys: make(n * 8, 128),
        instances: make(Math.max(1, capacity) * 96, 128 | 32 | 4),
        args: make(20, 128 | 256 | 4),
        ownArgs: make(20, 128 | 4),
        empty: make(96, 128),
        data: new ArrayBuffer(stages * 256),
      };
      views.set(id, slot);
    }
    // A retained slot may be larger than this frame's list; use its original complete network.
    const size = slot.n,
      steps: [number, number][] = [];
    for (let k = 2; k <= size; k *= 2) for (let j = k / 2; j >= 1; j /= 2) steps.push([j, k]);
    const sourceArgs = range.args ?? slot.ownArgs;
    if (!range.args) {
      this.args[0] = range.indexCount!;
      this.args[1] = range.count!;
      d.queue.writeBuffer(sourceArgs, 0, this.args as Uint32Array<ArrayBuffer>);
    }
    const f = new Float32Array(slot.data),
      u = new Uint32Array(slot.data),
      camera = c.camera;
    const position = camera.position,
      target = camera.target,
      forward = [target[0] - position[0], target[1] - position[1], target[2] - position[2]],
      length = Math.hypot(...forward);
    if (!(length > 0 && Number.isFinite(length)))
      throw new RangeError('Sorting needs a finite camera direction; separate camera position and target');
    const center = range.center ?? [0, 0, 0],
      node = range.node ?? identity,
      total = steps.length + 2;
    for (let i = 0; i < total; i++) {
      const at = i * 64;
      f.set(node, at);
      for (let k = 0; k < 3; k++) {
        f[at + 16 + k] = center[k];
        f[at + 20 + k] = forward[k] / length;
      }
      u.set([start, size, range.args ? argsOffset / 4 + 1 : 1, 0], at + 24);
      u.set(i > 0 && i < total - 1 ? steps[i - 1] : [0, 0], at + 28);
    }
    d.queue.writeBuffer(slot.uniform, 0, slot.data);
    const group = d.createBindGroup({
      layout: this.layout!,
      entries: [
        { binding: 0, resource: { buffer: slot.uniform, size: 128 } },
        ...[capacity ? range.instances : slot.empty, sourceArgs, slot.keys, slot.instances].map((buffer, i) => ({
          binding: i + 1,
          resource: { buffer },
        })),
      ],
    });
    const pass = c.encoder.beginComputePass(),
      dispatch = (pipeline: GPUComputePipeline, stage: number) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group, [stage * 256]);
        pass.dispatchWorkgroups(Math.ceil(size / 64));
      };
    dispatch(this.pipelines.seed, 0);
    for (let i = 0; i < steps.length; i++) dispatch(this.pipelines.network, i + 1);
    dispatch(this.pipelines.gather, total - 1);
    pass.end();
    c.encoder.copyBufferToBuffer(sourceArgs, range.args ? argsOffset : 0, slot.args, 0, 20);
    return { instances: slot.instances, args: slot.args };
  }
  private drop(s: Slot): void {
    for (const b of [s.uniform, s.keys, s.instances, s.args, s.ownArgs, s.empty]) b.destroy();
  }
  private release(): void {
    for (const views of this.slots.values()) for (const s of views.values()) this.drop(s);
    this.slots.clear();
    this.layout = this.pipelines = undefined;
  }
  /** Release one removed owner's resources across every view. The owner can be encoded again later. */
  forget(owner: object): void {
    const views = this.slots.get(owner);
    if (views) for (const s of views.values()) this.drop(s);
    this.slots.delete(owner);
  }
  /** Release all ordering resources. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** Models with optional transparent/transmissive primitive lists, which must keep their draw order. */
export interface SortModel extends CullableModel {
  readonly tintPrimitives?: readonly { primitive?: object }[];
}
/** Settings for front-to-back ordering of core batches and registered model instances. */
export interface FrontToBackOptions {
  models?: readonly SortModel[];
}
let serial = 0;
/** Sort kept opaque instances after culling and before drawing. Picking and caster buffers are untouched. */
export class FrontToBack implements EnginePlugin {
  readonly name = 'front-to-back:' + ++serial;
  enabled = true;
  disposed = false;
  private sorter = new InstanceSorter();
  private engine?: Engine;
  private models = new Set<SortModel>();
  private allocated = new Set<object>();
  private live = new Set<object>();
  private owned: {
    target: Batch | CullablePrimitive;
    previous?: { instances: GPUBuffer; args: GPUBuffer };
    sorted: { instances: GPUBuffer; args: GPUBuffer };
  }[] = [];
  private centers = new WeakMap<Float32Array, Float64Array>();
  constructor({ models = [] }: FrontToBackOptions = {}) {
    for (const model of models) this.add(model);
  }
  /** Attach to an engine; cullers run first, independent of plugin registration order. */
  static attach(engine: EngineKernel, options?: FrontToBackOptions): FrontToBack {
    const p = new FrontToBack(options);
    engine.use(p);
    return p;
  }
  /** Include a model's opaque instanced primitives. Plain primitives keep their existing draw order. */
  add(model: SortModel): this {
    if (!model || !Array.isArray(model.primitives))
      throw new TypeError('Sort model needs primitives; pass a loaded or materials model');
    this.models.add(model);
    return this;
  }
  /** Stop sorting a model from its next frame. */
  remove(model: SortModel): this {
    this.models.delete(model);
    this.restore();
    for (const primitive of model.primitives) {
      this.sorter.forget(primitive);
      this.allocated.delete(primitive);
      this.live.delete(primitive);
    }
    return this;
  }
  onPreUpdate(): void {
    for (const owner of this.allocated)
      if (!this.live.has(owner)) {
        this.sorter.forget(owner);
        this.allocated.delete(owner);
      }
    this.live.clear();
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Front-to-back sorting needs native WebGPU or the full WebGL2 layer; create a new plugin on a supported engine',
      );
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -500000,
      execute: (c) => {
        this.restore();
        if (c.backend === 'webgpu' && this.enabled) this.sort(c);
      },
    });
  }
  private set(c: Context, target: Batch | CullablePrimitive, range: SortRange): void {
    this.allocated.add(target);
    this.live.add(target);
    const previous = target.redirect,
      sorted = this.sorter.encode(c, target, range);
    target.redirect = sorted;
    this.owned.push({ target, previous, sorted });
  }
  private sort(c: Context): void {
    for (const b of c.batches ?? []) {
      if (b.claimed || (!b.count && !b.redirect)) continue;
      const source = b.redirect?.instances ?? this.engine!.geometryBuffers(b.geometry)!.instance;
      this.set(c, b, {
        instances: source,
        args: b.redirect?.args,
        capacity: b.redirect ? Math.floor(source.size / 96) : b.count,
        count: b.count,
        indexCount: b.geometry.indices.length,
        center: b.geometry.bounds,
      });
    }
    for (const model of this.models) {
      if (model.disposed) continue;
      const transparent = new Set(model.tintPrimitives?.map((p) => p.primitive));
      for (const p of model.primitives) {
        const material = (p as CullablePrimitive & { material?: { alphaMode?: string } }).material;
        if (!p.instances?.count || p.deformed || transparent.has(p) || material?.alphaMode === 'BLEND') continue;
        const source = p.redirect?.instances ?? p.instances.upload(c.device);
        let center = this.centers.get(p.vertices);
        if (!center) {
          const b = localBox({ vertices: p.vertices, indices: p.indices }, 20);
          center = Float64Array.from([0, 1, 2].map((k) => (b[k] + b[k + 3]) / 2));
          this.centers.set(p.vertices, center);
        }
        this.set(c, p, {
          instances: source,
          args: p.redirect?.args,
          capacity: p.instances.capacity,
          count: p.instances.count,
          indexCount: p.indices.length,
          center,
          node: p.node.matrix,
        });
      }
    }
  }
  private restore(): void {
    for (const o of this.owned) if (o.target.redirect === o.sorted) o.target.redirect = o.previous;
    this.owned.length = 0;
  }
  onDeviceRestored(engine: Engine): void {
    this.restore();
    this.sorter.dispose();
    this.sorter = new InstanceSorter();
    this.allocated.clear();
    this.live.clear();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.restore();
    this.sorter.dispose();
    this.models.clear();
    this.allocated.clear();
    this.live.clear();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** Static culled part lists with optional stable front-to-back ordering of each kept batch. */
export class SortedInstances extends CulledInstances {
  sortEnabled = true;
  private sorter = new InstanceSorter();
  /** Attach static parts with sorting enabled. */
  static override attach(...[engine, batches, options]: Parameters<typeof CulledInstances.attach>): SortedInstances {
    const value = new SortedInstances(batches, options);
    engine.use(value);
    return value;
  }
  protected override refine(c: Context): void {
    if (!this.sortEnabled) return;
    for (let i = 0; i < this.batches.length; i++) {
      const start = this.starts[i],
        capacity = (i + 1 < this.starts.length ? this.starts[i + 1] : this.slots) - start;
      if (!capacity) continue;
      const sorted = this.sorter.encode(c, this.batches[i], {
        instances: this.buffers.drawn,
        args: this.buffers.args,
        argsOffset: i * 20,
        start,
        capacity,
        center: this.batches[i].geometry.bounds,
      });
      c.encoder.copyBufferToBuffer(sorted.instances, 0, this.buffers.drawn, start * 96, capacity * 96);
    }
  }
  protected override release(): void {
    this.sorter.dispose();
    this.sorter = new InstanceSorter();
    super.release();
  }
}
