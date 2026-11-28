import { cos, exp, ln, pow, sin } from '@margoengine/math/pinned';
import {
  isRateLevel,
  regionWords,
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/index.js';
import { accretionError } from './errors.js';

const G = 6.6743e-11;
const C = 299_792_458;
const LAYOUT = 1;
const WORD = Float64Array.BYTES_PER_ELEMENT;
const EQUATOR = Math.PI / 2;
const MAX_GEODESIC_SUBSTEPS = 1 << 14;

type Six = readonly [number, number, number, number, number, number];

/**
 * Constants of motion of a Kerr geodesic: energy, axial angular momentum in geometrized units and Carter's
 * constant Q (default 0).
 */
export interface KerrConstants {
  /** Energy per unit rest mass for timelike tracers, or an arbitrary affine normalization for light. */
  readonly energy: number;
  /** Axial angular momentum in geometrized units (divide specific SI angular momentum by GM/c). */
  readonly axialAngularMomentum: number;
  /** Carter's constant Q in squared geometrized angular momentum units. Default zero. */
  readonly carterConstant?: number;
}

/**
 * A circular Kerr orbit: the constants of motion plus the angular velocity in radians per gravitational time
 * GM/c³.
 */
export interface KerrCircularOrbit extends KerrConstants {
  /** Angular velocity in radians per gravitational time GM/c³. */
  readonly angularVelocity: number;
}

/** A tracer or test particle in the fixed Kerr geometry, advanced in exterior observer time. */
export interface KerrGeodesicParams extends KerrConstants {
  /** Central mass, kilograms. */
  readonly centralMass: number;
  /** Signed dimensionless spin a in [-1, 1]. Zero gives Schwarzschild. */
  readonly spin?: number;
  /** Initial Boyer–Lindquist radius in GM/c². It must be outside the outer horizon. */
  readonly radius: number;
  /** Initial polar angle in radians from the positive spin axis. Default π/2. */
  readonly polarAngle?: number;
  /** Initial azimuth in radians. Default zero. */
  readonly azimuth?: number;
  /** Sign of the initial radial velocity, default -1 (infall). */
  readonly radialDirection?: -1 | 1;
  /** Sign of the initial polar velocity, default +1. */
  readonly polarDirection?: -1 | 1;
  /** 'massive' (default) for a timelike geodesic, or 'light' for a null tracer. */
  readonly tracer?: 'massive' | 'light';
}

/**
 * Options for the Kerr geodesic solver: its ID (default 'kerrGeodesic'), the world rate (default 0, 60 Hz) and
 * the largest phase step per RK4 substep (default 1/32).
 */
export interface KerrGeodesicOptions {
  /** Unique solver id, default 'kerrGeodesic'. */
  readonly id?: string;
  /** Preferred world rate, default 0 (60 Hz). */
  readonly rate?: RateLevel;
  /** Upper local angular/radial phase increment per RK4 substep. Default 1/32. Smaller is more accurate. */
  readonly maxPhaseStep?: number;
}

/**
 * One geodesic position: radius in metres, offset above the outer horizon in metres, polar angle, azimuth and
 * proper time in seconds.
 */
export interface KerrGeodesicSample {
  /** Radius in metres. */
  readonly radius: number;
  /** Offset above the outer horizon in metres, retained when radius rounds to the horizon. */
  readonly horizonOffset: number;
  readonly polarAngle: number;
  readonly azimuth: number;
  /** Proper time in seconds (zero on a null tracer). */
  readonly properTime: number;
}

interface Metric {
  readonly spin: number;
  readonly outer: number;
  readonly gap: number;
  readonly energy: number;
  readonly momentum: number;
  readonly k: number;
  readonly q: number;
  readonly mass2: number;
  readonly rUnit: number;
  readonly tUnit: number;
}

interface OrbitState {
  readonly metric: Metric;
  readonly host: SolverHost;
  readonly integrated: Region;
  readonly coordinates: Region;
}

function spinValue(spin: number): number {
  if (!(Math.abs(spin) <= 1)) throw accretionError('Use a dimensionless Kerr spin from -1 through 1.');
  return spin;
}

function direction(value: number): number {
  if (value !== -1 && value !== 1) throw accretionError('Use +1 or -1 for an orbit direction.');
  return value;
}

function horizon(spin: number): number {
  return 1 + Math.sqrt((1 - spin) * (1 + spin));
}

/** Equatorial circular orbit from Bardeen, Press and Teukolsky (1972), Eqs. (2.12), (2.13), (2.16). */
export function kerrCircularOrbit(radius: number, spin = 0, sense: -1 | 1 = 1): KerrCircularOrbit {
  spinValue(spin);
  direction(sense);
  if (!(radius > horizon(spin) && Number.isFinite(radius)))
    throw accretionError('Choose a finite orbit outside the horizon.');
  const root = Math.sqrt(radius);
  const r32 = radius * root;
  const a = sense * spin;
  const radicand = r32 - 3 * root + 2 * a;
  if (!(radicand > 0 && Number.isFinite(r32 * radicand)))
    throw accretionError('Choose a radius outside the equatorial photon orbit and within numeric range.');
  const scale = Math.sqrt(r32 * radicand);
  return {
    energy: (r32 - 2 * root + a) / scale,
    axialAngularMomentum: (sense * (radius * radius - 2 * a * root + spin * spin)) / scale,
    carterConstant: 0,
    angularVelocity: sense / (r32 + a),
  };
}

/** Equatorial innermost stable circular orbit, in GM/c². Direction is relative to positive azimuth. */
export function kerrIsco(spin = 0, sense: -1 | 1 = 1): number {
  spinValue(spin);
  direction(sense);
  const root = (x: number) => (x === 0 ? 0 : pow(x, 1 / 3));
  const z1 = 1 + root((1 - spin) * (1 + spin)) * (root(1 + spin) + root(1 - spin));
  const z2 = Math.sqrt(3 * spin * spin + z1 * z1);
  return 3 + z2 - Math.sign(spin * sense) * Math.sqrt(Math.max(0, 3 - z1) * (3 + z1 + 2 * z2));
}

function metric(params: KerrGeodesicParams): Metric {
  const spin = spinValue(params.spin ?? 0);
  const { centralMass, energy, axialAngularMomentum: momentum, carterConstant: q = 0, tracer = 'massive' } = params;
  if (tracer !== 'massive' && tracer !== 'light')
    throw accretionError('Use a massive or light tracer for the Kerr orbit.');
  const rUnit = (G / (C * C)) * centralMass;
  const tUnit = rUnit / C;
  if (!(tUnit > 0 && Number.isFinite(rUnit) && Number.isFinite(energy * energy + momentum * momentum + Math.abs(q))))
    throw accretionError('Use a positive central mass and finite geometrized constants for the geodesic.');
  const outer = horizon(spin);
  return {
    spin,
    outer,
    gap: 2 * (outer - 1),
    energy,
    momentum,
    q,
    k: momentum - spin * energy,
    mass2: tracer === 'massive' ? 1 : 0,
    rUnit,
    tUnit,
  };
}

function roots(m: Metric, radius: number, theta: number): readonly [number, number] {
  const a = m.spin;
  const r2 = radius * radius;
  const height = radius - m.outer;
  const delta = height * (height + m.gap);
  const p = m.energy * r2 - a * m.k;
  const sine = sin(theta);
  const cosine = theta === EQUATOR ? 0 : cos(theta);
  if (m.momentum !== 0 && sine === 0)
    throw accretionError('Choose a starting angle away from the axis when axial angular momentum is nonzero.');
  const radialFirst = p * p;
  const radialSecond = delta * (m.mass2 * r2 + m.k * m.k + m.q);
  const azimuth = m.momentum === 0 ? 0 : m.momentum / sine;
  const polarSecond = cosine * cosine * (a * a * (m.mass2 - m.energy * m.energy) + azimuth * azimuth);
  return [rootDifference(radialFirst, radialSecond), rootDifference(m.q, polarSecond)];
}

function rootDifference(a: number, b: number): number {
  const square = a - b;
  const noise = 16 * Number.EPSILON * (Math.abs(a) + Math.abs(b));
  if (!(square >= -noise && Number.isFinite(noise)))
    throw accretionError(
      'The starting point is outside the allowed Kerr potential. Set compatible energy and angular momentum.',
    );
  return square <= noise ? 0 : Math.sqrt(square);
}

// State in geometric units: log(r-r+), polar angle, azimuth, Mino radial and polar velocities, proper time.
function derivative(m: Metric, s: Six): Six {
  const z = exp(s[0]);
  const r = m.outer + z;
  const r2 = r * r;
  const a = m.spin;
  const delta = z * (z + m.gap);
  const p = m.energy * r2 - a * m.k;
  const sine = sin(s[1]);
  const cosine = s[1] === EQUATOR ? 0 : cos(s[1]);
  const sine2 = sine * sine;
  const azimuth = m.momentum === 0 ? 0 : m.momentum / sine2;
  // Delta * dt/dlambda and its reciprocal factors. The log-radius removes the remaining horizon denominator.
  const time = (r2 + a * a) * p + a * (m.momentum - a * m.energy * sine2) * delta;
  if (!(time > 0 && Number.isFinite(time)))
    throw accretionError('Choose a future-directed orbit within the exterior coordinate range.');
  const lapse = delta / time;
  const radial = 2 * r * m.energy * p - (r - 1) * (m.mass2 * r2 + m.k * m.k + m.q) - delta * m.mass2 * r;
  const polar =
    cosine * (a * a * (m.mass2 - m.energy * m.energy) * sine + (azimuth === 0 ? 0 : (azimuth * m.momentum) / sine));
  return [
    ((z + m.gap) * s[3]) / time,
    s[4] * lapse,
    (a * p + (azimuth - a * m.energy) * delta) / time,
    radial * lapse,
    polar * lapse,
    m.mass2 * (r2 + a * a * cosine * cosine) * lapse,
  ];
}

function shifted(v: Six, d: Six, h: number): Six {
  return [v[0] + h * d[0], v[1] + h * d[1], v[2] + h * d[2], v[3] + h * d[3], v[4] + h * d[4], v[5] + h * d[5]];
}

function rk4(metric: Metric, s: Six, h: number): Six {
  const a = derivative(metric, s);
  const b = derivative(metric, shifted(s, a, h * 0.5));
  const c = derivative(metric, shifted(s, b, h * 0.5));
  const d = derivative(metric, shifted(s, c, h));
  return s.map((value, i) => value + (h / 6) * (a[i]! + 2 * (b[i]! + c[i]!) + d[i]!)) as unknown as Six;
}

function words(s: OrbitState, r: Region): Float64Array {
  return regionWords(s.host.memory, r) as Float64Array;
}

function write(s: OrbitState, integrated: Six): void {
  const m = s.metric;
  const offset = exp(integrated[0]);
  const radius = (m.outer + offset) * m.rUnit;
  const proper = integrated[5] * m.tUnit;
  if (!integrated.every(Number.isFinite) || !Number.isFinite(radius + proper))
    throw accretionError(
      'The Kerr orbit exceeded its numeric range. Use a shorter step or consider intermediate initial data.',
    );
  words(s, s.integrated).set(integrated);
  words(s, s.coordinates).set([radius, integrated[1], integrated[2], proper, offset * m.rUnit]);
}

/** A replayable massive or light test trajectory in Schwarzschild or Kerr spacetime. */
export class KerrGeodesicSolver implements Solver<KerrGeodesicParams> {
  readonly id: string;
  /** Layout-1 f64: radius m, polar/azimuth rad, proper time s, horizon offset m. */
  readonly coordinatesField: FieldDescriptor;
  readonly #rate: RateLevel;
  readonly #maxPhase: number;
  #state?: OrbitState;

  constructor({ id = 'kerrGeodesic', rate = 0, maxPhaseStep = 1 / 32 }: KerrGeodesicOptions = {}) {
    if (!id || !isRateLevel(rate) || !(maxPhaseStep > 0 && Number.isFinite(maxPhaseStep)))
      throw accretionError('Use a nonempty Kerr id, a valid rate level and a positive finite phase increment.');
    this.id = id;
    this.#rate = rate;
    this.#maxPhase = maxPhaseStep;
    this.coordinatesField = {
      name: `${id}:coordinates`,
      kind: 'scalarSeries',
      quantity: 'relativisticCoordinates',
      unit: 'm rad s',
      centring: 'particle',
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.#rate,
      stableRate: () => this.#rate,
      fields: [{ field: this.coordinatesField, access: 'write' }],
    };
  }

  init(host: SolverHost, params: KerrGeodesicParams): void {
    if (this.#state) throw accretionError('Create a new Kerr geodesic solver for a second world.', 'attached');
    const m = metric(params);
    const { radius, polarAngle = EQUATOR, azimuth = 0, radialDirection = -1, polarDirection = 1 } = params;
    if (!(radius > m.outer && Number.isFinite(radius + Math.abs(polarAngle) + Math.abs(azimuth))))
      throw accretionError('Start at a finite exterior radius and provide finite polar and azimuth angles.');
    const [radial, polar] = roots(m, radius, polarAngle);
    const initial: Six = [
      ln(radius - m.outer),
      polarAngle,
      azimuth,
      direction(radialDirection) * radial,
      direction(polarDirection) * polar,
      0,
    ];
    derivative(m, initial);
    const state: OrbitState = {
      host,
      metric: m,
      integrated: host.allocate('geodesic-integration', 6 * WORD, 'f64', LAYOUT),
      coordinates: host.allocate('geodesic-coordinates', 5 * WORD, 'f64', LAYOUT),
    };
    write(state, initial);
    this.#state = state;
  }

  step(_context: StepContext, dt: number): void {
    const s = this.#live();
    if (!(dt >= 0 && Number.isFinite(dt))) throw accretionError('Pass a finite, nonnegative Kerr step duration.');
    let state = Array.from(words(s, s.integrated)) as unknown as Six;
    const m = s.metric;
    const at = derivative(m, state);
    const r = m.outer + exp(state[0]);
    const phaseRate = Math.max(Math.abs(at[0]), Math.abs(at[1]), Math.abs(at[2]), 1 / (r * Math.sqrt(r)));
    const seconds = dt / m.tUnit;
    let divisions = 1;
    while ((seconds / divisions) * phaseRate > this.#maxPhase) {
      if (divisions === MAX_GEODESIC_SUBSTEPS)
        throw accretionError(
          'This observer step cannot resolve the orbit. Shorten the step or use a faster world rate.',
        );
      divisions *= 2;
    }
    const step = seconds / divisions;
    for (let piece = 0; piece < divisions; piece++) state = rk4(m, state, step);
    write(s, state);
  }

  sample(): KerrGeodesicSample {
    const s = this.#live();
    const v = words(s, s.coordinates);
    return { radius: v[0]!, polarAngle: v[1]!, azimuth: v[2]!, properTime: v[3]!, horizonOffset: v[4]! };
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.#live();
    return [{ field: this.coordinatesField.name, region: s.coordinates, tick, cell: s.host.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const s = this.#live();
    return [s.integrated, s.coordinates];
  }

  extraState(): readonly Region[] {
    return [];
  }

  #live(): OrbitState {
    if (!this.#state) throw accretionError('Add the Kerr geodesic solver to a PhysicsWorld before reading it.');
    return this.#state;
  }
}
