import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { isShared, regionWords } from '../world/memory.js';
import {
  rateOf,
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import {
  BRAKE,
  CAR_WORDS,
  carFrequency,
  carOf,
  COUPLER,
  DISTANCE,
  DRIVE,
  initCar,
  readCar,
  SPEED,
  stepCar,
  type Car,
  type RailCarSpec,
  type RailCarState,
} from './car.js';
import { railNumber } from './contact.js';
import { bindWireKernel, loadWireKernel, type RailWireWorkCounts } from './kernel.js';
import {
  makeWire,
  readPantograph,
  readWire,
  stepWire,
  type PantographReading,
  type RailWireReading,
  type RailWireSpec,
  type Wire,
} from './wire.js';

export { railCreepForce, type RailAdhesion, type RailCreep } from './contact.js';
export {
  RailRoute,
  railRouteAtSwitches,
  type RailPoint,
  type RailSample,
  type RailSection,
  type RailStation,
} from './track.js';
export type { RailCarSpec, RailCarState, RailWheelset } from './car.js';
export type { RailWireWorkCounts, RailWireWorkerWork } from './kernel.js';
export type { PantographSpec, PantographReading, RailWireReading, RailWireSpec } from './wire.js';

/** Number of f64 words in each layout-1 car record. */
export const RAIL_CAR_WORDS = CAR_WORDS;
export const RAIL_CAR_LAYOUT = 1;

/** A sprung wagon connection with separate tension and buffer compression. */
export interface RailCoupler {
  readonly front: number;
  readonly rear: number;
  readonly restDistance: number;
  readonly slack?: number;
  readonly tensionStiffness?: number;
  readonly bufferStiffness?: number;
  readonly damping?: number;
}

export interface RailSolverOptions {
  readonly id?: string;
  /** Optional layout-1 f64 field containing relative wetness in [0, 1]. */
  readonly wetnessField?: FieldDescriptor;
  /** Native catenary participants including the caller. Defaults to 1. */
  readonly threads?: number;
}

export interface RailSolverParams {
  readonly cars: readonly RailCarSpec[];
  readonly couplers?: readonly RailCoupler[];
  readonly wire?: RailWireSpec;
}

export interface RailControls {
  /** Normalized traction torque from -1 to 1. */
  readonly drive?: number;
  /** Normalized brake torque from 0 to 1. */
  readonly brake?: number;
}

interface Running {
  readonly host: SolverHost;
  readonly cars: readonly Car[];
  readonly region: Region;
  readonly couplers: readonly Required<RailCoupler>[];
  readonly wire?: Wire;
  readonly candidateCars: Region;
  readonly candidateWire?: Region;
  readonly rate: RateLevel;
}

function makeCoupler(spec: RailCoupler, cars: readonly Car[]): Required<RailCoupler> {
  const front = cars[spec.front],
    rear = cars[spec.rear];
  if (!front || !rear || front === rear || front.track !== rear.track || front.distance <= rear.distance)
    throw new MargoError('state', 'Use a leading and trailing car on the same surveyed route for a coupler.');
  return {
    front: spec.front,
    rear: spec.rear,
    restDistance: railNumber(spec.restDistance, 'distance between coupled car centres', Number.MIN_VALUE),
    slack: railNumber(spec.slack ?? 0.03, 'coupler slack travel', 0),
    tensionStiffness: railNumber(spec.tensionStiffness ?? 450000, 'draft gear stiffness', 0),
    bufferStiffness: railNumber(spec.bufferStiffness ?? 820000, 'buffer stiffness', 0),
    damping: railNumber(spec.damping ?? 21000, 'coupler damping', 0),
  };
}

function solveCouplers(state: Running, cars: Float64Array): void {
  for (let i = 0; i < state.cars.length; i++) cars[i * CAR_WORDS + COUPLER] = 0;
  for (const spec of state.couplers) {
    const front = spec.front * CAR_WORDS,
      rear = spec.rear * CAR_WORDS;
    const gap = cars[front + DISTANCE]! - cars[rear + DISTANCE]! - spec.restDistance;
    const displacement = Math.max(0, Math.abs(gap) - spec.slack);
    if (displacement === 0) continue;
    const direction = Math.sign(gap);
    const stiffness = gap > 0 ? spec.tensionStiffness : spec.bufferStiffness;
    const velocity = cars[front + SPEED]! - cars[rear + SPEED]!;
    const force = direction * Math.max(0, stiffness * displacement + direction * spec.damping * velocity);
    cars[front + COUPLER] = cars[front + COUPLER]! - force;
    cars[rear + COUPLER] = cars[rear + COUPLER]! + force;
  }
}

function stableLevel(cars: readonly Car[], couplers: readonly Required<RailCoupler>[], wire?: Wire): RateLevel {
  let frequency = wire?.frequency ?? 0;
  for (const car of cars) frequency = Math.max(frequency, carFrequency(car));
  let coupling = 0;
  for (const spec of couplers) {
    const inverseMass = 1 / cars[spec.front]!.totalMass + 1 / cars[spec.rear]!.totalMass; // float division: relative mass
    coupling = Math.max(
      coupling,
      Math.sqrt(inverseMass * Math.max(spec.tensionStiffness, spec.bufferStiffness)),
      inverseMass * spec.damping,
    );
  }
  // Guard the explicit damping and symplectic spring update at dt * frequency <= 0.4.
  const required = 2.5 * Math.max(frequency, coupling);
  for (let level = 0; level <= 7; level++) if (rateOf(level as RateLevel) >= required) return level as RateLevel;
  throw new MargoError(
    'state',
    'Increase rail node spacing or reduce the configured stiffness to fit the world clock.',
  );
}

/** Sprung rail running gear, shared wheelset rotation, couplers and an optional tensioned overhead wire. */
export class RailSolver implements Solver<RailSolverParams> {
  readonly id: string;
  readonly carField: FieldDescriptor;
  readonly wireField: FieldDescriptor;
  private readonly weather?: FieldDescriptor;
  private readonly threads: number;
  private state?: Running;
  private compiled?: WebAssembly.Module;
  private pool?: NativePhasePool;
  private work?: RailWireWorkCounts;
  private disposed = false;

  constructor({ id, wetnessField }?: RailSolverOptions);
  constructor(options: RailSolverOptions = {}) {
    if (!options || typeof options !== 'object')
      throw new MargoError('state', 'Pass rail solver options as an object or omit them.');
    const { id = 'rail', wetnessField, threads = 1 } = options;
    if (typeof id !== 'string' || id.length === 0)
      throw new MargoError('state', 'Give the railway solver a nonempty ID.');
    if (wetnessField && (wetnessField.unit !== '1' || !wetnessField.name))
      throw new MargoError('state', 'Use a named dimensionless relative wetness field for rails.');
    if (threads !== 1 && threads !== 2 && threads !== 4)
      throw new MargoError('state', 'Use 1, 2 or 4 native catenary participants.');
    this.threads = threads;
    this.id = id;
    this.weather = wetnessField && { ...wetnessField };
    this.carField = { name: `${id}:cars`, kind: 'bodySet', quantity: 'railCarState', unit: 'SI', centring: 'particle' };
    this.wireField = {
      name: `${id}:wire`,
      kind: 'meshVertexSet',
      quantity: 'catenaryState',
      unit: 'SI',
      centring: 'vertex',
    };
  }

  /** Load the optional catenary kernel and helpers for the owning world's memory mode. */
  static async load(
    memory: WebAssembly.Memory,
    options?: RailSolverOptions,
    signal?: AbortSignal,
  ): Promise<RailSolver> {
    const solver = new RailSolver(options);
    if (!(memory instanceof WebAssembly.Memory))
      throw new MargoError('state', 'Pass the world memory from PhysicsWorld when loading the railway kernel.');
    if (solver.threads > 1 && !isShared(memory))
      throw new MargoError('unsupported', 'Use worldMemory(true) for railway workers or choose threads: 1.');
    solver.compiled = await loadWireKernel(memory, signal);
    if (solver.threads > 1) {
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.pool = await createNativePhasePool(solver.threads, {
        subject: 'Rail wire',
        phaseExport: 'rail_wire_thread_phase',
        signal,
      });
    }
    return solver;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => this.state?.rate ?? 0,
      fields: [
        { field: this.carField, access: 'write' },
        { field: this.wireField, access: 'write' },
        ...(this.weather ? [{ field: this.weather, access: 'read' as const, optional: true }] : []),
      ],
    };
  }

  init(host: SolverHost, params: RailSolverParams): void {
    if (this.disposed) throw new MargoError('disposed', 'Railway solver is disposed. Load a new solver.');
    if (this.state && this.pool)
      throw new MargoError('attached', 'Catenary workers are already bound. Load a new solver for the other world.');
    if (!Array.isArray(params?.cars) || !params.cars.length)
      throw new MargoError('state', 'Provide at least one railway car in an array.');
    if (params.wire && !this.compiled)
      throw new MargoError('state', 'Use RailSolver.load(world.memory) to simulate a contact wire.');
    if (this.threads > 1 && !params.wire)
      throw new MargoError('state', 'Configure a catenary to use railway workers or choose threads: 1.');
    const cars = params.cars.map((spec) => carOf(spec, host.gravity));
    const couplers = params.couplers?.map((spec) => makeCoupler(spec, cars)) ?? [];
    const all = new Set<string>();
    for (const { front, rear } of couplers) {
      const pair = `${front}:${rear}`;
      if (all.has(pair)) throw new MargoError('state', 'Use one coupler for each car connection.');
      all.add(pair);
    }
    const region = host.allocate(
      'cars',
      cars.length * CAR_WORDS * Float64Array.BYTES_PER_ELEMENT,
      'f64',
      RAIL_CAR_LAYOUT,
    );
    try {
      const wire = params.wire && makeWire(host, params.wire, cars, bindWireKernel(host, this.compiled!, this.pool));
      const rate = stableLevel(cars, couplers, wire);
      const candidateCars = host.allocate('candidate-cars', region.byteLength, 'f64', RAIL_CAR_LAYOUT);
      const candidateWire = wire && host.allocate('candidate-wire', wire.region.byteLength, 'f64', wire.region.layout);
      const state = { host, cars, couplers, region, wire, rate, candidateCars, candidateWire };
      const table = this.table(state);
      for (let i = 0; i < cars.length; i++) initCar(this.carRow(table, i), cars[i]!);
      this.work = undefined;
      this.state = state;
    } catch (cause) {
      if (this.pool) this.dispose();
      throw cause;
    }
  }

  step(context: StepContext, dt: number): void {
    const state = this.running();
    const { host, cars, wire, candidateCars, candidateWire } = state;
    if (!(dt > 0 && dt <= 1 / rateOf(state.rate)))
      throw new MargoError('state', 'Railway interval is outside the stable range. Step it on the PhysicsWorld clock.');
    const source = this.weather && context.inputs.get(this.weather.name);
    if (source && (source.region.type !== 'f64' || source.region.layout !== 1))
      throw new MargoError('state', 'Use a layout-1 f64 relative wetness port for rail adhesion.');
    const water = source ? (regionWords(host.memory, source.region) as Float64Array) : undefined;
    if (water) for (const car of cars) railNumber(water[car.wetnessWord]!, 'published rail wetness', 0, 1);
    const accepted = this.table(state);
    const table = regionWords(host.memory, candidateCars) as Float64Array;
    table.set(accepted);
    solveCouplers(state, table);
    let work: RailWireWorkCounts | undefined;
    const acceptedWire = wire && (regionWords(host.memory, wire.region) as Float64Array);
    const stagedWire = candidateWire && (regionWords(host.memory, candidateWire) as Float64Array);
    if (wire && stagedWire && acceptedWire) {
      stagedWire.set(acceptedWire);
      work = stepWire(wire, cars, candidateCars, dt, candidateWire);
    }
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      stepCar(this.carRow(table, i), car, host.gravity, water ? water[car.wetnessWord]! : car.wetness, dt);
    }
    if (!table.every(Number.isFinite) || (stagedWire && !stagedWire.every(Number.isFinite)))
      throw new MargoError('state', 'Railway forces exceed finite range. Reduce the loads, speeds or stiffness.');
    accepted.set(table);
    if (acceptedWire && stagedWire) acceptedWire.set(stagedWire);
    this.work = work;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const state = this.running();
    const cell = state.host.cell;
    const car = { field: this.carField.name, region: state.region, tick, cell };
    return state.wire ? [car, { field: this.wireField.name, region: state.wire.region, tick, cell }] : [car];
  }

  stateRegions(): readonly Region[] {
    const { region, wire } = this.running();
    return wire ? [region, wire.region] : [region];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Write held controls in snapshot memory before the next world advance. */
  setControls(index: number, { drive = 0, brake = 0 }: RailControls): void {
    const state = this.running();
    this.car(state, index);
    const torque = railNumber(drive, 'rail drive command', -1, 1);
    const braking = railNumber(brake, 'rail brake command', 0, 1);
    const row = this.carRow(this.table(state), index);
    row[DRIVE] = torque;
    row[BRAKE] = braking;
  }

  read(index: number): RailCarState {
    const state = this.running();
    return readCar(this.carRow(this.table(state), index), this.car(state, index));
  }

  readWire(arclength: number): RailWireReading {
    return readWire(this.wire(), arclength);
  }

  readPantograph(index: number): PantographReading {
    return readPantograph(this.wire(), index);
  }

  /** Work performed by the last accepted wire step computed by this instance. */
  wireWorkCounts(): RailWireWorkCounts | undefined {
    this.running();
    return this.work;
  }

  /** Releases optional catenary workers after the world's final railway step. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool?.close();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private wire(): Wire {
    const wire = this.running().wire;
    if (!wire) throw new MargoError('state', 'Configure a contact wire before reading it.');
    return wire;
  }

  private running(): Running {
    if (this.disposed) throw new MargoError('disposed', 'Railway solver is disposed. Load a new solver.');
    if (!this.state) throw new MargoError('state', 'Add the railway solver to a PhysicsWorld first.');
    return this.state;
  }

  private table({ host, region }: Running): Float64Array {
    return regionWords(host.memory, region) as Float64Array;
  }

  private carRow(table: Float64Array, index: number): Float64Array {
    return table.subarray(index * CAR_WORDS, (index + 1) * CAR_WORDS);
  }

  private car(state: Running, index: number): Car {
    const car = state.cars[index];
    if (!Number.isSafeInteger(index) || !car) throw new MargoError('state', 'Choose a configured rail car index.');
    return car;
  }
}
