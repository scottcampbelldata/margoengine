/// <reference lib="esnext.disposable" preserve="true" />
// An avalanche with a powder cloud, deterministic over film time (fixed steps, fixed cell order, no randomness, no
// physics engine; a seek back replays from the release). Sources (papers, read as text; no code; docs/clean-room.md
// "Avalanche"):
// - S. B. Savage and K. Hutter, "The motion of a finite mass of granular material down a rough incline", J. Fluid
//   Mech. 199, 177-215, 1989, https://doi.org/10.1017/S0022112089000340: the depth-averaged (shallow) mass and momentum
//   balance of a granular layer on a slope, with the bed-normal pressure g cos(theta) h^2 / 2 times an earth pressure
//   coefficient k along the slope and a Coulomb basal friction.
// - A. Voellmy, "Ueber die Zerstoerungskraft von Lawinen", Schweizerische Bauzeitung 73, 159-165, 212-217, 246-249,
//   280-285, 1955: the basal resistance mu g cos(theta) + g U^2 / (xi h), a dry friction and a turbulent friction, whose
//   steady speed on a uniform slope is U = sqrt(xi h (sin(theta) - mu cos(theta))).
// - B. Salm, A. Burkard and H. Gubler, "Berechnung von Fliesslawinen", Mitteilung 47, EISLF Davos, 1990: the Voellmy-Salm
//   run-out on the flat, s = (xi h / 2 g) ln(1 + U0^2 / (mu xi h)), for a flow arriving at U0.
// - M. Christen, J. Kowalski and P. Bartelt, "RAMMS: Numerical simulation of dense snow avalanches in three-dimensional
//   terrain", Cold Regions Science and Technology 63(1-2), 1-14, 2010, https://doi.org/10.1016/j.coldregions.2010.04.005:
//   the Voellmy-fluid depth-averaged model on a terrain grid with k = 1, a finite-volume solve, entrainment of the snow
//   cover proportional to the flow speed (the entrained mass arriving at rest) and the release from a slab of given depth.
// - P. Bartelt, B. Salm and U. Gruber, "Calculating dense-snow avalanche runout using a Voellmy-fluid model with
//   active/passive longitudinal straining", J. Glaciology 45(150), 242-254, 1999,
//   https://doi.org/10.3189/S002214300000174X: mu 0.155 to 0.3 and xi 1000 to 3000 m/s^2 for large dry avalanches.
// - B. Sovilla, P. Burlando and P. Bartelt, "Field experiments and numerical modeling of mass entrainment in snow
//   avalanches", J. Geophys. Res. 111, F03007, 2006, https://doi.org/10.1029/2005JF000391: most of the snow cover is
//   taken at the front, and the avalanche grows several times its release mass.
// - P. Beghin, E. J. Hopfinger and R. E. Britter, "Gravitational convection from instantaneous sources on inclined
//   boundaries", J. Fluid Mech. 107, 407-422, 1981, https://doi.org/10.1017/S0022112081001821: a heavy cloud on a slope
//   is a semi-elliptic thermal whose height grows linearly with the distance it travels, entraining air at rest, driven
//   by its excess weight along the slope, with an added mass of the air it pushes.
// - M. Rastello and E. J. Hopfinger, "Sediment-entraining suspension clouds: a model of powder-snow avalanches", J. Fluid
//   Mech. 509, 181-206, 2004, https://doi.org/10.1017/S0022112004009279: that thermal entrains the snow it passes over
//   above a threshold speed, which keeps it fast and growing (a turbidity current), and loses snow by settling below it.
// - D. M. McClung and P. A. Schaerer, "The Avalanche Handbook", 3rd ed., The Mountaineers, 2006: impact pressures of the
//   Canadian size classes, 100 kPa breaking trees (size 3) and 500 kPa a forest (size 4).
// - H. C. van de Hulst, "Light Scattering by Small Particles", Wiley, 1957: the extinction efficiency of a large
//   particle is 2, so a cloud of grains of radius r and mass concentration C has extinction 3 C / (2 rho_ice r).
//
// The dense core is solved on the terrain grid in horizontal coordinates: `flow` is the vertical thickness, the momentum
// is the thickness times the horizontal velocity. With gamma = sqrt(1 + |grad b|^2) (cos(theta) = 1 / gamma), the
// gravity along the slope has the horizontal part g cos^2(theta) grad b, the pressure is k g cos^2(theta) flow^2 / 2, and
// the Voellmy resistance acts on the speed along the slope U = gamma |u| with the bed-normal depth flow / gamma, so a
// uniform layer on a uniform slope reaches exactly Voellmy's steady speed. Fluxes are Rusanov's (local Lax-Friedrichs)
// with substeps under a CFL of 0.4; the friction is applied implicitly so it never reverses the flow; snow that stops is
// deposit (it raises the bed); snow on cells the flow covers is taken at kappa U per second.
import { MargoError } from '@margoengine/math/errors';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { SnowFieldSource } from './snow-drift.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

const G = 9.81;
const AIR = 1.2;
const ICE = 917;
const THIN = 1e-4;

/** A snow cover to slide from: a `SnowDrift` of `margoengine/weather/snow-drift`, read once at the release. */
export interface AvalancheSnow {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly origin: readonly [number, number];
  /** Ground and snow depth per sample, interleaved. */
  fieldData(): Float32Array;
  /** The slab and its stability index per sample. */
  slide(): { readonly slabDepth: Float32Array; readonly slabMass: Float32Array; readonly index: Float32Array };
}

/** What the avalanche follows: a `WeatherMachine` (its wind drifts the powder cloud). */
export interface AvalancheWeather {
  readonly state: { readonly wind: number; readonly windDirection: number };
}

/** Where the slab breaks away. */
export interface AvalancheRelease {
  /** World x and z of the centre of the slab. */
  readonly at: readonly [number, number];
  /** Half width across the slope and half length along it, metres above 0. Default [30, 15]. */
  readonly size?: readonly [number, number];
}

