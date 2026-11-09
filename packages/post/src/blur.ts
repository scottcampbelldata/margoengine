/// <reference lib="esnext.disposable" preserve="true" />
// Gaussian and box blur, an HDR PostStack stage. Separable: a horizontal pass from the stage input into an rgba16float
// texture, then a vertical pass into the output (or into a second rgba16float texture handed to the next HDR stage).
// Gaussian weights are exp(-x^2 / (2 sigma^2)) with sigma = radius / 3, normalised over the 2 radius + 1 taps; box
// weights are 1 / (2 radius + 1). Edges clamp to the nearest pixel. Inside `region` only; outside it the input passes.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type BlurPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Blur}; the object is kept and read every frame, so a focus pull animates `radius`. */
export interface BlurOptions {
  /** `'gaussian'` (default; sigma = radius / 3) or `'box'` (equal weights). */
  kind?: 'gaussian' | 'box';
  /** Half width of the kernel in pixels, 0 to 64 (fractions round to the nearest pixel). 0 passes the frame through. Default 8. */
  radius?: number;
  /** Part of the frame to blur, [x0, y0, x1, y1] in 0..1 of the view (y down), for a glass panel behind a menu.
   * Default the whole view. */
  region?: readonly [number, number, number, number];
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

/** Largest {@link BlurOptions.radius}. */
export const MAX_BLUR_RADIUS = 64;

// One pass along `u.axis`: weights from the kind and radius, taps clamped to the view; outside the region the input.
const blurShader = (display: boolean) => `${fullscreen}${display ? displayShader : ''}
struct U {axis:vec2i,radius:i32,box:i32,region:vec4f,size:vec2f,sigma:f32,pad:f32}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var original:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let size=vec2i(u.size);let uv=(vec2f(p)+0.5)/u.size;
 var out=textureLoad(original,p,0);
 if(all(uv>=u.region.xy)&&all(uv<u.region.zw)){
  var sum=vec4f(0);var total=0.0;
  for(var i=-u.radius;i<=u.radius;i++){
   let x=f32(i);let w=select(exp(-x*x/(2.0*u.sigma*u.sigma)),1.0,u.box==1);
   sum+=w*textureLoad(source,clamp(p+u.axis*i,vec2i(0),size-1),0);total+=w;
  }
  out=sum/total;
 }
 ${display ? 'return vec4f(toDisplay(out.rgb),out.a);' : 'return out;'}
}`;

/**
 * Gaussian or box blur in a PostStack (HDR effect), separable in two passes: menus behind glass (`region`), focus pulls
 * (animate `radius`) and custom chains (several Blurs, or a Blur between other HDR effects). `attach` runs it alone in
 * its own PostStack.
 * @throws TypeError when `enabled` is not a boolean; RangeError for a `kind`, `radius` or `region` out of range
 * (checked now and every frame); MargoError `'state'` outside a PostStack, `'unsupported'` without WebGPU, `'disposed'`
 * after `dispose()`, `'attached'` when joined twice.
 */
export class Blur implements EnginePlugin {
  readonly name = 'blur';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private readonly values = new ArrayBuffer(512);
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private pipelines = new Map<string, GPURenderPipeline>();
  private groups = new Map<string, GPUBindGroup>();
  private input?: GPUTextureView;
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };

