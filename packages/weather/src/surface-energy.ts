import { MargoError } from '@margoengine/math/errors';
import { exp } from '@margoengine/math/pinned';
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
} from '@margoengine/physics/world';
import { FUEL_TIMELAGS, fuelMoistureTarget } from './fuel-moisture.js';
import type { loadSurfaceEnergyKernel, SurfaceEnergyWorkCounts } from './surface-energy-native.js';

export type { SurfaceEnergyWorkCounts, SurfaceEnergyWorkerWork } from './surface-energy-native.js';

const FREEZING = 273.15;
const WATER_DENSITY = 1000;
const LATENT_VAPOR = 2.45e6;
const LATENT_FUSION = 333700;
const AIR_HEAT_CAPACITY = 1005;
const DRY_AIR_GAS_CONSTANT = 287.05;
const STEFAN_BOLTZMANN = 5.670374419e-8;
const LAYOUT = 1;
const ORIGIN: Cell = [0, 0, 0];
const WORD = Float64Array.BYTES_PER_ELEMENT;
const INPUT_WORDS = 13;
const OUTPUT_WORDS = 4;

const DEFAULT_FORCING = {
  shortwave: 0,
  longwave: 320,
  airTemperature: 288.15,
  humidity: 0.65,
  pressure: 101325,
  deepTemperature: 286.15,
  rain: 0,
  snow: 0,
  cloud: 0,
  albedo: 0.2,
  aerodynamicResistance: 100,
  surfaceResistance: 70,
};
type ForcingKey = keyof typeof DEFAULT_FORCING;
const FORCING_KEYS = Object.keys(DEFAULT_FORCING) as ForcingKey[];

const INPUT_UNITS: Record<ForcingKey, string> = {
  shortwave: 'W/m^2',
  longwave: 'W/m^2',
  airTemperature: 'K',
  humidity: '1',
  pressure: 'Pa',
  deepTemperature: 'K',
  rain: 'm/s',
  snow: 'm/s',
  cloud: '1',
  albedo: '1',
  aerodynamicResistance: 's/m',
  surfaceResistance: 's/m',
};

/** One incoming framework field. A projection can sample a grid or compute local insolation from an ephemeris. */
export interface SurfaceEnergyInput {
  /** The upstream descriptor, including its SI unit. */
  readonly field: FieldDescriptor;
  /** Zero-based f32/f64 word to read, layout 1. Defaults to 0. Ignored when sample is supplied. */
  readonly word?: number;
  /** Additional words between patches in X-fast order. Defaults to 0, a uniform input. */
  readonly patchStride?: number;
  /** Pure projection of a port at the current tick. Defaults to reading the configured scalar word. */
  readonly sample?: (memory: WebAssembly.Memory, port: Port, context: StepContext) => number;
}

/** Static or port-driven inputs to the land heat and water budgets. Radiative fluxes are downwelling. */
export interface SurfaceEnergyForcing {
  /** Shortwave irradiance on the patch, W/m². Default 0. */
  readonly shortwave?: number;
  /** Downwelling thermal radiation, W/m². Default 320. */
  readonly longwave?: number;
  /** Ambient air temperature, K. Default 288.15. */
  readonly airTemperature?: number;
  /** Relative air humidity, 0–1. Default 0.65. */
  readonly humidity?: number;
  /** Ambient pressure, Pa. Default 101325. */
  readonly pressure?: number;
  /** Temperature below the modeled surface layer, K. Default 286.15. */
  readonly deepTemperature?: number;
  /** Liquid rain rate as water depth per second, m/s. Default 0. */
  readonly rain?: number;
  /** Snowfall as liquid-water-equivalent depth per second, m/s. Default 0. */
  readonly snow?: number;
  /** Cloud cover, 0–1, used to estimate dead-fuel exposure. Default 0. */
  readonly cloud?: number;
  /** Shortwave reflectance, 0–1. Default 0.2. Use the snow albedo for a snow-covered patch. */
  readonly albedo?: number;
  /** Aerodynamic resistance to heat and vapour, s/m. Default 100. */
  readonly aerodynamicResistance?: number;
  /** Ground or canopy resistance to vapour loss, s/m. Default 70. */
  readonly surfaceResistance?: number;
}

