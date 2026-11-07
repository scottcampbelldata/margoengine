/// <reference lib="esnext.disposable" preserve="true" />
// Puddles and wet ground on every core mesh: rain darkens surfaces and makes them shinier, standing water gathers in
// the low spots of a procedural relief on flat, up-facing ground as the wetness rises, and falling rain rings the
// water. One hook in core's mesh shader (the surface before lighting), one 32-byte uniform a frame. The maths has a
// JavaScript twin (`puddleMask`, `puddleSurface`) that the real-GPU test holds the WGSL to.
import type { EngineKernel } from '@margoengine/core';
import { SurfaceHook, noiseWGSL, patchFragment, valueNoise2 } from './scene-patch.js';
import { wetColor, wetRoughness } from './surface.js';

/** Bind group 0 slot of the puddle uniform in core's mesh shader. */
export const PUDDLE_BINDING = 160;

/**
 * What the puddles follow: a `WeatherMachine` (its `wetness` and `state.rain`) or `@margoengine/sky`'s `Weather` (its
 * `wetness`, `amount` and `rainShare`). Anything with these numbers works.
 */
export interface PuddleSource {
  /** Ground wetness, 0 (dry) to 1 (soaked). */
  readonly wetness: number;
  /** A machine's state: `rain` rings the water. */
  readonly state?: { readonly rain: number };
  /** A sky Weather's eased precipitation, 0 to 1, of which `rainShare` is rain. */
  readonly amount?: number;
  /** Share of `amount` that is rain, 0 to 1 (1 when absent). */
  readonly rainShare?: number;
}

/** {@link Puddles} settings, read every frame from `puddles.options`. Out of range throws RangeError, a wrong type TypeError. */
export interface PuddleOptions {
  /** The weather to follow; while set it gives `wetness` and `rain`. Default none. */
  weather?: PuddleSource;
  /** Ground wetness when no `weather` is set, 0 to 1. Default 0. */
  wetness?: number;
  /** Rain intensity for the rings when no `weather` is set, 0 to 1. Default 0. */
  rain?: number;
  /** Share of flat ground under water once the ground is soaked (wetness 1), 0 to 0.8. Default 0.3. */
  coverage?: number;
  /** Size of the relief that holds the water, metres per noise cell, 0.25 to 100: puddles are about this wide. Default 3. */
  size?: number;
  /** Wetness at which water starts to stand, 0 to 1 (below it the ground only darkens). Default 0.4. */
  start?: number;
  /** Width of one ring cell in metres, 0.05 to 5; each holds one ring at a time. Default 0.35. */
  rippleSize?: number;
  /** How far the rings tilt the water's normal, 0 to 1. Default 0.35. */
  rippleStrength?: number;
  /** Darken and smooth surfaces with the wetness (`wetColor`, `wetRoughness`) as well as drawing the water. Default true. */
  wetSurfaces?: boolean;
}

const RANGES: Record<string, readonly [number, number]> = {
  wetness: [0, 1],
  rain: [0, 1],
  coverage: [0, 0.8],
  size: [0.25, 100],
  start: [0, 1],
  rippleSize: [0.05, 5],
  rippleStrength: [0, 1],
};

/** Throws for any invalid field of `o`. */
export function validatePuddles(o: PuddleOptions): void {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('Puddle options must be an object; pass {} for the defaults');
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const value = (o as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new RangeError(`Puddles ${key} must be a number from ${min} to ${max}; pass a finite value in range`);
  }
  if (o.wetSurfaces !== undefined && typeof o.wetSurfaces !== 'boolean')
    throw new TypeError('Puddles wetSurfaces must be true or false');
  if (
    o.weather !== undefined &&
    (typeof o.weather !== 'object' || o.weather === null || typeof o.weather.wetness !== 'number')
  )
    throw new TypeError('Puddles weather needs a numeric wetness; pass a WeatherMachine or a sky Weather');
}

/** The relief's height levels by share of ground below them: quantiles of {@link puddleRelief}, measured on 160,000 points. */
const QUANTILES = [0.05, 0.3055, 0.3689, 0.4156, 0.4577, 0.4978, 0.5369, 0.5794, 0.6275];
/** Softness of a puddle's shore, in relief units. */
const SHORE = 0.02;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : Number.isNaN(x) ? 0 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The relief that holds the water, 0..1 at world `(x, z)` for puddles about `size` metres wide. */
export function puddleRelief(x: number, z: number, size = 3): number {
  const px = x / size,
    pz = z / size;
  return (
    0.6 * valueNoise2(px, pz, 0) +
    0.3 * valueNoise2(px * 2.03, pz * 2.03, 1) +
    0.1 * valueNoise2(px * 4.01, pz * 4.01, 2)
  );
}

