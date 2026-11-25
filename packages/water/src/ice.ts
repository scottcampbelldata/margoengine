/// <reference lib="esnext.disposable" preserve="true" />
// Ice on the sea: IceMaterial (glacial ice that holds up close: light through it, wet where the waves reach, a wave-cut
// notch at the waterline, melt scallops, blue bands of clear ice in white bubbly ice), Iceberg (any closed ice mesh
// floating at the waterline Archimedes gives it, riding the sea through a Floater with its own heave, roll and pitch
// periods), SeaIce (pancake, brash and floes riding the swell and drifting with the wind), BergFoam (the foam ring and
// the breaking water on a berg's weather side, a Water surface effect) and BergSpray (the spray thrown off the weather
// face). Capsizing and calving stay a Blender bake.
//
// Sources (clean room, from the papers):
// - Ice optics: Warren and Brandt, "Optical constants of ice from the ultraviolet to the microwave: a revised
//   compilation", J. Geophys. Res. 113, D14220 (2008), https://doi.org/10.1029/2007JD009744, the imaginary index m_im
//   tabled below from 400 to 700 nm (https://atmos.washington.edu/ice_optical_constants/), absorption 4 pi m_im / lambda;
//   Warren, "Optical properties of ice and snow", Phil. Trans. R. Soc. A 377, 20180161 (2019),
//   https://doi.org/10.1098/rsta.2018.0161 (glacier ice is blue where it holds few bubbles, white where bubbles scatter);
//   Warren, "Optical constants of ice from the ultraviolet to the microwave", Appl. Opt. 23 (1984) (real index 1.31).
// - Bubbles: Mullen and Warren, "Theory of the optical properties of lake ice", J. Geophys. Res. 93 (1988): a bubble
//   much larger than the wavelength has extinction efficiency 2, so a volume fraction v of bubbles of radius r scatters
//   3 v / (2 r) per metre, with asymmetry about 0.75 (Margo takes 0.75).
// - Albedo of a deep scattering medium: Bohren and Barkstrom, "Theory of the optical properties of snow", J. Geophys.
//   Res. 79 (1974); the similarity form R = exp(-4 sqrt((1 - w) / (3 (1 - w g)))) of single-scatter albedo w.
// - Wet surfaces look darker and glossier: Lekner and Dorf, "Why some things are darker when wet", Appl. Opt. 27 (1988).
// - Buoyancy and stability: Archimedes (displaced volume = mass / water density); a box berg rolls over when its width
//   to height ratio is below sqrt(6 a (1 - a)), a = ice / water density: Weeks and Mellor, "Some elements of iceberg
//   technology", CRREL Report 78-2 (1978); Burton et al., "Laboratory investigations of iceberg capsize dynamics", J.
//   Geophys. Res. 117, F01007 (2012); Wagner et al., "On the representation of capsizing in iceberg models", Ocean
//   Modelling 117 (2017), arXiv:1702.06870. Here the metacentric height of any mesh is the righting arm of a small
//   tilt over its sine, the waterline re-solved at the tilt; the volume integrals are exact over the triangles (the
//   tetrahedron moments of Tonon, J. Math. Stat. 1 (2004)).
// - Wave erosion of the waterline: the notch rate of Bigg et al., "Prediction of iceberg trajectories for the North
//   Atlantic and Arctic Oceans", Cold Reg. Sci. Technol. 26 (1997), after White, Spaulding and Gominho (1980):
//   M_e = (1 / 12) S_s (1 + cos(pi A^3)) (T + 2) m/day, sea state S_s = (2 / 3) sqrt(U) + U / 10, ice cover A.
// - Sea ice: WMO Sea-Ice Nomenclature (WMO No. 259): pancake ice 30 cm to 3 m across and up to 10 cm thick with raised
//   rims; brash fragments up to 2 m across; small floes 20 to 100 m. Free drift: about 2% of the 10 m wind, turned 20 to
//   40 degrees to the right in the north (Nansen 1902; Leppaeranta, The Drift of Sea Ice, Springer 2011; Brunette et al.,
//   The Cryosphere 16 (2022), https://doi.org/10.5194/tc-16-533-2022). Waves in pancake ice lose energy at
//   0.2 T^-2.13 h per metre (Doble et al., "Relating wave attenuation to pancake ice thickness", Geophys. Res. Lett. 42
//   (2015), https://doi.org/10.1002/2015GL063628), h the equivalent thickness 0.7 x the pancakes'; amplitude at half.
// Margo's own choices are named where they are made: the band and scallop patterns, the notch profile, the foam shapes.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { WgslMaterial, type MaterialOptions } from '@margoengine/materials';
import type { Water } from './index.js';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import { Floater, type FloaterResponse, type SplashParticles, type WaterHeightSource } from './ships.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Vec3 = readonly [number, number, number];
type RGB = [number, number, number];

const G = 9.81;
/** Density of bubble-free ice, kg/m^3 (at 0 C). */
export const PURE_ICE_DENSITY = 917;
/** Real refractive index of ice in the visible (Warren 1984). */
export const ICE_IOR = 1.31;
/** Most bergs one BergFoam draws. */
export const MAX_BERGS = 8;
/** Waterline footprint samples per berg. */
export const FOOTPRINT_SAMPLES = 32;

const finite = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw rangeError(`Invalid ice ${what}; pass a finite number in ${lo}..${hi}`, 'geometry');
  return v;
};
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- Optics ---

/** Imaginary index of ice, 400 to 700 nm every 10 nm (Warren and Brandt 2008). */
export const ICE_IMAGINARY_INDEX: readonly number[] = Object.freeze([
  2.365e-11, 2.669e-11, 3.135e-11, 4.14e-11, 6.268e-11, 9.239e-11, 1.325e-10, 1.956e-10, 2.861e-10, 4.172e-10, 5.889e-10,
  8.036e-10, 1.076e-9, 1.409e-9, 1.813e-9, 2.289e-9, 2.839e-9, 3.461e-9, 4.159e-9, 4.93e-9, 5.73e-9, 6.89e-9, 8.58e-9,
  1.04e-8, 1.22e-8, 1.43e-8, 1.66e-8, 1.89e-8, 2.09e-8, 2.4e-8, 2.9e-8,
]);
/** Absorption coefficient of pure ice, 1/m, at a wavelength of 400 to 700 nm (log-linear between the table's rows). */
export function iceAbsorption(nanometres: number): number {
  finite(nanometres, 400, 700, 'wavelength');
  const x = (nanometres - 400) / 10,
    i = Math.min(29, Math.floor(x)),
    t = x - i;
  const m = Math.exp(Math.log(ICE_IMAGINARY_INDEX[i]) * (1 - t) + Math.log(ICE_IMAGINARY_INDEX[i + 1]) * t);
  return (4 * Math.PI * m) / (nanometres * 1e-9);
}
// Linear RGB as band averages: blue 400-490, green 490-580, red 580-700 nm (Margo's bands).
function bands(f: (nm: number) => number): RGB {
  const avg = (a: number, b: number) => {
    let s = 0,
      n = 0;
    for (let nm = a; nm <= b; nm += 5) (s += f(nm)), n++;
    return s / n;
  };
  return [avg(580, 700), avg(490, 580), avg(400, 490)];
}
/** Linear RGB share of light left after `metres` of clear ice. */
export function iceTransmittance(metres: number): RGB {
  finite(metres, 0, 1e4, 'path');
  return bands((nm) => Math.exp(-iceAbsorption(nm) * metres));
}
/** Volume share of air bubbles in glacier ice of `density` kg/m^3 (300..917). */
export function bubbleFraction(density: number): number {
  return 1 - finite(density, 300, PURE_ICE_DENSITY, 'density') / PURE_ICE_DENSITY;
}
/**
 * Linear RGB albedo of deep ice holding a volume share `bubbles` (0..0.5) of air bubbles `radius` mm across in radius
 * (0.01..10): white where many small bubbles scatter, blue where few do (Mullen and Warren 1988, Bohren and Barkstrom
 * 1974).
 */
export function iceAlbedo(bubbles: number, radius = 0.5): RGB {
  finite(bubbles, 0, 0.5, 'bubbles');
  finite(radius, 0.01, 10, 'bubble radius');
  const scatter = (3 * bubbles) / (2 * radius * 1e-3),
    g = 0.75;
  return bands((nm) => {
    const a = iceAbsorption(nm),
      w = scatter / (scatter + a);
    return a + scatter > 0 && w > 0 ? Math.exp(-4 * Math.sqrt((1 - w) / (3 * (1 - w * g)))) : 0;
  });
}

// --- The material ---

