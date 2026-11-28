import { MargoError } from '@margoengine/math/errors';
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { BASE_RATE, RATE_LEVELS } from './world/solver.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  RateLevel,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from './world/solver.js';
import {
  MODEL_WORDS,
  modeValues,
  PLANT_IMPULSE_WORDS,
  PLANT_SWAY_WORDS,
  type PlantSwayPlant,
  preparePlant,
  SECTIONS,
  SECTION_WORDS,
  STATIONS,
  STATION_WORDS,
  stemModes,
} from './vegetation/model.js';
import { PlantSwayPhase, type PlantSwayWorkCounts } from './vegetation/phase.js';

export type { PlantSwayWorkerWork, PlantSwayWorkCounts } from './vegetation/phase.js';
export { PLANT_IMPULSE_WORDS, PLANT_SWAY_WORDS, type PlantSwayPlant } from './vegetation/model.js';
export {
  PlantRigidSolver,
  type PlantRigidBinding,
  type PlantRigidOptions,
  type PlantRigidFragment,
} from './vegetation/rigid.js';

/** Configuration of the optional kernel and port names. */
export interface PlantSwayLoadOptions {
  /** Solver ID and field name prefix. Defaults to 'plant-sway'. */
  readonly id?: string;
  /** Number of native partitions including the caller. Defaults to one. */
  readonly threads?: number;
  /** Cancels the kernel load. */
  readonly signal?: AbortSignal;
}
/** Plant setup. Array order defines the indexing of every port. */
export interface PlantSwayOptions {
  /** Rooted plants in port order. */
  readonly plants: readonly PlantSwayPlant[];
  /** Air or water sampled in its origin cell. Omit it for free mechanical response in still vacuum. */
  readonly flow?: FlowField;
  /** Side of each world origin cell in metres. Defaults to 4096. */
  readonly cellSize?: number;
}
/** Continuous small-angle pose at a point on a plant above its root. */
export interface PlantSwaySample {
  /** Horizontal x/z deflection in metres. */
  readonly displacement: readonly [number, number];
  /** Horizontal x/z velocity in m/s. */
  readonly velocity: readonly [number, number];
  /** x/z derivatives of displacement with respect to height, dimensionless. */
  readonly slope: readonly [number, number];
}

interface State {
  readonly host: SolverHost;
  readonly count: number;
  readonly flow: FlowField | undefined;
  readonly cellSize: number;
  readonly modes: ReturnType<typeof stemModes>;
  readonly settings: Region;
  readonly roots: Region;
  readonly models: Region;
  readonly stationGeometry: Region;
  readonly sections: Region;
  readonly frequencies: Region;
  readonly sway: Region;
  readonly zeroImpulse: Region;
  readonly work: Region;
  readonly samples: Region;
  readonly sampleScratch: Float64Array;
  readonly regions: readonly Region[];
}

const SAMPLE_WORDS = 5;
const LAYOUT = 1;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const PHASE_STEP = 0.34641016151377546; // sqrt(0.12)

function words(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64);
}

function checkFlow(flow: FlowField | undefined): void {
  if (flow === undefined) return;
  if (
    !flow ||
    (flow.medium !== 'air' && flow.medium !== 'water') ||
    typeof flow.sample !== 'function' ||
    flow.cell?.length !== 3 ||
    !Array.from(flow.cell).every((axis) => Number.isInteger(axis) && axis >= -2147483648 && axis <= 2147483647)
  )
    throw new MargoError(
      'state',
      'PlantSway flow is invalid; provide an air or water FlowField with a signed origin cell.',
    );
}

function checkSample(sample: FlowSample): void {
  if (
    !sample ||
    !sample.velocity ||
    !Number.isFinite(sample.velocity[0]) ||
    !Number.isFinite(sample.velocity[1]) ||
    !Number.isFinite(sample.velocity[2]) ||
    !Number.isFinite(sample.density) ||
    sample.density < 0
  )
    throw new MargoError('state', 'PlantSway flow sample is invalid; return finite velocity and nonnegative density.');
}

