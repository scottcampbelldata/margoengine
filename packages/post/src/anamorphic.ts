/// <reference lib="esnext.disposable" preserve="true" />
// Anamorphic streaks, an HDR PostStack stage: the horizontal light streaks a cinema lens with an anamorphic element draws
// from bright points. Bright pass: the light above `threshold` (per pixel, by its brightest channel, with a soft knee)
// into a half-width, quarter-height rgba16float texture (streaks are thin, so height can go). Then `passes` horizontal
// passes, pass k taking 9 taps spaced 3^k texels apart with weights exp(-|i| / 2): a chain of growing sparse kernels
// (a trous) whose product is one smooth kernel up to 4 (3^passes - 1) / 2 texels each side. Composite: the input plus
// the streak light times `intensity` and `tint`, sampled bilinearly back to full size.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext, Vec3 } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type StreakPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Anamorphic}; the object is kept and read every frame. */
export interface AnamorphicOptions {
  /** Linear brightness (largest channel) where streaks start, with a soft knee of half of it below. Default 1.5. */
  threshold?: number;
  /** Streak strength, 0 to 10. Default 0.5. */
  intensity?: number;
  /** Linear RGB tint of the streaks, each 0 to 1. Default [0.4, 0.6, 1] (the blue of coated anamorphic glass). */
  tint?: Vec3;
  /** Spreading passes, 1 to 6: streaks reach 2 (3^passes - 1) half-resolution texels each side, so 5 reaches 484
   * texels (968 pixels). Default 5. */
  passes?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

const brightShader = `${fullscreen}
struct U {threshold:f32,intensity:f32,step:f32,pad:f32,tint:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var bilinear:sampler;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 // Four source rows per texel (quarter height): the brightest of them, so a one-pixel point is never lost.
 let size=vec2f(textureDimensions(scene));var c=vec3f(0);
 for(var y=0;y<4;y++){c=max(c,textureSampleLevel(scene,bilinear,vec2f(at.x*2.0,floor(at.y)*4.0+f32(y)+0.5)/size,0.0).rgb);}
 let peak=max(c.r,max(c.g,c.b));let knee=0.5*u.threshold;
 let soft=clamp(peak-u.threshold+knee,0.0,2.0*knee);let lift=max(soft*soft/(4.0*knee+1e-5),peak-u.threshold);
 return vec4f(c*max(lift,0.0)/max(peak,1e-5),1);
}`;
const spreadShader = `${fullscreen}
struct U {threshold:f32,intensity:f32,step:f32,pad:f32,tint:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var source:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let width=i32(textureDimensions(source).x);var sum=vec3f(0);var total=0.0;
 for(var i=-4;i<=4;i++){let w=exp(-0.5*abs(f32(i)));let x=p.x+i*i32(u.step);
  if(x>=0&&x<width){sum+=w*textureLoad(source,vec2i(x,p.y),0).rgb;}total+=w;}
 return vec4f(sum/total,1);
}`;
const compositeShader = (display: boolean) => `${fullscreen}${display ? displayShader : ''}
struct U {threshold:f32,intensity:f32,step:f32,pad:f32,tint:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var streaks:texture_2d<f32>;
@group(0) @binding(3) var bilinear:sampler;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let s=textureLoad(scene,vec2i(at.xy),0);
 let c=s.rgb+u.intensity*u.tint.rgb*textureSampleLevel(streaks,bilinear,at.xy/vec2f(textureDimensions(scene)),0.0).rgb;
 ${display ? 'return vec4f(toDisplay(c),s.a);' : 'return vec4f(c,s.a);'}
}`;

/**
 * Anamorphic lens streaks in a PostStack (HDR effect): bright points draw thin horizontal streaks of light, tinted
 * blue by default. Put it before Bloom or Tonemap among the HDR effects; `attach` runs it alone in its own PostStack.
 * @throws TypeError when `enabled` is not a boolean; RangeError for an option out of range (checked now and every
 * frame); MargoError `'state'` outside a PostStack, `'unsupported'` without WebGPU, `'disposed'` after `dispose()`,
 * `'attached'` when joined twice.
 */
export class Anamorphic implements EnginePlugin {
  readonly name = 'anamorphic';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private readonly values = new Float32Array(64 * 8);
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private output?: GPUTexture;
  private outputView?: GPUTextureView;
  private pipelines = new Map<string, GPURenderPipeline>();
  private groups = new Map<string, GPUBindGroup>();
  private input?: GPUTextureView;
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };

