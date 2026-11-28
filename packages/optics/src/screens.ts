// @margoengine/optics/screens: what an optics bench shows on the GPU. Laser beams as crossed Gaussian tubes, glass
// plates with a rim and a sheen band, glowing spots, a two-beam interference detector and mirror facets lit by a soft
// studio, all drawn by ONE RawShaderMaterial per blend mode, so a bench of many parts compiles one pipeline. Each part's
// look is data (colours, falloffs, weights) carried as flat per-vertex values: a demo passes numbers, never shader text.
//
// Sources (clean room, read as papers and books):
//  - H. Kogelnik and T. Li, "Laser Beams and Resonators", Applied Optics 5(10), 1966, doi:10.1364/AO.5.001550: the
//    TEM00 intensity I(r) = I0 exp(-2 r^2 / w^2). A beam's alpha is a sum of two such Gaussians (core and scatter halo).
//  - A. E. Siegman, Lasers, University Science Books, 1986, ch. 16-17: the Gaussian beam profile, and the wider halo
//    that scatter in air adds around it (the second Gaussian).
//  - M. Born and E. Wolf, Principles of Optics, 7th ed., Cambridge, 1999, section 7.5: two-beam interference,
//    I = I1 + I2 + 2 sqrt(I1 I2) cos(delta), written with fringe visibility V as I = I0 (1 + V cos(delta)) / 2.
//  - P. Hariharan, Basics of Interferometry, 2nd ed., Academic Press, 2007, ch. 2-3: tilted-mirror (wedge) fringes, a
//    linear phase across the detector whose offset moves one fringe per half wavelength of mirror travel.
//  - C. Schlick, "An Inexpensive BRDF Model for Physically-based Rendering", Computer Graphics Forum 13(3), 1994: the
//    brighter rim of glass seen at grazing angles, stood in for by a smoothstep rim on a flat plate.
//  - J. F. Blinn and M. E. Newell, "Texture and Reflection in Computer Generated Images", CACM 19(10), 1976: a mirror
//    shows its surroundings along the view ray reflected about the normal; here the surroundings are one soft panel and
//    one highlight strip, written as functions of that ray.
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import type { RawBlending } from '@margoengine/shader/raw';
import type { EngineKernel, Mesh } from '@margoengine/core';

/** An RGB colour, linear, each channel 0 to 1. */
export type ScreenColor = readonly [number, number, number];

/**
 * A laser beam's look. The beam is two crossed quads with u across (-1 to 1) and v along it (0 to 1); with d = u^2:
 * colour = mix(edge, core, coreMix exp(-colorFalloff d)), alpha = opacity (coreWeight exp(-coreFalloff d) +
 * haloWeight exp(-haloFalloff d)) (lengthBase + lengthSlope v + lengthTaper |2v - 1|), at most 1.
 */
export interface BeamLook {
  /** Colour at the beam's edge. Default a He-Ne red, [0.86, 0.137, 0.04]. */
  edge?: ScreenColor;
  /** Colour at the beam's axis. Default [1, 0.65, 0.26]. */
  core?: ScreenColor;
  /** How far the axis colour wins over the edge colour, 0 to 1. Default 1. */
  coreMix?: number;
  /** Falloff of the axis colour across the beam. Default 28. */
  colorFalloff?: number;
  /** Falloff of the core Gaussian (2 / w^2 in units of the half width). Default 24. */
  coreFalloff?: number;
  /** Weight of the core Gaussian. Default 0.925. */
  coreWeight?: number;
  /** Falloff of the wider scatter halo. Default 4.5. */
  haloFalloff?: number;
  /** Weight of the halo. Default 0.075. */
  haloWeight?: number;
  /** Brightness along the beam: lengthBase + lengthSlope v + lengthTaper |2v - 1|. Default 1. */
  lengthBase?: number;
  /** Default 0. */
  lengthSlope?: number;
  /** Default -0.18 (dimmer toward both ends). */
  lengthTaper?: number;
  /** Overall opacity. Default 1. */
  opacity?: number;
}

/**
 * A glass plate's look (a beam splitter, a compensator, a window). With m the rim measure (max(|u|, |v|) on a
 * rectangle, u^2 + v^2 on a disc) and band = u bandX + v bandY + bandOffset: colour = mix(tint, sheen,
 * sheenMix exp(-sheenFalloff band^2)), alpha = base + rimWeight smoothstep(rimStart, 1, m) + bandWeight
 * exp(-bandFalloff band^2).
 */
