/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { renderSizeView } from '../../shared/render-size-view.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type View = NonNullable<Context['view']>;

// Single-frame spatial upscale in two passes, built clean room from AMD's published descriptions of FidelityFX Super
// Resolution 1 (T. Lottes and K. Garcia, SIGGRAPH 2021 Advances talk; AMD GPUOpen FSR 1 pages; docs/clean-room.md).
// Pass 1, edge-adaptive upsample: each output pixel reads the 12 render texels around it (the 4x4 block minus its
// corners). For each texel of the inner 2x2 quad, a central difference of luma ((r + 2g + b) / 4) on its plus pattern
// gives the gradient, and the three lumas on each axis give a feature length: 1 for a step (no gradient reversal),
// 0 for a full reversal (a thin line) or a flat run, as the square of |right - left| / max(left, right); the larger
// axis counts. Direction and length are interpolated bilinearly at the output position. The kernel is rotated onto the
// gradient, widened across it from 1 to 1 / max(|dx|, |dy|) (sqrt 2 on a diagonal) and along the edge from 1 to 2 as
// the length grows, and its window grows from radius sqrt 2 (no negative lobe to speak of) to 2 (a real one). The
// kernel is this file's own polynomial in s = distance squared, (1 - s)(1 - s / 4) with zeros at 1 and 2 texels like
// a two-lobe Lanczos, times the window (1 - s / r^2)^2. The result is clamped to the 2x2 quad's per-channel range,
// which removes the ringing of the negative lobe.
// Pass 2, contrast-adaptive sharpen on the output: c' = (c + w (n + s + e + w')) / (1 + 4w) with the most negative
// ring weight w that keeps c' inside 0..1 whatever the five taps hold: w >= -min / (4 max) keeps it above 0 and
// w >= -(1 - max) / (4 (1 - min)) below 1, per channel, the least negative of them, floored at -0.2 so 1 + 4w stays
// at least 0.2, then scaled by `sharpen`. A value above 1 (HDR) gets no sharpening. Both passes work on display-encoded
// values, as the published guidance asks: an sRGB-encoded 8-bit frame is read as is, and a linear frame (float or an
// -srgb format) is encoded to sRGB on read and decoded on write.
// The CPU twin is test/upscale-math.js; test/upscale-browser.mjs checks the shaders against it.
const colour = (linear: boolean) => `const LINEAR=${linear};
fn enc(c:vec3f)->vec3f {if(!LINEAR){return c;}let x=max(c,vec3f(0));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>vec3f(0.0031308));}
fn dec(c:vec3f)->vec3f {if(!LINEAR){return c;}return select(c/12.92,pow((c+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));}`;

const easu = (linear: boolean) =>
  fullscreen +
  colour(linear) +
  `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var<uniform> u:vec4f;
fn tap(q:vec2i)->vec4f {let c=textureLoad(image,clamp(q,vec2i(0),vec2i(textureDimensions(image))-1),0);return vec4f(enc(c.rgb),c.a);}
fn luma(c:vec4f)->f32 {return dot(c.rgb,vec3f(0.25,0.5,0.25));}
fn axis(a:f32,c:f32,b:f32)->f32 {let l=abs(c-a);let r=abs(b-c);let m=max(l,r);if(m<=1e-5){return 0.0;}let t=abs(r-l)/m;return t*t;}
fn analyse(c:f32,n:f32,s:f32,w:f32,e:f32)->vec3f {return vec3f(e-w,s-n,max(axis(w,c,e),axis(n,c,s)));}
fn kernel(s:f32,r2:f32)->f32 {if(s>=r2){return 0.0;}let w=1-s/r2;return (1-s)*(1-0.25*s)*w*w;}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let p=v.position.xy*u.xy-0.5;let b=vec2i(floor(p));let f=p-floor(p);
 var t:array<vec4f,12>;
 let o=array<vec2i,12>(vec2i(0,0),vec2i(1,0),vec2i(0,1),vec2i(1,1),vec2i(0,-1),vec2i(1,-1),vec2i(-1,0),vec2i(-1,1),vec2i(2,0),vec2i(2,1),vec2i(0,2),vec2i(1,2));
 var l:array<f32,12>;
 for(var k=0;k<12;k++){t[k]=tap(b+o[k]);l[k]=luma(t[k]);}
 let a=analyse(l[0],l[4],l[2],l[6],l[1])*(1-f.x)*(1-f.y)+analyse(l[1],l[5],l[3],l[0],l[8])*f.x*(1-f.y)
  +analyse(l[2],l[0],l[10],l[7],l[3])*(1-f.x)*f.y+analyse(l[3],l[1],l[11],l[2],l[9])*f.x*f.y;
 let d2=dot(a.xy,a.xy);let g=select(vec2f(1,0),a.xy*inverseSqrt(max(d2,1e-20)),d2>1e-10);
 let across=1+(1/max(abs(g.x),abs(g.y))-1)*a.z;let along=1+a.z;let r2=2+2*a.z;
 var sum=vec3f(0);var total=0.0;
 for(var k=0;k<12;k++){
  let d=vec2f(o[k])-f;let x=dot(d,g)/across;let y=dot(d,vec2f(-g.y,g.x))/along;let w=kernel(x*x+y*y,r2);
  sum+=t[k].rgb*w;total+=w;
 }
 let lo=min(min(t[0].rgb,t[1].rgb),min(t[2].rgb,t[3].rgb));let hi=max(max(t[0].rgb,t[1].rgb),max(t[2].rgb,t[3].rgb));
 let alpha=mix(mix(t[0].a,t[1].a,f.x),mix(t[2].a,t[3].a,f.x),f.y);
 return vec4f(dec(clamp(sum/total,lo,hi)),alpha);
}`;

