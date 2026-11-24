/// <reference lib="esnext.disposable" preserve="true" />
// A volcanic eruption column with its umbrella cloud, ash fall and plume lightning, deterministic over film time
// (every output is a function of the film time alone: no stepping, no randomness but hashed). Sources (papers, read as
// text; no code; docs/clean-room.md "Eruption column"):
// - B. R. Morton, G. I. Taylor and J. S. Turner, "Turbulent gravitational convection from maintained and instantaneous
//   sources", Proc. R. Soc. Lond. A 234(1196), 1-23, 1956, https://doi.org/10.1098/rspa.1956.0011: a plume entrains
//   ambient air at a speed alpha times its own (alpha about 0.09), and in stable air rises as the 1/4 power of its flux.
// - A. W. Woods, "The fluid dynamics and thermodynamics of eruption columns", Bull. Volcanol. 50, 169-193, 1988,
//   https://doi.org/10.1007/BF01079681: the column as a top-hat plume of gas and pyroclasts whose density follows the
//   gas fraction, the temperature and the air pressure; the dense gas-thrust region at the vent decelerates until the
//   entrained air, heated by the clasts, makes it lighter than the air (a buoyant plume), or it collapses as a fountain.
// - R. S. J. Sparks, "The dimensions and dynamics of volcanic eruption columns", Bull. Volcanol. 48, 3-15, 1986,
//   https://doi.org/10.1007/BF01073509: the column's top overshoots the level of neutral buoyancy, where the umbrella
//   cloud spreads, the neutral level lying about 0.75 of the top.
// - M. J. Woodhouse, A. J. Hogg, J. C. Phillips and R. S. J. Sparks, "Interaction between volcanic plumes and wind
//   during the 2010 Eyjafjallajokull eruption, Iceland", J. Geophys. Res. Solid Earth 118, 92-109, 2013,
//   https://doi.org/10.1029/2012JB009592: the bent-over plume along its axis, entraining at alpha |u - V cos(theta)|
//   + beta |V sin(theta)| and taking the wind's horizontal momentum with the air it entrains.
// - L. G. Mastin et al., "A multidisciplinary effort to assign realistic source parameters to models of volcanic
//   ash-cloud transport and dispersion during eruptions", J. Volcanol. Geotherm. Res. 186, 10-21, 2009,
//   https://doi.org/10.1016/j.jvolgeores.2009.01.008, as tabled in A. Costa et al., "Results of the eruptive column
//   model inter-comparison study", J. Volcanol. Geotherm. Res. 326, 2-25, 2016,
//   https://doi.org/10.1016/j.jvolgeores.2016.01.017 (open access, read in full): M = 2500 (H / 2)^4.15 kg/s for a
//   height H km above the vent, and the heat capacities and gas constants of the pyroclasts, water vapour and air.
// - A. W. Woods and J. Kienle, "The dynamics and thermodynamics of volcanic clouds: theory and observations from the
//   April 15 and April 21, 1990 eruptions of Redoubt Volcano, Alaska", J. Volcanol. Geotherm. Res. 62, 273-299, 1994,
//   https://doi.org/10.1016/0377-0273(94)90037-X; Y. J. Suzuki and T. Koyaguchi, "A three-dimensional numerical
//   simulation of spreading umbrella clouds", J. Geophys. Res. 114, B03209, 2009, https://doi.org/10.1029/2007JB005369:
//   the umbrella is a gravity current at the neutral level whose front runs at lambda N h, so a steady volume flux q
//   spreads it to R = (3 lambda N q / (2 pi))^(1/3) t^(2/3), lambda about 0.2.
// - S. Carey and R. S. J. Sparks, "Quantitative models of the fallout and dispersal of tephra from volcanic eruption
//   columns", Bull. Volcanol. 48, 109-125, 1986, https://doi.org/10.1007/BF01046546: a clast leaves the column where
//   the column's upward speed falls to its fall speed.
// - C. Bonadonna, G. G. J. Ernst and R. S. J. Sparks, "Thickness variations and volume estimates of tephra fall
//   deposits: the importance of particle Reynolds number", J. Volcanol. Geotherm. Res. 81, 173-187, 1998,
//   https://doi.org/10.1016/S0377-0273(98)00007-9: the fall speed in the Stokes, intermediate and turbulent regimes;
//   C. Bonadonna et al., "Probabilistic modeling of tephra dispersal: hazard assessment of a multiphase rhyolitic
//   eruption at Tarawera, New Zealand", J. Geophys. Res. 110, B03203, 2005, https://doi.org/10.1029/2003JB002896: each
//   grain class lands as a Gaussian spread by diffusion over its fall time, carried downwind by the wind it falls
//   through.
// - S. R. McNutt and E. R. Williams, "Volcanic lightning: global observations and constraints on source mechanisms",
//   Bull. Volcanol. 72, 1153-1167, 2010, https://doi.org/10.1007/s00445-010-0393-4; S. A. Behnke et al.,
//   "Observations of volcanic lightning during the 2009 eruption of Redoubt Volcano", J. Volcanol. Geotherm. Res. 259,
//   214-234, 2013, https://doi.org/10.1016/j.jvolgeores.2011.12.010: small discharges at the vent and lightning in the
//   plume above it, more as the eruption is stronger.
// - International Civil Aviation Organization, Manual of the ICAO Standard Atmosphere, Doc 7488, 1993: the
//   temperature lapse of 6.5 K/km to 11 km, isothermal to 20 km, warming 1 K/km to 32 km and 2.8 K/km to 47 km, and
//   the pressure that follows from it.
// - H. C. van de Hulst, "Light Scattering by Small Particles", Wiley, 1957: the extinction efficiency of a large
//   particle is 2, so ash of radius r and mass concentration C has extinction 3 C / (2 rho r).
//
// The column is solved once per mass rate along its axis (fourth-order Runge-Kutta, steps of a tenth of its radius, at
// most 50 m); its top rises over film time at `frontSpeed` of the steady column's speed; the umbrella spreads from the
// neutral level when the top first reaches it; each grain class of the ash leaves the column where it can no longer be
// carried, falls through the wind and lands, the erupted mass arriving after its rise and fall times.
const G = 9.80665;
// Costa et al. 2016, Table 4.
const C_SOLID = 1100;
const C_VAPOUR = 1810;
const C_AIR = 1000;
const R_VAPOUR = 462;
const R_AIR = 287;
// ICAO Doc 7488's gas constant of dry air, for the standard atmosphere's pressure.
const R_ICAO = 287.05287;
const AIR_VISCOSITY = 1.8e-5;
const MAGMA = 2500;

