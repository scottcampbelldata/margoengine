/// <reference lib="esnext.disposable" preserve="true" />
// Gaussian and box blur, an HDR PostStack stage. Separable: a horizontal pass from the stage input into an rgba16float
// texture, then a vertical pass into the output (or into a second rgba16float texture handed to the next HDR stage).
// Gaussian weights are exp(-x^2 / (2 sigma^2)) with sigma = radius / 3, normalised over the 2 radius + 1 taps; box
// weights are 1 / (2 radius + 1). Edges clamp to the nearest pixel. Inside `region` only; outside it the input passes.
// Zoom and spin: one pass of `samples` bilinear taps along the ray to `center` (zoom) or the arc about it (spin), the
// radial sum of Mitchell, "Volumetric Light Scattering as a Post-Process", GPU Gems 3, 2007, ch. 13.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { displayFor, displayShader, premultipliedCanvas } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp, viewRect } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
};
type BlurPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Blur}; the object is kept and read every frame, so a focus pull animates `radius`. */
export interface BlurOptions {
  /** `'gaussian'` (default; sigma = radius / 3), `'box'` (equal weights), `'zoom'` (streaks towards `center`) or
   * `'spin'` (arcs around `center`). */
  kind?: 'gaussian' | 'box' | 'zoom' | 'spin';
  /** Half width of the kernel in pixels, 0 to 64 (fractions round to the nearest pixel). 0 passes the frame through. Default 8. Gaussian and box. */
  radius?: number;
  /** Part of the frame to blur, [x0, y0, x1, y1] in 0..1 of the view (y down), for a glass panel behind a menu.
   * Default the whole view. */
  region?: readonly [number, number, number, number];
  /** Zoom and spin: the sharp point, [x, y] in 0..1 of the view (y down); -10 to 10, so it may be off screen.
   * Default [0.5, 0.5]. */
  center?: readonly [number, number];
  /** Zoom and spin: 0 to 1; 0 passes the frame through. Zoom: the share of the way to `center` a streak covers. Spin:
   * the arc each pixel is smeared over, in radians. Default 0.1. */
  strength?: number;
  /** Zoom and spin: taps per pixel, a whole number 2 to 128. Default 32. */
  samples?: number;
  /** Zoom and spin: the radius around `center` that stays sharp, 0 to 10 view heights. Default 0. */
  innerRadius?: number;
  /** Zoom and spin: the distance past `innerRadius` over which the blur grows to `strength`, 0 to 10 view heights.
   * Default 0.2. */
  falloff?: number;
  /** Zoom and spin: each tap's weight as a share of its neighbour's nearer the pixel, 0 to 1. Default 1 (equal). */
  decay?: number;
  /** Zoom and spin light rays, 0 to 8. 0 (default) blurs; above 0 the frame stays sharp and the streaks of its light
   * above `threshold`, times `rays`, are added to it. */
  rays?: number;
  /** With `rays`: light below this per channel (linear HDR) casts no ray, 0 to 64. Default 1. */
  threshold?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

/** Largest {@link BlurOptions.samples}. */
export const MAX_BLUR_SAMPLES = 128;

// [option, smallest, largest, default] of the zoom and spin numbers, in uniform order.
const radialRanges = [
  ['strength', 0, 1, 0.1],
  ['innerRadius', 0, 10, 0],
  ['falloff', 0, 10, 0.2],
  ['decay', 0, 1, 1],
  ['rays', 0, 8, 0],
  ['threshold', 0, 64, 1],
] as const;

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

// One pass: taps from the pixel towards the centre (zoom) or along the arc about it (spin), in view-height units so a
// circle stays round, clamped to the view's pixel centres.
const radialShader = (display: boolean) => `${fullscreen}${display ? displayShader : ''}
struct U {rect:vec4f,region:vec4f,center:vec2f,size:vec2f,strength:f32,inner:f32,falloff:f32,decay:f32,rays:f32,threshold:f32,samples:i32,spin:i32}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var bilinear:sampler;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 var out=textureLoad(source,vec2i(at.xy),0);let uv=(at.xy-u.rect.xy)/u.rect.zw;
 let aspect=vec2f(u.rect.z/u.rect.w,1.0);let d=(uv-u.center)*aspect;
 let amount=u.strength*clamp((length(d)-u.inner)/max(u.falloff,1e-5),0.0,1.0);
 if(amount>0.0&&all(uv>=u.region.xy)&&all(uv<u.region.zw)){
  var sum=vec4f(0);var total=0.0;let last=f32(u.samples-1);
  for(var i=0;i<u.samples;i++){
   let t=f32(i)/last;var s=d*(1.0-amount*t);var steps=f32(i);
   if(u.spin==1){let a=amount*(t-0.5);s=vec2f(d.x*cos(a)-d.y*sin(a),d.x*sin(a)+d.y*cos(a));steps=abs(steps-0.5*last);}
   let w=pow(max(u.decay,1e-4),steps);
   let q=u.rect.xy+clamp((u.center+s/aspect)*u.rect.zw,vec2f(0.5),u.rect.zw-0.5);
   var c=textureSampleLevel(source,bilinear,q/u.size,0.0);
   if(u.rays>0.0){c=vec4f(max(c.rgb-vec3f(u.threshold),vec3f(0)),c.a);}
   sum+=w*c;total+=w;
  }
  if(u.rays>0.0){out=vec4f(out.rgb+u.rays*sum.rgb/total,out.a);}else{out=sum/total;}
 }
 ${display ? 'return vec4f(toDisplay(out.rgb),out.a);' : 'return out;'}
}`;

/**
 * Gaussian or box blur in a PostStack (HDR effect), separable in two passes: menus behind glass (`region`), focus pulls
 * (animate `radius`) and custom chains (several Blurs, or a Blur between other HDR effects). Kinds `'zoom'` and
 * `'spin'` are radial blurs about `center` in one pass: speed and impact shots, and light rays with `rays`. `attach`
 * runs it alone in its own PostStack.
 * @throws TypeError when `enabled` is not a boolean; RangeError for a `kind`, number or rectangle out of range
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
  private sampler?: GPUSampler;
  private readonly values = new ArrayBuffer(512);
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private pipelines = new Map<string, GPURenderPipeline>();
  private groups = new Map<string, GPUBindGroup>();
  private input?: GPUTextureView;
  private readonly attachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly descriptor: GPURenderPassDescriptor = {
    colorAttachments: [this.attachment],
  };

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
    return {
      kind: 'hdr',
      render: (c, input, output) => this.draw(c, input, output),
    };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Blur is disposed; create a new Blur');
    if (!this.stacked)
      throw margoError('state', 'Blur runs inside a PostStack; use Blur.attach(engine) or add it to a PostStack');
    if (!engine.gpu) throw margoError('unsupported', 'Blur requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    // Two 256 B slices (the uniform offset alignment): the horizontal pass's and the vertical pass's uniform.
    this.uniform = engine.gpu.createBuffer({
      size: 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
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
    const c = o.center;
    if (
      (o.kind !== undefined && !['gaussian', 'box', 'zoom', 'spin'].includes(o.kind)) ||
      radialRanges.some(([k, min, max]) => o[k] !== undefined && !(o[k] >= min && o[k] <= max)) ||
      (o.samples !== undefined && !(Number.isInteger(o.samples) && o.samples >= 2 && o.samples <= MAX_BLUR_SAMPLES)) ||
      (c !== undefined && !(Array.isArray(c) && c.length === 2 && [c[0], c[1]].every((v) => v >= -10 && v <= 10))) ||
      (o.radius !== undefined && !(o.radius >= 0 && o.radius <= MAX_BLUR_RADIUS)) ||
      (r !== undefined &&
        (!Array.isArray(r) ||
          r.length !== 4 ||
          ![0, 1, 2, 3].every((i) => r[i] >= 0 && r[i] <= 1) ||
          !(r[0] < r[2] && r[1] < r[3])))
    )
      throw new RangeError(
        `Invalid Blur options; kind 'gaussian', 'box', 'zoom' or 'spin', radius 0 to ${MAX_BLUR_RADIUS}, samples a whole number 2 to ${MAX_BLUR_SAMPLES}, center [x, y] in -10..10, region [x0, y0, x1, y1] in 0..1 with x0 < x1 and y0 < y1, ${radialRanges.map(([k, min, max]) => `${k} ${min} to ${max}`).join(', ')}.`,
      );
  }
  private draw(c: BlurPassContext, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const kind = this.options.kind,
      radial = kind === 'zoom' || kind === 'spin';
    const on = this.enabled && (radial ? (this.options.strength ?? 0.1) > 0 : Math.round(this.radius) > 0),
      radius = on && !radial ? Math.round(this.radius) : 0;
    if (!on && output.hdr) return input;
    const device = c.device;
    if (this.input !== input) {
      this.input = input;
      this.groups.clear();
    }
    if (radial && on) return this.drawRadial(c, input, output);
    if (this.textures[0]?.width !== c.width || this.textures[0].height !== c.height) {
      this.releaseTextures();
      this.input = input;
      for (let i = 0; i < 2; i++) {
        this.textures[i] = device.createTexture({
          size: [c.width, c.height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.views[i] = this.textures[i].createView();
      }
    }
    const region = this.options.region ?? [0, 0, 1, 1],
      box = kind === 'box';
    for (let pass = 0; pass < 2; pass++) {
      const ints = new Int32Array(this.values, pass * 256, 4),
        floats = new Float32Array(this.values, pass * 256 + 16, 8);
      ints.set([1 - pass, pass, radius, +box]);
      floats.set([...(pass ? region : [0, 0, 1, 1]), c.width, c.height, Math.max(radius, 1) / 3, 0]);
    }
    device.queue.writeBuffer(this.uniform!, 0, this.values);
    const pipeline = (format: GPUTextureFormat, display: boolean, multisample?: GPUMultisampleState) =>
      this.pipeline(device, blurShader, format, display, multisample);
    const bind = (key: string, p: GPURenderPipeline, offset: number, source: GPUTextureView) =>
      this.bind(device, key, p, [{ buffer: this.uniform!, offset, size: 48 }, source, input]);
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
  /** Zoom and spin: one pass from the stage input straight into the stage output. */
  private drawRadial(c: BlurPassContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      floats = new Float32Array(this.values, 0, 18);
    floats.set(viewRect(c) ?? [0, 0, c.width, c.height]);
    floats.set(o.region ?? [0, 0, 1, 1], 4);
    floats.set(o.center ?? [0.5, 0.5], 8);
    floats.set([c.width, c.height, ...radialRanges.map(([k, , , fallback]) => o[k] ?? fallback)], 10);
    new Int32Array(this.values, 72, 2).set([o.samples ?? 32, +(o.kind === 'spin')]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values, 0, 80);
    this.sampler ??= c.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const p = this.pipeline(c.device, radialShader, output.format, !output.hdr, output.multisample),
      resources = [{ buffer: this.uniform!, size: 80 }, input, this.sampler];
    this.pass(c, p, this.bind(c.device, `r${output.format}${output.multisample.count}`, p, resources), output.view);
  }
  private pipeline(
    device: GPUDevice,
    shader: (display: boolean) => string,
    format: GPUTextureFormat,
    display: boolean,
    multisample?: GPUMultisampleState,
  ): GPURenderPipeline {
    const straight = display && premultipliedCanvas(this.engine),
      key = `${shader === radialShader}:${format}:${display}:${multisample?.count ?? 1}:${straight}`;
    let p = this.pipelines.get(key);
    if (!p)
      this.pipelines.set(key, (p = render(device, displayFor(this.engine, shader(display)), format, { multisample })));
    return p;
  }
  private bind(device: GPUDevice, key: string, p: GPURenderPipeline, resources: GPUBindingResource[]): GPUBindGroup {
    let g = this.groups.get(key);
    if (!g) this.groups.set(key, (g = group(device, p, resources)));
    return g;
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
    this.sampler = undefined;
    this.pipelines.clear();
  }
}
