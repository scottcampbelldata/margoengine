// Precipitation (ATMO-04 of docs/physics-solvers.md): rain, snow, graupel and hail as one field of
// `@margoengine/math/fields` that gives, anywhere and at any time on the world clock, how much water falls in each form,
// the sizes it falls in, how fast and with how much energy (docs/physics-framework.md, section 4, "rain"; PA-23).
//
// Fall speeds come from each particle's own physics, so they follow the air's density, viscosity and temperature at any
// height:
// - Raindrops: weight against drag for an oblate spheroid (K. Loftus and R. D. Wordsworth, "The physics of falling raindrops
//   in diverse planetary atmospheres", JGR Planets 126, 2021, arXiv:2102.09570): the axis ratio from the balance of surface
//   tension and pressure at the equator (Green 1975, their eq. 2), the drag coefficient of Clift and Gauvin (1970) with
//   Loth's (2008) shape factor (their eqs. 6 and 7), solved for the terminal speed (their eq. 8). The largest drop is the
//   Rayleigh-Taylor length, pi times the capillary length, across the drop's width (their eq. 21, after Komabayasi et al.
//   1964). Water's surface tension is the IAPWS release (2014); air's viscosity is Sutherland's law with the constants of the
//   U.S. Standard Atmosphere (1976).
// - Snow aggregates: the Best-number method with the area-ratio correction of A. J. Heymsfield and C. D. Westbrook (J. Atmos.
//   Sci. 67, 2010), X* = X Ar^1/2, delta0 = 8.0, C0 = 0.35, as restated by Vazquez-Martin, Kuhn and Eliasson (ACP 21, 2021) and
//   McCorquodale and Westbrook (TRAIL part 2); mass m = 0.0185 D^1.9 kg (D in m) of Brown and Francis (1995), as restated by
//   Hogan et al. (2006); area ratio 0.24, the asymptotic 0.33 of large aggregates relative to their circumscribing ellipse
//   (Seifert and Jakub, Tellus A, "On the geometry of aggregate snowflakes") times the ellipse's aspect ratio of 0.74 they give.
// - Graupel and hail: the Reynolds-Best number fit of A. Heymsfield and R. Wright ("Graupel and hail terminal velocities: does a
//   'supercritical' Reynolds number apply?", J. Atmos. Sci. 71, 2014, eqs. 5 and 6), Re = 0.106 X^0.693 below X = 6.77e4 and
//   0.55 X^0.545 above; graupel density 0.18 D^0.33 g/cm^3 (D in cm, their eq. 3); hail 0.9 g/cm^3 (List et al. 1970, as they
//   cite). Graupel is rimed ice up to 5 mm, hail 5 mm and more (the AMS glossary, as they cite).
//
// Sizes: rain follows Marshall and Palmer (1948), N(D) = N0 exp(-Lambda D) with Lambda = 4.1 R^-0.21 per mm (R in mm/h), as
// restated by Garrett (arXiv:1901.02163), and N0 is then set so the drops carry exactly the rate asked for (Marshall and
// Palmer's 8000 per m^3 per mm comes back within a few percent). Snow carries the drops it melts into: an exponential whose
// slope and intercept give the same mass flux and the same number flux as the rain of its rate, so no flake is made or lost
// through the melting layer. Graupel and hail are exponentials of a given e-folding size.
//
// Phase: the share falling as snow is 1/2 (1 - tanh(k (T - T50))) at the local air temperature T, with T50 = 1.0 C (the
// Northern Hemisphere mean 50 percent rain-snow threshold of Jennings et al., Nature Communications 9, 2018) and k = 0.7 per K
// (the land slope of Dai, GRL 35, 2008), so the snow line follows the air's temperature with height.
//
// Where: a uniform rate and exponential rain cells that move, both given at cloud base; what reaches a point fell from the
// cloud base upwind of it, carried by the wind at the middle of its fall for the time it took to fall, so a rain shaft
// slants with the wind, is anchored in the world and drifts with its cell.
//
// Accepted differences: no evaporation below cloud base, no aggregation or breakup on the way down, hail and graupel do not
// melt, one fall speed (the median drop's) carries the whole shaft sideways, and a raindrop takes the air's temperature.

