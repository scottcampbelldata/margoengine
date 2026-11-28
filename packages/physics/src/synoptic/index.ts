import type { Bed, FlowSample, Wind } from '@margoengine/math/fields';
import { cos, exp, hypot, ln, sin } from '@margoengine/math/pinned';
import {
  FORCING_WORDS,
  SURFACE_WATER_FIELD,
  SURFACE_WATER_FORCING_FIELD,
  SURFACE_WATER_LAYOUT,
} from '../hydro/index.js';
import { isShared, MAX_MEMORY_PAGES, regionWords, STACK_BYTES } from '../world/memory.js';
import type { Cell, FieldDescriptor, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';
import { synopticError } from './errors.js';
import {
  bindSynopticPublication,
  loadSynopticKernels,
  type SynopticKernelBuilds,
  type SynopticPublication,
  type SynopticWorkCounts,
} from './kernel.js';

export { type SynopticWorkerWork, type SynopticWorkCounts } from './kernel.js';

const SEA_LEVEL = 101325;
const AIR_GAS = 287.05;
const WATER = 1000;
const GRAVITY = 9.80665;
const ZERO: Cell = [0, 0, 0];
const STEPS = 2;
const CELL_OFFSET = 16;

/** Version of the x-fast f64 atmospheric output and compatible forcing rows. */
export const SYNOPTIC_LAYOUT = 1;
/** Pressure, east and north wind, vertical air motion, sea-level and local temperature, vapour, cloud, hydrometeors, precipitation and east/north IVT. */
export const SYNOPTIC_WORDS = 12;

type GridInput = number | ((x: number, z: number) => number);

/** Equal-depth Phillips model for vertically sheared regional flow. */
export interface SynopticLayers {
  /** Baroclinic deformation radius in metres. Default 200 km. */
  readonly deformationRadius?: number;
  /** Upper-layer mean wind in m/s [east, north]. Defaults to the lower-layer mean wind. */
  readonly upperMeanWind?: readonly [number, number];
  /** Initial upper-layer streamfunction in m²/s. Defaults to the initial lower streamfunction. */
  readonly upperStreamfunction?: GridInput;
  /** Altitudes used to interpolate wind. Default [1500, 5500] m. */
  readonly altitudes?: readonly [number, number];
  /** Pressure levels used for the hypsometric temperature difference. Default [85000, 50000] Pa. */
  readonly pressureLevels?: readonly [number, number];
}

/** Grid of a coupled shallow-water surface. Origin is its southwest first cell centre. */
export interface SynopticWaterTarget {
  readonly columns: number;
  readonly rows: number;
  readonly spacing: readonly [number, number];
  readonly origin: readonly [number, number];
  readonly cellSize?: number;
  readonly windStress?: boolean;
  readonly waterDensity?: number;
}

/** Configuration of one regional periodic atmosphere. Distances are metres and meteorological time is seconds. */
export interface SynopticParams {
  /** Power-of-two grid dimensions [east, north]. Default [32, 32]. */
  readonly cells?: readonly [number, number];
  /** Cell sizes along east and north. Default [80,000, 80,000]. */
  readonly spacing?: readonly [number, number];
  /** Local position of the first cell centre. Default [0, 0]. */
  readonly origin?: readonly [number, number];
  /** Initial terrain alignment in whole world cells. Defaults to the solver's cell. */
  readonly cell?: Cell;
  /** Linear scale between the clock and meteorological time. Default 1. */
  readonly timeScale?: number;
  /** Higher-order limited transport, nonlinear pressure and terrain waves, or upwind transport and direct uplift. Default 'high'. */
  readonly fidelity?: 'high' | 'fast';
  /** Activate coupled lower and upper potential vorticity in the high tier. */
  readonly layers?: SynopticLayers;
  /** Latitude of the region centre in radians. Default π/4. */
  readonly latitude?: number;
  /** Coriolis parameter at the region centre in s⁻¹. Default 2Ω sin(latitude). */
  readonly coriolis?: number;
  /** Northward gradient of Coriolis in m⁻¹s⁻¹. Default 2Ω cos(latitude) / Earth radius. */
  readonly beta?: number;
  /** Specified large-scale wind [east, north] in m/s, default [12, 0]. */
  readonly meanWind?: readonly [number, number];
  /** Initial barotropic streamfunction in m²/s, sampled at cell centres. Default a weak regional low. */
  readonly streamfunction?: GridInput;
  /** Initial column vapour in kg/m², default 20. */
  readonly vapour?: GridInput;
  /** Initial cloud condensate in kg/m², default 0. */
  readonly cloud?: GridInput;
  /** Initial falling condensate in kg/m², default 0. */
  readonly hydrometeors?: GridInput;
  /** Initial sea-level air temperature in K, default 288.15. A frontal gradient is transported in this field. */
  readonly temperature?: GridInput;
  /** Prescribed surface evaporation in kg/m²/s, default 0. */
  readonly evaporation?: GridInput;
  /** Ground sampled for uplift. The default is flat at sea level. */
  readonly bed?: Bed;
  /** Metres per whole world cell for terrain alignment, default 4096. */
  readonly cellSize?: number;
  /** Sea-level mean pressure in Pa, default 101325. */
  readonly pressure?: number;
  /** Reference air density for balanced pressure in kg/m³, default 1.225. */
  readonly density?: number;
  /** Moisture sensitivity to terrain uplift in kg/m³. By default, Smith–Barstad's saturated column uses the current local temperature. */
  readonly liftSensitivity?: number;
  /** Moist Brunt–Väisälä frequency in s⁻¹ for the terrain wave response. Default 0.0104. */
  readonly moistStability?: number;
  /** Moisture scale height in metres. Default the saturated reference column at 288.15 K with the configured lapse. */
  readonly moistDepth?: number;
  /** Condensate conversion time in seconds, default 1000. */
  readonly cloudTime?: number;
  /** Falling-water reservoir time in seconds, default 1000. */
  readonly falloutTime?: number;
  /** Environmental lapse in K/m, default 0.0065. */
  readonly lapseRate?: number;
  /** Optional surface-water grid for pressure and wind-stress coupling. */
  readonly water?: SynopticWaterTarget;
}

/** Atmospheric reading on the regional grid, in SI units. */
export interface SynopticReading {
  readonly pressure: number;
  readonly wind: readonly [number, number];
  readonly lift: number;
  readonly seaTemperature: number;
  readonly temperature: number;
  readonly vapour: number;
  readonly cloud: number;
  readonly hydrometeors: number;
  readonly precipitation: number;
  readonly ivt: readonly [number, number];
}

/** Both streamfunctions, layer winds and the thermal anomaly of a layered solve. */
export interface SynopticLayerReading {
  readonly lowerStreamfunction: number;
  readonly upperStreamfunction: number;
  readonly lowerWind: readonly [number, number];
  readonly upperWind: readonly [number, number];
  readonly temperatureAnomaly: number;
}

type Native = {
  __stack_pointer: WebAssembly.Global;
  filter_orography(geometry: number, modes: number, scratch: number, table: number, nx: number, nz: number): void;
  advance_synoptic_layers(
    pv: number,
    output: number,
    work: number,
    vorticity: number,
    modes: number,
    table: number,
    base: number,
    layers: number,
  ): number;
  advance_synoptic(
    state: number,
    diagnostic: number,
    scratch: number,
    geometry: number,
    modes: number,
    twiddles: number,
    config: number,
  ): number;
};

type Layers = {
  state: Region;
  output: Region;
  work: Region;
  modes: Region;
  config: Region;
  altitudes: readonly [number, number];
};

type AtmosphereBanks = {
  readonly data: Region;
  readonly diagnostic: Region;
  readonly output: Region;
  readonly config: Region;
  readonly forcing?: Region;
  readonly layers?: Layers;
};

function bad(message: string): never {
  throw synopticError(message);
}

function number(value: number, label: string, min = -Infinity): number {
  if (!Number.isFinite(value) || value < min)
    bad(min === -Infinity ? `Pass a finite ${label}.` : `Pass a finite ${label} at or above ${min}.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!(Number.isFinite(value) && value > 0)) bad(`Pass a finite positive ${label}.`);
  return value;
}

function powerOfTwo(value: number) {
  if (!Number.isSafeInteger(value) || value < 4 || value > 0x40000000 || (value & (value - 1)) !== 0)
    bad('Use an integer power of two of at least four for both grid dimensions.');
  return value;
}

function valueOf(input: GridInput, x: number, z: number) {
  return typeof input === 'function' ? input(x, z) : input;
}

const mod = (i: number, n: number) => ((i % n) + n) % n;

function neutralOceanDrag(speed: number): number {
  const fittedEnd = (0.75 + 0.067 * 21) * 0.001;
  if (speed <= 21) return (0.75 + 0.067 * speed) * 0.001;
  return fittedEnd + ((Math.min(speed, 33) - 21) / 12) * (0.0025 - fittedEnd);
}

/** Regional rotating atmosphere, moisture transport and delayed orographic precipitation. */
export class SynopticWeather implements Solver<SynopticParams> {
  readonly field: FieldDescriptor;
  readonly wind: Wind;
  private host!: SolverHost;
  private kernel!: Native;
  private publication!: SynopticPublication;
  private trial!: AtmosphereBanks;
  private readonly copies: { accepted: Region; candidate: Region; seed: boolean }[] = [];
  private disposed = false;
  private nx = 0;
  private nz = 0;
  private count = 0;
  private dx = 0;
  private dz = 0;
  private x0 = 0;
  private z0 = 0;
  private speed = 1;
  private lapse = 0.0065;
  private initialMass = 0;
  private data!: Region;
  private diagnostic!: Region;
  private output!: Region;
  private geometry!: Region;
  private modes!: Region;
  private table!: Region;
  private work!: Region;
  private config!: Region;
  private forcing: Region | undefined;
  private water: SynopticWaterTarget | undefined;
  private layers: Layers | undefined;

  private constructor(
    readonly id: string,
    private readonly builds: SynopticKernelBuilds,
    private readonly connectWater: boolean,
  ) {
    this.field = {
      name: `${id}:atmosphere`,
      kind: 'uniformGrid',
      quantity: 'synoptic pressure, wind, water, precipitation and integrated transport',
      unit: 'Pa, m/s, K, kg/m², kg/m²/s, kg/m/s',
      centring: 'cell',
    };
    const solver = this;
    this.wind = {
      medium: 'air',
      get cell() {
        return solver.worldCell;
      },
      sample(x, y, z, _seconds, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
        return solver.air(x, y, z, out);
      },
    };
  }

  /** Loads only the optional SIMD kernels; pass water to declare the existing surface fields. */
  static load(options?: { id?: string; water?: boolean; signal?: AbortSignal }): Promise<SynopticWeather>;
  static load(options: {
    id?: string;
    water?: boolean;
    signal?: AbortSignal;
    threads?: 1 | 2 | 4;
  }): Promise<SynopticWeather>;
  static async load(
    options: { id?: string; water?: boolean; signal?: AbortSignal; threads?: 1 | 2 | 4 } = {},
  ): Promise<SynopticWeather> {
    const id = options.id ?? 'synoptic';
    if (typeof id !== 'string' || id === '') bad('Choose a nonempty synoptic solver id.');
    return new SynopticWeather(
      id,
      await loadSynopticKernels(options.signal, options.threads ?? 1),
      options.water ?? false,
    );
  }

  /** Releases the optional diagnostic helpers after stopping the world. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.builds[Symbol.dispose]();
  }

  /** Work completed for the most recent accepted atmospheric publication. */
  readNativeWork(): SynopticWorkCounts | undefined {
    return this.publication?.workCounts();
  }

  describe() {
    const fields = [{ field: this.field, access: 'write' as const }];
    return {
      id: this.id,
      rate: 0 as const,
      stableRate: () => 0 as const,
      // Its own seconds per world second: the shallow water it reads and forces must run at the same.
      timeScale: () => this.speed,
      fields: this.connectWater
        ? [
            ...fields,
            { field: SURFACE_WATER_FIELD, access: 'read' as const },
            { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' as const },
          ]
        : fields,
    };
  }

  init(host: SolverHost, params: SynopticParams = {}): void {
    if (this.disposed) throw synopticError('Load a new synoptic solver after disposing its helpers.', 'disposed');
    if (this.host) throw synopticError('Load a new solver before attaching to another world.', 'attached');
    const [nx, nz] = (params.cells ?? [32, 32]).map(powerOfTwo) as [number, number];
    const count = nx * nz;
    const bytes = 8 * count * (2 * (5 + 8) + 3 + 4 + 7 + 3 * SYNOPTIC_WORDS + (params.layers ? 28 : 0));
    if (!Number.isSafeInteger(bytes) || bytes >= MAX_MEMORY_PAGES * 65536)
      bad('Reduce the grid to fit the wasm32 world arena.');
    this.nx = nx;
    this.nz = nz;
    this.count = count;
    this.dx = positive(params.spacing?.[0] ?? 80_000, 'east spacing');
    this.dz = positive(params.spacing?.[1] ?? 80_000, 'north spacing');
    this.x0 = number(params.origin?.[0] ?? 0, 'east origin');
    this.z0 = number(params.origin?.[1] ?? 0, 'north origin');
    this.speed = positive(params.timeScale ?? 1, 'time scale');
    this.lapse = number(params.lapseRate ?? 0.0065, 'temperature lapse rate', 0);
    const cell = params.cell ?? host.cell;
    if (cell.length !== 3 || !cell.every((component) => Number.isInteger(component) && component === (component | 0)))
      bad('Use a signed integer for each coordinate of the origin cell.');
    this.water = this.waterTarget(params.water);
    const latitude = number(params.latitude ?? Math.PI / 4, 'latitude');
    if (Math.abs(latitude) > Math.PI / 2) bad('Pass latitude in radians between −π/2 and π/2.');
    const rotation = 2 * 7.292115e-5;
    const f = number(params.coriolis ?? rotation * sin(latitude), 'Coriolis parameter');
    const beta = number(params.beta ?? (rotation * cos(latitude)) / 6_371_000, 'Coriolis gradient');
    const fidelity = params.fidelity ?? 'high';
    if (fidelity !== 'high' && fidelity !== 'fast') bad('Choose the high or fast fidelity tier.');
    if (params.layers && fidelity !== 'high') bad('Choose the high fidelity tier for a two-layer atmosphere.');
    const native =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]'
        ? this.builds.shared
        : this.builds.plain;
    if (!native)
      throw synopticError('Use shared world memory for synoptic helpers, or choose one participant.', 'unsupported');
    this.host = host;
    const stack = host.allocate('synoptic-stack', STACK_BYTES, 'u8', SYNOPTIC_LAYOUT);
    const instance = new WebAssembly.Instance(native, { env: { memory: host.memory } });
    this.kernel = instance.exports as Native;
    if (
      typeof this.kernel.advance_synoptic !== 'function' ||
      typeof this.kernel.advance_synoptic_layers !== 'function' ||
      typeof this.kernel.filter_orography !== 'function' ||
      !(this.kernel.__stack_pointer instanceof WebAssembly.Global)
    )
      throw synopticError('Rebuild both synoptic kernel variants and load matching assets.', 'version');
    this.kernel.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    const area = (label: string, words: number) => host.allocate(label, words * 8, 'f64', SYNOPTIC_LAYOUT);
    this.data = area('synoptic-prognostics', 5 * count);
    this.diagnostic = area('synoptic-diagnostics', 8 * count + 3);
    this.output = area('synoptic-registry', SYNOPTIC_WORDS * count);
    this.geometry = area('synoptic-terrain-evaporation', 3 * count);
    this.modes = area('synoptic-inverse-modes', 4 * count);
    this.table = area('synoptic-twiddles', 2 * Math.max(nx, nz));
    this.work = area('synoptic-scratch', 7 * count);
    this.config = area('synoptic-parameters', CELL_OFFSET + 3);
    if (params.layers) {
      const [lower, upper] = params.layers.altitudes ?? [1500, 5500];
      if (!(number(lower, 'lower layer altitude') < number(upper, 'upper layer altitude')))
        bad('Put the upper layer above the lower layer.');
      this.layers = {
        state: area('synoptic-layer-vorticities', 2 * count),
        output: area('synoptic-layer-output', 5 * count),
        work: area('synoptic-layer-scratch', 10 * count),
        modes: area('synoptic-layer-modes', 4 * count),
        config: area('synoptic-layer-parameters', 6),
        altitudes: [lower, upper],
      };
    }
    if (this.water) this.forcing = area('synoptic-water-forcing', this.water.columns * this.water.rows * FORCING_WORDS);
    this.words(this.config).set([
      nx,
      nz,
      this.dx,
      this.dz,
      0,
      number(params.meanWind?.[0] ?? 12, 'mean east wind'),
      number(params.meanWind?.[1] ?? 0, 'mean north wind'),
      f,
      beta,
      positive(params.cloudTime ?? 1000, 'cloud conversion time'),
      positive(params.falloutTime ?? 1000, 'fallout time'),
      params.liftSensitivity === undefined ? -1 : number(params.liftSensitivity, 'lift sensitivity', 0),
      this.lapse,
      positive(params.pressure ?? SEA_LEVEL, 'base pressure'),
      positive(params.density ?? 1.225, 'base air density'),
      this.layers ? 2 : fidelity === 'high' ? 1 : 0,
    ]);
    this.words(this.config).set(cell, CELL_OFFSET);
    this.initialize(params);
    if (fidelity === 'high' && params.bed) this.initializeOrography(params, f);
    this.publication = bindSynopticPublication(host, this.builds, native, instance);
    this.advanceNative(0, {
      data: this.data,
      diagnostic: this.diagnostic,
      output: this.output,
      config: this.config,
      layers: this.layers,
    });
    this.publication.accept();
    const duplicate = (accepted: Region, seed = true): Region => {
      const candidate = area(accepted.name + '-trial', accepted.byteLength / 8);
      this.copies.push({ accepted, candidate, seed });
      return candidate;
    };
    this.trial = {
      data: duplicate(this.data),
      diagnostic: duplicate(this.diagnostic),
      output: duplicate(this.output, false),
      config: duplicate(this.config),
      forcing: this.forcing && duplicate(this.forcing, false),
      layers: this.layers && {
        ...this.layers,
        state: duplicate(this.layers.state),
        output: duplicate(this.layers.output, false),
        config: duplicate(this.layers.config),
      },
    };
  }

  private waterTarget(target: SynopticWaterTarget | undefined): SynopticWaterTarget | undefined {
    if (Boolean(target) !== this.connectWater)
      bad('Provide the matching water grid and load with {water: true} to couple surface water.');
    if (!target) return undefined;
    if (
      ![target.columns, target.rows].every((x) => Number.isSafeInteger(x) && x > 0) ||
      target.columns * target.rows * FORCING_WORDS * 16 >= MAX_MEMORY_PAGES * 65536
    )
      bad('Use positive integer water grid dimensions.');
    return {
      ...target,
      origin: [number(target.origin[0], 'water east origin'), number(target.origin[1], 'water north origin')],
      spacing: [positive(target.spacing[0], 'water east spacing'), positive(target.spacing[1], 'water north spacing')],
      cellSize: positive(target.cellSize ?? 4096, 'water origin cell size'),
      waterDensity: positive(target.waterDensity ?? WATER, 'water density'),
    };
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private get worldCell(): Cell {
    return this.host?.cell ?? ZERO;
  }

  private initialize(params: SynopticParams): void {
    const { nx, nz, dx, dz, count } = this;
    const data = this.words(this.data),
      geometry = this.words(this.geometry),
      modes = this.words(this.modes),
      table = this.words(this.table);
    const stream = new Float64Array(count),
      n = table.length / 2;
    const bed = params.bed,
      metres = positive(params.cellSize ?? 4096, 'bed origin cell size');
    const originOffset = bed ? (params.cell ?? this.worldCell).map((i, axis) => (i - bed.cell[axis]!) * metres) : ZERO;
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i) / n;
      table[2 * i] = cos(angle);
      table[2 * i + 1] = -sin(angle);
    }
    let water = 0;
    let minimumTemperature = Infinity;
    let maximumElevation = -Infinity;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const at = i + nx * j,
          x = this.x0 + i * dx,
          z = this.z0 + j * dz;
        const gx = (i - nx / 2) / nx,
          gz = (j - nz / 2) / nz;
        const defaultLow = -2e6 * exp(-32 * (gx * gx + gz * gz));
        stream[at] = number(valueOf(params.streamfunction ?? defaultLow, x, z), 'streamfunction');
        data[count + at] = number(valueOf(params.vapour ?? 20, x, z), 'vapour column mass', 0);
        data[2 * count + at] = number(valueOf(params.cloud ?? 0, x, z), 'cloud column mass', 0);
        data[3 * count + at] = number(valueOf(params.hydrometeors ?? 0, x, z), 'falling column mass', 0);
        data[4 * count + at] = positive(valueOf(params.temperature ?? 288.15, x, z), 'air temperature');
        water += data[count + at]! + data[2 * count + at]! + data[3 * count + at]!;
        geometry[at] = number(
          (bed?.sample(x + originOffset[0]!, z + originOffset[2]!).elevation ?? 0) - originOffset[1]!,
          'bed elevation',
        );
        minimumTemperature = Math.min(minimumTemperature, data[4 * count + at]!);
        maximumElevation = Math.max(maximumElevation, geometry[at]!);
        geometry[count + at] = number(valueOf(params.evaporation ?? 0, x, z), 'evaporation rate', 0);
        const sx = (2 * sin((Math.PI * i) / nx)) / dx,
          sz = (2 * sin((Math.PI * j) / nz)) / dz;
        modes[at] = at ? -1 / (sx * sx + sz * sz) : 0;
        modes[count + at] = (sin((2 * Math.PI * i) / nx) / dx) * modes[at]!;
      }
    if (minimumTemperature <= this.lapse * maximumElevation)
      bad(
        'Raise the air temperature or lower the bed elevation or lapse rate so every advected column can stay above absolute zero.',
      );
    this.initialMass = water * dx * dz;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const at = i + nx * j,
          middle = stream[at]!;
        data[at] =
          (stream[mod(i + 1, nx) + nx * j]! + stream[mod(i - 1, nx) + nx * j]! - 2 * middle) / (dx * dx) +
          (stream[i + nx * mod(j + 1, nz)]! + stream[i + nx * mod(j - 1, nz)]! - 2 * middle) / (dz * dz);
      }
    if (this.layers && params.layers) this.initializeLayers(this.layers, params.layers, stream);
  }

  private initializeLayers(regions: Layers, params: SynopticLayers, lower: Float64Array): void {
    const { nx, nz, dx, dz, count } = this;
    const r = positive(params.deformationRadius ?? 200_000, 'baroclinic deformation radius');
    const stretch = positive(0.5 / (r * r), 'vertical stretching coefficient');
    const base = this.words(this.config),
      q = this.words(regions.state),
      modes = this.words(regions.modes);
    const laplace = this.words(this.modes),
      relative = this.words(this.data);
    const u0 = base[5]!,
      v0 = base[6]!,
      u1 = number(params.upperMeanWind?.[0] ?? u0, 'upper east wind');
    const v1 = number(params.upperMeanWind?.[1] ?? v0, 'upper north wind'),
      beta = base[8]!;
    const [p0, p1] = params.pressureLevels ?? [85_000, 50_000];
    if (!(positive(p0, 'lower pressure level') > positive(p1, 'upper pressure level')))
      bad('Set the lower pressure level above the upper pressure level in Pa.');
    const upper = new Float64Array(count);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const at = i + nx * j;
        upper[at] = number(
          valueOf(params.upperStreamfunction ?? lower[at]!, this.x0 + i * dx, this.z0 + j * dz),
          'upper streamfunction',
        );
      }
    let bound = 0;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const at = i + nx * j,
          middle = upper[at]!;
        const lap =
          (upper[mod(i + 1, nx) + nx * j]! + upper[mod(i - 1, nx) + nx * j]! - 2 * middle) / (dx * dx) +
          (upper[i + nx * mod(j + 1, nz)]! + upper[i + nx * mod(j - 1, nz)]! - 2 * middle) / (dz * dz);
        const contrast = stretch * (middle - lower[at]!);
        q[at] = relative[at]! + contrast;
        q[count + at] = lap - contrast;
        const inv = laplace[at]!,
          invDifference = 1 / ((at ? 1 / inv : 0) - 2 * stretch);
        const k = (i === nx / 2 ? 0 : sin((2 * Math.PI * i) / nx)) / dx;
        const l = (j === nz / 2 ? 0 : sin((2 * Math.PI * j) / nz)) / dz;
        modes[at] = inv;
        modes[count + at] = invDifference;
        modes[2 * count + at] = k;
        modes[3 * count + at] = l;
        const lowerMode = k * u0 + l * v0,
          upperMode = k * u1 + l * v1;
        const coupling = stretch * (lowerMode - upperMode);
        const norm = 0.5 * (Math.abs(inv + invDifference) + Math.abs(inv - invDifference));
        bound = Math.max(
          bound,
          Math.abs(lowerMode) + Math.abs(k * beta + coupling) * norm,
          Math.abs(upperMode) + Math.abs(k * beta - coupling) * norm,
        );
      }
    const thicknessToTemperature = base[7]! / (AIR_GAS * ln(p0 / p1));
    this.words(regions.config).set([u1, v1, stretch, bound, thicknessToTemperature, 0]);
  }

  private initializeOrography(params: SynopticParams, f: number): void {
    const { nx, nz, dx, dz, count } = this;
    const stratification = number(params.moistStability ?? 0.0104, 'moist Brunt–Väisälä frequency', 0);
    const depth = positive(
      params.moistDepth ?? (461.5 * 288.15 * 288.15) / (2.5e6 * (this.lapse || 0.0065)),
      'moisture scale height',
    );
    const modes = this.words(this.modes),
      config = this.words(this.config),
      u = config[5]!,
      v = config[6]!;
    const wavenumber = (i: number, n: number, spacing: number) =>
      i === n / 2 ? 0 : (2 * Math.PI * (i < n / 2 ? i : i - n)) / (n * spacing);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const k = wavenumber(x, nx, dx),
          l = wavenumber(z, nz, dz),
          sigma = k * u + l * v;
        const intrinsic = sigma * sigma,
          inertial = intrinsic - f * f;
        if (sigma === 0 || inertial === 0) continue;
        const m2 = ((stratification * stratification - intrinsic) * (k * k + l * l)) / inertial;
        const at = 2 * count + 2 * (x + nx * z);
        if (m2 < 0) {
          modes[at + 1] = sigma / (1 + depth * Math.sqrt(-m2));
          continue;
        }
        const mh = Math.sign(sigma) * depth * Math.sqrt(m2);
        const factor = sigma / (1 + mh * mh);
        modes[at] = -factor * mh;
        modes[at + 1] = factor;
      }
    this.kernel.filter_orography(
      this.geometry.byteOffset,
      this.modes.byteOffset,
      this.work.byteOffset,
      this.table.byteOffset,
      nx,
      nz,
    );
  }

  private advanceNative(seconds: number, banks: AtmosphereBanks): void {
    this.words(banks.config)[4] = seconds;
    const layers = banks.layers;
    if (layers) {
      const count = this.kernel.advance_synoptic_layers(
        layers.state.byteOffset,
        layers.output.byteOffset,
        layers.work.byteOffset,
        banks.data.byteOffset,
        layers.modes.byteOffset,
        this.table.byteOffset,
        banks.config.byteOffset,
        layers.config.byteOffset,
      );
      if (!Number.isFinite(count)) bad('Reduce the wind shear or time scale so the layered solve can make progress.');
      this.words(layers.config)[5]! += count;
      if (
        !this.words(layers.state).every(Number.isFinite) ||
        !this.words(layers.output).every(Number.isFinite) ||
        !Number.isFinite(this.words(layers.config)[5]!)
      )
        bad('Reduce wind shear or the time scale so both atmospheric layers remain finite.');
    }
    const work = this.kernel.advance_synoptic(
      banks.data.byteOffset,
      banks.diagnostic.byteOffset,
      this.work.byteOffset,
      this.geometry.byteOffset,
      this.modes.byteOffset,
      this.table.byteOffset,
      banks.config.byteOffset,
    );
    if (!Number.isFinite(work)) bad('Reduce wind or time scale so a positive transport step fits the grid.');
    if (!this.words(banks.data).every(Number.isFinite) || !this.words(banks.diagnostic).every(Number.isFinite))
      bad('Reduce wind or time scale to keep the atmosphere and water budget finite.');
    this.publication.run(this.count, banks.data, banks.diagnostic, banks.output, layers?.output);
  }

  step(context: StepContext, dt: number): void {
    if (this.disposed)
      throw synopticError('Use a live synoptic solver and dispose it after the world stops stepping.', 'disposed');
    if (!this.trial) bad('Add the synoptic solver to a PhysicsWorld before stepping.');
    const seconds = positive(dt * this.speed, 'meteorological time step');
    const trial = this.trial;
    for (const { accepted, candidate, seed } of this.copies) if (seed) this.words(candidate).set(this.words(accepted));
    this.words(trial.config).set(context.cell, CELL_OFFSET);
    this.advanceNative(seconds, trial);
    if (trial.forcing && this.water) this.forceWater(context, trial, this.water);
    for (const { accepted, candidate } of this.copies) this.words(accepted).set(this.words(candidate));
    this.publication.accept();
  }

  private forceWater(context: StepContext, trial: AtmosphereBanks, grid: SynopticWaterTarget): void {
    const forces = this.words(trial.forcing!);
    forces.fill(0);
    const water = context.inputs.get(SURFACE_WATER_FIELD.name);
    if (!water) return;
    const region = water.region;
    const bytes = 12 * grid.columns * grid.rows;
    if (
      water.field !== SURFACE_WATER_FIELD.name ||
      region.layout !== SURFACE_WATER_LAYOUT ||
      region.type !== 'f32' ||
      region.byteLength !== bytes
    )
      throw synopticError('Bind the water target to the matching layout-1 ShallowWaterSolver grid.', 'version');
    const memory = region.memory ?? this.host.memory;
    const offset = region.byteOffset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 4 || offset > memory.buffer.byteLength - bytes)
      bad('Publish aligned shallow-water rows within the memory that owns the water field.');
    const depth = new Float32Array(memory.buffer, offset, bytes / 4);
    const [dx, dz] = grid.spacing,
      metres = grid.cellSize!;
    const x0 = grid.origin[0] + (water.cell[0] - context.cell[0]) * metres;
    const z0 = grid.origin[1] + (water.cell[2] - context.cell[2]) * metres;
    const air: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
    const pressure = (east: number, north: number) => this.interpolate(east, north, 0, trial.output);
    for (let j = 0; j < grid.rows; j++)
      for (let i = 0; i < grid.columns; i++) {
        const index = i + j * grid.columns,
          h = number(depth[index * 3]!, 'water depth', 0),
          east = number(depth[index * 3 + 1]!, 'east water momentum'),
          north = number(depth[index * 3 + 2]!, 'north water momentum'),
          at = index * FORCING_WORDS;
        if (h <= 0) continue;
        const x = x0 + i * dx,
          z = z0 + j * dz;
        const px = (pressure(x + dx / 2, z) - pressure(x - dx / 2, z)) / dx;
        const pz = (pressure(x, z + dz / 2) - pressure(x, z - dz / 2)) / dz;
        let stressX = 0,
          stressZ = 0;
        if (grid.windStress !== false) {
          this.air(x, 10, z, air, trial.output, trial.layers);
          const u = air.velocity[0] - east / h;
          const v = air.velocity[2] - north / h;
          const speed = hypot(u, v),
            drag = air.density * neutralOceanDrag(speed) * speed;
          stressX = drag * u;
          stressZ = drag * v;
        }
        forces[at] = number((stressX - h * px) / grid.waterDensity!, 'east atmospheric water forcing');
        forces[at + 1] = number((stressZ - h * pz) / grid.waterDensity!, 'north atmospheric water forcing');
      }
  }

  exportPorts(tick: number): readonly Port[] {
    const values = { field: this.field.name, tick, region: this.output, cell: this.worldCell };
    return this.forcing
      ? [values, { field: SURFACE_WATER_FORCING_FIELD.name, tick, region: this.forcing, cell: this.worldCell }]
      : [values];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const regions = [this.data, this.diagnostic, this.geometry, this.modes, this.table, this.output, this.config];
    if (this.layers) regions.push(this.layers.state, this.layers.output, this.layers.modes, this.layers.config);
    return this.forcing ? [...regions, this.forcing] : regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  private interpolate(x: number, z: number, column: number, region = this.output, stride = SYNOPTIC_WORDS): number {
    if (!this.host) bad('Add the solver to a PhysicsWorld before sampling.');
    const gx = (x - this.x0) / this.dx,
      gz = (z - this.z0) / this.dz,
      i = Math.floor(gx),
      j = Math.floor(gz);
    const a = gx - i,
      b = gz - j,
      left = mod(i, this.nx),
      right = mod(i + 1, this.nx),
      bottom = mod(j, this.nz),
      top = mod(j + 1, this.nz);
    const q = this.words(region);
    const south =
      (1 - a) * q[(bottom * this.nx + left) * stride + column]! + a * q[(bottom * this.nx + right) * stride + column]!;
    const north =
      (1 - a) * q[(top * this.nx + left) * stride + column]! + a * q[(top * this.nx + right) * stride + column]!;
    return (1 - b) * south + b * north;
  }

  /** Interpolates the live grid at metres east and north in the solver's world cell. */
  sample(x: number, z: number): SynopticReading {
    number(x, 'east sample coordinate');
    number(z, 'north sample coordinate');
    const at = (column: number) => this.interpolate(x, z, column);
    return {
      pressure: at(0),
      wind: [at(1), at(2)],
      lift: at(3),
      seaTemperature: at(4),
      temperature: at(5),
      vapour: at(6),
      cloud: at(7),
      hydrometeors: at(8),
      precipitation: at(9),
      ivt: [at(10), at(11)],
    };
  }

  /** Samples both solved layers when the world was configured with `layers`. */
  sampleLayers(x: number, z: number): SynopticLayerReading | undefined {
    const layers = this.layers;
    if (!layers) return undefined;
    number(x, 'east sample coordinate');
    number(z, 'north sample coordinate');
    const at = (column: number) => this.interpolate(x, z, column * this.count, layers.output, 1);
    return {
      lowerStreamfunction: at(0),
      upperStreamfunction: at(1),
      lowerWind: [this.interpolate(x, z, 1), this.interpolate(x, z, 2)],
      upperWind: [at(2), at(3)],
      temperatureAnomaly: at(4),
    };
  }

  private air(
    x: number,
    y: number,
    z: number,
    out: FlowSample,
    output = this.output,
    layers = this.layers,
  ): FlowSample {
    const base = this.interpolate(x, z, 4, output);
    out.temperature = positive(base - this.lapse * y, 'local absolute air temperature');
    const pressure = this.interpolate(x, z, 0, output) * exp((-GRAVITY * y) / (AIR_GAS * base));
    out.density = pressure / (AIR_GAS * out.temperature);
    out.velocity[0] = this.interpolate(x, z, 1, output);
    out.velocity[1] = this.interpolate(x, z, 3, output);
    out.velocity[2] = this.interpolate(x, z, 2, output);
    if (layers) {
      const [lower, upper] = layers.altitudes;
      const fraction = Math.min(1, Math.max(0, (y - lower) / (upper - lower)));
      const u = this.interpolate(x, z, 2 * this.count, layers.output, 1);
      const v = this.interpolate(x, z, 3 * this.count, layers.output, 1);
      out.velocity[0] += fraction * (u - out.velocity[0]);
      out.velocity[2] += fraction * (v - out.velocity[2]);
    }
    return out;
  }

  /** Rate at the surface in mm/h for Weather's existing precipitation sample and drop-size model. */
  rainSource(): { rate(x: number, z: number, seconds: number): number; readonly peak: number } {
    const solver = this;
    return {
      rate: (x, z) => 3600 * solver.interpolate(x, z, 9),
      get peak() {
        const rain = solver.words(solver.diagnostic).subarray(5 * solver.count, 6 * solver.count);
        let peak = 0;
        for (const rate of rain) peak = Math.max(peak, rate);
        return 3600 * peak;
      },
    };
  }

  /** Periodic-domain water budget in kg, and the number of native transport substeps. */
  get budget(): { initial: number; airborne: number; evaporation: number; precipitation: number; substeps: number } {
    const n = this.count,
      data = this.words(this.data),
      diagnostic = this.words(this.diagnostic),
      area = this.dx * this.dz;
    let airborne = 0;
    for (let i = n; i < 4 * n; i++) airborne += data[i]!;
    return {
      initial: this.initialMass,
      airborne: airborne * area,
      evaporation: diagnostic[8 * n]! * area,
      precipitation: diagnostic[8 * n + 1]! * area,
      substeps: diagnostic[8 * n + STEPS]!,
    };
  }

  /** Number of completed layered vorticity substeps since initialization. */
  get layerSubsteps(): number {
    return this.layers ? this.words(this.layers.config)[5]! : 0;
  }
}