const rcas = (linear: boolean) =>
  fullscreen +
  colour(linear) +
  `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var<uniform> u:vec4f;
fn tap(q:vec2i)->vec4f {let c=textureLoad(image,clamp(q,vec2i(0),vec2i(textureDimensions(image))-1),0);return vec4f(enc(c.rgb),c.a);}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let q=vec2i(v.position.xy);let c=tap(q);let n=tap(q+vec2i(0,-1)).rgb;let w=tap(q+vec2i(-1,0)).rgb;let e=tap(q+vec2i(1,0)).rgb;let s=tap(q+vec2i(0,1)).rgb;
 let lo=min(c.rgb,min(min(n,w),min(e,s)));let hi=max(c.rgb,max(max(n,w),max(e,s)));
 let bound=max(-lo/(4*max(hi,vec3f(1e-5))),-(1-hi)/(4*max(1-lo,vec3f(1e-5))));
 let k=min(0.0,max(-0.2,max(bound.r,max(bound.g,bound.b))))*u.z;
 return vec4f(dec((c.rgb+k*(n+w+e+s))/(1+4*k)),c.a);
}`;

/** Options of {@link SpatialUpscale}; the object is kept and read every frame. */
export interface SpatialUpscaleOptions {
  /** Render size as a share of the output size on each axis, 0.25 to 1 (0.77, 0.67, 0.59 and 0.5 are the usual quality steps). Default 0.67. */
  scale?: number;
  /** Strength of the contrast-adaptive sharpen after the upscale, 0 (off) to 1 (the most the local range allows without clipping). Default 0.8. */
  sharpen?: number;
}

/**
 * Renders the scene below output size and rebuilds the full frame from that one frame alone, with no history: an
 * edge-adaptive upsample that keeps edges sharp and free of ringing, then a contrast-adaptive sharpen. For devices
 * and scenes where a temporal upscaler does not fit (no motion data, cuts every frame, very low budgets). Frame-graph
 * passes from order -75 to 45 (the main pass, a PostStack, TAA, motion blur) run at render size, so they get cheaper
 * too; feed it anti-aliased input (MSAA, TAA, or FXAA/SMAA inside the stack). Plugins that draw after order 45 draw
 * over the full frame without the scene's depth. A frame of several views, a partial view or a view into a target is
 * drawn at full size, not upscaled.
 * @throws RangeError when an option is out of range (checked now and every frame); MargoError `'unsupported'` without
 * WebGPU or next to `TAAUpscale`, `'disposed'` after `dispose()`.
 */
