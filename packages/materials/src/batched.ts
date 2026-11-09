/// <reference lib="esnext.disposable" preserve="true" />
// Many distinct geometries in one materials mesh, so one draw call per pass (beauty, each shadow cascade, SSAO).
// Items are copied into shared vertex and index ranges once; a compute pass writes the drawn vertices from each item's
// matrix, colour and visibility whenever one changes, through gltf-pro's deformation hook (the same one skins use), so
// shadows, clustered lights, fog, IBL, SSAO and picking all draw the batch as they draw any materials mesh.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { PBRDeformationContext } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import { Material, createMesh, packGeometry, type MaterialMesh, type MeshGeometry } from './built-material.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; COPY_DST: number; COPY_SRC: number; UNIFORM: number };

/** Capacity of a {@link BatchedMesh}, fixed at creation. */
export interface BatchedMeshOptions {
  /** Items the batch holds at once, 1 to 1,000,000. */
  maxItems: number;
  /** Vertices of all items together, 3 to 1,000,000. */
  maxVertices: number;
  /** Indices of all items together, a positive multiple of 3. Default `maxVertices * 2` rounded up to triangles. */
  maxIndices?: number;
  /** Draw order among materials meshes (as `createMesh`). Default 0. */
  renderOrder?: number;
}
/** Per-item state given to {@link BatchedMesh.add}. */
export interface BatchedItemOptions {
  /** Column-major 4x4 matrix relative to `batch.mesh.root`. Default identity. */
  matrix?: ArrayLike<number>;
  /** Tint multiplied into the geometry's vertex colours (sRGB hex or linear `[r, g, b]`). Default white. */
  color?: ColorInput;
  /** Default true. */
  visible?: boolean;
}

// Per item on the GPU: matrix (16 floats), then linear rgb tint and a visible flag.
const ITEM = 20;
const NONE = 0xffffffff;
/** @internal The batch compute pass: one invocation per vertex slot, reading its item's matrix and tint. */
export const batchShader = /* wgsl */ `
struct Vertex {position:vec4f,normal:vec4f,tangent:vec4f,uv:vec4f,color:vec4f}
struct Item {matrix:mat4x4f,tint:vec4f}
@group(0) @binding(0) var<storage,read> source:array<Vertex>;
@group(0) @binding(1) var<storage,read_write> output:array<Vertex>;
@group(0) @binding(2) var<storage,read> items:array<Item>;
@group(0) @binding(3) var<storage,read> owner:array<u32>;
@group(0) @binding(4) var<uniform> counts:vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=counts.x){return;}
  var v=source[id.x];let k=owner[id.x];
  if(k==0xffffffffu||items[k].tint.w<0.5){output[id.x]=Vertex(vec4f(0,0,0,1),vec4f(0,0,1,0),vec4f(1,0,0,1),v.uv,v.color);return;}
  let m=items[k].matrix;
  let normalMatrix=mat3x3f(cross(m[1].xyz,m[2].xyz),cross(m[2].xyz,m[0].xyz),cross(m[0].xyz,m[1].xyz));
  let handedness=sign(dot(m[0].xyz,cross(m[1].xyz,m[2].xyz)));
  v.position=vec4f((m*vec4f(v.position.xyz,1)).xyz,1);
  v.normal=vec4f(normalize(normalMatrix*v.normal.xyz*handedness),0);
  v.tangent=vec4f((m*vec4f(v.tangent.xyz,0)).xyz,v.tangent.w*handedness);
  v.color=vec4f(v.color.rgb*items[k].tint.rgb,v.color.a);output[id.x]=v;
}
`;
const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();
let serial = 0;
type Range = { vertex: number; vertices: number; index: number; indices: number };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Many different geometries drawn as one materials mesh: one draw call per pass however many items it holds, each
 * item with its own matrix, colour and visibility. `BatchedMesh.attach(engine, material, {maxItems, maxVertices})`,
 * then `batch.add(geometry, {matrix, color})` per item. Every item is its own copy of its geometry's vertices; for many
 * copies of one geometry use `createInstancedMesh`. Moving, tinting or hiding an item costs 20 floats of upload and a
 * compute pass over the used vertices on the next frame; an unchanged batch costs nothing. `batch.mesh` takes
 * `shadows.add`, `clustered.add`, `ssao.add` and picking like any `createMesh` mesh (it redraws its shadow every frame
 * after a change, as a skinned mesh does). WebGPU only.
 */
