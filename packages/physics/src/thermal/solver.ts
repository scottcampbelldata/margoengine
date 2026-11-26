import { MargoError } from '@margoengine/math/errors';
import {
  COEFFICIENTS,
  type HeatConductionOptions,
  prepareThermalGrid,
  RADIATION_WORDS,
  type ThermalAxes,
} from './grid.js';
import { instantiateThermalKernel, loadThermalKernel, type ThermalKernelBuilds } from './kernel.js';
import {
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
  BASE_RATE,
  RATE_LEVELS,
} from '../world/solver.js';

/** Options for loading the feature-local Rust kernel. */
export interface HeatConductionLoadOptions {
  /** Solver ID and field-name prefix. Defaults to 'heat-conduction'. */
  readonly id?: string;
  /** Cancels the load with the signal's reason. Defaults to no cancellation. */
  readonly signal?: AbortSignal;
}

interface ThermalKernel {
  thermal_decode(energy: number, temperature: number, liquid: number, coefficients: number, count: number): void;
  thermal_step(
    energy: number,
    temperature: number,
    liquid: number,
    coefficients: number,
    scratch: number,
    source: number,
    radiation: number,
    radiators: number,
    nx: number,
    ny: number,
    nz: number,
    subdivisions: number,
    dt: number,
    implicit: number,
  ): number;
}

interface ThermalState {
  readonly host: SolverHost;
  readonly kernel: ThermalKernel;
  readonly dimensions: ThermalAxes;
  readonly geometry: Region;
  readonly coefficients: Region;
  readonly energy: Region;
  readonly temperature: Region;
  readonly liquid: Region;
  readonly scratch: Region;
  readonly radiation: Region;
  readonly regions: readonly Region[];
}

const LAYOUT = 1;
const FORWARD_EULER_LIMIT = 0.5;
// Keeps the backward-Euler fixed point at a contraction factor of at most 2/3.
const BACKWARD_EULER_LIMIT = 2;
const F64_BYTES = Float64Array.BYTES_PER_ELEMENT;
const CENTRE = [0, 0, 0] as const;

const words = (memory: WebAssembly.Memory, region: Region) =>
  new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64_BYTES);

const field = (name: string, quantity: string, unit: string): FieldDescriptor =>
  Object.freeze({ name, kind: 'uniformGrid', quantity, unit, centring: 'cell' });

/**
 * Conservative heat diffusion with an isothermal melt interval on a cell-centred grid.
 * Add one loaded solver to a PhysicsWorld. It publishes temperature (K), liquid fraction
 * and cell enthalpy (J). A coupled solver can accumulate joules in its enthalpy field.
 */
export class HeatConduction implements Solver<HeatConductionOptions> {
  /** Solver ID and field-name prefix. */
  readonly id: string;
  /** Cell temperatures in K, one f64 per cell in x-fastest order. */
  readonly temperatureField: FieldDescriptor;
  /** Cell enthalpy in J, one f64 per cell in x-fastest order. Contributions add J per cell. */
  readonly enthalpyField: FieldDescriptor;
  /** Cell liquid fractions in [0, 1], one f64 per cell in x-fastest order. */
  readonly liquidFractionField: FieldDescriptor;
  readonly #builds: ThermalKernelBuilds;
  #data?: ThermalState;
  #heatSource: Region | undefined;

  private constructor(id: string, builds: ThermalKernelBuilds) {
    this.id = id;
    this.#builds = builds;
    this.temperatureField = field(id + '/temperature', 'temperature', 'K');
    this.enthalpyField = field(id + '/enthalpy', 'heat', 'J');
    this.liquidFractionField = field(id + '/liquid-fraction', 'volumeFraction', '1');
  }

  /** Loads the optional Wasm, with no import-time loading. Use the result with PhysicsWorld.add. */
  static async load(options: HeatConductionLoadOptions = {}): Promise<HeatConduction> {
    const id = options.id ?? 'heat-conduction';
    if (typeof id !== 'string' || id.trim() === '' || id.trim() !== id)
      throw new RangeError('Thermal solver ID is invalid; pass a nonempty ID without outer whitespace.');
    return new HeatConduction(id, await loadThermalKernel(options.signal));
  }