export interface PlateLook {
  /** Body colour. Default [0.28, 0.45, 0.58]. */
  tint?: ScreenColor;
  /** Colour of the sheen band. Default [0.77, 0.64, 0.55]. */
  sheen?: ScreenColor;
  /** Default 0.42. */
  sheenMix?: number;
  /** Default 18. */
  sheenFalloff?: number;
  /** Direction of the sheen band across the plate. Default 1. */
  bandX?: number;
  /** Default -0.85. */
  bandY?: number;
  /** Default -0.12. */
  bandOffset?: number;
  /** Where the rim glow starts, 0 to 1 of the rim measure. Default 0.62. */
  rimStart?: number;
  /** Default 0.12. */
  base?: number;
  /** Default 0.32. */
  rimWeight?: number;
  /** Default 0.18. */
  bandWeight?: number;
  /** Default 49. */
  bandFalloff?: number;
  /** `'rect'` (default) or `'disc'`: a disc is cut at its unit circle. */
  shape?: 'rect' | 'disc';
}

/**
 * A glowing spot (a pinhole, a source, the light where a beam lands) on a quad with uv -1 to 1, d = u^2 + v^2:
 * colour = mix(edge, core, coreMix exp(-colorFalloff d)), alpha = opacity (innerWeight exp(-innerFalloff d) +
 * outerWeight exp(-outerFalloff d)) (1 - smoothstep(fade, 1, d)), at most 1; fade 1 or more turns the cut off.
 */
export interface SpotLook {
  /** Default [0.47, 0.039, 0.019]. */
  edge?: ScreenColor;
  /** Default [0.99, 0.57, 0.31]. */
  core?: ScreenColor;
  /** Default 1. */
  coreMix?: number;
  /** Default 4.5. */
  colorFalloff?: number;
  /** Default 0 (flat). */
  innerFalloff?: number;
  /** Default 1. */
  innerWeight?: number;
  /** Default 0. */
  outerFalloff?: number;
  /** Default 0. */
  outerWeight?: number;
  /** Where the spot starts to fade out, 0 to 1 of d. Default 0.62. */
  fade?: number;
  /** Default 1. */
  opacity?: number;
  /**
   * A hard-edged core in place of the two inner exponentials: [start, end] of d, the core being 1 - smoothstep(start,
   * end, d) for both the colour and the inner weight. Default [0, 0] (off).
   */
  hardCore?: readonly [number, number];
}

/**
 * A two-beam interference detector (Michelson, Twyman-Green): a round screen of unit radius in uv. The phase across
 * it is 2 pi (u frequency + cycles), the field (1 + visibility cos(phase)) / 2 under a Gaussian beam exp(-waist r^2),
 * shown as body + glow exp(-r^2) + beam mix(edge, core, beam^gamma) gain, with a reference mark at the top.
 */
export interface FringeLook {
  /** Fringes per unit of u (the screen's half width over the fringe spacing). Default 4. */
  frequency?: number;
  /** Fringe offset in cycles; set it each frame from the path difference. Default 0. */
  cycles?: number;
  /** Fringe visibility V, 0 to 1. Default 1. */
  visibility?: number;
  /** Default 1.52. */
  waist?: number;
  /** Default [0.88, 0.105, 0.036]. */
  edge?: ScreenColor;
  /** Default [0.98, 0.72, 0.45]. */
  core?: ScreenColor;
  /** Default 0.76. */
  gamma?: number;
  /** Default 1.75. */
  gain?: number;
  /** Screen body colour. Default [0.041, 0.028, 0.051]. */
  body?: ScreenColor;
  /** Glow added over the body, fading as exp(-r^2). Default [0.03, 0.021, 0.013]. */
  glow?: ScreenColor;
  /** Brightness of the reference mark at the top of the screen. Default 0.22. */
  markWeight?: number;
}

/**
 * A mirror facet lit by a soft studio (a corner-cube face, a polished housing): the view ray r reflected about the
 * facet normal sees a horizontal light panel, exp(-panelFalloff |r.y - panelHeight|), and a tilted highlight strip,
 * exp(-highlightFalloff |r.x + highlightTilt r.y + highlightOffset|): colour = dark + panel panelColor + tint
 * (base + highlightWeight highlight). Attach the set with `blending: 'none'` to draw facets opaque.
 */
export interface FacetLook {
  /** Default [0.051, 0.078, 0.096]. */
  dark?: ScreenColor;
  /** Default [0.245, 0.306, 0.316]. */
  panelColor?: ScreenColor;
  /** Default 10. */
  panelFalloff?: number;
  /** Default 0.21. */
  panelHeight?: number;
  /** Colour of the highlight strip. Default [1, 0.5, 0.16]. */
  tint?: ScreenColor;
  /** Default 11. */
  highlightFalloff?: number;
  /** Default 0.36. */
  highlightTilt?: number;
  /** Default 0.41. */
  highlightOffset?: number;
  /** Default 0.032. */
  base?: number;
  /** Default 0.21. */
  highlightWeight?: number;
}

