/// <reference lib="esnext.disposable" preserve="true" />
// Lava: a flow that runs down the ground from its vent, cools and grows a crust with glowing cracks, stops when it has
// cooled too far, ponded or lost its supply; a Hawaiian fountain of glowing clots over the vent; Strombolian bombs on
// ballistic paths; and the glow as colour, radiance and point lights. Deterministic over film time: every output is a
// function of the film time and the options alone (no stepping state, no randomness but hashed). Sources (papers and
// standards, read as text; no code; docs/clean-room.md "Lava flows and bombs"):
// - R. W. Griffiths, "The dynamics of lava flows", Annu. Rev. Fluid Mech. 32, 477-518, 2000,
//   https://doi.org/10.1146/annurev.fluid.32.1.477: lava as a viscous, yield-strength fluid whose flow is set by the
//   slope, the supply and the cooling of its surface; channels and levees, crusts that cover the surface and break into
//   plates with hot cracks between them, flows that stop when they cool.
// - H. Jeffreys, "The flow of water in an inclined channel of rectangular section", Phil. Mag. 49, 793-807, 1925,
//   https://doi.org/10.1080/14786442508634662: the mean speed of a laminar sheet on a slope, u = rho g h^2 sin(theta) /
//   (3 eta).
// - G. Hulme, "The interpretation of lava flow morphology", Geophys. J. R. Astr. Soc. 39, 361-383, 1974,
//   https://doi.org/10.1111/j.1365-246X.1974.tb05460.x: lava as a Bingham fluid, the plug thickness tau / (rho g
//   sin(theta)) below which it cannot flow, and the Bingham correction 1 - 3/2 (h_y / h) + 1/2 (h_y / h)^3 of the mean speed.
// - M. Dragoni, "A dynamical model of lava flows cooling by radiation", Bull. Volcanol. 51, 88-95, 1989,
//   https://doi.org/10.1007/BF01081978 (abstract): viscosity and yield strength rising exponentially as the lava cools,
//   eta = eta_v exp(b (T_v - T)) and tau = tau_0 (exp(c (T_v - T)) - 1); b 0.04 and c 0.08 per kelvin as later works
//   quote them (sliders).
// - A. Harris and S. Rowland, "FLOWGO: a kinematic thermo-rheological model for lava flowing in a channel", Bull.
//   Volcanol. 63, 20-44, 2001, https://doi.org/10.1007/s004450000120: the core's heat budget down the channel,
//   radiation and forced convection (C_H 0.0036) from a crusted surface with a hot crack share, the latent heat of
//   crystallisation, the step-by-step cooling and slowing.
// - J. Crisp and S. Baloga, "A model for heat transport in an active lava flow", J. Geophys. Res. 95(B2), 1255-1270,
//   1990, https://doi.org/10.1029/JB095iB02p01255: the surface as two thermal components, a crust and a share of hot
//   cracks near the core's temperature.
// - H. Pinkerton and L. Wilson, "Factors controlling the lengths of channel-fed lava flows", Bull. Volcanol. 56,
//   108-120, 1994, https://doi.org/10.1007/BF00304106 (abstract, and the Graetz rule as cited by Wilson, Pinkerton, Head
//   and Roberts 1993): a cooling-limited flow stops where its Graetz number Gz = Q d_e / (kappa w x) falls to about 300.
// - K. Hon, J. Kauahikaua, R. Denlinger and K. Mackay, "Emplacement and inflation of pahoehoe sheet flows", GSA
//   Bulletin 106, 351-370, 1994, https://doi.org/10.1130/0016-7606(1994)106<0351:EAIOPS>2.3.CO;2: the crust (to the
//   1,070 C isotherm) thickens as 0.0779 sqrt(t) metres, t in hours; the bound the crust model is checked against.
// - D. L. Turcotte and G. Schubert, "Geodynamics", 2nd ed., Cambridge, 2002, section 4-17 (solidification of a lava
//   lake): the Stefan problem the crust solver must meet with a fixed surface temperature.
// - L. Keszthelyi and R. Denlinger, "The initial cooling of pahoehoe flow lobes", Bull. Volcanol. 58, 5-18, 1996,
//   https://doi.org/10.1007/s004450050121: the surface cooling within seconds to minutes by radiation and convection,
//   computed here by conduction under a radiating, convecting surface.
// - H. E. Huppert, "The propagation of two-dimensional and axisymmetric viscous gravity currents over a rigid horizontal
//   surface", J. Fluid Mech. 121, 43-58, 1982, https://doi.org/10.1017/S0022112082001797: a pond fed at a steady flux
//   spreads as R = 0.715 (g Q^3 / (3 nu))^(1/8) t^(1/2).
// - M. Favalli, M. T. Pareschi, A. Neri and I. Isola, "Forecasting lava flow paths by a stochastic approach",
//   Geophys. Res. Lett. 32, L03305, 2005, https://doi.org/10.1029/2004GL021718: the path of steepest descent over the
//   ground, the ground's heights jittered by a small amount so a flow is not locked to the grid.
// - L. Wilson and J. W. Head, "Ascent and eruption of basaltic magma on the Earth and Moon", J. Geophys. Res. 86(B4),
//   2971-3001, 1981, https://doi.org/10.1029/JB086iB04p02971: a Hawaiian fountain's height is U^2 / (2 g) for its
//   exit speed U.
// - L. G. Mastin, "A simple calculator of ballistic trajectories for blocks ejected during volcanic eruptions", USGS
//   Open-File Report 01-45, 2001, https://pubs.usgs.gov/of/2001/0045/: blocks on ballistic paths through air that
//   thins with height, slowed by drag F = 1/2 rho_air Cd A v^2 relative to the wind (Cd about 0.6 to 1).
// - International Civil Aviation Organization, Manual of the ICAO Standard Atmosphere, Doc 7488, 1993: air density
//   through the troposphere.
// - M. Planck's law and the CIE 1931 2-degree observer, through the analytic fits of C. Wyman, P.-P. Sloan and
//   P. Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching Functions", JCGT 2(2), 1-11, 2013,
//   http://jcgt.org/published/0002/02/01/: the colour and luminance of glowing lava at any temperature (683 lm/W);
//   IEC 61966-2-1 (sRGB) for the XYZ to linear sRGB matrix.
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { displayShader } from '../../shared/display.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { unitLight } from '../../shared/unit-light.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { applyView } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { readonly STORAGE: number; readonly UNIFORM: number; readonly COPY_DST: number };

const G = 9.80665;
const SIGMA = 5.670374419e-8;
const H_PLANCK = 6.62607015e-34;
const C_LIGHT = 299792458;
const K_BOLTZ = 1.380649e-23;
/** Luminance (cd/m^2) of a white diffuse surface under a 100,000 lux sun: the engine's radiance 1. */
export const SUN_LUMINANCE = 100000 / Math.PI;
const AIR_HEAT = 1005;

/** What a flow follows down: a height function, or an object with `height(x, z)` (a `TerrainQuery` fits). */
export type LavaGround = ((x: number, z: number) => number) | { height(x: number, z: number): number | undefined };

/** What the lava follows: a `WeatherMachine` (its wind bends the fountain and carries clots and bombs). */
export interface LavaWeather {
  readonly state: { readonly wind: number; readonly windDirection: number };
}

/** A point light as `Clustered.setLights` or a `LightGroup` takes it. */
export interface LavaLight {
  position: [number, number, number];
  color: [number, number, number];
  intensity: number;
  range: number;
  decay: number;
}

/** What {@link LavaFlow.update} gives its glow lights to each frame: a `LightGroup` of `@margoengine/clustered/groups` fits. */
export interface LavaLightTarget {
  setLights(lights: readonly LavaLight[]): unknown;
}

/** What {@link LavaFlow.drawClots} and {@link LavaFlow.drawBombs} draw into: a gltf `PBRInstances` fits (mesh.instances). */
export interface LavaInstanceTarget {
  readonly capacity: number;
  count: number;
  setMatrixAt(i: number, m: ArrayLike<number>): unknown;
  setColorAt(i: number, color: ArrayLike<number>): unknown;
}

/** Options of {@link LavaFlow}. Every field has a documented default; `validateLava` checks the ranges. */
export interface LavaOptions {
  /** World place of the vent, [x, y, z] metres. Default [0, 0, 0]. */
  vent?: readonly [number, number, number];
  /** The ground the flow runs down. Default flat at the vent's height (the lava ponds). */
  ground?: LavaGround;
  /** Film second the vent opens. Default 0. */
  start?: number;
  /** Seconds to reach the full effusion rate, 1 to 86,400. Default 60. */
  rise?: number;
  /** Seconds at the full rate, 0 to 1e7. Default 3,600. */
  duration?: number;
  /** Seconds the supply takes to stop, 1 to 86,400. Default 300. */
  wane?: number;
  /** Lava supplied at the full rate, m^3/s, 0.1 to 10,000. Default 20. */
  effusionRate?: number;
  /** Lava temperature at the vent, kelvin, 1,000 to 1,600. Default 1,423 (1,150 C, Hawaiian basalt). */
  temperature?: number;
  /** Temperature of the crust's base (Hon et al. 1994's 1,070 C), kelvin, 900 to 1,500. Default 1,343. */
  crustTemperature?: number;
  /** Solidus: below it the lava has given up its latent heat, kelvin, 800 to 1,500. Default 1,253 (980 C). */
  solidus?: number;
  /** Air temperature, kelvin, 220 to 330. Default 288. */
  airTemperature?: number;
  /** Lava density, kg/m^3, 500 to 3,200. Default 2,600. */
  density?: number;
  /** Specific heat, J/(kg K), 500 to 2,000. Default 1,150. */
  heatCapacity?: number;
  /** Thermal conductivity, W/(m K), 0.1 to 5. Default 1.5. */
  conductivity?: number;
  /** Latent heat of crystallisation, J/kg, 0 to 1e6. Default 350,000. */
  latentHeat?: number;
  /** Crystals grown per kelvin of cooling in the channel, 0 to 0.02 (Harris and Rowland 2001). Default 0.003. */
  crystallisation?: number;
  /** Surface emissivity, 0.5 to 1. Default 0.95. */
  emissivity?: number;
  /** Viscosity at the vent, Pa s, 1 to 1e9. Default 300. */
  viscosity?: number;
  /** Viscosity rise per kelvin of cooling, b in eta_v exp(b dT), 0 to 0.2. Default 0.04 (Dragoni 1989). */
  viscosityRise?: number;
  /** Yield strength scale tau_0, Pa, 0 to 1e4: tau = tau_0 (exp(c dT) - 1). Default 0.01 (Dragoni 1989). */
  yieldStrength?: number;
  /** Yield strength rise per kelvin of cooling, c, 0 to 0.2. Default 0.08 (Dragoni 1989). */
  yieldRise?: number;
  /** Channel width, metres, 0.5 to 2,000. Default 12. */
  width?: number;
  /** Graetz number at which a cooling-limited flow stops, 10 to 3,000. Default 300 (Pinkerton and Wilson 1994). */
  stopGraetz?: number;
  /** Seconds a fresh surface takes to close its crust over to the crack share, 1 to 3,600. Default 60. */
  crackTime?: number;
  /** Least share of the surface left as hot cracks under a closed, moving crust, 0 to 1 (Crisp and Baloga 1990). Default 0.05. */
  crackShare?: number;
  /**
   * Crust broken open by speed: the crust covers (1 - crackShare) 0.9 exp(-crackSpeed u) of a surface moving at u m/s
   * (Harris and Rowland 2001, eq. 8, fitted at Kilauea and Mauna Loa), per m/s, 0 (speed opens nothing) to 2. Default 0.16.
   */
  crackSpeed?: number;
  /** Kelvin the hottest exposed lava is below the core (Harris and Rowland 2001, eq. 9: 0 to 140), 0 to 300. Default 120. */
  hotOffset?: number;
  /** Temperature of the base of the basal crust, kelvin (Harris and Rowland 2001: 700 C), 300 to 1,400. Default 973. */
  baseTemperature?: number;
  /** Basal crust thickness as a share of the sheet's (Harris and Rowland 2001: 10 percent), 0.01 to 0.5. Default 0.1. */
  baseCrust?: number;
  /**
   * Widest the channel grows, metres, 0.5 to 20,000. The sheet keeps its depth at the vent and widens as it slows
   * (mass conservation, Harris and Rowland 2001 eq. 1), so it spreads on flats and narrows on steeps; at this width it
   * thickens instead. Set it to `width` for a channel of one width. Default 1,000.
   */
  maxWidth?: number;
  /**
   * Highest levee over the sheet, as a share of its thickness, 0 (none) to 1 (as high again as the sheet). The levee
   * rises behind the front to Hulme's (1974) h_c = tau / (rho g sin) at the yield strength of its cooling crust, up to
   * this share. Default 0.35.
   */
  leveeMax?: number;
  /**
   * How steep a second line of descent must be to split the flow, as a share of the steepest's drop, 0 to 1 (1: never).
   * It must also lie 45 degrees or more off the steepest, past a divide (Dietterich and Cashman 2014). Default 0.7.
   */
  branchShare?: number;
  /** Most splits of one flow, 0 (a single channel) to 64. Default 8. */
  maxBranches?: number;
  /**
   * How close two arms must come to run together, as a share of their half-widths summed, 0 (never) to 4: an arm that
   * reaches another (once it has been clear of it) ends there and the other carries both on (Dietterich and Cashman
   * 2014). Default 1 (their edges touch).
   */
  joinDistance?: number;
  /**
   * Inflation, metres, at which a stalled front's flow breaks out through a levee (or a roof, where it has roofed), 0
   * (never) to 20. A front that cooled to a stop while still fed inflates: the supply lifts the crust over the
   * sluggish stretch behind it (Graetz under twice `stopGraetz`) by Q t / area (Hon et al. 1994; Hoblitt et al. 2012),
   * and at this height it ruptures where the ground just outside the levee lies lowest, sending all the lava down a new
   * arm from there with a fresh surface, unless the tube behind the front feeds it on first. Default 0.
   */
  breakoutHeight?: number;
  /**
   * Tensile strength of a tube's roof, Pa, 1e4 to 1e7. With breakouts on (`breakoutHeight` over 0), a stalled front blocks
   * the outflow of the tube behind it: the supply backs up the tube, filling the head room over its stream (Kauahikaua
   * et al. 1998), and the roof gives way where the lava's head over it first beats its weight and its strength as a
   * beam clamped at the levees, rho g d + 2 sigma d^2 / w^2 for a roof d thick over a w wide tube (Turcotte and
   * Schubert 2002, chapter 3), d the crust grown since the front passed. Default 1e6 (1 MPa: the low end of the
   * 0.5 to 9 MPa in-situ tensile strengths Gudmundsson gives, the roof being hot; tumuli rupture at 0.2 to 1 MPa,
   * Rossi and Gudmundsson 1996).
   */
  roofStrength?: number;
  /**
   * Most times one arm's front, stopped by cooling, is fed on by the tube roofed behind it, 0 (never) to 64: each run-on
   * starts where the last one cooled, once the roofs behind it close (Keszthelyi 1995; Calvari and Pinkerton 1998).
   * Default 16.
   */
  maxRunOns?: number;
  /**
   * Steepest slope a channel roofs over into a lava tube, degrees, 0 (no tubes) to 30 (Peterson et al. 1994: tubes
   * form where a steady channel crusts over on gentle ground). Default 4.
   */
  tubeSlope?: number;
  /**
   * Seconds of steady feed after the front passes before the roof closes, 60 to 1e7. Inside, the lava loses heat only
   * by conduction through a roof as thick as the crust grown in this time and into the floor (Keszthelyi 1995). Default
   * 86,400 (a day).
   */
  tubeTime?: number;
  /**
   * Mean spacing of skylights along a roofed tube, metres, 0 (none) to 100,000: holes where the roof fell in or never
   * closed, showing the stream until the tube drains (Kauahikaua et al. 1998). Default 200.
   */
  skylightSpacing?: number;
  /** Thermal conductivity of the ground under the flow, W/(m K), 0.1 to 5. Default 1 (dry basalt rubble and soil). */
  groundConductivity?: number;
  /** Length of a step of the path, metres, 0.5 to 500. Default 5. */
  step?: number;
  /** Longest path, metres, 10 to 200,000. Default 40,000. */
  maxLength?: number;
  /** Jitter of the ground under the path, metres (Favalli et al. 2005), 0 to 20. Default 0.2. */
  wander?: number;
  /** Wind at 10 m, m/s, 0 to 60. Unset follows `weather`. */
  wind?: number;
  /** Direction the wind blows toward, degrees, 0 is +Z, 90 is +X. Unset follows `weather`. */
  windDirection?: number;
  /** The weather whose wind it follows. */
  weather?: LavaWeather;
  /** Fountain height over the vent at the full rate, metres, 0 (none) to 1,000. Default 40. */
  fountainHeight?: number;
  /** Clots thrown by the fountain per second, 0 to 2,000. Default 80. */
  clotRate?: number;
  /** Median clot diameter, metres, 0.005 to 2. Default 0.08. */
  clotSize?: number;
  /** Half angle of the fountain's spread from the vertical, degrees, 0 to 45. Default 8. */
  fountainSpread?: number;
  /** Bursts of bombs per minute, 0 (none) to 120. Default 2. */
  bombRate?: number;
  /** Bombs thrown by each burst, 1 to 200. Default 12. */
  bombsPerBurst?: number;
  /** Median launch speed of the bombs, m/s, 1 to 600. Default 80. */
  bombSpeed?: number;
  /** Median bomb diameter, metres, 0.02 to 5. Default 0.4. */
  bombSize?: number;
  /** Half angle of the bombs' spread from the vertical, degrees, 0 to 80. Default 30. */
  bombSpread?: number;
  /** Bomb density, kg/m^3, 500 to 3,000. Default 2,500. */
  bombDensity?: number;
  /** Drag coefficient of clots and bombs, 0 (none) to 2 (Mastin 2001). Default 0.8. */
  drag?: number;
  /** Seconds a landed bomb stays (cooling) before it is dropped from the draw, 0 to 1e5. Default 600. */
  bombLife?: number;
  /** Multiplies the glow's radiance and lights, 0 to 100. Default 1 (physical luminance over the engine's sun 1). */
  glow?: number;
  /** Most glow lights {@link LavaFlow.glowLights} gives, 0 to 64. Default 8. */
  maxLights?: number;
  /** Range of each glow light, metres, 1 to 100,000. Default 400. */
  lightRange?: number;
  /** Lights fed each update (`update` writes `glowLights()` into it). */
  lights?: LavaLightTarget;
  /** Seed of the wander, fountain and bombs, an integer. Default 1. */
  seed?: number;
  /** Film seconds per real second, 0 to 100. Default 1. */
  timeScale?: number;
}

