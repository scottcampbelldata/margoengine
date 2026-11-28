// Moist convection and clouds (ATMO-03 of docs/physics-solvers.md): a box of air over the ground in which warm, moist air
// rises, cools, condenses into cloud, releases its latent heat, rains and drifts with the wind, as a solver of the physics
// framework. Cloud water is published as the registry field `cloudWater` for the sky to draw; the rain it drops is a source
// for the framework's precipitation (`PrecipitationField` of `@margoengine/weather/precipitation`, its `source` option), and
// its outflow can be added to a wind (`wind(base)`).
//
// The model is that of M. J. Harris, W. V. Baxter, T. Scheuermann and A. Lastra, "Simulation of cloud dynamics on graphics
// hardware", Graphics Hardware 2003 (read in full): incompressible flow with the buoyancy B = g (theta_v / theta_v0 - q_H) of
// the virtual potential temperature theta_v = theta (1 + 0.61 q_v) against the environment's (their eq. 4), the potential
// temperature theta = T / Pi (eq. 3), the saturation mixing ratio q_vs = 380.16 / p exp(17.67 T / (T + 243.5)) with T in C
// and p in Pa (eq. 6, after Rogers and Yau), the water continuity and latent heating of eqs. 7 and 8 with L = 2.501e6 J/kg,
// semi-Lagrangian advection and a pressure projection (after Stam 1999), and vorticity confinement (after Fedkiw et al.
// 2001). Their two-state water becomes Kessler's warm rain in the form restated by S. Hittmeir et al. (arXiv:2305.13847,
// read, eqs. 5a to 5c, the COSMO closure): autoconversion 0.001 (q_c - 0.001)+ per second above Kessler's threshold of
// 1 g/kg (as Hadrich et al., "Thunderscapes", arXiv:2412.00703, eq. 9, also use), accretion 1.72 rho_c rho_r^(7/8), and
// rain evaporation (3.86e-3 - 9.41e-5 (T - 273.15)) (1 + 9.1 rho_r^(3/16)) (rho_vs - rho_v) rho_r^(1/2); rain falls at the
// mass-weighted speed of a Marshall-Palmer rain with v(D) = 130 D^(1/2), (pi rho_w N0)^(-1/8) 130 Gamma(4.5) / 6
// rho_r^(1/8) with N0 = 8e6 per m^4 (Hittmeir et al., section 2.1, with rho_w the density of liquid water). Condensation is
// a saturation adjustment: the excess vapour over q_vs, divided by 1 + (L / c_p) dq_vs/dT so that the latent heat it
// releases leaves the air just saturated.
//
// Accepted differences: incompressible flow (Boussinesq; no anelastic density weighting), warm rain only (whether the rain
// reaches the ground as snow is decided by the precipitation field from the air there), flat ground, walls around the box
// for the flow it makes while the mean wind carries air through it, and semi-Lagrangian advection, which does not conserve
// water exactly.

import { airDensity, standardAtmosphere } from '@margoengine/math/atmosphere';
import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { cos as cosine, exp, hypot, pow } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  RateLevel,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import type { CloudProjection, CloudProjectionLoadOptions, CloudProjectionWorkCounts } from './projection-kernel.js';

/** The registry field of the clouds: cloud water mixing ratio per cell, kg/kg, owned by {@link CloudSolver}. */
export const CLOUD_WATER_FIELD: FieldDescriptor = {
  name: 'cloudWater',
  kind: 'uniformGrid',
  quantity: 'mixingRatio',
  unit: 'kg/kg',
  centring: 'cell',
};
/** The layout of a cloud solver's regions; a reader that knows another version refuses the port. */
export const CLOUD_LAYOUT = 1;

/** Latent heat of vaporisation, J/kg (Harris et al. 2003). */
export const LATENT_HEAT = 2.501e6;
/** Specific heat of dry air at constant pressure, J/(kg K). */
export const AIR_HEAT_CAPACITY = 1005;
const R_OVER_CP = 0.286;
const REFERENCE_PRESSURE = 100000;
const PROJECTION_RELATIVE_TOLERANCE = 1e-10;
const PROJECTION_ITERATIONS = 400;
const MAX_SUBSTEPS = 4096;
const MAX_CELLS = 2 ** 21;
const SATURATION_MINIMUM_K = 273.15 - 243.5;
const STATE_F32_MAX = 3.4028234663852886e38;
const WATER_DENSITY = 1000;
/** Kessler's autoconversion threshold, kg/kg, and rate, 1/s. */
const AUTOCONVERSION_THRESHOLD = 0.001;
const AUTOCONVERSION_RATE = 0.001;
/** (pi rho_w N0)^(-1/8) 130 Gamma(4.5) / 6, the rain fall speed per (kg/m^3)^(1/8). */
const RAIN_SPEED = 130 * (11.631728396567448 / 6) * pow(3.141592653589793 * WATER_DENSITY * 8e6, -0.125);

/** Settings of a {@link CloudSolver}; each has a default. */
export interface CloudParams {
  /** Cells along x, y (up) and z (default [48, 24, 48]). */
  cells?: readonly [number, number, number];
  /** The edge of a cell, m (default 200: a box 9.6 km across and 4.8 km high). */
  cellSize?: number;
  /** The box's centre over the ground, [x, z] m from the solver's cell origin (default [0, 0]). */
  centre?: readonly [number, number];
  /** The ground's height, y m (default 0). */
  ground?: number;
  /** The ground's height above sea level, m (default 0). */
  altitude?: number;
  /** Sea-level temperature of the environment, K (default 298.15: a warm day). */
  seaLevelTemperature?: number;
  /** Relative humidity of the environment at the ground, 0 to 1 (default 0.75). */
  humidity?: number;
  /** Relative humidity at the top of the box; it changes linearly with height between (default 0.3). */
  humidityTop?: number;
  /** Sensible heat the ground gives the air, W/m^2 (default 250: a sunny afternoon over land). */
  surfaceHeat?: number;
  /** Latent heat the ground gives the air as evaporated water, W/m^2 (default 150). */
  surfaceLatent?: number;
  /** How much the ground's heating varies from place to place, 0 (even) to 1 (default 0.6): where thermals rise. */
  patchiness?: number;
  /** How long one pattern of warm and cool ground lasts, s of cloud time (default 600). */
  thermalPeriod?: number;
  /** The wind that carries the air through the box (its mean over each layer above the centre; default still air). */
  wind?: Wind;
  /** Seconds of cloud time per second of world time (default 1; 60 runs a minute of weather a second, for a timelapse). */
  timeScale?: number;
  /** The cloud's own time step, s of cloud time (default 2). */
  interval?: number;
  /** Vorticity confinement strength, 0 to switch it off (default 0.2). */
  vorticity?: number;
  /** Metres per origin cell for translating the wind and cloud box (default 4096). */
  worldCellSize?: number;
  /** Warm bubbles to start from: where thermals or a storm begin (default none). */
  bubbles?: readonly CloudBubble[];
}

