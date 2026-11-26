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

/** Fixed coupling inputs and the patch ID. Use separate instances for independently forced patches. */
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

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'scalarSeries', quantity, unit, centring: 'cell' };
}

function checked(name: string, value: number, minimum = 0, maximum = Infinity): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError(
      `Invalid surface energy ${name}; pass a finite value from ${minimum} to ${maximum} in the documented units.`,
    );
  return value;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`Invalid surface energy ${name}; pass a positive finite value in the documented units.`);
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

function inputValue(memory: WebAssembly.Memory, input: SurfaceEnergyInput, port: Port, context: StepContext): number {
  if (input.sample) return input.sample(memory, port, context);
  const region = port.region;
  const index = input.word ?? 0;
  const width = region.type === 'f64' ? 8 : 4;
  if (
    (region.type !== 'f32' && region.type !== 'f64') ||
    region.layout !== LAYOUT ||
    index >= region.byteLength / width
  )
    throw new RangeError(
      `Invalid ${port.field} surface energy port; publish its layout-1 floating-point word or pass a sample projection.`,
    );
  const view = new DataView((region.memory ?? memory).buffer, region.byteOffset, region.byteLength);
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

function view(host: SolverHost, region: Region): Float64Array {
  return new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / WORD);
}

/**
 * Implicit land-surface energy balance and a conservative snow and soil-water column on the physics world clock.
 * Each instance owns a local temperature, water store and dead-fuel response.
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
  private state?: {
    readonly host: SolverHost;
    readonly regions: SurfaceRegions;
    readonly forcing: Required<SurfaceEnergyForcing>;
    readonly heatCapacity: number;
    readonly groundConductance: number;
    readonly emissivity: number;
    readonly waterCapacity: number;
  };

  constructor(setup: SurfaceEnergySetup = {}) {
    this.id = setup.id ?? 'surface-energy';
    this.inputs = FORCING_KEYS.flatMap((key) => {
      const input = setup.inputs?.[key];
      if (!input) return [];
      if (input.field.unit !== INPUT_UNITS[key])
        throw new RangeError(`Invalid surface energy ${key} unit; bind a field in ${INPUT_UNITS[key]}.`);
      if (input.word !== undefined && (!Number.isSafeInteger(input.word) || input.word < 0))
        throw new RangeError(`Invalid surface energy ${key} word; pass a nonnegative integer index.`);
      return [[key, { ...input, field: { ...input.field } }] as const];
    });
    if (setup.precipitation) {
      const position = setup.precipitation.position ?? ORIGIN;
      for (const coordinate of position)
        if (!Number.isFinite(coordinate))
          throw new RangeError(
            'Invalid surface precipitation position; supply three finite coordinates in its field cell.',
          );
      this.precipitation = { field: setup.precipitation.field, position: [...position] };
    }
    this.temperatureField = field(`${this.id}:temperature`, 'temperature', 'K');
    this.wetnessField = field(`${this.id}:wetness`, 'relativeWetness', '1');
    this.energyFluxField = field(`${this.id}:energy`, 'heatFlux', 'W/m^2');
    this.waterFluxField = field(`${this.id}:water`, 'surfaceWaterFlux', 'kg/(m^2 s)');
    this.fuelMoistureField = field(`${this.id}:fuel`, 'fuelMoisture', '1');
  }

  describe(): SolverDescription {
    const inputs = new Map(this.inputs.map(([, input]) => [input.field.name, input.field]));
    const fields: FieldUse[] = [...inputs.values()].map((field) => ({ field, access: 'read' }));
    fields.push(...this.outputs().map((field): FieldUse => ({ field, access: 'write' })));
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, options: SurfaceEnergyOptions = {}): void {
    const forcing = { ...DEFAULT_FORCING };
    for (const key of FORCING_KEYS) forcing[key] = checkForcing(key, options[key] ?? forcing[key]);
    const heatCapacity = positive('heatCapacity', options.heatCapacity ?? 250000);
    const groundConductance = checked('groundConductance', options.groundConductance ?? 5);
    const emissivity = checked('emissivity', options.emissivity ?? 0.97, 0, 1);
    const waterCapacity = positive('waterCapacity', options.waterCapacity ?? 15);
    const temperature = positive('initialTemperature', options.initialTemperature ?? forcing.airTemperature);
    const liquid = checked('initialWater', options.initialWater ?? 0.25 * waterCapacity, 0, waterCapacity);
    const snow = checked('initialSnow', options.initialSnow ?? 0);
    const allocate = (name: string, words: number) => host.allocate(name, words * WORD, 'f64', LAYOUT);
    const regions = {
      temperature: allocate('temperature', 1),
      storage: allocate('storage', 3),
      wetness: allocate('wetness', 1),
      energy: allocate('energy-flux', 5),
      water: allocate('water-flux', 3),
      fuel: allocate('fuel-moisture', 3),
      cell: allocate('cell', 3),
    };
    this.state = {
      host,
      regions,
      forcing,
      heatCapacity,
      groundConductance,
      emissivity,
      waterCapacity,
    };
    view(host, regions.temperature)[0] = temperature;
    view(host, regions.storage).set([liquid, snow, 0]);
    view(host, regions.wetness)[0] = liquid / waterCapacity;
    const fuel = fuelMoistureTarget(
      { humidity: forcing.humidity, temperature: forcing.airTemperature - FREEZING, cloud: forcing.cloud, rain: 0 },
      0,
      forcing.shortwave > 0,
    );
    view(host, regions.fuel).set([fuel.moisture, fuel.moisture10, fuel.moisture100]);
  }

  step(context: StepContext, dt: number): void {
    const config = this.requireState();
    const { host, regions } = config;
    const forcing = { ...config.forcing };
    if (this.precipitation) {
      const { field, position = ORIGIN } = this.precipitation;
      const time = context.tick * dt;
      const sample = field.sample(position[0], position[1], position[2], time);
      forcing.rain = checkForcing('rain', sample.rain.rate / 3.6e6);
      forcing.snow = checkForcing('snow', (sample.snow.rate + sample.graupel.rate + sample.hail.rate) / 3.6e6);
    }
    for (const [key, input] of this.inputs) {
      const port = context.inputs.get(input.field.name);
      if (port) forcing[key] = checkForcing(key, inputValue(host.memory, input, port, context));
    }

    const temperature = view(host, regions.temperature);
    const storage = view(host, regions.storage);
    const before = temperature[0]!;
    const liquid = checked('rain and stored liquid', storage[0]! + dt * (forcing.rain * WATER_DENSITY));
    const snow = checked('snowfall and stored snow', storage[1]! + dt * (forcing.snow * WATER_DENSITY));
    const rainHours = forcing.rain > 0 ? storage[2]! + dt / 3600 : 0;
    const { airTemperature, pressure, humidity, deepTemperature, aerodynamicResistance, surfaceResistance } = forcing;
    const density = pressure / (DRY_AIR_GAS_CONSTANT * airTemperature);
    const humidityAir = specificHumidity(humidity * saturationPressure(airTemperature, pressure), pressure);
    const sensible = (density * AIR_HEAT_CAPACITY) / aerodynamicResistance;
    const vapour = density / (aerodynamicResistance + surfaceResistance);
    const conductance = config.groundConductance;
    const emission = config.emissivity * STEFAN_BOLTZMANN;
    const incoming = (1 - forcing.albedo) * forcing.shortwave + config.emissivity * forcing.longwave;
    const capacityRate = config.heatCapacity / dt;
    const evaporate = (t: number) =>
      Math.min(liquid / dt, vapour * (specificHumidity(saturationPressure(t, pressure), pressure) - humidityAir));
    const balance = (t: number) =>
      capacityRate * (t - before) -
      incoming +
      emission * fourthPower(t) +
      sensible * (t - airTemperature) +
      conductance * (t - deepTemperature) +
      LATENT_VAPOR * evaporate(t);

    const meltHeatLimit = (snow / dt) * LATENT_FUSION;
    const energyAtFreezing = snow > 0 ? balance(FREEZING) : 0;
    const meltHeat = Math.min(meltHeatLimit, Math.max(0, -energyAtFreezing));
    let surface = FREEZING;
    if (!(meltHeat > 0 && meltHeat < meltHeatLimit)) {
      // Above all boundary temperatures and this incoming-energy bound the residual must be nonnegative.
      let lo = 0;
      let hi =
        Math.max(before, airTemperature, deepTemperature) +
        (incoming + LATENT_VAPOR * vapour * humidityAir) / capacityRate;
      if (!Number.isFinite(hi) || !Number.isFinite(balance(hi)))
        throw new RangeError(
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
    const melt = meltHeat === meltHeatLimit ? snow / dt : meltHeat / LATENT_FUSION;
    const evaporation = evaporate(surface);
    // Debit evaporation before melt. A snowmelt pulse joins the available liquid on the next step.
    const waterAfterFluxes = Math.max(0, liquid - evaporation * dt) + dt * melt;
    const runoff = Math.max(0, waterAfterFluxes - config.waterCapacity) / dt;
    const target = fuelMoistureTarget(
      { humidity, temperature: airTemperature - FREEZING, cloud: forcing.cloud, rain: forcing.rain },
      rainHours,
      forcing.shortwave > 0,
    );
    const fuel = view(host, regions.fuel);
    const targets = [target.moisture, target.moisture10, target.moisture100];
    for (let i = 0; i < FUEL_TIMELAGS.length; i++) {
      const equilibrium = targets[i]!;
      fuel[i] = equilibrium + (fuel[i]! - equilibrium) * exp(-dt / (3600 * FUEL_TIMELAGS[i]!));
    }
    const water = Math.min(waterAfterFluxes, config.waterCapacity);
    temperature[0] = surface;
    storage.set([water, Math.max(0, snow - dt * melt), rainHours]);
    view(host, regions.wetness)[0] = water / config.waterCapacity;
    view(host, regions.energy).set([
      incoming - emission * fourthPower(surface),
      sensible * (surface - airTemperature),
      evaporation * LATENT_VAPOR,
      conductance * (surface - deepTemperature),
      meltHeat,
    ]);
    view(host, regions.water).set([evaporation, melt, runoff]);
    view(host, regions.cell).set(context.cell);
  }

  importPorts(): void {
    // Inputs arrive in StepContext as registry mirrors of the current coupling tick.
  }

  exportPorts(tick: number): readonly Port[] {
    const { host, regions } = this.requireState();
    const cell = view(host, regions.cell);
    const origin: Cell = [cell[0]!, cell[1]!, cell[2]!];
    const published = [regions.temperature, regions.wetness, regions.energy, regions.water, regions.fuel];
    return this.outputs().map((field, index) => ({ field: field.name, region: published[index]!, tick, cell: origin }));
  }

  stateRegions(): readonly Region[] {
    return Object.values(this.requireState().regions);
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Copies the latest state, including the initialized temperature and storage before any ticks. */
  read(): SurfaceEnergySample {
    const { host, regions } = this.requireState();
    const storage = view(host, regions.storage);
    const energy = view(host, regions.energy);
    const water = view(host, regions.water);
    const fuel = view(host, regions.fuel);
    return {
      temperature: view(host, regions.temperature)[0]!,
      water: storage[0]!,
      snow: storage[1]!,
      wetness: view(host, regions.wetness)[0]!,
      netRadiation: energy[0]!,
      sensible: energy[1]!,
      latent: energy[2]!,
      ground: energy[3]!,
      meltHeat: energy[4]!,
      evaporation: water[0]!,
      melt: water[1]!,
      runoff: water[2]!,
      fuelMoisture: [fuel[0]!, fuel[1]!, fuel[2]!],
    };
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
    if (!this.state)
      throw new MargoError(
        'state',
        'Surface energy is uninitialized; add the solver to a PhysicsWorld before using it.',
      );
    return this.state;
  }
}
