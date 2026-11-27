/// <reference lib="esnext.disposable" preserve="true" />
// Many distinct geometries in one materials mesh, so one draw call per pass (beauty, each shadow cascade, SSAO).
// A geometry is stored once (addGeometry) and each item drawing it (addInstance) takes an output vertex and index
// range; a compute pass writes the drawn vertices from the stored geometry and each item's matrix, colour and
// visibility whenever one changes, through gltf/pbr's deformation hook (the same one skins use), so shadows, clustered
// lights, fog, IBL, SSAO and picking all draw the batch as they draw any materials mesh.
//
// Item sorting: when the engine's material sort mode for this material (setMaterialSortModes) is front-to-back or
// back-to-front, the index buffer is rewritten on the GPU in item order by squared camera distance to each item's box
// centre, as plain materials meshes sort by their origin: a key per item, Batcher's bitonic network (K. E. Batcher,
// "Sorting networks and their applications", AFIPS 1968, https://doi.org/10.1145/1468075.1468121), the item index
// counts summed in sorted order by a Hillis-Steele scan (W. D. Hillis and G. L. Steele, "Data parallel algorithms",
// CACM 29(12), 1986, https://doi.org/10.1145/7902.7903; G. E. Blelloch, "Prefix sums and their applications", CMU-CS-90-
// 190, 1990), then each index scattered to its item's sorted place. A stable network suits the small, sparse key sets
// of a batch; a radix sort (D. Merrill and A. Grimshaw, "High performance and scalable radix sorting", Parallel
// Processing Letters 21(2), 2011, https://doi.org/10.1142/S0129626411000187) pays off only at millions of keys.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { PBRDeformationContext } from '@margoengine/gltf/pbr';
import { MargoError } from '@margoengine/math/errors';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import {
  Material,
  createMesh,
  packGeometry,
  sortSettings,
  type MaterialMesh,
  type MaterialSortMode,
  type MeshGeometry,
} from './built-material.js';
import { clearPoseSource, setPoseSource, type PoseSource } from '../../shared/pose-source.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; COPY_DST: number; COPY_SRC: number; UNIFORM: number };
declare const GPUShaderStage: { COMPUTE: number };

