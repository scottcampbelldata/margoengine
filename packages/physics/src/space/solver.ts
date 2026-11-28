import type { Vec3 } from '@margoengine/core';
import { add, dot, scale, sub } from '@margoengine/math/vec3';

import { regionWords } from '../world/memory.js';
import {
  type FieldDescriptor,
  type Port,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
  rateOf,
} from '../world/solver.js';

import { analyticPositions } from './analytic.js';
import { magnitude } from './angles.js';
import {
  type GeodeticSite,
  type Insolation,
  type LunarEclipse,
  type TidalDrive,
  lunarEclipse,
  sampleInsolation,
  tidalDrive,
} from './effects.js';
import { celestialError } from './errors.js';
import {
  type CelestialKernelBuilds,
  type CelestialOrbitKernel,
  type CelestialOrbitWorkCounts,
  bindCelestialOrbits,
  loadCelestialKernels,
} from './kernel.js';
import { type EarthOrientation, earthFrame, toEarthFixed } from './orientation.js';
import type { EphemerisState, SpkEphemeris } from './spk.js';

const LIGHT_SPEED = 299792458;
const SOLAR_BARYCENTRE = 0;
const EARTH = 399;
const WORD = Float64Array.BYTES_PER_ELEMENT;
const BODY_NAMES = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;

/** Bodies resolved by the celestial solver. Mars and the giant planets use their system barycentres in DE440s. */
export type CelestialBody = (typeof BODY_NAMES)[number];

const BODY_IDS: Record<CelestialBody, number> = {
  sun: 10,
  moon: 301,
  mercury: 199,
  venus: 299,
  mars: 4,
  jupiter: 5,
  saturn: 6,
  uranus: 7,
  neptune: 8,
};

/** Insolation field, encoded as two f64 Earth-fixed apparent position vectors in metres, Sun then Moon. */
export const INSOLATION_FIELD: FieldDescriptor = Object.freeze({
  name: 'insolation',
  kind: 'scalarSeries',
  centring: 'vertex',
  quantity: 'heatFlux',
  unit: 'W/m^2',
});

/** Tide field, encoded as two f64 Earth-fixed simultaneous position vectors in metres, Sun then Moon. */
export const TIDAL_POTENTIAL_FIELD: FieldDescriptor = Object.freeze({
  name: 'tidalPotential',
  kind: 'scalarSeries',
  centring: 'vertex',
  quantity: 'tidalPotential',
  unit: 'm^2/s^2',
});

/** TT, UT1 and TDB at the start of the world, each in seconds since Julian Date 2451545.0 on its own timescale. */
export interface CelestialEpoch {
  readonly ttSeconds: number;
  readonly ut1Seconds: number;
  /** Defaults to TT. Explicit TDB lets callers use an externally determined relativistic correction. */
  readonly tdbSeconds?: number;
}

/** Start time, rate and ephemeris for a celestial solver. */
export interface CelestialParams {
  /** Defaults to the J2000 instant, using ΔT = 63.86 s from the NASA eclipse canon's year-2000 expression. */
  readonly epoch?: CelestialEpoch;
  /** Astronomical seconds per world second. Defaults to 1. A negative value runs the sky backwards. */
  readonly timeScale?: number;
  /** Optional NASA/JPL kernel. Defaults to the bundled analytic Sun, Moon and planet model. */
  readonly ephemeris?: SpkEphemeris;
  /** Optional Earth orientation parameters held for this run. Defaults to modelled precession and nutation. */
  readonly orientation?: EarthOrientation;
}

/** Options for the optional Standish planetary orbit kernel. */
export interface CelestialLoadOptions {
  /** Defaults to 'celestial'. */
  readonly id?: string;
  /** Maximum native participants, including the caller. Defaults to 1. */
  readonly threads?: 1 | 2 | 4;
  readonly signal?: AbortSignal;
}

interface Settings {
  readonly ttSeconds: number;
  readonly ut1Seconds: number;
  readonly tdbSeconds: number;
  readonly timeScale: number;
  readonly ephemeris?: SpkEphemeris;
  readonly orientation?: EarthOrientation;
}