/** Options of an {@link Avalanche}. Lengths in metres. Out of range throws RangeError. */
export interface AvalancheOptions {
  /** Samples along x and z, 3 to 2048 each, at most 4,194,304. Default the `snow`'s. Fixed. */
  readonly width?: number;
  readonly depth?: number;
  /** Metres between samples, 0.1 to 100. Default 1 (the `snow`'s). Fixed. */
  readonly cellSize?: number;
  /** World x and z of the first sample. Default [0, 0] (the `snow`'s). Fixed. */
  readonly origin?: readonly [number, number];
  /** Ground heights (`width * depth`, row by row along x). Default the `snow`'s ground, else flat 0. Fixed. */
  readonly ground?: ArrayLike<number>;
  /** A `SnowDrift`: the cover, its ground and, with `release` 'unstable', the slab come from it at time 0. */
  readonly snow?: AvalancheSnow;
  /** Snow cover depth on the ground without `snow`, metres, 0 to 50 (a number, or one per sample). Default 1. */
  readonly cover?: number | ArrayLike<number>;
  /** The slab: a rectangle on the slope, or 'unstable' (every sample of `snow` with a stability index under 1). Default 'unstable' with `snow`. */
  readonly release?: AvalancheRelease | 'unstable';
  /** Slab depth of a rectangle release, metres above 0 (at most the cover). Default 1. */
  readonly releaseDepth?: number;
  /** Film seconds the slab breaks at, 0 or more. Default 0. */
  readonly releaseTime?: number;
  /** Density of the flowing snow, kg/m^3, 50 to 600. Default 300. */
  readonly density?: number;
  /** Density of the snow cover, kg/m^3, 50 to 600. Default 200 (the `snow`'s slab density for its slab). */
  readonly coverDensity?: number;
  /** Voellmy dry friction mu, 0.05 to 1. Default 0.2 (Bartelt et al. 1999: 0.155 to 0.3). */
  readonly friction?: number;
  /** Voellmy turbulent friction xi, m/s^2, 100 to 10000. Default 2000. */
  readonly turbulence?: number;
  /** Earth pressure coefficient k, 0 to 3. Default 1 (RAMMS). */
  readonly pressure?: number;
  /** Snow cover taken, metres of depth a second per m/s of speed, 0 to 0.1. Default 0.005. */
  readonly entrainment?: number;
  /** Share of the entrained snow thrown up into the powder cloud, 0 to 1. Default 0.25. */
  readonly suspension?: number;
  /** No powder cloud when false. Default true. */
  readonly cloud?: boolean;
  /** Growth of the cloud's height per metre it travels (Beghin et al. 1981), 0 to 0.5. Default 0.06. */
  readonly cloudGrowth?: number;
  /** Cloud length and width over its height, 0.5 to 6. Default 1.6. */
  readonly cloudAspect?: number;
  /** Speed above which the cloud picks up snow and below which it settles, m/s, 1 to 60. Default 12. */
  readonly cloudThreshold?: number;
  /** Cloud pick-up, metres of cover a second per m/s above the threshold, over its footprint, 0 to 0.01. Default 0.001. */
  readonly cloudPickup?: number;
  /** Fall speed of the cloud's grains, m/s, 0 to 5. Default 0.5. */
  readonly settling?: number;
  /** Radius of the cloud's grains, metres, 1e-5 to 1e-2 (the extinction). Default 1e-4. */
  readonly grain?: number;
  /**
   * The flow stops (all of it deposit) once its momentum falls under this share of its highest, 0 to 0.5. Default
   * 0.05 (RAMMS's stopping criterion, Christen et al. 2010): a thin Voellmy tail on a slope steeper than atan(mu)
   * would otherwise creep on for ever.
   */
  readonly stopMomentum?: number;
  /** Pressure that breaks a tree, Pa, 1000 to 2,000,000. Default 100,000 (McClung and Schaerer 2006, size 3). */
  readonly breakPressure?: number;
  /**
   * Pressure that starts to bend plants along the flow, Pa, 100 to 1,000,000. Default 1,000 (McClung and Schaerer 2006:
   * size 1, harmless to people); they lie fully bent at half the `breakPressure`, where they start to break.
   */
  readonly bendPressure?: number;
  /** Deposit that buries plants, metres above 0. Default 2. */
  readonly buryDepth?: number;
  /** Wind at 10 m drifting the cloud, m/s, 0 to 60; unset follows `weather`. */
  wind?: number;
  /** Direction the wind blows toward, degrees, 0 is +Z, 90 is +X; unset follows `weather`. */
  windDirection?: number;
  /** The weather the wind follows. */
  weather?: AvalancheWeather;
  /** Simulated seconds per film second, 0 to 100. Default 1. */
  timeScale?: number;
  /** Simulated seconds per step, 0.005 to 0.5; changing it replays. Default 0.05. */
  step?: number;
}

/** One parcel of the powder cloud. */
export interface PowderParcel {
  /** Stays the same for the parcel's life. */
  readonly id: number;
  /** Centre of its base on the ground, world. */
  readonly position: readonly [number, number, number];
  /** Horizontal velocity, m/s (with the wind's drift). */
  readonly velocity: readonly [number, number];
  /** Speed along the slope, m/s. */
  readonly speed: number;
  /** Height, metres; length and width are `cloudAspect` times it. */
  readonly height: number;
  /** Snow it carries, kg. */
  readonly snow: number;
  /** Snow per cubic metre, kg/m^3. */
  readonly concentration: number;
  /** 1 - exp(-extinction x height): how much it hides behind it. */
  readonly opacity: number;
}

/** The mass budget since time 0, kg (the whole grid). */
export interface AvalancheBudget {
  /** The slab that broke away. */
  readonly released: number;
  /** Cover taken by the dense flow and by the cloud. */
  readonly entrained: number;
  /** Still flowing. */
  readonly flowing: number;
  /** Stopped as deposit (the dense flow and the cloud's settled snow). */
  readonly deposited: number;
  /** In the powder cloud. */
  readonly suspended: number;
}

/** The options {@link Avalanche.drawCloud} gives each cloud it adds (a subset of vfx `CloudOptions`). */
export interface PowderCloudOptions {
  seed?: number;
  segments?: number;
  bounds?: [number, number, number];
  volume?: number;
  color?: [number, number, number];
  concentrate?: 'inside' | 'outside' | 'random';
  opacity?: number;
}

/** What {@link Avalanche.drawCloud} draws into: a `Clouds` of `margoengine/vfx/clouds` fits it. */
export interface PowderCloudTarget {
  add(options: PowderCloudOptions): { readonly options: { opacity?: number }; readonly matrix: Float32Array };
  remove(cloud: object): boolean;
}

interface Parcel {
  id: number;
  x: number;
  z: number;
  ux: number;
  uz: number;
  h: number;
  m: number;
}

const FIXED = ['width', 'depth', 'cellSize', 'origin', 'ground', 'snow', 'cover', 'release', 'releaseDepth', 'step', 'coverDensity', 'density'] as const;
type Range = readonly [number, number];
const RANGES: Record<string, Range> = {
  cellSize: [0.1, 100],
  releaseDepth: [1e-6, 50],
  releaseTime: [0, 1e7],
  density: [50, 600],
  coverDensity: [50, 600],
  friction: [0.05, 1],
  turbulence: [100, 10000],
  pressure: [0, 3],
  entrainment: [0, 0.1],
  suspension: [0, 1],
  cloudGrowth: [0, 0.5],
  cloudAspect: [0.5, 6],
  cloudThreshold: [1, 60],
  cloudPickup: [0, 0.01],
  settling: [0, 5],
  grain: [1e-5, 1e-2],
  breakPressure: [1000, 2e6],
  bendPressure: [100, 1e6],
  stopMomentum: [0, 0.5],
  buryDepth: [1e-3, 100],
  wind: [0, 60],
  windDirection: [-360, 360],
  timeScale: [0, 100],
  step: [0.005, 0.5],
};

