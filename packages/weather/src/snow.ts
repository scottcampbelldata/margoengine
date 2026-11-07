/// <reference lib="esnext.disposable" preserve="true" />
// Snow that builds on every core mesh: up-facing surfaces whiten first and steeper ones as the cover grows, the snow
// has a grainy surface, and it has depth: the vertex stage lifts covered surfaces by the snow's thickness, which
// varies in drifts. One hook in core's mesh shader (the vertex position and the surface before lighting), one
// 48-byte uniform a frame. The maths has a JavaScript twin (`snowAt`, `snowDepthAt`) that the real-GPU test holds the
// WGSL to.
import type { EngineKernel } from '@margoengine/core';
import { SurfaceHook, noiseWGSL, patchFragment, valueNoise2 } from './scene-patch.js';
import { SNOW_COLOR, SNOW_ROUGHNESS } from './surface.js';

/** Bind group 0 slot of the snow uniform in core's mesh shader. */
export const SNOW_BINDING = 161;

/** What the snow follows: a `WeatherMachine` or `@margoengine/sky`'s `Weather`, by its `snowCover`. */
export interface SnowSource {
  /** Snow on the ground, 0 (none) to 1 (full cover). */
  readonly snowCover: number;
}

/** {@link Snow} settings, read every frame from `snow.options`. Out of range throws RangeError, a wrong type TypeError. */
export interface SnowOptions {
  /** The weather to follow; while set it gives the cover. Default none. */
  weather?: SnowSource;
  /** Snow cover when no `weather` is set, 0 to 1. Default 0. */
  cover?: number;
  /** Thickness on flat ground at full cover, metres, 0 to 2. Default 0.12. */
  depth?: number;
  /** How much the thickness varies in drifts, 0 (even) to 1 (from none to double). Default 0.4. */
  variation?: number;
  /** Width of a drift, metres, 0.25 to 100. Default 4. */
  drift?: number;
  /** Strength of the snow's grain in the normal, 0 to 1. Default 0.3. */
  grain?: number;
  /** Snow colour, linear RGB. Default `SNOW_COLOR`. */
  color?: readonly [number, number, number];
  /** Snow roughness, 0 to 1. Default `SNOW_ROUGHNESS`. */
  roughness?: number;
}

const RANGES: Record<string, readonly [number, number]> = {
  cover: [0, 1],
  depth: [0, 2],
  variation: [0, 1],
  drift: [0.25, 100],
  grain: [0, 1],
  roughness: [0, 1],
};

/** Throws for any invalid field of `o`. */
export function validateSnow(o: SnowOptions): void {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('Snow options must be an object; pass {} for the defaults');
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const value = (o as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new RangeError(`Snow ${key} must be a number from ${min} to ${max}; pass a finite value in range`);
  }
  if (o.color !== undefined) {
    if (
      !Array.isArray(o.color) ||
      o.color.length !== 3 ||
      !o.color.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    )
      throw new TypeError('Snow color needs [r, g, b] linear values of 0 or more; pass an array of three numbers');
  }
  if (
    o.weather !== undefined &&
    (typeof o.weather !== 'object' || o.weather === null || typeof o.weather.snowCover !== 'number')
  )
    throw new TypeError('Snow weather needs a numeric snowCover; pass a WeatherMachine or a sky Weather');
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : Number.isNaN(x) ? 0 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * How much snow covers a surface at world `(x, z)`, 0..1: {@link snowWeight}'s rule (up-facing first, steeper as the
 * cover grows) with the snow line broken up by fine noise, so the edge of the snow is patchy, not a contour.
 */
export function snowAt(x: number, z: number, normalY: number, cover: number): number {
  const c = clamp01(cover),
    threshold = 1 - 0.8 * c,
    jitter = (valueNoise2(x / 0.6, z / 0.6, 8) - 0.5) * 0.1;
  return smoothstep(threshold, threshold + 0.15, normalY + jitter) * smoothstep(0, 0.05, c);
}

/**
 * Thickness of the snow at world `(x, z)` in metres, by which the vertex stage lifts a surface: `depth` times the cover
 * on up-facing surfaces (none on walls), varied in drifts `drift` metres wide by up to `variation`.
 */
export function snowDepthAt(x: number, z: number, normalY: number, cover: number, o: SnowOptions = {}): number {
  const c = clamp01(cover),
    threshold = 1 - 0.8 * c,
    variation = o.variation ?? 0.4,
    drift = o.drift ?? 4;
  return (
    (o.depth ?? 0.12) *
    c *
    smoothstep(threshold, threshold + 0.15, normalY) *
    (1 + variation * (2 * valueNoise2(x / drift, z / drift, 9) - 1))
  );
}

