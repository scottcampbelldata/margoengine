/// <reference lib="esnext.disposable" preserve="true" />
// Snow that builds on every core mesh: up-facing surfaces whiten first and steeper ones as the cover grows, the snow
// has a grainy surface, and it has depth: the vertex stage lifts covered surfaces by the snow's thickness, which
// varies in drifts. One hook in core's mesh shader (the vertex position and the surface before lighting), one
// 48-byte uniform a frame. The maths has a JavaScript twin (`snowAt`, `snowDepthAt`) that the real-GPU test holds the
// WGSL to.
import type { EngineKernel } from '@margoengine/core';
import { SurfaceHook, noiseWGSL, patchFragment, valueNoise2 } from './scene-patch.js';
import { SNOW_COLOR, SNOW_ROUGHNESS } from './surface.js';
import type { SnowFieldSource } from './snow-drift.js';
import { heldFromWeather } from '../../shared/settings.js';

export type { SnowFieldSource };

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** Bind group 0 slot of the snow uniform in core's mesh shader. */
export const SNOW_BINDING = 161;
/** Bind group 0 slots of a snow field's uniform and its ground and depth map. */
export const SNOW_FIELD_BINDINGS = [164, 165] as const;

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
  /**
   * Snow lying on a ground grid, a `SnowDrift` from `margoengine/weather/snow-drift`: over the grid, surfaces on its
   * ground take its depth (drifts, scoured ridges, cornice debris) and whiten by it, in place of `cover` and `depth`.
   * Adding or removing it rebuilds the shader once. Default none.
   */
  field?: SnowFieldSource;
  /** How far above the field's ground a surface still counts as on it, metres, 0 to 10. Default 0.05. */
  band?: number;
}

const RANGES: Record<string, readonly [number, number]> = {
  cover: [0, 1],
  depth: [0, 2],
  variation: [0, 1],
  drift: [0.25, 100],
  grain: [0, 1],
  roughness: [0, 1],
  band: [0, 10],
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
  const f = o.field as Partial<SnowFieldSource> | undefined;
  if (
    f !== undefined &&
    (typeof f !== 'object' ||
      f === null ||
      typeof f.fieldData !== 'function' ||
      !Number.isInteger(f.width) ||
      !Number.isInteger(f.depth) ||
      f.width! < 2 ||
      f.depth! < 2 ||
      !(f.cellSize! > 0) ||
      !Array.isArray(f.origin))
  )
    throw new TypeError('Snow field needs a SnowDrift (width and depth of 2 or more, cellSize, origin, fieldData)');
}

/** Ground height and snow depth of `field` at world (x, z), bilinear between samples (the edge's within half a cell past it); undefined further out. */
export function snowFieldAt(
  field: SnowFieldSource,
  x: number,
  z: number,
  slack = 0,
): [ground: number, depth: number] | undefined {
  const W = field.width,
    rx = (x - field.origin[0]) / field.cellSize,
    rz = (z - field.origin[1]) / field.cellSize;
  // Half a cell past the edge still reads the edge, so a mesh on the grid's ground never falls off it by rounding.
  const e = 0.5 + slack / field.cellSize;
  if (!(rx >= -e && rz >= -e && rx <= W - 1 + e && rz <= field.depth - 1 + e)) return undefined;
  const gx = Math.min(W - 1, Math.max(0, rx)),
    gz = Math.min(field.depth - 1, Math.max(0, rz));
  const i = Math.min(W - 2, Math.floor(gx)),
    j = Math.min(field.depth - 2, Math.floor(gz)),
    tx = gx - i,
    tz = gz - j,
    d = field.fieldData(),
    out: [number, number] = [0, 0];
  for (let c = 0; c < 2; c++) {
    const k = (j * W + i) * 2 + c,
      a = d[k]!,
      b = d[k + 2]!,
      e = d[k + 2 * W]!,
      h = d[k + 2 * W + 2]!;
    out[c] = a + (b - a) * tx + (e - a) * tz + (a - b - e + h) * tx * tz;
  }
  return out;
}

/**
 * The cover the snow line takes at world (x, y, z) with a field: smoothstep(0.003, 0.03, depth) of the field's snow
 * where the point lies on its ground (up to the snow surface and `band` above), else `cover`. The shader's twin, with
 * `slack` 0 (the shader reads the position at the centroid, on the triangle); a `slack` widens both tests by that
 * many metres (the x and z slack must be equal here).
 */
