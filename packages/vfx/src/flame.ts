/// <reference lib="esnext.disposable" preserve="true" />
// Flames at any size: house fires, burning forest crowns and the line of a wildfire front, as soft self-luminous
// volumes with a core-to-edge temperature ramp and no additive blowout. Sources (papers and books, read as text; no
// code; docs/clean-room.md "Flame volumes"):
// - D. Q. Nguyen, R. Fedkiw and H. W. Jensen, "Physically Based Modeling and Animation of Fire", ACM Trans. Graph. 21(3)
//   (SIGGRAPH 2002), 721-728, https://doi.org/10.1145/566654.566643: a flame is lit by the blackbody radiation of its
//   gas, so its colour runs from the temperature of the reaction zone down to the cooler soot, and the radiance is
//   shown through an exposure (a mapping of the huge range of a flame's radiance to a display), not added up.
// - M. Planck, "Ueber das Gesetz der Energieverteilung im Normalspectrum", Annalen der Physik 309(3), 553-563, 1901: the
//   spectral radiance of a blackbody, 2 h c^2 / (lambda^5 (exp(h c / (lambda k T)) - 1)).
// - C. Wyman, P.-P. Sloan and P. Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching Functions",
//   Journal of Computer Graphics Techniques 2(2), 1-11, 2013, http://jcgt.org/published/0002/02/01/: the multi-lobe
//   Gaussian fits of the CIE 1931 2 degree observer that turn the spectrum into XYZ; XYZ goes to linear sRGB by the
//   matrix of IEC 61966-2-1 (the Rec. 709 primaries, D65).
// - G. M. Byram, "Combustion of forest fuels", in K. P. Davis (ed.), Forest Fire: Control and Use, McGraw-Hill, 1959:
//   the flame length of a fireline of intensity I (kW/m), L = 0.0775 I^0.46 metres.
// - G. Heskestad, "Luminous heights of turbulent diffusion flames", Fire Safety Journal 5(2), 103-108, 1983: the mean
//   flame height of a pool or compartment fire of heat release Q (kW) over a source of diameter D, L = 0.235 Q^(2/5)
//   - 1.02 D; a house fire is such a fire.
// - J. G. Quintiere, "Scaling applications in fire research", Fire Safety Journal 15(1), 3-29, 1989: the speeds of a
//   buoyant flame go as sqrt(g L), so one rise law holds from a candle to a forest crown.
//
// - G. Heskestad, "Fire Plumes, Flame Height, and Air Entrainment", SFPE Handbook of Fire Protection Engineering, 2016
//   (the same correlation, with the intermittency of the flame tip: the mean height is where flame is present half the time).
// - B. M. Cetegen and T. A. Ahmed, "Experiments on the periodic instability of buoyant plumes and pool fires",
//   Combustion and Flame 93(1-2), 157-184, 1993, https://doi.org/10.1016/0010-2180(93)90090-P: a pool fire puffs (its
//   flame necks, sheds a bulge that rises and burns out) at f = 1.5 D^(-1/2) Hz for a source D metres across.
// - E. E. Zukoski, B. M. Cetegen and T. Kubota, "Visible structure of buoyant diffusion flames", Twentieth Symposium
//   (International) on Combustion, 361-366, 1985, https://doi.org/10.1016/S0082-0784(85)80522-1: the intermittent region
//   of a flame runs from about half to one and a half of its mean height, the flame present half the time at the mean.
// - S. Chandrasekhar, Radiative Transfer, Dover, 1960 (emission and absorption in local thermodynamic equilibrium): a
//   ray through a glowing medium of absorption sigma and source B(T) collects the integral of sigma B e^(-tau), never
//   more than the hottest B along it.
//
// - B. Sun, R. Ramamoorthi, S. G. Narasimhan and S. K. Nayar, "A Practical Analytic Single Scattering Model for Real
//   Time Rendering", ACM Trans. Graph. 24(3) (SIGGRAPH 2005), 1040-1049, https://doi.org/10.1145/1073204.1073309: the
//   light a point source scatters into a viewing ray through a thin medium has a closed form in the ray's closest
//   approach h to the source, (atan((t1 - tc) / h) - atan((t0 - tc) / h)) / h for an unattenuated path; the glow of a
//   fire in the smoky air around it, and on the ground it lights (Lambert, irradiance I cos / d^2), are drawn from it.
// - B. W. Butler, J. Cohen, D. J. Latham, R. D. Schuette, P. Sopko, K. S. Shannon, D. Jimenez and L. S. Bradshaw,
//   "Measurements of radiant emissive power and temperatures in crown fires", Canadian Journal of Forest Research 34(8),
//   1577-1587, 2004, https://doi.org/10.1139/x04-060: the emissive power of a crown fire peaks low in the flame (the
//   continuous zone over the burning fuel), where the flame is hottest; it falls toward the tips.
// - R. C. Rothermel and H. E. Anderson, "Fire spread characteristics determined in the laboratory", USDA Forest Service
//   Research Paper INT-30, 1966, and Albini 1981 ("A model for the wind-blown flame from a line fire", Combustion and
//   Flame 43, 155-174): a line fire's flame stands on the fuel bed, following the ground, and its tips rise and fall
//   along the line as separate tongues of varied height around the mean length.
//
// A flame is drawn as one ray-marched volume in a box over its footprint: a flame zone that tapers from the footprint
// to a point (or to a ridge, for a line of fire) at 1.35 L, cut into tongues by turbulent noise that rises at the
// buoyant speed 0.5 sqrt(g L) (Quintiere 1989) and is stretched upward, with an intermittency that leaves flame half the
// time at L (Zukoski et al. 1985), and puffing: the zone necks and bulges in a wave that rises at the Cetegen and Ahmed
// frequency. Each point carries a heat, highest deep in the zone and low in the flame, whose temperature runs from the
// edge's to the core's; its colour is the blackbody's (a 16-stop table). The ray collects emission and absorption as
// above, so the pixel is never brighter than the hottest gas it crosses, then goes through a camera's per-channel
// shoulder, peak (1 - e^(-gain c / peak)): a hot core saturates red, then green, and reads yellow-white while blue stays
// low, so it never blows out to white. The flame lights its surroundings with point lights over its footprint whose
// intensity follows the puffing of the tongues above them.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import type { Clustered, PointLight } from '@margoengine/clustered';
import type { LightGroup, LightGroups } from '@margoengine/clustered/groups';
import { viewMatrix } from '../../shared/view.js';
import { applyView } from '../../shared/view-rect.js';
import { reactiveBlend, reactiveMaskWanted, reactiveTarget } from '../../shared/reactive-mask.js';
import { checkFog, FOG_BYTES, fogWgsl, writeFog, type FogLike } from '../../shared/fog.js';
import { valueNoiseWgsl } from '../../shared/noise-wgsl.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { soft, softDepthWgsl } from './soft.js';
import type { VFXWind } from '@margoengine/vfx/base';
import {
  blackbodyColor,
  blackbodyLuminousEfficacy,
  blackbodyXYZ,
  FLAME_PEAK,
  rampIn,
  type FlameRampOptions,
} from './flame-ramp.js';

export {
  blackbodyChromaticity,
  blackbodyColor,
  blackbodyLuminanceRatio,
  blackbodyLuminousEfficacy,
  flameRamp,
  FLAME_PEAK,
  type FlameRampOptions,
  type FlameStop,
} from './flame-ramp.js';

type Vec3 = readonly [number, number, number];

/** Gravity, m/s^2. */
const G = 9.80665;
/** The rise speed of a flame over sqrt(g L) (Quintiere 1989's scaling, with the constant of a flame's mean rise). */
export const FLAME_FROUDE = 0.5;
/** The flame length of the Cabin Hearth's fire, metres: the length the hearth kit's flames rise to. */
export const HEARTH_FLAME_LENGTH = 0.25;

// ---------------------------------------------------------------------------------------------------------------
// Flame length
// ---------------------------------------------------------------------------------------------------------------

/**
 * Byram's flame length of a fireline, metres: 0.0775 I^0.46 for a fireline intensity I in kW/m (Byram 1959).
 * @throws RangeError for an intensity that is not a finite number of 0 or more.
 * @example byramFlameLength(10000); // 5.4 m
 */
export function byramFlameLength(intensity: number): number {
  if (!(Number.isFinite(intensity) && intensity >= 0))
    throw new RangeError('Fireline intensity must be a finite kW/m of 0 or more');
  return 0.0775 * intensity ** 0.46;
}
/** The fireline intensity, kW/m, whose Byram flame length is `length` metres (the inverse of {@link byramFlameLength}). */
export function byramIntensity(length: number): number {
  if (!(Number.isFinite(length) && length >= 0))
    throw new RangeError('Flame length must be a finite number of metres, 0 or more');
  return (length / 0.0775) ** (1 / 0.46);
}
/**
 * Heskestad's mean flame height, metres, of a fire releasing `heat` watts over a source `diameter` metres across:
 * 0.235 Q^(2/5) - 1.02 D with Q in kW, never below 0 (Heskestad 1983).
 * @throws RangeError for a heat or diameter that is not a finite number of 0 or more.
 * @example heskestadFlameLength(20e6, 4); // 8.3 m: a house fire through a roof breach 4 m across
 */