export class BatchedMesh implements EnginePlugin {
  readonly name = 'batched-mesh:' + serial++;
  /** The materials mesh the items draw as. Move the whole batch with `mesh.root`; dispose the batch, not the mesh. */
  readonly mesh: MaterialMesh;
  /** Capacity, as created. */
  readonly maxItems: number;
  readonly maxVertices: number;
  readonly maxIndices: number;
  private readonly items: Float32Array<ArrayBuffer>;
  private readonly owner: Uint32Array<ArrayBuffer>;
  private readonly ranges: (Range | undefined)[] = [];
  /** Local [minX, minY, minZ, maxX, maxY, maxZ] of each item's geometry. */
  private readonly local: Float32Array;
  private free: Range[] = [];
  private freeIds: number[] = [];
  private nextVertex = 0;
  private nextIndex = 0;
  private live = 0;
  private dirtyItems: [number, number] = [Infinity, -Infinity];
  private dirtyVertices: [number, number] = [Infinity, -Infinity];
  private dirtyIndices: [number, number] = [Infinity, -Infinity];
  private changed = true;
  private disposed = false;
  private gpu?: {
    buffers: GPUBuffer[];
    source: GPUBuffer;
    output: GPUBuffer;
    items: GPUBuffer;
    owner: GPUBuffer;
    counts: GPUBuffer;
    group: GPUBindGroup;
    pipeline: GPUComputePipeline;
    used: number;
  };
  private unsubscribe?: () => void;
  private readonly prepare = (context: PBRDeformationContext) => this.update(context);