/** Water level on the relief for a share of ground under water (0 to 0.8): the quantile table, linearly interpolated. */
export function puddleLevel(share: number): number {
  const s = Math.min(0.8, Math.max(0, share)) * 10,
    k = Math.min(7, Math.floor(s));
  return QUANTILES[k] + (QUANTILES[k + 1] - QUANTILES[k]) * (s - k);
}

/**
 * How much standing water covers a surface at world `(x, z)`, 0..1. `normalY` is the world up component of its normal:
 * water stands only on ground within about 15 degrees of flat. The share of flat ground under water grows from 0 at
 * wetness `start` to `coverage` at wetness 1.
 */
export function puddleMask(x: number, z: number, normalY: number, wetness: number, o: PuddleOptions = {}): number {
  const start = o.start ?? 0.4,
    fill = smoothstep(start, 1, wetness) * (o.coverage ?? 0.3),
    flat = smoothstep(0.96, 0.99, normalY);
  if (fill <= 0 || flat <= 0) return 0;
  return flat * smoothstep(0, SHORE, puddleLevel(fill) - puddleRelief(x, z, o.size ?? 3));
}

/** Colour, roughness and metalness of a surface under puddles and wetness (rings aside), as the shader gives them. */
export function puddleSurface(
  base: { color: readonly [number, number, number]; roughness: number; metal?: number },
  x: number,
  z: number,
  normalY: number,
  wetness: number,
  o: PuddleOptions = {},
): { color: [number, number, number]; roughness: number; metal: number; water: number } {
  const wet = o.wetSurfaces ?? true,
    w = clamp01(wetness),
    water = puddleMask(x, z, normalY, w, o),
    c = wet ? wetColor(base.color, w) : [base.color[0], base.color[1], base.color[2]],
    r = wet ? wetRoughness(base.roughness, w) : base.roughness,
    dim = 1 - 0.3 * water;
  return {
    color: [c[0] * dim, c[1] * dim, c[2] * dim],
    roughness: r + (0.03 - r) * water,
    metal: (base.metal ?? 0) * (1 - water),
    water,
  };
}

const puddleCore = /* wgsl */ `
struct WeatherPuddles {a:vec4f, b:vec4f}
const weather_puddle_quantiles=array<f32,9>(${QUANTILES.join(',')});
fn weather_puddle_level(share:f32)->f32 {
  let s=clamp(share,0.0,0.8)*10.0;let k=min(7u,u32(floor(s)));
  return weather_puddle_quantiles[k]+(weather_puddle_quantiles[k+1u]-weather_puddle_quantiles[k])*(s-f32(k));
}
fn weather_puddle_relief(xz:vec2f, size:f32)->f32 {
  let p=xz/size;
  return 0.6*weather_noise(p,0u)+0.3*weather_noise(p*2.03,1u)+0.1*weather_noise(p*4.01,2u);
}
// u.a: wetness, rain, time, size; u.b: coverage, start, ripple size, ripple strength.
fn weather_puddle_mask(xz:vec2f, normalY:f32, u:WeatherPuddles)->f32 {
  let fill=smoothstep(u.b.y,1.0,u.a.x)*u.b.x;let flat=smoothstep(0.96,0.99,normalY);
  if(fill<=0.0||flat<=0.0){return 0.0;}
  return flat*smoothstep(0.0,${SHORE},weather_puddle_level(fill)-weather_puddle_relief(xz,u.a.w));
}
// Rings: each cell of two offset grids holds one drop at a time, at a random place and phase, if a random number is
// below the rain. The ring is the slope of a travelling Gaussian bump, so its tilt is zero at the centre and outside.
fn weather_puddle_ripple(xz:vec2f, u:WeatherPuddles)->vec2f {
  var tilt=vec2f(0);
  for(var layer=0u;layer<2u;layer++){
    let q=xz/u.b.z+vec2f(0.37,0.71)*f32(layer);let cell=floor(q);let f=q-cell;
    let l=4u+layer*3u;
    if(weather_lattice(cell,l)>=u.a.y){continue;}
    let centre=vec2f(0.3)+0.4*vec2f(weather_lattice(cell,l+1u),weather_lattice(cell,l+2u));
    let life=fract(u.a.z*0.9+weather_lattice(cell+vec2f(17,5),l));
    let d=f-centre;let r=length(d);let s=(r-life*0.3)/0.04;
    let amplitude=(1.0-life)*(1.0-life);
    tilt+=select(vec2f(0),d/r,r>1e-5)*2.0*s*exp(-s*s)*amplitude;
  }
  return tilt*u.b.w;
}
fn weather_puddle_surface(p:vec3f, n:vec3f, color:vec3f, roughness:f32, metal:f32, wet:bool, u:WeatherPuddles)->mat3x4f {
  let w=clamp(u.a.x,0.0,1.0);
  let water=weather_puddle_mask(p.xz,n.y,u);
  let k=select(1.0,1.0-0.25*w,wet);
  let r=select(roughness,clamp(roughness,0.0,1.0)*(1.0-0.65*w),wet);
  var normal=n;
  if(water>0.0){let t=weather_puddle_ripple(p.xz,u)*water;normal=normalize(mix(n,vec3f(0,1,0),water)+vec3f(t.x,0.0,t.y));}
  return mat3x4f(vec4f(color*k*(1.0-0.3*water),mix(r,0.03,water)),vec4f(metal*(1.0-water),water,0,0),vec4f(normal,0));
}
`;

