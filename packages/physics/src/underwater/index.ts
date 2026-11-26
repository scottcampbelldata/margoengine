import { MargoError } from '@margoengine/math/errors';
import type {
  FieldDescriptor,
  FieldUse,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { layerSpeed, prepareProfile, PROFILE_WORDS, type SoundSpeedKnot, soundLayer } from './profile.js';
import {
  acousticBeamPressure,
  type AcousticRayOptions,
  type AcousticRaySample,
  advanceRay,
  initializeRay,
  sampleRay,
  TRACE_WORDS,
} from './trace.js';

export type { SoundSpeedKnot } from './profile.js';
export {
  acousticBeamPressure,
  type AcousticPressure,
  type AcousticRayOptions,
  type AcousticRaySample,
} from './trace.js';

/** Version of the underwater acoustic ports, each using f64 rows. */
export const ACOUSTIC_FIELD_LAYOUT = 1;

/** One sound-speed profile, its boundaries and launch directions. */
export interface UnderwaterAcousticsOptions {
  /** Speed in m/s versus metres below the surface. Defaults to 1500 m/s from 0 to 100 metres. */
  readonly profile?: readonly SoundSpeedKnot[];
  /** Initial rays and Gaussian beams in port row order. Defaults to one horizontal ray at mid-depth. */
  readonly rays?: readonly AcousticRayOptions[];
  /** Signed pressure factor per flat surface reflection, from -1 to 1. Defaults to -1 for a pressure-release surface. */
  readonly surfaceReflection?: number;
  /** Signed pressure factor per flat bottom reflection, from -1 to 1. Defaults to 0.8. */
  readonly bottomReflection?: number;
  /** Pressure attenuation of the water in dB/km. Defaults to 0. */
  readonly absorption?: number;
}

/** Solver ID and registry field-name prefix. */
export interface UnderwaterAcousticsSolverOptions {
  /** Unique ID, also used to form the port names. Defaults to 'underwater-acoustics'. */
  readonly id?: string;
}

const DEFAULT_PROFILE: readonly SoundSpeedKnot[] = [
  { depth: 0, speed: 1500 },
  { depth: 100, speed: 1500 },
];
const CENTRE = [0, 0, 0] as const;
const F64_BYTES = Float64Array.BYTES_PER_ELEMENT;
const PATH_WORDS = 4;
const SIGNAL_WORDS = 2;
const OUTPUT_WORDS = PATH_WORDS + SIGNAL_WORDS + 1;

interface AcousticState {
  readonly memory: WebAssembly.Memory;
  readonly n: number;
  readonly settings: Region;
  readonly profile: Region;
  readonly rays: Region;
  readonly scratch: Region;
  readonly path: Region;
  readonly signal: Region;
  readonly delay: Region;
  readonly regions: readonly Region[];
}

function words(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64_BYTES);
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, kind: 'scalarSeries', quantity, unit, centring: 'cell' });
}

function reflection(value: number): number {
  if (!(value >= -1 && value <= 1))
    throw new RangeError('Invalid acoustic reflection coefficient; pass a signed pressure ratio from -1 to 1.');
  return value;
}

/** A 60 Hz ray and Gaussian-beam model for sound propagating through a layered water column. */
export class UnderwaterAcousticsSolver implements Solver<UnderwaterAcousticsOptions> {
  readonly #id: string;
  #data: AcousticState | undefined;

  /** One f64 row per ray: range, depth, integrated path length and beam width, in metres. */
  readonly pathField: FieldDescriptor;
  /** One f64 row per ray: real and imaginary axis pressure in Pa. */
  readonly signalField: FieldDescriptor;
  /** One f64 value per ray: travel time in seconds. */
  readonly delayField: FieldDescriptor;