interface CelestialState {
  readonly positions: readonly Vec3[];
  readonly light: readonly number[];
  readonly tide: readonly number[];
  readonly time: readonly number[];
}

const ORIGIN = [0, 0, 0] as const;

function vector(words: Float64Array, offset: number): Vec3 {
  return [words[offset]!, words[offset + 1]!, words[offset + 2]!];
}

function pairFromPort(memory: WebAssembly.Memory, port: Port, field: FieldDescriptor): readonly [Vec3, Vec3] {
  const region = port.region;
  if (port.field !== field.name || region.layout !== 1 || region.type !== 'f64' || region.byteLength !== 6 * WORD)
    throw celestialError('Use the matching celestial field port with layout 1 and six f64 words.', 'version');
  const owner = region.memory ?? memory;
  if (
    !Number.isSafeInteger(region.byteOffset) ||
    region.byteOffset < 0 ||
    region.byteOffset % WORD !== 0 ||
    region.byteOffset > owner.buffer.byteLength - region.byteLength
  )
    throw celestialError('Publish the six f64 words at an aligned offset within the memory that owns this field.');
  const words = new Float64Array(owner.buffer, region.byteOffset, 6);
  return [vector(words, 0), vector(words, 3)];
}

/** Sample the published insolation port at a WGS 84 geodetic site. */
export function insolationFromPort(memory: WebAssembly.Memory, port: Port, site: GeodeticSite): Insolation {
  const [sun, moon] = pairFromPort(memory, port, INSOLATION_FIELD);
  return sampleInsolation(sun, moon, site);
}

/** Sample the published tide port at an Earth-fixed point, in metres. */
export function tideFromPort(memory: WebAssembly.Memory, port: Port, position: Vec3): TidalDrive {
  const [sun, moon] = pairFromPort(memory, port, TIDAL_POTENTIAL_FIELD);
  return tidalDrive(sun, moon, position);
}

function apparent(k: SpkEphemeris, body: number, tdb: number, observer: EphemerisState, geometric: Vec3): Vec3 {
  // NAIF SPK, "Light Time Corrections". Three fixed-point refinements of the one-way light-time equation
  // converge rapidly: each iteration contracts the error by at most source speed divided by light speed.
  let displacement = geometric;
  for (let i = 0; i < 3; i++) {
    const transmitTime = tdb - magnitude(displacement) / LIGHT_SPEED;
    displacement = sub(k.state(body, SOLAR_BARYCENTRE, transmitTime).position, observer.position);
  }
  // NAIF SPK, "Stellar Aberration". The transverse observer motion tilts the ray by sin φ = |v⊥| / c.
  const distance = magnitude(displacement);
  const ray = scale(displacement, 1 / distance);
  const transverse = sub(observer.velocity, scale(ray, dot(observer.velocity, ray)));
  const fraction = scale(transverse, 1 / LIGHT_SPEED);
  return scale(add(scale(ray, Math.sqrt(1 - dot(fraction, fraction))), fraction), distance);
}

/** Deterministic celestial ephemeris with one-way insolation and tidal potential outputs. */
export class CelestialSolver implements Solver<CelestialParams> {
  readonly #id: string;
  #host: SolverHost | undefined;
  #builds: CelestialKernelBuilds | undefined;
  #kernel: CelestialOrbitKernel | undefined;
  #disposed = false;
  #settings!: Settings;
  #celestial!: Region;
  #light!: Region;
  #tide!: Region;
  #time!: Region;

  /** @param id Solver ID in the physics world. Defaults to 'celestial'. */
  constructor(id = 'celestial') {
    this.#id = id;
  }

  /** Compile the optional native planetary orbit kernel before adding this solver to a world. */
  static async load(options: CelestialLoadOptions = {}): Promise<CelestialSolver> {
    const solver = new CelestialSolver(options.id);
    solver.#builds = await loadCelestialKernels(options.signal, options.threads ?? 1);
    return solver;
  }

