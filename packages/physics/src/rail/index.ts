import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
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
import { bindWireKernel, loadWireKernel } from './kernel.js';
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
  const frequency = Math.max(...cars.map(carFrequency), wire?.frequency ?? 0);
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

const ZERO = [0, 0, 0] as const;

/** Sprung rail running gear, shared wheelset rotation, couplers and an optional tensioned overhead wire. */
export class RailSolver implements Solver<RailSolverParams> {
  readonly id: string;
  readonly carField: FieldDescriptor;
  readonly wireField: FieldDescriptor;
  private readonly weather?: FieldDescriptor;
  private state?: Running;
  private compiled?: WebAssembly.Module;

  constructor({ id = 'rail', wetnessField }: RailSolverOptions = {}) {
    if (wetnessField && wetnessField.unit !== '1')
      throw new MargoError('state', 'Use a dimensionless relative wetness field for rails.');
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

  /** Load the catenary kernel in the memory mode of the world that will own the train. */
  static async load(
    memory: WebAssembly.Memory,
    options?: RailSolverOptions,
    signal?: AbortSignal,
  ): Promise<RailSolver> {
    const solver = new RailSolver(options);
    solver.compiled = await loadWireKernel(memory, signal);
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
    if (!params.cars?.length) throw new MargoError('state', 'Provide at least one railway car.');
    if (params.wire && !this.compiled)
      throw new MargoError('state', 'Use RailSolver.load(world.memory) to simulate a contact wire.');
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
    const wire = params.wire && makeWire(host, params.wire, cars, bindWireKernel(host, this.compiled!));
    const state = { host, cars, couplers, region, wire, rate: stableLevel(cars, couplers, wire) };
    const table = this.table(state);
    for (let i = 0; i < cars.length; i++) initCar(this.carRow(table, i), cars[i]!);
    this.state = state;
  }

  step(context: StepContext, dt: number): void {
    const state = this.running();
    const table = this.table(state);
    const source = this.weather && context.inputs.get(this.weather.name);
    if (source && (source.region.type !== 'f64' || source.region.layout !== 1))
      throw new MargoError('state', 'Use a layout-1 f64 relative wetness port for rail adhesion.');
    const water = source ? (regionWords(state.host.memory, source.region) as Float64Array) : undefined;
    solveCouplers(state, table);
    if (state.wire) stepWire(state.wire, state.cars, state.region, dt);
    for (let i = 0; i < state.cars.length; i++) {
      const car = state.cars[i]!;
      const wetness = water ? railNumber(water[car.wetnessWord]!, 'published rail wetness', 0, 1) : car.wetness;
      stepCar(this.carRow(table, i), car, state.host.gravity, wetness, dt);
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const state = this.running();
    const car = { field: this.carField.name, region: state.region, tick, cell: ZERO };
    return state.wire ? [car, { field: this.wireField.name, region: state.wire.region, tick, cell: ZERO }] : [car];
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

  private wire(): Wire {
    const wire = this.running().wire;
    if (!wire) throw new MargoError('state', 'Configure a contact wire before reading it.');
    return wire;
  }

  private running(): Running {
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
