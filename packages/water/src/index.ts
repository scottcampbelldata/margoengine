/// <reference lib="esnext.disposable" preserve="true" />
import { resolveMSAA, sceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { acquireDepth, group } from '../../shared/gpu.js';
import { CoastalFlow, NO_FILL, waterFrame, oceanWaves } from './coastal.js';
import { WATER_FLOW_TICKS_PER_FRAME } from './film.js';
import { coastSurf, surfWaves } from './surf.js';
import { Spray } from './spray.js';
import { displayShader } from '../../shared/display.js';
import { margoError, fault } from '../../shared/errors.js';
import { MargoError } from '@margoengine/math/errors';
import { checkFog, FOG_BYTES, fogWgsl, writeFog, type FogLike } from '../../shared/fog.js';
export type { FogLike } from '../../shared/fog.js';
import { breakerDepth, contourSegments, type TerrainHeights } from './breaker.js';
export { BREAKER_GAMMA, breakerDepth, contourSegments, type BreakerWave, type TerrainHeights } from './breaker.js';
import { applyView, ViewStates } from '../../shared/view-rect.js';
import { ggxDenominatorOf } from '../../shared/light-terms.js';
import { queryStates, riverKernels, surfacePasses, waterSolvers, type WaterSolver } from './query-state.js';
import { surfaceEffects } from './surface-effects.js';
import { unitLight } from '../../shared/unit-light.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { seaState, whitecapCoverage } from './sea-state.js';
import { publishSurfaceDepth } from '../../shared/surface-depth.js';
import {
  skyCoordinates,
  skyTexture,
  validWaterSky,
  writeSkySampling,
  type WaterSkyEnvironment,
} from './sky-radiance.js';
export type { WaterSkyEnvironment } from './sky-radiance.js';
declare const GPUBufferUsage: {
  VERTEX: number;
  INDEX: number;
  UNIFORM: number;
  COPY_SRC: number;
  COPY_DST: number;
  STORAGE: number;
};
declare const GPUTextureUsage: {
  COPY_SRC: number;
  COPY_DST: number;
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Wind over open water: the sea it raises goes into the swell trains (see `@margoengine/water/sea-state`). */
export interface WaterWind {
  /** Speed at 10 m, m/s, 0 to 100. */
  speed: number;
  /** Fetch in metres, 1 to 1e7. Default 100,000. */
  fetch?: number;
  /** Direction the waves travel, XZ, nonzero. Default [1, 0.3]. */
  direction?: readonly [number, number];
}
/** A film clock Water steps on (`WaterOptions.clock`): `FilmClock` of `@margoengine/math/clock` is one. */
export interface WaterClock {
  /** Whole ticks of `rate` a second up to the clock's time. */
  ticks(rate: number): number;
  /** The clock's time, seconds. */
  readonly time: number;
}
/**
 * A sea Water draws (`WaterOptions.sea`): its linear waves at time `t` seconds, written into `out` four numbers a wave
 * (kx, kz in rad/m, amplitude in m, phase in rad at `t`, so a wave's height at (x, z) is amplitude cos(kx x + kz z +
 * phase)); returns how many. `SpectralSea` of `@margoengine/physics/sea` is one.
 */
export interface WaterSea {
  waveComponents(t: number, out: Float32Array): number;
}
/** One swell train: three Gerstner components around this direction and wavelength. Invalid values throw RangeError. */
export interface Wave {
  /** Travel direction in the XZ plane (any nonzero length). */
  direction: readonly [number, number];
  /** Height in world units, 0-100. */
  amplitude: number;
  /** Crest spacing in world units, 0-100,000 (exclusive of 0). */
  wavelength: number;
  /** Gerstner crest sharpness, 0..1; rejected (coded failed) when it would fold the surface. Default 0.5. */
  steepness?: number;
  /** Phase offset in radians. Default 0. */
  phase?: number;
}
/** The most cells a Water terrain may have per side: every WebGPU device can make a 2D texture this wide. */
const WATER_TERRAIN_MAX = 8192;
/** Terrain coupling: a borrowed heightmap the shallow-water flow, foam and spray run on. */
export interface WaterTerrain {
  /**
   * World-space Y heights in a sampleable `r32float` 2D texture, 2 cells per side up to the device's
   * `maxTextureDimension2D` (8,192 on every WebGPU device), within its storage-buffer binding limit; read every frame.
   */
  heightmap: () => GPUTexture | undefined;
  /** World XZ of the heightmap's first texel corner. */
  origin: readonly [number, number];
  /** World XZ extent the heightmap covers, each 0-100,000 (exclusive of 0). */
  size: readonly [number, number];
  /**
   * The same heights on the CPU (`data` row by row along z, `width` x `height` texels, the size of the heightmap), for
   * {@link Water.breakerLine}. Omitted: the breaker line is empty. Read when the line is asked for.
   */
  heights?: TerrainHeights;
}
/** A directional light record for glints and foam, such as an entry of `sky.lights`. */
export interface WaterLight {
  /** XYZ towards the light (nonzero, normalised here) plus intensity (>= 0) in the fourth element. */
  direction: ArrayLike<number>;
  /** Linear RGB radiance, each >= 0. */
  radiance: ArrayLike<number>;
}
/** What Water reads from `Shadows` (@margoengine/shadows): its sampling WGSL for a bind group, and that group's entries. */
export interface WaterShadowSource {
  pbr(group: number): { readonly declarations: string };
  bindings(): GPUBindGroupEntry[];
}
/** What `setCapture` takes: `@margoengine/post` SSR's material capture hook (its `SSRCapture`), declared here so water
 * does not import post. */
export interface WaterCapture {
  /** Module-scope WGSL for the water shader `code`: `struct MargoSSR` (specular to replace + roughness, weight + coverage,
   * normal) among the rest. */
  declarations(code: string): string;
  /** Colour targets of the capture pass, in `MargoSSR` location order. */
  readonly targets: readonly GPUColorTargetState[];
  /** This frame's capture pass: these targets and a depth attachment of the context's format; ended by the owner. */
  begin(): GPURenderPassEncoder;
}
/** At most this many samples in a {@link WaterFarField} profile. */
export const WATER_FAR_SAMPLES = 64;
const FAR_FLOATS = 8 + WATER_FAR_SAMPLES;
// The far field's first value in the frame uniform: after the viewport row (140..143).
const FAR_AT = 144;
// The sea's waves in the frame uniform (`WaterOptions.sea`): a header row (the count) after the far field, then one row
// (kx, kz, amplitude, phase at the frame's time) per wave. 896 rows keep the whole uniform under the 16 KiB a uniform
// block may hold on WebGL2 (GL_MAX_UNIFORM_BLOCK_SIZE is at least 16,384 bytes) and hold every bin of the wave solver's
// default 34 x 24 spectrum.
const SEA_AT = FAR_AT + FAR_FLOATS;
/** The most waves a {@link WaterSea} may give Water to draw. */
export const WATER_SEA_WAVES = 896;
export { WATER_FLOW_TICKS_PER_FRAME };
// One tick's slice of the frame uniform: everything before the sea's rows, which the flow and the spray read.
const TICK_FLOATS = SEA_AT + 4;
const TICK_BYTES = TICK_FLOATS * 4;
/** The flow's tick rate for `substeps` substeps a frame: the dyadic rate 60 * 2^k Hz at or above 60 * substeps. */
const flowRate = (substeps: number): number => {
  let rate = 60;
  for (let s = 1; s < substeps; s *= 2) rate *= 2;
  return rate;
};
/**
 * The open sea past a flood's 'sea' sides (`Water.setFarField`; `water/flood` sets it every frame): a long wave
 * travelling on to the map from outside it, and the sim's own edge level carried out from the coastal grid.
 */
export interface WaterFarField {
  /** The sides of the coastal grid (the `terrain` rectangle) the sea lies beyond. */
  sides: { west?: boolean; east?: boolean; south?: boolean; north?: boolean };
  /**
   * The incoming wave's rise over the sea level, metres, at evenly spaced distances 0..`range` past the sea sides (2 to
   * 64 samples; the first is the edge, usually 0). Past `range` the last sample holds.
   */
  profile: ArrayLike<number>;
  /** Metres past the sea sides that `profile` covers, above 0 to 1e7. */
  range: number;
  /**
   * The length L in metres the sim's edge level spreads from: its difference from the sea level falls as 1 / sqrt(1 + r / L)
   * r metres out (a long wave leaving an edge of length L). Above 0 to 1e7; default the coastal grid's longer side.
   */
  spread?: number;
}
/** Water settings, read at construction unless noted. Invalid values throw RangeError or TypeError. */
export interface WaterOptions {
  /** Grid extent in world units (X, Z), each 0-100,000 (exclusive of 0). Default [100, 100]. */
  size?: readonly [number, number];
  /** Grid cells per side, an integer 1-512. Default 128. */
  segments?: number;
  /** Mean sea level, world Y. Default 0. Live through `setSeaLevel`. */
  height?: number;
  /**
   * 1-8 swell trains. Default the eight trains of the sea of `wind`, which is 6 m/s when neither is given. Passing
   * `waves` keeps exactly those trains (the old default was two trains along [1, 0.3] and [1, 0.6], amplitudes 0.3 and
   * 0.15: pass them to get that sea back) and `setWind` then throws.
   */
  waves?: readonly Wave[];
  /**
   * Wind at 10 m (m/s, or `{ speed, fetch, direction }`): the swell trains become the fetch-limited JONSWAP sea of that
   * wind on eight fixed wavelengths, so `setWind` changes only their amplitudes, directions and steepness. Ignored when
   * `waves` is given. Default 6 m/s (a gentle breeze: 0.17% of the sea under foam, no whitecaps option needed).
   */
  wind?: number | WaterWind;
  /** Deep-water colour, linear RGB 0..1. Default [0.01, 0.18, 0.25]. */
  color?: readonly [number, number, number];
  /** Shoreline foam width in world units, 0-100 (exclusive of 0). Default 1. */
  foamDistance?: number;
  /** Scene depth provider; pass `() => effect.depthTexture` when Bloom, SSAO or DOF owns the capture. Default: Water's own. */
  depth?: () => GPUTexture | undefined;
  /**
   * The physics sea to draw (`SpectralSea` of `@margoengine/physics/sea`, or anything with `waveComponents`): its waves
   * replace the swell trains, as the linear waves the sea's own query sums, at Water's time, so a hull floats on the waves
   * the camera sees. The wind still drives the ripples, glints and foam patterns. Default none: the swell trains.
   */
  sea?: WaterSea;
  /**
   * A film clock (`FilmClock` of `@margoengine/math/clock`). With one, the wave clock is the film clock's time, and the
   * coastal or river flow and its spray step in fixed ticks of 60 * 2^k Hz (240 for the coast's three substeps, 480 for a
   * river's eight), as many as the clock owes since the last frame and at most `WATER_FLOW_TICKS_PER_FRAME` a frame
   * (`settle()` runs the rest): the same shot at 24, 30 or 60 fps flows the same water at the times it shares, a slow frame
   * loses no time, and a seek is setting the clock (back too: the flow starts again and replays). Each tick's wave time
   * and step are worked out on the CPU and reach the GPU in a ring of frame-uniform slices. Default none: the flow steps
   * by the frame's delta, as before.
   */
  clock?: WaterClock;
  /** Shallow-water coupling with a terrain heightmap. Omitted: open water only. */
  terrain?: WaterTerrain;
  /**
   * Standing water over `terrain`, read once per heightmap texel when the flow starts: the water surface height at world
   * `(x, z)`, or undefined for none (a non-finite result counts as none). Cells below it fill up to it; a cell whose ground
   * stands above it stays dry and holds that height for the mesh around it. Needs `terrain`.
   */
  fill?: (x: number, z: number) => number | undefined;
  /**
   * The water stands: no flow passes after the first frame, the surface stays at `fill` (a sloped one included) and at
   * sea level, and costs nothing but the draw. Needs `terrain`, not `spray`. Default false.
   */
  still?: boolean;
  /** Borrowed sky texture (sampleable `rgba16float`), e.g. `() => sky.reflectionTexture`. Omitted: a sky gradient. */
  reflection?: () => GPUTexture | undefined;
  /** Borrowed HDR Environment with live rotation and radiance scale. Takes precedence over reflection. */
  reflectionEnvironment?: WaterSkyEnvironment;
  /** Borrowed viewport-sized `rgba16float` scene colour with COPY_SRC, for refraction. Omitted: an approximate seabed. */
  sceneColor?: () => GPUTexture | undefined;
  /** Up to two directional lights for glints, e.g. `sky.lights`; read every frame. Default: the engine light. */
  lights?: readonly WaterLight[];
  /** A GPU spray pool of `sprayCount` droplets; needs `terrain`. Default false. */
  spray?: boolean;
  /** Droplets in the spray pool, a multiple of 64 from 64 to 65,536 (32 B each). Default 4,096. Read at construction. */
  sprayCount?: number;
  /** Open ocean: regular rows follow the camera, outer rows widen to 10 km, the last one to the horizon. Default false. */
  horizon?: boolean;
  /**
   * The engine light's shadow map: `Shadows` from @margoengine/shadows, attached to the same engine. Glints and foam
   * lose that light where it is blocked; without it they are lit everywhere.
   */
  shadows?: WaterShadowSource;
  /**
   * Breaking whitecaps, 0-1: steep crests break white in patches, with long foam streaks down-wind toward 1 (a gale);
   * with `terrain`, foam lines ring the land and the breakers, and with `spray` the spray, grow with it; foam takes the
   * sky's light too. 0 (the default) keeps the gentle crest foam only. Live through `setWhitecaps`.
   * With `wind` and no `whitecaps`, the foam follows the wind instead: it covers 3.84e-6 U^3.41 of the sea at U m/s
   * (0.5% at 8, 4% at 15, 22% at 25; none below 3 m/s), whatever the chop (Monahan and O'Muircheartaigh 1980). Passing
   * `whitecaps` sets the foam by hand (0 is none).
   */
  whitecaps?: number;
  /** Wind chop on the swell, 0-1: stronger ripples and a short wind-sea layer in the normals. Default 0. Live through `setChop`. */
  chop?: number;
}
// The foam that reaches half white covers fewer crests than pass the threshold (whitecap() thins and breaks them into
// patches), so the threshold's standard score z sits below the score y of the share to cover. Measured on the WebGPU
// path in a top-down 200 m view at U 4 to 25 (test/whitecap-coverage.browser.mjs): the pairs (y, z), ascending.
const FOAM_Y = [0.26, 0.994, 1.65, 2.07, 2.4, 2.77, 2.93, 3.11, 3.33, 3.59, 4.2] as const;
const FOAM_Z = [0.126, 0.806, 1.41, 1.79, 2.06, 2.36, 2.45, 2.54, 2.61, 2.63, 2.8] as const;
// The standard deviation of the patch noise added to the crest, the lowest wind with foam (Beaufort 2 to 3) and the three
// components (share of the amplitude, wavenumber scale) of every swell train, as in oceanWaves.
const FOAM_NOISE = 0.025;
const FOAM_MIN_WIND = 3;
// The mean square slope of Water's ripple layers at chop 0, measured on the noise they are made of.
const GLINT_RIPPLES = 0.003;
// GGX's lobe falls to half at 0.64 alpha, a Gaussian slope density at sigma sqrt(2 ln 2); with alpha squared the mean
// square slope 2 sigma squared that is a lobe 1.69 times too narrow in alpha squared. The sun's glint also falls with the
// geometry terms across the lobe, which narrows it further: 2.6 puts its half width on Cox and Munk's at U 2 and 12
// (test/glitter.browser.mjs).
const GLINT_LOBE = 2.6;
const SWELL_COMPONENTS = [
  [0.4, 1],
  [0.35, 0.84],
  [0.25, 1.18],
] as const;
/** The score y with a standard normal above it for a share p in (0, 1): Abramowitz and Stegun 26.2.23 (error under 5e-4). */
function upperScore(p: number): number {
  if (p > 0.5) return -upperScore(1 - p);
  const t = Math.sqrt(-2 * Math.log(p));
  return t - (2.515517 + t * (0.802853 + t * 0.010328)) / (1 + t * (1.432788 + t * (0.189269 + t * 0.001308)));
}
/** The wind of a Water given neither `waves` nor `wind`, m/s at 10 m. */
const DEFAULT_WIND = 6;
const windOf = (wind: number | WaterWind): WaterWind => (typeof wind === 'number' ? { speed: wind } : wind);
const seaOf = (wind: number | WaterWind) => {
  const w = windOf(wind);
  return seaState(w.speed, { fetch: w.fetch, direction: w.direction });
};
// Sources: Gerstner waves (Fournier & Reeves 1986; Tessendorf 2001 sec. 3); Schlick 1994 Fresnel with F0 0.02 =
// ((1.33 - 1) / (1.33 + 1))^2; sun glint GGX D (Walter et al. 2007) with the Schlick-GGX k = (r + 1)^2 / 8 of Karis
// 2013; roughness from normal variance after Toksvig 2005 and LEAN (Olano & Baker 2010); Lambert / pi foam; display
// Khronos PBR Neutral then sRGB (IEC 61966-2-1). Absorption (0.38, 0.10, 0.045) /m is Margo art of the order of
// pure-water absorption (Pope & Fry 1997); seabed, foam and scatter colours, the sky blur, the roughness constants and
// the ripple layers are Margo tuning.
// Refraction follows the Snell-bent ray in the opaque depth image, with attenuation over the same path as the sample.
// See docs/clean-room.md (above-water refraction) for the depth intersection and the optical fallback.
// Whitecaps (frame.grid.z, 0 draws none; whitecap()): a crest breaks where its components' summed slope a*k*sin, read a
// little ahead of the crest where spilling foam runs down the face, passes a threshold that falls as the amount rises;
// gradient noise breaks it into patches, densest and whitest where the crest stands furthest past the threshold and
// thinning softly into the water away from it, broken by down-wind streaks (long along the wind, thin across) and holed
// into bubbly foam by two finer octaves (until 2026-11-13 a 0.04 edge and white through, so near the camera caps drew
// as flat grey patches with hard edges; before that soft-edged and at most 0.6 of foam at a distance, so they read as
// grey blotches), and toward a gale long streaks lie down-wind (Beaufort 8 and up). Thresholds and noise scales are
// Margo tuning. Foam lines that the backwash carries out from the shore, wider than the shoreline band, follow
// landNearby(): how much land lies round a point of the coastal grid, ground at or above the sea in 18 taps on three
// rings of 1.2, 2.4 and 3.6 foam distances, nearer rings weighing more (0 in open water, about 0.5 beside a straight
// cliff). Wind chop (frame.grid.w): the ripple layers grow and a short wind-sea layer joins them, turned -5 degrees.
// With whitecaps on, foam also takes the light of the sky above it: a Lambert surface under a sky of radiance L returns
// about the cosine-weighted mean of L over the sky (irradiance over pi). foamSky() takes that mean over the whole upper
// sky in eight directions: two rings of four, 30 and 60 degrees up, turned 45 degrees from each other (cosine-weighted
// quadrature with equal weights: the sines of the elevations are the square roots of 1/4 and 3/4). The zenith alone, or
// the sky behind the viewer, misses the bright horizon band of an overcast deck lit from one side and leaves foam
// darker than the water that reflects it.
const shader =
  waterFrame +
  oceanWaves +
  surfWaves +
  `
const HORIZON=false;
const STILL=false;
// The most the shoreline term alone makes foam, before the grain.
const SHORE_FOAM=0.35;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var history:texture_2d<f32>;
@group(0) @binding(3) var coast:texture_2d<f32>;
@group(0) @binding(4) var environment:texture_2d<f32>;
@group(0) @binding(5) var skySampler:sampler;
@group(0) @binding(6) var opaque:texture_2d<f32>;
@group(0) @binding(7) var<storage,read> connected:array<u32>;
fn inCoast(xz:vec2f)->bool {let uv=(xz-frame.coast.xy)/frame.coast.zw;return frame.flow.w>0.5&&all(uv>=vec2f(0))&&all(uv<=vec2f(1));}
// Match offshore displacement, normals and optics across the finite simulation boundary.
fn coastBlend(xz:vec2f)->vec3f {
 let edges=vec4f(xz-frame.coast.xy,frame.coast.xy+frame.coast.zw-xz);let distance=min(min(edges.x,edges.y),min(edges.z,edges.w));
 let width=min(max(4.0,4.0*max(frame.flow.y,frame.flow.z)),min(frame.coast.z,frame.coast.w)*0.25);let t=clamp(distance/width,0.0,1.0);let slope=6.0*t*(1.0-t)/width;
 var gradient=vec2f(0);if(distance==edges.x){gradient.x=slope;}else if(distance==edges.y){gradient.y=slope;}else if(distance==edges.z){gradient.x=-slope;}else{gradient.y=-slope;}
 return vec3f(gradient,t*t*(3.0-2.0*t));
}
struct CoastalSample {water:vec4f,normal:vec3f,surface:f32,blend:vec3f,ocean:f32,edge:f32}
fn coastal(xz:vec2f)->CoastalSample {
 let size=vec2i(textureDimensions(coast));let uv=(xz-frame.coast.xy)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let a=textureLoad(coast,lo,0);let b=textureLoad(coast,vec2i(hi.x,lo.y),0);let c=textureLoad(coast,vec2i(lo.x,hi.y),0);let d=textureLoad(coast,hi,0);
 let standing=vec4f(a.x,b.x,c.x,d.x);var levels=vec4f(a.x+a.y,b.x+b.y,c.x+c.y,d.x+d.y);var has=standing;var signed=standing;
 // A still surface: a dry cell keeps its fill's level, so the mesh beside a narrow channel is not pulled down to the sea,
 // and its negative depth puts the waterline between texels, where a clamped 0 would stair it along them.
 if(STILL){let fill=vec4f(a.w,b.w,c.w,d.w);levels=select(fill,levels,standing>vec4f(0.003));has=select(standing,vec4f(1),fill>vec4f(-1e29));signed=select(select(vec4f(-1),fill-vec4f(a.y,b.y,c.y,d.y),fill>vec4f(-1e29)),standing,standing>vec4f(0.003));}
 let weights=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y)*step(vec4f(0.003),has);
 let total=dot(weights,vec4f(1));let surface=select(frame.settings.y,dot(weights,levels)/max(0.0001,total),total>0.0001);
 let h=select(vec4f(surface),levels,has>vec4f(0.003));
 let dx=mix(h.y-h.x,h.w-h.z,t.y)/max(0.0001,frame.flow.y);let dz=mix(h.z-h.x,h.w-h.y,t.x)/max(0.0001,frame.flow.z);
 let depths=max(vec4f(0),vec4f(frame.settings.y)-vec4f(a.y,b.y,c.y,d.y));
 let indices=vec4u(u32(lo.y*size.x+lo.x),u32(lo.y*size.x+hi.x),u32(hi.y*size.x+lo.x),u32(hi.y*size.x+hi.x))+1u;
 // With the surf field the analytic surf runs into SURF_SWASH and the flow carries the inner surf and swash (surfSea).
 let band=select(vec2f(0.65,2.4),SURF_SWASH,surfReady(u32(size.x*size.y)));
 let sea=smoothstep(vec4f(band.x),vec4f(band.y),depths)*vec4f(select(0.0,1.0,connected[indices.x]==0u),select(0.0,1.0,connected[indices.y]==0u),select(0.0,1.0,connected[indices.z]==0u),select(0.0,1.0,connected[indices.w]==0u));
 let ocean=mix(mix(sea.x,sea.y,t.x),mix(sea.z,sea.w,t.x),t.y);let gradient=vec2f(mix(sea.y-sea.x,sea.w-sea.z,t.y)/frame.flow.y,mix(sea.z-sea.x,sea.w-sea.y,t.x)/frame.flow.z);let edge=coastBlend(xz);
 let blend=vec3f(edge.xy*(1.0-ocean)-edge.z*gradient,edge.z*(1.0-ocean));
 return CoastalSample(mix(mix(a,b,t.x),mix(c,d,t.x),t.y),normalize(vec3f(-dx,1,-dz)),surface,blend,ocean,mix(mix(signed.x,signed.y,t.x),mix(signed.z,signed.w,t.x),t.y));
}
struct SurfHere {surf:Surf,weight:f32}
// The surf at a point of the coastal grid and how much of it shows (0 off the field and toward the grid's edge).
fn surfHere(xz:vec2f,sampleWidth:f32,foam:bool)->SurfHere {
 let size=vec2i(textureDimensions(coast));let field=surfField(xz,size);
 if(STILL||field.weight<=0.0){return SurfHere(Surf(vec3f(0),vec3f(0),vec3f(0),0.0,0.0,vec2f(0),0.0,vec2f(0)),0.0);}
 let uv=(xz-frame.coast.xy)/frame.coast.zw;let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let ground=mix(mix(textureLoad(coast,lo,0).y,textureLoad(coast,vec2i(hi.x,lo.y),0).y,t.x),mix(textureLoad(coast,vec2i(lo.x,hi.y),0).y,textureLoad(coast,hi,0).y,t.x),t.y);
 return SurfHere(surfSample(xz,sampleWidth,frame.settings.y-ground,field,foam),field.weight*coastBlend(xz).z);
}
// The open sea past a flood's 'sea' sides (setFarField; frame.far[0] the sea sides west, east, south, north as 1 or 0,
// frame.far[1] the range, the sample count, the spreading length and 1 when on, frame.far[2..17] the samples). Outside
// the coastal grid the long wave travels on to and from the map (Blayo and Debreu 2005): the incoming part is the
// sampled rise over the edge's level at r metres out, r the distance past the sea sides; the outgoing part is the
// sim's own edge level less the sea level, read at the nearest point of the grid where water stands there and spread
// as 1 / sqrt(1 + r / L) (a long wave from an edge of length L, Lamb 1932 sec. 191), so the open sea meets the sim's
// edge with no step, whatever the side lets in (FG-06).
fn farSample(i:u32)->f32 {return frame.far[2u+i/4u][i%4u];}
fn farSea(xz:vec2f)->f32 {
 let on=frame.far[1];if(on.w<0.5){return 0.0;}
 let lo=frame.coast.xy;let hi=lo+frame.coast.zw;let sides=frame.far[0];
 let beyond=vec4f(lo.x-xz.x,xz.x-hi.x,lo.y-xz.y,xz.y-hi.y);
 let r=max(0.0,max(max(beyond.x*sides.x,beyond.y*sides.y),max(beyond.z*sides.z,beyond.w*sides.w)));
 let count=u32(on.y);let s=clamp(r/max(on.x,0.001),0.0,1.0)*f32(count-1u);let i=min(u32(floor(s)),count-1u);let j=min(i+1u,count-1u);
 let incoming=mix(farSample(i),farSample(j),s-f32(i));
 let m=max(max(beyond.x,beyond.y),max(beyond.z,beyond.w));
 let nearest=select(select(select(sides.w,sides.z,beyond.z==m),sides.y,beyond.y==m),sides.x,beyond.x==m);
 if(nearest<0.5||frame.flow.w<0.5){return incoming;}
 let size=vec2i(textureDimensions(coast));let uv=(clamp(xz,lo,hi)-lo)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let a0=vec2i(floor(pixel));let a1=min(a0+1,size-1);let t=fract(pixel);
 let a=textureLoad(coast,a0,0);let b=textureLoad(coast,vec2i(a1.x,a0.y),0);let c=textureLoad(coast,vec2i(a0.x,a1.y),0);let d=textureLoad(coast,a1,0);
 let w=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y);let depth=vec4f(a.x,b.x,c.x,d.x);
 let wet=w*smoothstep(vec4f(0.0),vec4f(0.5),depth);let total=dot(wet,vec4f(1));
 if(total<0.0001){return incoming;}
 let level=dot(wet,depth+vec4f(a.y,b.y,c.y,d.y))/total;
 return incoming+(level-frame.settings.y)*min(1.0,total/dot(w,vec4f(1)))/sqrt(1.0+r/max(on.z,1.0));
}
struct Surface {position:vec3f,normal:vec3f,crest:f32}
fn surface(xz:vec2f,sampleWidth:f32)->Surface {
 let far=farSea(xz);var p=vec3f(xz.x,frame.settings.y+far,xz.y);var tangent=vec3f(1,0,0);var binormal=vec3f(0,0,1);var crest=0.0;
 // The far sea's slope, by forward differences half a metre long (it varies over hundreds of metres).
 if(frame.far[1].w>0.5){tangent.y=(farSea(xz+vec2f(0.5,0))-far)*2.0;binormal.y=(farSea(xz+vec2f(0,0.5))-far)*2.0;}
 for(var j=0u;j<u32(frame.settings.w);j++){
  let w=frame.waves[j];
  for(var component=0u;component<3u;component++){
   let wave=swell(w,xz,component,sampleWidth);let d=wave.direction;let a=wave.amplitude;
   // The bend's maximum gradient needs this margin to retain the existing nonfolding bound.
   let q=w.shape.x*0.9;let s=sin(wave.phase);let c=cos(wave.phase);
   p+=vec3f(q*a*d.x*c,a*s,q*a*d.y*c);
   let derivative=vec3f(-q*a*d.x*s,a*c,-q*a*d.y*s);
   tangent+=derivative*wave.gradient.x;binormal+=derivative*wave.gradient.y;
   crest=max(crest,smoothstep(0.75,0.98,s)*smoothstep(0.14,0.32,a*length(wave.gradient)));
  }
 }
 // The physics sea's linear waves (WaterOptions.sea), as its own query sums them: height a cos(theta) with no sideways
 // displacement, theta brought into [-pi, pi] where WGSL bounds sin and cos to 2^-11, each faded out where the mesh
 // samples it fewer than twice a wavelength (the swell's filter).
 for(var n=0u;n<u32(frame.sea.x);n++){
  let w=frame.seaWaves[n];let theta=w.x*xz.x+w.y*xz.y+w.w;let r=theta-6.2831853*round(theta*0.15915494);
  let a=w.z*swellFilter(length(w.xy),sampleWidth);let s=sin(r);
  p.y+=a*cos(r);tangent.y-=a*w.x*s;binormal.y-=a*w.y*s;
 }
 if(inCoast(xz)){
  // p = mix(p, base + offset, w) = p (1 - w) + w base + A with A = w offset. The surf's offset and weight both change
  // with depth, so their derivatives come from forward differences of A and w (1 cm) rather than the flat-bed ones.
  // One loop over the three points keeps a single copy of the surf in the compiled shader (water/caustics and the
  // capture recompile this function).
  let e=0.01;let steps=array<vec2f,3>(vec2f(0),vec2f(e,0),vec2f(0,e));
  var weights:array<f32,3>;var shifted:array<vec3f,3>;var offset=vec3f(0);var surfCrest=0.0;
  for(var k=0u;k<3u;k++){
   let here=surfHere(xz+steps[k],sampleWidth,false);weights[k]=here.weight;shifted[k]=here.surf.offset*here.weight;
   if(k==0u){if(here.weight<=0.0){break;}offset=here.surf.offset;surfCrest=here.surf.crest;}
  }
  let w=weights[0];
  if(w>0.0){
   let base=vec3f(xz.x,frame.settings.y,xz.y);
   let wx=(weights[1]-w)/e;let wz=(weights[2]-w)/e;let ax=(shifted[1]-shifted[0])/e;let az=(shifted[2]-shifted[0])/e;
   tangent=tangent*(1.0-w)+vec3f(w,0,0)+(base-p)*wx+ax;binormal=binormal*(1.0-w)+vec3f(0,0,w)+(base-p)*wz+az;
   p=mix(p,base+offset,w);crest=mix(crest,surfCrest,w);
  }
  let v=coastal(xz);let blend=v.blend;let shore=vec3f(xz.x,v.surface,xz.y);let delta=shore-p;
  tangent=mix(tangent,vec3f(1,-v.normal.x/max(0.0001,v.normal.y),0),blend.z)+delta*blend.x;
  binormal=mix(binormal,vec3f(0,-v.normal.z/max(0.0001,v.normal.y),1),blend.z)+delta*blend.y;
  p=mix(p,shore,blend.z);
 }
 return Surface(p,normalize(cross(binormal,tangent)),crest);
}
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) world:vec3f,@location(2) crest:f32,@location(3) xz:vec2f}
// A horizon grid follows the camera in whole cells (frame.grid.xy), so every term still reads fixed world positions.
@vertex fn vertex(@location(0) grid:vec2f,@location(1) sampleWidth:f32)->Output {
 var xz=grid;if(HORIZON){xz+=frame.grid.xy;}
 let v=surface(xz,sampleWidth);var clip=frame.camera*vec4f(v.position,1);if(HORIZON){clip.z=max(clip.z,0.000001*clip.w);}return Output(clip,v.normal,v.position,v.crest,xz);
}
fn linear(d:f32)->f32 {return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
fn refractionPixel(clip:vec4f)->vec2i {
 if(clip.w<=0.000001||any(abs(clip.xy)>=vec2f(clip.w))){return vec2i(-1);}
 let p=vec2i(frame.viewport.xy+(clip.xy/clip.w*vec2f(0.5,-0.5)+0.5)*frame.viewport.zw);
 if(any(p>=vec2i(frame.viewport.xy+frame.viewport.zw))){return vec2i(-1);}
 return p;
}
// Intersect the bent ray with the view-depth plane of a sampled texel. Reproject the intersection and only accept
// the sample if it belongs to that texel. Keep the search bounded at depth discontinuities and off-screen edges.
fn refractedScene(a:vec4f,b:vec4f,initial:f32)->vec4f {
 var p=refractionPixel(a+b*initial);
 for(var step=0;step<5;step++){
  if(p.x<0){break;}
  let d=textureLoad(depth,p,0);let denominator=b.z-d*b.w;
  if(d<=0.0||abs(denominator)<0.00000001){break;}
  let distance=(d*a.w-a.z)/denominator;
  if(distance<=0.0||distance>50.0){break;}
  let next=refractionPixel(a+b*distance);
  if(all(next==p)){return vec4f(textureLoad(opaque,p,0).rgb,distance);}
  p=next;
 }
 return vec4f(0,0,0,-1);
}
fn refractionBehind(clip:vec4f,p:vec2i)->bool {
 if(p.x<0){return false;}
 return textureLoad(depth,p,0)>clip.z/clip.w;
}
fn refractionCrossing(a:vec4f,b:vec4f)->vec4f {
 var lower=0.0;var upper=0.08;var wasBehind=false;
 for(var step=0;step<8;step++){
  let clip=a+b*upper;let p=refractionPixel(clip);
  if(p.x<0){break;}
  let behind=refractionBehind(clip,p);
  if(behind&&!wasBehind){
   var lo=lower;var hi=upper;
   for(var j=0;j<10;j++){
    let t=(lo+hi)*0.5;let at=a+b*t;
    if(refractionBehind(at,refractionPixel(at))){hi=t;}else{lo=t;}
   }
   // A sign change at a silhouette is not a hit. The hit still needs a depth-checked texel on the refracted ray.
   let hit=refractedScene(a,b,hi);
   if(hit.w>=lower&&hit.w<=upper){return hit;}
  }
  if(upper>=50.0){break;}
  wasBehind=behind;lower=upper;upper=min(50.0,upper*2.8);
 }
 return vec4f(0,0,0,-1);
}
// Ripple noise: 2D gradient noise (K. Perlin, "Improving Noise", SIGGRAPH 2002). Every lattice corner holds a random
// unit gradient whose angle is the PCG hash (Jarzynski and Olano, JCGT 9(3), 2020) of the corner's cell, so the field
// has no axis bias and works for negative and far cells alike.
fn ripplePcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn rippleGradient(cell:vec2i)->vec2f {
 let c=bitcast<vec2u>(cell);let angle=f32(ripplePcg(c.x+ripplePcg(c.y))>>8u)*3.7450703e-7;return vec2f(cos(angle),sin(angle));
}
// (value, d/dx, d/dy). Corner ramps dot(g, p - corner) are blended along x, then y, with the quintic fade
// q(t) = 10t^3 - 15t^4 + 6t^5; by the product rule each blend's gradient is the blend of the ramp gradients plus
// q'(t) = 30t^2(1-t)^2 times the difference of the two blended values along that blend's axis.
fn noise(p:vec2f)->vec3f {
 let base=floor(p);let cell=vec2i(base);let f=p-base;
 let g00=rippleGradient(cell);let g10=rippleGradient(cell+vec2i(1,0));let g01=rippleGradient(cell+vec2i(0,1));let g11=rippleGradient(cell+vec2i(1,1));
 let r00=dot(g00,f);let r10=dot(g10,f-vec2f(1,0));let r01=dot(g01,f-vec2f(0,1));let r11=dot(g11,f-vec2f(1,1));
 let q=f*f*f*(10.0+f*(6.0*f-15.0));let dq=30.0*f*f*(1.0-f)*(1.0-f);
 let low=mix(r00,r10,q.x);let high=mix(r01,r11,q.x);
 let dlow=mix(g00,g10,q.x)+vec2f(dq.x*(r10-r00),0.0);let dhigh=mix(g01,g11,q.x)+vec2f(dq.x*(r11-r01),0.0);
 return vec3f(mix(low,high,q.y),mix(dlow,dhigh,q.y)+vec2f(0.0,dq.y*(high-low)));
}
// One ripple layer's world-space slope. Each layer turns the wind frame by its own angle (cos, sin) and scales it by
// non-integer ratios, so no two layers share a lattice axis or spacing.
fn rippleSlope(xz:vec2f,turn:vec2f,scale:vec2f,drift:vec2f,offset:vec2f,pixelX:vec2f,pixelY:vec2f)->vec2f {
 let w=frame.waves[0].wave.xy;let along=vec2f(w.x*turn.x-w.y*turn.y,w.x*turn.y+w.y*turn.x);let across=vec2f(-along.y,along.x);
 let basis=mat2x2f(along,across);let local=transpose(basis);
 let width=max(length((local*pixelX)*scale),length((local*pixelY)*scale));
 let detail=1.0-smoothstep(0.25,1.0,width);
 if(detail<=0.0){return vec2f(0);}
 let n=noise((local*xz)*scale+frame.settings.x*drift+offset).yz*scale;
 return (basis*n)*detail;
}
// A short gravity wave lives in the shading normal. Its phase warp bends and breaks the visible crest.
fn shortWaveSlope(p:vec2f,pixelX:vec2f,pixelY:vec2f,k:vec2f,height:f32,warp:vec3f)->vec2f {
 let gradient=k+warp.yz;
 let width=max(abs(dot(gradient,pixelX)),abs(dot(gradient,pixelY)));
 let keep=1.0-smoothstep(0.9,3.14159265,width);
 let phase=dot(k,p)-sqrt(9.81*length(k))*frame.settings.x+warp.x;
 return gradient*(height*cos(phase)*keep);
}
fn fresnel(cosine:f32)->f32 {return 0.02+0.98*pow(1.0-clamp(cosine,0.0,1.0),5.0);}
fn landNearby(xz:vec2f)->f32 {
 let size=vec2f(textureDimensions(coast));var land=0.0;
 for(var r=1;r<=3;r++){
  for(var a=0;a<6;a++){
   let angle=f32(a)*1.0471976+f32(r)*0.52;let p=xz+vec2f(cos(angle),sin(angle))*f32(r)*1.2*frame.settings.z;
   let uv=(p-frame.coast.xy)/frame.coast.zw;
   if(all(uv>=vec2f(0))&&all(uv<vec2f(1))&&textureLoad(coast,vec2i(uv*size),0).y>frame.settings.y-0.3){land+=1.0/f32(r);}
  }
 }
 return land/11.0;
}
fn whitecap(xz:vec2f,footprint:f32)->f32 {
 let amount=frame.grid.z;if(amount<=0.0){return 0.0;}
 var crest=0.0;
 for(var j=0u;j<u32(frame.settings.w);j++){
  for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,max(footprint*2.0,0.05));crest+=s.amplitude*length(s.gradient)*sin(s.phase-0.4);}
 }
 let w=frame.waves[0].wave.xy;let q=vec2f(dot(xz,w),dot(xz,vec2f(-w.y,w.x)));let t=frame.settings.x;
 let detail=1.0-smoothstep(0.3,1.5,footprint);
 let patches=noise(q*vec2f(0.32,0.7)+vec2f(-t*0.35,0)).x+noise(q*vec2f(1.3,2.9)+vec2f(-t*0.8,5.1)).x*0.5*detail;
 let threshold=select(mix(0.42,0.16,amount),frame.foam.x,frame.foam.x>0.0);
 let over=crest+patches*0.08-threshold;let core=smoothstep(-0.02,0.07,over);
 let bubbles=noise(q*vec2f(0.75,1.3)+vec2f(-t*0.6,2.3)).x+noise(q*vec2f(2.1,2.7)+vec2f(-t*0.9,7.7)).x*0.5;
 let streak=noise(q*vec2f(0.16,2.2)+vec2f(-t*0.45,3.7)).x;
 let broken=smoothstep(-0.55,0.3,bubbles*0.8+streak*0.7+core*0.8-0.3);
 let caps=core*mix(0.85+0.15*core,broken*(0.55+0.45*core),detail);
 let streaks=amount*amount*smoothstep(0.25,0.55,noise(q*vec2f(0.06,1.4)+vec2f(-t*0.5,0)).x)*0.25*detail;
 return clamp(caps+streaks,0.0,1.0);
}
// The sea's glint lobe for light arriving from unit direction l: GGX D with alpha = rough^2 widened by the waves' unresolved
// slope variance (frame.foam.y), Schlick-Smith G and Fresnel, as radiance per unit irradiance normal to l. The sun, the
// moon and ships' lamps (ships.ts) all reflect through this one lobe.
fn seaGlint(n:vec3f,v:vec3f,l:vec3f,rough:f32)->f32 {
 let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.001,1.0);
 let h=(v+l)/max(0.0001,length(v+l));let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let alpha=rough*rough;let a2=alpha*alpha+frame.foam.y;let denominator=${/* @__PURE__ */ ggxDenominatorOf('n', 'h')};let d=a2/(3.14159265*denominator*denominator);let k=(rough+1.0)*(rough+1.0)*0.125;
 let g=nv/(nv*(1.0-k)+k)*nl/max(0.001,nl*(1.0-k)+k);
 return d*g*fresnel(vh)/max(0.004,4.0*nv);
}
fn directionalGlint(light:Light,n:vec3f,v:vec3f,rough:f32)->vec3f {
 if(light.direction.w<=0.0){return vec3f(0);}
 return light.radiance.rgb*light.direction.w*seaGlint(n,v,light.direction.xyz,rough);
}
// Resolve the reflected lobe over a solid angle for a detailed photographic sky. Raw Sky textures keep their
// established azimuthal sampling. Below-horizon rays see the horizon instead of the HDRI's photographed ground.
${skyCoordinates}
fn skyTap(direction:vec3f,horizon:f32,turn:f32)->vec3f {
 let d=normalize(vec3f(direction.x,max(horizon,direction.y),direction.z));
 return textureSampleLevel(environment,skySampler,seaSkyUv(d,turn),0.0).rgb;
}
fn skyLobe(direction:vec3f,rough:f32,horizon:f32,turn:f32)->vec3f {
 let r=normalize(vec3f(direction.x,max(max(1e-6,horizon),direction.y),direction.z));
 let across=normalize(cross(select(vec3f(0,1,0),vec3f(1,0,0),r.y>0.999),r));
 let up=cross(r,across);
 let width=rough*rough*1.41421356;
 return skyTap(r,horizon,turn)*0.5+(skyTap(r+across*width,horizon,turn)+skyTap(r-across*width,horizon,turn)+
        skyTap(r+up*width,horizon,turn)+skyTap(r-up*width,horizon,turn))*0.125;
}
fn reflectionRay(r:vec3f)->vec3f {return normalize(vec3f(r.x,max(0.02,r.y),r.z));}
fn incidentSky(direction:vec3f,rough:f32)->vec3f {
 if(frame.color.w>0.5&&hdrSkyScale()>0.0){return skyLobe(direction,rough,0.0,hdrSkyTurn())*hdrSkyScale();}
 let r=reflectionRay(direction);
 if(frame.color.w>0.5){let uv=seaSkyUv(r,0.0);let spread=vec2f(rough*0.035,0);return textureSampleLevel(environment,skySampler,uv,0).rgb*0.5+(textureSampleLevel(environment,skySampler,uv-spread,0).rgb+textureSampleLevel(environment,skySampler,uv+spread,0).rgb)*0.25;}
 return mix(vec3f(0.18,0.27,0.32),vec3f(0.035,0.10,0.20),sqrt(max(0.0,r.y)))*frame.radiance.rgb*(0.015+min(1.0,frame.sun.w*0.15));
}
// How much of a clear day's sky light the sky above the sea gives, 0 to 1: the luminance of the sky in two directions
// (30 and 60 degrees up) over 0.02, what the default gradient gives them under a sun of intensity 1 and white light 1.
// The sea's body is lit by this light, so a night sky, however its ambient is set, lights it only as much as it lights
// the sky the sea reflects (a sea that glowed above the sky it mirrors was the night-sea bug).
fn skyAmbient()->f32 {
 let a=incidentSky(vec3f(0.866,0.5,0),0.4);let b=incidentSky(vec3f(0.5,0.866,0),0.4);
 return clamp(dot((a+b)*0.5,vec3f(0.2126,0.7152,0.0722))/0.02,0.0,1.0);
}
fn foamSky()->vec3f {
 var sum=vec3f(0);
 for(var k=0u;k<8u;k++){let a=f32(k)*0.78539816;let up=select(0.5,0.8660254,(k&1u)==1u);let side=sqrt(1.0-up*up);sum+=incidentSky(vec3f(cos(a)*side,up,sin(a)*side),0.4);}
 return sum*0.125;
}
// Eight equally weighted samples in the cosine-weighted hemisphere, stratified in squared radius and azimuth.
fn hdrDiffuse()->vec3f {
 var sum=vec3f(0);
 for(var k=0u;k<8u;k++){
  let up=sqrt(select(0.25,0.75,(k&1u)==1u));let side=sqrt(1.0-up*up);let a=f32(k)*0.78539816;
  sum+=skyTap(vec3f(cos(a)*side,up,sin(a)*side),0.0,hdrSkyTurn());
 }
 return sum*(0.125*hdrSkyScale());
}
fn skyColorBase(direction:vec3f,rough:f32)->vec3f {
 if(frame.color.w>0.5&&hdrSkyScale()<=0.0){return skyLobe(direction,rough,0.02,0.0);}
 return incidentSky(direction,rough);
}
fn skyColor(direction:vec3f,rough:f32)->vec3f {return skyColorBase(direction,rough);}
struct Result {@location(0) color:vec4f,@location(1) foam:vec4f}
${displayShader}
@fragment fn fragment(i:Output)->Result{
 let pixel=vec2i(i.clip.xy);let waterDistance=linear(i.clip.z);let sceneDepth=textureLoad(depth,pixel,0);
 var gap=50.0;if(sceneDepth>0){gap=max(0.0,linear(sceneDepth)-waterDistance)*abs(frame.eye.y-i.world.y)/max(0.0001,waterDistance);}
 var movement=i.crest;let isCoast=inCoast(i.xz);var refraction=1.0;var dry=false;var river=false;var open=1.0;
 if(frame.flow.w>0.5){
  let sample=coastal(i.xz);let v=sample.water;refraction=coastBlend(i.xz).z;
  // shortcut: uncharted seabed deepens at 0.35 m/m; supply a larger heightmap for distant shoals.
  let outside=max(max(frame.coast.xy-i.xz,i.xz-frame.coast.xy-frame.coast.zw),vec2f(0));let bed=max(0.0,i.world.y-v.y)+length(outside)*0.35;
  gap=mix(gap,min(gap,bed),select(sample.ocean,1.0,isCoast));
  if(isCoast){dry=select(v.x<0.003,sample.edge<=0.0,STILL);gap=mix(gap,v.x,sample.blend.z);movement=mix(movement,v.z,sample.blend.z);river=STILL&&v.y>frame.settings.y;open=1.0-sample.blend.z;}
 }
 let pixelX=dpdx(i.world.xz);let pixelY=dpdy(i.world.xz);
 let footprint=max(length(pixelX),length(pixelY));
 // A depth discontinuity outside the contact band is not a shoreline.
 let contactRadius=max(0.03,frame.settings.z);
 let edge=clamp(fwidth(min(gap,contactRadius))*1.5,0.015,contactRadius*0.5);
 let normalWidth=length(fwidth(i.normal));
 let grainDetail=1.0-smoothstep(0.25,1.0,footprint*2.4);var grain=0.5;
 // Gradient noise is centred on zero with the same 0.21 spread as the former 0..1 value noise.
 if(grainDetail>0){grain=0.5+noise(i.world.xz*2.4+vec2f(frame.settings.x*0.22,0)).x*grainDetail;}
 // Breaking surf (surf.ts): rollers on the fronts and the lace they leave, a web of foam (ridges of drifting gradient
 // noise) torn into patches. The breaking churns sand into the water (murk), and the surf's foam replaces the depth-only
 // shoreline band, which on a gentle beach would whiten the whole surf zone.
 var surfing=0.0;var surfFoam=0.0;var murk=0.0;
 if(isCoast&&!river){
  let here=surfHere(i.xz,footprint,true);surfing=here.weight*here.surf.breaking;
  if(surfing>0.0){
   let q=i.world.xz;let t=frame.settings.x;
   let patches=noise(q*0.21+vec2f(t*0.03,0.0)).x+noise(q*0.63+vec2f(3.1,-t*0.05)).x*0.5;
   let web=1.0-abs(noise(q*0.9+vec2f(-t*0.04,7.3)).x+noise(q*2.3+vec2f(1.7,t*0.06)).x*0.45*grainDetail);
   let roller=here.surf.foam.x*smoothstep(-0.5,0.05,patches+here.surf.foam.x*0.7);
   let trail=here.surf.foam.y*smoothstep(-0.3,0.3,patches+here.surf.foam.y*0.3)*mix(0.25,1.0,smoothstep(0.62,0.9,web))*0.9;
   surfFoam=max(roller,trail)*here.weight;
  }
  murk=here.weight*max(here.surf.breaking,here.surf.stir);
 }
 let shore=(1.0-smoothstep(0.0,max(frame.settings.z*0.5,edge*2.0),max(0.0,gap+(grain-0.5)*0.08)))*(1.0-smoothstep(0.0,0.3,surfing));
 let pattern=mix(mix(0.45,1.0,frame.foam.z),1.0,grain);let caps=frame.grid.z;
 let fresh=clamp((select(shore,0.0,river)*SHORE_FOAM+movement*(0.9+0.9*caps))*pattern,0.0,1.0);
 var foam=max(fresh,surfFoam);if(frame.flow.w<0.5){foam=max(foam,textureLoad(history,pixel,0).r*exp(-frame.cameraData.z*3.0)*shore);}
 if(caps>0.0&&!river){
  var lines=0.0;
  // Foam lines ring land the surf does not reach; on a breaking beach the surf's own foam takes their place.
  if(isCoast){let near=landNearby(i.world.xz);lines=smoothstep(0.04,0.3,near+(grain-0.5)*0.25+0.08*sin(frame.settings.x*1.3-near*9.0))*mix(0.55,1.0,grain)*(1.0-smoothstep(0.0,0.3,surfing));}
  foam=max(foam,max(whitecap(i.world.xz,footprint)*open,lines*caps));
 }
 var shown=foam;if(frame.foam.z>0.0){shown=pow(foam,1.0-0.4*frame.foam.z);}
 var ripple=vec3f(0);
 // The coarsest layer is at least 0.075 cycles/m in any direction. Past this point all five filters are zero.
 if(footprint<13.334){
 // Agitation, chop and two micro layers turned 11, -21, 30 and -41 degrees from the wind. Weights keep the former
 // value-noise slope (RMS 0.39 per axis against gradient noise's 0.62).
 let p=i.world.xz;
 let slope=rippleSlope(p,vec2f(0.98200,0.18886),vec2f(0.22,0.16),vec2f(-0.09,0.03),vec2f(0),pixelX,pixelY)*0.186
  +rippleSlope(p,vec2f(0.93233,-0.36162),vec2f(0.57,0.42),vec2f(-0.17,-0.06),vec2f(3.17,9.23),pixelX,pixelY)*0.062
  +rippleSlope(p,vec2f(0.86281,0.50553),vec2f(1.8,0.65),vec2f(-0.5,0.12),vec2f(0),pixelX,pixelY)*0.0112
  +rippleSlope(p,vec2f(0.75836,-0.65183),vec2f(3.4,1.9),vec2f(-0.7,0.2),vec2f(7.13,3.71),pixelX,pixelY)*0.0037;
 let chop=frame.grid.w;
 let windSea=rippleSlope(p,vec2f(0.99619,-0.08716),vec2f(0.11,0.075),vec2f(-0.3,0.05),vec2f(1.9,6.4),pixelX,pixelY)*0.5;
 let w=frame.waves[0].wave.xy;let basis=mat2x2f(w,vec2f(-w.y,w.x));let local=transpose(basis);let q=local*p;
 // A broad, advecting wind patch varies the short-wave slope. Long-wave displacement stays in the authored trains.
 var shortWaves=vec2f(0);var gain=1.0;
 if(chop>0.0){
  let scale=vec3f(1.0,0.041,0.073);
  let windPatch=noise(q*scale.yz-vec2f(frame.settings.x*0.095,0))*scale;
  let gust=smoothstep(-0.48,0.48,windPatch.x);
  gain=mix(1.0,mix(0.4,1.6,gust),sqrt(chop));
  let dx=local*pixelX;let dy=local*pixelY;
  let a=shortWaveSlope(q,dx,dy,vec2f(1.48,0.81),0.060,windPatch*4.1);
  let b=shortWaveSlope(q,dx,dy,vec2f(1.63,-2.21),0.029,vec3f(2.1,0,0)-windPatch*3.4);
  shortWaves=(basis*(a+b))*(chop*gain*(1.0-smoothstep(7.0,13.333334,footprint)));
 }
 let agitated=(slope*(1.0+3.0*chop)+windSea*chop)*gain+shortWaves;
 ripple=vec3f(-agitated.x,0,-agitated.y)*(1.0-shown);
 }
 let n=normalize(i.normal+ripple);
 // A box pixel over a locally linear normal field has variance (dx^2 + dy^2)/12.
 // Fold it into the squared microfacet width so the sky and SSR share the same filtered lobe.
 let normalDx=dpdx(n);let normalDy=dpdy(n);
 let variance=(dot(normalDx,normalDx)+dot(normalDy,normalDy))/12.0;
 // Keep all quad lanes alive until the derivatives of both the shoreline and water normal have been read.
 if(dry){discard;}
 let v=normalize(frame.eye.xyz-i.world);let nv=clamp(dot(n,v),0.001,1.0);
 // Sand the swell lifts off the bed hangs in the water: a grey, nearly flat extinction of up to 1.4 per metre over
 // clear water's (murk, from surf.ts), so a surf zone reads as turbid green-grey water, not a clear lagoon over sand.
 var optical=min(50.0,gap/max(0.15,abs(v.y)));var opticalGap=gap;
 let hdr=hdrSkyScale()>0.0;
 var irradiance=vec3f(0);
 var ambient=frame.eye.w;
 if(hdr){irradiance=hdrDiffuse();ambient*=clamp(dot(irradiance,vec3f(0.2126,0.7152,0.0722))/0.02,0.0,1.0);}
 else{ambient*=skyAmbient();}
 // HDR water body and seabed use the sky's RGB irradiance relative to an 18% grey reference exposure.
 let diffuse=select(vec3f(ambient),irradiance*(frame.eye.w/0.18),hdr);
 var bottom=vec3f(0.28,0.25,0.17)*(diffuse+frame.radiance.rgb*frame.sun.w*0.12);
 if(frame.radiance.w>0.5&&refraction>0.0){
  let bent=refract(-v,n,0.75187970);
  let a=frame.camera*vec4f(i.world,1);let b=frame.camera*vec4f(bent,0);
  var hit=refractedScene(a,b,min(50.0,gap/max(0.05,-bent.y)));
  if(hit.w<0.0){hit=refractionCrossing(a,b);}
  if(hit.w>0.0){
   bottom=mix(bottom,hit.rgb,refraction);
   optical=mix(optical,hit.w,refraction);opticalGap=mix(gap,max(0.0,-bent.y*hit.w),refraction);
  }else if(frame.flow.w<0.5){
   // In uncharted water the straight ray's depth says nothing about a missing bent ray's bottom.
   optical=50.0;opticalGap=50.0;
  }
 }
 let transmission=exp(-(vec3f(0.38,0.10,0.045)+vec3f(1.4,1.3,1.5)*murk)*optical);
 let nl=clamp(dot(n,frame.sun.xyz),0.0,1.0);
 let baseRough=clamp(max(frame.foam.w,0.12+normalWidth*0.6+footprint*0.025),frame.foam.w,max(0.4,frame.foam.w));
 let alpha=baseRough*baseRough;
 let rough=min(sqrt(sqrt(alpha*alpha+2.0*variance)),max(0.55,frame.foam.w));
 // A down-going reflection on an open wave is partly blocked by neighbouring water. A broad transition
 // with residual skylight approximates the light returned by other facets without tracing secondary rays.
 let reflectedY=reflect(-v,n).y;
 let skyVisible=1.0-0.34*smoothstep(0.0,0.18+1.41421356*rough*rough,-reflectedY);
 let reflection=fresnel(nv)*mix(1.0,skyVisible,open);
 let glint=directionalGlint(frame.lights[0],n,v,rough)+directionalGlint(frame.lights[1],n,v,rough);
 // Glints and foam lose the direct light in its shadow; the map is read only where either shows.
 var shade=1.0;if(foam>0.002||max(glint.x,max(glint.y,glint.z))>0.002){shade=waterShadow(i.world);}
 let shallowBand=select(0.0,1.0-smoothstep(0.0,frame.shallow.w,opticalGap),frame.shallow.w>0.0);
 let bodyLight=diffuse+frame.radiance.rgb*nl*frame.sun.w*0.12;
 let body=bottom*transmission+frame.color.rgb*(vec3f(1)-transmission)*bodyLight+(frame.shallow.rgb-frame.color.rgb)*shallowBand*(vec3f(1)-transmission)*bodyLight;
 var color=mix(body,skyColor(reflect(-v,n),rough),reflection)+glint*shade;
 // Foam is a rough white scatterer: N.L direct light over the water's ambient, Lambert-normalized (albedo/pi) like the
 // scene's diffuse surfaces, so it no longer glows at full light strength on the side away from the moon.
 var skyLight=vec3f(0);if(frame.grid.z>0.0){if(hdr){skyLight=irradiance;}else{skyLight=foamSky();}}
 color=mix(color,vec3f(0.72,0.77,0.74)*(ambient+frame.radiance.rgb*nl*frame.sun.w*shade/3.14159265+skyLight),shown*0.95);
 if(frame.cameraData.w<0.5){color=toDisplay(color);}
 return Result(vec4f(color,1),vec4f(foam,0,0,1));
}`;
// With a shadow source its own filtered visibility (bind group 1) shades the surface; without one the light is unblocked.
// SSR capture (`setCapture`): the same fragment, ending in what screen-space reflections replace: the sky reflection the
// water added (times the Fresnel weight and the foam's share) and that weight, with the rippled normal and roughness.
const captureHead = '@fragment fn fragment(i:Output)->Result{',
  captureTail =
    /var color=mix\(body,skyColor\(reflect\(-v,n\),rough\),reflection\)\+glint\*shade;[\s\S]*return Result\(vec4f\(color,1\),vec4f\(foam,0,0,1\)\);/;
// Leave the bounded Water shader intact. The ocean drops the vertex depth clamp on its real grid and adds a flat
// quad distinguished by negative sample width. Its depth is the sky's and it fills only beyond the original far clip.
function horizonDepthShader(code: string): string {
  const vertex =
    'let v=surface(xz,sampleWidth);var clip=frame.camera*vec4f(v.position,1);if(HORIZON){clip.z=max(clip.z,0.000001*clip.w);}return Output(clip,v.normal,v.position,v.crest,xz);';
  const discard = 'if(dry){discard;}';
  if (!code.includes(vertex) || !code.includes(discard))
    throw margoError(
      'unsupported',
      'Water horizon depth needs the unclipped surface and dry-fragment anchors; update its shader edit',
    );
  return code
    .replace(
      vertex,
      `if(sampleWidth<0.0){
        let p=vec3f(xz.x,frame.settings.y,xz.y);let clip=frame.camera*vec4f(p,1);
        return Output(vec4f(clip.xy,0.0,clip.w),vec3f(0,1,0),p,0.0,xz);
       }
       let v=surface(xz,sampleWidth);
       return Output(frame.camera*vec4f(v.position,1),v.normal,v.position,v.crest,xz);`,
    )
    .replace(discard, `if(i.clip.z==0.0&&(frame.camera*vec4f(i.world,1)).z>0.0){discard;}\n ${discard}`);
}
function captureShader(code: string, declarations: string): string {
  const out = code
    .replace(captureHead, '@fragment fn fragment(i:Output)->MargoSSR{')
    .replace(
      captureTail,
      'let keep=reflection*(1.0-0.95*shown);_=body;_=glint*shade;return MargoSSR(vec4f(skyColor(reflect(-v,n),rough)*keep,rough),vec4f(vec3f(keep),1),vec4f(n*0.5+0.5,1));',
    );
  if (!out.includes('->MargoSSR{') || !out.includes('return MargoSSR('))
    throw margoError('unsupported', 'Water capture needs the water fragment; its shader changed');
  return declarations + out;
}
// Scene fog (`setFog`): the same place environment's Fog mixes on meshes, after the display tone mapping and before the
// sRGB encoding on an 8-bit target, in linear radiance on an HDR one. The SSR capture replaces this tail, so it is unfogged.
const fogFrom = 'if(frame.cameraData.w<0.5){color=toDisplay(color);}',
  fogTo =
    'let fogA=fogAmount(i.world);if(frame.cameraData.w<0.5){let mapped=mix(pbrNeutral(max(color,vec3f(0))),margoFog.color.rgb,fogA);color=select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308));}else{color=mix(color,margoFog.color.rgb,fogA);}';
function foggedShader(code: string): string {
  if (code.split(fogFrom).length !== 2)
    throw margoError('unsupported', 'Water fog needs the water fragment it was written for; update its fog edit');
  return code.replace(fogFrom, fogTo) + fogWgsl(0, 8);
}
const unshadowed = '\nfn waterShadow(p:vec3f)->f32 {return 1.0;}';
const shadowed = '\nfn waterShadow(p:vec3f)->f32 {return shadowVisibility(p,vec3f(0,1,0));}';
const depthCopy = `
@group(0) @binding(0) var sceneDepth:texture_depth_2d;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {return textureLoad(sceneDepth,vec2i(p.xy),0);}
`;
let instances = 0;
function unit(value: number, name: string): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1))
    throw new RangeError(`Invalid water ${name}; use a number from 0 to 1`);
  return value;
}
// How far the horizon grid's last row lies from the camera, in metres: atan(10 km / 10,000 km) is 0.06 degrees.
const HORIZON_REACH = 10_000_000;
/** One view's foam history and the bind groups that read it. */
interface WaterView {
  foam: GPUTexture[];
  foamViews: GPUTextureView[];
  current: number;
  groups: GPUBindGroup[];
  // Resources of each group (the capture pipeline has its own auto layout) and which group this view drew with.
  resources: GPUBindingResource[][];
  drawn: number;
  built: number;
  // Capture groups per capture pipeline (each effect that captures this water has its own).
  captureGroups: Map<GPURenderPipeline, GPUBindGroup[]>;
}
/**
 * An opaque, Y-up water surface: up to eight Gerstner swell trains with analytic normals, Fresnel reflection, glints,
 * absorption and shoreline foam, with optional terrain-coupled shallow-water flow and spray. `Water.attach(engine,
 * options)`; WebGPU only.
 * @throws RangeError / TypeError for invalid options; linked MargoError with code failed for folding wave steepness.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` during a frame when a
 * borrowed texture (depth, reflection, scene colour, terrain heightmap) does not have the required size or format.
 */