/** What the eruption follows: a `WeatherMachine` (its wind bends the column and carries the umbrella and the ash). */
export interface EruptionWeather {
  readonly state: { readonly wind: number; readonly windDirection: number };
}

/** Options of {@link Eruption}. Every field has a documented default; `validateEruption` checks the ranges. */
export interface EruptionOptions {
  /** World place of the vent, [x, y, z] metres. Default [0, 0, 0]. */
  vent?: readonly [number, number, number];
  /** Height of the vent above sea level, metres, 0 to 8,000 (the air's pressure and temperature). Default the vent's y. */
  ventAltitude?: number;
  /** Film seconds the eruption starts. Default 0. */
  start?: number;
  /** Seconds it takes to reach its full rate, 1 to 86,400. Default 60. */
  rise?: number;
  /** Seconds at its full rate, 0 to 1,000,000. Default 3,600. */
  duration?: number;
  /** Seconds it takes to stop, 1 to 86,400. Default 300. */
  wane?: number;
  /** Mass eruption rate at full rate, kg/s, 1,000 to 1e10. Default 1e7 (a Plinian column near 15 km). */
  massRate?: number;
  /** Column top above the vent, metres, 500 to 50,000: when set, the mass rate is Mastin et al.'s (2009) for it. */
  height?: number | null;
  /** Speed of the mixture leaving the vent, m/s, 10 to 600. Default 200. */
  exitVelocity?: number;
  /** Temperature of the mixture leaving the vent, kelvin, 600 to 1,600. Default 1,200. */
  exitTemperature?: number;
  /** Mass fraction of magmatic gas (water) at the vent, 0.005 to 0.2. Default 0.04. */
  gasFraction?: number;
  /** Radial entrainment alpha (Morton et al. 1956), 0.02 to 0.2. Default 0.09. */
  entrainment?: number;
  /** Wind entrainment beta (Woodhouse et al. 2013), 0 to 1.5. Default 0.5. */
  windEntrainment?: number;
  /** Air temperature at sea level, kelvin, 220 to 320. Default 288.15 (ICAO). */
  airTemperature?: number;
  /** Height of the tropopause above sea level, metres, 6,000 to 20,000. Default 11,000 (ICAO). */
  tropopause?: number;
  /** Wind at 10 m, m/s, 0 to 60; it grows with height (1/7 power) to the tropopause. Unset follows `weather`. */
  wind?: number;
  /** Direction the wind blows toward, degrees, 0 is +Z, 90 is +X. Unset follows `weather`. */
  windDirection?: number;
  /** The weather whose wind it follows. */
  weather?: EruptionWeather;
  /** Speed of the rising top as a share of the steady column's speed, 0.1 to 1. Default 0.5 (a model choice). */
  frontSpeed?: number;
  /** Umbrella front coefficient lambda (Suzuki and Koyaguchi 2009), 0.05 to 1. Default 0.2. */
  umbrellaSpread?: number;
  /** Mean grain size, phi (-log2 of the diameter in mm), -4 to 8. Default 2 (0.25 mm). */
  grainSize?: number;
  /** Spread of the grain sizes, phi, 0.5 to 4. Default 2.5. */
  grainSorting?: number;
  /** Density of the ash grains, kg/m^3, 500 to 3,000. Default 2,500. */
  ashDensity?: number;
  /** Bulk density of the fallen ash, kg/m^3, 300 to 2,000. Default 1,000. */
  depositDensity?: number;
  /** Horizontal diffusion of falling ash, m^2/s, 0 to 100,000. Default 2,000 (a model choice). */
  diffusion?: number;
  /** Plume lightning strikes per minute at 1e7 kg/s, growing with the mass rate, 0 to 600. Default 6 (a model choice). */
  lightningRate?: number;
  /** Share of strikes at the vent (the rest in the plume), 0 to 1. Default 0.3. */
  ventLightning?: number;
  /** Seed of the lightning and the puffs, an integer. Default 1. */
  seed?: number;
  /** Colour of the column, linear RGB 0 to 1. Default [0.30, 0.28, 0.26]. */
  color?: readonly [number, number, number];
  /** Colour of the umbrella cloud, linear RGB 0 to 1. Default [0.52, 0.5, 0.47]. */
  umbrellaColor?: readonly [number, number, number];
  /** Film seconds per real second, 0 to 100. Default 1. */
  timeScale?: number;
}

/** One sample along the column's axis. */
export interface ColumnSample {
  /** World place of the axis, metres. */
  readonly position: readonly [number, number, number];
  /** Radius, metres. */
  readonly radius: number;
  /** Speed along the axis, m/s. */
  readonly speed: number;
  /** Mixture density and the air's, kg/m^3. */
  readonly density: number;
  readonly airDensity: number;
  /** Mixture temperature, kelvin. */
  readonly temperature: number;
}

/** The column now. */
export interface EruptionColumn {
  /** Mass eruption rate now, kg/s. */
  readonly massRate: number;
  /** Height the top has risen to above the vent, metres. */
  readonly top: number;
  /** Height the steady column at this rate reaches above the vent, metres. */
  readonly steadyTop: number;
  /** Height above the vent where the column turns buoyant (the end of the gas-thrust region); null when it collapses. */
  readonly buoyantFrom: number | null;
  /** Level of neutral buoyancy above the vent, where the umbrella spreads, metres; null when it collapses. */
  readonly neutral: number | null;
  /** True when the gas-thrust region runs out of momentum while denser than the air: a collapsing fountain. */
  readonly collapse: boolean;
  /** The axis up to the top. */
  readonly samples: readonly ColumnSample[];
}

/** The umbrella cloud now. */
export interface UmbrellaCloud {
  /** World centre at the neutral level. */
  readonly centre: readonly [number, number, number];
  /** Radius of the spreading front, metres. */
  readonly radius: number;
  /** Mean thickness, metres. */
  readonly thickness: number;
  /** Fine ash still aloft in it, kg. */
  readonly ash: number;
  /** 1 - exp(-extinction x thickness). */
  readonly opacity: number;
}

