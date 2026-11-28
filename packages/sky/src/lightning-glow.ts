// The light a lightning channel scatters in fog, rain and haze toward the camera: the glow around a bolt.
//
// Method (clean room, from the papers):
// - Single scattering in a uniform medium along the view ray, the airlight integral of B. Sun, R. Ramamoorthi,
//   S. G. Narasimhan and S. K. Nayar, "A practical analytic single scattering model for real-time rendering", ACM
//   Trans. Graphics 24(3) (SIGGRAPH 2005) 1040-1049, https://doi.org/10.1145/1073204.1073309, here with line sources in
//   place of point sources. Lightning seen through atmospheric particles was first rendered this way by Y. Dobashi,
//   T. Yamamoto and T. Nishita, "Efficient rendering of lightning taking into account scattering effects due to clouds
//   and atmospheric particles", Proc. Pacific Graphics 2001, https://doi.org/10.1109/PCCGA.2001.962896.
// - Along each straight piece of channel, the inverse square integral is exact (the difference of two arctangents), and
//   the extinction and phase are taken at points of equal angle: equiangular sampling, C. Kulla and M. Fajardo,
//   "Importance sampling techniques for path tracing in participating media", Computer Graphics Forum 31(4) (2012)
//   1519-1528, https://doi.org/10.1111/j.1467-8659.2012.03148.x. The angles are split where the phase peaks, with three
//   Gauss-Legendre points on each side.
// - Along the view ray, t = t0 + h sinh(q) about the closest approach (t0, h) spreads a 1 / distance integrand evenly
//   in q; six Gauss-Legendre points on each side of the closest approach.
// - The phase function of L. G. Henyey and J. L. Greenstein, "Diffuse radiation in the galaxy", Astrophys. J. 93
//   (1941) 70-83, https://doi.org/10.1086/144246; extinction from the meteorological visibility, 3.912 / V (H.
//   Koschmieder, "Theorie der horizontalen Sichtweite", Beitr. Phys. freien Atmos. 12 (1924) 33-53, 171-181).
/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from '@margoengine/math';
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { applyView } from '../../shared/view-rect.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { depthWGSL, sceneDepth } from './depth.js';
import { CHANNEL_STRIDE, MAX_BOLTS, strokeLevel, type LightningBolt, type LightningChannel } from './lightning-bolt.js';
import { LIGHTNING_COLOR, type LightningStrike } from './weather.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Most straight pieces one channel's glow is worked out from. */
export const MAX_GLOW_PIECES = 64;

/** The uniform air between the camera and the channel. */
export interface LightningGlowMedium {
  /** Meteorological visibility, metres, 20 to 300,000: how far a dark object can be seen. Default 3,000 (rain). */
  visibility?: number;
  /** Share of the light a droplet takes out of a beam that it scatters instead of absorbing, 0 to 1. Default 1. */
  albedo?: number;
  /** Henyey-Greenstein anisotropy, -0.85 to 0.85: positive sends light on forward, as droplets do. Default 0.7. */
  anisotropy?: number;
}

/** {@link LightningGlow} settings, read every frame from `glow.options`. */
export interface LightningGlowOptions extends LightningGlowMedium {
  /** The bolt whose channels glow: its weather's live strikes, with its radiance and `bolt.width`. */
  bolt: LightningBolt;
  /** The scene's reversed-Z depth each frame (for example `bloom.depthTexture`); nothing is drawn while it is undefined. */
  depth: () => GPUTexture | undefined;
  /** Scales the scattered light, 0 to 1,000; 1 (the default) is what the channel's own radiance and width give. */
  strength?: number;
  /** Straight pieces the main channel is cut into, 1 to {@link MAX_GLOW_PIECES}. Default 24. */
  pieces?: number;
}

const DEFAULTS = { visibility: 3000, albedo: 1, anisotropy: 0.7, strength: 1, pieces: 24 };

function range(value: number, low: number, high: number, name: string): number {
  if (typeof value !== 'number' || !(value >= low && value <= high))
    throw new MargoError('state', `Set LightningGlow ${name} to a value from ${low} to ${high}.`);
  return value;
}

