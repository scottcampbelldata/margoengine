/// <reference lib="esnext.disposable" preserve="true" />
// Rock that holds up close (entry `@margoengine/terrain/rock-surface`): a patch of core's standard fragment shader that
// shades the meshes added to it as rock, per pixel from the world position, so a cliff, stack or boulder keeps its
// detail however near the camera comes and needs no UVs or textures. Per pixel:
// - relief: triplanar value-noise bumps in six octaves, as a surface gradient that tilts the shading normal (M. Mikkelsen,
//   "Surface gradient-based bump mapping framework", JCGT 9(3), 2020, https://jcgt.org/published/0009/03/04/; bump
//   mapping after J. F. Blinn, "Simulation of wrinkled surfaces", SIGGRAPH 1978, doi:10.1145/965139.507101); each octave
//   fades out as its wavelength nears the pixel's footprint (A. Norton, A. P. Rockwood, P. T. Skolmoski, "Clamping: a
//   method of antialiasing textured surfaces by bandwidth limiting in object space", SIGGRAPH 1982,
//   doi:10.1145/965145.801274), so distant rock does not shimmer;
// - colour: the rock type's two bed tones banded by strata with thin bedding lines, broad tone variation, dark joint
//   cracks (ridged noise), moss or lichen on faces turned to the sky;
// - water: a wet, algae-dark tide band up to `tide.height` over the rock's sea level and wetting by rain, darkening the
//   albedo and smoothing the surface (J. Lekner and M. C. Dorf, "Why some things are darker when wet", Applied Optics
//   27(7), 1988, doi:10.1364/AO.27.001278; H. W. Jensen, J. Legakis, J. Dorsey, "Rendering of wet materials", EGWR 1999,
//   doi:10.1007/978-3-7091-6809-7_25).
// Rain (`look.rain`) follows a `WeatherDrive` from @margoengine/weather/drive while it is null (the drive finds this
// plugin by its name, `terrain:rocks:N`).
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { noiseCode, openMeshBlock } from './mesh-patch.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** A colour: linear RGB, 0 to 1. */
export type RockColor = readonly [number, number, number];
/** The look every rock of the surface shares; every field is live (`setLook`, or `applyRockSettings`). */
export interface RockLook {
  /** Strength of the fine relief, 0 to 3. Default 1. */
  bump?: number;
  /** Wavelength of the largest relief, metres, 0.05 to 50 (five finer octaves follow, each half of the last). Default 1.6. */
  scale?: number;
  /** How many dark joint cracks show, 0 to 1. Default 0.6. */
  cracks?: number;
  /** Broad tone variation over the rock, 0 to 1. Default 0.5. */
  variation?: number;
  /** How strongly the beds differ in tone and the bedding lines show, 0 to 1. Default 0.6. */
  strata?: number;
  /** Surface roughness of dry rock, 0.3 to 1. Default 0.85. */
  roughness?: number;
  /** Moss or lichen on faces that look up, 0 to 1. Default 0.35. */
  moss?: number;
  /** Moss colour. Default [0.07, 0.1, 0.03]. */
  mossColor?: RockColor;
  /** Top of the wet tide band over each rock's sea level, metres, 0 to 30. Default 1.5. */
  tideHeight?: number;
  /** Dark algae and weed over the lower tide band, 0 to 1. Default 0.6. */
  algae?: number;
  /** Algae colour. Default [0.035, 0.045, 0.02]. */
  algaeColor?: RockColor;
  /** Albedo of fully wet rock against dry, 0 to 1 (1 is no darkening). Default 0.6. */
  wetDarkening?: number;
  /** Share by which wet rock is smoother, 0 to 1. Default 0.4. */
  wetGloss?: number;
  /** Wetness from rain, 0 dry to 1 soaked, or null to follow the weather (a `WeatherDrive` writes it). Default null. */
  rain?: number | null;
}
/** The rock type of one mesh: its colours and bedding. Set when it is added; add it again to change it. */
export interface RockStyle {
  /** A named rock type giving every field below (the fields given override it). Default 'sandstone'. */
  type?: RockType;
  /** Main bed colour, linear RGB. */
  color?: RockColor;
  /** Second bed colour, linear RGB. */
  color2?: RockColor;
  /** Bed thickness for the banding, metres, 0 (massive rock, no bands) to 100. */
  strata?: number;
  /** World height of the water this rock stands in (the tide band is over it). Default 0. */
  seaLevel?: number;
  /** How readily it soaks up rain, 0 to 1 (granite and basalt less than sandstone and chalk). */
  porosity?: number;
  /** Seed of its pattern, an unsigned 32-bit integer. Default 0. */
  seed?: number;
}
/** The named rock types of {@link RockStyle.type}. */
export type RockType = 'sandstone' | 'limestone' | 'chalk' | 'granite' | 'basalt' | 'shale';
/** Colours (linear albedo), bed thickness and porosity of each rock type. */
export const ROCK_TYPES: Readonly<Record<RockType, Required<Omit<RockStyle, 'type' | 'seaLevel' | 'seed'>>>> = {
  sandstone: { color: [0.36, 0.25, 0.15], color2: [0.45, 0.33, 0.21], strata: 1.2, porosity: 0.9 },
  limestone: { color: [0.42, 0.4, 0.35], color2: [0.5, 0.48, 0.42], strata: 0.8, porosity: 0.6 },
  chalk: { color: [0.66, 0.65, 0.6], color2: [0.58, 0.57, 0.53], strata: 1.5, porosity: 1 },
  // Granite from measured spectra, ECOSTRESS Spectral Library 1.0 (Meerdink, Hook, Roberts and Abbott, Remote Sensing of
  // Environment 230, 2019, https://doi.org/10.1016/j.rse.2019.05.015), JHU hand specimens integrated under a 6504 K
  // black body: the main tone is the mean of Granite_H2, H3 and H5 (the `granite` of @margoengine/materials), the second
  // the grey alkalic Granite_H1. Until 2026-11-28 both were chosen, (0.25, 0.219, 0.192) and (0.36, 0.316, 0.266).
  granite: { color: [0.2709, 0.224, 0.1869], color2: [0.1678, 0.171, 0.1512], strata: 0, porosity: 0.25 },
  basalt: { color: [0.07, 0.07, 0.075], color2: [0.1, 0.095, 0.09], strata: 0, porosity: 0.3 },
  shale: { color: [0.16, 0.15, 0.14], color2: [0.22, 0.2, 0.18], strata: 0.25, porosity: 0.5 },
};
const ROCK_FABRIC: Readonly<Record<RockType, number>> = {
  sandstone: 0,
  limestone: 0,
  chalk: 0,
  granite: 1,
  basalt: 2,
  shale: 3,
};
/** The look `RockSurface` starts from. */
export const ROCK_LOOK_DEFAULTS: Readonly<Required<RockLook>> = {
  bump: 1,
  scale: 1.6,
  cracks: 0.6,
  variation: 0.5,
  strata: 0.6,
  roughness: 0.85,
  moss: 0.35,
  mossColor: [0.07, 0.1, 0.03],
  tideHeight: 1.5,
  algae: 0.6,
  algaeColor: [0.035, 0.045, 0.02],
  wetDarkening: 0.6,
  wetGloss: 0.4,
  rain: null,
};
const RANGES: Record<string, [number, number]> = {
  bump: [0, 3],
  scale: [0.05, 50],
  cracks: [0, 1],
  variation: [0, 1],
  strata: [0, 1],
  roughness: [0.3, 1],
  moss: [0, 1],
  tideHeight: [0, 30],
  algae: [0, 1],
  wetDarkening: [0, 1],
  wetGloss: [0, 1],
  rain: [0, 1],
};
const COLORS = new Set(['mossColor', 'algaeColor']);
const isColor = (v: unknown) =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && x >= 0 && x <= 1);
function checkLook(look: unknown): RockLook {
  if (look === null || typeof look !== 'object') throw new RangeError('Rock look must be an object');
  for (const [key, v] of Object.entries(look)) {
    if (v === undefined) continue;
    if (COLORS.has(key)) {
      if (!isColor(v)) throw new RangeError(`Invalid rock look ${key}; pass linear RGB, three numbers 0 to 1`);
      continue;
    }
    const r = RANGES[key];
    if (!r) throw new TypeError(`Unknown rock look ${key}; use a field of RockLook`);
    if (key === 'rain' && v === null) continue;
    if (typeof v !== 'number' || !(v >= r[0] && v <= r[1]))
      throw new RangeError(`Invalid rock look ${key}; pass a number from ${r[0]} to ${r[1]}`);
  }
  return look as RockLook;
}
function styleRow(style: RockStyle | undefined): Float32Array {
  if (style !== undefined && (style === null || typeof style !== 'object'))
    throw new RangeError('Rock style must be an object');
  const type = style?.type ?? 'sandstone';
  if (!Object.hasOwn(ROCK_TYPES, type))
    throw new RangeError(`Unknown rock type ${String(type)}; use one of ${Object.keys(ROCK_TYPES).join(', ')}`);
  const base = ROCK_TYPES[type],
    color = style?.color ?? base.color,
    color2 = style?.color2 ?? base.color2,
    strata = style?.strata ?? base.strata,
    porosity = style?.porosity ?? base.porosity,
    sea = style?.seaLevel ?? 0,
    seed = style?.seed ?? 0;
  if (
    !isColor(color) ||
    !isColor(color2) ||
    typeof strata !== 'number' ||
    !(strata >= 0 && strata <= 100) ||
    typeof porosity !== 'number' ||
    !(porosity >= 0 && porosity <= 1) ||
    typeof sea !== 'number' ||
    !Number.isFinite(Math.fround(sea)) ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff
  )
    throw new RangeError(
      'Invalid rock style; colours are linear RGB 0 to 1, strata 0 to 100 m, porosity 0 to 1, seaLevel finite, seed a uint32',
    );
  // Row: color, on; color2, strata; sea level, porosity, pattern offset, mineral fabric.
  return new Float32Array([
    ...color,
    1,
    ...color2,
    strata,
    sea,
    porosity,
    (seed % 65521) * 0.6180339,
    ROCK_FABRIC[type],
  ]);
}
let serial = 0;
const GLOBAL = 5,
  PER = 3;