/**
 * The shader: `weather_puddle_mask`, `weather_puddle_ripple` and `weather_puddle_surface` (colour in `.xyz`,
 * roughness in `.w` of the first vector, metalness and water in the second, the tilted normal in the third). Paste it
 * ahead of a shader of your own with a `WeatherPuddles` uniform bound as `weatherPuddles`, or let {@link Puddles} patch
 * core's mesh shader.
 */
export const puddleWGSL: string = noiseWGSL + puddleCore;

/**
 * Wet ground and puddles on every core mesh. `Puddles.attach(engine, {weather})` follows a `WeatherMachine` or a sky
 * `Weather`; or set `options.wetness` and `options.rain` yourself. WebGPU only.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine or when core's mesh
 * shader was replaced, `'disposed'` after `dispose()`.
 * @example
 * const puddles = Puddles.attach(engine, {weather: machine, coverage: 0.4});
 */
export class Puddles extends SurfaceHook {
  readonly name: string = 'weather-puddles';
  private clock = 0;

  constructor(readonly options: PuddleOptions = {}) {
    super(
      'Puddles',
      PUDDLE_BINDING,
      `${puddleCore}@group(0) @binding(${PUDDLE_BINDING}) var<uniform> weatherPuddles:WeatherPuddles;`,
      new Float32Array(8),
    );
    validatePuddles(options);
  }

  static attach(engine: EngineKernel, options: PuddleOptions = {}): Puddles {
    return SurfaceHook.use(engine, new Puddles(options));
  }

  /** Wetness in use this frame: the weather's, else `options.wetness`. */
  get wetness(): number {
    return clamp01(this.options.weather?.wetness ?? this.options.wetness ?? 0);
  }
  /** Rain in use this frame for the rings: the weather's, else `options.rain`. */
  get rain(): number {
    const w = this.options.weather;
    if (!w) return clamp01(this.options.rain ?? 0);
    if (w.state) return clamp01(w.state.rain);
    return clamp01((w.amount ?? 0) * (w.rainShare ?? 1));
  }
  /** Seconds of ring time so far. */
  get time(): number {
    return this.clock;
  }

  patch(source: string): string {
    const wet = this.options.wetSurfaces ?? true;
    return patchFragment(
      source,
      `{let s=weather_puddle_surface(i.position,normalize(i.normal),i.color,i.material.x,i.material.y,${wet},weatherPuddles);if(s[1].y>0.0||${wet}){i.color=s[0].xyz;i.material.x=s[0].w;i.material.y=s[1].x;}if(s[1].y>0.0){i.normal=s[2].xyz;}}`,
    );
  }

  override onPreUpdate(delta: number): void {
    super.onPreUpdate(delta);
    // Wraps after an hour so the rings keep float precision on the GPU; their phases repeat then.
    this.clock = (this.clock + delta) % 3600;
  }

  protected validate(): void {
    validatePuddles(this.options);
  }

  protected override variant(): string {
    return String(this.options.wetSurfaces ?? true);
  }

  protected write(): void {
    const o = this.options,
      v = this.values;
    v[0] = this.wetness;
    v[1] = this.rain;
    v[2] = this.clock;
    v[3] = o.size ?? 3;
    v[4] = o.coverage ?? 0.3;
    v[5] = o.start ?? 0.4;
    v[6] = o.rippleSize ?? 0.35;
    v[7] = o.rippleStrength ?? 0.35;
  }
}