/** Surface material, starting state and fallback weather. Water storage is per square metre of horizontal ground. */
export interface SurfaceEnergyOptions extends SurfaceEnergyForcing {
  /** Thermal capacity of the active layer, J/(m² K). Default 250000. */
  readonly heatCapacity?: number;
  /** Layer-to-ground thermal conductance, W/(m² K). Default 5. */
  readonly groundConductance?: number;
  /** Thermal emissivity and absorptivity, 0–1. Default 0.97. */
  readonly emissivity?: number;
  /** Liquid storage capacity before runoff, kg/m². Default 15. */
  readonly waterCapacity?: number;
  /** Soil surface temperature, K. Default starts at the fallback air temperature. */
  readonly initialTemperature?: number;
  /** Water in the active layer, kg/m². Default 25% of waterCapacity. */
  readonly initialWater?: number;
  /** Snow water equivalent, kg/m². Default 0. */
  readonly initialSnow?: number;
  /** Optional rectangular grid of independent patches. Without it, this instance solves one patch. */
  readonly grid?: SurfaceEnergyGrid;
}

/** Fixed sampling geometry and optional overrides for each surface patch. */
export interface SurfaceEnergyGrid {
  /** Number of patch centres along X. */
  readonly columns: number;
  /** Number of patch centres along Z. */
  readonly rows: number;
  /** Position of the first patch centre in the solver's origin cell, metres. Defaults to [0, 0, 0]. */
  readonly origin?: readonly [number, number, number];
  /** Spacing between patch centres along X and Z, metres. */
  readonly spacing: readonly [number, number];
  /** Overrides the instance defaults per patch, with X increasing fastest. */
  readonly patches?: readonly Omit<SurfaceEnergyOptions, 'grid'>[];
  /** World cell size for translating to a precipitation field's cell. Defaults to 4096 m. */
  readonly cellSize?: number;
}

/** Last published state of a patch. Rates are positive in the direction named, and can be signed. */
export interface SurfaceEnergySample {
  readonly temperature: number;
  readonly water: number;
  readonly snow: number;
  readonly wetness: number;
  /** Absorbed shortwave and net longwave into the surface, W/m². */
  readonly netRadiation: number;
  /** Heat flux from ground to air, W/m². */
  readonly sensible: number;
  /** Evaporation flux times latent heat, W/m². */
  readonly latent: number;
  /** Heat flux into deep ground, W/m². */
  readonly ground: number;
  /** Heat used to melt snow, W/m². */
  readonly meltHeat: number;
  /** Water leaving the surface for the air, kg/(m² s). Negative for condensation. */
  readonly evaporation: number;
  /** Snow becoming liquid, kg/(m² s). */
  readonly melt: number;
  /** Liquid leaving a saturated patch, kg/(m² s). */
  readonly runoff: number;
  /** Fractions of dry mass for 1-, 10-, and 100-hour dead fuels. */
  readonly fuelMoisture: readonly [number, number, number];
}

/** Fixed coupling inputs and the surface solver ID. */
export interface SurfaceEnergySetup {
  /** Unique solver ID and prefix for its output fields. Default 'surface-energy'. */
  readonly id?: string;
  /** Field bindings by forcing name. Missing publishers use the initial forcing options. */
  readonly inputs?: Readonly<Partial<Record<ForcingKey, SurfaceEnergyInput>>>;
  /** Optional pure precipitation field, at this patch. Rain and snow input ports take precedence when present. */
  readonly precipitation?: {
    readonly field: Precipitation;
    /** Sample point, metres in the precipitation field's origin cell. Default [0, 0, 0]. */
    readonly position?: readonly [number, number, number];
  };
}

/** Loading the optional batch kernel and its workers. */
export interface SurfaceEnergyLoadOptions {
  /** Native participants including the caller. Defaults to 1. */
  readonly threads?: number;
  /** Cancels the optional native asset load. */
  readonly signal?: AbortSignal;
}

function invalid(message: string): MargoError {
  return new MargoError('state', message);
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'scalarSeries', quantity, unit, centring: 'cell' };
}

function checked(name: string, value: number, minimum = 0, maximum = Infinity): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw invalid(
      `Invalid surface energy ${name}; pass a finite value from ${minimum} to ${maximum} in the documented units.`,
    );
  return value;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw invalid(`Invalid surface energy ${name}; pass a positive finite value in the documented units.`);
  return value;
}

