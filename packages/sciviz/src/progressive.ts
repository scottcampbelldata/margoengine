// Clean-room policy and references: docs/sciviz-progressive.md and docs/clean-room.md.
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { SceneTarget } from '../../shared/msaa.js';
import { applyView } from '../../shared/view-rect.js';
import { fault } from '../../shared/errors.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { Figure } from './figure.js';
import { requireGPU, type Drawable, type GpuContext } from './render.js';
import { ProgressivePolicy, type ProgressiveOptions, type ProgressiveState } from './progressive-policy.js';
export type { ProgressiveOptions, ProgressiveState } from './progressive-policy.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };

interface ViewState {
  policy: ProgressivePolicy;
  signature: string;
  target?: SceneTarget;
  width?: number;
  height?: number;
  format?: GPUTextureFormat;
}

/** Camera-aware low-resolution rendering, bounded sample work and frame-by-frame refinement. One per engine. */
export class ProgressiveRendering implements EnginePlugin {
  /** Engine plugin identity. */
  readonly name = 'sciviz-progressive';
  readonly #figure: Figure;
  readonly #options: ProgressiveOptions;
  readonly #views = new Map<string, ViewState>();
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  #engine: Engine | undefined;
  #active: { view: ViewState; width: number; height: number; rectangle: GpuContext['view'] } | undefined;
  #state: ProgressiveState = { moving: true, progress: 0, resolutionScale: 0.5, sampleScale: 0.25 };
  #started = 0;
  #pending = false;
  #generation = 0;
  #disposed = false;
  readonly #lifetime: Drawable = {
    visible: false,
    transparent: false,
    center: () => [0, 0, 0],
    restore() {},
    draw() {},
    dispose: () => this.dispose(),
  };

  /** Creates the controller and attaches it to the figure's engine; same as `new ProgressiveRendering(figure, options)`. */
  static attach(figure: Figure, options: ProgressiveOptions = {}): ProgressiveRendering {
    return new this(figure, options);
  }
  /** Attaches to the figure's engine. Existing layer settings and canvas dimensions are retained. */
  constructor(figure: Figure, options: ProgressiveOptions = {}) {
    requireGPU(figure.renderer);
    const policy = new ProgressivePolicy(options);
    this.#options = policy.options;
    this.#figure = figure;
    this.#state = policy.next(true);
    if (figure.engine.hasPlugin(this.name))
      throw fault('state', 'An engine already has progressive rendering; dispose its controller first', 'sciviz');
    figure.renderer.engine.use(this);
    figure.renderer.add(this.#lifetime);
  }
  /** Most recently rendered view's settings; the snapshot is immutable to callers. */
  get state(): ProgressiveState {
    return { ...this.#state };
  }
  /** @internal */
  setup(engine: Engine): void {
    requireWebGPU(engine, 'Progressive rendering');
    this.#engine = engine;
  }
  /** @internal */
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':begin',
      order: -10000,
      execute: (c) => {
        if (c.backend === 'webgpu' && !this.#disposed) this.#begin(c);
      },
    });
    graph.add({
      name: this.name + ':present',
      order: 10000,
      execute: (c) => {
        if (c.backend === 'webgpu' && !this.#disposed) this.#present(c);
      },
    });
  }
  /** Feed an application's measured submitted-frame latency. Automatic feedback also runs without blocking. */
  recordFrameTime(milliseconds: number): void {
    if (this.#disposed) throw fault('state', 'Progressive rendering is disposed; create a new controller', 'sciviz');
    // Validate even before the first frame.
    const probe = new ProgressivePolicy(this.#options);
    probe.feedback(milliseconds);
    for (const view of this.#views.values()) view.policy.feedback(milliseconds);
  }
  #begin(c: GpuContext): void {
    this.#started = performance.now();
    const key = c.view?.id ?? '';
    let view = this.#views.get(key);
    if (!view) {
      view = { policy: new ProgressivePolicy(this.#options), signature: '' };
      this.#views.set(key, view);
    }
    const signature = [
      ...c.camera.matrix,
      ...c.camera.position,
      c.width,
      c.height,
      ...(c.view?.viewport ?? []),
      ...(c.view?.scissor ?? []),
    ].join(',');
    this.#state = view.policy.next(signature !== view.signature);
    view.signature = signature;
    this.#figure.renderer.samplingScale = this.#state.sampleScale;
    this.#active = undefined;
    if (this.#state.resolutionScale === 1) {
      this.#release(view);
      return;
    }
    const width = Math.max(1, Math.round(c.width * this.#state.resolutionScale));
    const height = Math.max(1, Math.round(c.height * this.#state.resolutionScale));
    if (!view.target || view.width !== width || view.height !== height || view.format !== c.format) {
      this.#release(view);
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
      const colour = c.device.createTexture({ size: [width, height], format: c.format, usage });
      const depth = c.device.createTexture({ size: [width, height], format: 'depth32float', usage });
      view.target = new SceneTarget(c.device, colour, depth, 1);
      view.width = width;
      view.height = height;
      view.format = c.format;
    }
    this.#active = { view, width: c.width, height: c.height, rectangle: c.view };
    view.target.begin(c);
    const sx = width / c.width,
      sy = height / c.height;
    c.width = width;
    c.height = height;
    if (c.view) {
      const scale = (r: readonly [number, number, number, number]): [number, number, number, number] => {
        const x = Math.min(width - 1, Math.floor(r[0] * sx)),
          y = Math.min(height - 1, Math.floor(r[1] * sy));
        return [
          x,
          y,
          Math.max(1, Math.min(width, Math.ceil((r[0] + r[2]) * sx)) - x),
          Math.max(1, Math.min(height, Math.ceil((r[1] + r[3]) * sy)) - y),
        ];
      };
      c.view = { ...c.view, viewport: scale(c.view.viewport), scissor: c.view.scissor && scale(c.view.scissor) };
    }
  }
  #present(c: GpuContext): void {
    const active = this.#active;
    if (active) {
      const target = active.view.target!;
      target.restore(c);
      c.width = active.width;
      c.height = active.height;
      c.view = active.rectangle;
      const key = `${c.format}|${c.descriptor.depthStencil!.format}|${c.descriptor.multisample?.count ?? 1}`;
      let pipeline = this.#pipelines.get(key);
      if (!pipeline) {
        const module = c.device.createShaderModule({
          code: `
@group(0) @binding(0) var colour:texture_2d<f32>;
@group(0) @binding(1) var depth:texture_depth_2d;
struct Out { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
 let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
 var o:Out;o.position=vec4f(p[i],0.0,1.0);o.uv=vec2f(p[i].x*0.5+0.5,0.5-p[i].y*0.5);return o;
}
struct Pixel { @location(0) colour:vec4f, @builtin(frag_depth) depth:f32 }
@fragment fn fragment(in:Out)->Pixel {
 let size=vec2i(textureDimensions(colour));let q=clamp(vec2i(in.uv*vec2f(size)),vec2i(0),size-1);
 var o:Pixel;o.colour=textureLoad(colour,q,0);o.depth=textureLoad(depth,q,0);return o;
}`,
        });
        pipeline = c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
          depthStencil: { format: c.descriptor.depthStencil!.format, depthWriteEnabled: true, depthCompare: 'always' },
          multisample: c.descriptor.multisample,
        });
        this.#pipelines.set(key, pipeline);
      }
      const group = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: target.resolvedColor.createView() },
          { binding: 1, resource: target.resolvedDepth.createView() },
        ],
      });
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: c.depth,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
          ...(c.descriptor.depthStencil!.format.includes('stencil') ? { stencilReadOnly: true } : {}),
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      // Source coordinates refer to the full reduced target, even for split views.
      if (c.view) {
        pass.setViewport(0, 0, c.width, c.height, 0, 1);
        const r = c.view.scissor ?? c.view.viewport;
        pass.setScissorRect(...r);
      } else applyView(pass, c);
      pass.draw(3);
      pass.end();
      this.#active = undefined;
    }
    this.#figure.renderer.samplingScale = 1;
    if (!this.#pending && (c.view?.index ?? 0) === (c.view ? c.view.count - 1 : 0)) {
      const generation = this.#generation,
        device = c.device,
        started = this.#started,
        moving = this.#state.moving;
      this.#pending = true;
      // The engine submits the current encoder before this microtask runs.
      queueMicrotask(() => {
        if (generation !== this.#generation || this.#disposed) return;
        void device.queue.onSubmittedWorkDone().then(
          () => {
            if (generation !== this.#generation || this.#disposed) return;
            this.#pending = false;
            if (moving) this.recordFrameTime(Math.max(0.001, performance.now() - started));
          },
          (error: unknown) => {
            if (generation !== this.#generation || this.#disposed) return;
            this.#pending = false;
            this.#engine?.onError(error);
          },
        );
      });
    }
  }
  #release(view: ViewState): void {
    view.target?.dispose();
    view.target?.resolvedColor.destroy();
    view.target?.resolvedDepth.destroy();
    view.target = undefined;
  }
  /** @internal Layer restore remains owned by the figure and its engine plugins. */
  onDeviceRestored(): void {
    this.#generation++;
    this.#pending = false;
    for (const view of this.#views.values()) this.#release(view);
    this.#views.clear();
    this.#pipelines.clear();
    this.#active = undefined;
    this.#figure.renderer.samplingScale = 1;
  }
  /** Removes the passes and releases reduced targets. Original layer settings are never overwritten. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.onDeviceRestored();
    this.#figure.renderer.remove(this.#lifetime);
    this.#engine?.removePlugin(this.name);
    this.#engine = undefined;
  }
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Attach adaptive interaction and progressive resting refinement to a scientific figure. */
export function progressiveRendering(figure: Figure, options: ProgressiveOptions = {}): ProgressiveRendering {
  return new ProgressiveRendering(figure, options);
}
