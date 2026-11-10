/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { PostStack } from '@margoengine/post/stack';
import type { StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { fault, rangeError } from '../../shared/errors.js';
import { applyView, viewLoadOp, viewRect, ViewStates } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
declare const GPUShaderStage: { FRAGMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Live controls for structure-tensor oriented, eight-sector polynomial Kuwahara filtering. */
export interface AnisotropicPainterlyOptions {
  /** Integer 1..8, default 3; the longest ellipse radius is at most twice this value. */
  radius?: number;
  /** Blend 0..1, default 1; zero copies input exactly and omits the tensor passes. */
  strength?: number;
  /** Orientation adaptation 0..1, default 1; zero uses circular sectors. */
  anisotropy?: number;
  /** Variance preference exponent 1..8, default 8. */
  sharpness?: number;
  /** Default true; false copies input exactly. */
  enabled?: boolean;
}
const common = `${fullscreen}
struct Paint {rect:vec4i,parameters:vec4f}
@group(0) @binding(0) var<uniform> paint:Paint;
@group(0) @binding(1) var image:texture_2d<f32>;
fn coord(p:vec2i)->vec2i {return clamp(p,paint.rect.xy,paint.rect.xy+paint.rect.zw-1);}
fn read(p:vec2i)->vec3f {return textureLoad(image,coord(p),0).rgb;}
`;
const tensorShader = `${common}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);
 let nw=read(p+vec2i(-1,-1));let n=read(p+vec2i(0,-1));let ne=read(p+vec2i(1,-1));
 let w=read(p+vec2i(-1,0));let e=read(p+vec2i(1,0));
 let sw=read(p+vec2i(-1,1));let s=read(p+vec2i(0,1));let se=read(p+vec2i(1,1));
 let dx=(ne+2.0*e+se-nw-2.0*w-sw)*0.125;
 let dy=(sw+2.0*s+se-nw-2.0*n-ne)*0.125;
 return vec4f(dot(dx,dx),dot(dx,dy),dot(dy,dy),0);
}`;
const blurShader = `${common}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);
 return vec4f((read(p-vec2i(2,0))+4.0*read(p-vec2i(1,0))+6.0*read(p)+4.0*read(p+vec2i(1,0))+read(p+vec2i(2,0)))/16.0,0);
}`;
const filterShader = `${common}
@group(0) @binding(2) var tensor:texture_2d<f32>;
fn tensorAt(p:vec2i)->vec3f {return textureLoad(tensor,coord(p),0).rgb;}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let centre=textureLoad(image,p,0);
 if(paint.parameters.y==0.0){return centre;}
 let t=(tensorAt(p-vec2i(0,2))+4.0*tensorAt(p-vec2i(0,1))+6.0*tensorAt(p)+4.0*tensorAt(p+vec2i(0,1))+tensorAt(p+vec2i(0,2)))/16.0;
 let trace=t.x+t.z;let gap=length(vec2f(t.x-t.z,2.0*t.y));
 var angle=0.0;var adaptation=0.0;
 if(trace>1e-8){angle=0.5*atan2(2.0*t.y,t.x-t.z)+1.57079632679;adaptation=clamp(gap/trace,0.0,1.0)*paint.parameters.z;}
 let tangent=vec2f(cos(angle),sin(angle));let normal=vec2f(-tangent.y,tangent.x);
 let radius=paint.parameters.x;let a=radius*(1.0+adaptation);let b=radius/(1.0+adaptation);
 let bound=i32(ceil(a));let zeta=2.0/radius;let eta=2.0*(zeta+0.70710678118);
 let dirs=array<vec2f,8>(vec2f(1,0),vec2f(0.70710678118,0.70710678118),vec2f(0,1),vec2f(-0.70710678118,0.70710678118),vec2f(-1,0),vec2f(-0.70710678118,-0.70710678118),vec2f(0,-1),vec2f(0.70710678118,-0.70710678118));
 var sums:array<vec3f,8>;var squares:array<vec3f,8>;var weights:array<f32,8>;
 for(var y=-bound;y<=bound;y++){for(var x=-bound;x<=bound;x++){
  let delta=vec2f(f32(x),f32(y));let q=vec2f(dot(delta,tangent)/a,dot(delta,normal)/b);let r2=dot(q,q);
  if(r2>1.0){continue;}
  var w:array<f32,8>;var total=0.0;
  for(var k=0;k<8;k++){let d=dirs[k];let across=dot(q,vec2f(-d.y,d.x));let value=max(0.0,zeta+dot(q,d)-eta*across*across);w[k]=value*value;total+=w[k];}
  let distance=sqrt(r2);let edge=max(0.0,1.0-distance);let radial=exp(-3.125*r2)*edge*edge*edge*edge*(1.0+4.0*distance)/max(total,1e-20);let colour=read(p+vec2i(x,y));
  for(var k=0;k<8;k++){let weight=w[k]*radial;sums[k]+=colour*weight;squares[k]+=colour*colour*weight;weights[k]+=weight;}
 }}
 var result=vec3f(0);var total=0.0;
 for(var k=0;k<8;k++){
  let mean=sums[k]/weights[k];let variance=max(squares[k]/weights[k]-mean*mean,vec3f(0));
  let preference=1.0/(1.0+pow(100.0*sqrt(dot(variance,vec3f(1))),paint.parameters.w));
  result+=mean*preference;total+=preference;
 }
 return vec4f(mix(centre.rgb,clamp(result/total,vec3f(0),vec3f(1)),paint.parameters.y),centre.a);
}`;
interface Resources {
  uniform: GPUBuffer;
  width?: number;
  height?: number;
  first?: GPUTexture;
  second?: GPUTexture;
  firstView?: GPUTextureView;
  secondView?: GPUTextureView;
  input?: GPUTextureView;
  tensorGroup?: GPUBindGroup;
  blurGroup?: GPUBindGroup;
  filterGroup?: GPUBindGroup;
}

/** LDR PostStack effect with a smoothed RGB structure tensor and overlapping elliptical sectors. */
export class AnisotropicPainterly implements EnginePlugin {
  readonly name = 'anisotropic-painterly';
  #engine?: Engine;
  #stack?: PostStack;
  #stacked = false;
  #disposed = false;
  #tensor?: GPURenderPipeline;
  #blur?: GPURenderPipeline;
  #layout?: GPUBindGroupLayout;
  #filters = new Map<string, GPURenderPipeline>();
  #bytes = new ArrayBuffer(32);
  #rect = new Int32Array(this.#bytes, 0, 4);
  #parameters = new Float32Array(this.#bytes, 16, 4);
  #views = new ViewStates<Resources>(
    () => ({
      uniform: this.#engine!.gpu!.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    }),
    (state) => {
      state.uniform.destroy();
      state.first?.destroy();
      state.second?.destroy();
    },
  );
  constructor(readonly options: AnisotropicPainterlyOptions = {}) {
    this.#validate();
  }
  /** Creates and owns a PostStack; otherwise place a new effect after the stack's display stage. */
  static attach(engine: EngineKernel, options: AnisotropicPainterlyOptions = {}): AnisotropicPainterly {
    const effect = new AnisotropicPainterly(options);
    if (!engineRuntime(engine).gpu)
      throw fault('unsupported', 'Anisotropic paint needs a GPU device; use WebGPU or the full compatibility layer');
    effect.#stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** False copies the input exactly. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw rangeError('Invalid anisotropic enabled; pass true or false', 'arguments');
    this.options.enabled = value;
  }
  private joinStack(): StackStage {
    this.#alive();
    if (this.#stacked || this.#engine)
      throw fault('attached', 'Anisotropic paint is attached; create a new effect', 'state');
    this.#stacked = true;
    return { kind: 'ldr', render: (c, input, output) => this.#draw(c, input, output) };
  }
  setup(engine: Engine): void {
    this.#alive();
    if (this.#engine) throw fault('attached', 'Anisotropic paint is attached; create a new effect', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'Anisotropic paint needs a GPU device; use WebGPU or the full compatibility layer');
    if (!this.#stacked) throw fault('state', 'Anisotropic paint needs a stack; use attach or PostStack');
    this.#validate();
    this.#engine = engine;
  }
  #alive(): void {
    if (this.#disposed) throw fault('disposed', 'Anisotropic paint is disposed; create a new effect');
  }
  #validate(): void {
    const o = this.options;
    if (!o || typeof o !== 'object' || Array.isArray(o))
      throw rangeError('Invalid anisotropic options; pass an options object', 'arguments');
    if (o.radius !== undefined && (!Number.isInteger(o.radius) || o.radius < 1 || o.radius > 8))
      throw rangeError('Invalid anisotropic radius; pass an integer in 1..8', 'arguments');
    for (const [name, value, lo, hi] of [
      ['strength', o.strength, 0, 1],
      ['anisotropy', o.anisotropy, 0, 1],
      ['sharpness', o.sharpness, 1, 8],
    ] as const)
      if (value !== undefined && (!Number.isFinite(value) || value < lo || value > hi))
        throw rangeError(`Invalid anisotropic ${name}; pass a finite number in ${lo}..${hi}`, 'arguments');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw rangeError('Invalid anisotropic enabled; pass true or false', 'arguments');
  }
  #pipelines(c: Context, output: StageOutput): GPURenderPipeline {
    const d = c.device;
    if (!this.#tensor) {
      const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ];
      const layout = d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({ entries })] });
      this.#tensor = render(d, tensorShader, 'rgba32float', { layout });
      this.#blur = render(d, blurShader, 'rgba32float', { layout });
      this.#layout = d.createBindGroupLayout({
        entries: [
          ...entries,
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        ],
      });
    }
    const key = output.format + ':' + (output.multisample?.count ?? 1);
    let pipeline = this.#filters.get(key);
    if (!pipeline) {
      pipeline = render(d, filterShader, output.format, {
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.#layout!] }),
        multisample: output.multisample,
      });
      this.#filters.set(key, pipeline);
    }
    return pipeline;
  }
  #draw(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.#alive();
    this.#validate();
    if (!this.#engine) throw fault('state', 'Anisotropic paint needs a live stack; attach before drawing');
    if (c.width * c.height * 32 > 512 * 1024 * 1024)
      throw rangeError('Anisotropic intermediate textures exceed 512 MiB; reduce render resolution', 'arguments');
    const pipeline = this.#pipelines(c, output),
      s = this.#views.get(c);
    if (s.width !== c.width || s.height !== c.height) {
      s.first?.destroy();
      s.second?.destroy();
      const create = () =>
        c.device.createTexture({
          size: [c.width, c.height],
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
      s.first = create();
      s.second = create();
      s.firstView = s.first.createView();
      s.secondView = s.second.createView();
      s.width = c.width;
      s.height = c.height;
      s.input = undefined;
    }
    if (s.input !== input) {
      s.tensorGroup = group(c.device, this.#tensor!, [{ buffer: s.uniform }, input]);
      s.blurGroup = group(c.device, this.#blur!, [{ buffer: s.uniform }, s.firstView!]);
      s.filterGroup = group(c.device, pipeline, [{ buffer: s.uniform }, input, s.secondView!]);
      s.input = input;
    }
    this.#rect.set(viewRect(c) ?? [0, 0, c.width, c.height]);
    this.#parameters.set([
      this.options.radius ?? 3,
      this.enabled ? (this.options.strength ?? 1) : 0,
      this.options.anisotropy ?? 1,
      this.options.sharpness ?? 8,
    ]);
    c.device.queue.writeBuffer(s.uniform, 0, this.#bytes);
    if (this.#parameters[1] > 0) {
      this.#paint(c, this.#tensor!, s.tensorGroup!, s.firstView!);
      this.#paint(c, this.#blur!, s.blurGroup!, s.secondView!);
    }
    this.#paint(c, pipeline, s.filterGroup!, output.view);
  }
  #paint(c: Context, pipeline: GPURenderPipeline, bindings: GPUBindGroup, view: GPUTextureView): void {
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) this.#views.prune();
  }
  #release(): void {
    this.#views.clear();
    this.#filters.clear();
    this.#tensor = undefined;
    this.#blur = undefined;
    this.#layout = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.#alive();
    this.#release();
    this.#engine = undefined;
    this.setup(engine);
  }
  /** Terminal, idempotent teardown; releases the stack owned by attach. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const engine = this.#engine;
    this.#engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.#release();
    this.#stack?.dispose();
    this.#stack = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
