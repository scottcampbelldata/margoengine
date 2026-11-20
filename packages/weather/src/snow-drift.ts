// Snow that drifts and slides: a snowpack on a height grid that the wind scours from windward slopes and drops on lee
// slopes, that builds cornices on sharp lee edges, sloughs off slopes steeper than its angle of repose, and carries
// the slide state (a slab on a weak layer, and how near the slab is to sliding) the avalanche builds on. A pure,
// deterministic function of its options, the weather it follows and film time: a fixed simulation step, cells in a
// fixed order and no randomness, so a seek replays the same snow. Clean room from the papers, no other engine's code:
// - Rasmussen, Vivekanandan, Cole, Myers and Masters 1999, "The estimation of snowfall rate using visibility", J. Appl.
//   Meteor. 38(10): 1542-1563, https://doi.org/10.1175/1520-0450(1999)038<1542:TEOSRU>2.0.CO;2 : the extinction of
//   falling snow is twice its cross-section per volume, sigma = 2 S / (Vt (m/A)), so the liquid-equivalent rate S
//   follows from the visibility (Koschmieder) with the fall speed Vt and the mass per area m/A (0.02 g/cm^2 for dry
//   snow, 0.08 for wet). `snowfallRate` and `snowVisibility`.
// - Liston and Sturm 1998, "A snow-transport model for complex terrain", J. Glaciology 44(148): 498-516
//   (SnowTran-3D): snow depth changes by the divergence of the wind's transport, which the terrain speeds up and slows
//   down, with saltation and suspension, the transport limited by the snow there is to lift.
// - Liston and Elder 2006, "A meteorological distribution system for high-resolution terrestrial modeling (MicroMet)",
//   J. Hydrometeorology 7(2): 217-234: the wind weight W = 1 + gs Os + gc Oc from the slope along the wind Os and the
//   curvature Oc, each scaled to -0.5..0.5, gs = gc = 0.5 by default.
// - Winstral, Elder and Davis 2002, "Spatial snow modeling of wind-redistributed snow using terrain-based parameters",
//   J. Hydrometeorology 3(5): 524-538: Sx, the steepest upwind horizon angle within a search distance, marks the lee
//   cells the wind skips over, where drifts form.
// - Pomeroy and Gray 1990, "Saltation of snow", Water Resources Research 26(7): 1583-1594: Q_salt = 0.68 rho u*t
//   (u*^2 - u*t^2) / (u* g). Pomeroy, Gray and Landine 1993, "The Prairie Blowing Snow Model", J. Hydrology 144:
//   165-192: the total transport of a fully developed blowing snow, about U10^4.04 / 714,801 kg/m/s.
// - Li and Pomeroy 1997, "Estimates of threshold wind speeds for snow transport using meteorological data", J. Appl.
//   Meteor. 36(3): 205-213: dry snow moves above U10t = 9.43 + 0.18 T + 0.0033 T^2 m/s (about 7 to 9 m/s), wet snow
//   above about 9.9 m/s.
// - Takeuchi 1980, "Vertical profile and horizontal increase of drift-snow transport", J. Glaciology 26(94): 481-492:
//   the transport grows over a fetch of a few hundred metres before it is fully developed; where the wind can carry
//   less, saltating grains land within a few metres (their hops are centimetres to a metre), so it falls out faster.
// - Hedstrom and Pomeroy 1998, "Measurements and modelling of snow interception in the boreal forest", Hydrological
//   Processes 12: 1611-1625: new snow density 67.92 + 51.25 exp(T / 2.59) kg/m^3. Dai 2008, "Temperature and pressure
//   dependence of the rain-snow phase transition over land and ocean", GRL 35, L12802: half snow at about 1 C.
// - Fearing 2000, "Computer modelling of fallen snow", SIGGRAPH 2000: 37-46: snow is stable only below an angle of
//   repose and slides on to lower surfaces past it. Musgrave, Kolb and Mace 1989, "The synthesis and rendering of eroded
//   fractal terrains", SIGGRAPH 1989: material past its talus angle moves to lower neighbours in proportion to the drop.
// - Vogel, Eckerstorfer and Christiansen 2012, "Cornice dynamics and meteorological control at Gruvefjellet, Central
//   Svalbard", The Cryosphere 6: 157-171: cornices grow on lee edges from drifting snow and break off when they overhang
//   too far.
// - Foehn 1987, "The stability index and various triggering mechanisms", IAHS Publ. 162: 195-214: the stability index
//   S = shear strength of the weak layer / shear stress the slab puts on it (rho g h sin psi cos psi), plus a trigger's
//   added stress. Schweizer, Jamieson and Schneebeli 2003, "Snow avalanche formation", Reviews of Geophysics 41(4): 1016:
//   slab avalanches release on 30 to 45 degree slopes where a cohesive slab lies on a weak layer, most of them on buried
//   weak layers that formed at the surface in fair weather. Jamieson and Johnston 2001, "Evaluation of the shear frame
//   test for weak snowpack layers", Annals of Glaciology 32: 59-69: buried weak layers hold about 0.2 to 2 kPa and gain
//   strength with load and time.
// The combinations (the larger of saltation and the developed total, a relaxation over the fetch, the shelter weight,
// the cornice's capture and shape, the stability classes) are Margo's reading of those measurements.

import { snowExtinction } from './air.js';

/** What the drift follows: a `WeatherMachine` (anything with a `state`). */
export interface SnowDriftWeather {
  readonly state: {
    readonly snow: number;
    readonly wind: number;
    readonly windDirection: number;
    readonly temperature: number;
    readonly humidity: number;
  };
}