/** Throws for any invalid field of `o`. */
export function validateAvalanche(o: AvalancheOptions): void {
  if (typeof o !== 'object' || o === null) throw new TypeError('Avalanche options must be an object; pass {snow} or {width, depth, ground}');
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = (o as unknown as Record<string, unknown>)[k];
    if (v !== undefined && !(typeof v === 'number' && v >= lo && v <= hi))
      throw new RangeError(`Avalanche ${k} is ${String(v)}; pass a number from ${lo} to ${hi}`);
  }
  const s = o.snow;
  if (s !== undefined && (typeof s?.fieldData !== 'function' || typeof s.slide !== 'function'))
    throw new TypeError('Avalanche snow needs a SnowDrift (fieldData and slide)');
  const W = o.width ?? s?.width,
    D = o.depth ?? s?.depth;
  if (!Number.isInteger(W) || !Number.isInteger(D) || W! < 3 || D! < 3 || W! > 2048 || D! > 2048 || W! * D! > 4194304)
    throw new RangeError('Avalanche width and depth must be whole numbers from 3 to 2048 (at most 4,194,304 samples)');
  if (o.ground !== undefined && o.ground.length !== W! * D!) throw new RangeError(`Avalanche ground needs ${W! * D!} heights`);
  if (typeof o.cover === 'number' ? !(o.cover >= 0 && o.cover <= 50) : o.cover !== undefined && o.cover.length !== W! * D!)
    throw new RangeError(`Avalanche cover must be 0 to 50 m, or ${W! * D!} depths`);
  const r = o.release;
  if (r === 'unstable' && !s) throw new RangeError("Avalanche release 'unstable' needs a snow (a SnowDrift)");
  if (r !== undefined && r !== 'unstable') {
    if (!Array.isArray(r.at) || !r.at.every(Number.isFinite)) throw new RangeError('Avalanche release.at must be [x, z]');
    if (r.size !== undefined && !(r.size.length === 2 && r.size[0] > 0 && r.size[1] > 0))
      throw new RangeError('Avalanche release.size must be two half sizes above 0');
  }
  if (r === undefined && !s) throw new RangeError('Avalanche needs a release (a rectangle) or a snow to release from');
}

/** Voellmy's steady speed along a uniform slope of `slope` degrees for a bed-normal depth `h`: 0 where friction holds. */
export function voellmySpeed(slope: number, h: number, friction = 0.2, turbulence = 2000): number {
  const t = (slope * Math.PI) / 180,
    a = Math.sin(t) - friction * Math.cos(t);
  return a > 0 ? Math.sqrt(turbulence * h * a) : 0;
}

/** The Voellmy-Salm run-out on the flat of a flow `h` deep arriving at `speed` (Salm et al. 1990), metres. */
export function voellmyRunout(speed: number, h: number, friction = 0.2, turbulence = 2000): number {
  return ((turbulence * h) / (2 * G)) * Math.log(1 + (speed * speed) / (friction * turbulence * h));
}

/**
 * An avalanche on a terrain grid: the slab breaks away, the dense core flows down the terrain (Savage-Hutter depth
 * averaged, Voellmy friction), takes the snow cover in its path, throws up a powder cloud that grows as it entrains air
 * and snow, and stops as deposit; trees in its path break and the deposit buries plants. It is a snow field: pass it as
 * `Snow`'s `field` and the ground shows the scar, the moving core and the deposit. `drawCloud` puts the powder cloud
 * into a `Clouds`; `AvalancheScatter` makes plants follow the deposit and leave the broken path.
 * @example
 * const slide = new Avalanche({ snow: drift, release: 'unstable', releaseTime: 2 });
 * Snow.attach(engine, { field: slide });
 * engine.onFrame((_, delta) => { slide.update(delta); slide.drawCloud(clouds); });
 */
export class Avalanche implements SnowFieldSource {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly origin: readonly [number, number];
  /** Grows whenever {@link fieldData} changes. */
  version = 0;
  private readonly n: number;
  private ground!: Float64Array;
  private cover!: Float64Array;
  private deposit!: Float64Array;
  private flow!: Float64Array;
  private qx!: Float64Array;
  private qz!: Float64Array;
  private peak!: Float64Array;
  private scratch!: Float64Array[];
  private parcels: Parcel[] = [];
  private nextId = 1;
  private feed = 0;
  /** Snow thrown up per sample since the last feed, kg, and its momentum, kg m/s. */
  private feedM!: Float64Array;
  private feedPx!: Float64Array;
  private feedPz!: Float64Array;
  private feedClock = 0;
  private released = false;
  private peakMomentum = 0;
  private stopped = false;
  private budgetValues = { released: 0, entrained: 0, deposited: 0 };
  private simTime = 0;
  private film = 0;
  private fixed: unknown[] = [];
  private field?: Float32Array;
  private fieldVersion = -1;
  private readonly clouds = new Map<number, { readonly options: Record<string, unknown>; readonly matrix: Float32Array }>();
  private cloudTarget?: PowderCloudTarget;

  constructor(readonly options: AvalancheOptions) {
    validateAvalanche(options);
    const s = options.snow;
    this.width = options.width ?? s!.width;
    this.depth = options.depth ?? s!.depth;
    this.cellSize = options.cellSize ?? s?.cellSize ?? 1;
    this.origin = [options.origin?.[0] ?? s?.origin[0] ?? 0, options.origin?.[1] ?? s?.origin[1] ?? 0];
    this.n = this.width * this.depth;
    this.fixed = this.fixedKey();
    this.reset();
  }

  /** The fixed options, compared by value for numbers and small arrays and by identity for grids and the snow. */
  private fixedKey(): unknown[] {
    return FIXED.map((k) => {
      const v = this.options[k];
      return k === 'origin' || k === 'release' ? JSON.stringify(v) : v;
    });
  }
  private sameFixed(): boolean {
    const now = this.fixedKey();
    return now.every((v, i) => Object.is(v, this.fixed[i]));
  }