/** The live look of an {@link IceMaterial}. */
export interface IceLook {
  /** Share of blue, clear ice in the white bubbly ice, 0..1. Default 0.25. */
  blueIce: number;
  /** Blue bands per metre, 0.005..2. Default 0.06. */
  bandScale: number;
  /** Bubble volume share of the white ice, 0.001..0.3. Default 0.05 (glacier ice of 870 kg/m^3). */
  bubbles: number;
  /** Bubble radius of the white ice, mm, 0.05..5. Default 0.5. */
  bubbleRadius: number;
  /** Light seen through the ice, 0..1 (the subsurface weight). Default 0.7. */
  subsurface: number;
  /** Depth of clear ice the light crosses for its tint, m, 0..50. Default 5. */
  scatterDepth: number;
  /** Height above the water the waves wet, m, 0..20. Default 1.5. */
  wetHeight: number;
  /** How much darker wet ice is, 0..0.9. Default 0.35. */
  wetDarkening: number;
  /** Roughness of wet ice, 0.02..1. Default 0.06. */
  wetRoughness: number;
  /** Roughness of dry ice, 0.02..1. Default 0.35. */
  roughness: number;
  /** Depth the waves cut into the waterline, m, 0..10. Default 0.8. */
  notchDepth: number;
  /** Height of the notch, m, 0.05..10. Default 1.2. */
  notchHeight: number;
  /** Melt scallop size, m, 0.02..5. Default 0.3. */
  scallopSize: number;
  /** Melt scallop depth (normal tilt), 0..2. Default 0.35. */
  scallopDepth: number;
}
/** The default ice look. */
export const ICE_LOOK_DEFAULTS: Readonly<IceLook> = Object.freeze({
  blueIce: 0.25,
  bandScale: 0.06,
  bubbles: 0.05,
  bubbleRadius: 0.5,
  subsurface: 0.7,
  scatterDepth: 5,
  wetHeight: 1.5,
  wetDarkening: 0.35,
  wetRoughness: 0.06,
  roughness: 0.35,
  notchDepth: 0.8,
  notchHeight: 1.2,
  scallopSize: 0.3,
  scallopDepth: 0.35,
});
const ICE_RANGES: Record<keyof IceLook, [number, number]> = {
  blueIce: [0, 1],
  bandScale: [0.005, 2],
  bubbles: [0.001, 0.3],
  bubbleRadius: [0.05, 5],
  subsurface: [0, 1],
  scatterDepth: [0, 50],
  wetHeight: [0, 20],
  wetDarkening: [0, 0.9],
  wetRoughness: [0.02, 1],
  roughness: [0.02, 1],
  notchDepth: [0, 10],
  notchHeight: [0.05, 10],
  scallopSize: [0.02, 5],
  scallopDepth: [0, 2],
};
/** Bubbles of the blue, clear ice: few and large (Warren 2019). */
const CLEAR_BUBBLES = 0.002,
  CLEAR_RADIUS = 1;
/** The water against an ice surface: a plane through (x, height, z) with slopes dh/dx and dh/dz. */
export interface IceWaterPlane {
  x: number;
  z: number;
  height: number;
  slopeX?: number;
  slopeZ?: number;
}
/** Options of an {@link IceMaterial}: its look, whether it cuts the notch, and any other Material option. */
export interface IceMaterialOptions extends Omit<MaterialOptions, 'shading'> {
  look?: Partial<IceLook>;
  /** Cut the waterline notch into the mesh (a vertex displacement). False for instanced sea ice. Default true. */
  notch?: boolean;
}

const ICE_WGSL = /* wgsl */ `
fn iceHash(p:vec3f)->f32 {var q=fract(p*0.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
fn iceNoise(p:vec3f)->f32 {
 let c=floor(p);let w=fract(p);let u=w*w*(3.0-2.0*w);
 let a=mix(mix(iceHash(c),iceHash(c+vec3f(1,0,0)),u.x),mix(iceHash(c+vec3f(0,1,0)),iceHash(c+vec3f(1,1,0)),u.x),u.y);
 let b=mix(mix(iceHash(c+vec3f(0,0,1)),iceHash(c+vec3f(1,0,1)),u.x),mix(iceHash(c+vec3f(0,1,1)),iceHash(c+vec3f(1,1,1)),u.x),u.y);
 return mix(a,b,u.z);
}
fn iceFbm(p:vec3f)->f32 {var s=0.0;var a=0.5;var q=p;for(var k=0;k<4;k++){s+=a*iceNoise(q);q=q*2.03+vec3f(1.7,9.2,3.1);a*=0.5;}return s/0.9375;}
// The nearest scallop centre: the offset from it (scallop units) and its squared length.
fn iceCell(p:vec3f)->vec4f {
 let c=floor(p);var best=9.0;var off=vec3f(0);
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let g=c+vec3f(f32(x),f32(y),f32(z));let o=g+vec3f(iceHash(g),iceHash(g+11.3),iceHash(g+27.1));let d=p-o;let d2=dot(d,d);
  if(d2<best){best=d2;off=d;}
 }}}
 return vec4f(off,best);
}
// The wave-cut notch across height u (notch heights from the waterline): deepest a tenth above it (Margo's profile).
fn iceNotchProfile(u:f32)->f32 {return exp(-4.0*(u-0.1)*(u-0.1));}
fn iceBlue(p:vec3f)->f32 {
 let b=uniforms.iceBands;if(b.x<=0.0){return 0.0;}if(b.x>=1.0){return 1.0;}
 let q=p*b.y;let v=iceFbm(vec3f(q.x*0.35,q.y*2.5,q.z*0.35)+vec3f(iceFbm(q*0.5)*1.5));
 let t=1.0-b.x;return smoothstep(t-0.06,t+0.06,v);
}
fn shade(i:Out,s:Surface)->Surface {
 var o=s;let p=i.position;let foot=length(fwidth(p));
 let w=uniforms.iceWater;let sl=uniforms.iceSlope;let nt=uniforms.iceNotch;let sc=uniforms.iceScallop;
 let level=w.z+sl.x*(p.x-w.x)+sl.y*(p.z-w.y);let above=p.y-level;
 let wet=1.0-smoothstep(0.0,max(w.w,1e-3),above);
 let blue=iceBlue(p);
 var albedo=mix(uniforms.iceWhite.rgb,uniforms.iceBlue.rgb,blue)*(1.0-sl.z*wet);
 o.roughness=mix(sc.z,sl.w,wet);
 let steep=1.0-smoothstep(0.6,0.95,abs(o.n.y));
 if(sc.x>0.0&&sc.y>0.0){
  // Scallops smaller than a few pixels fade out rather than alias (Margo's band: a sixth to half a scallop a pixel).
  let c=iceCell(p/sc.x);let g=c.xyz*2.0*sc.y*steep*(1.0-smoothstep(0.16*sc.x,0.5*sc.x,foot));
  o.n=normalize(o.n-(g-o.n*dot(g,o.n)));
 }
 if(nt.z>0.0){
  let k=iceNotchProfile((p.y-nt.w)/nt.y)*steep;
  albedo*=1.0-0.5*k;o.occlusion*=1.0-0.6*k;
 }
 o.base=vec4f(albedo,o.base.a);
 return o;
}
`;
const NOTCH_WGSL = /* wgsl */ `
fn displace(i:Input)->vec3f {
 let p=i.position.xyz;let n=i.normal.xyz;let nt=uniforms.iceNotch;let up=uniforms.iceNotchUp.xyz;
 if(nt.z<=0.0){return p;}
 let side=1.0-smoothstep(0.6,0.95,abs(dot(n,up)));let h=n-up*dot(n,up);let len=length(h);
 if(len<1e-4){return p;}
 return p-h/len*nt.z*iceNotchProfile((dot(p,up)-nt.x)/nt.y)*side;
}
`;

/**
 * Glacial ice for bergs, bergy bits and sea ice: white bubbly ice with bands of blue clear ice, both coloured from the
 * absorption of ice (Warren and Brandt 2008) and the scattering of its bubbles; light seen through it; wet and glossy as
 * high as the waves reach; a wave-cut notch along the waterline (cut into the mesh) and melt scallops on its walls. An
 * {@link Iceberg} given the material keeps its waterline current every update; otherwise call `setWater`.
 */
export class IceMaterial extends WgslMaterial {
  /** The look; change it with `setLook`. */
  readonly look: IceLook;
  /** Whether the notch is cut into the mesh. */
  readonly cutsNotch: boolean;
  private notchMesh = 0;
  constructor(options: IceMaterialOptions = {}) {
    const { look, notch = true, ...rest } = options;
    super({
      roughness: ICE_LOOK_DEFAULTS.roughness,
      ior: ICE_IOR,
      subsurfaceMode: 'thick',
      ...rest,
      wgsl: ICE_WGSL + (notch ? NOTCH_WGSL : ''),
      subsurface: ICE_LOOK_DEFAULTS.subsurface,
      uniforms: {
        iceWhite: [1, 1, 1, 0],
        iceBlue: [0.3, 0.6, 0.9, 0],
        iceBands: [0, 0, 0, 0],
        iceWater: [0, 0, 0, 0],
        iceSlope: [0, 0, 0, 0],
        iceNotch: [0, 1, 0, 0],
        iceNotchUp: [0, 1, 0, 0],
        iceScallop: [0, 0, 0, 0],
      },
    });
    this.cutsNotch = notch;
    this.look = { ...ICE_LOOK_DEFAULTS };
    this.setLook(look ?? {});
  }
  /** Changes look values (a name left out keeps its value). */
  setLook(look: Partial<IceLook>): this {
    for (const [key, value] of Object.entries(look ?? {})) {
      const range = ICE_RANGES[key as keyof IceLook];
      if (!range) throw typeError(`Unknown ice look ${key}; use a name of ICE_LOOK_DEFAULTS`, 'geometry');
      this.look[key as keyof IceLook] = finite(value, range[0], range[1], key);
    }
    const l = this.look,
      u = this.uniforms as Record<string, number | Float32Array | readonly number[]>;
    u.iceWhite = [...iceAlbedo(l.bubbles, l.bubbleRadius), 0];
    u.iceBlue = [...iceAlbedo(CLEAR_BUBBLES, CLEAR_RADIUS), 0];
    u.iceBands = [l.blueIce, l.bandScale, 0, 0];
    const water = u.iceWater as Float32Array;
    u.iceWater = [water[0], water[1], water[2], l.wetHeight];
    const slope = u.iceSlope as Float32Array;
    u.iceSlope = [slope[0], slope[1], l.wetDarkening, l.wetRoughness];
    const notch = u.iceNotch as Float32Array;
    u.iceNotch = [this.notchMesh, l.notchHeight, l.notchDepth, notch[3]];
    u.iceScallop = [l.scallopSize, l.scallopDepth, l.roughness, 0];
    this.subsurface = l.subsurface;
    this.subsurfaceColor = iceTransmittance(l.scatterDepth);
    return this;
  }
  /**
   * The water against the ice: a plane (its height at x, z and its slopes) that sets the wet band, and the mean
   * waterline for the notch: in the mesh's own space the plane dot(p, `meshUp`) = `meshWaterline` (default up +Y), and
   * its height in the world (`worldWaterline`).
   */
  setWater(plane: IceWaterPlane, meshWaterline = this.notchMesh, worldWaterline = plane.height, meshUp?: Vec3): this {
    const x = finite(plane?.x, -1e7, 1e7, 'water x'),
      z = finite(plane.z, -1e7, 1e7, 'water z'),
      h = finite(plane.height, -1e5, 1e5, 'water height');
    const u = this.uniforms as Record<string, number | Float32Array | readonly number[]>;
    u.iceWater = [x, z, h, this.look.wetHeight];
    u.iceSlope = [finite(plane.slopeX ?? 0, -10, 10, 'water slope'), finite(plane.slopeZ ?? 0, -10, 10, 'water slope'), this.look.wetDarkening, this.look.wetRoughness];
    this.notchMesh = finite(meshWaterline, -1e5, 1e5, 'mesh waterline');
    u.iceNotch = [this.notchMesh, this.look.notchHeight, this.look.notchDepth, finite(worldWaterline, -1e5, 1e5, 'world waterline')];
    if (meshUp !== undefined) {
      if (!Array.isArray(meshUp) || meshUp.length !== 3 || !meshUp.every(Number.isFinite) || !(Math.hypot(meshUp[0], meshUp[1], meshUp[2]) > 0))
        throw rangeError('IceMaterial meshUp must be three finite numbers, not zero', 'geometry');
      const l = Math.hypot(meshUp[0], meshUp[1], meshUp[2]);
      u.iceNotchUp = [meshUp[0] / l, meshUp[1] / l, meshUp[2] / l, 0];
    }
    return this;
  }
}

