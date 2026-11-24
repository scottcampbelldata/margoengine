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
// The same sum as the plain caster shaders, so a kept row lands on the same depth; @invariant, as they are, so no
// compiler evaluates it in another order here.
const drawShader = `
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> light:mat4x4f;
@group(0) @binding(1) var<storage,read> records:array<Record>;
struct Input {@location(0) p:vec3f,@location(1) row:u32}
@vertex fn vertex(i:Input)->@builtin(position) @invariant vec4f {return light*records[i.row].m*vec4f(i.p,1);}
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
  /**
   * The WebGL2 layer's route: writes row `i`'s world sphere (centre, radius) to `out` as the cull kernel computes it and
   * returns the row's batch, or -1 for a row the kernel skips. The lists are built on the CPU from it (no compute there).
   */
  cpu?: (i: number, out: Float64Array) => number;
}

/**
 * The cull kernel's light-box test on the CPU, in double precision: the six planes of the light matrix at `at`
 * (column-major; x and y in -w to w, depth in 0 to w), the sphere padded as the kernel pads it.
 */
function reachesCascade(l: ArrayLike<number>, at: number, x: number, y: number, z: number, r: number): boolean {
  const length = Math.sqrt(x * x + y * y + z * z);
  for (let p = 0; p < 6; p++) {
    // Row k of the matrix is (l[k], l[4 + k], l[8 + k], l[12 + k]); planes r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2.
    const k = p < 4 ? p >> 1 : 2,
      sign = p === 4 ? 0 : p & 1 ? -1 : 1,
      own = p === 4 ? 1 : sign;
    let a = own * l[at + k],
      b = own * l[at + 4 + k],
      c = own * l[at + 8 + k],
      w = own * l[at + 12 + k];
    if (p !== 4) {
      a += l[at + 3];
      b += l[at + 7];
      c += l[at + 11];
      w += l[at + 15];
    }
    const n = Math.sqrt(a * a + b * b + c * c);
    if (a * x + b * y + c * z + w < -(r * n + 1e-5 * (Math.abs(w) + n * length))) return false;
  }
  return true;
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
  // The WebGL2 layer's lists, built on the CPU each shadow frame and uploaded, with each cascade's kept count.
  private host?: { lists: Uint32Array; args: Uint32Array; template: Uint32Array; starts: Uint32Array; kept: number[] };
  private readonly sphere = new Float64Array(4);
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
    // Lists the GPU cannot bind leave every cascade drawing every caster; so does a vertex stage with no storage, or a
    // WebGL2 layer source with no CPU rows to test.
    const host = compatTier(d) === 'webgl2';
    if (
      (host && !s.cpu) ||
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
    this.draw ??= d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: d.createShaderModule({ code: drawShader }), entryPoint: 'vertex', buffers: layouts },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    const entry = (binding: number, buffer: GPUBuffer) => ({ binding, resource: { buffer } });
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
    if (host) {
      // The WebGL2 layer has no atomics or workgroup memory: the cull runs on the CPU (prepareHost) and the lists and
      // indirect arguments are uploaded, as culling's other routes there do (compat.ts).
      this.lists = made(bytes, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
      this.args = made(template.byteLength, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
      this.host = { lists: new Uint32Array(cascades * s.stride), args: template.slice(), template, starts, kept: [] };
      return;
    }
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
  }
  /** The WebGL2 layer's cull: the kernel's test per row and cascade on the CPU, then one upload of lists and args. */
  private prepareHost(d: GPUDevice, s: Source, matrices: Float32Array, cascades: number): void {
    const host = this.host!,
      { lists, args, starts } = host,
      sphere = this.sphere,
      batches = this.batches,
      stride = this.stride,
      test = s.cpu!;
    args.set(host.template);
    for (let i = 0; i < s.count; i++) {
      const k = test(i, sphere);
      if (k < 0) continue;
      for (let n = 0; n < cascades; n++)
        if (reachesCascade(matrices, n * 16, sphere[0], sphere[1], sphere[2], sphere[3])) {
          const slot = (n * batches + k) * 5 + 1;
          lists[n * stride + starts[k] + args[slot]++] = i;
        }
    }
    const kept = new Array<number>(cascades).fill(0);
    for (let n = 0; n < cascades; n++) for (let b = 0; b < batches; b++) kept[n] += args[(n * batches + b) * 5 + 1];
    host.kept = kept;
    d.queue.writeBuffer(this.lists!, 0, lists as Uint32Array<ArrayBuffer>);
    d.queue.writeBuffer(this.args!, 0, args as Uint32Array<ArrayBuffer>);
  }
  /** Records this frame's cull on `encoder`. */
  prepare(d: GPUDevice, encoder: GPUCommandEncoder, s: Source, matrices: Float32Array, cascades: number): void {
    this.encoder = undefined;
    if (s.rows !== this.rows || cascades !== this.cascades || s.stride !== this.stride) this.build(d, s, cascades);
    if (!this.lists) return;
    if (this.host) {
      this.prepareHost(d, s, matrices, cascades);
      this.encoder = encoder;
      return;
    }
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
    if (this.host) return this.host.kept.slice();
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
    this.lists = this.args = this.reset = this.starts = this.group = this.host = undefined;
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

/** The cull kernel's padded world sphere of the local sphere at `b[s]` under the matrix at `m[at]`, in `out`. */
function worldSphere(m: ArrayLike<number>, at: number, b: ArrayLike<number>, s: number, out: Float64Array): boolean {
  const x = b[s],
    y = b[s + 1],
    z = b[s + 2];
  const cx = m[at] * x + m[at + 4] * y + m[at + 8] * z + m[at + 12],
    cy = m[at + 1] * x + m[at + 5] * y + m[at + 9] * z + m[at + 13],
    cz = m[at + 2] * x + m[at + 6] * y + m[at + 10] * z + m[at + 14];
  const scale = Math.max(
    m[at] ** 2 + m[at + 1] ** 2 + m[at + 2] ** 2,
    m[at + 4] ** 2 + m[at + 5] ** 2 + m[at + 6] ** 2,
    m[at + 8] ** 2 + m[at + 9] ** 2 + m[at + 10] ** 2,
  );
  let r = b[s + 3] * Math.sqrt(scale);
  r += 1e-5 * (Math.sqrt(cx * cx + cy * cy + cz * cz) + r);
  out[0] = cx;
  out[1] = cy;
  out[2] = cz;
  out[3] = r;
  return Number.isFinite(cx + cy + cz + r);
}

/**
 * {@link CulledParts} that cull their casters against every shadow cascade on the GPU: each cascade draws only the parts
 * that reach its light box, through a compacted list and an indirect draw per batch. The shadow map is the same.
 * `shadows.add(parts)` as usual; `prepareShadow` is what makes it run.
 */
export class CascadeParts extends CulledParts {
  private readonly cascadeLists = new CascadeLists();
  // The kernel's world sphere of slot i (its batch's sphere under the part's matrix, the largest axis scale, padded).
  private readonly cpuSphere = (i: number, out: Float64Array): number => {
    if (this.hidden[i]) return -1;
    const k = this.batchOf[i];
    return worldSphere(this.records, i * 24, this.bounds, k * 4, out) ? k : -1;
  };
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
        cpu: this.cpuSphere,
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
  // A live, shown row with a finite matrix, as the compatibility route writes `world` (zero rows are skipped).
  private readonly record = new Float32Array(16);
  private readonly cpuSphere = (i: number, out: Float64Array): number => {
    if (this.states[i * 4 + 3] !== 1) return -1;
    const m = this.matrices,
      at = i * 12,
      r = this.record;
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 3; k++) {
        const v = m[at + c * 3 + k];
        if (!Number.isFinite(v)) return -1;
        r[c * 4 + k] = v;
      }
    r[15] = 1;
    return worldSphere(r, 0, this.geometry.bounds, 0, out) ? 0 : -1;
  };
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
        cpu: this.cpuSphere,
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