import { airDensity, SEA_LEVEL_TEMPERATURE, standardAtmosphere } from '@margoengine/math/atmosphere';
import type { FlowSample, HydrometeorSample, Precipitation, PrecipitationSample, Wind } from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { exp, ln, pow } from '@margoengine/math/pinned';

/** Density of liquid water, kg/m^3; 1 mm of rain on a square metre is 1 kg. */
export const WATER_DENSITY = 1000;
/** Density of hail, kg/m^3 (List et al. 1970, as Heymsfield and Wright 2014 cite). */
export const HAIL_DENSITY = 900;
/** The smallest hailstone, m; smaller rimed ice is graupel. */
export const HAIL_SMALLEST = 0.005;
/** The largest hailstone counted, m (stones of 20 cm have been recorded). */
const HAIL_LARGEST = 0.2;
const PI = 3.141592653589793;

/** The air a particle falls through. */
export interface FallingAir {
  /** Density, kg/m^3 (default 1.225, the standard atmosphere at sea level). */
  density?: number;
  /** Temperature, K (default 288.15). */
  temperature?: number;
  /** Gravity's magnitude, m/s^2 (default that of `DEFAULT_GRAVITY`). */
  gravity?: number;
}

interface Air {
  density: number;
  temperature: number;
  gravity: number;
  viscosity: number;
  surfaceTension: number;
}

function airOf(air: FallingAir = {}): Air {
  const { density = 1.225, temperature = SEA_LEVEL_TEMPERATURE, gravity = gravityMagnitude(DEFAULT_GRAVITY) } = air;
  if (!(density > 0 && Number.isFinite(density)))
    throw new RangeError(
      `Air density is a finite number of kg/m^3 above 0 (got ${density}); pass one, or leave it unset for 1.225.`,
    );
  if (!(temperature > 0 && Number.isFinite(temperature)))
    throw new RangeError(
      `Air temperature is a finite number of kelvin above 0 (got ${temperature}); pass one, or leave it unset for 288.15.`,
    );
  if (!(gravity > 0 && Number.isFinite(gravity)))
    throw new RangeError(
      `Gravity's magnitude is a finite number of m/s^2 above 0 (got ${gravity}); pass one, or leave it unset.`,
    );
  return {
    density,
    temperature,
    gravity,
    viscosity: airViscosity(temperature),
    surfaceTension: waterSurfaceTension(temperature),
  };
}

/** Dynamic viscosity of air at `temperature` K, Pa s: Sutherland's law with the U.S. Standard Atmosphere (1976) constants. */
export function airViscosity(temperature: number): number {
  return (1.458e-6 * temperature * Math.sqrt(temperature)) / (temperature + 110.4);
}

/** Surface tension of water against air at `temperature` K, N/m (IAPWS 2014; 248 K to 647 K). */
export function waterSurfaceTension(temperature: number): number {
  const tau = 1 - temperature / 647.096;
  return 0.2358 * pow(tau, 1.256) * (1 - 0.625 * tau);
}

/** The capillary length of water in air, m: sqrt(sigma / (g (rho_w - rho_a))). */
function capillaryLength(air: Air): number {
  return Math.sqrt(air.surfaceTension / (air.gravity * (WATER_DENSITY - air.density)));
}

/**
 * The shape of a drop of equivalent radius `r` m: s = (b/a)^(-1/3), from Green's balance r / l_c = s^(1/2) (s^6 - 2s + 1)^(1/2)
 * (Loftus and Wordsworth 2021, eq. 2, with b/a = s^-3). 1 is a sphere.
 */
function dropShape(r: number, lc: number): number {
  const target = (r / lc) * (r / lc);
  let lo = 1,
    hi = 2;
  for (let s3 = 8; hi * (s3 * s3 - 2 * hi + 1) < target; s3 = hi * hi * hi) hi *= 2;
  for (let i = 0; i < 64; i++) {
    const s = 0.5 * (lo + hi),
      s3 = s * s * s;
    if (s * (s3 * s3 - 2 * s + 1) < target) lo = s;
    else hi = s;
  }
  return 0.5 * (lo + hi);
}

/** Surface area of the oblate drop of shape `s` over that of the sphere of its volume. */
function surfaceRatio(s: number): number {
  const q = 1 / (s * s * s),
    e = Math.sqrt(Math.max(0, 1 - q * q)),
    // a = r s and b = r / s^2; S / (4 pi r^2) = (2 a^2 + (b^2 / e) ln((1 + e) / (1 - e))) / (4 r^2).
    lens = e < 1e-4 ? 2 * (1 + (e * e) / 3) : ln((1 + e) / (1 - e)) / e;
  return (2 * s * s + lens / (s * s * s * s)) / 4;
}

