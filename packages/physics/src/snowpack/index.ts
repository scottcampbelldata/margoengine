import type { Wind } from '@margoengine/math/fields';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { exp, ln, pow } from '@margoengine/math/pinned';
import { BED_FIELD, BED_LAYOUT } from '../earth/bed.js';
import { regionWords } from '../world/memory.js';
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

import { snowpackError } from './errors.js';
import { bindSnowpackKernel, loadSnowpackBuilds, type SnowpackBuilds, type SnowpackWorkCounts } from './kernel.js';

export type { SnowpackWorkCounts, SnowpackWorkerWork } from './kernel.js';

const FREEZING = 273.15;
const FUSION = 333700;
const ICE_CP = 2100;
const LAYOUT = 1;
const INPUT = 11;
const OUTPUT = 12;

/** A scalar over the pack or a row-major array with x increasing fastest. */
export type SnowpackGridValue = number | ArrayLike<number>;

/** The starting state at one vertical level. Levels are ordered top to bottom. */
export interface SnowpackLayer {
  /** Total water equivalent as mass, kg/m². */
  readonly mass: SnowpackGridValue;
  /** Dry snow density, kg/m³. Default 250. */
  readonly density?: SnowpackGridValue;
  /** Temperature in K, at or below the melting point. Default 268.15. */
  readonly temperature?: SnowpackGridValue;
  /** Fraction of the mass in liquid phase. Default zero. Give wet layers a temperature of 273.15 K. */
  readonly liquidFraction?: SnowpackGridValue;
  /** Cohesion of the contact above this layer, in Pa. Default 150. */
  readonly cohesion?: SnowpackGridValue;
  /** Compaction viscosity in Pa·s. The default uses the fresh-snow density and temperature law as an effective value. */
  readonly viscosity?: SnowpackGridValue;
}

/** The immutable plan-view grid and the initial snowpack, climate and material parameters. */
export interface SnowpackParams {
  /** Number of columns along X and Z, each positive. */
  readonly width: number;
  readonly depth: number;
  /** Horizontal sample spacing, metres. Defaults to 1. */
  readonly cellSize?: number;
  /** Position of the first column centre in the world cell, metres. Defaults to [0, 0]. */
  readonly origin?: readonly [number, number];
  /** Ground elevation under each column, metres. Default 0. A bound TerrainBed overrides it. */
  readonly ground?: SnowpackGridValue;
  /** Initial layers under the fresh surface layer. Default bare ground. */
  readonly layers?: readonly SnowpackLayer[];
  /** Solid accumulation as water mass rate, kg/(m² s). Default zero. */
  readonly snowfall?: SnowpackGridValue;
  /** Liquid precipitation, kg/(m² s). Default zero. */
  readonly rain?: SnowpackGridValue;
  /** Net surface and basal heat into the pack, W/m². Each defaults to zero. */
  readonly topHeat?: SnowpackGridValue;
  readonly bottomHeat?: SnowpackGridValue;
  /** Air and incoming precipitation temperature, K. Default 268.15. */
  readonly airTemperature?: SnowpackGridValue;
  /** New-snow density, kg/m³. The default uses the Hedstrom–Pomeroy relation. */
  readonly freshDensity?: SnowpackGridValue;
  /** Root or shelter support stress on a slipping interface, Pa. Default zero. */
  readonly support?: SnowpackGridValue;
  /** Irreducible liquid fraction of pore volume. Default 0.07. */
  readonly retention?: number;
  /** Dry sliding friction on a potential release interface. Default 0.3. */
  readonly slabFriction?: number;
  /** Fresh layer interface cohesion, Pa. Default 150. */
  readonly freshCohesion?: number;
  /** Dry exposed snow's threshold friction velocity, m/s. Default 0.2. */
  readonly windThreshold?: number;
  /** Prescribed friction velocity on X and Z in m/s. Default still air. */
  readonly frictionVelocity?: readonly [number, number];
  /** A pure wind field. When supplied, it is sampled 10 m above the ground and reduced by a log profile. */
  readonly wind?: Wind;
  /** Roughness length for wind extrapolation, metres. Default 0.0001. */
  readonly roughness?: number;
  /** Wind/terrain world-cell size, metres. Default 4096. */
  readonly worldCellSize?: number;
  /** Minimum lee drop divided by sample spacing for cornice collection. Default 1. */
  readonly cliffSlope?: number;
  /** Fraction of the cross-ridge drift captured by the overhang. Default 0.05. */
  readonly corniceEfficiency?: number;
  /** Effective overhang thickness, metres. Default 0.1. */
  readonly corniceThickness?: number;
  /** Compacted overhang density, kg/m³. Default 300. */
  readonly corniceDensity?: number;
  /** Upper accretion wind divided by the drift threshold. Stronger wind scours the rim. Default 2. */
  readonly corniceUpperRatio?: number;
  /** Simulated seconds per world second. Default one. Published fluxes integrate on the world clock. */
  readonly secondsPerSecond?: number;
}

