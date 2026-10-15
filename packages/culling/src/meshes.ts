/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Batch, Engine, EnginePlugin, FrameGraph, Geometry, PassContext } from '@margoengine/core/extension';

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

export interface CulledMeshesOptions {
  /** Also drop parts whose bounding sphere spans fewer than this many CSS pixels in radius (default 0: frustum only, same pixels as core). */
  minRadius?: number;
}

// One dispatch triple per core batch: frustum (+ screen size) test with a workgroup scan, a scan of the workgroup totals,
// then a stable scatter of the kept 96-byte instance records (original order, so coplanar faces resolve as in core).
const shader = `
struct Frame {camera:mat4x4f,planes:array<vec4f,6>,size:vec4f}
struct Part {count:u32,indices:u32,pad:vec2u,sphere:vec4f}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<uniform> b:Part;
@group(0) @binding(2) var<storage,read> records:array<Record>;
@group(0) @binding(3) var<storage,read_write> visible:array<u32>;
@group(0) @binding(4) var<storage,read_write> local:array<u32>;
@group(0) @binding(5) var<storage,read_write> groups:array<u32>;
@group(0) @binding(6) var<storage,read_write> drawn:array<Record>;
@group(0) @binding(7) var<storage,read_write> args:array<u32>;
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
@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u) {
  let i=g.x;var v=0u;
  if(i<b.count){if(keep(records[i].m)){v=1u;}visible[i]=v;}
  scratch[l]=v;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var t=0u;if(l>=o){t=scratch[l-o];}workgroupBarrier();scratch[l]+=t;workgroupBarrier();}
  if(i<b.count){local[i]=scratch[l]-v;}
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
  let i=g.x;if(i>=b.count){return;}
  let p=groups[i>>8u]+local[i];let v=visible[i];
  if(v==1u){drawn[p]=records[i];}
  if(i==b.count-1u){args[0]=b.indices;args[1]=p+v;args[2]=0u;args[3]=0u;args[4]=0u;}
}
`;

interface Slot {
  instance?: GPUBuffer;
  capacity: number;
  buffers: GPUBuffer[];
  drawn?: GPUBuffer;
  args?: GPUBuffer;
  uniform?: GPUBuffer;
  group?: GPUBindGroup;
  data: Uint32Array;
}
let serial = 0;

/**
 * GPU culling for regular core meshes: every frame a compute pass tests each drawn instance of core's batches against
 * the frustum (and optionally a screen-size threshold), compacts the kept instances in order and points core's draws at
 * them (`Batch.redirect`). The meshes stay core meshes, so `engine.pick`, Picking, hierarchy, ExplodedView,
 * AssemblyBVH and FeatureEdges keep working. Start with `engine.start({culling: false})` (or render with `{culling: false}`) to move frustum culling
 * off the CPU (the kept set then stays stable while the camera moves, so core reuses its instance lists).
 */
export class CulledMeshes implements EnginePlugin {
  readonly name = 'culled-meshes:' + ++serial;
  /** See {@link CulledMeshesOptions.minRadius}; may change at any time. */
  minRadius: number;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private pipelines?: {
    layout: GPUBindGroupLayout;
    cull: GPUComputePipeline;
    scan: GPUComputePipeline;
    scatter: GPUComputePipeline;
  };
  private frameBuffer?: GPUBuffer;
  private readonly frame = new Float32Array(44);
  private readonly slots = new Map<Geometry, Slot>();
  private redirected: Batch[] = [];