const RANGES: Record<string, readonly [number, number]> = {
  start: [0, 1e9],
  rise: [1, 86400],
  duration: [0, 1e7],
  wane: [1, 86400],
  effusionRate: [0.1, 1e4],
  temperature: [1000, 1600],
  crustTemperature: [900, 1500],
  solidus: [800, 1500],
  airTemperature: [220, 330],
  density: [500, 3200],
  heatCapacity: [500, 2000],
  conductivity: [0.1, 5],
  latentHeat: [0, 1e6],
  crystallisation: [0, 0.02],
  emissivity: [0.5, 1],
  viscosity: [1, 1e9],
  viscosityRise: [0, 0.2],
  yieldStrength: [0, 1e4],
  yieldRise: [0, 0.2],
  width: [0.5, 2000],
  stopGraetz: [10, 3000],
  crackTime: [1, 3600],
  crackShare: [0, 1],
  crackSpeed: [0, 2],
  hotOffset: [0, 300],
  baseTemperature: [300, 1400],
  baseCrust: [0.01, 0.5],
  maxWidth: [0.5, 2e4],
  groundConductivity: [0.1, 5],
  leveeMax: [0, 1],
  branchShare: [0, 1],
  tubeSlope: [0, 30],
  tubeTime: [60, 1e7],
  skylightSpacing: [0, 1e5],
  maxBranches: [0, 64],
  maxRunOns: [0, 64],
  joinDistance: [0, 4],
  breakoutHeight: [0, 20],
  roofStrength: [1e4, 1e7],
  step: [0.5, 500],
  maxLength: [10, 2e5],
  wander: [0, 20],
  wind: [0, 60],
  windDirection: [-360, 360],
  fountainHeight: [0, 1000],
  clotRate: [0, 2000],
  clotSize: [0.005, 2],
  fountainSpread: [0, 45],
  bombRate: [0, 120],
  bombsPerBurst: [1, 200],
  bombSpeed: [1, 600],
  bombSize: [0.02, 5],
  bombSpread: [0, 80],
  bombDensity: [500, 3000],
  drag: [0, 2],
  bombLife: [0, 1e5],
  glow: [0, 100],
  maxLights: [0, 64],
  lightRange: [1, 1e5],
  timeScale: [0, 100],
};

/** Throws for any invalid field of `o`. */
export function validateLava(o: LavaOptions): void {
  if (typeof o !== 'object' || o === null) throw new TypeError('Lava options must be an object');
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const v = (o as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
      throw new RangeError(`Lava ${key} must be a number from ${lo} to ${hi}`);
  }
  for (const key of ['bombsPerBurst', 'maxLights', 'maxBranches', 'maxRunOns'] as const)
    if (o[key] !== undefined && !Number.isInteger(o[key])) throw new RangeError(`Lava ${key} must be a whole number`);
  if (o.seed !== undefined && !Number.isInteger(o.seed)) throw new RangeError('Lava seed must be an integer');
  if (o.vent !== undefined && !(Array.isArray(o.vent) && o.vent.length === 3 && o.vent.every(Number.isFinite)))
    throw new RangeError('Lava vent must be an [x, y, z] point');
  if (
    o.ground !== undefined &&
    typeof o.ground !== 'function' &&
    typeof (o.ground as { height?: unknown })?.height !== 'function'
  )
    throw new TypeError('Lava ground must be a height function (x, z) or an object with height(x, z)');
  if ((o.solidus ?? 1253) >= (o.temperature ?? 1423))
    throw new RangeError('Lava solidus must be below its temperature');
  if ((o.crustTemperature ?? 1343) >= (o.temperature ?? 1423))
    throw new RangeError('Lava crustTemperature must be below its temperature');
}

// ---- Light: Planck's law through the CIE 1931 observer (Wyman, Sloan and Shirley 2013's multi-lobe fits). ----
const lobe = (l: number, mu: number, s1: number, s2: number) => {
  const d = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * d * d);
};
const xBar = (l: number) =>
  1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
const yBar = (l: number) => 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
const zBar = (l: number) => 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);

/** Spectral radiance of a blackbody, W / (m^2 sr m), at wavelength `nm` nanometres and `kelvin`. */
export function planck(nm: number, kelvin: number): number {
  const l = nm * 1e-9,
    x = (H_PLANCK * C_LIGHT) / (l * K_BOLTZ * kelvin);
  return x > 700 ? 0 : (2 * H_PLANCK * C_LIGHT * C_LIGHT) / (l ** 5 * Math.expm1(x));
}
const glowCache = new Map<number, readonly [number, number, number, number]>();
/**
 * The light of a blackbody at `kelvin`: [r, g, b, luminance], linear sRGB in cd/m^2 (683 lm/W against the CIE 1931
 * observer, 360 to 830 nm in 1 nm steps), negative channels clipped to 0. Below 500 K it is dark.
 * @example lavaGlow(1423); // Hawaiian lava at the vent: deep orange, about 1,800 cd/m^2
 */
export function lavaGlow(kelvin: number): readonly [number, number, number, number] {
  if (!(kelvin >= 500)) return [0, 0, 0, 0];
  const key = Math.round(kelvin * 4) / 4,
    hit = glowCache.get(key);
  if (hit) return hit;
  let X = 0,
    Y = 0,
    Z = 0;
  for (let nm = 360; nm <= 830; nm++) {
    const b = planck(nm, key) * 1e-9;
    X += b * xBar(nm);
    Y += b * yBar(nm);
    Z += b * zBar(nm);
  }
  X *= 683;
  Y *= 683;
  Z *= 683;
  const out = [
    Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    Math.max(0, 0.0557 * X - 0.204 * Y + 1.057 * Z),
    Y,
  ] as const;
  if (glowCache.size > 4096) glowCache.clear();
  glowCache.set(key, out);
  return out;
}

/** Air density at `z` metres above sea level through the ICAO troposphere (isothermal above 11 km), kg/m^3. */
export function airDensity(z: number): number {
  const h = Math.max(0, z);
  if (h <= 11000) return 1.225 * Math.pow(1 - (0.0065 * h) / 288.15, G / (287.05287 * 0.0065) - 1);
  return 0.36392 * Math.exp((-G * (h - 11000)) / (287.05287 * 216.65));
}

/** Mean speed of a Bingham sheet of thickness `h` (Jeffreys 1925 with Hulme 1974's plug correction), m/s. */
export function binghamSpeed(
  h: number,
  sinSlope: number,
  density: number,
  viscosity: number,
  yieldStrength: number,
): number {
  const hy = yieldStrength / (density * G * sinSlope);
  if (!(h > hy)) return 0;
  const x = hy / h;
  return ((density * G * sinSlope * h * h) / (3 * viscosity)) * (1 - 1.5 * x + 0.5 * x * x * x);
}
/** Sheet thickness carrying `q` m^2/s (flux per width) down a slope: the inverse of {@link binghamSpeed} times h. */
export function binghamThickness(
  q: number,
  sinSlope: number,
  density: number,
  viscosity: number,
  yieldStrength: number,
): number {
  const hy = yieldStrength / (density * G * sinSlope);
  let lo = hy,
    hi = Math.max(hy * 2, 1e-3);
  while (hi * binghamSpeed(hi, sinSlope, density, viscosity, yieldStrength) < q && hi < 1e5) hi *= 2;
  for (let k = 0; k < 100; k++) {
    const mid = 0.5 * (lo + hi);
    if (mid * binghamSpeed(mid, sinSlope, density, viscosity, yieldStrength) < q) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Huppert's (1982) radius of an axisymmetric pond fed at `flux` m^3/s for `seconds`, m. */
export function pondRadius(flux: number, seconds: number, density: number, viscosity: number): number {
  return 0.715 * Math.pow((G * flux ** 3) / (3 * (viscosity / density)), 1 / 8) * Math.sqrt(Math.max(seconds, 0));
}

// ---- The crust: conduction under a radiating, convecting surface, with the latent heat released to the solidus. ----
interface CrustTable {
  readonly age: Float64Array;
  readonly surface: Float64Array;
  readonly crust: Float64Array;
}
const crustCache = new Map<string, CrustTable>();
/**
 * Solves the cooling of a lava surface once (implicit finite differences, 5 mm cells to 4 m, time steps from 0.02 s
 * growing by 4 percent to 30 days): the surface temperature and the depth of the `crustTemperature` isotherm against
 * the age of the surface. `fixedSurface` holds the surface at the air temperature instead (the Stefan problem).
 */
function crustTable(o: LavaOptions, wind: number, fixedSurface = false): CrustTable {
  const Tv = o.temperature ?? 1423,
    Ta = o.airTemperature ?? 288,
    Tc = o.crustTemperature ?? 1343,
    Ts = o.solidus ?? 1253,
    rho = o.density ?? 2600,
    c = o.heatCapacity ?? 1150,
    k = o.conductivity ?? 1.5,
    L = o.latentHeat ?? 3.5e5,
    eps = o.emissivity ?? 0.95,
    hc = 0.0036 * airDensity(o.vent?.[1] ?? 0) * AIR_HEAT * Math.max(wind, 1),
    key = [Tv, Ta, Tc, Ts, rho, c, k, L, eps, hc, +fixedSurface].join();
  const hit = crustCache.get(key);
  if (hit) return hit;
  const n = 800,
    dz = 0.005,
    T = new Float64Array(n).fill(Tv),
    a = new Float64Array(n),
    b = new Float64Array(n),
    cc = new Float64Array(n),
    d = new Float64Array(n),
    ages: number[] = [0],
    surface: number[] = [Tv],
    crust: number[] = [0];
  // Apparent heat capacity: the latent heat spread evenly between the vent temperature and the solidus.
  const cap = (t: number) => rho * (c + (t > Ts && t <= Tv ? L / (Tv - Ts) : 0));
  let time = 0,
    dt = 0.02;
  if (fixedSurface) T[0] = Ta;
  while (time < 30 * 86400) {
    // One lag of the capacity and a Newton linearisation of the surface loss per step.
    const T0 = T[0],
      loss = eps * SIGMA * (T0 ** 4 - Ta ** 4) + hc * (T0 - Ta),
      dloss = 4 * eps * SIGMA * T0 ** 3 + hc,
      r = k / (dz * dz);
    for (let i = 0; i < n; i++) {
      const C = cap(T[i]) / dt;
      if (i === 0) {
        if (fixedSurface) {
          a[0] = 0;
          b[0] = 1;
          cc[0] = 0;
          d[0] = Ta;
          continue;
        }
        // Half cell at the surface: its loss leaves through the top.
        b[0] = C / 2 + r + dloss / dz;
        cc[0] = -r;
        a[0] = 0;
        d[0] = (C / 2) * T[0] - (loss - dloss * T0) / dz;
      } else if (i === n - 1) {
        a[i] = -r;
        b[i] = C + r;
        cc[i] = 0;
        d[i] = C * T[i];
      } else {
        a[i] = -r;
        b[i] = C + 2 * r;
        cc[i] = -r;
        d[i] = C * T[i];
      }
    }
    for (let i = 1; i < n; i++) {
      const m = a[i] / b[i - 1];
      b[i] -= m * cc[i - 1];
      d[i] -= m * d[i - 1];
    }
    T[n - 1] = d[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) T[i] = (d[i] - cc[i] * T[i + 1]) / b[i];
    time += dt;
    dt *= 1.04;
    let depth = 0;
    if (T[0] < Tc) {
      let i = 1;
      while (i < n && T[i] < Tc) i++;
      depth = i >= n ? n * dz : (i - 1 + (Tc - T[i - 1]) / (T[i] - T[i - 1])) * dz;
    }
    ages.push(time);
    surface.push(T[0]);
    crust.push(depth);
  }
  const table = { age: Float64Array.from(ages), surface: Float64Array.from(surface), crust: Float64Array.from(crust) };
  if (crustCache.size > 32) crustCache.clear();
  crustCache.set(key, table);
  return table;
}
function lookup(t: CrustTable, values: Float64Array, age: number): number {
  const a = t.age;
  if (age <= 0) return values[0];
  if (age >= a[a.length - 1]) return values[values.length - 1];
  let lo = 0,
    hi = a.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= age) lo = mid;
    else hi = mid;
  }
  return values[lo] + ((values[hi] - values[lo]) * (age - a[lo])) / (a[hi] - a[lo]);
}

