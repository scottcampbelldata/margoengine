import type { EngineKernel } from '@margoengine/core';
import { compatTier } from '../../shared/compat.js';
import { CulledParts, type CulledPartsBatch } from './parts.js';
import type { CulledInstancesOptions } from './index.js';
import { DynamicInstances, type DynamicInstancesOptions } from './dynamic.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  VERTEX: number;
  INDIRECT: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** What @margoengine/shadows hands `prepareShadow`, once per shadow frame. */
export interface CascadePrepareContext {
  context: { encoder: GPUCommandEncoder };
  /** Every cascade's light matrix, 16 floats each. */
  matrices: Float32Array;
  /** Cascades drawn this frame, 1 to 4. */
  cascades: number;
}
interface CascadeDrawContext {
  context: { device: GPUDevice; encoder?: GPUCommandEncoder };
  pass: GPURenderPassEncoder;
  matrix: Float32Array;
  cascade: number;
}

// One thread per row, every cascade in turn. Order in a list is free: a depth-only draw keeps the nearest depth whatever
// the order. A row's sphere is tested against the six planes of the light box; what lies outside clips away in that
// cascade's pass, so its shadow map stays the same.
const cullShader = (parts: boolean): string => `
struct Cascades {light:array<mat4x4f,4>,size:vec4u,sphere:vec4f}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> u:Cascades;
@group(0) @binding(1) var<storage,read> records:array<Record>;
@group(0) @binding(2) var<storage,read_write> lists:array<u32>;
@group(0) @binding(3) var<storage,read_write> args:array<atomic<u32>>;
${
  parts
    ? `@group(0) @binding(4) var<storage,read> hidden:array<u32>;
@group(0) @binding(5) var<storage,read> batchOf:array<u32>;
@group(0) @binding(6) var<storage,read> bounds:array<vec4f>;
@group(0) @binding(7) var<storage,read> starts:array<u32>;`
    : ''
}
fn outside(p:vec4f,c:vec3f,r:f32)->bool {
  let n=length(p.xyz);
  return dot(p.xyz,c)+p.w< -(r*n+1e-5*(abs(p.w)+n*length(c)));
}
fn reaches(l:mat4x4f,c:vec3f,r:f32)->bool {
  let t=transpose(l);
  return !(outside(t[3]+t[0],c,r)||outside(t[3]-t[0],c,r)||outside(t[3]+t[1],c,r)||outside(t[3]-t[1],c,r)||outside(t[2],c,r)||outside(t[3]-t[2],c,r));
}
@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=u.size.x){return;}
  ${
    parts
      ? 'if(hidden[i]!=0u){return;}let k=batchOf[i];let b=bounds[k];let start=starts[k];'
      : 'let k=0u;let b=u.sphere;let start=0u;'
  }
  let m=records[i].m;
  ${parts ? '' : 'if(m[3].w==0.0){return;}'}
  let c=(m*vec4f(b.xyz,1.0)).xyz;
  var r=b.w*sqrt(max(dot(m[0].xyz,m[0].xyz),max(dot(m[1].xyz,m[1].xyz),dot(m[2].xyz,m[2].xyz))));
  r+=1e-5*(length(c)+r);
  for(var n=0u;n<u.size.y;n++){
    if(reaches(u.light[n],c,r)){
      let p=atomicAdd(&args[(n*u.size.z+k)*5u+1u],1u);
      lists[n*u.size.w+start+p]=i;
    }
  }
}
`;
// The same sum as the plain caster shaders, so a kept row lands on the same depth.
const drawShader = `
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> light:mat4x4f;
@group(0) @binding(1) var<storage,read> records:array<Record>;
struct Input {@location(0) p:vec3f,@location(1) row:u32}
@vertex fn vertex(i:Input)->@builtin(position) vec4f {return light*records[i.row].m*vec4f(i.p,1);}
`;
const layouts: GPUVertexBufferLayout[] = [
  { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'uint32' }] },
];

interface Source {
  rows: GPUBuffer;
  /** Rows the lists are sized for. */
  stride: number;
  /** Rows to test this frame. */
  count: number;
  /** Each batch's index count and first row. */
  batches: readonly { indices: number; start: number }[];
  /** Parts: the visibility flags, each row's batch, and each batch's local sphere first in `bounds`. */
  parts?: { hidden: GPUBuffer; batchOf: GPUBuffer; bounds: GPUBuffer };
  /** Instances: the one local sphere. */
  sphere?: ArrayLike<number>;
}

/** The lists, indirect arguments and pipelines one caster source uses, per cascade and batch. */
class CascadeLists {
  private rows?: GPUBuffer;
  private cascades = 0;
  private batches = 0;
  private lists?: GPUBuffer;
  private args?: GPUBuffer;
  private reset?: GPUBuffer;
  private starts?: GPUBuffer;
  private uniform?: GPUBuffer;
  private lights: GPUBuffer[] = [];
  private cull?: GPUComputePipeline;
  private draw?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private groups: GPUBindGroup[] = [];
  private encoder?: GPUCommandEncoder;
  private stride = 0;
  private readonly values = new ArrayBuffer(288);
  private readonly words = new Uint32Array(this.values);
  private readonly floats = new Float32Array(this.values);