/** The largest stable raindrop in `air`, equivalent diameter in m (Rayleigh-Taylor: its width is pi capillary lengths). */
export function largestRaindrop(air?: FallingAir): number {
  return largestDrop(airOf(air));
}

function largestDrop(air: Air): number {
  const lc = capillaryLength(air),
    // Width 2a = pi l_c, with a / l_c = s^(3/2) (s^6 - 2s + 1)^(1/2): (pi / 2)^2 = s^3 (s^6 - 2s + 1).
    target = (PI / 2) * (PI / 2);
  let lo = 1,
    hi = 2;
  for (let i = 0; i < 64; i++) {
    const s = 0.5 * (lo + hi),
      s3 = s * s * s;
    if (s3 * (s3 * s3 - 2 * s + 1) < target) lo = s;
    else hi = s;
  }
  return (PI * lc) / (0.5 * (lo + hi));
}

/** Terminal speed of a raindrop of equivalent diameter `diameter` m through `air`, m/s (Loftus and Wordsworth 2021). */
export function rainFallSpeed(diameter: number, air?: FallingAir): number {
  if (!(diameter > 0 && Number.isFinite(diameter)))
    throw new RangeError(`A drop's diameter is a finite number of metres above 0 (got ${diameter}); pass one.`);
  const state = airOf(air);
  return rainSpeed(diameter, state, capillaryLength(state));
}

function rainSpeed(diameter: number, air: Air, lc: number): number {
  const r = diameter / 2,
    s = dropShape(r, lc),
    shape = Math.max(0, surfaceRatio(s) - 1),
    cshape = 1 + 1.5 * Math.sqrt(shape) + 6.7 * shape,
    // Weight against drag: v^2 C_D = K, with K = (8/3) (rho_w - rho_a) g r (b/a)^(2/3) / rho_a and (b/a)^(2/3) = s^-2.
    lnK = ln((8 / 3) * (WATER_DENSITY - air.density) * air.gravity * r) - 2 * ln(s) - ln(air.density),
    lnScale = ln((2 * r * air.density) / air.viscosity),
    lnCshape = ln(cshape),
    // Stokes's speed bounds the speed from above (the drag is never below 24 / Re).
    hiStart = lnK + lnScale - ln(24) - lnCshape;
  let lo = hiStart - 40,
    hi = hiStart,
    u = hiStart;
  for (let i = 0; i < 100; i++) {
    const lnRe = u + lnScale,
      re = exp(lnRe),
      p = exp(-0.313 * lnRe),
      q = 4.25e4 * exp(-1.16 * lnRe),
      a1 = 24 / re + 3.6 * p,
      a2 = 0.42 / (1 + q),
      cd = a1 + a2,
      // Re dC_D/dRe for the bracket: -24/Re - 1.1268 Re^-0.313 + 0.42 * 1.16 q / (1 + q)^2.
      slope = (-24 / re - 1.1268 * p + (0.4872 * q) / ((1 + q) * (1 + q))) / cd,
      h = 2 * u + ln(cd) + lnCshape - lnK;
    if (h < 0) lo = u;
    else hi = u;
    let next = u - h / (2 + slope);
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - u) < 1e-13) {
      u = next;
      break;
    }
    u = next;
  }
  return exp(u);
}

/** Speed from a Reynolds number for a particle of size `d` m. */
function speedOf(re: number, d: number, air: Air): number {
  return (re * air.viscosity) / (air.density * d);
}

/** Mass of a snow aggregate of maximum dimension `d` m, kg (Brown and Francis 1995). */
function snowMass(d: number): number {
  return 0.0185 * pow(d, 1.9);
}

/** Area ratio of a large aggregate (see the file comment). */
const SNOW_AREA_RATIO = 0.24;

/** Terminal speed of a snow aggregate of maximum dimension `diameter` m through `air`, m/s (Heymsfield and Westbrook 2010). */
export function snowFallSpeed(diameter: number, air?: FallingAir): number {
  if (!(diameter > 0 && Number.isFinite(diameter)))
    throw new RangeError(`A snowflake's size is a finite number of metres above 0 (got ${diameter}); pass one.`);
  return snowSpeed(diameter, airOf(air));
}