/** A warm, moist bubble at the start: theta rises by `warming` cos^2(pi r / 2 R) inside radius R. */
export interface CloudBubble {
  /** Its centre, [x, y, z] m from the solver's cell origin, y above the ground. */
  centre: readonly [number, number, number];
  /** Its radius R, m. */
  radius: number;
  /** The warming at its centre, K. */
  warming: number;
  /** Relative humidity at its centre, 0 to 1.2 (above 1 is supersaturated; default the environment's). */
  humidity?: number;
}

/** What a cloud solver gives at a point. */
export interface CloudSample {
  /** Cloud water, kg/kg. */
  cloudWater: number;
  /** Rain water, kg/kg. */
  rainWater: number;
  /** Water vapour, kg/kg. */
  vapour: number;
  /** Air temperature, K. */
  temperature: number;
  /** The air's velocity, m/s: the box's own flow plus the mean wind. */
  velocity: [number, number, number];
}

/** A rain source for `PrecipitationField`: the rate at the ground under the clouds, mm/h. */
export interface CloudRain {
  /** The rain rate at (x, z), mm/h. */
  rate(x: number, z: number, t: number): number;
  /** The strongest rain now, mm/h. */
  readonly peak: number;
}

const STATE = [
  'u',
  'v',
  'w',
  'theta',
  'vapour',
  'cloud',
  'rain',
  'pressure',
  'surfaceRain',
  'meanU',
  'meanW',
  'projection',
] as const;
const PROJECTION_WORDS = 4;
const NO_NATIVE_WORK: CloudProjectionWorkCounts = Object.freeze({
  threads: 1,
  applications: 0,
  cells: 0,
  pairedCells: 0,
  workers: Object.freeze([{ cells: 0, pairedCells: 0 }]),
});

/** Native pressure projection options. Four partitions include the world worker and three helpers. */
export interface CloudSolverLoadOptions extends CloudProjectionLoadOptions {
  readonly id?: string;
}

/** Projection statistics from the most recently accepted cloud interval. */
export interface CloudProjectionDiagnostics {
  readonly iterations: number;
  /** RMS divergence in inverse seconds, before and after the MAC face update. */
  readonly divergenceBefore: number;
  readonly divergenceAfter: number;
  /** L2 norm of the independently recomputed residual divided by the L2 right-hand side. */
  readonly relativeResidual: number;
}

export type { CloudProjectionWorkCounts } from './projection-kernel.js';
type StateName = (typeof STATE)[number];

/**
 * Moist convection in a box of air: cumulus that grow from warm, moist ground, build, rain and drift. A framework solver
 * (`Solver`): add it to a `PhysicsWorld` with its {@link CloudParams}.
 */
export class CloudSolver implements Solver<CloudParams> {
  private readonly id: string;
  private host!: SolverHost;
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private h = 0;
  private x0 = 0;
  private z0 = 0;
  private ground = 0;
  private settings!: Required<Omit<CloudParams, 'wind' | 'cells' | 'centre' | 'bubbles'>>;
  private wind: Wind | undefined;
  private random!: RandomStream;
  // The environment, by layer.
  private theta0!: Float64Array;
  private vapour0!: Float64Array;
  private exner!: Float64Array;
  private pressure0!: Float64Array;
  private density0!: Float64Array;
  private thetaV0!: Float64Array;
  private working: Map<StateName, Float64Array<ArrayBuffer>> | undefined;
  private readonly candidate = new Map<StateName, Float64Array<ArrayBuffer>>();
  private projectionWorkspace!: Region;
  private nativeProjection: CloudProjection | undefined;
  private lastWork: CloudProjectionWorkCounts = NO_NATIVE_WORK;
  private disposed = false;
  private projectionInput!: Float64Array<ArrayBuffer>;
  private projectionResidual!: Float64Array<ArrayBuffer>;
  private projectionPreconditioned!: Float64Array<ArrayBuffer>;
  private regions = new Map<StateName, Region>();
  private clock!: Region;
  private port!: Region;
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /** @param id The solver's id (default `'clouds'`). */
  constructor(id = 'clouds') {
    if (typeof id !== 'string' || !id || id.trim() !== id)
      throw new MargoError('state', 'Invalid cloud solver id; pass a nonempty string without surrounding spaces.');
    this.id = id;
  }

