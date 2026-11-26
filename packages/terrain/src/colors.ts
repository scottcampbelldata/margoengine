import { requireWebGPU } from '../../shared/require-webgpu.js';
/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
} from '@margoengine/core/extension';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { noiseCode, openMeshBlock } from './mesh-patch.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number; STORAGE_BINDING: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

type Range = readonly [number, number];
/**
 * Height/slope material bands for {@link TerrainColors}. Colors are linear RGB in 0..1; ranges increase. Every option
 * has a default, so `TerrainColors.attach(engine, mesh)` gives sand at sea level (world Y 0, as `@margoengine/water`),
 * grass over the rest and rock on slopes steeper than about 35 degrees.
 */
export interface TerrainColorOptions {
  /** Beach color below `shore`. Default [0.5, 0.42, 0.29], dry sand (albedo about 0.4). */
  sand?: Vec3;
  /** Low and high meadow colors, blended over `meadowHeight`. Default [0.133, 0.263, 0.033] and [0.274, 0.342, 0.064]. */
  meadow?: readonly [Vec3, Vec3];
  /** Rock color above `stoneHeight` and on steep slopes. Default [0.253, 0.223, 0.187], grey rock. */
  stone?: Vec3;
  /** World heights over which sand gives way to meadow and stone. Default [0.3, 1.5]: beaches up to 1.5 m above sea level. */
  shore?: Range;
  /** World heights over which the low meadow color gives way to the high one. Default: the mesh's lowest to highest point. */
  meadowHeight?: Range;
  /**
   * World heights over which meadow gives way to stone. Default: above the mesh's highest point, so only slopes are
   * stone; pass a range for rocky peaks.
   */
  stoneHeight?: Range;
  /** Surface normal Y (0 vertical, 1 flat) over which steep stone gives way to meadow. Default [0.75, 0.85]: 32 to 41 degrees. */
  stoneNormal?: Range;
  /** World heights over which the wet band dries. Default [-0.1, 0.4], just above sea level. */
  wetHeight?: Range;
  /** Albedo multiplier of fully wet ground, 0..1. Wet ground is also up to 40% smoother. Default 0.6. */
  wetDarkening?: number;
  /**
   * With `wetness`: seconds over which sand the water has left dries to 1/e of its moisture, 1 to 604,800. Default 900
   * (15 minutes): the band behind the swash stays dark for minutes and pales over the next hour.
   */
  wetDryTime?: number;
  /**
   * With `wetness`: seconds over which the glossy water film on sand the water has left drains to 1/e, 0.1 to 3,600.
   * Default 20: the sheen behind the backwash lasts tens of seconds; the sand stays dark after it goes.
   */
  wetGlossTime?: number;
  /** Brightness variation, 0..1 (default 0): two scales of smooth noise darken colors by up to twice this. */
  variation?: number;
  /**
   * Per-pixel material detail, 0..1 (default 1). Noise moves each band border by up to 30% of its range; sand, meadow
   * and stone blend by procedural height maps, so sand settles between grass tufts and grass between rock bumps; steep
   * stone gets triplanar strata with a small normal perturbation. Fine detail fades out between 20 and 60 m from the
   * camera. 0 removes all of it from the shader.
   */
  detail?: number;
  /**
   * Moving wet band from a borrowed water-depth texture (red channel, meters) over world XZ `origin`/`size`. Terrain
   * keeps a moisture record over that grid, so sand the swash has left stays wet and dries over `wetDryTime`.
   */
  wetness?: { texture: () => GPUTexture | undefined; origin: Range; size: Range };
  /**
   * Wind-built sand surface on the sand band, on by default with `detail` above 0 (`false` removes it): impact ripples
   * across the wind, streaks along it, and sorting by slope (lee slip faces paler and smooth, windward faces darker
   * and rippled), so dune faces read at a distance. See {@link SandSurface}.
   */
  sandSurface?: SandSurface | false;
}
/** Wind-built sand detail of {@link TerrainColorOptions.sandSurface}. Every field has a default. */
export interface SandSurface {
  /** Direction the wind blows toward, world `[x, z]`, any length above 0. Default [1, 0] (toward +x). */
  wind?: readonly [number, number];
  /** Ripple spacing, metres, 0.02 to 1. Default 0.1 (impact ripples of fine to medium sand are 5 to 20 cm apart). */
  ripple?: number;
  /** Ripple relief, 0 (flat) to 2. Default 1: height 1/15 of the spacing, lee 19 and stoss 5.5 degrees. */
  ripples?: number;
  /** Streak contrast along the wind, 0 to 1. Default 1: albedo varies by up to 8% either way. */
  streaks?: number;
  /** Sorting by slope, 0 to 1. Default 1: lee slip faces up to 10% paler, windward faces up to 7% darker. */
  sorting?: number;
  /**
   * Broad scour bands along the wind, 0 to 1. Default 0 (none). They are 8 to 15 m wide and about 80 m long, vary the
   * albedo by up to 15% either way at 1 and never fade with distance (they are wider than a pixel at any range), so a
   * dune face hundreds of metres away still shows the wind's work after the ripples and fine streaks clamp out.
   */
  broad?: number;
}
let serial = 0;

