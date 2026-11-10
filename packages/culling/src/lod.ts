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
const shader = (levels: number): string => `${cullInputs(',limits:vec4f')}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<uniform> b:Part;
@group(0) @binding(2) var<storage,read> records:array<Record>;
@group(0) @binding(3) var<storage,read> hidden:array<u32>;
@group(0) @binding(4) var<storage,read_write> counts:array<atomic<u32>>;
${Array.from({ length: levels }, (_, l) => `@group(0) @binding(${5 + l}) var<storage,read_write> drawn${l}:array<Record>;`).join('\n')}
${sphereCode}
// The first level whose limit the sphere's radius in pixels reaches; an eye inside the sphere takes the first level.
fn pick(s:vec4f)->u32 {
  let m=f.camera;let row=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let w=dot(row,vec4f(s.xyz,1.0));
  if(dot(row.xyz,row.xyz)>0.0&&w<=s.w){return 0u;}
  let size=s.w*f.size.y/w;
  for(var l=0u;l<${levels}u;l++){if(size>=b.limits[l]){return l;}}
  return ${levels}u;
}
@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=b.count||hidden[i]!=0u){return;}
  let r=records[i];let s=bound(r.m);if(!keep(s)){return;}
  let l=pick(s);if(l>=${levels}u){return;}
  let p=atomicAdd(&counts[l*5u+1u],1u);
  ${Array.from({ length: levels }, (_, l) => `if(l==${l}u){drawn${l}[p]=r;}`).join('')}
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
 * each list as one batch through `Batch.redirect`, with its own shader and shader patches. Instances of a level draw in no
 * fixed order. That shows between exactly coplanar faces, and on GPUs whose multisampled edges depend on draw order
 * (the Apple M6) where instances overlap at an edge: known-bugs.md, batch 132 culling.
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
    pipeline: GPUComputePipeline;
    group: GPUBindGroup;
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
  /** Instances drawn per level in the last frame, most detailed first. A GPU readback; for tests and tools. */
  async readCounts(): Promise<number[]> {
    const d = this.device,
      gpu = this.gpu;
    if (!d || !gpu) return this.levels.map(() => 0);
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
      level.drawn = made(n * 96, S | GPUBufferUsage.VERTEX | C);
      level.args = made(20, S | GPUBufferUsage.INDIRECT | C);
      level.redirect.instances = level.drawn;
      level.redirect.args = level.args;
    });
    const reset = made(template.byteLength, GPUBufferUsage.COPY_SRC | C),
      counts = made(template.byteLength, S | GPUBufferUsage.COPY_SRC | C),
      frame = made(176, GPUBufferUsage.UNIFORM | C),
      part = made(64, GPUBufferUsage.UNIFORM | C),
      records = made(n * 96, S | C),
      hidden = made(n * 4, S | C);
    d.queue.writeBuffer(reset, 0, template);
    const pipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: shader(levels) }), entryPoint: 'cull' },
    });
    const entry = (binding: number, buffer: GPUBuffer) => ({ binding, resource: { buffer } }),
      group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          entry(0, frame),
          entry(1, part),
          entry(2, records),
          entry(3, hidden),
          entry(4, counts),
          ...this.levels.map((level, l) => entry(5 + l, level.drawn!)),
        ],
      });
    this.low = this.hiddenLow = 0;
    this.high = this.hiddenHigh = n;
    return { frame, part, records, hidden, counts, reset, pipeline, group };
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
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, gpu.group);
    pass.dispatchWorkgroups(Math.ceil(this.count / 256));
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
      for (const buffer of [gpu.frame, gpu.part, gpu.records, gpu.hidden, gpu.counts, gpu.reset]) buffer.destroy();
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