function snowSpeed(d: number, air: Air): number {
  const x =
      (8 * snowMass(d) * air.gravity * air.density) / (PI * Math.sqrt(SNOW_AREA_RATIO) * air.viscosity * air.viscosity),
    // Re = delta0^2 / 4 ((1 + 4 sqrt(X*) / (delta0^2 sqrt(C0)))^1/2 - 1)^2, delta0 = 8, C0 = 0.35.
    root = Math.sqrt(1 + (4 * Math.sqrt(x)) / (64 * Math.sqrt(0.35))) - 1;
  return speedOf(16 * root * root, d, air);
}

/** Density of graupel of diameter `d` m, kg/m^3: 0.18 D^0.33 g/cm^3 with D in cm (Heymsfield and Wright 2014, eq. 3). */
export function graupelDensity(d: number): number {
  return 180 * pow(100 * d, 0.33);
}

function rimedSpeed(d: number, density: number, air: Air): number {
  // X = 2 m g rho_a D^2 / (A eta^2) for a sphere of bulk density `density`: 8 m g rho_a / (pi eta^2).
  const mass = (density * PI * d * d * d) / 6,
    x = (8 * mass * air.gravity * air.density) / (PI * air.viscosity * air.viscosity),
    re = x < 6.77e4 ? 0.106 * pow(x, 0.693) : 0.55 * pow(x, 0.545);
  return speedOf(re, d, air);
}

/** Terminal speed of graupel of diameter `diameter` m through `air`, m/s (Heymsfield and Wright 2014). */
export function graupelFallSpeed(diameter: number, air?: FallingAir): number {
  if (!(diameter > 0 && Number.isFinite(diameter)))
    throw new RangeError(
      `A graupel pellet's diameter is a finite number of metres above 0 (got ${diameter}); pass one.`,
    );
  return rimedSpeed(diameter, graupelDensity(diameter), airOf(air));
}

/** Terminal speed of a hailstone of diameter `diameter` m and bulk `density` kg/m^3 through `air`, m/s (Heymsfield and Wright 2014). */
export function hailFallSpeed(diameter: number, air?: FallingAir, density = HAIL_DENSITY): number {
  if (!(diameter > 0 && Number.isFinite(diameter)))
    throw new RangeError(`A hailstone's diameter is a finite number of metres above 0 (got ${diameter}); pass one.`);
  if (!(density > 0 && density <= 917))
    throw new RangeError(
      `A hailstone's density lies in (0, 917] kg/m^3, solid ice at most (got ${density}); pass one in that range.`,
    );
  return rimedSpeed(diameter, density, airOf(air));
}

/** The share of precipitation falling as snow at `temperature` K: 1/2 (1 - tanh(sharpness (T - threshold))). */
export function snowFraction(temperature: number, threshold = 274.15, sharpness = 0.7): number {
  const a = 2 * sharpness * (temperature - threshold);
  // 1/2 (1 - tanh(a / 2)) = 1 / (1 + e^a), written so neither end overflows.
  return a > 0 ? exp(-a) / (1 + exp(-a)) : 1 / (1 + exp(a));
}

// Gauss-Legendre, 8 points on [-1, 1].
const GL_X = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498, 0.1834346424956498,
  0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GL_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362, 0.3137066458778873,
  0.2223810344533745, 0.1012285362903763,
];
const PANELS = 8;
const NODES = PANELS * GL_X.length;
/** How far past the smallest size the integrals run, in units of 1 / slope: exp(-48) is below 1e-20. */
const SPAN = 48;

/** Nodes and weights for integrals of f(D) exp(-slope D) dD over [d0, d1] (the weights hold the exponential). */
class Quadrature {
  readonly d = new Float64Array(NODES);
  readonly w = new Float64Array(NODES);

  set(slope: number, d0: number, d1: number): void {
    const x0 = slope * d0,
      x1 = Math.min(slope * d1, x0 + SPAN),
      h = (x1 - x0) / PANELS;
    let k = 0;
    for (let p = 0; p < PANELS; p++)
      for (let j = 0; j < GL_X.length; j++, k++) {
        const x = x0 + h * (p + 0.5 * (GL_X[j]! + 1));
        this.d[k] = x / slope;
        this.w[k] = (0.5 * h * GL_W[j]! * exp(-x)) / slope;
      }
  }
}