  private constructor(engine: EngineKernel, material: Material, o: BatchedMeshOptions) {
    const { maxItems, maxVertices } = o,
      maxIndices = o.maxIndices ?? Math.ceil((maxVertices * 2) / 3) * 3;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1_000_000)
      throw new RangeError('BatchedMesh maxItems must be an integer from 1 to 1,000,000; pass a smaller capacity');
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3 || maxVertices > 1_000_000)
      throw new RangeError('BatchedMesh maxVertices must be an integer from 3 to 1,000,000; pass a smaller capacity');
    if (!Number.isSafeInteger(maxIndices) || maxIndices < 3 || maxIndices % 3)
      throw new RangeError('BatchedMesh maxIndices must be a positive multiple of 3; pass whole triangles');
    this.maxItems = maxItems;
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;
    this.items = new Float32Array(maxItems * ITEM);
    this.owner = new Uint32Array(maxVertices).fill(NONE);
    this.local = new Float32Array(maxItems * 6);
    // Placeholder geometry of the full capacity: every index points at vertex 0 until an item fills its range.
    const normals = new Float32Array(maxVertices * 3),
      tangents = new Float32Array(maxVertices * 4);
    for (let i = 0; i < maxVertices; i++) {
      normals[i * 3 + 2] = 1;
      tangents[i * 4] = tangents[i * 4 + 3] = 1;
    }
    this.mesh = createMesh(
      engine,
      {
        positions: new Float32Array(maxVertices * 3),
        normals,
        tangents,
        uvs: new Float32Array(maxVertices * 2),
        indices: new Uint32Array(maxIndices),
      },
      material,
      { renderOrder: o.renderOrder ?? 0 },
    );
    const vertices = this.mesh.primitives[0].vertices;
    // Placeholder vertices are white so an item's tint is its colour.
    for (let i = 0; i < maxVertices; i++) vertices.fill(1, i * 20 + 16, i * 20 + 20);
    const model = this.mesh,
      prototype = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(model), 'bounds')!;
    // CPU bounds come from the items, not the placeholder vertices the model holds.
    Object.defineProperty(model, 'bounds', {
      configurable: true,
      get: () => (this.disposed ? prototype.get!.call(model) : this.bounds()),
    });
  }

  /**
   * A batch drawn with `material` (any materials `Material`), holding up to `maxItems` items and `maxVertices`
   * vertices in all. Throws RangeError for a capacity out of range, MargoError 'unsupported' without WebGPU.
   */
  static attach(engine: EngineKernel, material: Material, options: BatchedMeshOptions): BatchedMesh {
    if (!(material instanceof Material))
      throw new TypeError('BatchedMesh needs a materials Material; pass new Material({...})');
    if (!options || typeof options !== 'object')
      throw new TypeError('BatchedMesh needs options; pass {maxItems, maxVertices}');
    const batch = new BatchedMesh(engine, material, options);
    try {
      engine.use(batch);
    } catch (error) {
      batch.mesh.dispose();
      throw error;
    }
    return batch;
  }
  /** Items currently in the batch. */
  get count(): number {
    return this.live;
  }
  /** Vertices and indices in use, including ranges of removed items not yet reused. */
  get usage(): { vertices: number; indices: number } {
    return { vertices: this.nextVertex, indices: this.nextIndex };
  }
  /**
   * Adds a copy of `geometry` (the `createMesh` geometry shape; its own vertex colours are kept and tinted) and returns
   * the item's id, reusing the space of a removed item when it fits. Throws RangeError when the batch is full.
   */
  add(geometry: MeshGeometry, options: BatchedItemOptions = {}): number {
    this.live_();
    const data = packGeometry(geometry),
      vertices = data.vertices.length / 20,
      indices = data.indices.length;
    if (this.live >= this.maxItems)
      throw new RangeError(`BatchedMesh holds ${this.maxItems} items; remove one or create a larger batch`);
    let range: Range | undefined;
    const reuse = this.free.findIndex((r) => r.vertices >= vertices && r.indices >= indices);
    if (reuse >= 0) range = this.free.splice(reuse, 1)[0];
    else if (this.nextVertex + vertices <= this.maxVertices && this.nextIndex + indices <= this.maxIndices) {
      range = { vertex: this.nextVertex, vertices, index: this.nextIndex, indices };
      this.nextVertex += vertices;
      this.nextIndex += indices;
    } else
      throw new RangeError(
        `BatchedMesh is out of space for ${vertices} vertices and ${indices} indices; create it with a larger maxVertices or maxIndices`,
      );
    const id = this.freeIds.pop() ?? this.ranges.length;
    this.ranges[id] = range;
    this.live++;
    const primitive = this.mesh.primitives[0];
    primitive.vertices.set(data.vertices, range.vertex * 20);
    primitive.indices.fill(range.vertex, range.index, range.index + range.indices);
    for (let i = 0; i < indices; i++) primitive.indices[range.index + i] = data.indices[i] + range.vertex;
    this.owner.fill(NONE, range.vertex, range.vertex + range.vertices);
    this.owner.fill(id, range.vertex, range.vertex + vertices);
    const box = this.local;
    box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], id * 6);
    for (let i = 0; i < data.vertices.length; i += 20)
      for (let axis = 0; axis < 3; axis++) {
        box[id * 6 + axis] = Math.min(box[id * 6 + axis], data.vertices[i + axis]);
        box[id * 6 + 3 + axis] = Math.max(box[id * 6 + 3 + axis], data.vertices[i + axis]);
      }
    this.items.set(identity, id * ITEM);
    this.items.fill(1, id * ITEM + 16, id * ITEM + 20);
    try {
      if (options.matrix !== undefined) this.setMatrix(id, options.matrix);
      if (options.color !== undefined) this.setColor(id, options.color);
      if (options.visible !== undefined) this.setVisible(id, options.visible);
    } catch (error) {
      this.remove(id);
      throw error;
    }
    this.mark(this.dirtyItems, id, id + 1);
    this.mark(this.dirtyVertices, range.vertex, range.vertex + range.vertices);
    this.mark(this.dirtyIndices, range.index, range.index + range.indices);
    return id;
  }
  /** Removes item `id`; later `add` calls reuse its space. Throws RangeError for an id not in the batch. */
  remove(id: number): void {
    const range = this.range(id),
      primitive = this.mesh.primitives[0];
    this.owner.fill(NONE, range.vertex, range.vertex + range.vertices);
    primitive.indices.fill(range.vertex, range.index, range.index + range.indices);
    this.items[id * ITEM + 19] = 0;
    this.ranges[id] = undefined;
    this.freeIds.push(id);
    this.free.push(range);
    this.live--;
    this.mark(this.dirtyItems, id, id + 1);
    this.mark(this.dirtyVertices, range.vertex, range.vertex + range.vertices);
    this.mark(this.dirtyIndices, range.index, range.index + range.indices);
  }
  /** Whether `id` is an item of this batch. */
  has(id: number): boolean {
    return Number.isInteger(id) && !!this.ranges[id];
  }
  /** Sets item `id`'s column-major matrix (16 finite numbers), relative to `mesh.root`. */
  setMatrix(id: number, matrix: ArrayLike<number>): this {
    this.range(id);
    if (!matrix || typeof matrix !== 'object' || matrix.length !== 16)
      throw new TypeError('BatchedMesh matrix needs 16 numbers; pass a column-major 4x4 matrix');
    for (let i = 0; i < 16; i++)
      if (typeof matrix[i] !== 'number' || !Number.isFinite(matrix[i]))
        throw new RangeError('BatchedMesh matrix has a non-finite value; pass finite numbers');
    this.items.set(matrix, id * ITEM);
    this.mark(this.dirtyItems, id, id + 1);
    return this;
  }
  /** Item `id`'s matrix, written into `out` (16 numbers) when given. */
  getMatrix(id: number, out: Float32Array | number[] = new Float32Array(16)): Float32Array | number[] {
    this.range(id);
    for (let i = 0; i < 16; i++) out[i] = this.items[id * ITEM + i];
    return out;
  }
  /** Sets item `id`'s tint: sRGB hex, CSS colour or linear `[r, g, b]`, multiplied into its vertex colours. */
  setColor(id: number, color: ColorInput): this {
    this.range(id);
    parseColor(color, this.items, id * ITEM + 16);
    this.mark(this.dirtyItems, id, id + 1);
    return this;
  }
  /** Item `id`'s linear rgb tint, written into `out` when given. */
  getColor(id: number, out: Float32Array | number[] = [0, 0, 0]): Float32Array | number[] {
    this.range(id);
    for (let i = 0; i < 3; i++) out[i] = this.items[id * ITEM + 16 + i];
    return out;
  }
  /** Shows or hides item `id` (a hidden item keeps its space and draws nothing). */
  setVisible(id: number, visible: boolean): this {
    this.range(id);
    if (typeof visible !== 'boolean')
      throw new TypeError('BatchedMesh visibility must be a boolean; pass true or false');
    this.items[id * ITEM + 19] = +visible;
    this.mark(this.dirtyItems, id, id + 1);
    return this;
  }
  /** Whether item `id` draws. */
  isVisible(id: number): boolean {
    this.range(id);
    return this.items[id * ITEM + 19] > 0.5;
  }
  /** The item a vertex of `mesh` belongs to (as a picking hit's vertex index gives), or -1 for unused space. */
  itemOf(vertex: number): number {
    const id = this.owner[vertex];
    return id === undefined || id === NONE ? -1 : id;
  }
  /**
   * World [minX, minY, minZ, maxX, maxY, maxZ] of item `id` (its geometry's box through its matrix and the batch
   * root), or of every visible item without `id`. Empty boxes are +Infinity/-Infinity.
   */
  bounds(id?: number): Float32Array {
    const out = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    if (id !== undefined) this.range(id);
    const root = this.mesh.primitives[0].node.matrix,
      m = new Float64Array(16);
    for (let k = id ?? 0; k < (id === undefined ? this.ranges.length : id + 1); k++) {
      if (!this.ranges[k] || (id === undefined && this.items[k * ITEM + 19] < 0.5)) continue;
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0;
          for (let j = 0; j < 4; j++) s += root[j * 4 + r] * this.items[k * ITEM + c * 4 + j];
          m[c * 4 + r] = s;
        }
      for (let corner = 0; corner < 8; corner++) {
        const x = this.local[k * 6 + (corner & 1 ? 3 : 0)],
          y = this.local[k * 6 + (corner & 2 ? 4 : 1)],
          z = this.local[k * 6 + (corner & 4 ? 5 : 2)];
        for (let axis = 0; axis < 3; axis++) {
          const v = m[axis] * x + m[4 + axis] * y + m[8 + axis] * z + m[12 + axis];
          out[axis] = Math.min(out[axis], v);
          out[axis + 3] = Math.max(out[axis + 3], v);
        }
      }
    }
    return out;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'BatchedMesh is disposed; create a new batch');
    const device = engine.gpu;
    if (!device)
      throw new MargoError(
        'unsupported',
        'BatchedMesh needs WebGPU; create the engine with webgpu; see https://margoengine.com/errors#webgpu',
      );
    const vertices = this.mesh.primitives[0].vertices;
    if (
      Math.max(vertices.byteLength, this.items.byteLength) >
      Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)
    )
      throw new RangeError('BatchedMesh buffers exceed the device storage limit; create a smaller batch');
    const pipeline =
      pipelines.get(device) ??
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: batchShader }), entryPoint: 'main' },
      });
    pipelines.set(device, pipeline);
    const buffers: GPUBuffer[] = [],
      buffer = (size: number, usage = GPUBufferUsage.STORAGE) => {
        const b = device.createBuffer({ size: Math.max(16, size), usage: usage | GPUBufferUsage.COPY_DST });
        buffers.push(b);
        return b;
      };
    this.unsubscribe ??= this.mesh.onDispose(() => this.dispose());
    const source = buffer(vertices.byteLength),
      output = buffer(vertices.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC),
      items = buffer(this.items.byteLength),
      owner = buffer(this.owner.byteLength),
      counts = buffer(16, GPUBufferUsage.UNIFORM);
    this.gpu = {
      buffers,
      source,
      output,
      items,
      owner,
      counts,
      pipeline,
      used: -1,
      group: device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [source, output, items, owner, counts].map((buffer, binding) => ({ binding, resource: { buffer } })),
      }),
    };
    // Everything uploads on the first update after (re)creating the buffers.
    this.mark(this.dirtyItems, 0, this.ranges.length);
    this.mark(this.dirtyVertices, 0, this.nextVertex);
    this.mark(this.dirtyIndices, 0, this.nextIndex);
    for (const p of this.mesh.primitives) p.deformed = output;
    this.mesh.prepareDeformation = this.prepare;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: -10, execute: (c) => this.update(c) });
  }
  private update(context: PassContext | PBRDeformationContext): void {
    const gpu = this.gpu;
    if (context.backend !== 'webgpu' || !gpu || this.mesh.disposed) return;
    const queue = context.device.queue,
      primitive = this.mesh.primitives[0],
      [v0, v1] = this.dirtyVertices,
      [i0, i1] = this.dirtyIndices,
      [k0, k1] = this.dirtyItems;
    let changed = this.changed;
    if (v0 < v1) {
      queue.writeBuffer(
        gpu.source,
        v0 * 80,
        primitive.vertices.subarray(v0 * 20, v1 * 20) as Float32Array<ArrayBuffer>,
      );
      queue.writeBuffer(gpu.owner, v0 * 4, this.owner.subarray(v0, v1));
      changed = true;
    }
    // The model's own index buffer, once it is set up on the device (before that, it uploads the CPU array).
    const index = primitive.buffers?.index;
    if (i0 < i1 && index) {
      queue.writeBuffer(index, i0 * 4, primitive.indices.subarray(i0, i1) as Uint32Array<ArrayBuffer>);
      this.dirtyIndices = [Infinity, -Infinity];
    }
    if (k0 < k1) {
      queue.writeBuffer(gpu.items, k0 * ITEM * 4, this.items.subarray(k0 * ITEM, k1 * ITEM));
      changed = true;
    }
    this.dirtyVertices = [Infinity, -Infinity];
    this.dirtyItems = [Infinity, -Infinity];
    if (gpu.used !== this.nextVertex) {
      gpu.used = this.nextVertex;
      queue.writeBuffer(gpu.counts, 0, new Uint32Array([this.nextVertex, 0, 0, 0]));
      changed = true;
    }
    this.changed = false;
    // The output keeps the last result, so an unchanged batch costs no dispatch.
    if (!changed || !this.nextVertex) return;
    const pass = context.encoder.beginComputePass();
    try {
      pass.setPipeline(gpu.pipeline);
      pass.setBindGroup(0, gpu.group);
      pass.dispatchWorkgroups(Math.ceil(this.nextVertex / 64));
    } finally {
      pass.end();
    }
  }
  private mark(range: [number, number], from: number, to: number): void {
    range[0] = Math.min(range[0], from);
    range[1] = Math.max(range[1], to);
  }
  private live_(): void {
    if (this.disposed || this.mesh.disposed)
      throw new MargoError('disposed', 'BatchedMesh is disposed; create a new batch');
  }
  private range(id: number): Range {
    this.live_();
    const range = Number.isInteger(id) ? this.ranges[id] : undefined;
    if (!range) throw new RangeError(`BatchedMesh has no item ${id}; use an id that add returned`);
    return range;
  }
  private release(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    if (this.mesh.prepareDeformation === this.prepare) this.mesh.prepareDeformation = undefined;
    for (const p of this.mesh.primitives) if (p.deformed === gpu.output) p.deformed = undefined;
    for (const b of gpu.buffers) b.destroy();
    this.gpu = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.changed = true;
    this.setup(engine);
  }
  /** Removes the batch and its mesh and frees the GPU buffers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.mesh.root.engine.removePlugin(this.name);
    if (!this.mesh.disposed) this.mesh.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