/** Ground under the flow: rho c of dry basaltic rubble and soil, J/(m^3 K). */
const GROUND_HEAT = 2.0e6;
/**
 * The middle of a sheet `h` metres thick, all at `T0` when the vent stops, `seconds` later: a slab whose top is held at
 * the air and whose base is held at the lava-ground contact temperature (both from Carslaw and Jaeger 1959).
 */
export function slabCore(o: LavaOptions, T0: number, h: number, seconds: number): number {
  const Ta = o.airTemperature ?? 288,
    Tv = o.temperature ?? 1423,
    Ts = o.solidus ?? 1253,
    rho = o.density ?? 2600,
    k = o.conductivity ?? 1.5,
    cEff = (o.heatCapacity ?? 1150) + (Tv > Ts ? (o.latentHeat ?? 3.5e5) / (Tv - Ts) : 0),
    kg = o.groundConductivity ?? 1,
    eLava = Math.sqrt(k * rho * cEff),
    eGround = Math.sqrt(kg * GROUND_HEAT),
    Tb = (eLava * T0 + eGround * Ta) / (eLava + eGround),
    kappa = k / (rho * cEff),
    f = (Math.PI * Math.PI * kappa * Math.max(seconds, 0)) / (h * h);
  // Steady part at the middle, then the decaying modes sin(n pi z / h) at z = h / 2 (only odd n are nonzero there).
  let T = 0.5 * (Ta + Tb);
  for (let n = 1; n <= 127; n += 2) {
    const sign = (n & 3) === 1 ? 1 : -1,
      b = (2 / (n * Math.PI)) * (2 * (T0 - Tb) - (Ta - Tb));
    T += sign * b * Math.exp(-n * n * f);
  }
  return Math.min(T0, Math.max(Ta, T));
}