/**
 * A lens face (toric or spherical glass seen face on) on a unit disc in uv, r2 = u^2 + v^2 and ribbon = u ribbonX +
 * v ribbonY + ribbonOffset, coating = exp(-ribbonFalloff ribbon^2): colour = mix(inner, outer, edgeMix r2 + coatingMix
 * coating), alpha = (base + edgeWeight r2^2 + coatingWeight coating) (1 - smoothstep(rimStart, rimEnd, r2)).
 */
export interface LensLook {
  /** Default [0.12, 0.049, 0.30] (a violet anti-reflection coating). */
  inner?: ScreenColor;
  /** Default [0.46, 0.65, 0.72]. */
  outer?: ScreenColor;
  /** Default 0.45. */
  edgeMix?: number;
  /** Default 0.38. */
  coatingMix?: number;
  /** Default 1. */
  ribbonX?: number;
  /** Default 0.40. */
  ribbonY?: number;
  /** Default 0.22. */
  ribbonOffset?: number;
  /** Default 49. */
  ribbonFalloff?: number;
  /** Default 0.20. */
  base?: number;
  /** Default 0.58. */
  edgeWeight?: number;
  /** Default 0.18. */
  coatingWeight?: number;
  /** Default 0.974. */
  rimStart?: number;
  /** Default 1.01. */
  rimEnd?: number;
}

/** The shape of a {@link OpticsScreens.lens} face: z = (1 - r^2)(sag + sagU u^2 + sagV v^2) over a disc of `radius`. */
export interface LensShape {
  /** Centre height of the face along +z. Default 0.012. */
  sag?: number;
  /** Extra sag along u (x), the toric difference. Default 0. */
  sagU?: number;
  /** Extra sag along v (y). Default 0. */
  sagV?: number;
  /** Rings from the centre out. Default 10. */
  rings?: number;
  /** Segments around. Default 64. */
  segments?: number;
}

/**
 * An image screen behind ruled glass (a reticle): a spot of radii `spotRadius` (in the screen's own units, half sizes
 * `halfSize`) over a toned glass card with an 80-per-unit ruled grid, crosshair axes and grain; its halo colour runs from
 * `haloA` to `haloB` with `hueMix`, the halo following exp(-1.17 r^2) and the spot edge softened by its pixel size.
 */
export interface ReticleLook {
  /** Spot radii along u and v in screen units. Default [0.02, 0.02]. */
  spotRadius?: readonly [number, number];
  /** Default [0.91, 0.29, 0.34]. */
  haloA?: ScreenColor;
  /** Default [0.33, 0.62, 0.92]. */
  haloB?: ScreenColor;
  /** 0 shows haloA, 1 haloB. Default 0.5. */
  hueMix?: number;
  /** Default [0.93, 0.87, 0.74]. */
  spot?: ScreenColor;
  /** Default 0.95. */
  spotWeight?: number;
  /** Default 0.52. */
  haloWeight?: number;
  /** Ruled lines per screen unit. Default 80. */
  pitch?: number;
}

/** One part on the bench: its RawMesh (hide it with `mesh.visible`) and a live `set` taking any fields of its look. */
export interface ScreenPart<L> {
  readonly mesh: RawMesh;
  /** Changes some of the look; the rest stays. */
  set(look: L): this;
}

/** Options for {@link OpticsScreens.attach}. */
export interface OpticsScreensOptions {
  /**
   * `'normal'` (default) or `'additive'` blend every part of this set after the opaque scene; `'none'` draws them
   * opaque, writing depth (for facets and solid screens).
   */
  blending?: Extract<RawBlending, 'none' | 'normal' | 'additive'>;
  /** Material name, for errors and tools. Default `'optics screens'`. */
  name?: string;
}

// One RawShaders plugin per engine: every set on an engine draws through it (an engine takes one plugin of a name).
const plugins = new WeakMap<EngineKernel, RawShaders>();

const KIND = { beam: 0, plate: 1, disc: 2, spot: 3, fringes: 4, facet: 5, lens: 6, reticle: 7 } as const;