/**
 * Granite's crystal size, metres. Granite is phaneritic: medium grained (1 to 5 mm) to coarse (over 5 mm), the Front
 * Range granites coarse (F. Barker, D. R. Wones, W. N. Sharp, G. A. Desborough, "The Pikes Peak batholith, Colorado
 * Front Range...", Precambrian Research 2(2), 1975, doi:10.1016/0301-9268(75)90001-7). Its share of minerals follows
 * the granite field of A. Streckeisen, "To each plutonic rock its proper name", Earth-Science Reviews 12(1), 1976,
 * doi:10.1016/0012-8252(76)90052-0: about 30 percent quartz, 64 percent feldspar and 6 percent dark biotite. Until
 * 2026-11-28 the grain was value noise 1/13 of the relief scale across (7 to 20 cm), thresholded into quartz and mica
 * blotches, which read as camouflage paint on a boulder.
 */
const GRANITE_GRAIN = 0.005;
/** Brightness of feldspar, quartz and biotite crystals against granite's mean tone (the shares above average to 1). */
const GRANITE_MINERALS = { feldspar: 1.15, quartz: 0.75, biotite: 0.3, quartzShare: 0.3, biotiteShare: 0.06 };
const graniteMean =
  GRANITE_MINERALS.biotiteShare * GRANITE_MINERALS.biotite +
  GRANITE_MINERALS.quartzShare * GRANITE_MINERALS.quartz +
  (1 - GRANITE_MINERALS.quartzShare - GRANITE_MINERALS.biotiteShare) * GRANITE_MINERALS.feldspar;