// Defaults (GAP-FILM-LOOK). Colours: dry sand albedo 0.35 to 0.45 and grass 0.16 to 0.26 (T. R. Oke, "Boundary Layer
// Climates", 2nd ed., 1987, table 1.1); the meadow and rock colours are @margoengine/biomes' grass, meadow and rock
// looks in linear RGB, so a heightfield matches a biome world. Wet ground darkens to about 0.6 of its albedo (J. Lekner
// and M. Dorf, "Why some things are darker when wet", Applied Optics 27(7), 1988). Slopes: loose soil and scree hold up
// to their angle of repose, about 30 to 40 degrees (J. Carrigy, "Experiments on the angles of repose of granular
// materials", Sedimentology 14, 1970), so ground past it shows rock.
const SAND: Vec3 = [0.5, 0.42, 0.29],
  MEADOW: readonly [Vec3, Vec3] = [
    [0.133, 0.263, 0.033],
    [0.274, 0.342, 0.064],
  ],
  STONE: Vec3 = [0.253, 0.223, 0.187];

/** Options with every default filled in; height bands from the mesh's geometry under its own position and scale. */
function withDefaults(
  mesh: Mesh,
  options: TerrainColorOptions,
): Required<Omit<TerrainColorOptions, 'wetness' | 'variation' | 'detail' | 'sandSurface'>> & TerrainColorOptions {
  let low = 0,
    high = 50;
  const vertices = mesh.geometry?.vertices;
  if (vertices?.length) {
    low = Infinity;
    high = -Infinity;
    for (let i = 1; i < vertices.length; i += 6) {
      if (vertices[i] < low) low = vertices[i];
      if (vertices[i] > high) high = vertices[i];
    }
    const scale = mesh.scale.y,
      at = mesh.position.y;
    [low, high] = [at + low * scale, at + high * scale].sort((a, b) => a - b);
    if (!(high > low)) high = low + 1;
  }
  return {
    sand: SAND,
    meadow: MEADOW,
    stone: STONE,
    shore: [0.3, 1.5],
    meadowHeight: [low, high],
    stoneHeight: [high + 1, high + 2],
    stoneNormal: [0.75, 0.85],
    wetHeight: [-0.1, 0.4],
    wetDarkening: 0.6,
    wetDryTime: 900,
    wetGlossTime: 20,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
}

/** The checked, defaulted look of one mesh: what {@link TerrainColors} compiles in and what its uniform holds. */
interface ResolvedLook {
  options: ReturnType<typeof withDefaults>;
  detail: number;
  wetness: TerrainColorOptions['wetness'];
  sand?: Required<SandSurface>;
}
function resolveLook(mesh: Mesh, given: TerrainColorOptions): ResolvedLook {
  if (typeof given !== 'object' || given === null)
    throw new TypeError('Terrain color options must be an object; pass {} or leave them out for the defaults');
  const options = withDefaults(mesh, given);
  if (options.meadow.length !== 2) throw new RangeError('Expected two meadow colors');
  for (const color of [options.sand, ...options.meadow, options.stone])
    if (color.length !== 3 || color.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
      throw new RangeError('Invalid terrain color; use [r, g, b] with each channel between 0 and 1.');
  for (const range of [
    options.shore,
    options.meadowHeight,
    options.stoneHeight,
    options.stoneNormal,
    options.wetHeight,
  ])
    if (range.length !== 2 || !range.every((v) => Number.isFinite(Math.fround(v))) || range[0] >= range[1])
      throw new RangeError('Invalid terrain color range; use [min, max] with finite numbers and min below max.');
  if (
    options.stoneNormal[0] < 0 ||
    options.stoneNormal[1] > 1 ||
    !Number.isFinite(options.wetDarkening) ||
    options.wetDarkening < 0 ||
    options.wetDarkening > 1 ||
    !Number.isFinite(options.variation ?? 0) ||
    (options.variation ?? 0) < 0 ||
    (options.variation ?? 0) > 1
  )
    throw new RangeError(
      'Invalid terrain wetness or variation; stoneNormal must stay within 0..1, wetDarkening and variation must be between 0 and 1.',
    );
  if (
    !(options.wetDryTime >= 1 && options.wetDryTime <= 604800) ||
    !(options.wetGlossTime >= 0.1 && options.wetGlossTime <= 3600)
  )
    throw new RangeError('Invalid terrain drying; wetDryTime must be 1 to 604,800 s and wetGlossTime 0.1 to 3,600 s.');
  const detail = options.detail ?? 1;
  if (typeof detail !== 'number' || !(detail >= 0 && detail <= 1))
    throw new RangeError('Terrain detail must be a number in 0..1');
  const wetness = options.wetness;
  if (
    wetness !== undefined &&
    (!wetness ||
      typeof wetness.texture !== 'function' ||
      !Array.isArray(wetness.origin) ||
      !Array.isArray(wetness.size) ||
      wetness.origin.length !== 2 ||
      wetness.size.length !== 2 ||
      !wetness.origin.every((v) => Number.isFinite(Math.fround(v))) ||
      !wetness.size.every((v) => Number.isFinite(Math.fround(v)) && v > 0))
  )
    throw new RangeError(
      'Invalid terrain wetness map; give a texture function, a finite [x, z] origin and a positive finite [width, depth] size.',
    );
  const sandGiven = options.sandSurface ?? {};
  if (sandGiven !== false && (typeof sandGiven !== 'object' || sandGiven === null))
    throw new TypeError('Terrain sandSurface must be an object or false; leave it out for the defaults');
  const sand =
    sandGiven === false
      ? undefined
      : {
          wind: [1, 0] as readonly [number, number],
          ripple: 0.1,
          ripples: 1,
          streaks: 1,
          sorting: 1,
          broad: 0,
          ...Object.fromEntries(Object.entries(sandGiven).filter(([, value]) => value !== undefined)),
        };
  if (
    sand &&
    (!Array.isArray(sand.wind) ||
      sand.wind.length !== 2 ||
      !sand.wind.every(Number.isFinite) ||
      !(Math.hypot(sand.wind[0], sand.wind[1]) > 1e-6) ||
      !(sand.ripple >= 0.02 && sand.ripple <= 1) ||
      !(sand.ripples >= 0 && sand.ripples <= 2) ||
      !(sand.streaks >= 0 && sand.streaks <= 1) ||
      !(sand.sorting >= 0 && sand.sorting <= 1) ||
      !(sand.broad >= 0 && sand.broad <= 1))
  )
    throw new RangeError(
      'Invalid terrain sandSurface; pass wind as a non-zero finite [x, z], ripple 0.02 to 1 m, ripples 0 to 2, streaks, sorting and broad 0 to 1.',
    );
  return { options, detail, wetness, sand: sand as Required<SandSurface> | undefined };
}
const LOOK_SLOTS = 11;
/**
 * The look as the uniform the surface shader reads, `array<vec4f, 11>`: sand, meadow low, meadow high, stone (rgb) with
 * the wet darkening, one minus it and the roughness slope in their `w`; shore and wet heights; meadow and stone height
 * ranges; the stone normal range; the width of each border's wander (0.6 of the range times detail); the sand wind
 * direction, ripple spacing and relief; and the sand shading strengths. Values are rounded as the shader's constants
 * were, so a look written once draws as the same look compiled in.
 */
function lookArray(options: ResolvedLook['options'], detail: number, sand: ResolvedLook['sand']): Float32Array {
  const v = new Float32Array(LOOK_SLOTS * 4),
    dark = options.wetDarkening,
    wander = (range: Range) => rnd(0.6 * detail * (range[1] - range[0])),
    s = sand ?? { wind: [1, 0] as const, ripple: 0.1, ripples: 1, streaks: 1, sorting: 1, broad: 0 },
    norm = Math.hypot(s.wind[0], s.wind[1]);
  v.set([...options.sand, dark], 0);
  v.set([...options.meadow[0], 1 - dark], 4);
  v.set([...options.meadow[1], dark < 1 ? rnd(0.4 / (1 - dark)) : 0], 8);
  v.set(options.stone, 12);
  v.set([...options.shore, ...options.wetHeight], 16);
  v.set([...options.meadowHeight, ...options.stoneHeight], 20);
  v.set(options.stoneNormal, 24);
  v.set(
    [wander(options.meadowHeight), wander(options.shore), wander(options.stoneHeight), wander(options.stoneNormal)],
    28,
  );
  v.set([rnd(s.wind[0] / norm), rnd(s.wind[1] / norm), rnd(s.ripple), rnd(s.ripples * detail)], 32);
  v.set(
    [
      rnd(0.1 * s.sorting * detail),
      rnd(0.07 * s.sorting * detail),
      rnd(0.16 * s.streaks * detail),
      rnd(0.3 * s.broad * detail),
    ],
    36,
  );
  v.set([rnd(0.14 * s.sorting * detail), rnd(s.ripple / 4), rnd(s.ripple / 2)], 40);
  return v;
}
/** The look fields {@link TerrainColors.setLook} changes while the scene runs, with no shader rebuild. */
export type TerrainLook = Pick<
  TerrainColorOptions,
  | 'sand'
  | 'meadow'
  | 'stone'
  | 'shore'
  | 'meadowHeight'
  | 'stoneHeight'
  | 'stoneNormal'
  | 'wetHeight'
  | 'wetDarkening'
  | 'wetDryTime'
  | 'wetGlossTime'
> & { sandSurface?: SandSurface };
/** Where {@link TerrainColors.setLook} takes `null` to mean the default. */
export type TerrainLookUpdate = { [K in keyof TerrainLook]?: TerrainLook[K] | null };
// The pixel's footprint on the surface, metres: the longer of the screen-space position derivatives, so it follows the
// frame's real size, device pixel ratio and grazing angle (KB-TERRAIN-SAND3).
const footprintLine = 'let terrainColorFootprint=max(length(dpdx(i.position)),length(dpdy(i.position)));';
const surfaceStruct = 'struct TerrainSurface {color:vec3f,normal:vec3f,rough:f32}\n';
// Height-based blending (A. Mishkinis, "Advanced Terrain Texture Splatting", 2013): near a transition the higher surface
// wins within a 0.2 depth. Material heights stay in 0..0.5, so a material at weight 0 never shows through.
const blendCode = `
fn terrainBlend(t:f32,ha:f32,hb:f32)->f32 {
 let a=ha+1.0-t;let b=hb+t;let m=max(a,b)-0.2;let x=max(a-m,0.0);let y=max(b-m,0.0);return y/(x+y);
}
`;
// The wet-sand record (KB-TERRAIN-WETSAND1): one rgba32float texel per water texel, updated once a frame from the
// water's depth. x is the moisture as a share of saturation, y the surface water film, z the share of the full wet
// darkening; x and y rise to the current wetting while water stands there and decay once it has gone:
// - Moisture: sand behind the swash stays saturated while the beach water table holds the pores full, then drains and
//   dries over minutes to hours (D. P. Horn, "Beach groundwater dynamics", Geomorphology 48, 2002,
//   https://doi.org/10.1016/S0169-555X(02)00178-2; R. A. Namikas, B. L. Edwards, M. C. Bitton, J. L. Booth and Y. Zhu,
//   "Temporal and spatial variabilities in the surface moisture content of a fine-grained beach", Geomorphology 114(3),
//   2010, https://doi.org/10.1016/j.geomorph.2009.07.011: a saturated band beside the swash, a 5 to 25% transition
//   landward and dry sand under 5%, mapped every 2 to 4 hours). It falls as exp(-t / wetDryTime), default 900 s.
// - Darkening: wet grains lose albedo by internal reflection in the water film (J. Lekner and M. Dorf, "Why some things
//   are darker when wet", Applied Optics 27(7), 1988, https://doi.org/10.1364/AO.27.001278; S. A. Twomey, C. F. Bohren
//   and J. L. Mergenthaler, Applied Optics 25(3), 1986, https://doi.org/10.1364/AO.25.000431), and most of the drop
//   comes with the first moisture: reflectance falls exponentially with moisture and levels off toward saturation
//   (D. B. Lobell and G. P. Asner, "Moisture effects on soil reflectance", Soil Sci. Soc. Am. J. 66, 2002,
//   https://doi.org/10.2136/sssaj2002.7220; C. Nolet, A. Poortinga, P. Roosjen, H. Bartholomeus and G. Ruessink,
//   "Measuring and modeling the effect of surface moisture on the spectral reflectance of coastal beach sand", PLoS ONE
//   9(11), 2014, https://doi.org/10.1371/journal.pone.0112151). The share is (1 - e^-3m) / (1 - e^-3), 95% of the drop
//   at saturation, so drying sand holds its dark tone and pales late.
// - Gloss: the water film left by the backwash drains into the bed in seconds to tens of seconds above the seepage face
//   (D. P. Horn, "Measurements and modelling of beach groundwater flow in the swash-zone: a review", Continental Shelf
//   Research 26(5), 2006, https://doi.org/10.1016/j.csr.2006.02.001); it falls as exp(-t / wetGlossTime), default 20 s.
// The update gathers its own texel only, so the WebGL2 layer runs it on its fragment tier.
const WET_RECORD = /* wgsl */ `
@group(0) @binding(0) var depth:texture_2d<f32>;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_storage_2d<rgba32float,write>;
@group(0) @binding(3) var<uniform> drying:vec4f;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(after));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let now=smoothstep(0.001,0.025,textureLoad(depth,p,0).r);let w=textureLoad(before,p,0);
 let m=max(now,w.x*exp(-drying.x/drying.y));let f=max(now,w.y*exp(-drying.x/drying.z));
 textureStore(after,p,vec4f(m,f,(1.0-exp(-3.0*m))/(1.0-exp(-3.0)),0.0));
}`;
/**
 * What the wet-sand record of {@link TerrainColors} holds `seconds` after the water left fully wet sand: the moisture
 * and surface film as shares of fully wet, and the share of the full `wetDarkening` the sand still shows.
 */
export function wetSandAfter(
  seconds: number,
  dryTime = 900,
  glossTime = 20,
): { moisture: number; film: number; darkening: number } {
  const moisture = Math.exp(-seconds / dryTime);
  return {
    moisture,
    film: Math.exp(-seconds / glossTime),
    darkening: (1 - Math.exp(-3 * moisture)) / (1 - Math.exp(-3)),
  };
}
const rnd = (value: number) => Math.round(value * 1e6) / 1e6;
const num = (value: number) => String(rnd(value));

/** Height/slope colors on one ordinary mesh, shaded per pixel inside the scene's PBR and shadow shader. */
export class TerrainColors implements EnginePlugin {
  readonly name = 'terrain:colors:' + ++serial;
  private engine?: Engine;
  private source = '';
  private shader = '';
  private disposed = false;
  private readonly surfaceCode: string;
  private readonly wetCode: string;
  private readonly wetness?: TerrainColorOptions['wetness'];
  private dry?: GPUTexture;
  private dryEntry?: GPUBindGroupEntry;
  private wet?: GPUTexture;
  private wetEntry?: GPUBindGroupEntry;
  private wetBinding = 40;
  private lookBinding = 41;
  private given: TerrainColorOptions;
  private look!: Float32Array;
  private lookBuffer?: GPUBuffer;
  private lookEntry?: GPUBindGroupEntry;
  private lookDirty = true;
  private readonly sandOn: boolean;
  private readonly wetSource: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly wetTarget: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly wetSize: GPUExtent3DDict = { width: 1, height: 1 };
  private record?: GPUTexture;
  private recordNext?: GPUTexture;
  private recordGroup?: GPUBindGroup;
  private recordPipeline?: GPUComputePipeline;
  private dryingBuffer?: GPUBuffer;
  private readonly drying = new Float32Array(4);
  private readonly recordSource: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly recordTarget: GPUTexelCopyTextureInfo = { texture: undefined! };
  private elapsed = 0;
  private dryTime = 900;
  private glossTime = 20;
  constructor(
    private readonly mesh: Mesh,
    given: TerrainColorOptions = {},
  ) {
    const { options, detail, wetness, sand } = resolveLook(mesh, given);
    this.wetness = wetness;
    this.given = given;
    this.dryTime = options.wetDryTime;
    this.glossTime = options.wetGlossTime;
    this.look = lookArray(options, detail, sand);
    const U = (slot: number, c: string) => `terrainLook[${slot}].${c}`;
    const variation = options.variation ?? 0;
    // Noise moves a band's border by up to 30% of its range at the 14 m scale, so borders wander like real ones.
    // The ranges and the border wander (0.6 * detail * width) sit in the look uniform: slots 4 and 5 hold the ranges, 7 the wander.
    const band = (lo: string, hi: string, wander: string, at: string) =>
        `smoothstep(${lo},${hi},${at}${detail ? `+large*${wander}` : ''})`,
      blend = (t: string, heights: string) =>
        detail === 1 ? `terrainBlend(${t},${heights})` : `mix(${t},terrainBlend(${t},${heights}),${detail})`;
    // Wind-built sand (KB-TERRAIN-SAND2), on the sand band only. Impact ripples: crests across the wind, spacing 5 to
    // 20 cm set by the reptating grains' hop (R. S. Anderson, "A theoretical model for aeolian impact ripples",
    // Sedimentology 34, 1987; B. Andreotti, P. Claudin and O. Pouliquen, "Aeolian sand ripples: experimental study of
    // fully developed states", Phys. Rev. Lett. 96, 2006), height about 1/15 of it, a long gentle stoss side and a short
    // steep lee (R. P. Sharp, "Wind ripples", J. Geology 71, 1963; R. A. Bagnold, "The Physics of Blown Sand and Desert
    // Dunes", 1941): the slope profile below is 5.5 degrees for 69% of a wavelength and 19 for 19%, smoothed, with zero
    // mean. Crests wander and break off at defects (B. T. Werner and G. Kocurek, "Bedform spacing from defect dynamics",
    // Geology 27, 1999): a two-octave phase warp and an amplitude noise. The relief is a height gradient applied as a
    // surface gradient (M. Mikkelsen, "Surface Gradient-Based Bump Mapping Framework", JCGT 9(3), 2020), clamped out
    // in object space before a pixel covers half a ripple (A. Norton, A. Rockwood and P. Skolmoski, "Clamping: a method
    // of antialiasing textured surfaces by bandwidth limiting in object space", SIGGRAPH 1982): the footprint is the
    // pixel's real one, the longer screen-space derivative of the position (it was distance / 1000, one pixel at 1080
    // lines, and aliased into moire at 540 and 270 lines, KB-TERRAIN-SAND3). Avalanching
    // lee slip faces carry no ripples and show fresh, paler sand; windward faces keep a coarser, darker lag (N.
    // Lancaster, "Geomorphology of Desert Dunes", 1995, ch. 4; R. E. Hunter, "Basic types of stratification in small
    // eolian dunes", Sedimentology 24, 1977) in grainflow tongues, so dune faces read apart in flat overcast light. Streaks run along the
    // wind, 1 to 2 m wide and tens of metres long (R. Greeley and J. D. Iversen, "Wind as a Geological Process", 1985).
    const sandOn = !!sand && detail > 0;
    this.sandOn = sandOn;
    const sandCode = sandOn
      ? `
 let foot=footprint;
 let sw=${U(8, 'xy')};let along=dot(p.xz,sw);let across=dot(p.xz,vec2f(-sw.y,sw.x));
 let face=dot(n.xz,sw);let lee=smoothstep(0.25,0.45,face);let stoss=smoothstep(0.03,0.2,-face);
 var sandShade=1.0+${U(9, 'x')}*lee-${U(9, 'y')}*stoss;
 let streak=(terrainNoise(vec2f(along*0.045,across*0.55)+vec2f(13.0,7.0)).x-0.5)*(1.0-smoothstep(0.45,0.9,foot));
 var fineStreak=0.0;let sf=1.0-smoothstep(0.13,0.26,foot);
 if(sf>0.0){fineStreak=(terrainNoise(vec2f(along*0.13,across*1.9)+vec2f(3.0,29.0)).x-0.5)*sf;}
 sandShade*=1.0+${U(9, 'z')}*(0.65*streak+0.35*fineStreak);
 // Broad scour bands along the wind (Greeley and Iversen 1985), kept at every distance; the amount is 0 by default.
 sandShade*=1.0+${U(9, 'w')}*(terrainNoise(vec2f(along*0.012,across*0.09)+vec2f(23.0,5.0)).x-0.5);
 // Grainflow tongues down the slip faces: strips about 1 m wide along the wind.
 let flow=(terrainNoise(vec2f(along*0.12,across*1.1)+vec2f(41.0,17.0)).x-0.5)*(1.0-smoothstep(0.25,0.5,foot));
 sandShade*=1.0+${U(10, 'x')}*lee*flow;
 var sandGrad=vec3f(0.0);let rv=${U(8, 'w')}*(1.0-smoothstep(${U(10, 'y')},${U(10, 'z')},foot))*(1.0-lee)*(1.0-sandT);
 if(rv>0.0){
  let w1=terrainNoise(p.xz*0.9);let w2=terrainNoise(p.xz*3.3+vec2f(7.0,3.0));let amp=terrainNoise(p.xz*1.7+vec2f(5.0,11.0)).x;
  let t=fract(along/${U(8, 'z')}+1.6*w1.x+0.35*w2.x);
  let up=smoothstep(0.0,0.06,t)*(1.0-smoothstep(0.69,0.75,t));let down=smoothstep(0.75,0.81,t)*(1.0-smoothstep(0.94,1.0,t));
  let r=rv*(0.4+0.6*amp);let d=r*(0.0966*up-0.351*down)*(sw+${U(8, 'z')}*(1.44*w1.yz+1.155*w2.yz));
  sandGrad=vec3f(d.x,0.0,d.y);
  // Coarse grains ride on the crests and lee sides (Bagnold 1941; Sharp 1963): a darker band less its mean, so the
  // clamp keeps the mean colour.
  sandShade*=1.0-0.2*r*(smoothstep(0.55,0.7,t)*(1.0-smoothstep(0.85,1.0,t))-0.3);
 }`
      : '';
    // Per pixel: bands follow the interpolated height and normal, not the triangles. Noise has a 14 m and a 1.1 m
    // octave (turned 52 degrees so the lattices do not align); the fine one fades out by 60 m, before it can alias.
    // Detail: grass tufts (fine noise), sand in their hollows and rock bumps are the height maps of the blend. Rock is
    // triplanar where stone shows: anisotropic noise on the two vertical projections reads as horizontal strata, so
    // cliffs never stretch a top-down pattern; its analytic gradient tilts the normal (surface-gradient bump mapping).
    this.surfaceCode = `
fn terrainSurface(p:vec3f,n:vec3f,footprint:f32)->TerrainSurface {
 var s:TerrainSurface;let h=p.y;${
   variation || detail
     ? `let fade=1.0-smoothstep(20.0,60.0,distance(frame.eye.xyz,p));
 let large=terrainNoise(p.xz*0.07).x-0.5;var fine=0.0;
 if(fade>0.0){fine=(terrainNoise(mat2x2f(0.61566,0.78801,-0.78801,0.61566)*p.xz*0.9).x-0.5)*fade;}`
     : ''
 }
 let meadow=mix(${U(1, 'xyz')},${U(2, 'xyz')},${band(U(5, 'x'), U(5, 'y'), U(7, 'x'), 'h')});
 let shore=${band(U(4, 'x'), U(4, 'y'), U(7, 'y'), 'h')};
 let steep=max(${band(U(5, 'z'), U(5, 'w'), U(7, 'z'), 'h')},1.0-${band(U(6, 'x'), U(6, 'y'), U(7, 'w'), 'n.y')});${
   detail
     ? `
 var rock=large;var grad=vec3f(0.0);
 if(steep>0.004&&fade>0.0){
  let a=n*n;var w=a*a;w/=w.x+w.y+w.z;
  let zy=terrainNoise(vec2f(p.z*0.35,p.y*1.4)+vec2f(17.0,0.0));let xz=terrainNoise(p.xz*0.6);let xy=terrainNoise(vec2f(p.x*0.35,p.y*1.4)+vec2f(0.0,29.0));
  rock=mix(large,w.x*zy.x+w.y*xz.x+w.z*xy.x-0.5,fade);
  grad=fade*(w.x*vec3f(0.0,zy.z*1.4,zy.y*0.35)+w.y*vec3f(xz.y*0.6,0.0,xz.z*0.6)+w.z*vec3f(xy.y*0.35,xy.z*1.4,0.0));
 }
 let grass=0.275+0.35*fine;let stoneT=${blend('steep', 'grass,0.25+0.5*rock')};
 let sandT=${blend('shore', '0.15-0.3*fine,mix(grass,0.25+0.5*rock,stoneT)')};${sandCode}`
     : `
 let stoneT=steep;let sandT=shore;`
 }
 ${wetness ? 'let wr=terrainWet(p);let wet=wr.x;let glint=wr.y;' : `let wet=mix(${U(0, 'w')},1.0,smoothstep(${U(4, 'z')},${U(4, 'w')},h));let glint=wet;`}
 s.color=mix(${U(0, 'xyz')}${detail ? `*(1.0+${num(0.2 * detail)}*fine)` : ''}${sandOn ? '*sandShade' : ''},mix(meadow,${U(3, 'xyz')}${detail ? `*(1.0+${num(0.6 * detail)}*rock)` : ''},stoneT),sandT)*wet${variation ? `*(${num(1 - variation)}+${num(2 * variation)}*(0.65*large+0.35*fine))` : ''};
 s.normal=${detail ? `normalize(n-(grad-n*dot(n,grad))*(${num(0.15 * detail)}*stoneT*sandT)${sandOn ? '-(sandGrad-n*dot(n,sandGrad))' : ''})` : 'n'};
 s.rough=select(1.0,0.6+${U(2, 'w')}*(glint-${U(0, 'w')}),${U(0, 'w')}<1.0);return s;
}
`;
    // The record (WET_RECORD below) holds, per water texel, moisture, film and the darkening share; the fragment blends
    // it bilinearly and keeps it to the beach heights. x of the result is the albedo factor, y the roughness one.
    this.wetCode = wetness
      ? `
@group(0) @binding(9) var terrainWater:texture_2d<f32>;
fn terrainWet(position:vec3f)->vec2f {
 if(position.y>=${U(4, 'w')}){return vec2f(1.0);}
 let uv=(position.xz-vec2f(${wetness.origin.join(',')}))/vec2f(${wetness.size.join(',')});
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return vec2f(1.0);}
 let size=vec2i(textureDimensions(terrainWater));let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let a=textureLoad(terrainWater,lo,0).zy;let b=textureLoad(terrainWater,vec2i(hi.x,lo.y),0).zy;let c=textureLoad(terrainWater,vec2i(lo.x,hi.y),0).zy;let d=textureLoad(terrainWater,hi,0).zy;
 let wet=mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
 let beach=(1.0-smoothstep(${U(4, 'z')},${U(4, 'w')},position.y))*(1.0-smoothstep(${U(4, 'x')},${U(4, 'y')},position.y));
 return 1.0-${U(1, 'w')}*beach*wet;
}
`
      : '';
  }
  static attach(engine: EngineKernel, mesh: Mesh, options: TerrainColorOptions = {}): TerrainColors {
    const colors = new TerrainColors(mesh, options);
    engineRuntime(engine).use(colors);
    return colors;
  }
  setup(engine: Engine): void {
    requireWebGPU(engine, 'TerrainColors');
    const mesh = meshRuntime(this.mesh);
    mesh.check();
    if (this.engine || this.disposed || mesh.engine !== engine)
      throw new MargoError(
        'attached',
        "Terrain color mesh belongs to another engine or is already attached; attach one TerrainColors per mesh, to the mesh's engine",
      );
    this.engine = engine;
    if (this.wetness) {
      this.dry = engine.gpu.createTexture({
        size: [1, 1],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      engine.gpu.queue.writeTexture({ texture: this.dry }, new Float32Array(1), { bytesPerRow: 4 }, [1, 1]);
      this.dryEntry = { binding: 9, resource: this.dry.createView() };
    }
  }
  /** Whether the sand surface was compiled in (not `sandSurface: false`, and `detail` above 0). */
  get sandSurfaceOn(): boolean {
    return this.sandOn;
  }
  /**
   * Changes the look while the scene runs: the colours, height and slope ranges, wet darkening and the sand surface's
   * wind, ripples, streaks, sorting and broad bands. A field left out keeps its value. Nothing is rebuilt: the next frame
   * writes one small uniform, so any of it can be keyed over a shot. `detail`, `variation`, `wetness` and whether
   * `sandSurface` is on were compiled in at construction and stay.
   * @throws TypeError for `sandSurface` fields when the sand surface was built off; RangeError for a value out of range.
   */
  setLook(look: TerrainLookUpdate): void {
    if (typeof look !== 'object' || look === null) throw new TypeError('Terrain look must be an object');
    const own = this.given.sandSurface,
      given: TerrainColorOptions = { ...this.given };
    // A value of null puts the option back to its default (the mesh's own height range, for the height ranges).
    for (const [key, value] of Object.entries(look))
      if (value !== undefined && key !== 'sandSurface') {
        if (value === null) delete (given as Record<string, unknown>)[key];
        else (given as Record<string, unknown>)[key] = value;
      }
    if (look.sandSurface !== undefined) {
      if (!this.sandOn)
        throw new TypeError(
          'This TerrainColors was built without a sand surface (sandSurface false or detail 0); it cannot gain one',
        );
      given.sandSurface = { ...(own || {}), ...look.sandSurface };
    }
    const r = resolveLook(this.mesh, given);
    this.look = lookArray(r.options, r.detail, r.sand);
    this.dryTime = r.options.wetDryTime;
    this.glossTime = r.options.wetGlossTime;
    this.given = given;
    this.lookDirty = true;
  }
  /** Adds the mesh-ID varying once, then this mesh's surface call inside the shared per-pixel block. */
  private patch(source: string, id: number): string {
    const opened = openMeshBlock(source);
    // Silent like the other optional core patches: without the standard shader the mesh keeps its material color.
    if (!opened) return source;
    const { code } = opened;
    // One footprint for every mesh's call, taken where control flow is still uniform; later meshes' calls go after it.
    const shared = code.indexOf(footprintLine),
      at = shared < 0 ? opened.at : shared + footprintLine.length;
    const suffix = '_' + id;
    const own = (
      `@group(0) @binding(${this.lookBinding}) var<uniform> terrainLook:array<vec4f,${LOOK_SLOTS}>;
` +
      this.wetCode.replace('@binding(9)', `@binding(${this.wetBinding})`) +
      this.surfaceCode
    ).replace(/terrainSurface|terrainWater|terrainWet|terrainLook/g, (name) => name + suffix);
    return (
      (code.includes('struct TerrainSurface ') ? '' : surfaceStruct) +
      (this.surfaceCode.includes('terrainNoise(') && !code.includes('fn terrainNoise(') ? noiseCode : '') +
      (this.surfaceCode.includes('terrainBlend(') && !code.includes('fn terrainBlend(') ? blendCode : '') +
      own +
      code.slice(0, at) +
      (shared < 0 ? footprintLine : '') +
      `if(i.terrainId==${id + 1}.0){let s=terrainSurface${suffix}(i.position,n,terrainColorFootprint);i.color=s.color;i.material.x*=s.rough;n=s.normal;}` +
      code.slice(at)
    );
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const mesh = meshRuntime(this.mesh);
        mesh.check();
        if (this.source !== c.shader) {
          this.source = c.shader;
          if (this.wetness) {
            this.wetBinding = 40;
            while (c.bindings.some((entry) => entry.binding === this.wetBinding)) this.wetBinding++;
          }
          this.lookBinding = this.wetness ? this.wetBinding + 1 : 41;
          while (c.bindings.some((entry) => entry.binding === this.lookBinding)) this.lookBinding++;
          this.lookEntry = undefined;
          this.shader = this.patch(c.shader, mesh.id);
        }
        if (this.wetness) {
          const texture = this.wetness.texture();
          if (texture !== undefined) {
            if (
              !texture ||
              texture.dimension !== '2d' ||
              texture.sampleCount !== 1 ||
              texture.depthOrArrayLayers > 1 ||
              !['r32float', 'rgba32float', 'rgba16float'].includes(texture.format) ||
              !(texture.usage & GPUTextureUsage.COPY_SRC)
            )
              throw new TypeError('Terrain wetness needs a copyable water-depth texture');
            // A stable view avoids rebuilding scene/vegetation bindings as flow ping-pongs.
            if (
              this.wet?.width !== texture.width ||
              this.wet?.height !== texture.height ||
              this.wet?.format !== texture.format
            ) {
              this.dropRecord();
              this.wet = c.device.createTexture({
                size: [texture.width, texture.height],
                format: texture.format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              });
              // The record starts dry (zeros). The bound one stays the same texture; the update writes the other and
              // copies it back, so scene and vegetation bindings are not rebuilt each frame.
              this.record = c.device.createTexture({
                size: [texture.width, texture.height],
                format: 'rgba32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              });
              this.recordNext = c.device.createTexture({
                size: [texture.width, texture.height],
                format: 'rgba32float',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
              });
              this.dryingBuffer ??= c.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              });
              this.recordPipeline ??= c.device.createComputePipeline({
                layout: 'auto',
                compute: { module: c.device.createShaderModule({ code: WET_RECORD }), entryPoint: 'main' },
              });
              this.recordGroup = c.device.createBindGroup({
                layout: this.recordPipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: this.wet.createView() },
                  { binding: 1, resource: this.record.createView() },
                  { binding: 2, resource: this.recordNext.createView() },
                  { binding: 3, resource: { buffer: this.dryingBuffer } },
                ],
              });
              this.wetEntry = { binding: 9, resource: this.record.createView() };
              this.wetTarget.texture = this.wet;
              this.recordSource.texture = this.recordNext;
              this.recordTarget.texture = this.record;
              this.wetSize.width = texture.width;
              this.wetSize.height = texture.height;
            }
            this.wetSource.texture = texture;
            c.encoder.copyTextureToTexture(this.wetSource, this.wetTarget, this.wetSize);
            // The seconds since the last update: a frame's later views add none.
            this.drying.set([this.elapsed, this.dryTime, this.glossTime, 0]);
            this.elapsed = 0;
            c.device.queue.writeBuffer(this.dryingBuffer!, 0, this.drying);
            const pass = c.encoder.beginComputePass();
            pass.setPipeline(this.recordPipeline!);
            pass.setBindGroup(0, this.recordGroup!);
            pass.dispatchWorkgroups(Math.ceil(texture.width / 8), Math.ceil(texture.height / 8));
            pass.end();
            c.encoder.copyTextureToTexture(this.recordSource, this.recordTarget, this.wetSize);
          }
          const entry = texture ? this.wetEntry! : this.dryEntry!;
          entry.binding = this.wetBinding;
          c.bindings.push(entry);
        }
        const device = this.engine!.gpu!;
        if (!this.lookBuffer) {
          this.lookBuffer = device.createBuffer({
            size: this.look.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          this.lookDirty = true;
        }
        if (this.lookDirty) {
          device.queue.writeBuffer(this.lookBuffer, 0, this.look as Float32Array<ArrayBuffer>);
          this.lookDirty = false;
        }
        this.lookEntry ??= { binding: this.lookBinding, resource: { buffer: this.lookBuffer } };
        c.bindings.push(this.lookEntry);
        c.shader = this.shader;
      },
    });
  }
  /** Adds the frame's seconds to the wet-sand record's next update. */
  onPreUpdate(delta: number): void {
    this.elapsed += delta;
  }
  /** Frees the water snapshot and the wet-sand record (a new size, a lost device or disposal). */
  private dropRecord(): void {
    this.wet?.destroy();
    this.record?.destroy();
    this.recordNext?.destroy();
    this.wet = this.record = this.recordNext = undefined;
    this.recordGroup = undefined;
    this.recordSource.texture = this.recordTarget.texture = undefined!;
  }
  onDeviceRestored(engine: Engine): void {
    this.dry?.destroy();
    this.dropRecord();
    this.dryingBuffer?.destroy();
    this.dryingBuffer = this.recordPipeline = undefined;
    this.dry = undefined;
    this.dryEntry = this.wetEntry = undefined;
    this.wetSource.texture = this.wetTarget.texture = undefined!;
    this.lookBuffer?.destroy();
    this.lookBuffer = undefined;
    this.lookEntry = undefined;
    this.lookDirty = true;
    this.engine = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dry?.destroy();
    this.dropRecord();
    this.dryingBuffer?.destroy();
    this.dryingBuffer = this.recordPipeline = undefined;
    this.dry = undefined;
    this.dryEntry = this.wetEntry = undefined;
    this.wetSource.texture = this.wetTarget.texture = undefined!;
    this.lookBuffer?.destroy();
    this.lookBuffer = undefined;
    this.lookEntry = undefined;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