/** Capacity of a {@link BatchedMesh}, fixed at creation. */
export interface BatchedMeshOptions {
  /** Items the batch holds at once, 1 to 1,000,000. */
  maxItems: number;
  /** Vertices of all items together, 3 to 1,000,000. */
  maxVertices: number;
  /** Indices of all items together, a positive multiple of 3. Default `maxVertices * 2` rounded up to triangles. */
  maxIndices?: number;
  /** Vertices of all stored geometries together (`addGeometry`, and `add` stores one per item), 3 to 1,000,000. Default `maxVertices`. */
  maxGeometryVertices?: number;
  /** Draw order among materials meshes (as `createMesh`). Default 0. */
  renderOrder?: number;
  /**
   * Order of the items inside the batch's one draw: `'auto'` (default) follows the engine's material sort mode for
   * this material (`setMaterialSortModes`: transparent `'back-to-front'`, opaque `'manual'` by default), and
   * `'manual'`, `'front-to-back'` or `'back-to-front'` choose one. Sorted items order by squared camera distance to
   * their box centre, on the GPU. Live as `batch.sort`.
   */
  sort?: MaterialSortMode | 'auto';
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
// What the compute pass writes for a hidden or free slot: position at the origin, normal +z, tangent +x.
const COLLAPSED = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
/** @internal The batch compute pass: one invocation per vertex slot, reading its item's matrix and tint. */
export const batchShader: string = /* wgsl */ `
struct Vertex {position:vec4f,normal:vec4f,tangent:vec4f,uv:vec4f,color:vec4f}
struct Item {matrix:mat4x4f,tint:vec4f}
@group(0) @binding(0) var<storage,read> source:array<Vertex>;
@group(0) @binding(1) var<storage,read_write> output:array<Vertex>;
@group(0) @binding(2) var<storage,read> items:array<Item>;
@group(0) @binding(3) var<storage,read> owner:array<u32>;
@group(0) @binding(4) var<uniform> counts:vec4u;
@group(0) @binding(5) var<storage,read> sourceOf:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=counts.x){return;}
  var v=source[sourceOf[id.x]];let k=owner[id.x];
  if(k==0xffffffffu||items[k].tint.w<0.5){output[id.x]=Vertex(vec4f(0,0,0,1),vec4f(0,0,1,0),vec4f(1,0,0,1),v.uv,v.color);return;}
  let m=items[k].matrix;
  let normalMatrix=mat3x3f(cross(m[1].xyz,m[2].xyz),cross(m[2].xyz,m[0].xyz),cross(m[0].xyz,m[1].xyz));
  let handedness=select(-1.0,1.0,dot(m[0].xyz,cross(m[1].xyz,m[2].xyz))>=0.0);let bent=normalMatrix*v.normal.xyz*handedness;
  v.position=vec4f((m*vec4f(v.position.xyz,1)).xyz,1);
  v.normal=vec4f(normalize(select(vec3f(0,1,0),bent,dot(bent,bent)>0.0)),0);
  v.tangent=vec4f((m*vec4f(v.tangent.xyz,0)).xyz,v.tangent.w*handedness);
  v.color=vec4f(v.color.rgb*items[k].tint.rgb,v.color.a);output[id.x]=v;
}
`;
/** @internal The item sort: keys, bitonic network, ranks, index-count scan and index scatter (see the file head). */
export const batchSortShader: string = /* wgsl */ `
struct Item {matrix:mat4x4f,tint:vec4f}
struct Info {center:vec4f,range:vec4u}
struct Key {depth:f32,index:u32}
struct Params {root:mat4x4f,eye:vec4f,dims:vec4u,step:vec4u}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> items:array<Item>;
@group(0) @binding(2) var<storage,read> info:array<Info>;
@group(0) @binding(3) var<storage,read_write> keys:array<Key>;
@group(0) @binding(4) var<storage,read_write> ranks:array<u32>;
@group(0) @binding(5) var<storage,read_write> scan:array<u32>;
@group(0) @binding(6) var<storage,read> owner:array<u32>;
@group(0) @binding(7) var<storage,read> indices:array<u32>;
@group(0) @binding(8) var<storage,read_write> sorted:array<u32>;
fn less(a:Key,b:Key)->bool {
 if(a.index==0xffffffffu){return false;}if(b.index==0xffffffffu){return true;}
 if(a.depth<b.depth){return true;}if(a.depth>b.depth){return false;}return a.index<b.index;
}
@compute @workgroup_size(64) fn seed(@builtin(global_invocation_id) g:vec3u){
 let i=g.x;if(i>=u.dims.x){return;}
 var k=Key(0.0,0xffffffffu);
 if(i<u.dims.z){
  ranks[i]=0xffffffffu;
  if(info[i].range.z==1u&&items[i].tint.w>=0.5){
   let d=(u.root*items[i].matrix*vec4f(info[i].center.xyz,1.0)).xyz-u.eye.xyz;let r=dot(d,d);
   k=Key(select(r,-r,u.dims.w==1u),i);
  }
 }
 keys[i]=k;
}
@compute @workgroup_size(64) fn network(@builtin(global_invocation_id) g:vec3u){
 let i=g.x;let j=i^u.step.x;if(i>=u.dims.x||j>=u.dims.x||i>=j){return;}
 let a=keys[i];let b=keys[j];let ascending=(i&u.step.y)==0u;
 if((ascending&&less(b,a))||(!ascending&&less(a,b))){keys[i]=b;keys[j]=a;}
}
@compute @workgroup_size(64) fn rank(@builtin(global_invocation_id) g:vec3u){
 let r=g.x;if(r>=u.dims.x){return;}
 let k=keys[r].index;var c=0u;
 if(k!=0xffffffffu){ranks[k]=r;c=info[k].range.y;}
 scan[r]=c;
}
@compute @workgroup_size(64) fn sum(@builtin(global_invocation_id) g:vec3u){
 let i=g.x;if(i>=u.dims.x){return;}
 let n=u.dims.x;let base=u.step.y*n;var v=scan[base+i];
 if(i>=u.step.x){v+=scan[base+i-u.step.x];}
 scan[(1u-u.step.y)*n+i]=v;
}
@compute @workgroup_size(64) fn scatter(@builtin(global_invocation_id) g:vec3u){
 let p=g.x;if(p>=u.dims.y){return;}
 let k=owner[p];if(k==0xffffffffu){return;}
 let r=ranks[k];if(r==0xffffffffu){return;}
 let start=scan[u.step.y*u.dims.x+r]-info[k].range.y;
 sorted[start+p-info[k].range.x]=indices[p];
}
`;
const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();
const sortPipelines = new WeakMap<
  GPUDevice,
  { layout: GPUBindGroupLayout } & Record<'seed' | 'network' | 'rank' | 'sum' | 'scatter', GPUComputePipeline>
>();
let serial = 0;
type Range = { vertex: number; vertices: number; index: number; indices: number };
/** A stored geometry: its vertices at `source` in the store, its own indices, local box and users. */
type Shape = { source: number; vertices: number; indices: Uint32Array; box: Float32Array; users: number; own: boolean };
// Per item for the sort: box centre (4 floats), then index start, index count and a live flag (4 words).
const INFO = 8;
const sortModes = ['auto', 'manual', 'front-to-back', 'back-to-front'] as const;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Root times item matrix, for bounds().
const product = new Float64Array(16);

/**
 * Many different geometries drawn as one materials mesh: one draw call per pass however many items it holds, each
 * item with its own matrix, colour and visibility. `BatchedMesh.attach(engine, material, {maxItems, maxVertices})`,
 * then `batch.add(geometry, {matrix, color})` per item, or `batch.addGeometry(geometry)` once and
 * `batch.addInstance(geometryId, {matrix, color})` per item to store a shared geometry once. Each item draws its own
 * range of posed vertices; for thousands of copies of one geometry `createInstancedMesh` is lighter. Moving, tinting or
 * hiding an item costs 20 floats of upload and a compute pass over the used vertices on the next frame; an unchanged
 * batch costs nothing. Items sort by camera distance as the engine's material sort mode says (`sort`). `batch.mesh` takes
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
  readonly maxGeometryVertices: number;
  private readonly items: Float32Array<ArrayBuffer>;
  private readonly owner: Uint32Array<ArrayBuffer>;
  /** Store vertex each output vertex reads (0 for unused slots). */
  private readonly sourceOf: Uint32Array<ArrayBuffer>;
  /** Stored geometries' packed vertices (20 floats each), read by the compute pass. */
  private readonly store: Float32Array<ArrayBuffer>;
  private readonly shapes: (Shape | undefined)[] = [];
  private freeShapeIds: number[] = [];
  private storeFree: { start: number; count: number }[] = [];
  private storeNext = 0;
  /** Shape of each item. */
  private readonly itemShape: number[] = [];
  /** Item owning each index slot (NONE for free space), for the sort's scatter. */
  private readonly indexOwner: Uint32Array<ArrayBuffer>;
  /** Per item: box centre, index start and count, live flag (INFO words). */
  private readonly info: ArrayBuffer;
  private mode: MaterialSortMode | 'auto' = 'auto';
  private dirtyStore: [number, number] = [Infinity, -Infinity];
  private sorter?: {
    n: number;
    uniform: GPUBuffer;
    keys: GPUBuffer;
    ranks: GPUBuffer;
    scan: GPUBuffer;
    info: GPUBuffer;
    indexOwner: GPUBuffer;
    indices: GPUBuffer;
    sorted: GPUBuffer;
    group: GPUBindGroup;
    /** What the last sort saw: order, revision, eye and root; a rerun is needed when any differs. */
    last: string;
  };
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
    sourceOf: GPUBuffer;
    counts: GPUBuffer;
    group: GPUBindGroup;
    pipeline: GPUComputePipeline;
    used: number;
  };
  private unsubscribe?: () => void;
  private readonly prepare = (context: PBRDeformationContext) => this.update(context);
  /** Bumped by every change the compute pass would draw (items, vertices, owners). */
  private revision = 0;
  private posed?: { vertices: Float32Array; revision: number };
  /**
   * The batch's CPU pose (packages/shared/pose-source.js), so a synchronous raycast or an AssemblyBVH tests the items
   * where they are drawn: the compute pass's arithmetic term for term (batchShader), each vertex through its item's
   * matrix, hidden and free slots collapsed to the origin. Evaluated on demand, once per change.
   */
  private readonly pose: PoseSource = () => {
    const gpu = this.gpu,
      primitive = this.mesh.primitives[0];
    if (!gpu || this.disposed || primitive.deformed !== gpu.output) return undefined;
    const posed = (this.posed ??= { vertices: new Float32Array(primitive.vertices.length), revision: -1 });
    if (posed.revision === this.revision) return posed;
    const out = posed.vertices,
      source = primitive.vertices,
      items = this.items;
    for (let i = 0; i < this.nextVertex; i++) {
      const v = i * 20,
        k = this.owner[i],
        q = k * ITEM;
      out.set(source.subarray(v + 12, v + 20), v + 12);
      if (k === NONE || items[q + 19] < 0.5) {
        out.set(COLLAPSED, v);
        continue;
      }
      const m = items.subarray(q, q + 16),
        // Normal matrix columns: the cross products of the matrix columns (its cofactors, as the shader builds them).
        c0x = m[5] * m[10] - m[6] * m[9],
        c0y = m[6] * m[8] - m[4] * m[10],
        c0z = m[4] * m[9] - m[5] * m[8],
        c1x = m[9] * m[2] - m[10] * m[1],
        c1y = m[10] * m[0] - m[8] * m[2],
        c1z = m[8] * m[1] - m[9] * m[0],
        c2x = m[1] * m[6] - m[2] * m[5],
        c2y = m[2] * m[4] - m[0] * m[6],
        c2z = m[0] * m[5] - m[1] * m[4],
        hand = m[0] * c0x + m[1] * c0y + m[2] * c0z >= 0 ? 1 : -1,
        [px, py, pz] = [source[v], source[v + 1], source[v + 2]],
        [nx, ny, nz] = [source[v + 4], source[v + 5], source[v + 6]],
        [tx, ty, tz] = [source[v + 8], source[v + 9], source[v + 10]],
        bx = (c0x * nx + c1x * ny + c2x * nz) * hand,
        by = (c0y * nx + c1y * ny + c2y * nz) * hand,
        bz = (c0z * nx + c1z * ny + c2z * nz) * hand,
        length = Math.hypot(bx, by, bz);
      out[v] = m[0] * px + m[4] * py + m[8] * pz + m[12];
      out[v + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
      out[v + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
      out[v + 3] = 1;
      if (length > 0) out.set([bx / length, by / length, bz / length, 0], v + 4);
      else out.set([0, 1, 0, 0], v + 4);
      out[v + 8] = m[0] * tx + m[4] * ty + m[8] * tz;
      out[v + 9] = m[1] * tx + m[5] * ty + m[9] * tz;
      out[v + 10] = m[2] * tx + m[6] * ty + m[10] * tz;
      out[v + 11] = source[v + 11] * hand;
      for (let c = 0; c < 3; c++) out[v + 16 + c] = source[v + 16 + c] * items[q + 16 + c];
    }
    posed.revision = this.revision;
    return posed;
  };

  private constructor(
    engine: EngineKernel,
    private readonly material: Material,
    o: BatchedMeshOptions,
  ) {
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
    const maxGeometryVertices = o.maxGeometryVertices ?? maxVertices;
    if (!Number.isSafeInteger(maxGeometryVertices) || maxGeometryVertices < 3 || maxGeometryVertices > 1_000_000)
      throw new RangeError(
        'BatchedMesh maxGeometryVertices must be an integer from 3 to 1,000,000; pass a smaller capacity',
      );
    this.maxIndices = maxIndices;
    this.maxGeometryVertices = maxGeometryVertices;
    if (o.sort !== undefined) this.sort = o.sort;
    this.items = new Float32Array(maxItems * ITEM);
    this.owner = new Uint32Array(maxVertices).fill(NONE);
    this.sourceOf = new Uint32Array(maxVertices);
    this.store = new Float32Array(maxGeometryVertices * 20);
    this.indexOwner = new Uint32Array(maxIndices).fill(NONE);
    this.info = new ArrayBuffer(maxItems * INFO * 4);
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
   * the item's id, reusing the space of a removed item when it fits. The geometry is stored for this item alone and
   * freed with it; store one geometry for many items with {@link BatchedMesh.addGeometry} and
   * {@link BatchedMesh.addInstance}. Throws RangeError when the batch is full.
   */
  add(geometry: MeshGeometry, options: BatchedItemOptions = {}): number {
    this.live_();
    if (this.live >= this.maxItems)
      throw new RangeError(`BatchedMesh holds ${this.maxItems} items; remove one or create a larger batch`);
    const data = packGeometry(geometry);
    this.outputRange(data.vertices.length / 20, data.indices.length, false);
    const shape = this.storeShape(data);
    this.shapes[shape]!.own = true;
    try {
      return this.addInstance(shape, options);
    } catch (error) {
      // A refused option already freed the geometry with its item.
      if (this.hasGeometry(shape)) this.removeGeometry(shape);
      throw error;
    }
  }
  /**
   * Stores `geometry` once and returns its geometry id, for {@link BatchedMesh.addInstance}: every item of one stored
   * geometry reads the same stored vertices (packed, uploaded and kept once). It draws nothing until an instance is
   * added. Throws RangeError when `maxGeometryVertices` has no room for it.
   */
  addGeometry(geometry: MeshGeometry): number {
    this.live_();
    return this.storeShape(packGeometry(geometry));
  }
  private storeShape(data: { vertices: Float32Array; indices: ArrayLike<number> }): number {
    const vertices = data.vertices.length / 20;
    let source: number;
    const reuse = this.storeFree.findIndex((r) => r.count >= vertices);
    if (reuse >= 0) {
      const free = this.storeFree[reuse];
      source = free.start;
      if (free.count === vertices) this.storeFree.splice(reuse, 1);
      else {
        free.start += vertices;
        free.count -= vertices;
      }
    } else if (this.storeNext + vertices <= this.maxGeometryVertices) {
      source = this.storeNext;
      this.storeNext += vertices;
    } else
      throw new RangeError(
        `BatchedMesh has no room to store ${vertices} more geometry vertices; remove geometries or create it with a larger maxGeometryVertices`,
      );
    this.store.set(data.vertices, source * 20);
    const box = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < data.vertices.length; i += 20)
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis], data.vertices[i + axis]);
        box[3 + axis] = Math.max(box[3 + axis], data.vertices[i + axis]);
      }
    const id = this.freeShapeIds.pop() ?? this.shapes.length;
    this.shapes[id] = { source, vertices, indices: Uint32Array.from(data.indices), box, users: 0, own: false };
    this.mark(this.dirtyStore, source, source + vertices);
    return id;
  }
  /**
   * Adds an item drawing stored geometry `geometryId` (from {@link BatchedMesh.addGeometry}) and returns its id. The
   * item takes its own range of drawn vertices and indices, reusing a removed item's space when it fits. Throws
   * RangeError for an unknown geometry or when the batch is full.
   */
  addInstance(geometryId: number, options: BatchedItemOptions = {}): number {
    const shape = this.shape(geometryId),
      vertices = shape.vertices,
      indices = shape.indices.length;
    if (this.live >= this.maxItems)
      throw new RangeError(`BatchedMesh holds ${this.maxItems} items; remove one or create a larger batch`);
    const range = this.outputRange(vertices, indices, true)!;
    const id = this.freeIds.pop() ?? this.ranges.length;
    this.ranges[id] = range;
    this.itemShape[id] = geometryId;
    shape.users++;
    this.live++;
    const primitive = this.mesh.primitives[0];
    primitive.vertices.set(this.store.subarray(shape.source * 20, (shape.source + vertices) * 20), range.vertex * 20);
    primitive.indices.fill(range.vertex, range.index, range.index + range.indices);
    for (let i = 0; i < indices; i++) primitive.indices[range.index + i] = shape.indices[i] + range.vertex;
    this.owner.fill(NONE, range.vertex, range.vertex + range.vertices);
    this.owner.fill(id, range.vertex, range.vertex + vertices);
    this.sourceOf.fill(0, range.vertex, range.vertex + range.vertices);
    for (let i = 0; i < vertices; i++) this.sourceOf[range.vertex + i] = shape.source + i;
    this.indexOwner.fill(id, range.index, range.index + range.indices);
    this.local.set(shape.box, id * 6);
    const box = shape.box,
      f = new Float32Array(this.info, id * INFO * 4, INFO),
      w = new Uint32Array(this.info, id * INFO * 4, INFO);
    for (let axis = 0; axis < 3; axis++) f[axis] = (box[axis] + box[3 + axis]) / 2;
    f[3] = 1;
    w.set([range.index, range.indices, 1, 0], 4);
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
  /**
   * Removes item `id`; later items reuse its space. An item made by `add` frees its geometry with it; a geometry from
   * `addGeometry` stays stored. Throws RangeError for an id not in the batch.
   */
  remove(id: number): void {
    const range = this.range(id),
      primitive = this.mesh.primitives[0],
      shapeId = this.itemShape[id],
      shape = this.shapes[shapeId]!;
    this.owner.fill(NONE, range.vertex, range.vertex + range.vertices);
    this.indexOwner.fill(NONE, range.index, range.index + range.indices);
    primitive.indices.fill(range.vertex, range.index, range.index + range.indices);
    this.items[id * ITEM + 19] = 0;
    new Uint32Array(this.info, id * INFO * 4, INFO)[6] = 0;
    this.ranges[id] = undefined;
    this.freeIds.push(id);
    this.free.push(range);
    this.live--;
    shape.users--;
    this.mark(this.dirtyItems, id, id + 1);
    this.mark(this.dirtyVertices, range.vertex, range.vertex + range.vertices);
    this.mark(this.dirtyIndices, range.index, range.index + range.indices);
    if (shape.own && !shape.users) this.removeGeometry(shapeId);
  }
  /**
   * Removes stored geometry `geometryId` and every item drawing it; its stored vertices are reused by later
   * geometries. Throws RangeError for an unknown geometry id.
   */
  removeGeometry(geometryId: number): void {
    const shape = this.shape(geometryId);
    shape.own = false;
    for (let id = 0; id < this.ranges.length && shape.users; id++)
      if (this.ranges[id] && this.itemShape[id] === geometryId) this.remove(id);
    this.shapes[geometryId] = undefined;
    this.freeShapeIds.push(geometryId);
    this.freeStore(shape.source, shape.vertices);
  }
  /** Returns stored vertices to the free list, merged with free neighbours and with the unused tail. */
  private freeStore(start: number, count: number): void {
    const list = this.storeFree;
    list.push({ start, count });
    list.sort((a, b) => a.start - b.start);
    for (let i = list.length - 1; i > 0; i--)
      if (list[i - 1].start + list[i - 1].count === list[i].start) {
        list[i - 1].count += list[i].count;
        list.splice(i, 1);
      }
    const last = list[list.length - 1];
    if (last && last.start + last.count === this.storeNext) {
      this.storeNext = last.start;
      list.pop();
    }
  }
  /** Whether `geometryId` is a stored geometry of this batch. */
  hasGeometry(geometryId: number): boolean {
    return Number.isInteger(geometryId) && !!this.shapes[geometryId];
  }
  /** The stored geometry item `id` draws. */
  getGeometryId(id: number): number {
    this.range(id);
    return this.itemShape[id];
  }
  /** Stored geometries and the vertices they use (freed space included until reused). */
  get geometryUsage(): { geometries: number; vertices: number } {
    return { geometries: this.shapes.filter(Boolean).length, vertices: this.storeNext };
  }
  /**
   * Order of the items in the batch's draw: `'auto'` (follow the engine's material sort mode for this material),
   * `'manual'` (item order), `'front-to-back'` or `'back-to-front'` (by squared camera distance to each item's box
   * centre, sorted on the GPU when the camera, an item or the order changes). Live.
   */
  get sort(): MaterialSortMode | 'auto' {
    return this.mode;
  }
  set sort(value: MaterialSortMode | 'auto') {
    if (!sortModes.includes(value))
      throw new TypeError(
        `BatchedMesh sort ${String(value)} is invalid; pass 'auto', 'manual', 'front-to-back' or 'back-to-front'`,
      );
    this.mode = value;
    // Back to item order, or a fresh sort, from the next frame.
    if (this.sorter) this.sorter.last = '';
    this.mark(this.dirtyIndices, 0, this.nextIndex);
  }
  /** The order in effect: `sort`, with `'auto'` resolved from the engine's material sort modes. */
  get order(): MaterialSortMode {
    if (this.mode !== 'auto') return this.mode;
    const modes = sortSettings(this.mesh.root.engine.frameGraph);
    return this.material.transparent ? modes.transparent : modes.opaque;
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
      // The matrix is stored as float32: a finite double past its range would become Infinity there.
      if (typeof matrix[i] !== 'number' || !Number.isFinite(Math.fround(matrix[i])))
        throw new RangeError('BatchedMesh matrix has a value that is not finite as float32; pass finite numbers');
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
    return this.boundsInto(new Float32Array(6), id);
  }
  /** As `bounds(id)`, written into `out` (6 numbers) and returned, so a caller that asks every frame allocates nothing. */
  boundsInto<T extends Float32Array | Float64Array | number[]>(out: T, id?: number): T {
    for (let i = 0; i < 6; i++) out[i] = i < 3 ? Infinity : -Infinity;
    if (id !== undefined) this.range(id);
    const root = this.mesh.primitives[0].node.matrix,
      m = product;
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
      Math.max(vertices.byteLength, this.store.byteLength, this.items.byteLength, this.maxIndices * 4) >
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
    const source = buffer(this.store.byteLength),
      output = buffer(vertices.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC),
      items = buffer(this.items.byteLength),
      owner = buffer(this.owner.byteLength),
      sourceOf = buffer(this.sourceOf.byteLength),
      counts = buffer(16, GPUBufferUsage.UNIFORM);
    this.gpu = {
      buffers,
      source,
      output,
      items,
      owner,
      sourceOf,
      counts,
      pipeline,
      used: -1,
      group: device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [source, output, items, owner, counts, sourceOf].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      }),
    };
    // Everything uploads on the first update after (re)creating the buffers.
    this.mark(this.dirtyItems, 0, this.ranges.length);
    this.mark(this.dirtyVertices, 0, this.nextVertex);
    this.mark(this.dirtyStore, 0, this.storeNext);
    this.mark(this.dirtyIndices, 0, this.nextIndex);
    for (const p of this.mesh.primitives) {
      p.deformed = output;
      setPoseSource(p, this.pose);
    }
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
    const [s0, s1] = this.dirtyStore;
    if (s0 < s1) {
      queue.writeBuffer(gpu.source, s0 * 80, this.store.subarray(s0 * 20, s1 * 20));
      this.dirtyStore = [Infinity, -Infinity];
      changed = true;
    }
    if (v0 < v1) {
      queue.writeBuffer(gpu.owner, v0 * 4, this.owner.subarray(v0, v1));
      queue.writeBuffer(gpu.sourceOf, v0 * 4, this.sourceOf.subarray(v0, v1));
      changed = true;
    }
    // The model's own index buffer, once it is set up on the device (before that, it uploads the CPU array).
    const index = primitive.buffers?.index;
    if (i0 < i1 && index) {
      queue.writeBuffer(index, i0 * 4, primitive.indices.subarray(i0, i1) as Uint32Array<ArrayBuffer>);
      if (this.sorter) {
        queue.writeBuffer(this.sorter.indices, i0 * 4, primitive.indices.subarray(i0, i1) as Uint32Array<ArrayBuffer>);
        queue.writeBuffer(this.sorter.indexOwner, i0 * 4, this.indexOwner.subarray(i0, i1));
        this.sorter.last = '';
      }
      this.dirtyIndices = [Infinity, -Infinity];
    }
    if (k0 < k1) {
      queue.writeBuffer(gpu.items, k0 * ITEM * 4, this.items.subarray(k0 * ITEM, k1 * ITEM));
      if (this.sorter) queue.writeBuffer(this.sorter.info, k0 * INFO * 4, this.info, k0 * INFO * 4, (k1 - k0) * INFO * 4);
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
    if (changed && this.nextVertex) {
      const pass = context.encoder.beginComputePass();
      try {
        pass.setPipeline(gpu.pipeline);
        pass.setBindGroup(0, gpu.group);
        pass.dispatchWorkgroups(Math.ceil(this.nextVertex / 64));
      } finally {
        pass.end();
      }
    }
    // Sorting needs the camera, which the frame graph pass has (the deformation hook does not).
    if ('camera' in context && index) this.sortItems(context, index);
  }
  /**
   * Rewrites the draw's index buffer in item order by camera distance when the order in effect sorts and the camera,
   * the root, an item or the order changed since the last sort; a 'manual' order puts the item order back.
   */
  private sortItems(context: Extract<PassContext, { backend: 'webgpu' }>, index: GPUBuffer): void {
    const order = this.order,
      device = context.device;
    if (order === 'manual') {
      if (this.sorter) {
        this.releaseSorter();
        // Item order again: the CPU indices are the unsorted ones.
        device.queue.writeBuffer(index, 0, this.mesh.primitives[0].indices.subarray(0, this.nextIndex) as Uint32Array<ArrayBuffer>);
      }
      return;
    }
    const slots = this.ranges.length,
      n = 2 ** Math.ceil(Math.log2(Math.max(2, slots)));
    let sorter = this.sorter;
    if (!sorter || sorter.n !== n) sorter = this.makeSorter(device, n);
    const eye = context.camera.position,
      root = this.mesh.primitives[0].node.matrix,
      seen = `${order}|${this.revision}|${eye[0]},${eye[1]},${eye[2]}|${Array.from(root).join(',')}`;
    if (seen === sorter.last || !this.nextIndex) return;
    sorter.last = seen;
    const stages: [string, number, number][] = [['seed', 0, 0]];
    for (let k = 2; k <= n; k *= 2) for (let j = k / 2; j >= 1; j /= 2) stages.push(['network', j, k]);
    stages.push(['rank', 0, 0]);
    let half = 0;
    for (let d = 1; d < n; d *= 2, half = 1 - half) stages.push(['sum', d, half]);
    stages.push(['scatter', 0, half]);
    const data = new ArrayBuffer(stages.length * 256),
      f = new Float32Array(data),
      u = new Uint32Array(data);
    stages.forEach(([, a, b], i) => {
      const at = i * 64;
      f.set(root, at);
      f.set([eye[0], eye[1], eye[2], 0], at + 16);
      u.set([n, this.nextIndex, slots, order === 'back-to-front' ? 1 : 0], at + 20);
      u.set([a, b, 0, 0], at + 24);
    });
    if (sorter.uniform.size < data.byteLength) {
      sorter.uniform.destroy();
      sorter.uniform = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      sorter.group = this.sortGroup(device, sorter);
    }
    device.queue.writeBuffer(sorter.uniform, 0, data);
    const pipes = sortPipelines.get(device)!,
      bytes = Math.ceil(this.nextIndex) * 4;
    context.encoder.clearBuffer(sorter.sorted, 0, bytes);
    const pass = context.encoder.beginComputePass();
    try {
      stages.forEach(([stage], i) => {
        pass.setPipeline(pipes[stage as 'seed']);
        pass.setBindGroup(0, sorter.group, [i * 256]);
        pass.dispatchWorkgroups(Math.ceil((stage === 'scatter' ? this.nextIndex : n) / 64));
      });
    } finally {
      pass.end();
    }
    context.encoder.copyBufferToBuffer(sorter.sorted, 0, index, 0, bytes);
  }
  private sortGroup(device: GPUDevice, sorter: NonNullable<BatchedMesh['sorter']>): GPUBindGroup {
    const gpu = this.gpu!;
    return device.createBindGroup({
      layout: sortPipelines.get(device)!.layout,
      entries: [
        { binding: 0, resource: { buffer: sorter.uniform, size: 128 } },
        ...[
          gpu.items,
          sorter.info,
          sorter.keys,
          sorter.ranks,
          sorter.scan,
          sorter.indexOwner,
          sorter.indices,
          sorter.sorted,
        ].map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
      ],
    });
  }
  /** The sort's buffers for `n` keys (a power of two), with the item records and indices uploaded whole. */
  private makeSorter(device: GPUDevice, n: number): NonNullable<BatchedMesh['sorter']> {
    if (!sortPipelines.has(device)) {
      const storage = (readOnly: boolean): GPUBindGroupLayoutEntry => ({
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: readOnly ? 'read-only-storage' : 'storage' },
        }),
        layout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
            ...[true, true, false, false, false, true, true, false].map((r, i) => ({ ...storage(r), binding: i + 1 })),
          ],
        }),
        module = device.createShaderModule({ code: batchSortShader }),
        pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        make = (entryPoint: string) =>
          device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
      sortPipelines.set(device, {
        layout,
        seed: make('seed'),
        network: make('network'),
        rank: make('rank'),
        sum: make('sum'),
        scatter: make('scatter'),
      });
    }
    this.releaseSorter();
    const buffer = (size: number, usage = GPUBufferUsage.STORAGE) =>
        device.createBuffer({ size: Math.max(16, size), usage: usage | GPUBufferUsage.COPY_DST }),
      indices = this.mesh.primitives[0].indices,
      sorter = {
        n,
        uniform: buffer(256, GPUBufferUsage.UNIFORM),
        keys: buffer(n * 8),
        ranks: buffer(this.maxItems * 4),
        scan: buffer(n * 8),
        info: buffer(this.info.byteLength),
        indexOwner: buffer(this.maxIndices * 4),
        indices: buffer(this.maxIndices * 4),
        sorted: buffer(this.maxIndices * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        group: undefined as unknown as GPUBindGroup,
        last: '',
      };
    sorter.group = this.sortGroup(device, sorter);
    device.queue.writeBuffer(sorter.info, 0, this.info);
    device.queue.writeBuffer(sorter.indexOwner, 0, this.indexOwner);
    device.queue.writeBuffer(sorter.indices, 0, indices as Uint32Array<ArrayBuffer>);
    return (this.sorter = sorter);
  }
  private releaseSorter(): void {
    const sorter = this.sorter;
    if (!sorter) return;
    for (const b of [sorter.uniform, sorter.keys, sorter.ranks, sorter.scan, sorter.info]) b.destroy();
    for (const b of [sorter.indexOwner, sorter.indices, sorter.sorted]) b.destroy();
    this.sorter = undefined;
  }
  private mark(range: [number, number], from: number, to: number): void {
    this.revision++;
    range[0] = Math.min(range[0], from);
    range[1] = Math.max(range[1], to);
  }
  private live_(): void {
    if (this.disposed || this.mesh.disposed)
      throw new MargoError('disposed', 'BatchedMesh is disposed; create a new batch');
  }
  /** A free output range for `vertices` and `indices` (taken when `take`), or RangeError when none fits. */
  private outputRange(vertices: number, indices: number, take: boolean): Range | undefined {
    const reuse = this.free.findIndex((r) => r.vertices >= vertices && r.indices >= indices);
    if (reuse >= 0) return take ? this.free.splice(reuse, 1)[0] : undefined;
    if (this.nextVertex + vertices <= this.maxVertices && this.nextIndex + indices <= this.maxIndices) {
      if (!take) return undefined;
      const range = { vertex: this.nextVertex, vertices, index: this.nextIndex, indices };
      this.nextVertex += vertices;
      this.nextIndex += indices;
      return range;
    }
    throw new RangeError(
      `BatchedMesh is out of space for ${vertices} vertices and ${indices} indices; create it with a larger maxVertices or maxIndices`,
    );
  }
  private shape(geometryId: number): Shape {
    this.live_();
    const shape = Number.isInteger(geometryId) ? this.shapes[geometryId] : undefined;
    if (!shape)
      throw new RangeError(`BatchedMesh has no geometry ${geometryId}; use an id that addGeometry returned`);
    return shape;
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
    for (const p of this.mesh.primitives) {
      if (p.deformed === gpu.output) p.deformed = undefined;
      clearPoseSource(p, this.pose);
    }
    for (const b of gpu.buffers) b.destroy();
    this.releaseSorter();
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
    // The scene this batch was attached to, not whichever scene is active now.
    const engine = this.mesh.root.engine;
    engine.sceneOf(this)?.removePlugin(this.name);
    if (!this.mesh.disposed) this.mesh.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