function checkForcing(key: ForcingKey, value: number): number {
  if (key === 'airTemperature' || key === 'deepTemperature' || key === 'pressure' || key === 'aerodynamicResistance')
    return positive(key, value);
  return checked(key, value, 0, key === 'humidity' || key === 'cloud' || key === 'albedo' ? 1 : Infinity);
}

function saturationPressure(temperature: number, pressure: number): number {
  // FAO-56 Eq. 11. Below its formal singularity the liquid-water vapour pressure has already rounded to zero.
  const celsius = temperature - FREEZING;
  if (celsius <= -237.3) return 0;
  return Math.min(pressure, 610.8 * exp((17.27 * celsius) / (celsius + 237.3)));
}

function specificHumidity(vapourPressure: number, pressure: number): number {
  const fraction = vapourPressure / pressure;
  return (0.622 * fraction) / (1 - 0.378 * fraction);
}

function fourthPower(value: number): number {
  const square = value * value;
  return square * square;
}

function inputValue(
  memory: WebAssembly.Memory,
  input: SurfaceEnergyInput,
  port: Port,
  context: StepContext,
  patch: number,
): number {
  if (input.sample) return input.sample(memory, port, context);
  const region = port.region;
  const stride = input.patchStride ?? 0;
  const index = (input.word ?? 0) + patch * stride;
  const width = region?.type === 'f64' ? 8 : 4;
  const source = region?.memory ?? memory;
  if (
    !region ||
    (region.type !== 'f32' && region.type !== 'f64') ||
    region.layout !== LAYOUT ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(region.byteLength) ||
    region.byteLength % width !== 0 ||
    index >= region.byteLength / width ||
    !Number.isSafeInteger(region.byteOffset) ||
    region.byteOffset < 0 ||
    region.byteOffset + region.byteLength > source.buffer.byteLength ||
    (stride > 0 &&
      (port.cell?.length !== 3 ||
        port.cell[0] !== context.cell[0] ||
        port.cell[1] !== context.cell[1] ||
        port.cell[2] !== context.cell[2]))
  )
    throw invalid(
      `Invalid ${port.field} surface energy port; publish layout-1 floats at the configured patch stride and origin, or pass a sample projection.`,
    );
  const view = new DataView(source.buffer, region.byteOffset, region.byteLength);
  return region.type === 'f64' ? view.getFloat64(index * width, true) : view.getFloat32(index * width, true);
}

interface SurfaceRegions {
  readonly temperature: Region;
  readonly storage: Region;
  readonly wetness: Region;
  readonly energy: Region;
  readonly water: Region;
  readonly fuel: Region;
  readonly cell: Region;
}

interface PatchConfig {
  readonly forcing: Required<SurfaceEnergyForcing>;
  readonly heatCapacity: number;
  readonly groundConductance: number;
  readonly emissivity: number;
  readonly waterCapacity: number;
  readonly initialTemperature: number;
  readonly initialWater: number;
  readonly initialSnow: number;
}

interface GridShape {
  readonly columns: number;
  readonly count: number;
  readonly origin: Cell;
  readonly spacing: readonly [number, number];
  readonly cellSize: number;
}

interface SurfaceState {
  readonly host: SolverHost;
  readonly regions: SurfaceRegions;
  readonly grid?: GridShape;
  readonly patches: readonly PatchConfig[];
  readonly stagedForcing: Record<ForcingKey, number>[];
  readonly staged: {
    readonly temperature: Float64Array;
    readonly storage: Float64Array;
    readonly wetness: Float64Array;
    readonly energy: Float64Array;
    readonly water: Float64Array;
    readonly fuel: Float64Array;
  };
  readonly input: Float64Array;
  readonly output: Float64Array;
}

function view(host: SolverHost, region: Region): Float64Array {
  return new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / WORD);
}

function point(value: Cell, label: string): Cell {
  if (value?.length !== 3 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2]))
    throw invalid(`Choose three finite metre coordinates for ${label}.`);
  return [value[0], value[1], value[2]];
}

function fieldOffset(to: number, from: number, cellSize: number): number {
  const delta = to - from;
  if (!Number.isSafeInteger(delta) || !Number.isFinite(delta * cellSize))
    throw invalid('The surface and precipitation cells are too far apart. Place them in nearby world cells.');
  return delta * cellSize;
}

