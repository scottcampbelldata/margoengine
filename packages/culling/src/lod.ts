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
import { compatTier } from '../../shared/compat.js';
import { cullInputs, fillFrame, sphereCode } from './shaders.js';

declare const GPUBufferUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  INDIRECT: number;
  MAP_READ: number;
  STORAGE: number;
  UNIFORM: number;
  VERTEX: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** One level of detail. */
export interface LodLevel {
  geometry: Geometry;
  /**
   * The smallest on-screen radius, in CSS pixels, that still draws this level. Levels go from most detailed to least, each
   * below the last. An instance smaller than the last level's value draws nothing. Default: 0, which only the last level
   * may leave out.
   */
  minRadius?: number;
}
/** {@link LodInstances} settings. */
export interface LodInstancesOptions {
  /** 1 to 4 levels, most detailed first. The first level's bounding sphere is every instance's: the others must fit in it. */
  levels: readonly LodLevel[];
  material: PbrMaterial;
  /** Column-major affine world matrices, 16 floats per instance. */
  transforms: Float32Array;
  /** Allow matrices with a negative determinant. Default: false. */
  mirrored?: boolean;
}

const NO_MESH = 16777216;
// Three kernels keep each level's list in instance order, so an unchanged frame draws the same order every time (an
// atomicAdd slot changed it from frame to frame, and with it MSAA edges where instances overlap on the M6). `cull`
// picks each instance's level (`levels` for none) and scans one-hot level counts in its workgroup (Hillis and Steele
// 1986, doubling in workgroup memory); `scan` turns the workgroup totals into offsets and writes each level's count;
// `scatter` copies each kept record to its level's list at its offset plus its place in the workgroup.
const shader = (levels: number): string => `${cullInputs(',limits:vec4f')}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<uniform> b:Part;
@group(0) @binding(2) var<storage,read> records:array<Record>;
@group(0) @binding(3) var<storage,read> hidden:array<u32>;
@group(0) @binding(4) var<storage,read_write> counts:array<u32>;
@group(0) @binding(5) var<storage,read_write> level:array<u32>;
@group(0) @binding(6) var<storage,read_write> local:array<u32>;
@group(0) @binding(7) var<storage,read_write> groups:array<vec4u>;
${Array.from({ length: levels }, (_, l) => `@group(0) @binding(${8 + l}) var<storage,read_write> drawn${l}:array<Record>;`).join('\n')}
var<workgroup> scratch:array<vec4u,256>;
${sphereCode}
// The first level whose limit the sphere's radius in pixels reaches; an eye inside the sphere takes the first level.
fn pick(s:vec4f)->u32 {
  let m=f.camera;let row=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let w=dot(row,vec4f(s.xyz,1.0));
  if(dot(row.xyz,row.xyz)>0.0&&w<=s.w){return 0u;}
  let size=s.w*f.size.y/w;
  for(var l=0u;l<${levels}u;l++){if(size>=b.limits[l]){return l;}}
  return ${levels}u;
}
@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) t:u32,@builtin(workgroup_id) w:vec3u) {
  let i=g.x;var lv=${levels}u;
  if(i<b.count){if(hidden[i]==0u){let s=bound(records[i].m);if(keep(s)){lv=pick(s);}}level[i]=lv;}
  var v=vec4u(0u);if(lv<${levels}u){v[lv]=1u;}
  scratch[t]=v;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var x=vec4u(0u);if(t>=o){x=scratch[t-o];}workgroupBarrier();scratch[t]+=x;workgroupBarrier();}
  if(i<b.count&&lv<${levels}u){let e=scratch[t]-v;local[i]=e[lv];}
  if(t==255u){groups[w.x]=scratch[255];}
}
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) t:u32) {
  let n=(b.count+255u)/256u;let per=(n+255u)/256u;let lo=min(t*per,n);let hi=min(lo+per,n);
  var sum=vec4u(0u);for(var k=lo;k<hi;k++){sum+=groups[k];}
  scratch[t]=sum;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var x=vec4u(0u);if(t>=o){x=scratch[t-o];}workgroupBarrier();scratch[t]+=x;workgroupBarrier();}
  var run=scratch[t]-sum;for(var k=lo;k<hi;k++){let x=groups[k];groups[k]=run;run+=x;}
  if(t==255u){let total=scratch[255];${Array.from({ length: levels }, (_, l) => `counts[${l * 5 + 1}u]=total[${l}];`).join('')}}
}
@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=b.count){return;}
  let lv=level[i];if(lv>=${levels}u){return;}
  let p=groups[i>>8u][lv]+local[i];
  ${Array.from({ length: levels }, (_, l) => `if(lv==${l}u){drawn${l}[p]=records[i];}`).join('')}
}
`;

