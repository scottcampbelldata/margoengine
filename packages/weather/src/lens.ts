/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { lattice, noiseWGSL } from './scene-patch.js';

/** Lens raindrop settings, read each frame. */
export interface LensDropsOptions {
  /** Amount of water on the lens, 0..1. Default 0.6. */
  wetness?: number;
  /** Optional wetness source, overriding wetness. Default none. */
  weather?: { readonly wetness: number };
  /** Drop radius as a fraction of image height, 0.002..0.06. Default 0.025. */
  radius?: number;
  /** Downward travel in image heights per second, 0..1. Default 0.08. */
  speed?: number;
  /** Refraction strength, 0..2. Default 0.7. */
  distortion?: number;
  /** Trail length in drop diameters, 0..1. Default 0.65. */
  streaks?: number;
  /** Integer seed, 0..16777215. Default 1. */
  seed?: number;
  /** Optional absolute pattern time for seeking, 0..1000000 seconds. Default accumulated frame time. */
  time?: number;
  /** False copies the input exactly before the usual output encoding. Default true. */
  enabled?: boolean;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function validate(o: LensDropsOptions): void {
  if (typeof o !== 'object' || o === null) throw new TypeError('LensDrops options must be an object; pass {} for defaults');
  for (const [key, lo, hi] of [
    ['wetness',0,1],['radius',0.002,0.06],['speed',0,1],['distortion',0,2],
    ['streaks',0,1],['seed',0,16777215],['time',0,1000000],
  ] as const) {
    const n = o[key];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi))
      throw new RangeError(`LensDrops ${key} must be finite in ${lo}..${hi}; pass a value in range`);
  }
  if (o.seed !== undefined && !Number.isInteger(o.seed)) throw new RangeError('LensDrops seed must be an integer; pass 0..16777215');
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw new TypeError('LensDrops enabled must be a boolean; pass true or false');
  if (o.weather !== undefined && (!o.weather || !Number.isFinite(o.weather.wetness) || o.weather.wetness < 0 || o.weather.wetness > 1))
    throw new RangeError('LensDrops weather.wetness must be finite in 0..1; pass a wetness source');
}

/** Droplet mask and refracting slope at height-normalised screen (x,y), for inspection and GPU parity. */
export function lensField(x: number, y: number, time: number, options: LensDropsOptions = {}): readonly [number, number, number] {
  validate(options);
  if (![x,y,time].every(Number.isFinite)) throw new RangeError('Lens field coordinates and time must be finite; pass screen coordinates and seconds');
  const wet = options.enabled === false ? 0 : options.weather?.wetness ?? options.wetness ?? 0.6;
  const radius = options.radius ?? 0.025, spacing = 6 * radius, seed = options.seed ?? 1;
  let nx = 0, ny = 0, mask = 0;
  for (let layer = 0; layer < 2; layer++) {
    const py = y - (layer ? time * (options.speed ?? 0.08) : 0), cx = Math.floor(x / spacing), cy = Math.floor(py / spacing);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const a = cx+i, b = cy+j, k = seed+layer*3;
      const activation = smooth(lattice(a,b,k),lattice(a,b,k)+0.12,wet);
      const r = radius * (0.55+0.45*lattice(a,b,k+1)) * (layer ? 1 : 0.55);
      const qx = (x-(a+0.2+0.6*lattice(a,b,k+2))*spacing)/r;
      const qy = (py-(b+0.2+0.6*lattice(a+17,b,k+2))*spacing)/r;
      const dome = Math.max(0,1-qx*qx-qy*qy), head = smooth(0,0.18,dome);
      const length = (options.streaks ?? 0.65)*4;
      const trail = layer && qy<0 && qy> -1-length ? (1-smooth(0.08,0.22,Math.abs(qx)))*smooth(-1-length,-0.8-length,qy) : 0;
      nx += (qx*Math.sqrt(dome)*head + qx*trail)*activation;
      ny += qy*Math.sqrt(dome)*head*activation;
      mask = Math.max(mask,Math.max(head,trail)*activation);
    }
  }
  return [nx,ny,mask];
}