/**
 * The extinction coefficient, per metre, of air with a meteorological visibility of `visibility` metres: 3.912 / V
 * (Koschmieder 1924, the distance at which a black object's contrast falls to 2 percent).
 * @throws MargoError `state` for a visibility outside 20 to 300,000.
 */
export function visibilityExtinction(visibility: number): number {
  return 3.912 / range(visibility, 20, 300000, 'visibility');
}

/**
 * The main channel of `channel` cut into `count` straight pieces of equal path length, in the layout of
 * {@link LightningChannel.segments}: start xyz, then the piece's path length over its chord length (the light a crooked
 * stretch gives off, carried by its chord), end xyz, 0. Forks are left out.
 * @throws MargoError `state` for a count that is not a whole number from 1 to 64.
 */
export function lightningGlowPieces(channel: LightningChannel, count: number = DEFAULTS.pieces): Float32Array {
  if (!Number.isInteger(count) || count < 1 || count > MAX_GLOW_PIECES)
    throw new MargoError('state', `Set LightningGlow pieces to a whole number from 1 to ${MAX_GLOW_PIECES}.`);
  const s = channel.segments,
    lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < channel.trunk; i++) {
    const o = i * CHANNEL_STRIDE,
      l = Math.hypot(s[o + 4]! - s[o]!, s[o + 5]! - s[o + 1]!, s[o + 6]! - s[o + 2]!);
    lengths.push(l);
    total += l;
  }
  const out = new Float32Array(count * CHANNEL_STRIDE);
  let segment = 0,
    walked = 0,
    from = [s[0]!, s[1]!, s[2]!];
  for (let k = 0; k < count; k++) {
    const target = k === count - 1 ? total : ((k + 1) * total) / count;
    while (segment < channel.trunk - 1 && walked + lengths[segment]! < target) walked += lengths[segment++]!;
    const o = segment * CHANNEL_STRIDE,
      f = lengths[segment]! > 0 ? Math.min(1, Math.max(0, (target - walked) / lengths[segment]!)) : 1,
      // The last piece ends on the channel's end itself, not on a rounded point beside it.
      to = [0, 1, 2].map((i) => (k === count - 1 ? s[o + 4 + i]! : s[o + i]! + (s[o + 4 + i]! - s[o + i]!) * f)),
      chord = Math.hypot(to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!);
    // A piece that comes back on itself has no chord; it stays a dot and gives no light.
    out.set([from[0]!, from[1]!, from[2]!, chord > 1e-3 ? total / count / chord : 0], k * CHANNEL_STRIDE);
    out.set(to, k * CHANNEL_STRIDE + 4);
    from = to;
  }
  return out;
}

// Gauss-Legendre points and weights on 0..1.
const RAY_RULE: readonly (readonly [number, number])[] = [
  [0.033765242898424, 0.085662246189585],
  [0.169395306766868, 0.180380786524069],
  [0.380690406958402, 0.233956967286346],
  [0.619309593041598, 0.233956967286346],
  [0.830604693233132, 0.180380786524069],
  [0.966234757101576, 0.085662246189585],
];
const SOURCE_RULE: readonly (readonly [number, number])[] = [
  [0.112701665379258, 0.277777777777778],
  [0.5, 0.444444444444444],
  [0.887298334620742, 0.277777777777778],
];
// Beyond this many mean free paths past the closest approach, the air in between has taken the light out.
const REACH = 8;

/** A view ray for {@link lightningGlowRadiance}. */
export interface LightningGlowRay {
  /** Where the ray starts, world metres. */
  origin: Vec3;
  /** The way it looks; any length above 0. */
  direction: Vec3;
  /** Metres to the surface it ends on. Default: none (the sky). */
  distance?: number;
}

/**
 * The radiance a view ray gathers from straight channel pieces ({@link lightningGlowPieces}) scattered once in the
 * medium: what {@link LightningGlow} draws at a pixel, worked out on the CPU, per unit of `intensity`, the light a metre
 * of channel gives off each way (its radiance times its width). `radius` is the channel's half width in metres: no point
 * counts as nearer to the channel than that. Against a fine numerical integral over 60 seeded rays and pieces at
 * anisotropy up to 0.7 the median error is under 1 percent (`test/lightning-glow.test.js`).
 * @throws MargoError `state` for an invalid ray, medium, intensity or radius.
 */