export function snowFieldCover(
  field: SnowFieldSource,
  x: number,
  y: number,
  z: number,
  cover: number,
  band = 0.05,
  slack: readonly [number, number, number] = [0, 0, 0],
): number {
  const g = snowFieldAt(field, x, z, Math.max(slack[0], slack[2]));
  if (!g || y - slack[1] > g[0] + g[1] + band) return cover;
  return smoothstep(0.003, 0.03, g[1]);
}

/** The lift of a vertex at world (x, y, z) with a field: the field's depth on its ground (within `band`), else {@link snowDepthAt} on flat ground. */
export function snowFieldDepth(
  field: SnowFieldSource,
  x: number,
  y: number,
  z: number,
  cover: number,
  o: SnowOptions = {},
): number {
  const g = snowFieldAt(field, x, z);
  if (!g || y > g[0] + (o.band ?? 0.05)) return snowDepthAt(x, z, 1, cover, o);
  return g[1];
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

// The field: a ground and depth map (rg32float, read with textureLoad and blended by hand like snowFieldAt) over the
// area origin + [0, (size - 1) cell]. area: origin x, z, 1 / cell; size: samples x, z, band.
const fieldCore = /* wgsl */ `
struct WeatherSnowField {area:vec4f, size:vec4f}
@group(0) @binding(${SNOW_FIELD_BINDINGS[0]}) var<uniform> weatherSnowField:WeatherSnowField;
@group(0) @binding(${SNOW_FIELD_BINDINGS[1]}) var weatherSnowMap:texture_2d<f32>;
fn weather_field(xz:vec2f)->vec2f {
  let f=weatherSnowField;let g=(xz-f.area.xy)*f.area.z;let n=f.size.xy-1.0;let e=vec2f(0.5);
  if(any(g<-e)||any(g>n+e)){return vec2f(0,-1);}
  let q=clamp(g,vec2f(0),n);let c=min(floor(q),n-1.0);let t=q-c;let b=vec2i(c);
  let a=textureLoad(weatherSnowMap,b,0).xy;let r=textureLoad(weatherSnowMap,b+vec2i(1,0),0).xy;
  let d=textureLoad(weatherSnowMap,b+vec2i(0,1),0).xy;let h=textureLoad(weatherSnowMap,b+vec2i(1,1),0).xy;
  return a+(r-a)*t.x+(d-a)*t.y+(a-r-d+h)*t.x*t.y;
}
fn weather_snow_field_cover(p:vec3f, cover:f32)->f32 {
  let g=weather_field(p.xz);
  if(g.y<0.0||p.y>g.x+g.y+weatherSnowField.size.z){return cover;}
  return smoothstep(0.003,0.03,g.y);
}
fn weather_snow_field_uniform(p:vec3f, u:WeatherSnow)->WeatherSnow {
  let g=weather_field(p.xz);
  if(g.y<0.0||p.y>g.x+weatherSnowField.size.z){return u;}
  var v=u;v.a.x=1.0;v.a.y=g.y;v.a.z=0.0;return v;
}
`;

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

// Core's vertex stage: the world position it computes, which the lift needs before the clip position. The lift is the
// depth on flat ground at the vertex's place, whatever way its face turns: a flat-shaded box has its own vertices per
// face, and a lift by each vertex's own normal raised the top face off the top of the sides, a gap seen side on.
// Vertices at one place now rise together, so the faces stay joined; a PrecipitationCover keeps sheltered ones down.
const VERTEX = 'let p=model*vec4f(i.position,1);';
const LIFT = 'var p=model*vec4f(i.position,1);p.y+=weather_snow_depth(p.xz,1.0,weatherSnow);';

/**
 * The shader: `weather_snow_at`, `weather_snow_depth` and `weather_snow_normal`. Paste it ahead of a shader of your
 * own with a `WeatherSnow` uniform bound as `weatherSnow`, or let {@link Snow} patch core's mesh shader.
 */
export const snowWGSL: string = noiseWGSL + snowCore;
/** The field's shader (`weather_field`, `weather_snow_field_cover`, `weather_snow_field_uniform` and their bindings), after {@link snowWGSL}. */
export const snowFieldWGSL: string = fieldCore;
const FIELD_LIFT =
  'var p=model*vec4f(i.position,1);p.y+=weather_snow_depth(p.xz,1.0,weather_snow_field_uniform(p.xyz,weatherSnow));';

const OUTPUT = /struct Output \{([^}]+)\}/;
const SET_POSITION = 'o.position=p.xyz;';

/**
 * Core's mesh shader `source` with one more varying, the world position interpolated at the centroid (a covered sample
 * of the pixel, so always on the triangle), at the next free location of `Output`; undefined when the shader has no
 * such struct or no `o.position=p.xyz;` to copy (a replaced vertex stage).
 */