type InputName = 'snowfall' | 'rain' | 'airTemperature' | 'topHeat' | 'bottomHeat' | 'support';
const SOURCES: Record<InputName, { offset: number; unit: string; min: number }> = {
  snowfall: { offset: 1, unit: 'kg/(m^2 s)', min: 0 },
  rain: { offset: 2, unit: 'kg/(m^2 s)', min: 0 },
  airTemperature: { offset: 3, unit: 'K', min: Number.MIN_VALUE },
  topHeat: { offset: 4, unit: 'W/m^2', min: -Infinity },
  bottomHeat: { offset: 5, unit: 'W/m^2', min: -Infinity },
  support: { offset: 10, unit: 'Pa', min: 0 },
};

/** A layout-1 f64/f32 source on this grid or a uniform scalar port. */
export interface SnowpackInput {
  readonly field: FieldDescriptor;
  /** Words per column (or for the scalar patch). Default one. */
  readonly stride?: number;
  /** Weights applied to consecutive words. Default [1]. For ATMO-09 net atmospheric heating use [1, -1, -1]. */
  readonly weights?: readonly number[];
}

/** Bind cross-solver forcing without taking ownership of its publisher. */
export interface SnowpackLoadOptions {
  readonly id?: string;
  readonly signal?: AbortSignal;
  /** Native participants including the caller. Use 1 (default), 2 or 4 with shared memory. */
  readonly threads?: number;
  readonly inputs?: Readonly<Partial<Record<InputName, SnowpackInput>>>;
  /** Read heights from a same-cell TerrainBed with the same cell counts and spacing. Default false. */
  readonly followTerrain?: boolean;
}

/** A physical column at the current world tick. */
export interface SnowpackSample {
  /** Stored total and liquid water masses, kg/m². */
  readonly mass: number;
  readonly liquid: number;
  readonly temperature: number;
  readonly depth: number;
  /** Least static strength / driving stress over the interfaces, or Infinity without downslope load. */
  readonly stability: number;
  readonly slabDepth: number;
  /** Water equivalent of the unstable slab, kg/m². */
  readonly slabMass: number;
  /** Overhang vector in metres along X and Z. */
  readonly cornice: readonly [number, number];
  /** Mass per horizontal area already included in the snowpack, kg/m². */
  readonly corniceMass: number;
  /** Drainage to the ground, m/s liquid equivalent. */
  readonly runoff: number;
  /** Forcing that reached bare ground and energy carried out by drainage, W/m². */
  readonly unusedHeat: number;
  readonly runoffHeat: number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: ReturnType<typeof bindSnowpackKernel>;
  readonly width: number;
  readonly depth: number;
  readonly spacing: number;
  readonly origin: readonly [number, number];
  readonly count: number;
  readonly layers: number;
  readonly timeScale: number;
  readonly wind?: Wind;
  readonly windToFriction: number;
  readonly worldCellSize: number;
  readonly pack: Region;
  readonly cornices: Region;
  readonly drift: Region;
  readonly forcing: Region;
  readonly defaults: Region;
  readonly viscosity: Region;
  readonly prescribedViscosity: Region;
  readonly cohesion: Region;
  readonly priorIce: Region;
  readonly config: Region;
  readonly runoff: Region;
  readonly discharge: Region;
  readonly summary: Region;
  readonly cover: Region;
  readonly clock: Region;
  readonly stagedForcing: Float64Array;
  readonly trial: Pick<State, 'pack' | 'cornices' | 'runoff' | 'discharge' | 'summary' | 'cover'>;
}