export function lightningGlowRadiance(
  ray: LightningGlowRay,
  pieces: ArrayLike<number>,
  intensity: number,
  medium: LightningGlowMedium = {},
  radius = 0.75,
): number {
  const { origin, direction, distance = Infinity } = ray,
    length = Math.hypot(...direction);
  if (origin.length !== 3 || direction.length !== 3 || !(length > 0) || !origin.every(Number.isFinite))
    throw new MargoError('state', 'Give the glow ray a finite origin and a nonzero direction of three numbers.');
  if (!(distance >= 0)) throw new MargoError('state', 'Give the glow ray a distance of 0 or more metres.');
  if (!(intensity >= 0 && Number.isFinite(intensity)))
    throw new MargoError('state', 'Give the glow a finite channel intensity of 0 or more.');
  if (!(radius > 0 && Number.isFinite(radius)))
    throw new MargoError('state', 'Give the glow a finite channel radius above 0 metres.');
  const sigma = visibilityExtinction(medium.visibility ?? DEFAULTS.visibility),
    albedo = range(medium.albedo ?? DEFAULTS.albedo, 0, 1, 'albedo'),
    g = range(medium.anisotropy ?? DEFAULTS.anisotropy, -0.85, 0.85, 'anisotropy'),
    v = direction.map((x) => x / length);
  let radiance = 0;
  for (let o = 0; o + CHANNEL_STRIDE <= pieces.length; o += CHANNEL_STRIDE) {
    const a = [pieces[o]!, pieces[o + 1]!, pieces[o + 2]!],
      ab = [pieces[o + 4]! - a[0]!, pieces[o + 5]! - a[1]!, pieces[o + 6]! - a[2]!],
      L = Math.hypot(ab[0]!, ab[1]!, ab[2]!),
      stretch = pieces[o + 3]!;
    if (!(L > 1e-3) || !stretch) continue;
    const u = ab.map((x) => x / L),
      w = [0, 1, 2].map((i) => origin[i]! - a[i]!),
      dot = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!,
      vu = dot(v, u),
      k2 = 1 - vu * vu,
      // The point of the piece nearest the ray's line, and the ray point nearest it.
      along = Math.min(L, Math.max(0, k2 > 1e-5 ? (dot(u, w) - vu * dot(v, w)) / k2 : L / 2)),
      toPoint = [0, 1, 2].map((i) => u[i]! * along - w[i]!),
      t0 = dot(toPoint, v),
      h = Math.max(radius, Math.hypot(...[0, 1, 2].map((i) => toPoint[i]! - v[i]! * t0))),
      end = Math.min(distance, Math.max(t0, 0) + REACH / sigma),
      low = Math.asinh(-t0 / h),
      high = Math.asinh((end - t0) / h),
      mid = Math.min(high, Math.max(low, 0));
    if (!(end > 0)) continue;
    let sum = 0;
    for (const [q0, q1] of [
      [low, mid],
      [mid, high],
    ] as const)
      for (const [x, weight] of RAY_RULE) {
        const q = q0 + (q1 - q0) * x,
          t = t0 + h * Math.sinh(q),
          step = h * Math.cosh(q) * (q1 - q0) * weight,
          r = [0, 1, 2].map((i) => w[i]! + v[i]! * t),
          s = dot(r, u),
          across = r.map((value, i) => value - u[i]! * s),
          gap = Math.hypot(...across),
          d = Math.max(radius, gap),
          // The angle the piece fills as seen from the ray point, without the cancellation of two arctangents.
          angle = Math.atan2(L * d, d * d - s * (L - s)),
          start = Math.atan2(-s, d),
          peak = Math.atan2(vu, -dot(across, v) / Math.max(gap, 1e-6)),
          cut = Math.min(start + angle, Math.max(start, peak));
        let source = 0;
        for (const [f0, f1] of [
          [start, cut],
          [cut, start + angle],
        ] as const)
          for (const [y, share] of SOURCE_RULE) {
            const at = Math.min(L, Math.max(0, s + d * Math.tan(f0 + (f1 - f0) * y))),
              to = r.map((value, i) => u[i]! * at - value),
              far = Math.max(radius, Math.hypot(to[0]!, to[1]!, to[2]!)),
              cos = dot(to, v) / far,
              phase = (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * cos) ** 1.5);
            source += (f1 - f0) * share * Math.exp(-sigma * far) * phase;
          }
        sum += (step * Math.exp(-sigma * t) * source) / d;
      }
    radiance += sum * stretch;
  }
  return radiance * intensity * albedo * sigma;
}