interface Level {
  source: Geometry;
  own: Geometry;
  limit: number;
  batch?: Batch;
  drawn?: GPUBuffer;
  args?: GPUBuffer;
  redirect: { instances: GPUBuffer; args: GPUBuffer };
}
let serial = 0;

/**
 * Instances of one object at several levels of detail. One compute pass tests each instance against the frustum, picks its
 * level by its size on screen and appends it to that level's list, so the frame has no CPU loop over instances. Core draws
 * each list as one batch through `Batch.redirect`, with its own shader and shader patches. Instances of a level draw in
 * instance order, so an unchanged frame repeats to the byte (coplanar faces and, on the Apple M6, multisampled edges
 * follow draw order).
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class LodInstances implements EnginePlugin {
  readonly name = 'lod-instances:' + ++serial;
  disposed = false;
  /** Instances held. Fixed. */
  readonly count: number;
  private readonly levels: Level[];
  private readonly material: PbrMaterial;
  private readonly mirrored: boolean;
  private readonly records: Float32Array;
  private readonly hidden: Uint32Array;
  private readonly frame = new Float32Array(44);
  private readonly part = new ArrayBuffer(64);
  private low = 0;
  private high: number;
  private hiddenLow = 0;
  private hiddenHigh: number;
  private engine?: Engine;
  private device?: GPUDevice;
  private compat = false;
  private gpu?: {
    frame: GPUBuffer;
    part: GPUBuffer;
    records: GPUBuffer;
    hidden: GPUBuffer;
    counts: GPUBuffer;
    reset: GPUBuffer;
    level: GPUBuffer;
    local: GPUBuffer;
    groups: GPUBuffer;
    pipelines: GPUComputePipeline[];
    binds: GPUBindGroup[];
  };

  /** Creates the instances and attaches them to `engine`. */
  static attach(engine: EngineKernel, options: LodInstancesOptions): LodInstances {
    const value = new LodInstances(options);
    engine.use(value);
    return value;
  }
  constructor({ levels, material, transforms, mirrored = false }: LodInstancesOptions) {
    if (!Array.isArray(levels) || levels.length < 1 || levels.length > 4)
      throw new RangeError('Invalid LOD levels; pass 1 to 4 levels, most detailed first');
    if (!(material?.data instanceof Float32Array)) throw new TypeError('Invalid LOD material; pass a core PbrMaterial');
    if (!(transforms instanceof Float32Array) || transforms.length < 16 || transforms.length % 16)
      throw new TypeError('Invalid LOD transforms; pass a Float32Array of 16 floats per instance');
    let last = Infinity;
    this.levels = levels.map(({ geometry, minRadius = 0 }: LodLevel, l: number) => {
      if (!geometry?.indices || !geometry.vertices || !geometry.bounds)
        throw new TypeError('Invalid LOD geometry; pass a core Geometry');
      if (!(minRadius >= 0) || minRadius >= last || (!minRadius && l < levels.length - 1))
        throw new RangeError('Invalid LOD minRadius; each level needs a smaller value than the one before it');
      last = minRadius;
      return { source: geometry, own: Object.create(geometry) as Geometry, limit: minRadius, redirect: {} as never };
    });
    this.material = material;
    this.mirrored = mirrored;
    const n = (this.count = transforms.length / 16);
    this.records = new Float32Array(n * 24);
    this.hidden = new Uint32Array(n);
    const data = material.data;
    for (let i = 0; i < n; i++) {
      this.place(i, transforms.subarray(i * 16, i * 16 + 16));
      this.records.set([data[0], data[1], data[2], 1, data[4], data[5], data[6], NO_MESH], i * 24 + 16);
    }
    this.high = this.hiddenHigh = n;
  }
  private place(i: number, m: ArrayLike<number>): void {
    if (m?.length !== 16) throw new TypeError('Invalid instance matrix; pass 16 numbers, column-major');
    for (let k = 0; k < 16; k++)
      if (m[k] - m[k] !== 0) throw new RangeError('Instance matrix is not finite; pass finite numbers');
    if (m[3] || m[7] || m[11] || m[15] !== 1)
      throw new RangeError('Instance matrix is not affine; its last row must be 0, 0, 0, 1');
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (det < 0 && !this.mirrored)
      throw new RangeError('Instance matrix is mirrored; create LodInstances with mirrored: true');
    for (let k = 0; k < 16; k++) this.records[i * 24 + k] = m[k];
  }
  private check(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.count)
      throw new RangeError(`Invalid instance index ${i}; use 0 to ${this.count - 1}`);
  }
  /** Sets one instance's world matrix: 16 floats, column-major, affine. */
  setTransform(index: number, matrix: ArrayLike<number>): this {
    this.check(index);
    this.place(index, matrix);
    this.low = Math.min(this.low, index);
    this.high = Math.max(this.high, index + 1);
    return this;
  }
  /** Shows or hides one instance. */
  setVisible(index: number, visible: boolean): this {
    this.check(index);
    this.hidden[index] = visible ? 0 : 1;
    this.hiddenLow = Math.min(this.hiddenLow, index);
    this.hiddenHigh = Math.max(this.hiddenHigh, index + 1);
    return this;
  }
  /**
   * Instances drawn per level in the last frame, most detailed first. A GPU readback; for tests and tools. On the WebGL2
   * layer, which has no level kernel, every shown instance at the first level.
   */
  async readCounts(): Promise<number[]> {
    const d = this.device,
      gpu = this.gpu;
    if (!d || !gpu) return this.levels.map(() => 0);
    if (this.compat) {
      let shown = 0;
      for (let i = 0; i < this.count; i++) if (!this.hidden[i]) shown++;
      return this.levels.map((_, l) => (l === 0 ? shown : 0));
    }
    const size = gpu.counts.size,
      staging = d.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = d.createCommandEncoder();
    encoder.copyBufferToBuffer(gpu.counts, 0, staging, 0, size);
    d.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange()),
      out = this.levels.map((_, l) => words[l * 5 + 1]);
    staging.unmap();
    staging.destroy();
    return out;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'LodInstances requires WebGPU; attach a new LodInstances to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    const d = engine.gpu;
    if (this.count * 96 > d.limits.maxStorageBufferBindingSize)
      throw new RangeError(
        `LodInstances of ${this.count} needs ${this.count * 96} bytes of storage; this device binds at most ${d.limits.maxStorageBufferBindingSize}`,
      );
    // All levels or none, before `engine` is set: `use` runs dispose when setup throws, and dispose releases every level.
    let held = 0;
    try {
      for (; held < this.levels.length; held++) engine.retain(this.levels[held].own);
    } catch (error) {
      while (held) engine.release(this.levels[--held].own);
      throw error;
    }
    this.engine = engine;
    this.device = d;
    this.compat = compatTier(d) === 'webgl2';
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1e6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.cull(c);
      },
    });
  }
  private create(d: GPUDevice): NonNullable<LodInstances['gpu']> {
    const S = GPUBufferUsage.STORAGE,
      C = GPUBufferUsage.COPY_DST,
      made = (size: number, usage: number) => d.createBuffer({ size, usage }),
      n = this.count,
      levels = this.levels.length,
      template = new Uint32Array(levels * 5);
    this.levels.forEach((level, l) => {
      template[l * 5] = level.source.indices.length;
      level.drawn = made(n * 96, S | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | C);
      level.args = made(20, S | GPUBufferUsage.INDIRECT | C);
      level.redirect.instances = level.drawn;
      level.redirect.args = level.args;
    });
    const reset = made(template.byteLength, GPUBufferUsage.COPY_SRC | C),
      counts = made(template.byteLength, S | GPUBufferUsage.COPY_SRC | C),
      frame = made(176, GPUBufferUsage.UNIFORM | C),
      part = made(64, GPUBufferUsage.UNIFORM | C),
      records = made(n * 96, S | C),
      hidden = made(n * 4, S | C),
      level = made(n * 4, S),
      local = made(n * 4, S),
      groups = made(Math.ceil(n / 256) * 16, S);
    d.queue.writeBuffer(reset, 0, template);
    const module = d.createShaderModule({ code: shader(levels) }),
      entry = (binding: number, buffer: GPUBuffer) => ({ binding, resource: { buffer } }),
      all = [frame, part, records, hidden, counts, level, local, groups, ...this.levels.map((l) => l.drawn!)],
      // layout 'auto' keeps each entry point's group to the bindings it uses (at most 8 storage buffers each).
      uses = [
        [0, 1, 2, 3, 5, 6, 7],
        [1, 4, 7],
        [1, 2, 5, 6, 7, ...this.levels.map((_, l) => 8 + l)],
      ],
      pipelines = ['cull', 'scan', 'scatter'].map((entryPoint) =>
        d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } }),
      ),
      binds = pipelines.map((pipeline, k) =>
        d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: uses[k].map((binding) => entry(binding, all[binding])),
        }),
      );
    this.low = this.hiddenLow = 0;
    this.high = this.hiddenHigh = n;
    return { frame, part, records, hidden, counts, reset, level, local, groups, pipelines, binds };
  }
  private cull(c: Context): void {
    const d = c.device,
      gpu = (this.gpu ??= this.create(d)),
      changed = this.high > this.low || this.hiddenHigh > this.hiddenLow;
    if (this.high > this.low) {
      const { low, high } = this;
      d.queue.writeBuffer(
        gpu.records,
        low * 96,
        this.records as Float32Array<ArrayBuffer>,
        low * 24,
        (high - low) * 24,
      );
    }
    if (this.hiddenHigh > this.hiddenLow) {
      const { hiddenLow: low, hiddenHigh: high } = this;
      d.queue.writeBuffer(gpu.hidden, low * 4, this.hidden as Uint32Array<ArrayBuffer>, low, high - low);
    }
    this.low = this.hiddenLow = this.count;
    this.high = this.hiddenHigh = 0;
    if (this.compat) {
      if (changed) this.fallback(d);
    } else {
      this.dispatch(c, gpu);
    }
    const list = c.batches ?? [],
      mask = this.material.data[6] || this.mirrored ? 1 : 0;
    for (const level of this.levels) {
      if (!level.batch) for (const batch of list) if (batch.geometry === level.own) level.batch = batch;
      if (level.batch) {
        level.batch.redirect = level.redirect;
        level.batch.mask = mask;
      }
    }
  }
  private dispatch(c: Context, gpu: NonNullable<LodInstances['gpu']>): void {
    const d = c.device,
      canvas = this.engine!.canvas,
      ratio = canvas.clientWidth ? c.width / canvas.clientWidth : 1,
      words = new Uint32Array(this.part),
      floats = new Float32Array(this.part);
    fillFrame(this.frame, c, canvas, 0);
    words[0] = this.count;
    words[1] = 0;
    floats.set(this.levels[0].source.bounds, 4);
    this.levels.forEach((level, l) => (floats[8 + l] = level.limit * ratio));
    d.queue.writeBuffer(gpu.frame, 0, this.frame as Float32Array<ArrayBuffer>);
    d.queue.writeBuffer(gpu.part, 0, this.part);
    c.encoder.copyBufferToBuffer(gpu.reset, 0, gpu.counts, 0, gpu.counts.size);
    const pass = c.encoder.beginComputePass(),
      groups = Math.ceil(this.count / 256);
    gpu.pipelines.forEach((pipeline, k) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, gpu.binds[k]);
      pass.dispatchWorkgroups(k === 1 ? 1 : groups);
    });
    pass.end();
    this.levels.forEach((level, l) => c.encoder.copyBufferToBuffer(gpu.counts, l * 20, level.args!, 0, 20));
  }
  // The WebGL2 layer has no compute: every shown instance draws the first level, written when something changes.
  private fallback(d: GPUDevice): void {
    const kept = new Float32Array(this.count * 24);
    let n = 0;
    for (let i = 0; i < this.count; i++)
      if (!this.hidden[i]) kept.set(this.records.subarray(i * 24, i * 24 + 24), n++ * 24);
    const first = this.levels[0];
    d.queue.writeBuffer(first.drawn!, 0, kept, 0, n * 24);
    d.queue.writeBuffer(first.args!, 0, new Uint32Array([first.source.indices.length, n, 0, 0, 0]));
  }
  private release(): void {
    for (const level of this.levels) {
      if (level.batch?.redirect === level.redirect) level.batch.redirect = undefined;
      level.drawn?.destroy();
      level.args?.destroy();
      level.batch = level.drawn = level.args = undefined;
    }
    const gpu = this.gpu;
    if (gpu)
      for (const buffer of [
        gpu.frame,
        gpu.part,
        gpu.records,
        gpu.hidden,
        gpu.counts,
        gpu.reset,
        gpu.level,
        gpu.local,
        gpu.groups,
      ])
        buffer.destroy();
    this.gpu = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = engine;
    this.device = engine.gpu ?? undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.release();
    if (engine) {
      engine.sceneOf(this)?.removePlugin(this.name);
      if (!engine.disposed) for (const level of this.levels) engine.release(level.own);
    }
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
