// How weather changes surfaces: wet ground is darker and shinier, snow settles on surfaces that face up. The same
// formulas exist in JavaScript (for materials you set from code) and in WGSL (for a shader), and the real-GPU test runs
// the WGSL against the JavaScript.
import type { WeatherState } from './state.js';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : Number.isNaN(x) ? 0 : x);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Roughness of a surface after rain: wet surfaces are shinier, down to 35 percent of the dry roughness at wetness 1. */
export function wetRoughness(roughness: number, wetness: number): number {
  return clamp01(roughness) * (1 - 0.65 * clamp01(wetness));
}

/** Colour of a surface after rain: wet surfaces are darker, by up to 25 percent at wetness 1 (linear RGB in, linear RGB out). */
export function wetColor(color: readonly [number, number, number], wetness: number): [number, number, number] {
  const k = 1 - 0.25 * clamp01(wetness);
  return [color[0] * k, color[1] * k, color[2] * k];
}

/**
 * How much snow covers a surface, 0..1. `normalY` is the world-space up component of the surface normal (1 for a floor,
 * 0 for a wall, negative for a ceiling) and `snowCover` the machine's `snowCover`. With no cover nothing is white; as the
 * cover grows, steeper surfaces turn white too (at cover 1, anything tilted less than about 70 degrees from flat).
 */
export function snowWeight(normalY: number, snowCover: number): number {
  const cover = clamp01(snowCover),
    threshold = 1 - 0.8 * cover;
  return smoothstep(threshold, threshold + 0.15, normalY) * smoothstep(0, 0.05, cover);
}

/** Roughness and colour of a surface under a weather state's ground wetness and snow cover. */
export interface SurfaceResponse {
  /** New roughness. */
  roughness: number;
  /** New colour, linear RGB. */
  color: [number, number, number];
}

/** Snow colour (linear RGB) and roughness that `surfaceResponse` blends toward. */
/** Colour (linear RGB) that snow blends toward. */
export const SNOW_COLOR: readonly [number, number, number] = [0.9, 0.92, 0.95];
/** Roughness that snow blends toward. */
export const SNOW_ROUGHNESS = 0.85;

/**
 * Combines both effects for one surface: wet first, then snow over it by {@link snowWeight}. A surface with `normalY`
 * 0.9 under snow cover 0.5 is partly white; a wall stays wet-dark until cover is high.
 */
export function surfaceResponse(
  base: { roughness: number; color: readonly [number, number, number] },
  normalY: number,
  wetness: number,
  snowCover: number,
): SurfaceResponse {
  const wetR = wetRoughness(base.roughness, wetness),
    wetC = wetColor(base.color, wetness),
    w = snowWeight(normalY, snowCover);
  return {
    roughness: wetR + (SNOW_ROUGHNESS - wetR) * w,
    color: [0, 1, 2].map((i) => wetC[i] + (SNOW_COLOR[i] - wetC[i]) * w) as [number, number, number],
  };
}

/**
 * Sets `material.roughness` from a dry roughness and a wetness (a duck-typed hook: any object with a numeric
 * `roughness`, such as a PbrMaterial). Call it each frame, or when `wetness` changes by more than you care about.
 */
export function applyWetness(material: { roughness: number }, dryRoughness: number, wetness: number): void {
  material.roughness = wetRoughness(dryRoughness, wetness);
}

/** Wetness and snow cover the ground settles at when a state lasts long enough. */
export function settledGround(state: Pick<WeatherState, 'rain' | 'hail' | 'snow'>): {
  wetness: number;
  snowCover: number;
} {
  return { wetness: clamp01(Math.max(state.rain, state.hail) * 1.5), snowCover: clamp01(state.snow) };
}

/**
 * The same formulas in WGSL: `weather_wet_roughness`, `weather_wet_color`, `weather_snow_weight` and
 * `weather_surface` (which returns roughness in `.w` and colour in `.xyz`). Paste it ahead of your shader; it declares no
 * bindings. The names carry a `weather_` prefix so they cannot clash with yours.
 */
export const surfaceWGSL = /* wgsl */ `
fn weather_wet_roughness(roughness:f32, wetness:f32)->f32 {
  return clamp(roughness,0.0,1.0)*(1.0-0.65*clamp(wetness,0.0,1.0));
}
fn weather_wet_color(color:vec3f, wetness:f32)->vec3f {
  return color*(1.0-0.25*clamp(wetness,0.0,1.0));
}
fn weather_snow_weight(normalY:f32, snowCover:f32)->f32 {
  let cover=clamp(snowCover,0.0,1.0);
  let threshold=1.0-0.8*cover;
  return smoothstep(threshold,threshold+0.15,normalY)*smoothstep(0.0,0.05,cover);
}
fn weather_surface(roughness:f32, color:vec3f, normalY:f32, wetness:f32, snowCover:f32)->vec4f {
  let wetR=weather_wet_roughness(roughness,wetness);
  let wetC=weather_wet_color(color,wetness);
  let w=weather_snow_weight(normalY,snowCover);
  return vec4f(mix(wetC,vec3f(${SNOW_COLOR[0]},${SNOW_COLOR[1]},${SNOW_COLOR[2]}),w),mix(wetR,${SNOW_ROUGHNESS},w));
}
`;