function emptyHydrometeor(): HydrometeorSample {
  return { rate: 0, intercept: 0, slope: 0, fallSpeed: 0, impactRate: 0, energyFlux: 0, waterContent: 0 };
}

function clear(out: HydrometeorSample): HydrometeorSample {
  out.rate = out.intercept = out.slope = out.fallSpeed = out.impactRate = out.energyFlux = out.waterContent = 0;
  return out;
}

/** A moving rain cell: an exponential mound of rain rate at cloud base. */
export interface RainCell {
  /** Where its centre is at time 0, [x, z] m from the field's cell origin. */
  centre: readonly [number, number];
  /** The distance over which its rate falls by a factor e, m. */
  radius: number;
  /** Rate at its centre, mm/h of liquid water. */
  rate: number;
  /** How its centre moves over the ground, [x, z] m/s (default still). */
  velocity?: readonly [number, number];
}

/** Rain made elsewhere, such as under a cloud solver's clouds: its rate at the field's cloud base. */
export interface RainSource {
  /** The rate at (x, z) at time `t`, mm/h of liquid water, 0 or more. */
  rate(x: number, z: number, t: number): number;
  /** Its strongest rate now, mm/h: the field carries the falling water sideways at that rain's median drop speed. */
  readonly peak: number;
}

/** Rimed ice carried with the rain: its share of the rate and its sizes. */
export interface RimedIce {
  /** The share of the precipitation rate it carries, 0 to 1. */
  fraction: number;
  /** The e-folding size of its exponential size distribution, m (1 / slope). */
  scale?: number;
}

/** Settings of a {@link PrecipitationField}; each has a default. */
export interface PrecipitationFieldOptions {
  /** A rate everywhere, mm/h of liquid water at cloud base (default 4, moderate rain, with no cells and no source; otherwise 0). */
  rate?: number;
  /** Rain cells on top of `rate`. */
  cells?: readonly RainCell[];
  /**
   * Rain from elsewhere on top of `rate` and `cells`, such as `CloudSolver.rainSource()` of `@margoengine/physics/clouds`
   * (give `base` half a cloud cell then, as its rain is already at the ground). A sample then depends on the source's state.
   */
  source?: RainSource;
  /** Cloud base, m above the ground (default 1500). */
  base?: number;
  /** The ground's height, y m, that heights are measured from (default 0). */
  ground?: number;
  /** The ground's height above sea level, m, for the standard atmosphere (default 0). */
  altitude?: number;
  /** Sea-level temperature of the standard atmosphere, K (default 288.15); unused when `wind` gives temperatures. */
  seaLevelTemperature?: number;
  /** The wind that carries the falling water and whose air (density, temperature) it falls through (default still air). */
  wind?: Wind;
  /** The temperature at which half the precipitation falls as snow, K (default 274.15, 1.0 C). */
  snowTemperature?: number;
  /** How quickly snow gives way to rain with temperature, per K (default 0.7). */
  snowSharpness?: number;
  /** Graupel (default none; scale 1 mm). */
  graupel?: RimedIce;
  /** Hail of 5 mm and more (default none; scale 1 cm, density 900 kg/m^3). */
  hail?: RimedIce & { density?: number };
  /** Gravity's magnitude, m/s^2 (default that of `DEFAULT_GRAVITY`). */
  gravity?: number;
}

const GRAUPEL_LARGEST = HAIL_SMALLEST;

/** Precipitation anywhere: rain, snow, graupel and hail with their sizes, speeds and energy, on the world clock. */
export class PrecipitationField implements Precipitation {
  readonly cell = [0, 0, 0] as const;
  readonly base: number;
  private readonly rate: number;
  private readonly cells: readonly Required<RainCell>[];
  private readonly source: RainSource | undefined;
  private readonly ground: number;
  private readonly altitude: number;
  private readonly seaLevel: number;
  private readonly wind: Wind | undefined;
  private readonly snowTemperature: number;
  private readonly snowSharpness: number;
  private readonly graupel: Required<RimedIce>;
  private readonly hail: Required<RimedIce> & { density: number };
  private readonly gravity: number;
  /** The rate whose median drop sets how far the wind carries the falling water. */
  private readonly driftRate: number;
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly q = new Quadrature();
  private readonly speeds = new Float64Array(NODES);
  private readonly masses = new Float64Array(NODES);

