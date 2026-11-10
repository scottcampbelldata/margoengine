/// <reference lib="esnext.disposable" preserve="true" />
// Underwater view: Beer-Lambert extinction (Bouguer-Lambert-Beer law) with per-channel absorption plus scattering,
// single-scattered sunlight marched along the in-water part of each view ray with a Henyey-Greenstein phase function
// (Henyey & Greenstein 1941), Snell refraction and Schlick's Fresnel approximation (Schlick 1994) at the surface, and
// light-shaft focusing from the Jacobian of the refracted ray map over the rendered surface (irradiance follows the
// inverse area change of a ray bundle; Born & Wolf, Principles of Optics, 3.1). The waterline is the intersection of
// the camera near plane with the surface probed under the camera. Citations are in docs/clean-room.md.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { PostStack } from '@margoengine/post/stack';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { fault, rangeError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import type { Water } from './index.js';
import type { FFTOcean } from './fft.js';
import { queryStates } from './query-state.js';
import { surfacePass } from './surface-pass.js';
import { SurfaceCapture } from './surface-capture.js';
import { underwaterOptics } from './underwater-optics.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Live settings except surface and resolution, which are copied. Coefficients are per metre, linear RGB. */
export interface UnderwaterOptions {
  /** Live Water or FFTOcean in the same engine and scene. Required. */
  surface: Water | FFTOcean;
  /** Absorption coefficient per channel, 0..100 /m. Default [0.38, 0.1, 0.045], Water's own absorption. */
  absorption?: readonly [number, number, number];
  /** Scattering coefficient per channel, 0..100 /m. Default [0.02, 0.035, 0.04]. */
  scattering?: readonly [number, number, number];
  /** Henyey-Greenstein asymmetry, -0.99..0.99; positive scatters forward. Default 0.75. */
  anisotropy?: number;
  /** Light shaft (single-scattered sunlight) strength, 0..10; 0 leaves only ambient in-scatter. Default 1. */
  shafts?: number;
  /** Ray-march samples per pixel for the sunlit in-scatter, integer 1..128. Default 24. */
  steps?: number;
  /** Distance the shafts are marched, 0.1..10000 m; farther water uses the shaft-free analytic integral. Default 40. */
  shaftDistance?: number;
  /** Path length used for empty pixels (sky or far plane), 0.1..100000 m. Default 200. */
  maxDistance?: number;
  /** Width of the surface field around the camera that focuses shafts, 1..10000 m. Default 64. */
  shaftExtent?: number;
  /** Side of that surface field in texels, power of two 16..1024. Copied. Default 128. */
  resolution?: number;
  /** Waterline band width in drawing-buffer pixels, 0..64; 0 hides the band. Default 2. */
  waterline?: number;
  /** Water refractive index, 1..2. Default 1.333. */
  refractiveIndex?: number;
  /** Screen trace samples per reflection/refraction ray, integer 1..2048. Default 512. */
  raySteps?: number;
  /** Depth reconstruction tolerance in metres, 0.001..10. Default 0.05, plus the local texel footprint. */
  thickness?: number;
  /** Borrowed sampleable single-sample rgba16float equirectangular sky. Default the sky gradient. */
  environment?: () => GPUTexture | undefined;
  /** Linear horizon radiance, three channels in 0..100. Default [0.38, 0.53, 0.67]. */
  skyHorizon?: readonly [number, number, number];
  /** Linear zenith radiance, three channels in 0..100. Default [0.045, 0.16, 0.34]. */
  skyZenith?: readonly [number, number, number];
  /** False passes the scene through unchanged. Default true. */
  enabled?: boolean;
}