/** One plume lightning strike: where and when it flashes. */
export interface EruptionStrike {
  readonly time: number;
  /** World point under the flash, on the vent's level. */
  readonly ground: readonly [number, number, number];
  /** Height of the flash above the vent, metres. */
  readonly height: number;
  readonly kind: 'vent' | 'plume';
  /** 0 to 1. */
  readonly strength: number;
}

// The engine calls an attached eruption makes: it leaves the scene it joined.
interface EruptionEngine {
  sceneOf?(plugin: object): { removePlugin(name: string): void } | undefined;
  removePlugin(name: string): void;
}
let attached = 0;

/** The sky's `Weather` of `@margoengine/sky` as {@link Eruption.flashLightning} uses it. */
export interface EruptionSky {
  readonly listener: ArrayLike<number>;
  strike(options: { distance?: number; azimuth?: number; strength?: number }): unknown;
}

/** An `AshEvent` of `@margoengine/terrain/ground-change` for {@link Eruption.ashEvent}. */
export interface EruptionAshEvent {
  kind: 'ash';
  vent: [number, number];
  start: number;
  duration: number;
  thickness: number;
  half: number;
  wind: [number, number];
  elongation: number;
  seed: number;
}

/** What {@link Eruption.drawPlume} draws into: a `Clouds` of `@margoengine/vfx/clouds` fits it. */
export interface PlumeCloudTarget {
  add(options: Record<string, unknown>): { options: { opacity?: number }; matrix: Float32Array };
  remove(cloud: object): boolean;
}

const RANGES: Record<string, readonly [number, number]> = {
  ventAltitude: [0, 8000],
  start: [0, 1e9],
  rise: [1, 86400],
  duration: [0, 1e6],
  wane: [1, 86400],
  massRate: [1e3, 1e10],
  height: [500, 50000],
  exitVelocity: [10, 600],
  exitTemperature: [600, 1600],
  gasFraction: [0.005, 0.2],
  entrainment: [0.02, 0.2],
  windEntrainment: [0, 1.5],
  airTemperature: [220, 320],
  tropopause: [6000, 20000],
  wind: [0, 60],
  windDirection: [-360, 360],
  frontSpeed: [0.1, 1],
  umbrellaSpread: [0.05, 1],
  grainSize: [-4, 8],
  grainSorting: [0.5, 4],
  ashDensity: [500, 3000],
  depositDensity: [300, 2000],
  diffusion: [0, 1e5],
  lightningRate: [0, 600],
  ventLightning: [0, 1],
  timeScale: [0, 100],
};

/** Throws for any invalid field of `o`. */
export function validateEruption(o: EruptionOptions): void {
  if (!o || typeof o !== 'object') throw new TypeError('Eruption options must be an object');
  for (const [name, [lo, hi]] of Object.entries(RANGES)) {
    const v = (o as Record<string, unknown>)[name];
    if (v === undefined || (v === null && name === 'height')) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
      throw new RangeError(`Eruption ${name} must be a finite number from ${lo} to ${hi}; got ${String(v)}`);
  }
  for (const name of ['vent', 'color', 'umbrellaColor'] as const) {
    const v = o[name];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
      throw new TypeError(`Eruption ${name} must be three finite numbers`);
    if (name !== 'vent' && !v.every((x) => x >= 0 && x <= 1))
      throw new RangeError(`Eruption ${name} must be from 0 to 1`);
  }
  if (o.seed !== undefined && !Number.isInteger(o.seed)) throw new RangeError('Eruption seed must be an integer');
}

/** Mass eruption rate, kg/s, of a column `height` metres above the vent: Mastin et al. (2009), 2500 (H / 2 km)^4.15. */
export function mastinRate(height: number): number {
  return MAGMA * (height / 2000) ** 4.15;
}
/** Column height above the vent, metres, for a mass eruption rate `rate` kg/s: Mastin et al. (2009) inverted. */
export function mastinHeight(rate: number): number {
  return 2000 * (rate / MAGMA) ** (1 / 4.15);
}

/** The ICAO standard atmosphere shifted to a sea-level temperature: [temperature K, pressure Pa] at `z` metres. */
export function standardAtmosphere(z: number, seaLevel = 288.15, tropopause = 11000): [number, number] {
  // Layers: lapse to the tropopause, isothermal 9 km, +1 K/km to 32 km, +2.8 K/km to 47 km, isothermal above.
  const layers: [number, number][] = [
    [tropopause, -0.0065],
    [tropopause + 9000, 0],
    [32000, 0.001],
    [47000, 0.0028],
    [Infinity, 0],
  ];
  let T = seaLevel,
    P = 101325,
    base = 0;
  for (const [top, lapse] of layers) {
    const h = Math.min(Math.max(z, base), Math.max(top, base)) - base;
    const T1 = T + lapse * h;
    P = lapse === 0 ? P * Math.exp((-G * h) / (R_ICAO * T)) : P * (T1 / T) ** (-G / (lapse * R_ICAO));
    T = T1;
    if (z <= top) break;
    base = Math.max(top, base);
  }
  return [T, P];
}

/**
 * Fall speed, m/s, of a grain of diameter `d` metres and density `rho` in air of density `air`: Stokes under a
 * Reynolds number of 6, the intermediate law to 500, the turbulent law above (Bonadonna et al. 1998).
 */
export function ashFallSpeed(d: number, rho: number, air: number, viscosity = AIR_VISCOSITY): number {
  const stokes = (rho * G * d * d) / (18 * viscosity);
  if ((air * stokes * d) / viscosity < 6) return stokes;
  const mid = d * ((4 * rho * rho * G * G) / (225 * viscosity * air)) ** (1 / 3);
  if ((air * mid * d) / viscosity < 500) return mid;
  return Math.sqrt((3.1 * rho * G * d) / air);
}

interface Profile {
  readonly rate: number;
  readonly s: Float64Array;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly b: Float64Array;
  readonly u: Float64Array;
  readonly rho: Float64Array;
  readonly air: Float64Array;
  readonly T: Float64Array;
  /** Seconds the front takes to reach each sample. */
  readonly time: Float64Array;
  readonly top: number;
  readonly buoyantFrom: number | null;
  readonly neutral: number | null;
  readonly neutralIndex: number;
  readonly collapse: boolean;
}