// ---- Hashing (lowbias32, C. Wellons, "Prospecting for Hash Functions"). ----
function hash(v: number): number {
  let x = v >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
const unit = (a: number, b: number, c: number) => hash(hash(hash(a) ^ (b >>> 0)) ^ (c >>> 0)) / 4294967296;
/** A standard normal from two hashed uniforms (Box and Muller 1958). */
const normal = (a: number, b: number, c: number) =>
  Math.sqrt(-2 * Math.log(Math.max(unit(a, b, c), 1e-12))) * Math.cos(2 * Math.PI * unit(a, b, c + 7919));

/** One point of the flow's path. */
export interface LavaPathPoint {
  /** World place on the ground, metres. */
  readonly position: readonly [number, number, number];
  /** Length along the path from the vent, metres. */
  readonly distance: number;
  /** Seconds of full-rate supply after which the front reaches it. */
  readonly travel: number;
  /** Mean speed of the lava here, m/s. */
  readonly speed: number;
  /** Sheet thickness, metres. */
  readonly thickness: number;
  /** Channel width, metres. */
  readonly width: number;
  /** Core temperature, kelvin. */
  readonly temperature: number;
  /** Viscosity, Pa s. */
  readonly viscosity: number;
  /** Yield strength, Pa. */
  readonly yieldStrength: number;
  /** Graetz number of the flow here. */
  readonly graetz: number;
  /** Sine of the ground's slope down the path here (0 where it ponded). */
  readonly slope: number;
  /**
   * Seconds of full-rate supply the front waited, up the path from here, at stops a tube later fed it on from
   * (0 unless tube-fed): `travel - wait` is the lava's trip from the vent.
   */
  readonly wait: number;
  /** Seconds of full-rate supply at which the lava here came into the open: 0 from the vent, else a tube's mouth. */
  readonly opened: number;
}

/** One arm of a flow that split: the trunk (`parent` -1) or a branch off another arm. */
export interface LavaBranch {
  /** Index in {@link LavaFlow.branches} of the arm it split from, -1 for the trunk. */
  readonly parent: number;
  /** Index in the parent's path of the point it split at (0 for the trunk). */
  readonly at: number;
  /** Lava it carries at the full supply when it splits off, m^3/s (the trunk: the effusion rate). */
  readonly flux: number;
  /** Its path, the split point first. */
  readonly path: readonly LavaPathPoint[];
  /** Why it stops ('joined' where it runs into another arm). */
  readonly stop: LavaStop;
  /** Where it ran into another arm and ended: that arm's index in {@link LavaFlow.branches} and its point there. */
  readonly joins?: { readonly arm: number; readonly at: number };
  /** True for an arm that broke out of its parent's stalled stretch ({@link LavaOptions.breakoutHeight}). */
  readonly breakout?: boolean;
}
interface SolvedArm {
  start: ArmStart;
  flux: number;
  path: LavaPathPoint[];
  stop: LavaStop;
  depth: number;
  joins?: { arm: number; at: number };
  gone?: boolean;
}
/**
 * What an arm asks of the arms around it at each step. `hit`: whether it has run into another, given its place, width,
 * direction and top; `beside` true when it came alongside, running the same way below the other's levee crest, so the
 * two run side by side. `gap`: how far (metres) its edge stands clear of arm `arm`'s nearest edge, negative where they
 * overlap, Infinity when that arm is not near.
 */
interface Joiner {
  hit(
    x: number,
    z: number,
    width: number,
    dirX: number,
    dirZ: number,
    top: number,
  ): { arm: number; at: number; beside: boolean } | undefined;
  gap(arm: number, x: number, z: number, width: number): number;
}
interface ArmLeg {
  points: LavaPathPoint[];
  stop: LavaStop;
  /** Flux left at its end, the direction it last moved and the vent's depth it carries on. */
  Q: number;
  dirX: number;
  dirZ: number;
  depth: number;
  /** The arm and point it ran into, if it ended so. */
  joins?: { arm: number; at: number };
}
interface ArmStart {
  /** True for a breakout: it never rejoins its parent's stalled stretch past `at`. */
  breakout?: boolean;
  parent: number;
  at: number;
  x: number;
  z: number;
  T: number;
  s: number;
  travel: number;
  dirX: number;
  dirZ: number;
  depth: number;
  flux: number;
  wait: number;
  opened: number;
  /** Distance along the path where its lava came into the open (0 at the vent, else a tube's mouth). */
  openS: number;
}

/** Why the front stopped (or 'flowing'). */
export type LavaStop = 'flowing' | 'cooled' | 'ponded' | 'supply' | 'length' | 'stalled' | 'joined';

/** The front now. */
export interface LavaFront {
  readonly distance: number;
  readonly position: readonly [number, number, number];
  /** m/s now (0 once stopped). */
  readonly speed: number;
  readonly stop: LavaStop;
}

/** A glowing clot or bomb now. */
export interface LavaBlob {
  readonly position: readonly [number, number, number];
  /** Diameter, metres. */
  readonly size: number;
  /** Surface temperature, kelvin. */
  readonly temperature: number;
  /** Glow, linear sRGB radiance (engine units: the sun's white 1), times `glow`. */
  readonly color: readonly [number, number, number];
  /** True once it has landed. */
  readonly landed: boolean;
}

/** A bomb landing, for dust, sound and ground marks. */
export interface LavaImpact {
  readonly time: number;
  readonly position: readonly [number, number, number];
  /** Speed at impact, m/s. */
  readonly speed: number;
  /** Mass, kg. */
  readonly mass: number;
  /** Film second it was thrown. */
  readonly launch: number;
  /** Speed it was thrown at, m/s. */
  readonly launchSpeed: number;
}

/** A `LavaEvent` of `@margoengine/terrain/ground-change`, as {@link LavaFlow.lavaEvent} gives it. */
export interface LavaGroundEvent {
  kind: 'lava';
  path: [number, number][];
  arrival: number[];
  widths: number[];
  thicknesses: number[];
  glows: number[];
  /** Levee height over the sheet per point, a share of the thickness, as {@link LavaFlow.leveeShare} gives it. */
  levees: number[];
  /** Film second the channel from each point roofs over into a tube, {@link LavaFlow.roofTime} (1e9 where it never does). */
  roofs: number[];
  /** Film second the tube from each point stops carrying lava: the supply's end passes it (1e9 for never). */
  drains: number[];
  /** Mean skylight spacing along a roofed tube, metres, {@link LavaOptions.skylightSpacing}. */
  skylights: number;
  cooling: number;
  seed: number;
  /** The pond a flow that ponded fills at its end (Huppert 1982), as `LavaEvent.pond` of ground-change takes it. */
  pond?: { center: [number, number]; start: number; end: number; flux: number; viscosity: number; density: number };
}

interface Flight {
  readonly launch: number;
  readonly size: number;
  readonly mass: number;
  /** Positions every FLIGHT_STEP seconds until it lands, xyz. */
  readonly path: Float64Array;
  /** Seconds of flight to the landing. */
  readonly flight: number;
  readonly impact: number;
  readonly speed: number;
}
const FLIGHT_STEP = 0.05;
let attached = 0;

/** The engine a {@link LavaFlow.attach} adds the flow to. */
interface LavaEngine {
  sceneOf?(plugin: object): { removePlugin(name: string): void } | undefined;
  removePlugin(name: string): void;
}

/**
 * Lava from one vent over film time: a flow that runs down the ground by steepest descent (Favalli et al. 2005) as a
 * Bingham sheet (Jeffreys 1925; Hulme 1974) whose core cools by radiation and convection from a crusted surface with
 * hot cracks (Harris and Rowland 2001; Crisp and Baloga 1990), thickening and slowing as viscosity and yield strength
 * rise (Dragoni 1989), until it stops where its Graetz number reaches 300 (Pinkerton and Wilson 1994), where it ponds,
 * stalls or runs out of supply; a crust that grows under the surface (Hon et al. 1994); a fountain of clots (Wilson and
 * Head 1981) and bursts of bombs on drag-slowed ballistic paths (Mastin 2001); and the glow (Planck) as colour, ground
 * cover and point lights. `seek` to any time gives the same lava however it got there.
 * @example
 * const lava = new LavaFlow({ vent: [0, 900, 0], ground: (x, z) => query.height(x, z) ?? 0, lights: lights.group('lava') });
 * engine.onFrame((_, dt) => { lava.update(dt); change.clear(); change.add(lava.lavaEvent()); lava.drawClots(clots.instances); });
 */
export class LavaFlow {
  /** The options; change them at any time (a changed option takes effect at the next read). */
  readonly options: LavaOptions;
  /** Its plugin name: `lava:N` once added with {@link LavaFlow.attach}. */
  readonly name: string = 'lava';
  private engine?: LavaEngine;
  private film = 0;
  private profileKey = '';
  private profile: LavaPathPoint[] = [];
  private stopReason: LavaStop = 'flowing';
  private arms: LavaBranch[] = [];
  private tubeCache = new WeakMap<readonly LavaPathPoint[], Float64Array>();
  private flights = new Map<string, Flight>();
  private flightKey = '';
  private impactsFrom = 0;
  private profileGround?: LavaGround;
  private flightGround?: LavaGround;

  constructor(options: LavaOptions = {}) {
    validateLava(options);
    this.options = options;
  }

  /** A new flow added to an engine as a plugin named `lava:N`: it steps its own film time each frame (`update`). */
  static attach(engine: { use(plugin: object): unknown }, options: LavaOptions = {}): LavaFlow {
    const lava = new LavaFlow(options);
    (lava as { name: string }).name = 'lava:' + ++attached;
    engine.use(lava);
    return lava;
  }
  /** Engine plugin hooks. */
  setup(engine: LavaEngine): void {
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.update(delta);
  }
  /** Clears its lights and takes an attached flow out of its engine (the options stay; reads still work). */
  dispose(): void {
    this.options.lights?.setLights([]);
    const engine = this.engine;
    this.engine = undefined;
    (engine?.sceneOf?.(this) ?? engine)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  /** Film seconds now. */
  get time(): number {
    return this.film;
  }
  /** Moves film time on by `delta` real seconds times `timeScale`: the clock a seek from `@margoengine/cutscene/seek` replays. */
  advanceTime(delta: number): void {
    this.update(delta);
  }
  /** Moves film time on by `delta` real seconds times `timeScale`, and writes the glow lights into `lights`. */
  update(delta: number): void {
    if (!(delta >= 0) || !Number.isFinite(delta))
      throw new RangeError('LavaFlow update needs a finite delta, 0 or more');
    this.seek(this.film + delta * (this.options.timeScale ?? 1));
  }
  /**
   * Back to film second 0, as a fresh flow with the same options (GAP-FILM-RESET): the front, the glow lights (written
   * for second 0) and the bombs' impacts start again (impacts are read again from the start).
   */
  resetTime(): void {
    this.seek(0);
    this.impactsFrom = 0;
  }
  /** Goes to film second `t` (and writes the glow lights into `lights`). */
  seek(t: number): void {
    if (!(t >= 0) || !Number.isFinite(t)) throw new RangeError('LavaFlow seek needs a finite time, 0 or more');
    validateLava(this.options);
    if (t < this.film) this.impactsFrom = t;
    this.film = t;
    this.options.lights?.setLights(this.glowLights());
  }

  /** Share of the full supply at film second `t`, 0 to 1. */
  envelope(t = this.film): number {
    const o = this.options,
      rise = o.rise ?? 60,
      hold = o.duration ?? 3600,
      wane = o.wane ?? 300,
      a = t - (o.start ?? 0);
    if (a <= 0) return 0;
    if (a < rise) return a / rise;
    if (a < rise + hold) return 1;
    return Math.max(0, 1 - (a - rise - hold) / wane);
  }
  /** Seconds of full-rate supply delivered by film second `t` (the integral of {@link envelope}). */
  supplied(t = this.film): number {
    const o = this.options,
      rise = o.rise ?? 60,
      hold = o.duration ?? 3600,
      wane = o.wane ?? 300,
      a = Math.max(0, t - (o.start ?? 0)),
      r = Math.min(a, rise),
      h = Math.min(Math.max(a - rise, 0), hold),
      w = Math.min(Math.max(a - rise - hold, 0), wane);
    return (0.5 * r * r) / rise + h + w - (0.5 * w * w) / wane;
  }
  /** Film second at which `seconds` of full-rate supply have been delivered (Infinity past the whole supply). */
  supplyTime(seconds: number): number {
    const o = this.options,
      t0 = o.start ?? 0,
      rise = o.rise ?? 60,
      hold = o.duration ?? 3600,
      wane = o.wane ?? 300;
    if (seconds <= 0) return t0;
    if (seconds <= rise / 2) return t0 + Math.sqrt(2 * seconds * rise);
    if (seconds <= rise / 2 + hold) return t0 + rise + seconds - rise / 2;
    const left = seconds - rise / 2 - hold;
    if (left >= wane / 2) return Infinity;
    // w - w^2 / (2 wane) = left.
    return t0 + rise + hold + wane * (1 - Math.sqrt(1 - (2 * left) / wane));
  }
  /** Film second the vent stops. */
  get end(): number {
    const o = this.options;
    return (o.start ?? 0) + (o.rise ?? 60) + (o.duration ?? 3600) + (o.wane ?? 300);
  }

  /** The wind at 10 m, [x, z] m/s: the option, else the weather, else calm. */
  windNow(): [number, number] {
    const o = this.options,
      s = o.weather?.state,
      w = o.wind ?? s?.wind ?? 0,
      d = o.windDirection != null ? (o.windDirection * Math.PI) / 180 : (s?.windDirection ?? 0);
    return [w * Math.sin(d), w * Math.cos(d)];
  }

  private groundAt(x: number, z: number): number {
    const g = this.options.ground,
      vy = this.options.vent?.[1] ?? 0;
    if (!g) return vy;
    const h = typeof g === 'function' ? g(x, z) : g.height(x, z);
    return typeof h === 'number' && Number.isFinite(h) ? h : vy;
  }

  /** Surface temperature (kelvin) of lava whose surface has been open to the air for `age` seconds. */
  surfaceTemperature(age: number): number {
    const t = crustTable(this.options, Math.hypot(...this.windNow()));
    return lookup(t, t.surface, age);
  }
  /** Crust thickness (metres, to the `crustTemperature` isotherm) of a surface `age` seconds old. */
  crustThickness(age: number): number {
    const t = crustTable(this.options, Math.hypot(...this.windNow()));
    return lookup(t, t.crust, age);
  }
  /** The crust thickness of the same lava with its surface held at the air temperature (the Stefan problem), metres. */
  stefanCrust(age: number): number {
    const t = crustTable(this.options, 0, true);
    return lookup(t, t.crust, age);
  }

  /** Viscosity (Pa s) and yield strength (Pa) at `kelvin` (Dragoni 1989). */
  rheology(kelvin: number): [number, number] {
    const o = this.options,
      dT = Math.max(0, (o.temperature ?? 1423) - kelvin);
    return [
      (o.viscosity ?? 300) * Math.exp((o.viscosityRise ?? 0.04) * dT),
      (o.yieldStrength ?? 0.01) * Math.expm1((o.yieldRise ?? 0.08) * dT),
    ];
  }

  /**
   * The flow's path at the full supply, vent first: steepest descent over the jittered ground, the sheet's thickness
   * and speed, the core's temperature, the travel time of the front. Cached until an option or the wind changes.
   */
  path(): readonly LavaPathPoint[] {
    const o = this.options,
      wind = Math.hypot(...this.windNow()),
      key = JSON.stringify({
        ...o,
        ground: undefined,
        lights: undefined,
        weather: undefined,
        timeScale: 0,
        glow: 0,
        wind,
      });
    if (key === this.profileKey && this.profileGround === o.ground && this.profile.length) return this.profile;
    this.profileGround = o.ground;
    this.profileKey = key;
    this.profile = this.solve(wind);
    return this.profile;
  }

  private solve(wind: number): LavaPathPoint[] {
    const o = this.options,
      step = o.step ?? 5,
      wander = o.wander ?? 0.2,
      seed = o.seed ?? 1,
      vent = o.vent ?? [0, 0, 0];
    // Favalli et al.'s jitter: the ground moved up or down by up to `wander`, as value noise on a lattice of four steps
    // (smooth, so it bends the path without digging pits a step wide).
    const cell = 4 * step,
      corner = (i: number, j: number) => 2 * unit(Math.imul(i, 73856093), Math.imul(j, 19349663), seed) - 1,
      jitter = (x: number, z: number) => {
        if (!wander) return 0;
        const fx = x / cell,
          fz = z / cell,
          i = Math.floor(fx),
          j = Math.floor(fz),
          u = fx - i,
          v = fz - j,
          su = u * u * (3 - 2 * u),
          sv = v * v * (3 - 2 * v);
        return (
          wander *
          ((corner(i, j) * (1 - su) + corner(i + 1, j) * su) * (1 - sv) +
            (corner(i, j + 1) * (1 - su) + corner(i + 1, j + 1) * su) * sv)
        );
      };
    const height = (x: number, z: number) => this.groundAt(x, z) + jitter(x, z),
      reach = o.joinDistance ?? 1,
      maxB = o.maxBranches ?? 8,
      cap = 4 * (maxB + 1) * (maxB + 1) + 16,
      live: SolvedArm[] = [],
      tasks: { arm: number; keep: number; start: ArmStart }[] = [];
    let left = maxB,
      solves = 0;
    const trunk: ArmStart = {
      parent: -1,
      at: 0,
      x: vent[0],
      z: vent[2],
      T: o.temperature ?? 1423,
      s: 0,
      travel: 0,
      dirX: 0,
      dirZ: 0,
      depth: 0,
      flux: o.effusionRate ?? 20,
      wait: 0,
      opened: 0,
      openS: 0,
    };
    live.push({ start: trunk, flux: trunk.flux, path: [], stop: 'flowing', depth: 0 });
    tasks.push({ arm: 0, keep: 0, start: trunk });
    const split = (k: number, offset: number) => (b: Omit<ArmStart, 'parent'>) => {
        if (left <= 0) return false;
        left--;
        const start = { ...b, at: b.at + offset, parent: k };
        live.push({ start, flux: b.flux, path: [], stop: 'flowing', depth: b.depth });
        tasks.push({ arm: live.length - 1, keep: 0, start });
        return true;
      },
      // An arm and everything split off it go; arms that ran into them are solved again.
      drop = (k: number): void => {
        live[k]!.gone = true;
        left++;
        clear(k, 0);
      },
      // Forgets what hangs off arm k from its point `from` on: its branches there go, and arms that joined it there
      // are solved again from their starts.
      clear = (k: number, from: number): void => {
        live.forEach((a, i) => {
          if (a.gone) return;
          if (a.start.parent === k && a.start.at >= from) drop(i);
          else if (a.joins && a.joins.arm === k && a.joins.at >= from) {
            a.joins = undefined;
            a.path = [];
            clear(i, 0);
            tasks.push({ arm: i, keep: 0, start: a.start });
          }
        });
      },
      // Lava an arm passes on at its end: its flux, less its branches, plus the arms that joined it.
      endFlux = (k: number, before = Infinity): number =>
        live.reduce(
          (f, a, i) =>
            a.gone
              ? f
              : f -
                (a.start.parent === k && a.start.at < before ? a.flux : 0) +
                (a.joins?.arm === k && a.joins.at < before ? endFlux(i) : 0),
          live[k]!.flux,
        ),
      // True when arm i's lava runs (through joins) into arm k.
      feeds = (i: number, k: number): boolean => {
        for (let j: number | undefined = i, n = 0; j !== undefined && n <= live.length; j = live[j]!.joins?.arm, n++)
          if (j === k) return true;
        return false;
      };
    // Solves arm r again from its point q on, carrying arm k's lava too when k ran into it there: r carries both from
    // there (Dietterich and Cashman 2014), at their flux-weighted temperature, and what hung off its old tail goes.
    const retail = (r: number, q: number, k?: number): void => {
      const R = live[r]!;
      clear(r, q);
      if (k !== undefined) live[k]!.joins = { arm: r, at: q };
      if (q <= 0) {
        R.path = [];
        tasks.unshift({ arm: r, keep: 0, start: R.start });
        return;
      }
      const p = R.path[q]!,
        prev = R.path[q - 1]!,
        len = Math.hypot(p.position[0] - prev.position[0], p.position[2] - prev.position[2]),
        Qr = endFlux(r, q),
        Qm = k === undefined ? 0 : endFlux(k),
        Tm = k === undefined ? p.temperature : live[k]!.path[live[k]!.path.length - 1]!.temperature;
      let o0 = q;
      while (o0 > 0 && R.path[o0 - 1]!.opened === p.opened) o0--;
      tasks.unshift({
        arm: r,
        keep: q,
        start: {
          parent: R.start.parent,
          at: R.start.at,
          x: p.position[0],
          z: p.position[2],
          T: (Qr * p.temperature + Qm * Tm) / (Qr + Qm),
          s: p.distance,
          travel: p.travel,
          dirX: len > 0 ? (p.position[0] - prev.position[0]) / len : R.start.dirX,
          dirZ: len > 0 ? (p.position[2] - prev.position[2]) / len : R.start.dirZ,
          depth: R.depth,
          flux: Qr + Qm,
          wait: p.wait,
          opened: p.opened,
          openS: R.path[o0]!.distance,
        },
      });
    };
    while (tasks.length) {
      const { arm: k, keep, start } = tasks.shift()!,
        a = live[k]!;
      if (a.gone) continue;
      solves++;
      // Its tail is solved again: the arm its old tail ran into no longer carries its lava.
      if (a.joins) {
        const { arm: t, at } = a.joins;
        a.joins = undefined;
        retail(t, at - 1);
      }
      const join = reach > 0 && solves <= cap ? this.joiner(live, k, reach, feeds) : undefined,
        points = a.path.slice(0, keep);
      let leg = this.arm(wind, start, height, split(k, keep), join);
      points.push(...leg.points);
      // A tube-fed run-on: once the channel behind a cooled front roofs over, the tube brings the front lava hotter
      // than the open channel did, and it flows on from there (Keszthelyi 1995; Calvari and Pinkerton 1998).
      for (let from = keep, runs = o.maxRunOns ?? 16; leg.stop === 'cooled'; runs--) {
        const next = runs > 0 ? this.runOn(points, from, start.parent, leg) : undefined,
          // Unless the tube feeds it on first, the inflating stalled flow breaks out through a levee.
          burst = this.breakout(points, from, leg, height, next ? next.travel : Infinity);
        if (burst) {
          split(k, 0)(burst);
          break;
        }
        if (!next) break;
        from = points.length;
        leg = this.arm(wind, next, height, split(k, from), join);
        points.push(...leg.points);
      }
      a.path = points;
      a.stop = leg.stop;
      a.depth = leg.depth;
      if (leg.joins) retail(leg.joins.arm, leg.joins.at, k);
    }
    // The arms that stand, in order, their parents and joins renumbered.
    const index = new Map<number, number>();
    live.forEach((a, i) => !a.gone && index.set(i, index.size));
    const arms: LavaBranch[] = [];
    live.forEach((a) => {
      if (a.gone) return;
      const b: LavaBranch = {
        parent: a.start.parent < 0 ? -1 : index.get(a.start.parent)!,
        at: a.start.at,
        flux: a.flux,
        path: a.path,
        stop: a.stop,
        ...(a.start.breakout ? { breakout: true } : {}),
      };
      arms.push(a.joins ? { ...b, joins: { arm: index.get(a.joins.arm)!, at: a.joins.at } } : b);
    });
    this.arms = arms;
    this.stopReason = arms[0]!.stop;
    return arms[0]!.path as LavaPathPoint[];
  }

  /**
   * One arm of the flow from `a` down the ground until it stops. Where a second line of descent at least 45 degrees off
   * the steepest drops at least `branchShare` of it, past a divide, the flow splits (Dietterich and Cashman 2014; a
   * flow parts round ground it cannot overtop, Favalli et al. 2005): `branch` is offered the new arm with the flux
   * shared by the drops (Jeffreys: at one thickness the flux per width goes as the slope) and this arm goes on with
   * the rest.
   */
  private arm(
    wind: number,
    a: ArmStart,
    height: (x: number, z: number) => number,
    branch: (split: Omit<ArmStart, 'parent'>) => boolean,
    join?: Joiner,
  ): ArmLeg {
    const o = this.options,
      rho = o.density ?? 2600,
      c = o.heatCapacity ?? 1150,
      k = o.conductivity ?? 1.5,
      kappa = k / (rho * c),
      Lh = o.latentHeat ?? 3.5e5,
      dphi = o.crystallisation ?? 0.003,
      eps = o.emissivity ?? 0.95,
      Ta = o.airTemperature ?? 288,
      Tsol = o.solidus ?? 1253,
      w = o.width ?? 12,
      step = o.step ?? 5,
      maxLength = o.maxLength ?? 40000,
      stopGz = o.stopGraetz ?? 300,
      crackTime = o.crackTime ?? 60,
      floor = o.crackShare ?? 0.05,
      crackSpeed = o.crackSpeed ?? 0.16,
      hotOffset = o.hotOffset ?? 120,
      Tbase = o.baseTemperature ?? 973,
      baseShare = o.baseCrust ?? 0.1,
      maxWidth = Math.max(o.maxWidth ?? 1000, w),
      share = o.branchShare ?? 0.7,
      hc = 0.0036 * airDensity(o.vent?.[1] ?? 0) * AIR_HEAT * Math.max(wind, 1),
      table = crustTable(o, wind),
      out: LavaPathPoint[] = [],
      drops = new Float64Array(32);
    const { wait, opened, openS } = a;
    let { x, z, T, s, travel, dirX, dirZ, depth, flux: Q } = a,
      y = this.groundAt(x, z),
      lastSplit = a.parent < 0 ? -Infinity : s,
      stop: LavaStop = 'flowing',
      joins: { arm: number; at: number } | undefined,
      // The arm it runs beside (braided, Dietterich and Cashman 2014), whose levee it may not cross, and how far its edge
      // stood clear of that arm's (at most 0) when it came alongside.
      beside = -1,
      edge = 0;
    for (;;) {
      // Steepest descent among 32 directions, never turning back on itself by more than 100 degrees.
      let best = 0,
        bx = 0,
        bz = 0,
        ib = -1;
      const here = height(x, z),
        wide = out.length ? out[out.length - 1]!.width : w;
      for (let i = 0; i < 32; i++) {
        const ang = (i / 32) * 2 * Math.PI,
          dx = Math.sin(ang),
          dz = Math.cos(ang);
        drops[i] =
          ((s > 0 || a.parent >= 0) && dx * dirX + dz * dirZ < -0.17) ||
          // Beside another arm: never further over its levee than where it came alongside.
          (beside >= 0 && join!.gap(beside, x + dx * step, z + dz * step, wide) < edge - 0.1 * step)
            ? -Infinity
            : here - height(x + dx * step, z + dz * step);
        if (drops[i]! > best) {
          best = drops[i]!;
          bx = dx;
          bz = dz;
          ib = i;
        }
      }
      // A new arm leaves along the direction it split to.
      if (a.parent >= 0 && !out.length) {
        const i = Math.round((Math.atan2(dirX, dirZ) / (2 * Math.PI)) * 32 + 32) % 32;
        if (drops[i]! > 0) {
          best = drops[i]!;
          bx = Math.sin((i / 32) * 2 * Math.PI);
          bz = Math.cos((i / 32) * 2 * Math.PI);
          ib = -1;
        }
      }
      let reachStep = step;
      const [eta, tau] = this.rheology(T);
      if (!(best > 0) && out.length) {
        ib = -1;
        // A hollow: the sheet fills it and spills over its lowest rim within 8 steps, if the rim is below its top.
        const fill = here + out[out.length - 1]!.thickness;
        for (let far = 2; far <= 8 && !(best > 0); far *= 2)
          for (let i = 0; i < 32; i++) {
            const ang = (i / 32) * 2 * Math.PI,
              dx = Math.sin(ang),
              dz = Math.cos(ang);
            if (dx * dirX + dz * dirZ < -0.17) continue;
            let rim = -Infinity;
            for (let m = 1; m < far; m++) rim = Math.max(rim, height(x + dx * step * m, z + dz * step * m));
            const drop = here - height(x + dx * step * far, z + dz * step * far);
            if (rim <= fill && drop > best) {
              best = drop;
              bx = dx;
              bz = dz;
              reachStep = step * far;
            }
          }
      }
      const sin = best > 0 ? best / Math.hypot(best, reachStep) : 0;
      if (sin <= 0) {
        stop = 'ponded';
        if (!out.length)
          out.push(
            this.point(
              x,
              y,
              z,
              s,
              travel,
              0,
              binghamThickness(Q / w, 0.001, rho, eta, tau),
              w,
              T,
              eta,
              tau,
              Infinity,
              0,
              wait,
              opened,
            ),
          );
        break;
      }
      // Mass conservation at the vent's depth (Harris and Rowland 2001, eq. 1): Q = w d u, so a sheet that slows widens.
      let h = binghamThickness(Q / w, sin, rho, eta, tau),
        width = w;
      if (!depth && Number.isFinite(h)) depth = h;
      if (depth && maxWidth > w) {
        const ud = binghamSpeed(depth, sin, rho, eta, tau);
        width = ud > 0 ? Math.min(maxWidth, Math.max(w, Q / (depth * ud))) : maxWidth;
        h = width < maxWidth ? depth : binghamThickness(Q / width, sin, rho, eta, tau);
      }
      const u = binghamSpeed(h, sin, rho, eta, tau);
      if (!(u > 0) || !Number.isFinite(h)) {
        stop = 'stalled';
        break;
      }
      const de = (4 * width * h) / (width + 2 * h),
        // Gz = u d_e^2 / (kappa x) (Pinkerton and Sparks 1976, as Harris and Rowland 2009 write it, eq. 7), x from where
        // the lava came into the open: the vent, or the mouth of the tube that fed it on.
        gz = s > openS ? (u * de * de) / (kappa * (s - openS)) : Infinity;
      out.push(this.point(x, y, z, s, travel, u, h, width, T, eta, tau, gz, sin, wait, opened));
      const met = join?.hit(x, z, width, dirX, dirZ, y + h);
      // Alongside another arm and below its levee crest: the two run side by side.
      if (met?.beside) {
        if (beside !== met.arm) edge = Math.min(0, join!.gap(met.arm, x, z, width));
        beside = met.arm;
      } else if (met) {
        joins = { arm: met.arm, at: met.at };
        stop = 'joined';
        break;
      }
      if (gz < stopGz || T <= Tsol) {
        // Cooled: the Graetz rule, or the core at the solidus (Harris and Rowland 2001 stop at the solidus too).
        stop = 'cooled';
        break;
      }
      if (s >= maxLength) {
        stop = 'length';
        break;
      }
      // A split: the best other local maximum of the drop round the circle, 45 degrees or more off the steepest, with a
      // divide between them (a drop under half its own on the shorter arc), at least two widths past the last split.
      if (ib >= 0 && share < 1 && s - lastSplit >= 2 * width) {
        let jb = -1;
        for (let j = 0; j < 32; j++) {
          const dj = drops[j]!,
            sep = Math.min((j - ib + 32) % 32, (ib - j + 32) % 32);
          if (sep < 4 || !(dj >= share * best) || dj < drops[(j + 31) % 32]! || dj < drops[(j + 1) % 32]!) continue;
          const dir = (j - ib + 32) % 32 <= 16 ? 1 : -1;
          let divide = Infinity;
          for (let m = ib; m !== j; m = (m + dir + 32) % 32) divide = Math.min(divide, drops[m]!);
          if (divide < 0.5 * dj && (jb < 0 || dj > drops[jb]!)) jb = j;
        }
        if (jb >= 0) {
          const dj = drops[jb]!,
            part = (Q * dj) / (best + dj),
            ang = (jb / 32) * 2 * Math.PI;
          if (
            branch({
              at: out.length - 1,
              x,
              z,
              T,
              s,
              travel,
              dirX: Math.sin(ang),
              dirZ: Math.cos(ang),
              depth,
              flux: part,
              wait,
              opened,
              openS,
            })
          ) {
            Q -= part;
            lastSplit = s;
          }
        }
      }
      // The core's heat budget over this step (Harris and Rowland 2001): radiation and forced convection from the hot
      // cracks at the core temperature and the crust at its surface temperature, against the heat the flux carries,
      // with the latent heat of the crystals grown (dphi per kelvin) above the solidus.
      // The hot share: the cracks of a crust closing over crackTime, held open by the speed (Harris and Rowland 2001,
      // eq. 8); the hottest lava a little below the core (eq. 9); conduction through the basal crust (their Table 3).
      const surfaceAge = travel - opened,
        open = 1 - (1 - floor) * 0.9 * Math.exp(-crackSpeed * u),
        hot = open + (1 - open) * Math.exp(-surfaceAge / crackTime),
        Thot = Math.max(Ta, T - hotOffset),
        Tsurf = Math.min(lookup(table, table.surface, surfaceAge), Thot),
        q =
          eps * SIGMA * (hot * Thot ** 4 + (1 - hot) * Tsurf ** 4 - Ta ** 4) +
          hc * (hot * (Thot - Ta) + (1 - hot) * (Tsurf - Ta)) +
          (k * Math.max(0, T - Tbase)) / (baseShare * h),
        cEff = c + (T > Tsol ? Lh * dphi : 0);
      T = Math.max(Ta, T - (q * width * reachStep) / (rho * Q * cEff));
      travel += reachStep / u;
      s += reachStep;
      x += bx * reachStep;
      z += bz * reachStep;
      dirX = bx;
      dirZ = bz;
      y = this.groundAt(x, z);
    }
    return { points: out, stop, Q, dirX, dirZ, depth, joins };
  }
  /**
   * The test an arm `k` makes at each step for running into another (Dietterich and Cashman 2014: arms that split
   * rejoin where the ground brings them together): a point of another arm closer than `reach` times their half-widths
   * summed, once the arm has been clear of every other (so a branch does not rejoin where it split), never an arm whose
   * lava already runs into this one. The nearest such point wins. An arm that comes alongside the other, moving within
   * 45 degrees of its way and with its top below the other's levee crest (`leveeMax` over its sheet), runs beside it
   * instead: braided channels kept apart by the levee between them (Dietterich and Cashman 2014).
   */
  private joiner(
    live: readonly SolvedArm[],
    k: number,
    reach: number,
    feeds: (i: number, k: number) => boolean,
  ): Joiner {
    const cells = new Map<string, number[]>(),
      lev = this.options.leveeMax ?? 0.35;
    let wide = 0;
    const others = live.flatMap((a, i) => (i === k || a.gone || a.path.length < 2 || feeds(i, k) ? [] : [i])),
      // A breakout runs beside the stalled stretch it left: it never joins that.
      own = live[k]!.start,
      dead = (i: number, j: number) => own.breakout === true && i === own.parent && j >= own.at;
    for (const i of others) for (const p of live[i]!.path) wide = Math.max(wide, p.width);
    const cell = Math.max(8 * (this.options.step ?? 5), reach * wide),
      key = (cx: number, cz: number) => cx + ',' + cz;
    // Never at an arm's first point: a join solves that arm again from the point before.
    for (const i of others)
      live[i]!.path.forEach((p, j) => {
        if (!j || dead(i, j)) return;
        const id = key(Math.floor(p.position[0] / cell), Math.floor(p.position[2] / cell)),
          list = cells.get(id);
        if (list) list.push(i, j);
        else cells.set(id, [i, j]);
      });
    // The nearest point of another arm (or of arm `only`) whose edge overlaps a sheet `width` wide at (x, z), and by
    // how much its edge stands clear (negative: overlapping).
    const nearest = (
      x: number,
      z: number,
      width: number,
      only = -1,
    ): { arm: number; at: number; gap: number } | undefined => {
      const r = (reach * (width + wide)) / 2,
        cx = Math.floor(x / cell),
        cz = Math.floor(z / cell),
        n = Math.ceil(r / cell);
      let best: { arm: number; at: number; gap: number } | undefined,
        near = Infinity;
      for (let a = cx - n; a <= cx + n; a++)
        for (let b = cz - n; b <= cz + n; b++) {
          const list = cells.get(key(a, b));
          if (list)
            for (let m = 0; m < list.length; m += 2) {
              if (only >= 0 && list[m] !== only) continue;
              const p = live[list[m]!]!.path[list[m + 1]!]!,
                d = Math.hypot(p.position[0] - x, p.position[2] - z),
                gap = d - (reach * (width + p.width)) / 2;
              if (gap < 0 && d < near) {
                near = d;
                best = { arm: list[m]!, at: list[m + 1]!, gap };
              }
            }
        }
      return best;
    };
    let apart = false;
    return {
      hit: (x, z, width, dirX, dirZ, top) => {
        const best = nearest(x, z, width);
        if (!apart) {
          apart = !best;
          return undefined;
        }
        if (!best) return undefined;
        const path = live[best.arm]!.path,
          p = path[best.at]!,
          q = path[Math.max(best.at - 1, 0)]!,
          r = path[Math.min(best.at + 1, path.length - 1)]!,
          tx = r.position[0] - q.position[0],
          tz = r.position[2] - q.position[2],
          len = Math.hypot(tx, tz),
          along = len > 0 && (dirX * tx + dirZ * tz) / len > Math.SQRT1_2;
        return {
          arm: best.arm,
          at: best.at,
          beside: along && lev > 0 && top <= p.position[1] + p.thickness * (1 + lev),
        };
      },
      gap: (arm, x, z, width) => nearest(x, z, width, arm)?.gap ?? Infinity,
    };
  }
  /**
   * The breakout of a front that cooled to a stop while still fed (Hon et al. 1994: a sheet fed under its crust inflates
   * and breaks out at its margins; Hoblitt et al. 2012): the supply spreads under the crust of the sluggish stretch
   * behind the front (Graetz under twice `stopGraetz`, at least one width square), lifting it by Q t / area; at
   * `breakoutHeight` the levee ruptures where the ground one width outside it lies furthest below the flow's top, and
   * all the lava leaves sideways from there as a new arm, its surface fresh and its core the fluid core fed under the
   * crust: the channel's core at the head of the stretch, less only what conducts through the crust on the way. None when the tube behind would feed the front on by `before` (supply seconds), when the supply is
   * spent first, or when that core is below the solidus.
   */
  private breakout(
    points: readonly LavaPathPoint[],
    from: number,
    leg: ArmLeg,
    height: (x: number, z: number) => number,
    before: number,
  ): Omit<ArmStart, 'parent'> | undefined {
    const o = this.options,
      rise = o.breakoutHeight ?? 0,
      n = points.length;
    if (!(rise > 0) || n - from < 2 || !(leg.Q > 0)) return undefined;
    const end = points[n - 1]!,
      slow = 2 * (o.stopGraetz ?? 300);
    let m = n - 1;
    while (m > from && points[m - 1]!.graetz < slow) m--;
    let area = 0;
    for (let i = m; i + 1 < n; i++)
      area += 0.5 * (points[i]!.width + points[i + 1]!.width) * (points[i + 1]!.distance - points[i]!.distance);
    const levee = end.travel + (rise * Math.max(area, end.width * end.width)) / leg.Q,
      roof = this.roofBurst(points, Math.max(area, end.width * end.width), leg.Q),
      tube = !!roof && roof.opened < levee,
      opened = tube ? roof.opened : levee;
    if (!(opened < before) || !(opened < this.supplied(Infinity))) return undefined;
    // Where it leaves: the side of the stretch (or of the burst roof) whose ground one width out lies furthest below the
    // flow's top.
    let best = -Infinity,
      at = -1,
      nx = 0,
      nz = 0;
    for (let i = tube ? roof.at : m; i < (tube ? roof.at + 1 : n); i++) {
      const p = points[i]!,
        q = points[Math.max(i - 1, tube ? 0 : from)]!,
        r = points[Math.min(i + 1, n - 1)]!,
        tx = r.position[0] - q.position[0],
        tz = r.position[2] - q.position[2],
        len = Math.hypot(tx, tz);
      if (!(len > 0)) continue;
      for (const side of [1, -1]) {
        const sx = (-tz / len) * side,
          sz = (tx / len) * side,
          drop = p.position[1] + p.thickness - height(p.position[0] + sx * p.width, p.position[2] + sz * p.width);
        if (drop > best) {
          best = drop;
          at = i;
          nx = sx;
          nz = sz;
        }
      }
    }
    const p = points[at];
    if (!p) return undefined;
    // The lava that breaks out is the fluid core fed under the crust of the inflating stretch: it comes in at the head
    // of the stretch with the heat the channel's budget left it (Harris and Rowland 2001) and loses only what conducts
    // through the crust grown since the front passed (Hon et al. 1994; Keszthelyi 1995), not the stalled lava's. Out of
    // a burst roof it is the tube's own lava.
    let T = tube ? this.tubeProfile(points)[at]! : points[m]!.temperature;
    if (!tube)
      for (let i = m; i < at; i++)
        T = this.covered(
          T,
          points[i]!.width,
          points[i + 1]!.distance - points[i]!.distance,
          leg.Q,
          opened - points[i]!.travel,
        );
    if (!(T > (o.solidus ?? 1253))) return undefined;
    return {
      breakout: true,
      at,
      x: p.position[0] + nx * p.width,
      z: p.position[2] + nz * p.width,
      T,
      s: p.distance + p.width,
      travel: opened,
      dirX: nx,
      dirZ: nz,
      depth: p.thickness,
      flux: leg.Q,
      wait: p.wait + opened - p.travel,
      opened,
      openS: p.distance + p.width,
    };
  }
  /**
   * The roof of the tube behind a stalled front that gives way first, and when (supply seconds), or undefined: the
   * front blocks the tube's outflow, so the supply backs up and the lava's level rises over the front's top as it lifts
   * the sluggish stretch (`area`, Q t / area as for the levee). It fills the tube's head room (Kauahikaua et al. 1998:
   * streams 1 to 2 m deep in tubes about 5 m high; here as high again as the levees over the stream) and presses on
   * each roof below the level by rho g (level - ceiling); a roof d thick (the crust grown since the front passed) over
   * a w wide tube holds rho g d + 2 sigma d^2 / w^2 (a beam clamped at both sides, Turcotte and Schubert 2002, chapter
   * 3). The first roof, closed by then, whose hold the level passes bursts.
   */
  private roofBurst(
    points: readonly LavaPathPoint[],
    area: number,
    Q: number,
  ): { at: number; opened: number } | undefined {
    const o = this.options,
      rho = o.density ?? 2600,
      sigma = o.roofStrength ?? 1e6,
      lev = o.leveeMax ?? 0.35,
      end = points[points.length - 1]!,
      top = end.position[1] + end.thickness;
    let best: { at: number; opened: number } | undefined;
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i]!,
        ceiling = p.position[1] + p.thickness * (1 + lev);
      if (best && ceiling - top > ((best.opened - end.travel) * Q) / area) break;
      // The hold grows with the roof's age while the level rises: the time they meet, by fixed-point passes.
      let opened = end.travel;
      for (let pass = 0, last = -1; pass < 64 && Math.abs(opened - last) > 1e-6; pass++) {
        const d = this.crustThickness(Math.max(0, opened - p.travel)),
          level = ceiling + d + (2 * sigma * d * d) / (p.width * p.width * rho * G);
        last = opened;
        opened = end.travel + (Math.max(0, level - top) * area) / Q;
      }
      if (this.roofAt(p) <= this.supplyTime(opened) && (!best || opened < best.opened)) best = { at: i, opened };
    }
    return best;
  }
  /**
   * Where a front that cooled starts again, fed by a tube: the last point (at or after `from`) whose channel roofs over
   * while the vent feeds it must close before the vent stops, and the tube must bring the lava to the front hotter
   * than the open channel did and above the solidus. The front waits there until that roof closes, then flows on with
   * the tube's lava, its surface fresh and its Graetz length counted from the mouth.
   */
  private runOn(points: readonly LavaPathPoint[], from: number, parent: number, leg: ArmLeg): ArmStart | undefined {
    const n = points.length,
      end = points[n - 1]!;
    let close = Infinity;
    for (let i = n - 1; i >= from && close === Infinity; i--) close = this.roofAt(points[i]!);
    const hot = this.tubeProfile(points)[n - 1]!;
    if (!(close < this.end) || !(hot > end.temperature) || !(hot > (this.options.solidus ?? 1253))) return undefined;
    const opened = Math.max(this.supplied(close), end.travel);
    return {
      parent,
      at: 0,
      x: end.position[0],
      z: end.position[2],
      T: hot,
      s: end.distance,
      travel: opened,
      dirX: leg.dirX,
      dirZ: leg.dirZ,
      depth: leg.depth,
      flux: leg.Q,
      wait: end.wait + opened - end.travel,
      opened,
      openS: end.distance,
    };
  }
  private point(
    x: number,
    y: number,
    z: number,
    s: number,
    travel: number,
    u: number,
    h: number,
    w: number,
    T: number,
    eta: number,
    tau: number,
    gz: number,
    sin: number,
    wait: number,
    opened: number,
  ): LavaPathPoint {
    return {
      position: [x, y, z],
      distance: s,
      travel,
      speed: u,
      thickness: h,
      width: w,
      temperature: T,
      viscosity: eta,
      yieldStrength: tau,
      graetz: gz,
      slope: sin,
      wait,
      opened,
    };
  }
  /**
   * Forgets the solved path and flights: call after the ground under the same `ground` object changed (a sculpted or
   * streamed terrain). A changed option or a new `ground` is seen without it.
   */
  invalidate(): void {
    this.profile = [];
    this.flights.clear();
  }
  /**
   * The arms of the flow, the trunk ({@link path}) first: where the ground offers a second line of descent past a divide
   * the flow splits (Dietterich and Cashman 2014), at most `maxBranches` times, the flux shared by the drops, so the
   * fluxes of the arms that reach the ends always sum to the effusion rate.
   */
  branches(): readonly LavaBranch[] {
    this.path();
    return this.arms;
  }
  /**
   * Why the flow at the full supply stops: 'cooled' (Graetz), 'ponded', 'stalled', 'length' (maxLength), or 'joined'
   * where the trunk ran into one of its own arms, which carries its lava on.
   */
  get stop(): LavaStop {
    this.path();
    return this.stopReason;
  }
  /** Length the flow reaches at the full supply before it stops, metres. */
  get length(): number {
    const p = this.path();
    return p[p.length - 1]!.distance;
  }

  /** Film second the front reaches path point `i` (Infinity if the supply stops first). */
  arrival(i: number): number {
    const p = this.path()[i];
    return p ? this.supplyTime(p.travel) : Infinity;
  }

  /** The front now: how far it has come, where, how fast, and why it stopped. */
  front(t = this.film): LavaFront {
    const p = this.path(),
      supplied = this.supplied(t);
    let i = 0;
    while (i + 1 < p.length && p[i + 1]!.travel <= supplied) i++;
    const a = p[i]!,
      b = p[i + 1],
      f = b ? Math.min(1, (supplied - a.travel) / Math.max(b.travel - a.travel, 1e-9)) : 0,
      lerp = (u: number, v: number) => u + (v - u) * f,
      // Waiting at a cooled stop for the tube behind it to feed it on (a run-on starts at the same place).
      waiting = !!b && b.distance === a.distance,
      flowing = !!b && !waiting && this.envelope(t) > 0 && t >= (this.options.start ?? 0);
    return {
      distance: b ? lerp(a.distance, b.distance) : a.distance,
      position: b
        ? [lerp(a.position[0], b.position[0]), lerp(a.position[1], b.position[1]), lerp(a.position[2], b.position[2])]
        : a.position,
      // A sheet carrying a share e of the flux runs at e^(2/3) of its speed (Jeffreys: h goes as q^(1/3), u as h^2).
      speed: flowing ? a.speed * this.envelope(t) ** (2 / 3) : 0,
      stop: b ? (t >= this.end ? 'supply' : waiting ? 'cooled' : 'flowing') : this.stop,
    };
  }

  /** Huppert's (1982) radius of the pond at the flow's end now, metres (0 unless it ponded). */
  pondRadius(t = this.film): number {
    if (this.stop !== 'ponded') return 0;
    const p = this.path(),
      last = p[p.length - 1]!,
      after = this.supplied(t) - last.travel;
    return after > 0
      ? pondRadius(this.options.effusionRate ?? 20, after, this.options.density ?? 2600, last.viscosity)
      : 0;
  }

  /** Seconds the surface at path point `i` has been open to the air at film time `t` (its crust's age). */
  surfaceAge(i: number, t = this.film): number {
    const p = this.path()[i];
    if (!p) return 0;
    const reached = this.supplyTime(p.travel);
    if (!(t >= reached)) return -1;
    // While the vent feeds it, the surface here is as old as the lava's trip from the vent (or from the mouth of the tube
    // that fed it on); after, it ages on.
    const fedUntil = this.end + p.travel - p.wait;
    return p.travel - p.opened + Math.max(0, t - Math.max(fedUntil, reached));
  }

  /**
   * Core temperature (kelvin) at path point `i` now: the vent's lava as the path carries it while the vent feeds the
   * point, then the middle of a sheet cooling by conduction (Carslaw and Jaeger 1959, a slab with fixed faces, the
   * series summed to 64 terms): its top at the air, its base at the contact temperature of lava and ground, two
   * half-spaces weighted by their effusivities sqrt(k rho c) (Carslaw and Jaeger 1959, section 2.15). The latent heat
   * slows it, spread over the vent temperature to the solidus as an apparent heat capacity.
   */
  coreTemperature(i: number, t = this.film, arm = 0): number {
    const p = this.branches()[arm]?.path[i];
    if (!p) return this.options.airTemperature ?? 288;
    const after = t - (this.end + p.travel - p.wait),
      roof = this.roofTime(i, arm),
      // Inside a tube the lava keeps the heat the roof saves (Keszthelyi 1995).
      T0 = t >= roof ? this.tubeTemperatures(arm)[i]! : p.temperature;
    if (!(after > 0)) return T0;
    return slabCore(this.options, T0, p.thickness, after);
  }

  /**
   * Film second the channel at point `i` roofs over into a tube: `tubeTime` after the front passes, where the slope is
   * under `tubeSlope` and the vent still feeds it then (Infinity where it never does).
   */
  roofTime(i: number, arm = 0): number {
    const p = this.branches()[arm]?.path[i];
    return p ? this.roofAt(p) : Infinity;
  }
  private roofAt(p: LavaPathPoint): number {
    const o = this.options,
      limit = Math.sin(((o.tubeSlope ?? 4) * Math.PI) / 180);
    if (!(p.slope > 0) || !(p.slope < limit)) return Infinity;
    const t = this.supplyTime(p.travel) + (o.tubeTime ?? 86400);
    return t < this.end + p.travel - p.wait ? t : Infinity;
  }
  /** True when point `i` is roofed over at film time `t` (its glow hidden, its core kept hot). */
  tubed(i: number, t = this.film, arm = 0): boolean {
    return t >= this.roofTime(i, arm);
  }

  /**
   * The core's temperature along an arm once its tubes have roofed over, kelvin per path point: in a stretch under
   * `tubeSlope` (roofed once {@link roofTime} passes) the
   * lava loses heat only by conduction, up through a roof as thick as the crust grown in `tubeTime` (k dT / roof) and
   * down into the ground as a half-space heated for `tubeTime` from the lava-ground contact temperature (Carslaw and
   * Jaeger 1959), over the channel's width; open stretches lose what the open channel loses. Keszthelyi (1995) finds
   * about 1 K/km in the Waha'ula tube, Helz et al. (2003) 0.6 K/km in Kupaianaha's; an open channel loses several.
   */
  tubeTemperatures(arm = 0): Float64Array {
    const branch = this.branches()[arm];
    return branch ? this.tubeProfile(branch.path) : new Float64Array(0);
  }
  /**
   * Core temperature (kelvin) of lava at `T` after it runs `length` metres at `flux` m^3/s under a crust grown for `age`
   * seconds, `width` metres across: it loses heat only by conduction, up through the crust (k dT / crust) and down into
   * the ground as a half-space heated for `age` from the lava-ground contact temperature, the two weighted by their
   * effusivities sqrt(k rho c) (Carslaw and Jaeger 1959, section 2.15; Keszthelyi 1995). A roofed tube's lava, and the
   * fluid core an inflating sheet carries under its crust to a breakout (Hon et al. 1994; Helz et al. 2003).
   */
  private covered(T: number, width: number, length: number, flux: number, age: number): number {
    const o = this.options,
      Ta = o.airTemperature ?? 288,
      Tv = o.temperature ?? 1423,
      Tsol = o.solidus ?? 1253,
      rho = o.density ?? 2600,
      k = o.conductivity ?? 1.5,
      kg = o.groundConductivity ?? 1,
      cEff = (o.heatCapacity ?? 1150) + (o.latentHeat ?? 3.5e5) * (o.crystallisation ?? 0.003),
      cLava = (o.heatCapacity ?? 1150) + (Tv > Tsol ? (o.latentHeat ?? 3.5e5) / (Tv - Tsol) : 0),
      eLava = Math.sqrt(k * rho * cLava),
      eGround = Math.sqrt(kg * GROUND_HEAT),
      roof = Math.max(this.crustThickness(age), 0.01),
      groundDepth = Math.sqrt((Math.PI * kg * age) / GROUND_HEAT),
      Tb = (eLava * T + eGround * Ta) / (eLava + eGround),
      loss = width * ((k * (T - Ta)) / roof + (kg * (Tb - Ta)) / groundDepth);
    return Math.max(Ta, T - (loss * length) / (rho * Math.max(flux, 1e-9) * cEff));
  }
  private tubeProfile(p: readonly LavaPathPoint[]): Float64Array {
    // The solve asks while an arm still grows (a run-on), so a profile is kept only for the length it was made at.
    const hit = this.tubeCache.get(p);
    if (hit && hit.length === p.length) return hit;
    const o = this.options,
      Ta = o.airTemperature ?? 288,
      Tv = o.temperature ?? 1423,
      age = o.tubeTime ?? 86400,
      limit = Math.sin(((o.tubeSlope ?? 4) * Math.PI) / 180),
      out = new Float64Array(p.length);
    out[0] = p[0]?.temperature ?? Tv;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1]!,
        b = p[i]!,
        T = out[i - 1]!;
      // A tube's mouth: the front that waited here goes on with the tube's lava.
      if (b.wait > a.wait) out[i] = T;
      else if (a.slope > 0 && a.slope < limit)
        out[i] = this.covered(T, a.width, b.distance - a.distance, a.width * a.thickness * a.speed, age);
      else out[i] = Math.max(Ta, T - (a.temperature - b.temperature));
    }
    this.tubeCache.set(p, out);
    return out;
  }

  /** Share of the surface at point `i` that is hot cracks now (Crisp and Baloga 1990), 0 to 1. */
  crackShare(i: number, t = this.film): number {
    const age = this.surfaceAge(i, t);
    if (age < 0 || this.tubed(i, t)) return 0;
    // While fed, the cracks a moving crust keeps open: the crust covers (1 - crackShare) 0.9 exp(-crackSpeed u) of
    // the surface (Harris and Rowland 2001, eq. 8, with crackShare's cracks in it).
    const o = this.options,
      u = this.path()[i]?.speed ?? 0,
      floor = this.envelope(t) > 0 ? 1 - (1 - (o.crackShare ?? 0.05)) * 0.9 * Math.exp(-(o.crackSpeed ?? 0.16) * u) : 0;
    return floor + (1 - floor) * Math.exp(-age / (this.options.crackTime ?? 60));
  }

  /**
   * Levee height over the sheet at path point `i` now, as a share of the sheet's thickness, 0 to `leveeMax`. The margins
   * the front leaves behind stop moving and cool; a Bingham sheet holds still where it is thinner than Hulme's (1974)
   * h_c = tau / (rho g sin theta), so the levee stands as high as h_c at the yield strength (Dragoni 1989) of its crust,
   * whose mean temperature is halfway between its surface (the crust solve) and the crust's base: it rises as the crust
   * cools, higher on gentle slopes, never above `leveeMax` of the sheet.
   */
  leveeShare(i: number, t = this.film, arm = 0): number {
    const p = this.branches()[arm]?.path[i],
      o = this.options;
    if (!p) return 0;
    const age = t - this.supplyTime(p.travel);
    if (!(age >= 0)) return 0;
    const max = o.leveeMax ?? 0.35;
    if (!(p.slope > 0)) return max;
    const Tm = 0.5 * (this.surfaceTemperature(age) + Math.min(o.crustTemperature ?? 1343, p.temperature)),
      hc = this.rheology(Tm)[1] / ((o.density ?? 2600) * G * p.slope);
    return max * Math.min(1, hc / p.thickness);
  }

  /** The glow of the surface at path point `i` now: [r, g, b] linear sRGB radiance in engine units (sun's white 1), times `glow`. */
  radiance(i: number, t = this.film): [number, number, number] {
    const age = this.surfaceAge(i, t),
      p = this.path()[i];
    if (age < 0 || !p) return [0, 0, 0];
    const f = this.crackShare(i, t),
      core = lavaGlow(this.coreTemperature(i, t)),
      crust = lavaGlow(this.surfaceTemperature(age)),
      scale = (this.options.glow ?? 1) / SUN_LUMINANCE;
    return [0, 1, 2].map((c) => (f * core[c]! + (1 - f) * crust[c]!) * scale) as [number, number, number];
  }

  /**
   * The flow now as a `LavaEvent` for `@margoengine/terrain/ground-change`: the path (about `points` of it, keeping both points where a front waited for a tube), the front's
   * arrival times, widths, thicknesses, the core's glow (its luminance over the vent's) and the levees as they stand at
   * film time `t` ({@link leveeShare}). Set it each frame to grow the levees, or once for levees fixed at `t`.
   * @example change.clear(); change.add(lava.lavaEvent());
   */
  lavaEvent(points = 256, t = this.film, arm = 0): LavaGroundEvent {
    const arms = this.branches(),
      branch = arms[arm];
    if (!branch) throw new RangeError(`LavaFlow has no arm ${arm}; branches() lists ${arms.length}`);
    const p = branch.path,
      vent = lavaGlow(this.options.temperature ?? 1423)[3],
      out: LavaGroundEvent = {
        kind: 'lava',
        path: [],
        arrival: [],
        widths: [],
        thicknesses: [],
        glows: [],
        levees: [],
        roofs: [],
        drains: [],
        skylights: this.options.skylightSpacing ?? 200,
        cooling: 1,
        seed: this.options.seed ?? 1,
      },
      total = this.supplied(Infinity);
    // The points the supply ever brings the front to, plus the first it does not (cut off below).
    let reach = 1;
    while (reach < p.length && p[reach - 1]!.travel <= total) reach++;
    const stride = Math.max(1, Math.ceil(reach / Math.max(2, points)));
    for (let i = 0; i < reach; i++)
      // Every stride-th point, the last, and both points where a front waited for a tube (its stop holds still).
      if (!(i % stride) || i === reach - 1 || p[i + 1]?.wait !== p[i]!.wait || (i > 0 && p[i - 1]!.wait !== p[i]!.wait))
        this.eventPoint(out, p, i, vent, t, arm);
    if (out.path.length < 2) {
      // A flow that ponded at its vent: a short stub so the event is valid.
      const a = p[0]!;
      out.path.push([a.position[0] + 0.5, a.position[2]]);
      out.arrival.push(out.arrival[0]!);
      out.widths.push(out.widths[0]!);
      out.thicknesses.push(out.thicknesses[0]!);
      out.glows.push(out.glows[0]!);
      out.levees.push(out.levees[0]!);
      out.roofs.push(out.roofs[0]!);
      out.drains.push(out.drains[0]!);
    }
    // A front the supply never brings: the event ends at the last point it reaches.
    let n = out.arrival.findIndex((a) => !Number.isFinite(a));
    if (n === 0) n = 1;
    if (n > 0) {
      const last = Math.max(out.arrival[n - 1]!, 0);
      for (const key of ['path', 'arrival', 'widths', 'thicknesses', 'glows', 'levees', 'roofs', 'drains'] as const)
        out[key].length = Math.max(n, 2);
      for (let i = 0; i < out.arrival.length; i++) if (!Number.isFinite(out.arrival[i]!)) out.arrival[i] = last;
    }
    // A flow that ponded fills a pond at its end with what the supply brings past it: the full rate from the front's
    // arrival there for the rest of the supplied seconds, so its radius is pondRadius() while the vent runs at full rate.
    const end = p[p.length - 1]!,
      left = total - end.travel;
    if (branch.stop === 'ponded' && reach === p.length && left > 0) {
      const start = this.supplyTime(end.travel),
        // What reaches the end of this arm: its flux less the branches that left it, plus the arms that ran into it.
        flux = this.endFlux(arm);
      out.pond = {
        center: [end.position[0], end.position[2]],
        start,
        end: start + left,
        flux,
        viscosity: end.viscosity,
        density: this.options.density ?? 2600,
      };
    }
    return out;
  }
  /**
   * Lava reaching the end of arm `arm` at the full supply, m^3/s: its flux, less the branches that split off it, plus
   * what reaches the end of each arm that ran into it. Over the arms that do not end `joined` these sum to the
   * effusion rate.
   */
  endFlux(arm = 0): number {
    const arms = this.branches();
    if (!arms[arm]) throw new RangeError(`LavaFlow has no arm ${arm}; branches() lists ${arms.length}`);
    const end = (k: number): number =>
      // An arm can split off this one and run back into it: both terms then count.
      arms.reduce((f, b, i) => f - (b.parent === k ? b.flux : 0) + (b.joins?.arm === k ? end(i) : 0), arms[k]!.flux);
    return end(arm);
  }
  /** One `LavaEvent` per arm of the flow ({@link branches}), the trunk first: `lavaEvent(points, t, k)` for each. */
  lavaEvents(points = 256, t = this.film): LavaGroundEvent[] {
    return this.branches().map((_, k) => this.lavaEvent(points, t, k));
  }
  private eventPoint(
    out: LavaGroundEvent,
    p: readonly LavaPathPoint[],
    i: number,
    vent: number,
    t: number,
    arm: number,
  ): void {
    const a = p[i]!;
    out.path.push([a.position[0], a.position[2]]);
    out.arrival.push(this.supplyTime(a.travel));
    out.widths.push(a.width);
    out.thicknesses.push(Math.min(a.thickness, 1000));
    out.glows.push(vent > 0 ? Math.min(1, lavaGlow(a.temperature)[3] / vent) : 0);
    out.levees.push(this.leveeShare(i, t, arm));
    out.roofs.push(Math.min(this.roofTime(i, arm), 1e9));
    out.drains.push(Math.min(Math.max(this.end + a.travel - a.wait, 0), 1e9));
  }

  /** Fountain height now, metres: `fountainHeight` while the vent runs at full supply, shrinking with it. */
  fountain(t = this.film): number {
    return (this.options.fountainHeight ?? 40) * this.envelope(t) ** 2;
  }

  private airKey(): string {
    const o = this.options,
      [wx, wz] = this.windNow();
    return [o.drag ?? 0.8, o.bombDensity ?? 2500, o.density ?? 2600, wx, wz, o.vent?.join()].join();
  }
  /**
   * The flight of a clot or bomb launched at `launch` with velocity v and diameter `size`: fourth-order Runge-Kutta in
   * FLIGHT_STEP steps, gravity and quadratic drag against the wind through the ICAO air (Mastin 2001), until it meets the
   * ground or 300 s pass.
   */
  private fly(id: string, launch: number, v: [number, number, number], size: number, density: number): Flight {
    const hit = this.flights.get(id);
    if (hit) return hit;
    const o = this.options,
      vent = o.vent ?? [0, 0, 0],
      [wx, wz] = this.windNow(),
      cd = o.drag ?? 0.8,
      area = (Math.PI * size * size) / 4,
      mass = (density * Math.PI * size ** 3) / 6,
      kd = (0.5 * cd * area) / mass,
      accel = (p: number[], out: number[]) => {
        const rx = p[3] - wx,
          ry = p[4],
          rz = p[5] - wz,
          sp = Math.hypot(rx, ry, rz),
          f = kd * airDensity(p[1]) * sp;
        out[0] = p[3];
        out[1] = p[4];
        out[2] = p[5];
        out[3] = -f * rx;
        out[4] = -G - f * ry;
        out[5] = -f * rz;
      };
    const path: number[] = [vent[0], vent[1], vent[2]];
    let p = [vent[0], vent[1], vent[2], v[0], v[1], v[2]],
      flight = 300,
      impact = 0;
    const k1 = [0, 0, 0, 0, 0, 0],
      k2 = [0, 0, 0, 0, 0, 0],
      k3 = [0, 0, 0, 0, 0, 0],
      k4 = [0, 0, 0, 0, 0, 0],
      tmp = [0, 0, 0, 0, 0, 0],
      dt = FLIGHT_STEP;
    for (let step = 1; step * dt <= 300; step++) {
      accel(p, k1);
      for (let i = 0; i < 6; i++) tmp[i] = p[i] + 0.5 * dt * k1[i];
      accel(tmp, k2);
      for (let i = 0; i < 6; i++) tmp[i] = p[i] + 0.5 * dt * k2[i];
      accel(tmp, k3);
      for (let i = 0; i < 6; i++) tmp[i] = p[i] + dt * k3[i];
      accel(tmp, k4);
      const next = p.map((q, i) => q + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
      const g = this.groundAt(next[0], next[2]);
      if (next[4] < 0 && next[1] <= g) {
        // Land where the height above the ground crosses zero within the step: positions on the cubic Hermite of the two
        // ends' positions and velocities (exact under gravity alone), velocities linear between them, the ground linear.
        const g0 = this.groundAt(p[0], p[2]),
          herm = (i: number, f: number) => {
            const f2 = f * f,
              f3 = f2 * f;
            return (
              (2 * f3 - 3 * f2 + 1) * p[i] +
              (f3 - 2 * f2 + f) * dt * p[i + 3] +
              (-2 * f3 + 3 * f2) * next[i] +
              (f3 - f2) * dt * next[i + 3]
            );
          },
          above = (f: number) => herm(1, f) - (g0 + (g - g0) * f);
        let lo = 0,
          hi = 1;
        for (let it = 0; it < 60; it++) {
          const mid = 0.5 * (lo + hi);
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        const f = 0.5 * (lo + hi);
        flight = (step - 1 + f) * dt;
        const lx = herm(0, f),
          lz = herm(2, f);
        path.push(lx, this.groundAt(lx, lz), lz);
        impact = Math.hypot(...[3, 4, 5].map((i) => p[i] + (next[i] - p[i]) * f));
        break;
      }
      p = next;
      path.push(p[0], p[1], p[2]);
    }
    const f: Flight = { launch, size, mass, path: Float64Array.from(path), flight, impact, speed: Math.hypot(...v) };
    this.flights.set(id, f);
    return f;
  }
  private where(f: Flight, age: number): [number, number, number] {
    const a = Math.min(age, f.flight) / FLIGHT_STEP,
      i = Math.min(Math.floor(a), f.path.length / 3 - 1),
      j = Math.min(i + 1, f.path.length / 3 - 1),
      span = j > i ? Math.min(1, age >= f.flight ? 1 : a - i) : 0,
      p = f.path;
    return [0, 1, 2].map((c) => p[i * 3 + c]! + (p[j * 3 + c]! - p[i * 3 + c]!) * span) as [number, number, number];
  }
  private freshCache(): void {
    const key = this.airKey();
    if (key !== this.flightKey || this.flightGround !== this.options.ground) {
      this.flights.clear();
      this.flightKey = key;
      this.flightGround = this.options.ground;
    }
    if (this.flights.size > 20000) this.flights.clear();
  }

  /**
   * The fountain's clots in the air now (each a function of its index and film time): launched at `clotRate` per second
   * scaled by the supply, with speeds up to sqrt(2 g H) (Wilson and Head 1981) within `fountainSpread`, lognormal
   * sizes about `clotSize`, slowed by drag and carried by the wind, glowing at their surface temperature.
   */
  clots(t = this.film): LavaBlob[] {
    const o = this.options,
      H = o.fountainHeight ?? 40,
      rate = o.clotRate ?? 80,
      out: LavaBlob[] = [];
    if (!(H > 0) || !(rate > 0)) return out;
    this.freshCache();
    const U = Math.sqrt(2 * G * H),
      spread = ((o.fountainSpread ?? 8) * Math.PI) / 180,
      seed = o.seed ?? 1,
      window = (2 * U) / G + 2,
      first = Math.max(0, Math.floor((t - window) * rate)),
      last = Math.floor(t * rate);
    for (let n = first; n <= last; n++) {
      const launch = (n + unit(n, seed, 11)) / rate;
      if (launch > t) continue;
      const e = this.envelope(launch);
      // Thinned by the supply: a clot flies only where its hashed share is under the envelope.
      if (!(unit(n, seed, 13) < e)) continue;
      const speed = U * e * Math.sqrt(0.5 + 0.5 * unit(n, seed, 17)),
        tilt = spread * Math.sqrt(unit(n, seed, 19)),
        az = 2 * Math.PI * unit(n, seed, 23),
        size = (o.clotSize ?? 0.08) * Math.exp(0.5 * normal(n, seed, 29)),
        f = this.fly(
          `c${n}`,
          launch,
          [speed * Math.sin(tilt) * Math.sin(az), speed * Math.cos(tilt), speed * Math.sin(tilt) * Math.cos(az)],
          size,
          (o.density ?? 2600) * 0.4,
        ),
        age = t - launch;
      if (age > f.flight) continue;
      out.push(this.blob(f, age, false));
    }
    return out;
  }
  private blob(f: Flight, age: number, landed: boolean): LavaBlob {
    const T = this.surfaceTemperature(age),
      g = lavaGlow(T),
      scale = (this.options.glow ?? 1) / SUN_LUMINANCE;
    return {
      position: this.where(f, age),
      size: f.size,
      temperature: T,
      color: [g[0] * scale, g[1] * scale, g[2] * scale],
      landed,
    };
  }

  private burst(b: number, k: number): { id: string; launch: number; v: [number, number, number]; size: number } {
    const o = this.options,
      seed = o.seed ?? 1,
      rate = (o.bombRate ?? 2) / 60,
      launch = (b + unit(b, seed, 31)) / rate,
      speed = (o.bombSpeed ?? 80) * Math.exp(0.25 * normal(b * 977 + k, seed, 37)),
      spread = ((o.bombSpread ?? 30) * Math.PI) / 180,
      tilt = spread * Math.sqrt(unit(b * 977 + k, seed, 41)),
      az = 2 * Math.PI * unit(b * 977 + k, seed, 43);
    return {
      id: `b${b}:${k}`,
      launch,
      v: [speed * Math.sin(tilt) * Math.sin(az), speed * Math.cos(tilt), speed * Math.sin(tilt) * Math.cos(az)],
      size: (o.bombSize ?? 0.4) * Math.exp(0.6 * normal(b * 977 + k, seed, 47)),
    };
  }
  /** Each bomb burst's index range whose bombs may still be in the air or lying glowing at film time `t`. */
  private bursts(t: number): [number, number] {
    const o = this.options,
      rate = (o.bombRate ?? 2) / 60;
    if (!(rate > 0)) return [0, -1];
    const reach = 300 + (o.bombLife ?? 600);
    return [Math.max(0, Math.floor((t - reach) * rate) - 1), Math.floor(t * rate)];
  }
  private bombLive(b: number, launch: number): boolean {
    // A burst fires while the vent is active, its chance the supply share at its time.
    return launch >= (this.options.start ?? 0) && unit(b, this.options.seed ?? 1, 53) < this.envelope(launch);
  }

  /** The bombs now: in flight, or landed and cooling for `bombLife` seconds. */
  bombs(t = this.film): LavaBlob[] {
    const o = this.options,
      out: LavaBlob[] = [],
      [b0, b1] = this.bursts(t),
      per = o.bombsPerBurst ?? 12,
      life = o.bombLife ?? 600;
    this.freshCache();
    for (let b = b0; b <= b1; b++)
      for (let k = 0; k < per; k++) {
        const s = this.burst(b, k);
        if (s.launch > t || !this.bombLive(b, s.launch)) continue;
        const f = this.fly(s.id, s.launch, s.v, s.size, o.bombDensity ?? 2500),
          age = t - s.launch;
        if (age > f.flight + life) continue;
        out.push(this.blob(f, age, age >= f.flight));
      }
    return out;
  }

  /** Bombs that land after film second `from` up to `to`, in time order (for dust, sound and ground marks). */
  impacts(from: number, to: number): LavaImpact[] {
    const o = this.options,
      out: LavaImpact[] = [],
      [b0] = this.bursts(from),
      [, b1] = this.bursts(to),
      per = o.bombsPerBurst ?? 12;
    this.freshCache();
    for (let b = b0; b <= b1; b++)
      for (let k = 0; k < per; k++) {
        const s = this.burst(b, k);
        if (s.launch > to || !this.bombLive(b, s.launch)) continue;
        const f = this.fly(s.id, s.launch, s.v, s.size, o.bombDensity ?? 2500),
          at = s.launch + f.flight;
        if (at > from && at <= to && f.impact > 0)
          out.push({
            time: at,
            position: this.where(f, f.flight),
            speed: f.impact,
            mass: f.mass,
            launch: s.launch,
            launchSpeed: f.speed,
          });
      }
    return out.sort((a, b) => a.time - b.time);
  }
  /** The impacts since the last call (or since a seek back): call once a frame after `update`. */
  takeImpacts(): LavaImpact[] {
    const from = this.impactsFrom;
    this.impactsFrom = this.film;
    return from < this.film ? this.impacts(from, this.film) : [];
  }

  /** Writes the clots into `target` (a gltf `PBRInstances`: sphere instances with a 'basic' material show the glow). */
  drawClots(target: LavaInstanceTarget): number {
    return this.draw(target, this.clots());
  }
  /** Writes the bombs into `target` (as {@link drawClots}). */
  drawBombs(target: LavaInstanceTarget): number {
    return this.draw(target, this.bombs());
  }
  private draw(target: LavaInstanceTarget, blobs: LavaBlob[]): number {
    const n = Math.min(blobs.length, target.capacity),
      m = new Float32Array(16);
    for (let i = 0; i < n; i++) {
      const b = blobs[i]!;
      m.fill(0);
      m[0] = m[5] = m[10] = b.size / 2;
      m[12] = b.position[0];
      m[13] = b.position[1] + (b.landed ? b.size / 4 : 0);
      m[14] = b.position[2];
      m[15] = 1;
      target.setMatrixAt(i, m);
      target.setColorAt(i, b.color);
    }
    target.count = n;
    return n;
  }

  /**
   * The glow as point lights (at most `max`): one over the vent and fountain, the rest along the reached flow in equal
   * stretches, each at its stretch's glow-weighted centre a few metres up, its colour the glow's and its intensity the
   * glowing area times its radiance (engine units: candela over the 100,000 lux sun), times `glow`.
   */
  glowLights(max = this.options.maxLights ?? 8): LavaLight[] {
    const o = this.options,
      t = this.film,
      range = o.lightRange ?? 400,
      out: LavaLight[] = [];
    if (max <= 0 || t < (o.start ?? 0)) return out;
    const scale = (o.glow ?? 1) / 1e5,
      vent = o.vent ?? [0, 0, 0],
      push = (x: number, y: number, z: number, rgb: number[], cd: number) => {
        const peak = Math.max(rgb[0]!, rgb[1]!, rgb[2]!);
        if (peak > 0 && cd * scale > 1e-9)
          out.push({
            position: [x, y, z],
            color: [rgb[0]! / peak, rgb[1]! / peak, rgb[2]! / peak],
            intensity: cd * scale,
            range,
            decay: 2,
          });
      };
    const H = this.fountain(t);
    if (H > 0) {
      // The fountain as a glowing column about H tall and H / 3 wide at the vent temperature, its clots filling a third of it.
      const g = lavaGlow(o.temperature ?? 1423),
        area = (H * H) / 9;
      push(vent[0], vent[1] + H / 2, vent[2], [g[0], g[1], g[2]], g[3] * area);
    }
    const p = this.path(),
      reached = this.front(t).distance;
    let count = 0;
    while (count < p.length && p[count]!.distance <= reached) count++;
    const slots = Math.max(0, max - out.length);
    if (!slots || count === 0) return out;
    const per = Math.ceil(count / slots);
    for (let s0 = 0; s0 < count; s0 += per) {
      let wx = 0,
        wy = 0,
        wz = 0,
        r = 0,
        g = 0,
        b = 0,
        cd = 0;
      for (let i = s0; i < Math.min(count, s0 + per); i++) {
        const q = p[i]!,
          rad = this.radiance(i, t),
          lum = (0.2126 * rad[0] + 0.7152 * rad[1] + 0.0722 * rad[2]) * SUN_LUMINANCE,
          area = q.width * (o.step ?? 5);
        r += rad[0] * area;
        g += rad[1] * area;
        b += rad[2] * area;
        const weight = lum * area;
        cd += weight;
        wx += q.position[0] * weight;
        wy += (q.position[1] + q.thickness + 3) * weight;
        wz += q.position[2] * weight;
      }
      if (cd > 0) push(wx / cd, wy / cd, wz / cd, [r, g, b], cd / (o.glow ?? 1) || 0);
    }
    return out.slice(0, max);
  }
}

/** One accepted X-fast lava grid in a local rendering cell. No solver dependency is needed to read the frame. */
export interface LavaGridFrame {
  /** Arena containing the currently accepted field. */
  readonly memory: WebAssembly.Memory;
  /** Layout-1 f64 rows of depth, bulk and skin temperature, crust, discharge, surface altitude and enthalpy. */
  readonly region: {
    readonly type: string;
    readonly layout: number;
    readonly byteOffset: number;
    readonly byteLength: number;
  };
  /** X and Z cell counts. */
  readonly cells: readonly [number, number];
  /** Width of each square cell, in metres. */
  readonly spacing: number;
  /** Lower XZ corner in metres, before the optional cell translation. */
  readonly origin: readonly [number, number];
  /** Translation into the camera's origin cell, in metres. Defaults to zero. */
  readonly offset?: readonly [number, number, number];
}

/** Settings for a view of the accepted, time-stepped lava grid. */
export interface LavaSurfaceOptions {
  /** Supplies the latest accepted frame before each draw, or undefined to clear the surface. */
  readonly source: () => LavaGridFrame | undefined;
  /** Film appearance multiplier on skin radiance. Default 1. */
  readonly glow?: number;
  /** Unique plugin name when drawing several patches in a scene. Default 'weather:lava-surface'. */
  readonly name?: string;
}

type LavaPass = Extract<PassContext, { backend: 'webgpu' }>;
const LAVA_GRID_WORDS = 8;
const GRID_SHADER = `
${displayShader}
struct LavaFrame {
  camera: mat4x4f,
  grid: vec4f,
  cells: vec4u,
  sun: vec4f,
  radiance: vec4f,
  ambient: vec4f,
}
struct LavaTile { heightWetCrust: vec4f, glow: vec4f }
@group(0) @binding(0) var<uniform> lava: LavaFrame;
@group(0) @binding(1) var<storage, read> tile: array<LavaTile>;

struct SurfaceVertex {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) emission: vec3f,
  @location(2) @interpolate(flat) crust: f32,
}
const corners = array<vec2i, 6>(
  vec2i(0, 0), vec2i(0, 1), vec2i(1, 0),
  vec2i(1, 0), vec2i(0, 1), vec2i(1, 1),
);

fn elevation(cell: vec2i) -> f32 {
  let at = vec2u(clamp(cell, vec2i(0), vec2i(lava.cells.xy) - vec2i(1)));
  return tile[at.x + at.y * lava.cells.x].heightWetCrust.x;
}

@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) index: u32) -> SurfaceVertex {
  let state = tile[index].heightWetCrust;
  if (state.y <= 0.0) {
    return SurfaceVertex(vec4f(2, 2, 2, 1), vec3f(0), vec3f(0), 0.0);
  }
  let cell = vec2i(i32(index % lava.cells.x), i32(index / lava.cells.x));
  let point = cell + corners[vertexIndex];
  let xz = lava.grid.xy + vec2f(point) * lava.grid.z;
  // A shared corner has the same elevation for either neighbouring cell.
  let height = 0.25 * (elevation(point) + elevation(point - vec2i(1, 0)) +
                      elevation(point - vec2i(0, 1)) + elevation(point - vec2i(1, 1)));
  let world = vec3f(xz.x, height, xz.y);
  return SurfaceVertex(lava.camera * vec4f(world, 1), world, tile[index].glow.rgb, state.z);
}

@fragment fn fragment(i: SurfaceVertex) -> @location(0) vec4f {
  let crossed = cross(dpdx(i.world), dpdy(i.world));
  let upward = crossed * select(-1.0, 1.0, crossed.y >= 0.0);
  let n = upward / max(length(upward), 1e-15);
  // The writer uploads the unit direction (unitLight): a normalize of a uniform-only value can differ by an ulp
  // between frames on some drivers.
  let sun = lava.sun.xyz;
  let light = lava.ambient.xyz * lava.radiance.w +
    (max(dot(n, sun), 0.0) * lava.sun.w / 3.14159265) * lava.radiance.rgb;
  // Visual diffuse reflectance of exposed and crusted basalt; emission comes only from the accepted skin.
  let basalt = mix(vec3f(0.077, 0.051, 0.038), vec3f(0.047, 0.042, 0.039), i.crust);
  let colour = basalt * light + i.emission;
  return vec4f(select(toDisplay(colour), colour, lava.grid.w > 0.5), 1);
}
`;

function finiteLavaVector(values: ArrayLike<number> | undefined, count: number): boolean {
  if (values?.length !== count) return false;
  for (let i = 0; i < count; i++) {
    if (typeof values[i] !== 'number' || !Number.isFinite(values[i])) return false;
  }
  return true;
}

/**
 * Draws the published EARTH-10 surface over terrain, on WebGPU or its WebGL2 compatibility layer.
 * Advance or restore the physics world before drawing. The shader uses the accepted skin temperature
 * for thermal emission and the accepted crust depth for diffuse shading. It leaves dry cells to the terrain.
 */
export class LavaSurface implements EnginePlugin {
  readonly name: string;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private storage?: GPUBuffer;
  private bind?: GPUBindGroup;
  private pipeline?: GPURenderPipeline;
  private pipelineKey = '';
  private data = new Float32Array(0);
  private readonly values = new Float32Array(36);
  private readonly cells = new Uint32Array(this.values.buffer, 20 * Float32Array.BYTES_PER_ELEMENT, 2);
  private disposed = false;

  constructor(readonly options: LavaSurfaceOptions) {
    if (typeof options?.source !== 'function')
      throw new MargoError('state', 'Give LavaSurface a callback that reads the accepted lava grid.');
    if (
      options.glow !== undefined &&
      !(typeof options.glow === 'number' && options.glow >= 0 && Number.isFinite(Math.fround(options.glow)))
    )
      throw new MargoError('state', 'Give LavaSurface a finite nonnegative glow multiplier.');
    const name = options.name ?? 'weather:lava-surface';
    if (typeof name !== 'string' || !name.trim())
      throw new MargoError('state', 'Give each LavaSurface a nonempty plugin name.');
    this.name = name;
  }

  /** Attaches the surface to the rendering engine. */
  static attach(engine: EngineKernel, options: LavaSurfaceOptions): LavaSurface {
    const surface = new LavaSurface(options);
    engineRuntime(engine).use(surface);
    return surface;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'This LavaSurface was disposed. Attach a new lava surface.');
    // The small WebGL2 preview has no frame-graph draw for the surface: refuse it so /auto escalates to WebGPU (or to
    // the WebGL2 compatibility layer, which runs the WebGPU pass).
    requireWebGPU(engine, 'LavaSurface');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':draw',
      order: 1.5,
      execute: (context) => {
        if (context.backend === 'webgpu' && (context.view?.layers === undefined || context.view.layers & 1))
          this.draw(context);
      },
    });
  }

  private pack(context: LavaPass, frame: LavaGridFrame): number {
    const { memory, region, cells, spacing, origin, offset = [0, 0, 0] } = frame;
    if (
      !finiteLavaVector(cells, 2) ||
      !(Number.isSafeInteger(cells[0]) && cells[0] > 0 && Number.isSafeInteger(cells[1]) && cells[1] > 0) ||
      !finiteLavaVector(origin, 2) ||
      !finiteLavaVector(offset, 3) ||
      !(spacing > 0 && Number.isFinite(spacing))
    )
      throw new MargoError(
        'state',
        'Give LavaSurface positive grid dimensions and spacing, a finite origin and a finite cell translation.',
      );
    const [nx, nz] = cells;
    const count = nx * nz;
    const words = count * LAVA_GRID_WORDS;
    const bytes = words * Float32Array.BYTES_PER_ELEMENT;
    const limits = context.device.limits;
    if (!Number.isSafeInteger(count) || bytes > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize))
      throw new MargoError('state', 'The lava grid exceeds render device storage. Divide it into smaller patches.');
    const f64 = Float64Array.BYTES_PER_ELEMENT;
    if (
      !(memory instanceof WebAssembly.Memory) ||
      region?.type !== 'f64' ||
      region.layout !== 1 ||
      !Number.isSafeInteger(region.byteOffset) ||
      region.byteOffset < 0 ||
      region.byteOffset % f64 !== 0 ||
      region.byteLength !== words * f64 ||
      region.byteLength > memory.buffer.byteLength - region.byteOffset
    )
      throw new MargoError('state', 'Read LavaSurface from the live layout-1 f64 lava grid.');

    const x = origin[0] + offset[0];
    const z = origin[1] + offset[2];
    const edgeX = x + nx * spacing;
    const edgeZ = z + nz * spacing;
    if (
      ![x, z, edgeX, edgeZ, spacing].every((value) => Number.isFinite(Math.fround(value))) ||
      Math.fround(x + spacing) === Math.fround(x) ||
      Math.fround(z + spacing) === Math.fround(z) ||
      Math.fround(edgeX - spacing) === Math.fround(edgeX) ||
      Math.fround(edgeZ - spacing) === Math.fround(edgeZ)
    )
      throw new MargoError('state', 'The lava grid has no float32 cell resolution. Use a nearer rendering cell.');

    const rows = new Float64Array(memory.buffer, region.byteOffset, words);
    if (this.data.length !== words) this.data = new Float32Array(words);
    const data = this.data;
    const gain = (this.options.glow ?? 1) / SUN_LUMINANCE;
    let flowing = false;
    for (let at = 0; at < words; at += LAVA_GRID_WORDS) {
      const depth = rows[at]!;
      const skin = rows[at + 2]!;
      const crust = rows[at + 3]!;
      const elevation = rows[at + 6]! + offset[1];
      if (
        !(
          depth >= 0 &&
          Number.isFinite(depth) &&
          skin > 0 &&
          Number.isFinite(skin) &&
          crust >= 0 &&
          crust <= depth &&
          Number.isFinite(Math.fround(elevation))
        )
      )
        throw new MargoError(
          'state',
          'LavaSurface received invalid cells. Publish finite depths, skin temperatures, crust and elevations.',
        );
      data[at] = elevation;
      data[at + 1] = depth > 0 ? 1 : 0;
      if (depth === 0) continue;
      data[at + 2] = crust / depth;
      const glow = lavaGlow(skin);
      for (let channel = 0; channel < 3; channel++) {
        const radiance = glow[channel]! * gain;
        if (!Number.isFinite(Math.fround(radiance)))
          throw new MargoError(
            'state',
            'The lava skin radiance exceeds its render range. Reduce the glow or skin temperature.',
          );
        data[at + 4 + channel] = radiance;
      }
      flowing = true;
    }
    if (!flowing) return 0;
    this.values.set([x, z, spacing, +linearHdr(context.format)], 16);
    this.cells[0] = nx;
    this.cells[1] = nz;
    return count;
  }

  private draw(context: LavaPass): void {
    const frame = this.options.source();
    if (!frame || !this.engine || !this.uniform) return;
    const count = this.pack(context, frame);
    if (!count) return;
    const device = context.device;
    const depth = context.descriptor.depthStencil?.format;
    if (!depth) throw new MargoError('unsupported', 'Give the lava surface a render target with a depth attachment.');

    const bytes = this.data.byteLength;
    if (!this.storage || this.storage.size !== bytes) {
      this.storage?.destroy();
      this.storage = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.bind = undefined;
    }
    const key = context.format + ':' + depth + ':' + context.descriptor.multisample?.count;
    if (key !== this.pipelineKey) {
      const module = device.createShaderModule({ code: GRID_SHADER });
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: context.format }] },
        depthStencil: { format: depth, depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: context.descriptor.multisample,
      });
      this.pipelineKey = key;
      this.bind = undefined;
    }
    this.bind ??= device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.storage } },
      ],
    });

    const light = this.engine.sceneOf(this)?.lighting ?? this.engine.lighting;
    this.values.set(context.camera.matrix, 0);
    unitLight(this.values, 24, light.direction);
    this.values.set(light.radiance, 28);
    this.values.set(light.ambient, 32);
    device.queue.writeBuffer(this.uniform, 0, this.values);
    device.queue.writeBuffer(this.storage, 0, this.data);
    const pass = context.encoder.beginRenderPass({
      colorAttachments: [{ view: context.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: context.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(depth.includes('stencil') ? { stencilReadOnly: true } : {}),
      },
    });
    applyView(pass, context);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bind);
    pass.draw(6, count);
    pass.end();
  }

  private release(): void {
    this.uniform?.destroy();
    this.storage?.destroy();
    this.uniform = this.storage = this.pipeline = this.bind = undefined;
    this.pipelineKey = '';
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  /** Detaches the surface and releases its graphics buffers. The physics world remains owned by its caller. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
    this.data = new Float32Array(0);
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
