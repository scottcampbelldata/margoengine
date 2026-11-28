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
import { iceError } from './errors.js';
import { bindIceKernel, type IceBuilds, type IceKernel, type IceWorkCounts, loadIceBuilds } from './kernel.js';
import {
  CHANGE_WORDS,
  CONFIG_WORDS,
  DEFAULT_SURFACE_TRANSFER,
  finishIceSite,
  GEOMETRY_WORDS,
  ICE_THERMAL_INPUT_WORDS,
  ICE_THERMAL_OUTPUT_WORDS,
  type IceSiteOptions,
  prepareSite,
  settleIceEnergy,
  stageIceSite,
} from './model.js';

export type { IceWorkCounts, IceWorkerWork } from './kernel.js';
export {
  type IceFrostOptions,
  type IceIcicleOptions,
  type IceSheetOptions,
  type IceSiteOptions,
  iceFreezingTemperature,
  iceVapourPressure,
} from './model.js';

/** Version of the f64 ice field layouts. */
export const ICE_FIELD_LAYOUT = 1;
const F64_BYTES = Float64Array.BYTES_PER_ELEMENT;

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, kind: 'scalarSeries', quantity, unit, centring: 'cell' });
}

/** Positive external heating in W/m², one f64 per site, with site order matching IceSolver. */
export const ICE_HEAT_FIELD = field('iceSurfaceHeat', 'heatFlux', 'W/m^2');
/** Boundary temperature in kelvin, one f64 per site. */
export const ICE_TEMPERATURE_FIELD = field('iceBoundaryTemperature', 'temperature', 'K');
/** Ambient water-vapour partial pressure in Pa, one f64 per site. Read by frost sites. */
export const ICE_VAPOUR_FIELD = field('iceVapourPressure', 'pressure', 'Pa');
/** Two f64 metre values per site: (thickness, 0) for sheet or frost, (radius, length) for an icicle. */
export const ICE_GEOMETRY_FIELD = field('iceGeometry', 'length', 'm');
/** Liquid drainage in kg/s, one f64 per site. Includes the icicle's unfrozen supply. */
export const ICE_MELTWATER_FIELD = field('iceMeltwater', 'massFlow', 'kg/s');
/** Steam returned to the heat source in kg/s, one f64 per site. */
export const ICE_STEAM_FIELD = field('iceSteam', 'massFlow', 'kg/s');
/** Power absorbed from the external heat source in W, one f64 per site. */
export const ICE_HEAT_ABSORPTION_FIELD = field('iceHeatAbsorption', 'power', 'W');

const OUTPUTS = [ICE_GEOMETRY_FIELD, ICE_MELTWATER_FIELD, ICE_STEAM_FIELD, ICE_HEAT_ABSORPTION_FIELD];

/** Parameters used to create a frozen-water column, icicle or frost layer. */
export interface IceWorldOptions {
  /** Site options in field order. At least one site is required. */
  readonly sites: readonly IceSiteOptions[];
}

/** Registry fields and scheduler ID selected before the world builds the coupling graph. */
export interface IceSolverOptions {
  /** ID unique in the world. Defaults to 'ice-thermodynamics'. */
  readonly id?: string;
  /** Reads ICE_HEAT_FIELD when true. Defaults to false. */
  readonly readHeat?: boolean;
  /** Reads ICE_TEMPERATURE_FIELD when true. Defaults to false. */
  readonly readTemperature?: boolean;
  /** Reads ICE_VAPOUR_FIELD when true. Defaults to false. */
  readonly readVapour?: boolean;
}

/** Selects optional native phase-energy execution in IceSolver.load. */
export interface IceLoadOptions extends IceSolverOptions {
  /** Total participants including the caller. Defaults to one. */
  readonly threads?: 1 | 2 | 4;
  /** Cancels native loading and releases native helpers. */
  readonly signal?: AbortSignal;
}

/** Current geometry and rates for one ice site in SI units. */
export interface IceSample {
  /** Sheet or frost thickness, or icicle radius, in metres. */
  readonly thickness: number;
  /** Icicle length in metres. Zero for a sheet or frost site. */
  readonly length: number;
  /** Liquid drainage in kg/s. Includes unfrozen icicle supply. */
  readonly meltwater: number;
  /** Steam in kg/s. */
  readonly steam: number;
  /** Power absorbed from the external heat field in W. */
  readonly heatAbsorbed: number;
}

interface IceState {
  readonly host: SolverHost;
  readonly memory: WebAssembly.Memory;
  readonly count: number;
  readonly config: Region;
  readonly geometry: Region;
  readonly meltwater: Region;
  readonly steam: Region;
  readonly absorbed: Region;
  readonly scratch: Region;
  readonly surfaceTransfer?: Region;
  readonly phase?: Float64Array;
  readonly result?: Float64Array;
  readonly kernel?: IceKernel;
  readonly regions: readonly Region[];
}

function words(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64_BYTES);
}