const snowCore = /* wgsl */ `
// a: cover, depth, variation, drift; b: colour, roughness; c: grain.
struct WeatherSnow {a:vec4f, b:vec4f, c:vec4f}
fn weather_snow_at(xz:vec2f, normalY:f32, cover:f32)->f32 {
  let c=clamp(cover,0.0,1.0);let threshold=1.0-0.8*c;
  let jitter=(weather_noise(xz/0.6,8u)-0.5)*0.1;
  return smoothstep(threshold,threshold+0.15,normalY+jitter)*smoothstep(0.0,0.05,c);
}
fn weather_snow_depth(xz:vec2f, normalY:f32, u:WeatherSnow)->f32 {
  let c=clamp(u.a.x,0.0,1.0);let threshold=1.0-0.8*c;
  return u.a.y*c*smoothstep(threshold,threshold+0.15,normalY)*(1.0+u.a.z*(2.0*weather_noise(xz/u.a.w,9u)-1.0));
}
// The grain: the slope of fine noise 8 cm across, turned into a tilt of the normal.
fn weather_snow_normal(xz:vec2f, n:vec3f, w:f32, u:WeatherSnow)->vec3f {
  let q=xz/0.08;let h=weather_noise(q,10u);
  let t=vec2f(weather_noise(q+vec2f(0.25,0),10u)-h,weather_noise(q+vec2f(0,0.25),10u)-h)*4.0*0.15*u.c.x;
  return normalize(mix(n,vec3f(0,1,0),0.5*w)+vec3f(t.x,0.0,t.y)*w);
}
`;

// Core's vertex stage: the world position and normal it computes, which the lift needs before the clip position.
const VERTEX = 'let p=model*vec4f(i.position,1);';
const LIFT =
  'var p=model*vec4f(i.position,1);{let wn=normalize(mat3x3f(cross(i.m1.xyz,i.m2.xyz),cross(i.m2.xyz,i.m0.xyz),cross(i.m0.xyz,i.m1.xyz))*i.normal*sign(dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz))));p.y+=weather_snow_depth(p.xz,wn.y,weatherSnow);}';

/**
 * The shader: `weather_snow_at`, `weather_snow_depth` and `weather_snow_normal`. Paste it ahead of a shader of your
 * own with a `WeatherSnow` uniform bound as `weatherSnow`, or let {@link Snow} patch core's mesh shader.
 */
export const snowWGSL: string = noiseWGSL + snowCore;

/**
 * Snow on every core mesh. `Snow.attach(engine, {weather})` follows a `WeatherMachine` or a sky `Weather`; or set
 * `options.cover` yourself. WebGPU only.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine or when core's mesh
 * shader was replaced, `'disposed'` after `dispose()`.
 * @example
 * const snow = Snow.attach(engine, {weather: machine, depth: 0.2});
 */
export class Snow extends SurfaceHook {
  readonly name: string = 'weather-snow';

  constructor(readonly options: SnowOptions = {}) {
    super(
      'Snow',
      SNOW_BINDING,
      `${snowCore}@group(0) @binding(${SNOW_BINDING}) var<uniform> weatherSnow:WeatherSnow;`,
      new Float32Array(12),
    );
    validateSnow(options);
  }

  static attach(engine: EngineKernel, options: SnowOptions = {}): Snow {
    return SurfaceHook.use(engine, new Snow(options));
  }

  /** Snow cover in use this frame: the weather's, else `options.cover`. */
  get cover(): number {
    return clamp01(this.options.weather?.snowCover ?? this.options.cover ?? 0);
  }

  patch(source: string): string {
    const fragment = patchFragment(
      source,
      '{let n0=normalize(i.normal);let w=weather_snow_at(i.position.xz,n0.y,weatherSnow.a.x);if(w>0.0){i.color=mix(i.color,weatherSnow.b.xyz,w);i.material.x=mix(i.material.x,weatherSnow.b.w,w);i.material.y=i.material.y*(1.0-w);i.normal=weather_snow_normal(i.position.xz,n0,w,weatherSnow);}}',
    );
    // A vertex stage another package replaced keeps its shape: the snow is then a layer of colour and grain only.
    return fragment === source ? source : fragment.replace(VERTEX, () => LIFT);
  }

  protected validate(): void {
    validateSnow(this.options);
  }

  protected write(): void {
    const o = this.options,
      v = this.values,
      color = o.color ?? SNOW_COLOR;
    v[0] = this.cover;
    v[1] = o.depth ?? 0.12;
    v[2] = o.variation ?? 0.4;
    v[3] = o.drift ?? 4;
    v[4] = color[0];
    v[5] = color[1];
    v[6] = color[2];
    v[7] = o.roughness ?? SNOW_ROUGHNESS;
    v[8] = o.grain ?? 0.3;
  }
}