  private build(d: GPUDevice, s: Source, cascades: number): void {
    this.drop();
    this.rows = s.rows;
    this.cascades = cascades;
    this.batches = s.batches.length;
    this.stride = s.stride;
    const bytes = cascades * s.stride * 4,
      limits = d.limits as GPUSupportedLimits & { maxStorageBuffersInVertexStage?: number };
    // Lists the GPU cannot bind leave every cascade drawing every caster; so does a vertex stage with no storage.
    if (
      compatTier(d) === 'webgl2' ||
      limits.maxStorageBuffersInVertexStage === 0 ||
      bytes > Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize)
    )
      return;
    const template = new Uint32Array(cascades * this.batches * 5),
      starts = new Uint32Array(this.batches);
    s.batches.forEach(({ indices, start }, i) => {
      starts[i] = start;
      for (let n = 0; n < cascades; n++) template[(n * this.batches + i) * 5] = indices;
    });
    const made = (size: number, usage: number) => d.createBuffer({ size: Math.max(size, 4), usage });
    this.lists = made(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX);
    this.args = made(
      template.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.reset = made(template.byteLength, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    d.queue.writeBuffer(this.reset, 0, template);
    this.starts = made(starts.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    d.queue.writeBuffer(this.starts, 0, starts);
    this.uniform ??= d.createBuffer({ size: 288, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cull ??= d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: cullShader(!!s.parts) }), entryPoint: 'cull' },
    });
    this.draw ??= d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: d.createShaderModule({ code: drawShader }), entryPoint: 'vertex', buffers: layouts },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    const entry = (binding: number, buffer: GPUBuffer) => ({ binding, resource: { buffer } });
    this.group = d.createBindGroup({
      layout: this.cull.getBindGroupLayout(0),
      entries: [
        entry(0, this.uniform),
        entry(1, s.rows),
        entry(2, this.lists),
        entry(3, this.args),
        ...(s.parts
          ? [entry(4, s.parts.hidden), entry(5, s.parts.batchOf), entry(6, s.parts.bounds), entry(7, this.starts)]
          : []),
      ],
    });
    for (let n = 0; n < 4; n++) {
      const light = (this.lights[n] ??= d.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
      this.groups[n] = d.createBindGroup({
        layout: this.draw.getBindGroupLayout(0),
        entries: [entry(0, light), entry(1, s.rows)],
      });
    }
  }
  /** Records this frame's cull on `encoder`. */
  prepare(d: GPUDevice, encoder: GPUCommandEncoder, s: Source, matrices: Float32Array, cascades: number): void {
    this.encoder = undefined;
    if (s.rows !== this.rows || cascades !== this.cascades || s.stride !== this.stride) this.build(d, s, cascades);
    if (!this.lists) return;
    this.floats.set(matrices.subarray(0, cascades * 16));
    this.words.set([s.count, cascades, this.batches, s.stride], 64);
    if (s.sphere) this.floats.set(s.sphere, 68);
    d.queue.writeBuffer(this.uniform!, 0, this.values);
    encoder.copyBufferToBuffer(this.reset!, 0, this.args!, 0, this.args!.size);
    if (s.count) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.cull!);
      pass.setBindGroup(0, this.group!);
      pass.dispatchWorkgroups(Math.ceil(s.count / 256));
      pass.end();
    }
    this.encoder = encoder;
  }
  /** Whether this frame's lists can draw `cascade`; a pass that never prepared takes the plain draw. */
  ready(encoder: GPUCommandEncoder | undefined, cascade: number): boolean {
    return !!this.encoder && encoder === this.encoder && cascade < this.cascades;
  }
  /** Opens one cascade's draws. */
  begin(d: GPUDevice, pass: GPURenderPassEncoder, cascade: number, matrix: Float32Array): void {
    d.queue.writeBuffer(this.lights[cascade], 0, matrix as Float32Array<ArrayBuffer>);
    pass.setPipeline(this.draw!);
    pass.setBindGroup(0, this.groups[cascade]);
  }
  /** One batch of one cascade. */
  drawBatch(
    pass: GPURenderPassEncoder,
    cascade: number,
    batch: number,
    start: number,
    geometry: { vertex: GPUBuffer; index: GPUBuffer },
  ): void {
    pass.setVertexBuffer(0, geometry.vertex);
    pass.setVertexBuffer(1, this.lists!, (cascade * this.stride + start) * 4);
    pass.setIndexBuffer(geometry.index, 'uint32');
    pass.drawIndexedIndirect(this.args!, (cascade * this.batches + batch) * 20);
  }
  /** Casters kept per cascade in the last prepared frame, every batch summed. */
  async read(d: GPUDevice): Promise<number[]> {
    if (!this.args) return [];
    const size = this.args.size,
      staging = d.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = d.createCommandEncoder();
    encoder.copyBufferToBuffer(this.args, 0, staging, 0, size);
    d.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange()),
      out = new Array<number>(this.cascades).fill(0);
    for (let n = 0; n < this.cascades; n++)
      for (let b = 0; b < this.batches; b++) out[n] += words[(n * this.batches + b) * 5 + 1];
    staging.unmap();
    staging.destroy();
    return out;
  }
  private drop(): void {
    for (const buffer of [this.lists, this.args, this.reset, this.starts]) buffer?.destroy();
    this.lists = this.args = this.reset = this.starts = this.group = undefined;
    this.encoder = undefined;
  }
  release(): void {
    this.drop();
    for (const buffer of [this.uniform, ...this.lights]) buffer?.destroy();
    this.uniform = this.rows = this.cull = this.draw = undefined;
    this.lights = [];
    this.groups = [];
    this.cascades = 0;
  }
}