const varying = `
struct ScreenVarying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) @interpolate(flat) kind:f32,
  @location(2) @interpolate(flat) a:vec4f,
  @location(3) @interpolate(flat) b:vec4f,
  @location(4) @interpolate(flat) c:vec4f,
  @location(5) @interpolate(flat) d:vec4f,
  @location(6) @interpolate(flat) e:vec4f,
  @location(7) world:vec3f,
  @location(8) normal:vec3f,
}`;

/** The vertex stage of every screen part (WGSL after the RawShaderMaterial prelude). */
export const screensVertexShader = `${varying}
@vertex fn vertex(v:Attributes)->ScreenVarying {
  let p=mesh.world*vec4f(v.position,1.0);
  return ScreenVarying(camera.viewProjection*p,v.uv,v.kind,v.a,v.b,v.c,v.d,v.e,p.xyz,mesh.normal*v.direction);
}`;

/**
 * The fragment stage: one branch per part kind, each reading its look from the flat values a to e. Its derivatives
 * come first, in uniform control flow (before any branch or discard); only the reticle reads them.
 */
export const screensFragmentShader = `${varying}
@fragment fn fragment(i:ScreenVarying)->@location(0) vec4f {
  let uv=i.uv;
  let sample=uv*i.e.yz;
  let radius=length(sample/max(abs(i.a.xy),vec2f(1e-6)));
  let radiusStep=fwidth(radius);
  let sampleStep=fwidth(sample);
  var color=vec3f(0.0);
  var alpha=1.0;
  if(i.kind<0.5){
    let d=uv.x*uv.x;
    color=mix(i.a.rgb,i.b.rgb,i.a.w*exp(-i.b.w*d));
    let along=i.d.x+i.d.y*uv.y+i.d.z*abs(2.0*uv.y-1.0);
    alpha=min(1.0,i.d.w*(i.c.y*exp(-i.c.x*d)+i.c.w*exp(-i.c.z*d))*along);
  } else if(i.kind<2.5){
    var m=max(abs(uv.x),abs(uv.y));
    if(i.kind>1.5){
      m=dot(uv,uv);
      if(m>1.0){discard;}
    }
    let rim=smoothstep(i.c.w,1.0,m);
    let band=uv.x*i.c.x+uv.y*i.c.y+i.c.z;
    color=mix(i.a.rgb,i.b.rgb,i.a.w*exp(-i.b.w*band*band));
    alpha=i.d.x+i.d.y*rim+i.d.z*exp(-i.d.w*band*band);
  } else if(i.kind<3.5){
    let d=dot(uv,uv);
    var shade=exp(-i.b.w*d);
    var inner=exp(-i.c.x*d);
    if(i.e.y>i.e.x){
      shade=1.0-smoothstep(i.e.x,i.e.y,d);
      inner=shade;
    }
    color=mix(i.a.rgb,i.b.rgb,i.a.w*shade);
    var cut=1.0;
    if(i.d.x<1.0){cut=1.0-smoothstep(i.d.x,1.0,d);}
    alpha=min(1.0,i.d.w*(i.c.y*inner+i.c.w*exp(-i.c.z*d))*cut);
  } else if(i.kind<4.5){
    let rr=dot(uv,uv);
    if(rr>1.0){discard;}
    let angle=6.28318530718*(uv.x*i.c.x+i.c.y);
    let field=0.5+0.5*(i.a.w*cos(angle));
    let beam=field*exp(-i.c.z*rr);
    let body=i.d.rgb+i.e.rgb*exp(-rr);
    let core=mix(i.a.rgb,i.b.rgb,pow(beam,i.b.w));
    let mark=(1.0-smoothstep(.007,.016,abs(uv.x)))*smoothstep(.75,.86,uv.y);
    color=body+beam*core*i.c.w+mark*i.d.w;
  } else if(i.kind<5.5){
    let r=reflect(-normalize(camera.position-i.world),normalize(i.normal));
    let panel=exp(-i.a.w*abs(r.y-i.b.w));
    let highlight=exp(-i.c.w*abs(r.x+i.d.x*r.y+i.d.y));
    color=i.a.rgb+i.b.rgb*panel+i.c.rgb*(i.d.z+i.d.w*highlight);
  } else if(i.kind<6.5){
    let edge=dot(uv,uv);
    let ribbon=uv.x*i.c.x+uv.y*i.c.y+i.c.z;
    let coating=exp(-i.a.w*ribbon*ribbon);
    color=mix(i.a.rgb,i.b.rgb,i.b.w*edge+i.c.w*coating);
    alpha=(i.d.x+i.d.y*edge*edge+i.d.z*coating)*(1.0-smoothstep(i.d.w,i.e.x,edge));
  } else {
    let soft=clamp(radiusStep,0.10,0.60);
    let aa=max(sampleStep*i.e.x,vec2f(0.008,0.008));
    let spot=1.0-smoothstep(1.0-soft,1.0+soft,radius);
    let spill=exp(-1.17*radius*radius);
    let toned=mix(vec3f(0.050,0.037,0.064),vec3f(0.153,0.137,0.169),1.0-dot(uv*0.68,uv*0.68));
    let nearLine=abs(fract(sample*i.e.x+0.5)-0.5);
    let lines=1.0-smoothstep(vec2f(0.014,0.014),vec2f(0.014,0.014)+aa,nearLine);
    let ruled=max(lines.x,lines.y)*(1.0-smoothstep(0.83,1.01,max(abs(uv.x),abs(uv.y))));
    let axes=1.0-smoothstep(0.0,0.010,min(abs(uv.x),abs(uv.y)));
    let haze=fract(sin(dot(floor(sample*7500.0),vec2f(127.1,311.7)))*43758.5453)*0.018;
    let glass=toned+vec3f(0.046,0.038,0.048)*(ruled+axes*0.65)+haze;
    let halo=mix(i.b.rgb,i.c.rgb,i.b.w);
    color=glass+halo*i.d.w*spill+i.d.rgb*i.c.w*spot;
  }
  let brightness=clamp(color,vec3f(0.0),vec3f(1.0));
  return vec4f(margoEncode(vec4f(brightness,1.0)).rgb,alpha);
}`;