/**
 * Wave erosion of a berg's waterline, metres a day (Bigg et al. 1997 after White et al. 1980): wind `windSpeed` m/s
 * (0..60), sea surface temperature `sea` C (-2..30), ice cover `iceCover` 0..1 (sea ice damps the waves).
 */
export function waveErosion(windSpeed: number, sea: number, iceCover = 0): number {
  finite(windSpeed, 0, 60, 'wind speed');
  finite(sea, -2, 30, 'sea temperature');
  finite(iceCover, 0, 1, 'ice cover');
  const state = (2 / 3) * Math.sqrt(windSpeed) + windSpeed / 10;
  return (state * (1 + Math.cos(Math.PI * iceCover ** 3)) * (sea + 2)) / 12;
}

// --- Buoyancy ---

/** A closed, outward-wound triangle mesh in metres, Y up (a glTF mesh's attributes). */
export interface IceMesh {
  positions: ArrayLike<number>;
  /** Triangle indices; left out, every three positions are a triangle. */
  indices?: ArrayLike<number>;
}
/** Densities, kg/m^3. */
export interface BuoyancyOptions {
  /** Ice, 300..917. Default 900 (glacier ice with a little air). */
  iceDensity?: number;
  /** Sea water, 990..1100. Default 1027 (the cold North Atlantic). */
  waterDensity?: number;
}
/** How an ice mesh floats, in the mesh's own space turned to its resting attitude (metres, Y up) unless said. */
export interface Buoyancy {
  volume: number;
  mass: number;
  /** Centre of mass. */
  centroid: [number, number, number];
  /** Mesh Y of the waterline at rest. */
  waterline: number;
  /** Depth below the waterline to the keel. */
  draft: number;
  /** Height above the waterline to the top. */
  freeboard: number;
  /** Share of the volume under the water: ice over water density. */
  submergedFraction: number;
  /** Centre of the displaced water. */
  buoyancyCentre: [number, number, number];
  /** Area of the waterplane, m^2. */
  waterplaneArea: number;
  /** Centre of the waterplane, mesh X and Z. */
  waterplaneCentre: [number, number];
  /** Extent of the waterplane along mesh Z (length) and X (beam). */
  length: number;
  beam: number;
  /** Metacentric height for roll (about mesh Z) and pitch (about mesh X), m; negative rolls the berg over. */
  rollMetacentricHeight: number;
  pitchMetacentricHeight: number;
  /** True when both metacentric heights are above zero. */
  stable: boolean;
  /**
   * The resting attitude, radians: heel turns mesh +X up about Z, then trim turns +Z up about X, both about the centre
   * of mass, until the centre of buoyancy is under it. The other fields are of the mesh at rest.
   */
  heel: number;
  trim: number;
  /** World up at rest in the mesh's own space (the notch's plane normal). */
  up: [number, number, number];
  /** Natural periods, s (no added mass). */
  heavePeriod: number;
  rollPeriod: number;
  pitchPeriod: number;
  /** Waterplane radius from its centre at FOOTPRINT_SAMPLES angles, angle k 2 pi / n from mesh +X toward +Z. */
  footprint: Float64Array;
}
interface Moments {
  volume: number;
  first: [number, number, number];
}
function triangles(mesh: IceMesh): { p: ArrayLike<number>; index: (k: number) => number; count: number } {
  const p = mesh?.positions;
  if (!p || typeof p.length !== 'number' || p.length < 12 || p.length % 3) throw typeError('Ice mesh needs positions (x, y, z triples)', 'geometry');
  const idx = mesh.indices,
    count = idx ? idx.length : p.length / 3;
  if (count % 3 || count < 12) throw typeError('Ice mesh needs whole triangles, four or more', 'geometry');
  const vertices = p.length / 3;
  if (idx) for (let k = 0; k < idx.length; k++) if (!Number.isInteger(idx[k]) || idx[k] < 0 || idx[k] >= vertices) throw rangeError('Ice mesh index out of range', 'geometry');
  for (let k = 0; k < p.length; k++) if (!Number.isFinite(p[k])) throw rangeError('Ice mesh positions must be finite', 'geometry');
  return { p, index: idx ? (k) => idx[k] : (k) => k, count };
}
type Mesh3 = ReturnType<typeof triangles>;
// Volume and first moment of the part of a mesh below the plane y = c, after `rotate` turns each point: signed
// tetrahedra from a point on the plane, so the cap on the plane adds nothing.
function below(mesh: Mesh3, c: number, rotate?: (v: number[]) => number[]): Moments {
  const { p, index, count } = mesh;
  let volume = 0;
  const first: [number, number, number] = [0, 0, 0];
  const point = (k: number) => {
    const i = index(k) * 3,
      v = [p[i], p[i + 1], p[i + 2]];
    return rotate ? rotate(v) : v;
  };
  const tet = (a: number[], b: number[], d: number[]) => {
    const ax = a[0],
      ay = a[1] - c,
      az = a[2],
      bx = b[0],
      by = b[1] - c,
      bz = b[2],
      dx = d[0],
      dy = d[1] - c,
      dz = d[2];
    const det = ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx),
      v = det / 6;
    volume += v;
    first[0] += (v * (ax + bx + dx)) / 4;
    first[1] += (v * (a[1] + b[1] + d[1] + c)) / 4;
    first[2] += (v * (az + bz + dz)) / 4;
  };
  const cut = (a: number[], b: number[]) => {
    const t = (c - a[1]) / (b[1] - a[1]);
    return [a[0] + (b[0] - a[0]) * t, c, a[2] + (b[2] - a[2]) * t];
  };
  for (let k = 0; k < count; k += 3) {
    const v = [point(k), point(k + 1), point(k + 2)];
    const under = v.map((q) => q[1] <= c);
    const n = under.filter(Boolean).length;
    if (n === 3) tet(v[0], v[1], v[2]);
    else if (n === 0) continue;
    else {
      // Clip the triangle to y <= c, keeping its winding: a polygon of 3 or 4 points, fanned.
      const poly: number[][] = [];
      for (let j = 0; j < 3; j++) {
        const a = v[j],
          b = v[(j + 1) % 3];
        if (under[j]) poly.push(a);
        if (under[j] !== under[(j + 1) % 3]) poly.push(cut(a, b));
      }
      for (let j = 1; j + 1 < poly.length; j++) tet(poly[0], poly[j], poly[j + 1]);
    }
  }
  return { volume, first };
}
function solveWaterline(mesh: Mesh3, target: number, lo: number, hi: number, rotate?: (v: number[]) => number[]): number {
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (below(mesh, mid, rotate).volume < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/**
 * How a closed ice mesh floats: the waterline where it displaces its own mass of sea water, its draft and freeboard, the
 * centres of mass and buoyancy, the waterplane, the metacentric heights (a berg with one at or below zero rolls over)
 * and the natural periods. Exact over the triangles; the waterline to 1e-12 of the mesh's height.
 */
export function iceBuoyancy(mesh: IceMesh, options: BuoyancyOptions = {}): Buoyancy {
  const source = triangles(mesh);
  const ice = finite(options.iceDensity ?? 900, 300, PURE_ICE_DENSITY, 'ice density'),
    water = finite(options.waterDensity ?? 1027, 990, 1100, 'water density');
  const extent = (q: ArrayLike<number>) => {
    let lo = Infinity,
      hi = -Infinity;
    for (let k = 1; k < q.length; k += 3) (lo = Math.min(lo, q[k])), (hi = Math.max(hi, q[k]));
    return [lo, hi];
  };
  {
    const [lo, hi] = extent(source.p);
    if (!(hi > lo)) throw rangeError('Ice mesh is flat; pass a closed solid', 'geometry');
  }
  const p = source.p;
  // The whole mesh and its second moments (Tonon 2004), from the origin.
  let volume = 0;
  const first = [0, 0, 0],
    second = [0, 0, 0]; // xx yy zz
  for (let k = 0; k < source.count; k += 3) {
    const a = source.index(k) * 3,
      b = source.index(k + 1) * 3,
      c = source.index(k + 2) * 3;
    const A = [p[a], p[a + 1], p[a + 2]],
      B = [p[b], p[b + 1], p[b + 2]],
      C = [p[c], p[c + 1], p[c + 2]];
    const det = A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
    volume += det / 6;
    const s = [A[0] + B[0] + C[0], A[1] + B[1] + C[1], A[2] + B[2] + C[2]];
    for (let j = 0; j < 3; j++) first[j] += (det / 24) * s[j];
    for (let j = 0; j < 3; j++) second[j] += (det / 120) * (A[j] * A[j] + B[j] * B[j] + C[j] * C[j] + s[j] * s[j]);
  }
  if (!(volume > 0)) throw rangeError('Ice mesh encloses no volume; pass a closed mesh wound outward (counter-clockwise from outside)', 'geometry');
  const g = [first[0] / volume, first[1] / volume, first[2] / volume] as [number, number, number];
  const fraction = ice / water,
    target = volume * fraction;
  // Heel (about Z, +X up) then trim (about X, +Z up), about the centre of mass.
  const attitude = (heel: number, trim: number) => {
    const ch = Math.cos(heel),
      sh = Math.sin(heel),
      ct = Math.cos(trim),
      st = Math.sin(trim);
    return (v: number[]) => {
      const x = v[0] - g[0],
        y = v[1] - g[1],
        z = v[2] - g[2];
      const x1 = x * ch - y * sh,
        y1 = x * sh + y * ch;
      return [g[0] + x1, g[1] + z * st + y1 * ct, g[2] + z * ct - y1 * st];
    };
  };
  // The righting arms (G - B across X and Z) of the mesh `q` turned by `rotate`, its waterline re-solved.
  const arms = (q: Mesh3, rotate?: (v: number[]) => number[]) => {
    const [lo, hi] = extent(q.p),
      span = hi - lo;
    const moved = below(q, solveWaterline(q, target, lo - span, hi + span, rotate), rotate);
    return [g[0] - moved.first[0] / moved.volume, g[2] - moved.first[2] / moved.volume];
  };
  // The resting attitude: Newton steps on both arms until the centre of buoyancy is under the centre of mass. A shape
  // that is not symmetric settles with a heel and a trim, as a real berg does.
  let heel = 0,
    trim = 0;
  {
    const [lo, hi] = extent(p),
      tol = (hi - lo) * 1e-9,
      d = 0.004;
    for (let k = 0; k < 40; k++) {
      const [ah, at] = arms(source, attitude(heel, trim));
      if (Math.abs(ah) < tol && Math.abs(at) < tol) break;
      const kh = (arms(source, attitude(heel + d, trim))[0] - arms(source, attitude(heel - d, trim))[0]) / (2 * d),
        kt = (arms(source, attitude(heel, trim + d))[1] - arms(source, attitude(heel, trim - d))[1]) / (2 * d);
      // Restoring arms grow with the angle they oppose: step against them, at most 0.2 rad.
      const step = (a: number, k: number) => Math.max(-0.2, Math.min(0.2, Math.abs(k) > 1e-12 ? -a / Math.abs(k) : 0));
      heel += step(ah, kh);
      trim += step(at, kt);
    }
  }
  // The mesh at rest; everything below is in this frame.
  const turn = attitude(heel, trim),
    rested = new Float64Array(p.length);
  for (let k = 0; k < p.length; k += 3) rested.set(turn([p[k], p[k + 1], p[k + 2]]), k);
  const m: Mesh3 = { p: rested, index: source.index, count: source.count };
  const [minY, maxY] = extent(rested);
  const waterline = solveWaterline(m, target, minY, maxY);
  const sub = below(m, waterline);
  const b = sub.first.map((x) => x / sub.volume) as [number, number, number];
  // Waterplane area: the rate the displaced volume grows with the waterline.
  const e = (maxY - minY) * 1e-4;
  const up = below(m, waterline + e),
    down = below(m, waterline - e),
    area = (up.volume - down.volume) / (2 * e);
  // Footprint: the outer crossing of the waterline at each angle from the waterplane's centre.
  const segments: number[][] = [];
  for (let k = 0; k < m.count; k += 3) {
    const v = [0, 1, 2].map((j) => {
      const i = m.index(k + j) * 3;
      return [p[i], p[i + 1], p[i + 2]];
    });
    const hits: number[][] = [];
    for (let j = 0; j < 3; j++) {
      const a = v[j],
        c = v[(j + 1) % 3];
      if ((a[1] <= waterline) !== (c[1] <= waterline)) {
        const t = (waterline - a[1]) / (c[1] - a[1]);
        hits.push([a[0] + (c[0] - a[0]) * t, a[2] + (c[2] - a[2]) * t]);
      }
    }
    if (hits.length === 2) segments.push([...hits[0], ...hits[1]]);
  }
  // The waterplane's area centroid: the rate the displaced first moment grows, over the area.
  const centre: [number, number] = area > 0 ? [(up.first[0] - down.first[0]) / (2 * e * area), (up.first[2] - down.first[2]) / (2 * e * area)] : [b[0], b[2]];
  const footprint = new Float64Array(FOOTPRINT_SAMPLES);
  for (let k = 0; k < FOOTPRINT_SAMPLES; k++) {
    const t = (2 * Math.PI * k) / FOOTPRINT_SAMPLES,
      dx = Math.cos(t),
      dz = Math.sin(t);
    let r = 0;
    for (const [x0, z0, x1, z1] of segments) {
      // Ray centre + s d against the segment.
      const ex = x1 - x0,
        ez = z1 - z0,
        wx = x0 - centre[0],
        wz = z0 - centre[1],
        den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const s = (wx * ez - wz * ex) / den,
        u = (wx * dz - wz * dx) / den;
      if (s > 0 && u >= 0 && u <= 1) r = Math.max(r, s);
    }
    footprint[k] = r;
  }
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [x0, z0, x1, z1] of segments) {
    minX = Math.min(minX, x0, x1);
    maxX = Math.max(maxX, x0, x1);
    minZ = Math.min(minZ, z0, z1);
    maxZ = Math.max(maxZ, z0, z1);
  }
  // Metacentric heights: the rate the righting arm grows with a small heel or trim from rest, the waterline re-solved
  // at each angle (central differences, so an arm left at rest does not count).
  const theta = 0.01,
    tilt = (axis: 'roll' | 'pitch') => {
      const k = axis === 'roll' ? 0 : 1,
        plus = arms(m, axis === 'roll' ? attitude(theta, 0) : attitude(0, theta))[k],
        minus = arms(m, axis === 'roll' ? attitude(-theta, 0) : attitude(0, -theta))[k];
      return (plus - minus) / (2 * Math.sin(theta));
    };
  const roll = tilt('roll'),
    pitch = tilt('pitch');
  const mass = ice * volume;
  // Inertia about the centre of mass (uniform ice), for roll about Z and pitch about X.
  const sxx = second[0] / volume - g[0] * g[0],
    syy = second[1] / volume - g[1] * g[1],
    szz = second[2] / volume - g[2] * g[2];
  const period = (radius2: number, gm: number) => (gm > 0 ? 2 * Math.PI * Math.sqrt(radius2 / (G * gm)) : Infinity);
  return {
    volume,
    mass,
    centroid: g,
    waterline,
    draft: waterline - minY,
    freeboard: maxY - waterline,
    submergedFraction: sub.volume / volume,
    buoyancyCentre: b,
    waterplaneArea: area,
    waterplaneCentre: centre,
    length: maxZ - minZ,
    beam: maxX - minX,
    rollMetacentricHeight: roll,
    pitchMetacentricHeight: pitch,
    stable: roll > 0 && pitch > 0,
    heel,
    trim,
    up: [Math.sin(heel) * Math.cos(trim), Math.cos(heel) * Math.cos(trim), Math.sin(trim)] as unknown as [number, number, number],
    heavePeriod: area > 0 ? 2 * Math.PI * Math.sqrt(mass / (water * G * area)) : Infinity,
    rollPeriod: period(sxx + syy, roll),
    pitchPeriod: period(syy + szz, pitch),
    footprint,
  };
}
/** The width to height ratio below which a box berg rolls over: sqrt(6 a (1 - a)), a = ice / water density. */
export function capsizeRatio(iceDensity = 900, waterDensity = 1027): number {
  const a = finite(iceDensity, 300, PURE_ICE_DENSITY, 'ice density') / finite(waterDensity, 990, 1100, 'water density');
  return Math.sqrt(6 * a * (1 - a));
}

// --- Iceberg ---

/** Settings of an {@link Iceberg}. */
export interface IcebergOptions extends BuoyancyOptions {
  mesh: IceMesh;
  /** Where the waterplane's centre starts, world X and Z (Y is the ride's). Default the origin. */
  position?: Vec3;
  /** Compass heading of mesh +Z, degrees (0 is +Z, 90 is +X). Default 0. */
  heading?: number;
  /** Share of the surface velocity the berg drifts with, 0..1. Default 0. */
  drift?: number;
  /** Responses; the default periods are the berg's own (heave, roll, pitch), damping 0.2, 0.05 and 0.05. */
  heave?: FloaterResponse;
  roll?: FloaterResponse;
  pitch?: FloaterResponse;
  /** The material whose waterline the berg keeps current (wet band and notch). */
  material?: IceMaterial;
}
const clampPeriod = (t: number) => (Number.isFinite(t) ? Math.min(120, Math.max(0, t)) : 120);
/**
 * An ice mesh floating on the sea: it sits at the waterline Archimedes gives it (about nine tenths under water for
 * glacier ice in sea water) and rides any water height source through a {@link Floater}, with the heave, roll and pitch
 * periods of its own shape and mass. An unstable shape (`buoyancy.stable` false) is drawn upright; it does not capsize.
 */
export class Iceberg {
  readonly buoyancy: Readonly<Buoyancy>;
  readonly floater: Floater;
  material?: IceMaterial;
  private plane?: IceWaterPlane;
  private source?: WaterHeightSource;
  constructor(options: IcebergOptions) {
    if (!options || typeof options !== 'object') throw typeError('Iceberg needs options { mesh }', 'geometry');
    const b = (this.buoyancy = Object.freeze(iceBuoyancy(options.mesh, options)));
    const response = (r: FloaterResponse | undefined, period: number, damping: number): FloaterResponse => ({
      period: r?.period ?? clampPeriod(period),
      damping: r?.damping ?? damping,
    });
    this.floater = new Floater({
      hull: { length: Math.max(0.5, b.length), beam: Math.max(0.1, b.beam), draft: Math.max(0.05, b.draft), entrance: 60 },
      metacentricHeight: Math.min(20, Math.max(0.01, b.rollMetacentricHeight)),
      heave: response(options.heave, b.heavePeriod, 0.2),
      roll: response(options.roll, b.rollPeriod, 0.05),
      pitch: response(options.pitch, b.pitchPeriod, 0.05),
      drift: options.drift ?? 0,
      position: options.position ?? [0, 0, 0],
      heading: options.heading ?? 0,
    });
    if (options.material !== undefined && !(options.material instanceof IceMaterial)) throw typeError('Iceberg material must be an IceMaterial', 'geometry');
    this.material = options.material;
  }
  /**
   * Puts the berg back where it was built, at rest and with no water given, as a fresh one is, so a later `seek`
   * (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock) gives what a fresh world seeked there
   * gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.floater.resetTime();
    this.source = undefined;
    this.plane = undefined;
  }
  /**
   * Rides `delta` seconds more on the water last given to {@link update}, with no new drive: the clock a film seek
   * (`@margoengine/cutscene` `seek`, the berg in its `extra`) replays. Does nothing before the first `update`.
   */
  advanceTime(delta: number): void {
    if (this.source && delta > 0 && Number.isFinite(delta)) this.update(this.source, Math.min(delta, 10));
  }
  /** Rides the water for `dt` seconds (0..10); give a new position (x and z) and heading to tow it along a path. */
  update(source: WaterHeightSource, dt: number, drive: { position?: Vec3; heading?: number } = {}): this {
    this.source = source;
    this.floater.update(source, dt, drive);
    const fit = this.floater.fit(source),
      a = (this.floater.heading * Math.PI) / 180,
      [x, , z] = this.floater.position;
    if (fit) {
      // The fit's slopes along the hull (forward) and across it (port) as world slopes.
      const along = Math.tan(fit.pitch),
        across = Math.tan(fit.roll),
        f = [Math.sin(a), Math.cos(a)],
        port = [Math.cos(a), -Math.sin(a)];
      this.plane = { x, z, height: fit.height, slopeX: along * f[0] + across * port[0], slopeZ: along * f[1] + across * port[1] };
    }
    if (this.material && this.plane) {
      const b = this.buoyancy,
        g = b.centroid,
        d = b.waterline - g[1] + b.up[0] * g[0] + b.up[1] * g[1] + b.up[2] * g[2];
      this.material.setWater(this.plane, d, this.floater.position[1], b.up);
    }
    return this;
  }
  /** The water plane under the berg at its last update (undefined before one, or aground). */
  get water(): IceWaterPlane | undefined {
    return this.plane;
  }
  /**
   * The mesh's world matrix, column-major: the mesh turned to its resting heel and trim about its centre of mass, its
   * waterplane centre at the Floater's waterline, then the Floater's pose.
   */
  matrix(out: Float32Array | number[] = new Float32Array(16)): Float32Array | number[] {
    const f = this.floater.matrix(new Array(16)) as number[],
      b = this.buoyancy,
      g = b.centroid,
      ch = Math.cos(b.heel),
      sh = Math.sin(b.heel),
      ct = Math.cos(b.trim),
      st = Math.sin(b.trim);
    // The rest turn's columns (images of mesh X, Y, Z) and its translation G - R G, then the waterline offset.
    const r = [ch, sh * ct, -sh * st, -sh, ch * ct, -ch * st, 0, st, ct];
    const t = [0, 1, 2].map((i) => g[i] - (r[i] * g[0] + r[3 + i] * g[1] + r[6 + i] * g[2]));
    t[0] -= b.waterplaneCentre[0];
    t[1] -= b.waterline;
    t[2] -= b.waterplaneCentre[1];
    const local = [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, t[0], t[1], t[2], 1];
    for (let c = 0; c < 4; c++)
      for (let row = 0; row < 4; row++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += f[k * 4 + row] * local[c * 4 + k];
        out[c * 4 + row] = v;
      }
    return out;
  }
  /** World position of the mesh's origin (for `setPosition` with `quaternion`). */
  get position(): [number, number, number] {
    const m = this.matrix(new Array(16));
    return [m[12], m[13], m[14]];
  }
  /** The mesh's rotation as a unit quaternion [x, y, z, w] (Shepperd's method on {@link matrix}). */
  quaternion(): [number, number, number, number] {
    const m = this.matrix(new Array(16)) as number[],
      r = (row: number, col: number) => m[col * 4 + row],
      trace = r(0, 0) + r(1, 1) + r(2, 2);
    let q: [number, number, number, number];
    if (trace > 0) {
      const t = Math.sqrt(trace + 1) * 2;
      q = [(r(2, 1) - r(1, 2)) / t, (r(0, 2) - r(2, 0)) / t, (r(1, 0) - r(0, 1)) / t, t / 4];
    } else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) {
      const t = Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)) * 2;
      q = [t / 4, (r(0, 1) + r(1, 0)) / t, (r(0, 2) + r(2, 0)) / t, (r(2, 1) - r(1, 2)) / t];
    } else if (r(1, 1) > r(2, 2)) {
      const t = Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)) * 2;
      q = [(r(0, 1) + r(1, 0)) / t, t / 4, (r(1, 2) + r(2, 1)) / t, (r(0, 2) - r(2, 0)) / t];
    } else {
      const t = Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)) * 2;
      q = [(r(0, 2) + r(2, 0)) / t, (r(1, 2) + r(2, 1)) / t, t / 4, (r(1, 0) - r(0, 1)) / t];
    }
    return q;
  }
}