interface FallClass {
  readonly share: number;
  readonly radius: number;
  /** Seconds from the vent to landing. */
  readonly delay: number;
  /** Landing centre relative to the vent, downwind metres. */
  readonly along: number;
  /** Spread (Gaussian sigma), metres. */
  readonly sigma: number;
  /** Fall speed near the ground, m/s. */
  readonly speed: number;
  /** Lands from the umbrella (fine) rather than the column's margin. */
  readonly umbrella: boolean;
}

/** lowbias32 (C. Wellons, "Prospecting for Hash Functions"), as a number in [0, 1). */
const hash = (x: number): number => {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
};

/**
 * A volcanic eruption column: the gas-thrust region and the buoyant plume above it (Woods 1988), bent over by the
 * wind (Woodhouse et al. 2013), its top rising over film time; the umbrella cloud spreading at the level of neutral
 * buoyancy (Woods and Kienle 1994); ash falling out of it downwind, grain class by grain class, onto the ground
 * (Carey and Sparks 1986; Bonadonna et al. 1998, 2005); and lightning in the plume. Too dense a mixture collapses as a
 * fountain (`column().collapse`). `seek` to any time gives the same eruption however it got there.
 * @example
 * const eruption = new Eruption({ vent: [0, 1500, 0], massRate: 2e7, weather });
 * engine.onFrame((_, dt) => { eruption.update(dt); eruption.drawPlume(clouds); eruption.flashLightning(sky); });
 */
export class Eruption {
  /** The options; change them at any time (a changed option takes effect at the next read). */
  readonly options: EruptionOptions;
  /** Its plugin name: `eruption:N` once added with {@link Eruption.attach}, which is how a `WeatherDrive` finds its falling ash. */
  readonly name: string = 'eruption';
  private engine?: EruptionEngine;
  private film = 0;
  private cache = new Map<string, Profile>();
  private fallKey = '';
  private fall: FallClass[] = [];
  private fired = 0;
  private puffs = new Map<string, { options: { opacity?: number }; matrix: Float32Array }>();
  private target?: PlumeCloudTarget;

  constructor(options: EruptionOptions = {}) {
    validateEruption(options);
    this.options = options;
  }