const beamDefaults: Required<BeamLook> = {
  edge: [0.86, 0.137, 0.04],
  core: [1, 0.65, 0.26],
  coreMix: 1,
  colorFalloff: 28,
  coreFalloff: 24,
  coreWeight: 0.925,
  haloFalloff: 4.5,
  haloWeight: 0.075,
  lengthBase: 1,
  lengthSlope: 0,
  lengthTaper: -0.18,
  opacity: 1,
};
const plateDefaults: Required<PlateLook> = {
  tint: [0.28, 0.45, 0.58],
  sheen: [0.77, 0.64, 0.55],
  sheenMix: 0.42,
  sheenFalloff: 18,
  bandX: 1,
  bandY: -0.85,
  bandOffset: -0.12,
  rimStart: 0.62,
  base: 0.12,
  rimWeight: 0.32,
  bandWeight: 0.18,
  bandFalloff: 49,
  shape: 'rect',
};
const spotDefaults: Required<SpotLook> = {
  edge: [0.47, 0.039, 0.019],
  core: [0.99, 0.57, 0.31],
  coreMix: 1,
  colorFalloff: 4.5,
  innerFalloff: 0,
  innerWeight: 1,
  outerFalloff: 0,
  outerWeight: 0,
  fade: 0.62,
  opacity: 1,
  hardCore: [0, 0],
};
const fringeDefaults: Required<FringeLook> = {
  frequency: 4,
  cycles: 0,
  visibility: 1,
  waist: 1.52,
  edge: [0.88, 0.105, 0.036],
  core: [0.98, 0.72, 0.45],
  gamma: 0.76,
  gain: 1.75,
  body: [0.041, 0.028, 0.051],
  glow: [0.03, 0.021, 0.013],
  markWeight: 0.22,
};
const facetDefaults: Required<FacetLook> = {
  dark: [0.051, 0.078, 0.096],
  panelColor: [0.245, 0.306, 0.316],
  panelFalloff: 10,
  panelHeight: 0.21,
  tint: [1, 0.5, 0.16],
  highlightFalloff: 11,
  highlightTilt: 0.36,
  highlightOffset: 0.41,
  base: 0.032,
  highlightWeight: 0.21,
};

const lensDefaults: Required<LensLook> = {
  inner: [0.12, 0.049, 0.3],
  outer: [0.46, 0.65, 0.72],
  edgeMix: 0.45,
  coatingMix: 0.38,
  ribbonX: 1,
  ribbonY: 0.4,
  ribbonOffset: 0.22,
  ribbonFalloff: 49,
  base: 0.2,
  edgeWeight: 0.58,
  coatingWeight: 0.18,
  rimStart: 0.974,
  rimEnd: 1.01,
};
const reticleDefaults: Required<ReticleLook> = {
  spotRadius: [0.02, 0.02],
  haloA: [0.91, 0.29, 0.34],
  haloB: [0.33, 0.62, 0.92],
  hueMix: 0.5,
  spot: [0.93, 0.87, 0.74],
  spotWeight: 0.95,
  haloWeight: 0.52,
  pitch: 80,
};