  /** Same as `engine.use(new CulledMeshes(options))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: CulledMeshesOptions): CulledMeshes {
    const value = new CulledMeshes(options);
    engine.use(value);
    return value;
  }
  constructor({ minRadius = 0 }: CulledMeshesOptions = {}) {
    this.minRadius = minRadius;
    this.check();
  }
  private check(): void {
    if (!(this.minRadius >= 0 && this.minRadius < 1e6)) throw new RangeError('Invalid culled mesh options');
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('CulledMeshes requires WebGPU');
    this.engine = engine;
    this.device = engine.gpu;
  }
  registerPasses(graph: FrameGraph): void {
    // First in the frame, so every core draw of these batches (main pass and replays) sees this frame's culled lists.
    graph.add({
      name: this.name,
      order: -1e6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.cull(c);
      },
    });
  }
  /** Instances drawn per redirected batch in the latest submitted frame, keyed by geometry (a GPU readback; for tests and tools). */
  async readCounts(): Promise<Map<Geometry, number>> {
    const d = this.device;
    if (!d) throw new Error('CulledMeshes is not attached');
    const entries = [...this.slots].filter(([, s]) => s.args),
      read = d.createBuffer({
        size: Math.max(4, entries.length * 4),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    try {
      const encoder = d.createCommandEncoder();
      entries.forEach(([, s], i) => encoder.copyBufferToBuffer(s.args!, 4, read, i * 4, 4));
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      return new Map(entries.map(([g], i) => [g, values[i]]));
    } finally {
      read.destroy();
    }
  }

  private cull(c: Context): void {
    this.check();
    this.restore();
    const d = c.device,
      batches = c.batches ?? [],
      engine = this.engine!;
    this.pipelines ??= (() => {
      // One explicit layout shared by the three entry points ('auto' layouts are per pipeline and incompatible).
      const visibility = 4,
        buffer = (type: GPUBufferBindingType) => ({ visibility, buffer: { type } });
      const layout = d.createBindGroupLayout({
        entries: [
          buffer('uniform'),
          buffer('uniform'),
          buffer('read-only-storage'),
          ...[3, 4, 5, 6, 7].map(() => buffer('storage')),
        ].map((e, binding) => ({ binding, ...e })),
      });
      const module = d.createShaderModule({ code: shader }),
        pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [layout] }),
        entry = (entryPoint: string) =>
          d.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
      return { layout, cull: entry('cull'), scan: entry('scan'), scatter: entry('scatter') };
    })();
    this.frameBuffer ??= d.createBuffer({
      size: this.frame.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const m = c.camera.matrix,
      canvas = engine.canvas,
      ratio = canvas.clientWidth ? c.width / canvas.clientWidth : 1,
      f = this.frame;
    f.set(m);
    f.set(c.camera.planes, 16);
    f[40] = c.width;
    f[41] = (Math.hypot(m[1], m[5], m[9]) * c.height) / 2;
    f[42] = this.minRadius * ratio;
    d.queue.writeBuffer(this.frameBuffer, 0, f as Float32Array<ArrayBuffer>);
    const pass = c.encoder.beginComputePass(),
      p = this.pipelines,
      live = new Set<Geometry>();
    for (const batch of batches) {
      if (!batch.count) continue;
      const slot = this.slot(d, engine, batch);
      live.add(batch.geometry);
      const groups = Math.ceil(batch.count / 256);
      pass.setBindGroup(0, slot.group!);
      pass.setPipeline(p.cull);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(p.scan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(p.scatter);
      pass.dispatchWorkgroups(groups);
      batch.redirect = { instances: slot.drawn!, args: slot.args! };
      this.redirected.push(batch);
    }
    pass.end();
    for (const [geometry, slot] of this.slots)
      if (!live.has(geometry)) {
        for (const b of slot.buffers) b.destroy();
        this.slots.delete(geometry);
      }
  }
  // Per-geometry storage, sized to the batch count (doubling) and rebound when core replaces its instance buffer.
  private slot(d: GPUDevice, engine: Engine, batch: Batch): Slot {
    let slot = this.slots.get(batch.geometry);
    if (!slot) this.slots.set(batch.geometry, (slot = { capacity: 0, buffers: [], data: new Uint32Array(8) }));
    const instance = engine.geometryBuffers(batch.geometry)!.instance;
    if (batch.count > slot.capacity) {
      for (const b of slot.buffers) b.destroy();
      const n = Math.max(256, 2 ** Math.ceil(Math.log2(batch.count))),
        S = GPUBufferUsage.STORAGE,
        make = (size: number, usage: number) => {
          const b = d.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
          slot!.buffers.push(b);
          return b;
        };
      slot.buffers = [];
      slot.capacity = n;
      slot.uniform = make(32, GPUBufferUsage.UNIFORM);
      slot.drawn = make(n * 96, S | GPUBufferUsage.VERTEX);
      slot.args = make(20, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
      make(n * 4, S);
      make(n * 4, S);
      make(Math.ceil(n / 256) * 4, S);
      slot.instance = undefined;
    }
    if (slot.instance !== instance) {
      const [, , , visible, local, groups] = slot.buffers,
        r = (buffer: GPUBuffer): GPUBindingResource => ({ buffer });
      slot.group = d.createBindGroup({
        layout: this.pipelines!.layout,
        entries: [
          r(this.frameBuffer!),
          r(slot.uniform!),
          r(instance),
          r(visible),
          r(local),
          r(groups),
          r(slot.drawn!),
          r(slot.args!),
        ].map((resource, binding) => ({ binding, resource })),
      });
      slot.instance = instance;
    }
    const words = slot.data;
    words[0] = batch.count;
    words[1] = batch.geometry.indices.length;
    new Float32Array(words.buffer).set(batch.geometry.bounds, 4);
    d.queue.writeBuffer(slot.uniform!, 0, words as Uint32Array<ArrayBuffer>);
    return slot;
  }
  // Core draws batches without a redirect from its own instance buffer, as before.
  private restore(): void {
    for (const batch of this.redirected) batch.redirect = undefined;
    this.redirected = [];
  }
  private release(): void {
    this.restore();
    for (const slot of this.slots.values()) for (const b of slot.buffers) b.destroy();
    this.slots.clear();
    this.frameBuffer?.destroy();
    this.frameBuffer = this.pipelines = undefined;
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
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