const rule = (name: string, points: readonly (readonly [number, number])[]) =>
  `const ${name}=array<vec2f,${points.length}>(${points.map(([x, w]) => `vec2f(${x},${w})`).join(',')});`;

// The shader is lightningGlowRadiance above, line for line, with the pieces and the ray relative to the camera.
const shader = (depth: string) => /* wgsl */ `${fullscreen}${displayShader}
struct Glow { inverse:mat4x4f, eye:vec4f, color:vec4f, medium:vec4f }
@group(0) @binding(0) var<uniform> glow:Glow;
@group(0) @binding(1) var<storage,read> pieces:array<vec4f>;
${depth}
${rule('RAY', RAY_RULE)}
${rule('SOURCE', SOURCE_RULE)}
fn piece(index:u32,origin:vec3f,v:vec3f,reach:f32)->f32 {
 let head=pieces[index*2u];let tail=pieces[index*2u+1u];
 let a=head.xyz;let ab=tail.xyz-a;let L=length(ab);
 if(!(L>0.001)){return 0.0;}
 let sigma=glow.medium.x;let g=glow.medium.y;let radius=glow.medium.z;
 let u=ab/L;let w=origin-a;let vu=dot(v,u);let k2=1.0-vu*vu;
 var along=L*0.5;if(k2>0.00001){along=(dot(u,w)-vu*dot(v,w))/k2;}
 along=clamp(along,0.0,L);
 let toPoint=u*along-w;let t0=dot(toPoint,v);let h=max(radius,length(toPoint-v*t0));
 let end=min(reach,max(t0,0.0)+${REACH}.0/sigma);
 if(!(end>0.0)){return 0.0;}
 let low=asinh(-t0/h);let high=asinh((end-t0)/h);let mid=clamp(0.0,low,high);
 var sum=0.0;
 for(var half=0u;half<2u;half++){
  let q0=select(low,mid,half==1u);let q1=select(mid,high,half==1u);
  for(var i=0u;i<${RAY_RULE.length}u;i++){
   let q=q0+(q1-q0)*RAY[i].x;let t=t0+h*sinh(q);let step=h*cosh(q)*(q1-q0)*RAY[i].y;
   let r=w+v*t;let s=dot(r,u);let across=r-u*s;let gap=length(across);let d=max(radius,gap);
   let angle=atan2(L*d,d*d-s*(L-s));let start=atan2(-s,d);
   let peak=atan2(vu,-dot(across,v)/max(gap,0.000001));let cut=clamp(peak,start,start+angle);
   var source=0.0;
   for(var side=0u;side<2u;side++){
    let f0=select(start,cut,side==1u);let f1=select(cut,start+angle,side==1u);
    for(var j=0u;j<${SOURCE_RULE.length}u;j++){
     let at=clamp(s+d*tan(f0+(f1-f0)*SOURCE[j].x),0.0,L);
     let to=u*at-r;let far=max(radius,length(to));let c=dot(to,v)/far;
     let base=1.0+g*g-2.0*g*c;
     source+=(f1-f0)*SOURCE[j].y*exp(-sigma*far)*(1.0-g*g)/(12.566370614359172*base*sqrt(base));
    }
   }
   sum+=step*exp(-sigma*t)*source/d;
  }
 }
 return sum;
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let ndc=vec2f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0);
 let pn=glow.inverse*vec4f(ndc,1.0,1.0);let pf=glow.inverse*vec4f(ndc,0.000001,1.0);
 let origin=pn.xyz/pn.w;let v=normalize(pf.xyz/pf.w-origin);
 let z=sceneDepthAt(vec2i(i.position.xy));
 var reach=1e9;if(z>0.0){let s=glow.inverse*vec4f(ndc,z,1.0);reach=length(s.xyz/s.w-origin);}
 var light=0.0;
 for(var k=0u;k<u32(glow.eye.w);k++){
  // Each piece's light per metre, level and all, rides in its second row.
  let amount=pieces[k*2u].w*pieces[k*2u+1u].w;
  if(amount>0.0){light+=amount*piece(k,origin-glow.eye.xyz,v,reach);}
 }
 var color=light*glow.medium.w*glow.color.rgb;
 if(glow.color.w>0.5){color=toDisplay(color);}
 return vec4f(color,0.0);
}`;