/** The five flat vec4 values (a to e) one part's look packs into. */
export type ScreenSlots = [number[], number[], number[], number[], number[]];
const zero4 = [0, 0, 0, 0];

/** The flat values of a beam's look. Exported for tests and tools. */
export function packBeam(look: Required<BeamLook>): ScreenSlots {
  const l = look;
  return [
    [...l.edge, l.coreMix],
    [...l.core, l.colorFalloff],
    [l.coreFalloff, l.coreWeight, l.haloFalloff, l.haloWeight],
    [l.lengthBase, l.lengthSlope, l.lengthTaper, l.opacity],
    zero4,
  ];
}
/** The flat values of a plate's look. */
export function packPlate(look: Required<PlateLook>): ScreenSlots {
  const l = look;
  return [
    [...l.tint, l.sheenMix],
    [...l.sheen, l.sheenFalloff],
    [l.bandX, l.bandY, l.bandOffset, l.rimStart],
    [l.base, l.rimWeight, l.bandWeight, l.bandFalloff],
    zero4,
  ];
}
/** The flat values of a spot's look. */
export function packSpot(look: Required<SpotLook>): ScreenSlots {
  const l = look;
  return [
    [...l.edge, l.coreMix],
    [...l.core, l.colorFalloff],
    [l.innerFalloff, l.innerWeight, l.outerFalloff, l.outerWeight],
    [l.fade, 0, 0, l.opacity],
    [l.hardCore[0], l.hardCore[1], 0, 0],
  ];
}
/** The flat values of a fringe screen's look. */
export function packFringes(look: Required<FringeLook>): ScreenSlots {
  const l = look;
  return [
    [...l.edge, l.visibility],
    [...l.core, l.gamma],
    [l.frequency, l.cycles, l.waist, l.gain],
    [...l.body, l.markWeight],
    [...l.glow, 0],
  ];
}
/** The flat values of a facet's look. */
export function packFacet(look: Required<FacetLook>): ScreenSlots {
  const l = look;
  return [
    [...l.dark, l.panelFalloff],
    [...l.panelColor, l.panelHeight],
    [...l.tint, l.highlightFalloff],
    [l.highlightTilt, l.highlightOffset, l.base, l.highlightWeight],
    zero4,
  ];
}

/** The flat values of a lens face's look. */
export function packLens(look: Required<LensLook>): ScreenSlots {
  const l = look;
  return [
    [...l.inner, l.ribbonFalloff],
    [...l.outer, l.edgeMix],
    [l.ribbonX, l.ribbonY, l.ribbonOffset, l.coatingMix],
    [l.base, l.edgeWeight, l.coatingWeight, l.rimStart],
    [l.rimEnd, 0, 0, 0],
  ];
}
/** The flat values of a reticle's look; `halfSize` is the screen's own half width and height. */
export function packReticle(look: Required<ReticleLook>, halfSize: readonly [number, number]): ScreenSlots {
  const l = look;
  return [
    [l.spotRadius[0], l.spotRadius[1], 0, 0],
    [...l.haloA, l.hueMix],
    [...l.haloB, l.spotWeight],
    [...l.spot, l.haloWeight],
    [l.pitch, halfSize[0], halfSize[1], 0],
  ];
}

/** Two crossed quads along +z from 0 to 1, u across, v along: the shape a beam's mesh is scaled and turned into. */
export const BEAM_POSITIONS: readonly number[] = [
  -1, 0, 0, 1, 0, 0, 1, 0, 1, -1, 0, 1, 0, -1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1,
];
const BEAM_UV = [-1, 0, 1, 0, 1, 1, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1];
const BEAM_INDEX = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
const QUAD_UV = [-1, -1, 1, -1, 1, 1, -1, 1];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];
const quad = (w: number, h: number) => [-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0];

function check(look: object, defaults: object, what: string): void {
  for (const [key, value] of Object.entries(look)) {
    if (!(key in defaults))
      throw new TypeError(
        `optics/screens ${what}: unknown look field ${key}; use one of ${Object.keys(defaults).join(', ')}`,
      );
    const numbers = typeof value === 'number' ? [value] : Array.isArray(value) ? value : [];
    if (numbers.some((x) => typeof x !== 'number' || !Number.isFinite(x)))
      throw new RangeError(`optics/screens ${what}: ${key} must hold finite numbers`);
  }
}
function positive(what: string, ...sizes: number[]): void {
  if (!sizes.every((s) => s > 0 && Number.isFinite(s)))
    throw new RangeError(`optics/screens ${what}: sizes must be positive`);
}