// --- Sea ice ---

/** WMO kinds of sea ice SeaIce lays out. */
export type SeaIceKind = 'pancake' | 'brash' | 'floe';
/** The wind on the ice: speed at 10 m (m/s) and the direction it blows toward (XZ). */
export interface IceWind {
  speed: number;
  direction?: readonly [number, number];
}
/** Settings of a {@link SeaIce} field. */
export interface SeaIceOptions {
  /** Default 'pancake'. */
  kind?: SeaIceKind;
  /** Centre and size of the field, world XZ metres. Size 1..1e5 each way. */
  centre?: readonly [number, number];
  size: readonly [number, number];
  /** Share of the sea the pieces cover, 0.01..0.85. Default pancake 0.6, brash 0.4, floe 0.5. */
  concentration?: number;
  /** Piece size across, m: default the WMO range (pancake 0.3..3, brash 0.2..2, floe 20..100). */
  diameter?: readonly [number, number];
  /** Piece thickness, m: default pancake 0.05..0.12, brash 0.2..1, floe 0.3..2. */
  thickness?: readonly [number, number];
  /** Densities, kg/m^3: ice 800..940 (default 910, sea ice), water 990..1100 (default 1027). */
  iceDensity?: number;
  waterDensity?: number;
  /** Wind; default calm. */
  wind?: IceWind;
  /** Drift share of the wind, 0..0.1. Default 0.02. */
  windFactor?: number;
  /** Degrees the drift turns from the wind, -90..90, positive to the right. Default 25 (the north); -25 for the south. */
  turning?: number;
  /** Ocean current, m/s XZ. Default none. */
  current?: readonly [number, number];
  /** Swell period for the attenuation into the field, 1..30 s. Default 9. */
  wavePeriod?: number;
  /** Direction the swell travels, XZ. Default [1, 0]. */
  waveDirection?: readonly [number, number];
  /** Attenuation multiplier, 0 (none) ..20. Default 1 (Doble et al. 2015). */
  attenuation?: number;
  /** Mean sea level the attenuated swell is measured from. Default 0. */
  seaLevel?: number;
  /** Seed of the layout. Default 1. */
  seed?: number;
  /** Most pieces, 1..50,000. Default 20,000. */
  maxPieces?: number;
}
/** One piece of sea ice as laid out (world XZ at time 0). */
export interface SeaIcePiece {
  x: number;
  z: number;
  diameter: number;
  /** Width across over diameter: 1 a disc, below 1 longer than wide. */
  aspect: number;
  thickness: number;
  /** Yaw, radians. */
  yaw: number;
}
const KINDS: Record<SeaIceKind, { concentration: number; diameter: [number, number]; thickness: [number, number] }> = {
  pancake: { concentration: 0.6, diameter: [0.3, 3], thickness: [0.05, 0.12] },
  brash: { concentration: 0.4, diameter: [0.2, 2], thickness: [0.2, 1] },
  floe: { concentration: 0.5, diameter: [20, 100], thickness: [0.3, 2] },
};
function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    // Mulberry32.
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const vec2 = (v: unknown, lo: number, hi: number, what: string): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2) throw typeError(`Sea ice ${what} must be two numbers`, 'geometry');
  return [finite(v[0], lo, hi, what), finite(v[1], lo, hi, what)];
};
const pair = (v: unknown, lo: number, hi: number, what: string): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2) throw typeError(`Sea ice ${what} must be two numbers`, 'geometry');
  const a = finite(v[0], lo, hi, what),
    b = finite(v[1], lo, hi, what);
  if (b < a) throw rangeError(`Sea ice ${what} must be [low, high]`, 'geometry');
  return [a, b];
};
/** Writes instance matrices: `InstancedMesh.instances` of @margoengine/materials fits. */
export interface IceInstances {
  setMatrixAt(index: number, matrix: ArrayLike<number>): unknown;
  count: number;
}
/**
 * A field of sea ice: pancakes, brash or floes laid out without overlap at a concentration, drifting together in free
 * drift (2% of the wind turned 25 degrees, plus the current) and wrapping round the field so it stays full, each piece
 * riding the swell at its freeboard on the plane the water makes under it, the swell weakening into the field as it
 * does in pancake ice. The motion is a function of time, so a seek draws the same field as playing there. Give each
 * kind your own unit model (1 m across, 1 m thick, centred) and write the matrices with `writeInstances`.
 */