export class Water implements EnginePlugin {
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly foamAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
    stencilReadOnly: true,
  };
  private readonly presentation: GPURenderPassDescriptor = {
    colorAttachments: [this.attachment, this.foamAttachment],
    depthStencilAttachment: this.depthAttachment,
  };
  private readonly copiedDepth: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthClearValue: 0,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
    stencilReadOnly: true,
  };
  private readonly depthPresentation: GPURenderPassDescriptor = {
    colorAttachments: [],
    depthStencilAttachment: this.copiedDepth,
  };
  private foamMSAA?: GPUTexture;
  private foamMSAAView?: GPUTextureView;
  private surfaceDepth?: GPUTexture;
  private surfaceView?: GPUTextureView;
  private copyPipeline?: GPURenderPipeline;
  private copyGroup?: GPUBindGroup;
  private copyBuilt = -1;
  private depthView?: GPUTextureView;
  private reflected?: GPUTexture;
  private captured?: GPUTexture;
  private capturedView?: GPUTextureView;
  private skySampler?: GPUSampler;
  private spray?: Spray;
  private readonly colorSource: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly colorTarget: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly colorSize: GPUExtent3DDict = { width: 1, height: 1, depthOrArrayLayers: 1 };
  // Foam history and its bind groups per engine view (the plain frame is one too), released when a view is not drawn
  // for a frame. `built` bumps when a binding all views share changes, so each view rebuilds its groups once.
  private readonly views = new ViewStates<WaterView>(
    () => ({
      foam: [],
      foamViews: [],
      current: 0,
      groups: [],
      resources: [],
      drawn: 0,
      built: -1,
      captureGroups: new Map(),
    }),
    (view) => {
      for (const texture of view.foam) texture.destroy();
      if (view === this.drawnView) this.drawnView = undefined;
    },
  );
  // `view` is this frame's view, cleared at the start of each frame so the SSR capture draw only uses a view drawn this
  // frame. `drawnView` is the view drawn last, which WaveQuery reads: it lives until a newer draw or its release, so a
  // capture from a plugin's onPreUpdate (after this one's) still reads the frame on screen.
  private view?: WaterView;
  private drawnView?: WaterView;
  private built = 0;
  private shaderCode = '';
  private effectBindings: GPUBindGroupEntry[] = [];
  private vertexBindings: GPUBindGroupEntry[] = [];
  private capture?: WaterCapture;
  // Capture pipelines keyed by the shader, the effect's declarations, targets and pass format: one water captured by
  // two effects keeps both, each with that effect's own MargoSSR outputs.
  private readonly captures = new Map<
    string,
    { pipeline: GPURenderPipeline; shadow?: GPUBindGroup; shadowEntries?: GPUBindGroupEntry[] }
  >();
  private readonly disposers = new Set<() => void>();
  private shadowGroup?: GPUBindGroup;
  private shadowEntries?: GPUBindGroupEntry[];
  private sampledDepth?: GPUTexture;
  private coastal?: WaterSolver;
  /** What the flow was built with: water/rivers' kernels and a `water/flood` solver factory. */
  private coastalSource?: readonly [unknown, unknown];
  readonly name = 'water:' + ++instances;
  private engine?: Engine;
  private source?: () => GPUTexture | undefined;
  private shared?: ReturnType<typeof acquireDepth>;
  private uniform?: GPUBuffer;
  private vertices?: GPUBuffer;
  private indices?: GPUBuffer;
  private count = 0;
  private pipeline?: GPURenderPipeline;
  private format = '';
  private seconds = 0;
  private readonly values = new Float32Array(SEA_AT + 4 + WATER_SEA_WAVES * 4);
  /** Flow ticks run since the flow was built, with a film clock. */
  private flowTicks = 0;
  /** The ring of per-tick frame-uniform slices, with a film clock (made on first use). */
  private ring?: GPUBuffer;
  private ringData?: Float32Array;
  private tickSlice?: Float32Array;
  /** The sea's rows of the frame uniform, a view made once (a frame makes no typed-array views). */
  private readonly seaRows = this.values.subarray(SEA_AT + 4);
  private fogSource: FogLike | null = null;
  private fogBuffer?: GPUBuffer;
  private readonly fogData = new Float32Array(12);
  private readonly waveHeights = new Float32Array(8);
  private maxWaveHeight = 0;
  /** The wind the swell trains follow (set with `options.wind`). */
  private windSea?: { speed: number; fetch?: number; direction?: readonly [number, number] };
  /** True while the foam follows the wind (`wind` set, `whitecaps` omitted or not yet set by hand). */
  private foamFollowsWind = false;
  private disposed = false;
  private readonly positions: Float32Array;
  private readonly triangles: Uint32Array;
  private readonly horizon: boolean;
  // Regular cell width and depth: the step a horizon grid follows the camera in.
  private readonly cell: readonly [number, number];
  constructor(readonly options: WaterOptions = {}) {
    const {
      size = [100, 100],
      segments = 128,
      height = 0,
      color = [0.01, 0.18, 0.25],
      foamDistance = 1,
      // The calm real default: the sea of a 6 m/s wind (a gentle breeze, Beaufort 4), not two hand-set trains.
      waves = seaOf(options.wind ?? DEFAULT_WIND).waves,
    } = options;
    if (!options.waves) {
      const w = windOf(options.wind ?? DEFAULT_WIND);
      this.windSea = { speed: w.speed, fetch: w.fetch, direction: w.direction };
    }
    if (
      size.length !== 2 ||
      size.some((v) => !Number.isFinite(Math.fround(v)) || v <= 0 || v > 100000) ||
      !Number.isInteger(segments) ||
      segments < 1 ||
      segments > 512 ||
      !Number.isFinite(Math.fround(height)) ||
      !Number.isFinite(foamDistance) ||
      foamDistance <= 0 ||
      foamDistance > 100 ||
      color.length !== 3 ||
      color.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
      waves.length < 1 ||
      waves.length > 8 ||
      (options.depth !== undefined && typeof options.depth !== 'function')
    )
      throw new RangeError(
        'Invalid water options; use size and segments above 0, finite color and height, 1 to 8 waves and a depth function',
      );
    if (options.sea !== undefined && typeof options.sea?.waveComponents !== 'function')
      throw new TypeError('Water sea needs waveComponents(t, out); pass a SpectralSea from @margoengine/physics/sea.');
    // A sea's own waves replace the swell trains on the surface (their count is 0); the trains keep the wind's direction
    // for the ripples and foam patterns that read it.
    this.values.set([0, height, foamDistance, options.sea ? 0 : waves.length], 20);
    this.values.set(color, 24);
    this.values[135] = 0.12;
    this.values.set([0, 0.28, 0.3], 136);
    this.values.set([0.6, 0.8, 0, 3, 1, 0.9, 0.75, 0], 104);
    this.setWhitecaps(options.whitecaps ?? 0).setChop(options.chop ?? 0);
    this.foamFollowsWind = options.whitecaps === undefined && !!this.windSea;
    if (
      (options.reflection !== undefined && typeof options.reflection !== 'function') ||
      (options.reflectionEnvironment !== undefined && !validWaterSky(options.reflectionEnvironment))
    )
      throw new TypeError(
        'Invalid water optics; pass a Sky texture callback as reflection or an HDR Environment as reflectionEnvironment',
      );
    if (
      (options.sceneColor !== undefined && typeof options.sceneColor !== 'function') ||
      (options.spray !== undefined && typeof options.spray !== 'boolean') ||
      (options.spray && !options.terrain) ||
      (options.sprayCount !== undefined &&
        (!Number.isInteger(options.sprayCount) ||
          options.sprayCount < 64 ||
          options.sprayCount > 65536 ||
          options.sprayCount % 64 !== 0)) ||
      (options.horizon !== undefined && typeof options.horizon !== 'boolean')
    )
      throw new TypeError(
        'Invalid water optics or spray options; sceneColor takes a function and horizon takes a boolean, spray needs options.terrain, and sprayCount is a multiple of 64 from 64 to 65536',
      );
    if (
      options.shadows !== undefined &&
      (typeof options.shadows?.pbr !== 'function' || typeof options.shadows?.bindings !== 'function')
    )
      throw new TypeError('Water shadows need pbr() and bindings(); pass a Shadows from @margoengine/shadows');
    if (
      (options.fill !== undefined && (typeof options.fill !== 'function' || !options.terrain)) ||
      (options.still !== undefined && (typeof options.still !== 'boolean' || !options.terrain || options.spray))
    )
      throw new TypeError(
        'Invalid water fill or still; fill takes a function, still a boolean, both need options.terrain and still does not take spray',
      );
    this.validateLights();
    this.horizon = options.horizon ?? false;
    this.cell = [size[0] / segments, size[1] / segments];
    this.values[98] = this.values[99] = 1;
    const terrain = options.terrain;
    if (terrain) {
      if (
        typeof terrain.heightmap !== 'function' ||
        terrain.origin.length !== 2 ||
        terrain.origin.some((v) => !Number.isFinite(Math.fround(v))) ||
        terrain.size.length !== 2 ||
        terrain.size.some((v) => !Number.isFinite(Math.fround(v)) || v <= 0 || v > 100000) ||
        (terrain.heights !== undefined &&
          (typeof terrain.heights !== 'object' ||
            terrain.heights === null ||
            !Number.isInteger(terrain.heights.width) ||
            !Number.isInteger(terrain.heights.height) ||
            terrain.heights.width < 2 ||
            terrain.heights.height < 2 ||
            terrain.heights.width > WATER_TERRAIN_MAX ||
            terrain.heights.height > WATER_TERRAIN_MAX ||
            terrain.heights.data?.length !== terrain.heights.width * terrain.heights.height))
      )
        throw new RangeError(
          'Invalid water terrain; pass a heightmap function, a finite origin [x, z], a size [x, z] from 0 to 100000 and heights of width x height values (2 to 8192 a side)',
        );
      this.values.set(terrain.origin, 96);
      this.values.set(terrain.size, 98);
      this.values[103] = 1;
    }
    const edge = Math.hypot(size[0] / segments, size[1] / segments);
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i],
        length = Math.hypot(...w.direction),
        q = w.steepness ?? 0.5;
      if (
        w.direction.length !== 2 ||
        w.direction.some((v) => !Number.isFinite(v)) ||
        !length ||
        !Number.isFinite(w.amplitude) ||
        w.amplitude < 0 ||
        w.amplitude > 100 ||
        !Number.isFinite(w.wavelength) ||
        w.wavelength <= 0 ||
        w.wavelength > 100000 ||
        !Number.isFinite(q) ||
        q < 0 ||
        q > 1 ||
        !Number.isFinite(w.phase ?? 0)
      )
        throw new RangeError(
          'Invalid Gerstner wave; use a non-zero [x, z] direction, amplitude 0-100, wavelength above 0 up to 100000, steepness 0-1',
        );
      const k = (2 * Math.PI) / w.wavelength;
      if (q * w.amplitude * k > 1 / waves.length)
        throw fault(
          'failed',
          'Wave steepness would fold the surface; lower the amplitude or steepness, or lengthen the wavelength',
          'geometry',
        );
      // Fade waves shorter than four triangle edges to prevent mesh sampling artifacts.
      const t = Math.max(0, Math.min(1, (w.wavelength / edge - 2) / 2));
      this.values.set(
        [
          w.direction[0] / length,
          w.direction[1] / length,
          w.amplitude,
          k,
          q,
          // Deep-water dispersion omega = sqrt(g k) (Tessendorf 2001).
          Math.sqrt(9.81 * k),
          w.phase ?? 0,
          t * t * (3 - 2 * t),
        ],
        32 + i * 8,
      );
      this.waveHeights[i] = w.amplitude;
      this.maxWaveHeight = Math.max(this.maxWaveHeight, w.amplitude);
    }
    this.followWind();
    const vertices = (segments + 1) ** 2,
      indices = segments ** 2 * 6;
    this.positions = new Float32Array((vertices + (this.horizon ? 4 : 0)) * 3);
    this.triangles = new Uint32Array(indices + (this.horizon ? 6 : 0));
    // Horizon rows: the central 75% of each axis keeps its regular cells and follows the camera (drawSurface); each
    // outer row but the last is `ratio` times wider than the one inside it, reaching 10 km past the grid's edge, so
    // waves fade over many rows instead of one. The last row lies HORIZON_REACH out, where a camera 10 km up sees the
    // sea's edge within a pixel of the true horizon (a 10 km square edge showed 14 degrees below it from 3 km).
    const inner = Math.max(0, Math.floor(segments * 0.875) - segments / 2),
      grown = segments / 2 - inner - 1,
      ratios = (this.horizon && grown > 0 ? size : []).map((s) => {
        const cell = s / segments,
          target = (s / 2 + 10000 - inner * cell) / cell,
          reach = (r: number) => (r * (r ** grown - 1)) / (r - 1);
        let low = 1,
          high = 2;
        while (reach(high) < target) high *= 2;
        for (let i = 0; i < 200; i++) {
          const mid = (low + high) / 2;
          if (reach(mid) < target) low = mid;
          else high = mid;
        }
        return high;
      });
    const coordinate = (i: number, axis: number) => {
      const u = i / segments - 0.5,
        d = Math.abs(i - segments / 2);
      if (!this.horizon || d <= inner) return u * size[axis];
      if (d >= segments / 2) return Math.sign(u) * HORIZON_REACH;
      const cell = size[axis] / segments,
        r = ratios[axis];
      return Math.sign(u) * (inner * cell + (cell * r * (r ** (d - inner) - 1)) / (r - 1));
    };
    const step = (i: number, axis: number) =>
      Math.max(
        coordinate(Math.min(segments, i + 1), axis) - coordinate(i, axis),
        coordinate(i, axis) - coordinate(Math.max(0, i - 1), axis),
      );
    for (let z = 0; z <= segments; z++)
      for (let x = 0; x <= segments; x++) {
        const o = (z * (segments + 1) + x) * 3;
        this.positions[o] = coordinate(x, 0);
        this.positions[o + 1] = coordinate(z, 1);
        this.positions[o + 2] = Math.hypot(step(x, 0), step(z, 1));
        if (x < segments && z < segments) {
          const a = o / 3,
            b = a + segments + 1;
          this.triangles.set([a, b, a + 1, a + 1, b, b + 1], (z * segments + x) * 6);
        }
      }
    if (this.horizon) {
      // Keep the real far clip for the displaced mesh. Clamping its shared vertices advances the depth of triangles
      // that cross the far plane and can draw over distant land. A separate flat quad at depth zero fills the sky there.
      const reach = HORIZON_REACH;
      this.positions.set([-reach, -reach, -1, reach, -reach, -1, -reach, reach, -1, reach, reach, -1], vertices * 3);
      this.triangles.set([vertices, vertices + 2, vertices + 1, vertices + 1, vertices + 2, vertices + 3], indices);
    }
    this.count = this.triangles.length;
    queryStates.set(this, () =>
      this.disposed || !this.engine?.gpu || !this.uniform || !this.drawnView?.groups.length
        ? undefined
        : {
            kind: 'water',
            device: this.engine.gpu,
            token: this.uniform,
            values: this.values,
            time: this.values[20],
            shader: this.shaderCode.slice(0, this.shaderCode.indexOf('struct Output')),
            segments,
            positions: this.positions,
            resources: this.drawnView.resources[this.drawnView.drawn],
            coast: this.coastal,
            extraBindings: this.vertexBindings,
            extraVelocity: (surfaceEffects.get(this) ?? []).map((e) => e.velocity).filter((v): v is string => !!v),
            still: this.shaderCode.includes('const STILL=true;'),
          },
    );
  }
  static attach(engine: EngineKernel, options: WaterOptions = {}): Water {
    const effect = new Water(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  /** Borrowed coastal state; R is water depth in meters. Undefined before simulation or after restoration. */
  get coastalDepthTexture(): GPUTexture | undefined {
    return this.coastal?.states[this.coastal.current];
  }
  /** Borrowed scene depth including the water surface; changes on resize/restoration. */
  get depthTexture(): GPUTexture | undefined {
    return this.surfaceDepth;
  }
  /** The fog the water is drawn in (see `setFog`), or null. */
  get fog(): FogLike | null {
    return this.fogSource;
  }
  /**
   * Fogs the surface and its spray: `fog` is `@margoengine/environment`'s `Fog` or any object with its fields, read every
   * frame, with Fog's maths (linear near/far, exp2 density, height falloff) and mixed where Fog mixes on meshes (after
   * the display tone mapping on the canvas, in linear radiance on an HDR target), so fogged water matches fogged
   * terrain and a fully fogged surface shows the fog colour. `null` (the default) draws exactly as without fog. Setting
   * or clearing it recompiles the surface shader once; changing the fog or its `enabled` flag never does.
   * @throws TypeError when `fog` is neither an object nor null; RangeError or TypeError for an invalid field.
   */
  setFog(fog: FogLike | null): this {
    this.fogSource = checkFog(fog);
    return this;
  }
  /**
   * Sets the breaking whitecaps, 0-1 (see `WaterOptions.whitecaps`); read every frame. `null` hands the foam back to the
   * wind (a Water without `waves`) or turns it off (with `waves`), as a Water made without the option has it.
   * Throws RangeError outside 0-1.
   */
  setWhitecaps(amount: number | null): this {
    if (amount === null) {
      this.values[130] = this.values[132] = 0;
      this.foamFollowsWind = !!this.windSea;
      this.followWind();
      return this;
    }
    this.values[130] = unit(amount, 'whitecaps');
    this.values[132] = 0;
    this.foamFollowsWind = false;
    return this;
  }
  /** The wind of the sea (`speed` m/s, `fetch` m, `direction` XZ), or undefined with `options.waves`. A copy. */
  get wind(): Readonly<WaterWind> | undefined {
    const w = this.windSea;
    return w && { speed: w.speed, fetch: w.fetch, direction: w.direction && [w.direction[0], w.direction[1]] };
  }
  /** Sets the deep-water colour, linear RGB 0-1 (see `WaterOptions.color`); read every frame. Throws RangeError otherwise. */
  setColor(color: readonly [number, number, number]): this {
    if (color.length !== 3 || color.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
      throw new RangeError('Invalid water color; use three numbers from 0 to 1');
    this.values.set(color, 24);
    return this;
  }
  /**
   * Moves the mean sea level to world Y `y` (see `WaterOptions.height`), from -100,000 to 100,000; read every frame. With
   * `terrain`, the flow's map edge and its open-sea cells follow it, so a slow rise floods the land below it and a fall
   * drains it again (a storm surge or a tide); the open sea, the surf and the queries ride on it.
   * @throws RangeError outside that range.
   */
  setSeaLevel(y: number): this {
    if (this.disposed || typeof y !== 'number' || !Number.isFinite(Math.fround(y)) || Math.abs(y) > 100000)
      throw new RangeError('Invalid water sea level; use a finite world Y from -100000 to 100000');
    this.values[21] = y;
    return this;
  }
  /**
   * Sets the open sea past the coastal grid's sea sides, or null (the default) for one flat sea level everywhere:
   * outside the grid the surface carries `profile`, the long wave travelling on to it, and near and past a sea side it
   * starts from the flow's own edge level where water stands there, so the open sea and the simulated edge meet with
   * no step. Needs `terrain`. Read every frame; `water/flood` sets it from its tsunamis and surge.
   * @throws RangeError for a profile of other than 2 to 64 finite samples, or a range or spread outside (0, 1e7].
   */
  setFarField(field: WaterFarField | null): this {
    const v = this.values;
    if (field === null) {
      v.fill(0, FAR_AT, FAR_AT + FAR_FLOATS);
      return this;
    }
    const profile = field?.profile,
      n = profile?.length ?? 0;
    if (!field || typeof field !== 'object' || n < 2 || n > WATER_FAR_SAMPLES)
      throw new RangeError(
        `Invalid water far field; use { sides, profile, range } with 2 to ${WATER_FAR_SAMPLES} samples`,
      );
    for (let i = 0; i < n; i++)
      if (!Number.isFinite(profile[i]) || Math.abs(profile[i]) > 1e5)
        throw new RangeError('Invalid water far field profile; use finite metres from -100000 to 100000');
    const span = (x: number | undefined, name: string, fallback: number) => {
      const y = x ?? fallback;
      if (!Number.isFinite(y) || y <= 0 || y > 1e7)
        throw new RangeError(`Invalid water far field ${name}; use metres above 0 and up to 10000000`);
      return y;
    };
    const t = this.options.terrain,
      range = span(field.range, 'range', 1),
      spread = span(field.spread, 'spread', t ? Math.max(t.size[0], t.size[1]) : 1),
      sides = field.sides ?? {};
    v.set([+!!sides.west, +!!sides.east, +!!sides.south, +!!sides.north, range, n, spread, 1], FAR_AT);
    for (let i = 0; i < WATER_FAR_SAMPLES; i++) v[FAR_AT + 8 + i] = profile[Math.min(i, n - 1)];
    return this;
  }
  /** The mean sea level, world Y (`WaterOptions.height`, or the last `setSeaLevel`). */
  get seaLevel(): number {
    return this.values[21];
  }
  /**
   * Sets the lowest roughness of the sun's glitter, 0.02 to 0.6 (0.12, the default, is the sea's own floor); a higher
   * floor widens and smooths the glints, as an animated feature draws them. Read every frame; RangeError outside.
   */
  setGlitterRoughness(roughness: number): this {
    if (!Number.isFinite(roughness) || roughness < 0.02 || roughness > 0.6)
      throw new RangeError('Invalid water glitterRoughness; use a number from 0.02 to 0.6');
    this.values[135] = roughness;
    return this;
  }
  /**
   * Sets how soft the foam's edges are, 0 (the physical foam) to 1: the foam's small-scale pattern fades and its edge
   * widens into larger, softer shapes. Read every frame; RangeError outside 0-1.
   */
  setFoamSoftness(amount: number): this {
    this.values[134] = unit(amount, 'foamSoftness');
    return this;
  }
  /**
   * Sets the shallow-water colour band: water over a bed less than `depth` metres below the surface takes `color`
   * (linear RGB 0-1) instead of the deep colour, fading to it at `depth`; a depth of 0 turns the band off. Read every
   * frame; RangeError for a colour outside 0-1 or a depth outside 0-100.
   */
  setShallow(color: readonly [number, number, number], depth: number): this {
    if (
      color.length !== 3 ||
      color.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
      !Number.isFinite(depth) ||
      depth < 0 ||
      depth > 100
    )
      throw new RangeError(
        'Invalid water shallow band; use a colour of three numbers from 0 to 1 and a depth from 0 to 100',
      );
    this.values.set(color, 136);
    this.values[139] = depth;
    return this;
  }
  /** Sets the shoreline foam width, above 0 to 100 world units (see `WaterOptions.foamDistance`); read every frame. */
  setFoamDistance(distance: number): this {
    if (!Number.isFinite(distance) || distance <= 0 || distance > 100)
      throw new RangeError('Invalid water foamDistance; use a number above 0 and up to 100');
    this.values[22] = distance;
    return this;
  }
  /** Sets the wind chop, 0-1 (see `WaterOptions.chop`); read every frame. Throws RangeError outside 0-1. */
  setChop(amount: number): this {
    this.values[131] = unit(amount, 'chop');
    return this;
  }
  /**
   * Where this sea's swell starts breaking on its coast: the contour of `terrain.heights` at the sea level less
   * {@link breakerDepth} of the current trains (after `setWind` and `setWaveHeight`), as [x, z] segments, the line the
   * surf shader's breakers sit on in the mean. Empty without `terrain.heights`, without waves, or where no ground is that
   * deep. A `WeatherDrive` reads it to thicken the spray near the breakers. Kept until the depth or the sea level changes.
   */
  breakerLine(): [number, number][][] {
    const terrain = this.options.terrain;
    if (!terrain?.heights) return [];
    const waves = [];
    for (let i = 0; i < this.values[23]!; i++)
      waves.push({ amplitude: this.values[34 + i * 8]!, wavenumber: this.values[35 + i * 8]! });
    const depth = breakerDepth(waves),
      level = this.values[21]! - depth,
      held = this.breakers;
    if (held && held.level === level && held.data === terrain.heights.data) return held.lines;
    const lines = depth > 0 ? contourSegments(terrain.heights, terrain.origin, terrain.size, level) : [];
    this.breakers = { level, data: terrain.heights.data, lines };
    return lines;
  }
  private breakers?: { level: number; data: ArrayLike<number>; lines: [number, number][][] };
  /**
   * Sets the wind, a speed in m/s at 10 m or `{ speed, fetch, direction }`, and retunes the eight swell trains to its sea
   * (amplitudes, directions and steepness; the wavelengths stay). Read every frame; no fold at any speed.
   * @throws TypeError with `options.waves` (the trains are then fixed); RangeError outside 0-100 m/s.
   */
  setWind(wind: number | WaterWind): this {
    if (this.disposed || !this.windSea)
      throw new TypeError('setWind needs a Water without options.waves; the trains you passed stay as they are');
    // A fetch or direction left out, or given as undefined, keeps the held one: the sea is built from the merged wind, so
    // it is the sea the Water then reports (a spread of `undefined` over the held values would build it from defaults).
    const next = windOf(wind),
      held = this.windSea;
    this.windSea = {
      speed: next.speed,
      fetch: next.fetch ?? held.fetch,
      direction: next.direction ?? held.direction,
    };
    const sea = seaOf(this.windSea);
    this.maxWaveHeight = 0;
    sea.waves.forEach((w, i) => {
      const o = 32 + i * 8,
        length = Math.hypot(w.direction[0], w.direction[1]);
      this.values[o] = w.direction[0] / length;
      this.values[o + 1] = w.direction[1] / length;
      this.values[o + 2] = w.amplitude;
      this.values[o + 4] = w.steepness ?? 0.5;
      this.waveHeights[i] = w.amplitude;
      this.maxWaveHeight = Math.max(this.maxWaveHeight, w.amplitude);
    });
    this.followWind();
    return this;
  }
  /**
   * Sets the foam from the wind (see `WaterOptions.whitecaps`): the fraction of the sea under foam is Monahan and
   * O'Muircheartaigh's W = 3.84e-6 U^3.41, none below 3 m/s. A crest breaks where the swell's slope term of `whitecap()`
   * (a sum of sines of known amplitudes) passes a threshold; with a Gaussian crest of standard deviation sigma, the
   * threshold that a share p of the sea passes is sigma x z(p) (z from Abramowitz and Stegun 26.2.23). The foam that
   * reaches half white is thinner than the crest that passes (FOAM_Y, FOAM_Z, measured). Nothing but the waves' own numbers is
   * read, so the threshold follows the wind, the fetch and `setWaveHeight`, and the chop does not change it.
   */
  /**
   * Runs the flow ticks the film clock owes, at most `limit`, into `encoder`: each tick's slice of the frame uniform (its
   * start time on the wave clock, its step) worked out here in doubles, written once to the ring, copied into the frame
   * uniform before the tick's flow substep and spray step; the frame's own values copied back after the last. Returns how
   * many ran.
   */
  private tickFlow(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    clock: WaterClock,
    limit = WATER_FLOW_TICKS_PER_FRAME,
  ): number {
    const coastal = this.coastal as CoastalFlow,
      substeps = coastal.substeps,
      rate = flowRate(substeps),
      target = clock.ticks(rate);
    if (!Number.isSafeInteger(target) || target < 0)
      throw new RangeError(`A Water clock gives whole ticks from 0; got ${target}. Pass a FilmClock.`);
    if (!coastal.isSetUp) {
      // The set-up (the surf's spin-up reads the wave clock) runs at the time of the flow's first tick, as a continuous
      // run from that time sets it up, whatever frame builds it: the tick's slice goes into the frame uniform before the
      // set-up's submissions and the frame's values back after them.
      const slice = (this.tickSlice ??= new Float32Array(TICK_FLOATS));
      for (let j = 0; j < TICK_FLOATS; j++) slice[j] = this.values[j]!;
      slice[20] = this.flowTicks / rate;
      slice[100] = substeps / (3 * rate);
      slice[30] = 1 / rate;
      device.queue.writeBuffer(this.uniform!, 0, slice as Float32Array<ArrayBuffer>);
      coastal.ready();
      device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>, 0, TICK_FLOATS);
    }
    const owed = Math.min(limit, target - this.flowTicks);
    if (!(owed > 0)) return 0;
    this.ring ??= device.createBuffer({
      size: (WATER_FLOW_TICKS_PER_FRAME + 1) * TICK_BYTES,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const ring = (this.ringData ??= new Float32Array((WATER_FLOW_TICKS_PER_FRAME + 1) * TICK_FLOATS)),
      values = this.values;
    for (let i = 0; i <= owed; i++) {
      const o = i * TICK_FLOATS;
      for (let j = 0; j < TICK_FLOATS; j++) ring[o + j] = values[j]!;
      if (i === owed) break; // the frame's own values, put back after the ticks
      ring[o + 20] = (this.flowTicks + i) / rate;
      ring[o + 100] = substeps / (3 * rate);
      ring[o + 30] = 1 / rate;
    }
    device.queue.writeBuffer(this.ring, 0, ring as Float32Array<ArrayBuffer>, 0, (owed + 1) * TICK_FLOATS);
    coastal.writeSources();
    for (let i = 0; i < owed; i++) {
      encoder.copyBufferToBuffer(this.ring, i * TICK_BYTES, this.uniform!, 0, TICK_BYTES);
      coastal.tick(encoder);
      this.spray?.step(encoder);
    }
    encoder.copyBufferToBuffer(this.ring, owed * TICK_BYTES, this.uniform!, 0, TICK_BYTES);
    this.flowTicks += owed;
    return owed;
  }
  /**
   * Runs every flow tick the film clock owes now, `WATER_FLOW_TICKS_PER_FRAME` to a submission, and resolves when the GPU
   * has finished them: after a seek far ahead the flow then holds what a continuous run holds. Nothing to do before the
   * flow is built (the first frame with a terrain builds it) or without one.
   * @throws MargoError `state` without `options.clock`.
   */
  async settle(): Promise<void> {
    const clock = this.options.clock;
    if (!clock) throw new MargoError('state', 'Water.settle needs a film clock; pass options.clock (a FilmClock).');
    const device = this.engine?.gpu;
    if (!(this.coastal instanceof CoastalFlow) || !this.uniform || !device) return;
    for (;;) {
      const encoder = device.createCommandEncoder(),
        ran = this.tickFlow(device, encoder, clock);
      device.queue.submit([encoder.finish()]);
      if (ran < WATER_FLOW_TICKS_PER_FRAME) break;
    }
    await device.queue.onSubmittedWorkDone();
  }
  /** The sea's waves at Water's time into the frame uniform: computed by the sea in doubles, rounded once to f32. */
  private writeSea(sea: WaterSea): void {
    const count = sea.waveComponents(this.seconds, this.seaRows);
    if (!Number.isInteger(count) || count < 0 || count > WATER_SEA_WAVES)
      throw new RangeError(
        `Water draws 0 to ${WATER_SEA_WAVES} sea waves; the sea gave ${count}. Give the wave spectrum fewer frequencies or directions.`,
      );
    this.values[SEA_AT] = count;
  }
  private followWind(): void {
    if (!this.windSea) return;
    let slopes = 0;
    for (let i = 0; i < this.values[23]; i++) {
      const o = 32 + i * 8,
        slope = this.values[o + 2] * this.values[o + 3] * this.values[o + 7];
      for (const [share, scale] of SWELL_COMPONENTS) slopes += 0.5 * 1.12 * (slope * share * scale) ** 2;
    }
    // Glitter: the sea's mean square slope is Cox and Munk's 0.003 + 0.00512 U (1954). The swell and the ripple layers
    // (about 0.003) give some of it; the sun's glint lobe takes the rest as extra width (added to GGX's alpha squared).
    this.values[133] = GLINT_LOBE * Math.max(0, 0.003 + 0.00512 * this.windSea.speed - slopes - GLINT_RIPPLES);
    if (!this.foamFollowsWind) return;
    const cover = whitecapCoverage(this.windSea.speed);
    if (this.windSea.speed < FOAM_MIN_WIND || cover <= 0) {
      this.values[130] = this.values[132] = 0;
      return;
    }
    const variance = FOAM_NOISE * FOAM_NOISE + slopes;
    // The standard score y of the covered share, then the threshold score z whose foam reaches it (FOAM_Y, FOAM_Z).
    const y = upperScore(Math.min(0.9, cover));
    let z = y - (FOAM_Y[0] - FOAM_Z[0]);
    if (y >= FOAM_Y[FOAM_Y.length - 1]) z = y - (FOAM_Y[FOAM_Y.length - 1] - FOAM_Z[FOAM_Z.length - 1]);
    else if (y > FOAM_Y[0])
      for (let i = 1; i < FOAM_Y.length; i++)
        if (y <= FOAM_Y[i]) {
          const f = (y - FOAM_Y[i - 1]) / (FOAM_Y[i] - FOAM_Y[i - 1]);
          z = FOAM_Z[i - 1] + f * (FOAM_Z[i] - FOAM_Z[i - 1]);
          break;
        }
    this.values[130] = Math.min(1, cover / 0.25);
    this.values[132] = Math.max(1e-4, Math.sqrt(variance) * z);
  }
  /**
   * Scales the wave spectrum so its largest configured train has this amplitude in meters; `null` gives the trains back
   * their own amplitudes (the wind's sea, or the `waves` you passed).
   */
  setWaveHeight(height: number | null): this {
    if (height === null) height = this.maxWaveHeight;
    if (this.disposed || !Number.isFinite(height) || height < 0 || height > 100 || (!this.maxWaveHeight && height > 0))
      throw new RangeError(
        'Invalid water wave height; use 0 to 100 meters, and a wave train with an amplitude above 0 to scale',
      );
    for (let i = 0; i < this.values[23]; i++) {
      const o = 32 + i * 8,
        amplitude = this.maxWaveHeight ? (height * this.waveHeights[i]) / this.maxWaveHeight : 0;
      if (this.values[o + 4] * amplitude * this.values[o + 3] > 1 / this.values[23])
        throw fault(
          'failed',
          'Wave steepness would fold the surface; lower the amplitude or steepness, or lengthen the wavelength',
          'geometry',
        );
    }
    for (let i = 0; i < this.values[23]; i++)
      this.values[34 + i * 8] = this.maxWaveHeight ? (height * this.waveHeights[i]) / this.maxWaveHeight : 0;
    this.followWind();
    return this;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Water requires WebGPU; attach a new Water to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    // Kept across a device restore: the shared capture rebuilds its own textures, and releasing it there would replace
    // its registration in the scene.
    if (!this.options.depth) this.shared ??= acquireDepth(engine);
    this.source = this.options.depth ?? this.shared!.texture;
    // The uniform supplies the unused connectivity binding when there is no terrain.
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.skySampler = engine.gpu.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
    });
    this.vertices = engine.gpu.createBuffer({
      size: this.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    engine.gpu.queue.writeBuffer(this.vertices, 0, this.positions as Float32Array<ArrayBuffer>);
    this.indices = engine.gpu.createBuffer({
      size: this.triangles.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    engine.gpu.queue.writeBuffer(this.indices, 0, this.triangles as Uint32Array<ArrayBuffer>);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':draw',
      order: 4,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawSurface(c);
      },
    });
  }
  private validateLights(): void {
    const lights = this.options.lights;
    if (lights === undefined) return;
    if (!Array.isArray(lights) || lights.length > 2)
      throw new RangeError('Water accepts up to two directional lights; pass options.lights with at most two entries');
    for (const light of lights) {
      if (!light || light.direction?.length !== 4 || light.radiance?.length !== 3)
        throw new RangeError(
          'Invalid water light; use a finite direction [x, y, z, w >= 0] that is not zero and a finite radiance [r, g, b] of 0 or more',
        );
      for (let i = 0; i < 4; i++)
        if (
          !Number.isFinite(Math.fround(light.direction[i])) ||
          (i < 3 && (!Number.isFinite(Math.fround(light.radiance[i])) || light.radiance[i] < 0))
        )
          throw new RangeError(
            'Invalid water light; use a finite direction [x, y, z, w >= 0] that is not zero and a finite radiance [r, g, b] of 0 or more',
          );
      if (
        light.direction[3] < 0 ||
        !Math.hypot(Math.fround(light.direction[0]), Math.fround(light.direction[1]), Math.fround(light.direction[2]))
      )
        throw new RangeError(
          'Invalid water light; use a finite direction [x, y, z, w >= 0] that is not zero and a finite radiance [r, g, b] of 0 or more',
        );
    }
  }
  // The fill surface per heightmap texel centre, or undefined with no fill and no still.
  private fillCells(terrain: GPUTexture): Float32Array | undefined {
    const { fill, still, terrain: place } = this.options;
    if (!fill && !still) return undefined;
    const { width, height } = terrain,
      cells = new Float32Array(width * height).fill(NO_FILL);
    if (fill)
      for (let j = 0; j < height; j++)
        for (let i = 0; i < width; i++) {
          const level = fill(
            place!.origin[0] + ((i + 0.5) * place!.size[0]) / width, // float division: metres
            place!.origin[1] + ((j + 0.5) * place!.size[1]) / height, // float division: metres
          );
          if (level !== undefined && Number.isFinite(level)) cells[j * width + i] = level;
        }
    return cells;
  }
  private drawSurface(c: Context): void {
    resolveMSAA(c);
    const samples = c.descriptor.multisample?.count ?? 1;
    const depth = this.source!();
    if (
      !depth ||
      depth.width !== c.width ||
      depth.height !== c.height ||
      !depth.format.startsWith('depth') ||
      !(depth.usage & GPUTextureUsage.TEXTURE_BINDING)
    )
      throw new MargoError('state', 'Water needs viewport-sized sampleable scene depth; return one from options.depth');
    const source = this.options.reflectionEnvironment ?? this.options.reflection;
    const reflection = skyTexture(source);
    if (
      source &&
      (!reflection ||
        reflection.dimension !== '2d' ||
        reflection.sampleCount !== 1 ||
        reflection.depthOrArrayLayers > 1 ||
        reflection.format !== 'rgba16float' ||
        !(reflection.usage & GPUTextureUsage.TEXTURE_BINDING))
    )
      throw new MargoError(
        'state',
        'Water reflection needs a sampleable rgba16float sky texture from Sky or Environment',
      );
    if (this.reflected !== reflection) {
      this.reflected = reflection;
      this.built++;
    }
    this.values[27] = +!!reflection;
    const scene = this.options.sceneColor?.();
    this.values[111] = +!!scene;
    if (this.options.sceneColor) {
      if (
        !scene ||
        scene.dimension !== '2d' ||
        scene.sampleCount !== 1 ||
        scene.depthOrArrayLayers > 1 ||
        scene.width !== c.width ||
        scene.height !== c.height ||
        scene.format !== 'rgba16float' ||
        scene.format !== c.format ||
        !(scene.usage & GPUTextureUsage.COPY_SRC)
      )
        throw new MargoError(
          'state',
          'Water scene color needs a viewport-sized copyable HDR color texture; return an rgba16float one from options.sceneColor',
        );
      const target = sceneTarget(c);
      // The 1x opaque resolve is separate from our 4x color attachment and stays unchanged during this pass.
      if (
        samples === 4 &&
        target?.samples === 4 &&
        scene === target.resolvedColor &&
        scene.usage & GPUTextureUsage.TEXTURE_BINDING
      ) {
        if (this.colorSource.texture !== scene || !this.capturedView || this.captured) {
          this.captured?.destroy();
          this.captured = undefined;
          this.capturedView = scene.createView();
          this.built++;
        }
        this.colorSource.texture = scene;
      } else {
        if (
          this.captured?.width !== c.width ||
          this.captured?.height !== c.height ||
          this.captured?.format !== c.format
        ) {
          this.captured?.destroy();
          this.captured = c.device.createTexture({
            size: [c.width, c.height],
            format: c.format,
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.capturedView = this.captured.createView();
          this.colorTarget.texture = this.captured;
          this.colorSize.width = c.width;
          this.colorSize.height = c.height;
          this.built++;
        }
        this.colorSource.texture = scene;
        c.encoder.copyTextureToTexture(this.colorSource, this.colorTarget, this.colorSize);
      }
    }
    if (
      this.surfaceDepth?.width !== c.width ||
      this.surfaceDepth?.height !== c.height ||
      this.surfaceDepth?.format !== depth.format ||
      this.surfaceDepth?.sampleCount !== samples
    ) {
      const changed = this.surfaceDepth?.format !== depth.format || this.surfaceDepth?.sampleCount !== samples;
      this.surfaceDepth?.destroy();
      this.surfaceDepth = c.device.createTexture({
        size: [c.width, c.height],
        format: depth.format,
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.surfaceView = this.surfaceDepth.createView();
      this.copiedDepth.view = this.surfaceView;
      this.built++;
      if (changed) {
        const module = c.device.createShaderModule({ code: depthCopy });
        this.copyPipeline = c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [] },
          depthStencil: { format: depth.format, depthWriteEnabled: true, depthCompare: 'always' },
          multisample: { count: samples },
        });
        this.format = '';
      }
    }
    if (
      (samples === 4 &&
        (this.foamMSAA?.width !== c.width || this.foamMSAA.height !== c.height || !this.foamMSAAView)) ||
      (samples === 1 && this.foamMSAA)
    ) {
      this.foamMSAA?.destroy();
      this.foamMSAA = undefined;
      this.foamMSAAView = undefined;
      if (samples === 4) {
        this.foamMSAA = c.device.createTexture({
          size: [c.width, c.height],
          format: 'r8unorm',
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.foamMSAAView = this.foamMSAA.createView();
      }
    }
    const view = (this.view = this.drawnView = this.views.get(c));
    if (view.foam[0]?.width !== c.width || view.foam[0]?.height !== c.height) {
      for (const texture of view.foam) texture.destroy();
      view.foam = [];
      for (let i = 0; i < 2; i++)
        view.foam.push(
          c.device.createTexture({
            size: [c.width, c.height],
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
          }),
        );
      view.foamViews = view.foam.map((texture) => texture.createView());
      view.built = -1;
      view.current = 0;
    }
    const shadows = this.options.shadows,
      fog = this.fogSource;
    if (fog) {
      writeFog(fog, c.camera.position, this.fogData);
      this.fogBuffer ??= c.device.createBuffer({
        size: FOG_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      c.device.queue.writeBuffer(this.fogBuffer, 0, this.fogData);
    }
    const effects = surfaceEffects.get(this) ?? [];
    const extra: GPUBindGroupEntry[] = [];
    const vertexExtra: GPUBindGroupEntry[] = [];
    let effectBinding = 9;
    for (const effect of effects) {
      for (const resource of effect.prepare(c)) {
        const entry = { binding: effectBinding++, resource };
        extra.push(entry);
        if (effect.vertex) vertexExtra.push(entry);
      }
    }
    if (
      extra.length !== this.effectBindings.length ||
      extra.some((e, i) => e.resource !== this.effectBindings[i].resource)
    )
      this.built++;
    this.effectBindings = extra;
    this.vertexBindings = vertexExtra;
    const effectKey = effects.map((e) => e.key).join(',');
    const format =
      effectKey + ':' + c.format + ':' + samples + ':' + depth.format + ':' + !!shadows + (fog ? ':fog' : '');
    if (this.format !== format) {
      // Shadow sampling goes after the surface functions, which GPU probes compile on their own.
      let code =
        shader
          .replace('const HORIZON=false;', `const HORIZON=${this.horizon};`)
          .replace('const STILL=false;', `const STILL=${!!this.options.still};`) +
        (shadows ? '\n' + shadows.pbr(1).declarations + shadowed : unshadowed);
      if (this.horizon) code = horizonDepthShader(code);
      let binding = 9;
      for (const effect of effects) {
        code = effect.shader(code, binding);
        binding += effect.count;
      }
      this.shaderCode = fog ? foggedShader(code) : code;
      const module = c.device.createShaderModule({ code: this.shaderCode });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 12,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }, { format: 'r8unorm' }] },
        primitive: { cullMode: 'none' },
        depthStencil: { format: depth.format, depthCompare: 'greater-equal', depthWriteEnabled: true },
        multisample: { count: samples },
      });
      this.format = format;
      this.built++;
      this.shadowEntries = undefined;
    }
    this.values.set(c.camera.matrix);
    this.values.set(c.camera.position, 16);
    if (this.horizon) {
      const [x, z] = this.cell;
      this.values[128] = Math.round(c.camera.position[0] / x) * x;
      this.values[129] = Math.round(c.camera.position[2] / z) * z;
    }
    this.values[20] = this.seconds;
    if (this.options.sea) this.writeSea(this.options.sea);
    this.values[28] = c.camera.near;
    this.values[29] = c.camera.far;
    this.values[30] = c.delta;
    this.values[31] = +linearHdr(c.format);
    this.values.set(c.view?.viewport ?? [0, 0, c.width, c.height], 140);
    const lighting = this.engine!.lighting;
    this.values[19] = lighting?.radiance[3] ?? 0.15;
    if (lighting) {
      unitLight(this.values, 104, lighting.direction);
      this.values[108] = lighting.radiance[0];
      this.values[109] = lighting.radiance[1];
      this.values[110] = lighting.radiance[2];
    }
    this.validateLights();
    this.values.fill(0, 112, 128);
    if (this.options.lights) {
      for (let i = 0; i < this.options.lights.length; i++) {
        const light = this.options.lights[i],
          length = Math.hypot(light.direction[0], light.direction[1], light.direction[2]);
        for (let j = 0; j < 3; j++) this.values[112 + i * 8 + j] = light.direction[j] / length;
        this.values[115 + i * 8] = light.direction[3];
        this.values.set(light.radiance, 116 + i * 8);
      }
    } else {
      this.values.copyWithin(112, 104, 108);
      this.values.copyWithin(116, 108, 111);
    }
    // A film clock behind the flow (a seek back): the flow starts again and replays its ticks.
    if (
      this.options.clock &&
      this.coastal instanceof CoastalFlow &&
      this.options.clock.ticks(flowRate(this.coastal.substeps)) < this.flowTicks
    )
      this.coastalSource = undefined;
    if (this.options.terrain) {
      const terrain = this.options.terrain.heightmap();
      if (
        !terrain ||
        terrain.dimension !== '2d' ||
        terrain.sampleCount !== 1 ||
        terrain.depthOrArrayLayers > 1 ||
        terrain.width < 2 ||
        terrain.height < 2 ||
        terrain.format !== 'r32float' ||
        !(terrain.usage & GPUTextureUsage.TEXTURE_BINDING)
      )
        throw new MargoError(
          'state',
          'Water terrain needs a sampleable 2D r32float heightmap of at least 2 cells per side; return one from options.terrain.heightmap',
        );
      const river = riverKernels.get(this),
        solver = waterSolvers.get(this);
      // The flow keeps one connectivity word a cell in a storage binding, and the open-sea surf nine (surf.ts).
      const cells = terrain.width * terrain.height,
        bytes = (solver || river || this.options.still ? cells + 1 : coastSurf.words(cells)) * 4,
        room = Math.min(c.device.limits.maxStorageBufferBindingSize, c.device.limits.maxBufferSize);
      if (bytes > room)
        throw new MargoError(
          'state',
          `Water terrain of ${terrain.width} x ${terrain.height} cells needs ${bytes} B in one storage binding, over this device's ${room} B; use larger cells`,
        );
      // No recorded source (a new Water, resetTime, a seek back on the film clock) always builds a fresh flow: with no river
      // and no solver, an unset record compared equal to the current pair and the old flow stayed.
      if (
        !this.coastalSource ||
        this.coastal?.terrain !== terrain ||
        this.coastalSource[0] !== river ||
        this.coastalSource[1] !== solver
      ) {
        this.spray?.dispose();
        this.spray = undefined;
        this.coastal?.dispose();
        this.coastal = undefined;
        this.flowTicks = 0;
        this.coastal = solver
          ? solver({ device: c.device, uniform: this.uniform!, terrain, fill: this.fillCells(terrain) })
          : new CoastalFlow(
              c.device,
              this.uniform!,
              terrain,
              this.fillCells(terrain),
              this.options.still,
              river,
              coastSurf,
            );
        this.coastalSource = [river, solver];
        if (this.options.spray)
          this.spray = new Spray(c.device, this.uniform!, this.coastal, this.options.sprayCount ?? 4096);
        this.values[101] = this.values[98] / terrain.width;
        this.values[102] = this.values[99] / terrain.height;
        this.built++;
      }
      this.values[100] = Math.min(Math.max(c.delta, 0), 1 / 15) / 3;
    }
    writeSkySampling(source, this.values, 119, 127, 0);
    // Up to the sea's last row: the header row always (a count of 0 without a sea), the rows only as many as it gave.
    c.device.queue.writeBuffer(
      this.uniform!,
      0,
      this.values as Float32Array<ArrayBuffer>,
      0,
      SEA_AT + 4 + 4 * this.values[SEA_AT]!,
    );
    // A film clock steps Water's own flow in ticks; a solver on the bridge (water/flood) keeps its own clock.
    if (this.options.clock && this.coastal instanceof CoastalFlow)
      this.tickFlow(c.device, c.encoder, this.options.clock);
    else {
      this.coastal?.step(c.encoder);
      this.spray?.step(c.encoder);
    }
    if (this.sampledDepth !== depth) {
      this.sampledDepth = depth;
      this.built++;
    }
    if (this.copyBuilt !== this.built) {
      this.depthView = depth.createView({ aspect: 'depth-only' });
      this.copyGroup = group(c.device, this.copyPipeline!, [this.depthView]);
      this.copyBuilt = this.built;
    }
    if (view.built !== this.built) {
      view.groups = [];
      view.resources = [];
      view.captureGroups.clear();
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < (this.coastal ? 2 : 1); j++) {
          const resources: GPUBindingResource[] = [
            { buffer: this.uniform! },
            this.depthView!,
            view.foamViews[i],
            this.coastal?.views[j] ?? view.foamViews[i],
            reflection?.createView() ?? view.foamViews[i],
            this.skySampler!,
            this.capturedView ?? view.foamViews[i],
            { buffer: this.coastal?.connected ?? this.uniform! },
          ];
          if (fog) resources.push({ buffer: this.fogBuffer! });
          view.groups.push(
            c.device.createBindGroup({
              layout: this.pipeline!.getBindGroupLayout(0),
              entries: [...resources.map((resource, binding) => ({ binding, resource })), ...this.effectBindings],
            }),
          );
          view.resources.push(resources);
        }
      view.built = this.built;
    }
    // The shadow source owns its entries; a new array (resize, restoration) rebuilds group 1.
    const shadowEntries = shadows?.bindings();
    if (shadowEntries && this.shadowEntries !== shadowEntries) {
      this.shadowGroup = c.device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(1),
        entries: shadowEntries,
      });
      this.shadowEntries = shadowEntries;
    }
    const target = sceneTarget(c);
    // In the surface depth's own format: a capture's depth (e.g. TAA's, the canvas's depth32float-stencil8) can differ
    // from the source depth this surface copies its format from, and a mismatched copy pipeline fails the whole frame.
    if (target && samples === 4) target.copyDepth(c.encoder, this.surfaceView!, 4, this.surfaceDepth!.format);
    else {
      const copy = c.encoder.beginRenderPass(this.depthPresentation);
      copy.setPipeline(this.copyPipeline!);
      copy.setBindGroup(0, this.copyGroup!);
      applyView(copy, c);
      copy.draw(3);
      copy.end();
    }
    view.drawn = view.current * (this.coastal ? 2 : 1) + (this.coastal?.current ?? 0);
    let changedColor = false;
    const readyPasses = surfacePasses.get(this);
    if (readyPasses) for (const entry of readyPasses) changedColor = !!entry.draw(c) || changedColor;
    // A source-ready lighting pass updates the opaque target before refraction.
    // The single-sample route owns a copy rather than the target's live view.
    if (changedColor && this.captured && this.colorSource.texture === target?.resolvedColor)
      c.encoder.copyTextureToTexture(this.colorSource, this.colorTarget, this.colorSize);
    const bind = view.groups[view.drawn];
    view.current = 1 - view.current;
    this.attachment.view = c.color;
    this.foamAttachment.view = samples === 4 ? this.foamMSAAView! : view.foamViews[view.current];
    this.foamAttachment.resolveTarget = samples === 4 ? view.foamViews[view.current] : undefined;
    this.foamAttachment.storeOp = samples === 4 ? 'discard' : 'store';
    this.depthAttachment.view = this.surfaceView!;
    const pass = c.encoder.beginRenderPass(this.presentation);
    applyView(pass, c);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bind);
    if (shadowEntries) pass.setBindGroup(1, this.shadowGroup!);
    pass.setVertexBuffer(0, this.vertices!);
    pass.setIndexBuffer(this.indices!, 'uint32');
    pass.drawIndexed(this.count);
    pass.end();
    // The capture's depth holds no water: a later pass that needs the sea's depth (VolumetricFog) reads this one.
    publishSurfaceDepth(c, this.surfaceDepth!);
    this.spray?.draw(
      c,
      this.surfaceDepth!,
      this.surfaceView!,
      reflection,
      this.skySampler!,
      fog ? this.fogBuffer : undefined,
    );
  }
  /**
   * Lets a capture hook (`@margoengine/post` SSR: `ssr.add(water)`) draw the water surface with `draw(c, 'capture', ...)`
   * into its targets: the sky reflection the water added (so SSR replaces it where its ray hits instead of adding to it),
   * the Fresnel weight, the rippled normal and roughness. Depth tested (greater-equal) and written, so SSR also traces
   * against the water. Returns a remover. Without a hook the water draws exactly as before.
   */
  setCapture(hook: WaterCapture): () => void {
    if (
      this.disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw new TypeError(
        'Invalid water capture hook; pass an object with a targets array and the callbacks it documents',
      );
    this.capture = hook;
    return () => {
      if (this.capture === hook) this.capture = undefined;
    };
  }
  /** Calls `callback` once when the water is disposed; returns a remover. */
  onDispose(callback: () => void): () => void {
    if (typeof callback !== 'function')
      throw new TypeError('Water onDispose needs a function; pass the callback to run on dispose');
    this.disposers.add(callback);
    return () => this.disposers.delete(callback);
  }
  /** `mode` 'capture': draws this frame's surface into the capture hook's pass (`setCapture`); `color` and `depth` are
   * unused (the hook's pass has its own). Does nothing before the water's first draw, without a hook or after disposal. */
  draw(
    c: Extract<PassContext, { backend: 'webgpu' }>,
    mode: 'capture',
    color?: GPUTextureView,
    depth?: GPUTextureView,
  ): void {
    const hook = this.capture;
    const view = this.view;
    if (mode !== 'capture' || !hook || this.disposed || !view?.groups.length || !this.shaderCode) return;
    void color;
    void depth;
    const shadows = this.options.shadows,
      declarations = hook.declarations(this.shaderCode),
      key =
        hook.targets.map((t) => t.format).join(',') +
        ':' +
        c.descriptor.multisample?.count +
        ':' +
        c.descriptor.depthStencil!.format +
        '\0' +
        declarations +
        '\0' +
        this.shaderCode;
    let capture = this.captures.get(key);
    if (!capture) {
      const module = c.device.createShaderModule({ code: captureShader(this.shaderCode, declarations) });
      const pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 12,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: hook.targets as GPUColorTargetState[] },
        primitive: { cullMode: 'none' },
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthCompare: 'greater-equal',
          depthWriteEnabled: true,
        },
        multisample: c.descriptor.multisample,
      });
      if (this.captures.size >= 8) {
        this.captures.clear();
        for (const state of this.views.values()) state.captureGroups.clear();
      }
      this.captures.set(key, (capture = { pipeline }));
    }
    const pipeline = capture.pipeline;
    // The capture fragment ends before the fog mix, so its layout has no fog binding (resource 8).
    let groups = view.captureGroups.get(pipeline);
    if (!groups)
      view.captureGroups.set(
        pipeline,
        (groups = view.resources.map((resources) =>
          c.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              ...resources.slice(0, 8).map((resource, binding) => ({ binding, resource })),
              ...this.effectBindings,
            ],
          }),
        )),
      );
    const entries = shadows?.bindings();
    if (entries && capture.shadowEntries !== entries) {
      capture.shadowEntries = entries;
      capture.shadow = c.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries });
    }
    const pass = hook.begin();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, groups[view.drawn]);
    if (entries) pass.setBindGroup(1, capture.shadow!);
    pass.setVertexBuffer(0, this.vertices!);
    pass.setIndexBuffer(this.indices!, 'uint32');
    pass.drawIndexed(this.count);
  }
  private release(): void {
    this.captures.clear();
    for (const state of this.views.values()) state.captureGroups.clear();
    this.shaderCode = '';
    this.foamMSAA?.destroy();
    this.foamMSAA = undefined;
    this.foamMSAAView = undefined;
    this.shared?.release();
    this.shared = undefined;
    this.spray?.dispose();
    this.spray = undefined;
    this.coastal?.dispose();
    this.coastal = undefined;
    this.coastalSource = undefined;
    this.surfaceDepth?.destroy();
    this.surfaceDepth = undefined;
    this.surfaceView = undefined;
    this.copyPipeline = undefined;
    this.copyGroup = this.depthView = undefined;
    this.captured?.destroy();
    this.captured = undefined;
    this.capturedView = undefined;
    this.reflected = undefined;
    this.skySampler = undefined;
    this.uniform?.destroy();
    this.vertices?.destroy();
    this.indices?.destroy();
    this.fogBuffer?.destroy();
    this.fogBuffer = undefined;
    this.ring?.destroy();
    this.ring = undefined;
    this.views.clear();
    this.view = this.drawnView = undefined;
    this.built++;
    this.shadowGroup = this.shadowEntries = undefined;
    this.sampledDepth = undefined;
    this.uniform = this.vertices = this.indices = undefined;
    this.pipeline = undefined;
    this.format = '';
  }
  onDeviceRestored(engine: Engine): void {
    const shared = this.shared;
    this.shared = undefined;
    this.release();
    this.shared = shared;
    this.setup(engine);
  }
  /** Seconds on the wave clock: the sum of the frame deltas given to `advanceTime` (each frame update runs it). */
  get time(): number {
    return this.seconds;
  }
  /**
   * Puts the wave clock back to 0 and drops what the surface keeps from earlier frames (each view's foam history, the
   * coastal flow or its solver, the spray), so the next frame builds them as a fresh water does, so a later `seek`
   * (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock) gives what a fresh world seeked there
   * gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.seconds = 0;
    this.views.clear();
    this.view = undefined;
    // The next frame sees no flow built and builds it again, with its solver (water/flood) and spray.
    this.coastalSource = undefined;
    this.flowTicks = 0;
  }
  /**
   * Moves the wave clock by `delta` seconds without drawing (a delta of 0 or less moves nothing). Each frame update
   * runs it, so a seek from `@margoengine/cutscene/seek` replays the waves exactly. Until 2026-11-16 the draw pass
   * moved the clock: hidden water stood still and two views in a frame moved it twice; now it keeps time either way.
   */
  advanceTime(delta: number): void {
    // A film clock owns the time: the wave clock is its time, whatever the frame's delta.
    if (this.options.clock) this.seconds = this.options.clock.time;
    else if (delta > 0) this.seconds += delta;
  }
  /**
   * Sets the wave clock to `seconds` outright (0 to 1e9), as `FFTOcean.setTime` does; the next frame draws the waves
   * there. Throws RangeError for any other value.
   */
  setTime(seconds: number): this {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1e9)
      throw new RangeError('Invalid water time; pass seconds from 0 to 1e9.');
    this.seconds = seconds;
    return this;
  }
  /**
   * Releases the foam of engine views that were not drawn in the last frame (once per frame, not on picks). The view
   * drawn last stays readable for WaveQuery until the next draw.
   */
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
    if (!(delta > 0)) return;
    this.views.prune();
    this.view = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.capture = undefined;
    this.engine = undefined;
    const disposers = [...this.disposers];
    this.disposers.clear();
    for (const callback of disposers) callback();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
