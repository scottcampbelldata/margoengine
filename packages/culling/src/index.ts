/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { Geometry, PbrMaterial } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { computeShader } from './shaders.js';
import { Pyramid, depthKind, exactShader, levelTable, occluderPipeline } from './pyramid.js';
import { OccluderList, type OccluderMesh, type OccluderSource } from './occluders.js';
import { viewSize } from '../../shared/view-rect.js';
import { loadCompatRoute } from '../../shared/compat.js';
export { CulledMeshes } from './meshes.js';
export type { CulledMeshesOptions } from './meshes.js';
export type { OccluderContext, OccluderMesh, OccluderPrimitive, OccluderSource } from './occluders.js';

declare const GPUBufferUsage: {
  MAP_READ: number;
  COPY_SRC: number;
  COPY_DST: number;
  INDEX: number;
  VERTEX: number;
  UNIFORM: number;
  STORAGE: number;
  INDIRECT: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `frustum` (default): bounding spheres against the view frustum. `occlusion`: frustum + Hi-Z occlusion (dense or enclosed assemblies). `none`: draw everything. */
export type CullingMode = 'none' | 'frustum' | 'occlusion';
/** `sphere` (default): bounding spheres only. `box`: each part's oriented box too, tighter for long or thin parts. */
export type CullingBounds = 'sphere' | 'box';
/** One (geometry, material) group of static parts; uploaded once at attach. */
export interface CulledBatch {
  /** Shared by every part of the batch. */
  geometry: Geometry;
  /** Shared by every part of the batch. */
  material: PbrMaterial;
  /** Column-major affine world matrices, 16 floats per instance. */
  transforms: Float32Array;
}
/** `CulledInstances` settings. */
export interface CulledInstancesOptions {
  /** Culling test; also settable later as `parts.culling`. Default `'frustum'`. */
  culling?: CullingMode;
  /** Parts whose bounding sphere spans at least this many pixels in radius become occluders for the next frame (default 8). */
  occluderSize?: number;
  /**
   * What the frustum and occlusion tests use. `'box'` tests each part's oriented box after its sphere, so a long or thin
   * part just behind a surface or just outside the view is dropped; it costs more maths per part. Fixed. Default
   * `'sphere'`.
   */
  bounds?: CullingBounds;
}

const modes: readonly CullingMode[] = ['none', 'frustum', 'occlusion'];
let serial = 0;

/**
 * Static parts drawn without per-part CPU work: instances are uploaded once, and every frame a compute pass tests each
 * part against the frustum and a Hi-Z pyramid, compacts the visible ones in their original order and writes indirect
 * draw arguments. Parts are not core meshes (no core picking, hierarchy or sections caps); `CulledParts` from
 * `@margoengine/culling/parts` adds its own picking, hierarchy, shadows and streaming.
 */
export class CulledInstances implements EnginePlugin {
  readonly name = 'culling:' + ++serial;
  /** First slot of each batch in the flat order of all slots; a batch holds `capacity` slots. */
  readonly starts: readonly number[];
  culling: CullingMode;
  /** See {@link CulledInstancesOptions.occluderSize}. */
  occluderSize: number;
  disposed = false;
  protected engine?: Engine;
  protected device?: GPUDevice;
  protected readonly batches: readonly CulledBatch[];
  /** Slots in all batches, free ones included; the buffers and kernels cover this many. */
  protected readonly slots: number;
  protected readonly records: Float32Array;
  // Per batch: the geometry's local bounding sphere (the cull pass places it under each part's matrix).
  private readonly bounds: Float32Array;
  // What the kernels read, three vec4f per batch: that sphere, then the geometry's box as centre and half size.
  private readonly shapes: Float32Array;
  private readonly boxes: boolean;
  protected readonly batchOf: Uint32Array;
  protected readonly table: Uint32Array;
  private readonly args: Uint32Array;
  private readonly earlyReset: Uint32Array;
  protected readonly hidden: Uint32Array;
  // 1 for a part whose transform mirrors it (negative determinant); per batch, how many such parts it has.
  protected readonly flipped: Uint8Array;
  protected readonly flips: Uint32Array;
  // Parts changed since the last upload, [low, high): one write per buffer before the next frame's culling.
  private low = Infinity;
  private high = 0;
  private hiddenLow = Infinity;
  private hiddenHigh = 0;
  private readonly uniform = new ArrayBuffer(448);
  private readonly floats = new Float32Array(this.uniform);
  private readonly words = new Uint32Array(this.uniform);
  private readonly frame = new Float32Array(32);
  // The WebGL2 layer's route (./compat.js): frustum tests and compaction on the CPU, kept records uploaded.
  private route?: ReturnType<typeof import('./compat.js').instancesRoute>;
  protected buffers: Record<string, GPUBuffer> = {};
  protected geometryBuffers = new Map<Geometry, { vertex: GPUBuffer; index: GPUBuffer }>();
  private compute?: {
    early: GPUComputePipeline;
    depth0: GPUComputePipeline;
    reduce: GPUComputePipeline;
    cull: GPUComputePipeline;
    scan: GPUComputePipeline;
    scatter: GPUComputePipeline;
  };
  private prepass?: { plain: GPURenderPipeline; sided: GPURenderPipeline };
  private groups: Record<string, GPUBindGroup> = {};
  private hiz?: Pyramid;
  private samples = 0;
  private outside?: OccluderList;
  // The main pass draws with core's pipeline state; single-sided batches without mirrored parts use its back-culled
  // variant (cullMode back, override C=1 compiles out the back-face discard), as core does for its own batches.
  private pipeline?: GPURenderPipeline;
  private culledPipeline?: GPURenderPipeline;
  private pipelineKey = '';
  private group?: GPUBindGroup;
  private culledGroup?: GPUBindGroup;
  private bindings: GPUBindGroupEntry[] = [];
  private readonly color: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly target: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  private readonly main: GPURenderPassDescriptor = {
    colorAttachments: [this.color],
    depthStencilAttachment: this.target,
  };

  /** Same as `engine.use(new CulledInstances(...))`; returns the CulledInstances. */
  static attach(
    engine: EngineKernel,
    batches: readonly CulledBatch[],
    options?: CulledInstancesOptions,
  ): CulledInstances {
    const value = new CulledInstances(batches, options);
    engine.use(value);
    return value;
  }
  constructor(
    batches: readonly CulledBatch[],
    { culling = 'frustum', occluderSize = 8, bounds = 'sphere' }: CulledInstancesOptions = {},
  ) {
    if (!Array.isArray(batches) || !batches.length) throw new TypeError('Expected culled batches');
    if (!modes.includes(culling)) throw new TypeError('Invalid culling mode; use "none", "frustum" or "occlusion"');
    if (bounds !== 'sphere' && bounds !== 'box') throw new TypeError('Invalid culling bounds; use "sphere" or "box"');
    this.boxes = bounds === 'box';
    this.culling = culling;
    this.occluderSize = occluderSize;
    const starts: number[] = [];
    let count = 0;
    for (const b of batches) {
      if (
        !(b?.geometry instanceof Geometry) ||
        !(b.material instanceof PbrMaterial) ||
        !(b.transforms instanceof Float32Array) ||
        !b.transforms.length ||
        b.transforms.length % 16
      )
        throw new TypeError(
          'Invalid culled batch; give each batch a geometry, a PbrMaterial and a non-empty Float32Array of 16-float matrices',
        );
      starts.push(count);
      count += b.transforms.length / 16;
    }
    if (count > 1_000_000) throw new RangeError('Culled instances: at most 1,000,000');
    this.batches = batches.map((b) => ({ ...b }));
    this.slots = count;
    this.starts = starts;
    this.records = new Float32Array(count * 24);
    this.bounds = new Float32Array(batches.length * 4);
    this.shapes = new Float32Array(batches.length * (this.boxes ? 12 : 4));
    this.batchOf = new Uint32Array(count);
    this.hidden = new Uint32Array(count);
    this.flipped = new Uint8Array(count);
    this.flips = new Uint32Array(batches.length);
    this.table = new Uint32Array(batches.length * 4);
    this.args = new Uint32Array(batches.length * 5);
    this.earlyReset = new Uint32Array(batches.length * 5);
    batches.forEach((b, batch) => {
      const start = starts[batch],
        end = start + b.transforms.length / 16;
      this.table.set([start, end, b.geometry.indices.length, 0], batch * 4);
      this.bounds.set(b.geometry.bounds, batch * 4);
      this.shapes.set(b.geometry.bounds, batch * 4);
      if (this.boxes) localBox(b.geometry.vertices, this.shapes, (batches.length + batch * 2) * 4);
      this.args[batch * 5] = this.earlyReset[batch * 5] = b.geometry.indices.length;
      for (let i = start; i < end; i++) {
        this.batchOf[i] = batch;
        this.records.set(b.material.data, i * 24 + 16);
        this.records[i * 24 + 23] = -1; // no core mesh ID
        this.write(i, b.transforms.subarray((i - start) * 16, (i - start + 1) * 16));
      }
    });
  }
  /** Parts in all batches. */
  get count(): number {
    return this.slots;
  }

  /**
   * Replaces one part's world matrix (column-major affine). Changes reach the GPU together before the next frame: one
   * write per buffer covering every part changed since the last frame, so moving many parts costs no per-part GPU call.
   */
  setTransform(batch: number, index: number, matrix: ArrayLike<number>): void {
    const i = this.index(batch, index);
    this.write(i, matrix);
    this.dirty(i);
  }
  /** Hides or shows one part (uploaded with the next frame, like {@link setTransform}). */
  setVisible(batch: number, index: number, visible: boolean): void {
    const i = this.index(batch, index);
    if (typeof visible !== 'boolean') throw new TypeError('Invalid visibility; pass true or false');
    this.show(i, +!visible);
  }
  /**
   * Lets geometry that is not a part hide parts in `'occlusion'` mode, so a building hides what is behind it: a core mesh,
   * a gltf-pro model, a materials mesh or a `Terrain`. It is drawn depth-only each frame, every primitive of it, so add
   * the large things. Cut-out, blended, displaced and clipped primitives do not occlude, and neither do back faces.
   * @throws TypeError for anything else.
   */
  addOccluder(source: OccluderMesh | OccluderSource): this {
    (this.outside ??= new OccluderList()).add(source);
    return this;
  }
  /** Stops `source` occluding from the next frame. */
  removeOccluder(source: OccluderMesh | OccluderSource): this {
    this.outside?.remove(source);
    return this;
  }
  /** Reads back how many parts of each batch were drawn in the latest submitted frame (for tests and benchmarks). */
  async readCounts(): Promise<number[]> {
    const d = this.device;
    if (!d) throw new MargoError('state', 'CulledInstances is not attached; attach it to an engine first');
    const size = this.args.byteLength,
      read = d.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(this.buffers.args, 0, read, 0, size);
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      return this.starts.map((_, b) => values[b * 5 + 1]);
    } finally {
      read.destroy();
    }
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'CulledInstances requires WebGPU; attach a new CulledInstances to a WebGPU engine',
      );
    this.engine = engine;
    const d = (this.device = engine.gpu);
    const n = this.slots,
      B = this.batches.length,
      buffer = (name: string, size: number, usage: number, data?: ArrayBufferView): GPUBuffer => {
        if (size > d.limits.maxStorageBufferBindingSize)
          throw new RangeError(
            'Culled instances exceed GPU buffer limits; split the instances across fewer or smaller batches',
          );
        const b = (this.buffers[name] = d.createBuffer({
          size: Math.max(16, Math.ceil(size / 4) * 4),
          usage: usage | GPUBufferUsage.COPY_DST,
        }));
        if (data) d.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
        return b;
      };
    const S = GPUBufferUsage.STORAGE;
    try {
      buffer('uniform', 448, GPUBufferUsage.UNIFORM);
      buffer('frame', 128, GPUBufferUsage.UNIFORM);
      buffer('levels', 16 * 256, GPUBufferUsage.UNIFORM, levelTable());
      buffer('records', n * 96, S | GPUBufferUsage.VERTEX, this.records);
      buffer('drawn', n * 96, S | GPUBufferUsage.VERTEX);
      buffer('hidden', n * 4, S | GPUBufferUsage.VERTEX, this.hidden);
      buffer('bounds', this.shapes.byteLength, S, this.shapes);
      buffer('visible', n * 4, S);
      buffer('local', n * 4, S);
      buffer('groups', Math.ceil(n / 256) * 4, S);
      buffer('batchOf', n * 4, S, this.batchOf);
      buffer('batches', B * 16, S, this.table);
      buffer('args', B * 20, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC, this.args);
      buffer('earlyArgs', B * 20, S | GPUBufferUsage.INDIRECT);
      buffer('earlyList', n * 4, S | GPUBufferUsage.VERTEX);
      for (const { geometry: g } of this.batches)
        if (!this.geometryBuffers.has(g)) {
          const vertex = d.createBuffer({
            size: g.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          });
          const index = d.createBuffer({
            size: g.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          });
          this.geometryBuffers.set(g, { vertex, index });
          d.queue.writeBuffer(vertex, 0, g.vertices as Float32Array<ArrayBuffer>);
          d.queue.writeBuffer(index, 0, g.indices as Uint32Array<ArrayBuffer>);
        }
    } catch (error) {
      this.release();
      throw error;
    }
    this.low = this.hiddenLow = Infinity;
    this.high = this.hiddenHigh = 0;
    const records = this.buffers.records;
    loadCompatRoute(d, () => import('./compat.js'))?.then(({ instancesRoute }) => {
      if (this.buffers.records === records)
        this.route = instancesRoute(
          {
            records: this.records,
            hidden: this.hidden,
            bounds: this.bounds,
            batchOf: this.batchOf,
            starts: this.starts,
            count: n,
          },
          this.args,
          B,
        );
    });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1,
      joins: true,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  protected show(i: number, word: number): void {
    this.hidden[i] = word;
    if (i < this.hiddenLow) this.hiddenLow = i;
    if (i >= this.hiddenHigh) this.hiddenHigh = i + 1;
  }
  protected index(batch: number, index: number): number {
    const start = this.starts[batch],
      end = batch + 1 < this.starts.length ? this.starts[batch + 1] : this.slots;
    if (
      !Number.isInteger(batch) ||
      start === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      start + index >= end
    )
      throw new RangeError('Invalid culled instance; pass a batch index and an instance index inside that batch');
    return start + index;
  }
  protected dirty(i: number): void {
    if (i < this.low) this.low = i;
    if (i >= this.high) this.high = i + 1;
  }
  // The changed parts' records, and the changed visibility flags, one contiguous range each.
  protected flush(d: GPUDevice): void {
    if (this.high > this.low) {
      const { low, high } = this;
      d.queue.writeBuffer(
        this.buffers.records,
        low * 96,
        this.records as Float32Array<ArrayBuffer>,
        low * 24,
        (high - low) * 24,
      );
      this.low = Infinity;
      this.high = 0;
    }
    if (this.hiddenHigh > this.hiddenLow) {
      const { hiddenLow: low, hiddenHigh: high } = this;
      d.queue.writeBuffer(this.buffers.hidden, low * 4, this.hidden as Uint32Array<ArrayBuffer>, low, high - low);
      this.hiddenLow = Infinity;
      this.hiddenHigh = 0;
    }
  }
  /** Validates a matrix as a part's world transform; returns its determinant. */
  protected determinant(m: ArrayLike<number>): number {
    if (m?.length !== 16) throw new TypeError('Expected 16 matrix values');
    // One finiteness test for the matrix (a NaN or infinite float32 value makes the sum non-finite; 16 finite float32
    // values cannot overflow a double); plain arrays are also checked for non-numbers, typed arrays hold numbers.
    let sum = 0;
    for (let k = 0; k < 16; k++) sum += Math.fround(m[k]);
    if (!Number.isFinite(sum)) throw new RangeError('Invalid instance transform: pass 16 finite float32 values');
    if (!ArrayBuffer.isView(m))
      for (let k = 0; k < 16; k++)
        if (typeof m[k] !== 'number') throw new RangeError('Invalid instance transform: pass 16 finite float32 values');
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (m[3] || m[7] || m[11] || m[15] !== 1 || !Number.isFinite(det) || !det)
      throw new RangeError('Expected nonsingular affine instance transforms');
    return det;
  }
  /** Whether some part of a batch can show back faces, which rules out core's back-culled pipeline. */
  protected backFaces(batch: number): boolean {
    return this.batches[batch].material.data[6] >= 0.5 || this.flips[batch] > 0;
  }
  /** Whether the depth prepass applies the single-sided rule, which it reads per part, to a batch. */
  protected singleSided(batch: number): boolean {
    return this.batches[batch].material.data[6] < 0.5;
  }
  protected write(i: number, m: ArrayLike<number>): void {
    const det = this.determinant(m),
      records = this.records,
      o = i * 24;
    // By index: `set` costs more in its call than in its 16 values.
    for (let k = 0; k < 16; k++) records[o + k] = m[k];
    const flip = +(det < 0);
    this.flips[this.batchOf[i]] += flip - this.flipped[i];
    this.flipped[i] = flip;
  }
  protected bind(
    pipeline: GPUComputePipeline | GPURenderPipeline,
    entries: [number, GPUBindingResource][],
  ): GPUBindGroup {
    return this.device!.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map(([binding, resource]) => ({ binding, resource })),
    });
  }
  private build(c: Context): void {
    const d = c.device,
      samples = c.descriptor.multisample?.count ?? 1,
      b = this.buffers,
      module = d.createShaderModule({ code: computeShader(samples, this.boxes) });
    const entry = (entryPoint: string) => d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    this.compute = {
      early: entry('early'),
      depth0: entry('depth0'),
      reduce: entry('reduce'),
      cull: entry('cull'),
      scan: entry('scan'),
      scatter: entry('scatter'),
    };
    this.prepass = { plain: occluderPipeline(d, samples, false), sided: occluderPipeline(d, samples, true) };
    const r = (name: string): GPUBindingResource => ({ buffer: b[name] }),
      p = this.compute;
    this.groups.early = this.bind(p.early, [
      [0, r('uniform')],
      [1, r('hidden')],
      [2, r('visible')],
      [6, r('batchOf')],
      [7, r('batches')],
      [9, r('earlyArgs')],
      [10, r('earlyList')],
      [11, r('records')],
      [15, r('bounds')],
    ]);
    this.groups.scan = this.bind(p.scan, [
      [0, r('uniform')],
      [4, r('groups')],
    ]);
    this.groups.scatter = this.bind(p.scatter, [
      [0, r('uniform')],
      [2, r('visible')],
      [3, r('local')],
      [4, r('groups')],
      [6, r('batchOf')],
      [7, r('batches')],
      [8, r('args')],
      [11, r('records')],
      [12, r('drawn')],
    ]);
    this.groups.prepass = this.bind(this.prepass.plain, [
      [0, r('uniform')],
      [11, r('records')],
    ]);
    this.groups.sided = this.bind(this.prepass.sided, [
      [0, r('uniform')],
      [11, r('records')],
    ]);
    this.samples = samples;
    this.hiz?.destroy();
    this.hiz = new Pyramid(d, samples, this.compute, b.uniform, b.levels, this.words);
  }
  // Size-dependent resources: the occluder depth target and the Hi-Z pyramid buffer, for a view of up to width x height.
  private resize(width: number, height: number): void {
    const b = this.buffers,
      pyramid = this.hiz!;
    pyramid.resize(width, height);
    const hiz: GPUBindingResource = { buffer: pyramid.buffer! };
    this.groups.cull = this.bind(this.compute!.cull, [
      [0, { buffer: b.uniform }],
      [1, { buffer: b.hidden }],
      [2, { buffer: b.visible }],
      [3, { buffer: b.local }],
      [4, { buffer: b.groups }],
      [5, hiz],
      [6, { buffer: b.batchOf }],
      [11, { buffer: b.records }],
      [15, { buffer: b.bounds }],
    ]);
  }
  private draw(c: Context): void {
    const d = c.device,
      b = this.buffers;
    if (!this.compute || (c.descriptor.multisample?.count ?? 1) !== this.samples) this.build(c);
    // The occluder depth and Hi-Z cover the view being drawn: its camera projects onto its rectangle. Views of different
    // sizes share resources sized for the largest; a plain frame keeps them at the canvas size.
    const [width, height] = viewSize(c);
    const pyramid = this.hiz!;
    if (c.view ? width > pyramid.width || height > pyramid.height : width !== pyramid.width || height !== pyramid.height)
      this.resize(Math.max(width, c.view ? pyramid.width : 0), Math.max(height, c.view ? pyramid.height : 0));
    pyramid.plan(width, height);
    const occlusion = this.culling === 'occlusion' && exactShader(c.shader),
      mode = occlusion ? 2 : this.culling === 'none' ? 0 : 1;
    if (!(this.occluderSize >= 0))
      throw new RangeError('Invalid occluder size; set occluderSize to a number of 0 or more');
    const m = c.camera.matrix,
      f = this.floats;
    f.set(m);
    f.set(c.camera.planes, 16);
    this.words.set([width, height, pyramid.levels, this.slots, mode, this.batches.length, depthKind(m)], 40);
    f[47] = this.occluderSize;
    d.queue.writeBuffer(b.uniform, 0, this.words);
    this.flush(d);
    const lighting = this.engine!.lighting;
    this.frame.set(c.camera.matrix);
    this.frame.set(c.camera.position, 16);
    this.frame.set(lighting.direction, 20);
    this.frame.set(lighting.radiance, 24);
    this.frame.fill(1, 28, 31);
    if (lighting.ambient) this.frame.set(lighting.ambient, 28);
    d.queue.writeBuffer(b.frame, 0, this.frame as Float32Array<ArrayBuffer>);
    const p = this.compute!,
      groups = Math.ceil(this.slots / 256);
    if (this.route) this.route(d, b, c.camera.planes, mode > 0);
    else {
      if (occlusion) {
        d.queue.writeBuffer(b.earlyArgs, 0, this.earlyReset as Uint32Array<ArrayBuffer>);
        const select = c.encoder.beginComputePass();
        select.setPipeline(p.early);
        select.setBindGroup(0, this.groups.early);
        select.dispatchWorkgroups(groups);
        select.end();
        const pass = c.encoder.beginRenderPass(pyramid.pass);
        // The target may be larger than this view (shared with a larger one).
        if (c.view) pass.setViewport(0, 0, width, height, 0, 1);
        this.batches.forEach((batch, i) => {
          const sided = this.singleSided(i);
          pass.setPipeline(sided ? this.prepass!.sided : this.prepass!.plain);
          pass.setBindGroup(0, sided ? this.groups.sided : this.groups.prepass);
          const g = this.geometryBuffers.get(batch.geometry)!;
          pass.setVertexBuffer(0, g.vertex);
          pass.setVertexBuffer(1, b.earlyList, this.starts[i] * 4);
          pass.setIndexBuffer(g.index, 'uint32');
          pass.drawIndexedIndirect(b.earlyArgs, i * 20);
        });
        this.outside?.draw(pass, c, this.engine!, this.samples);
        pass.end();
      }
      const pass = c.encoder.beginComputePass();
      if (occlusion) pyramid.encode(pass, width, height);
      pass.setPipeline(p.cull);
      pass.setBindGroup(0, this.groups.cull);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(p.scan);
      pass.setBindGroup(0, this.groups.scan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(p.scatter);
      pass.setBindGroup(0, this.groups.scatter);
      pass.dispatchWorkgroups(groups);
      pass.end();
    }
    // Main pass: core's own shader and pipeline state (sections, fog and other shader hooks apply), core's targets.
    const key = c.shader + c.format + c.descriptor.multisample?.count + c.descriptor.depthStencil!.format;
    if (key !== this.pipelineKey) {
      const module = d.createShaderModule({ code: c.shader }),
        fragment = { ...c.descriptor.fragment!, module, targets: [{ format: c.format }] },
        descriptor = { ...c.descriptor, vertex: { ...c.descriptor.vertex, module }, fragment };
      this.pipeline = d.createRenderPipeline(descriptor);
      // Only a shader that still has core's switch for its back-face discard (package hooks keep it).
      this.culledPipeline = c.shader.includes('override C=')
        ? d.createRenderPipeline({
            ...descriptor,
            primitive: { ...c.descriptor.primitive, cullMode: 'back' },
            fragment: { ...fragment, constants: { ...fragment.constants, C: 1 } },
          })
        : undefined;
      this.pipelineKey = key;
      this.group = this.culledGroup = undefined;
    }
    if (!this.group || !sameBindings(this.bindings, c.bindings)) {
      const entries: [number, GPUBindingResource][] = [
        [0, { buffer: b.frame }],
        ...c.bindings.map((e) => [e.binding, e.resource] as [number, GPUBindingResource]),
      ];
      this.group = this.bind(this.pipeline!, entries);
      this.culledGroup = this.culledPipeline && this.bind(this.culledPipeline, entries);
      this.bindings = c.bindings.map(({ binding, resource }) => ({
        binding,
        resource: 'buffer' in resource ? { ...resource } : resource,
      }));
    }
    this.color.view = c.color;
    this.target.view = c.depth;
    this.target.stencilReadOnly = c.descriptor.depthStencil!.format.includes('stencil') || undefined;
    this.target.stencilLoadOp = this.target.stencilStoreOp = undefined;
    this.color.resolveTarget = undefined;
    this.color.loadOp = this.target.depthLoadOp = 'load';
    this.color.storeOp = this.target.depthStoreOp = 'store';
    c.attach?.(this.color, this.target, true);
    const main = c.encoder.beginRenderPass(this.main);
    let current: GPURenderPipeline | undefined;
    this.batches.forEach((batch, i) => {
      // The back faces of a single-sided batch without mirrored parts are exactly what core's discard removes.
      const culled = this.culledPipeline && !this.backFaces(i),
        pipeline = culled ? this.culledPipeline! : this.pipeline!;
      if (pipeline !== current) {
        current = pipeline;
        main.setPipeline(pipeline);
        main.setBindGroup(0, culled ? this.culledGroup! : this.group!);
      }
      const g = this.geometryBuffers.get(batch.geometry)!;
      main.setVertexBuffer(0, g.vertex);
      main.setVertexBuffer(1, b.drawn, this.starts[i] * 96);
      main.setIndexBuffer(g.index, 'uint32');
      main.drawIndexedIndirect(b.args, i * 20);
    });
    main.end();
  }
  protected release(): void {
    this.route = undefined;
    this.outside?.release();
    for (const buffer of Object.values(this.buffers)) buffer.destroy();
    for (const g of this.geometryBuffers.values()) {
      g.vertex.destroy();
      g.index.destroy();
    }
    this.hiz?.destroy();
    this.buffers = {};
    this.geometryBuffers.clear();
    this.groups = {};
    this.hiz = undefined;
    this.compute = this.prepass = this.pipeline = this.group = this.culledPipeline = this.culledGroup = undefined;
    this.pipelineKey = '';
    this.bindings = [];
    this.samples = 0;
    this.device = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

// The box of 24-byte vertices into `out` from `at`: centre at 0, half size at 4.
function localBox(vertices: Float32Array, out: Float32Array, at: number): void {
  for (let k = 0; k < 3; k++) {
    let low = Infinity,
      high = -Infinity;
    for (let i = k; i < vertices.length; i += 6) {
      if (vertices[i] < low) low = vertices[i];
      if (vertices[i] > high) high = vertices[i];
    }
    out[at + k] = (low + high) / 2;
    out[at + 4 + k] = (high - low) / 2;
  }
}
function sameBindings(previous: readonly GPUBindGroupEntry[], entries: readonly GPUBindGroupEntry[]): boolean {
  return (
    previous.length === entries.length &&
    previous.every((old, i) => {
      const a = old.resource as GPUBufferBinding,
        b = entries[i].resource as GPUBufferBinding;
      return (
        old.binding === entries[i].binding &&
        (a === b || (a.buffer !== undefined && a.buffer === b.buffer && a.offset === b.offset && a.size === b.size))
      );
    })
  );
}