  constructor(readonly options: BlurOptions = {}) {
    this.validate();
  }
  /** Attaches a new Blur to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: BlurOptions = {}): Blur {
    const effect = new Blur(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Mirrors `options.enabled`. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('Blur enabled must be a boolean; pass true or false');
    this.options.enabled = value;
  }
  /** Mirrors `options.radius` (pixels, 0 to {@link MAX_BLUR_RADIUS}). Default 8. */
  get radius(): number {
    return this.options.radius ?? 8;
  }
  set radius(value: number) {
    const before = this.options.radius;
    this.options.radius = value;
    try {
      this.validate();
    } catch (error) {
      this.options.radius = before;
      throw error;
    }
  }
  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'Blur is already attached; create a new Blur');
    this.stacked = true;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Blur is disposed; create a new Blur');
    if (!this.stacked)
      throw margoError('state', 'Blur runs inside a PostStack; use Blur.attach(engine) or add it to a PostStack');
    if (!engine.gpu) throw margoError('unsupported', 'Blur requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    // Two 256 B slices (the uniform offset alignment): the horizontal pass's and the vertical pass's uniform.
    this.uniform = engine.gpu.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  /** Removes the effect, releases its GPU resources and disposes the stack `attach` created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }
  /** A lost device: drop every resource of the old one and set up again on the new one. */
  onDeviceRestored(engine: Engine): void {
    this.engine = undefined;
    this.release();
    this.setup(engine);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private validate(): void {
    const o = this.options,
      r = o.region;
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Blur enabled must be a boolean; pass true or false');
    if (
      (o.kind !== undefined && o.kind !== 'gaussian' && o.kind !== 'box') ||
      (o.radius !== undefined && !(o.radius >= 0 && o.radius <= MAX_BLUR_RADIUS)) ||
      (r !== undefined &&
        (!Array.isArray(r) ||
          r.length !== 4 ||
          ![0, 1, 2, 3].every((i) => r[i] >= 0 && r[i] <= 1) ||
          !(r[0] < r[2] && r[1] < r[3])))
    )
      throw new RangeError(
        `Invalid Blur options; kind 'gaussian' or 'box', radius 0 to ${MAX_BLUR_RADIUS}, region [x0, y0, x1, y1] in 0..1 with x0 < x1 and y0 < y1.`,
      );
  }
  private draw(c: BlurPassContext, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const on = this.enabled && Math.round(this.radius) > 0,
      radius = on ? Math.round(this.radius) : 0;
    if (!on && output.hdr) return input;
    const device = c.device;
    if (this.textures[0]?.width !== c.width || this.textures[0].height !== c.height) {
      this.releaseTextures();
      for (let i = 0; i < 2; i++) {
        this.textures[i] = device.createTexture({
          size: [c.width, c.height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.views[i] = this.textures[i].createView();
      }
    }
    if (this.input !== input) {
      this.input = input;
      this.groups.clear();
    }
    const region = this.options.region ?? [0, 0, 1, 1],
      box = this.options.kind === 'box';
    for (let pass = 0; pass < 2; pass++) {
      const ints = new Int32Array(this.values, pass * 256, 4),
        floats = new Float32Array(this.values, pass * 256 + 16, 8);
      ints.set([1 - pass, pass, radius, +box]);
      floats.set([...(pass ? region : [0, 0, 1, 1]), c.width, c.height, Math.max(radius, 1) / 3, 0]);
    }
    device.queue.writeBuffer(this.uniform!, 0, this.values);
    const pipeline = (format: GPUTextureFormat, display: boolean, multisample?: GPUMultisampleState) => {
      const key = `${format}:${display}:${multisample?.count ?? 1}`;
      let p = this.pipelines.get(key);
      if (!p) this.pipelines.set(key, (p = render(device, blurShader(display), format, { multisample })));
      return p;
    };
    const bind = (key: string, p: GPURenderPipeline, offset: number, source: GPUTextureView) => {
      let g = this.groups.get(key);
      if (!g)
        this.groups.set(key, (g = group(device, p, [{ buffer: this.uniform!, offset, size: 48 }, source, input])));
      return g;
    };
    const across = pipeline('rgba16float', false);
    if (!on) {
      // Pass-through as the last effect: one display pass with a one-tap kernel.
      const down = pipeline(output.format, true, output.multisample);
      this.pass(c, down, bind(`p${output.format}${output.multisample.count}`, down, 256, input), output.view);
      return;
    }
    // The horizontal pass keeps the region test out: it blurs every pixel, the vertical pass picks.
    this.pass(c, across, bind('h', across, 0, input), this.views[0]);
    if (output.hdr) {
      this.pass(c, across, bind('v', across, 256, this.views[0]), this.views[1]);
      return this.views[1];
    }
    const down = pipeline(output.format, true, output.multisample);
    this.pass(c, down, bind(`v${output.format}${output.multisample.count}`, down, 256, this.views[0]), output.view);
  }
  private pass(c: BlurPassContext, pipeline: GPURenderPipeline, bindings: GPUBindGroup, view: GPUTextureView) {
    this.attachment.view = view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.descriptor);
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }
  private releaseTextures(): void {
    for (const t of this.textures) t.destroy();
    this.textures = [];
    this.views = [];
    this.groups.clear();
    this.input = undefined;
  }
  private release(): void {
    this.releaseTextures();
    this.uniform?.destroy();
    this.uniform = undefined;
    this.pipelines.clear();
  }
}
