/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import {Geometry, PbrMaterial} from '@margoengine/core';
import type {Engine, EnginePlugin, FrameGraph, PassContext} from '@margoengine/core/extension';
import {computeShader, depthShader} from './shaders.js';

declare const GPUBufferUsage: {MAP_READ: number; COPY_SRC: number; COPY_DST: number; INDEX: number; VERTEX: number; UNIFORM: number; STORAGE: number; INDIRECT: number};
declare const GPUTextureUsage: {RENDER_ATTACHMENT: number; TEXTURE_BINDING: number};
declare const GPUMapMode: {READ: number};
type Context = Extract<PassContext, {backend: 'webgpu'}>;

/** `frustum` (default): bounding spheres against the view frustum. `occlusion`: frustum + Hi-Z occlusion (dense or enclosed assemblies). `none`: draw everything. */
export type CullingMode = 'none' | 'frustum' | 'occlusion';
export interface CulledBatch {
  geometry: Geometry;
  material: PbrMaterial;
  /** Column-major affine world matrices, 16 floats per instance. */
  transforms: Float32Array;
}
export interface CulledInstancesOptions {
  culling?: CullingMode;
  /** Parts whose bounding sphere spans at least this many pixels in radius become occluders for the next frame (default 8). */
  occluderSize?: number;
}

const modes: readonly CullingMode[] = ['none', 'frustum', 'occlusion'];
// Occlusion is exact only when core's shader still computes clip positions unchanged and discards nothing beyond
// its single-sided rule; section planes and similar fragment clipping fall back to frustum culling.
const exactShader = (shader: string): boolean => shader.includes('let p=model*vec4f(i.position,1);\nvar o:Output;o.clip=frame.camera*p;') && shader.split('discard').length === 2;
const vertexLayout: GPUVertexBufferLayout = {arrayStride: 24, attributes: [{shaderLocation: 0, offset: 0, format: 'float32x3'}]};
let serial = 0;

/**
 * Static parts drawn without per-part CPU work: instances are uploaded once, and every frame a compute pass tests each
 * part against the frustum and a Hi-Z pyramid, compacts the visible ones in their original order and writes indirect
 * draw arguments. Parts are not core meshes (no core picking, hierarchy or sections caps).
 */