export class SeaIce {
  readonly kind: SeaIceKind;
  readonly centre: readonly [number, number];
  readonly size: readonly [number, number];
  readonly pieces: readonly SeaIcePiece[];
  readonly iceDensity: number;
  readonly waterDensity: number;
  /** Read every update. */
  wind: IceWind;
  windFactor: number;
  turning: number;
  current: [number, number];
  wavePeriod: number;
  waveDirection: [number, number];
  attenuation: number;
  seaLevel: number;
  private seconds = 0;
  private source?: WaterHeightSource;
  private offset: [number, number] = [0, 0];
  private readonly poses: Float32Array;
  constructor(options: SeaIceOptions) {
    if (!options || typeof options !== 'object') throw typeError('SeaIce needs options { size }', 'geometry');
    const kind = options.kind ?? 'pancake';
    if (!(kind in KINDS)) throw typeError(`Unknown sea ice kind ${kind}; use pancake, brash or floe`, 'geometry');
    this.kind = kind;
    const base = KINDS[kind];
    this.centre = options.centre ? vec2(options.centre, -1e7, 1e7, 'centre') : [0, 0];
    if (!Array.isArray(options.size) || options.size.length !== 2) throw typeError('Sea ice size must be two numbers', 'geometry');
    this.size = [finite(options.size[0], 1, 1e5, 'size'), finite(options.size[1], 1, 1e5, 'size')];
    const concentration = finite(options.concentration ?? base.concentration, 0.01, 0.85, 'concentration');
    const diameter = pair(options.diameter ?? base.diameter, 0.05, 2000, 'diameter'),
      thickness = pair(options.thickness ?? base.thickness, 0.01, 30, 'thickness');
    this.iceDensity = finite(options.iceDensity ?? 910, 800, 940, 'ice density');
    this.waterDensity = finite(options.waterDensity ?? 1027, 990, 1100, 'water density');
    this.wind = { speed: 0, direction: [1, 0] };
    this.windFactor = 0.02;
    this.turning = 25;
    this.current = [0, 0];
    this.wavePeriod = 9;
    this.waveDirection = [1, 0];
    this.attenuation = 1;
    this.seaLevel = 0;
    this.setDrift(options);
    const max = options.maxPieces ?? 20000;
    if (!Number.isInteger(max) || max < 1 || max > 50000) throw rangeError('Sea ice maxPieces must be a whole number 1..50,000', 'geometry');
    // Dart throwing on a hash grid until the cover is reached or the darts stop landing: pieces never overlap.
    const rand = random(options.seed ?? 1),
      [w, d] = this.size,
      pieces: SeaIcePiece[] = [],
      cell = diameter[1],
      grid = new Map<string, number[]>();
    let covered = 0,
      misses = 0;
    const target = concentration * w * d;
    while (covered < target && pieces.length < max && misses < 4000) {
      // Sizes weighted toward the small end, as broken ice is (Margo's choice: uniform in sqrt of the range).
      const u = rand(),
        dia = diameter[0] + (diameter[1] - diameter[0]) * u * u;
      const aspect = kind === 'pancake' ? 0.85 + 0.15 * rand() : 0.55 + 0.45 * rand();
      const r = dia / 2,
        x = (rand() - 0.5) * w,
        z = (rand() - 0.5) * d;
      const gx = Math.floor(x / cell),
        gz = Math.floor(z / cell);
      let clear = true;
      for (let a = -1; a <= 1 && clear; a++)
        for (let b = -1; b <= 1 && clear; b++)
          for (const j of grid.get(`${gx + a},${gz + b}`) ?? []) {
            const q = pieces[j];
            if (Math.hypot(q.x - x, q.z - z) < r + q.diameter / 2) {
              clear = false;
              break;
            }
          }
      if (!clear) {
        misses++;
        continue;
      }
      misses = 0;
      const key = `${gx},${gz}`;
      grid.set(key, [...(grid.get(key) ?? []), pieces.length]);
      pieces.push({ x, z, diameter: dia, aspect, thickness: thickness[0] + (thickness[1] - thickness[0]) * rand(), yaw: rand() * Math.PI * 2 });
      covered += Math.PI * r * r * aspect;
    }
    this.pieces = Object.freeze(pieces.map((p) => Object.freeze(p)));
    this.poses = new Float32Array(pieces.length * 16);
  }
  /** Changes the drift settings (wind, windFactor, turning, current, wavePeriod, waveDirection, attenuation, seaLevel). */
  setDrift(d: Partial<Pick<SeaIceOptions, 'wind' | 'windFactor' | 'turning' | 'current' | 'wavePeriod' | 'waveDirection' | 'attenuation' | 'seaLevel'>>): this {
    if (d.wind !== undefined) {
      const dir = d.wind.direction ?? this.wind.direction ?? [1, 0];
      if (!Array.isArray(dir) || dir.length !== 2 || !(Math.hypot(dir[0], dir[1]) > 0)) throw rangeError('Sea ice wind direction must be two numbers, not zero', 'geometry');
      this.wind = { speed: finite(d.wind.speed, 0, 100, 'wind speed'), direction: [dir[0], dir[1]] };
    }
    if (d.windFactor !== undefined) this.windFactor = finite(d.windFactor, 0, 0.1, 'wind factor');
    if (d.turning !== undefined) this.turning = finite(d.turning, -90, 90, 'turning');
    if (d.current !== undefined) this.current = vec2(d.current, -10, 10, 'current');
    if (d.wavePeriod !== undefined) this.wavePeriod = finite(d.wavePeriod, 1, 30, 'wave period');
    if (d.waveDirection !== undefined) {
      const v = d.waveDirection;
      if (!Array.isArray(v) || v.length !== 2 || !(Math.hypot(v[0], v[1]) > 0)) throw rangeError('Sea ice wave direction must be two numbers, not zero', 'geometry');
      this.waveDirection = [v[0], v[1]];
    }
    if (d.attenuation !== undefined) this.attenuation = finite(d.attenuation, 0, 20, 'attenuation');
    if (d.seaLevel !== undefined) this.seaLevel = finite(d.seaLevel, -1e5, 1e5, 'sea level');
    return this;
  }
  /** The free drift velocity, m/s XZ: windFactor x the wind turned by `turning` (to the right when positive), plus the current. */
  drift(): [number, number] {
    const dir = this.wind.direction ?? [1, 0],
      len = Math.hypot(dir[0], dir[1]),
      s = this.windFactor * this.wind.speed;
    // Seen from above (Y up), a turn from +X toward +Z is clockwise: to the right.
    const a = (this.turning * Math.PI) / 180,
      ux = dir[0] / len,
      uz = dir[1] / len,
      c = Math.cos(a),
      sn = Math.sin(a);
    return [s * (ux * c - uz * sn) + this.current[0], s * (ux * sn + uz * c) + this.current[1]];
  }
  /** Seconds on the field's clock. */
  get time(): number {
    return this.seconds;
  }
  /** Seeks the clock: the field drifts to where the current drift puts it at that time. */
  setTime(seconds: number): this {
    this.seconds = finite(seconds, -1e9, 1e9, 'time');
    const v = this.drift();
    this.offset = [v[0] * this.seconds, v[1] * this.seconds];
    return this;
  }
  /** Freeboard of a piece `thickness` thick: thickness x (1 - ice / water density). */
  freeboard(thickness: number): number {
    return thickness * (1 - this.iceDensity / this.waterDensity);
  }
  /** Amplitude share of the swell left `metres` into the field: exp(-0.1 T^-2.13 (0.7 h) x attenuation x metres). */
  swellShare(metres: number, thickness: number): number {
    const alpha = 0.2 * this.wavePeriod ** -2.13 * (this.kind === 'pancake' ? 0.7 : 1) * thickness;
    return Math.exp(-(alpha / 2) * this.attenuation * Math.max(0, metres));
  }
  /** Where piece `i` is now, world XZ (wrapped into the field). */
  at(i: number): [number, number] {
    const p = this.pieces[i];
    if (!p) throw rangeError('Sea ice piece index out of range', 'geometry');
    const [w, d] = this.size,
      wrap = (v: number, span: number) => v - span * Math.floor(v / span + 0.5);
    return [this.centre[0] + wrap(p.x + this.offset[0], w), this.centre[1] + wrap(p.z + this.offset[1], d)];
  }
  /**
   * Puts the field's clock and drift back to 0 and forgets the water it was given and the poses set on it, as a fresh
   * field has them, so a later `seek` (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock) gives
   * what a fresh world seeked there gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.seconds = 0;
    this.offset = [0, 0];
    this.source = undefined;
    this.poses.fill(0);
  }
  /**
   * Moves the clock `delta` seconds and, once {@link update} has given it water, sets the pieces on that water again:
   * the clock a film seek (`@margoengine/cutscene` `seek`, the field in its `extra`) replays.
   */
  advanceTime(delta: number): void {
    if (!(delta > 0 && Number.isFinite(delta))) return;
    if (this.source) this.update(this.source, Math.min(delta, 10));
    else this.setTime(this.seconds + delta);
  }
  /**
   * Advances the clock by `dt` (0..10 s) and sets every piece on the water `source` gives: heave and tilt from a plane
   * through the water at the piece's centre and its rim, weakened by the swell's attenuation into the field.
   */
  update(source: WaterHeightSource, dt: number): this {
    if (!source || typeof source.sample !== 'function') throw typeError('SeaIce needs a water source with sample(x, z)', 'geometry');
    this.source = source;
    finite(dt, 0, 10, 'time step');
    const v = this.drift();
    this.seconds += dt;
    this.offset[0] += v[0] * dt;
    this.offset[1] += v[1] * dt;
    const [w, d] = this.size,
      wd = this.waveDirection,
      wl = Math.hypot(wd[0], wd[1]),
      ux = wd[0] / wl,
      uz = wd[1] / wl;
    // Distance into the field from its upwave edge, along the swell.
    const edge = -(Math.abs(ux) * w + Math.abs(uz) * d) / 2;
    const out = this.poses;
    this.pieces.forEach((p, i) => {
      const [x, z] = this.at(i),
        r = (p.diameter / 2) * 0.8;
      const h0 = source.sample(x, z)?.height ?? this.seaLevel,
        hx = source.sample(x + r, z)?.height ?? h0,
        hz = source.sample(x, z + r)?.height ?? h0;
      const into = (x - this.centre[0]) * ux + (z - this.centre[1]) * uz - edge,
        share = this.swellShare(into, p.thickness);
      const height = this.seaLevel + (h0 - this.seaLevel) * share,
        sx = ((hx - h0) / r) * share,
        sz = ((hz - h0) / r) * share;
      // Up is the plane's normal; X the yaw's direction laid on the plane; Z = X x up.
      const n = [-sx, 1, -sz],
        nl = Math.hypot(n[0], n[1], n[2]),
        up = n.map((c) => c / nl);
      const x0 = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)],
        dot = x0[0] * up[0] + x0[2] * up[2];
      let ax = [x0[0] - up[0] * dot, -up[1] * dot, x0[2] - up[2] * dot];
      const al = Math.hypot(ax[0], ax[1], ax[2]);
      ax = ax.map((c) => c / al);
      const az = [ax[1] * up[2] - ax[2] * up[1], ax[2] * up[0] - ax[0] * up[2], ax[0] * up[1] - ax[1] * up[0]];
      const cy = height + this.freeboard(p.thickness) - p.thickness / 2;
      const sxw = p.diameter,
        szw = p.diameter * p.aspect,
        o = i * 16;
      out.set([ax[0] * sxw, ax[1] * sxw, ax[2] * sxw, 0, up[0] * p.thickness, up[1] * p.thickness, up[2] * p.thickness, 0, az[0] * szw, az[1] * szw, az[2] * szw, 0, x, cy, z, 1], o);
    });
    return this;
  }
  /** Column-major world matrices of every piece at the last update (16 floats each), for a unit model. */
  get matrices(): Float32Array {
    return this.poses;
  }
  /** Writes the pieces' matrices into instances (`InstancedMesh.instances`) and sets their count; returns the count. */
  writeInstances(instances: IceInstances, first = 0, count = this.pieces.length - first): number {
    if (!instances || typeof instances.setMatrixAt !== 'function') throw typeError('writeInstances needs instances with setMatrixAt', 'geometry');
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 0 || first + count > this.pieces.length) throw rangeError('Sea ice instance range out of the field', 'geometry');
    for (let i = 0; i < count; i++) instances.setMatrixAt(i, this.poses.subarray((first + i) * 16, (first + i) * 16 + 16));
    instances.count = count;
    return count;
  }
}