/**
 * Draws the glow a lightning channel throws into the fog, rain and haze around it: at every pixel, the light of each of
 * the bolt's live strikes scattered once, between the camera and the surface there, by uniform air of a given visibility
 * ({@link lightningGlowRadiance}). Hills and walls cut it where they stand in front. The source is the channel the
 * {@link LightningBolt} draws, at its radiance, width, `bolt.scale` and flicker, so one set of settings drives both; set
 * `lightning.bolt.glow` to 0 to leave out the bolt's fixed-width glow. Add it with
 * `LightningGlow.attach(engine, {bolt, depth: () => bloom.depthTexture})`.
 * @throws MargoError `state` for invalid options or a bolt that draws a physical `field`; `unsupported` on a WebGL
 * engine; `disposed` after `dispose()`.
 */
export class LightningGlow implements EnginePlugin {
  readonly name = 'sky:lightning-glow';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private storage?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private bound?: GPUTexture | GPUTextureView;
  private key = '';
  private disposed = false;
  private readonly values = new Float32Array(28);
  private readonly rows = new Float32Array(MAX_BOLTS * MAX_GLOW_PIECES * CHANNEL_STRIDE);
  private readonly cache = new WeakMap<
    LightningChannel,
    { count: number; segments: Float32Array; pieces: Float32Array }
  >();
  private readonly scratch = new Float64Array(52);

  constructor(readonly options: LightningGlowOptions) {
    this.validate();
  }

  static attach(engine: EngineKernel, options: LightningGlowOptions): LightningGlow {
    const glow = new LightningGlow(options);
    engineRuntime(engine).use(glow);
    return glow;
  }

