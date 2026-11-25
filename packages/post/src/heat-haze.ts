/// <reference lib="esnext.disposable" preserve="true" />
// Heat haze, an HDR PostStack stage: the shimmer of what lies behind the hot plume over a fire. Light crossing air of
// varying density bends toward the denser air, so the scene behind a plume is seen displaced, and the turbulent eddies
// of the plume make the displacement ripple as they rise. Sources (papers and books, read as text; no code;
// docs/clean-room.md "Heat haze"):
// - J. H. Gladstone and T. P. Dale, "Researches on the refraction, dispersion, and sensitiveness of liquids",
//   Philosophical Transactions of the Royal Society 153, 317-343, 1863, https://doi.org/10.1098/rstl.1863.0014: the
//   refractivity of a gas is proportional to its density, n - 1 = K rho; for air and visible light K = 2.26e-4 m^3/kg
//   (W. Merzkirch, Flow Visualization, 2nd ed., Academic Press, 1987). With the ideal gas rho = p / (R T) the hot gas of
//   a plume is less refractive than the air around it: n - 1 falls as 1 / T.
// - G. S. Settles, Schlieren and Shadowgraph Techniques, Springer, 2001, https://doi.org/10.1007/978-3-642-56640-0: a
//   ray through a refractive field turns by the integral along it of the gradient of n across it, eps = (1/n0) integral
//   grad_perp n ds (the small-angle ray equation).
// - M. Raffel, "Background-oriented schlieren (BOS) techniques", Experiments in Fluids 56, 60, 2015,
//   https://doi.org/10.1007/s00348-015-1927-5: a ray bent by eps at distance t from the camera reaches a background at
//   distance tb displaced by eps (tb - t), so the camera sees the background shifted by the angle eps (1 - t / tb); a
//   surface in front of the hot gas (tb < t) is not shifted at all.
// - B. J. McCaffrey, "Purely Buoyant Diffusion Flames: Some Experimental Results", NBSIR 79-1910, National Bureau of
//   Standards, 1979, https://doi.org/10.6028/NBS.IR.79-1910: the mean centreline temperature rise of a fire over its
//   height z, 2 g dT / T0 = (kappa / 0.9)^2 (z / Q^(2/5))^(2 eta - 1) in three regions: the continuous flame (kappa 6.8,
//   eta 1/2, a constant rise of about 850 K), the intermittent flame (1.9, 0) and the plume above it (1.1, -1/3).
// - G. Heskestad, "Fire Plumes, Flame Height, and Air Entrainment", SFPE Handbook of Fire Protection Engineering, 5th
//   ed., 2016, and "Luminous heights of turbulent diffusion flames", Fire Safety Journal 5(2), 103-108, 1983: the flame
//   height L = 0.235 Q^(2/5) - 1.02 D (so z / Q^(2/5) is about 0.235 z / L), the virtual origin z0 = 0.083 Q^(2/5) -
//   1.02 D, and the plume's Gaussian temperature half-width b = 0.12 (Tc / T0)^(1/2) (z - z0).
// - W. K. George, R. L. Alpert and F. Tamanini, "Turbulence measurements in an axisymmetric buoyant plume",
//   International Journal of Heat and Mass Transfer 20(11), 1145-1154, 1977,
//   https://doi.org/10.1016/0017-9310(77)90123-9: the root-mean-square temperature fluctuation on a plume's axis is about
//   0.4 of its mean rise (the `turbulence` default).
// - G. I. Taylor, "The spectrum of turbulence", Proceedings of the Royal Society A 164, 476-490, 1938,
//   https://doi.org/10.1098/rspa.1938.0032: eddies are carried by the mean flow faster than they change (frozen
//   turbulence), so the fluctuation field is a fixed noise that rises with the plume, at the buoyant rise speed
//   0.5 sqrt(g L) of the flame's own tongues (J. G. Quintiere, "Scaling applications in fire research", Fire Safety
//   Journal 15(1), 3-29, 1989).
// Each pixel marches its view ray through the box of every plume, sums the bend of the mean field and of the eddies
// (an eddy of size l crossed by a step longer than l adds a random kick, so the eddies' part is weighted by
// sqrt(min(1, l / ds)) and their sum grows as the square root of the path, as a random walk does), weighs each bend by
// 1 - t / tb against the scene depth tb, and reads the scene where the bent ray lands. A landing on a surface nearer than
// the plume keeps the pixel's own colour (that surface is not behind the hot gas).
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayFor, displayShader, premultipliedCanvas } from '../../shared/display.js';
import { valueNoiseWgsl } from '../../shared/noise-wgsl.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Vec3 = readonly [number, number, number];