// --- Foam and breaking water at the berg ---

/** The live look of BergFoam. */
export interface BergFoamLook {
  /** Width of the foam ring round the waterline, m, 0..50. Default 3. */
  foamWidth: number;
  /** Breaking foam on the weather side, 0..3. Default 1. */
  breakFoam: number;
  /** Length of the foam streaks the swell carries past the berg, m, 0..1000. Default 60. */
  foamTrail: number;
  /** Significant wave height, m (0..20), or null: from the Water's wind (Pierson and Moskowitz, 0.21 U^2 / g). */
  waveHeight: number | null;
}
/** The default BergFoam look. */
export const BERG_FOAM_DEFAULTS: Readonly<BergFoamLook> = Object.freeze({ foamWidth: 3, breakFoam: 1, foamTrail: 60, waveHeight: null });
const FOAM_RANGES: Record<keyof BergFoamLook, [number, number]> = { foamWidth: [0, 50], breakFoam: [0, 3], foamTrail: [0, 1000], waveHeight: [0, 20] };
/** Settings of BergFoam. */
export interface BergFoamOptions {
  surface: Water;
  bergs?: readonly Iceberg[];
  look?: Partial<BergFoamLook>;
  /** Direction the swell travels, XZ; default the Water's wind direction. */
  waveDirection?: readonly [number, number];
}
// Uniform: head (bergs, wave x, wave z, wave height), look (width, break, trail, 0), then per berg a pose (x, z,
// heading radians, mean radius) and the footprint radii in 8 vec4.
const BERG_FLOATS = 4 + FOOTPRINT_SAMPLES,
  FOAM_FLOATS = 8 + MAX_BERGS * BERG_FLOATS;