/**
 * Two small-angle transverse modes of tapered rooted plants, driven by a world-clock FlowField.
 * Add a loaded solver to PhysicsWorld. Failed plants retain the state of the failure for a rigid-body consumer.
 */
export class PlantSway implements Solver<PlantSwayOptions> {
  /** Solver ID and field name prefix. */
  readonly id: string;
  /** f64 records [q0x,q0z,q1x,q1z,v0x,v0z,v1x,v1z,peakRatio,status,failureHeight,rootMoment,failureTick]. */
  readonly swayField: FieldDescriptor;
  /** Generalized modal impulse contributions [first x,z, second x,z] in N s, in plant order. */
  readonly impulseField: FieldDescriptor;
  readonly #phase: PlantSwayPhase;
  #acceptedWork: PlantSwayWorkCounts;
  #disposed = false;
  #data: State | undefined;
  #impulse: Region | undefined;

  private constructor(id: string, phase: PlantSwayPhase) {
    this.id = id;
    this.#phase = phase;
    this.#acceptedWork = phase.workCounts();
    this.impulseField = Object.freeze({
      name: id + '/impulses',
      kind: 'particleSet',
      quantity: 'impulse',
      unit: 'N s',
      centring: 'particle',
    });
    this.swayField = Object.freeze({
      name: id + '/sway',
      kind: 'particleSet',
      quantity: 'plantSway',
      unit: 'm, m/s, N m, 1',
      centring: 'particle',
    });
  }

