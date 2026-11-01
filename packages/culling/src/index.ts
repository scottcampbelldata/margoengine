/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { Geometry, PbrMaterial } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { computeShader, depthShader, partsPickShader, partsShadowShader } from './shaders.js';
import { viewSize } from '../../shared/view-rect.js';
import { loadCompatRoute } from '../../shared/compat.js';
export { CulledMeshes } from './meshes.js';
export type { CulledMeshesOptions } from './meshes.js';

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
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `frustum` (default): bounding spheres against the view frustum. `occlusion`: frustum + Hi-Z occlusion (dense or enclosed assemblies). `none`: draw everything. */
export type CullingMode = 'none' | 'frustum' | 'occlusion';
/** One (geometry, material) group of static parts; uploaded once at attach. */
export interface CulledBatch {
  /** Shared by every part of the batch. */
  geometry: Geometry;
  /** Shared by every part of the batch. */
  material: PbrMaterial;
  /** Column-major affine world matrices, 16 floats per instance. May be empty when `capacity` is set. */
  transforms: Float32Array;
  /**
   * Parts this batch can hold at once, for {@link CulledInstances.addParts}. Fixed; each free slot costs its 96-byte
   * record and one test per frame. Default: the parts in `transforms`, so nothing can be added.
   */
  capacity?: number;
}
/** One part: its batch, and its index inside that batch. */
export interface CulledPart {
  batch: number;
  index: number;
}
/** `CulledInstances` settings. */
export interface CulledInstancesOptions {
  /** Culling test; also settable later as `parts.culling`. Default `'frustum'`. */
  culling?: CullingMode;
  /** Parts whose bounding sphere spans at least this many pixels in radius become occluders for the next frame (default 8). */
  occluderSize?: number;
}

const modes: readonly CullingMode[] = ['none', 'frustum', 'occlusion'];
// Occlusion is exact only when core's shader still computes clip positions unchanged and discards nothing beyond
// its single-sided rule; section planes and similar fragment clipping fall back to frustum culling.
const exactShader = (shader: string): boolean =>
  shader.includes('let p=model*vec4f(i.position,1);\nvar o:Output;o.clip=frame.camera*p;') &&
  shader.split('discard').length === 2;
const vertexLayout: GPUVertexBufferLayout = {
  arrayStride: 24,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
};
// The whole part list as instance data, for the caster and id draws: a part's record and its hidden word.
const partLayouts: GPUVertexBufferLayout[] = [
  vertexLayout,
  {
    arrayStride: 96,
    stepMode: 'instance',
    attributes: [
      ...[2, 3, 4, 5].map((shaderLocation, i) => ({
        shaderLocation,
        offset: i * 16,
        format: 'float32x4' as const,
      })),
      { shaderLocation: 6, offset: 80, format: 'float32x4' },
    ],
  },
  { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 7, offset: 0, format: 'uint32' }] },
];
const FREE = 2; // A slot's word in `hidden`: 0 shown, 1 hidden by setVisible, 2 holds no part.
let serial = 0;

