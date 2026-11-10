/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import type { Vec3 } from '@margoengine/math';
import { ParticleOverlay } from '../../shared/particle-overlay.js';
import { fullscreen } from '../../shared/gpu.js';
import { applyView, viewSize } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type WeatherPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Speed of sound in air at 20 C, metres per second: thunder follows lightning by `distance / speed`. */
export const speedOfSound = 343;

/** `lightning` option of {@link Weather}: storms that flash the scene and report each strike and its thunder. */
export interface WeatherLightningOptions {
  /** Strikes per minute when `intensity` is 1; the rate rises from 0 at `threshold`. Default 6. */
  rate?: number;
  /** Intensity (0..1) below which no lightning strikes. Default 0.6. */
  threshold?: number;
  /** Nearest strike, metres from the listener. Default 300. */
  minDistance?: number;
  /** Farthest strike, metres. Default 6000. */
  maxDistance?: number;
  /** Peak brightness of the flash overlay, linear light added to the whole frame. Default 0.35. 0 turns the overlay off. */
  strength?: number;
  /** Colour of the flash, linear RGB. Default a cool white. */
  color?: Vec3;
  /** Seed of the strike generator: the same seed and frame times give the same storm. Default 1. */
  seed?: number;
}

/**
 * Settings of a {@link Weather}, read every frame from `weather.options`. A value out of range throws RangeError, a
 * value of the wrong shape TypeError.
 */
export interface WeatherOptions {
  /** `'rain'` streaks, `'snow'` flakes, `'sleet'` (both at once, by `snowShare`), or `'none'`. Default `'rain'`. */
  precipitation?: 'rain' | 'snow' | 'sleet' | 'none';
  /** With `'sleet'`: the share of the precipitation that falls as snow, 0 to 1; the rest is rain. Default 0.5. */
  snowShare?: number;
  /** Target amount, 0 (dry) to 1 (storm). The visible {@link Weather.amount} eases to it over `fadeSeconds`. Default 0.5. */
  intensity?: number;
  /** Seconds the amount takes to move across its whole range, 0 or more (0 jumps). Default 4. */
  fadeSeconds?: number;
  /** Horizontal wind in metres per second, world X and Z. Rain slants and snow drifts with it. Default [0, 0]. */
  wind?: readonly [number, number];
  /** Half-width in metres of the box around the camera that holds the particles, 2..200. Default 25. */
  radius?: number;
  /** Height in metres of that box, 2..200. Default 20. */
  height?: number;
  /** Particles at intensity 1, 0..500,000. Default 24,000 for rain and 16,000 for snow. */
  particles?: number;
  /** Particle colour, linear RGB. Default a pale grey-blue for rain and white for snow. */
  color?: Vec3;
  /** Scales the particle colour, 0 or more: lower it at night (`1 - sky.nightFactor`). Default 1. */
  brightness?: number;
  /** Opacity of one particle, 0..1. Default 0.35 for rain and 0.8 for snow. */
  opacity?: number;
  /** Storms; omitted means no lightning. */
  lightning?: WeatherLightningOptions;
}

/**
 * What keeps rain and snow off: the cover map `WeatherFX` (`@margoengine/sky/weather-fx`) draws each frame, its frame
 * uniform (binding 1) and its top-down depth (binding 2). While both are set the weather draws its particles with
 * `shader(code)`, its own WGSL with the cover read in, which drops every particle under cover.
 */
export interface WeatherOcclusion {
  readonly buffer: GPUBuffer | undefined;
  readonly view: GPUTextureView | undefined;
  shader(code: string): string;
}

/** One lightning strike, given to {@link Weather.onLightning} listeners and, later, to {@link Weather.onThunder} ones. */
export interface LightningStrike {
  /** 1 for the first strike, counting up. */
  id: number;
  /** Seconds of weather time at which it struck. */
  time: number;
  /** Metres from the listener. */
  distance: number;
  /** Direction from the listener in radians, 0 toward +Z and pi/2 toward +X. */
  azimuth: number;
  /** Where it hit the ground: the listener's position plus the offset, at y = 0, in world metres. */
  position: Vec3;
  /** Peak flash brightness, 0..1, falling off with distance. */
  strength: number;
  /** Return strokes in the flash, 1..4. */
  strokes: number;
  /** Seconds until the thunder is heard: `distance / speedOfSound`. */
  thunderDelay: number;
  /** Seconds the rumble lasts, longer the farther the strike. */
  rumble: number;
  /** Loudness of the thunder, 0..1, falling off with distance. */
  loudness: number;
}

