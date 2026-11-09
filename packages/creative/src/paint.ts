/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { PostStack } from '@margoengine/post/stack';
import type { StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { fault, rangeError } from '../../shared/errors.js';
import { applyView, viewLoadOp, viewRect, ViewStates } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Display-space painterly treatment. */
export type PainterlyMode = 'kuwahara' | 'watercolour' | 'sketch';
/** Live options, checked before drawing each frame. */
export interface PainterlyOptions {
  /** Default 'kuwahara'. Watercolour and sketch are stylizations, not physical media simulations. */
  mode?: PainterlyMode;
  /** Integer pixel radius 1..8. Sketch uses this as its gradient spacing. Default 3. */
  radius?: number;
  /** Blend with the input, 0..1. Zero copies exactly. Default 1. */
  strength?: number;
  /** False copies exactly. Default true. */
  enabled?: boolean;
}

// Classic four overlapping rectangular regions, minimum summed RGB variance, as described in section 2 of
// Kyprianidis, Kang and Dollner (2009). This is not their anisotropic structure-tensor filter.
// Watercolour borrows the appearance goals (granulation and darkened edges) of Curtis et al. (1997),
// not their fluid or pigment simulation. Sobel gradients and diagonal tone hatching are authored here.
const shader = `${fullscreen}
struct Paint {rect:vec4i,flags:vec4u,blend:vec4f}
@group(0) @binding(0) var<uniform> paint:Paint;
@group(0) @binding(1) var image:texture_2d<f32>;
fn read(p:vec2i)->vec3f {
 return textureLoad(image,clamp(p,paint.rect.xy,paint.rect.xy+paint.rect.zw-1),0).rgb;
}
fn luma(c:vec3f)->f32 {return dot(c,vec3f(0.299,0.587,0.114));}
fn edge(p:vec2i,r:i32)->f32 {
 let nw=luma(read(p+vec2i(-r,-r)));let n=luma(read(p+vec2i(0,-r)));let ne=luma(read(p+vec2i(r,-r)));
 let w=luma(read(p+vec2i(-r,0)));let e=luma(read(p+vec2i(r,0)));
 let sw=luma(read(p+vec2i(-r,r)));let s=luma(read(p+vec2i(0,r)));let se=luma(read(p+vec2i(r,r)));
 let dx=ne+2*e+se-nw-2*w-sw;let dy=sw+2*s+se-nw-2*n-ne;
 return clamp(length(vec2f(dx,dy))*0.25,0.0,1.0);
}
fn smoothColour(p:vec2i,r:i32)->vec3f {
 var best=vec3f(0);var variance=1e10;
 let count=f32((r+1)*(r+1));
 for(var q=0;q<4;q++) {
  let direction=vec2i(select(-1,1,(q%2)==1),select(-1,1,q>=2));
  var sum=vec3f(0);var squares=vec3f(0);
  for(var y=0;y<=r;y++) {for(var x=0;x<=r;x++) {
   let c=read(p+vec2i(x,y)*direction);sum+=c;squares+=c*c;
  }}
  let mean=sum/count;let v=dot(max(squares/count-mean*mean,vec3f(0)),vec3f(1));
  if(v<variance) {variance=v;best=mean;}
 }
 return best;
}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let centre=textureLoad(image,p,0);
 if(paint.flags.z==0u||paint.blend.x==0.0) {return centre;}
 let r=i32(paint.flags.x);let local=p-paint.rect.xy;
 var colour:vec3f;
 if(paint.flags.y==2u) {
  let tone=luma(centre.rgb);let outline=edge(p,r);
  let first=select(0.0,1.0,((local.x+local.y)%6)==0&&tone<0.75);
  let second=select(0.0,1.0,((local.x-local.y+paint.rect.w)%6)==0&&tone<0.4);
  colour=vec3f((1.0-0.85*outline)*(1.0-max(first*0.45,second*0.6)));
 } else {
  colour=smoothColour(p,r);
  if(paint.flags.y==1u) {
   // Integer paper texture: stable across frames and reproducible without transcendental noise.
   let grain=f32((u32(local.x)*13u+u32(local.y)*7u)%17u)/16.0;
   let wash=floor(colour*7.0+0.5)/7.0;
   colour=mix(vec3f(1),wash,0.85)*(1.0-0.2*edge(p,1))*(0.96+0.04*grain);
  }
 }
 return vec4f(mix(centre.rgb,clamp(colour,vec3f(0),vec3f(1)),paint.blend.x),centre.a);
}`;

interface ViewResources {
  uniform: GPUBuffer;
  input?: GPUTextureView;
  pipeline?: GPURenderPipeline;
  group?: GPUBindGroup;
}

/**
 * LDR PostStack effect: classic Kuwahara, a quantized watercolour wash or a Sobel/hatching sketch.
 * Preserves centre alpha; all neighbourhood reads clamp to the current view. No history or scene data required.
 * `attach` owns a stack; otherwise use `new Painterly(options)` in a PostStack after display effects.
 * @throws RangeError for invalid options (also live edits); MargoError 'unsupported' on WebGL2, 'state' outside
 * a PostStack, 'attached' on a second attachment, and 'disposed' after disposal. Errors include a help link.
 */
export class Painterly implements EnginePlugin {
  readonly name = 'painterly';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private pipeline?: GPURenderPipeline;
  private key = '';
  private readonly bytes = new ArrayBuffer(48);
  private readonly rect = new Int32Array(this.bytes, 0, 4);
  private readonly flags = new Uint32Array(this.bytes, 16, 4);
  private readonly blend = new Float32Array(this.bytes, 32, 4);
  // Separate uniforms keep encoded views independent until the shared command buffer is submitted.
  private readonly views = new ViewStates<ViewResources>(
    () => ({
      uniform: this.engine!.gpu!.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    }),
    (state) => state.uniform.destroy(),
  );

  constructor(readonly options: PainterlyOptions = {}) {
    this.validate();
  }

  /** Attaches the effect in its own PostStack. Dispose the returned effect to release both. */
  static attach(engine: EngineKernel, options: PainterlyOptions = {}): Painterly {
    const effect = new Painterly(options);
    if (!engineRuntime(engine).gpu) throw fault('unsupported', 'Painterly requires WebGPU; WebGL2 is unsupported');
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  /** Default true; false copies the input. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw rangeError('Invalid Painterly enabled; pass true or false', 'arguments');
    this.options.enabled = value;
  }

  private joinStack(): StackStage {
    this.alive();
    if (this.stacked || this.engine)
      throw fault('attached', 'Painterly is already attached; create a new effect', 'state');
    this.stacked = true;
    return { kind: 'ldr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    this.alive();
    if (this.engine) throw fault('attached', 'Painterly is already attached; create a new effect', 'state');
    if (!engine.gpu) throw fault('unsupported', 'Painterly requires WebGPU; WebGL2 is unsupported');
    if (!this.stacked) throw fault('state', 'Use Painterly.attach(engine) or add a new Painterly to a PostStack');
    this.validate();
    this.engine = engine;
  }

  onPreUpdate(delta: number): void {
    if (delta > 0) this.views.prune();
  }

  onDeviceRestored(engine: Engine): void {
    this.alive();
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }

  /** Terminal, idempotent disposal; also disposes the stack made by attach. */
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

  private alive(): void {
    if (this.disposed) throw fault('disposed', 'Painterly is disposed; create a new effect');
  }

  private validate(): void {
    const o = this.options;
    if (!o || typeof o !== 'object' || Array.isArray(o))
      throw rangeError('Invalid Painterly options; pass an options object', 'arguments');
    if (o.mode !== undefined && !['kuwahara', 'watercolour', 'sketch'].includes(o.mode))
      throw rangeError('Invalid Painterly mode; pass kuwahara, watercolour or sketch', 'arguments');
    if (o.radius !== undefined && (!Number.isInteger(o.radius) || o.radius < 1 || o.radius > 8))
      throw rangeError('Invalid Painterly radius; pass an integer in 1..8', 'arguments');
    if (
      o.strength !== undefined &&
      (typeof o.strength !== 'number' || !Number.isFinite(o.strength) || o.strength < 0 || o.strength > 1)
    )
      throw rangeError('Invalid Painterly strength; pass a finite number in 0..1', 'arguments');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw rangeError('Invalid Painterly enabled; pass true or false', 'arguments');
  }

  private draw(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.alive();
    this.validate();
    if (!this.engine) throw fault('state', 'Attach Painterly to a live PostStack before drawing');
    const key = output.format + ':' + (output.multisample?.count ?? 1);
    if (key !== this.key) {
      this.pipeline = render(c.device, shader, output.format, { multisample: output.multisample });
      this.key = key;
    }
    const state = this.views.get(c);
    this.rect.set(viewRect(c) ?? [0, 0, c.width, c.height]);
    this.flags[0] = this.options.radius ?? 3;
    this.flags[1] = this.options.mode === 'sketch' ? 2 : this.options.mode === 'watercolour' ? 1 : 0;
    this.flags[2] = +this.enabled;
    this.blend[0] = this.options.strength ?? 1;
    c.device.queue.writeBuffer(state.uniform, 0, this.bytes);
    if (state.input !== input || state.pipeline !== this.pipeline) {
      state.group = group(c.device, this.pipeline!, [{ buffer: state.uniform }, input]);
      state.input = input;
      state.pipeline = this.pipeline;
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    try {
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, state.group!);
      applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }

  private release(): void {
    this.views.clear();
    this.pipeline = undefined;
    this.key = '';
  }
}