  constructor(options: UnderwaterAcousticsSolverOptions = {}) {
    this.#id = options.id ?? 'underwater-acoustics';
    if (typeof this.#id !== 'string' || this.#id.trim() === '' || this.#id.trim() !== this.#id)
      throw new RangeError('Invalid underwater acoustics ID; pass a nonempty ID without outer whitespace.');
    this.pathField = field(this.#id + '.path', 'length', 'm');
    this.signalField = field(this.#id + '.signal', 'pressure', 'Pa');
    this.delayField = field(this.#id + '.delay', 'time', 's');
  }

  /** Describes the path, pressure and delay fields at a dyadic 60 Hz. */
  describe(): SolverDescription {
    const fields: FieldUse[] = [this.pathField, this.signalField, this.delayField].map((output) => ({
      field: output,
      access: 'write',
    }));
    return { id: this.#id, fields, rate: 0, stableRate: () => 0 };
  }

  /** Validates and copies the profile and launch conditions into world memory. */
  init(host: SolverHost, options: UnderwaterAcousticsOptions = {}): void {
    if (this.#data)
      throw new MargoError(
        'attached',
        'Underwater acoustics is already attached; create a fresh solver for a new world.',
      );
    const packed = prepareProfile(options.profile ?? DEFAULT_PROFILE);
    const launches = options.rays ?? [{}];
    if (!Array.isArray(launches) || launches.length === 0)
      throw new RangeError('No acoustic rays are configured; pass at least one launch condition.');
    const rows = launches.map((launch) => initializeRay(packed, launch));
    const surface = reflection(options.surfaceReflection ?? -1);
    const bottom = reflection(options.bottomReflection ?? 0.8);
    const absorption = options.absorption ?? 0;
    if (!(absorption >= 0 && Number.isFinite(absorption)))
      throw new RangeError('Invalid acoustic absorption; pass a finite nonnegative loss in dB/km.');
    const n = rows.length;
    const allocate = (name: string, count: number) =>
      host.allocate(name, count * F64_BYTES, 'f64', ACOUSTIC_FIELD_LAYOUT);
    const settings = allocate('acoustic-settings', 3);
    const profile = allocate('acoustic-profile', packed.length);
    const rays = allocate('acoustic-rays', n * TRACE_WORDS);
    const path = allocate('acoustic-path', n * PATH_WORDS);
    const signal = allocate('acoustic-signal', n * SIGNAL_WORDS);
    const delay = allocate('acoustic-delay', n);
    const scratch = allocate('acoustic-scratch', n * (TRACE_WORDS + OUTPUT_WORDS));
    words(host.memory, settings).set([surface, bottom, absorption]);
    words(host.memory, profile).set(packed);
    const initial = words(host.memory, rays);
    for (let i = 0; i < n; i++) initial.set(rows[i]!, i * TRACE_WORDS);
    const data = {
      memory: host.memory,
      n,
      settings,
      profile,
      rays,
      scratch,
      path,
      signal,
      delay,
      regions: [settings, profile, rays, path, signal, delay],
    };
    this.#publish(data, packed, initial, absorption);
    this.#data = data;
  }

  /** Traces boundary crossings and advances wavefront curvature and width by one world step. */
  step(_context: StepContext, dt: number): void {
    const data = this.#state();
    const { memory, n, settings, profile, rays, scratch } = data;
    const [surface, bottom, absorption] = words(memory, settings);
    const layers = words(memory, profile);
    const state = words(memory, rays);
    const next = words(memory, scratch).subarray(0, n * TRACE_WORDS);
    next.set(state);
    for (let i = 0; i < n; i++) advanceRay(layers, next, i * TRACE_WORDS, dt, surface!, bottom!);
    if (!next.every(Number.isFinite))
      throw new RangeError(
        'Acoustic trace exceeds numeric range; reduce the profile gradient or use a shorter interval.',
      );
    this.#publish(data, layers, next, absorption!);
    state.set(next);
  }

  /** The acoustic ports are output-only and have no incoming accumulators. */
  importPorts(_tick: number): void {}

  /** Publishes the f64 path, pressure and travel time regions. */
  exportPorts(tick: number): readonly Port[] {
    const { path, signal, delay } = this.#state();
    return [
      { field: this.pathField.name, region: path, tick, cell: CENTRE },
      { field: this.signalField.name, region: signal, tick, cell: CENTRE },
      { field: this.delayField.name, region: delay, tick, cell: CENTRE },
    ];
  }

  /** All physical and exported state is included in the world's snapshot. */
  stateRegions(): readonly Region[] {
    return this.#state().regions;
  }

  /** The beam's phase and launch parameters are stored in its ray region. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Current central ray and Gaussian beam, indexed by the launch array. */
  sample(ray: number): AcousticRaySample {
    const { memory, rays, profile, settings, n } = this.#state();
    if (!Number.isInteger(ray) || ray < 0 || ray >= n)
      throw new RangeError(`Acoustic ray index is out of range; pass an integer from 0 to ${n - 1}.`);
    return sampleRay(words(memory, profile), words(memory, rays), ray * TRACE_WORDS, words(memory, settings)[2]!);
  }

  /** Reads the piecewise-linear sound speed in m/s at a depth in metres. */
  soundSpeed(depth: number): number {
    const { memory, profile } = this.#state();
    const data = words(memory, profile);
    return layerSpeed(data, soundLayer(data, depth, true) * PROFILE_WORDS, depth);
  }

  #publish(data: AcousticState, layers: Float64Array, rays: Float64Array, absorption: number): void {
    const output = words(data.memory, data.scratch).subarray(data.n * TRACE_WORDS);
    const signalStart = data.n * PATH_WORDS;
    const delaysStart = signalStart + data.n * SIGNAL_WORDS;
    for (let i = 0; i < data.n; i++) {
      const sample = sampleRay(layers, rays, i * TRACE_WORDS, absorption);
      const pressure = acousticBeamPressure(sample, 0);
      if (!Number.isFinite(sample.curvature) || !(sample.width > 0))
        throw new RangeError(
          'Acoustic beam width or curvature exceeds numeric range; adjust launch frequency or beam waist.',
        );
      output.set([sample.range, sample.depth, sample.pathLength, sample.width], PATH_WORDS * i);
      output.set([pressure.real, pressure.imaginary], signalStart + SIGNAL_WORDS * i);
      output[delaysStart + i] = sample.travelTime;
    }
    if (!output.every(Number.isFinite))
      throw new RangeError('Acoustic output exceeds numeric range; reduce launch pressure or frequency.');
    words(data.memory, data.path).set(output.subarray(0, signalStart));
    words(data.memory, data.signal).set(output.subarray(signalStart, delaysStart));
    words(data.memory, data.delay).set(output.subarray(delaysStart));
  }

  #state(): AcousticState {
    if (!this.#data)
      throw new MargoError('state', 'Underwater acoustics has no world; add the solver to a PhysicsWorld first.');
    return this.#data;
  }
}