function checked(label: string, value: number, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw snowpackError(`Invalid snowpack ${label}; pass finite values from ${min} to ${max} in the documented units.`);
  return value;
}

function gridValue(value: SnowpackGridValue, i: number, n: number, name: string, min?: number, max?: number): number {
  if (typeof value !== 'number' && value?.length !== n)
    throw snowpackError(`Invalid snowpack ${name} length; supply a scalar or ${n} column values.`);
  return checked(name, typeof value === 'number' ? value : value[i]!, min, max);
}

function words(s: State, region: Region): Float64Array {
  return regionWords(s.host.memory, region) as Float64Array;
}

function inputWords(s: State, port: Port) {
  try {
    return regionWords(port.region.memory ?? s.host.memory, port.region);
  } catch (cause) {
    throw snowpackError(
      'The snowpack input region is outside or misaligned. Publish its region with the memory that owns it.',
      'state',
      cause,
    );
  }
}

function descriptor(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, quantity, unit, kind: 'uniformGrid', centring: 'cell' };
}

/** Layered snow mass, enthalpy and settling with conservative surface drift and runoff. */
export class Snowpack implements Solver<SnowpackParams> {
  readonly runoffField: FieldDescriptor;
  /** Layout-1 f64 outlet volumes per second in m³/s, for HYDRO-01 source cells. */
  readonly dischargeField: FieldDescriptor;
  /** Layout-1 f32 ground and snow depth per column, row-major along X. */
  readonly coverField: FieldDescriptor;
  /** Layout-1 f64 diagnostics in the order documented by the snowpack field layout. */
  readonly columnField: FieldDescriptor;
  private readonly id: string;
  private readonly followTerrain: boolean;
  private readonly inputs: readonly (readonly [InputName, Required<SnowpackInput>])[];
  private readonly flowSample = { velocity: [0, 0, 0] as [number, number, number], density: 0, temperature: 0 };
  private state?: State;
  private stepping = false;
  private disposed = false;
  private nativeWork?: SnowpackWorkCounts;

  private constructor(
    private readonly builds: SnowpackBuilds,
    options: SnowpackLoadOptions,
  ) {
    this.id = options.id ?? 'snowpack';
    this.followTerrain = options.followTerrain ?? false;
    this.runoffField = descriptor(`${this.id}:runoff`, 'waterFlux', 'm/s');
    this.dischargeField = descriptor(`${this.id}:discharge`, 'volumeFlux', 'm^3/s');
    this.coverField = descriptor(`${this.id}:cover`, 'height', 'm');
    this.columnField = descriptor(`${this.id}:columns`, 'snowpackColumn', 'record');
    this.inputs = (Object.keys(SOURCES) as InputName[]).flatMap((name) => {
      const input = options.inputs?.[name];
      if (!input) return [];
      if (!(typeof input.field?.name === 'string' && input.field.name.length > 0))
        throw snowpackError('A snowpack input needs a registered field. Pass its field descriptor.');
      const unit = SOURCES[name].unit;
      const waterEquivalent = (name === 'rain' || name === 'snowfall') && input.field.unit === 'm/s';
      if (!waterEquivalent && input.field.unit !== unit)
        throw snowpackError(`Invalid snowpack ${name} field; bind a field with unit ${unit}.`);
      const weights = [...(input.weights ?? [1])];
      const stride = input.stride ?? weights.length;
      if (
        !Number.isSafeInteger(stride) ||
        stride < weights.length ||
        weights.length === 0 ||
        !weights.every(Number.isFinite)
      )
        throw snowpackError(
          `Invalid snowpack ${name} input layout; give finite weights and a stride of at least their count.`,
        );
      if (waterEquivalent) for (let i = 0; i < weights.length; i++) weights[i]! *= 1000;
      return [[name, { field: { ...input.field }, stride, weights }] as const];
    });
  }