/**
 * Packs the two settings vectors of {@link lensWGSL} for pattern time `time`. The falling layer's travel,
 * time * speed, is split in double precision into whole drop cells (u32 bits in b.w) and a remainder below one
 * cell (a.y, with a.w = 1), so the shader keeps full f32 precision at any time up to 1000000 seconds.
 */
export function lensSettings(options: LensDropsOptions, time: number, out: Float32Array = new Float32Array(8)): Float32Array {
  validate(options);
  if (!Number.isFinite(time) || time < 0) throw new RangeError('Lens time must be finite and nonnegative; pass seconds');
  const radius = options.radius ?? 0.025, spacing = 6 * radius, travel = time * (options.speed ?? 0.08);
  const cells = Math.floor(travel / spacing);
  out.set([options.enabled === false ? 0 : options.weather?.wetness ?? options.wetness ?? 0.6, travel - cells * spacing, radius, 1,
    options.distortion ?? 0.7, options.streaks ?? 0.65, options.seed ?? 1, 0]);
  new Uint32Array(out.buffer, out.byteOffset + 28, 1)[0] = cells >>> 0;
  return out;
}

/**
 * Pure field WGSL: lens_field(p, a, b) returns slope.xy and mask.z, with a = (wetness, time, radius, speed) and
 * b = (distortion, streaks, seed, whole cells of extra travel as u32 bits, 0 for none). Use {@link lensSettings}
 * for long or seeked times: a raw time * speed product loses f32 precision.
 */
export const lensWGSL: string = `${noiseWGSL}
fn lens_lattice(c:vec2f,shift:u32,layer:u32)->f32 {
  return f32(weather_pcg(weather_pcg(bitcast<u32>(i32(c.x)))^(bitcast<u32>(i32(c.y))-shift)^(layer*0x9e3779b9u))>>8u)*5.9604645e-8;
}
fn lens_field(p:vec2f,a:vec4f,b:vec4f)->vec3f {
 var result=vec3f(0);let spacing=6.0*a.z;
 for(var layer=0u;layer<2u;layer++){
  let q=p-vec2f(0,select(0.0,a.y*a.w,layer==1u));let cell=floor(q/spacing);let k=u32(b.z)+layer*3u;let n=select(0u,bitcast<u32>(b.w),layer==1u);
  for(var j=-1;j<=1;j++){for(var i=-1;i<=1;i++){
   let c=cell+vec2f(f32(i),f32(j));let random=lens_lattice(c,n,k);
   let activation=smoothstep(random,random+0.12,a.x);
   let r=a.z*(0.55+0.45*lens_lattice(c,n,k+1u))*select(0.55,1.0,layer==1u);
   // Reduce to the cell before forming the sub-cell centre to retain its low bits.
   let local=fma(-c,vec2f(spacing),q);
   let centre=(vec2f(0.2)+0.6*vec2f(lens_lattice(c,n,k+2u),lens_lattice(c+vec2f(17,0),n,k+2u)))*spacing;
   let v=(local-centre)/r;let dome=max(0.0,1.0-dot(v,v));let head=smoothstep(0.0,0.18,dome);let length=b.y*4.0;
   var trail=0.0;if(layer==1u&&v.y<0.0&&v.y> -1.0-length){trail=(1.0-smoothstep(0.08,0.22,abs(v.x)))*smoothstep(-1.0-length,-0.8-length,v.y);}
   result.x+=(v.x*sqrt(dome)*head+v.x*trail)*activation;result.y+=v.y*sqrt(dome)*head*activation;
   result.z=max(result.z,max(head,trail)*activation);
  }}
 }
 return result;
}`;