  /** Load native SIMD pressure projection. The constructor remains available for scalar projection. */
  static async load(options: CloudSolverLoadOptions = {}): Promise<CloudSolver> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new MargoError('state', 'Invalid cloud load options; pass an options object or omit it.');
    const solver = new CloudSolver(options.id),
      { CloudProjection } = await import('./projection-kernel.js');
    solver.nativeProjection = await CloudProjection.load(options);
    return solver;
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.nativeProjection?.[Symbol.dispose]();
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [{ field: CLOUD_WATER_FIELD, access: 'write' }],
      rate: 0 as RateLevel,
      stableRate: () => 0 as RateLevel,
    };
  }

  init(host: SolverHost, params: CloudParams = {}): void {
    if (this.disposed)
      throw new MargoError('disposed', 'The cloud solver has been disposed; construct or load a new solver.');
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new MargoError('state', 'Invalid cloud parameters; pass a CloudParams object or omit it.');
    const {
      cells = [48, 24, 48],
      cellSize = 200,
      centre = [0, 0],
      ground = 0,
      altitude = 0,
      seaLevelTemperature = 298.15,
      humidity = 0.75,
      humidityTop = 0.3,
      surfaceHeat = 250,
      surfaceLatent = 150,
      patchiness = 0.6,
      thermalPeriod = 600,
      wind,
      timeScale = 1,
      interval = 2,
      vorticity = 0.2,
      worldCellSize = 4096,
      bubbles = [],
    } = params;
    if (
      !Array.isArray(cells) ||
      cells.length !== 3 ||
      ![cells[0], cells[1], cells[2]].every((n) => Number.isInteger(n) && n >= 2 && n <= 512)
    )
      throw new MargoError('state', `A cloud box has 2 to 512 whole cells along each axis (got ${cells}); pass three.`);
    for (const [name, value] of [
      ['cell size', cellSize],
      ['sea-level temperature', seaLevelTemperature],
      ['thermal period', thermalPeriod],
      ['time scale', timeScale],
      ['interval', interval],
      ['world cell size', worldCellSize],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw new MargoError('state', `A cloud box's ${name} is a finite number above 0 (got ${value}); pass one.`);
    for (const [name, value] of [
      ['humidity', humidity],
      ['top humidity', humidityTop],
      ['patchiness', patchiness],
    ] as const)
      if (!(Number.isFinite(value) && value >= 0 && value <= 1))
        throw new MargoError('state', `A cloud box's ${name} lies in [0, 1] (got ${value}); pass one in that range.`);
    for (const [name, value] of [
      ['surface heat', surfaceHeat],
      ['surface latent heat', surfaceLatent],
      ['vorticity', vorticity],
    ] as const)
      if (!(value >= 0 && Number.isFinite(value)))
        throw new MargoError('state', `A cloud box's ${name} is a finite number, 0 or more (got ${value}); pass one.`);
    if (
      !Array.isArray(centre) ||
      centre.length !== 2 ||
      ![centre[0], centre[1]].every(Number.isFinite) ||
      !Number.isFinite(ground) ||
      !Number.isFinite(altitude)
    )
      throw new MargoError(
        'state',
        'A cloud box needs a finite centre [x, z], ground and altitude in metres; pass them.',
      );
    const cellsCount = cells[0] * cells[1] * cells[2];
    if (cellsCount > MAX_CELLS)
      throw new MargoError('state', `A cloud box has room for ${MAX_CELLS} cells; reduce one or more grid dimensions.`);
    if (
      !Number.isFinite(cells[1] * cellSize + altitude) ||
      !Number.isFinite(ground + cells[1] * cellSize) ||
      !Number.isFinite(Math.abs(centre[0]) + (cells[0] * cellSize) / 2) ||
      !Number.isFinite(Math.abs(centre[1]) + (cells[2] * cellSize) / 2)
    )
      throw new MargoError(
        'state',
        'Cloud grid bounds must fit in finite metres; bring the centre and ground into their local origin and reduce the cell size.',
      );
    if (
      wind !== undefined &&
      (!wind || wind.medium !== 'air' || typeof wind.sample !== 'function' || !validOrigin(wind.cell))
    )
      throw new MargoError(
        'state',
        'Clouds use an air Wind with a signed origin cell; pass a BoundaryLayerWind or another Wind for air.',
      );
    if (!Array.isArray(bubbles))
      throw new MargoError('state', 'Cloud bubbles must be an array; pass an array of CloudBubble options.');
    const validBubbles = Array.from(bubbles, (bubble: CloudBubble, n) => {
      if (
        !bubble ||
        !Array.isArray(bubble.centre) ||
        bubble.centre.length !== 3 ||
        ![bubble.centre[0], bubble.centre[1], bubble.centre[2]].every(Number.isFinite) ||
        !(bubble.radius > 0) ||
        !Number.isFinite(bubble.radius) ||
        !Number.isFinite(bubble.warming)
      )
        throw new MargoError(
          'state',
          `Bubble ${n} needs a finite centre [x, y, z], a radius above 0 and a finite warming; pass them.`,
        );
      if (
        bubble.humidity !== undefined &&
        !(Number.isFinite(bubble.humidity) && bubble.humidity >= 0 && bubble.humidity <= 1.2)
      )
        throw new MargoError('state', `Bubble ${n}'s humidity lies in [0, 1.2]; pass one in that range.`);
      return bubble;
    });
    this.host = host;
    [this.nx, this.ny, this.nz] = cells;
    this.h = cellSize;
    this.x0 = centre[0] - (this.nx * cellSize) / 2;
    this.z0 = centre[1] - (this.nz * cellSize) / 2;
    this.ground = ground;
    this.wind = wind;
    this.settings = {
      cellSize,
      ground,
      altitude,
      seaLevelTemperature,
      humidity,
      humidityTop,
      surfaceHeat,
      surfaceLatent,
      patchiness,
      thermalPeriod,
      timeScale,
      interval,
      vorticity,
      worldCellSize,
    };
    this.random = new RandomStream(0, solverNumber(this.id));
    const { nx, ny, nz } = this;
    this.theta0 = new Float64Array(ny);
    this.vapour0 = new Float64Array(ny);
    this.exner = new Float64Array(ny);
    this.pressure0 = new Float64Array(ny);
    this.density0 = new Float64Array(ny);
    this.thetaV0 = new Float64Array(ny);
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * cellSize,
        [t, p] = standardAtmosphere(altitude + y, seaLevelTemperature),
        pi = pow(p / REFERENCE_PRESSURE, R_OVER_CP),
        rh = humidity + ((humidityTop - humidity) * (j + 0.5)) / ny;
      const density = airDensity(t, p);
      if (
        !(
          t > SATURATION_MINIMUM_K &&
          p > 0 &&
          density > 0 &&
          Number.isFinite(t) &&
          Number.isFinite(p) &&
          Number.isFinite(density)
        )
      )
        throw new MargoError(
          'state',
          'The cloud reference atmosphere has invalid temperature or density; use a smaller altitude, grid height or a realistic sea-level temperature.',
        );
      this.pressure0[j] = p;
      this.density0[j] = density;
      this.exner[j] = pi;
      this.theta0[j] = t / pi;
      this.vapour0[j] = rh * saturation(t, p);
      this.thetaV0[j] = this.theta0[j]! * (1 + 0.61 * this.vapour0[j]!);
    }
    const sizes: Record<StateName, number> = {
      u: (nx + 1) * ny * nz,
      v: nx * (ny + 1) * nz,
      w: nx * ny * (nz + 1),
      theta: cellsCount,
      vapour: cellsCount,
      cloud: cellsCount,
      rain: cellsCount,
      pressure: cellsCount,
      surfaceRain: nx * nz,
      meanU: ny,
      meanW: ny,
      projection: PROJECTION_WORDS,
    };
    for (const name of STATE) {
      this.regions.set(name, host.allocate(name, sizes[name] * 8, 'f64', CLOUD_LAYOUT));
      this.candidate.set(name, new Float64Array(sizes[name]));
    }
    this.projectionWorkspace = host.allocate('projectionScratch', cellsCount * 32, 'f64', CLOUD_LAYOUT);
    this.nativeProjection?.bind(host, nx, ny, nz);
    this.lastWork = this.nativeProjection?.workCounts() ?? NO_NATIVE_WORK;
    const degree = (regionWords(host.memory, this.projectionWorkspace) as Float64Array).subarray(0, cellsCount);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++)
          degree[i + nx * (j + ny * k)] =
            Number(i > 0) +
            Number(i < nx - 1) +
            Number(j > 0) +
            Number(j < ny - 1) +
            Number(k > 0) +
            Number(k < nz - 1);
    this.projectionInput = new Float64Array(cellsCount);
    this.projectionResidual = new Float64Array(cellsCount);
    this.projectionPreconditioned = new Float64Array(cellsCount);
    this.clock = host.allocate('clock', 16, 'f64', CLOUD_LAYOUT);
    this.port = host.allocate('cloudWater', cellsCount * 4, 'f32', CLOUD_LAYOUT);
    const vapour = this.words('vapour'),
      theta = this.words('theta');
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) vapour[i + nx * (j + ny * k)] = this.vapour0[j]!;
    for (const { centre: at, radius, warming, humidity: wet } of validBubbles) {
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const dx = this.x0 + (i + 0.5) * cellSize - at[0],
              dy = (j + 0.5) * cellSize - at[1],
              dz = this.z0 + (k + 0.5) * cellSize - at[2],
              r = hypot(dx / radius, dy / radius, dz / radius);
            if (r >= 1) continue;
            const c = i + nx * (j + ny * k),
              shape = 0.5 + 0.5 * cosine(3.141592653589793 * r);
            theta[c]! += warming * shape;
            if (wet !== undefined) {
              const t = (this.theta0[j]! + theta[c]!) * this.exner[j]!,
                wanted = wet * saturation(t, this.pressure0[j]!);
              vapour[c] = vapour[c]! + shape * (wanted - vapour[c]!);
            }
          }
    }
    this.checkCellState();
  }

  private words(name: StateName): Float64Array {
    return this.working?.get(name) ?? (regionWords(this.host.memory, this.regions.get(name)!) as Float64Array);
  }

  step(context: StepContext, dt: number): void {
    if (this.disposed)
      throw new MargoError('state', 'The cloud solver has been disposed; add a fresh solver to a new world.');
    if (this.random.seed !== context.seed) this.random = new RandomStream(context.seed, solverNumber(this.id));
    const clock = regionWords(this.host.memory, this.clock) as Float64Array,
      { interval, timeScale } = this.settings;
    let pending = clock[0]! + dt * timeScale,
      time = clock[1]!;
    if (!(pending / interval < MAX_SUBSTEPS + 1) || !Number.isFinite(time + pending))
      throw new MargoError(
        'state',
        'A world tick exceeds the cloud substep or time budget; reduce timeScale or increase interval.',
      );
    this.nativeProjection?.resetWork();
    if (pending < interval) {
      this.lastWork = this.nativeProjection?.workCounts() ?? NO_NATIVE_WORK;
      clock[0] = pending;
      return;
    }
    for (const name of STATE) this.candidate.get(name)!.set(this.words(name));
    this.working = this.candidate;
    try {
      let substeps = 0;
      while (pending >= interval) {
        if (substeps++ >= MAX_SUBSTEPS || !(time + interval > time))
          throw new MargoError('state', 'Cloud time cannot advance safely; lower timeScale or use a larger interval.');
        this.advance(interval, time);
        pending -= interval;
        time += interval;
      }
      this.checkCellState();
    } finally {
      this.working = undefined;
    }
    for (const name of STATE) this.words(name).set(this.candidate.get(name)!);
    this.lastWork = this.nativeProjection?.workCounts() ?? NO_NATIVE_WORK;
    clock[0] = pending;
    clock[1] = time;
  }

  exportPorts(tick: number): readonly Port[] {
    const cloud = this.words('cloud'),
      out = regionWords(this.host.memory, this.port) as Float32Array;
    for (let c = 0; c < cloud.length; c++) out[c] = cloud[c]!;
    return [{ field: CLOUD_WATER_FIELD.name, region: this.port, tick, cell: this.host.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return STATE.map((name) => this.regions.get(name)!);
  }

  extraState(): readonly Region[] {
    return [this.clock];
  }

  /** The cloud box's signed origin cell, as retained by the world and its snapshots. */
  get cell(): Cell {
    return this.host.cell;
  }

  /** Native work from the last accepted world tick. Work receipts are excluded from world snapshots. */
  workCounts(): CloudProjectionWorkCounts {
    return this.lastWork;
  }

  get projectionDiagnostics(): CloudProjectionDiagnostics {
    const [iterations, divergenceBefore, divergenceAfter, relativeResidual] = this.words('projection');
    return {
      iterations: iterations!,
      divergenceBefore: divergenceBefore!,
      divergenceAfter: divergenceAfter!,
      relativeResidual: relativeResidual!,
    };
  }

  /** Cells along x, y and z, and the cell edge in metres. */
  get grid(): { cells: [number, number, number]; cellSize: number; origin: [number, number, number] } {
    return { cells: [this.nx, this.ny, this.nz], cellSize: this.h, origin: [this.x0, this.ground, this.z0] };
  }

  /** Seconds of cloud time simulated so far. */
  get time(): number {
    return (regionWords(this.host.memory, this.clock) as Float64Array)[1]!;
  }

  /** A copy of the cloud water, kg/kg, cell by cell with x fastest, then y (up), then z: a density volume to draw. */
  cloudWater(): Float32Array {
    return Float32Array.from(this.words('cloud'));
  }

  /** The air at (x, y, z) m from the solver's cell origin: water, temperature and velocity, trilinear between cells. */
  sample(x: number, y: number, z: number, out?: CloudSample): CloudSample {
    if (![x, y, z].every(Number.isFinite))
      throw new MargoError(
        'state',
        'Cloud sampling needs finite local coordinates; pass finite metres from the cloud origin.',
      );
    const s = out ?? { cloudWater: 0, rainWater: 0, vapour: 0, temperature: 0, velocity: [0, 0, 0] },
      px = (x - this.x0) / this.h,
      py = (y - this.ground) / this.h,
      pz = (z - this.z0) / this.h,
      j = Math.min(this.ny - 1, Math.max(0, Math.floor(py - 0.5))),
      theta = this.scalarAt(this.words('theta'), px, py, pz, 0);
    s.cloudWater = this.scalarAt(this.words('cloud'), px, py, pz, 0);
    s.rainWater = this.scalarAt(this.words('rain'), px, py, pz, 0);
    s.vapour = this.scalarAt(this.words('vapour'), px, py, pz, -1);
    s.temperature = (this.layer(this.theta0, py) + theta) * this.layer(this.exner, py);
    this.velocityAt(px, py, pz, s.velocity);
    s.velocity[0] += this.words('meanU')[j]!;
    s.velocity[2] += this.words('meanW')[j]!;
    return s;
  }

  /** The rain reaching the ground at (x, z), mm/h, bilinear between columns. */
  rainRate(x: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw new MargoError(
        'state',
        'Cloud rain sampling needs finite local coordinates; pass finite X and Z in metres.',
      );
    const rain = this.words('surfaceRain'),
      { nx, nz } = this,
      px = (x - this.x0) / this.h - 0.5,
      pz = (z - this.z0) / this.h - 0.5;
    if (px < -0.5 || pz < -0.5 || px > nx - 0.5 || pz > nz - 0.5) return 0;
    const i = Math.min(nx - 2, Math.max(0, Math.floor(px))),
      k = Math.min(nz - 2, Math.max(0, Math.floor(pz))),
      fx = Math.min(1, Math.max(0, px - i)),
      fz = Math.min(1, Math.max(0, pz - k)),
      at = (a: number, b: number) => rain[a + nx * b]!;
    return (
      3600 *
      ((1 - fz) * ((1 - fx) * at(i, k) + fx * at(i + 1, k)) + fz * ((1 - fx) * at(i, k + 1) + fx * at(i + 1, k + 1)))
    );
  }

  /** The rain under the clouds as a source for `PrecipitationField` (give it `base` half a cell above the ground). */
  rainSource(): CloudRain {
    const self = this;
    return {
      rate: (x, z) => self.rainRate(x, z),
      get peak() {
        let peak = 0;
        for (const r of self.words('surfaceRain')) peak = Math.max(peak, r * 3600);
        return peak;
      },
    };
  }

  /** `base` with this box's own flow added inside it: the gusts and outflow of the clouds, for the solvers that read wind. */
  windWith(base: Wind): Wind {
    const self = this,
      v: [number, number, number] = [0, 0, 0];
    return {
      medium: 'air',
      cell: base.cell,
      sample(x: number, y: number, z: number, t: number, out?: FlowSample): FlowSample {
        const delta = originDelta(base.cell, self.host.cell, self.settings.worldCellSize);
        const s = base.sample(x, y, z, t, out);
        self.velocityAt(
          (x + delta[0] - self.x0) / self.h,
          (y + delta[1] - self.ground) / self.h,
          (z + delta[2] - self.z0) / self.h,
          v,
        );
        s.velocity[0] += v[0];
        s.velocity[1] += v[1];
        s.velocity[2] += v[2];
        return s;
      },
    };
  }

  /** A layer value at height `py` cells, linear between layer centres. */
  private layer(values: Float64Array, py: number): number {
    const q = Math.min(this.ny - 1, Math.max(0, py - 0.5)),
      j = Math.min(this.ny - 2, Math.floor(q)),
      f = q - j;
    return values[j]! * (1 - f) + values[j + 1]! * f;
  }

  /**
   * A cell-centred field at (px, py, pz) in cells from the box's corner, trilinear; outside the box sideways the environment
   * (`environment` 0 for a perturbation, -1 for the vapour's layer value). Heights clamp to the box.
   */
  private scalarAt(field: Float64Array, px: number, py: number, pz: number, environment: number): number {
    const { nx, ny, nz } = this;
    if (px < 0 || pz < 0 || px > nx || pz > nz) return environment < 0 ? this.layer(this.vapour0, py) : environment;
    return trilinear(field, nx, ny, nz, px - 0.5, py - 0.5, pz - 0.5);
  }

  /** The box's own flow at (px, py, pz) in cells, from its faces; zero outside it. */
  private velocityAt(px: number, py: number, pz: number, out: [number, number, number]): [number, number, number] {
    const { nx, ny, nz } = this;
    if (px < 0 || pz < 0 || py < 0 || px > nx || pz > nz || py > ny) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    out[0] = trilinear(this.words('u'), nx + 1, ny, nz, px, py - 0.5, pz - 0.5);
    out[1] = trilinear(this.words('v'), nx, ny + 1, nz, px - 0.5, py, pz - 0.5);
    out[2] = trilinear(this.words('w'), nx, ny, nz + 1, px - 0.5, py - 0.5, pz);
    return out;
  }

  /** One step of `dt` seconds of cloud time starting at cloud time `time`. */
  private advance(dt: number, time: number): void {
    this.meanWind(time);
    this.advect(dt);
    this.forces(dt, time);
    this.project(dt);
    this.microphysics(dt);
  }

  private checkCellState(): void {
    const theta = this.words('theta'),
      vapour = this.words('vapour'),
      cloud = this.words('cloud'),
      rain = this.words('rain');
    for (let c = 0; c < theta.length; c++) {
      const j = Math.floor(c / this.nx) % this.ny;
      const temperature = (this.theta0[j]! + theta[c]!) * this.exner[j]!;
      if (
        !(
          temperature > SATURATION_MINIMUM_K &&
          Number.isFinite(temperature) &&
          vapour[c]! >= 0 &&
          cloud[c]! >= 0 &&
          cloud[c]! <= STATE_F32_MAX &&
          rain[c]! >= 0 &&
          Number.isFinite(vapour[c]!) &&
          Number.isFinite(rain[c]!)
        )
      )
        throw new MargoError(
          'state',
          'Cloud thermodynamics left its finite warm-rain domain; reduce bubble warming or ground forcing and use a smaller interval.',
        );
    }
    for (const rate of this.words('surfaceRain')) {
      if (!(rate >= 0 && Number.isFinite(rate * 3600)))
        throw new MargoError(
          'state',
          'Cloud surface rain is outside finite millimetres per hour; reduce the moisture forcing or interval.',
        );
    }
  }

  /** The mean wind of each layer, from the wind over the box's centre. */
  private meanWind(time: number): void {
    const wind = this.wind,
      meanU = this.words('meanU'),
      meanW = this.words('meanW');
    if (!wind) {
      meanU.fill(0);
      meanW.fill(0);
      return;
    }
    const delta = originDelta(this.host.cell, wind.cell, this.settings.worldCellSize),
      cx = this.x0 + (this.nx * this.h) / 2 + delta[0],
      cz = this.z0 + (this.nz * this.h) / 2 + delta[2];
    for (let j = 0; j < this.ny; j++) {
      // The wind runs on world time; cloud time runs `timeScale` times faster.
      const y = this.ground + (j + 0.5) * this.h + delta[1];
      if (![cx, y, cz].every(Number.isFinite))
        throw new MargoError(
          'state',
          'Cloud wind coordinates have overflowed; rebase closer to the Wind cell or use a smaller worldCellSize.',
        );
      const v = wind.sample(cx, y, cz, time / this.settings.timeScale, this.flow)?.velocity;
      if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[2]))
        throw new MargoError(
          'state',
          'Cloud advection needs finite wind; return finite horizontal velocity from Wind.sample().',
        );
      meanU[j] = v[0];
      meanW[j] = v[2];
    }
  }

  /** Semi-Lagrangian advection of every field by the flow plus the mean wind, back along a midpoint (RK2) path. */
  private advect(dt: number): void {
    const { nx, ny, nz, h } = this,
      u = this.words('u'),
      v = this.words('v'),
      w = this.words('w'),
      nu = Float64Array.from(u),
      nv = Float64Array.from(v),
      nw = Float64Array.from(w),
      vel: [number, number, number] = [0, 0, 0],
      // Where the air at (px, py, pz) cells was dt ago.
      back = (px: number, py: number, pz: number): [number, number, number] => {
        this.totalVelocity(px, py, pz, vel);
        const mx = px - (0.5 * dt * vel[0]) / h,
          my = py - (0.5 * dt * vel[1]) / h,
          mz = pz - (0.5 * dt * vel[2]) / h;
        this.totalVelocity(mx, my, mz, vel);
        return [px - (dt * vel[0]) / h, py - (dt * vel[1]) / h, pz - (dt * vel[2]) / h];
      };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const [bx, by, bz] = back(i, j + 0.5, k + 0.5);
          nu[i + (nx + 1) * (j + ny * k)] = this.velocityAt(bx, by, bz, vel)[0];
        }
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const [bx, by, bz] = back(i + 0.5, j, k + 0.5);
          nv[i + nx * (j + (ny + 1) * k)] = this.velocityAt(bx, by, bz, vel)[1];
        }
    for (let k = 1; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const [bx, by, bz] = back(i + 0.5, j + 0.5, k);
          nw[i + nx * (j + ny * k)] = this.velocityAt(bx, by, bz, vel)[2];
        }
    const scalars = (['theta', 'vapour', 'cloud', 'rain'] as const).map((name) => [name, this.words(name)] as const),
      next = scalars.map(([, f]) => new Float64Array(f.length));
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k),
            [bx, by, bz] = back(i + 0.5, j + 0.5, k + 0.5);
          for (let s = 0; s < scalars.length; s++)
            next[s]![c] = this.scalarAt(scalars[s]![1], bx, by, bz, scalars[s]![0] === 'vapour' ? -1 : 0);
        }
    u.set(nu);
    v.set(nv);
    w.set(nw);
    for (let s = 0; s < scalars.length; s++) scalars[s]![1].set(next[s]!);
  }

  /** The box's flow plus the mean wind of the layer, at (px, py, pz) cells. */
  private totalVelocity(px: number, py: number, pz: number, out: [number, number, number]): void {
    this.velocityAt(px, py, pz, out);
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor(py)));
    out[0] += this.words('meanU')[j]!;
    out[2] += this.words('meanW')[j]!;
  }

  /** Buoyancy, vorticity confinement, and the ground's heat and water. */
  private forces(dt: number, time: number): void {
    const { nx, ny, nz, h } = this,
      [gx, gy, gz] = this.host.gravity,
      g = hypot(gx, gy, gz),
      theta = this.words('theta'),
      vapour = this.words('vapour'),
      cloud = this.words('cloud'),
      rain = this.words('rain'),
      v = this.words('v'),
      buoyancy = new Float64Array(nx * ny * nz);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k),
            thetaV = (this.theta0[j]! + theta[c]!) * (1 + 0.61 * vapour[c]!);
          buoyancy[c] = g * (thetaV / this.thetaV0[j]! - 1 - cloud[c]! - rain[c]!);
        }
    // On the interior horizontal faces, the mean of the two cells.
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++)
          v[i + nx * (j + (ny + 1) * k)]! +=
            0.5 * dt * (buoyancy[i + nx * (j - 1 + ny * k)]! + buoyancy[i + nx * (j + ny * k)]!);
    if (this.settings.vorticity > 0) this.confine(dt);
    // The ground's fluxes into the lowest layer, patchy by column for one thermal period at a time.
    const { surfaceHeat, surfaceLatent, patchiness, thermalPeriod } = this.settings,
      epoch = Math.floor(time / thermalPeriod),
      rho = this.density0[0]!,
      heat = (surfaceHeat * dt) / (rho * AIR_HEAT_CAPACITY * h * this.exner[0]!),
      water = (surfaceLatent * dt) / (rho * LATENT_HEAT * h);
    if (heat === 0 && water === 0) return;
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++) {
        const column = i + nx * k,
          f = 1 + patchiness * (2 * this.random.uniform(epoch, column, 0) - 1),
          c = i + nx * (ny * k);
        theta[c]! += heat * f;
        vapour[c]! += water * f;
      }
  }

  /** Vorticity confinement (Fedkiw, Stam and Jensen 2001, as Harris et al. use it): eps h (N x omega). */
  private confine(dt: number): void {
    const { nx, ny, nz, h } = this,
      n = nx * ny * nz,
      ox = new Float64Array(n),
      oy = new Float64Array(n),
      oz = new Float64Array(n),
      mag = new Float64Array(n),
      vel = (i: number, j: number, k: number, out: [number, number, number]) =>
        this.velocityAt(i + 0.5, j + 0.5, k + 0.5, out),
      a: [number, number, number] = [0, 0, 0],
      b: [number, number, number] = [0, 0, 0],
      clampI = (i: number, m: number) => Math.min(m - 1, Math.max(0, i));
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k),
            d = (axis: number, comp: number): number => {
              const lo = [i, j, k],
                hi = [i, j, k];
              lo[axis] = clampI(lo[axis]! - 1, [nx, ny, nz][axis]!);
              hi[axis] = clampI(hi[axis]! + 1, [nx, ny, nz][axis]!);
              vel(lo[0]!, lo[1]!, lo[2]!, a);
              vel(hi[0]!, hi[1]!, hi[2]!, b);
              const span = (hi[axis]! - lo[axis]!) * h;
              return span > 0 ? (b[comp]! - a[comp]!) / span : 0;
            };
          ox[c] = d(1, 2) - d(2, 1);
          oy[c] = d(2, 0) - d(0, 2);
          oz[c] = d(0, 1) - d(1, 0);
          mag[c] = Math.sqrt(ox[c]! * ox[c]! + oy[c]! * oy[c]! + oz[c]! * oz[c]!);
        }
    const eps = this.settings.vorticity,
      u = this.words('u'),
      v = this.words('v'),
      w = this.words('w'),
      fx = new Float64Array(n),
      fy = new Float64Array(n),
      fz = new Float64Array(n);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k),
            at = (ii: number, jj: number, kk: number) =>
              mag[clampI(ii, nx) + nx * (clampI(jj, ny) + ny * clampI(kk, nz))]!,
            gx = (at(i + 1, j, k) - at(i - 1, j, k)) / (2 * h),
            gy = (at(i, j + 1, k) - at(i, j - 1, k)) / (2 * h),
            gz = (at(i, j, k + 1) - at(i, j, k - 1)) / (2 * h),
            len = Math.sqrt(gx * gx + gy * gy + gz * gz);
          if (!(len > 1e-30)) continue;
          const Nx = gx / len,
            Ny = gy / len,
            Nz = gz / len;
          fx[c] = eps * h * (Ny * oz[c]! - Nz * oy[c]!);
          fy[c] = eps * h * (Nz * ox[c]! - Nx * oz[c]!);
          fz[c] = eps * h * (Nx * oy[c]! - Ny * ox[c]!);
        }
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++)
          u[i + (nx + 1) * (j + ny * k)]! += 0.5 * dt * (fx[i - 1 + nx * (j + ny * k)]! + fx[i + nx * (j + ny * k)]!);
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++)
          v[i + nx * (j + (ny + 1) * k)]! += 0.5 * dt * (fy[i + nx * (j - 1 + ny * k)]! + fy[i + nx * (j + ny * k)]!);
    for (let k = 1; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++)
          w[i + nx * (j + ny * k)]! += 0.5 * dt * (fz[i + nx * (j + ny * (k - 1))]! + fz[i + nx * (j + ny * k)]!);
  }

  /** Signed MAC face speed balance across each closed cell, equal to cell width times divergence. */
  private faceBalance(target: Float64Array): number {
    const { nx, ny, nz } = this,
      u = this.words('u'),
      v = this.words('v'),
      w = this.words('w');
    let largest = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k),
            a = i + (nx + 1) * (j + ny * k),
            b = i + nx * (j + (ny + 1) * k),
            balance = u[a + 1]! - u[a]! + (v[b + nx]! - v[b]!) + (w[c + nx * ny]! - w[c]!);
          target[c] = balance;
          largest = Math.max(largest, Math.abs(balance));
        }
    return largest;
  }

  /** Harlow–Welch MAC and Chorin projection with a Jacobi-preconditioned Neumann solve. */
  private project(dt: number): void {
    const { nx, ny, nz, h } = this,
      n = nx * ny * nz,
      u = this.words('u'),
      v = this.words('v'),
      w = this.words('w'),
      acceptedPressure = this.words('pressure'),
      evidence = this.words('projection'),
      rhs = this.projectionInput,
      r = this.projectionResidual,
      z = this.projectionPreconditioned,
      workspace = regionWords(this.host.memory, this.projectionWorkspace) as Float64Array,
      degree = workspace.subarray(0, n),
      p = workspace.subarray(n, n * 2),
      d = workspace.subarray(n * 2, n * 3),
      q = workspace.subarray(n * 3);
    const speed = this.faceBalance(rhs);
    if (!Number.isFinite(speed))
      throw new MargoError('state', 'Cloud velocity divergence has overflowed; reduce the interval or the forcing.');
    if (speed === 0) {
      acceptedPressure.fill(0);
      evidence.fill(0);
      return;
    }
    // Solve for pressure multiplied by dt / (h * speed). This conditions the RHS without squaring large velocities.
    let mean = 0,
      beforeSquared = 0;
    for (let c = 0; c < n; c++) {
      rhs[c] = -rhs[c]! / speed;
      mean += rhs[c]!;
      beforeSquared += rhs[c]! * rhs[c]!;
    }
    mean /= n;
    p.fill(0);
    let bSquared = 0,
      rz = 0;
    for (let c = 0; c < n; c++) {
      rhs[c]! -= mean;
      r[c] = rhs[c]!;
      z[c] = d[c] = r[c]! / degree[c]!;
      bSquared += rhs[c]! * rhs[c]!;
      rz += r[c]! * z[c]!;
    }
    const toleranceSquared = PROJECTION_RELATIVE_TOLERANCE ** 2 * bSquared;
    let residualSquared = bSquared,
      iterations = 0;
    while (residualSquared > toleranceSquared && iterations < PROJECTION_ITERATIONS) {
      this.pressureOperator(d, degree, q);
      let curvature = 0;
      for (let c = 0; c < n; c++) curvature += d[c]! * q[c]!;
      if (!(curvature > 0) || !Number.isFinite(curvature)) break;
      const alpha = rz / curvature;
      let next = 0;
      residualSquared = 0;
      for (let c = 0; c < n; c++) {
        p[c]! += alpha * d[c]!;
        r[c]! -= alpha * q[c]!;
        z[c] = r[c]! / degree[c]!;
        next += r[c]! * z[c]!;
        residualSquared += r[c]! * r[c]!;
      }
      const beta = next / rz;
      rz = next;
      for (let c = 0; c < n; c++) d[c] = z[c]! + beta * d[c]!;
      iterations++;
    }
    // Check the actual operator residual as well as the recurrence. Neither publishes on failed convergence.
    this.pressureOperator(p, degree, q);
    let actualSquared = 0;
    for (let c = 0; c < n; c++) {
      const error = rhs[c]! - q[c]!;
      actualSquared += error * error;
    }
    if (!(actualSquared <= toleranceSquared) || !Number.isFinite(actualSquared))
      throw new MargoError(
        'state',
        `Cloud pressure projection did not converge in ${iterations} iterations; reduce the grid dimensions.`,
      );
    // The solved potential is already scaled by dt / h, so only the speed normalisation remains here.
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          u[i + (nx + 1) * (j + ny * k)]! -= speed * (p[c]! - p[c - 1]!);
        }
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          v[i + nx * (j + (ny + 1) * k)]! -= speed * (p[c]! - p[c - nx]!);
        }
    for (let k = 1; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          w[c]! -= speed * (p[c]! - p[c - nx * ny]!);
        }
    this.faceBalance(r);
    let afterSquared = 0;
    for (let c = 0; c < n; c++) {
      const row = r[c]! / speed;
      afterSquared += row * row;
      acceptedPressure[c] = ((p[c]! * speed) / dt) * h;
      if (!Number.isFinite(acceptedPressure[c]))
        throw new MargoError(
          'state',
          'Cloud pressure is outside finite units; reduce the grid scale, wind or forcing.',
        );
    }
    // A mean removed to make the Neumann equation solvable is a roundoff from telescoping closed faces.
    let faceSpeed = 0;
    for (const field of [u, v, w]) for (const value of field) faceSpeed = Math.max(faceSpeed, Math.abs(value));
    const roundoff = ((64 * Number.EPSILON * faceSpeed) / speed) * Math.sqrt(n);
    if (
      !Number.isFinite(afterSquared) ||
      !(Math.sqrt(afterSquared) <= PROJECTION_RELATIVE_TOLERANCE * Math.sqrt(beforeSquared) + roundoff)
    )
      throw new MargoError(
        'state',
        'Cloud projection left excess divergence in the corrected faces; reduce the grid size or the forcing.',
      );
    const after = (Math.sqrt(afterSquared / n) * speed) / h,
      before = (Math.sqrt(beforeSquared / n) * speed) / h;
    if (!Number.isFinite(before) || !Number.isFinite(after))
      throw new MargoError(
        'state',
        'Cloud divergence is outside finite inverse seconds; use larger cells or smaller forcing.',
      );
    evidence.set([iterations, before, after, bSquared === 0 ? 0 : Math.sqrt(actualSquared / bSquared)]);
  }

  private pressureOperator(input: Float64Array, degree: Float64Array, output: Float64Array): void {
    if (this.nativeProjection) {
      this.nativeProjection.apply(input, degree, output);
      return;
    }
    const { nx, ny, nz } = this;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          let value = degree[c]! * input[c]!;
          if (i > 0) value -= input[c - 1]!;
          if (i < nx - 1) value -= input[c + 1]!;
          if (j > 0) value -= input[c - nx]!;
          if (j < ny - 1) value -= input[c + nx]!;
          if (k > 0) value -= input[c - nx * ny]!;
          if (k < nz - 1) value -= input[c + nx * ny]!;
          output[c] = value;
        }
  }

  /** Condensation, Kessler's warm rain, rain evaporation and the rain's fall, cell by cell and column by column. */
  private microphysics(dt: number): void {
    const { nx, ny, nz, h } = this,
      theta = this.words('theta'),
      vapour = this.words('vapour'),
      cloud = this.words('cloud'),
      rain = this.words('rain'),
      surface = this.words('surfaceRain'),
      air = { temperature: 0, vapour: 0, cloud: 0 };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k),
            pi = this.exner[j]!,
            p = this.pressure0[j]!,
            rho = this.density0[j]!,
            heating = LATENT_HEAT / (AIR_HEAT_CAPACITY * pi);
          // Saturation adjustment, in temperature (theta changes by the same heat over pi).
          air.temperature = (this.theta0[j]! + theta[c]!) * pi;
          air.vapour = vapour[c]!;
          air.cloud = cloud[c]!;
          saturate(air, p);
          let th = air.temperature / pi,
            qv = air.vapour,
            qc = air.cloud,
            qr = rain[c]!;
          // Autoconversion and accretion.
          const rhoR = Math.max(0, rho * qr),
            collect = Math.min(
              qc,
              dt *
                (AUTOCONVERSION_RATE * Math.max(0, qc - AUTOCONVERSION_THRESHOLD) +
                  (rhoR > 0 ? 1.72 * qc * pow(rhoR, 0.875) : 0)),
            );
          qc -= collect;
          qr += collect;
          // Rain evaporates into air below saturation.
          const t = th * pi,
            qvs = saturation(t, p);
          if (qr > 0 && qv < qvs) {
            const rr = rho * qr,
              rate =
                (3.86e-3 - 9.41e-5 * (t - 273.15)) * (1 + 9.1 * pow(rr, 0.1875)) * (rho * (qvs - qv)) * Math.sqrt(rr),
              evaporated = Math.min(qr, qvs - qv, (Math.max(0, rate) * dt) / rho);
            qr -= evaporated;
            qv += evaporated;
            th -= heating * evaporated;
          }
          theta[c] = th - this.theta0[j]!;
          vapour[c] = qv;
          cloud[c] = qc;
          rain[c] = qr;
        }
    // The rain's fall: upwind fluxes down each column, in as many substeps as keep it within a cell a substep.
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++) {
        let fastest = 0;
        for (let j = 0; j < ny; j++)
          fastest = Math.max(fastest, rainSpeed(this.density0[j]! * rain[i + nx * (j + ny * k)]!));
        const steps = Math.max(1, Math.ceil((fastest * dt) / h)),
          sub = dt / steps;
        if (!(steps <= MAX_SUBSTEPS))
          throw new MargoError(
            'state',
            'Cloud rainfall exceeds the sedimentation substep budget; reduce interval or increase cellSize.',
          );
        let landed = 0;
        for (let s = 0; s < steps; s++) {
          let above = 0;
          for (let j = ny - 1; j >= 0; j--) {
            const c = i + nx * (j + ny * k),
              rho = this.density0[j]!,
              mass = rho * h * rain[c]!,
              flux = rho * rain[c]! * rainSpeed(rho * rain[c]!),
              out = Math.min(flux * sub, mass);
            rain[c] = (mass - out + above) / (rho * h);
            above = out;
          }
          landed += above;
        }
        surface[i + nx * k] = landed / dt;
      }
  }
}