function centroidPosition(source: string): { source: string; name: string } | undefined {
  const m = OUTPUT.exec(source);
  if (!m || !source.includes(SET_POSITION)) return undefined;
  const name = 'weatherSnowAt';
  if (m[1]!.includes(name)) return { source, name };
  let next = 0;
  for (const l of m[1]!.matchAll(/@location\((\d+)\)/g)) next = Math.max(next, Number(l[1]) + 1);
  return {
    name,
    source: source
      .replace(
        OUTPUT,
        (_, body: string) =>
          `struct Output {${body},@location(${next}) @interpolate(perspective,centroid) ${name}:vec3f}`,
      )
      .replace(SET_POSITION, () => `${SET_POSITION}o.${name}=p.xyz;`),
  };
}

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
  private fieldUniform?: GPUBuffer;
  private fieldTexture?: GPUTexture;
  private fieldVersion = -1;
  private fieldDevice?: GPUDevice;

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

  /** Snow cover in use this frame: the weather's, else `options.cover` (a cover held by `applySnowSettings` wins). */
  get cover(): number {
    const o = this.options;
    // A cover set by hand through the settings is an override: it wins over the weather until handed back (null).
    if (o.cover !== undefined && heldFromWeather(o, 'cover')) return clamp01(o.cover);
    return clamp01(o.weather?.snowCover ?? o.cover ?? 0);
  }

  protected override variant(): string {
    return this.options.field ? 'field' : '';
  }

  protected override shaderDeclarations(): string {
    const base = `${snowCore}@group(0) @binding(${SNOW_BINDING}) var<uniform> weatherSnow:WeatherSnow;`;
    return this.options.field ? base + fieldCore : base;
  }

  protected override extraBindings(device: GPUDevice): GPUBindGroupEntry[] {
    const f = this.options.field;
    if (!f) return [];
    if (this.fieldDevice !== device) this.releaseExtra();
    this.fieldDevice = device;
    if (!this.fieldUniform)
      this.fieldUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const t = this.fieldTexture;
    if (!t || t.width !== f.width || t.height !== f.depth) {
      t?.destroy();
      this.fieldTexture = device.createTexture({
        size: [f.width, f.depth],
        format: 'rg32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.fieldVersion = -1;
    }
    if (this.fieldVersion !== f.version) {
      device.queue.writeTexture(
        { texture: this.fieldTexture! },
        f.fieldData() as Float32Array<ArrayBuffer>,
        { bytesPerRow: f.width * 8, rowsPerImage: f.depth },
        [f.width, f.depth],
      );
      this.fieldVersion = f.version;
    }
    device.queue.writeBuffer(
      this.fieldUniform,
      0,
      new Float32Array([f.origin[0], f.origin[1], 1 / f.cellSize, 1, f.width, f.depth, this.options.band ?? 0.05, 0]),
    );
    return [
      { binding: SNOW_FIELD_BINDINGS[0], resource: { buffer: this.fieldUniform } },
      { binding: SNOW_FIELD_BINDINGS[1], resource: this.fieldTexture!.createView() },
    ];
  }

  protected override releaseExtra(): void {
    this.fieldUniform?.destroy();
    this.fieldTexture?.destroy();
    this.fieldUniform = undefined;
    this.fieldTexture = undefined;
    this.fieldVersion = -1;
  }

  patch(source: string): string {
    // A multisampled edge pixel runs its fragment at the pixel centre, which may lie off the triangle, so a position read
    // there is extrapolated, a long way on a surface seen edge on. The field's tests read the position through their own
    // varying interpolated at the centroid (a covered sample, so a point on the triangle), which is exact.
    const field = this.options.field ? centroidPosition(source) : undefined;
    const coverOf = field
      ? `weather_snow_field_cover(i.${field.name},weatherSnow.a.x)`
      : this.options.field
        ? 'weather_snow_field_cover(i.position,weatherSnow.a.x)'
        : 'weatherSnow.a.x';
    const fragment = patchFragment(
      field ? field.source : source,
      `{let n0=normalize(i.normal);let w=weather_snow_at(i.position.xz,n0.y,${coverOf});if(w>0.0){i.color=mix(i.color,weatherSnow.b.xyz,w);i.material.x=mix(i.material.x,weatherSnow.b.w,w);i.material.y=i.material.y*(1.0-w);i.normal=weather_snow_normal(i.position.xz,n0,w,weatherSnow);}}`,
    );
    // A vertex stage another package replaced keeps its shape: the snow is then a layer of colour and grain only.
    if (fragment === (field ? field.source : source)) return source;
    return fragment.replace(VERTEX, () => (this.options.field ? FIELD_LIFT : LIFT));
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