  /** Release this solver's native helpers after its world has stopped stepping. */
  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#builds?.[Symbol.dispose]();
    this.#builds = undefined;
    this.#kernel = undefined;
  }

  /** Native planetary work for the latest accepted epoch, when the optional analytic kernel ran. */
  readNativeWork(): CelestialOrbitWorkCounts | undefined {
    return this.#kernel?.workCounts();
  }

  describe(): SolverDescription {
    return {
      id: this.#id,
      fields: [
        { field: INSOLATION_FIELD, access: 'write' },
        { field: TIDAL_POTENTIAL_FIELD, access: 'write' },
      ],
      rate: 0,
      stableRate: () => 0,
      // Astronomical seconds per world second: a solver reading the sky's insolation or tide must run at the same. A sky
      // frozen (0) or run backwards is a set input, not a faster clock, and counts as the world's time.
      timeScale: () => (this.#settings.timeScale > 0 ? this.#settings.timeScale : 1),
    };
  }

  init(host: SolverHost, params: CelestialParams = {}): void {
    if (this.#disposed) throw celestialError('Create a new celestial solver after disposing its helpers.', 'disposed');
    if (this.#host)
      throw celestialError(
        'The celestial solver is already attached. Create a new solver for the next world.',
        'attached',
      );
    const { epoch, ephemeris, orientation, timeScale = 1 } = params;
    const ttSeconds = epoch?.ttSeconds ?? 0;
    const ut1Seconds = epoch?.ut1Seconds ?? -63.86;
    const tdbSeconds = epoch?.tdbSeconds ?? ttSeconds;
    if (![ttSeconds, ut1Seconds, tdbSeconds, timeScale].every(Number.isFinite))
      throw celestialError('Pass finite TT, UT1 and TDB epoch offsets and a finite celestial time scale.');
    this.#settings = {
      ttSeconds,
      ut1Seconds,
      tdbSeconds,
      timeScale,
      ephemeris,
      orientation: orientation && {
        ...orientation,
        celestialPole: orientation.celestialPole && { ...orientation.celestialPole },
      },
    };
    const kernel = this.#builds && !ephemeris ? bindCelestialOrbits(host, this.#builds) : undefined;
    const state = this.#calculate(0, kernel);
    this.#celestial = host.allocate('celestialPositions', 3 * BODY_NAMES.length * WORD, 'f64', 1);
    this.#light = host.allocate(INSOLATION_FIELD.name, 6 * WORD, 'f64', 1);
    this.#tide = host.allocate(TIDAL_POTENTIAL_FIELD.name, 6 * WORD, 'f64', 1);
    this.#time = host.allocate('celestialClock', 4 * WORD, 'f64', 1);
    this.#host = host;
    this.#kernel = kernel;
    this.#write(state);
  }

  #calculate(elapsed: number, kernel: CelestialOrbitKernel | undefined): CelestialState {
    const { ttSeconds, ut1Seconds, tdbSeconds, ephemeris, orientation } = this.#settings;
    const tt = ttSeconds + elapsed;
    const ut1 = ut1Seconds + elapsed;
    const tdb = tdbSeconds + elapsed;
    if (![tt, ut1, tdb].every(Number.isFinite))
      throw celestialError('Reduce the celestial time scale or seek to an epoch within the ephemeris range.');
    let positions: Vec3[];
    let lightSun: Vec3;
    let lightMoon: Vec3;
    if (ephemeris) {
      positions = BODY_NAMES.map((body) => ephemeris.state(BODY_IDS[body], EARTH, tdb).position);
      const observer = ephemeris.state(EARTH, SOLAR_BARYCENTRE, tdb);
      lightSun = apparent(ephemeris, BODY_IDS.sun, tdb, observer, positions[0]!);
      lightMoon = apparent(ephemeris, BODY_IDS.moon, tdb, observer, positions[1]!);
    } else {
      const analytic = analyticPositions(tdb, kernel && ((centuries) => kernel.run(centuries)));
      positions = [
        analytic.sun,
        analytic.moon,
        ...BODY_NAMES.slice(2).map((body) =>
          analytic.planet(BODY_IDS[body] === 199 ? 1 : BODY_IDS[body] === 299 ? 2 : BODY_IDS[body]),
        ),
      ];
      lightSun = analytic.sun;
      lightMoon = analytic.moon;
    }
    const frame = earthFrame(tt, ut1, orientation);
    const candidate = {
      positions,
      light: [...toEarthFixed(frame, lightSun), ...toEarthFixed(frame, lightMoon)],
      tide: [...toEarthFixed(frame, positions[0]!), ...toEarthFixed(frame, positions[1]!)],
      time: [tt, ut1, tdb, frame.rotation],
    };
    if (
      !candidate.positions.every((position) => position.length === 3 && position.every(Number.isFinite)) ||
      !candidate.light.every(Number.isFinite) ||
      !candidate.tide.every(Number.isFinite) ||
      !candidate.time.every(Number.isFinite)
    )
      throw celestialError(
        'Use an ephemeris and Earth orientation that produce finite positions and time at this epoch.',
      );
    return candidate;
  }

  #words(region: Region): Float64Array {
    if (!this.#host)
      throw celestialError('The celestial solver has no world. Add it with world.add(solver, params) before sampling.');
    return regionWords(this.#host.memory, region) as Float64Array;
  }

  #write(state: CelestialState): void {
    const positions = this.#words(this.#celestial);
    for (let i = 0; i < state.positions.length; i++) positions.set(state.positions[i]!, 3 * i);
    this.#words(this.#light).set(state.light);
    this.#words(this.#tide).set(state.tide);
    this.#words(this.#time).set(state.time);
    this.#kernel?.accept();
  }

  step(context: StepContext, _dt: number): void {
    if (this.#disposed)
      throw celestialError('Use a live celestial solver and dispose it after the world stops stepping.', 'disposed');
    if (!this.#host) throw celestialError('Add the celestial solver to a world before stepping it.');
    // Absolute integer world ticks avoid accumulating a rounded astronomical dt over a long film.
    const elapsed = ((context.tick + 1) / rateOf(context.level)) * this.#settings.timeScale;
    this.#write(this.#calculate(elapsed, this.#kernel));
  }

  exportPorts(tick: number): readonly Port[] {
    return [
      { field: INSOLATION_FIELD.name, region: this.#light, tick, cell: this.#host?.cell ?? ORIGIN },
      { field: TIDAL_POTENTIAL_FIELD.name, region: this.#tide, tick, cell: this.#host?.cell ?? ORIGIN },
    ];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    return [this.#celestial, this.#light, this.#tide];
  }

  extraState(): readonly Region[] {
    return [this.#time];
  }

  /** The current epoch in the same timescales as the initial epoch, with TDB always populated. */
  get epoch(): Required<CelestialEpoch> {
    const words = this.#words(this.#time);
    return { ttSeconds: words[0]!, ut1Seconds: words[1]!, tdbSeconds: words[2]! };
  }

  /** The current Earth rotation angle from the celestial intermediate origin, in radians. */
  get rotation(): number {
    return this.#words(this.#time)[3]!;
  }

  /** Simultaneous geometric geocentric position in J2000 axes, in metres. */
  position(body: CelestialBody): Vec3 {
    const index = BODY_NAMES.indexOf(body);
    if (index < 0) throw celestialError('Pass one of the named bodies from the celestial ephemeris.');
    return vector(this.#words(this.#celestial), 3 * index);
  }

  /** Local geometric eclipse, solar direction and top-of-atmosphere sunlight. */
  insolation(site: GeodeticSite): Insolation {
    const words = this.#words(this.#light);
    return sampleInsolation(vector(words, 0), vector(words, 3), site);
  }

  /** Fraction of the Moon in the Earth's umbral and penumbral shadows. */
  lunarEclipse(): LunarEclipse {
    return lunarEclipse(this.position('sun'), this.position('moon'));
  }

  /** Direct lunar and solar tidal forcing, at an Earth-fixed Cartesian point in metres. */
  tide(position: Vec3): TidalDrive {
    const words = this.#words(this.#tide);
    return tidalDrive(vector(words, 0), vector(words, 3), position);
  }
}