const shader = (encode: boolean) => `${fullscreen}${encode ? displayShader : ''}
@group(0) @binding(0) var<uniform> u:array<vec4f,24>;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var mask:texture_2d<f32>;
@group(0) @binding(4) var field:texture_2d<f32>;
@group(0) @binding(5) var probe:texture_2d<f32>;
@group(0) @binding(6) var opaque:texture_2d<f32>;
@group(0) @binding(7) var environment:texture_2d<f32>;
@group(0) @binding(8) var skySampler:sampler;
fn unproject(xy:vec2f,d:f32)->vec3f {let p=mat4x4f(u[4],u[5],u[6],u[7])*vec4f(xy,d,1);return p.xyz/p.w;}
${underwaterOptics}
fn cell(xz:vec2f)->vec2i {let r=u[18].x;return vec2i(floor(((xz-u[8].xz)/u[12].w*0.5+0.5)*r));}
fn surfaceAt(p:vec2i)->vec4f {let r=i32(u[18].x);if(any(p<vec2i(0))||any(p>=vec2i(r))){return vec4f(0);}return textureLoad(field,p,0);}
// Refracted propagation direction (pointing down) of sunlight through a surface with normal n.
fn refracted(n:vec3f)->vec3f {
 let i=-u[12].xyz;let eta=1.0/u[19].w;let c=-dot(n,i);let k=1.0-eta*eta*(1.0-c*c);
 if(k<0.0){return vec3f(0,-1,0);}return normalize(eta*i+(eta*c-sqrt(k))*n);
}
fn slope(n:vec3f)->vec2f {let t=refracted(n);return t.xz/min(t.y,-0.05);}
// 1/|J| of the map x -> x + z*slope(n(x)) over one field cell, clamped so a fold stays finite.
fn focus(p:vec2i,z:f32)->f32 {
 let a=surfaceAt(p);let b=surfaceAt(p+vec2i(1,0));let c=surfaceAt(p+vec2i(0,1));
 if(dot(a.xyz,a.xyz)<0.5||dot(b.xyz,b.xyz)<0.5||dot(c.xyz,c.xyz)<0.5){return 1.0;}
 let h=2.0*u[12].w/u[18].x;let s=slope(a.xyz);let dx=(slope(b.xyz)-s)/h;let dz=(slope(c.xyz)-s)/h;
 let j=(1.0+z*dx.x)*(1.0+z*dz.y)-z*dx.y*z*dz.x;return min(1.0/max(abs(j),0.1),10.0);
}
fn hg(c:f32)->f32 {let g=u[17].w;let d=1.0+g*g-2.0*g*c;return (1.0-g*g)/(12.566370614*d*sqrt(d));}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let now=textureLoad(scene,p,0);
 let xy=(at.xy-u[14].xy)/u[14].zw*vec2f(2,-2)+vec2f(-1,1);
 let near=unproject(xy,1.0);let probed=textureLoad(probe,vec2i(0),0);
 let level=vec3f(u[8].x,probed.w,u[8].z);let found=dot(probed.xyz,probed.xyz)>0.5;
 let side=dot(near-level,select(vec3f(0,1,0),normalize(probed.xyz),found));
 let px=max(fwidth(side),1e-9);
 if(u[20].y<0.5||!found){return vec4f(${encode ? 'toDisplay(now.rgb)' : 'now.rgb'},now.a);}
 var rgb=now.rgb;
 if(side<0.0){
  let d=textureLoad(depth,p,0);let far=unproject(xy,max(d,0.000001));let ray=normalize(far-near);
  var span=select(u[19].y,distance(near,far),d>0.0);
  let hit=textureLoad(mask,p,0);let hitSpan=max(0.0,abs(hit.w)-distance(u[8].xyz,near));
  if(dot(hit.xyz,hit.xyz)>0.5&&hit.w<0.0&&hitSpan<span){
   span=hitSpan;let point=near+ray*span;let n=-normalize(hit.xyz);
   let cosine=clamp(dot(-ray,n),0.0,1.0);let f=dielectric(cosine,u[19].w);
   let reflected=trace(point+n*0.001,reflect(ray,n));
   let k=u[16].xyz+u[17].xyz;
   // The reflected path stays in water. Unavailable off-screen geometry tends
   // to the same ambient medium used by the volume, rather than reflecting sky.
   var reflection=u[15].rgb*u[17].rgb/max(k,vec3f(1e-6));
   if(reflected.w>=0.0){let t=exp(-k*reflected.w);reflection=reflected.rgb*t+reflection*(vec3f(1)-t);}
   var transmission=vec3f(0);
   if(f<1.0){let r=refract(ray,n,u[19].w);let sample=trace(point-n*0.001,r);transmission=select(sky(r),sample.rgb,sample.w>=0.0);}
   rgb=mix(transmission,reflection,f);
  }
  let a=u[16].xyz;let b=u[17].xyz;let k=a+b;let view=exp(-k*span);
  let sun=u[13].xyz*u[13].w;let down=refracted(vec3f(0,1,0));let cosine=max(0.0,u[12].y);
  let fresnel=1.0-(0.02+0.98*pow(1.0-cosine,5.0));
  let phase=hg(dot(down,-ray));let ambient=u[15].xyz;
  let march=min(span,u[19].z);let steps=u[16].w;let dt=march/steps;
  let jitter=fract(52.9829189*fract(dot(at.xy,vec2f(0.06711056,0.00583715))));
  var light=vec3f(0);
  for(var i=0.0;i<steps;i+=1.0){
   let t=(i+jitter)*dt;let q=near+ray*t;
   let lift=max(0.0,probed.w-q.y);let foot=q.xz+down.xz*lift/min(down.y,-0.05);
   let c=cell(foot);let s=surfaceAt(c);let top=select(probed.w,s.w,dot(s.xyz,s.xyz)>0.5);let z=top-q.y;
   if(z<=0.0){continue;}
   let shaft=u[20].x*focus(c,z)*fresnel*phase*sun*exp(-k*z/max(-down.y,0.05));
   light+=b*(shaft+ambient*exp(-k*z))*exp(-k*t)*dt;
  }
  // Past the march the in-scatter of a constant source at the last depth integrates in closed form.
  let z=max(0.0,probed.w-(near+ray*march).y);
  let tail=b*(u[20].x*fresnel*phase*sun*exp(-k*z/max(-down.y,0.05))+ambient*exp(-k*z))*(exp(-k*march)-view)/max(k,vec3f(1e-6));
  rgb=rgb*view+light+tail;
 }
 let band=select(0.0,1.0-smoothstep(0.0,u[19].x,abs(side)/px),u[19].x>0.0);
 rgb=mix(rgb,rgb*vec3f(0.35,0.5,0.55),band);
 return vec4f(${encode ? 'toDisplay(rgb)' : 'rgb'},now.a);
}`;