function gridShape(grid: SurfaceEnergyGrid): GridShape {
  const { columns, rows, spacing, patches } = grid;
  const count = columns * rows;
  if (
    !Number.isSafeInteger(columns) ||
    !Number.isSafeInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    !Number.isSafeInteger(count) ||
    count * (18 + INPUT_WORDS + OUTPUT_WORDS) * WORD >= 0x1_0000_0000
  )
    throw invalid('Choose positive whole surface grid dimensions that fit native storage. Use fewer rows or columns.');
  if (spacing?.length !== 2) throw invalid('Provide two surface grid spacings along X and Z, in metres.');
  const dx = positive('grid X spacing', spacing[0]);
  const dz = positive('grid Z spacing', spacing[1]);
  const origin = point(grid.origin ?? ORIGIN, 'surface grid origin');
  const maxX = origin[0] + (columns - 1) * dx;
  const maxZ = origin[2] + (rows - 1) * dz;
  if (
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxZ) ||
    (columns > 1 && (origin[0] + dx === origin[0] || maxX - dx === maxX)) ||
    (rows > 1 && (origin[2] + dz === origin[2] || maxZ - dz === maxZ))
  )
    throw invalid('The surface grid loses its spacing at this origin. Move the grid closer to its cell origin.');
  if (patches !== undefined && (!Array.isArray(patches) || patches.length !== count))
    throw invalid('Supply one surface patch override per grid cell in X-fast order.');
  return { columns, count, origin, spacing: [dx, dz], cellSize: positive('world cell size', grid.cellSize ?? 4096) };
}

function patchConfig(options: SurfaceEnergyOptions): PatchConfig {
  const forcing = { ...DEFAULT_FORCING };
  for (const key of FORCING_KEYS) forcing[key] = checkForcing(key, options[key] ?? forcing[key]);
  const waterCapacity = positive('waterCapacity', options.waterCapacity ?? 15);
  return {
    forcing,
    heatCapacity: positive('heatCapacity', options.heatCapacity ?? 250000),
    groundConductance: checked('groundConductance', options.groundConductance ?? 5),
    emissivity: checked('emissivity', options.emissivity ?? 0.97, 0, 1),
    waterCapacity,
    initialTemperature: positive('initialTemperature', options.initialTemperature ?? forcing.airTemperature),
    initialWater: checked('initialWater', options.initialWater ?? 0.25 * waterCapacity, 0, waterCapacity),
    initialSnow: checked('initialSnow', options.initialSnow ?? 0),
  };
}

function solvePatch(input: Float64Array, output: Float64Array, patch: number): void {
  const start = patch * INPUT_WORDS;
  const [
    before,
    liquidPerSecond,
    snowPerSecond,
    pressure,
    humidityAir,
    airTemperature,
    deepTemperature,
    sensible,
    vapour,
    conductance,
    emission,
    incoming,
    capacityRate,
  ] = input.subarray(start, start + INPUT_WORDS) as unknown as readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const evaporate = (t: number) =>
    Math.min(liquidPerSecond, vapour * (specificHumidity(saturationPressure(t, pressure), pressure) - humidityAir));
  const balance = (t: number) =>
    capacityRate * (t - before) -
    incoming +
    emission * fourthPower(t) +
    sensible * (t - airTemperature) +
    conductance * (t - deepTemperature) +
    LATENT_VAPOR * evaporate(t);

  const meltHeatLimit = snowPerSecond * LATENT_FUSION;
  const energyAtFreezing = snowPerSecond > 0 ? balance(FREEZING) : 0;
  const meltHeat = Math.min(meltHeatLimit, Math.max(0, -energyAtFreezing));
  let surface = FREEZING;
  if (!(meltHeat > 0 && meltHeat < meltHeatLimit)) {
    // Above all boundary temperatures and this incoming-energy bound the residual is nonnegative.
    let lo = 0;
    let hi =
      Math.max(before, airTemperature, deepTemperature) +
      (incoming + LATENT_VAPOR * vapour * humidityAir) / capacityRate;
    if (!Number.isFinite(hi) || !Number.isFinite(balance(hi)))
      throw invalid(
        'Surface energy forcing exceeds floating-point range; reduce fluxes and use finite SI material properties.',
      );
    for (;;) {
      const mid = lo + (hi - lo) * 0.5;
      if (mid === lo || mid === hi) {
        surface = Math.abs(balance(lo) + meltHeat) < Math.abs(balance(hi) + meltHeat) ? lo : hi;
        break;
      }
      const residual = balance(mid) + meltHeat;
      if (residual === 0) {
        surface = mid;
        break;
      }
      if (residual > 0) hi = mid;
      else lo = mid;
    }
  }
  const melt = meltHeat === meltHeatLimit ? snowPerSecond : meltHeat / LATENT_FUSION;
  output.set([surface, evaporate(surface), melt, meltHeat], patch * OUTPUT_WORDS);
}