function localInput(
  context: StepContext,
  memory: WebAssembly.Memory,
  descriptor: FieldDescriptor | undefined,
  count: number,
): Float64Array | undefined {
  if (!descriptor) return;
  const region = context.inputs.get(descriptor.name)?.region;
  if (!region || region.layout !== ICE_FIELD_LAYOUT || region.type !== 'f64' || region.byteLength !== count * F64_BYTES)
    throw iceError(`Invalid ${descriptor.name} port; publish layout-1 f64 values, one per configured ice site.`);
  const owner = region.memory ?? memory;
  if (
    !Number.isSafeInteger(region.byteOffset) ||
    region.byteOffset < 0 ||
    region.byteOffset % F64_BYTES ||
    region.byteOffset + region.byteLength > owner.buffer.byteLength
  ) {
    throw iceError(`Invalid ${descriptor.name} bank. Publish aligned records in their owning memory.`);
  }
  const values = words(owner, region);
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || (descriptor === ICE_TEMPERATURE_FIELD && value === 0))
      throw iceError(`Invalid ${descriptor.name} forcing; publish finite SI values in its physical range.`);
  }
  return values;
}

/** Freezing and thawing of snow-insulated sheets, dripping icicles and frost, on the PhysicsWorld clock. */
export class IceSolver implements Solver<IceWorldOptions> {
  readonly #id: string;
  readonly #heat: FieldDescriptor | undefined;
  readonly #temperature: FieldDescriptor | undefined;
  readonly #vapour: FieldDescriptor | undefined;
  #data: IceState | undefined;
  #builds?: IceBuilds;
  #work?: IceWorkCounts;
  #disposed = false;