/** Validates a matrix as a part's world transform; returns its determinant. */
function determinant(m: ArrayLike<number>): number {
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

/**
 * Static parts drawn without per-part CPU work: instances are uploaded once, and every frame a compute pass tests each
 * part against the frustum and a Hi-Z pyramid, compacts the visible ones in their original order and writes indirect
 * draw arguments. Parts are not core meshes (no `engine.pick` or sections caps); they have their own {@link pick},
 * {@link setParent}, {@link drawShadow} and {@link addParts}.
 */
export class CulledInstances implements EnginePlugin {
  readonly name = 'culling:' + ++serial;
  /** First slot of each batch in the flat order of all slots; a batch holds `capacity` slots. */
  readonly starts: readonly number[];
  /** Bumped when a part changes, for `shadows.add(parts, {static: true})`: the cached still map re-renders. */
  shadowVersion = 0;
  culling: CullingMode;
  /** See {@link CulledInstancesOptions.occluderSize}. */
  occluderSize: number;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private readonly batches: readonly CulledBatch[];
  /** Slots in all batches, free ones included; the buffers and kernels cover this many. */
  private readonly slots: number;
  private live = 0;
  // Per batch, the free indices inside it, the lowest last.
  private readonly free: number[][];
  // Allocated by the first setParent. Per slot: the parent's slot or -1, and the matrix relative to that parent.
  private parents?: Int32Array;
  private locals?: Float32Array;
  private children?: Map<number, number[]>;
  private readonly product = new Float32Array(16);
  private shadow?: { pipeline: GPURenderPipeline; uniforms: GPUBuffer[]; groups: GPUBindGroup[] };
  private picker?: {
    pipeline: GPURenderPipeline;
    uniform: GPUBuffer;
    ids: GPUTexture;
    depth: GPUTexture;
    group: GPUBindGroup;
    descriptor: GPURenderPassDescriptor;
  };
  private picking?: Promise<CulledPart | null>;
  private readonly records: Float32Array;
  // Per batch: the geometry's local bounding sphere (the cull pass places it under each part's matrix).
  private readonly bounds: Float32Array;
  private readonly batchOf: Uint32Array;
  private readonly table: Uint32Array;
  private readonly args: Uint32Array;
  private readonly earlyReset: Uint32Array;
  private readonly hidden: Uint32Array;
  // 1 for a part whose transform mirrors it (negative determinant); per batch, how many such parts it has.
  private readonly flipped: Uint8Array;
  private readonly flips: Uint32Array;
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
  private buffers: Record<string, GPUBuffer> = {};
  private geometryBuffers = new Map<Geometry, { vertex: GPUBuffer; index: GPUBuffer }>();
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
  private levelGroups: GPUBindGroup[] = [];
  private depth?: GPUTexture;
  private hiz?: GPUBuffer;
  private samples = 0;
  private width = 0;
  private height = 0;
  private levels = 0;
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
  private readonly occluders: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthClearValue: 0,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
  };
  private readonly early: GPURenderPassDescriptor = { colorAttachments: [], depthStencilAttachment: this.occluders };

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
  constructor(batches: readonly CulledBatch[], { culling = 'frustum', occluderSize = 8 }: CulledInstancesOptions = {}) {
    if (!Array.isArray(batches) || !batches.length) throw new TypeError('Expected culled batches');
    if (!modes.includes(culling)) throw new TypeError('Invalid culling mode; use "none", "frustum" or "occlusion"');
    this.culling = culling;
    this.occluderSize = occluderSize;
    const starts: number[] = [];
    let count = 0;
    for (const b of batches) {
      if (
        !(b?.geometry instanceof Geometry) ||
        !(b.material instanceof PbrMaterial) ||
        !(b.transforms instanceof Float32Array) ||
        !(b.transforms.length || b.capacity) ||
        b.transforms.length % 16
      )
        throw new TypeError(
          'Invalid culled batch; give each batch a geometry, a PbrMaterial and a non-empty Float32Array of 16-float matrices',
        );
      const slots = b.capacity ?? b.transforms.length / 16;
      if (!Number.isInteger(slots) || slots < b.transforms.length / 16)
        throw new RangeError('Invalid culled batch capacity; pass a whole number no smaller than its part count');
      starts.push(count);
      count += slots;
    }
    if (count > 1_000_000) throw new RangeError('Culled instances: at most 1,000,000');
    this.batches = batches.map((b) => ({ ...b }));
    this.slots = count;
    this.starts = starts;
    this.free = batches.map(() => []);
    this.records = new Float32Array(count * 24);
    this.bounds = new Float32Array(batches.length * 4);
    this.batchOf = new Uint32Array(count);
    this.hidden = new Uint32Array(count);
    this.flipped = new Uint8Array(count);
    this.flips = new Uint32Array(batches.length);
    this.table = new Uint32Array(batches.length * 4);
    this.args = new Uint32Array(batches.length * 5);
    this.earlyReset = new Uint32Array(batches.length * 5);
    batches.forEach((b, batch) => {
      const start = starts[batch],
        parts = b.transforms.length / 16,
        end = start + (b.capacity ?? parts);
      this.table.set([start, end, b.geometry.indices.length, 0], batch * 4);
      this.bounds.set(b.geometry.bounds, batch * 4);
      this.args[batch * 5] = this.earlyReset[batch * 5] = b.geometry.indices.length;
      for (let i = start; i < end; i++) {
        this.batchOf[i] = batch;
        this.records.set(b.material.data, i * 24 + 16);
        this.records[i * 24 + 23] = -1; // no core mesh ID
        if (i - start < parts) this.write(i, b.transforms.subarray((i - start) * 16, (i - start + 1) * 16));
      }
      for (let i = end - start - 1; i >= parts; i--) {
        this.hidden[start + i] = FREE;
        this.free[batch].push(i);
      }
      this.live += parts;
    });
  }
  /** Parts alive now, hidden ones included. */
  get count(): number {
    return this.live;
  }

  /**
   * Replaces one part's world matrix (column-major affine). Changes reach the GPU together before the next frame: one
   * write per buffer covering every part changed since the last frame, so moving many parts costs no per-part GPU call.
   */
  setTransform(batch: number, index: number, matrix: ArrayLike<number>): void {
    this.place(this.index(batch, index), matrix);
  }
  /**
   * Makes a part follow another: from now on its matrix (the one it has, and each later {@link setTransform}) is relative
   * to `parent`, and moving the parent moves the whole subtree, one record write per part there. `null` detaches it,
   * keeping its world position. A parent may be hidden, which makes it a plain group node.
   * @throws RangeError for a part not alive or a parent inside the part's own subtree.
   */
  setParent(batch: number, index: number, parent: CulledPart | null): void {
    const i = this.index(batch, index),
      p = parent ? this.index(parent.batch, parent.index) : -1;
    const parents = (this.parents ??= new Int32Array(this.slots).fill(-1)),
      locals = (this.locals ??= new Float32Array(this.slots * 16)),
      children = (this.children ??= new Map());
    for (let a = p; a >= 0; a = parents[a])
      if (a === i) throw new RangeError("Invalid culled parent; pick a part outside this part's own subtree");
    const old = parents[i];
    if (old >= 0) this.unlink(i, old);
    else if (p >= 0) locals.set(this.records.subarray(i * 24, i * 24 + 16), i * 16);
    parents[i] = p;
    if (p >= 0) {
      const list = children.get(p);
      if (list) list.push(i);
      else children.set(p, [i]);
      this.place(i, locals.subarray(i * 16, i * 16 + 16));
    }
  }
  /** Writes a part's world matrix into `out` (default a new array) and returns it. */
  getWorldMatrix(batch: number, index: number, out: number[] | Float32Array = new Float32Array(16)): typeof out {
    const at = this.index(batch, index) * 24;
    for (let k = 0; k < 16; k++) out[k] = this.records[at + k];
    return out;
  }
  /**
   * Adds parts to a batch's free slots, shown, without touching the rest: one upload per changed range with the next
   * frame, as for {@link setTransform}. Returns each new part's index inside the batch.
   * @throws RangeError when the batch has too few free slots; reserve them with {@link CulledBatch.capacity}.
   */
  addParts(batch: number, transforms: Float32Array): number[] {
    const free = this.free[batch];
    if (!free) throw new RangeError('Invalid culled batch index; pass a batch index from 0 up to the batch count');
    if (!(transforms instanceof Float32Array) || transforms.length % 16)
      throw new TypeError('Invalid culled parts; pass a Float32Array of 16-float matrices');
    const n = transforms.length / 16;
    if (n > free.length)
      throw new RangeError(
        `Culled batch ${batch} has ${free.length} free slots for ${n} parts; set a larger capacity on the batch`,
      );
    for (let k = 0; k < n; k++) determinant(transforms.subarray(k * 16, k * 16 + 16));
    const added: number[] = [];
    for (let k = 0; k < n; k++) {
      const index = free.pop()!,
        i = this.starts[batch] + index;
      this.show(i, 0);
      this.place(i, transforms.subarray(k * 16, k * 16 + 16));
      added.push(index);
    }
    this.live += n;
    return added;
  }
  /**
   * Removes parts, freeing their slots for {@link addParts}; other parts keep their indices. Detaches each from its parent.
   * @throws RangeError for a part not alive, listed twice, or still the parent of a part that is not removed with it.
   */
  removeParts(batch: number, indices: readonly number[]): void {
    const slots = indices.map((index) => this.index(batch, index)),
      gone = new Set(slots);
    if (gone.size !== slots.length) throw new RangeError('Invalid culled parts; list each part to remove once');
    for (const i of slots)
      if (this.children?.get(i)?.some((child) => !gone.has(child)))
        throw new RangeError('Culled part still has children; detach them with setParent or remove them too');
    slots.forEach((i, k) => {
      const parent = this.parents?.[i] ?? -1;
      if (parent >= 0) this.unlink(i, parent);
      if (this.parents) this.parents[i] = -1;
      this.flips[batch] -= this.flipped[i];
      this.flipped[i] = 0;
      this.show(i, FREE);
      this.free[batch].push(indices[k]);
    });
    this.live -= slots.length;
  }
  /** Hides or shows one part (uploaded with the next frame, like {@link setTransform}). */
  setVisible(batch: number, index: number, visible: boolean): void {
    const i = this.index(batch, index);
    if (typeof visible !== 'boolean') throw new TypeError('Invalid visibility; pass true or false');
    this.show(i, +!visible);
  }
  /**
   * The shown part under CSS pixel (x, y) through the engine camera, or null. Other drawing does not count: to find what
   * is nearest overall, compare with `engine.pick`. A GPU readback of one draw of every shown part (culled ones can
   * never be the answer) into a 1x1 id target; overlapping calls run one after another. Follows core's single-sided rule.
   */
  pick(x: number, y: number): Promise<CulledPart | null> {
    if (!this.engine || !this.device)
      return Promise.reject(new MargoError('state', 'CulledInstances is not attached; attach it to an engine first'));
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return Promise.reject(new RangeError('Invalid pick; pass finite CSS pixels'));
    const run = (this.picking ?? Promise.resolve(null)).then(
      () => this.pickNow(x, y),
      () => this.pickNow(x, y),
    );
    this.picking = run;
    return run;
  }
  /**
   * Draws every shown part into one shadow cascade (the `ShadowSource` contract of @margoengine/shadows:
   * `shadows.add(parts)`). Parts outside the camera view still cast, so this does not use the camera's culled list.
   */
  drawShadow({
    context,
    pass,
    matrix,
    cascade,
  }: {
    context: { device: GPUDevice };
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    const d = context.device;
    if (!this.device) return;
    const s = (this.shadow ??= (() => {
      const module = d.createShaderModule({ code: partsShadowShader }),
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', buffers: partLayouts },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
        }),
        uniforms: GPUBuffer[] = [],
        groups: GPUBindGroup[] = [];
      for (let i = 0; i < 4; i++) {
        const buffer = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        uniforms.push(buffer);
        groups.push(this.bind(pipeline, [[0, { buffer }]]));
      }
      return { pipeline, uniforms, groups };
    })());
    this.flush(d);
    d.queue.writeBuffer(s.uniforms[cascade], 0, matrix as Float32Array<ArrayBuffer>);
    pass.setPipeline(s.pipeline);
    pass.setBindGroup(0, s.groups[cascade]);
    this.drawParts(pass);
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
      buffer(
        'levels',
        16 * 256,
        GPUBufferUsage.UNIFORM,
        new Uint32Array(16 * 64).map((_, i) => (i % 64 ? 0 : i / 64)),
      );
      buffer('records', n * 96, S | GPUBufferUsage.VERTEX, this.records);
      buffer('drawn', n * 96, S | GPUBufferUsage.VERTEX);
      buffer('hidden', n * 4, S | GPUBufferUsage.VERTEX, this.hidden);
      buffer('bounds', B * 16, S, this.bounds);
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
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  // One draw per batch of all its slots: firstInstance is the flat slot, so instance_index names the part.
  private drawParts(pass: GPURenderPassEncoder): void {
    pass.setVertexBuffer(1, this.buffers.records);
    pass.setVertexBuffer(2, this.buffers.hidden);
    this.batches.forEach((batch, i) => {
      const g = this.geometryBuffers.get(batch.geometry)!,
        table = this.table;
      pass.setVertexBuffer(0, g.vertex);
      pass.setIndexBuffer(g.index, 'uint32');
      pass.drawIndexed(batch.geometry.indices.length, table[i * 4 + 1] - table[i * 4], 0, 0, table[i * 4]);
    });
  }
  private async pickNow(x: number, y: number): Promise<CulledPart | null> {
    const engine = this.engine,
      d = this.device;
    if (!engine || !d) return null;
    const canvas = engine.canvas,
      w = canvas.clientWidth || canvas.width,
      h = canvas.clientHeight || canvas.height;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const t = (this.picker ??= (() => {
      const module = d.createShaderModule({ code: partsPickShader }),
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', buffers: partLayouts },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32uint' }] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
        }),
        uniform = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        ids = d.createTexture({ size: [1, 1], format: 'r32uint', usage: 16 | 1 }),
        depth = d.createTexture({ size: [1, 1], format: 'depth32float', usage: 16 });
      return {
        pipeline,
        uniform,
        ids,
        depth,
        group: this.bind(pipeline, [[0, { buffer: uniform }]]),
        descriptor: {
          colorAttachments: [
            { view: ids.createView(), clearValue: [4294967295, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
          ],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
          },
        } as GPURenderPassDescriptor,
      };
    })());
    // The camera matrix scaled and offset so the picked device pixel fills the 1x1 target.
    const camera = engine.camera.matrix,
      matrix = this.product,
      px = Math.floor((x * canvas.width) / w) + 0.5,
      py = Math.floor((y * canvas.height) / h) + 0.5;
    for (let c = 0; c < 4; c++) {
      const wc = camera[c * 4 + 3];
      matrix[c * 4] = camera[c * 4] * canvas.width - (2 * px - canvas.width) * wc;
      matrix[c * 4 + 1] = camera[c * 4 + 1] * canvas.height + (2 * py - canvas.height) * wc;
      matrix[c * 4 + 2] = camera[c * 4 + 2];
      matrix[c * 4 + 3] = wc;
    }
    d.queue.writeBuffer(t.uniform, 0, matrix as Float32Array<ArrayBuffer>);
    this.flush(d);
    const read = d.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = d.createCommandEncoder(),
        pass = encoder.beginRenderPass(t.descriptor);
      pass.setPipeline(t.pipeline);
      pass.setBindGroup(0, t.group);
      this.drawParts(pass);
      pass.end();
      encoder.copyTextureToBuffer({ texture: t.ids }, { buffer: read }, [1, 1]);
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const id = new Uint32Array(read.getMappedRange().slice(0))[0];
      read.unmap();
      if (id >= this.slots || this.hidden[id]) return null;
      const batch = this.batchOf[id];
      return { batch, index: id - this.starts[batch] };
    } finally {
      read.destroy();
    }
  }
  private unlink(i: number, parent: number): void {
    const list = this.children!.get(parent)!;
    list.splice(list.indexOf(i), 1);
    if (!list.length) this.children!.delete(parent);
  }
  private show(i: number, word: number): void {
    this.hidden[i] = word;
    if (i < this.hiddenLow) this.hiddenLow = i;
    if (i >= this.hiddenHigh) this.hiddenHigh = i + 1;
    this.shadowVersion++;
  }
  // A part's own matrix (relative to its parent, if it has one), then the world matrices of its subtree, parents first.
  private place(i: number, matrix: ArrayLike<number>): void {
    const parent = this.parents?.[i] ?? -1;
    if (parent >= 0) {
      this.write(i, this.fold(parent, matrix, 0));
      this.locals!.set(matrix, i * 16);
    } else this.write(i, matrix);
    this.dirty(i);
    this.shadowVersion++;
    const below = this.children?.get(i);
    if (!below) return;
    const stack = [...below];
    while (stack.length) {
      const k = stack.pop()!;
      this.write(k, this.fold(this.parents![k], this.locals!, k * 16));
      this.dirty(k);
      const more = this.children!.get(k);
      if (more) stack.push(...more);
    }
  }
  // The world matrix of `parent` times the 16 values of `m` from `at`, in a shared scratch array.
  private fold(parent: number, m: ArrayLike<number>, at: number): Float32Array {
    const a = this.records,
      p = parent * 24,
      out = this.product;
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        out[c * 4 + r] =
          a[p + r] * m[at + c * 4] +
          a[p + 4 + r] * m[at + c * 4 + 1] +
          a[p + 8 + r] * m[at + c * 4 + 2] +
          a[p + 12 + r] * m[at + c * 4 + 3];
    return out;
  }
  private index(batch: number, index: number): number {
    const start = this.starts[batch],
      end = batch + 1 < this.starts.length ? this.starts[batch + 1] : this.slots;
    if (
      !Number.isInteger(batch) ||
      start === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      start + index >= end ||
      this.hidden[start + index] === FREE
    )
      throw new RangeError('Invalid culled instance; pass a batch index and an instance index inside that batch');
    return start + index;
  }
  private dirty(i: number): void {
    if (i < this.low) this.low = i;
    if (i >= this.high) this.high = i + 1;
  }
  // The changed parts' records, and the changed visibility flags, one contiguous range each.
  private flush(d: GPUDevice): void {
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
  private write(i: number, m: ArrayLike<number>): void {
    const det = determinant(m);
    this.records.set(m, i * 24);
    const flip = +(det < 0);
    this.flips[this.batchOf[i]] += flip - this.flipped[i];
    this.flipped[i] = flip;
  }
  private bind(
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
      module = d.createShaderModule({ code: computeShader(samples) });
    const entry = (entryPoint: string) => d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    this.compute = {
      early: entry('early'),
      depth0: entry('depth0'),
      reduce: entry('reduce'),
      cull: entry('cull'),
      scan: entry('scan'),
      scatter: entry('scatter'),
    };
    const depthModule = d.createShaderModule({ code: depthShader }),
      prepass = (fragment: boolean) =>
        d.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: depthModule,
            entryPoint: 'vertex',
            buffers: [
              vertexLayout,
              {
                arrayStride: 4,
                stepMode: 'instance',
                attributes: [{ shaderLocation: 2, offset: 0, format: 'uint32' }],
              },
            ],
          },
          fragment: fragment ? { module: depthModule, entryPoint: 'fragment', targets: [] } : undefined,
          multisample: { count: samples },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
        });
    this.prepass = { plain: prepass(false), sided: prepass(true) };
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
    this.width = this.height = 0;
  }
  // Size-dependent resources: the occluder depth target and the Hi-Z pyramid buffer, for a view of up to width x height.
  private resize(c: Context, width: number, height: number): void {
    const d = c.device,
      p = this.compute!,
      b = this.buffers;
    this.depth?.destroy();
    this.hiz?.destroy();
    this.depth = this.hiz = undefined;
    this.depth = d.createTexture({
      size: [width, height],
      format: 'depth32float',
      sampleCount: this.samples,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.width = width;
    this.height = height;
    const levels = this.pyramid(width, height);
    this.hiz = d.createBuffer({ size: levels * 4, usage: GPUBufferUsage.STORAGE });
    const view = this.depth.createView(),
      hiz: GPUBindingResource = { buffer: this.hiz };
    this.occluders.view = view;
    this.groups.depth0 = this.bind(p.depth0, [
      [0, { buffer: b.uniform }],
      [5, hiz],
      [14, view],
    ]);
    this.groups.cull = this.bind(p.cull, [
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
    this.levelGroups = Array.from({ length: this.levels }, (_, l) =>
      this.bind(p.reduce, [
        [0, { buffer: b.uniform }],
        [5, hiz],
        [13, { buffer: b.levels, offset: l * 256, size: 16 }],
      ]),
    );
  }
  // Writes the Hi-Z level table (offset, width, height) for a width x height view, level 0 at full resolution; sets
  // `levels` and returns the texel count.
  private pyramid(width: number, height: number): number {
    let w = width,
      h = height,
      offset = 0,
      level = 0;
    for (; ; level++) {
      this.words.set([offset, w, h, 0], 48 + level * 4);
      offset += w * h;
      if (w === 1 && h === 1) break;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
    this.levels = level + 1;
    return offset;
  }
  private draw(c: Context): void {
    const d = c.device,
      b = this.buffers;
    if (!this.compute || (c.descriptor.multisample?.count ?? 1) !== this.samples) this.build(c);
    // The occluder depth and Hi-Z cover the view being drawn: its camera projects onto its rectangle. Views of different
    // sizes share resources sized for the largest; a plain frame keeps them at the canvas size.
    const [width, height] = viewSize(c);
    if (c.view ? width > this.width || height > this.height : width !== this.width || height !== this.height)
      this.resize(c, Math.max(width, c.view ? this.width : 0), Math.max(height, c.view ? this.height : 0));
    this.pyramid(width, height);
    const occlusion = this.culling === 'occlusion' && exactShader(c.shader),
      mode = occlusion ? 2 : this.culling === 'none' ? 0 : 1;
    if (!(this.occluderSize >= 0))
      throw new RangeError('Invalid occluder size; set occluderSize to a number of 0 or more');
    const m = c.camera.matrix,
      f = this.floats;
    f.set(m);
    f.set(c.camera.planes, 16);
    this.words.set([width, height, this.levels, this.slots, mode, this.batches.length, depthKind(m)], 40);
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
        const pass = c.encoder.beginRenderPass(this.early);
        // The target may be larger than this view (shared with a larger one).
        if (c.view) pass.setViewport(0, 0, width, height, 0, 1);
        this.batches.forEach((batch, i) => {
          const sided = batch.material.data[6] < 0.5;
          pass.setPipeline(sided ? this.prepass!.sided : this.prepass!.plain);
          pass.setBindGroup(0, sided ? this.groups.sided : this.groups.prepass);
          const g = this.geometryBuffers.get(batch.geometry)!;
          pass.setVertexBuffer(0, g.vertex);
          pass.setVertexBuffer(1, b.earlyList, this.starts[i] * 4);
          pass.setIndexBuffer(g.index, 'uint32');
          pass.drawIndexedIndirect(b.earlyArgs, i * 20);
        });
        pass.end();
      }
      const pass = c.encoder.beginComputePass();
      if (occlusion) {
        pass.setPipeline(p.depth0);
        pass.setBindGroup(0, this.groups.depth0);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.setPipeline(p.reduce);
        for (let l = 1; l < this.levels; l++) {
          pass.setBindGroup(0, this.levelGroups[l]);
          pass.dispatchWorkgroups(Math.ceil(this.words[48 + l * 4 + 1] / 8), Math.ceil(this.words[48 + l * 4 + 2] / 8));
        }
      }
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
    const main = c.encoder.beginRenderPass(this.main);
    let current: GPURenderPipeline | undefined;
    this.batches.forEach((batch, i) => {
      // The back faces of a single-sided batch without mirrored parts are exactly what core's discard removes.
      const culled = this.culledPipeline && batch.material.data[6] < 0.5 && !this.flips[i],
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
  private release(): void {
    this.route = undefined;
    for (const buffer of Object.values(this.buffers)) buffer.destroy();
    for (const buffer of this.shadow?.uniforms ?? []) buffer.destroy();
    this.picker?.uniform.destroy();
    this.picker?.ids.destroy();
    this.picker?.depth.destroy();
    this.shadow = this.picker = undefined;
    for (const g of this.geometryBuffers.values()) {
      g.vertex.destroy();
      g.index.destroy();
    }
    this.depth?.destroy();
    this.hiz?.destroy();
    this.buffers = {};
    this.geometryBuffers.clear();
    this.groups = {};
    this.levelGroups = [];
    this.depth = this.hiz = undefined;
    this.compute = this.prepass = this.pipeline = this.group = this.culledPipeline = this.culledGroup = undefined;
    this.pipelineKey = '';
    this.bindings = [];
    this.samples = this.width = this.height = 0;
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

// Nearest sphere depth is exact when clip z depends on w alone (perspective: row 2 parallel to row 3) or w is constant
// (orthographic); other projections use the bounding box corners only.
function depthKind(m: Float32Array): number {
  const [a, b, c] = [m[2], m[6], m[10]],
    [x, y, z] = [m[3], m[7], m[11]],
    row3 = Math.hypot(x, y, z);
  if (!row3) return 2;
  return Math.hypot(b * z - c * y, c * x - a * z, a * y - b * x) <= 1e-6 * Math.hypot(a, b, c) * row3 ? 1 : 0;
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