/**
 * The screens of an optics bench. `OpticsScreens.attach(engine)` makes one material; every `beam`, `plate`, `spot`,
 * `fringes`, `facet`, `lens` and `reticle` call adds a part that follows a core mesh's transform (scale a beam's mesh to its width and
 * length).
 */
export class OpticsScreens {
  readonly material: RawShaderMaterial;
  readonly raw: RawShaders;
  readonly #parts: RawMesh[] = [];

  private constructor(engine: EngineKernel, options: OpticsScreensOptions) {
    const blending = options.blending ?? 'normal';
    if (blending !== 'normal' && blending !== 'additive' && blending !== 'none')
      throw new TypeError(`optics/screens blending must be none, normal or additive, not ${String(blending)}`);
    const opaque = blending === 'none';
    let raw = plugins.get(engine);
    if (!raw) plugins.set(engine, (raw = RawShaders.attach(engine)));
    this.raw = raw;
    this.material = new RawShaderMaterial({
      name: options.name ?? 'optics screens',
      vertexShader: screensVertexShader,
      fragmentShader: screensFragmentShader,
      blending: opaque ? 'normal' : blending,
      transparent: !opaque,
      depthWrite: opaque,
      cull: 'none',
    });
  }

  /** A set of screens on `engine`, sharing one material. */
  static attach(engine: EngineKernel, options: OpticsScreensOptions = {}): OpticsScreens {
    return new OpticsScreens(engine, options);
  }