const FOAM_WGSL = /* wgsl */ `
struct BergData {head:vec4f,look:vec4f,bergs:array<vec4f,${MAX_BERGS * (BERG_FLOATS / 4)}>}
fn bergRadius(b:u32,angle:f32)->f32 {
 let x=fract(angle/6.28318531)*${FOOTPRINT_SAMPLES}.0;let k=u32(floor(x))%${FOOTPRINT_SAMPLES}u;let k2=(k+1u)%${FOOTPRINT_SAMPLES}u;
 let o=b*${BERG_FLOATS / 4}u+1u;
 return mix(bergData.bergs[o+k/4u][k%4u],bergData.bergs[o+k2/4u][k2%4u],fract(x));
}
fn bergFoam(p:vec2f)->f32 {
 var foam=0.0;let dir=bergData.head.yz;let hs=bergData.head.w;let look=bergData.look;
 for(var b=0u;b<u32(bergData.head.x);b++){
  let pose=bergData.bergs[b*${BERG_FLOATS / 4}u];let rel=p-pose.xy;
  let c=cos(pose.z);let s=sin(pose.z);
  let local=vec2f(rel.x*c-rel.y*s,rel.x*s+rel.y*c);
  let dist=length(local);if(dist>pose.w*4.0+look.z+look.x+1.0){continue;}
  let edge=dist-bergRadius(b,atan2(local.y,local.x));
  let width=look.x*(1.0+hs*0.5);
  let toward=select(rel/max(dist,1e-4),vec2f(0),dist<1e-4);
  let weather=max(0.0,-dot(toward,dir));
  var ring=0.0;if(width>0.0&&edge>-0.5){ring=(1.0-smoothstep(0.0,width*(0.6+weather),edge))*(0.45+0.55*weather*min(look.y,1.0)*smoothstep(0.1,1.5,hs));}
  var crash=0.0;if(edge>-0.5){crash=look.y*weather*smoothstep(0.2,2.0,hs)*(1.0-smoothstep(0.0,0.6*width+hs,edge));}
  let along=dot(rel,dir);let across=abs(rel.x*dir.y-rel.y*dir.x);
  var trail=0.0;if(look.z>0.0&&along>0.0){trail=0.6*exp(-along/look.z)*(1.0-smoothstep(0.5*pose.w,1.1*pose.w,across))*smoothstep(-0.5,width,edge);}
  foam=max(foam,max(max(ring,crash),trail));
 }
 return clamp(foam,0.0,1.0);
}
`;
/**
 * The water round floating ice on a Water: a foam ring along each berg's waterline, wider and whiter on the weather
 * side where the swell breaks against it, and streaks of foam the swell carries past it. Its CPU twin is `sample`.
 */
