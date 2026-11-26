import { MargoError } from '@margoengine/math/errors';
import type { Precipitation } from '@margoengine/math/fields';
import type {
  Cell,
  FieldDescriptor,
  FieldUse,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { instantiateRunoff, loadRunoffBuilds, type RunoffBuilds, type RunoffKernel } from './kernel.js';

const F64 = Float64Array.BYTES_PER_ELEMENT;
const LAYOUT = 1;
const COLUMNS = 7;
const SURFACE = 0;
const SOIL = 1;
const INFILTRATION = 3;
const RECHARGE = 4;
const DISCHARGE = 5;
const OUTLETS = 6;
const METRES_PER_MMH = 1 / 3.6e6;

type GridNumber = number | ArrayLike<number>;

/** A row-major drainage grid. Coordinates of its cell centres are in metres. */
export interface RunoffGrid {
  readonly nx: number;
  readonly nz: number;
  /** Cell size along X, in metres. */
  readonly dx: number;
  /** Cell size along Z, in metres. Defaults to dx. */
  readonly dz?: number;
  /** South-west corner of the grid, [x, z] in metres. Default [0, 0]. */
  readonly origin?: readonly [number, number];
  /** Downstream cell index for each cell, or -1 for an outflow. The graph must be acyclic. */
  readonly downstream: ArrayLike<number>;
  /** Terrain heights in metres. Used to derive an edge slope and to sample precipitation. Default 0 m. */
  readonly elevation?: ArrayLike<number>;
  /** Hydraulic gradient. Defaults to the height drop over the edge, or 0.01 when heights are absent and at the outlets. */
  readonly slope?: GridNumber;
  /** Natural-log wetness index at each cell, available from the biomes drainage grid after converting its Q8 values. */
  readonly wetnessIndex?: ArrayLike<number>;
}

/** Soil and channel parameters, common to the grid or set at each cell independently. */
export interface RunoffParams extends RunoffGrid {
  /** Saturated conductivity, m/s. Default 1e-5. */
  readonly conductivity?: GridNumber;
  /** Positive suction head at the front, metres. Default 0.15. */
  readonly suctionHead?: GridNumber;
  /** Initial volumetric moisture deficit of the wetting front, 0–1. Default 0.25. */
  readonly wettingDeficit?: GridNumber;
  /** Active soil's capacity in water-equivalent metres. Default 0.15. */
  readonly soilCapacity?: GridNumber;
  /** Initial water as a fraction of soil capacity, 0–1. Default 0. */
  readonly initialSaturation?: GridNumber;
  /** Initial surface water depth in metres. Default 0. */
  readonly initialDepth?: GridNumber;
  /** Drainage coefficient of the active soil into groundwater, s^-1. Default 1/86400. */
  readonly drainage?: GridNumber;
  /** Manning roughness, s/m^(1/3). Default 0.035. */
  readonly roughness?: GridNumber;
  /** Effective hydraulic width, metres. Defaults to the cell width. */
  readonly width?: GridNumber;
  /** TOPMODEL storage-depth scale, metres. Default 0.04 with a wetnessIndex, 0 without it. */
  readonly topographicScale?: number;
  /** Fallback steady liquid rainfall in m/s. Default 0. */
  readonly rainRate?: GridNumber;
  /** Optional precipitation service. Sample coordinates are taken in its cell. A bound rain port takes precedence. */
  readonly precipitation?: Precipitation;
}

/** A layout-1 scalar or grid incoming at the coupling tick. */
export interface RunoffRainInput {
  readonly field: FieldDescriptor;
  /** A scalar word to broadcast. Without it, read a single word or a complete row-major grid. */
  readonly word?: number;
}

/** Optional forcing ports and the identity of the world solver. */
export interface RunoffLoadOptions {
  /** Solver ID and the prefix of output field names. Default 'runoff'. */
  readonly id?: string;
  /** SI liquid rain rate, m/s. */
  readonly rain?: RunoffRainInput;
  /** ATMO-09 layout-1 f64 water-flux field. Its evaporation and melt words drive this patch if bound. */
  readonly surfaceEnergy?: FieldDescriptor;
  /** Cancels loading with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** Every cumulative runoff budget term is measured in cubic metres. */
export interface RunoffBudget {
  readonly rain: number;
  readonly melt: number;
  readonly condensation: number;
  readonly evaporation: number;
  readonly recharge: number;
  readonly outflow: number;
}

/** Instantaneous surface and soil storage, fluxes and discharge at a drainage cell. */
export interface RunoffSample {
  /** Surface water depth, m. */
  readonly depth: number;
  /** Soil water storage, m liquid-water equivalent. */
  readonly soilWater: number;
  /** Infiltration into the soil, m/s. */
  readonly infiltration: number;
  /** Downward groundwater recharge, m/s. */
  readonly recharge: number;
  /** Discharge into the downstream link, m³/s. */
  readonly discharge: number;
  /** Discharge leaving the drainage grid here, m³/s. Zero on cells with a downstream link. */
  readonly outflow: number;
}

interface Shape {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly dz: number;
  readonly count: number;
  readonly x: number;
  readonly z: number;
  readonly area: number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: RunoffKernel;
  readonly shape: Shape;
  readonly storage: Region;
  readonly coefficients: Region;
  readonly topology: Region;
  readonly elevations: Region;
  readonly rain: Region;
  readonly forcing: Region;
  readonly scratch: Region;
  readonly budget: Region;
  readonly cell: Region;
  readonly topographicScale: number;
  readonly precipitation?: Precipitation;
}

function numberIn(option: string, value: number, minimum = 0, maximum = Infinity): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError(`Invalid runoff ${option}; pass a finite number in [${minimum}, ${maximum}] in its SI units.`);
  return value;
}

function positive(option: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`Invalid runoff ${option}; pass a positive finite number in its SI units.`);
  return value;
}