  #part<L extends object>(
    parent: Mesh,
    shape: {
      positions: readonly number[];
      uv: readonly number[];
      index: readonly number[];
      normal?: readonly number[];
    },
    kind: number | ((look: Required<L>) => number),
    defaults: Required<L>,
    pack: (look: Required<L>) => ScreenSlots,
    look: L,
    what: string,
  ): ScreenPart<L> {
    check(look, defaults, what);
    let current = { ...defaults, ...look } as Required<L>;
    const count = shape.positions.length / 3;
    const kindOf = (l: Required<L>) => (typeof kind === 'number' ? kind : kind(l));
    const fill = (values: readonly number[]) => {
      const out = new Float32Array(count * values.length);
      for (let v = 0; v < count; v++) out.set(values, v * values.length);
      return out;
    };
    const slots = pack(current);
    const mesh = this.raw.add(
      new RawMesh({
        mesh: parent,
        material: this.material,
        index: [...shape.index],
        attributes: {
          position: { data: new Float32Array(shape.positions), type: 'vec3f' },
          uv: { data: new Float32Array(shape.uv), type: 'vec2f' },
          direction: { data: fill(shape.normal ?? [0, 0, 1]), type: 'vec3f' },
          kind: { data: fill([kindOf(current)]), type: 'f32' },
          a: { data: fill(slots[0]), type: 'vec4f' },
          b: { data: fill(slots[1]), type: 'vec4f' },
          c: { data: fill(slots[2]), type: 'vec4f' },
          d: { data: fill(slots[3]), type: 'vec4f' },
          e: { data: fill(slots[4]), type: 'vec4f' },
        },
      }),
    );
    this.#parts.push(mesh);
    return {
      mesh,
      set(next: L) {
        check(next, defaults, what);
        const before = pack(current),
          kindBefore = kindOf(current);
        current = { ...current, ...next };
        pack(current).forEach((values, slot) => {
          if (values.some((x, k) => x !== before[slot][k]))
            mesh.setAttribute('abcde'[slot], { data: fill(values), type: 'vec4f' });
        });
        if (kindOf(current) !== kindBefore) mesh.setAttribute('kind', { data: fill([kindOf(current)]), type: 'f32' });
        return this;
      },
    };
  }

  /** A laser beam along the parent's +z from 0 to 1, one unit wide each side; scale the parent to width and length. */
  beam(parent: Mesh, look: BeamLook = {}): ScreenPart<BeamLook> {
    const shape = { positions: BEAM_POSITIONS, uv: BEAM_UV, index: BEAM_INDEX };
    return this.#part(parent, shape, KIND.beam, beamDefaults, packBeam, look, 'beam');
  }

  /** A glass plate of half width `halfWidth` and half height `halfHeight` in the parent's xy plane. */
  plate(parent: Mesh, halfWidth: number, halfHeight: number, look: PlateLook = {}): ScreenPart<PlateLook> {
    positive('plate', halfWidth, halfHeight);
    if (look.shape !== undefined && look.shape !== 'rect' && look.shape !== 'disc')
      throw new TypeError('optics/screens plate: shape must be rect or disc');
    const shape = { positions: quad(halfWidth, halfHeight), uv: QUAD_UV, index: QUAD_INDEX };
    const kind = (l: Required<PlateLook>) => (l.shape === 'disc' ? KIND.disc : KIND.plate);
    return this.#part(parent, shape, kind, plateDefaults, packPlate, look, 'plate');
  }

  /** A glowing spot of half width `halfWidth` and half height `halfHeight` (an ellipse) in the parent's xy plane. */
  spot(parent: Mesh, halfWidth: number, halfHeight: number, look: SpotLook = {}): ScreenPart<SpotLook> {
    positive('spot', halfWidth, halfHeight);
    const shape = { positions: quad(halfWidth, halfHeight), uv: QUAD_UV, index: QUAD_INDEX };
    return this.#part(parent, shape, KIND.spot, spotDefaults, packSpot, look, 'spot');
  }

  /** A round interference detector of radius `radius` in the parent's xy plane; move its fringes with `set({cycles})`. */
  fringes(parent: Mesh, radius: number, look: FringeLook = {}): ScreenPart<FringeLook> {
    positive('fringes', radius);
    const shape = { positions: quad(radius, radius), uv: QUAD_UV, index: QUAD_INDEX };
    return this.#part(parent, shape, KIND.fringes, fringeDefaults, packFringes, look, 'fringes');
  }

  /** A flat mirror facet: the triangle `points` (three [x, y, z] in the parent's frame) with face normal `normal`. */
  facet(
    parent: Mesh,
    points: readonly (readonly [number, number, number])[],
    normal: readonly [number, number, number],
    look: FacetLook = {},
  ): ScreenPart<FacetLook> {
    if (points.length !== 3 || points.some((p) => p.length !== 3) || normal.length !== 3)
      throw new TypeError('optics/screens facet: points must be three [x, y, z] and normal one');
    const shape = { positions: points.flat(), uv: [0, 0, 1, 0, 0, 1], index: [0, 1, 2], normal };
    return this.#part(parent, shape, KIND.facet, facetDefaults, packFacet, look, 'facet');
  }

  /**
   * A lens face of radius `radius` in the parent's xy plane, bulging along +z by `shape` (a polar mesh of
   * `rings` x `segments`), drawn as coated glass.
   */
  lens(parent: Mesh, radius: number, look: LensLook = {}, shape: LensShape = {}): ScreenPart<LensLook> {
    positive('lens', radius);
    const { sag = 0.012, sagU = 0, sagV = 0, rings = 10, segments = 64 } = shape;
    if (![sag, sagU, sagV].every(Number.isFinite) || !(rings >= 1 && segments >= 3))
      throw new RangeError('optics/screens lens: sags must be finite, rings at least 1 and segments at least 3');
    const positions = [0, 0, sag],
      uv = [0, 0],
      index: number[] = [];
    for (let ring = 1; ring <= rings; ring++)
      for (let k = 0; k < segments; k++) {
        const angle = (2 * Math.PI * k) / segments,
          u = (ring / rings) * Math.cos(angle),
          v = (ring / rings) * Math.sin(angle);
        positions.push(u * radius, v * radius, (1 - u * u - v * v) * (sag + sagU * u * u + sagV * v * v));
        uv.push(u, v);
        const last = 1 + (ring - 1) * segments + k,
          next = 1 + (ring - 1) * segments + ((k + 1) % segments);
        if (ring === 1) index.push(0, last, next);
        else index.push(last - segments, last, next, last - segments, next, next - segments);
      }
    return this.#part(parent, { positions, uv, index }, KIND.lens, lensDefaults, packLens, look, 'lens');
  }

  /** An image screen behind ruled glass, half width `halfWidth` and half height `halfHeight` in the parent's xy plane. */
  reticle(parent: Mesh, halfWidth: number, halfHeight: number, look: ReticleLook = {}): ScreenPart<ReticleLook> {
    positive('reticle', halfWidth, halfHeight);
    const shape = { positions: quad(halfWidth, halfHeight), uv: QUAD_UV, index: QUAD_INDEX };
    const pack = (l: Required<ReticleLook>) => packReticle(l, [halfWidth, halfHeight]);
    return this.#part(parent, shape, KIND.reticle, reticleDefaults, pack, look, 'reticle');
  }

  /** Resolves once the pipeline is compiled; rejects with the material's compile error. */
  async ready(): Promise<void> {
    await this.raw.ready();
    if (this.material.error) throw this.material.error;
  }

  /** Removes every part and frees the material. */
  dispose(): void {
    for (const mesh of this.#parts.splice(0)) {
      this.raw.remove(mesh);
      mesh.dispose();
    }
    this.material.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