/** Overrides for {@link Weather.strike}: a strike you place yourself. */
export interface StrikeOptions {
  /** Metres from the listener. Default random within the lightning range, or 1000. */
  distance?: number;
  /** Radians, 0 toward +Z. Default random. */
  azimuth?: number;
  /** Peak brightness 0..1. Default from the distance. */
  strength?: number;
}

/**
 * Brightness (0..1) of a strike `seconds` after it started: each stroke rises in about 8 ms and falls with a time
 * constant of 70 ms; the flash is the brightest stroke. `offsets` are the strokes' start times, `amplitudes` their
 * relative peaks.
 */
export function lightningFlash(seconds: number, offsets: readonly number[], amplitudes: readonly number[]): number {
  let flash = 0;
  for (let i = 0; i < offsets.length; i++) {
    const t = seconds - offsets[i];
    if (t < 0) continue;
    const level = t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / 0.07);
    flash = Math.max(flash, amplitudes[i] * level);
  }
  return flash;
}

/** Seconds for thunder to cover `distance` metres at `speed` metres per second (default {@link speedOfSound}). */
export function thunderDelay(distance: number, speed: number = speedOfSound): number {
  if (!(distance >= 0) || !Number.isFinite(distance) || !(speed > 0) || !Number.isFinite(speed))
    throw new RangeError('Thunder delay needs a distance of 0 or more and a speed above 0; pass finite numbers');
  return distance / speed;
}

interface Active {
  strike: LightningStrike;
  offsets: number[];
  amplitudes: number[];
  age: number;
  heard: boolean;
}

// Hash: the PCG hash (O'Neill, PCG, 2014; GPU form in Jarzynski and Olano, JCGT 9(3), 2020); integer maths is exact
// on every GPU. Each particle takes three hashes for its place in the box and one for its size.
const shader = `
struct Weather {
 camera:mat4x4f, eye:vec4f, volume:vec4f, drift:vec4f, colour:vec4f, screen:vec4f, params:vec4f, extra:vec4f,
}
@group(0) @binding(0) var<uniform> w:Weather;
struct Out {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
fn pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let x=((s>>((s>>28u)+4u))^s)*277803737u;return (x>>22u)^x;}
fn rnd(i:u32,k:u32)->f32 {return f32(pcg(i*4u+k+bitcast<u32>(w.params.z))>>8u)*5.9604645e-8;}
const corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
const culled=Out(vec4f(2,2,2,1),vec2f(0),0.0);
@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let corner=corners[vi];
 let size=w.volume.xyz;
 let start=vec3f(rnd(ii,0u),rnd(ii,1u),rnd(ii,2u))*size;
 // The drift (velocity times time, wrapped on the CPU) keeps the numbers small; the box follows the camera.
 let rel=fract((start+w.drift.xyz-w.eye.xyz)/size)-0.5;
 var q=w.eye.xyz+rel*size;
 let snow=w.params.x>0.5;
 if(snow){q+=vec3f(sin(w.drift.w+start.x*3.1),0.0,cos(w.drift.w*0.8+start.z*2.7))*0.35;}
 let edge=max(max(abs(rel.x),abs(rel.z)),abs(rel.y));
 let nearDistance=length(q-w.eye.xyz);
 let fade=(1.0-smoothstep(0.7,1.0,edge*2.0))*smoothstep(0.4,2.0,nearDistance);
 let vp=w.screen.xy;
 var out:Out;
 if(snow){
  let c=w.camera*vec4f(q,1);
  if(c.w<0.1){return culled;}
  let sizeMeters=w.params.y*(0.6+0.8*rnd(ii,3u));
  let px=max(sizeMeters*w.screen.z/c.w,1.0);
  out.position=vec4f(c.xy+corner*px*2.0/vp*c.w,c.z,c.w);
  out.uv=corner;
  // Flakes smaller than a pixel fade rather than sparkle.
  out.alpha=fade*min(1.0,sizeMeters*w.screen.z/c.w);
  return out;
 }
 let velocity=vec3f(w.extra.x,-w.extra.y,w.extra.z);
 let tail=q-velocity*w.params.y;
 let a=w.camera*vec4f(q,1);
 let b=w.camera*vec4f(tail,1);
 if(a.w<0.1||b.w<0.1){return culled;}
 let pa=a.xy/a.w*vp*0.5;
 let pb=b.xy/b.w*vp*0.5;
 let d=pb-pa;
 let length2=length(d);
 let dir=select(vec2f(0,1),d/length2,length2>0.0001);
 let normal=vec2f(-dir.y,dir.x);
 let head=corner.y>0.0;
 let halfWidth=max(w.extra.w*0.5,0.5);
 let base=select(pb,pa,head);
 let ndc=(base+normal*corner.x*halfWidth)*2.0/vp;
 let c=select(b,a,head);
 out.position=vec4f(ndc*c.w,c.z,c.w);
 out.uv=vec2f(corner.x,select(0.0,1.0,head));
 out.alpha=fade*(0.4+0.6*rnd(ii,3u));
 return out;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 var a=i.alpha*w.colour.w;
 if(w.params.x>0.5){a*=1.0-smoothstep(0.4,1.0,length(i.uv));}
 else{a*=(1.0-i.uv.x*i.uv.x)*mix(0.15,1.0,i.uv.y);}
 return vec4f(w.colour.rgb*(1.0+w.params.w*6.0),a);
}`;