type Context = Extract<PassContext, { backend: 'webgpu' }>;
const shader = (hdr: boolean) => `${fullscreen}${displayShader}${lensWGSL}
@group(0) @binding(0) var<uniform> lens:array<vec4f,2>;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var filtering:sampler;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let dimensions=vec2f(textureDimensions(scene));let uv=at.xy/dimensions;
 var color=textureLoad(scene,vec2i(at.xy),0);
 let field=lens_field(at.xy/dimensions.y,lens[0],lens[1]);
 if(field.z>0.0){let offset=field.xy*lens[0].z*lens[1].x*vec2f(dimensions.y/dimensions.x,1);
  color=textureSampleLevel(scene,filtering,clamp(uv+offset,vec2f(0),vec2f(1)),0.0);
  color=vec4f(color.rgb*(1.0-0.08*field.z)+vec3f(max(0.0,-field.x-field.y)*0.08),color.a);
 }
 return vec4f(${hdr ? 'color.rgb' : 'toDisplay(color.rgb)'},color.a);
}`;

/**
 * Refracting drops and downward streaks as an HDR PostStack stage. Construct with
 * new LensDrops(options), then pass it to PostStack.attach(engine, [lens]).
 * No textures or simulation history are required; time and seed determine the pattern.
 * @throws TypeError/RangeError for invalid options; MargoError for standalone setup or disposed use.
 */
export class LensDrops implements EnginePlugin {
  /** Lazily creates an owned one-effect PostStack. Await attachment; abort cancels before registration. */
  static async attach(engine: EngineKernel, options: LensDropsOptions = {}, signal?: AbortSignal): Promise<LensDrops> {
    signal?.throwIfAborted();
    const { PostStack } = await import('@margoengine/post/stack');
    signal?.throwIfAborted();
    const lens = new LensDrops(options);
    try {
      lens.stack = PostStack.attach(engine, [lens]);
      return lens;
    } catch (error) {
      lens.dispose();
      throw error;
    }
  }
  private stack?: { dispose(): void };
  readonly name = 'weather-lens';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private stacked = false;
  private disposed = false;
  private clock = 0;
  private readonly values = new Float32Array(8);
  private readonly pipelines = new Map<string, GPURenderPipeline>();

  constructor(readonly options: LensDropsOptions = {}) { validate(options); }

  private joinStack(_host: StackHost): StackStage {
    if (this.stacked || this.disposed) throw new MargoError('attached', 'LensDrops is already used; create a new LensDrops');
    this.stacked = true;
    return {kind:'hdr',render:(c,input,output)=>this.draw(c,input,output)};
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'LensDrops is disposed; create a new LensDrops');
    if (!this.stacked) throw new MargoError('state', 'Add LensDrops to a PostStack before setup');
    if (!engine.gpu) throw new MargoError('unsupported', 'LensDrops requires WebGPU or its WebGL2 compatibility device');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({size:32,usage:64|8});
    this.sampler = engine.gpu.createSampler({minFilter:'linear',magFilter:'linear'});
  }

  onPreUpdate(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', 'LensDrops is disposed; create a new LensDrops');
    validate(this.options);
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('LensDrops delta must be finite and nonnegative; pass seconds');
    this.clock += delta;
  }

  private draw(c: Context, input: GPUTextureView, output: StageOutput): void {
    const o=this.options;
    validate(o);
    lensSettings(o,o.time??this.clock,this.values);
    c.device.queue.writeBuffer(this.uniform!,0,this.values);
    const key=output.format+':'+(output.multisample?.count??1)+':'+output.hdr;
    let pipeline=this.pipelines.get(key);
    if (!pipeline) {pipeline=render(c.device,shader(output.hdr),output.format,{multisample:output.multisample});this.pipelines.set(key,pipeline);}
    const bindings=group(c.device,pipeline,[{buffer:this.uniform!},input,this.sampler!]);
    const pass=c.encoder.beginRenderPass({colorAttachments:[{view:output.view,loadOp:viewLoadOp(c,'clear'),storeOp:'store'}]});
    try {pass.setPipeline(pipeline);pass.setBindGroup(0,bindings);applyView(pass,c);pass.draw(3);} finally {pass.end();}
  }

  onDeviceRestored(engine: Engine): void {
    this.uniform?.destroy();this.pipelines.clear();this.setup(engine);
  }

  dispose(): void {
    if(this.disposed)return;
    this.disposed=true;
    this.stack?.dispose();this.stack=undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.uniform?.destroy();this.uniform=undefined;this.sampler=undefined;this.pipelines.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
