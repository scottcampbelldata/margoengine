/// <reference lib="esnext.disposable" preserve="true" />
// Screen-space subsurface scattering, an HDR PostStack stage: the separable screen-space blur of Jimenez et al.,
// "Separable Subsurface Scattering" (Computer Graphics Forum 34(6), 2015). Light that entered a translucent surface leaves
// it some distance away, so the lit image of a masked surface is blurred by a diffusion profile, one 1-D pass across and
// one down. The profile is one Gaussian per colour channel, each as wide as `radius` times its `profile` share: d'Eon and
// Luebke ("Advanced Techniques for Realistic Real-Time Skin Rendering", GPU Gems 3, ch. 14, 2007) fit measured profiles
// with sums of Gaussians and found red spreading far wider than green and blue in skin. Kernel widths are in world units,
// turned into pixels per pixel from the depth, so the look keeps its size at any distance; taps that step off the surface
// (depth gap) or off the mask fall back to the centre colour so light does not bleed across silhouettes.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link SSS}; the object is kept and read every frame. */
export interface SSSOptions {
  /**
   * Which pixels scatter and how much: the red channel, 0 to 1, of a texture covering the frame (read at the matching
   * pixel when its size differs), such as a `SceneTargets` output or `() => selection.maskTexture`. Nothing scatters
   * while it is missing or returns undefined.
   */
  mask?: () => GPUTexture | undefined;
  /** How far light travels under the surface, world units, above 0. Default 0.01 (1 cm, skin at metre scale). */
  radius?: number;
  /**
   * Linear red, green and blue spread, each a share of `radius` in 0..1: the colour profile. Default `[1, 0.4, 0.25]`
   * (skin: red travels farthest). Wax and marble spread more evenly, such as `[1, 0.85, 0.7]`.
   */
  profile?: readonly [number, number, number];
  /** Share of the scattered light mixed in, 0 to 1, times the mask. Default 1. */
  strength?: number;
  /** Taps on each side of a pixel in each of the two passes, 1 to 32. Default 8. */
  taps?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

/** The widest kernel half-width in pixels: a surface very close to the camera stops growing its blur here. */
export const SSS_MAX_REACH = 64;

const shader = (last: boolean, encode: boolean) => `${fullscreen}${encode ? displayShader : ''}
struct U {inverse:mat4x4f,profile:vec4f,step:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var mask:texture_2d<f32>;
${last ? '@group(0) @binding(4) var original:texture_2d<f32>;' : ''}
fn place(p:vec2f,d:f32,size:vec2f)->vec3f {let w=u.inverse*vec4f(p/size*vec2f(2,-2)+vec2f(-1,1),d,1);return w.xyz/w.w;}
fn marked(p:vec2i,size:vec2f)->f32 {
 let m=vec2f(textureDimensions(mask));return textureLoad(mask,vec2i((vec2f(p)+0.5)*m/size),0).r;
}
fn out(c:vec3f,a:f32)->vec4f {return vec4f(${encode ? 'toDisplay(c)' : 'c'},a);}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let size=vec2f(textureDimensions(depth));let centre=textureLoad(image,p,0);
 ${last ? 'let before=textureLoad(original,p,0);' : 'let before=centre;'}
 let d=textureLoad(depth,p,0);let weight=clamp(marked(p,size),0.0,1.0)*u.step.w;
 if(d<=0||weight<=0){return out(before.rgb,before.a);}
 let here=place(at.xy,d,size);let unit=distance(place(at.xy+u.step.xy,d,size),here);
 let widths=max(u.profile.xyz*u.profile.w,vec3f(1e-6));
 let reach=min(3*max(widths.x,max(widths.y,widths.z))/max(unit,1e-12),${SSS_MAX_REACH}.0);
 if(reach<0.5){return out(${last ? 'mix(before.rgb,centre.rgb,weight)' : 'centre.rgb'},before.a);}
 let taps=u.step.z;let step=reach/taps;
 var sum=centre.rgb;var total=vec3f(1);
 for(var i=1.0;i<=taps;i+=1){
  for(var side=-1.0;side<=1.0;side+=2){
   let q=at.xy+u.step.xy*side*i*step;
   if(any(q<vec2f(0))||any(q>=size)){continue;}
   let qi=vec2i(q);let x=i*step*unit;let k=exp(-0.5*(x/widths)*(x/widths));
   var tap=textureLoad(image,qi,0).rgb;let dq=textureLoad(depth,qi,0);
   if(dq<=0||marked(qi,size)<=0){tap=centre.rgb;}
   else{let gap=abs(distance(place(q,dq,size),here)-x);tap=mix(tap,centre.rgb,clamp(gap/u.profile.w,0.0,1.0));}
   sum+=k*tap;total+=k;
  }
 }
 let blurred=sum/total;
 return out(${last ? 'mix(before.rgb,blurred,weight)' : 'blurred'},before.a);
}`;

/**
 * Screen-space subsurface scattering in a PostStack (HDR effect): blurs the lit image of masked pixels by a colour
 * profile measured in world units, so skin, wax and marble look soft with light bleeding red into shadow edges. Pair it
 * with the `subsurface` option of `@margoengine/materials`, which adds the light seen through thin parts. Put it first
 * among the HDR effects, after SSAO and before SSR and Bloom.
 * ```ts
 * PostStack.attach(engine, [new SSS({mask: () => targets.texture('skin'), radius: 0.012}), new Tonemap()]);
 * ```
 * @throws RangeError when an option is out of range (checked now and every frame); TypeError for a wrong type;
 * MargoError `'state'` outside a PostStack, `'unsupported'` without WebGPU, `'disposed'` after `dispose()`,
 * `'attached'` when joined twice.
 */
export class SSS implements EnginePlugin {
  readonly name = 'sss';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniforms: GPUBuffer[] = [];
  private across?: GPUTexture;
  private acrossView?: GPUTextureView;
  private readonly values = new Float32Array(24);
  private readonly workspace = new Float64Array(52);
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly bindings: (GPUBindGroup | undefined)[] = [];
  private readonly bound: (readonly unknown[])[] = [[], []];