/** Saturation mixing ratio over water at `t` K and `p` Pa (Harris et al. 2003, eq. 6). */
export function saturation(t: number, p: number): number {
  const c = t - 273.15;
  return (380.16 / p) * exp((17.67 * c) / (c + 243.5));
}

/**
 * Saturation adjustment at pressure `pressure` Pa: condenses the vapour above saturation, or evaporates cloud into air
 * below it, releasing or taking the latent heat, until the air is just saturated or the cloud is gone. Total water is kept
 * exactly; the temperature changes by L / c_p times the water condensed.
 */
export function condense(
  temperature: number,
  pressure: number,
  vapour: number,
  cloud: number,
): { temperature: number; vapour: number; cloud: number } {
  const state = { temperature, vapour, cloud };
  saturate(state, pressure);
  return state;
}

/** Newton steps of {@link adjust} until the change is below a part in 1e13 of the water (at most 20). */
function saturate(state: { temperature: number; vapour: number; cloud: number }, pressure: number): void {
  for (let pass = 0; pass < 20; pass++) {
    const amount = adjust(state.temperature, pressure, state.vapour, state.cloud);
    state.vapour -= amount;
    state.cloud += amount;
    state.temperature += (LATENT_HEAT / AIR_HEAT_CAPACITY) * amount;
    if (Math.abs(amount) <= 1e-13 * (state.vapour + state.cloud)) break;
  }
}