  /**
   * A new eruption added to an engine as a plugin named `eruption:N`: it steps its own film time each frame (`update`),
   * and a `WeatherDrive` in the scene takes its falling ash at the camera into the weather's `ash`, so the sun dims and
   * the fog greys under the cloud with no wiring by hand. `dispose()` takes it out.
   * @example const eruption = Eruption.attach(engine, { vent: [0, 1300, 0], weather });
   */
  static attach(engine: { use(plugin: object): unknown }, options: EruptionOptions = {}): Eruption {
    const eruption = new Eruption(options);
    (eruption as { name: string }).name = 'eruption:' + ++attached;
    engine.use(eruption);
    return eruption;
  }
  /** Engine plugin hooks. */
  setup(engine: EruptionEngine): void {
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.update(delta);
  }
  /** Takes the plume's clouds out of their `Clouds` and an attached eruption out of its engine (the options stay; reads still work). */
  dispose(): void {
    this.clearPlume();
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
  /**
   * Moves film time on by `delta` real seconds times `timeScale`, as {@link update}: the clock a seek from `@margoengine/cutscene/seek` replays
   * (pass this eruption in its `extra`), so a scene started at film time T shows what a continuous run shows at T, bit for
   * bit (GAP-FILM-TIME).
   */
  advanceTime(delta: number): void {
    this.update(delta);
  }
  /** Moves film time on by `delta` real seconds times `timeScale`. */
  update(delta: number): void {
    if (!(delta >= 0) || !Number.isFinite(delta))
      throw new RangeError('Eruption update needs a finite delta, 0 or more');
    this.seek(this.film + delta * (this.options.timeScale ?? 1));
  }
  /** Goes to film second `t`; going back fires no lightning again. */
  seek(t: number): void {
    if (!(t >= 0) || !Number.isFinite(t)) throw new RangeError('Eruption seek needs a finite time, 0 or more');
    validateEruption(this.options);
    if (t < this.film) this.fired = t;
    this.film = t;
  }

  /** Mass eruption rate at full rate, kg/s: `massRate`, or Mastin et al.'s rate for `height`. */
  peakRate(): number {
    const o = this.options;
    return o.height != null ? mastinRate(o.height) : (o.massRate ?? 1e7);
  }
  /** Share of the full rate at film second `t`, 0 to 1. */
  envelope(t = this.film): number {
    const o = this.options,
      t0 = o.start ?? 0,
      rise = o.rise ?? 60,
      hold = o.duration ?? 3600,
      wane = o.wane ?? 300,
      a = t - t0;
    if (a <= 0) return 0;
    if (a < rise) return a / rise;
    if (a < rise + hold) return 1;
    return Math.max(0, 1 - (a - rise - hold) / wane);
  }
  /** Mass erupted by film second `t`, kg. */
  erupted(t = this.film): number {
    const o = this.options,
      rise = o.rise ?? 60,
      hold = o.duration ?? 3600,
      wane = o.wane ?? 300,
      a = Math.max(0, t - (o.start ?? 0)),
      r = Math.min(a, rise),
      h = Math.min(Math.max(a - rise, 0), hold),
      w = Math.min(Math.max(a - rise - hold, 0), wane);
    return this.peakRate() * ((0.5 * (r * r)) / rise + h + w - (0.5 * w * w) / wane);
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

  private windAt(speed10: number, z: number): number {
    const o = this.options,
      ground = o.ventAltitude ?? o.vent?.[1] ?? 0,
      cap = Math.max(10, (o.tropopause ?? 11000) - ground);
    return speed10 * (Math.min(Math.max(z, 1), cap) / 10) ** (1 / 7);
  }

  /** The steady column for mass rate `rate` (Woods 1988 bent over as Woodhouse et al. 2013), cached. */
  private profile(rate: number): Profile {
    const o = this.options,
      [wx, wz] = this.windNow(),
      V10 = Math.hypot(wx, wz),
      key = [
        rate,
        V10,
        o.ventAltitude,
        o.vent?.[1],
        o.exitVelocity,
        o.exitTemperature,
        o.gasFraction,
        o.entrainment,
        o.windEntrainment,
        o.airTemperature,
        o.tropopause,
        o.frontSpeed,
      ].join();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const ground = o.ventAltitude ?? o.vent?.[1] ?? 0,
      sea = o.airTemperature ?? 288.15,
      tropo = o.tropopause ?? 11000,
      u0 = o.exitVelocity ?? 200,
      T0 = o.exitTemperature ?? 1200,
      n0 = o.gasFraction ?? 0.04,
      alpha = o.entrainment ?? 0.09,
      beta = o.windEntrainment ?? 0.5,
      front = o.frontSpeed ?? 0.5,
      Q0 = rate / Math.PI,
      solids = (1 - n0) * Q0,
      vapour = n0 * Q0;
    // State along the axis: mass flux Q, horizontal and vertical momentum fluxes, energy flux, x and z (per pi).
    const mix = (y: readonly number[]) => {
      const [Q, Px, Pz, E, , z] = y as [number, number, number, number, number, number],
        u = Math.hypot(Px, Pz) / Q,
        air = Q - Q0,
        cp = (solids * C_SOLID + vapour * C_VAPOUR + air * C_AIR) / Q,
        T = (E / Q - 0.5 * u * u - G * z) / cp,
        gas = vapour + air,
        Rg = (vapour * R_VAPOUR + air * R_AIR) / gas,
        n = gas / Q,
        [Ta, Pa] = standardAtmosphere(ground + z, sea, tropo),
        rho = 1 / ((n * Rg * T) / Pa + (1 - n) / MAGMA),
        rhoA = Pa / (R_AIR * Ta),
        b = Math.sqrt(Q / (rho * u));
      return { u, T, rho, rhoA, Ta, b };
    };
    const rhs = (y: readonly number[]): number[] => {
      const m = mix(y),
        cos = y[1]! / (y[0]! * m.u),
        sin = y[2]! / (y[0]! * m.u),
        V = this.windAt(V10, y[5]!),
        Ue = alpha * Math.abs(m.u - V * cos) + beta * Math.abs(V * sin),
        dQ = 2 * m.rhoA * m.b * Ue;
      return [dQ, V * dQ, G * (m.rhoA - m.rho) * m.b * m.b, (C_AIR * m.Ta + G * y[5]! + 0.5 * V * V) * dQ, cos, sin];
    };
    let y = [Q0, 0, Q0 * u0, Q0 * ((solids * C_SOLID + vapour * C_VAPOUR) / Q0) * T0 + 0.5 * Q0 * u0 * u0, 0, 0],
      s = 0,
      time = 0,
      buoyant = false,
      buoyantFrom: number | null = null,
      neutral: number | null = null,
      neutralIndex = -1;
    const S: number[] = [],
      X: number[] = [],
      Z: number[] = [],
      B: number[] = [],
      U: number[] = [],
      R: number[] = [],
      A: number[] = [],
      TT: number[] = [],
      TI: number[] = [];
    const record = (): void => {
      const m = mix(y);
      S.push(s);
      X.push(y[4]!);
      Z.push(y[5]!);
      B.push(m.b);
      U.push(m.u);
      R.push(m.rho);
      A.push(m.rhoA);
      TT.push(m.T);
      TI.push(time);
    };
    record();
    for (let i = 0; i < 200000 && y[2]! > 0 && y[5]! < 80000; i++) {
      const m = mix(y),
        ds = Math.min(50, Math.max(0.5, 0.1 * m.b)),
        k1 = rhs(y),
        k2 = rhs(y.map((v, j) => v + 0.5 * ds * k1[j]!)),
        k3 = rhs(y.map((v, j) => v + 0.5 * ds * k2[j]!)),
        k4 = rhs(y.map((v, j) => v + ds * k3[j]!)),
        next = y.map((v, j) => v + (ds / 6) * (k1[j]! + 2 * k2[j]! + 2 * k3[j]! + k4[j]!));
      if (!(next[2]! > 0) || !next.every(Number.isFinite)) break;
      time += ds / (front * Math.max(1e-3, 0.5 * (m.u + Math.hypot(next[1]!, next[2]!) / next[0]!)));
      y = next;
      s += ds;
      const after = mix(y);
      if (!buoyant && after.rho < after.rhoA) {
        buoyant = true;
        buoyantFrom = y[5]!;
      } else if (buoyant && neutral === null && after.rho >= after.rhoA) {
        neutral = y[5]!;
        neutralIndex = S.length;
      }
      record();
    }
    const top = Z[Z.length - 1]!;
    if (buoyant && neutral === null) {
      neutral = top;
      neutralIndex = S.length - 1;
    }
    const p: Profile = {
      rate,
      s: Float64Array.from(S),
      x: Float64Array.from(X),
      z: Float64Array.from(Z),
      b: Float64Array.from(B),
      u: Float64Array.from(U),
      rho: Float64Array.from(R),
      air: Float64Array.from(A),
      T: Float64Array.from(TT),
      time: Float64Array.from(TI),
      top,
      buoyantFrom,
      neutral,
      neutralIndex,
      collapse: !buoyant,
    };
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(key, p);
    return p;
  }

  /** The world place of a point `along` metres downwind and `up` metres above the vent. */
  private world(along: number, up: number, across = 0): [number, number, number] {
    const v = this.options.vent ?? [0, 0, 0],
      [wx, wz] = this.windNow(),
      l = Math.hypot(wx, wz),
      dx = l > 0 ? wx / l : 0,
      dz = l > 0 ? wz / l : 1;
    return [v[0] + along * dx + across * dz, v[1] + up, v[2] + along * dz - across * dx];
  }

  /** The column now: its rate, its rising top and the axis up to it. */
  column(): EruptionColumn {
    const rate = this.peakRate() * this.envelope(),
      since = this.film - (this.options.start ?? 0);
    if (!(rate > 0))
      return { massRate: 0, top: 0, steadyTop: 0, buoyantFrom: null, neutral: null, collapse: false, samples: [] };
    const p = this.profile(rate),
      samples: ColumnSample[] = [];
    let top = 0;
    for (let i = 0; i < p.s.length; i++) {
      if (p.time[i]! > since) break;
      top = p.z[i]!;
      if (i % Math.max(1, Math.floor(p.s.length / 256)) === 0 || i === p.s.length - 1)
        samples.push({
          position: this.world(p.x[i]!, p.z[i]!),
          radius: p.b[i]!,
          speed: p.u[i]!,
          density: p.rho[i]!,
          airDensity: p.air[i]!,
          temperature: p.T[i]!,
        });
    }
    return {
      massRate: rate,
      top,
      steadyTop: p.top,
      buoyantFrom: p.buoyantFrom,
      neutral: p.collapse ? null : p.neutral,
      collapse: p.collapse,
      samples,
    };
  }

  /** The umbrella cloud now, or null before the top first reaches the neutral level (or when the column collapses). */
  umbrella(): UmbrellaCloud | null {
    const o = this.options,
      peak = this.profile(this.peakRate());
    if (peak.collapse || peak.neutralIndex < 0) return null;
    const t0 = (o.start ?? 0) + peak.time[peak.neutralIndex]!,
      t = this.film;
    if (t <= t0) return null;
    const i = peak.neutralIndex,
      zB = peak.z[i]!,
      [Ta] = standardAtmosphere(
        (o.ventAltitude ?? o.vent?.[1] ?? 0) + zB,
        o.airTemperature ?? 288.15,
        o.tropopause ?? 11000,
      ),
      [Tb] = standardAtmosphere(
        (o.ventAltitude ?? o.vent?.[1] ?? 0) + zB + 100,
        o.airTemperature ?? 288.15,
        o.tropopause ?? 11000,
      ),
      // Buoyancy frequency: N^2 = (g / T)(dT/dz + g / c_p).
      N = Math.sqrt(Math.max(1e-6, (G / Ta) * ((Tb - Ta) / 100 + G / C_AIR))),
      lambda = o.umbrellaSpread ?? 0.2,
      // Volume flux into the umbrella at the full rate, scaled by the share erupting (pi b^2 u at the neutral level).
      qPeak = Math.PI * peak.b[i]! ** 2 * peak.u[i]!,
      volume = (qPeak / this.peakRate()) * Math.max(0, this.erupted(t) - this.erupted(t0)),
      // dR/dt = lambda N h with h = volume / (pi R^2): R^3 grows as 3 lambda N times the volume's integral / pi.
      R = Math.cbrt(((3 * lambda * N) / Math.PI) * this.volumeIntegral(t0, t, qPeak)),
      [wx, wz] = this.windNow(),
      V = this.windAt(Math.hypot(wx, wz), zB),
      along = peak.x[i]! + V * (t - t0),
      thickness = R > 0 ? volume / (Math.PI * R * R) : 0,
      [aloft, area] = this.umbrellaAsh(t),
      // Extinction 3 C / (2 rho r) summed over the classes aloft (van de Hulst 1957).
      ext = volume > 0 ? (3 * area) / (2 * (o.ashDensity ?? 2500) * volume) : 0;
    return { centre: this.world(along, zB), radius: R, thickness, ash: aloft, opacity: 1 - Math.exp(-ext * thickness) };
  }

  /** The integral of the umbrella's volume from `t0` to `t` (it grows at q times the envelope). */
  private volumeIntegral(t0: number, t: number, q: number): number {
    // Fixed 64-point midpoint rule: deterministic and smooth over film time.
    const n = 64,
      h = (t - t0) / n,
      peak = this.peakRate(),
      e0 = this.erupted(t0);
    let sum = 0;
    for (let k = 0; k < n; k++) sum += (q / peak) * (this.erupted(t0 + (k + 0.5) * h) - e0);
    return sum * h;
  }

  /** The grain classes' fall from the column at the full rate (Carey and Sparks 1986; Bonadonna et al. 1998, 2005). */
  private classes(): FallClass[] {
    const o = this.options,
      [wx, wz] = this.windNow(),
      key = [
        this.peakRate(),
        Math.hypot(wx, wz),
        o.grainSize,
        o.grainSorting,
        o.ashDensity,
        o.diffusion,
        o.ventAltitude,
        o.vent?.[1],
        o.exitVelocity,
        o.exitTemperature,
        o.gasFraction,
        o.entrainment,
        o.windEntrainment,
        o.airTemperature,
        o.tropopause,
        o.frontSpeed,
        o.umbrellaSpread,
      ].join();
    if (key === this.fallKey) return this.fall;
    const p = this.profile(this.peakRate()),
      mean = o.grainSize ?? 2,
      sort = o.grainSorting ?? 2.5,
      rhoS = o.ashDensity ?? 2500,
      K = o.diffusion ?? 2000,
      ground = o.ventAltitude ?? o.vent?.[1] ?? 0,
      sea = o.airTemperature ?? 288.15,
      tropo = o.tropopause ?? 11000,
      V10 = Math.hypot(wx, wz),
      out: FallClass[] = [];
    let total = 0;
    const weights: number[] = [];
    for (let phi = -5; phi <= 10; phi++) {
      const w = Math.exp(-0.5 * ((phi - mean) / sort) ** 2);
      weights.push(w);
      total += w;
    }
    const top = p.neutralIndex >= 0 ? p.neutralIndex : p.s.length - 1;
    for (let c = 0, phi = -5; phi <= 10; phi++, c++) {
      const d = 1e-3 * 2 ** -phi;
      // Where the column can no longer carry it: its speed under the grain's fall speed, else the neutral level.
      let k = top;
      for (let i = 0; i <= top; i++) {
        const v = ashFallSpeed(d, rhoS, p.air[i]!);
        if (p.z[i]! > 0 && p.u[i]! < v) {
          k = i;
          break;
        }
      }
      const umbrella = k === top && !p.collapse;
      // Fall through 32 layers to the vent's level, carried by the wind it falls through.
      const z0 = p.z[k]!,
        layers = 32,
        dz = z0 / layers;
      let fallTime = 0,
        drift = 0,
        speed = 0;
      for (let l = 0; l < layers; l++) {
        const z = z0 - (l + 0.5) * dz,
          [Ta, Pa] = standardAtmosphere(ground + z, sea, tropo),
          v = ashFallSpeed(d, rhoS, Pa / (R_AIR * Ta));
        fallTime += dz / v;
        drift += (this.windAt(V10, z) * dz) / v;
        speed = v;
      }
      // The umbrella's fines leave over twice the column's radius at the neutral level (a model choice), the rest its radius.
      const source = umbrella ? 2 * p.b[k]! : p.b[k]!;
      out.push({
        share: weights[c]! / total,
        radius: d / 2,
        delay: p.time[k]! + fallTime,
        along: p.x[k]! + drift,
        sigma: Math.sqrt(source * source + 2 * K * fallTime),
        speed,
        umbrella,
      });
    }
    this.fall = out;
    this.fallKey = key;
    return out;
  }

  /** Ash still in the umbrella at `t`, kg, and its sum of mass over grain radius, kg/m: classes erupted, not landed. */
  private umbrellaAsh(t: number): [number, number] {
    let m = 0,
      a = 0;
    for (const c of this.classes())
      if (c.umbrella) {
        const k = Math.max(0, c.share * (this.erupted(t) - this.erupted(t - c.delay)));
        m += k;
        a += k / c.radius;
      }
    return [m, a];
  }

  /** Ash on the ground at world (x, z) now, kg/m^2. */
  ashLoad(x: number, z: number): number {
    const v = this.options.vent ?? [0, 0, 0],
      [wx, wz] = this.windNow(),
      l = Math.hypot(wx, wz),
      dx = l > 0 ? wx / l : 0,
      dz = l > 0 ? wz / l : 1,
      rx = x - v[0],
      rz = z - v[2],
      s = rx * dx + rz * dz,
      c = rx * dz - rz * dx;
    let load = 0;
    for (const k of this.classes()) {
      const landed = k.share * this.erupted(this.film - k.delay);
      if (!(landed > 0)) continue;
      const r2 = (s - k.along) ** 2 + c * c;
      load += (landed / (2 * Math.PI * k.sigma * k.sigma)) * Math.exp(-r2 / (2 * k.sigma * k.sigma));
    }
    return load;
  }
  /** Fallen ash thickness at world (x, z) now, metres (`ashLoad` over `depositDensity`). */
  ashThickness(x: number, z: number): number {
    return this.ashLoad(x, z) / (this.options.depositDensity ?? 1000);
  }
  /** Ash falling through the air near the ground at world (x, z) now, kg/m^3 (the landing flux over the fall speed). */
  airAsh(x: number, z: number): number {
    const v = this.options.vent ?? [0, 0, 0],
      [wx, wz] = this.windNow(),
      l = Math.hypot(wx, wz),
      dx = l > 0 ? wx / l : 0,
      dz = l > 0 ? wz / l : 1,
      s = (x - v[0]) * dx + (z - v[2]) * dz,
      c = (x - v[0]) * dz - (z - v[2]) * dx;
    let conc = 0;
    for (const k of this.classes()) {
      const flux = k.share * this.peakRate() * this.envelope(this.film - k.delay);
      if (!(flux > 0)) continue;
      const r2 = (s - k.along) ** 2 + c * c;
      conc += ((flux / (2 * Math.PI * k.sigma * k.sigma)) * Math.exp(-r2 / (2 * k.sigma * k.sigma))) / k.speed;
    }
    return conc;
  }
  /** How far one sees through the falling ash at world (x, z) now, metres (Koschmieder, 3.912 / extinction). */
  visibility(x: number, z: number): number {
    const v = this.options.vent ?? [0, 0, 0],
      [wx, wz] = this.windNow(),
      l = Math.hypot(wx, wz),
      dx = l > 0 ? wx / l : 0,
      dz = l > 0 ? wz / l : 1,
      s = (x - v[0]) * dx + (z - v[2]) * dz,
      c = (x - v[0]) * dz - (z - v[2]) * dx,
      rho = this.options.ashDensity ?? 2500;
    let ext = 3.912 / 23000;
    for (const k of this.classes()) {
      const flux = k.share * this.peakRate() * this.envelope(this.film - k.delay);
      if (!(flux > 0)) continue;
      const r2 = (s - k.along) ** 2 + c * c,
        conc = ((flux / (2 * Math.PI * k.sigma * k.sigma)) * Math.exp(-r2 / (2 * k.sigma * k.sigma))) / k.speed;
      ext += (3 * conc) / (2 * rho * k.radius);
    }
    return 3.912 / ext;
  }

  /**
   * Fallen ash thickness over a grid, metres: `width` by `depth` samples `cellSize` apart from world `origin` [x, z],
   * row by row (a `GroundGrid` of `@margoengine/terrain/ground-change` fits it).
   */
  ashGrid(grid: {
    readonly width: number;
    readonly depth: number;
    readonly cellSize: number;
    readonly origin: readonly [number, number];
  }): Float32Array {
    const out = new Float32Array(grid.width * grid.depth);
    for (let j = 0; j < grid.depth; j++)
      for (let i = 0; i < grid.width; i++)
        out[j * grid.width + i] = this.ashThickness(
          grid.origin[0] + i * grid.cellSize,
          grid.origin[1] + j * grid.cellSize,
        );
    return out;
  }

  /**
   * The whole fall as an ash event for `GroundChange` (`@margoengine/terrain/ground-change`): `ground.add(e.ashEvent())`.
   * Its thickness at the vent, its crosswind halving distance and its downwind stretch are fitted to this eruption's
   * deposit when the fall ends (its quarter-thickness reach downwind and across), its start and length to the first
   * and last landing.
   */
  ashEvent(): EruptionAshEvent {
    const o = this.options,
      classes = this.classes(),
      v = o.vent ?? [0, 0, 0],
      [wx, wz] = this.windNow(),
      l = Math.hypot(wx, wz),
      dx = l > 0 ? wx / l : 0,
      dz = l > 0 ? wz / l : 1,
      first = Math.min(...classes.map((c) => c.delay)),
      last = Math.max(...classes.filter((c) => c.share > 1e-3).map((c) => c.delay)),
      keep = this.film;
    this.film = this.end + last;
    const at = (s: number, c: number) => this.ashThickness(v[0] + s * dx + c * dz, v[2] + s * dz - c * dx),
      T = Math.max(at(0, 0), 1e-6),
      reach = (f: (r: number) => number): number => {
        let lo = 0,
          hi = 1;
        while (f(hi) >= T / 4 && hi < 4e6) hi *= 2;
        for (let k = 0; k < 40; k++) {
          const mid = 0.5 * (lo + hi);
          if (f(mid) >= T / 4) lo = mid;
          else hi = mid;
        }
        return Math.max(lo, 1);
      },
      down = reach((r) => at(r, 0)),
      across = reach((r) => at(0, r));
    this.film = keep;
    // The event's quarter isopach reaches (2g - 1) 2 half downwind and 2 half sqrt(2g - 1) / g across the vent.
    let g = 1;
    for (let lo = 1, hi = 12, k = 0; k < 50; k++) {
      g = 0.5 * (lo + hi);
      if (g * Math.sqrt(2 * g - 1) < down / across) lo = g;
      else hi = g;
    }
    return {
      kind: 'ash',
      vent: [v[0], v[2]],
      start: (o.start ?? 0) + first,
      duration: Math.max(1e-3, this.end + last - (o.start ?? 0) - first),
      thickness: T,
      half: down / (2 * (2 * g - 1)),
      wind: [wx, wz],
      elongation: g,
      seed: o.seed ?? 1,
    };
  }

  /** Strikes per second at film second `t`: `lightningRate` per minute at 1e7 kg/s, in proportion to the rate. */
  private strikeRate(t: number): number {
    return (((this.options.lightningRate ?? 6) / 60) * this.peakRate() * this.envelope(t)) / 1e7;
  }

  /** The plume's lightning strikes from film second `from` (excluded) to `to` (included), in time order. */
  strikes(from: number, to: number): EruptionStrike[] {
    const o = this.options,
      seed = (o.seed ?? 1) >>> 0,
      out: EruptionStrike[] = [],
      start = o.start ?? 0;
    // One-second bins after the start: each holds floor(rate + u) strikes, u hashed from the seed and the bin.
    for (let bin = Math.max(0, Math.floor(from - start)); bin <= Math.floor(to - start); bin++) {
      const t0 = start + bin,
        lam = this.strikeRate(t0 + 0.5),
        n = Math.floor(lam + hash(seed * 0x9e3779b1 + bin * 4 + 1));
      for (let k = 0; k < n; k++) {
        const h = (j: number) => hash((seed * 0x9e3779b1) ^ (bin * 977 + k * 131 + j * 7919)),
          time = t0 + h(1);
        if (!(time > from && time <= to)) continue;
        const vent = h(2) < (o.ventLightning ?? 0.3),
          p = this.profile(this.peakRate() * this.envelope(time)),
          reached = p.time.findIndex((x) => x > time - start),
          last = reached < 0 ? p.s.length - 1 : Math.max(0, reached - 1),
          // Vent discharges in the lowest tenth of the column; plume lightning above it, up to the top reached.
          i = vent ? Math.floor(h(3) * Math.max(1, last * 0.1)) : Math.floor(last * (0.1 + 0.9 * h(3))),
          spread = p.b[i]! * (2 * h(4) - 1);
        out.push({
          time,
          ground: this.world(p.x[i]!, 0, spread),
          height: p.z[i]!,
          kind: vent ? 'vent' : 'plume',
          strength: vent ? 0.3 + 0.3 * h(5) : 0.6 + 0.4 * h(5),
        });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /**
   * Flashes the strikes since the last call through the sky's `Weather` (`@margoengine/sky`): each becomes a
   * `weather.strike` at its place from the listener, so its light, the cloud deck and the thunder follow the sky's own
   * lightning link. Call once a frame after `update`; a seek back fires nothing again.
   */
  flashLightning(sky: EruptionSky): EruptionStrike[] {
    const list = this.strikes(this.fired, this.film);
    this.fired = this.film;
    for (const s of list) {
      const dx = s.ground[0] - (sky.listener[0] ?? 0),
        dz = s.ground[2] - (sky.listener[2] ?? 0);
      sky.strike({ distance: Math.min(1e5, Math.hypot(dx, dz)), azimuth: Math.atan2(dx, dz), strength: s.strength });
    }
    return list;
  }

  /**
   * Puts the column and the umbrella into `clouds` (a `Clouds` of `@margoengine/vfx/clouds`): `segments` clouds of
   * soft lit puffs along the column's axis up to its top, sized by its radius, and one flat cloud for the umbrella.
   * Call after `update`.
   */
  drawPlume(clouds: PlumeCloudTarget, segments = 16, puffs = 32): void {
    if (this.target && this.target !== clouds) this.clearPlume();
    this.target = clouds;
    const o = this.options,
      col = this.column(),
      live = new Set<string>(),
      seed = o.seed ?? 1;
    const place = (
      id: string,
      options: Record<string, unknown>,
      opacity: number,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
    ): void => {
      live.add(id);
      let c = this.puffs.get(id);
      if (!c) {
        c = clouds.add(options);
        this.puffs.set(id, c);
      }
      c.options.opacity = opacity;
      const m = c.matrix;
      m.fill(0);
      m[0] = sx;
      m[5] = sy;
      m[10] = sx;
      m[12] = x;
      m[13] = y;
      m[14] = z;
      m[15] = 1;
    };
    const n = col.samples.length;
    if (n > 1) {
      const count = Math.min(segments, n - 1);
      for (let k = 0; k < count; k++) {
        const a = col.samples[Math.floor((k * (n - 1)) / count)]!,
          b = col.samples[Math.floor(((k + 1) * (n - 1)) / count)]!,
          r = 0.5 * (a.radius + b.radius),
          len = Math.max(r, b.position[1] - a.position[1]);
        place(
          `c${k}`,
          {
            seed: seed * 97 + k,
            segments: puffs,
            bounds: [2, 1, 2],
            volume: 1.6,
            color: [...(o.color ?? [0.3, 0.28, 0.26])],
            concentrate: 'inside',
          },
          1,
          0.5 * (a.position[0] + b.position[0]),
          0.5 * (a.position[1] + b.position[1]),
          0.5 * (a.position[2] + b.position[2]),
          r,
          len,
        );
      }
    }
    const u = this.umbrella();
    if (u && u.radius > 0)
      place(
        'u',
        {
          seed: seed * 97 + 1000,
          segments: puffs * 2,
          bounds: [2, 1, 2],
          volume: 1.2,
          color: [...(o.umbrellaColor ?? [0.52, 0.5, 0.47])],
          concentrate: 'inside',
        },
        Math.min(1, Math.max(0.05, u.opacity)),
        u.centre[0],
        u.centre[1],
        u.centre[2],
        u.radius,
        Math.max(u.thickness, 0.05 * u.radius),
      );
    for (const [id, c] of this.puffs)
      if (!live.has(id)) {
        clouds.remove(c);
        this.puffs.delete(id);
      }
  }

  /** Takes every cloud {@link drawPlume} added out of its `Clouds`. */
  clearPlume(): void {
    for (const c of this.puffs.values()) this.target?.remove(c);
    this.puffs.clear();
  }
}

export {
  BlastCloud,
  airStability,
  thermalTop,
  type BlastCloudOptions,
  type BlastCloudTarget,
  type BlastDrawOptions,
  type BlastSource,
  type BlastThermal,
} from './thermal.js';