  constructor(readonly options: SSSOptions = {}) {
    this.validate();
  }

  /** Attaches a new SSS to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: SSSOptions = {}): SSS {
    const effect = new SSS(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  private validate(): void {
    const o = this.options;
    if (o.mask !== undefined && typeof o.mask !== 'function')
      throw new TypeError('SSS mask must be a function returning a GPUTexture or undefined');
    if (o.radius !== undefined && !(Number.isFinite(o.radius) && o.radius > 0))
      throw new RangeError('SSS radius must be finite and above 0; pass world units');
    if (
      o.profile !== undefined &&
      !(o.profile.length === 3 && o.profile.every((v) => v >= 0 && v <= 1) && o.profile.some((v) => v > 0))
    )
      throw new RangeError('SSS profile must be three shares in 0..1, not all 0; pass [red, green, blue]');
    if (o.strength !== undefined && !(o.strength >= 0 && o.strength <= 1))
      throw new RangeError('SSS strength must be in 0..1');
    if (o.taps !== undefined && !(Number.isInteger(o.taps) && o.taps >= 1 && o.taps <= 32))
      throw new RangeError('SSS taps must be a whole number from 1 to 32');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('SSS enabled must be a boolean; pass true or false');
  }

  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw new MargoError('attached', 'SSS is already attached; create a new SSS');
    this.stacked = true;
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'SSS is disposed; create a new SSS');
    if (!this.stacked)
      throw new MargoError('state', 'SSS runs inside a PostStack; use SSS.attach(engine) or add it to a PostStack');
    if (!engine.gpu) throw new MargoError('unsupported', 'SSS requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.uniforms = [0, 1].map(() => engine.gpu!.createBuffer({ size: 96, usage }));
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
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

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private pipeline(
    device: GPUDevice,
    last: boolean,
    format: GPUTextureFormat,
    encode: boolean,
    ms?: GPUMultisampleState,
  ) {
    const key = `${+last}:${format}:${ms?.count ?? 1}:${+encode}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(device, shader(last, encode), format, ms ? { multisample: ms } : {});
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private draw(c: Context, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const o = this.options,
      mask = (o.enabled ?? true) ? o.mask?.() : undefined,
      device = c.device,
      depth = this.host!.depthTexture!;
    // Pass-through without a mask: the next stage reads the input as it is. When last, the frame still has to be
    // encoded for display, which the second pass does with a zero strength.
    if (!mask && output.hdr) return input;
    const v = this.values;
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.workspace))
      throw new MargoError('state', 'Invalid SSS camera; give the camera a finite, invertible projection');
    const p = o.profile ?? [1, 0.4, 0.25];
    v.set([p[0], p[1], p[2], o.radius ?? 0.01], 16);
    const taps = o.taps ?? 8,
      strength = mask ? (o.strength ?? 1) : 0;
    if (!this.across || this.across.width !== depth.width || this.across.height !== depth.height) {
      this.across?.destroy();
      this.across = device.createTexture({
        size: [depth.width, depth.height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.acrossView = this.across.createView();
    }
    // Pass 0 blurs across into `across`; pass 1 blurs down into the output and mixes with the original by the mask.
    for (const pass of [0, 1]) {
      v.set([pass ? 0 : 1, pass ? 1 : 0, taps, strength], 20);
      device.queue.writeBuffer(this.uniforms[pass], 0, v);
      const last = pass === 1,
        pipeline = last
          ? this.pipeline(device, true, output.format, !output.hdr, output.multisample)
          : this.pipeline(device, false, 'rgba16float', false),
        parts = [pipeline, this.across, depth, mask ?? null, input];
      if (parts.some((part, i) => part !== this.bound[pass][i])) {
        this.bound[pass] = parts;
        const resources: GPUBindingResource[] = [
          { buffer: this.uniforms[pass] },
          last ? this.acrossView! : input,
          depth.createView({ aspect: 'depth-only' }),
          mask ? mask.createView() : this.fallbackMask(device),
        ];
        if (last) resources.push(input);
        this.bindings[pass] = group(device, pipeline, resources);
      }
      const encoder = c.encoder.beginRenderPass({
        colorAttachments: [
          last
            ? { view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }
            : { view: this.acrossView!, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      encoder.setPipeline(pipeline);
      encoder.setBindGroup(0, this.bindings[pass]!);
      applyView(encoder, c);
      encoder.draw(3);
      encoder.end();
    }
  }

  private empty?: GPUTexture;
  private emptyView?: GPUTextureView;
  private fallbackMask(device: GPUDevice): GPUTextureView {
    this.empty ??= device.createTexture({ size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    return (this.emptyView ??= this.empty.createView());
  }

  private release(): void {
    for (const buffer of this.uniforms) buffer.destroy();
    this.across?.destroy();
    this.empty?.destroy();
    this.uniforms = [];
    this.across = this.empty = undefined;
    this.acrossView = this.emptyView = undefined;
    this.bindings.length = 0;
    this.bound[0] = [];
    this.bound[1] = [];
    this.pipelines.clear();
  }
}