  /** @throws RangeError for a rate, size, height, share or temperature that is out of range or not finite. */
  constructor(options: PrecipitationFieldOptions = {}) {
    const {
      cells = [],
      source,
      rate = cells.length || source ? 0 : 4,
      base = 1500,
      ground = 0,
      altitude = 0,
      seaLevelTemperature = SEA_LEVEL_TEMPERATURE,
      wind,
      snowTemperature = 274.15,
      snowSharpness = 0.7,
      graupel = { fraction: 0 },
      hail = { fraction: 0 },
      gravity = gravityMagnitude(DEFAULT_GRAVITY),
    } = options;
    nonNegative(rate, 'rate', 'mm/h');
    positive(base, 'cloud base', 'm');
    for (const [name, v] of [
      ['ground', ground],
      ['altitude', altitude],
    ] as const)
      if (!Number.isFinite(v))
        throw new RangeError(`A precipitation field's ${name} is a finite number of metres (got ${v}); pass one.`);
    positive(seaLevelTemperature, 'sea-level temperature', 'K');
    positive(snowTemperature, 'snow temperature', 'K');
    positive(snowSharpness, 'snow sharpness', 'per K');
    positive(gravity, 'gravity', 'm/s^2');
    this.cells = cells.map((c, i) => {
      if (!(c.centre.length === 2 && c.centre.every(Number.isFinite)))
        throw new RangeError(`Rain cell ${i}'s centre must be two finite numbers [x, z] (got ${c.centre}).`);
      positive(c.radius, `rain cell ${i}'s radius`, 'm');
      nonNegative(c.rate, `rain cell ${i}'s rate`, 'mm/h');
      const velocity = c.velocity ?? [0, 0];
      if (!(velocity.length === 2 && velocity.every(Number.isFinite)))
        throw new RangeError(`Rain cell ${i}'s velocity must be two finite numbers [x, z] m/s (got ${velocity}).`);
      return {
        centre: [c.centre[0], c.centre[1]],
        radius: c.radius,
        rate: c.rate,
        velocity: [velocity[0], velocity[1]],
      };
    });
    const g = { fraction: graupel.fraction, scale: graupel.scale ?? 0.001 },
      h = { fraction: hail.fraction, scale: hail.scale ?? 0.01, density: hail.density ?? HAIL_DENSITY };
    for (const [name, v] of [
      ['graupel', g],
      ['hail', h],
    ] as const) {
      if (!(v.fraction >= 0 && v.fraction <= 1))
        throw new RangeError(`The ${name} fraction lies in [0, 1] (got ${v.fraction}); pass one in that range.`);
      positive(v.scale, `${name} scale`, 'm');
    }
    if (g.fraction + h.fraction > 1)
      throw new RangeError(
        `Graupel and hail together carry at most all the precipitation (got ${g.fraction + h.fraction}); reduce their fractions.`,
      );
    if (!(h.density > 0 && h.density <= 917))
      throw new RangeError(
        `A hailstone's density lies in (0, 917] kg/m^3, solid ice at most (got ${h.density}); pass one in that range.`,
      );
    if (source !== undefined && !(typeof source.rate === 'function' && 'peak' in source))
      throw new TypeError('A rain source has rate(x, z, t) and peak; pass one such as CloudSolver.rainSource().');
    this.source = source;
    this.rate = rate;
    this.base = base;
    this.ground = ground;
    this.altitude = altitude;
    this.seaLevel = seaLevelTemperature;
    this.wind = wind;
    this.snowTemperature = snowTemperature;
    this.snowSharpness = snowSharpness;
    this.graupel = g;
    this.hail = h;
    this.gravity = gravity;
    this.driftRate = Math.max(rate, ...this.cells.map((c) => c.rate));
  }

  /** The rate at cloud base above (x, z) at time `t`, mm/h. */
  sourceRate(x: number, z: number, t: number): number {
    let rate = this.rate;
    for (const c of this.cells) {
      const dx = x - (c.centre[0] + c.velocity[0] * t),
        dz = z - (c.centre[1] + c.velocity[1] * t);
      rate += c.rate * exp(-Math.sqrt(dx * dx + dz * dz) / c.radius);
    }
    if (this.source) {
      const extra = this.source.rate(x, z, t);
      if (!(extra >= 0 && Number.isFinite(extra)))
        throw new RangeError(
          `A rain source gave ${extra} mm/h at (${x}, ${z}); its rate must be a finite number, 0 or more.`,
        );
      rate += extra;
    }
    return rate;
  }