/**
 * Implicit land-surface energy balance and a conservative snow and soil-water column on the physics world clock.
 * Owns local temperature, water storage and dead-fuel response for each surface patch.
 */
export class SurfaceEnergySolver implements Solver<SurfaceEnergyOptions> {
  readonly temperatureField: FieldDescriptor;
  readonly wetnessField: FieldDescriptor;
  readonly energyFluxField: FieldDescriptor;
  readonly waterFluxField: FieldDescriptor;
  readonly fuelMoistureField: FieldDescriptor;
  private readonly id: string;
  private readonly inputs: readonly (readonly [ForcingKey, SurfaceEnergyInput])[];
  private readonly precipitation: SurfaceEnergySetup['precipitation'];
  private state?: SurfaceState;
  private native?: Awaited<ReturnType<typeof loadSurfaceEnergyKernel>>;
  private work?: SurfaceEnergyWorkCounts;
  private disposed = false;

  constructor(setup: SurfaceEnergySetup = {}) {
    if (!setup || typeof setup !== 'object') throw invalid('Provide a surface energy setup object or omit it.');
    this.id = setup.id ?? 'surface-energy';
    if (typeof this.id !== 'string' || this.id.length === 0) throw invalid('Use a nonempty surface energy ID.');
    this.inputs = FORCING_KEYS.flatMap((key) => {
      const input = setup.inputs?.[key];
      if (!input) return [];
      if (input.field?.unit !== INPUT_UNITS[key] || !input.field.name)
        throw invalid(`Invalid surface energy ${key} field; bind a named field in ${INPUT_UNITS[key]}.`);
      if (input.word !== undefined && (!Number.isSafeInteger(input.word) || input.word < 0))
        throw invalid(`Invalid surface energy ${key} word; pass a nonnegative integer index.`);
      if (input.patchStride !== undefined && (!Number.isSafeInteger(input.patchStride) || input.patchStride < 0))
        throw invalid(`Invalid surface energy ${key} stride; pass a nonnegative whole number of words.`);
      if (input.sample !== undefined && typeof input.sample !== 'function')
        throw invalid(`Invalid surface energy ${key} projection; provide a function or omit it.`);
      return [[key, { ...input, field: { ...input.field } }] as const];
    });
    if (setup.precipitation) {
      if (typeof setup.precipitation.field?.sample !== 'function')
        throw invalid('Supply a precipitation field with a sample method.');
      const position = point(setup.precipitation.position ?? ORIGIN, 'surface precipitation position');
      this.precipitation = { field: setup.precipitation.field, position };
    }
    this.temperatureField = field(`${this.id}:temperature`, 'temperature', 'K');
    this.wetnessField = field(`${this.id}:wetness`, 'relativeWetness', '1');
    this.energyFluxField = field(`${this.id}:energy`, 'heatFlux', 'W/m^2');
    this.waterFluxField = field(`${this.id}:water`, 'surfaceWaterFlux', 'kg/(m^2 s)');
    this.fuelMoistureField = field(`${this.id}:fuel`, 'fuelMoisture', '1');
  }

  /** Loads the optional native surface batch and its requested helpers. */
  static async load(
    setup: SurfaceEnergySetup = {},
    options: SurfaceEnergyLoadOptions = {},
  ): Promise<SurfaceEnergySolver> {
    if (!options || typeof options !== 'object') throw invalid('Provide surface energy loading options or omit them.');
    const solver = new SurfaceEnergySolver(setup);
    const { loadSurfaceEnergyKernel } = await import('./surface-energy-native.js');
    solver.native = await loadSurfaceEnergyKernel(options);
    return solver;
  }