export class BergFoam implements EnginePlugin {
  readonly name = 'water:berg-foam-' + sequence++;
  readonly surface: Water;
  readonly bergs: Iceberg[] = [];
  readonly look: BergFoamLook;
  waveDirection?: [number, number];
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;
  private readonly values = new Float32Array(FOAM_FLOATS);
  constructor(options: BergFoamOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function') throw fault('state', 'BergFoam needs a Water surface; pass options.surface');
    this.surface = options.surface;
    this.look = { ...BERG_FOAM_DEFAULTS };
    this.setLook(options.look ?? {});
    if (options.waveDirection) {
      const v = options.waveDirection;
      if (!Array.isArray(v) || v.length !== 2 || !(Math.hypot(v[0], v[1]) > 0)) throw rangeError('BergFoam waveDirection must be two numbers, not zero', 'geometry');
      this.waveDirection = [v[0], v[1]];
    }
    for (const b of options.bergs ?? []) this.add(b);
  }
  /** Same as `engine.use(new BergFoam(options))`; attach after the Water. */
  static attach(engine: EngineKernel, options: BergFoamOptions): BergFoam {
    const foam = new BergFoam(options);
    engineRuntime(engine).use(foam);
    return foam;
  }
  add(berg: Iceberg): this {
    this.live();
    if (!(berg instanceof Iceberg)) throw typeError('BergFoam adds an Iceberg', 'geometry');
    if (this.bergs.length >= MAX_BERGS) throw rangeError(`BergFoam holds up to ${MAX_BERGS} bergs`, 'geometry');
    this.bergs.push(berg);
    return this;
  }
  delete(berg: Iceberg): boolean {
    const i = this.bergs.indexOf(berg);
    if (i < 0) return false;
    this.bergs.splice(i, 1);
    return true;
  }
  /** Changes look values; a null waveHeight follows the Water's wind. */
  setLook(look: Partial<BergFoamLook>): this {
    for (const [key, value] of Object.entries(look ?? {})) {
      const range = FOAM_RANGES[key as keyof BergFoamLook];
      if (!range) throw typeError(`Unknown berg foam look ${key}; use a name of BERG_FOAM_DEFAULTS`, 'geometry');
      if (key === 'waveHeight' && value === null) this.look.waveHeight = null;
      else (this.look as unknown as Record<string, number>)[key] = finite(value, range[0], range[1], key);
    }
    return this;
  }
  /** The swell direction (unit XZ) and significant wave height drawn now. */
  sea(): { direction: [number, number]; waveHeight: number } {
    const wind = this.surface.wind,
      dir = this.waveDirection ?? (wind?.direction as [number, number] | undefined) ?? [1, 0.3],
      len = Math.hypot(dir[0], dir[1]);
    const speed = wind?.speed ?? 0;
    return { direction: [dir[0] / len, dir[1] / len], waveHeight: this.look.waveHeight ?? Math.min(20, (0.21 * speed * speed) / G) };
  }
  /** Fills the uniform from the bergs' poses now. */
  build(): Float32Array {
    const v = this.values,
      { direction, waveHeight } = this.sea();
    v.fill(0);
    v.set([this.bergs.length, direction[0], direction[1], waveHeight, this.look.foamWidth, this.look.breakFoam, this.look.foamTrail, 0], 0);
    this.bergs.forEach((berg, i) => {
      const f = berg.floater,
        b = berg.buoyancy,
        a = (f.heading * Math.PI) / 180,
        o = 8 + i * BERG_FLOATS;
      // The waterplane centre is the Floater's position; the shader turns world offsets by the heading a into mesh X
      // (port, (cos a, -sin a)) and Z (forward, (sin a, cos a)).
      let mean = 0;
      for (const r of b.footprint) mean += r / FOOTPRINT_SAMPLES;
      v.set([f.position[0], f.position[2], a, mean], o);
      v.set(b.footprint, o + 4);
    });
    return v;
  }
  /** The foam drawn at world XZ, 0..1, as the GPU draws it (before the Water's foam pattern), in doubles. */
  sample(x: number, z: number): number {
    finite(x, -1e7, 1e7, 'x');
    finite(z, -1e7, 1e7, 'z');
    const v = this.build(),
      dir = [v[1], v[2]],
      hs = v[3],
      [width0, brk, trailLen] = [v[4], v[5], v[6]];
    let foam = 0;
    for (let b = 0; b < v[0]; b++) {
      const o = 8 + b * BERG_FLOATS,
        rel = [x - v[o], z - v[o + 1]],
        c = Math.cos(v[o + 2]),
        s = Math.sin(v[o + 2]);
      const local = [rel[0] * c - rel[1] * s, rel[0] * s + rel[1] * c],
        dist = Math.hypot(local[0], local[1]),
        mean = v[o + 3];
      if (dist > mean * 4 + trailLen + width0 + 1) continue;
      const angle = Math.atan2(local[1], local[0]),
        t = ((((angle / (2 * Math.PI)) % 1) + 1) % 1) * FOOTPRINT_SAMPLES,
        k = Math.floor(t) % FOOTPRINT_SAMPLES,
        k2 = (k + 1) % FOOTPRINT_SAMPLES;
      const radius = v[o + 4 + k] + (v[o + 4 + k2] - v[o + 4 + k]) * (t - Math.floor(t));
      const edge = dist - radius,
        width = width0 * (1 + hs * 0.5);
      const toward = dist < 1e-4 ? [0, 0] : [rel[0] / dist, rel[1] / dist],
        weather = Math.max(0, -(toward[0] * dir[0] + toward[1] * dir[1]));
      const ring = width > 0 && edge > -0.5 ? (1 - smoothstep(0, width * (0.6 + weather), edge)) * (0.45 + 0.55 * weather * Math.min(brk, 1) * smoothstep(0.1, 1.5, hs)) : 0;
      const crash = edge > -0.5 ? brk * weather * smoothstep(0.2, 2, hs) * (1 - smoothstep(0, 0.6 * width + hs, edge)) : 0;
      const along = rel[0] * dir[0] + rel[1] * dir[1],
        across = Math.abs(rel[0] * dir[1] - rel[1] * dir[0]);
      const trail = trailLen > 0 && along > 0 ? 0.6 * Math.exp(-along / trailLen) * (1 - smoothstep(0.5 * mean, 1.1 * mean, across)) * smoothstep(-0.5, width, edge) : 0;
      foam = Math.max(foam, ring, crash, trail);
    }
    return Math.min(1, Math.max(0, foam));
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'BergFoam already attached; create another BergFoam', 'state');
    if (!engine.gpu) throw fault('unsupported', 'BergFoam needs WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.surface.name)) throw fault('state', 'Attach the Water surface to this engine before BergFoam');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'berg-foam')) throw fault('attached', 'This Water already has berg foam; add bergs to the attached BergFoam', 'state');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: FOAM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const resources = [{ buffer: this.uniform }];
    this.remove = addSurfaceEffect(this.surface, {
      key: 'berg-foam',
      vertex: false,
      count: 1,
      shader: (code, binding) => foamShader(code, binding),
      prepare: (c: Context) => {
        if (c.device !== this.engine?.gpu) throw fault('state', 'BergFoam and Water must use the same engine; attach both to one engine');
        c.device.queue.writeBuffer(this.uniform!, 0, this.build());
        return resources;
      },
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'BergFoam disposed; create another BergFoam');
  }
  private release(): void {
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.uniform = undefined;
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
let sequence = 0;
function foamShader(code: string, binding: number): string {
  const foamLine = 'var foam=max(fresh,surfFoam);';
  if (!code.includes(foamLine)) throw fault('state', 'BergFoam found no place in the Water shader for its foam; update @margoengine/water');
  return `
@group(0) @binding(${binding}) var<uniform> bergData:BergData;
${FOAM_WGSL}${code.replace(foamLine, `${foamLine}foam=max(foam,bergFoam(i.world.xz)*pattern);`)}`;
}

/** Settings of a {@link BergSpray}; the numbers are read every update. */
export interface BergSprayOptions {
  berg: Iceberg;
  particles: SplashParticles;
  /** Direction the swell travels, XZ. Default [1, 0]. */
  waveDirection?: readonly [number, number];
  /** Spray particles a second while the water climbs the face at the threshold, 0..1e6. Default 1,500. */
  sprayRate?: number;
  /** Particles a surge throws at the threshold, growing with the square of the excess, 0..1e6. Default 300. */
  surgeBurst?: number;
  /** Rise speed of the water at the weather face that throws spray, 0.05..20 m/s. Default 0.8. */
  surgeThreshold?: number;
}
/** What the last BergSpray update did. */
export interface BergSprayState {
  rate: number;
  burst: number;
  rise: number;
}
/**
 * Spray off a berg's weather face: the emitter sits where the swell meets the waterline and throws water up the face as
 * fast as the water there climbs, continuously while it climbs past `surgeThreshold` and in a burst at each surge.
 */
export class BergSpray {
  readonly berg: Iceberg;
  readonly particles: SplashParticles;
  waveDirection: [number, number];
  sprayRate: number;
  surgeBurst: number;
  surgeThreshold: number;
  last: BergSprayState = { rate: 0, burst: 0, rise: 0 };
  private lastHeight?: number;
  private rising = false;
  constructor(options: BergSprayOptions) {
    if (!(options?.berg instanceof Iceberg)) throw typeError('BergSpray needs an Iceberg', 'geometry');
    if (!options.particles || typeof options.particles.burst !== 'function' || typeof options.particles.options !== 'object')
      throw typeError('BergSpray needs particles with options and burst(count), such as a VFX', 'geometry');
    this.berg = options.berg;
    this.particles = options.particles;
    const d = options.waveDirection ?? [1, 0];
    if (!Array.isArray(d) || d.length !== 2 || !(Math.hypot(d[0], d[1]) > 0)) throw rangeError('BergSpray waveDirection must be two numbers, not zero', 'geometry');
    this.waveDirection = [d[0], d[1]];
    this.sprayRate = finite(options.sprayRate ?? 1500, 0, 1e6, 'spray rate');
    this.surgeBurst = finite(options.surgeBurst ?? 300, 0, 1e6, 'surge burst');
    this.surgeThreshold = finite(options.surgeThreshold ?? 0.8, 0.05, 20, 'surge threshold');
  }
  /** The weather face point on the waterline, world XZ. */
  face(): [number, number] {
    const f = this.berg.floater,
      b = this.berg.buoyancy,
      a = (f.heading * Math.PI) / 180,
      len = Math.hypot(this.waveDirection[0], this.waveDirection[1]),
      up = [-this.waveDirection[0] / len, -this.waveDirection[1] / len];
    // The upwave direction in mesh space: X = port (cos a, -sin a), Z = forward (sin a, cos a).
    const lx = up[0] * Math.cos(a) - up[1] * Math.sin(a),
      lz = up[0] * Math.sin(a) + up[1] * Math.cos(a);
    const t = ((((Math.atan2(lz, lx) / (2 * Math.PI)) % 1) + 1) % 1) * FOOTPRINT_SAMPLES,
      k = Math.floor(t) % FOOTPRINT_SAMPLES;
    const r = b.footprint[k] + (b.footprint[(k + 1) % FOOTPRINT_SAMPLES] - b.footprint[k]) * (t - Math.floor(t));
    return [f.position[0] + up[0] * r, f.position[2] + up[1] * r];
  }
  /** Sets the emitter for this frame; call after the Iceberg's update with the same water and step. */
  update(source: WaterHeightSource, dt: number): BergSprayState {
    finite(dt, 0, 10, 'time step');
    const [x, z] = this.face(),
      hit = source.sample(x, z);
    const o = this.particles.options;
    if (!hit) {
      o.rate = 0;
      return (this.last = { rate: 0, burst: 0, rise: 0 });
    }
    const rise = this.lastHeight === undefined || dt <= 0 ? 0 : (hit.height - this.lastHeight) / dt;
    this.lastHeight = hit.height;
    const th = this.surgeThreshold,
      len = Math.hypot(this.waveDirection[0], this.waveDirection[1]);
    o.position = [x, hit.height, z];
    // Thrown up the face at the climb speed, and back against the swell.
    o.velocity = [(-this.waveDirection[0] / len) * rise * 0.5, Math.max(0, rise) * 2, (-this.waveDirection[1] / len) * rise * 0.5];
    o.spread = Math.max(0.3, rise);
    o.emissionExtent = [2, 0.2, 2];
    const rate = this.sprayRate * smoothstep(th * 0.5, th * 1.5, rise);
    o.rate = rate;
    let burst = 0;
    if (rise > th && !this.rising) {
      burst = Math.round(this.surgeBurst * ((rise * rise) / (th * th)));
      this.particles.burst(burst);
    }
    this.rising = rise > th;
    return (this.last = { rate, burst, rise });
  }
}