function scalarGrid(option: string, value: GridNumber, count: number) {
  if (typeof value === 'number') return () => value;
  if (value.length !== count)
    throw new RangeError(`Invalid runoff ${option} length; supply one number or exactly ${count} cell values.`);
  return (index: number) => value[index]!;
}

function gridShape(options: RunoffGrid): Shape {
  const { nx, nz } = options;
  const count = nx * nz;
  if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(nz) || nx < 1 || nz < 1 || count > 0x7fffffff)
    throw new RangeError(
      'Invalid runoff dimensions; pass positive integers whose cell indices fit a signed 32-bit grid.',
    );
  const dx = positive('dx', options.dx);
  const dz = positive('dz', options.dz ?? dx);
  const [x, z] = options.origin ?? [0, 0];
  return {
    nx,
    nz,
    dx,
    dz,
    count,
    area: positive('cell area', dx * dz),
    x: numberIn('origin x', x, -Infinity),
    z: numberIn('origin z', z, -Infinity),
  };
}

function drainageOrder(downstream: ArrayLike<number>, count: number): Int32Array {
  if (downstream.length !== count)
    throw new RangeError(`Invalid runoff downstream length; give one index per cell (${count} indices).`);
  const topology = new Int32Array(2 * count);
  const incoming = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const next = downstream[i]!;
    if (!Number.isInteger(next) || next < -1 || next >= count)
      throw new RangeError(`Invalid runoff downstream[${i}]; use -1 for an outlet or a cell index below ${count}.`);
    topology[i] = next;
    if (next >= 0) incoming[next]!++;
  }
  let end = count;
  for (let i = 0; i < count; i++) if (incoming[i] === 0) topology[end++] = i;
  for (let begin = count; begin < end; begin++) {
    const next = topology[topology[begin]!]!;
    if (next >= 0 && --incoming[next]! === 0) topology[end++] = next;
  }
  if (end !== topology.length)
    throw new RangeError('Runoff downstream links contain a cycle; pass an acyclic drainage graph with outlets.');
  return topology;
}

function output(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'uniformGrid', quantity, unit, centring: 'cell' };
}

function floats(state: State, region: Region): Float64Array<ArrayBufferLike> {
  return new Float64Array(state.host.memory.buffer, region.byteOffset, region.byteLength / F64);
}

function plane(storage: Region, count: number, row: number, name: string): Region {
  return { ...storage, name, byteOffset: storage.byteOffset + row * count * F64, byteLength: count * F64 };
}