  constructor(options: IceSolverOptions = {}) {
    this.#id = options.id ?? 'ice-thermodynamics';
    if (typeof this.#id !== 'string' || this.#id.trim() === '' || this.#id.trim() !== this.#id)
      throw iceError('Invalid ice solver ID; pass a nonempty ID without outer whitespace.');
    this.#heat = options.readHeat ? ICE_HEAT_FIELD : undefined;
    this.#temperature = options.readTemperature ? ICE_TEMPERATURE_FIELD : undefined;
    this.#vapour = options.readVapour ? ICE_VAPOUR_FIELD : undefined;
  }

  /** Describes the field registry edges and fixed dyadic 60 Hz rate. */
  describe(): SolverDescription {
    const fields: FieldUse[] = OUTPUTS.map((output) => ({ field: output, access: 'write' }));
    for (const input of [this.#heat, this.#temperature, this.#vapour]) {
      if (input) fields.push({ field: input, access: 'read' });
    }
    return { id: this.#id, fields, rate: 0, stableRate: () => 0 };
  }

  /** Loads optional native SIMD for the common ice phase-energy budget. */
  static async load(options: IceLoadOptions = {}): Promise<IceSolver> {
    const ice = new IceSolver(options);
    ice.#builds = await loadIceBuilds(options.signal, options.threads);
    return ice;
  }

  /** Releases this solver's native helpers. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#builds?.[Symbol.dispose]();
  }

  /** Joined native work from the latest accepted step, or undefined in scalar mode. */
  readNativeWork(): IceWorkCounts | undefined {
    return this.#work && structuredClone(this.#work);
  }

  #requireActive(): void {
    if (this.#disposed) throw iceError('Use a new ice solver after disposal.', 'disposed');
  }

  /** Allocates geometry, settings and exchange state in the world's memory. */
  init(host: SolverHost, options: IceWorldOptions): void {
    this.#requireActive();
    if (this.#data) throw iceError('IceSolver is already attached. Create a new solver for another world.', 'attached');
    if (!Array.isArray(options?.sites) || options.sites.length === 0)
      throw iceError('IceSolver requires at least one site; pass a list of ice sheets, frost layers or icicles.');
    const sites = options.sites.map(prepareSite);
    const count = sites.length;
    const allocate = (name: string, width: number) =>
      host.allocate(name, width * count * F64_BYTES, 'f64', ICE_FIELD_LAYOUT);
    const config = allocate('ice-settings', CONFIG_WORDS);
    const geometry = allocate('ice-geometry', GEOMETRY_WORDS);
    const meltwater = allocate('ice-liquid', 1);
    const steam = allocate('ice-steam', 1);
    const absorbed = allocate('ice-heat-absorbed', 1);
    const scratch = allocate('ice-step-scratch', CHANGE_WORDS);
    // Default-only worlds retain their existing settings layout and snapshot schema.
    const surfaceTransfer = sites.some((site) => site.surfaceTransfer !== undefined)
      ? allocate('ice-surface-transfer', 1)
      : undefined;
    if (surfaceTransfer) {
      const transfer = words(host.memory, surfaceTransfer);
      for (const [i, site] of sites.entries()) transfer[i] = site.surfaceTransfer ?? DEFAULT_SURFACE_TRANSFER;
    }
    const settings = words(host.memory, config);
    const shape = words(host.memory, geometry);
    for (let i = 0; i < count; i++) {
      settings.set(sites[i]!.config, i * CONFIG_WORDS);
      shape.set(sites[i]!.geometry, i * GEOMETRY_WORDS);
    }
    const kernel = this.#builds && bindIceKernel(host, this.#builds, count);
    this.#data = {
      host,
      memory: host.memory,
      count,
      config,
      geometry,
      meltwater,
      steam,
      absorbed,
      scratch,
      surfaceTransfer,
      phase: kernel ? undefined : new Float64Array(count * ICE_THERMAL_INPUT_WORDS),
      result: kernel ? undefined : new Float64Array(count * ICE_THERMAL_OUTPUT_WORDS),
      kernel,
      regions: [config, geometry, meltwater, steam, absorbed, ...(surfaceTransfer ? [surfaceTransfer] : [])],
    };
  }

  /** Integrates each site and its exchanges over one dyadic interval. */
  step(context: StepContext, dt: number): void {
    this.#requireActive();
    if (!(dt > 0 && Number.isFinite(dt))) throw iceError('Ice step duration is invalid. Pass positive finite seconds.');
    const state = this.#state();
    const { memory, count, config, geometry, meltwater, steam, absorbed, scratch, surfaceTransfer, kernel } = state;
    const heat = localInput(context, memory, this.#heat, count);
    const temperature = localInput(context, memory, this.#temperature, count);
    const vapour = localInput(context, memory, this.#vapour, count);
    const settings = words(memory, config);
    const shape = words(memory, geometry);
    const staged = words(memory, scratch);
    const phase = kernel ? kernel.rows() : state.phase!;
    const transfers = surfaceTransfer && words(memory, surfaceTransfer);
    for (let i = 0; i < count; i++) {
      stageIceSite(
        settings,
        shape,
        i,
        temperature?.[i],
        vapour?.[i],
        heat?.[i] ?? 0,
        dt,
        transfers?.[i] ?? DEFAULT_SURFACE_TRANSFER,
        phase,
        staged,
      );
    }
    if (!phase.every(Number.isFinite))
      throw iceError('Ice boundary energy exceeds numeric range. Reduce the heat flux or initial dimensions.');
    const result = kernel ? kernel.apply(dt) : state.result!;
    if (!kernel) {
      for (let i = 0; i < count; i++) settleIceEnergy(phase, i, dt, result);
    }
    const next = words(memory, scratch);
    const acceptedSettings = words(memory, config);
    for (let i = 0; i < count; i++) finishIceSite(acceptedSettings, i, result, next);
    if (!next.every(Number.isFinite))
      throw iceError('Ice state overflows its numerical range. Reduce the boundary flux or initial dimensions.');
    const work = kernel?.workCounts();
    const acceptedShape = words(memory, geometry);
    const liquidRate = words(memory, meltwater);
    const steamRate = words(memory, steam);
    const power = words(memory, absorbed);
    for (let i = 0; i < count; i++) {
      const offset = i * CHANGE_WORDS;
      acceptedShape[i * GEOMETRY_WORDS] = next[offset]!;
      acceptedShape[i * GEOMETRY_WORDS + 1] = next[offset + 1]!;
      liquidRate[i] = next[offset + 2]!;
      steamRate[i] = next[offset + 3]!;
      power[i] = next[offset + 4]!;
    }
    this.#work = work;
  }

  /** The solver receives its readers' published forcing in StepContext and owns no accumulators. */
  importPorts(_tick: number): void {}

  /** Publishes geometry, liquid drainage, steam and absorbed power for the given tick. */
  exportPorts(tick: number): readonly Port[] {
    const { host, geometry, meltwater, steam, absorbed } = this.#state();
    return [geometry, meltwater, steam, absorbed].map((region, i) => ({
      field: OUTPUTS[i]!.name,
      region,
      tick,
      cell: host.cell,
    }));
  }

  /** Settings and state needed to continue from a snapshot. */
  stateRegions(): readonly Region[] {
    return this.#state().regions;
  }

  /** The closed-form column update requires no additional integration history. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Reads a site's latest geometry and exchange rates after a world advance. */
  sample(site: number): IceSample {
    const { count, memory, geometry, meltwater, steam, absorbed } = this.#state();
    if (!Number.isInteger(site) || site < 0 || site >= count)
      throw iceError(`Ice site index is out of range; pass an integer from 0 to ${count - 1}.`);
    const dimensions = words(memory, geometry);
    return {
      thickness: dimensions[site * GEOMETRY_WORDS]!,
      length: dimensions[site * GEOMETRY_WORDS + 1]!,
      meltwater: words(memory, meltwater)[site]!,
      steam: words(memory, steam)[site]!,
      heatAbsorbed: words(memory, absorbed)[site]!,
    };
  }

  #state(): IceState {
    if (!this.#data) throw iceError('IceSolver has no world. Add it to a PhysicsWorld first.');
    return this.#data;
  }
}