  /** Load the optional native kernels for the available memory modes. */
  static async load(options: SnowpackLoadOptions = {}): Promise<Snowpack> {
    const id = options.id ?? 'snowpack';
    if (!(typeof id === 'string' && id.trim().length > 0))
      throw snowpackError('A snowpack solver ID must be nonempty. Pass a unique name.');
    const builds = await loadSnowpackBuilds(options.signal, options.threads);
    try {
      return new Snowpack(builds, options);
    } catch (cause) {
      builds[Symbol.dispose]();
      throw cause;
    }
  }

  /** Release optional helper threads after the world finishes using this solver. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.builds[Symbol.dispose]();
  }

  describe(): SolverDescription {
    const inputs = new Map(this.inputs.map(([, { field }]) => [field.name, field]));
    if (this.followTerrain) inputs.set(BED_FIELD.name, BED_FIELD);
    const fields: FieldUse[] = [...inputs.values()].map((field) => ({ field, access: 'read' }));
    for (const field of [this.runoffField, this.dischargeField, this.coverField, this.columnField])
      fields.push({ field, access: 'write' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, params: SnowpackParams): void {
    if (this.disposed) throw snowpackError('The snowpack solver was disposed. Load a new instance.', 'disposed');
    if (this.state && this.builds.pool)
      throw snowpackError('The snowpack helpers belong to a world. Load a new solver for another world.');
    try {
      this.initialize(host, params);
    } catch (cause) {
      if (this.builds.pool) this[Symbol.dispose]();
      throw cause;
    }
  }

  private initialize(host: SolverHost, params: SnowpackParams): void {
    if (!params) throw snowpackError('Snowpack has no grid; pass width, depth and an optional sample spacing.');
    const { width, depth, wind } = params;
    if (
      wind &&
      !(
        (wind.medium === undefined || wind.medium === 'air') &&
        wind.cell?.length === 3 &&
        wind.cell.every(Number.isSafeInteger) &&
        typeof wind.sample === 'function'
      )
    )
      throw snowpackError(
        'Snowpack wind needs an air field with a valid origin. Pass a Wind with a finite cell and sample method.',
      );
    const count = width * depth;
    const profiles = params.layers ?? [];
    const layers = profiles.length + 1;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(depth) ||
      width < 1 ||
      depth < 1 ||
      !Number.isSafeInteger(count * layers * 24) ||
      count * layers * 24 >= 0x100000000
    )
      throw snowpackError(
        'Invalid snowpack grid; choose positive whole dimensions and layer state within Wasm32 address space.',
      );
    const spacing = checked('sample spacing', params.cellSize ?? 1, Number.MIN_VALUE);
    const roughness = checked('roughness', params.roughness ?? 0.0001, Number.MIN_VALUE, 10);
    if (roughness === 10)
      throw snowpackError('Invalid snowpack roughness; use a length below its 10 m sampling height.');
    const from = params.origin ?? [0, 0];
    const origin = [checked('origin X', from[0]), checked('origin Z', from[1])] as const;
    const settings = [
      checked('gravity', gravityMagnitude(host.gravity), Number.MIN_VALUE),
      spacing,
      checked('liquid retention', params.retention ?? 0.07, 0, 1),
      checked('slab friction', params.slabFriction ?? 0.3, 0),
      checked('wind threshold', params.windThreshold ?? 0.2, Number.MIN_VALUE),
      checked('cornice capture efficiency', params.corniceEfficiency ?? 0.05, 0, 1),
      checked('cliff slope', params.cliffSlope ?? 1, 0),
      checked('cornice thickness', params.corniceThickness ?? 0.1, Number.MIN_VALUE),
      checked('cornice density', params.corniceDensity ?? 300, Number.MIN_VALUE, 917),
      checked('cornice upper wind ratio', params.corniceUpperRatio ?? 2, 1),
    ];
    const kernel = bindSnowpackKernel(host, this.builds);
    const allocate = (name: string, n: number): Region => host.allocate(`snowpack-${name}`, 8 * n, 'f64', LAYOUT);
    const wordsPerPack = count * layers;
    const s: State = {
      host,
      kernel,
      width,
      depth,
      spacing,
      origin,
      count,
      layers,
      wind: params.wind,
      timeScale: checked('time scale', params.secondsPerSecond ?? 1, Number.MIN_VALUE),
      windToFriction: 0.4 / ln(10 / roughness),
      worldCellSize: checked('world cell size', params.worldCellSize ?? 4096, 1),
      pack: allocate('layers', 3 * wordsPerPack),
      cornices: allocate('cornices', 3 * count),
      drift: allocate('drift-pulses', 3 * count),
      forcing: allocate('forcing', INPUT * count),
      defaults: allocate('weather-defaults', INPUT * count),
      viscosity: allocate('viscosity', wordsPerPack),
      prescribedViscosity: allocate('viscosity-overrides', wordsPerPack),
      cohesion: allocate('cohesion', wordsPerPack),
      priorIce: allocate('pre-flux-ice', wordsPerPack),
      config: allocate('config', settings.length),
      runoff: allocate('runoff', count),
      discharge: allocate('discharge', count),
      summary: allocate('summary', OUTPUT * count),
      cover: host.allocate('snowpack-cover', 2 * count * 4, 'f32', LAYOUT),
      clock: allocate('clock', 4),
      stagedForcing: new Float64Array(INPUT * count),
      trial: {
        pack: allocate('trial-pack', 3 * wordsPerPack),
        cornices: allocate('trial-cornices', 3 * count),
        runoff: allocate('trial-runoff', count),
        discharge: allocate('trial-discharge', count),
        summary: allocate('trial-summary', OUTPUT * count),
        cover: host.allocate('snowpack-trial-cover', 2 * count * 4, 'f32', LAYOUT),
      },
    };
    words(s, s.config).set(settings);
    const pack = words(s, s.pack),
      defaults = words(s, s.defaults),
      cohesion = words(s, s.cohesion);
    const override = words(s, s.prescribedViscosity);
    const [u, v] = params.frictionVelocity ?? [0, 0];
    const freshCohesion = checked('fresh cohesion', params.freshCohesion ?? 150, 0);
    for (let i = 0; i < count; i++) {
      const value = (source: SnowpackGridValue, name: string, min?: number, max?: number) =>
        gridValue(source, i, count, name, min, max);
      const temp = value(params.airTemperature ?? 268.15, 'air temperature', Number.MIN_VALUE);
      defaults.set(
        [
          value(params.ground ?? 0, 'ground'),
          value(params.snowfall ?? 0, 'snowfall', 0),
          value(params.rain ?? 0, 'rain', 0),
          temp - FREEZING,
          value(params.topHeat ?? 0, 'surface heat'),
          value(params.bottomHeat ?? 0, 'ground heat'),
          params.freshDensity === undefined ? 0 : value(params.freshDensity, 'fresh density', Number.MIN_VALUE, 917),
          checked('friction X', u),
          checked('friction Z', v),
          1.225,
          value(params.support ?? 0, 'support', 0),
        ],
        INPUT * i,
      );
      cohesion[i * layers] = freshCohesion;
      for (let j = 0; j < profiles.length; j++) {
        const layer = profiles[j]!;
        const mass = value(layer.mass, 'layer mass', 0);
        const density = value(layer.density ?? 250, 'layer density', Number.MIN_VALUE, 917);
        const temperature = value(layer.temperature ?? 268.15, 'layer temperature', Number.MIN_VALUE, FREEZING);
        const liquid = value(layer.liquidFraction ?? 0, 'layer liquid fraction', 0, 1);
        if (liquid > 0 && temperature !== FREEZING)
          throw snowpackError(
            'Invalid wet snow temperature; initialize any liquid water at the melting point (273.15 K).',
          );
        const k = i * layers + j + 1;
        const solid = mass * (1 - liquid);
        pack.set([mass, mass * liquid * FUSION + solid * ICE_CP * (temperature - FREEZING), solid / density], 3 * k);
        cohesion[k] = value(layer.cohesion ?? 150, 'interface cohesion', 0);
        if (layer.viscosity !== undefined) override[k] = value(layer.viscosity, 'layer viscosity', Number.MIN_VALUE);
      }
    }
    this.run(s, { tick: -1, level: 0, seed: 0, cell: host.cell, inputs: new Map() }, 0);
    this.state = s;
    this.nativeWork = undefined;
  }

  importPorts(): void {
    // The scheduler supplies held fields through the step context.
  }

  step(context: StepContext, dt: number): void {
    if (this.disposed) throw snowpackError('The snowpack solver was disposed. Load a new instance.', 'disposed');
    checked('step duration', dt, Number.MIN_VALUE);
    if (this.stepping)
      throw snowpackError(
        'A snowpack field callback re-entered the step. Sample a separate field during the callback.',
      );
    this.stepping = true;
    try {
      this.run(this.requireState(), context, dt);
    } finally {
      this.stepping = false;
    }
  }

  private run(s: State, context: StepContext, dt: number): void {
    const scaledDt = checked('physical step duration', dt * s.timeScale, 0);
    const input = s.stagedForcing;
    input.set(words(s, s.defaults));
    for (const [name, binding] of this.inputs) {
      const port = context.inputs.get(binding.field.name);
      if (!port) continue;
      const region = port.region;
      if (
        region.layout !== LAYOUT ||
        (region.type !== 'f32' && region.type !== 'f64') ||
        !sameCell(port.cell, context.cell)
      )
        throw snowpackError(`Invalid snowpack ${name} input; publish a layout-1 float port in the same world cell.`);
      const values = inputWords(s, port);
      const uniform = values.length === binding.stride;
      if (!uniform && values.length !== binding.stride * s.count)
        throw snowpackError(`Invalid snowpack ${name} input size; send one patch or one value row for each column.`);
      const spec = SOURCES[name];
      for (let i = 0; i < s.count; i++) {
        const start = uniform ? 0 : i * binding.stride;
        let value = 0;
        for (let j = 0; j < binding.weights.length; j++) value += binding.weights[j]! * values[start + j]!;
        input[i * INPUT + spec.offset] = checked(name, value, spec.min) - (name === 'airTemperature' ? FREEZING : 0);
      }
    }
    const bed = this.followTerrain && context.inputs.get(BED_FIELD.name);
    if (bed) {
      const region = bed.region;
      if (
        region.type !== 'f32' ||
        region.layout !== BED_LAYOUT ||
        region.byteLength !== 4 * (s.width + 1) * (s.depth + 1) ||
        !sameCell(bed.cell, context.cell)
      )
        throw snowpackError('Invalid snowpack terrain port; attach a matching TerrainBed in the same world cell.');
      const height = inputWords(s, bed);
      const stride = s.depth + 1;
      // A cell centre falls on the same diagonal used by the TerrainBed triangles.
      for (let z = 0; z < s.depth; z++)
        for (let x = 0; x < s.width; x++) {
          const low = z + x * stride;
          input[INPUT * (x + z * s.width)] = checked(
            'terrain height',
            0.5 * (height[low + 1]! + height[low + stride]!),
          );
        }
    }
    const wind = s.wind;
    for (let i = 0; i < s.count; i++) {
      const k = INPUT * i;
      const air = input[k + 3]!;
      if (input[k + 6] === 0) input[k + 6] = 67.92 + 51.25 * exp(Math.min(0, air) / 2.59);
      if (wind && dt > 0) {
        const shift = (axis: number) => (context.cell[axis]! - wind.cell[axis]!) * s.worldCellSize;
        let gust: ReturnType<Wind['sample']>;
        try {
          gust = wind.sample(
            s.origin[0] + (i % s.width) * s.spacing + shift(0),
            input[k]! + 10 + shift(1),
            s.origin[1] + Math.floor(i / s.width) * s.spacing + shift(2),
            context.tick * dt,
            this.flowSample,
          );
        } catch (cause) {
          throw snowpackError(
            'A snowpack wind sample failed. Supply an air field that covers the requested coordinates and time.',
            'failed',
            cause,
          );
        }
        if (!gust?.velocity || gust.velocity.length !== 3)
          throw snowpackError(
            'Snowpack wind returned an invalid velocity. Supply three finite components and an air density.',
          );
        input[k + 7] = checked('wind X', gust.velocity[0]) * s.windToFriction;
        input[k + 8] = checked('wind Z', gust.velocity[2]) * s.windToFriction;
        input[k + 9] = checked('air density', gust.density, 0);
      }
    }
    words(s, s.forcing).set(input);
    const eta = words(s, s.viscosity);
    const override = words(s, s.prescribedViscosity);
    const packs = words(s, s.pack);
    for (let i = 0; i < s.count; i++) {
      const k = INPUT * i;
      const air = input[k + 3]!;
      for (let j = 0; j < s.layers; j++) {
        const layer = i * s.layers + j;
        const mass = packs[3 * layer]!,
          energy = packs[3 * layer + 1]!,
          volume = packs[3 * layer + 2]!;
        const solid = mass - Math.min(mass, Math.max(0, energy / FUSION));
        const density = solid > 0 && volume > 0 ? solid / volume : input[k + 6]!;
        const temperature = mass > 0 ? Math.min(0, energy / (ICE_CP * mass)) : Math.min(0, air);
        eta[layer] =
          override[layer] ||
          checked('layer viscosity', 0.007 * pow(density, 4.75 - temperature / 40), Number.MIN_VALUE);
      }
    }
    const { trial } = s;
    words(s, trial.pack).set(packs);
    words(s, trial.cornices).set(words(s, s.cornices));
    const status = s.kernel.snowpack_step(
      trial.pack.byteOffset,
      trial.cornices.byteOffset,
      s.drift.byteOffset,
      s.forcing.byteOffset,
      s.viscosity.byteOffset,
      s.cohesion.byteOffset,
      s.priorIce.byteOffset,
      s.config.byteOffset,
      trial.runoff.byteOffset,
      trial.discharge.byteOffset,
      trial.summary.byteOffset,
      trial.cover.byteOffset,
      s.width,
      s.depth,
      s.layers,
      scaledDt,
      dt || 1,
    );
    if (status !== 0)
      throw snowpackError(
        'The native snowpack step failed. Check shared memory and use finite physical inputs.',
        'failed',
      );
    this.publishTrial(s);
    words(s, s.clock).set([...context.cell, context.tick + 1]);
    if (dt > 0) this.nativeWork = s.kernel.workCounts();
  }

  /** Copy the native work completed during the last accepted physical step. */
  readNativeWork(): SnowpackWorkCounts | undefined {
    const work = this.nativeWork;
    return work && { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  private publishTrial(s: State): void {
    const { trial } = s;
    const depth = regionWords(s.host.memory, trial.cover) as Float32Array;
    if (
      !words(s, trial.pack).every(Number.isFinite) ||
      !words(s, trial.cornices).every(Number.isFinite) ||
      !words(s, trial.runoff).every(Number.isFinite) ||
      !words(s, trial.discharge).every(Number.isFinite) ||
      !depth.every(Number.isFinite) ||
      !words(s, trial.summary).every(
        (value, slot) => Number.isFinite(value) || (slot % OUTPUT === 4 && value === Infinity),
      )
    )
      throw snowpackError(
        'The snowpack step exceeded its finite range. Reduce the forcing, physical time scale or extreme input sizes.',
        'failed',
      );
    words(s, s.pack).set(words(s, trial.pack));
    words(s, s.cornices).set(words(s, trial.cornices));
    words(s, s.runoff).set(words(s, trial.runoff));
    words(s, s.discharge).set(words(s, trial.discharge));
    words(s, s.summary).set(words(s, trial.summary));
    (regionWords(s.host.memory, s.cover) as Float32Array).set(depth);
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.requireState();
    const cell = s.host.cell;
    return [
      { field: this.runoffField.name, region: s.runoff, tick, cell },
      { field: this.dischargeField.name, region: s.discharge, tick, cell },
      { field: this.coverField.name, region: s.cover, tick, cell },
      { field: this.columnField.name, region: s.summary, tick, cell },
    ];
  }

  stateRegions(): readonly Region[] {
    const s = this.requireState();
    return [
      s.pack,
      s.cornices,
      s.defaults,
      s.prescribedViscosity,
      s.cohesion,
      s.config,
      s.runoff,
      s.discharge,
      s.summary,
      s.cover,
      s.clock,
    ];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** The current sample at an integer X and Z column. */
  read(x: number, z: number): SnowpackSample {
    const s = this.requireState();
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || x >= s.width || z < 0 || z >= s.depth)
      throw snowpackError('Invalid snowpack column; pass whole X and Z indices inside the grid.');
    const i = x + z * s.width;
    const row = words(s, s.summary).subarray(i * OUTPUT, (i + 1) * OUTPUT);
    return {
      mass: row[0]!,
      liquid: row[1]!,
      temperature: row[2]!,
      depth: row[3]!,
      stability: row[4]!,
      slabDepth: row[5]!,
      slabMass: row[11]!,
      cornice: [row[6]!, row[7]!],
      corniceMass: row[8]!,
      unusedHeat: row[9]!,
      runoffHeat: row[10]!,
      runoff: words(s, s.runoff)[i]!,
    };
  }

  /** Read total mass, enthalpy relative to melting ice and geometrical depth at a layer, with layer zero the surface. */
  layer(x: number, z: number, layer: number): readonly [number, number, number] {
    const s = this.requireState();
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(z) ||
      !Number.isInteger(layer) ||
      x < 0 ||
      x >= s.width ||
      z < 0 ||
      z >= s.depth ||
      layer < 0 ||
      layer >= s.layers
    )
      throw snowpackError('Invalid snowpack layer; pass whole X, Z and layer indices inside the model.');
    const words = regionWords(s.host.memory, s.pack);
    const start = 3 * (layer + s.layers * (x + z * s.width));
    return [words[start]!, words[start + 1]!, words[start + 2]!];
  }

  /** Number of columns along X. */
  get width(): number {
    return this.requireState().width;
  }
  /** Number of columns along Z. */
  get depth(): number {
    return this.requireState().depth;
  }
  /** Metres between columns. */
  get cellSize(): number {
    return this.requireState().spacing;
  }
  /** World-cell coordinates of the first column centre, metres. */
  get origin(): readonly [number, number] {
    return this.requireState().origin;
  }
  /** Revision of the renderable data on the world clock. */
  get version(): number {
    const s = this.requireState();
    return words(s, s.clock)[3]!;
  }

  /** Ground and snow depth interleaved, matching the Weather SnowFieldSource contract. */
  fieldData(): Float32Array {
    const s = this.requireState();
    return (regionWords(s.host.memory, s.cover) as Float32Array).slice();
  }

  /** Slab depth, mass and stability in the form accepted by the Weather avalanche solver. */
  slide(): { slabDepth: Float32Array; slabMass: Float32Array; index: Float32Array } {
    const s = this.requireState();
    const values = words(s, s.summary);
    const slabDepth = new Float32Array(s.count),
      slabMass = new Float32Array(s.count),
      index = new Float32Array(s.count);
    for (let i = 0; i < s.count; i++) {
      slabDepth[i] = values[OUTPUT * i + 5]!;
      slabMass[i] = values[OUTPUT * i + 11]!;
      index[i] = values[OUTPUT * i + 4]!;
    }
    return { slabDepth, slabMass, index };
  }

  private requireState(): State {
    if (!this.state) throw snowpackError('Snowpack is not attached; add it to a PhysicsWorld with a grid first.');
    return this.state;
  }
}

function sameCell(a: Cell, b: Cell): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