/**
 * Rock shading for meshes on core's standard material: add each cliff, stack or boulder with its rock type, and every
 * pixel of it is shaded as rock from its world position (relief, beds, cracks, moss, tide band, rain). It replaces the
 * mesh material's colour, roughness and metalness; other meshes draw as they were.
 */
export class RockSurface implements EnginePlugin {
  readonly name = 'terrain:rocks:' + ++serial;
  /** Options it was made with (none yet; kept for the weather drive's target shape). */
  readonly options: object = {};
  /** The live look; write it through `setLook`. `look.rain` null follows the weather. */
  readonly look: Required<RockLook>;
  private engine?: Engine;
  private disposed = false;
  private readonly rows = new Map<Mesh, { id: number; row: Float32Array }>();
  private dirty = true;
  private uploaded = '';
  private buffer?: GPUBuffer;
  private capacity = 0;
  private source = '';
  private shader = '';
  private binding = 40;
  private entries: GPUBindGroupEntry[] = [];
  constructor(look: RockLook = {}) {
    this.look = { ...ROCK_LOOK_DEFAULTS, ...checkLook(look) } as Required<RockLook>;
    this.look.mossColor = [...this.look.mossColor];
    this.look.algaeColor = [...this.look.algaeColor];
  }
  /** Shades rock on `engine` (a WebGPU engine, or WebGPU on the WebGL2 layer). */
  static attach(engine: EngineKernel, look: RockLook = {}): RockSurface {
    const surface = new RockSurface(look);
    engineRuntime(engine).use(surface);
    return surface;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Rock shading requires WebGPU and a live module; attach a new RockSurface to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
  }
  /** Changes the look (fields left out keep their value). @throws RangeError for a value out of range. */
  setLook(look: RockLook): this {
    checkLook(look);
    for (const [key, v] of Object.entries(look))
      if (v !== undefined) (this.look as Record<string, unknown>)[key] = Array.isArray(v) ? [...v] : v;
    return this;
  }
  /**
   * Shades `mesh` as rock of `style`. Adding it again changes its style. The mesh must belong to this engine and draw
   * with core's standard material.
   */
  add(mesh: Mesh, style?: RockStyle): this {
    if (this.disposed) throw new MargoError('disposed', 'This RockSurface is disposed; attach a new one');
    const runtime = meshRuntime(mesh);
    runtime.check();
    if (this.engine && runtime.engine !== this.engine)
      throw new MargoError('attached', "The mesh belongs to another engine; add meshes of the surface's engine");
    this.rows.set(mesh, { id: runtime.id, row: styleRow(style) });
    this.dirty = true;
    return this;
  }
  /** Stops shading `mesh` as rock; false when it was not added. */
  remove(mesh: Mesh): boolean {
    const removed = this.rows.delete(mesh);
    if (removed) this.dirty = true;
    return removed;
  }
  /** Whether `mesh` is shaded as rock. */
  has(mesh: Mesh): boolean {
    return this.rows.has(mesh);
  }
  /** The look as the five shared rows of the buffer (rain null is dry until a weather writes it). */
  private globals(): Float32Array {
    const l = this.look;
    return new Float32Array([
      l.bump,
      l.scale,
      l.cracks,
      l.variation,
      l.strata,
      l.moss,
      l.tideHeight,
      l.algae,
      ...l.mossColor,
      l.roughness,
      ...l.algaeColor,
      l.wetDarkening,
      l.wetGloss,
      l.rain ?? 0,
      0,
      0,
    ]);
  }
  /**
   * The WGSL added to core's shader. `rockShade` returns the rock's colour (rgb) and roughness (a) and tilts the normal:
   * triplanar weights |n|^4; per octave the three projections' value noise and its analytic slopes, summed as a world
   * gradient, its tangential part (the surface gradient) taken off the normal; the beds from world height.
   * graniteGrain puts one crystal in each cell of a lattice whose edges a low noise bends, so grains are irregular and
   * interlock; the cell's hash picks its mineral, and the result is its brightness over granite's mean.
   * Granite's crystals are millimetres whatever the rock's relief scale: cells of GRANITE_GRAIN metres.
   */
  private code(binding: number): string {
    return `
@group(0) @binding(${binding}) var<storage,read> rockRows:array<vec4f>;
fn rockRow(id:f32,k:u32)->vec4f {
 let i=${GLOBAL}u+u32(max(id-1.0,0.0))*${PER}u+k;if(id<1.0||i>=arrayLength(&rockRows)){return vec4f(0);}return rockRows[i];
}
fn rockHash(x:f32)->f32 {return f32(terrainHash(bitcast<u32>(i32(floor(x)))+0x9e3779b9u)>>8u)*5.9604645e-8;}
struct RockPlanar {value:f32,gradient:vec3f}
fn rockPlanar(p:vec3f,w:vec3f,f:f32,o:f32)->RockPlanar {
 let a=terrainNoise(p.yz*f+o);let b=terrainNoise(p.xz*f+o*1.7);let c=terrainNoise(p.xy*f+o*2.3);
 var r:RockPlanar;r.value=w.x*a.x+w.y*b.x+w.z*c.x;
 r.gradient=f*(w.x*vec3f(0,a.y,a.z)+w.y*vec3f(b.y,0,b.z)+w.z*vec3f(c.y,c.z,0));return r;
}
fn graniteGrain(q:vec2f,o:f32)->f32 {
 let s=q*0.6+o*31.0;let bend=vec2f(terrainNoise(s).x,terrainNoise(s+17.3).x)-0.5;
 let c=bitcast<vec2u>(vec2i(floor(q+0.9*bend)));
 let h=f32(terrainHash(c.x+terrainHash(c.y+bitcast<u32>(i32(o*977.0))))>>8u)*5.9604645e-8;
 return select(select(${(GRANITE_MINERALS.feldspar / graniteMean).toFixed(4)},${(GRANITE_MINERALS.quartz / graniteMean).toFixed(4)},h<${(GRANITE_MINERALS.biotiteShare + GRANITE_MINERALS.quartzShare).toFixed(3)}),${(GRANITE_MINERALS.biotite / graniteMean).toFixed(4)},h<${GRANITE_MINERALS.biotiteShare.toFixed(3)});
}
struct RockShade {color:vec3f,rough:f32,normal:vec3f}
fn rockShade(p:vec3f,n0:vec3f,id:f32,footprint:f32)->RockShade {
 let m0=rockRow(id,0u);let m1=rockRow(id,1u);let m2=rockRow(id,2u);
 let g0=rockRows[0];let g1=rockRows[1];let g2=rockRows[2];let g3=rockRows[3];let g4=rockRows[4];
 var w=pow(abs(n0),vec3f(4));w/=max(w.x+w.y+w.z,1e-6);
 var grad=vec3f(0);var detail=0.0;var amp=1.0;var f=1.0/g0.y;var total=0.0;
 for(var o=0;o<6;o++){
  let keep=clamp(2.0-3.0*footprint*f,0.0,1.0);
  let s=rockPlanar(p,w,f,m2.z+f32(o)*7.31);
  grad+=s.gradient*(0.12*g0.y*amp*keep);detail+=(s.value-0.5)*amp*keep;total+=amp;amp*=0.6;f*=2.0;
 }
 detail/=total;
 let broad=rockPlanar(p,w,0.11/g0.y,m2.z+3.0).value;
 // Joint cracks: the ridge of a mid-scale noise, thin and dark, broken into lengths by a second noise.
 let cf=0.9/g0.y;let cn=rockPlanar(p,w,cf,m2.z+11.0);let ridge=1.0-abs(2.0*cn.value-1.0);
 let pieces=smoothstep(0.5,0.7,rockPlanar(p,w,0.37/g0.y,m2.z+5.0).value);
 let crack=smoothstep(0.94,0.99,ridge)*pieces*g0.z*clamp(2.0-3.0*footprint*cf,0.0,1.0);
 var col=m0.rgb;
 if(m1.w>0.0){
  let b=(p.y+0.5*m1.w*(terrainNoise(p.xz*0.05/max(m1.w,0.1)+m2.z).x-0.5))/m1.w;
  col=mix(m0.rgb,m1.rgb,rockHash(b+m2.z)*g1.x);
  let line=1.0-smoothstep(0.0,0.07,fract(b));
  col*=1.0-0.35*g1.x*line*clamp(2.0-6.0*footprint/m1.w,0.0,1.0);
 }
 let tone=rockPlanar(p,w,0.31/g0.y,m2.z+17.0).value;
 col=mix(col,m1.rgb,g0.w*smoothstep(0.3,0.8,tone)*0.6);
 col*=1.0+g0.w*(broad-0.5)*1.2+0.6*detail;
 col*=1.0-0.55*crack;
 // Rock types share weathering, but have different grains at the scale of a broken face.
 // Fade grain contrast and relief together when the footprint can no longer resolve it.
 var fabric=0.0;
 let gf=select(21.0/g0.y,${(1 / GRANITE_GRAIN).toFixed(1)},m2.w==1.0);
 let keepGrain=clamp(2.0-4.0*footprint*gf,0.0,1.0);
 if(keepGrain>0.0){
  let grain=rockPlanar(p,w,gf,m2.z+53.79);
  if(m2.w==1.0){
   // A mosaic of whole crystals, each one mineral: feldspar, quartz, or a dark biotite fleck (graniteGrain).
   let mineral=w.x*graniteGrain(p.yz*gf,m2.z)+w.y*graniteGrain(p.xz*gf,m2.z+0.37)+w.z*graniteGrain(p.xy*gf,m2.z+0.71);
   fabric=(mineral-1.0)*keepGrain;
   grad+=grain.gradient*(0.04/gf)*keepGrain;
  }else if(m2.w==2.0){
   let pit=1.0-smoothstep(0.20,0.36,grain.value);
   fabric=-0.29*pit*keepGrain;
   grad+=grain.gradient*(0.35/gf)*pit*keepGrain;
  }else if(m2.w==3.0&&m1.w>0.0){
   let lf=5.0/m1.w;
   let bed=p.y*lf+(grain.value-0.5)*0.26+m2.z;
   let seam=1.0-smoothstep(0.015,0.22,abs(fract(bed)-0.5));
   fabric=-0.32*seam*g1.x*clamp(2.0-6.0*footprint*lf,0.0,1.0)*keepGrain;
  }else{
   fabric=0.22*(grain.value-0.5)*keepGrain;
  }
 }
 col*=1.0+fabric;
 let gt=grad-n0*dot(n0,grad);
 let n=normalize(n0-g0.x*gt);
 var rough=g2.w*(1.0+0.1*detail)-0.15*fabric+0.1*crack;
 let above=p.y-m2.x;
 // Moss: up-facing rock clear of the tide, in patches of the broad noise.
 let moss=g1.y*smoothstep(0.5,0.85,n.y)*smoothstep(0.35,0.6,broad+0.2*detail)*smoothstep(g1.z,g1.z+0.6,above);
 col=mix(col,g2.rgb*(0.85+0.3*broad),moss);rough=mix(rough,0.95,moss);
 let tideTop=g1.z*(1.0+0.25*(broad-0.5));
 var tide=0.0;
 if(tideTop>0.0){
  tide=1.0-smoothstep(tideTop*0.8,tideTop+0.05,above);
  let algae=g1.w*(1.0-smoothstep(0.0,tideTop*0.55,above))*smoothstep(0.3,0.55,broad+0.3*detail);
  col=mix(col,g3.rgb,algae*tide);
 }
 let wet=max(tide,g4.y*m2.y);
 col*=mix(1.0,g3.w,wet);rough=mix(rough,rough*(1.0-g4.x),wet);
 var r:RockShade;r.color=col;r.rough=clamp(rough,0.05,1.0);r.normal=n;return r;
}
`;
  }
  private patch(source: string, binding: number): string {
    const opened = openMeshBlock(source);
    // Silent like the other optional core patches: other shaders draw their meshes as they were.
    if (!opened) return source;
    const { code, at } = opened;
    return (
      (code.includes('fn terrainNoise(') ? '' : noiseCode) +
      this.code(binding) +
      code.slice(0, at) +
      'let rockFootprint=max(length(dpdx(i.position)),length(dpdy(i.position)));' +
      '{if(rockRow(i.terrainId,0u).w>0.0){let r=rockShade(i.position,n,i.terrainId,rockFootprint);i.color=r.color;i.material.x=r.rough;i.material.y=0.0;n=r.normal;}}' +
      code.slice(at)
    );
  }
  private upload(device: GPUDevice): void {
    let top = 0;
    for (const row of this.rows.values()) top = Math.max(top, row.id + 1);
    if (!this.buffer || top > this.capacity) {
      this.buffer?.destroy();
      this.capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(top, 1))));
      this.buffer = device.createBuffer({
        size: (GLOBAL + this.capacity * PER) * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.entries = [];
    }
    const values = new Float32Array((GLOBAL + this.capacity * PER) * 4);
    values.set(this.globals());
    for (const row of this.rows.values()) values.set(row.row, (GLOBAL + row.id * PER) * 4);
    device.queue.writeBuffer(this.buffer, 0, values);
    this.dirty = false;
  }
  registerPasses(graph: FrameGraph): void {
    // After the terrain colour and blend patches (order -1) and before core's main draw (order 0): this block opens
    // first in the shader, so the blend's fade into the ground is laid over the rock, not under it.
    graph.add({
      name: this.name,
      order: -0.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.engine || this.disposed || this.rows.size === 0) return;
        for (const mesh of this.rows.keys())
          if (meshRuntime(mesh).engine !== this.engine) {
            this.rows.delete(mesh);
            this.dirty = true;
          }
        if (this.rows.size === 0) return;
        // The look is live: one small write when it changed, nothing rebuilt.
        const look = JSON.stringify(this.look);
        if (this.dirty || look !== this.uploaded) {
          this.uploaded = look;
          this.upload(c.device);
        }
        if (this.source !== c.shader) {
          this.source = c.shader;
          const taken = new Set(c.bindings.map((entry) => entry.binding));
          for (const m of c.shader.matchAll(/@group\(0\) @binding\((\d+)\)/g)) taken.add(Number(m[1]));
          let binding = 40;
          while (taken.has(binding)) binding++;
          this.binding = binding;
          this.entries = [];
          this.shader = this.patch(c.shader, binding);
        }
        if (this.shader === this.source) return;
        if (!this.entries.length) this.entries = [{ binding: this.binding, resource: { buffer: this.buffer! } }];
        c.bindings.push(...this.entries);
        c.shader = this.shader;
      },
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.buffer?.destroy();
    this.buffer = undefined;
    this.capacity = 0;
    this.entries = [];
    this.dirty = true;
    this.engine = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buffer?.destroy();
    this.buffer = undefined;
    this.entries = [];
    this.rows.clear();
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