  describe(): SolverDescription {
    const inputs = new Map(this.inputs.map(([, input]) => [input.field.name, input.field]));
    const fields: FieldUse[] = [...inputs.values()].map((field) => ({ field, access: 'read' }));
    fields.push(...this.outputs().map((field): FieldUse => ({ field, access: 'write' })));
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, options: SurfaceEnergyOptions = {}): void {
    if (this.disposed) throw new MargoError('disposed', 'Surface energy is disposed; create or load a new solver.');
    if (!options || typeof options !== 'object')
      throw invalid('Supply surface energy options as an object or omit them.');
    const grid = options.grid && gridShape(options.grid);
    const count = grid?.count ?? 1;
    const patches = Array.from({ length: count }, (_, patch) =>
      patchConfig({ ...options, ...options.grid?.patches?.[patch] }),
    );
    const allocate = (name: string, words: number) => host.allocate(name, words * WORD, 'f64', LAYOUT);
    const regions = {
      temperature: allocate('temperature', count),
      storage: allocate('storage', 3 * count),
      wetness: allocate('wetness', count),
      energy: allocate('energy-flux', 5 * count),
      water: allocate('water-flux', 3 * count),
      fuel: allocate('fuel-moisture', 3 * count),
      cell: allocate('cell', 3),
    };
    const temperature = view(host, regions.temperature);
    const storage = view(host, regions.storage);
    const wetness = view(host, regions.wetness);
    const fuel = view(host, regions.fuel);
    for (let patch = 0; patch < count; patch++) {
      const config = patches[patch]!;
      const forcing = config.forcing;
      temperature[patch] = config.initialTemperature;
      storage.set([config.initialWater, config.initialSnow, 0], patch * 3);
      wetness[patch] = config.initialWater / config.waterCapacity;
      const target = fuelMoistureTarget(
        { humidity: forcing.humidity, temperature: forcing.airTemperature - FREEZING, cloud: forcing.cloud, rain: 0 },
        0,
        forcing.shortwave > 0,
      );
      fuel.set(
        [
          checked('initial one-hour fuel moisture', target.moisture),
          checked('initial ten-hour fuel moisture', target.moisture10),
          checked('initial hundred-hour fuel moisture', target.moisture100),
        ],
        patch * 3,
      );
    }
    view(host, regions.cell).set(host.cell);
    this.state = {
      host,
      regions,
      grid,
      patches,
      stagedForcing: patches.map(({ forcing }) => ({ ...forcing })),
      staged: {
        temperature: new Float64Array(count),
        storage: new Float64Array(3 * count),
        wetness: new Float64Array(count),
        energy: new Float64Array(5 * count),
        water: new Float64Array(3 * count),
        fuel: new Float64Array(3 * count),
      },
      input: new Float64Array(INPUT_WORDS * count),
      output: new Float64Array(OUTPUT_WORDS * count),
    };
    this.work = undefined;
  }

