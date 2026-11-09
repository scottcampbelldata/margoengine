/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type {
  Batch,
  Engine,
  EnginePlugin,
  FrameGraph,
  Geometry,
  PassContext,
  PbrMaterial,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { loadCompatRoute } from '../../shared/compat.js';

declare const GPUBufferUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
  VERTEX: number;
  UNIFORM: number;
  STORAGE: number;
  INDIRECT: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `DynamicInstances` settings. */
export interface DynamicInstancesOptions {
  /** Shared by every instance. Core meshes may use the same geometry; they keep their own batch. */
  geometry: Geometry;
  /** Shared by every instance; read every frame, so its setters work as on core meshes. Per-instance colour: `setColorAt`. */
  material: PbrMaterial;
  /** Most instances alive at once, 1 to 4,194,304 (and 96 bytes each within the device's storage binding size). Fixed. */
  capacity: number;
  /** Also drop instances whose bounding sphere spans fewer than this many CSS pixels in radius. Default 0 (frustum only). */
  minRadius?: number;
  /**
   * Allow mirrored transforms (negative determinant). Default false: single-sided instances then draw with core's
   * back-face-culled pipeline, and `setMatrixAt` refuses a mirrored matrix. Set true when any matrix mirrors; it is
   * required for mirrored matrices written straight into `matrices`.
   */
  mirrored?: boolean;
}

/** Floats per instance row in `matrices`: the 16-float column-major matrix without elements 3, 7, 11 and 15. */
const ROW = 12;
/** Instances per dirty block: one workgroup of the cull kernel. */
const BLOCK = 256;
/** `factors.w` of every record: past core's 2^23 entity ids, so a record never names a core mesh. */
const NO_MESH = 16777216;

// The cull kernel tests each live row like CulledMeshes; then the CulledMeshes scan and an order-keeping scatter build the
// kept rows' 96-byte core instance records and the indirect arguments. `fill` builds `world`, every row's record in row
// order (free, hidden and non-finite rows zero, which draws nothing), only for what reads it: shadows and picking. Written
// every frame it was 192 bytes of GPU memory traffic per instance that drawing never used.
const shader = `
struct Frame {camera:mat4x4f,planes:array<vec4f,6>,size:vec4f}
struct Part {count:u32,indices:u32,pad:vec2u,sphere:vec4f,factors:vec4f,base:vec4f}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<uniform> b:Part;
@group(0) @binding(2) var<storage,read> matrices:array<f32>;
@group(0) @binding(3) var<storage,read> rows:array<vec4u>;
@group(0) @binding(4) var<storage,read_write> world:array<Record>;
@group(0) @binding(5) var<storage,read_write> local:array<u32>;
@group(0) @binding(6) var<storage,read_write> groups:array<u32>;
@group(0) @binding(7) var<storage,read_write> drawn:array<Record>;
@group(0) @binding(8) var<storage,read_write> args:array<u32>;
var<workgroup> scratch:array<u32,256>;
// World sphere as core's kernel computes it (radius scaled by sqrt(norm1*normInf) of the 3x3), padded for float32.
fn keep(m:mat4x4f)->bool {
  let c=(m*vec4f(b.sphere.xyz,1.0)).xyz;let a=mat3x3f(abs(m[0].xyz),abs(m[1].xyz),abs(m[2].xyz));
  let one=vec3f(1.0);let cols=max(max(dot(a[0],one),dot(a[1],one)),dot(a[2],one));let rows=a[0]+a[1]+a[2];
  var r=b.sphere.w*sqrt(cols*max(max(rows.x,rows.y),rows.z));r+=1e-5*(length(c)+r);
  for(var p=0u;p<6u;p++){if(dot(f.planes[p].xyz,c)+f.planes[p].w< -r){return false;}}
  let w=dot(vec4f(f.camera[0].w,f.camera[1].w,f.camera[2].w,f.camera[3].w),vec4f(c,1.0));
  return f.size.z<=0.0||w<=r||r*f.size.y/w>=f.size.z;
}
fn finite(x:f32)->bool {return (bitcast<u32>(x)&0x7f800000u)!=0x7f800000u;}
fn shown(i:u32)->bool {
  let k=i*12u;var ok=rows[i].w==1u;for(var j=0u;j<12u;j++){ok=ok&&finite(matrices[k+j]);}
  return ok;
}
fn matrix(i:u32)->mat4x4f {
  let k=i*12u;return mat4x4f(vec4f(matrices[k],matrices[k+1u],matrices[k+2u],0.0),vec4f(matrices[k+3u],matrices[k+4u],matrices[k+5u],0.0),vec4f(matrices[k+6u],matrices[k+7u],matrices[k+8u],0.0),vec4f(matrices[k+9u],matrices[k+10u],matrices[k+11u],1.0));
}
fn record(i:u32)->Record {return Record(matrix(i),vec4f(b.base.rgb*bitcast<vec3f>(rows[i].xyz),1.0),b.factors);}
@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u) {
  let i=g.x;var v=0u;
  if(i<b.count){
    if(shown(i)&&keep(matrix(i))){v=1u;}
  }
  scratch[l]=v;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var t=0u;if(l>=o){t=scratch[l-o];}workgroupBarrier();scratch[l]+=t;workgroupBarrier();}
  if(i<b.count){local[i]=(scratch[l]-v)|(v<<31u);}
  if(l==255u){groups[w.x]=scratch[255];}
}
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) l:u32) {
  let n=(b.count+255u)/256u;let per=(n+255u)/256u;let lo=min(l*per,n);let hi=min(lo+per,n);
  var sum=0u;for(var k=lo;k<hi;k++){sum+=groups[k];}
  scratch[l]=sum;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var t=0u;if(l>=o){t=scratch[l-o];}workgroupBarrier();scratch[l]+=t;workgroupBarrier();}
  var run=scratch[l]-sum;for(var k=lo;k<hi;k++){let t=groups[k];groups[k]=run;run+=t;}
}
@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;
  if(i==0u&&b.count==0u){args[0]=b.indices;args[1]=0u;args[2]=0u;args[3]=0u;args[4]=0u;}
  if(i>=b.count){return;}
  let e=local[i];let v=e>>31u;let p=groups[i>>8u]+(e&0x7fffffffu);
  if(v==1u){drawn[p]=record(i);}
  if(i==b.count-1u){args[0]=b.indices;args[1]=p+v;args[2]=0u;args[3]=0u;args[4]=0u;}
}
@compute @workgroup_size(256) fn fill(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;
  if(i<b.count){var r:Record;if(shown(i)){r=record(i);}world[i]=r;}
}
`;
// Depth-only caster drawing for @margoengine/shadows (its cascade passes: depth32float, less-equal, no face culling).
const shadowShader = `
@group(0) @binding(0) var<uniform> light:mat4x4f;
struct Input {@location(0) p:vec3f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f}
@vertex fn vertex(i:Input)->@builtin(position) vec4f {return light*mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);}
`;
// One id per instance (its index), drawn into a 1x1 r32uint target for `pick`. Ids are the row order of `world`.
const pickShader = `
@group(0) @binding(0) var<uniform> camera:mat4x4f;
struct Input {@builtin(instance_index) n:u32,@location(0) p:vec3f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f}
struct Output {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) id:u32}
@vertex fn vertex(i:Input)->Output {var o:Output;o.clip=camera*mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);o.id=i.n;return o;}
@fragment fn fragment(i:Output)->@location(0) u32 {return i.id;}
`;
const instanceLayout: GPUVertexBufferLayout = {
  arrayStride: 96,
  stepMode: 'instance',
  attributes: [2, 3, 4, 5].map((shaderLocation, i) => ({
    shaderLocation,
    offset: i * 16,
    format: 'float32x4' as const,
  })),
};
const vertexLayout: GPUVertexBufferLayout = {
  arrayStride: 24,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
};

interface Buffers {
  frame: GPUBuffer;
  part: GPUBuffer;
  matrices: GPUBuffer;
  rows: GPUBuffer;
  world: GPUBuffer;
  local: GPUBuffer;
  groups: GPUBuffer;
  drawn: GPUBuffer;
  args: GPUBuffer;
}
let serial = 0;

/**
 * Many moving objects with a fixed amount of engine CPU work per frame, however many move, show, hide, appear or go.
 * Each instance is one row of `matrices` (12 floats); setters write a row and mark its block of 256 rows, and each frame
 * the plugin uploads the marked blocks (one `writeBuffer` per run of them). A compute pass then builds each live row's
 * matrix and bounding sphere, tests it against the frustum, and compacts the kept rows in index order with indirect
 * draw arguments. Core draws them as one batch (`Batch.redirect`) in its main pass and every replay of it, with its
 * own shader and every shader patch (shadow receiving, sections, fog); add the instances to `@margoengine/shadows` to
 * cast. WebGPU (and the WebGL2 compatibility layer, culling on the CPU there).
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class DynamicInstances implements EnginePlugin {
  readonly name = 'dynamic-instances:' + ++serial;
  /** Most instances alive at once. */
  readonly capacity: number;
  /**
   * One row of 12 floats per instance: the column-major affine matrix without its last row (elements 0-2, 4-6, 8-10,
   * 12-14 of the 16-float matrix). Bulk writers (physics, animation) write rows directly and call `update(from, to)`.
   * Rows of deleted or never-added instances are ignored. Non-finite rows draw nothing.
   */
  readonly matrices: Float32Array;
  /** See {@link DynamicInstancesOptions.minRadius}; may change at any time. */
  minRadius: number;
  /** See {@link DynamicInstancesOptions.mirrored}. */
  readonly mirrored: boolean;
  /** See {@link DynamicInstancesOptions.material}. */
  readonly material: PbrMaterial;
  disposed = false;
  protected readonly geometry: Geometry;
  /** Own batch identity: a geometry inheriting the caller's arrays, so core meshes of that geometry keep their batch. */
  protected readonly own: Geometry;
  /** Per row: rgb tint as floats and the state word (0 free, 1 shown, 2 hidden), as the GPU reads it (`vec4u`). */
  private readonly attributes: ArrayBuffer;
  private readonly tints: Float32Array;
  private readonly states: Uint32Array;
  private readonly free: Int32Array;
  private freeCount = 0;
  /** Rows the kernels visit: one past the highest row ever added. */
  protected high = 0;
  private live = 0;
  private readonly dirtyMatrices: Uint8Array;
  private readonly dirtyRows: Uint8Array;
  private dirty = false;
  private filled = false;
  protected engine?: Engine;
  protected device?: GPUDevice;
  protected buffers?: Buffers;
  private pipelines?: {
    cull: GPUComputePipeline;
    scan: GPUComputePipeline;
    scatter: GPUComputePipeline;
    fill: GPUComputePipeline;
    group: GPUBindGroup;
  };
  private shadow?: { pipeline: GPURenderPipeline; uniforms: GPUBuffer[]; groups: GPUBindGroup[] };
  private pickTarget?: {
    pipeline: GPURenderPipeline;
    uniform: GPUBuffer;
    ids: GPUTexture;
    depth: GPUTexture;
    matrix: Float32Array<ArrayBuffer>;
    group: GPUBindGroup;
    descriptor: GPURenderPassDescriptor;
  };
  private picking?: Promise<number | null>;
  private readonly frame = new Float32Array(44);
  private readonly part = new ArrayBuffer(64);
  private readonly partWords = new Uint32Array(this.part);
  private readonly partFloats = new Float32Array(this.part);
  private readonly sphere = new Float32Array(this.part, 16, 4);
  private batch?: Batch;
  private readonly redirect: { instances: GPUBuffer; args: GPUBuffer } = {} as never;
  private route?: ReturnType<typeof import('./compat.js').dynamicRoute>;

  /** Same as `engine.use(new DynamicInstances(options))`; returns the plugin. */
  static attach(engine: EngineKernel, options: DynamicInstancesOptions): DynamicInstances {
    const value = new DynamicInstances(options);
    engine.use(value);
    return value;
  }
  constructor({ geometry, material, capacity, minRadius = 0, mirrored = false }: DynamicInstancesOptions) {
    if (!geometry?.indices || !geometry.vertices || !geometry.bounds)
      throw new TypeError('Invalid dynamic instances geometry; pass a core Geometry such as box()');
    if (!(material?.data instanceof Float32Array))
      throw new TypeError('Invalid dynamic instances material; pass a core PbrMaterial');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4194304)
      throw new RangeError('Invalid dynamic instances capacity; pass a whole number from 1 to 4194304');
    if (typeof mirrored !== 'boolean') throw new TypeError('Invalid mirrored option; pass true or false');
    this.geometry = geometry;
    this.own = Object.create(geometry) as Geometry;
    this.material = material;
    this.capacity = capacity;
    this.minRadius = minRadius;
    this.mirrored = mirrored;
    this.check();
    this.matrices = new Float32Array(capacity * ROW);
    this.attributes = new ArrayBuffer(capacity * 16);
    this.tints = new Float32Array(this.attributes);
    this.states = new Uint32Array(this.attributes);
    this.free = new Int32Array(capacity);
    const blocks = Math.ceil(capacity / BLOCK);
    this.dirtyMatrices = new Uint8Array(blocks);
    this.dirtyRows = new Uint8Array(blocks);
  }
  private check(): void {
    if (!(this.minRadius >= 0 && this.minRadius < 1e6))
      throw new RangeError('Invalid dynamic instances minRadius; set a number from 0 up to 1e6');
  }
  /** Instances alive (added and not deleted), shown or hidden. */
  get count(): number {
    return this.live;
  }
  /**
   * The GPU copy of `matrices` (12 floats per row, storage usage), for an app compute pass that animates instances on
   * the GPU without any upload. Undefined until the first frame and after device loss. Rows written here are
   * overwritten by later CPU writes to the same block.
   */
  get transforms(): GPUBuffer | undefined {
    return this.buffers?.matrices;
  }

  /**
   * Adds an instance and returns its index (deleted indices are reused first, lowest-freed last). `matrix`: 16-float
   * column-major affine world matrix, default identity. Shown, with no tint.
   * @throws RangeError when all `capacity` instances are alive, or for an invalid matrix.
   */
  addInstance(matrix?: ArrayLike<number>): number {
    if (this.live >= this.capacity)
      throw new RangeError(
        `No free instance: all ${this.capacity} are alive; delete one or create DynamicInstances with a larger capacity`,
      );
    const index = this.freeCount ? this.free[--this.freeCount] : this.high++;
    this.live++;
    const t = index * 4;
    this.tints[t] = this.tints[t + 1] = this.tints[t + 2] = 1;
    this.states[t + 3] = 1;
    this.mark(this.dirtyRows, index);
    if (matrix) this.setMatrixAt(index, matrix);
    else {
      const m = this.matrices,
        at = index * ROW;
      m.fill(0, at, at + ROW);
      m[at] = m[at + 4] = m[at + 8] = 1;
      this.mark(this.dirtyMatrices, index);
    }
    return index;
  }
  /** Deletes an instance; its index may be returned by a later `addInstance`. @throws RangeError for an index not alive. */
  deleteInstance(index: number): this {
    this.alive(index);
    this.states[index * 4 + 3] = 0;
    this.free[this.freeCount++] = index;
    this.live--;
    this.mark(this.dirtyRows, index);
    return this;
  }
  /**
   * Sets an instance's world matrix: 16 floats, column-major, affine (last row 0, 0, 0, 1). Mirrored matrices need
   * `mirrored: true`.
   * @throws RangeError for an index not alive, or a matrix that is not finite, not affine or (without `mirrored`) mirrors.
   */
  setMatrixAt(index: number, matrix: ArrayLike<number>): this {
    this.alive(index);
    if (!matrix || matrix.length !== 16) throw new TypeError('Invalid instance matrix; pass 16 numbers, column-major');
    for (let i = 0; i < 16; i++)
      if (matrix[i] - matrix[i] !== 0) throw new RangeError('Instance matrix is not finite; pass finite numbers');
    if (matrix[3] || matrix[7] || matrix[11] || matrix[15] !== 1)
      throw new RangeError('Instance matrix is not affine; its last row must be 0, 0, 0, 1');
    if (
      !this.mirrored &&
      matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
        matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9]) +
        matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]) <
        0
    )
      throw new RangeError('Instance matrix mirrors; create DynamicInstances with mirrored: true');
    const m = this.matrices,
      at = index * ROW;
    m[at] = matrix[0];
    m[at + 1] = matrix[1];
    m[at + 2] = matrix[2];
    m[at + 3] = matrix[4];
    m[at + 4] = matrix[5];
    m[at + 5] = matrix[6];
    m[at + 6] = matrix[8];
    m[at + 7] = matrix[9];
    m[at + 8] = matrix[10];
    m[at + 9] = matrix[12];
    m[at + 10] = matrix[13];
    m[at + 11] = matrix[14];
    this.mark(this.dirtyMatrices, index);
    return this;
  }
  /** Writes an instance's 16-float column-major matrix into `out` (default a new array) and returns it. */
  getMatrixAt(index: number, out: number[] | Float32Array = new Float32Array(16)): number[] | Float32Array {
    this.alive(index);
    const m = this.matrices,
      at = index * ROW;
    for (let c = 0; c < 4; c++) {
      out[c * 4] = m[at + c * 3];
      out[c * 4 + 1] = m[at + c * 3 + 1];
      out[c * 4 + 2] = m[at + c * 3 + 2];
      out[c * 4 + 3] = c === 3 ? 1 : 0;
    }
    return out;
  }
  /**
   * Tints an instance: linear rgb multipliers of the material colour, each 0 to 1. Default
   * [1, 1, 1].
   * @throws RangeError for an index not alive or a value outside 0 to 1.
   */
  setColorAt(index: number, rgb: ArrayLike<number>): this {
    this.alive(index);
    if (!rgb || rgb.length !== 3) throw new TypeError('Invalid instance colour; pass three linear rgb numbers');
    for (let i = 0; i < 3; i++)
      if (!(rgb[i] >= 0 && rgb[i] <= 1)) throw new RangeError('Invalid instance colour; pass values from 0 to 1');
    const t = index * 4;
    this.tints[t] = rgb[0];
    this.tints[t + 1] = rgb[1];
    this.tints[t + 2] = rgb[2];
    this.mark(this.dirtyRows, index);
    return this;
  }
  /** Shows or hides an instance without deleting it. @throws RangeError for an index not alive. */
  setVisibleAt(index: number, visible: boolean): this {
    this.alive(index);
    this.states[index * 4 + 3] = visible ? 1 : 2;
    this.mark(this.dirtyRows, index);
    return this;
  }
  /** Whether an instance is shown. @throws RangeError for an index not alive. */
  getVisibleAt(index: number): boolean {
    this.alive(index);
    return this.states[index * 4 + 3] === 1;
  }
  /**
   * Marks rows `from` to `to - 1` of `matrices` as written, after a bulk write into the array. Default every row.
   * @throws RangeError for a range outside 0 to `capacity`.
   */
  update(from = 0, to = this.capacity): this {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > this.capacity || from > to)
      throw new RangeError(`Invalid instance range; pass whole numbers with 0 <= from <= to <= ${this.capacity}`);
    if (from < to) {
      this.dirtyMatrices.fill(1, Math.floor(from / BLOCK), Math.floor((to - 1) / BLOCK) + 1);
      this.dirty = true;
    }
    return this;
  }
  private alive(index: number): void {
    if (!(index >= 0 && index < this.high && this.states[index * 4 + 3] && index === (index | 0)))
      throw new RangeError(`Instance ${index} is not alive; use an index addInstance returned`);
  }
  private mark(blocks: Uint8Array, index: number): void {
    blocks[index >> 8] = 1;
    this.dirty = true;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'DynamicInstances requires WebGPU; attach a new DynamicInstances to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    const d = engine.gpu;
    const storage = d.limits.maxStorageBufferBindingSize;
    if (this.capacity * 96 > storage)
      throw new RangeError(
        `DynamicInstances capacity ${this.capacity} needs ${this.capacity * 96} bytes of storage; this device binds at most ${storage}`,
      );
    // Retained first: `use` runs dispose when setup throws, and dispose releases only with `engine` set.
    engine.retain(this.own);
    this.engine = engine;
    this.device = d;
    loadCompatRoute(d, () => import('./compat.js'))?.then(({ dynamicRoute }) => {
      if (this.device === d) this.route = dynamicRoute(this.capacity);
    });
  }
  registerPasses(graph: FrameGraph): void {
    // Before every core draw of the batch (main pass, replays) and before shadow passes, which read `world`.
    graph.add({
      name: this.name,
      order: -2e6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.cull(c);
      },
    });
  }

  private cull(c: Context): void {
    this.check();
    const d = c.device,
      b = (this.buffers ??= this.create(d)),
      p = (this.pipelines ??= this.compile(d, b));
    if (this.dirty) this.upload(d, b);
    // Material values each frame, checked as core checks a mesh's material.
    const data = this.material.data;
    for (let i = 0; i < 8; i++)
      if (!(data[i] >= 0 && data[i] <= 1)) throw new RangeError('Invalid material; values must be 0 to 1');
    const words = this.partWords,
      floats = this.partFloats,
      bounds = this.geometry.bounds;
    words[0] = this.high;
    words[1] = this.geometry.indices.length;
    for (let i = 0; i < 4; i++) floats[4 + i] = bounds[i];
    floats[8] = data[4];
    floats[9] = data[5];
    floats[10] = data[6];
    floats[11] = NO_MESH;
    floats[12] = data[0];
    floats[13] = data[1];
    floats[14] = data[2];
    floats[15] = 1;
    const m = c.camera.matrix,
      canvas = this.engine!.canvas,
      ratio = canvas.clientWidth ? c.width / canvas.clientWidth : 1,
      f = this.frame;
    f.set(m);
    f.set(c.camera.planes, 16);
    f[40] = c.width;
    f[41] = (Math.hypot(m[1], m[5], m[9]) * c.height) / 2;
    f[42] = this.minRadius * ratio;
    if (this.route)
      this.route(d, this.high, this.matrices, this.tints, b, f, floats, this.sphere, this.geometry.indices.length);
    else {
      d.queue.writeBuffer(b.frame, 0, f as Float32Array<ArrayBuffer>);
      d.queue.writeBuffer(b.part, 0, this.part);
      const pass = c.encoder.beginComputePass(),
        groups = Math.max(1, Math.ceil(this.high / BLOCK));
      pass.setBindGroup(0, p.group);
      pass.setPipeline(p.cull);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(p.scan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(p.scatter);
      pass.dispatchWorkgroups(groups);
      pass.end();
      this.filled = false;
    }
    // The batch core keeps for the own geometry: the same object while this plugin retains the geometry.
    let batch = this.batch;
    if (!batch) {
      const list = c.batches ?? [];
      for (let i = 0; i < list.length; i++) if (list[i].geometry === this.own) batch = list[i];
      this.batch = batch;
    }
    if (batch) {
      this.redirect.instances = b.drawn;
      this.redirect.args = b.args;
      batch.redirect = this.redirect;
      // Back faces: double-sided material, or mirrored transforms allowed.
      batch.mask = data[6] || this.mirrored ? 1 : 0;
    }
  }
  /** Uploads each run of marked blocks of `matrices` and of the per-row attributes with one write per run. */
  private upload(d: GPUDevice, b: Buffers): void {
    this.dirty = false;
    this.runs(d, b.matrices, this.dirtyMatrices, this.matrices, ROW);
    this.runs(d, b.rows, this.dirtyRows, this.tints, 4);
  }
  private runs(d: GPUDevice, buffer: GPUBuffer, blocks: Uint8Array, data: Float32Array, floats: number): void {
    const end = Math.ceil(this.high / BLOCK);
    for (let i = 0; i < end; i++) {
      if (!blocks[i]) continue;
      let j = i;
      while (j < end && blocks[j]) blocks[j++] = 0;
      const from = i * BLOCK,
        to = Math.min(j * BLOCK, this.high);
      d.queue.writeBuffer(
        buffer,
        from * floats * 4,
        data as Float32Array<ArrayBuffer>,
        from * floats,
        (to - from) * floats,
      );
      i = j;
    }
    // Blocks past the high row hold nothing the kernels read; they are written once a row there is added.
  }
  private create(d: GPUDevice): Buffers {
    const n = this.capacity,
      S = GPUBufferUsage.STORAGE,
      D = GPUBufferUsage.COPY_DST,
      made: GPUBuffer[] = [];
    const make = (size: number, usage: number) => {
      const buffer = d.createBuffer({ size: Math.max(16, size), usage: usage | D });
      made.push(buffer);
      return buffer;
    };
    try {
      const buffers = {
        frame: make(this.frame.byteLength, GPUBufferUsage.UNIFORM),
        part: make(64, GPUBufferUsage.UNIFORM),
        matrices: make(n * ROW * 4, S),
        rows: make(n * 16, S),
        world: make(n * 96, S | GPUBufferUsage.VERTEX),
        local: make(n * 4, S),
        groups: make(Math.ceil(n / BLOCK) * 4, S),
        drawn: make(n * 96, S | GPUBufferUsage.VERTEX),
        args: make(20, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC),
      };
      // A new device holds nothing yet: every row up to the high row is uploaded on the first frame.
      this.dirtyMatrices.fill(1);
      this.dirtyRows.fill(1);
      this.dirty = true;
      return buffers;
    } catch (error) {
      for (const buffer of made) buffer.destroy();
      throw error;
    }
  }
  private compile(d: GPUDevice, b: Buffers): NonNullable<DynamicInstances['pipelines']> {
    const visibility = 4,
      entry = (type: GPUBufferBindingType) => ({ visibility, buffer: { type } });
    const layout = d.createBindGroupLayout({
      entries: [
        entry('uniform'),
        entry('uniform'),
        entry('read-only-storage'),
        entry('read-only-storage'),
        entry('storage'),
        entry('storage'),
        entry('storage'),
        entry('storage'),
        entry('storage'),
      ].map((e, binding) => ({ binding, ...e })),
    });
    const module = d.createShaderModule({ code: shader }),
      pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      pipeline = (entryPoint: string) =>
        d.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
    const group = d.createBindGroup({
      layout,
      entries: [b.frame, b.part, b.matrices, b.rows, b.world, b.local, b.groups, b.drawn, b.args].map(
        (buffer, binding) => ({ binding, resource: { buffer } }),
      ),
    });
    return {
      cull: pipeline('cull'),
      scan: pipeline('scan'),
      scatter: pipeline('scatter'),
      fill: pipeline('fill'),
      group,
    };
  }

  /** Records `world` on `encoder`, once per cull. The compatibility route writes it on the CPU. */
  private fill(encoder: GPUCommandEncoder): void {
    const p = this.pipelines;
    if (this.filled || !p || this.route) return;
    this.filled = true;
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, p.group);
    pass.setPipeline(p.fill);
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(this.high / BLOCK)));
    pass.end();
  }
  /** The `ShadowSource` contract of @margoengine/shadows: builds the rows `drawShadow` reads. */
  prepareShadow({ context }: { context: { encoder: GPUCommandEncoder } }): void {
    this.fill(context.encoder);
  }

  /**
   * Draws every live, shown instance into one shadow cascade (the `ShadowSource` contract of @margoengine/shadows:
   * `shadows.add(instances)`). Casters outside the camera view still cast; hidden and deleted ones do not.
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
    const b = this.buffers,
      engine = this.engine;
    if (!b || !engine || !this.high) return;
    const d = context.device;
    const s = (this.shadow ??= (() => {
      const module = d.createShaderModule({ code: shadowShader }),
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', buffers: [vertexLayout, instanceLayout] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
        });
      const uniforms: GPUBuffer[] = [],
        groups: GPUBindGroup[] = [];
      for (let i = 0; i < 4; i++) {
        const buffer = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        uniforms.push(buffer);
        groups.push(
          d.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer } }],
          }),
        );
      }
      return { pipeline, uniforms, groups };
    })());
    d.queue.writeBuffer(s.uniforms[cascade], 0, matrix as Float32Array<ArrayBuffer>);
    const core = engine.geometryBuffers(this.own);
    if (!core) return;
    pass.setPipeline(s.pipeline);
    pass.setBindGroup(0, s.groups[cascade]);
    pass.setVertexBuffer(0, core.vertex);
    pass.setVertexBuffer(1, b.world);
    pass.setIndexBuffer(core.index, 'uint32');
    pass.drawIndexed(this.geometry.indices.length, this.high);
  }

  /**
   * The index of the shown instance under CSS pixel (x, y) through the engine camera as of the last frame, or null.
   * `engine.pick` never returns instances (they are not core meshes). A GPU readback of one draw of every live row into
   * a 1x1 id target; overlapping calls run one after another, each for its own point.
   */
  pick(x: number, y: number): Promise<number | null> {
    if (!this.engine || !this.device)
      return Promise.reject(new MargoError('state', 'DynamicInstances is not attached; attach it to an engine first'));
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return Promise.reject(new RangeError('Invalid pick; pass finite CSS pixels'));
    const run = (this.picking ?? Promise.resolve(null)).then(
      () => this.pickNow(x, y),
      () => this.pickNow(x, y),
    );
    this.picking = run;
    return run;
  }
  private async pickNow(x: number, y: number): Promise<number | null> {
    const engine = this.engine,
      d = this.device,
      b = this.buffers;
    if (!engine || !d || !b || !this.high) return null;
    const canvas = engine.canvas,
      w = canvas.clientWidth || canvas.width,
      h = canvas.clientHeight || canvas.height;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const core = engine.geometryBuffers(this.own);
    if (!core) return null;
    // Made once per device and reused: the id target, its depth, the uniform and the pass descriptor.
    const t = (this.pickTarget ??= (() => {
      const module = d.createShaderModule({ code: pickShader }),
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', buffers: [vertexLayout, instanceLayout] },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32uint' }] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
        }),
        uniform = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        ids = d.createTexture({ size: [1, 1], format: 'r32uint', usage: 16 | 1 }),
        depth = d.createTexture({ size: [1, 1], format: 'depth32float', usage: 16 }),
        none = 4294967295;
      return {
        pipeline,
        uniform,
        ids,
        depth,
        matrix: new Float32Array(16),
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        }),
        descriptor: {
          colorAttachments: [
            { view: ids.createView(), clearValue: [none, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
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
      matrix = t.matrix,
      px = Math.floor((x * canvas.width) / w) + 0.5,
      py = Math.floor((y * canvas.height) / h) + 0.5;
    for (let c = 0; c < 4; c++) {
      const wc = camera[c * 4 + 3];
      matrix[c * 4] = camera[c * 4] * canvas.width - (2 * px - canvas.width) * wc;
      matrix[c * 4 + 1] = camera[c * 4 + 1] * canvas.height + (2 * py - canvas.height) * wc;
      matrix[c * 4 + 2] = camera[c * 4 + 2];
      matrix[c * 4 + 3] = wc;
    }
    d.queue.writeBuffer(t.uniform, 0, matrix);
    const read = d.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = d.createCommandEncoder();
      this.fill(encoder);
      const pass = encoder.beginRenderPass(t.descriptor);
      pass.setPipeline(t.pipeline);
      pass.setBindGroup(0, t.group);
      pass.setVertexBuffer(0, core.vertex);
      // `world` in row order, so the instance index is the row; hidden and deleted rows are zero matrices.
      pass.setVertexBuffer(1, b.world);
      pass.setIndexBuffer(core.index, 'uint32');
      pass.drawIndexed(this.geometry.indices.length, this.high);
      pass.end();
      encoder.copyTextureToBuffer({ texture: t.ids }, { buffer: read }, [1, 1]);
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const id = new Uint32Array(read.getMappedRange().slice(0))[0];
      read.unmap();
      return id < this.high && this.states[id * 4 + 3] === 1 ? id : null;
    } finally {
      read.destroy();
    }
  }
  /** Instances drawn in the latest submitted frame (a GPU readback; for tests and tools). */
  async readCount(): Promise<number> {
    const d = this.device,
      b = this.buffers;
    if (!d) throw new MargoError('state', 'DynamicInstances is not attached; attach it to an engine first');
    if (!b) return 0;
    const read = d.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(b.args, 4, read, 0, 4);
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const value = new Uint32Array(read.getMappedRange().slice(0))[0];
      read.unmap();
      return value;
    } finally {
      read.destroy();
    }
  }

  protected release(): void {
    if (this.batch?.redirect === this.redirect) this.batch.redirect = undefined;
    this.batch = undefined;
    if (this.buffers) for (const buffer of Object.values(this.buffers)) buffer.destroy();
    for (const buffer of this.shadow?.uniforms ?? []) buffer.destroy();
    this.pickTarget?.uniform.destroy();
    this.pickTarget?.ids.destroy();
    this.pickTarget?.depth.destroy();
    this.buffers = this.pipelines = this.shadow = this.pickTarget = this.route = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = engine;
    this.device = engine.gpu ?? undefined;
    if (this.device)
      loadCompatRoute(this.device, () => import('./compat.js'))?.then(({ dynamicRoute }) => {
        if (this.device === engine.gpu) this.route = dynamicRoute(this.capacity);
      });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.release();
    if (engine) {
      engine.removePlugin(this.name);
      if (!engine.disposed) engine.release(this.own);
    }
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
