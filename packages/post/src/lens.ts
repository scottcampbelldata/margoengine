/// <reference lib="esnext.disposable" preserve="true" />
// Lens model, an HDR PostStack stage: lens dirt lit by bright light, and barrel or pincushion distortion. Glow: the light
// above `threshold` averaged over 8 by 8 pixel blocks into an eighth-size rgba16float texture, then a separable Gaussian
// (25 taps, sigma 4 texels) across and down. Composite: each output pixel reads the scene and the glow at the distorted
// point c + (p - c) (1 + k r^2) s (r measured in view heights from the centre c, s scales the corners back onto the
// corners for barrel), and adds glow times the dirt at the undistorted point (dirt sits on the front glass) times
// `dirtIntensity`. Panini projection is the WideAngle camera in @margoengine/cameras/panini, not a post effect.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
type LensPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Lens}; the object is kept and read every frame. */
export interface LensOptions {
  /** Radial distortion k, -1 to 1: above 0 barrel (the middle bulges; the corners stay put), below 0 pincushion.
   * Default 0 (none). */
  distortion?: number;
  /** Strength of the lens dirt lit by bright light, 0 to 10; 0 skips the glow passes. Default 1. */
  dirtIntensity?: number;
  /** Linear brightness (largest channel) above which light lights the dirt. Default 1. */
  threshold?: number;
  /** Dirt image (linear RGB, any size, stretched over the view), a GPUTexture of this engine's device. Default a
   * built-in pattern of soft smudges. */
  dirt?: GPUTexture;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

const uniforms = `struct U {axis:vec2f,threshold:f32,intensity:f32,k:f32,fit:f32,aspect:f32,custom:f32}
@group(0) @binding(0) var<uniform> u:U;`;
// Eighth size: the mean over each 8 by 8 block of the light above the threshold, so a one-pixel light still counts.
const glowShader = `${fullscreen}${uniforms}
@group(0) @binding(1) var scene:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let last=vec2i(textureDimensions(scene))-1;let base=vec2i(at.xy)*8;var sum=vec3f(0);
 for(var j=0;j<64;j++){
  let c=textureLoad(scene,min(base+vec2i(j%8,j/8),last),0).rgb;let peak=max(c.r,max(c.g,c.b));
  sum+=c*max(peak-u.threshold,0.0)/max(peak,1e-5);
 }
 return vec4f(sum/64.0,1);
}`;
const spreadShader = `${fullscreen}${uniforms}
@group(0) @binding(1) var glow:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let last=vec2i(textureDimensions(glow))-1;var sum=vec3f(0);var total=0.0;
 for(var i=-12;i<=12;i++){
  let w=exp(-f32(i*i)/32.0);total+=w;
  sum+=w*textureLoad(glow,clamp(vec2i(at.xy)+vec2i(u.axis)*i,vec2i(0),last),0).rgb;
 }
 return vec4f(sum/total,1);
}`;
const compositeShader = (display: boolean) => `${fullscreen}${display ? displayShader : ''}${uniforms}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var glow:texture_2d<f32>;
@group(0) @binding(3) var dirt:texture_2d<f32>;
@group(0) @binding(4) var bilinear:sampler;
fn hash(v:vec2u)->vec2f{
 var w=v*1664525u+1013904223u;w.x+=w.y*1664525u;w.y+=w.x*1664525u;w=w^(w>>vec2u(16u));
 w.x+=w.y*1664525u;w.y+=w.x*1664525u;w=w^(w>>vec2u(16u));return vec2f(w)/4294967295.0;
}
// The built-in dirt: a faint haze plus soft round smudges, one per cell of a 5-high grid, placed and sized by a hash.
fn smudges(uv:vec2f)->vec3f{
 let p=uv*vec2f(u.aspect,1.0)*5.0;let cell=floor(p);var d=0.08;
 for(var j=0;j<9;j++){
  let q=cell+vec2f(f32(j%3-1),f32(j/3-1));let h=hash(vec2u(q+64.0));let g=hash(vec2u(q+4096.0));
  d+=h.y*smoothstep(0.2+0.5*g.x,0.0,length(p-q-h));
 }
 return vec3f(d)*vec3f(1.0,0.95,0.85);
}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let size=vec2f(textureDimensions(scene));let uv=at.xy/size;let off=(uv-0.5)*vec2f(u.aspect,1.0);
 let src=0.5+(uv-0.5)*(1.0+u.k*dot(off,off))*u.fit;
 var s=textureLoad(scene,vec2i(at.xy),0);
 if(u.k!=0.0){s=textureSampleLevel(scene,bilinear,src,0.0);}
 var c=s.rgb;
 if(u.intensity>0.0){
  let d=select(smudges(uv),textureSampleLevel(dirt,bilinear,uv,0.0).rgb,u.custom>0.0);
  c+=u.intensity*d*textureSampleLevel(glow,bilinear,src,0.0).rgb;
 }
 ${display ? 'return vec4f(toDisplay(c),s.a);' : 'return vec4f(c,s.a);'}
}`;

/**
 * Lens model effects in a PostStack (HDR effect): lens dirt that lights up around bright light, and barrel or
 * pincushion distortion. Put it after the HDR effects that draw light (Bloom, LensFlare) so they are distorted too;
 * `attach` runs it alone in its own PostStack. For the Panini projection use `WideAngle` from
 * `@margoengine/cameras/panini`.
 * @throws TypeError when `enabled` is not a boolean or `dirt` is not a texture; RangeError for an option out of range
 * (checked now and every frame); MargoError `'state'` outside a PostStack, `'unsupported'` without WebGPU,
 * `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class Lens implements EnginePlugin {
  readonly name = 'lens';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private blank?: GPUTexture;
  private dirt?: GPUTexture;
  private dirtView?: GPUTextureView;
  private readonly values = new Float32Array(64 * 4);
  private glow: GPUTexture[] = [];
  private glowViews: GPUTextureView[] = [];
  private result?: GPUTexture;
  private resultView?: GPUTextureView;
  private pipelines = new Map<string, GPURenderPipeline>();
  private groups = new Map<string, GPUBindGroup>();
  private input?: GPUTextureView;
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };

  constructor(readonly options: LensOptions = {}) {
    this.check();
  }
  /** Attaches a new Lens to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: LensOptions = {}): Lens {
    const effect = new Lens(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Mirrors `options.enabled`. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('Lens enabled must be a boolean; pass true or false');
    this.options.enabled = value;
  }
  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'Lens is already attached; create a new Lens');
    this.stacked = true;
    return { kind: 'hdr', render: (c, input, output) => this.frame(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Lens is disposed; create a new Lens');
    if (!this.stacked)
      throw margoError('state', 'Lens runs inside a PostStack; use Lens.attach(engine) or add it to a PostStack');
    if (!engine.gpu) throw margoError('unsupported', 'Lens requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    // One 256 B uniform slice per pass: glow, across, down, composite.
    this.uniform = engine.gpu.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    // Bound in place of `dirt` when none is given (the shader draws its own smudges then).
    this.blank = engine.gpu.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  /** Removes the effect, releases its GPU resources and disposes the stack `attach` created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.removePlugin(this.name);
    this.free();
    this.stack?.dispose();
    this.stack = undefined;
  }
  /** A lost device: drop every resource of the old one and set up again on the new one. */
  onDeviceRestored(engine: Engine): void {
    this.free();
    this.engine = undefined;
    this.setup(engine);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private check(): void {
    const o = this.options;
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Lens enabled must be a boolean; pass true or false');
    if (o.dirt !== undefined && typeof (o.dirt as { createView?: unknown })?.createView !== 'function')
      throw new TypeError('Lens dirt must be a GPUTexture of the engine device; leave it unset for the built-in dirt');
    if (
      (o.distortion !== undefined && !(o.distortion >= -1 && o.distortion <= 1)) ||
      (o.dirtIntensity !== undefined && !(o.dirtIntensity >= 0 && o.dirtIntensity <= 10)) ||
      (o.threshold !== undefined && !(o.threshold >= 0 && Number.isFinite(Math.fround(o.threshold))))
    )
      throw new RangeError('Invalid Lens options; distortion -1 to 1, dirtIntensity 0 to 10, threshold 0 or more.');
  }
  private frame(c: LensPassContext, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.check();
    const device = c.device,
      o = this.options,
      on = this.enabled,
      k = on ? (o.distortion ?? 0) : 0,
      intensity = on ? (o.dirtIntensity ?? 1) : 0,
      aspect = c.width / c.height,
      small = [Math.max(1, Math.ceil(c.width / 8)), Math.max(1, Math.ceil(c.height / 8))];
    if (!on && output.hdr) return input;
    if (this.result?.width !== c.width || this.result.height !== c.height) {
      this.freeTargets();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      for (const i of [0, 1]) {
        this.glow[i] = device.createTexture({ size: small, format: 'rgba16float', usage });
        this.glowViews[i] = this.glow[i].createView();
      }
      this.result = device.createTexture({ size: [c.width, c.height], format: 'rgba16float', usage });
      this.resultView = this.result.createView();
    }
    if (this.input !== input || this.dirt !== o.dirt) {
      this.input = input;
      this.dirt = o.dirt;
      this.dirtView = (o.dirt ?? this.blank!).createView();
      this.groups.clear();
    }
    // Barrel: scale so the corners (r^2 = (aspect^2 + 1) / 4) read the corners. Pincushion reads inward already.
    const fit = k > 0 ? 1 / (1 + (k * (aspect * aspect + 1)) / 4) : 1,
      v = this.values;
    for (let slot = 0; slot < 4; slot++)
      v.set(
        [slot === 1 ? 1 : 0, slot === 2 ? 1 : 0, o.threshold ?? 1, intensity, k, fit, aspect, o.dirt ? 1 : 0],
        slot * 64,
      );
    device.queue.writeBuffer(this.uniform!, 0, v);
    const pipe = (key: string, code: string, format: GPUTextureFormat, multisample?: GPUMultisampleState) => {
      let p = this.pipelines.get(key);
      if (!p) this.pipelines.set(key, (p = render(device, code, format, { multisample })));
      return p;
    };
    const groupFor = (key: string, p: GPURenderPipeline, slot: number, resources: GPUBindingResource[]) => {
      let g = this.groups.get(key);
      if (!g)
        this.groups.set(
          key,
          (g = group(device, p, [{ buffer: this.uniform!, offset: slot * 256, size: 32 }, ...resources])),
        );
      return g;
    };
    if (intensity > 0) {
      const glow = pipe('glow', glowShader, 'rgba16float'),
        spread = pipe('spread', spreadShader, 'rgba16float');
      this.run(c, glow, groupFor('glow', glow, 0, [input]), this.glowViews[0], false);
      this.run(c, spread, groupFor('across', spread, 1, [this.glowViews[0]]), this.glowViews[1], false);
      this.run(c, spread, groupFor('down', spread, 2, [this.glowViews[1]]), this.glowViews[0], false);
    }
    const display = !output.hdr,
      key = `${output.format}${display}${output.multisample.count}`,
      composite = pipe(
        `composite${key}`,
        compositeShader(display),
        display ? output.format : 'rgba16float',
        display ? output.multisample : undefined,
      ),
      bindings = groupFor(`composite${key}`, composite, 3, [input, this.glowViews[0], this.dirtView!, this.sampler!]);
    this.run(c, composite, bindings, display ? output.view : this.resultView!, true);
    if (!display) return this.resultView;
  }
  private run(
    c: LensPassContext,
    pipeline: GPURenderPipeline,
    bindings: GPUBindGroup,
    view: GPUTextureView,
    full: boolean,
  ) {
    this.attachment.view = view;
    this.attachment.loadOp = full ? viewLoadOp(c, 'clear') : 'clear';
    const pass = c.encoder.beginRenderPass(this.descriptor);
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      if (full) applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }
  private freeTargets(): void {
    for (const t of [...this.glow, this.result]) t?.destroy();
    this.glow = [];
    this.glowViews = [];
    this.result = this.resultView = undefined;
    this.groups.clear();
    this.input = undefined;
  }
  private free(): void {
    this.freeTargets();
    this.blank?.destroy();
    this.uniform?.destroy();
    this.uniform = this.sampler = this.blank = this.dirt = this.dirtView = undefined;
    this.pipelines.clear();
  }
}