/** The Gladstone-Dale constant of air for visible light, m^3/kg (Merzkirch 1987): n - 1 = K rho. */
export const GLADSTONE_DALE_AIR = 2.26e-4;
/** The specific gas constant of dry air, J/(kg K). */
const R_AIR = 287.05;
/** Sea-level pressure, Pa. */
const PRESSURE = 101325;
const G = 9.80665;
/** Most plumes one frame draws: the longest flames are kept. */
export const HEAT_HAZE_MAX_PLUMES = 32;
/** The plume's box top over the flame length: the mean rise there is under 5% of the flame's. */
const TOP = 3;
/** The eddy size over the flame length (about the size of the flame's tongues, 0.22 L). */
const EDDY = 0.2;
/** Root-mean-square of the eddy noise before scaling (the noise is divided by it so its rms is 1). */
export const HEAT_HAZE_NOISE_RMS = 0.1402;

/**
 * The refractivity n - 1 of air at `kelvin` and `pressure` pascals (Gladstone and Dale 1863 with the ideal gas): about
 * 2.72e-4 at 20 C and sea level.
 * @throws RangeError for a temperature or pressure that is not a finite number above 0.
 */
export function airRefractivity(kelvin: number, pressure = PRESSURE): number {
  if (!(Number.isFinite(kelvin) && kelvin > 0) || !(Number.isFinite(pressure) && pressure > 0))
    throw new RangeError('airRefractivity needs a finite temperature (K) and pressure (Pa) above 0');
  return (GLADSTONE_DALE_AIR * pressure) / (R_AIR * kelvin);
}
/**
 * McCaffrey's (1979) mean centreline temperature rise, kelvin, at `height` metres over a fire whose mean flame length is
 * `length` metres, in air of `ambient` kelvin: the least of the continuous-flame, intermittent and plume laws at
 * z / Q^(2/5) = 0.235 height / length (Heskestad 1983), so the rise is about 850 K low in the flame and falls as
 * z^(-5/3) in the plume. 0 for a length of 0.
 */
export function plumeExcess(height: number, length: number, ambient = 293.15): number {
  if (!(length > 0)) return 0;
  const z = Math.max((0.235 * Math.max(height, 0)) / length, 1e-6),
    k = ambient / (2 * G) / 0.81;
  return Math.min(k * 6.8 * 6.8, (k * 1.9 * 1.9) / z, k * 1.1 * 1.1 * z ** (-5 / 3));
}

/** A hot plume over a fire, in world units (metres). `Flame` (`@margoengine/vfx/flame`) gives its own as `flame.plume`. */
export interface HeatPlume {
  /** Centre of the burning footprint at the ground. */
  readonly position: Vec3;
  /** Mean flame length, metres; 0 is no plume. */
  readonly length: number;
  /** Footprint `[x, z]` before `yaw`, metres. Default `[0.5 length, 0.5 length]`. */
  readonly footprint?: readonly [number, number];
  /** Turn of the footprint about +y, radians (its x side runs along `[cos yaw, 0, -sin yaw]`). Default 0. */
  readonly yaw?: number;
  /** The plume's lean in the wind, `[x, z]` world metres across per metre up. Default `[0, 0]`. */
  readonly lean?: readonly [number, number];
  /** The plume's clock, seconds: its eddies rise with it, so a seeked flame shimmers as a played one. Default the effect's own clock. */
  readonly time?: number;
}
/** A plume, or anything that carries one as `plume` (a `Flame`). */
export type HeatSource = HeatPlume | { readonly plume: HeatPlume };