function inputWords(memory: WebAssembly.Memory, port: Port) {
  const { region } = port;
  const buffer = (region.memory ?? memory).buffer;
  if (region.layout === LAYOUT && region.type === 'f64')
    return new Float64Array(buffer, region.byteOffset, region.byteLength / F64);
  if (region.layout === LAYOUT && region.type === 'f32')
    return new Float32Array(buffer, region.byteOffset, region.byteLength / Float32Array.BYTES_PER_ELEMENT);
  throw new RangeError(
    `Invalid runoff input ${port.field}; publish layout-1 f32 or f64 words in the documented units.`,
  );
}

/** Rainfall runoff and infiltration with implicit kinematic-wave routing through a fixed drainage graph. */
export class RainfallRunoff implements Solver<RunoffParams> {
  readonly depthField: FieldDescriptor;
  readonly soilWaterField: FieldDescriptor;
  readonly infiltrationField: FieldDescriptor;
  readonly rechargeField: FieldDescriptor;
  readonly dischargeField: FieldDescriptor;
  readonly outletField: FieldDescriptor;
  private readonly id: string;
  private readonly rainInput?: RunoffRainInput;
  private readonly energyInput?: FieldDescriptor;
  private readonly outputPlanes: ReadonlyArray<readonly [FieldDescriptor, number]>;
  private state?: State;

  private constructor(
    private readonly builds: RunoffBuilds,
    options: RunoffLoadOptions,
  ) {
    this.id = options.id ?? 'runoff';
    if (options.rain) {
      const { field, word } = options.rain;
      if (field.unit !== 'm/s' || (word !== undefined && (!Number.isSafeInteger(word) || word < 0)))
        throw new RangeError('Invalid runoff rain binding; use m/s and an optional nonnegative word index.');
      this.rainInput = { field: { ...field }, word };
    }
    if (options.surfaceEnergy) {
      if (options.surfaceEnergy.unit !== 'kg/(m^2 s)')
        throw new RangeError('Invalid runoff surface energy binding; bind the ATMO-09 water-flux field in kg/(m^2 s).');
      this.energyInput = { ...options.surfaceEnergy };
    }
    this.depthField = output(`${this.id}:depth`, 'height', 'm');
    this.soilWaterField = output(`${this.id}:soilWater`, 'height', 'm');
    this.infiltrationField = output(`${this.id}:infiltration`, 'infiltrationRate', 'm/s');
    this.rechargeField = output(`${this.id}:recharge`, 'groundwaterRecharge', 'm/s');
    this.dischargeField = output(`${this.id}:discharge`, 'volumeFlowRate', 'm^3/s');
    this.outletField = output(`${this.id}:outlets`, 'volumeFlowRate', 'm^3/s');
    this.outputPlanes = [
      [this.depthField, SURFACE],
      [this.soilWaterField, SOIL],
      [this.infiltrationField, INFILTRATION],
      [this.rechargeField, RECHARGE],
      [this.dischargeField, DISCHARGE],
      [this.outletField, OUTLETS],
    ];
  }