  private validate(): Required<Omit<LightningGlowOptions, 'bolt' | 'depth'>> {
    const o = this.options;
    if (typeof o !== 'object' || o === null || typeof o.bolt?.channelOf !== 'function')
      throw new MargoError('state', 'Attach LightningGlow with a LightningBolt in the bolt option.');
    if (o.bolt.options.field)
      throw new MargoError('state', 'LightningGlow follows weather strikes; attach it to a bolt without a field.');
    if (typeof o.depth !== 'function')
      throw new MargoError('state', 'Give LightningGlow a depth function returning the scene depth texture.');
    const pieces = o.pieces ?? DEFAULTS.pieces;
    if (!Number.isInteger(pieces) || pieces < 1 || pieces > MAX_GLOW_PIECES)
      throw new MargoError('state', `Set LightningGlow pieces to a whole number from 1 to ${MAX_GLOW_PIECES}.`);
    return {
      visibility: range(o.visibility ?? DEFAULTS.visibility, 20, 300000, 'visibility'),
      albedo: range(o.albedo ?? DEFAULTS.albedo, 0, 1, 'albedo'),
      anisotropy: range(o.anisotropy ?? DEFAULTS.anisotropy, -0.85, 0.85, 'anisotropy'),
      strength: range(o.strength ?? DEFAULTS.strength, 0, 1000, 'strength'),
      pieces,
    };
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'LightningGlow requires WebGPU; attach a new LightningGlow to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.storage = engine.gpu.createBuffer({
      size: this.rows.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    // Just under the bolt (6.55), so the channel's core lies over its own glow.
    graph.add({
      name: 'sky:lightning-glow',
      order: 6.54,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  /** The strikes alight now and how bright each channel is, 0 to 1. */
  private live(): { strike: LightningStrike; level: number }[] {
    const weather = this.options.bolt.options.weather,
      o = weather.options.lightning,
      tau = o?.bolt?.fade ?? 0.03;
    if (o?.hold !== undefined)
      return weather.lastStrike && o.hold > 0 ? [{ strike: weather.lastStrike, level: o.hold }] : [];
    return weather.liveStrikes
      .map((a) => ({ strike: a.strike, level: strokeLevel(a.age, a.offsets, a.amplitudes, tau) }))
      .filter((a) => a.level > 0.002)
      .slice(-MAX_BOLTS);
  }

  /** Writes the live pieces into `rows`: start and stretch, end and light per metre. Returns how many there are. */
  private fill(count: number, intensity: number): number {
    let total = 0;
    for (const { strike, level } of this.live()) {
      const channel = this.options.bolt.channelOf(strike);
      let held = this.cache.get(channel);
      if (held?.count !== count || held.segments !== channel.segments) {
        held = { count, segments: channel.segments, pieces: lightningGlowPieces(channel, count) };
        this.cache.set(channel, held);
      }
      this.rows.set(held.pieces, total * CHANNEL_STRIDE);
      for (let k = 0; k < count; k++) this.rows[(total + k) * CHANNEL_STRIDE + 7] = intensity * level;
      total += count;
    }
    return total;
  }

  private draw(c: Context): void {
    if (!this.uniform || !this.storage) return;
    const o = this.validate(),
      bolt = this.options.bolt,
      look = bolt.options.weather.options.lightning?.bolt ?? {},
      width = look.width ?? 1.5,
      intensity = (bolt.options.coreRadiance ?? 80) * (look.scale ?? 1) * width * o.strength;
    if (!(intensity > 0) || !o.albedo) return;
    const total = this.fill(o.pieces, intensity);
    if (!total) return;
    const depth = sceneDepth(c, this.options.depth, 'LightningGlow');
    if (!depth) return;
    const v = this.values,
      color = bolt.options.weather.options.lightning?.light?.color ?? LIGHTNING_COLOR,
      top = Math.max(color[0], color[1], color[2]) || 1,
      eye = c.camera.position,
      sigma = visibilityExtinction(o.visibility);
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.scratch))
      throw new MargoError('state', 'Invalid LightningGlow camera; give the camera a finite, invertible projection.');
    // Pieces are sent relative to the camera, subtracted in doubles; the shader takes the ray's origin the same way.
    for (let k = 0; k < total; k++)
      for (let i = 0; i < 3; i++) {
        this.rows[k * CHANNEL_STRIDE + i] -= eye[i]!;
        this.rows[k * CHANNEL_STRIDE + 4 + i] -= eye[i]!;
      }
    v.set([eye[0]!, eye[1]!, eye[2]!, total], 16);
    // The bolt's core colour: its light's colour, whitened.
    for (let i = 0; i < 3; i++) v[20 + i] = 0.4 + (0.6 * color[i]!) / top;
    v[23] = +!linearHdr(c.format);
    v.set([sigma, o.anisotropy, Math.max(width / 2, 0.05), sigma * o.albedo], 24);
    const device = c.device;
    device.queue.writeBuffer(this.uniform, 0, v);
    device.queue.writeBuffer(this.storage, 0, this.rows, 0, total * CHANNEL_STRIDE);
    const key = `${c.format}:${c.descriptor.multisample?.count ?? 1}:${depth.samples}`;
    if (this.key !== key) {
      const module = device.createShaderModule({ code: shader(depthWGSL(2, depth.samples)) });
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
      });
      this.key = key;
      this.bound = undefined;
    }
    if (this.bound !== depth.texture) {
      this.bind = device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: { buffer: this.storage } },
          { binding: 2, resource: depth.resource },
        ],
      });
      this.bound = depth.texture;
    }
    const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
    applyView(pass, c);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();
  }

  private release(): void {
    this.uniform?.destroy();
    this.storage?.destroy();
    this.uniform = this.storage = this.pipeline = this.bind = this.bound = undefined;
    this.key = '';
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