  /** The air at (x, y, z) at time t: the wind's, or the standard atmosphere's with no wind. */
  private airAt(x: number, y: number, z: number, t: number): FlowSample {
    const flow = this.flow;
    if (this.wind) return this.wind.sample(x, y, z, t, flow);
    const [temperature, pressure] = standardAtmosphere(this.altitude + y - this.ground, this.seaLevel);
    flow.velocity[0] = flow.velocity[1] = flow.velocity[2] = 0;
    flow.temperature = temperature;
    flow.density = airDensity(temperature, pressure);
    return flow;
  }

  /** The precipitation at (x, y, z) at time `t` (the {@link Precipitation} contract). */
  sample(x: number, y: number, z: number, t: number, out?: PrecipitationSample): PrecipitationSample {
    const sample = out ?? {
        rate: 0,
        rain: emptyHydrometeor(),
        snow: emptyHydrometeor(),
        graupel: emptyHydrometeor(),
        hail: emptyHydrometeor(),
        velocity: [0, 0, 0],
      },
      fall = Math.max(0, this.base - (y - this.ground));
    // How far the wind carries what falls here: the median drop of the strongest rain, at the middle of its fall.
    let sx = x,
      sz = z,
      st = t;
    const driftRate = this.source ? Math.max(this.driftRate, this.source.peak) : this.driftRate;
    if (fall > 0 && driftRate > 0) {
      const mid = this.airAt(x, y + fall / 2, z, t),
        air = this.air(mid),
        snowShare = snowFraction(mid.temperature, this.snowTemperature, this.snowSharpness),
        median = 3.67 / (4100 * pow(driftRate, -0.21)),
        speed =
          (1 - snowShare) * rainSpeed(median, air, capillaryLength(air)) +
          snowShare * snowSpeed(this.snowSize(median), air),
        time = fall / speed;
      // The wind at the middle of the fall, at the middle of its time.
      const drift = this.wind ? this.wind.sample(x, y + fall / 2, z, t - time / 2, this.flow).velocity : [0, 0, 0];
      sx = x - drift[0]! * time;
      sz = z - drift[2]! * time;
      st = t - time;
    }
    const total = this.sourceRate(sx, sz, st),
      local = this.airAt(x, y, z, t),
      air = this.air(local),
      snowShare = snowFraction(local.temperature, this.snowTemperature, this.snowSharpness),
      hailRate = total * this.hail.fraction,
      graupelRate = total * this.graupel.fraction,
      liquid = total - hailRate - graupelRate;
    sample.rate = total;
    this.rain(liquid * (1 - snowShare), air, sample.rain);
    this.snow(liquid * snowShare, air, sample.snow);
    this.rimed(graupelRate, 1 / this.graupel.scale, 0, GRAUPEL_LARGEST, 0, air, sample.graupel);
    this.rimed(hailRate, 1 / this.hail.scale, HAIL_SMALLEST, HAIL_LARGEST, this.hail.density, air, sample.hail);
    const flux =
      sample.rain.rate * sample.rain.fallSpeed +
      sample.snow.rate * sample.snow.fallSpeed +
      sample.graupel.rate * sample.graupel.fallSpeed +
      sample.hail.rate * sample.hail.fallSpeed;
    sample.velocity[0] = local.velocity[0];
    sample.velocity[1] = local.velocity[1] - (total > 0 ? flux / total : 0);
    sample.velocity[2] = local.velocity[2];
    return sample;
  }

  private air(flow: FlowSample): Air {
    return {
      density: flow.density,
      temperature: flow.temperature,
      gravity: this.gravity,
      viscosity: airViscosity(flow.temperature),
      surfaceTension: waterSurfaceTension(flow.temperature),
    };
  }

  /** The maximum dimension of the snowflake that melts into a drop of diameter `d`. */
  private snowSize(d: number): number {
    return pow((WATER_DENSITY * PI * d * d * d) / (6 * 0.0185), 1 / 1.9);
  }