/** Fog, colour absorption, a waterline across the camera and light shafts while the camera is below the surface. */
export class Underwater implements EnginePlugin {
  readonly name = 'water:underwater';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private removePass?: () => void;
  private readonly surface: Water | FFTOcean;
  private readonly resolution: number;
  private readonly values = new Float32Array(96);
  private readonly workspace = new Float64Array(52);
  private readonly capture = new SurfaceCapture();
  private uniform?: GPUBuffer;
  private targets: GPUTexture[] = [];
  private depths: GPUTexture[] = [];
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private prepared?: GPUCommandEncoder;
  private opaque?: GPUTexture;
  private opaqueDepth?: GPUTexture;
  private sampler?: GPUSampler;
  private environment?: GPUTexture;
  private depthCopy?: GPURenderPipeline;

  constructor(readonly options: UnderwaterOptions) {
    this.validate();
    if (!queryStates.has(options.surface)) throw fault('state', 'Underwater surface must be a Water or FFTOcean');
    this.surface = options.surface;
    this.resolution = options.resolution ?? 128;
  }
  /** Attach alone; to combine effects add new Underwater(options) to a PostStack. */
  static attach(engine: EngineKernel, options: UnderwaterOptions): Underwater {
    const effect = new Underwater(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  private validate(): void {
    const o = this.options;
    if (!o || typeof o !== 'object') throw fault('state', 'Underwater needs options.surface, a live Water or FFTOcean');
    for (const [name, min, max, integer] of [
      ['anisotropy', -0.99, 0.99, false],
      ['shafts', 0, 10, false],
      ['steps', 1, 128, true],
      ['shaftDistance', 0.1, 10000, false],
      ['maxDistance', 0.1, 100000, false],
      ['shaftExtent', 1, 10000, false],
      ['resolution', 16, 1024, true],
      ['waterline', 0, 64, false],
      ['refractiveIndex', 1, 2, false],
      ['raySteps', 1, 2048, true],
      ['thickness', 0.001, 10, false],
    ] as const) {
      const value = o[name];
      if (
        value !== undefined &&
        (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      )
        throw rangeError(
          `Underwater ${name} must be ${integer ? 'an integer' : 'finite'} in ${min}..${max}; pass a value in range`,
          'geometry',
        );
    }
    if (o.resolution !== undefined && o.resolution & (o.resolution - 1))
      throw rangeError('Underwater resolution must be a power of two; use 16, 32, ... 1024', 'geometry');
    for (const name of ['absorption', 'scattering', 'skyHorizon', 'skyZenith'] as const) {
      const value = o[name];
      if (
        value !== undefined &&
        (typeof value !== 'object' || value.length !== 3 || value.some((v) => !Number.isFinite(v) || v < 0 || v > 100))
      )
        throw rangeError(`Underwater ${name} needs three finite per-metre channels in 0..100`, 'geometry');
    }
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw fault('state', 'Underwater enabled must be true or false');
    if (o.environment !== undefined && typeof o.environment !== 'function')
      throw fault('state', 'Underwater environment must be a function returning a sampleable sky texture');
  }
  private joinStack(host: StackHost): StackStage {
    if (this.disposed) throw fault('disposed', 'Underwater is disposed; create another Underwater');
    if (this.host || this.engine)
      throw fault('attached', 'Underwater is already attached; create another Underwater for the other stack', 'state');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.composite(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'Underwater is disposed; create another Underwater');
    if (this.engine)
      throw fault('attached', 'Underwater is already attached; create another Underwater for the other stack', 'state');
    if (!this.host) throw fault('state', 'Use Underwater.attach or add Underwater to a PostStack');
    if (!engine.gpu) throw fault('unsupported', 'Underwater requires WebGPU or full WebGL2 compatibility', 'webgpu');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 384, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat' });
    // After caustics (order 0): the probe and mask read the same submitted surface.
    this.removePass = surfacePass(this.surface, 1, (c) => this.probe(c));
  }
  private textures(c: Context): void {
    if (this.targets[0]?.width === c.width && this.targets[0].height === c.height) return;
    this.releaseTextures();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    for (const [width, height] of [
      [c.width, c.height],
      [this.resolution, this.resolution],
      [1, 1],
    ]) {
      this.targets.push(c.device.createTexture({ size: [width, height], format: 'rgba32float', usage }));
      this.depths.push(c.device.createTexture({ size: [width, height], format: 'depth32float', usage }));
    }
    this.opaque = c.device.createTexture({
      size: [c.width, c.height],
      format: this.host!.target!.resolvedColor.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.opaqueDepth = c.device.createTexture({ size: [c.width, c.height], format: 'depth32float', usage });
  }
  private probe(c: Context): boolean {
    this.validate();
    const o = this.options,
      state = queryStates.get(this.surface)?.();
    if (
      !this.host?.target ||
      !state ||
      state.device !== c.device ||
      this.engine!.sceneOf(this) !== this.engine!.sceneOf(this.surface)
    )
      throw fault('state', 'Underwater and its live surface must share an engine, scene and PostStack');
    this.prepared = c.encoder;
    if (o.enabled === false) return false;
    this.textures(c);
    // Snapshot current opaque colour and depth before either Water or FFT draws.
    // In particular FFT writes scene depth, so the composite cannot use its later resolve.
    const target = this.host!.target!;
    target.resolve(c.encoder);
    c.encoder.copyTextureToTexture({ texture: target.resolvedColor }, { texture: this.opaque! }, [c.width, c.height]);
    if (target.samples === 4) target.copyDepth(c.encoder, this.opaqueDepth!.createView(), 1, 'depth32float');
    else {
      if (!this.depthCopy) {
        const module = c.device.createShaderModule({
          code: `${fullscreen}
@group(0) @binding(0) var source:texture_depth_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {return textureLoad(source,vec2i(p.xy),0);}`,
        });
        this.depthCopy = c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        });
      }
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.opaqueDepth!.createView(),
          depthLoadOp: viewLoadOp(c, 'clear'),
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      pass.setPipeline(this.depthCopy);
      pass.setBindGroup(
        0,
        group(c.device, this.depthCopy, [target.resolvedDepth.createView({ aspect: 'depth-only' })]),
      );
      applyView(pass, c);
      pass.draw(3);
      pass.end();
    }
    this.environment = o.environment?.();
    const environment = this.environment;
    if (
      environment &&
      (environment.format !== 'rgba16float' ||
        environment.sampleCount !== 1 ||
        environment.dimension !== '2d' ||
        environment.depthOrArrayLayers !== 1 ||
        !(environment.usage & GPUTextureUsage.TEXTURE_BINDING))
    )
      throw fault('state', 'Underwater environment needs a sampleable single-sample 2D rgba16float sky texture');
    const v = this.values,
      light = this.engine!.lighting;
    v.fill(0);
    v.set(c.camera.matrix);
    if (!invertMatrixStable(c.camera.matrix, v.subarray(16, 32), this.workspace))
      throw fault('state', 'Underwater needs an invertible camera; give it a finite projection');
    v.set(c.camera.position, 32);
    const d = light.direction,
      length = Math.hypot(d[0], d[1], d[2]) || 1;
    v.set([d[0] / length, d[1] / length, d[2] / length, (o.shaftExtent ?? 64) / 2], 48);
    v.set([light.radiance[0], light.radiance[1], light.radiance[2], d[3]], 52);
    v.set(c.view?.viewport ?? [0, 0, c.width, c.height], 56);
    v.set([light.ambient[0], light.ambient[1], light.ambient[2], 0], 60);
    v.set([...(o.absorption ?? [0.38, 0.1, 0.045]), o.steps ?? 24], 64);
    v.set([...(o.scattering ?? [0.02, 0.035, 0.04]), o.anisotropy ?? 0.75], 68);
    v[72] = this.resolution;
    v.set([o.waterline ?? 2, o.maxDistance ?? 200, o.shaftDistance ?? 40, o.refractiveIndex ?? 1.333], 76);
    v.set([o.shafts ?? 1, 1, 0, 0], 80);
    v.set([o.raySteps ?? 512, o.thickness ?? 0.05, 0, 0], 84);
    v.set([...(o.skyHorizon ?? [0.38, 0.53, 0.67]), 0], 88);
    v.set([...(o.skyZenith ?? [0.045, 0.16, 0.34]), environment ? 1 : 0], 92);
    c.device.queue.writeBuffer(this.uniform!, 0, v);
    this.capture.draw(c, this.surface, this.uniform!, this.targets, this.depths);
    return false;
  }
  private composite(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    if (this.prepared !== c.encoder)
      throw fault('state', 'Render the live Underwater surface in the same scene before composition');
    const enabled = this.options.enabled !== false && this.targets.length > 0;
    const key = `${output.format}:${output.multisample.count ?? 1}:${+output.hdr}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(c.device, shader(!output.hdr), output.format, { multisample: output.multisample });
      this.pipelines.set(key, pipeline);
    }
    if (!enabled) {
      this.values[81] = 0;
      if (!this.targets.length) this.textures(c);
      c.device.queue.writeBuffer(this.uniform!, 324, this.values, 81, 1);
    }
    const depth = this.opaqueDepth!;
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      group(c.device, pipeline, [
        { buffer: this.uniform! },
        input,
        depth.createView({ aspect: 'depth-only' }),
        ...this.targets.map((t) => t.createView()),
        this.opaque!.createView(),
        (this.environment ?? this.opaque!).createView(),
        this.sampler!,
      ]),
    );
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private releaseTextures(): void {
    for (const texture of [...this.targets, ...this.depths]) texture.destroy();
    this.targets = [];
    this.depths = [];
    this.opaque?.destroy();
    this.opaqueDepth?.destroy();
    this.opaque = this.opaqueDepth = undefined;
    this.environment = undefined;
  }
  private release(): void {
    this.removePass?.();
    this.removePass = undefined;
    this.releaseTextures();
    this.capture.dispose();
    this.uniform?.destroy();
    this.uniform = undefined;
    this.pipelines.clear();
    this.depthCopy = undefined;
    this.prepared = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
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
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
