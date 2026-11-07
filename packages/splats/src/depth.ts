/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/splats/depth: writes a splat cloud's depth into the scene depth buffer after the cloud has drawn, so
// whatever draws later (meshes of later passes, other clouds, points, particles, depth-reading post effects) is hidden
// behind the capture where it is solid, while meshes drawn before the cloud keep hiding the splats behind them through
// the cloud's own depth test. A pixel takes the depth of the nearest splat whose Gaussian opacity there reaches
// `threshold`: alpha-tested depth from the same ellipses and the same 3 sigma falloff the colour pass draws
// (Kerbl et al. 2023, App. C; EWA ellipses: Zwicker et al. 2001), written by the rasteriser at the splat's centre depth.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { applyView } from '../../shared/view-rect.js';
import type { Splats } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link SplatDepth}. */
export interface SplatDepthOptions {
  /** Opacity (0 to 1) a splat must reach at a pixel to write its depth there. Default 0.5. Live: `depth.threshold`. */
  threshold?: number;
  /** Frame-graph order of the depth pass. Default 3.5: right after the clouds draw (order 3). */
  order?: number;
}

// Same quad and falloff as the colour pass (shader.ts `render`): corner c covers 3 sigma, alpha = opacity * exp(-4.5|c|^2).
const code = `struct Ellipse {center:vec4f,axes:vec4f}
@group(0) @binding(0) var<uniform> threshold:vec4f;
@group(0) @binding(1) var<storage,read> ellipses:array<Ellipse>;
@group(0) @binding(2) var<storage,read> sorted:array<vec2u>;
struct Out {@builtin(position) clip:vec4f,@location(0) corner:vec2f,@location(1) @interpolate(flat) opacity:f32}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {
  let corners=array<vec2f,4>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(1,1));let e=ellipses[sorted[instance].y];let corner=corners[vertex];var o:Out;
  o.clip=vec4f(e.center.xy+e.axes.xy*corner.x+e.axes.zw*corner.y,e.center.z,1);o.corner=corner;o.opacity=e.center.w;
  if(e.center.w<threshold.x){o.clip=vec4f(2,2,0,1);}return o;
}
@fragment fn fragment(i:Out) {let power=-4.5*dot(i.corner,i.corner);if(power<-4.5||min(0.99,i.opacity*exp(power))<threshold.x){discard;}}`;

/**
 * Depth for a splat cloud: `SplatDepth.attach(engine, cloud)`. Each frame after the cloud draws, its splats write their
 * depth (reversed Z, greater wins) where their opacity reaches `threshold`; no colour is written. WebGPU only.
 * @throws RangeError for a threshold outside 0 to 1 or a non-finite order; TypeError when `cloud` is not a Splats.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` when attached after `dispose()`.
 */
export class SplatDepth implements EnginePlugin {
  private static next = 0;
  readonly name = 'splats-depth:' + SplatDepth.next++;
  readonly cloud: Splats;
  readonly order: number;
  private value: number;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private readonly data = new Float32Array(4);
  private pipelines = new Map<string, GPURenderPipeline>();
  private group?: { group: GPUBindGroup; ellipses: GPUBuffer; sorted: GPUBuffer; layout: GPUBindGroupLayout };
  private disposed = false;
  constructor(cloud: Splats, options: SplatDepthOptions = {}) {
    if (!cloud || typeof cloud !== 'object' || !('gpuState' in cloud)) throw new TypeError('SplatDepth needs a Splats cloud');
    this.cloud = cloud;
    this.value = check(options.threshold ?? 0.5);
    this.order = options.order ?? 3.5;
    if (!Number.isFinite(this.order)) throw new RangeError('SplatDepth order must be a finite number');
  }
  /** Same as `engine.use(new SplatDepth(cloud, options))`; returns it. */
  static attach(engine: EngineKernel, cloud: Splats, options: SplatDepthOptions = {}): SplatDepth {
    const depth = new SplatDepth(cloud, options);
    engineRuntime(engine).use(depth);
    return depth;
  }
  /** Opacity a splat must reach at a pixel to write its depth (0 to 1). */
  get threshold(): number {
    return this.value;
  }
  set threshold(value: number) {
    this.value = check(value);
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'SplatDepth needs WebGPU and a live depth pass; attach a new SplatDepth to a WebGPU engine',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private draw(c: Context): void {
    // A cloud not attached yet, or disposed, has nothing to write.
    if (!this.cloud.attached) return;
    const state = this.cloud.gpuState;
    const samples = c.descriptor.multisample?.count ?? 1,
      format = c.descriptor.depthStencil!.format,
      key = samples + ':' + format;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [] },
        primitive: { topology: 'triangle-strip' },
        multisample: c.descriptor.multisample,
        depthStencil: { format, depthWriteEnabled: true, depthCompare: 'greater' },
      });
      this.pipelines.set(key, pipeline);
    }
    const layout = pipeline.getBindGroupLayout(0);
    // A restored device or a re-attached cloud hands new buffers: the group follows them.
    if (!this.group || this.group.ellipses !== state.ellipses || this.group.sorted !== state.sorted || this.group.layout !== layout)
      this.group = {
        group: c.device.createBindGroup({
          layout,
          entries: [this.uniform!, state.ellipses, state.sorted].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
        ellipses: state.ellipses,
        sorted: state.sorted,
        layout,
      };
    this.data[0] = this.value;
    c.device.queue.writeBuffer(this.uniform!, 0, this.data);
    const stencil = format.includes('stencil'),
      pass = c.encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: c.depth,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
          ...(stencil ? { stencilReadOnly: true } : {}),
        },
      });
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group.group);
    pass.draw(4, this.cloud.count);
    pass.end();
    this.engine!.stats.drawCalls++;
  }
  onDeviceRestored(engine: Engine): void {
    this.pipelines.clear();
    this.group = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.uniform?.destroy();
    this.uniform = this.group = this.engine = undefined;
    this.pipelines.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

function check(value: number): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new RangeError('SplatDepth threshold must be 0 to 1');
  return value;
}