  /** Loads the optional runoff kernel, then returns a solver ready to add to a PhysicsWorld. */
  static async load(options: RunoffLoadOptions = {}): Promise<RainfallRunoff> {
    return new RainfallRunoff(await loadRunoffBuilds(options.signal), options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = this.outputPlanes.map(([field]) => ({ field, access: 'write' }));
    if (this.rainInput) fields.push({ field: this.rainInput.field, access: 'read' });
    if (this.energyInput) fields.push({ field: this.energyInput, access: 'read' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, options: RunoffParams): void {
    if (!options?.downstream)
      throw new RangeError('Runoff needs a drainage grid; supply dimensions, spacing and downstream cell indices.');
    const shape = gridShape(options);
    const { count, dx, dz, nx } = shape;
    const topology = drainageOrder(options.downstream, count);
    const topographicScale = numberIn(
      'topographicScale',
      options.topographicScale ?? (options.wetnessIndex ? 0.04 : 0),
    );
    const elevation = scalarGrid('elevation', options.elevation ?? 0, count);
    const slope = options.slope === undefined ? undefined : scalarGrid('slope', options.slope, count);
    const wetness = scalarGrid('wetnessIndex', options.wetnessIndex ?? 0, count);
    const conductivity = scalarGrid('conductivity', options.conductivity ?? 1e-5, count);
    const suction = scalarGrid('suctionHead', options.suctionHead ?? 0.15, count);
    const wettingDeficit = scalarGrid('wettingDeficit', options.wettingDeficit ?? 0.25, count);
    const capacity = scalarGrid('soilCapacity', options.soilCapacity ?? 0.15, count);
    const saturation = scalarGrid('initialSaturation', options.initialSaturation ?? 0, count);
    const depth = scalarGrid('initialDepth', options.initialDepth ?? 0, count);
    const drainage = scalarGrid('drainage', options.drainage ?? 1 / 86400, count);
    const roughness = scalarGrid('roughness', options.roughness ?? 0.035, count);
    const width = scalarGrid('width', options.width ?? dx, count);
    const rain = scalarGrid('rainRate', options.rainRate ?? 0, count);

    const heights = new Float64Array(count);
    const rainRates = new Float64Array(count);
    const configuration = new Float64Array(6 * count);
    const initial = new Float64Array(2 * count);
    for (let i = 0; i < count; i++) heights[i] = numberIn('elevation', elevation(i), -Infinity);
    for (let i = 0; i < count; i++) {
      const next = topology[i]!;
      const east = ((i % nx) - (next % nx)) * dx;
      const north = (Math.floor(i / nx) - Math.floor(next / nx)) * dz;
      const reachSlope = slope
        ? numberIn('slope', slope(i))
        : next < 0 || !options.elevation
          ? 0.01
          : Math.max(0, heights[i]! - heights[next]!) / Math.sqrt(east * east + north * north);
      const soilCapacity = numberIn('soilCapacity', capacity(i));
      configuration[i] = numberIn('conductivity', conductivity(i));
      configuration[count + i] =
        numberIn('suctionHead', suction(i)) * numberIn('wettingDeficit', wettingDeficit(i), 0, 1);
      configuration[2 * count + i] = soilCapacity;
      configuration[3 * count + i] = numberIn('drainage', drainage(i));
      configuration[4 * count + i] = numberIn(
        'Manning transfer coefficient',
        (Math.sqrt(reachSlope) * positive('width', width(i))) / positive('roughness', roughness(i)),
      );
      configuration[5 * count + i] = numberIn('wetnessIndex', wetness(i), -Infinity);
      rainRates[i] = numberIn('rainRate', rain(i));
      initial[i] = numberIn('initialDepth', depth(i));
      initial[count + i] = soilCapacity * numberIn('initialSaturation', saturation(i), 0, 1);
    }

    const allocate = (name: string, words: number) => host.allocate(name, words * F64, 'f64', LAYOUT);
    const state: State = {
      host,
      shape,
      topographicScale,
      kernel: instantiateRunoff(host, this.builds),
      precipitation: options.precipitation,
      storage: allocate('hydrology-state', COLUMNS * count),
      coefficients: allocate('hydrology-coefficients', 6 * count),
      elevations: allocate('hydrology-bed', count),
      topology: host.allocate('hydrology-topology', topology.byteLength, 'i32', LAYOUT),
      rain: allocate('hydrology-fallback-rain', count),
      forcing: allocate('hydrology-forcing', 3 * count),
      scratch: allocate('hydrology-scratch', 2 * count),
      budget: allocate('hydrology-budget', 6),
      cell: allocate('hydrology-origin-cell', 3),
    };
    floats(state, state.elevations).set(heights);
    floats(state, state.coefficients).set(configuration);
    floats(state, state.storage).set(initial);
    floats(state, state.rain).set(rainRates);
    new Int32Array(host.memory.buffer, state.topology.byteOffset, 2 * count).set(topology);
    this.state = state;
  }

  importPorts(): void {
    // The registry passes the forcing mirrors through StepContext when the scheduler starts this step.
  }

  step(context: StepContext, dt: number): void {
    const state = this.requireState();
    const { host, shape } = state;
    const { count, nx, dx, dz, x, z, area } = shape;
    const forcing = floats(state, state.forcing);
    const rain = forcing.subarray(0, count);
    const boundRain = this.rainInput && context.inputs.get(this.rainInput.field.name);
    if (boundRain) {
      const values = inputWords(host.memory, boundRain);
      const word = this.rainInput?.word;
      if (word !== undefined || values.length === 1) rain.fill(numberIn('rain field', values[word ?? 0]!));
      else {
        if (values.length !== count)
          throw new RangeError(`Invalid runoff rain grid; publish one scalar or ${count} grid words.`);
        for (let i = 0; i < count; i++) rain[i] = numberIn('rain field', values[i]!);
      }
    } else if (state.precipitation) {
      const heights = floats(state, state.elevations);
      const time = context.tick * dt;
      for (let i = 0; i < count; i++) {
        const weather = state.precipitation.sample(
          x + ((i % nx) + 0.5) * dx,
          heights[i]!,
          z + (Math.floor(i / nx) + 0.5) * dz,
          time,
        );
        rain[i] = numberIn('precipitation rain rate', weather.rain.rate) * METRES_PER_MMH;
      }
    } else rain.set(floats(state, state.rain));

    let melt = 0;
    let evaporation = 0;
    const energy = this.energyInput && context.inputs.get(this.energyInput.name);
    if (energy) {
      const values = inputWords(host.memory, energy);
      if (values.length !== 3)
        throw new RangeError(
          'Invalid runoff surface energy port; publish ATMO-09 evaporation, melt and runoff as three words.',
        );
      evaporation = numberIn('surface evaporation', values[0]!, -Infinity) / 1000;
      melt = numberIn('snowmelt', values[1]!) / 1000;
    }
    forcing.fill(melt, count, 2 * count);
    forcing.fill(evaporation, 2 * count);
    state.kernel.runoff_step(
      state.storage.byteOffset,
      state.coefficients.byteOffset,
      state.topology.byteOffset,
      state.forcing.byteOffset,
      state.scratch.byteOffset,
      state.budget.byteOffset,
      count,
      area,
      state.topographicScale,
      dt,
    );
    floats(state, state.cell).set(context.cell);
  }

  exportPorts(tick: number): readonly Port[] {
    const state = this.requireState();
    const [x, y, z] = floats(state, state.cell);
    const cell: Cell = [x!, y!, z!];
    return this.outputPlanes.map(([field, index]) => ({
      field: field.name,
      tick,
      cell,
      region: plane(state.storage, state.shape.count, index, field.name),
    }));
  }

  stateRegions(): readonly Region[] {
    const { storage, coefficients, topology, elevations, rain, budget, cell } = this.requireState();
    return [storage, coefficients, topology, elevations, rain, budget, cell];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Reads a drainage cell by its integer column and row. */
  read(i: number, j: number): RunoffSample {
    const state = this.requireState();
    const { count, nx, nz } = state.shape;
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || i >= nx || j < 0 || j >= nz)
      throw new RangeError('Invalid runoff cell; supply a column and row inside the configured grid.');
    const index = i + nx * j;
    const values = floats(state, state.storage);
    return {
      depth: values[index]!,
      soilWater: values[SOIL * count + index]!,
      infiltration: values[INFILTRATION * count + index]!,
      recharge: values[RECHARGE * count + index]!,
      discharge: values[DISCHARGE * count + index]!,
      outflow: values[OUTLETS * count + index]!,
    };
  }

  /** The complete external water ledger since initialization, in cubic metres. */
  get budget(): RunoffBudget {
    const state = this.requireState();
    const [rain, melt, condensation, evaporation, recharge, outflow] = floats(state, state.budget);
    return {
      rain: rain!,
      melt: melt!,
      condensation: condensation!,
      evaporation: evaporation!,
      recharge: recharge!,
      outflow: outflow!,
    };
  }

  /** Current channel discharge at a point in the grid's coordinates, in m³/s. Outside the grid returns zero. */
  dischargeAt(x: number, z: number): number {
    const state = this.requireState();
    const { count, nx, nz, dx, dz, x: minX, z: minZ } = state.shape;
    const i = Math.floor((x - minX) / dx);
    const j = Math.floor((z - minZ) / dz);
    if (!(i >= 0 && i < nx && j >= 0 && j < nz)) return 0;
    return floats(state, state.storage)[DISCHARGE * count + i + j * nx]!;
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('state', 'Runoff has no drainage grid; add the solver to a PhysicsWorld first.');
    return this.state;
  }
}
