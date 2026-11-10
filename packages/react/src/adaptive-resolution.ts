import type { Engine, RenderView } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Frames } from './internal.js';
import { frameOutput } from './frame-priority.js';

interface Hold { scale: () => number; pixelated: boolean }
const managers = new WeakMap<Engine, AdaptiveResolution>();
const shader = `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
struct Varying { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Varying {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Varying; out.position = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y); return out;
}
@fragment fn fs(v: Varying) -> @location(0) vec4f { return textureSample(image, filtering, v.uv); }
`;
/** Package-owned presentation; the Canvas and native MSAA configuration stay at their original dimensions. */
class AdaptiveResolution {
  readonly name = 'react-adaptive-resolution';
  readonly holds = new Set<Hold>();
  private releaseOutput: () => void = () => {};
  private readonly pick: Engine['pick'];
  private readonly pickProperty;
  private readonly adaptedPick: Engine['pick'];
  private views: readonly RenderView[] | null = null;
  private texture: GPUTexture | null = null;
  private device: GPUDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private groups: GPUBindGroup[] = [];
  private closed = false;
  constructor(private readonly engine: Engine, frames: Frames) {
    this.pick = engine.pick;
    this.pickProperty = Object.getOwnPropertyDescriptor(engine, 'pick');
    this.adaptedPick = (x, y, view) => {
      if (view || !this.views) return this.pick.call(engine, x, y, view);
      const w = engine.canvas.clientWidth || engine.canvas.width, h = engine.canvas.clientHeight || engine.canvas.height;
      if (x < 0 || y < 0 || x >= w || y >= h) return Promise.resolve(null);
      const px = x * engine.canvas.width / w, py = y * engine.canvas.height / h;
      const inside = (rect: readonly number[], pixels?: boolean) => {
        const [rx, ry, rw, rh] = pixels ? rect : [rect[0] * engine.canvas.width, rect[1] * engine.canvas.height, rect[2] * engine.canvas.width, rect[3] * engine.canvas.height];
        return px >= rx && py >= ry && px < rx + rw && py < ry + rh;
      };
      for (let i = this.views.length - 1; i >= 0; i--) {
        const candidate = this.views[i];
        if (inside(candidate.viewport, candidate.pixels) && (!candidate.scissor || inside(candidate.scissor, candidate.pixels)))
          return this.pick.call(engine, x, y, candidate);
      }
      return Promise.resolve(null);
    };
    this.releaseOutput = frameOutput(frames, (options, render) => this.draw(options, render));
    engine.pick = this.adaptedPick;
  }
  setup(): void {}
  onDeviceRestored(): void { this.releaseGPU(); }
  private draw(options: Parameters<Engine['render']>[0], render: Engine['render']): void {
    const source: readonly RenderView[] = options?.views ?? [{ camera: options?.camera ?? this.engine.camera, viewport: [0, 0, 1, 1] }];
    const canvasViews = source.filter(view => !view.target);
    if (!canvasViews.length) { render(options); return; }
    let scale = 1, pixelated = false;
    for (const hold of this.holds) { scale = Math.min(scale, hold.scale()); pixelated ||= hold.pixelated; }
    if (scale >= 1) {
      render(options); this.views = null; this.releaseGPU();
      if (!this.holds.size) this.engine.scene.removePlugin(this.name);
      return;
    }
    const engine = this.engine, device = engine.gpu!, target = engine.renderTarget!;
    // Match the public Canvas's native backing size without touching its tier or MSAA selection.
    const cap = globalThis.margoLow, samples = cap ? 1 : target.samples;
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, cap || 2, 4 / samples);
    const native = (size: number, fallback: number) => Math.max(1, Math.min(4096, Math.round(size * dpr) || fallback));
    const width = Math.max(1, Math.round(native(engine.canvas.clientWidth, engine.canvas.width) * scale));
    const height = Math.max(1, Math.round(native(engine.canvas.clientHeight, engine.canvas.height) * scale));
    if (this.device !== device || this.texture?.width !== width || this.texture?.height !== height || this.texture?.format !== target.format) {
      this.releaseGPU(); this.device = device;
      // GPUTextureUsage.RENDER_ATTACHMENT | TEXTURE_BINDING, per WebGPU's stable flags.
      this.texture = device.createTexture({ label: 'React adaptive scene', size: [width, height], format: target.format, usage: 0x10 | 0x04 });
      const module = device.createShaderModule({ label: 'React adaptive present', code: shader });
      this.pipeline = device.createRenderPipeline({ label: 'React adaptive present', layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: target.format }] }, primitive: { topology: 'triangle-list' } });
      this.groups = ['linear', 'nearest'].map(filter => device.createBindGroup({ layout: this.pipeline!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.texture!.createView() },
        { binding: 1, resource: device.createSampler({ minFilter: filter as GPUFilterMode, magFilter: filter as GPUFilterMode }) },
      ] }));
    }
    const rect = (value: readonly [number, number, number, number]) => [Math.round(value[0] * scale), Math.round(value[1] * scale), Math.max(1, Math.round((value[0] + value[2]) * scale) - Math.round(value[0] * scale)), Math.max(1, Math.round((value[1] + value[3]) * scale) - Math.round(value[1] * scale))] as const;
    const views = source.map(view => view.target ? view : { ...view, target: { color: this.texture! }, viewport: view.pixels ? rect(view.viewport) : view.viewport, scissor: view.pixels && view.scissor ? rect(view.scissor) : view.scissor });
    render({ ...options, views });
    this.views = canvasViews.map(view => ({ ...view, viewport: [...view.viewport], scissor: view.scissor && [...view.scissor] }));
    const context = engine.canvas.getContext('webgpu') as GPUCanvasContext;
    const encoder = device.createCommandEncoder({ label: 'React adaptive present' });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }] });
    pass.setPipeline(this.pipeline!); pass.setBindGroup(0, this.groups[pixelated ? 1 : 0]); pass.draw(3); pass.end();
    device.queue.submit([encoder.finish()]);
  }
  releaseGPU(): void { this.texture?.destroy(); this.texture = null; this.pipeline = null; this.groups = []; this.device = null; }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.releaseGPU(); this.releaseOutput(); this.views = null; this.holds.clear();
    if (this.engine.pick === this.adaptedPick) {
      if (this.pickProperty) Object.defineProperty(this.engine, 'pick', this.pickProperty);
      else Reflect.deleteProperty(this.engine, 'pick');
    }
    managers.delete(this.engine);
  }
}
export function adaptiveResolution(engine: Engine, frames: Frames, scale: () => number, pixelated: boolean): () => void {
  if (engine.backend !== 'webgpu' || !engine.gpu || !engine.renderTarget)
    throw new MargoError('unsupported', 'AdaptiveDpr requires the WebGPU renderer or WebGL2 compatibility layer; use one of those renderers. See https://margoengine.com/errors#webgpu');
  let manager = managers.get(engine);
  if (!manager) {
    manager = new AdaptiveResolution(engine, frames);
    try { engine.scene.use(manager); } catch (error) { manager.dispose(); throw error; }
    managers.set(engine, manager);
  }
  const hold = { scale, pixelated }; manager.holds.add(hold);
  const owner = manager;
  return () => {
    owner.holds.delete(hold);
    if (!owner.holds.size) owner.releaseGPU();
    // Retain logical picking until the next unscaled draw, including an idle demand Canvas.
  };
}