/** Options of {@link HeatHaze}; the object is kept and read every frame. */
export interface HeatHazeOptions {
  /** The hot plumes: a list, or a function called every frame (`() => front.flameVolumes`). Default none. */
  sources?: readonly HeatSource[] | (() => Iterable<HeatSource>);
  /** The bend as a multiple of the physical, 0 to 100. Default 1: the refraction of real hot air, about a pixel at a telephoto's field of view and less at a wide one. */
  strength?: number;
  /** Root-mean-square temperature fluctuation over the mean rise, 0 to 1 (George et al. 1977). Default 0.4. */
  turbulence?: number;
  /** Temperature of the air around the plume, kelvin, 200 to 340. Default 293.15. */
  ambient?: number;
  /** Least march steps through each plume, a whole number 4 to 64; a ray where the plume is narrow takes more (two a half-width), up to 4 times as many. Default 24. */
  steps?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

const PLUME_FLOATS = 16;
const HEAD = 40;
// Shader notes (kept here so the shipped shader carries no comment text):
// fn excess and fn plume: The plume at local q (footprint axes, the lean taken out): x the mean change of n, y the eddies' change. McCaffrey's centreline rise at height h, and Heskestad's Gaussian half-width there.
// the march: At least two steps across the plume's narrowest half-width along the ray (it widens upward), up to 4 x steps.
// the draw: The shift is the difference of two projections, so no bend moves no pixel by any rounding.
const shader = (encode: boolean) => `${fullscreen}${encode ? displayShader : ''}
struct P {a:vec4f,b:vec4f,c:vec4f,d:vec4f}
struct U {view:mat4x4f,inverse:mat4x4f,look:vec4f,misc:vec4f,plumes:array<P,${HEAT_HAZE_MAX_PLUMES}>}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var bilinear:sampler;
${valueNoiseWgsl}
fn eddies(p:vec3f)->f32 {return (0.7*vnoise3(p)+0.3*vnoise3(p*2.03+vec3f(17.1,3.7,9.2))-0.5)/${HEAT_HAZE_NOISE_RMS};}
fn excess(k:P,h:f32)->f32 {
 let z=max(0.235*max(h,0.0)/k.a.w,1e-6);let c=u.look.w/(2.0*9.80665)/0.81;
 return min(c*46.24,min(c*3.61/z,c*1.21*pow(z,-5.0/3.0)));
}
fn width(k:P,h:f32,rise:f32)->f32 {return max(0.12*sqrt(1.0+rise/u.look.w)*(max(h,0.0)-k.c.z),k.d.z);}
fn field(k:P,q:vec3f)->vec2f {
 let L=k.a.w;let h=max(q.y,0.0);let T0=u.look.w;
 let rise=excess(k,h);
 let b=width(k,h,rise);
 let shrink=min(k.b.z,k.b.w)*min(h/(1.35*L),1.0);
 let e=max(abs(q.xz)-max(k.b.zw-shrink,vec2f(0.0)),vec2f(0.0));
 let f=exp(-dot(e,e)/(b*b))*smoothstep(-0.05*L,0.0,q.y)*(1.0-smoothstep(0.8*k.d.w,k.d.w,q.y));
 let dT=rise*f;let T=T0+dT;
 let n=-u.look.z*dT/T;
 let turb=-u.look.z*T0/(T*T)*u.look.y*dT*eddies((q-vec3f(0.0,k.d.x,0.0))/k.c.w);
 return vec2f(n,turb);
}
fn toLocal(k:P,v:vec3f)->vec3f {
 let r=vec3f(k.b.x*v.x-k.b.y*v.z,v.y,k.b.y*v.x+k.b.x*v.z);
 return vec3f(r.x-k.c.x*r.y,r.y,r.z-k.c.y*r.y);
}
fn toWorldGradient(k:P,g:vec3f)->vec3f {
 let v=vec3f(g.x,g.y-k.c.x*g.x-k.c.y*g.z,g.z);
 return vec3f(k.b.x*v.x+k.b.y*v.z,v.y,-k.b.y*v.x+k.b.x*v.z);
}
fn world(ndc:vec2f,d:f32)->vec3f {let p=u.inverse*vec4f(ndc,d,1.0);return p.xyz/p.w;}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let size=vec2f(textureDimensions(scene));let p=vec2i(at.xy);let now=textureLoad(scene,p,0);
 let ndc=at.xy/size*vec2f(2.0,-2.0)+vec2f(-1.0,1.0);
 let o=world(ndc,1.0);let dir=normalize(world(ndc,0.5)-o);
 let dz=textureLoad(depth,p,0);
 var tb=1e30;
 if(dz>0.0){tb=max(dot(world(ndc,dz)-o,dir),1e-4);}
 var bend=vec3f(0.0);var first=1e30;
 let count=i32(u.misc.x);let steps=u.misc.y;
 for(var j=0;j<count;j++){
  let k=u.plumes[j];
  let lo=toLocal(k,o-k.a.xyz);let ld=toLocal(k,dir);
  let lo3=vec3f(-k.b.z-k.d.y,0.0,-k.b.w-k.d.y);let hi3=vec3f(k.b.z+k.d.y,k.d.w,k.b.w+k.d.y);
  let inv=1.0/select(ld,vec3f(1e-12),abs(ld)<vec3f(1e-12));
  let ta=(lo3-lo)*inv;let tc=(hi3-lo)*inv;
  let t0=max(max(max(min(ta.x,tc.x),min(ta.y,tc.y)),min(ta.z,tc.z)),0.0);
  let t1=min(min(min(max(ta.x,tc.x),max(ta.y,tc.y)),max(ta.z,tc.z)),tb);
  if(t1<=t0){continue;}
  first=min(first,t0);
    let low=min(lo.y+ld.y*t0,lo.y+ld.y*t1);let narrow=width(k,low,excess(k,low));
  let n=min(max(steps,ceil((t1-t0)/(0.5*narrow))),4.0*steps);
  let ds=(t1-t0)/n;let ell=k.c.w;let hstep=min(ell,k.d.z)/4.0;let kick=sqrt(min(1.0,ell/ds));
  for(var i=0.0;i<n;i+=1.0){
   let t=t0+(i+0.5)*ds;let q=lo+ld*t;
   let ex=vec3f(hstep,0.0,0.0);let ey=vec3f(0.0,hstep,0.0);let ez=vec3f(0.0,0.0,hstep);
   let sx=field(k,q+ex)-field(k,q-ex);let sy=field(k,q+ey)-field(k,q-ey);let sz=field(k,q+ez)-field(k,q-ez);
   let gm=vec3f(sx.x,sy.x,sz.x)/(2.0*hstep);let gt=vec3f(sx.y,sy.y,sz.y)/(2.0*hstep);
   let g=toWorldGradient(k,gm+gt*kick);
   let w=select(1.0-t/tb,1.0,tb>=1e29);
   bend+=(g-dir*dot(dir,g))*ds*w;
  }
 }
 var rgb=now.rgb;
 if(first<1e29){
    let s=min(tb,1e6);let base=u.view*vec4f(o+dir*s,1.0);
  let clip=u.view*vec4f(o+dir*s+bend*u.look.x*s,1.0);
  let shift=(clip.xy/clip.w-base.xy/base.w)*vec2f(0.5,-0.5);
  if(clip.w>0.0&&base.w>0.0&&any(shift!=vec2f(0.0))){
   let uv=at.xy/size+shift;
   let q=clamp(vec2i(uv*size),vec2i(0),vec2i(size)-1);let dq=textureLoad(depth,q,0);
   let behind=dq<=0.0||dot(world(uv*vec2f(2.0,-2.0)+vec2f(-1.0,1.0),dq)-o,dir)>=first;
   if(behind&&all(uv>=vec2f(0.0))&&all(uv<=vec2f(1.0))){rgb=textureSampleLevel(scene,bilinear,uv,0.0).rgb;}
  }
 }
 return vec4f(${encode ? 'toDisplay(rgb)' : 'rgb'},now.a);
}`;

const plumeOf = (s: HeatSource): HeatPlume => ('plume' in s && s.plume ? s.plume : (s as HeatPlume));

/**
 * Heat haze in a PostStack (HDR effect): the scene behind the hot plumes of fires ripples as the plumes bend its light.
 * Feed it the flames (`[flame]`, or `() => front.flameVolumes` for a `FireFront`); each pixel's ray is bent by the
 * refraction of the hot air it crosses (Gladstone-Dale, McCaffrey's plume temperatures), and the eddies rise with the
 * plume. Put it first among the HDR effects (before Bloom and DOF) so the glow and focus see the bent scene.
 * ```ts
 * const flame = Flame.attach(engine, { position: [0, 0, 0], length: 4 });
 * PostStack.attach(engine, [new HeatHaze({ sources: [flame] }), new Tonemap()]);
 * ```
 * @throws TypeError when `sources` is not a list or function or `enabled` is not a boolean; RangeError for an option
 * or a plume out of range (checked now and every frame); MargoError `'state'` outside a PostStack, `'unsupported'`
 * without a GPU device, `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class HeatHaze implements EnginePlugin {
  readonly name = 'heat-haze';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private clock = 0;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private readonly values = new Float32Array(HEAD + HEAT_HAZE_MAX_PLUMES * PLUME_FLOATS);
  private readonly workspace = new Float64Array(52);
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly list: HeatPlume[] = [];
  private bindings?: GPUBindGroup;
  private bound: readonly unknown[] = [];

  constructor(readonly options: HeatHazeOptions = {}) {
    this.validate();
  }
  /** Attaches a new HeatHaze to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: HeatHazeOptions = {}): HeatHaze {
    const effect = new HeatHaze(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Seconds on the effect's own clock (the sum of its frame deltas), used by plumes without a `time`. */
  get time(): number {
    return this.clock;
  }
  /** Back to time 0 and a fresh one's state, history dropped (GAP-FILM-RESET; `resetClocks` in `@margoengine/cutscene/seek`). */
  resetTime(): void {
    this.clock = 0;
  }
  /**
   * Moves the effect's clock by `delta` seconds (the CPU part of its frame update, which runs it), so
   * `@margoengine/cutscene/seek` replays it and a haze seeked to film time T ripples as a played one does at T
   * (GAP-FILM-TIME). A draw moves no clock: hidden or disabled haze keeps time, and two views in a frame move it once.
   */
  advanceTime(delta: number): void {
    if (this.disposed) return;
    this.clock += delta > 0 ? delta : 0;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  private validate(): void {
    const o = this.options,
      within = (v: number | undefined, lo: number, hi: number) => v === undefined || (v >= lo && v <= hi);
    if (o.sources !== undefined && typeof o.sources !== 'function' && !Array.isArray(o.sources))
      throw new TypeError('HeatHaze sources must be a list of plumes or flames, or a function returning them');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('HeatHaze enabled must be a boolean; pass true or false');
    if (!within(o.strength, 0, 100) || !within(o.turbulence, 0, 1) || !within(o.ambient, 200, 340))
      throw new RangeError('Invalid HeatHaze options; strength 0 to 100, turbulence 0 to 1, ambient 200 to 340 K');
    if (o.steps !== undefined && !(Number.isInteger(o.steps) && o.steps >= 4 && o.steps <= 64))
      throw new RangeError('HeatHaze steps must be a whole number from 4 to 64');
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw new MargoError('attached', 'HeatHaze is already attached; create a new HeatHaze');
    this.stacked = true;
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'HeatHaze is disposed; create a new HeatHaze');
    if (!this.stacked)
      throw new MargoError(
        'state',
        'HeatHaze runs inside a PostStack; use HeatHaze.attach(engine) or add it to a PostStack',
      );
    if (!engine.gpu)
      throw new MargoError('unsupported', 'HeatHaze requires a GPU device (WebGPU or the WebGL2 compatibility layer)');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
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
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** The plumes this frame draws: valid, lit (length above 0), the longest {@link HEAT_HAZE_MAX_PLUMES}. */
  private gather(): HeatPlume[] {
    const o = this.options,
      list = this.list;
    list.length = 0;
    const sources = typeof o.sources === 'function' ? o.sources() : (o.sources ?? []);
    for (const source of sources) {
      const p = plumeOf(source);
      if (
        !p ||
        typeof p !== 'object' ||
        !Array.isArray(p.position) ||
        p.position.length !== 3 ||
        !p.position.every(Number.isFinite)
      )
        throw new TypeError('A HeatHaze plume needs a position [x, y, z]; pass a Flame or a HeatPlume');
      const fp = p.footprint ?? [0.5 * p.length, 0.5 * p.length];
      if (
        !(Number.isFinite(p.length) && p.length >= 0) ||
        !(fp[0] >= 0 && fp[1] >= 0 && Number.isFinite(fp[0] + fp[1]))
      )
        throw new RangeError('A HeatHaze plume needs a finite length and footprint of 0 or more metres');
      if (!Number.isFinite(p.yaw ?? 0) || !(p.lean ?? [0, 0]).every(Number.isFinite) || !Number.isFinite(p.time ?? 0))
        throw new RangeError('A HeatHaze plume needs a finite yaw, lean and time');
      if (p.length > 0) list.push(p);
    }
    if (list.length > HEAT_HAZE_MAX_PLUMES) list.sort((a, b) => b.length - a.length).length = HEAT_HAZE_MAX_PLUMES;
    return list;
  }
  private draw(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const o = this.options,
      device = c.device,
      v = this.values,
      m = c.camera.matrix,
      ambient = o.ambient ?? 293.15,
      plumes = (o.enabled ?? true) ? this.gather() : [];
    v.set(m);
    if (!invertMatrixStable(m, v.subarray(16, 32), this.workspace))
      throw new MargoError('state', 'Invalid HeatHaze camera; give the camera a finite, invertible projection');
    v.set([o.strength ?? 1, o.turbulence ?? 0.4, airRefractivity(ambient), ambient], 32);
    v.set([plumes.length, o.steps ?? 24, 0, 0], 36);
    plumes.forEach((p, i) => writePlume(p, ambient, this.clock, v, HEAD + i * PLUME_FLOATS));
    device.queue.writeBuffer(this.uniform!, 0, v, 0, HEAD + plumes.length * PLUME_FLOATS);
    const key = `${output.format}:${output.multisample?.count ?? 1}:${+output.hdr}:${premultipliedCanvas(this.engine)}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(device, displayFor(this.engine, shader(!output.hdr)), output.format, {
        multisample: output.multisample,
      });
      this.pipelines.set(key, pipeline);
    }
    const depth = this.host!.depthTexture!,
      parts = [pipeline, input, depth];
    if (parts.some((part, i) => part !== this.bound[i])) {
      this.bound = parts;
      this.bindings = group(device, pipeline, [
        { buffer: this.uniform! },
        input,
        depth.createView({ aspect: 'depth-only' }),
        this.sampler!,
      ]);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindings!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.bindings = this.sampler = undefined;
    this.pipelines.clear();
    this.bound = [];
  }
}

/**
 * The plume's shader record: a (base, length), b (cos yaw, sin yaw, half footprint), c (lean in the footprint's axes,
 * virtual origin z0, eddy size), d (how far the eddies have risen, the box's margin past the footprint, the least
 * half-width, the box top).
 */
function writePlume(p: HeatPlume, ambient: number, clock: number, out: Float32Array, at: number): void {
  const L = p.length,
    fp = p.footprint ?? [0.5 * L, 0.5 * L],
    yaw = p.yaw ?? 0,
    c = Math.cos(yaw),
    s = Math.sin(yaw),
    [lx, lz] = p.lean ?? [0, 0],
    // Heskestad's source diameter: the circle of the footprint's area, never more than twice its narrower side.
    D = Math.max(Math.min(Math.sqrt((4 * fp[0] * fp[1]) / Math.PI), 2 * Math.min(fp[0], fp[1])), 0.05),
    q25 = (L + 1.02 * D) / 0.235,
    z0 = 0.083 * q25 - 1.02 * D,
    top = TOP * L,
    least = 0.05 * L + 0.01,
    widest = Math.max(0.12 * Math.sqrt(1 + plumeExcess(top, L, ambient) / ambient) * (top - z0), least),
    rise = 0.5 * Math.sqrt(G * L);
  out.set(
    [
      p.position[0],
      p.position[1],
      p.position[2],
      L,
      c,
      s,
      fp[0] / 2,
      fp[1] / 2,
      c * lx - s * lz,
      s * lx + c * lz,
      z0,
      EDDY * L,
      rise * (p.time ?? clock),
      2.5 * widest,
      least,
      top,
    ],
    at,
  );
}

/**
 * The bend, radians, of a ray through the mean (eddy-free) refractive field of one plume, as the shader marches it: the
 * world vector sum of grad_perp n ds along `origin + t dir` (dir of length 1) up to `background` metres (Infinity for
 * the sky), each weighed by 1 - t / background. The same march, steps and finite differences as the GPU pass; for tests
 * and tools.
 */
export function plumeBend(
  plume: HeatPlume,
  origin: Vec3,
  dir: Vec3,
  options: { ambient?: number; steps?: number; background?: number } = {},
): [number, number, number] {
  const v = new Float32Array(PLUME_FLOATS),
    T0 = options.ambient ?? 293.15,
    na = airRefractivity(T0),
    steps = options.steps ?? 24,
    tb = options.background ?? Infinity;
  writePlume(plume, T0, 0, v, 0);
  const [bx, by, bz, L, c, s, hx, hz, lx, lz, z0, ell, , margin, least, top] = Array.from(v, (x) => x) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const local = (x: number, y: number, z: number): [number, number, number] => {
    const rx = c * x - s * z,
      rz = s * x + c * z;
    return [rx - lx * y, y, rz - lz * y];
  };
  const width = (h: number, rise: number) => Math.max(0.12 * Math.sqrt(1 + rise / T0) * (Math.max(h, 0) - z0), least);
  const field = (q: number[]) => {
    const h = Math.max(q[1]!, 0),
      rise = plumeExcess(h, L, T0),
      b = width(h, rise),
      shrink = Math.min(hx, hz) * Math.min(h / (1.35 * L), 1),
      ex = Math.max(Math.abs(q[0]!) - Math.max(hx - shrink, 0), 0),
      ez = Math.max(Math.abs(q[2]!) - Math.max(hz - shrink, 0), 0),
      smooth = (a: number, e: number, x: number) => {
        const t = Math.min(Math.max((x - a) / (e - a), 0), 1);
        return t * t * (3 - 2 * t);
      },
      f = Math.exp(-(ex * ex + ez * ez) / (b * b)) * smooth(-0.05 * L, 0, q[1]!) * (1 - smooth(0.8 * top, top, q[1]!));
    return (-na * rise * f) / (T0 + rise * f);
  };
  const lo = local(origin[0] - bx, origin[1] - by, origin[2] - bz),
    ld = local(dir[0], dir[1], dir[2]),
    min = [-hx - margin, 0, -hz - margin],
    max = [hx + margin, top, hz + margin];
  let t0 = 0,
    t1 = tb;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / (Math.abs(ld[a]!) < 1e-12 ? 1e-12 : ld[a]!),
      ta = (min[a]! - lo[a]!) * inv,
      tc = (max[a]! - lo[a]!) * inv;
    t0 = Math.max(t0, Math.min(ta, tc));
    t1 = Math.min(t1, Math.max(ta, tc));
  }
  const bend: [number, number, number] = [0, 0, 0];
  if (!(t1 > t0)) return bend;
  const low = Math.min(lo[1] + ld[1] * t0, lo[1] + ld[1] * t1),
    narrow = width(low, plumeExcess(low, L, T0)),
    n = Math.min(Math.max(steps, Math.ceil((t1 - t0) / (0.5 * narrow))), 4 * steps),
    ds = (t1 - t0) / n,
    e = Math.min(ell, least) / 4;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i + 0.5) * ds,
      q = [lo[0] + ld[0] * t, lo[1] + ld[1] * t, lo[2] + ld[2] * t],
      gl = [0, 1, 2].map(
        (a) =>
          (field(q.map((x, j) => (j === a ? x + e : x))) - field(q.map((x, j) => (j === a ? x - e : x)))) / (2 * e),
      ),
      vy = gl[1]! - lx * gl[0]! - lz * gl[2]!,
      g = [c * gl[0]! + s * gl[2]!, vy, -s * gl[0]! + c * gl[2]!],
      dot = g[0]! * dir[0] + g[1]! * dir[1] + g[2]! * dir[2],
      w = Number.isFinite(tb) ? 1 - t / tb : 1;
    for (let a = 0; a < 3; a++) bend[a] += (g[a]! - dir[a] * dot) * ds * w;
  }
  return bend;
}

/** The eddy noise of the shader on the CPU (two octaves of value noise, scaled to unit root-mean-square); for tests. */
export function heatHazeNoise(x: number, y: number, z: number): number {
  return (
    (0.7 * vnoise3(x, y, z) + 0.3 * vnoise3(x * 2.03 + 17.1, y * 2.03 + 3.7, z * 2.03 + 9.2) - 0.5) /
    HEAT_HAZE_NOISE_RMS
  );
}
const hash1 = (n: number): number => {
  let x = (Math.imul(n >>> 0, 747796405) + 2891336453) >>> 0;
  x = Math.imul(((x >>> ((x >>> 28) + 4)) ^ x) >>> 0, 277803737) >>> 0;
  x = ((x >>> 22) ^ x) >>> 0;
  return x / 4294967295;
};
const hash3 = (x: number, y: number, z: number) =>
  hash1((Math.imul(x >>> 0, 73856093) ^ Math.imul(y >>> 0, 19349663) ^ Math.imul(z >>> 0, 83492791)) >>> 0);
function vnoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z),
    s = (f: number) => f * f * (3 - 2 * f),
    sx = s(x - ix),
    sy = s(y - iy),
    sz = s(z - iz),
    l = (a: number, b: number, t: number) => a + (b - a) * t,
    layer = (k: number) =>
      l(l(hash3(ix, iy, k), hash3(ix + 1, iy, k), sx), l(hash3(ix, iy + 1, k), hash3(ix + 1, iy + 1, k), sx), sy);
  return l(layer(iz), layer(iz + 1), sz);
}