  /** Loads the optional vegetation Wasm without mutating a world. */
  static async load(options: PlantSwayLoadOptions = {}): Promise<PlantSway> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new MargoError('state', 'Plant load options must be an object. Pass PlantSwayLoadOptions or omit it.');
    const id = options.id ?? 'plant-sway';
    if (typeof id !== 'string' || id.trim() === '' || id.trim() !== id)
      throw new MargoError('state', 'PlantSway solver ID is invalid; pass a nonempty ID without outer whitespace.');
    return new PlantSway(id, await PlantSwayPhase.load(options));
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#phase[Symbol.dispose]();
  }

  /** Actual native work performed for the last accepted tick. */
  workCounts(): PlantSwayWorkCounts {
    const work = this.#acceptedWork;
    return { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  /** Describes the modal fields and rate derived from the highest dry natural frequency. */
  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: this.swayField, access: 'write' },
        { field: this.impulseField, access: 'write' },
      ],
      rate: 0,
      stableRate: () => {
        const data = this.#data;
        return data ? (words(data.host.memory, data.settings)[0] as RateLevel) : 0;
      },
    };
  }

  /** Allocates the modal matrices, quadrature stations, inputs and output port in the arena. */
  init(host: SolverHost, options: PlantSwayOptions): void {
    if (this.#disposed) throw new MargoError('disposed', 'PlantSway is disposed. Load a fresh solver to add plants.');
    if (this.#data)
      throw new MargoError('attached', 'PlantSway is already attached; load a fresh solver for a second world.');
    if (!options || !Array.isArray(options.plants))
      throw new MargoError(
        'state',
        'PlantSway needs an ordered list of plants. Pass a plants array in the world options.',
      );
    const count = options.plants.length;
    const cellSize = options.cellSize ?? 4096;
    if (!(cellSize > 0 && Number.isFinite(cellSize)))
      throw new MargoError(
        'state',
        'Plant origin cells need a finite positive size. Pass the PhysicsWorld cell size in metres.',
      );
    // Includes owned state, work arrays and both registry mirrors of the two ports.
    const perPlant =
      3 +
      MODEL_WORDS +
      STATIONS * (STATION_WORDS + SAMPLE_WORDS) +
      SECTIONS * SECTION_WORDS +
      2 +
      4 * PLANT_SWAY_WORDS +
      3 * PLANT_IMPULSE_WORDS;
    if (count === 0 || !Number.isSafeInteger(count) || count * perPlant * F64 > 0xffffffff)
      throw new MargoError(
        'state',
        'PlantSway cannot allocate that many plants; supply a nonempty list that fits the Wasm arena.',
      );
    const flow = options.flow;
    checkFlow(flow);
    const modes = stemModes();
    const prepared = Array.from(options.plants, (plant) => preparePlant(plant, modes, flow?.medium === 'water'));
    this.#phase.bind(host);
    const allocate = (name: string, length: number) => host.allocate(name, F64 * length, 'f64', LAYOUT);
    const settings = allocate('plant-motion-settings-' + count, 1);
    const roots = allocate('plant-roots', count * 3);
    const models = allocate('plant-model', count * MODEL_WORDS);
    const stationGeometry = allocate('plant-force-stations', count * STATIONS * STATION_WORDS);
    const sections = allocate('plant-failure-sections', count * SECTIONS * SECTION_WORDS);
    const frequencies = allocate('plant-dry-frequencies', count * 2);
    const sway = allocate('plant-sway', count * PLANT_SWAY_WORDS);
    const zeroImpulse = allocate('plant-unforced', count * PLANT_IMPULSE_WORDS);
    const work = allocate('plant-sway-work', count * PLANT_SWAY_WORDS);
    const samples = allocate('plant-flow-samples', count * STATIONS * SAMPLE_WORDS);
    const rootsWords = words(host.memory, roots);
    const modelWords = words(host.memory, models);
    const stationWords = words(host.memory, stationGeometry);
    const sectionWords = words(host.memory, sections);
    const frequencyWords = words(host.memory, frequencies);
    const swayWords = words(host.memory, sway);
    let maximum = 0;
    for (let i = 0; i < count; i++) {
      const plant = prepared[i]!;
      rootsWords.set(plant.root, i * 3);
      modelWords.set(plant.model, i * MODEL_WORDS);
      stationWords.set(plant.stations, i * STATIONS * STATION_WORDS);
      sectionWords.set(plant.sections, i * SECTIONS * SECTION_WORDS);
      frequencyWords.set(plant.angular, i * 2);
      swayWords.set(plant.initial, i * PLANT_SWAY_WORDS);
      swayWords[i * PLANT_SWAY_WORDS + 12] = -1;
      maximum = Math.max(maximum, plant.angular[1]);
    }
    let level = 0;
    while (level + 1 < RATE_LEVELS && maximum > BASE_RATE * (1 << level) * PHASE_STEP) level++;
    words(host.memory, settings)[0] = level;
    this.#data = {
      host,
      count,
      flow,
      cellSize,
      modes,
      settings,
      roots,
      models,
      stationGeometry,
      sections,
      frequencies,
      sway,
      zeroImpulse,
      work,
      samples,
      sampleScratch: new Float64Array(count * STATIONS * SAMPLE_WORDS),
      regions: [settings, roots, models, stationGeometry, sections, frequencies, sway, zeroImpulse],
    };
  }

  /** Reads the world registry's accumulated generalized impulse for this tick. */
  importPorts(_tick: number): void {
    const data = this.#state();
    const source = data.host.port(this.impulseField.name)?.region;
    if (
      source &&
      (source.type !== 'f64' ||
        source.layout !== LAYOUT ||
        source.byteLength !== data.count * PLANT_IMPULSE_WORDS * F64)
    )
      throw new MargoError(
        'state',
        'Plant impulse layout does not match the plant set; publish four f64 impulse values per plant.',
      );
    this.#impulse = source;
  }

  /** Samples the flow at the dyadic clock, then solves mass, stiffness and drag together. */
  step(context: StepContext, dt: number): void {
    const data = this.#state();
    if (!Number.isFinite(dt) || dt <= 0)
      throw new MargoError('state', 'PlantSway step duration is invalid. You must advance with a finite positive world step.');
    const source = this.#impulse;
    this.#impulse = undefined;
    if (data.flow) this.#sample(data, data.flow, context, dt);
    const status = this.#phase.apply(
      data.models.byteOffset,
      data.stationGeometry.byteOffset,
      data.sections.byteOffset,
      data.samples.byteOffset,
      data.sway.byteOffset,
      data.work.byteOffset,
      source?.byteOffset ?? 0,
      data.count,
      dt,
      data.flow?.medium === 'water' ? -data.host.gravity[1] : 0,
      context.tick,
    );
    if (status === 1)
      throw new MargoError(
        'failed',
        'The upright plant has nonpositive modal mass or stiffness; check material, buoyancy and preload.',
      );
    if (status !== 0)
      throw new MargoError(
        'failed',
        'Plant motion exceeds the numeric range; check flow values, impulses and physical scales.',
      );
    const work = this.#phase.workCounts();
    words(data.host.memory, data.sway).set(words(data.host.memory, data.work));
    this.#acceptedWork = work;
  }

  /** The current origin of plant roots and their published fields, in signed world cells. */
  get cell(): Cell {
    return this.#state().host.cell;
  }

  /** Publishes the modal state and receives impulse contributions through the same set ordering. */
  exportPorts(tick: number): readonly Port[] {
    const data = this.#state();
    return [
      { field: this.swayField.name, region: data.sway, tick, cell: data.host.cell },
      { field: this.impulseField.name, region: data.zeroImpulse, tick, cell: data.host.cell },
    ];
  }

  /** Persistent geometry, modal state and field backing used by snapshot and replay. */
  stateRegions(): readonly Region[] {
    return this.#state().regions;
  }

  /** The current displacement and velocity carry all integration history. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Copies sway records in plant order. Status 0 is standing, 1 is snapped and 2 is uprooted. */
  readSway(): Float64Array {
    const data = this.#state();
    return words(data.host.memory, data.sway).slice();
  }

  /** Returns the two dry natural frequencies in Hz, excluding added mass and buoyancy. */
  dryFrequencies(plant: number): readonly [number, number] {
    const data = this.#plant(plant);
    const frequencies = words(data.host.memory, data.frequencies);
    return [frequencies[2 * plant]! / (2 * Math.PI), frequencies[2 * plant + 1]! / (2 * Math.PI)];
  }

  /** Decomposes a horizontal impulse at height into the two modal impulse pairs. */
  projectImpulse(plant: number, height: number, x: number, z: number): readonly [number, number, number, number] {
    const data = this.#plant(plant);
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw new MargoError('state', 'Plant impulse components are invalid. Pass finite X and Z impulses in N s.');
    if (height === 0) return [0, 0, 0, 0];
    const [a, b] = this.#at(data, plant, height);
    const impulse = [a[0] * x, a[0] * z, b[0] * x, b[0] * z] as const;
    if (!impulse.every(Number.isFinite))
      throw new MargoError('state', 'Plant modal impulse exceeds the numeric range. Reduce the impulse magnitude.');
    return impulse;
  }

  /** Samples the stem deflection, velocity and slope between the root and tip. */
  sample(plant: number, height: number): PlantSwaySample {
    const data = this.#plant(plant);
    if (height === 0) return { displacement: [0, 0], velocity: [0, 0], slope: [0, 0] };
    const [a, b] = this.#at(data, plant, height);
    const s = words(data.host.memory, data.sway);
    const at = plant * PLANT_SWAY_WORDS;
    const h = words(data.host.memory, data.models)[plant * MODEL_WORDS + 9]!;
    return {
      displacement: [a[0] * s[at]! + b[0] * s[at + 2]!, a[0] * s[at + 1]! + b[0] * s[at + 3]!],
      velocity: [a[0] * s[at + 4]! + b[0] * s[at + 6]!, a[0] * s[at + 5]! + b[0] * s[at + 7]!],
      slope: [(a[1] * s[at]! + b[1] * s[at + 2]!) / h, (a[1] * s[at + 1]! + b[1] * s[at + 3]!) / h],
    };
  }

  #state(): State {
    if (this.#disposed) throw new MargoError('disposed', 'PlantSway is disposed. Load a fresh solver to add plants.');
    if (!this.#data) throw new MargoError('state', 'PlantSway has no plants; add it to a PhysicsWorld first.');
    return this.#data;
  }

  #plant(index: number): State {
    const data = this.#state();
    if (!Number.isSafeInteger(index) || index < 0 || index >= data.count)
      throw new MargoError('state', 'Plant index is outside the list; use an index passed into the world.');
    return data;
  }

  #at(data: State, plant: number, height: number) {
    const h = words(data.host.memory, data.models)[plant * MODEL_WORDS + 9]!;
    if (!Number.isFinite(height) || height < 0 || height > h)
      throw new MargoError('state', 'Plant sample height is outside the stem; use a height from zero to its tip.');
    return modeValues(data.modes, height / h);
  }

  #sample(data: State, flow: FlowField, context: StepContext, dt: number): void {
    checkFlow(flow);
    const flowCell = flow.cell;
    const offset = [0, 1, 2].map((axis) => (context.cell[axis]! - flowCell[axis]!) * data.cellSize);
    const out: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
    const start = context.tick * dt;
    const middle = start + 0.5 * dt;
    const end = start + dt;
    if (![start, middle, end].every(Number.isFinite))
      throw new MargoError('state', 'Plant flow sample time exceeds finite seconds. You must advance at the world clock rate.');
    const buffer = data.sampleScratch;
    buffer.fill(0);
    for (let i = 0; i < data.count; i++) {
      const t = i * PLANT_SWAY_WORDS;
      for (let n = 0; n < STATIONS; n++) {
        // A FlowField may be supplied by an app. No arena view survives its call.
        const states = words(data.host.memory, data.sway);
        if (states[t + 9] !== 0) break;
        const stations = words(data.host.memory, data.stationGeometry);
        const roots = words(data.host.memory, data.roots);
        const s = (i * STATIONS + n) * STATION_WORDS;
        if (stations[s + 3] === 0 && stations[s + 4] === 0 && stations[s + 5] === 0) continue;
        const a = stations[s + 1]!;
        const b = stations[s + 2]!;
        const x = roots[i * 3]! + a * states[t]! + b * states[t + 2]! + offset[0]!;
        const y = roots[i * 3 + 1]! + stations[s]! + offset[1]!;
        const z = roots[i * 3 + 2]! + a * states[t + 1]! + b * states[t + 3]! + offset[2]!;
        if (![x, y, z].every(Number.isFinite))
          throw new MargoError(
            'state',
            'Plant flow sample position exceeds the numeric range. Use local roots and finite deflections.',
          );
        const j = (i * STATIONS + n) * SAMPLE_WORDS;
        const mid = flow.sample(x, y, z, middle, out);
        checkSample(mid);
        buffer[j] = mid.velocity[0];
        buffer[j + 1] = mid.velocity[2];
        buffer[j + 4] = mid.density;
        if (mid.density === 0) continue;
        const before = flow.sample(x, y, z, start, out);
        checkSample(before);
        const [ux, , uz] = before.velocity;
        const after = flow.sample(x, y, z, end, out);
        checkSample(after);
        const ax = (after.velocity[0] - ux) / dt,
          az = (after.velocity[2] - uz) / dt;
        if (!Number.isFinite(ax) || !Number.isFinite(az))
          throw new MargoError(
            'state',
            'Plant flow acceleration exceeds finite SI units. You must return physically scaled flow velocities.',
          );
        buffer[j + 2] = ax;
        buffer[j + 3] = az;
      }
    }
    words(data.host.memory, data.samples).set(buffer);
  }
}