const flashShader = `${fullscreen}
@group(0) @binding(0) var<uniform> flash:vec4f;
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 // Brighter toward the top of the frame, where the cloud base lights up.
 let sheet=0.7+0.3*(1.0-i.uv.y);
 return vec4f(flash.rgb*sheet,0.0);
}`;

const defaults = {
  rain: { particles: 24000, opacity: 0.35, color: [0.62, 0.68, 0.76] as Vec3 },
  snow: { particles: 16000, opacity: 0.8, color: [1, 1, 1] as Vec3 },
};
const flashColor: Vec3 = [0.75, 0.82, 1];
const lightningDefaults = { rate: 6, threshold: 0.6, minDistance: 300, maxDistance: 6000, strength: 0.35, seed: 1 };

const number = (value: unknown, name: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Weather ${name} must be a number from ${min} to ${max}; pass a finite value in range`);
};

function validate(o: WeatherOptions): void {
  if (
    o.precipitation !== undefined &&
    o.precipitation !== 'rain' &&
    o.precipitation !== 'snow' &&
    o.precipitation !== 'sleet' &&
    o.precipitation !== 'none'
  )
    throw new TypeError('Weather precipitation must be "rain", "snow", "sleet" or "none"; pass one of them');
  if (o.snowShare !== undefined) number(o.snowShare, 'snowShare', 0, 1);
  if (o.intensity !== undefined) number(o.intensity, 'intensity', 0, 1);
  if (o.fadeSeconds !== undefined) number(o.fadeSeconds, 'fadeSeconds', 0, 3600);
  if (o.radius !== undefined) number(o.radius, 'radius', 2, 200);
  if (o.height !== undefined) number(o.height, 'height', 2, 200);
  if (o.particles !== undefined) number(o.particles, 'particles', 0, 500000);
  if (o.brightness !== undefined) number(o.brightness, 'brightness', 0, 1e6);
  if (o.opacity !== undefined) number(o.opacity, 'opacity', 0, 1);
  if (o.wind !== undefined) {
    if (!Array.isArray(o.wind) || o.wind.length !== 2)
      throw new TypeError('Weather wind needs [x, z] in metres per second; pass an array of two numbers');
    number(o.wind[0], 'wind[0]', -100, 100);
    number(o.wind[1], 'wind[1]', -100, 100);
  }
  if (o.color !== undefined) {
    finiteVector(o.color, 3, 'Weather color');
    if (o.color.some((v) => v < 0)) throw new RangeError('Weather color must be non-negative linear RGB');
  }
  const l = o.lightning;
  if (l === undefined) return;
  if (typeof l !== 'object' || l === null)
    throw new TypeError('Weather lightning must be an options object; pass {} for the defaults');
  if (l.rate !== undefined) number(l.rate, 'lightning.rate', 0, 600);
  if (l.threshold !== undefined) number(l.threshold, 'lightning.threshold', 0, 1);
  if (l.minDistance !== undefined) number(l.minDistance, 'lightning.minDistance', 0, 1e5);
  if (l.maxDistance !== undefined) number(l.maxDistance, 'lightning.maxDistance', 0, 1e5);
  if ((l.minDistance ?? lightningDefaults.minDistance) > (l.maxDistance ?? lightningDefaults.maxDistance))
    throw new RangeError('Weather lightning minDistance must not exceed maxDistance; swap them');
  if (l.strength !== undefined) number(l.strength, 'lightning.strength', 0, 100);
  if (l.seed !== undefined) number(l.seed, 'lightning.seed', -2147483648, 4294967295);
  if (l.color !== undefined) {
    finiteVector(l.color, 3, 'Weather lightning color');
    if (l.color.some((v) => v < 0)) throw new RangeError('Weather lightning color must be non-negative linear RGB');
  }
}

/**
 * Rain or snow around the camera, with storms. Particles live in a box that follows the camera, are placed by an
 * integer hash and moved by the wind with no per-frame buffer upload, and are depth-tested against the scene. Lightning
 * flashes the frame, reports each strike and, after the distance-based delay, its thunder (`onThunder`, for audio).
 * The weather state (`amount`, `flash`, `wetness`, `snowCover`) is plain numbers, so materials, sky, fog and sound can
 * follow it. Without a GPU engine it still runs: `new Weather(options)` and `onPreUpdate(delta)`.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when a listener changes the weather it is called from.
 */
export class Weather implements EnginePlugin {
  readonly name: string = 'weather';
  /** Where the listener (the ear and the eye) is: strikes are placed around it. The render pass follows the camera. */
  readonly listener = new Float32Array(3);
  /** Set by `WeatherFX` from `@margoengine/sky/weather-fx`: the cover map under which no rain or snow falls. */
  occlusion?: WeatherOcclusion;
  private coverEntries?: GPUBindGroupEntry[];
  private readonly overlay = new ParticleOverlay();
  // Sleet draws its snow as a second overlay with its own uniform: one uploaded buffer holds one draw's values.
  private readonly snowOverlay = new ParticleOverlay();
  private snowUniform?: GPUBuffer;
  private readonly snowValues = new Float32Array(44);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private flashUniform?: GPUBuffer;
  private flashPipeline?: GPURenderPipeline;
  private flashBind?: GPUBindGroup;
  private flashKey = '';
  private readonly values = new Float32Array(44);
  private readonly flashValues = new Float32Array(4);
  private disposed = false;
  private time = 0;
  private level = 0;
  private flashLevel = 0;
  private wet = 0;
  private snow = 0;
  private state = 0x9e3779b9;
  private seeded = NaN;
  private counter = 0;
  private active: Active[] = [];
  private lightningListeners = new Set<(strike: LightningStrike) => void>();
  private thunderListeners = new Set<(strike: LightningStrike) => void>();
  private dispatching = false;

  constructor(readonly options: WeatherOptions = {}) {
    validate(options);
  }

  static attach(engine: EngineKernel, options: WeatherOptions = {}): Weather {
    const effect = new Weather(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  /** Visible precipitation, 0..1: eases toward `options.intensity` over `options.fadeSeconds`. */
  get amount(): number {
    return this.level;
  }
  /** Lightning flash brightness this frame, 0..1 (0 between strikes), before `lightning.strength` scales it. */
  get flash(): number {
    return this.flashLevel;
  }
  /** How wet surfaces are, 0..1: rises under rain (about 20 s), dries when it stops (about 90 s). Drive roughness with it. */
  get wetness(): number {
    return this.wet;
  }
  /** Snow lying on the ground, 0..1: builds under snow (about 2 minutes) and melts slowly (about 5 minutes). */
  get snowCover(): number {
    return this.snow;
  }
  /** Share of the precipitation that is rain, 0 to 1: 1 for rain, 0 for snow and none, `1 - snowShare` for sleet. */
  get rainShare(): number {
    const kind = this.options.precipitation ?? 'rain';
    return kind === 'rain' ? 1 : kind === 'sleet' ? 1 - (this.options.snowShare ?? 0.5) : 0;
  }
  /** Seconds of weather time so far (the sum of the deltas given to `onPreUpdate`). */
  get elapsed(): number {
    return this.time;
  }

  /**
   * Calls `listener` when lightning strikes, at the moment the flash starts. Returns a function that removes it.
   * @throws TypeError when `listener` is not a function.
   */
  onLightning(listener: (strike: LightningStrike) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Weather onLightning needs a function; pass a listener');
    this.lightningListeners.add(listener);
    return () => void this.lightningListeners.delete(listener);
  }

  /**
   * Calls `listener` when a strike's thunder arrives, `thunderDelay` seconds after the flash: play the sound with
   * `loudness` and `rumble`. Returns a function that removes it.
   * @throws TypeError when `listener` is not a function.
   */
  onThunder(listener: (strike: LightningStrike) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Weather onThunder needs a function; pass a listener');
    this.thunderListeners.add(listener);
    return () => void this.thunderListeners.delete(listener);
  }

  /**
   * Strikes now, wherever the options say lightning is or not, and returns the strike.
   * @throws RangeError when a value is out of range.
   */
  strike(options: StrikeOptions = {}): LightningStrike {
    this.idle();
    if (options.distance !== undefined) number(options.distance, 'strike distance', 0, 1e5);
    if (options.azimuth !== undefined) number(options.azimuth, 'strike azimuth', -1e6, 1e6);
    if (options.strength !== undefined) number(options.strength, 'strike strength', 0, 1);
    return this.spawn(options);
  }

  /** Throws unless this weather is alive and not inside one of its own callbacks. */
  private idle(): void {
    if (this.disposed) throw new MargoError('disposed', 'Weather is disposed; create a new Weather');
    if (this.dispatching)
      throw new MargoError('state', 'Weather listener changed the weather during a callback; do it on the next frame');
  }

  private random(): number {
    // mulberry32 (Tommy Ettinger): a small 32-bit generator, plenty for scheduling strikes.
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private spawn(options: StrikeOptions): LightningStrike {
    const l = this.options.lightning,
      min = l?.minDistance ?? lightningDefaults.minDistance,
      max = l?.maxDistance ?? lightningDefaults.maxDistance;
    const distance = options.distance ?? (l ? min + this.random() * (max - min) : 1000),
      azimuth = options.azimuth ?? this.random() * Math.PI * 2,
      reach = Math.max(max, 1),
      strength = options.strength ?? Math.max(0.1, 1 - 0.7 * Math.min(1, distance / reach)),
      strokes = 1 + Math.floor(this.random() * 3.999);
    const offsets = [0],
      amplitudes = [1];
    for (let i = 1; i < strokes; i++) {
      offsets.push(offsets[i - 1] + 0.04 + this.random() * 0.08);
      amplitudes.push(0.4 + this.random() * 0.5);
    }
    const strike: LightningStrike = {
      id: ++this.counter,
      time: this.time,
      distance,
      azimuth,
      position: [this.listener[0] + Math.sin(azimuth) * distance, 0, this.listener[2] + Math.cos(azimuth) * distance],
      strength,
      strokes,
      thunderDelay: thunderDelay(distance),
      rumble: Math.min(8, 1 + distance / 700),
      loudness: 1 / (1 + (distance / 1500) ** 2),
    };
    this.active.push({ strike, offsets, amplitudes, age: 0, heard: false });
    this.notify(this.lightningListeners, strike);
    return strike;
  }

  private notify(listeners: Set<(strike: LightningStrike) => void>, strike: LightningStrike): void {
    this.dispatching = true;
    let failure: unknown,
      failed = false;
    try {
      for (const listener of [...listeners])
        try {
          listener(strike);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
    } finally {
      this.dispatching = false;
    }
    if (failed) throw failure;
  }

  onPreUpdate(delta: number): void {
    this.idle();
    validate(this.options);
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid weather delta; pass a finite delta of 0 or more seconds.');
    const o = this.options,
      precipitation = o.precipitation ?? 'rain',
      target = precipitation === 'none' ? 0 : (o.intensity ?? 0.5),
      fade = o.fadeSeconds ?? 4;
    this.time += delta;
    this.level =
      fade === 0
        ? target
        : Math.max(
            0,
            Math.min(
              1,
              this.level + Math.sign(target - this.level) * Math.min(Math.abs(target - this.level), delta / fade),
            ),
          );
    // First-order approach to a target: rain wets, snow settles, both with their own drying and melting, each by its
    // share of the precipitation (sleet does both).
    const approach = (value: number, goal: number, up: number, down: number) =>
        value + (goal - value) * (1 - Math.exp(-delta / (goal > value ? up : down))),
      rain = this.rainShare,
      snow = precipitation === 'none' ? 0 : 1 - rain;
    this.wet = approach(this.wet, rain > 0 ? Math.min(1, this.level * 1.5) * rain : 0, 20, 90);
    this.snow = approach(this.snow, snow > 0 ? this.level * snow : 0, 120, 300);
    this.storm(delta);
    this.advance(delta);
  }

  private storm(delta: number): void {
    const l = this.options.lightning;
    if (!l || delta === 0) return;
    const seed = l.seed ?? lightningDefaults.seed;
    if (this.seeded !== seed) {
      this.state = (seed | 0) ^ 0x9e3779b9;
      this.seeded = seed;
    }
    const threshold = l.threshold ?? lightningDefaults.threshold,
      share = threshold >= 1 ? 0 : Math.max(0, (this.level - threshold) / (1 - threshold)),
      perSecond = ((l.rate ?? lightningDefaults.rate) * share) / 60;
    // A Poisson process: the chance of a strike in this step. A long step (a hidden tab) strikes at most once.
    if (perSecond > 0 && this.random() < 1 - Math.exp(-perSecond * Math.min(delta, 5))) this.spawn({});
  }

  private advance(delta: number): void {
    let flash = 0;
    const l = this.options.lightning;
    for (const a of this.active) {
      a.age += delta;
      flash = Math.max(flash, a.strike.strength * lightningFlash(a.age, a.offsets, a.amplitudes));
      if (!a.heard && a.age >= a.strike.thunderDelay) {
        a.heard = true;
        this.notify(this.thunderListeners, a.strike);
      }
    }
    this.active = this.active.filter((a) => !a.heard || a.age < a.offsets[a.offsets.length - 1] + 0.6);
    this.flashLevel = flash;
    this.flashValues[3] = 0;
    const strength = l?.strength ?? lightningDefaults.strength,
      color = l?.color ?? flashColor;
    for (let i = 0; i < 3; i++) this.flashValues[i] = color[i] * strength * flash;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Weather requires WebGPU; attach a new Weather to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.flashUniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'weather:precipitation',
      order: 6,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.listener.set(c.camera.position);
        this.drawPrecipitation(c);
      },
    });
    graph.add({
      name: 'weather:flash',
      order: 6.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawFlash(c);
      },
    });
  }

  private drawPrecipitation(c: WeatherPassContext): void {
    const o = this.options,
      kind = o.precipitation ?? 'rain';
    if (kind === 'none' || this.level <= 0.001) return;
    if (kind !== 'sleet') return this.drawKind(c, kind, 1, this.overlay, this.uniform!, this.values);
    // Sleet: rain and snow at once, each with its share of the particles; the snow on its own hash seed.
    const share = o.snowShare ?? 0.5;
    this.drawKind(c, 'rain', 1 - share, this.overlay, this.uniform!, this.values);
    this.snowUniform ??= c.device.createBuffer({
      size: this.snowValues.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.drawKind(c, 'snow', share, this.snowOverlay, this.snowUniform, this.snowValues, 0x51ed27);
  }

  private drawKind(
    c: WeatherPassContext,
    kind: 'rain' | 'snow',
    share: number,
    overlay: ParticleOverlay,
    uniform: GPUBuffer,
    v: Float32Array,
    salt = 0,
  ): void {
    const o = this.options,
      d = defaults[kind],
      count = Math.ceil((o.particles ?? d.particles) * this.level * share);
    if (count === 0) return;
    const radius = o.radius ?? 25,
      height = o.height ?? 20,
      wind = o.wind ?? [0, 0],
      snow = kind === 'snow',
      fall = snow ? 1.2 : 9,
      color = o.color ?? d.color,
      brightness = o.brightness ?? 1,
      [width, tall] = viewSize(c) as [number, number];
    v.set(c.camera.matrix, 0);
    v.set(c.camera.position, 16);
    v[19] = 0;
    v[20] = radius * 2;
    v[21] = height;
    v[22] = radius * 2;
    // Position = start + velocity * time, wrapped into the box on the CPU in double precision so it stays exact.
    const wrap = (value: number, size: number) => ((value % size) + size) % size;
    v[24] = wrap(wind[0] * this.time, radius * 2);
    v[25] = wrap(-fall * this.time, height);
    v[26] = wrap(wind[1] * this.time, radius * 2);
    // Snow sways with sin(phase) and cos(0.8 phase): the phase wraps at 10 pi, a whole turn of both.
    v[27] = (this.time * 1.3) % (Math.PI * 10);
    for (let i = 0; i < 3; i++) v[28 + i] = color[i] * brightness;
    v[31] = o.opacity ?? d.opacity;
    // screen: viewport pixels and the focal length in pixels. params: snow flag, flake radius in metres or rain streak
    // seconds, the hash seed (as bits) and the lightning lift of the colour. extra: wind, fall speed and streak width.
    v[32] = width;
    v[33] = tall;
    v[34] = tall / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    v[35] = 0;
    v[36] = +snow;
    v[37] = snow ? 0.012 : 0.035;
    new Uint32Array(v.buffer)[38] = ((this.options.lightning?.seed ?? 1) + salt) >>> 0;
    v[39] = Math.min(1, this.flashLevel);
    v[40] = wind[0];
    v[41] = fall;
    v[42] = wind[1];
    v[43] = Math.max(1, (tall / 540) * 1.2);
    const cover = this.occlusion;
    if (cover?.buffer && cover.view) {
      const e = this.coverEntries;
      if (!e || (e[0].resource as GPUBufferBinding).buffer !== cover.buffer || e[1].resource !== cover.view)
        this.coverEntries = [
          { binding: 1, resource: { buffer: cover.buffer } },
          { binding: 2, resource: cover.view },
        ];
      overlay.draw(c, cover.shader(shader), uniform, v as Float32Array<ArrayBuffer>, count, this.coverEntries);
    } else overlay.draw(c, shader, uniform, v as Float32Array<ArrayBuffer>, count);
  }

  private drawFlash(c: WeatherPassContext): void {
    if (this.flashLevel <= 0.0005 || !(this.flashValues[0] + this.flashValues[1] + this.flashValues[2] > 0)) return;
    const key = c.format + ':' + c.descriptor.multisample?.count;
    if (this.flashKey !== key) {
      const module = c.device.createShaderModule({ code: flashShader });
      this.flashPipeline = c.device.createRenderPipeline({
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
      this.flashBind = c.device.createBindGroup({
        layout: this.flashPipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.flashUniform! } }],
      });
      this.flashKey = key;
    }
    c.device.queue.writeBuffer(this.flashUniform!, 0, this.flashValues as Float32Array<ArrayBuffer>);
    const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
    applyView(pass, c);
    pass.setPipeline(this.flashPipeline!);
    pass.setBindGroup(0, this.flashBind!);
    pass.draw(3);
    pass.end();
  }

  private release(): void {
    this.uniform?.destroy();
    this.flashUniform?.destroy();
    this.uniform = this.flashUniform = undefined;
    this.overlay.release();
    this.snowOverlay.release();
    this.snowUniform?.destroy();
    this.snowUniform = this.coverEntries = undefined;
    this.flashPipeline = this.flashBind = undefined;
    this.flashKey = '';
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
    this.active = [];
    this.lightningListeners.clear();
    this.thunderListeners.clear();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