  step(context: StepContext, dt: number): void {
    const state = this.requireState();
    const { host, regions, grid, patches, stagedForcing, staged, input, output } = state;
    const tick = context.tick;
    const time = (tick + 1) * dt;
    if (
      !(
        dt > 0 &&
        Number.isFinite(dt) &&
        Number.isSafeInteger(tick + 1) &&
        tick >= 0 &&
        Number.isFinite(time) &&
        time > tick * dt
      )
    )
      throw invalid('The surface energy clock cannot advance. Use a finite step and a valid world tick.');

    const temperature = view(host, regions.temperature);
    const storage = view(host, regions.storage);
    const fuel = view(host, regions.fuel);
    const precipitation = this.precipitation;
    let gridOrigin: Cell | undefined;
    if (grid && precipitation) {
      const cell = precipitation.field.cell;
      if (cell?.length !== 3 || ![cell[0], cell[1], cell[2]].every(Number.isSafeInteger))
        throw invalid('Provide three signed, whole cell coordinates for the precipitation field.');
      gridOrigin = [
        grid.origin[0] + fieldOffset(context.cell[0], cell[0], grid.cellSize),
        grid.origin[1] + fieldOffset(context.cell[1], cell[1], grid.cellSize),
        grid.origin[2] + fieldOffset(context.cell[2], cell[2], grid.cellSize),
      ];
    }
    for (let patch = 0; patch < patches.length; patch++) {
      const config = patches[patch]!;
      const forcing = stagedForcing[patch]!;
      Object.assign(forcing, config.forcing);
      if (precipitation) {
        const { field, position = ORIGIN } = precipitation;
        const location =
          grid && gridOrigin
            ? ([
                gridOrigin[0] + (patch % grid.columns) * grid.spacing[0],
                gridOrigin[1],
                gridOrigin[2] + Math.floor(patch / grid.columns) * grid.spacing[1],
              ] as const)
            : position;
        const [x, y, z] = point(location, 'surface precipitation sample');
        const sample = field.sample(x, y, z, time);
        const rain = checked('precipitation rain rate', sample?.rain?.rate);
        const snow = checked('precipitation snow rate', sample?.snow?.rate);
        const graupel = checked('precipitation graupel rate', sample?.graupel?.rate);
        const hail = checked('precipitation hail rate', sample?.hail?.rate);
        forcing.rain = checkForcing('rain', rain / 3.6e6);
        forcing.snow = checkForcing('snow', (snow + graupel + hail) / 3.6e6);
      }
      for (const [key, source] of this.inputs) {
        const port = context.inputs.get(source.field.name);
        if (port) forcing[key] = checkForcing(key, inputValue(host.memory, source, port, context, patch));
      }

      const at = patch * 3;
      const before = positive('accepted surface temperature', temperature[patch]!);
      const liquid = checked('rain and stored liquid', storage[at]! + dt * (forcing.rain * WATER_DENSITY));
      const snow = checked('snowfall and stored snow', storage[at + 1]! + dt * (forcing.snow * WATER_DENSITY));
      const rainHours = checked('rain duration', forcing.rain > 0 ? storage[at + 2]! + dt / 3600 : 0);
      staged.storage.set([liquid, snow, rainHours], at);
      const { airTemperature, pressure, humidity, deepTemperature, aerodynamicResistance, surfaceResistance } = forcing;
      const density = pressure / (DRY_AIR_GAS_CONSTANT * airTemperature);
      const humidityAir = specificHumidity(humidity * saturationPressure(airTemperature, pressure), pressure);
      const sensible = (density * AIR_HEAT_CAPACITY) / aerodynamicResistance;
      const vapour = density / (aerodynamicResistance + surfaceResistance);
      const emission = config.emissivity * STEFAN_BOLTZMANN;
      const incoming = (1 - forcing.albedo) * forcing.shortwave + config.emissivity * forcing.longwave;
      const capacityRate = positive('heat capacity per step second', config.heatCapacity / dt);
      const values = [
        before,
        liquid / dt,
        snow / dt,
        pressure,
        humidityAir,
        airTemperature,
        deepTemperature,
        sensible,
        vapour,
        config.groundConductance,
        emission,
        incoming,
        capacityRate,
      ];
      if (!values.every(Number.isFinite))
        throw invalid(
          'Surface energy forcing exceeds floating-point range. Reduce fluxes, reservoirs or material extremes.',
        );
      input.set(values, patch * INPUT_WORDS);
    }

    const work = this.native?.step(input, output);
    if (!this.native) for (let patch = 0; patch < patches.length; patch++) solvePatch(input, output, patch);

    for (let patch = 0; patch < patches.length; patch++) {
      const config = patches[patch]!;
      const forcing = stagedForcing[patch]!;
      const at = patch * 3;
      const start = patch * OUTPUT_WORDS;
      const surface = positive('predicted surface temperature', output[start]!);
      const evaporation = checked('predicted evaporation', output[start + 1]!, -Infinity);
      const melt = checked('predicted melt rate', output[start + 2]!);
      const meltHeat = checked('predicted melt heat', output[start + 3]!);
      const liquid = staged.storage[at]!;
      const snow = staged.storage[at + 1]!;
      const rainHours = staged.storage[at + 2]!;
      const evaporatedMass = checked('evaporated mass', evaporation * dt, -Infinity);
      const meltedMass = checked('melted mass', melt * dt);
      // Debit evaporation before melt. Meltwater becomes available for evaporation on the next step.
      const waterAfterFluxes = checked('water after fluxes', Math.max(0, liquid - evaporatedMass) + meltedMass);
      const runoff = checked('runoff', Math.max(0, waterAfterFluxes - config.waterCapacity) / dt);
      const target = fuelMoistureTarget(
        {
          humidity: forcing.humidity,
          temperature: forcing.airTemperature - FREEZING,
          cloud: forcing.cloud,
          rain: forcing.rain,
        },
        rainHours,
        forcing.shortwave > 0,
      );
      const targets = [target.moisture, target.moisture10, target.moisture100];
      for (let i = 0; i < FUEL_TIMELAGS.length; i++) {
        const equilibrium = targets[i]!;
        staged.fuel[at + i] = checked(
          'fuel moisture',
          equilibrium + (fuel[at + i]! - equilibrium) * exp(-dt / (3600 * FUEL_TIMELAGS[i]!)),
        );
      }
      const water = Math.min(waterAfterFluxes, config.waterCapacity);
      staged.temperature[patch] = surface;
      staged.storage.set([water, Math.max(0, snow - meltedMass), rainHours], at);
      staged.wetness[patch] = water / config.waterCapacity;
      const prepared = patch * INPUT_WORDS;
      const energy = [
        input[prepared + 11]! - input[prepared + 10]! * fourthPower(surface),
        input[prepared + 7]! * (surface - forcing.airTemperature),
        evaporation * LATENT_VAPOR,
        config.groundConductance * (surface - forcing.deepTemperature),
        meltHeat,
      ];
      if (!energy.every(Number.isFinite))
        throw invalid('The surface heat ledger exceeds floating-point range. Reduce temperature or fluxes.');
      staged.energy.set(energy, patch * 5);
      staged.water.set([evaporation, melt, runoff], at);
    }
    for (const field of ['temperature', 'storage', 'wetness', 'energy', 'water', 'fuel'] as const)
      view(host, regions[field]).set(staged[field]);
    view(host, regions.cell).set(context.cell);
    this.work = work;
  }

