/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/splats/edit: pick, select, erase and paint splats on the GPU, for capture clean-up tools. Every operation
// is one compute dispatch over the cloud's splats against the ellipses its projection pass wrote for the last frame,
// so a brush stroke costs the same for 10 thousand or 3 million splats and needs no CPU copy of the projection.
// Picking takes the nearest splat whose Gaussian at the pixel reaches a threshold, with the colour pass's 3 sigma
// falloff (Kerbl et al. 2023, "3D Gaussian Splatting", App. C); nearest by two atomic-min passes, first over the
// view depth as an order-preserving integer, then over the indices at that depth, so ties resolve to the lowest index.
// Painting a cloud with spherical harmonics sets the DC term to the blended colour and fades the higher bands by the
// same strength (the 3DGS SH convention: colour = 0.5 + 0.2820948 DC + ...; Sloan 2008, App. A).
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { viewMatrix } from '../../shared/view.js';
import type { SplatData } from './data.js';
import type { Splats } from './index.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  STORAGE: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/**
 * A brush region in pixels of the frame the cloud last drew (`SplatBrush.frame`), from its top-left corner: a circle
 * (`x`, `y`, `radius`) or a rectangle (`x`, `y`, `width`, `height`). A splat is in the region when its projected
 * centre is, and it was drawn in that frame.
 */
export type BrushRegion =
  | { x: number; y: number; radius: number }
  | { x: number; y: number; width: number; height: number };
/** How `select` combines a region with the current selection. */
export type SelectMode = 'replace' | 'add' | 'subtract';
/** What `erase` and `paint` change: the splats in a region, the selected splats, or every splat. */
export type BrushTarget = BrushRegion | 'selection' | 'all';

/**
 * WGSL of the brush, one entry point for every operation. Uniform: view matrix, region (circle x, y, radius or rect
 * x0, y0, x1, y1, pixels), colour (rgb, a strength), params (x pick threshold, y and z frame size), counts (x splats,
 * y operation: 0 to 2 select replace, add, subtract, 3 erase, 4 paint, 5 and 6 the two pick passes; z target: 0 circle,
 * 1 rect, 2 selection, 3 all; w SH coefficients per channel).
 */
export const brushShader = `struct Brush {view:mat4x4f,region:vec4f,color:vec4f,params:vec4f,counts:vec4u}
struct Ellipse {center:vec4f,axes:vec4f}
@group(0) @binding(0) var<uniform> u:Brush;
@group(0) @binding(1) var<storage,read> ellipses:array<Ellipse>;
@group(0) @binding(2) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> colors:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> sh:array<f32>;
@group(0) @binding(5) var<storage,read_write> mask:array<u32>;
@group(0) @binding(6) var<storage,read_write> result:array<atomic<u32>,2>;
fn drawn(i:u32)->bool {let e=ellipses[i];return positions[i].w>0&&e.center.w>0&&any(e.axes!=vec4f(0));}
fn inside(i:u32)->bool {
  let t=u.counts.z;if(t==3u){return true;}if(t==2u){return mask[i]!=0u;}if(!drawn(i)){return false;}
  let c=ellipses[i].center;let p=vec2f((c.x+1)*0.5*u.params.y,(1-c.y)*0.5*u.params.z);
  if(t==0u){let d=p-u.region.xy;return dot(d,d)<=u.region.z*u.region.z;}return all(p>=u.region.xy)&&all(p<=u.region.zw);
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x;if(i>=u.counts.x){return;}let op=u.counts.y;
  if(op<=2u){let hit=inside(i);if(op==0u){mask[i]=u32(hit);}else if(hit){mask[i]=u32(op==1u);}return;}
  if(op==3u){if(inside(i)){positions[i].w=0;colors[i].a=0;}return;}
  if(op==4u){
    if(positions[i].w<=0||!inside(i)){return;}let s=u.color.a;let c=colors[i];colors[i]=vec4f(mix(c.rgb,u.color.rgb,s),c.a);
    let k=u.counts.w;if(k==0u){return;}let at=i*k*3;let dc=vec3f(sh[at],sh[at+1],sh[at+2]);
    let n=(mix(vec3f(0.5)+0.2820947918*dc,u.color.rgb,s)-vec3f(0.5))/0.2820947918;sh[at]=n.x;sh[at+1]=n.y;sh[at+2]=n.z;
    for(var j=3u;j<k*3u;j++){sh[at+j]*=1-s;}return;
  }
  if(!drawn(i)){return;}let e=ellipses[i];
  let d=vec2f(2*(u.region.x+0.5)/u.params.y-1,1-2*(u.region.y+0.5)/u.params.z)-e.center.xy;
  let a=dot(d,e.axes.xy)/dot(e.axes.xy,e.axes.xy);let b=dot(d,e.axes.zw)/dot(e.axes.zw,e.axes.zw);let power=-4.5*(a*a+b*b);
  if(power<-4.5||min(0.99,e.center.w*exp(power))<u.params.x){return;}
  // The view depth as an integer in the same order (negative floats too, for orthographic cameras).
  let bits=bitcast<u32>(-(u.view*vec4f(positions[i].xyz,1)).z);let key=select(bits^0x80000000u,~bits,(bits>>31u)==1u);
  if(op==5u){atomicMin(&result[0],key);}else if(key==atomicLoad(&result[0])){atomicMin(&result[1],i);}
}`;

