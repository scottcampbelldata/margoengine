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
import { advanceSite, CHANGE_WORDS, CONFIG_WORDS, GEOMETRY_WORDS, type IceSiteOptions, prepareSite } from './model.js';

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
const CENTRE = [0, 0, 0] as const;

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
  readonly memory: WebAssembly.Memory;
  readonly count: number;
  readonly config: Region;
  readonly geometry: Region;
  readonly meltwater: Region;
  readonly steam: Region;
  readonly absorbed: Region;
  readonly scratch: Region;
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
    throw new RangeError(`Invalid ${descriptor.name} port; publish layout-1 f64 values, one per configured ice site.`);
  const values = words(region.memory ?? memory, region);
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || (descriptor === ICE_TEMPERATURE_FIELD && value === 0))
      throw new RangeError(`Invalid ${descriptor.name} forcing; publish finite SI values in its physical range.`);
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

  constructor(options: IceSolverOptions = {}) {
    this.#id = options.id ?? 'ice-thermodynamics';
    if (typeof this.#id !== 'string' || this.#id.trim() === '' || this.#id.trim() !== this.#id)
      throw new RangeError('Invalid ice solver ID; pass a nonempty ID without outer whitespace.');
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

  /** Allocates geometry, settings and exchange state in the world's memory. */
  init(host: SolverHost, options: IceWorldOptions): void {
    if (this.#data)
      throw new MargoError('attached', 'IceSolver is already attached; create a new solver for another world.');
    if (!Array.isArray(options?.sites) || options.sites.length === 0)
      throw new RangeError('IceSolver requires at least one site; pass a list of ice sheets, frost layers or icicles.');
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
    const settings = words(host.memory, config);
    const shape = words(host.memory, geometry);
    for (let i = 0; i < count; i++) {
      settings.set(sites[i]!.config, i * CONFIG_WORDS);
      shape.set(sites[i]!.geometry, i * GEOMETRY_WORDS);
    }
    this.#data = {
      memory: host.memory,
      count,
      config,
      geometry,
      meltwater,
      steam,
      absorbed,
      scratch,
      regions: [config, geometry, meltwater, steam, absorbed],
    };
  }

  /** Integrates each site and its exchanges over one dyadic interval. */
  step(context: StepContext, dt: number): void {
    const { memory, count, config, geometry, meltwater, steam, absorbed, scratch } = this.#state();
    const heat = localInput(context, memory, this.#heat, count);
    const temperature = localInput(context, memory, this.#temperature, count);
    const vapour = localInput(context, memory, this.#vapour, count);
    const settings = words(memory, config);
    const shape = words(memory, geometry);
    const next = words(memory, scratch);
    for (let i = 0; i < count; i++) {
      advanceSite(settings, shape, i, temperature?.[i], vapour?.[i], heat?.[i] ?? 0, dt, next);
    }
    if (!next.every(Number.isFinite))
      throw new RangeError('Ice state overflows its numerical range; reduce the boundary flux or initial dimensions.');
    const liquidRate = words(memory, meltwater);
    const steamRate = words(memory, steam);
    const power = words(memory, absorbed);
    for (let i = 0; i < count; i++) {
      const offset = i * CHANGE_WORDS;
      shape[i * GEOMETRY_WORDS] = next[offset]!;
      shape[i * GEOMETRY_WORDS + 1] = next[offset + 1]!;
      liquidRate[i] = next[offset + 2]!;
      steamRate[i] = next[offset + 3]!;
      power[i] = next[offset + 4]!;
    }
  }

  /** The solver receives its readers' published forcing in StepContext and owns no accumulators. */
  importPorts(_tick: number): void {}

  /** Publishes geometry, liquid drainage, steam and absorbed power for the given tick. */
  exportPorts(tick: number): readonly Port[] {
    const { geometry, meltwater, steam, absorbed } = this.#state();
    return [geometry, meltwater, steam, absorbed].map((region, i) => ({
      field: OUTPUTS[i]!.name,
      region,
      tick,
      cell: CENTRE,
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
      throw new RangeError(`Ice site index is out of range; pass an integer from 0 to ${count - 1}.`);
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
    if (!this.#data) throw new MargoError('state', 'IceSolver has no world; add it to a PhysicsWorld first.');
    return this.#data;
  }
}