  constructor(readonly options: AnamorphicOptions = {}) {
    this.validate();
  }
  /** Attaches a new Anamorphic to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: AnamorphicOptions = {}): Anamorphic {
    const effect = new Anamorphic(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Mirrors `options.enabled`. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('Anamorphic enabled must be a boolean; pass true or false');
    this.options.enabled = value;
  }
  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'Anamorphic is already attached; create a new Anamorphic');
    this.stacked = true;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Anamorphic is disposed; create a new Anamorphic');
    if (!this.stacked)
      throw margoError(
        'state',
        'Anamorphic runs inside a PostStack; use Anamorphic.attach(engine) or add it to a PostStack',
      );
    if (!engine.gpu)
      throw margoError('unsupported', 'Anamorphic requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    // One 256 B uniform slice per pass: bright, up to 6 spreads, composite.
    this.uniform = engine.gpu.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  /** Removes the effect, releases its GPU resources and disposes the stack `attach` created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.removePlugin(this.name);
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
      t = o.tint;
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Anamorphic enabled must be a boolean; pass true or false');
    if (
      (o.threshold !== undefined && !(o.threshold > 0 && Number.isFinite(Math.fround(o.threshold)))) ||
      (o.intensity !== undefined && !(o.intensity >= 0 && o.intensity <= 10)) ||
      (o.passes !== undefined && !(Number.isInteger(o.passes) && o.passes >= 1 && o.passes <= 6)) ||
      (t !== undefined && (!Array.isArray(t) || t.length !== 3 || ![0, 1, 2].every((i) => t[i] >= 0 && t[i] <= 1)))
    )
      throw new RangeError(
        'Invalid Anamorphic options; threshold above 0, intensity 0 to 10, passes 1 to 6, tint three numbers 0 to 1.',
      );
  }
  private draw(c: StreakPassContext, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const device = c.device,
      o = this.options,
      on = this.enabled,
      passes = o.passes ?? 5,
      size = [Math.max(1, Math.ceil(c.width / 2)), Math.max(1, Math.ceil(c.height / 4))];
    if (!on && output.hdr) return input;
    if (this.output?.width !== c.width || this.output.height !== c.height) {
      this.releaseTextures();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      for (let i = 0; i < 2; i++) {
        this.textures[i] = device.createTexture({ size, format: 'rgba16float', usage });
        this.views[i] = this.textures[i].createView();
      }
      this.output = device.createTexture({ size: [c.width, c.height], format: 'rgba16float', usage });
      this.outputView = this.output.createView();
    }
    if (this.input !== input) {
      this.input = input;
      this.groups.clear();
    }
    const v = this.values,
      tint = o.tint ?? [0.4, 0.6, 1];
    for (let k = 0; k < 8; k++)
      v.set([o.threshold ?? 1.5, on ? (o.intensity ?? 0.5) : 0, 3 ** Math.max(0, k - 1), 0, ...tint, 0], k * 64);
    device.queue.writeBuffer(this.uniform!, 0, v);
    const pipeline = (key: string, code: string, format: GPUTextureFormat, multisample?: GPUMultisampleState) => {
      let p = this.pipelines.get(key);
      if (!p) this.pipelines.set(key, (p = render(device, code, format, { multisample })));
      return p;
    };
    const bind = (key: string, p: GPURenderPipeline, slot: number, resources: GPUBindingResource[]) => {
      let g = this.groups.get(key);
      if (!g)
        this.groups.set(
          key,
          (g = group(device, p, [{ buffer: this.uniform!, offset: slot * 256, size: 32 }, ...resources])),
        );
      return g;
    };
    let streaks = this.views[0];
    if (on) {
      const bright = pipeline('bright', brightShader, 'rgba16float');
      this.pass(c, bright, bind('bright', bright, 0, [input, this.sampler!]), this.views[0], false);
      const spread = pipeline('spread', spreadShader, 'rgba16float');
      for (let k = 1; k <= passes; k++) {
        const from = (k - 1) & 1;
        this.pass(c, spread, bind(`spread${k}${from}`, spread, k, [this.views[from]]), this.views[from ^ 1], false);
      }
      streaks = this.views[passes & 1];
    }
    const display = !output.hdr,
      composite = pipeline(
        `composite${output.format}${display}${output.multisample.count}`,
        compositeShader(display),
        display ? output.format : 'rgba16float',
        display ? output.multisample : undefined,
      );
    const g = bind(`composite${output.format}${display}${output.multisample.count}${on}${passes & 1}`, composite, 7, [
      input,
      streaks,
      this.sampler!,
    ]);
    if (display) {
      this.pass(c, composite, g, output.view, true);
      return;
    }
    this.pass(c, composite, g, this.outputView!, true);
    return this.outputView;
  }
  private pass(
    c: StreakPassContext,
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
  private releaseTextures(): void {
    for (const t of [...this.textures, this.output]) t?.destroy();
    this.textures = [];
    this.views = [];
    this.output = this.outputView = undefined;
    this.groups.clear();
    this.input = undefined;
  }
  private release(): void {
    this.releaseTextures();
    this.uniform?.destroy();
    this.uniform = this.sampler = undefined;
    this.pipelines.clear();
  }
}