const targets = { circle: 0, rect: 1, selection: 2, all: 3 } as const;

/**
 * GPU picking and brush editing of a splat cloud: `const brush = SplatBrush.attach(engine, cloud)`, then
 * `await brush.pick(x, y)`, `brush.select(region)`, `brush.erase('selection')` or `brush.paint(region, [1, 0, 0])`
 * in pixels of the last drawn frame. Edits change the cloud's GPU buffers at once (shown from the next frame);
 * `await brush.commit()` copies them into the cloud's data (`Splats.read`), which export and device restoration use.
 * WebGPU only, as `Splats`.
 * @throws TypeError when `cloud` is not a Splats; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` before the cloud has drawn a frame.
 */
export class SplatBrush implements EnginePlugin {
  private static next = 0;
  readonly name = 'splats-brush:' + SplatBrush.next++;
  readonly cloud: Splats;
  private engine?: Engine;
  private device?: GPUDevice;
  private width = 0;
  private height = 0;
  private readonly data = new Float32Array(32);
  private readonly integers = new Uint32Array(this.data.buffer);
  private uniform?: GPUBuffer;
  private result?: GPUBuffer;
  private mask?: GPUBuffer;
  private pipeline?: GPUComputePipeline;
  private group?: { group: GPUBindGroup; ellipses: GPUBuffer };
  private dead = false;
  constructor(cloud: Splats) {
    if (!cloud || typeof cloud !== 'object' || !('gpuState' in cloud))
      throw new TypeError('SplatBrush needs a Splats cloud');
    this.cloud = cloud;
  }
  /** Same as `engine.use(new SplatBrush(cloud))`; returns it. */
  static attach(engine: EngineKernel, cloud: Splats): SplatBrush {
    const brush = new SplatBrush(cloud);
    engineRuntime(engine).use(brush);
    return brush;
  }
  /** Width and height in pixels of the frame the cloud last drew, the space of every region and pick; 0 before. */
  get frame(): [number, number] {
    return [this.width, this.height];
  }
  setup(engine: Engine): void {
    if (this.dead || !engine.gpu)
      throw new MargoError(
        this.dead ? 'disposed' : 'unsupported',
        'SplatBrush needs WebGPU; attach a new SplatBrush to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = engine.gpu.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.result = engine.gpu.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  }
  registerPasses(graph: FrameGraph): void {
    // After the cloud projects (order -7): the frame size and view its ellipses were made with.
    graph.add({
      name: this.name,
      order: -6.9,
      execute: (c: PassContext) => {
        if (c.backend !== 'webgpu' || !this.cloud.attached) return;
        this.width = c.width;
        this.height = c.height;
        viewMatrix(this.data.subarray(0, 16), c.camera);
      },
    });
  }
  /**
   * The index of the nearest splat drawn at pixel (`x`, `y`) whose own opacity there (its Gaussian falloff times its
   * opacity) reaches `threshold`, or -1 when none does.
   * @throws RangeError for a threshold outside 0 to 1 or a non-finite pixel.
   */
  async pick(x: number, y: number, threshold = 0.1): Promise<number> {
    if (!(threshold >= 0 && threshold <= 1)) throw new RangeError('SplatBrush.pick threshold must be 0 to 1');
    const d = this.ready({ x, y, radius: 0 }),
      read = d.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.data[24] = threshold;
    d.queue.writeBuffer(this.result!, 0, new Uint32Array([0xffffffff, 0xffffffff]));
    // Two submissions: each pass reads the uniform as written just before it.
    this.submit(5, { x, y, radius: 0 });
    const e = d.createCommandEncoder();
    this.run(e, 6);
    e.copyBufferToBuffer(this.result!, 0, read, 0, 8);
    d.queue.submit([e.finish()]);
    try {
      await read.mapAsync(GPUMapMode.READ);
      const index = new Uint32Array(read.getMappedRange())[1];
      return index === 0xffffffff ? -1 : index;
    } finally {
      read.destroy();
    }
  }
  /**
   * Selects the splats in `region` ('all' for every splat, 'none' for none), replacing the selection, adding to it or
   * taking from it.
   * @throws RangeError for an invalid region or mode.
   */
  select(region: BrushRegion | 'all' | 'none', mode: SelectMode = 'replace'): this {
    const op = ['replace', 'add', 'subtract'].indexOf(mode);
    if (op < 0) throw new RangeError("SplatBrush.select mode must be 'replace', 'add' or 'subtract'");
    if (region === 'none') return mode === 'replace' ? this.submit(2, 'all') : this;
    return this.submit(op, region);
  }
  /** The indices of the selected splats, in order. */
  async selection(): Promise<Uint32Array> {
    const d = this.ready('all'),
      size = this.cloud.count * 4,
      read = d.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      e = d.createCommandEncoder();
    e.copyBufferToBuffer(this.mask!, 0, read, 0, size);
    d.queue.submit([e.finish()]);
    try {
      await read.mapAsync(GPUMapMode.READ);
      const mask = new Uint32Array(read.getMappedRange()),
        out: number[] = [];
      for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
      return Uint32Array.from(out);
    } finally {
      read.destroy();
    }
  }
  /** Hides the target's splats (opacity 0), as `Splats.clear` does. The selection is kept. */
  erase(target: BrushTarget = 'selection'): this {
    return this.submit(3, target);
  }
  /**
   * Blends the target's colour toward `color` (linear RGB, each 0 to 1) by `strength` (0 to 1); opacity is kept.
   * @throws RangeError for a colour or strength outside 0 to 1.
   */
  paint(target: BrushTarget, color: ArrayLike<number>, strength = 1): this {
    if (color?.length !== 3 || ![...Array.from(color), strength].every((v) => v >= 0 && v <= 1))
      throw new RangeError('SplatBrush.paint needs an RGB colour and a strength, each 0 to 1');
    this.data.set([color[0], color[1], color[2], strength], 20);
    return this.submit(4, target);
  }
  /** Copies the GPU edits into the cloud's data and returns it: `cloud.read()`. */
  commit(): Promise<SplatData> {
    return this.cloud.read();
  }
  /** Checks the state and writes the region, ready for a dispatch; returns the device. */
  private ready(region: BrushTarget): GPUDevice {
    if (this.dead || !this.device)
      throw new MargoError('disposed', 'SplatBrush is disposed or not attached; attach a new one');
    if (!this.width || !this.cloud.attached)
      throw new MargoError('state', 'SplatBrush works on a drawn frame; render the engine once before editing');
    const d = this.device,
      state = this.cloud.gpuState,
      v = this.data;
    let target: number;
    if (typeof region === 'string') target = targets[region];
    else {
      const circle = 'radius' in region,
        values = circle ? [region.x, region.y, region.radius] : [region.x, region.y, region.width, region.height];
      if (!values.every(Number.isFinite) || values.slice(2).some((s) => s < 0))
        throw new RangeError('A brush region needs finite x and y and a radius, or a width and height, of 0 or more');
      target = circle ? 0 : 1;
      v.set(
        circle
          ? [region.x, region.y, region.radius, 0]
          : [region.x, region.y, region.x + values[2], region.y + values[3]],
        16,
      );
    }
    if (target === undefined) throw new RangeError("A brush target must be a region, 'selection' or 'all'");
    v[25] = this.width;
    v[26] = this.height;
    this.integers[28] = this.cloud.count;
    this.integers[30] = target;
    this.integers[31] = this.cloud.coefficients;
    // A restored device or a re-attached cloud hands new buffers: the mask (and so the selection) starts again.
    if (!this.group || this.group.ellipses !== state.ellipses) {
      this.mask?.destroy();
      this.mask = d.createBuffer({
        size: this.cloud.count * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      this.pipeline ??= d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: brushShader }), entryPoint: 'main' },
      });
      this.group = {
        group: d.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            this.uniform!,
            state.ellipses,
            state.positions,
            state.inputColors,
            state.sh,
            this.mask,
            this.result!,
          ].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
        ellipses: state.ellipses,
      };
    }
    return d;
  }
  private submit(op: number, target: BrushTarget): this {
    const d = this.ready(target),
      e = d.createCommandEncoder();
    this.run(e, op);
    d.queue.submit([e.finish()]);
    return this;
  }
  private run(e: GPUCommandEncoder, op: number): void {
    this.integers[29] = op;
    this.device!.queue.writeBuffer(this.uniform!, 0, this.data);
    const pass = e.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!.group);
    pass.dispatchWorkgroups(Math.ceil(this.cloud.count / 256));
    pass.end();
  }
  onDeviceRestored(engine: Engine): void {
    this.mask?.destroy();
    this.mask = this.pipeline = this.group = undefined;
    this.width = 0;
    this.setup(engine);
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.engine?.removePlugin(this.name);
    for (const b of [this.uniform, this.result, this.mask]) b?.destroy();
    this.uniform = this.result = this.mask = this.pipeline = this.group = this.device = this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