  /** Back to time 0: the snow before the slab breaks. */
  reset(): void {
    const n = this.n,
      o = this.options,
      s = o.snow,
      field = s?.fieldData();
    this.ground = new Float64Array(n);
    this.cover = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      this.ground[k] = o.ground ? o.ground[k]! : field ? field[2 * k]! : 0;
      this.cover[k] = typeof o.cover === 'number' ? o.cover : o.cover ? o.cover[k]! : field ? field[2 * k + 1]! : 1;
    }
    this.deposit = new Float64Array(n);
    this.flow = new Float64Array(n);
    this.qx = new Float64Array(n);
    this.qz = new Float64Array(n);
    this.peak = new Float64Array(n);
    this.scratch = [new Float64Array(n), new Float64Array(n)];
    this.parcels = [];
    this.nextId = 1;
    this.feedM = new Float64Array(n);
    this.feedPx = new Float64Array(n);
    this.feedPz = new Float64Array(n);
    this.feed = this.feedClock = 0;
    this.released = this.stopped = false;
    this.peakMomentum = 0;
    this.budgetValues = { released: 0, entrained: 0, deposited: 0 };
    this.simTime = 0;
    this.film = 0;
    this.version++;
  }

  /** Film seconds reached. */
  get time(): number {
    return this.film;
  }
  /** Whether the slab has broken away. */
  get isReleased(): boolean {
    return this.released;
  }
  /** Whether everything has stopped after the release (no flow and no cloud left). */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Moves film time on by `delta` seconds, as {@link update}: the clock a seek from `@margoengine/cutscene/seek` replays
   * (pass this avalanche in its `extra`), so a scene started at film time T shows what a continuous run shows at T, bit for
   * bit (GAP-FILM-TIME).
   */
  advanceTime(delta: number): void {
    this.update(delta);
  }
  /** Advances by `delta` film seconds. */
  update(delta: number): void {
    if (!(delta >= 0) || !Number.isFinite(delta)) throw new RangeError('Avalanche delta must be a finite number of 0 or more seconds');
    this.seek(this.film + delta);
  }

  /** Shows the avalanche at film time `time`: steps forward, or replays from 0 to go back. */
  seek(time: number): void {
    if (!(time >= 0) || !Number.isFinite(time)) throw new RangeError('Avalanche time must be a finite number of 0 or more seconds');
    validateAvalanche(this.options);
    if (!this.sameFixed()) {
      this.fixed = this.fixedKey();
      this.reset();
    }
    if (time < this.film) this.reset();
    const o = this.options,
      step = o.step ?? 0.05,
      start = o.releaseTime ?? 0,
      target = Math.max(0, time - start) * (o.timeScale ?? 1);
    this.film = time;
    if (time < start) return;
    if (!this.released) this.release();
    let moved = false;
    while (!this.stopped && this.simTime + step <= target + 1e-9) {
      this.step(step);
      this.simTime += step;
      moved = true;
    }
    if (moved) this.version++;
  }

  private release(): void {
    const o = this.options,
      r = o.release ?? 'unstable',
      rhoF = o.density ?? 300;
    let slabDepth: ArrayLike<number> | undefined, slabMass: ArrayLike<number> | undefined, index: ArrayLike<number> | undefined;
    if (r === 'unstable') ({ slabDepth, slabMass, index } = o.snow!.slide());
    const rhoC = o.coverDensity ?? 200,
      dA = this.cellSize * this.cellSize;
    let mass = 0;
    for (let j = 0; j < this.depth; j++)
      for (let i = 0; i < this.width; i++) {
        const k = j * this.width + i;
        let d = 0,
          m = 0;
        if (r === 'unstable') {
          if (index![k]! < 1) {
            d = slabDepth![k]!;
            m = slabMass![k]!;
          }
        } else {
          const x = this.origin[0] + i * this.cellSize - r.at[0],
            z = this.origin[1] + j * this.cellSize - r.at[1],
            [sx, sz] = r.size ?? [30, 15],
            [gx, gz] = this.gradient(this.ground, i, j),
            g = Math.hypot(gx, gz);
          // The rectangle lies across the fall line: its long side across the slope.
          const ax = g > 1e-9 ? -gx / g : 0,
            az = g > 1e-9 ? -gz / g : 1,
            along = x * ax + z * az,
            across = -x * az + z * ax;
          if (Math.abs(across) <= sx && Math.abs(along) <= sz) {
            d = Math.min(this.cover[k]!, o.releaseDepth ?? 1);
            m = d * rhoC;
          }
        }
        if (d > 0) {
          this.cover[k] = Math.max(0, this.cover[k]! - d);
          this.flow[k] = m / rhoF;
          mass += m * dA;
        }
      }
    this.budgetValues.released = mass;
    this.released = true;
    this.version++;
  }

  private gradient(b: Float64Array, i: number, j: number): [number, number] {
    const W = this.width,
      D = this.depth,
      dx = this.cellSize,
      k = j * W + i,
      l = i > 0 ? k - 1 : k,
      r = i < W - 1 ? k + 1 : k,
      d = j > 0 ? k - W : k,
      u = j < D - 1 ? k + W : k;
    return [(b[r]! - b[l]!) / ((r - l) * dx || dx), (b[u]! - b[d]!) / (((u - d) / W) * dx || dx)];
  }

  private step(dt: number): void {
    const o = this.options,
      W = this.width,
      D = this.depth,
      n = this.n,
      dx = this.cellSize,
      k0 = o.pressure ?? 1,
      mu = o.friction ?? 0.2,
      xi = o.turbulence ?? 2000,
      kappa = o.entrainment ?? 0.005,
      share = o.cloud === false ? 0 : (o.suspension ?? 0.25),
      rhoF = o.density ?? 300,
      rhoC = o.coverDensity ?? 200,
      dA = dx * dx,
      bed = this.scratch[0]!,
      h = this.flow,
      qx = this.qx,
      qz = this.qz;
    // The flow follows the ground's slope: the cover and the deposit (at most metres) are not steps it is steered by, as
    // a step deeper than the flow would leave the Rusanov flux and the bed slope unbalanced at its edge (Audusse et al.
    // 2004 balance that only where the step is shallower than the flow, which a steep grid cell is not).
    bed.set(this.ground);
    // Substeps under a CFL of 0.4 (the fastest wave this step).
    let fastest = 0;
    for (let k = 0; k < n; k++)
      if (h[k]! > THIN) fastest = Math.max(fastest, Math.hypot(qx[k]!, qz[k]!) / h[k]! + Math.sqrt(k0 * G * h[k]!));
    const subs = Math.max(1, Math.ceil((fastest * dt) / (0.4 * dx))),
      sdt = dt / subs;
    for (let s = 0; s < subs; s++) this.substep(sdt, bed, k0, mu, xi, kappa, share, rhoF, rhoC, dA);
    // RAMMS's stopping criterion: the momentum has fallen under a share of its peak, so what still flows stops.
    let momentum = 0;
    for (let k = 0; k < n; k++) momentum += Math.hypot(qx[k]!, qz[k]!);
    this.peakMomentum = Math.max(this.peakMomentum, momentum);
    if (momentum <= (o.stopMomentum ?? 0.05) * this.peakMomentum)
      for (let k = 0; k < n; k++)
        if (h[k]! > 0) {
          this.deposit[k] = this.deposit[k]! + h[k]!;
          this.budgetValues.deposited += h[k]! * rhoF * dA;
          h[k] = qx[k] = qz[k] = 0;
        }
    this.cloudStep(dt, rhoC, dA);
    let flowing = false;
    for (let k = 0; k < n && !flowing; k++) flowing = h[k]! > 0;
    if (!flowing && this.parcels.length === 0 && this.released) this.stopped = true;
  }

  private substep(dt: number, bed: Float64Array, k0: number, mu: number, xi: number, kappa: number, share: number, rhoF: number, rhoC: number, dA: number): void {
    const W = this.width,
      D = this.depth,
      n = this.n,
      dx = this.cellSize,
      h = this.flow,
      qx = this.qx,
      qz = this.qz,
      [nh, nqx, nqz] = this.scratch.length > 2 ? (this.scratch.slice(2) as [Float64Array, Float64Array, Float64Array]) : this.grow();
    nh.set(h);
    nqx.set(qx);
    nqz.set(qz);
    // cos^2 of the bed at a cell.
    const cos2 = this.scratch[1]!;
    for (let j = 0; j < D; j++)
      for (let i = 0; i < W; i++) {
        const [gx, gz] = this.gradient(bed, i, j);
        cos2[j * W + i] = 1 / (1 + gx * gx + gz * gz);
      }
    // Rusanov fluxes across every inner face, x faces then z faces; closed outer walls hold nothing in (an open edge:
    // what reaches the last sample stays there as it stops).
    const face = (a: number, b: number, normalX: boolean): void => {
      const ha = h[a]!,
        hb = h[b]!;
      if (ha <= THIN && hb <= THIN) return;
      const ca = cos2[a]!,
        cb = cos2[b]!,
        ua = ha > THIN ? (normalX ? qx[a]! : qz[a]!) / ha : 0,
        ub = hb > THIN ? (normalX ? qx[b]! : qz[b]!) / hb : 0,
        va = ha > THIN ? (normalX ? qz[a]! : qx[a]!) / ha : 0,
        vb = hb > THIN ? (normalX ? qz[b]! : qx[b]!) / hb : 0,
        pa = 0.5 * k0 * G * ca * ha * ha,
        pb = 0.5 * k0 * G * cb * hb * hb,
        s = Math.max(Math.abs(ua) + Math.sqrt(k0 * G * ca * ha), Math.abs(ub) + Math.sqrt(k0 * G * cb * hb)),
        fh = 0.5 * (ha * ua + hb * ub) - 0.5 * s * (hb - ha),
        fn = 0.5 * (ha * ua * ua + pa + hb * ub * ub + pb) - 0.5 * s * (hb * ub - ha * ua),
        ft = 0.5 * (ha * ua * va + hb * ub * vb) - 0.5 * s * (hb * vb - ha * va),
        r = dt / dx;
      nh[a] = nh[a]! - r * fh;
      nh[b] = nh[b]! + r * fh;
      const an = normalX ? nqx : nqz,
        at = normalX ? nqz : nqx;
      // The pressure of each side's own column cancels in the cell (it is the bed slope source's hydrostatic part).
      an[a] = an[a]! - r * (fn - pa);
      an[b] = an[b]! + r * (fn - pb);
      at[a] = at[a]! - r * ft;
      at[b] = at[b]! + r * ft;
    };
    for (let j = 0; j < D; j++) for (let i = 0; i < W - 1; i++) face(j * W + i, j * W + i + 1, true);
    for (let j = 0; j < D - 1; j++) for (let i = 0; i < W; i++) face(j * W + i, (j + 1) * W + i, false);
    // Sources: gravity along the slope (the pressure is in the fluxes), then Voellmy, then entrainment.
    for (let j = 0; j < D; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i,
          hk = h[k]!;
        if (hk <= 0 && nh[k]! <= 0) continue;
        const c = cos2[k]!,
          [bx, bz] = this.gradient(bed, i, j),
          // Drive: the horizontal part of g sin(theta) along the fall line, g cos^2(theta) grad b.
          gx = -G * c * bx,
          gz = -G * c * bz;
        let mx = nqx[k]! + dt * hk * gx,
          mz = nqz[k]! + dt * hk * gz;
        const d = Math.max(0, nh[k]!);
        if (d <= THIN) {
          // Too thin to flow: what is left stops.
          this.deposit[k] = this.deposit[k]! + d;
          this.budgetValues.deposited += d * rhoF * dA;
          nh[k] = 0;
          nqx[k] = nqz[k] = 0;
          continue;
        }
        const gamma = 1 / Math.sqrt(c);
        let speed = Math.hypot(mx, mz) / d;
        // Coulomb: a bed-normal weight mu g cos(theta) along the slope, horizontal part mu g cos^2(theta).
        const coulomb = mu * G * c * dt;
        if (speed <= coulomb) {
          this.deposit[k] = this.deposit[k]! + d;
          this.budgetValues.deposited += d * rhoF * dA;
          nh[k] = 0;
          nqx[k] = nqz[k] = 0;
          continue;
        }
        let next = speed - coulomb;
        // Turbulent: g U^2 / (xi h_n) with U = gamma |u| and h_n = d / gamma, horizontal part g gamma^2 |u|^2 / (xi d), implicit.
        next = next / (1 + (dt * G * gamma * gamma * next) / (xi * d));
        const f = next / speed;
        mx *= f;
        mz *= f;
        speed = next;
        // Entrainment of the cover: kappa U, the snow arriving at rest (momentum kept, speed falls).
        const U = gamma * speed,
          take = Math.min(this.cover[k]!, kappa * U * dt);
        if (take > 0) {
          this.cover[k] = this.cover[k]! - take;
          const mass = take * rhoC * dA;
          this.budgetValues.entrained += mass;
          // Only a flow faster than the cloud threshold throws snow up into suspension (the saltation layer of its front).
          const up = U > (this.options.cloudThreshold ?? 12) ? mass * share : 0;
          nh[k] = d + (mass - up) / (rhoF * dA);
          if (up > 0) {
            const ux = mx / d,
              uz = mz / d;
            this.feed += up;
            this.feedM[k] = this.feedM[k]! + up;
            this.feedPx[k] = this.feedPx[k]! + up * ux;
            this.feedPz[k] = this.feedPz[k]! + up * uz;
          }
        } else nh[k] = d;
        nqx[k] = mx;
        nqz[k] = mz;
        this.peak[k] = Math.max(this.peak[k]!, rhoF * U * U);
      }
    h.set(nh);
    qx.set(nqx);
    qz.set(nqz);
  }

  private grow(): [Float64Array, Float64Array, Float64Array] {
    const n = this.n,
      made: [Float64Array, Float64Array, Float64Array] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    this.scratch.push(...made);
    return made;
  }

  /** Ground height (no snow) and the bilinear index of world (x, z) clamped to the grid. */
  private sampleIndex(x: number, z: number): number {
    const i = Math.min(this.width - 1, Math.max(0, Math.round((x - this.origin[0]) / this.cellSize))),
      j = Math.min(this.depth - 1, Math.max(0, Math.round((z - this.origin[1]) / this.cellSize)));
    return j * this.width + i;
  }

  private bedAt(k: number): number {
    return this.ground[k]! + this.cover[k]! + this.deposit[k]!;
  }

  private cloudStep(dt: number, rhoC: number, dA: number): void {
    const o = this.options;
    if (o.cloud === false) return;
    const growth = o.cloudGrowth ?? 0.06,
      aspect = o.cloudAspect ?? 1.6,
      threshold = o.cloudThreshold ?? 12,
      pickup = o.cloudPickup ?? 0.001,
      settling = o.settling ?? 0.5,
      wind = this.windNow();
    // Every half second the snow thrown up by the core joins the cloud's head over the core's front, its momentum with
    // it against the head's whole inertia (snow, air and added air). The core erupts most of its snow just behind its
    // front and the dilute cloud runs ahead of it (Sovilla, McElwaine and Louge 2015), so the feed goes to the head at
    // the front, never to a parcel at the middle of the flow.
    this.feedClock += dt;
    if (this.feedClock >= 0.5 - 1e-9) {
      this.feedClock = 0;
      if (this.feed > 0) this.feedParcels(aspect);
    }
    const kept: Parcel[] = [],
      bed = this.scratch[0]!;
    if (this.parcels.length) bed.set(this.ground);
    for (const p of this.parcels) {
      const k = this.sampleIndex(p.x, p.z),
        i = k % this.width,
        j = Math.floor(k / this.width);
      const [bx, bz] = this.gradient(bed, i, j),
        c2 = 1 / (1 + bx * bx + bz * bz),
        gamma = 1 / Math.sqrt(c2),
        V = (2 / 3) * Math.PI * aspect * aspect * p.h ** 3,
        added = 0.5 * AIR * V,
        M = p.m + AIR * V + added,
        speed = gamma * Math.hypot(p.ux, p.uz);
      // Gravity on the excess weight along the slope (horizontal part g cos^2 grad b) and the drag of the air it meets.
      const front = 0.5 * Math.PI * aspect * p.h * p.h,
        drag = 0.3 * AIR * front * speed,
        ax = (-p.m * G * c2 * bx - drag * p.ux) / M,
        az = (-p.m * G * c2 * bz - drag * p.uz) / M;
      p.ux += ax * dt;
      p.uz += az * dt;
      const travelled = gamma * Math.hypot(p.ux, p.uz) * dt;
      // Height grows with distance (Beghin et al. 1981); the entrained air arrives at rest, so momentum is kept.
      const h0 = p.h;
      p.h += growth * travelled;
      const V1 = (2 / 3) * Math.PI * aspect * aspect * p.h ** 3,
        M1 = p.m + 1.5 * AIR * V1,
        keep = (p.m + 1.5 * AIR * (2 / 3) * Math.PI * aspect * aspect * h0 ** 3) / M1;
      p.ux *= keep;
      p.uz *= keep;
      const U = gamma * Math.hypot(p.ux, p.uz);
      if (U > threshold) {
        // Above the threshold it picks up the cover under it (Rastello and Hopfinger 2004).
        // Over its footprint (an ellipse of semi-axes aspect x height), at most 16 samples each way of its centre.
        const rate = pickup * (U - threshold) * dt,
          reach = Math.min(16, Math.floor((aspect * p.h) / this.cellSize)),
          r2 = (aspect * p.h) ** 2;
        let mass = 0;
        for (let b = Math.max(0, j - reach); b <= Math.min(this.depth - 1, j + reach); b++)
          for (let a = Math.max(0, i - reach); a <= Math.min(this.width - 1, i + reach); a++) {
            const q = b * this.width + a;
            if (((a - i) ** 2 + (b - j) ** 2) * this.cellSize ** 2 > r2 && q !== k) continue;
            const take = Math.min(this.cover[q]!, rate);
            this.cover[q] = this.cover[q]! - take;
            mass += take * rhoC * dA;
          }
        this.budgetValues.entrained += mass;
        p.m += mass;
      } else {
        // Below it the grains settle out over its height.
        const lost = p.m * Math.min(1, (settling * dt) / p.h) * (1 - (U * U) / (threshold * threshold));
        p.m -= lost;
        this.depositAt(k, lost, rhoC, dA);
      }
      p.x += (p.ux + wind[0]) * dt;
      p.z += (p.uz + wind[1]) * dt;
      const rho = AIR + p.m / V1;
      this.peak[k] = Math.max(this.peak[k]!, rho * U * U);
      const inside = p.x >= this.origin[0] && p.z >= this.origin[1] && p.x <= this.origin[0] + (this.width - 1) * this.cellSize && p.z <= this.origin[1] + (this.depth - 1) * this.cellSize;
      // A parcel too thin to see (optical depth under 0.002) has settled out: what it holds lies where it is.
      const tau = ((3 * (p.m / V1)) / (2 * ICE * (o.grain ?? 1e-4))) * p.h;
      if (p.m > 1 && tau > 0.002 && inside) kept.push(p);
      else this.depositAt(this.sampleIndex(p.x, p.z), p.m, rhoC, dA);
    }
    this.parcels = kept;
  }

  private feedParcels(aspect: number): void {
    const W = this.width,
      dx = this.cellSize;
    let m = 0,
      px = 0,
      pz = 0;
    for (let k = 0; k < this.n; k++) {
      m += this.feedM[k]!;
      px += this.feedPx[k]!;
      pz += this.feedPz[k]!;
    }
    // The core's front: the feeding sample farthest along the feed's mean direction.
    const l = Math.hypot(px, pz) || 1,
      dirX = px / l,
      dirZ = pz / l;
    let fx = 0,
      fz = 0,
      far = -Infinity;
    for (let k = 0; k < this.n; k++) {
      if (!(this.feedM[k]! > 0)) continue;
      const cx = this.origin[0] + (k % W) * dx,
        cz = this.origin[1] + Math.floor(k / W) * dx,
        along = cx * dirX + cz * dirZ;
      if (along > far) {
        far = along;
        fx = cx;
        fz = cz;
      }
      this.feedM[k] = this.feedPx[k] = this.feedPz[k] = 0;
    }
    // The cloud's head: the parcel farthest along that direction. It takes the feed while its footprint (semi-axes
    // aspect x height) reaches the core's front; one left behind becomes tail, and the feed starts a new head there.
    let head: Parcel | undefined,
      lead = -Infinity;
    for (const p of this.parcels) {
      const along = p.x * dirX + p.z * dirZ;
      if (along > lead) {
        lead = along;
        head = p;
      }
    }
    if (head && Math.hypot(head.x - fx, head.z - fz) < aspect * head.h) {
      const M = head.m + 1.5 * AIR * (2 / 3) * Math.PI * aspect * aspect * head.h ** 3;
      head.ux = (head.ux * M + px) / (M + m);
      head.uz = (head.uz * M + pz) / (M + m);
      head.m += m;
    } else this.parcels.push({ id: this.nextId++, x: fx, z: fz, ux: px / m, uz: pz / m, h: 2, m });
    this.feed = 0;
  }

  private depositAt(k: number, mass: number, rhoC: number, dA: number): void {
    if (!(mass > 0)) return;
    this.deposit[k] = this.deposit[k]! + mass / (rhoC * dA);
    this.budgetValues.deposited += mass;
  }

  /** The wind drifting the cloud, [x, z] m/s: the option, else the weather, else calm. */
  windNow(): [number, number] {
    const o = this.options,
      s = o.weather?.state,
      w = o.wind ?? s?.wind ?? 0,
      d = o.windDirection != null ? (o.windDirection * Math.PI) / 180 : (s?.windDirection ?? 0);
    return [w * Math.sin(d), w * Math.cos(d)];
  }

  /** Ground height and snow depth (cover, deposit and the flowing core) per sample, interleaved, for `Snow`'s field. */
  fieldData(): Float32Array {
    if (this.field && this.fieldVersion === this.version) return this.field;
    const n = this.n,
      out = this.field ?? new Float32Array(2 * n);
    for (let k = 0; k < n; k++) {
      out[2 * k] = this.ground[k]!;
      out[2 * k + 1] = this.cover[k]! + this.deposit[k]! + this.flow[k]!;
    }
    this.field = out;
    this.fieldVersion = this.version;
    return out;
  }

  /** Flowing thickness per sample, metres (vertical). */
  flowDepth(): Float32Array {
    return Float32Array.from(this.flow);
  }
  /** Flow speed along the slope per sample, m/s. */
  flowSpeed(): Float32Array {
    const out = new Float32Array(this.n);
    for (let j = 0; j < this.depth; j++)
      for (let i = 0; i < this.width; i++) {
        const k = j * this.width + i,
          h = this.flow[k]!;
        if (h <= THIN) continue;
        const [gx, gz] = this.gradient(this.scratch[0]!, i, j);
        out[k] = Math.sqrt(1 + gx * gx + gz * gz) * (Math.hypot(this.qx[k]!, this.qz[k]!) / h);
      }
    return out;
  }
  /** Deposit per sample, metres. */
  depositDepth(): Float32Array {
    return Float32Array.from(this.deposit);
  }
  /** Snow cover left per sample, metres (the scar and the entrained path show as less). */
  coverDepth(): Float32Array {
    return Float32Array.from(this.cover);
  }
  /** Highest pressure the dense flow or the cloud put on each sample, Pa. */
  peakPressure(): Float32Array {
    return Float32Array.from(this.peak);
  }
  /**
   * Share of plants left standing per sample, 0 to 1: trees break from half the `breakPressure` to all of it, and a
   * deposit from half the `buryDepth` to all of it buries what is left.
   */
  plantsKept(): Float32Array {
    const o = this.options,
      p = o.breakPressure ?? 100000,
      b = o.buryDepth ?? 2,
      out = new Float32Array(this.n);
    for (let k = 0; k < this.n; k++) out[k] = (1 - smoothstep(0.5 * p, p, this.peak[k]!)) * (1 - smoothstep(0.5 * b, b, this.deposit[k]!));
    return out;
  }
  /**
   * How plants bend under the flow now, per sample interleaved `[x, z]`: the direction the dense core or the cloud over
   * it pushes, its length the bend from 0 (upright) to 1 (flat). Plants bend from `bendPressure` and lie flat at half
   * the `breakPressure`, where {@link plantsKept} starts to break them; they stand up again once the flow has passed.
   */
  plantBend(): Float32Array {
    const o = this.options,
      lo = o.bendPressure ?? 1000,
      hi = Math.max(lo * 1.001, 0.5 * (o.breakPressure ?? 100000)),
      rhoF = o.density ?? 300,
      aspect = o.cloudAspect ?? 1.6,
      W = this.width,
      dx = this.cellSize,
      press = new Float64Array(this.n),
      out = new Float32Array(2 * this.n),
      bed = this.scratch[0]!;
    const push = (k: number, p: number, ux: number, uz: number): void => {
      if (!(p > press[k]!)) return;
      press[k] = p;
      const l = Math.hypot(ux, uz) || 1;
      out[2 * k] = ux / l;
      out[2 * k + 1] = uz / l;
    };
    for (let j = 0; j < this.depth; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i,
          h = this.flow[k]!;
        if (h <= THIN) continue;
        const [gx, gz] = this.gradient(bed, i, j),
          U = Math.sqrt(1 + gx * gx + gz * gz) * (Math.hypot(this.qx[k]!, this.qz[k]!) / h);
        push(k, rhoF * U * U, this.qx[k]!, this.qz[k]!);
      }
    for (const p of this.parcels) {
      const V = (2 / 3) * Math.PI * aspect * aspect * p.h ** 3,
        rho = AIR + p.m / V,
        U = Math.hypot(p.ux, p.uz),
        reach = Math.min(16, Math.floor((aspect * p.h) / dx)),
        k0 = this.sampleIndex(p.x, p.z),
        i0 = k0 % W,
        j0 = Math.floor(k0 / W);
      for (let b = Math.max(0, j0 - reach); b <= Math.min(this.depth - 1, j0 + reach); b++)
        for (let a = Math.max(0, i0 - reach); a <= Math.min(W - 1, i0 + reach); a++)
          if (((a - i0) ** 2 + (b - j0) ** 2) * dx * dx <= (aspect * p.h) ** 2) push(b * W + a, rho * U * U, p.ux, p.uz);
    }
    const kept = this.plantsKept();
    for (let k = 0; k < this.n; k++) {
      const amount = kept[k]! > 0 ? smoothstep(lo, hi, press[k]!) : 0;
      out[2 * k] = out[2 * k]! * amount;
      out[2 * k + 1] = out[2 * k + 1]! * amount;
    }
    return out;
  }

  /**
   * {@link plantBend} as pushers for a `TrampledScatter` of `@margoengine/scatter/interact`: one per bent sample, half a
   * sample upstream of it with a radius of one sample, so the plants on it turn along the flow. The strongest `most`
   * (default 4,096, the scatter's limit), ties in sample order.
   */
  plantPushers(most = 4096): { position: [number, number, number]; radius: number; strength: number }[] {
    const bend = this.plantBend(),
      f = this.fieldData(),
      W = this.width,
      dx = this.cellSize,
      list: { k: number; amount: number }[] = [];
    for (let k = 0; k < this.n; k++) {
      const amount = Math.hypot(bend[2 * k]!, bend[2 * k + 1]!);
      if (amount > 0.01) list.push({ k, amount });
    }
    list.sort((a, b) => b.amount - a.amount || a.k - b.k);
    return list.slice(0, Math.max(0, Math.floor(most))).map(({ k, amount }) => ({
      position: [
        this.origin[0] + (k % W) * dx - (0.5 * dx * bend[2 * k]!) / amount,
        f[2 * k]! + f[2 * k + 1]!,
        this.origin[1] + Math.floor(k / W) * dx - (0.5 * dx * bend[2 * k + 1]!) / amount,
      ],
      radius: dx,
      strength: Math.min(1, amount),
    }));
  }

  /** The farthest a sample of flow or deposit lies from the slab's first sample along `direction` [x, z], metres. */
  reach(direction: readonly [number, number], from: readonly [number, number]): number {
    const l = Math.hypot(direction[0], direction[1]) || 1;
    let best = 0;
    for (let k = 0; k < this.n; k++)
      if (this.flow[k]! > THIN || this.deposit[k]! > 1e-3) {
        const x = this.origin[0] + (k % this.width) * this.cellSize - from[0],
          z = this.origin[1] + Math.floor(k / this.width) * this.cellSize - from[1];
        best = Math.max(best, (x * direction[0] + z * direction[1]) / l);
      }
    return best;
  }
  /** The powder cloud's parcels now. */
  powderCloud(): PowderParcel[] {
    const aspect = this.options.cloudAspect ?? 1.6,
      r = this.options.grain ?? 1e-4,
      wind = this.windNow();
    return this.parcels.map((p) => {
      const k = this.sampleIndex(p.x, p.z),
        V = (2 / 3) * Math.PI * aspect * aspect * p.h ** 3,
        c = p.m / V,
        tau = ((3 * c) / (2 * ICE * r)) * p.h;
      return {
        id: p.id,
        position: [p.x, this.bedAt(k) + (this.flow[k] ?? 0), p.z] as const,
        velocity: [p.ux + wind[0], p.uz + wind[1]] as const,
        speed: Math.hypot(p.ux, p.uz),
        height: p.h,
        snow: p.m,
        concentration: c,
        opacity: 1 - Math.exp(-tau),
      };
    });
  }
  /** The mass budget, kg: released + entrained = flowing + deposited + suspended (to rounding). */
  budget(): AvalancheBudget {
    let flowing = 0,
      suspended = this.feed;
    const rho = this.options.density ?? 300,
      dA = this.cellSize * this.cellSize;
    for (let k = 0; k < this.n; k++) flowing += this.flow[k]! * rho * dA;
    for (const p of this.parcels) suspended += p.m;
    return { ...this.budgetValues, flowing, suspended };
  }

  /**
   * Puts the powder cloud into `clouds` (a `Clouds` of `@margoengine/vfx/clouds`): one cloud of soft lit puffs per
   * parcel, sized and placed by it, white, its opacity the parcel's; parcels gone are taken out. Call after `update`.
   */
  drawCloud(clouds: PowderCloudTarget, puffs = 24): void {
    if (this.cloudTarget && this.cloudTarget !== clouds) this.clearCloud();
    this.cloudTarget = clouds;
    const aspect = this.options.cloudAspect ?? 1.6,
      live = new Set<number>();
    for (const p of this.powderCloud()) {
      live.add(p.id);
      let c = this.clouds.get(p.id);
      if (!c) {
        c = clouds.add({ seed: p.id, segments: puffs, bounds: [2 * aspect, 1, 2 * aspect], volume: 1.4, color: [0.92, 0.94, 0.97], concentrate: 'inside' });
        this.clouds.set(p.id, c);
      }
      c.options.opacity = Math.min(1, p.opacity);
      const s = p.height,
        m = c.matrix,
        head = Math.atan2(p.velocity[0], p.velocity[1]);
      m.fill(0);
      m[0] = Math.cos(head) * s;
      m[2] = -Math.sin(head) * s;
      m[5] = s;
      m[8] = Math.sin(head) * s;
      m[10] = Math.cos(head) * s;
      m[12] = p.position[0];
      m[13] = p.position[1] + 0.5 * s;
      m[14] = p.position[2];
      m[15] = 1;
    }
    for (const [id, c] of this.clouds)
      if (!live.has(id)) {
        clouds.remove(c);
        this.clouds.delete(id);
      }
  }

  /** Takes every cloud {@link drawCloud} added out of its `Clouds`. */
  clearCloud(): void {
    for (const c of this.clouds.values()) this.cloudTarget?.remove(c);
    this.clouds.clear();
  }
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Maps that make a `Scatter` or `GrassScatter` (`@margoengine/scatter`) follow an avalanche: plants stand on the snow
 * surface (ground, cover and deposit) and are kept by {@link Avalanche.plantsKept}, so the broken path and the buried
 * run-out are bare. Spread it into the scatter's options: `{heightmap: s.heightmap, densityMap: s.densityMap, bounds:
 * s.bounds}`. The maps follow the avalanche's `version` each frame; disposing releases them.
 */
export class AvalancheScatter implements EnginePlugin {
  readonly name: string;
  private static count = 0;
  private engine?: Engine;
  private height?: GPUTexture;
  private density?: GPUTexture;
  private seen = -1;
  private disposed = false;
  /** World `[minX, minZ, maxX, maxZ]` the maps cover (half a cell past the grid). */
  readonly bounds: readonly [number, number, number, number];

  constructor(readonly avalanche: Avalanche) {
    if (!(avalanche instanceof Avalanche)) throw new TypeError('AvalancheScatter needs an Avalanche');
    this.name = `weather-avalanche-scatter:${AvalancheScatter.count++}`;
    const a = avalanche,
      h = a.cellSize / 2;
    this.bounds = [a.origin[0] - h, a.origin[1] - h, a.origin[0] + (a.width - 1) * a.cellSize + h, a.origin[1] + (a.depth - 1) * a.cellSize + h];
  }

  /** Makes the maps on an engine and keeps them up to date. */
  static attach(engine: EngineKernel, avalanche: Avalanche): AvalancheScatter {
    const s = new AvalancheScatter(avalanche);
    engineRuntime(engine).use(s);
    return s;
  }

  /** `r32float` snow surface heights, metres; undefined until attached. */
  readonly heightmap = (): GPUTexture | undefined => (this.upload(), this.height);
  /** `r8unorm` share of plants kept. */
  readonly densityMap = (): GPUTexture | undefined => (this.upload(), this.density);

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'AvalancheScatter is disposed; create a new AvalancheScatter');
    if (!engine.gpu) throw new MargoError('unsupported', 'AvalancheScatter requires WebGPU or its WebGL2 compatibility device');
    this.engine = engine;
    this.seen = -1;
  }

  onPreUpdate(): void {
    this.upload();
  }

  private upload(): void {
    const device = this.engine?.gpu,
      a = this.avalanche;
    if (this.disposed || !device) return;
    if (!this.height || !this.density) {
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
      this.height = device.createTexture({ size: [a.width, a.depth], format: 'r32float', usage });
      this.density = device.createTexture({ size: [a.width, a.depth], format: 'r8unorm', usage });
      this.seen = -1;
    }
    if (this.seen === a.version) return;
    this.seen = a.version;
    const f = a.fieldData(),
      n = a.width * a.depth,
      heights = new Float32Array(n),
      kept = a.plantsKept(),
      bytes = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      heights[k] = f[2 * k]! + f[2 * k + 1]!;
      bytes[k] = Math.round(255 * kept[k]!);
    }
    device.queue.writeTexture({ texture: this.height }, heights, { bytesPerRow: a.width * 4 }, [a.width, a.depth]);
    device.queue.writeTexture({ texture: this.density }, bytes, { bytesPerRow: a.width }, [a.width, a.depth]);
  }

  private release(): void {
    this.height?.destroy();
    this.density?.destroy();
    this.height = this.density = undefined;
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }

  declare [Symbol.dispose]: () => void;
}
AvalancheScatter.prototype[Symbol.dispose] = AvalancheScatter.prototype.dispose;