export class CulledInstances implements EnginePlugin {
  readonly name = 'culling:' + ++serial;
  /** Total instances, and the first instance of each batch in that flat order. */
  readonly count: number;
  readonly starts: readonly number[];
  culling: CullingMode;
  /** See {@link CulledInstancesOptions.occluderSize}. */
  occluderSize: number;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private readonly batches: readonly CulledBatch[];
  private readonly records: Float32Array;
  private readonly spheres: Float32Array;
  private readonly batchOf: Uint32Array;
  private readonly table: Uint32Array;
  private readonly args: Uint32Array;
  private readonly earlyReset: Uint32Array;
  private readonly hidden: Uint8Array;
  private readonly uniform = new ArrayBuffer(448);
  private readonly floats = new Float32Array(this.uniform);
  private readonly words = new Uint32Array(this.uniform);
  private readonly frame = new Float32Array(28);
  private buffers: Record<string, GPUBuffer> = {};
  private geometryBuffers = new Map<Geometry, {vertex: GPUBuffer; index: GPUBuffer}>();
  private compute?: {early: GPUComputePipeline; depth0: GPUComputePipeline; reduce: GPUComputePipeline; cull: GPUComputePipeline; scan: GPUComputePipeline; scatter: GPUComputePipeline};
  private prepass?: {plain: GPURenderPipeline; sided: GPURenderPipeline};
  private groups: Record<string, GPUBindGroup> = {};
  private levelGroups: GPUBindGroup[] = [];
  private depth?: GPUTexture;
  private hiz?: GPUBuffer;
  private samples = 0;
  private width = 0;
  private height = 0;
  private levels = 0;
  private pipeline?: GPURenderPipeline;
  private pipelineKey = '';
  private group?: GPUBindGroup;
  private bindings: GPUBindGroupEntry[] = [];
  private readonly color: GPURenderPassColorAttachment = {view: undefined!, loadOp: 'load', storeOp: 'store'};
  private readonly target: GPURenderPassDepthStencilAttachment = {view: undefined!, depthLoadOp: 'load', depthStoreOp: 'store'};
  private readonly main: GPURenderPassDescriptor = {colorAttachments: [this.color], depthStencilAttachment: this.target};
  private readonly occluders: GPURenderPassDepthStencilAttachment = {view: undefined!, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store'};
  private readonly early: GPURenderPassDescriptor = {colorAttachments: [], depthStencilAttachment: this.occluders};

  /** Same as `engine.use(new CulledInstances(...))`; returns the CulledInstances. */
  static attach(engine: EngineKernel, batches: readonly CulledBatch[], options?: CulledInstancesOptions): CulledInstances {const value = new CulledInstances(batches, options); engine.use(value); return value;}
  constructor(batches: readonly CulledBatch[], {culling = 'frustum', occluderSize = 8}: CulledInstancesOptions = {}) {
    if (!Array.isArray(batches) || !batches.length) throw new TypeError('Expected culled batches');
    if (!modes.includes(culling)) throw new TypeError('Invalid culling mode');
    this.culling = culling;this.occluderSize = occluderSize;
    const starts: number[] = [];let count = 0;
    for (const b of batches) {
      if (!(b?.geometry instanceof Geometry) || !(b.material instanceof PbrMaterial) || !(b.transforms instanceof Float32Array) || !b.transforms.length || b.transforms.length % 16) throw new TypeError('Invalid culled batch');
      starts.push(count);count += b.transforms.length / 16;
    }
    if (count > 1_000_000) throw new RangeError('Culled instances: at most 1,000,000');
    this.batches = batches.map(b => ({...b}));this.count = count;this.starts = starts;
    this.records = new Float32Array(count * 24);this.spheres = new Float32Array(count * 4);this.batchOf = new Uint32Array(count);this.hidden = new Uint8Array(count);
    this.table = new Uint32Array(batches.length * 4);this.args = new Uint32Array(batches.length * 5);this.earlyReset = new Uint32Array(batches.length * 5);
    batches.forEach((b, batch) => {
      const start = starts[batch], end = start + b.transforms.length / 16;
      this.table.set([start, end, b.geometry.indices.length, 0], batch * 4);this.args[batch * 5] = this.earlyReset[batch * 5] = b.geometry.indices.length;
      for (let i = start; i < end; i++) {
        this.batchOf[i] = batch;this.records.set(b.material.data, i * 24 + 16);this.records[i * 24 + 23] = -1; // no core mesh ID
        this.write(i, b.transforms.subarray((i - start) * 16, (i - start + 1) * 16));
      }
    });
  }

  /** Replaces one part's world matrix (column-major affine). */
  setTransform(batch: number, index: number, matrix: ArrayLike<number>): void {
    const i = this.index(batch, index);this.write(i, matrix);
    const d = this.device;if (d) {d.queue.writeBuffer(this.buffers.records, i * 96, this.records.subarray(i * 24, i * 24 + 16));d.queue.writeBuffer(this.buffers.spheres, i * 16, this.spheres.subarray(i * 4, i * 4 + 4));}
  }
  setVisible(batch: number, index: number, visible: boolean): void {
    const i = this.index(batch, index);if (typeof visible !== 'boolean') throw new TypeError('Invalid visibility');
    this.hidden[i] = +!visible;this.sphere(i);this.device?.queue.writeBuffer(this.buffers.spheres, i * 16, this.spheres.subarray(i * 4, i * 4 + 4));
  }
  /** Reads back how many parts of each batch were drawn in the latest submitted frame (for tests and benchmarks). */
  async readCounts(): Promise<number[]> {
    const d = this.device;if (!d) throw new Error('CulledInstances is not attached');
    const size = this.args.byteLength, read = d.createBuffer({size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    try {
      const encoder = d.createCommandEncoder();encoder.copyBufferToBuffer(this.buffers.args, 0, read, 0, size);d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);const values = new Uint32Array(read.getMappedRange().slice(0));read.unmap();
      return this.starts.map((_, b) => values[b * 5 + 1]);
    } finally {read.destroy();}
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('CulledInstances requires WebGPU');
    this.engine = engine;const d = this.device = engine.gpu;
    const n = this.count, B = this.batches.length, buffer = (name: string, size: number, usage: number, data?: ArrayBufferView): GPUBuffer => {
      if (size > d.limits.maxStorageBufferBindingSize) throw new RangeError('Culled instances exceed GPU buffer limits');
      const b = this.buffers[name] = d.createBuffer({size: Math.max(16, Math.ceil(size / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST});
      if (data) d.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);return b;
    };
    const S = GPUBufferUsage.STORAGE;
    try {
      buffer('uniform', 448, GPUBufferUsage.UNIFORM);buffer('frame', 112, GPUBufferUsage.UNIFORM);
      buffer('levels', 16 * 256, GPUBufferUsage.UNIFORM, new Uint32Array(16 * 64).map((_, i) => i % 64 ? 0 : i / 64));
      buffer('records', n * 96, S, this.records);buffer('drawn', n * 96, S | GPUBufferUsage.VERTEX);buffer('spheres', n * 16, S, this.spheres);
      buffer('visible', n * 4, S);buffer('local', n * 4, S);buffer('groups', Math.ceil(n / 256) * 4, S);buffer('batchOf', n * 4, S, this.batchOf);
      buffer('batches', B * 16, S, this.table);buffer('args', B * 20, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC, this.args);
      buffer('earlyArgs', B * 20, S | GPUBufferUsage.INDIRECT);buffer('earlyList', n * 4, S | GPUBufferUsage.VERTEX);
      for (const {geometry: g} of this.batches) if (!this.geometryBuffers.has(g)) {
        const vertex = d.createBuffer({size: g.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
        const index = d.createBuffer({size: g.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST});
        this.geometryBuffers.set(g, {vertex, index});d.queue.writeBuffer(vertex, 0, g.vertices as Float32Array<ArrayBuffer>);d.queue.writeBuffer(index, 0, g.indices as Uint32Array<ArrayBuffer>);
      }
    } catch (error) {this.release();throw error;}
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({name: this.name, order: 1, execute: c => {if (c.backend === 'webgpu') this.draw(c);}});
  }

  private index(batch: number, index: number): number {
    const start = this.starts[batch], end = batch + 1 < this.starts.length ? this.starts[batch + 1] : this.count;
    if (!Number.isInteger(batch) || start === undefined || !Number.isInteger(index) || index < 0 || start + index >= end) throw new RangeError('Invalid culled instance');
    return start + index;
  }
  private write(i: number, m: ArrayLike<number>): void {
    if (m?.length !== 16) throw new TypeError('Expected 16 matrix values');
    for (let k = 0; k < 16; k++) if (typeof m[k] !== 'number' || !Number.isFinite(Math.fround(m[k]))) throw new RangeError('Invalid instance transform');
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (m[3] || m[7] || m[11] || m[15] !== 1 || !Number.isFinite(det) || !det) throw new RangeError('Expected nonsingular affine instance transforms');
    this.records.set(m, i * 24);this.sphere(i);
  }
  // World bounding sphere from the geometry's local sphere, padded for float32 vertex transform error.
  private sphere(i: number): void {
    const m = this.records, o = i * 24, b = this.batches[this.batchOf[i]].geometry.bounds, s = this.spheres;
    if (this.hidden[i]) {s.fill(0, i * 4, i * 4 + 3);s[i * 4 + 3] = -1;return;}
    const x = m[o] * b[0] + m[o + 4] * b[1] + m[o + 8] * b[2] + m[o + 12], y = m[o + 1] * b[0] + m[o + 5] * b[1] + m[o + 9] * b[2] + m[o + 13], z = m[o + 2] * b[0] + m[o + 6] * b[1] + m[o + 10] * b[2] + m[o + 14];
    const scale = Math.sqrt(Math.max(m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2, m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2, m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2)), r = b[3] * scale;
    s[i * 4] = x;s[i * 4 + 1] = y;s[i * 4 + 2] = z;s[i * 4 + 3] = r + 1e-5 * (Math.hypot(x, y, z) + r);
  }
  private bind(pipeline: GPUComputePipeline | GPURenderPipeline, entries: [number, GPUBindingResource][]): GPUBindGroup {
    return this.device!.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: entries.map(([binding, resource]) => ({binding, resource}))});
  }
  private build(c: Context): void {
    const d = c.device, samples = c.descriptor.multisample?.count ?? 1, b = this.buffers, module = d.createShaderModule({code: computeShader(samples)});
    const entry = (entryPoint: string) => d.createComputePipeline({layout: 'auto', compute: {module, entryPoint}});
    this.compute = {early: entry('early'), depth0: entry('depth0'), reduce: entry('reduce'), cull: entry('cull'), scan: entry('scan'), scatter: entry('scatter')};
    const depthModule = d.createShaderModule({code: depthShader}), prepass = (fragment: boolean) => d.createRenderPipeline({
      layout: 'auto', vertex: {module: depthModule, entryPoint: 'vertex', buffers: [vertexLayout, {arrayStride: 4, stepMode: 'instance', attributes: [{shaderLocation: 2, offset: 0, format: 'uint32'}]}]},
      fragment: fragment ? {module: depthModule, entryPoint: 'fragment', targets: []} : undefined, multisample: {count: samples},
      depthStencil: {format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal'}});
    this.prepass = {plain: prepass(false), sided: prepass(true)};
    const r = (name: string): GPUBindingResource => ({buffer: b[name]}), p = this.compute;
    this.groups.early = this.bind(p.early, [[0, r('uniform')], [1, r('spheres')], [2, r('visible')], [6, r('batchOf')], [7, r('batches')], [9, r('earlyArgs')], [10, r('earlyList')]]);
    this.groups.scan = this.bind(p.scan, [[0, r('uniform')], [4, r('groups')]]);
    this.groups.scatter = this.bind(p.scatter, [[0, r('uniform')], [2, r('visible')], [3, r('local')], [4, r('groups')], [6, r('batchOf')], [7, r('batches')], [8, r('args')], [11, r('records')], [12, r('drawn')]]);
    this.groups.prepass = this.bind(this.prepass.plain, [[0, r('uniform')], [11, r('records')]]);
    this.groups.sided = this.bind(this.prepass.sided, [[0, r('uniform')], [11, r('records')]]);
    this.samples = samples;this.width = this.height = 0;
  }
  // Size-dependent resources: the occluder depth target and the Hi-Z pyramid (level 0 at full resolution).
  private resize(c: Context): void {
    const d = c.device, p = this.compute!, b = this.buffers;
    this.depth?.destroy();this.hiz?.destroy();this.depth = this.hiz = undefined;
    this.depth = d.createTexture({size: [c.width, c.height], format: 'depth32float', sampleCount: this.samples, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
    let w = c.width, h = c.height, offset = 0, level = 0;
    for (;; level++) {this.words.set([offset, w, h, 0], 48 + level * 4);offset += w * h;if (w === 1 && h === 1) break;w = Math.ceil(w / 2);h = Math.ceil(h / 2);}
    this.levels = level + 1;
    this.hiz = d.createBuffer({size: offset * 4, usage: GPUBufferUsage.STORAGE});
    const view = this.depth.createView(), hiz: GPUBindingResource = {buffer: this.hiz};
    this.occluders.view = view;
    this.groups.depth0 = this.bind(p.depth0, [[0, {buffer: b.uniform}], [5, hiz], [14, view]]);
    this.groups.cull = this.bind(p.cull, [[0, {buffer: b.uniform}], [1, {buffer: b.spheres}], [2, {buffer: b.visible}], [3, {buffer: b.local}], [4, {buffer: b.groups}], [5, hiz]]);
    this.levelGroups = Array.from({length: this.levels}, (_, l) => this.bind(p.reduce, [[0, {buffer: b.uniform}], [5, hiz], [13, {buffer: b.levels, offset: l * 256, size: 16}]]));
    this.width = c.width;this.height = c.height;
  }
  private draw(c: Context): void {
    const d = c.device, b = this.buffers;
    if (!this.compute || (c.descriptor.multisample?.count ?? 1) !== this.samples) this.build(c);
    if (c.width !== this.width || c.height !== this.height) this.resize(c);
    const occlusion = this.culling === 'occlusion' && exactShader(c.shader), mode = occlusion ? 2 : this.culling === 'none' ? 0 : 1;
    if (!(this.occluderSize >= 0)) throw new RangeError('Invalid occluder size');
    const m = c.camera.matrix, f = this.floats;f.set(m);f.set(c.camera.planes, 16);this.words.set([c.width, c.height, this.levels, this.count, mode, this.batches.length, depthKind(m)], 40);f[47] = this.occluderSize;
    d.queue.writeBuffer(b.uniform, 0, this.words);
    const lighting = this.engine!.lighting;this.frame.set(c.camera.matrix);this.frame.set(c.camera.position, 16);this.frame.set(lighting.direction, 20);this.frame.set(lighting.radiance, 24);
    d.queue.writeBuffer(b.frame, 0, this.frame as Float32Array<ArrayBuffer>);
    const p = this.compute!, groups = Math.ceil(this.count / 256);
    if (occlusion) {
      d.queue.writeBuffer(b.earlyArgs, 0, this.earlyReset as Uint32Array<ArrayBuffer>);
      const select = c.encoder.beginComputePass();select.setPipeline(p.early);select.setBindGroup(0, this.groups.early);select.dispatchWorkgroups(groups);select.end();
      const pass = c.encoder.beginRenderPass(this.early);
      this.batches.forEach((batch, i) => {
        const sided = batch.material.data[6] < 0.5;pass.setPipeline(sided ? this.prepass!.sided : this.prepass!.plain);pass.setBindGroup(0, sided ? this.groups.sided : this.groups.prepass);
        const g = this.geometryBuffers.get(batch.geometry)!;pass.setVertexBuffer(0, g.vertex);pass.setVertexBuffer(1, b.earlyList, this.starts[i] * 4);pass.setIndexBuffer(g.index, 'uint32');pass.drawIndexedIndirect(b.earlyArgs, i * 20);
      });
      pass.end();
    }
    const pass = c.encoder.beginComputePass();
    if (occlusion) {
      pass.setPipeline(p.depth0);pass.setBindGroup(0, this.groups.depth0);pass.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
      pass.setPipeline(p.reduce);
      for (let l = 1; l < this.levels; l++) {pass.setBindGroup(0, this.levelGroups[l]);pass.dispatchWorkgroups(Math.ceil(this.words[48 + l * 4 + 1] / 8), Math.ceil(this.words[48 + l * 4 + 2] / 8));}
    }
    pass.setPipeline(p.cull);pass.setBindGroup(0, this.groups.cull);pass.dispatchWorkgroups(groups);
    pass.setPipeline(p.scan);pass.setBindGroup(0, this.groups.scan);pass.dispatchWorkgroups(1);
    pass.setPipeline(p.scatter);pass.setBindGroup(0, this.groups.scatter);pass.dispatchWorkgroups(groups);
    pass.end();
    // Main pass: core's own shader and pipeline state (sections, fog and other shader hooks apply), core's targets.
    const key = c.shader + c.format + c.descriptor.multisample?.count + c.descriptor.depthStencil!.format;
    if (key !== this.pipelineKey) {
      const module = d.createShaderModule({code: c.shader});
      this.pipeline = d.createRenderPipeline({...c.descriptor, vertex: {...c.descriptor.vertex, module}, fragment: {...c.descriptor.fragment!, module, targets: [{format: c.format}]}});
      this.pipelineKey = key;this.group = undefined;
    }
    if (!this.group || !sameBindings(this.bindings, c.bindings)) {
      this.group = this.bind(this.pipeline!, [[0, {buffer: b.frame}], ...c.bindings.map(e => [e.binding, e.resource] as [number, GPUBindingResource])]);
      this.bindings = c.bindings.map(({binding, resource}) => ({binding, resource: 'buffer' in resource ? {...resource} : resource}));
    }
    this.color.view = c.color;this.target.view = c.depth;this.target.stencilReadOnly = c.descriptor.depthStencil!.format.includes('stencil') || undefined;
    const main = c.encoder.beginRenderPass(this.main);main.setPipeline(this.pipeline!);main.setBindGroup(0, this.group);
    this.batches.forEach((batch, i) => {
      const g = this.geometryBuffers.get(batch.geometry)!;main.setVertexBuffer(0, g.vertex);main.setVertexBuffer(1, b.drawn, this.starts[i] * 96);main.setIndexBuffer(g.index, 'uint32');main.drawIndexedIndirect(b.args, i * 20);
    });
    main.end();
  }
  private release(): void {
    for (const buffer of Object.values(this.buffers)) buffer.destroy();
    for (const g of this.geometryBuffers.values()) {g.vertex.destroy();g.index.destroy();}
    this.depth?.destroy();this.hiz?.destroy();
    this.buffers = {};this.geometryBuffers.clear();this.groups = {};this.levelGroups = [];this.depth = this.hiz = undefined;
    this.compute = this.prepass = this.pipeline = this.group = undefined;this.pipelineKey = '';this.bindings = [];this.samples = this.width = this.height = 0;this.device = undefined;
  }
  onDeviceRestored(engine: Engine): void {this.release();this.setup(engine);}
  dispose(): void {if (this.disposed) return;this.disposed = true;this.engine?.removePlugin(this.name);this.release();this.engine = undefined;}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}

// Nearest sphere depth is exact when clip z depends on w alone (perspective: row 2 parallel to row 3) or w is constant
// (orthographic); other projections use the bounding box corners only.
function depthKind(m: Float32Array): number {
  const [a, b, c] = [m[2], m[6], m[10]], [x, y, z] = [m[3], m[7], m[11]], row3 = Math.hypot(x, y, z);
  if (!row3) return 2;
  return Math.hypot(b * z - c * y, c * x - a * z, a * y - b * x) <= 1e-6 * Math.hypot(a, b, c) * row3 ? 1 : 0;
}
function sameBindings(previous: readonly GPUBindGroupEntry[], entries: readonly GPUBindGroupEntry[]): boolean {
  return previous.length === entries.length && previous.every((old, i) => {
    const a = old.resource as GPUBufferBinding, b = entries[i].resource as GPUBufferBinding;
    return old.binding === entries[i].binding && (a === b || a.buffer !== undefined && a.buffer === b.buffer && a.offset === b.offset && a.size === b.size);
  });
}