  importPorts(): void {
    // Inputs arrive in StepContext as registry mirrors of the current coupling tick.
  }

  exportPorts(tick: number): readonly Port[] {
    const { host, regions } = this.requireState();
    const cell = host.cell;
    const published = [regions.temperature, regions.wetness, regions.energy, regions.water, regions.fuel];
    return this.outputs().map((field, index) => ({ field: field.name, region: published[index]!, tick, cell }));
  }

  stateRegions(): readonly Region[] {
    return Object.values(this.requireState().regions);
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Copies the latest state of the first patch, including its initialized state before any ticks. */
  read(): SurfaceEnergySample {
    return this.readPatch(0);
  }

  /** Copies one patch by its zero-based X-fast index. */
  readPatch(index: number): SurfaceEnergySample {
    const { host, regions, patches } = this.requireState();
    if (!Number.isSafeInteger(index) || index < 0 || index >= patches.length)
      throw invalid('Choose a configured surface patch by its zero-based X-fast index.');
    const storage = view(host, regions.storage);
    const energy = view(host, regions.energy);
    const water = view(host, regions.water);
    const fuel = view(host, regions.fuel);
    const at = index * 3;
    const heat = index * 5;
    return {
      temperature: view(host, regions.temperature)[index]!,
      water: storage[at]!,
      snow: storage[at + 1]!,
      wetness: view(host, regions.wetness)[index]!,
      netRadiation: energy[heat]!,
      sensible: energy[heat + 1]!,
      latent: energy[heat + 2]!,
      ground: energy[heat + 3]!,
      meltHeat: energy[heat + 4]!,
      evaporation: water[at]!,
      melt: water[at + 1]!,
      runoff: water[at + 2]!,
      fuelMoisture: [fuel[at]!, fuel[at + 1]!, fuel[at + 2]!],
    };
  }

  /** Returns work from the latest accepted native step computed by this instance, if present. */
  workCounts(): SurfaceEnergyWorkCounts | undefined {
    this.requireState();
    return this.work;
  }

  /** Releases optional native helpers after the last surface step. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.native?.close();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private outputs(): readonly FieldDescriptor[] {
    return [
      this.temperatureField,
      this.wetnessField,
      this.energyFluxField,
      this.waterFluxField,
      this.fuelMoistureField,
    ];
  }

  private requireState() {
    if (this.disposed) throw new MargoError('disposed', 'Surface energy is disposed; create or load a new solver.');
    if (!this.state)
      throw new MargoError(
        'state',
        'Surface energy is uninitialized; add the solver to a PhysicsWorld before using it.',
      );
    return this.state;
  }
}