/** Options of a {@link SnowDrift}. Lengths in metres, angles in degrees. Out of range throws RangeError. */
export interface SnowDriftOptions {
  /** Height samples along x and z, 2 to 2048 each, at most 4,194,304 in all. Fixed. */
  readonly width: number;
  readonly depth: number;
  /** Metres between samples, 0.05 to 100. Default 1. Fixed. */
  readonly cellSize?: number;
  /** World x and z of the first sample. Default [0, 0]. Fixed. */
  readonly origin?: readonly [number, number];
  /** Ground heights (metres, `width * depth`, row by row along x). Default flat 0. Fixed. */
  readonly ground?: ArrayLike<number>;
  /** Snow already lying at time 0, metres (it is the old snow under the first weak layer). Default 0. Fixed. */
  readonly initialDepth?: number;
  /** Density of that snow, kg/m^3, 50 to 600. Default 250. Fixed. */
  readonly initialDensity?: number;
  /** Simulated seconds per step, 0.5 to 600. Default 10. Fixed (a change replays). */
  readonly step?: number;
  /** The weather to follow for every null weather value below. */
  weather?: SnowDriftWeather;
  /** Wind at 10 m, m/s, 0 to 60; null follows the weather (0 without one). */
  wind?: number | null;
  /** Direction the wind blows toward, degrees: 0 is +Z, 90 is +X; null follows the weather. */
  windDirection?: number | null;
  /** Snowfall, mm/h of water, 0 to 50; null follows the weather's snow by Rasmussen 1999 ({@link snowfallRate}). */
  snowfall?: number | null;
  /** Air temperature, C, -60 to 20; null follows the weather (-5 without one). */
  temperature?: number | null;
  /** Relative humidity 0 to 1; null follows the weather (0.8 without one). */
  humidity?: number | null;
  /** Simulated seconds per second of film, 0 to 100,000. Default 1. */
  timeScale?: number;
  /** Wind at 10 m at which snow starts to move, m/s, 2 to 30; null is Li and Pomeroy 1997 at the temperature. */
  threshold?: number | null;
  /** Surface roughness length of snow, m, 0.00001 to 0.01. Default 0.0005. */
  roughness?: number;
  /** Multiplies the transport, 0 to 10. Default 1. */
  transport?: number;
  /** Fetch over which the transport grows to the wind's capacity (e-folding), m, 1 to 2000. Default 100. */
  fetch?: number;
  /**
   * Distance over which snow in motion settles out where the wind can carry less (e-folding), m, 0.1 to 500. Default
   * 5: saltating grains land within a few metres, so lee slopes catch what the wind drops.
   */
  settle?: number;
  /** Slope weight gs, 0 to 2 (MicroMet 0.5). Default 0.5. */
  slopeWeight?: number;
  /** Curvature weight gc, 0 to 2 (MicroMet 0.5). Default 0.5. */
  curvatureWeight?: number;
  /** Length the curvature is measured over, m, 1 to 500. Default 20. */
  curvatureLength?: number;
  /** How much a lee cell's wind drops at full shelter, 0 to 1. Default 0.8. */
  shelter?: number;
  /** Upwind horizon angle of full shelter, degrees, 1 to 60. Default 15. */
  shelterAngle?: number;
  /** Upwind search distance of the shelter, m, 0 to 1000. Default 60. */
  shelterDistance?: number;
  /** Density wind-packed snow settles at, kg/m^3, 100 to 600. Default 300. */
  windDensity?: number;
  /** Share of the snow in motion lost to sublimation per 100 m of travel in dry air, 0 to 1. Default 0.02. */
  sublimation?: number;
  /** Snow blows in at the upwind edge as if a snowfield went on (true) or the edge is bare (false). Default true. */
  inflow?: boolean;
  /** Angle of repose: snow on a steeper surface sloughs to lower cells, degrees, 20 to 90 (90 never). Default 45. */
  repose?: number;
  /** A lee drop steeper than this makes a cornice at the edge above it, degrees, 15 to 89. Default 35. */
  corniceAngle?: number;
  /** Share of the snow in motion a cornice edge catches, 0 to 1. Default 0.25. */
  corniceCapture?: number;
  /** Density of cornice snow, kg/m^3, 200 to 600. Default 400. */
  corniceDensity?: number;
  /** Overhang at which a cornice breaks off onto the lee slope, m, 0.1 to 20. Default 3. */
  corniceMax?: number;
  /** Shear strength of a fresh weak layer, Pa, 50 to 10,000. Default 500 (buried surface hoar). */
  weakLayer?: number;
  /** Strength the weak layer gains per Pa of slab weight on it (a friction coefficient), 0 to 2. Default 0.2. */
  weakFriction?: number;
  /** Strength the weak layer gains per hour as it sinters, Pa, 0 to 1000. Default 15. */
  sintering?: number;
  /** Seconds of fair weather after which the surface becomes the next weak layer, 60 to 1,000,000. Default 21,600. */
  burial?: number;
  /** Shear stress a trigger adds to the weak layer (a skier is about 150 to 500 Pa at 1 m), Pa, 0 to 10,000. Default 0. */
  trigger?: number;
}

/** A cornice on a lee edge: where it stands, which way it leans and how big it is. */
export interface SnowCornice {
  /** The cell of the edge. */
  readonly cell: number;
  /** World place of the edge and the snow surface height there. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit direction the lip leans toward (downwind), x and z. */
  readonly direction: readonly [number, number];
  /** Snow held, kg per metre of edge. */
  readonly mass: number;
  /** How far the lip reaches past the edge, m. */
  readonly overhang: number;
  /** Height of the cornice above the edge, m. */
  readonly height: number;
}

/** A cornice that broke off: when, where and how much snow fell onto the lee slope. */
export interface SnowCorniceFall {
  readonly time: number;
  readonly cell: number;
  readonly x: number;
  readonly z: number;
  /** kg per metre of edge. */
  readonly mass: number;
}

/** Stability classes of {@link SnowDrift.stabilityIndex}: below 1 the slab releases by itself. */
export type SnowStability = 'none' | 'release' | 'poor' | 'fair' | 'good';

/** The slide state of every cell, the avalanche's input. Arrays are `width * depth`, row by row along x. */
export interface SnowSlideState {
  /** Slab above the top weak layer, m and kg/m^2. */
  readonly slabDepth: Float32Array;
  readonly slabMass: Float32Array;
  /** Old snow under the weak layer, m. */
  readonly baseDepth: Float32Array;
  /** Shear strength of the weak layer, Pa. */
  readonly strength: Float32Array;
  /** Shear stress the slab (and trigger) puts on it, Pa. */
  readonly stress: Float32Array;
  /** Slope of the bed (ground and old snow), degrees. */
  readonly slope: Float32Array;
  /** Strength over stress, capped at {@link STABILITY_MAX} (and that where there is no slab or no slope). */
  readonly index: Float32Array;
  /** Cells with an index under 1. */
  readonly release: number;
}