  /** Fill `out` from the nodes, speeds and masses for a rate of `rate` mm/h; the intercept makes the mass flux the rate. */
  private fill(rate: number, slope: number, out: HydrometeorSample): HydrometeorSample {
    const { w } = this.q;
    let massFlux = 0,
      numberFlux = 0,
      energy = 0,
      content = 0;
    for (let i = 0; i < NODES; i++) {
      const v = this.speeds[i]!,
        m = this.masses[i]!,
        wi = w[i]!;
      massFlux += wi * m * v;
      numberFlux += wi * v;
      energy += wi * 0.5 * m * v * v * v;
      content += wi * m;
    }
    const n0 = rate / 3600 / massFlux;
    out.rate = rate;
    out.intercept = n0;
    out.slope = slope;
    out.fallSpeed = massFlux / content;
    out.impactRate = n0 * numberFlux;
    out.energyFlux = n0 * energy;
    out.waterContent = n0 * content;
    return out;
  }

  private rainNodes(rate: number, air: Air): number {
    const slope = 4100 * pow(rate, -0.21),
      lc = capillaryLength(air);
    this.q.set(slope, 0, largestDrop(air));
    for (let i = 0; i < NODES; i++) {
      const d = this.q.d[i]!;
      this.speeds[i] = rainSpeed(d, air, lc);
      this.masses[i] = (WATER_DENSITY * PI * d * d * d) / 6;
    }
    return slope;
  }

  private rain(rate: number, air: Air, out: HydrometeorSample): HydrometeorSample {
    if (!(rate > 0)) return clear(out);
    return this.fill(rate, this.rainNodes(rate, air), out);
  }

  /** Snow of `rate` mm/h: the exponential that carries the mass and number flux of the rain it melts into. */
  private snow(rate: number, air: Air, out: HydrometeorSample): HydrometeorSample {
    if (!(rate > 0)) return clear(out);
    const rain = this.fill(rate, this.rainNodes(rate, air), out),
      meanMass = rate / 3600 / rain.impactRate,
      largest = this.snowSize(largestDrop(air));
    // The mean mass of the falling flakes falls as the slope rises: find the slope that matches the drops'.
    let lo = ln(1 / largest),
      hi = ln(1e7);
    for (let i = 0; i < 52; i++) {
      const mid = 0.5 * (lo + hi);
      this.snowNodes(exp(mid), largest, air);
      let mass = 0,
        number = 0;
      for (let k = 0; k < NODES; k++) {
        mass += this.q.w[k]! * this.masses[k]! * this.speeds[k]!;
        number += this.q.w[k]! * this.speeds[k]!;
      }
      if (mass / number > meanMass) lo = mid;
      else hi = mid;
    }
    const slope = exp(0.5 * (lo + hi));
    this.snowNodes(slope, largest, air);
    return this.fill(rate, slope, out);
  }

  private snowNodes(slope: number, largest: number, air: Air): void {
    this.q.set(slope, 0, largest);
    for (let i = 0; i < NODES; i++) {
      const d = this.q.d[i]!;
      this.speeds[i] = snowSpeed(d, air);
      this.masses[i] = snowMass(d);
    }
  }

  /** Graupel (density 0: its size law) or hail of `rate` mm/h between `d0` and `d1` m. */
  private rimed(
    rate: number,
    slope: number,
    d0: number,
    d1: number,
    density: number,
    air: Air,
    out: HydrometeorSample,
  ): HydrometeorSample {
    if (!(rate > 0)) return clear(out);
    this.q.set(slope, d0, d1);
    for (let i = 0; i < NODES; i++) {
      const d = this.q.d[i]!,
        rho = density > 0 ? density : graupelDensity(d);
      this.speeds[i] = rimedSpeed(d, rho, air);
      this.masses[i] = (rho * PI * d * d * d) / 6;
    }
    return this.fill(rate, slope, out);
  }
}

function positive(v: number, name: string, unit: string): void {
  if (!(v > 0 && Number.isFinite(v)))
    throw new RangeError(`A ${name} is a finite number of ${unit} above 0 (got ${v}); pass one.`);
}

function nonNegative(v: number, name: string, unit: string): void {
  if (!(v >= 0 && Number.isFinite(v)))
    throw new RangeError(`A ${name} is a finite number of ${unit}, 0 or more (got ${v}); pass one.`);
}