export function heskestadFlameLength(heat: number, diameter: number): number {
  if (!(Number.isFinite(heat) && heat >= 0))
    throw new RangeError('Heat release must be a finite number of watts, 0 or more');
  if (!(Number.isFinite(diameter) && diameter >= 0))
    throw new RangeError('Fire diameter must be a finite number of metres, 0 or more');
  return Math.max(0.235 * (heat / 1000) ** 0.4 - 1.02 * diameter, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// The volume
// ---------------------------------------------------------------------------------------------------------------

/** Cetegen and Ahmed 1993's puffing constant: a pool fire D metres across puffs at 1.5 D^(-1/2) Hz. */
export const PUFFING_CONSTANT = 1.5;
/**
 * The puffing frequency, Hz, of a fire `diameter` metres across: 1.5 D^(-1/2) (Cetegen and Ahmed 1993).
 * @throws RangeError for a diameter that is not a finite number above 0.
 * @example puffingFrequency(4); // 0.75 Hz
 */
export function puffingFrequency(diameter: number): number {
  if (!(Number.isFinite(diameter) && diameter > 0))
    throw new RangeError('Fire diameter must be a finite number of metres above 0');
  return PUFFING_CONSTANT / Math.sqrt(diameter);
}
/**
 * The source diameter, metres, that sets the puffing of a footprint `[x, z]` metres: the diameter of a circle of the same
 * area for a compact fire, never more than twice its narrower side, so a long line of fire puffs as its depth does.
 */
export function puffingDiameter(footprint: readonly [number, number]): number {
  const [x, z] = footprint;
  return Math.max(Math.min(Math.sqrt((4 * x * z) / Math.PI), 2 * Math.min(x, z)), 0.05);
}
/**
 * The flame volume's draw order in the frame graph: just before the particle effects, smoke columns and cloud puffs (6).
 * A second pass right after it ({@link FLAME_DEPTH_ORDER}) writes the depth of the flame where it is opaque, so a puff or
 * ember behind the flame is hidden by it and one in front draws over it (KB-FLAME-FRONTEMBERS1).
 */
const FLAME_ORDER = 5.95;
/** The flame's depth pass: after its colour, before the particles. */
const FLAME_DEPTH_ORDER = 5.96;
/** Transmittance at which the depth pass puts the flame's surface: behind it, half the light is gone. */
const DEPTH_AT = 0.5;
/** The default flame zone of the volume: it tapers to nothing at this many flame lengths. */
const TOP = 1.35;
/** The volume's box height over the flame length (room for the tips of the tongues). */
const BOX_TOP = 2;
/** Shoulder gain: a flame of heat 1 (its core) shows 1 - e^(-4) = 98% of `peak` in its brightest channel. */
const GAIN = 4;
/** Absorption of the flame zone at full density, per flame length. */
const EXTINCTION = 18;
/** Fewest ray steps through the box (a short ray). */
const STEPS = 64;
/** Most ray steps: a grazing ray along a long front steps {@link STEP_LENGTH} at a time, two through empty air. */
const MAX_STEPS = 256;
/** The longest ray step over the flame length: finer than the smallest tongue detail, so a grazing view shows no steps. */
const STEP_LENGTH = 0.03;
/** Interleaved gradient noise's per-frame pixel shift (Jimenez 2014): the march start moves every frame. */
const IGN_FRAME_SHIFT = 5.588238;
/** Scattering coefficient of the air around a flame, per metre: a light haze (visibility about 8 km); a wildfire's smoke-filled air is thicker (`FireFront` gives its flames 0.003). */
const DEFAULT_HAZE = 0.0005;
/** Reflectance of the ground the glow lights when no `lights` are given: forest litter and duff. */
const GROUND_ALBEDO = 0.15;
/** How far the glow reaches, flame lengths. */
const GLOW_RADIUS = 3;
/** Most glow sources along a footprint (as many as the light's points). */
const GLOW_SOURCES = 4;
/** Stops of the temperature table the shader reads. */
const TABLE = 16;
/**
 * The flame's light over its peak radiance times its silhouette (flame length by width): a source of radiance Lr and
 * area A has intensity Lr A, so a wall it lights is never brighter than the flame (the flame fills about half of that
 * rectangle, at about its peak radiance).
 */
export const FLAME_LIGHT_FILL = 0.5;
/**
 * The share of a fire's heat release that leaves as radiation (the radiative fraction chi_r): about 0.3 for wood,
 * cellulosic packing and most sooty fuels in free burn (Tewarson, "Generation of Heat and Gaseous, Liquid, and Solid
 * Products in Fires", SFPE Handbook of Fire Protection Engineering, 5th ed., 2016; Koseki, "Combustion properties of
 * large liquid pool fires", Fire Technology 25(3), 241-255, 1989; McCaffrey, "Purely Buoyant Diffusion Flames: Some
 * Experimental Results", NBSIR 79-1910, 1979).
 */
export const FLAME_RADIANT_FRACTION = 0.3;

/**
 * The luminous flux of a fire, lumens: the radiated share of its heat release (`radiantFraction` of `heat` watts) times
 * the luminous efficacy of blackbody radiation at the temperature it radiates at (`kelvin`, Planck's law through the
 * photopic curve). A candle (about 80 W, chi_r about 0.2, 1,850 K soot) gives about 12 lm, the one candela it was
 * named for; a 1 MW wood fire at 1,760 K about 150,000 lm.
 * @throws RangeError for a heat or fraction out of range, or a temperature outside 500 to 40,000 K.
 * @example flameLuminousFlux(1e6, 1760); // about 150,000 lm
 */
export function flameLuminousFlux(heat: number, kelvin: number, radiantFraction = FLAME_RADIANT_FRACTION): number {
  if (!(Number.isFinite(heat) && heat >= 0))
    throw new RangeError('Heat release must be a finite number of watts, 0 or more');
  if (!(Number.isFinite(radiantFraction) && radiantFraction >= 0 && radiantFraction <= 1))
    throw new RangeError('Radiant fraction must be a number from 0 to 1');
  return radiantFraction * heat * blackbodyLuminousEfficacy(kelvin);
}
/** The heat release, watts, of a flame `length` metres tall over a source `diameter` across (Heskestad 1983 turned round). */
export function heskestadHeat(length: number, diameter: number): number {
  if (!(Number.isFinite(length) && length >= 0))
    throw new RangeError('Flame length must be a finite number of metres, 0 or more');
  if (!(Number.isFinite(diameter) && diameter >= 0))
    throw new RangeError('Fire diameter must be a finite number of metres, 0 or more');
  return 1000 * ((length + 1.02 * diameter) / 0.235) ** 2.5;
}

// The shader's hash and value noise, and their twin here, so the light of a stretch puffs with the tongues above it.
const hash = (n: number): number => {
  let x = (Math.imul(n >>> 0, 747796405) + 2891336453) >>> 0;
  x = Math.imul(((x >>> ((x >>> 28) + 4)) ^ x) >>> 0, 277803737) >>> 0;
  x = ((x >>> 22) ^ x) >>> 0;
  return x / 4294967295;
};
const vnoise1 = (v: number): number => {
  const i = Math.floor(v),
    f = v - i,
    s = f * f * (3 - 2 * f);
  return hash(i | 0) + (hash((i + 1) | 0) - hash(i | 0)) * s;
};

/** A flame's hot plume ({@link Flame.plume}): the shape `HeatHaze` of `@margoengine/post/heat-haze` reads. */
export interface FlamePlume {
  /** Centre of the footprint on the fuel, world units. */
  readonly position: readonly [number, number, number];
  /** Flame length now, metres (0 when out). */
  readonly length: number;
  /** Footprint `[x, z]` before `yaw`, metres, as drawn. */
  readonly footprint: readonly [number, number];
  /** Turn of the footprint about +y, radians. */
  readonly yaw: number;
  /** Lean in the wind, `[x, z]` world metres across per metre up. */
  readonly lean: readonly [number, number];
  /** The flame's clock, seconds. */
  readonly time: number;
}

/** `Flame.attach` settings. `position` is required, and one of `length`, `intensity` or `heat`. */
export interface FlameOptions extends FlameRampOptions {
  /** Centre of the footprint on the fuel, world units. */
  position: Vec3;
  /** The flame length, metres, 0 to 1,000 (0 puts the flames out). Wins over `intensity` and `heat`. */
  length?: number;
  /** A fireline's intensity, kW/m: the length is Byram's (Byram 1959). */
  intensity?: number;
  /** A fire's heat release, watts: the length is Heskestad's over the footprint's diameter (Heskestad 1983). */
  heat?: number;
  /** Footprint `[x, z]` before `yaw`, metres, 0 or more. Default `[0.5 length, 0.5 length]`. */
  footprint?: readonly [number, number];
  /** Turn of the footprint about +y, radians (its x side runs along `[cos yaw, 0, -sin yaw]`). Default 0. */
  yaw?: number;
  /** The wind at the flames, `[x, z]` m/s or `{sample(x, y, z, t)}`: the flames lean atan(U / w) at their rise speed w. Default none. */
  wind?: VFXWind;
  /**
   * The slope of the ground under the flame, `[dy/dx, dy/dz]` in world axes, each -10 to 10: the flame stands on that
   * plane through `position` (its base follows the ground across a long footprint instead of being cut by the slope),
   * and the glow lights it. Default [0, 0] (level ground).
   */
  slope?: readonly [number, number];
  /**
   * The light the flame throws into the air and onto the ground around it, as a multiple of the physical, 0 to 8: the
   * smoky air within `glowRadius` flame lengths glows with the light it scatters (Sun et al. 2005), and the ground plane
   * (`slope`) is lit by it. Without `depth`, surfaces standing in that light (trees) take the light of the ground
   * behind them. 0 turns it off. Default 1.
   */
  glow?: number;
  /** Scattering coefficient of the air around the flames, per metre, 0 to 1 (a light haze 0.0005, smoke-filled air at a wildfire about 0.003 to 0.01, a clear night 0.0001). Default 0.0005. */
  haze?: number;
  /** Reflectance of the ground the glow lights, 0 to 1 (forest litter about 0.15). Default 0.15; 0 when `lights` is given (the point lights light the scene). */
  groundAlbedo?: number;
  /** How far the glow reaches, flame lengths, 0.5 to 10. Default 3. */
  glowRadius?: number;
  /** Opacity of the flame zone, 0 to 1. Default 1. */
  opacity?: number;
  /** Puffing and light flicker as a multiple of the physical (Cetegen and Ahmed 1993), 0 to 3; 0 holds the flames steady. Default 1. */
  flicker?: number;
  /** Size of the flame tongues as a multiple of the default (0.22 of the flame length across), 0.25 to 4. Default 1. */
  tongues?: number;
  /**
   * A crown fire: the spacing of the burning trees, metres, 0 to 1,000. Each tree torches as its own tapering column
   * (Van Wagner 1977; Alexander and Cruz 2011 put crown flames at one to two and a half times the stand height): its
   * base reaches down into its crown by up to 0.3 flame lengths, its top runs from 0.6 to 1.4 flame lengths, so the
   * fire's foot and crest are ragged as in a torching stand. 0 is a surface fire (one zone over the footprint). Default 0.
   */
  crowns?: number;
  /**
   * Where the flame's light goes: a `LightGroups` (the flame takes a group of its own, `flame`, `flame 2`, ...) or a
   * `Clustered` (the flame then owns its whole list), attached to the same scene; it lights the meshes added to that
   * `Clustered` (`clustered.add(mesh)`) and smoke whose `lit.lights` is it. Point lights over the footprint at a
   * third of the flame's height, as bright as its silhouette at its peak radiance ({@link FLAME_LIGHT_FILL}), flickering with the puffing
   * of the tongues above each. Read at attach. Default: no light.
   */
  lights?: Clustered | LightGroups;
  /** Scales the light, 0 or more. Default 1. */
  lightPower?: number;
  /** Fog over the flames (`Fog` of `@margoengine/environment` or any `FogLike`). Default none. */
  fog?: FogLike | null;
  /**
   * The scene depth (`DepthTexture` of `@margoengine/post/depth`): the march stops at surfaces inside the volume (a house
   * in its own flames, logs, the ground), and the camera may stand inside the flames. Read at attach. Default: the box is
   * depth-tested against the scene, which draws nothing from inside it.
   */
  depth?: () => GPUTexture | undefined;
  /**
   * Draw the flame's coverage (its opacity along each pixel's ray) into the frame's shared reactive mask, which TAA reads
   * with no option, so the rising, puffing tongues stay crisp instead of smearing into a history they have no motion
   * vectors for. The glow, smooth added light, is left out. Default: on while TAA (or another reader of reactive masks)
   * runs, off otherwise; `true` draws it every frame, `false` never. Changeable between frames.
   */
  reactive?: boolean;
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
const UNIFORM_FLOATS = 48 + TABLE * 4 + 16;
/** Where the extra vec4 starts: x the frame's dither shift, y the crown spacing, z the glow radius (m), w the glow sources. */
const EXTRA = 48 + TABLE * 4;
/** The ground vec4: x, z slope in the footprint's axes, z the ground albedo, w the haze. */
const GROUND = EXTRA + 4;
/** The glow vec4: rgb the intensity of each glow source, w the height of the sources over the base. */
const GLOW = EXTRA + 8;
/** The outer (glow) box vec4: x its margin past the footprint, y its top, z, w the world slope. */
const OUTER = EXTRA + 12;
/** The flame pipelines of each device, by target format, depth format, samples, fog and depth. */
const PIPELINES = new WeakMap<GPUDevice, Map<string, GPURenderPipeline[]>>();
let nextId = 0;
/**
 * Flames attached to each engine so far. A flame's noise seed follows its place among its engine's flames, not among
 * every flame the process ever made: a scene rendered in a fresh process, or after another scene in the same one,
 * seeds its flames the same way, so a cut draws the flame a continuous run draws (GAP-FILM-TIME).
 */
const ATTACHED = new WeakMap<object, number>();

// `depth` picks the face of the box that marches (the far one over a scene depth); `clip` samples that scene depth to end
// the ray at it. The depth pass takes no clip: it writes the very depth a `depth()` option may hand back, which WebGPU
// refuses to sample in the same pass (KB-SCENES-TUNNELGPU1), and its depth test keeps what stands in front.
const shader = (samples: number, fogged: boolean, encode: boolean, depth: boolean, clip = depth): string => /* wgsl */ `
struct F {camera:mat4x4f,eye:vec4f,base:vec4f,shape:vec4f,turn:vec4f,motion:vec4f,look:vec4f,box:vec4f,forward:vec4f,ramp:array<vec4f,${TABLE}>,extra:vec4f,ground:vec4f,glow:vec4f,outer:vec4f}
@group(0) @binding(0) var<uniform> u:F;
${fogged ? fogWgsl(0, 5) : ''}
${clip ? softDepthWgsl(samples) : ''}
struct Out {@builtin(position) clip:vec4f,@location(0) world:vec3f}
// Local space: the footprint's axes, sheared by the lean and by the ground's slope, so y is the height over the ground
// plane through the base.
fn toWorld(p:vec3f)->vec3f {
  var s=vec3f(p.x+u.shape.z*p.y,p.y,p.z+u.shape.w*p.y);
  s.y+=u.ground.x*s.x+u.ground.y*s.z;
  return u.base.xyz+vec3f(u.turn.x*s.x+u.turn.y*s.z,s.y,-u.turn.y*s.x+u.turn.x*s.z);
}
fn toLocal(v:vec3f)->vec3f {
  var r=vec3f(u.turn.x*v.x-u.turn.y*v.z,v.y,u.turn.y*v.x+u.turn.x*v.z);
  r.y-=u.ground.x*r.x+u.ground.y*r.z;
  return vec3f(r.x-u.shape.z*r.y,r.y,r.z-u.shape.w*r.y);
}
fn corner(v:u32,margin:f32,top:f32)->Out {
  var corners=array<u32,36>(0u,2u,1u,1u,2u,3u,4u,5u,6u,5u,7u,6u,0u,1u,4u,1u,5u,4u,2u,6u,3u,3u,6u,7u,0u,4u,2u,2u,4u,6u,1u,3u,5u,3u,7u,5u);
  let k=corners[v];
  let c=vec3f(f32(k&1u),f32((k>>1u)&1u),f32((k>>2u)&1u));
  let w=toWorld(vec3f((c.x*2.0-1.0)*(u.shape.x+margin),mix(u.box.z,top,c.y),(c.z*2.0-1.0)*(u.shape.y+margin)));
  var o:Out;o.clip=u.camera*vec4f(w,1.0);o.world=w;return o;
}
// The flame's box, and the larger box of its glow.
@vertex fn vertex(@builtin(vertex_index) v:u32)->Out {return corner(v,u.box.x,u.box.y);}
@vertex fn glowVertex(@builtin(vertex_index) v:u32)->Out {return corner(v,u.outer.x,u.outer.y);}
${valueNoiseWgsl}
fn vnoise1(v:f32)->f32 {let i=floor(v);let f=v-i;let s=f*f*(3.0-2.0*f);let a=bitcast<u32>(i32(i));return mix(hash1(a),hash1(a+1u),s);}
fn fbm(p:vec3f)->f32 {return 0.5161*vnoise3(p)+0.2581*vnoise3(p*2.03+vec3f(17.1,3.7,9.2))+0.129*vnoise3(p*4.07+vec3f(5.3,11.9,2.1))+0.0645*vnoise3(p*8.11+vec3f(9.7,1.3,13.4))+0.0323*vnoise3(p*16.3+vec3f(3.1,7.7,5.9));}
fn table(x:f32)->vec3f {let t=clamp(x,0.0,1.0)*${TABLE - 1}.0;let i=u32(floor(t));let j=min(i+1u,${TABLE - 1}u);return mix(u.ramp[i].rgb,u.ramp[j].rgb,t-floor(t));}
// The flame zone at a local point q (metres over the base, before the lean): density and heat, each 0 to 1.
// The torching trees of a crown fire around q (one jittered tree a cell of the spacing), joined: x the strongest
// column value (the tree's tapering radius less the distance, over the spacing) and y that tree's height h (its flame
// reaches down into its crown by up to 0.3 flame lengths and tops out at 0.6 to 1.4 flame lengths).
fn trees(q:vec3f,h0:f32)->vec2f {
  let S=u.extra.y;let c=floor(q.xz/S);var best=vec2f(-9.0,h0);
  for(var j=-1;j<=1;j++){for(var i=-1;i<=1;i++){
    let id=vec2i(c)+vec2i(i,j);let at=(vec2f(id)+0.2+0.6*vec2f(hash3(vec3i(id,7)),hash3(vec3i(id,13))))*S;
    let h=(h0+0.3*hash3(vec3i(id,29)))/(0.6+0.8*hash3(vec3i(id,41)));
    let r=0.34*pow(clamp(1.0-h/${TOP.toFixed(2)},0.0,1.0),0.7)*smoothstep(-0.08,0.12,h);
    let v=2.6*(r-length(q.xz-at)/S);
    if(v>best.x){best=vec2f(v,h);}
  }}
  return best;
}
fn zone(q:vec3f)->vec2f {
  let L=u.base.w;var h=q.y/L;
  if(h<u.box.z/L||h>${BOX_TOP.toFixed(2)}){return vec2f(0.0);}
  let along=select(q.z,q.x,u.shape.x>=u.shape.y);
  // Tongues of varied height along a line of fire (Albini 1981): the local flame length swings 0.7 to 1.3 times the
  // mean along the line, drifting slowly, so the crest is ragged instead of one even edge (a crown fire's trees vary
  // on their own).
  h/=1.0+select(0.6,0.0,u.extra.y>0.0)*smoothstep(0.5*L,2.0*L,max(u.shape.x,u.shape.y))*(vnoise1(along/(0.8*L)+3.7*u.look.w+0.15*u.turn.z*u.eye.w)-0.5);
  // A crown fire: each tree's column starts down in its crown and tapers at its own height.
  var column=0.0;
  if(u.extra.y>0.0){
    let t=trees(q,h);column=t.x;h=max(t.y,0.0);
    if(column<-1.2){return vec2f(0.0);}
  }
  let puff=sin(6.2831853*(u.turn.z*u.eye.w-q.y/u.turn.w+vnoise1(along/u.look.z+u.look.w)));
  let taper=pow(clamp(1.0-h/${TOP.toFixed(2)},0.0,1.0),0.6);
  let narrow=min(u.shape.x,u.shape.y)+0.12*L;
  let ext=max(vec2f(u.shape.x,u.shape.y)+0.12*L-narrow*(1.0-taper)-0.2*L*smoothstep(0.0,1.3,h),vec2f(0.0));
  let d=abs(q.xz)-ext;
  var inner=-(length(max(d,vec2f(0.0)))+min(max(d.x,d.y),0.0))/(0.35*L+0.5*narrow);
  if(u.extra.y>0.0){inner=min(inner+0.6,column);}
  inner+=0.3*u.motion.z*puff*smoothstep(0.1,0.9,h);
  if(inner<-1.2){return vec2f(0.0);}
  let s=u.motion.y;let rise=u.motion.x*u.eye.w;
  let warp=vec3f(vnoise3(vec3f(q.x/s,(q.y-rise)/(2.2*s),q.z/s)+vec3f(31.7,0.0,7.3)),0.0,vnoise3(vec3f(q.x/s,(q.y-rise)/(2.2*s),q.z/s)+vec3f(2.9,0.0,43.1)))-vec3f(0.5,0.0,0.5);
  let p=vec3f(q.x/s+1.4*warp.x,(q.y-rise)/(2.6*s),q.z/s+1.4*warp.z);
  let n=fbm(p);
  let amp=mix(0.35,1.25,smoothstep(0.0,1.1,h));
  var v=inner+amp*(n-0.5)*2.0-0.55*smoothstep(0.45,1.55,h)+0.25;
  // Wisps: near the luminous surface, fine streaks drawn up with the flow (a quarter and an eighth of a tongue across,
  // three times taller) tear the edge into thin tongues instead of a soft rim; deep inside they change nothing.
  if(v>-0.35&&v<0.35){
    let w=vec3f(p.x*4.0+2.0*warp.x,p.y*1.4,p.z*4.0+2.0*warp.z);
    v+=(0.24*(vnoise3(w)-0.5)+0.14*(vnoise3(w*2.0+vec3f(7.3,1.1,3.9))-0.5))*2.0*smoothstep(0.0,0.6,h+0.2);
  }
  // A sharp luminous surface: the reaction zone of a diffusion flame is thin (Turns 2012, ch. 9), so the density
  // rises from nothing to full over a short step of the field.
  let density=smoothstep(0.0,0.03,v)*smoothstep(0.0,0.08,h+0.3*(n-0.5));
  // Hottest low in the flame, over the burning fuel (Butler et al. 2004): a hot base under cooler tips.
  let heat=clamp(2.0*v+0.3-0.7*h+0.25*(1.0-smoothstep(0.0,0.15,h)),0.0,1.0);
  return vec2f(density,heat);
}
fn encodeSrgb(c:vec3f)->vec3f {return select(1.055*pow(c,vec3f(1.0/2.4))-0.055,c*12.92,c<=vec3f(0.0031308));}
// Where a ray (local origin o, direction d) enters and leaves the box lo..hi.
fn boxHit(o:vec3f,d:vec3f,lo:vec3f,hi:vec3f)->vec2f {
  let inv=1.0/select(d,vec3f(1e-6),abs(d)<vec3f(1e-6));
  let ta=(lo-o)*inv;let tb=(hi-o)*inv;
  let tn=min(ta,tb);let tf=max(ta,tb);
  return vec2f(max(max(tn.x,tn.y),tn.z),min(min(tf.x,tf.y),tf.z));
}
// A pixel's ray: span x where it starts in the glow box, y where it ends (the box, the scene or the ground plane), z
// where it meets the ground plane (-1 if it does not), w 1 when this fragment marches the pixel.
struct Ray {o:vec3f,d:vec3f,rd:vec3f,span:vec4f}
fn rayOf(i:Out,margin:f32,top:f32,glow:bool)->Ray {
  var r:Ray;
  let ray=i.world-u.eye.xyz;let along=length(ray);r.rd=ray/along;
  r.o=toLocal(u.eye.xyz-u.base.xyz);r.d=toLocal(r.rd);
  let m=vec2f(u.shape.x,u.shape.y)+margin;
  let box=boxHit(r.o,r.d,vec3f(-m.x,u.box.z,-m.y),vec3f(m.x,top,m.y));
  let enter=box.x;let leave=box.y;
  // One fragment marches per pixel: the far face with the scene depth, the near face (depth-tested) without; the glow
  // also takes the far face when the camera stands inside its box (its depth is then the camera's, which passes).
  ${depth ? 'let mine=!(abs(along-leave)>abs(along-max(enter,0.0))&&enter>0.0);' : 'let mine=select(!(abs(along-enter)>abs(along-leave)||enter<0.0),abs(along-leave)<=abs(along-enter),glow&&enter<0.0);'}
  var end=leave;
  ${clip ? 'if(textureLoad(sceneDepth,vec2i(i.clip.xy),0)>0.0){end=min(end,softGap(i.clip,0.0)/max(dot(r.rd,u.forward.xyz),1e-4));}' : ''}
  // The ground plane ends the ray: the flame stands on it and its glow lights it. It is local y = 0 under a surface
  // fire; a crown fire's position is the canopy's base, so its ground lies 0.3 flame lengths below the box's bottom.
  var ground=-1.0;
  let floor=select(0.0,u.box.z+0.16*u.base.w,u.extra.y>0.0);
  if(r.d.y<0.0){let tg=(floor-r.o.y)/r.d.y;if(tg>max(enter,0.0)&&tg<end){end=tg;ground=tg;}}
  r.span=vec4f(max(enter,0.0),end,ground,select(0.0,1.0,mine&&end>max(enter,0.0)));
  return r;
}
// The flame along the ray from t0 to t1: emitted light, transmittance, the depth where it is half opaque (for fog) and,
// with stopAt above 0, the first depth where the transmittance falls below stopAt (-1 if it never does).
struct March {glow:vec3f,trans:f32,middle:f32,surface:f32}
fn march(o:vec3f,d:vec3f,t0:f32,t1:f32,pixel:vec2f,stopAt:f32)->March {
  var m:March;m.glow=vec3f(0.0);m.trans=1.0;m.middle=t0;m.surface=-1.0;
  // Steps no longer than STEP_LENGTH flame lengths (at least STEPS a ray), so a grazing ray shows no layers; the
  // march strides two steps through empty air and stops once the flame is opaque (MAX_STEPS at most).
  let dt=min((t1-t0)/${STEPS}.0,${STEP_LENGTH}*u.base.w);
  // Interleaved gradient noise, shifted every frame (Jimenez 2014): no fixed hatch, and frames averaged (motion blur
  // sub-frames, TAA) converge to the exact march.
  let px=pixel+${IGN_FRAME_SHIFT}*u.extra.x;let dither=fract(52.9829189*fract(0.06711056*px.x+0.00583715*px.y));
  var t=t0+dt*dither;
  let k=u.box.w/u.base.w;
  var last=t;var entered=false;
  for(var n=0;n<${MAX_STEPS};n++){
    if(t>t1){break;}
    var z=zone(o+d*t);
    // The first sample inside the flame: bisect back to the luminous surface, so where a ray meets the flame (and the
    // samples after it) does not hang on the dither, which drew a hatch over grazing views.
    if(z.x>0.0&&!entered){
      entered=true;var a0=last;var b0=t;
      for(var r=0;r<5;r++){let mid=0.5*(a0+b0);if(zone(o+d*mid).x>0.0){b0=mid;}else{a0=mid;}}
      t=b0;z=zone(o+d*t);
    }
    last=t;
    if(z.x>0.0){
      // Cool gas is thin: what does not glow mostly lets light through (soot absorbs where it is hot).
      let a=1.0-exp(-z.x*(0.2+0.8*z.y)*k*dt);
      m.glow+=m.trans*a*table(z.y);
      if(m.trans>0.5){m.middle=t;}
      m.trans*=1.0-a;
      if(stopAt>0.0&&m.trans<stopAt){m.surface=t;break;}
      if(m.trans<0.004){break;}
    }
    t+=select(dt,2.0*dt,z.x<=0.0);
  }
  return m;
}
// The flame's light scattered into the ray by the smoky air from ta to tb (Sun et al. 2005's closed form for a point
// source, with a kernel that falls to 0 at the glow radius), and the light it throws on the ground plane where the ray
// meets it at tg (Lambert), from glow sources along the footprint's long axis.
fn glowAt(e:vec3f,rd:vec3f,ta:f32,tb:f32,tg:f32)->vec3f {
  let n=i32(u.extra.w);
  if(n<=0||tb<=ta){return vec3f(0.0);}
  let L=u.base.w;let R=u.extra.z;let a2=0.0625*L*L;let kR=1.0/(R*R+a2);
  let long=u.shape.x>=u.shape.y;let span=1.6*max(u.shape.x,u.shape.y);
  let normal=normalize(vec3f(-u.outer.z,1.0,-u.outer.w));
  var air=0.0;var lit=0.0;
  for(var k=0;k<n;k++){
    let a=select(0.0,(f32(k)/f32(max(n-1,1))-0.5)*span,n>1);
    let s=toWorld(select(vec3f(0.0,u.glow.w,a),vec3f(a,u.glow.w,0.0),long));
    let es=s-e;let tc=dot(es,rd);let h2=max(dot(es,es)-tc*tc,0.0);
    let c2=R*R-h2;
    if(c2>0.0){
      let c=sqrt(c2);let x0=clamp(ta-tc,-c,c);let x1=clamp(tb-tc,-c,c);let b=sqrt(h2+a2);
      air+=max((atan(x1/b)-atan(x0/b))/b-(x1-x0)*kR,0.0);
    }
    if(tg>0.0){
      let sv=s-(e+rd*tg);let dd=dot(sv,sv);
      if(dd<R*R){lit+=max(dot(normal,sv),0.0)*inverseSqrt(max(dd,1e-6))*(1.0/(dd+a2)-kR);}
    }
  }
  return u.glow.rgb*(u.ground.w*0.07957747*air+u.ground.z*0.31830989*lit);
}
fn flame(i:Out)->vec4f {
  let r=rayOf(i,u.box.x,u.box.y,false);
  if(r.span.w<=0.0){discard;}
  let m=march(r.o,r.d,r.span.x,r.span.y,i.clip.xy,0.0);
  // Coverage through a steeper curve: a ray that grazes the luminous surface shows it, so tongues keep crisp edges.
  let alpha=(1.0-m.trans*m.trans)*u.motion.w;
  if(alpha<=0.0){discard;}
  // A camera's shoulder per channel: the hot core saturates toward the peak and reads yellow-white, never white.
  var c=u.look.x*(vec3f(1.0)-exp(-u.look.y*m.glow/(max(1.0-m.trans,1e-5)*u.look.x)));
  ${fogged ? 'c=mix(c,margoFog.color.rgb,fogAmount(u.eye.xyz+r.rd*m.middle));' : ''}
  ${encode ? 'c=encodeSrgb(max(c,vec3f(0.0)));' : ''}
  return vec4f(c*alpha,alpha);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {return flame(i);}
// The flame's coverage of TAA's reactive mask.
@fragment fn reactiveFragment(i:Out)->@location(0) vec4f {return vec4f(clamp(flame(i).a,0.0,1.0),0,0,1);}
// The glow, drawn before the flame over its larger box: added light, tested at the depth where the ray enters the box
// (the camera's when it stands inside), so a ridge or a wall in front of the fire hides it.
struct Glow {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn glowFragment(i:Out)->Glow {
  let r=rayOf(i,u.outer.x,u.outer.y,true);
  if(r.span.w<=0.0){discard;}
  var add=glowAt(u.eye.xyz,r.rd,r.span.x,r.span.y,r.span.z);
  ${fogged ? 'add*=1.0-fogAmount(u.eye.xyz+r.rd*r.span.y);' : ''}
  if(max(add.x,max(add.y,add.z))<=0.0){discard;}
  ${encode ? 'add=encodeSrgb(max(add,vec3f(0.0)));' : ''}
  var o:Glow;o.color=vec4f(add,0.0);o.depth=1.0;
  if(r.span.x>0.0){let p=u.camera*vec4f(u.eye.xyz+r.rd*r.span.x,1.0);o.depth=clamp(p.z/p.w,0.0,1.0);}
  return o;
}
// The depth pass: the flame's depth where it is opaque (its transmittance below DEPTH_AT), so particles behind it are
// hidden and those in front draw over it; elsewhere nothing is written.
struct Depth {@builtin(frag_depth) depth:f32}
@fragment fn depthFragment(i:Out)->Depth {
  let r=rayOf(i,u.box.x,u.box.y,false);
  if(r.span.w<=0.0||u.motion.w<1.0){discard;}
  let m=march(r.o,r.d,r.span.x,r.span.y,i.clip.xy,${DEPTH_AT});
  if(m.surface<0.0){discard;}
  let p=u.camera*vec4f(u.eye.xyz+r.rd*m.surface,1.0);
  var o:Depth;o.depth=clamp(p.z/p.w,0.0,1.0);return o;
}
`;

type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/**
 * A flame of any size, from a campfire to a house fire or a burning forest crown: one ray-marched volume over its
 * footprint, sized by a flame length, an intensity (Byram 1959) or a heat release (Heskestad 1983). Tall tapering
 * tongues rise at the buoyant speed and break up at the tip half the time at the flame length (Zukoski et al. 1985); the
 * zone puffs at 1.5 D^(-1/2) Hz (Cetegen and Ahmed 1993); the colour runs from the core's temperature to the edge's
 * through a camera's shoulder, so the core reads yellow-white and no pixel passes `peak` or turns white. With `lights`
 * the flame lights the ground, smoke and anything near with point lights that flicker with its puffing. Every option
 * is read each frame and written into one uniform, so a fire that grows, moves, leans or changes its look makes no GPU
 * object after its first frame; a length of 0 puts the flames out. `applyFlameSettings` takes it as a target (the flame
 * rows). WebGPU and the WebGL2 compatibility layer.
 * @throws TypeError for a missing position or size; RangeError for an option out of range.
 * A plugin of the scene it is attached to: disposing that scene disposes the flame.
 */
export class Flame implements EnginePlugin {
  readonly name: string;
  private readonly seed: number;
  /** Read every frame; see {@link FlameOptions}. */
  readonly options: FlameOptions;
  /** The light's points (empty without `lights`), their intensities as of the last frame. */
  readonly lights: readonly PointLight[];
  private engine?: Engine;
  private disposed = false;
  private clock = 0;
  private current = 0;
  private look: Record<string, unknown> | undefined;
  private readonly key: number[] = [];
  private readonly values = new Float32Array(UNIFORM_FLOATS);
  private readonly view = new Float32Array(16);
  private readonly heat = {
    position: [0, 0, 0] as [number, number, number],
    length: 0,
    footprint: [0, 0] as [number, number],
    yaw: 0,
    lean: [0, 0] as [number, number],
    time: 0,
  };
  private readonly fogData = new Float32Array(FOG_BYTES / 4);
  private readonly target?: Clustered | LightGroup;
  private readonly group?: LightGroup;
  private readonly steady: number[] = [];
  private coreFloor = 0;
  /** The scene depth's samples as of this view's colour pass. */
  private samples = 0;
  private uniform?: GPUBuffer;
  private fogBuffer?: GPUBuffer;
  private owned: { destroy(): void }[] = [];
  private softRuntime?: ReturnType<NonNullable<typeof soft>['create']>;
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup>();
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly reactiveAttachments: GPURenderPassColorAttachment[] = [];
  private constructor(options: FlameOptions, index: number) {
    this.name = 'vfx-flame:' + nextId++;
    this.seed = (index * 7.31) % 97;
    this.options = options;
    this.check();
    const lights = options.lights,
      groups = lights && 'names' in lights && 'clustered' in lights ? lights : undefined,
      clustered = groups ? groups.clustered : lights && 'maxLights' in lights ? lights : undefined;
    if (lights && !clustered)
      throw new TypeError('Invalid Flame lights; pass a Clustered from @margoengine/clustered or its LightGroups');
    const list: PointLight[] = [];
    if (clustered) {
      for (let i = 0; i < 4; i++)
        list.push({ position: [0, -1e6, 0], range: 1, intensity: 0, color: [1, 0.5, 0.2], radius: 0 });
      if (groups) {
        let name = 'flame';
        for (let n = 2; groups.names.includes(name); n++) name = `flame ${n}`;
        this.target = this.group = groups.group(name);
      } else this.target = clustered;
    }
    this.lights = list;
    this.write(true);
  }
  /** The flame length now, metres: `length`, else Byram's of `intensity`, else Heskestad's of `heat`. */
  private length(): number {
    const o = this.options;
    if (o.length !== undefined) return o.length;
    if (o.intensity !== undefined) return byramFlameLength(o.intensity);
    const [fx, fz] = o.footprint ?? [0, 0];
    return heskestadFlameLength(o.heat ?? 0, Math.sqrt((4 * fx * fz) / Math.PI));
  }
  private check(): void {
    const o = this.options;
    if (!o || typeof o !== 'object')
      throw new TypeError('Flame options must be an object with a position and a length, intensity or heat');
    finiteVector(o.position, 3, 'Flame position');
    if (o.length === undefined && o.intensity === undefined && o.heat === undefined)
      throw new TypeError('Flame needs a length (m), an intensity (kW/m) or a heat (W)');
    rampIn(this.length(), 'length', 0, 1000);
    if (o.footprint) {
      rampIn(o.footprint[0], 'footprint x', 0, 1e5);
      rampIn(o.footprint[1], 'footprint z', 0, 1e5);
    }
    rampIn(o.opacity ?? 1, 'opacity', 0, 1);
    rampIn(o.flicker ?? 1, 'flicker', 0, 3);
    rampIn(o.tongues ?? 1, 'tongues', 0.25, 4);
    rampIn(o.crowns ?? 0, 'crowns', 0, 1000);
    if (o.slope !== undefined) {
      finiteVector(o.slope, 2, 'Flame slope');
      rampIn(o.slope[0], 'slope x', -10, 10);
      rampIn(o.slope[1], 'slope z', -10, 10);
    }
    rampIn(o.glow ?? 1, 'glow', 0, 8);
    if (o.reactive !== undefined && typeof o.reactive !== 'boolean')
      throw new TypeError('Flame reactive must be true or false; pass a boolean');
    rampIn(o.haze ?? DEFAULT_HAZE, 'haze', 0, 1);
    rampIn(o.groundAlbedo ?? 0, 'groundAlbedo', 0, 1);
    rampIn(o.glowRadius ?? GLOW_RADIUS, 'glowRadius', 0.5, 10);
    rampIn(o.yaw ?? 0, 'yaw', -1e3, 1e3);
    rampIn(o.lightPower ?? 1, 'lightPower', 0, 1e6);
  }
  /** The look values now: the flame rows where `setFlameLook` set them, else the options. */
  private lookOf() {
    const o = this.options,
      look = this.look,
      lv = (name: string, fallback: number): number =>
        look && typeof look[name] === 'number' ? (look[name] as number) : fallback,
      edgeColor = (look?.['flames.edgeColor'] as readonly number[] | undefined) ?? [0.55, 0.12, 0.04];
    return {
      core: lv('flames.core', o.core ?? 2200),
      edge: lv('flames.edge', o.edge ?? 1000),
      peak: lv('flames.peak', o.peak ?? FLAME_PEAK),
      flicker: lv('flames.flicker', 1) * (o.flicker ?? 1),
      tongues: lv('flames.tongues', 1) * (o.tongues ?? 1),
      size: lv('flames.size', 1),
      radiance: lv('flames.radiance', 1),
      opacity: lv('flames.opacity', 1) * (o.opacity ?? 1),
      ramp: lv('flames.ramp', 0),
      glow: lv('flames.glow', 1) * (o.glow ?? 1),
      haze: lv('flames.haze', 1) * (o.haze ?? DEFAULT_HAZE),
      edgeColor,
    };
  }
  /** Rewrites the temperature table when a number it depends on changed (no allocation otherwise). */
  private write(force = false): void {
    const o = this.options,
      l = this.lookOf(),
      key = [
        l.core,
        l.edge,
        o.cooling ?? 1.2,
        o.exposure ?? 0.3,
        l.ramp,
        l.edgeColor[0]!,
        l.edgeColor[1]!,
        l.edgeColor[2]!,
      ];
    if (!force && key.every((v, i) => v === this.key[i])) return;
    for (let i = 0; i < key.length; i++) this.key[i] = key[i]!;
    const core = rampIn(l.core, 'core', 800, 3000),
      edge = rampIn(Math.min(l.edge, core), 'edge', 600, 3000),
      cooling = rampIn(o.cooling ?? 1.2, 'cooling', 0.2, 5),
      exposure = rampIn(o.exposure ?? 0.3, 'exposure', 0, 1),
      top = blackbodyXYZ(core)[1],
      u = this.values;
    this.coreFloor = Math.min(...blackbodyColor(core));
    for (let k = 0; k < TABLE; k++) {
      const x = k / (TABLE - 1),
        kelvin = edge + (core - edge) * x ** cooling,
        scale = Math.min(1, (blackbodyXYZ(kelvin)[1] / top) ** exposure),
        c = blackbodyColor(kelvin);
      for (let ch = 0; ch < 3; ch++)
        u[48 + k * 4 + ch] = c[ch]! * scale + (l.edgeColor[ch]! - c[ch]! * scale) * l.ramp * (1 - x);
      u[48 + k * 4 + 3] = 1;
    }
  }
  /**
   * Writes the flame rows that `applyFlameSettings` resolved (`flames.core`, `edge`, `peak`, `flicker`, `tongues`,
   * `size`, `radiance`, `opacity`, `ramp`, `edgeColor`); the flame keeps them while its length, footprint or wind change.
   * The ember rows do nothing here (a `Flame` has no embers).
   */
  setFlameLook(values: Readonly<Record<string, unknown>>): this {
    this.look = { ...values };
    this.write();
    return this;
  }
  /**
   * The brightest the flame shows in any channel, linear: its `peak` times its `radiance` as the look is now (the
   * camera shoulder holds every flame channel under it). A `Fire`'s embers take it as their own brightest radiance.
   */
  get peakRadiance(): number {
    const look = this.lookOf();
    return look.peak * look.radiance;
  }
  /**
   * The hot plume over the flame as of its last frame, for `HeatHaze` of `@margoengine/post/heat-haze` (the shimmer of
   * the scene behind the fire): the base, the length now, the footprint as drawn (`flames.size` included), the yaw, the
   * lean in the wind (world metres across per metre up) and the flame's clock, so a seeked flame shimmers as a played
   * one. One object, rewritten on each read.
   */
  get plume(): FlamePlume {
    const o = this.options,
      h = this.heat,
      u = this.values;
    h.position[0] = o.position[0];
    h.position[1] = o.position[1];
    h.position[2] = o.position[2];
    h.length = this.current;
    h.footprint[0] = 2 * u[24]!;
    h.footprint[1] = 2 * u[25]!;
    h.yaw = o.yaw ?? 0;
    h.time = this.clock;
    return h;
  }
  /** The length now, metres (0 when out). */
  get flameLength(): number {
    return this.current;
  }
  /** Seconds on the flame's clock: the sum of its frame deltas. */
  get time(): number {
    return this.clock;
  }
  /** The puffing frequency now, Hz: {@link puffingFrequency} of the footprint's {@link puffingDiameter}. */
  get puffing(): number {
    const length = this.length(),
      fp = this.options.footprint ?? [0.5 * length, 0.5 * length];
    return puffingFrequency(puffingDiameter(fp));
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':draw',
      // After the particles and clouds (order 6): the volume writes no depth, so a smoke puff drawn after it covered
      // the flame even from behind it, and only where a wall or the ground hid those puffs did the flame show, as a
      // hard-edged slab (KB-FLAME-SMOKEBOX1). Drawn after them, the flame covers what lies behind it.
      order: FLAME_ORDER,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c as Context, false);
      },
    });
    graph.add({
      name: this.name + ':depth',
      order: FLAME_DEPTH_ORDER,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c as Context, true);
      },
    });
  }
  /** The wind's lean of the flames, `[dx, dz]` per metre of height, at their rise speed `rise`. */
  private lean(rise: number, out: Float32Array, at: number): void {
    const o = this.options,
      wind = o.wind;
    let wx = 0,
      wz = 0;
    if (wind && typeof wind === 'object' && 'sample' in wind) {
      const v = wind.sample(o.position[0], o.position[1] + 0.5 * this.current, o.position[2], this.clock);
      wx = v[0] ?? 0;
      wz = v[2] ?? 0;
    } else if (wind) {
      wx = (wind as readonly number[])[0]!;
      wz = (wind as readonly number[])[1]!;
    }
    // A plume rising at w in a wind U leans atan(U / w); the lean is in world axes, the shader's shear in the footprint's.
    const c = Math.cos(o.yaw ?? 0),
      s = Math.sin(o.yaw ?? 0),
      lx = Math.max(-3, Math.min(3, wx / rise)),
      lz = Math.max(-3, Math.min(3, wz / rise));
    this.heat.lean[0] = lx;
    this.heat.lean[1] = lz;
    out[at] = c * lx - s * lz;
    out[at + 1] = s * lx + c * lz;
  }
  /**
   * Moves the flame's clock by `delta` seconds (0 or less moves nothing): the CPU part of its frame update, which a
   * seek from `@margoengine/cutscene/seek` replays. Everything a frame then draws (the puffing, the flicker of the light,
   * the dither shift, the wind it samples) is worked from this clock, so a flame seeked to T draws what a continuous run
   * draws at T (GAP-FILM-TIME).
   */
  advanceTime(delta: number): void {
    if (this.disposed) return;
    this.clock += delta > 0 ? delta : 0;
  }
  /**
   * Back to time 0, as a fresh flame with the same options (GAP-FILM-RESET): the puffing, the light's flicker and the
   * dither start again, so the same frames after it draw what a fresh flame draws.
   */
  resetTime(): void {
    this.clock = this.current = 0;
  }
  onPreUpdate(delta: number): void {
    if (this.disposed) return;
    this.advanceTime(delta);
    this.check();
    this.write();
    const o = this.options,
      length = this.length(),
      l = this.lookOf(),
      fp = o.footprint ?? [0.5 * length, 0.5 * length],
      u = this.values;
    this.current = length;
    rampIn(l.peak, 'peak', 1e-6, 1000);
    const L = Math.max(length, 1e-3),
      rise = FLAME_FROUDE * Math.sqrt(G * L),
      diameter = puffingDiameter(fp),
      f = puffingFrequency(diameter),
      yaw = o.yaw ?? 0;
    u[16 + 3] = this.clock;
    u[20] = o.position[0];
    u[21] = length > 0 ? o.position[1] : -1e6;
    u[22] = o.position[2];
    u[23] = L;
    u[24] = (fp[0] / 2) * l.size;
    u[25] = (fp[1] / 2) * l.size;
    this.lean(rise, u, 26);
    u[28] = Math.cos(yaw);
    u[29] = Math.sin(yaw);
    u[30] = f;
    // The puffs rise with the flow: one wavelength is what the flow climbs in a period.
    u[31] = rise / f;
    u[32] = rise;
    u[33] = 0.22 * L * l.tongues;
    u[34] = l.flicker;
    u[35] = clamp01(l.opacity);
    u[36] = l.peak;
    // However bright the rows ask for, the core's weakest channel stays under 1 - e^(-2) of the peak, so no pixel turns
    // white: the hue of the hottest gas survives.
    u[37] = Math.min(GAIN * l.radiance, 2 / Math.max(this.coreFloor, 1e-3));
    u[38] = diameter;
    u[39] = this.seed;
    u[40] = 0.2 * L + 0.3 * Math.min(fp[0], fp[1]);
    u[41] = BOX_TOP * L;
    u[42] = (o.crowns ? -0.46 : -0.16) * L;
    u[43] = length > 0 ? EXTINCTION : 0;
    // The dither's shift follows the flame's clock (a 240 Hz count, wrapped so float32 keeps it exact): each new frame
    // or motion-blur sub-frame moves it, and a frame drawn again at the same time draws the same picture.
    u[EXTRA] = Math.floor(this.clock * 240) % 4096;
    u[EXTRA + 1] = o.crowns ?? 0;
    this.glow(L, fp, l, rise, u);
    this.light(L, fp, f, diameter, l.flicker, u[39]!);
  }
  /**
   * The ground plane and the glow: the slope in the footprint's axes, the glow sources' intensity (the light's total, as
   * {@link FLAME_LIGHT_FILL}, over as many sources as its points), the haze and the glow box around the flame box.
   */
  private glow(
    L: number,
    fp: readonly [number, number],
    l: ReturnType<Flame['lookOf']>,
    rise: number,
    u: Float32Array,
  ): void {
    const o = this.options,
      c = Math.cos(o.yaw ?? 0),
      s = Math.sin(o.yaw ?? 0),
      gx = o.slope?.[0] ?? 0,
      gz = o.slope?.[1] ?? 0,
      // The footprint's x axis is (c, -s) in world x, z and its z axis (s, c).
      sx = gx * c - gz * s,
      sz = gx * s + gz * c,
      n = Math.min(GLOW_SOURCES, Math.max(1, Math.round(Math.max(fp[0], fp[1]) / L))),
      on = this.current > 0 && l.glow > 0,
      total = on
        ? FLAME_LIGHT_FILL * l.peak * l.radiance * l.glow * L * (0.5 * (fp[0] + fp[1]) + 0.24 * L) * (o.lightPower ?? 1)
        : 0,
      colour = blackbodyColor(Math.max(1000, Math.min(l.core * 0.8, 3000))),
      R = (o.glowRadius ?? GLOW_RADIUS) * L,
      lean = Math.max(Math.abs(u[26]!), Math.abs(u[27]!)),
      tilt = Math.max(Math.abs(sx), Math.abs(sz)),
      albedo = o.groundAlbedo ?? (o.lights ? 0 : GROUND_ALBEDO);
    u[EXTRA + 2] = R;
    u[EXTRA + 3] = on ? n : 0;
    u[GROUND] = sx;
    u[GROUND + 1] = sz;
    u[GROUND + 2] = albedo;
    u[GROUND + 3] = l.haze;
    for (let i = 0; i < 3; i++) u[GLOW + i] = (total / n) * colour[i]!;
    u[GLOW + 3] = 0.35 * L;
    // The glow box holds the sphere of the glow radius around each source, through the lean and the slope's shear.
    u[OUTER] = on ? Math.max(u[40]!, R * (1 + tilt + lean)) : u[40]!;
    u[OUTER + 1] = on ? Math.max(u[41]!, 0.35 * L + R * (1 + tilt)) : u[41]!;
    u[OUTER + 2] = gx;
    u[OUTER + 3] = gz;
    void rise;
  }
  /** Places the light's points over the footprint and sets each one's flicker from the puffing of the tongues above it. */
  private light(
    L: number,
    fp: readonly [number, number],
    f: number,
    diameter: number,
    flicker: number,
    seed: number,
  ): void {
    if (!this.target || this.target.isDisposed) return;
    const o = this.options,
      lights = this.lights as PointLight[],
      longX = fp[0] >= fp[1],
      span = longX ? fp[0] : fp[1],
      n = Math.min(4, Math.max(1, Math.round(span / Math.max(L, 1e-3)))),
      on = this.current > 0,
      look = this.lookOf(),
      total = on
        ? FLAME_LIGHT_FILL * look.peak * look.radiance * L * (0.5 * (fp[0] + fp[1]) + 0.24 * L) * (o.lightPower ?? 1)
        : 0,
      c = Math.cos(o.yaw ?? 0),
      s = Math.sin(o.yaw ?? 0),
      colour = blackbodyColor(Math.max(1000, Math.min(look.core * 0.8, 3000)));
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i]!,
        along = n > 1 ? (i / (n - 1) - 0.5) * span * 0.8 : 0,
        lx = longX ? along : 0,
        lz = longX ? 0 : along,
        phase =
          6.2831853 *
          (f * this.clock - (0.35 * L) / ((FLAME_FROUDE * Math.sqrt(G * L)) / f) + vnoise1(along / diameter + seed)),
        // The visible area, and with it the light, swells and shrinks with the puff above the point.
        wave = Math.max(
          0.15,
          1 + flicker * (0.3 * Math.sin(phase) + 0.25 * (vnoise1(this.clock * f * 2.7 + i * 5.1 + seed) - 0.5)),
        ),
        p = light.position as unknown as number[];
      p[0] = o.position[0] + c * lx + s * lz;
      p[1] = o.position[1] + 0.35 * L;
      p[2] = o.position[2] - s * lx + c * lz;
      light.range = 30 * L;
      light.radius = 0.25 * Math.min(L, Math.max(fp[0], fp[1]) / n + 0.2 * L);
      light.intensity = i < n ? (total / n) * wave : 0;
      light.color = colour;
      this.steady[i] = i < n ? total / n : 0;
    }
    this.target.setLights(lights);
  }
  private draw(c: Context, depthPass: boolean): void {
    if (this.disposed) return;
    const device = c.device,
      o = this.options,
      u = this.values,
      v = viewMatrix(this.view, c.camera);
    // The depth pass draws with what the colour pass of this view wrote: no buffer writes of its own.
    if (!depthPass) {
      u.set(c.camera.matrix);
      for (let i = 0; i < 3; i++) {
        u[16 + i] = c.camera.position[i]!;
        u[44 + i] = -v[i * 4 + 2]!;
      }
      this.uniform ??= device.createBuffer({
        size: UNIFORM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.uniform, 0, u as Float32Array<ArrayBuffer>);
    }
    if (!this.uniform) return;
    const fog = checkFog(o.fog ?? null),
      encode = !c.format.includes('float') && !c.format.endsWith('-srgb');
    if (fog && !depthPass) {
      writeFog(fog, c.camera.position, this.fogData);
      this.fogBuffer ??= device.createBuffer({
        size: FOG_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.fogBuffer, 0, this.fogData as Float32Array<ArrayBuffer>);
    }
    let samples = 0;
    const depth = o.depth;
    if (depth) {
      this.softRuntime ??= soft.create(device, this.owned);
      if (depthPass) samples = this.samples;
      else {
        samples = this.samples = this.softRuntime.write(c as never, depth(), v, 1);
        if (this.softRuntime.changed) this.groups.clear();
      }
    }
    const multisample = c.descriptor.multisample?.count ?? 1,
      depthFormat = c.descriptor.depthStencil!.format,
      key = [c.format, depthFormat, multisample, samples, !!fog, !!depth].join(':');
    // The pipelines (glow, flame, depth) per device and target for every flame, made on the first frame (lit or not), so
    // flames that light up later make no GPU object.
    let shared = PIPELINES.get(device);
    if (!shared) PIPELINES.set(device, (shared = new Map()));
    let set = shared.get(key);
    if (!set) {
      const module = device.createShaderModule({ code: shader(samples, !!fog, encode, !!depth) }),
        // The depth pass's own: over a scene depth it must not sample it (it writes the depth).
        written = depth ? device.createShaderModule({ code: shader(samples, !!fog, encode, true, false) }) : module,
        // Premultiplied over (Porter and Duff 1984): the flame covers what is behind it by its opacity; the glow (alpha 0) adds.
        blend: GPUBlendState = {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
        make = (
          vertex: string,
          fragment: string,
          target: GPUColorTargetState,
          depthStencil: Omit<GPUDepthStencilState, 'format'>,
          code = module,
        ) =>
          device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: code, entryPoint: vertex },
            fragment: { module: code, entryPoint: fragment, targets: [target] },
            primitive: { topology: 'triangle-list' },
            multisample: c.descriptor.multisample,
            depthStencil: { format: depthFormat, ...depthStencil },
          });
      set = [
        // The glow tests the depth where its ray enters the box (frag_depth), so it is hidden behind what stands in front.
        make(
          'glowVertex',
          'glowFragment',
          { format: c.format, blend },
          { depthWriteEnabled: false, depthCompare: 'greater-equal' },
        ),
        make(
          'vertex',
          'fragment',
          { format: c.format, blend },
          { depthWriteEnabled: false, depthCompare: depth ? 'always' : 'greater-equal' },
        ),
        // The depth pass writes no colour; its own (frag_depth) depth is tested against the scene and the nearer kept.
        make(
          'vertex',
          'depthFragment',
          { format: c.format, writeMask: 0 },
          { depthWriteEnabled: true, depthCompare: 'greater-equal' },
          written,
        ),
        // The coverage into the reactive mask, tested as the flame is; the most over a pixel is kept.
        make(
          'vertex',
          'reactiveFragment',
          { format: 'r8unorm', blend: reactiveBlend },
          { depthWriteEnabled: false, depthCompare: depth ? 'always' : 'greater-equal' },
        ),
      ];
      shared.set(key, set);
    }
    const pipelines = depthPass ? [set[2]!] : u[EXTRA + 3]! > 0 ? [set[0]!, set[1]!] : [set[1]!];
    for (const pipeline of set)
      if (!this.groups.has(pipeline))
        this.groups.set(
          pipeline,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            // The depth pass reads the uniform alone: no fog, no scene depth.
            entries: [
              { binding: 0, resource: { buffer: this.uniform } },
              ...(fog && pipeline !== set[2] ? [{ binding: 5, resource: { buffer: this.fogBuffer! } }] : []),
              ...(samples && pipeline !== set[2] ? this.softRuntime!.entries : []),
            ],
          }),
        );
    // The depth pass draws only a fully opaque flame (a faded one hides nothing); its pipeline is made on the first frame all the same.
    if (!(this.current > 0) || (depthPass && !((this.options.opacity ?? 1) >= 1 && this.lookOf().opacity >= 1))) return;
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    this.depthAttachment.depthReadOnly = depthPass ? undefined : true;
    if (depthPass) {
      this.depthAttachment.depthLoadOp = 'load';
      this.depthAttachment.depthStoreOp = 'store';
    } else {
      delete this.depthAttachment.depthLoadOp;
      delete this.depthAttachment.depthStoreOp;
    }
    this.depthAttachment.stencilReadOnly = depthFormat.includes('stencil') ? true : undefined;
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [this.attachment],
      depthStencilAttachment: this.depthAttachment,
    });
    applyView(pass, c);
    for (const pipeline of pipelines) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.groups.get(pipeline)!);
      pass.draw(36);
      if (this.engine) this.engine.stats.drawCalls++;
    }
    pass.end();
    if (depthPass || !(o.reactive ?? reactiveMaskWanted(c, this))) return;
    this.reactiveAttachments[0] = reactiveTarget(c);
    const mask = c.encoder.beginRenderPass({
      colorAttachments: this.reactiveAttachments,
      depthStencilAttachment: this.depthAttachment,
    });
    applyView(mask, c);
    mask.setPipeline(set[3]!);
    mask.setBindGroup(0, this.groups.get(set[3]!)!);
    mask.draw(36);
    mask.end();
    if (this.engine) this.engine.stats.drawCalls++;
  }
  /** Sets the flame length, metres (see {@link FlameOptions.length}); the volume answers from the next frame. */
  setLength(length: number): this {
    rampIn(length, 'length', 0, 1000);
    this.options.length = length;
    return this;
  }
  /** Sets the wind at the flames (see {@link FlameOptions.wind}); undefined removes it. */
  setWind(wind: VFXWind | undefined): this {
    this.options.wind = wind;
    return this;
  }
  /** The light's points at their steady intensities (the mean the flicker swings about), as of the last frame. */
  get steadyIntensities(): readonly number[] {
    return this.steady;
  }
  /** Flames at `options.position`; see {@link FlameOptions}. */
  static attach(engine: EngineKernel, options: FlameOptions): Flame {
    // The volume draws on WebGPU (and the WebGL2 compatibility layer) only: the small WebGL2 preview is refused here,
    // before a light group is made or the plugin attached, so it never attaches and then silently draws no flames.
    requireWebGPU(engine, 'Flame');
    const index = ATTACHED.get(engine) ?? 0,
      flame = new Flame(options, index);
    engine.use(flame);
    ATTACHED.set(engine, index + 1);
    return flame;
  }
  private release(): void {
    for (const resource of [this.uniform, this.fogBuffer, ...this.owned]) resource?.destroy();
    this.uniform = this.fogBuffer = this.softRuntime = undefined;
    this.owned = [];
    this.groups.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** Removes the flames and their light (a group the flame made goes with it). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    // A group goes with the flame (its dispose never throws, whichever of it and its Clustered went first).
    if (this.group) this.group.dispose();
    else if (this.target && !this.target.isDisposed) this.target.setLights([]);
    this.release();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** The embers of a hearth kit scaled to a fire of flame length `length` over `footprint` (for `Fire.attach({flameLength})`). */
export function scaleHearthEmbers<T extends Record<string, unknown>>(
  embers: T,
  length: number,
  footprint: readonly [number, number],
): T {
  const root = Math.sqrt(Math.max(length / HEARTH_FLAME_LENGTH, 1)),
    e = structuredClone(embers) as Record<string, unknown> & {
      size: number;
      rate: number;
      capacity: number;
      lifetime: [number, number];
      velocity: [number, number, number];
      gravity: [number, number, number];
      turbulence: number;
      frequency: number;
    };
  // Embers of a big fire are fewer and larger (the roadmap's look): their size, speed and life follow sqrt(L).
  e.size *= root;
  e.rate *= root;
  e.capacity = Math.ceil(e.capacity * root);
  e.lifetime = [e.lifetime[0] * root, e.lifetime[1] * root];
  e.velocity = e.velocity.map((v) => v * root) as [number, number, number];
  e.gravity = e.gravity.map((v) => v * root) as [number, number, number];
  e.turbulence *= root;
  e.frequency /= root;
  return {
    ...e,
    emissionExtent: [footprint[0] / 2, 0.02 * length, footprint[1] / 2],
    schedule: { prewarm: e.lifetime[1] },
  } as unknown as T;
}