export class SpatialUpscale implements EnginePlugin {
  readonly name = 'spatial-upscale';
  private engine?: Engine;
  private disposed = false;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(4);
  private target?: SceneTarget;
  private scene?: GPUTexture;
  private depth?: GPUTexture;
  private middle?: GPUTexture;
  private key = '';
  private easuPipeline?: GPURenderPipeline;
  private rcasPipeline?: GPURenderPipeline;
  private easuGroup?: GPUBindGroup;
  private rcasGroup?: GPUBindGroup;
  private saved?: { width: number; height: number; view: View | undefined };
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };

  constructor(readonly options: SpatialUpscaleOptions = {}) {
    this.validate();
  }

  /** Attaches a new SpatialUpscale to `engine`. */
  static attach(engine: EngineKernel, options: SpatialUpscaleOptions = {}): SpatialUpscale {
    const effect = new SpatialUpscale(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  private validate(): void {
    const o = this.options;
    if (o.scale !== undefined && !(o.scale >= 0.25 && o.scale <= 1))
      throw new RangeError('SpatialUpscale scale must be in 0.25..1');
    if (o.sharpen !== undefined && !(o.sharpen >= 0 && o.sharpen <= 1))
      throw new RangeError('SpatialUpscale sharpen must be in 0..1');
  }

  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'SpatialUpscale is disposed; create a new SpatialUpscale');
    if (!engine.gpu)
      throw margoError(
        'unsupported',
        'SpatialUpscale requires WebGPU or the WebGL2 layer; see https://margoengine.com/errors#webgpu',
      );
    if (engine.hasPlugin('taa-upscale'))
      throw margoError('unsupported', 'SpatialUpscale and TAAUpscale both upscale; keep one of them');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'spatial-upscale:capture',
      order: -75,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    graph.add({
      name: 'spatial-upscale:resolve',
      order: 45,
      execute: (c) => {
        if (c.backend === 'webgpu') this.finish(c);
      },
    });
  }

  private capture(c: Context): void {
    this.validate();
    const scale = this.options.scale ?? 0.67,
      width = Math.max(1, Math.round(c.width * scale)),
      height = Math.max(1, Math.round(c.height * scale)),
      view = renderSizeView(c.view, [c.width, c.height], [width, height]),
      samples = c.descriptor.multisample?.count ?? 4,
      depth = c.descriptor.depthStencil!.format,
      key = `${c.format}:${depth}:${samples}:${c.descriptor.multisample?.count ?? 1}`;
    // Several views, a partial rectangle or a view into a target draw at full size, unscaled.
    if (view === null) return;
    if (this.key !== key || this.scene?.width !== width || this.scene.height !== height) {
      this.releaseTargets();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this.scene = c.device.createTexture({ size: [width, height], format: c.format, usage });
      this.depth = c.device.createTexture({ size: [width, height], format: depth, usage });
      this.target = new SceneTarget(c.device, this.scene, this.depth, samples);
      if (this.key !== key) {
        this.key = key;
        const linear = c.format !== 'rgba8unorm' && c.format !== 'bgra8unorm';
        this.easuPipeline = render(c.device, easu(linear), c.format);
        this.rcasPipeline = render(c.device, rcas(linear), c.format, { multisample: c.descriptor.multisample });
      }
      this.easuGroup = group(c.device, this.easuPipeline!, [this.scene.createView(), { buffer: this.uniform! }]);
    }
    if (this.middle?.width !== c.width || this.middle.height !== c.height || this.middle.format !== c.format) {
      this.middle?.destroy();
      this.middle = c.device.createTexture({
        size: [c.width, c.height],
        format: c.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.rcasGroup = undefined;
    }
    this.rcasGroup ??= group(c.device, this.rcasPipeline!, [this.middle.createView(), { buffer: this.uniform! }]);
    this.values.set([width / c.width, height / c.height, this.options.sharpen ?? 0.8, 0]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    this.saved = { width: c.width, height: c.height, view: c.view };
    // The render-size view first: the target keeps the view it begins with for its depth copies.
    c.view = view;
    this.target!.begin(c);
    c.width = width;
    c.height = height;
  }

  private finish(c: Context): void {
    const saved = this.saved;
    if (!saved) return;
    this.saved = undefined;
    const target = this.target!;
    // A plain resolve, then restore without its depth copy: the outer depth has the output's size, not this target's.
    target.resolve(c.encoder, false);
    (target as unknown as { retired: boolean }).retired = true;
    target.restore(c);
    c.width = saved.width;
    c.height = saved.height;
    c.view = saved.view;
    this.draw(c, this.easuPipeline!, this.easuGroup!, this.middle!.createView(), 'clear');
    this.draw(c, this.rcasPipeline!, this.rcasGroup!, c.color, viewLoadOp(c, 'clear'));
  }

  private draw(c: Context, pipeline: GPURenderPipeline, bindings: GPUBindGroup, view: GPUTextureView, load: GPULoadOp) {
    this.attachment.view = view;
    this.attachment.loadOp = load;
    const pass = c.encoder.beginRenderPass(this.descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }

  private releaseTargets(): void {
    this.target?.dispose();
    this.scene?.destroy();
    this.depth?.destroy();
    this.target = this.scene = this.depth = this.easuGroup = undefined;
  }

  private release(): void {
    this.releaseTargets();
    this.middle?.destroy();
    this.uniform?.destroy();
    this.middle = this.uniform = this.rcasGroup = this.easuPipeline = this.rcasPipeline = undefined;
    this.saved = undefined;
    this.key = '';
  }

  onDeviceRestored(engine: Engine): void {
    if (this.disposed) return;
    this.release();
    this.setup(engine);
  }

  /** Removes the effect and releases its GPU resources. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