/**
 * {@link CulledParts} that cull their casters against every shadow cascade on the GPU: each cascade draws only the parts
 * that reach its light box, through a compacted list and an indirect draw per batch. The shadow map is the same.
 * `shadows.add(parts)` as usual; `prepareShadow` is what makes it run.
 */
export class CascadeParts extends CulledParts {
  private readonly cascadeLists = new CascadeLists();
  static override attach(
    engine: EngineKernel,
    batches: readonly CulledPartsBatch[],
    options?: CulledInstancesOptions,
  ): CascadeParts {
    const value = new CascadeParts(batches, options);
    engine.use(value);
    return value;
  }
  /** The `ShadowSource` contract of @margoengine/shadows: builds every cascade's list of casters. */
  prepareShadow({ context, matrices, cascades }: CascadePrepareContext): void {
    const d = this.device,
      b = this.buffers,
      table = this.table;
    if (!d) return;
    this.flush(d);
    this.cascadeLists.prepare(
      d,
      context.encoder,
      {
        rows: b.records,
        stride: this.slots,
        count: this.slots,
        batches: this.batches.map((batch, i) => ({ indices: batch.geometry.indices.length, start: table[i * 4] })),
        parts: { hidden: b.hidden, batchOf: b.batchOf, bounds: b.bounds },
      },
      matrices,
      cascades,
    );
  }
  /** Draws one cascade's list; a frame without `prepareShadow` draws every part, as {@link CulledParts.drawShadow}. */
  override drawShadow(c: CascadeDrawContext): void {
    const lists = this.cascadeLists,
      d = this.device;
    if (!d || !lists.ready(c.context.encoder, c.cascade)) return super.drawShadow(c);
    lists.begin(d, c.pass, c.cascade, c.matrix);
    this.batches.forEach((batch, i) => {
      lists.drawBatch(c.pass, c.cascade, i, this.table[i * 4], this.geometryBuffers.get(batch.geometry)!);
    });
  }
  /** Parts kept per cascade in the last shadow frame, for tests and tools. A GPU readback. */
  readCascades(): Promise<number[]> {
    return this.device ? this.cascadeLists.read(this.device) : Promise.resolve([]);
  }
  protected override release(): void {
    this.cascadeLists.release();
    super.release();
  }
}

/** {@link DynamicInstances} whose casters are culled per cascade, as {@link CascadeParts}. */
export class CascadeInstances extends DynamicInstances {
  private readonly cascadeLists = new CascadeLists();
  static override attach(engine: EngineKernel, options: DynamicInstancesOptions): CascadeInstances {
    const value = new CascadeInstances(options);
    engine.use(value);
    return value;
  }
  /** The `ShadowSource` contract of @margoengine/shadows: builds the rows, then every cascade's list of casters. */
  override prepareShadow({ context, matrices, cascades }: CascadePrepareContext): void {
    super.prepareShadow({ context });
    const d = this.device,
      b = this.buffers;
    if (!d || !b) return;
    this.cascadeLists.prepare(
      d,
      context.encoder,
      {
        rows: b.world,
        stride: this.capacity,
        count: this.high,
        batches: [{ indices: this.geometry.indices.length, start: 0 }],
        sphere: this.geometry.bounds,
      },
      matrices,
      cascades,
    );
  }
  /** Draws one cascade's list; a frame without `prepareShadow` draws every row, as {@link DynamicInstances.drawShadow}. */
  override drawShadow(c: CascadeDrawContext): void {
    const lists = this.cascadeLists,
      d = this.device,
      core = this.engine?.geometryBuffers(this.own);
    if (!d || !core || !lists.ready(c.context.encoder, c.cascade)) return super.drawShadow(c);
    lists.begin(d, c.pass, c.cascade, c.matrix);
    lists.drawBatch(c.pass, c.cascade, 0, 0, core);
  }
  /** Instances kept per cascade in the last shadow frame, for tests and tools. A GPU readback. */
  readCascades(): Promise<number[]> {
    return this.device ? this.cascadeLists.read(this.device) : Promise.resolve([]);
  }
  protected override release(): void {
    this.cascadeLists.release();
    super.release();
  }
}