/** What the drift has done with the snow since time 0, kg (per the whole grid). */
export interface SnowBudget {
  fallen: number;
  blownIn: number;
  blownOut: number;
  sublimated: number;
  /** Snow held in cornices now. */
  cornices: number;
}

/** The highest stability index reported (no slab, flat bed or a very strong layer). */
export const STABILITY_MAX = 10;
/** Gravity, m/s^2. */
const G = 9.81;
const KARMAN = 0.4;

/** The extent of a field of height samples and the snow on it, which `Snow`'s `field` option reads. */
export interface SnowFieldSource {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly origin: readonly [number, number];
  /** Grows whenever {@link fieldData} changes. */
  readonly version: number;
  /** Ground height and snow depth per sample, interleaved (`2 * width * depth` values, row by row along x). */
  fieldData(): Float32Array;
}

/**
 * Liquid-equivalent snowfall, mm/h, of a weather's `snow` 0..1: the rate whose extinction (Rasmussen et al. 1999,
 * sigma = 2 S / (Vt m/A) with dry snow's Vt 1 m/s and m/A 0.2 kg/m^2) is the snow extinction `visibility` uses (the
 * Federal Meteorological Handbook No. 1 classes): about 0.9 mm/h at 0.35 (light), 1.9 at 0.65 (moderate), 4 at 1.
 */
export function snowfallRate(snow: number, fallSpeed = 1, massPerArea = 0.2): number {
  if (!(snow >= 0 && snow <= 1)) throw new RangeError('snowfallRate needs snow from 0 to 1');
  return ((snowExtinction(snow) * fallSpeed * massPerArea) / 2) * 3600;
}

/**
 * Visibility in metres in snow falling at `rate` mm/h of water (Rasmussen et al. 1999 with Koschmieder's 3.912):
 * 3.912 Vt (m/A) / (2 S). Dry snow (the default, Vt 1 m/s, m/A 0.2 kg/m^2) at 1 mm/h leaves about 1.4 km; wet snow
 * (`snowVisibility(rate, 1.5, 0.8)`) about four times more for the same rate. Infinity at rate 0.
 */
export function snowVisibility(rate: number, fallSpeed = 1, massPerArea = 0.2): number {
  if (!(rate >= 0) || !(fallSpeed > 0) || !(massPerArea > 0))
    throw new RangeError('snowVisibility needs a rate of 0 or more and a positive fall speed and mass per area');
  return rate === 0 ? Infinity : (3.912 * fallSpeed * massPerArea) / (2 * (rate / 3600));
}

/** Wind at 10 m at which dry snow starts to move at `temperature` C (Li and Pomeroy 1997); wet snow (above 0 C) 9.9. */
export function snowThreshold(temperature: number): number {
  const t = Math.min(0, temperature),
    dry = 9.43 + 0.18 * t + 0.0033 * t * t;
  return temperature <= 0 ? dry : dry + (9.9 - dry) * Math.min(1, temperature);
}

/** Density of new snow at `temperature` C, kg/m^3 (Hedstrom and Pomeroy 1998; at 0 C above it). */
export function newSnowDensity(temperature: number): number {
  return 67.92 + 51.25 * Math.exp(Math.min(0, temperature) / 2.59);
}

/** Share of precipitation that falls as snow at `temperature` C: all at 0 and below, half at 1 C, none from 2 C (Dai 2008). */
export function snowShare(temperature: number): number {
  return Math.min(1, Math.max(0, 1 - temperature / 2));
}

/**
 * Snow carried by the wind, kg per metre across the wind per second, for a 10 m wind `wind` m/s over snow whose
 * threshold is `threshold` m/s: the larger of Pomeroy and Gray's (1990) saltation and the developed total of Pomeroy,
 * Gray and Landine (1993) scaled by 1 - (Ut / U)^2, so it starts at 0 at the threshold. 0 below it.
 */
export function snowTransport(wind: number, threshold: number, temperature = -5, roughness = 0.0005): number {
  if (!(wind > threshold)) return 0;
  const log = Math.log(10 / roughness),
    u = (KARMAN * wind) / log,
    ut = (KARMAN * threshold) / log,
    rho = 101325 / (287.05 * (Math.min(20, temperature) + 273.15)),
    salt = (0.68 * rho * ut * (u * u - ut * ut)) / (u * G),
    total = (wind ** 4.04 / 714801) * (1 - (threshold / wind) ** 2);
  return Math.max(salt, total);
}

/** Stability class of an index (Foehn 1987 index; class bounds after Schweizer et al. 2003). */
export function snowStability(index: number): SnowStability {
  return index >= STABILITY_MAX ? 'none' : index < 1 ? 'release' : index < 1.5 ? 'poor' : index < 2.5 ? 'fair' : 'good';
}

const RANGES: Record<string, readonly [number, number]> = {
  initialDepth: [0, 100],
  initialDensity: [50, 600],
  step: [0.5, 600],
  wind: [0, 60],
  windDirection: [-100000, 100000],
  snowfall: [0, 50],
  temperature: [-60, 20],
  humidity: [0, 1],
  timeScale: [0, 100000],
  threshold: [2, 30],
  roughness: [0.00001, 0.01],
  transport: [0, 10],
  fetch: [1, 2000],
  settle: [0.1, 500],
  slopeWeight: [0, 2],
  curvatureWeight: [0, 2],
  curvatureLength: [1, 500],
  shelter: [0, 1],
  shelterAngle: [1, 60],
  shelterDistance: [0, 1000],
  windDensity: [100, 600],
  sublimation: [0, 1],
  repose: [20, 90],
  corniceAngle: [15, 89],
  corniceCapture: [0, 1],
  corniceDensity: [200, 600],
  corniceMax: [0.1, 20],
  weakLayer: [50, 10000],
  weakFriction: [0, 2],
  sintering: [0, 1000],
  burial: [60, 1000000],
  trigger: [0, 10000],
};