/** Vapour to condense at temperature `t` (negative: cloud to evaporate) so the air ends just saturated, linearised once. */
function adjust(t: number, p: number, qv: number, qc: number): number {
  const qvs = saturation(t, p),
    excess = qv - qvs;
  if (excess <= 0 && qc <= 0) return 0;
  const c = t - 273.15,
    slope = (qvs * 17.67 * 243.5) / ((c + 243.5) * (c + 243.5)),
    amount = excess / (1 + (LATENT_HEAT / AIR_HEAT_CAPACITY) * slope);
  return Math.max(amount, -qc);
}

/** The mass-weighted fall speed of rain of `density` kg/m^3 of rain water, m/s. */
export function rainSpeed(density: number): number {
  return density > 0 ? RAIN_SPEED * pow(density, 0.125) : 0;
}

function validOrigin(cell: Cell): boolean {
  return (
    Array.isArray(cell) &&
    cell.length === 3 &&
    [cell[0], cell[1], cell[2]].every((axis) => Number.isInteger(axis) && axis >= -2147483648 && axis <= 2147483647)
  );
}

function originDelta(from: Cell, to: Cell, size: number): [number, number, number] {
  return [(from[0] - to[0]) * size, (from[1] - to[1]) * size, (from[2] - to[2]) * size];
}

/** Trilinear interpolation in a grid of nx by ny by nz values at (fx, fy, fz) in grid units, clamped to the grid. */
function trilinear(
  field: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  fx: number,
  fy: number,
  fz: number,
): number {
  const x = Math.min(nx - 1, Math.max(0, fx)),
    y = Math.min(ny - 1, Math.max(0, fy)),
    z = Math.min(nz - 1, Math.max(0, fz)),
    i = Math.min(nx - 2, Math.floor(x)),
    j = Math.min(ny - 2, Math.floor(y)),
    k = Math.min(nz - 2, Math.floor(z)),
    a = x - i,
    b = y - j,
    c = z - k,
    at = (ii: number, jj: number, kk: number) => field[ii + nx * (jj + ny * kk)]!;
  return (
    (1 - c) *
      ((1 - b) * ((1 - a) * at(i, j, k) + a * at(i + 1, j, k)) +
        b * ((1 - a) * at(i, j + 1, k) + a * at(i + 1, j + 1, k))) +
    c *
      ((1 - b) * ((1 - a) * at(i, j, k + 1) + a * at(i + 1, j, k + 1)) +
        b * ((1 - a) * at(i, j + 1, k + 1) + a * at(i + 1, j + 1, k + 1)))
  );
}