  /** Describes the fields and the dyadic rate required by the diffusion bound. */
  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: this.temperatureField, access: 'write' },
        { field: this.enthalpyField, access: 'write' },
        { field: this.liquidFractionField, access: 'write' },
      ],
      rate: 0,
      stableRate: () => {
        const data = this.#data;
        if (!data) return 0;
        const geometry = words(data.host.memory, data.geometry);
        const limit = geometry[4] === 1 ? BACKWARD_EULER_LIMIT : FORWARD_EULER_LIMIT;
        let level = 0;
        while (level + 1 < RATE_LEVELS && geometry[3]! / limit > BASE_RATE * (1 << level)) level++;
        return level as RateLevel;
      },
    };
  }

  /** Allocates solver state and validates the grid before joining the world. */
  init(host: SolverHost, options: HeatConductionOptions): void {
    if (this.#data)
      throw new MargoError('attached', 'HeatConduction is already attached; load a fresh solver for another world.');
    const prepared = prepareThermalGrid(options);
    const bytes = prepared.energy.byteLength;
    const cellCount = prepared.energy.length;
    const kernel = instantiateThermalKernel(host, this.#builds) as unknown as ThermalKernel;
    const topology = prepared.dimensions.join('x') + '-' + prepared.integration;
    const geometry = host.allocate('thermal-geometry-' + topology, 5 * F64_BYTES, 'f64', LAYOUT);
    const coefficients = host.allocate('thermal-coefficients', COEFFICIENTS * bytes, 'f64', LAYOUT);
    const energy = host.allocate('enthalpy', bytes, 'f64', LAYOUT);
    const temperature = host.allocate('temperature', bytes, 'f64', LAYOUT);
    const liquid = host.allocate('liquid-fraction', bytes, 'f64', LAYOUT);
    const radiation = host.allocate('thermal-radiation', prepared.radiation.byteLength, 'f64', LAYOUT);
    const implicit = prepared.integration === 'implicit';
    const planes = 3 + Number(implicit) + Number(prepared.radiation.length > 0);
    const scratch = host.allocate('thermal-scratch', planes * bytes, 'f64', LAYOUT);
    words(host.memory, geometry).set([...prepared.cellSize, prepared.stiffness, Number(implicit)]);
    words(host.memory, coefficients).set(prepared.coefficients);
    words(host.memory, energy).set(prepared.energy);
    words(host.memory, radiation).set(prepared.radiation);
    kernel.thermal_decode(
      energy.byteOffset,
      temperature.byteOffset,
      liquid.byteOffset,
      coefficients.byteOffset,
      cellCount,
    );
    if (!words(host.memory, temperature).every(Number.isFinite))
      throw new RangeError(
        'Initial thermal temperature overflows; pass finite materials and initial conditions within range.',
      );
    this.#data = {
      host,
      kernel,
      dimensions: prepared.dimensions,
      geometry,
      coefficients,
      energy,
      temperature,
      liquid,
      scratch,
      radiation,
      regions: [geometry, coefficients, energy, temperature, liquid, radiation],
    };
  }

  /** Takes the current tick's accumulated energy from the field registry. */
  importPorts(_tick: number): void {
    const state = this.#state();
    const source = state.host.port(this.enthalpyField.name)?.region;
    if (source && (source.byteLength !== state.energy.byteLength || source.type !== 'f64' || source.layout !== LAYOUT))
      throw new RangeError('Thermal heat input layout differs from the grid; publish one f64 joule value per cell.');
    this.#heatSource = source;
  }

  /** Advances one dyadic world step. The kernel subdivides if diffusion needs a finer step. */
  step(_context: StepContext, dt: number): void {
    const state = this.#state();
    const [nx, ny, nz] = state.dimensions;
    const [, , , stiffness, implicit] = words(state.host.memory, state.geometry);
    const limit = implicit === 1 ? BACKWARD_EULER_LIMIT : FORWARD_EULER_LIMIT;
    const substeps = Math.max(1, Math.ceil((dt * stiffness!) / limit));
    if (!(dt > 0) || !Number.isFinite(dt) || substeps > 0xffffffff)
      throw new RangeError(
        'Thermal timestep exceeds its representable stable subdivisions; use a finer tick or coarser cells.',
      );
    const status = state.kernel.thermal_step(
      state.energy.byteOffset,
      state.temperature.byteOffset,
      state.liquid.byteOffset,
      state.coefficients.byteOffset,
      state.scratch.byteOffset,
      this.#heatSource?.byteOffset ?? 0,
      state.radiation.byteOffset,
      state.radiation.byteLength / (F64_BYTES * RADIATION_WORDS),
      nx,
      ny,
      nz,
      substeps,
      dt / substeps,
      implicit!,
    );
    this.#heatSource = undefined;
    if (status === 2)
      throw new RangeError('Implicit heat step did not converge; use a finer tick or reduce the material contrast.');
    if (status !== 0)
      throw new RangeError(
        'Thermal step produced invalid energy or temperature; reduce the applied flux or enthalpy impulse.',
      );
  }

  /** Publishes all three grid fields for the supplied world tick. */
  exportPorts(tick: number): readonly Port[] {
    const state = this.#state();
    return [
      { field: this.temperatureField.name, region: state.temperature, tick, cell: CENTRE },
      { field: this.enthalpyField.name, region: state.energy, tick, cell: CENTRE },
      { field: this.liquidFractionField.name, region: state.liquid, tick, cell: CENTRE },
    ];
  }

  /** Grid data and material coefficients needed for deterministic restore. */
  stateRegions(): readonly Region[] {
    return this.#state().regions;
  }

  /** The thermal update is first order in time and needs no additional history. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Returns an owned temperature array in K, ordered x fastest. */
  readTemperature(): Float64Array {
    const state = this.#state();
    return words(state.host.memory, state.temperature).slice();
  }

  /** Returns an owned liquid fraction array in [0, 1], ordered x fastest. */
  readLiquidFraction(): Float64Array {
    const state = this.#state();
    return words(state.host.memory, state.liquid).slice();
  }

  #state(): ThermalState {
    if (!this.#data)
      throw new MargoError('state', 'HeatConduction has no grid; add it to a PhysicsWorld before reading or stepping.');
    return this.#data;
  }
}