/** Throws for any invalid field of `o`. */
export function validateSnowDrift(o: SnowDriftOptions): void {
  if (typeof o !== 'object' || o === null) throw new TypeError('SnowDrift options must be an object with width and depth');
  for (const key of ['width', 'depth'] as const)
    if (!Number.isInteger(o[key]) || o[key] < 2 || o[key] > 2048)
      throw new RangeError(`SnowDrift ${key} must be a whole number of samples from 2 to 2048`);
  if (o.width * o.depth > 4194304) throw new RangeError('SnowDrift width * depth must be 4,194,304 or fewer');
  const cell = o.cellSize ?? 1;
  if (!(cell >= 0.05 && cell <= 100)) throw new RangeError('SnowDrift cellSize must be a number from 0.05 to 100');
  if (
    o.origin !== undefined &&
    (!Array.isArray(o.origin) || o.origin.length !== 2 || !o.origin.every((v) => Number.isFinite(v)))
  )
    throw new TypeError('SnowDrift origin must be [x, z] in metres');
  if (o.ground !== undefined) {
    if (typeof o.ground !== 'object' || o.ground === null || o.ground.length !== o.width * o.depth)
      throw new TypeError('SnowDrift ground needs width * depth heights, row by row along x');
    for (let k = 0; k < o.ground.length; k++)
      if (!Number.isFinite(o.ground[k])) throw new RangeError(`SnowDrift ground height ${k} is not finite; pass finite heights in metres`);
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = (o as unknown as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      throw new RangeError(`SnowDrift ${key} must be a number from ${min} to ${max}${key in NULLABLE ? ' or null' : ''}`);
  }
  if (o.inflow !== undefined && typeof o.inflow !== 'boolean') throw new TypeError('SnowDrift inflow must be true or false');
  if (o.weather !== undefined) {
    const s = (o.weather as { state?: Record<string, unknown> } | null)?.state;
    if (!s || !['snow', 'wind', 'windDirection', 'temperature', 'humidity'].every((k) => typeof s[k] === 'number'))
      throw new TypeError('SnowDrift weather needs a state with snow, wind, windDirection, temperature and humidity; pass a WeatherMachine');
  }
}
const NULLABLE = { wind: 1, windDirection: 1, snowfall: 1, temperature: 1, humidity: 1, threshold: 1 };

// Fixed options: a change to one of these starts the snow again from time 0.
const FIXED = ['width', 'depth', 'cellSize', 'initialDepth', 'initialDensity', 'step'] as const;

/**
 * Snow that drifts and slides on a height grid, deterministic over film time. `update(delta)` advances it by film
 * seconds (times `timeScale`, in whole fixed steps), `seek(time)` jumps to any time (replaying from 0 to go back).
 * Read the snow depth with {@link depthAt} or {@link snowDepth}, cornices with {@link cornices}, the slide state with
 * {@link slide}; pass the drift as `Snow`'s `field` to draw it on the ground.
 * @throws TypeError / RangeError on invalid options (at construction and every update).
 * @example
 * const drift = new SnowDrift({ width: 128, depth: 128, ground, weather: machine, timeScale: 600 });
 * engine.onFrame((_, delta) => drift.update(delta));
 */
export class SnowDrift implements SnowFieldSource {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly origin: readonly [number, number];
  /** Ground heights, m. */
  readonly ground: Float64Array;
  private readonly n: number;
  private fixed: string;
  private base!: Float64Array; // kg/m^2 of old snow under the weak layer
  private baseDepth!: Float64Array; // m
  private slab!: Float64Array; // kg/m^2 above the weak layer
  private slabDepth!: Float64Array; // m
  private weakAge!: Float64Array; // s since the weak layer formed
  private cornice!: Float64Array; // kg per metre of edge
  private weight!: Float64Array; // terrain wind weight
  private flux!: Float64Array;
  private moves!: Float64Array;
  private weightKey = '';
  private steps = 0;
  private dry = 0;
  private simTime = 0;
  private film = 0;
  private data?: Float32Array;
  private dataVersion = -1;
  private falls: SnowCorniceFall[] = [];
  /** Changes whenever the snow does. */
  version = 0;
  /** Snow fallen, blown in and out, sublimated and held in cornices since time 0, kg. */
  budget: SnowBudget = { fallen: 0, blownIn: 0, blownOut: 0, sublimated: 0, cornices: 0 };

  constructor(readonly options: SnowDriftOptions) {
    validateSnowDrift(options);
    this.width = options.width;
    this.depth = options.depth;
    this.cellSize = options.cellSize ?? 1;
    this.origin = [options.origin?.[0] ?? 0, options.origin?.[1] ?? 0];
    this.n = this.width * this.depth;
    this.ground = new Float64Array(this.n);
    if (options.ground) for (let k = 0; k < this.n; k++) this.ground[k] = options.ground[k]!;
    this.fixed = this.fixedKey();
    this.reset();
  }

  private fixedKey(): string {
    return FIXED.map((k) => this.options[k]).join();
  }

  /** Back to time 0: the initial snow only. */
  reset(): void {
    const n = this.n,
      o = this.options,
      d0 = o.initialDepth ?? 0,
      rho0 = o.initialDensity ?? 250;
    this.base = new Float64Array(n).fill(d0 * rho0);
    this.baseDepth = new Float64Array(n).fill(d0);
    this.slab = new Float64Array(n);
    this.slabDepth = new Float64Array(n);
    this.weakAge = new Float64Array(n);
    this.cornice = new Float64Array(n);
    this.weight = new Float64Array(n).fill(1);
    this.flux = new Float64Array(n);
    this.moves = new Float64Array(n);
    this.weightKey = '';
    this.steps = 0;
    this.dry = 0;
    this.simTime = 0;
    this.film = 0;
    this.falls = [];
    this.budget = { fallen: 0, blownIn: 0, blownOut: 0, sublimated: 0, cornices: 0 };
    this.version++;
  }

  /** Film seconds the snow has reached. */
  get time(): number {
    return this.film;
  }
  /** Simulated seconds done (whole steps). */
  get simulated(): number {
    return this.simTime;
  }

  /**
   * Moves film time on by `delta` seconds, as {@link update}: the clock a seek from `@margoengine/cutscene/seek` replays
   * (pass this snow in its `extra`), so a scene started at film time T shows what a continuous run shows at T, bit for
   * bit (GAP-FILM-TIME).
   */
  advanceTime(delta: number): void {
    this.update(delta);
  }
  /** Advances by `delta` film seconds. */
  update(delta: number): void {
    if (!(delta >= 0) || !Number.isFinite(delta)) throw new RangeError('SnowDrift delta must be a finite number of 0 or more seconds');
    this.seek(this.film + delta);
  }

  /**
   * Shows the snow at film time `time`: steps forward to it, or replays from 0 to go back. The snow at a time depends
   * only on the options and the weather along the way, never on how it was reached (while those stay the same).
   */
  seek(time: number): void {
    if (!(time >= 0) || !Number.isFinite(time)) throw new RangeError('SnowDrift time must be a finite number of 0 or more seconds');
    validateSnowDrift(this.options);
    if (this.fixedKey() !== this.fixed) {
      this.fixed = this.fixedKey();
      this.reset();
    }
    if (time < this.film) this.reset();
    const o = this.options,
      step = o.step ?? 10,
      target = time * (o.timeScale ?? 1);
    this.film = time;
    let stepped = false;
    while (this.simTime + step <= target + 1e-9) {
      this.advance(step);
      this.simTime = ++this.steps * step;
      stepped = true;
    }
    if (stepped) this.version++;
  }

  /** The drivers this step: the option, else the weather, else the default. */
  private drivers() {
    const o = this.options,
      s = o.weather?.state;
    const temperature = o.temperature ?? s?.temperature ?? -5;
    return {
      wind: o.wind ?? s?.wind ?? 0,
      // Weather: radians, 0 toward +Z and pi/2 toward +X; the option: degrees on the same compass.
      direction: o.windDirection != null ? (o.windDirection * Math.PI) / 180 : (s?.windDirection ?? 0),
      snowfall: o.snowfall ?? (s ? snowfallRate(Math.min(1, Math.max(0, s.snow))) : 0),
      temperature,
      humidity: o.humidity ?? s?.humidity ?? 0.8,
    };
  }

  private at(field: Float64Array, i: number, j: number): number {
    const w = this.width;
    return field[Math.min(this.depth - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))]!;
  }
  private surface(k: number): number {
    return this.ground[k]! + this.baseDepth[k]! + this.slabDepth[k]!;
  }

  // The terrain's weight on the wind (MicroMet slope and curvature, Winstral shelter), from the snow surface. It moves
  // slowly, so it is worked out again every 6 steps or when the wind turns by a degree.
  private windWeights(dx: number, dz: number): void {
    const o = this.options,
      key = `${Math.round(Math.atan2(dx, dz) * 57.29578)}|${Math.floor(this.steps / 6)}|${o.slopeWeight}|${o.curvatureWeight}|${o.curvatureLength}|${o.shelter}|${o.shelterAngle}|${o.shelterDistance}`;
    if (key === this.weightKey) return;
    this.weightKey = key;
    const W = this.width,
      D = this.depth,
      h = this.cellSize,
      s = new Float64Array(this.n);
    for (let k = 0; k < this.n; k++) s[k] = this.surface(k);
    const slope = new Float64Array(this.n),
      curve = new Float64Array(this.n),
      eta = Math.max(1, Math.round((o.curvatureLength ?? 20) / h)),
      r2 = Math.SQRT2 * eta * h;
    let maxS = 0,
      maxC = 0;
    for (let j = 0; j < D; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i,
          gx = (this.at(s, i + 1, j) - this.at(s, i - 1, j)) / (2 * h),
          gz = (this.at(s, i, j + 1) - this.at(s, i, j - 1)) / (2 * h);
        // Slope along the wind: rising toward the wind's travel is a windward face (speed up).
        const os = gx * dx + gz * dz;
        // Curvature: Liston and Elder's mean of the four directions, length eta.
        const z = s[k]!,
          oc =
            ((z - (this.at(s, i - eta, j) + this.at(s, i + eta, j)) / 2) / (2 * eta * h) +
              (z - (this.at(s, i, j - eta) + this.at(s, i, j + eta)) / 2) / (2 * eta * h) +
              (z - (this.at(s, i - eta, j - eta) + this.at(s, i + eta, j + eta)) / 2) / (2 * r2) +
              (z - (this.at(s, i - eta, j + eta) + this.at(s, i + eta, j - eta)) / 2) / (2 * r2)) /
            4;
        slope[k] = os;
        curve[k] = oc;
        maxS = Math.max(maxS, Math.abs(os));
        maxC = Math.max(maxC, Math.abs(oc));
      }
    const gs = o.slopeWeight ?? 0.5,
      gc = o.curvatureWeight ?? 0.5,
      shelter = o.shelter ?? 0.8,
      tanFull = Math.tan(((o.shelterAngle ?? 15) * Math.PI) / 180),
      reach = Math.floor((o.shelterDistance ?? 60) / h);
    for (let j = 0; j < D; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        let w = 1 + (maxS > 0 ? (gs * slope[k]!) / (2 * maxS) : 0) + (maxC > 0 ? (gc * curve[k]!) / (2 * maxC) : 0);
        // Sx: the steepest rise of the upwind surface seen from here (Winstral et al. 2002), sampled a cell apart.
        let sx = 0;
        for (let m = 1; m <= reach; m++) {
          const x = i - dx * m,
            z = j - dz * m;
          if (x < 0 || z < 0 || x > W - 1 || z > D - 1) break;
          const x0 = Math.min(W - 2, Math.floor(x)),
            z0 = Math.min(D - 2, Math.floor(z)),
            fx = x - x0,
            fz = z - z0,
            a = s[z0 * W + x0]!,
            b = s[z0 * W + x0 + 1]!,
            c = s[(z0 + 1) * W + x0]!,
            e = s[(z0 + 1) * W + x0 + 1]!,
            up = a + (b - a) * fx + (c - a) * fz + (a - b - c + e) * fx * fz;
          sx = Math.max(sx, (up - s[k]!) / (m * h * Math.hypot(dx, dz)));
        }
        const t = Math.min(1, Math.max(0, sx / tanFull));
        w *= 1 - shelter * t * t * (3 - 2 * t);
        this.weight[k] = Math.max(0, w);
      }
  }

  private advance(dt: number): void {
    const o = this.options,
      d = this.drivers(),
      W = this.width,
      D = this.depth,
      n = this.n,
      h = this.cellSize,
      area = h * h,
      base = this.base,
      slab = this.slab,
      baseDepth = this.baseDepth,
      slabDepth = this.slabDepth;
    // Snowfall onto the slab, at the new-snow density.
    const fall = ((d.snowfall * snowShare(d.temperature)) / 3600) * dt,
      rhoNew = newSnowDensity(d.temperature);
    if (fall > 0) {
      for (let k = 0; k < n; k++) {
        slab[k] = slab[k]! + fall;
        slabDepth[k] = slabDepth[k]! + fall / rhoNew;
      }
      this.budget.fallen += fall * n * area;
      this.dry = 0;
    } else this.dry += dt;
    // A fair spell long enough turns the surface into the next weak layer: the slab joins the old snow.
    const burial = o.burial ?? 21600;
    if (this.dry >= burial && this.dry - dt < burial)
      for (let k = 0; k < n; k++) {
        base[k] = base[k]! + slab[k]!;
        baseDepth[k] = baseDepth[k]! + slabDepth[k]!;
        slab[k] = 0;
        slabDepth[k] = 0;
        this.weakAge[k] = 0;
      }
    for (let k = 0; k < n; k++) this.weakAge[k] = this.weakAge[k]! + dt;

    // Wind transport (SnowTran-3D's divergence, MicroMet's terrain weight, a fetch relaxation, donor cells upwind).
    const sx = Math.sin(d.direction),
      sz = Math.cos(d.direction),
      ax = Math.abs(sx),
      az = Math.abs(sz),
      sum = ax + az,
      threshold = o.threshold ?? snowThreshold(d.temperature),
      scale = o.transport ?? 1,
      rough = o.roughness ?? 0.0005,
      rhoWind = o.windDensity ?? 300;
    if (d.wind > threshold * 0.5 && scale > 0) {
      const dx = sx / Math.max(ax, az),
        dz = sz / Math.max(ax, az);
      this.windWeights(dx, dz);
      const flux = this.flux,
        grow = 1 - Math.exp(-h / sum / (o.fetch ?? 100)),
        drop = 1 - Math.exp(-h / sum / (o.settle ?? 5)),
        travel = h / sum,
        lose = 1 - Math.pow(1 - (o.sublimation ?? 0.02) * (1 - d.humidity), travel / 100),
        stepI = sx >= 0 ? 1 : -1,
        stepJ = sz >= 0 ? 1 : -1,
        i0 = stepI > 0 ? 0 : W - 1,
        j0 = stepJ > 0 ? 0 : D - 1,
        tanCornice = Math.tan(((o.corniceAngle ?? 35) * Math.PI) / 180),
        capture = o.corniceCapture ?? 0.25,
        inflow = o.inflow ?? true,
        cap = (k: number) => scale * snowTransport(d.wind * this.weight[k]!, threshold, d.temperature, rough);
      // Mass moves across a cell's two upwind faces: q |sx| across the x face and q |sz| across the z face, per metre.
      for (let jj = 0, j = j0; jj < D; jj++, j += stepJ)
        for (let ii = 0, i = i0; ii < W; ii++, i += stepI) {
          const k = j * W + i,
            iu = i - stepI,
            ju = j - stepJ,
            inX = iu < 0 || iu >= W ? (inflow ? cap(k) : 0) : flux[j * W + iu]!,
            inZ = ju < 0 || ju >= D ? (inflow ? cap(k) : 0) : flux[ju * W + i]!;
          if (iu < 0 || iu >= W) this.budget.blownIn += inX * ax * h * dt;
          if (ju < 0 || ju >= D) this.budget.blownIn += inZ * az * h * dt;
          // Incoming per metre across the wind, less what sublimates crossing this cell.
          let q = ((inX * ax + inZ * az) / sum) * (1 - lose);
          this.budget.sublimated += ((inX * ax + inZ * az) / sum) * lose * sum * h * dt;
          const c = cap(k),
            want = q + (c - q) * (c > q ? grow : drop);
          // Erosion is limited by the snow there is to lift; deposition by nothing.
          let change = ((want - q) * sum * dt) / h; // kg/m^2 taken up (+) or laid down (-)
          const avail = slab[k]! + base[k]!;
          if (change > avail) change = avail;
          q += (change * h) / (sum * dt);
          if (change > 0) this.take(k, change);
          else if (change < 0) this.lay(k, -change, rhoWind);
          // A cornice: the ground drops steeply just downwind of a cell no lower than the one upwind.
          if (capture > 0 && q > 0) {
            const id = i + stepI * (ax >= az ? 1 : 0),
              jd = j + stepJ * (ax >= az ? 0 : 1),
              iU = i - stepI * (ax >= az ? 1 : 0),
              jU = j - stepJ * (ax >= az ? 0 : 1);
            if (id >= 0 && id < W && jd >= 0 && jd < D && iU >= 0 && iU < W && jU >= 0 && jU < D) {
              // On the ground's edge: the lee fills with drift, but the edge the cornice grows from stays.
              const here = this.ground[k]!;
              if (here - this.ground[jd * W + id]! > tanCornice * h && here >= this.ground[jU * W + iU]!) {
                const caught = q * capture;
                q -= caught;
                this.cornice[k] = this.cornice[k]! + caught * sum * dt;
                this.budget.cornices += caught * sum * h * dt;
                this.corniceBreak(k, id, jd);
              }
            }
          }
          flux[k] = q;
          const iD = i + stepI,
            jD = j + stepJ;
          if (iD < 0 || iD >= W) this.budget.blownOut += q * ax * h * dt;
          if (jD < 0 || jD >= D) this.budget.blownOut += q * az * h * dt;
        }
    }
    this.slough();
  }

  /** Lifts `mass` kg/m^2 from cell k: the slab first, then the old snow. */
  private take(k: number, mass: number): void {
    const s = this.slab[k]!;
    if (mass <= s) {
      const left = s - mass;
      this.slabDepth[k] = s > 0 ? (this.slabDepth[k]! * left) / s : 0;
      this.slab[k] = left;
      return;
    }
    this.slab[k] = 0;
    this.slabDepth[k] = 0;
    const b = this.base[k]!,
      left = Math.max(0, b - (mass - s));
    this.baseDepth[k] = b > 0 ? (this.baseDepth[k]! * left) / b : 0;
    this.base[k] = left;
  }
  /** Lays `mass` kg/m^2 on cell k's slab at density `rho`. */
  private lay(k: number, mass: number, rho: number): void {
    this.slab[k] = this.slab[k]! + mass;
    this.slabDepth[k] = this.slabDepth[k]! + mass / rho;
  }

  private overhang(mass: number): number {
    // Cross-section about a quarter ellipse of reach L and height 0.6 L: area = 0.15 pi L^2.
    return Math.sqrt(mass / (this.options.corniceDensity ?? 400) / (0.15 * Math.PI));
  }

  private corniceBreak(k: number, id: number, jd: number): void {
    const mass = this.cornice[k]!;
    if (this.overhang(mass) < (this.options.corniceMax ?? 3)) return;
    // It breaks off: its snow lands on the lee cell below as dense debris (per m^2 over one cell's width).
    const below = jd * this.width + id;
    this.lay(below, mass / this.cellSize, this.options.corniceDensity ?? 400);
    this.cornice[k] = 0;
    this.budget.cornices -= mass * this.cellSize;
    const i = k % this.width,
      j = (k - i) / this.width;
    this.falls.push({ time: this.film, cell: k, x: this.origin[0] + i * this.cellSize, z: this.origin[1] + j * this.cellSize, mass });
  }

  // Snow on a surface steeper than the angle of repose slides to its lower neighbours in proportion to the drop past
  // repose (Fearing 2000; Musgrave et al. 1989), two passes a step, each from a snapshot so the order does not matter.
  private slough(): void {
    const repose = this.options.repose ?? 45;
    if (repose >= 90) return;
    const W = this.width,
      D = this.depth,
      h = this.cellSize,
      talus = Math.tan((repose * Math.PI) / 180) * h,
      s = new Float64Array(this.n),
      moves = this.moves;
    const nb = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < this.n; k++) s[k] = this.surface(k);
      moves.fill(0);
      const out = new Float64Array(this.n * 4);
      for (let j = 0; j < D; j++)
        for (let i = 0; i < W; i++) {
          const k = j * W + i,
            snow = this.slab[k]! + this.base[k]!;
          if (snow <= 0) continue;
          let total = 0,
            most = 0;
          for (let m = 0; m < 4; m++) {
            const a = i + nb[m]![0],
              b = j + nb[m]![1];
            if (a < 0 || b < 0 || a >= W || b >= D) continue;
            const drop = s[k]! - s[b * W + a]! - talus;
            if (drop > 0) {
              out[k * 4 + m] = drop;
              total += drop;
              most = Math.max(most, drop);
            }
          }
          if (total <= 0) continue;
          // Move half the steepest excess (as depth at this cell's density), never more than the snow there.
          const depth = this.slabDepth[k]! + this.baseDepth[k]!,
            rho = depth > 0 ? snow / depth : 300,
            mass = Math.min(snow, (most / 2) * rho);
          moves[k] = mass;
          for (let m = 0; m < 4; m++) out[k * 4 + m] = (out[k * 4 + m]! / total) * mass;
        }
      for (let k = 0; k < this.n; k++) {
        const mass = moves[k]!;
        if (mass <= 0) continue;
        const depth = this.slabDepth[k]! + this.baseDepth[k]!,
          rho = depth > 0 ? (this.slab[k]! + this.base[k]!) / depth : 300;
        this.take(k, mass);
        const i = k % W,
          j = (k - i) / W;
        for (let m = 0; m < 4; m++) {
          const part = out[k * 4 + m]!;
          if (part > 0) this.lay((j + nb[m]![1]) * W + i + nb[m]![0], part, rho);
        }
      }
    }
  }

  /** Snow depth per sample, m (a new array). */
  snowDepth(): Float32Array {
    const out = new Float32Array(this.n);
    for (let k = 0; k < this.n; k++) out[k] = this.baseDepth[k]! + this.slabDepth[k]!;
    return out;
  }
  /** Snow mass per sample, kg/m^2 (a new array). */
  snowMass(): Float32Array {
    const out = new Float32Array(this.n);
    for (let k = 0; k < this.n; k++) out[k] = this.base[k]! + this.slab[k]!;
    return out;
  }
  /** Total snow on the grid, kg (cornices not counted; they are `budget.cornices`). */
  get mass(): number {
    let m = 0;
    for (let k = 0; k < this.n; k++) m += this.base[k]! + this.slab[k]!;
    return m * this.cellSize * this.cellSize;
  }

  /** Ground and snow depth per sample, interleaved, for `Snow`'s `field` (the array is reused). */
  fieldData(): Float32Array {
    if (!this.data) this.data = new Float32Array(this.n * 2);
    if (this.dataVersion !== this.version) {
      for (let k = 0; k < this.n; k++) {
        this.data[k * 2] = this.ground[k]!;
        this.data[k * 2 + 1] = this.baseDepth[k]! + this.slabDepth[k]!;
      }
      this.dataVersion = this.version;
    }
    return this.data;
  }

  private bilinear(x: number, z: number, value: (k: number) => number): number | undefined {
    const gx = (x - this.origin[0]) / this.cellSize,
      gz = (z - this.origin[1]) / this.cellSize;
    if (!(gx >= 0 && gz >= 0 && gx <= this.width - 1 && gz <= this.depth - 1)) return undefined;
    const i = Math.min(this.width - 2, Math.floor(gx)),
      j = Math.min(this.depth - 2, Math.floor(gz)),
      fx = gx - i,
      fz = gz - j,
      k = j * this.width + i,
      a = value(k),
      b = value(k + 1),
      c = value(k + this.width),
      e = value(k + this.width + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + e) * fx * fz;
  }
  /** Snow depth at world (x, z), m, between samples bilinearly; 0 outside the grid. */
  depthAt(x: number, z: number): number {
    return this.bilinear(x, z, (k) => this.baseDepth[k]! + this.slabDepth[k]!) ?? 0;
  }
  /** Height of the snow surface at world (x, z), m; undefined outside the grid. */
  surfaceAt(x: number, z: number): number | undefined {
    return this.bilinear(x, z, (k) => this.surface(k));
  }

  /** The cornices standing now, from the upwind side of the grid. */
  cornices(): SnowCornice[] {
    const out: SnowCornice[] = [],
      d = this.drivers(),
      dir = [Math.sin(d.direction), Math.cos(d.direction)] as const;
    for (let k = 0; k < this.n; k++) {
      const mass = this.cornice[k]!;
      if (mass <= 0) continue;
      const i = k % this.width,
        j = (k - i) / this.width,
        overhang = this.overhang(mass);
      out.push({
        cell: k,
        x: this.origin[0] + i * this.cellSize,
        y: this.surface(k),
        z: this.origin[1] + j * this.cellSize,
        direction: dir,
        mass,
        overhang,
        height: 0.6 * overhang,
      });
    }
    return out;
  }
  /** Cornices that broke off since time 0, in order. */
  corniceFalls(): readonly SnowCorniceFall[] {
    return this.falls;
  }

  /**
   * A mesh of the standing cornices (positions, normals and triangle indices, flat shaded): each a curled lip that
   * leans downwind past its edge, one cell wide across the wind, closed at its ends. Pass it to core's `Geometry`.
   */
  corniceGeometry(): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
    const shape = [
      [-0.6, 0],
      [-0.2, 0.85],
      [0.3, 1],
      [0.85, 0.85],
      [1, 0.55],
      [0.8, 0.35],
      [0.3, 0.15],
      [0, 0],
    ] as const;
    const pos: number[] = [],
      nor: number[] = [],
      idx: number[] = [];
    const tri = (a: number[], b: number[], c: number[]) => {
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!],
        v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!],
        nx = u[1]! * v[2]! - u[2]! * v[1]!,
        ny = u[2]! * v[0]! - u[0]! * v[2]!,
        nz = u[0]! * v[1]! - u[1]! * v[0]!,
        l = Math.hypot(nx, ny, nz) || 1,
        base = pos.length / 3;
      for (const p of [a, b, c]) {
        pos.push(p[0]!, p[1]!, p[2]!);
        nor.push(nx / l, ny / l, nz / l);
      }
      idx.push(base, base + 1, base + 2);
    };
    for (const c of this.cornices()) {
      const [fx, fz] = c.direction,
        half = this.cellSize * 0.51,
        side = [-fz, fx];
      const point = (p: readonly [number, number], s: number) => [
        c.x + fx * p[0] * c.overhang + side[0]! * s,
        c.y + p[1] * c.height,
        c.z + fz * p[0] * c.overhang + side[1]! * s,
      ];
      // The outline runs over the top and back under the lip, so the outward side is on the left looking along it
      // from the left end: the quads wind so their normals face out.
      for (let m = 0; m < shape.length; m++) {
        const p = shape[m]!,
          q = shape[(m + 1) % shape.length]!,
          a = point(p, -half),
          b = point(q, -half),
          e = point(q, half),
          f = point(p, half);
        tri(a, e, b);
        tri(a, f, e);
      }
      // End caps: a fan from the first outline point.
      for (let m = 1; m < shape.length - 1; m++) {
        tri(point(shape[0]!, -half), point(shape[m]!, -half), point(shape[m + 1]!, -half));
        tri(point(shape[0]!, half), point(shape[m + 1]!, half), point(shape[m]!, half));
      }
    }
    return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx) };
  }

  // One cell's weak layer: Foehn's index from the slab's weight on the bed's slope.
  private cell(k: number): [strength: number, stress: number, slope: number, index: number] {
    const o = this.options,
      W = this.width,
      h = this.cellSize,
      i = k % W,
      j = (k - i) / W,
      bed = (a: number, b: number) => {
        const q = Math.min(this.depth - 1, Math.max(0, b)) * W + Math.min(W - 1, Math.max(0, a));
        return this.ground[q]! + this.baseDepth[q]!;
      },
      gx = (bed(i + 1, j) - bed(i - 1, j)) / (2 * h),
      gz = (bed(i, j + 1) - bed(i, j - 1)) / (2 * h),
      psi = Math.atan(Math.hypot(gx, gz)),
      m = this.slab[k]!,
      load = m * G, // Pa: the slab's weight per square metre of plan
      // On a square metre of slope that weight is load cos psi: load sin psi cos psi along it, load cos^2 psi across it.
      tau = load * Math.sin(psi) * Math.cos(psi) + (m > 0 ? (o.trigger ?? 0) : 0),
      sigma = load * Math.cos(psi) * Math.cos(psi),
      strength = (o.weakLayer ?? 500) + (o.weakFriction ?? 0.2) * sigma + ((o.sintering ?? 15) * this.weakAge[k]!) / 3600;
    return [strength, tau, (psi * 180) / Math.PI, m > 0 && tau > 0 ? Math.min(STABILITY_MAX, strength / tau) : STABILITY_MAX];
  }

  /** The slide state of every cell now (Foehn's stability index on the top weak layer). */
  slide(): SnowSlideState {
    const n = this.n,
      slabDepth = new Float32Array(n),
      slabMass = new Float32Array(n),
      baseDepth = new Float32Array(n),
      strength = new Float32Array(n),
      stress = new Float32Array(n),
      slope = new Float32Array(n),
      index = new Float32Array(n);
    let release = 0;
    for (let k = 0; k < n; k++) {
      const c = this.cell(k);
      slabDepth[k] = this.slabDepth[k]!;
      slabMass[k] = this.slab[k]!;
      baseDepth[k] = this.baseDepth[k]!;
      strength[k] = c[0];
      stress[k] = c[1];
      slope[k] = c[2];
      index[k] = c[3];
      if (c[3] < 1) release++;
    }
    return { slabDepth, slabMass, baseDepth, strength, stress, slope, index, release };
  }

  /** Stability index at world (x, z) (nearest sample), {@link STABILITY_MAX} outside the grid. */
  stabilityAt(x: number, z: number): number {
    const i = Math.round((x - this.origin[0]) / this.cellSize),
      j = Math.round((z - this.origin[1]) / this.cellSize);
    if (i < 0 || j < 0 || i >= this.width || j >= this.depth) return STABILITY_MAX;
    return this.cell(j * this.width + i)[3];
  }
}
