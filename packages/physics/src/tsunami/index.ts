import { MargoError } from '@margoengine/math/errors';
import type { BedSample } from '@margoengine/math/fields';
import { cos, pow } from '@margoengine/math/pinned';
import { BED_FIELD, BED_LAYOUT, type BedShape, bedSurface, bedVertexCount } from '../earth/bed.js';
import { WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS } from '../sea/wake.js';
import { regionWords } from '../world/memory.js';
import type { FieldDescriptor, FieldUse, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';
import { bindTsunamiKernel, loadTsunamiBuilds, type TsunamiBuilds, type TsunamiKernel } from './kernel.js';

/** Layout of the cell-centred f64 inundation records. */
export const TSUNAMI_LAYOUT = 1;
/** Cell row: bed altitude, surface altitude, depth, X and Z discharge, peak depth and first wet time. */
export const TSUNAMI_WORDS = 7;
const F64 = 8;
type Pair = readonly [number, number];
type Series = number | ArrayLike<number>;

/** Inputs bound while declaring the solver's registry edges. */
export interface TsunamiLoadOptions {
  /** Solver identifier and owned field prefix. Defaults to 'tsunami'. */
  readonly id?: string;
  /** Layout-1 f64 or f32 celled bottom elevations in metres. Defaults to the initial bathymetry. */
  readonly bottomField?: FieldDescriptor;
  /** Geometry of a live TerrainBed. Mutually exclusive with bottomField. */
  readonly terrain?: BedShape;
  /** Layout-1 f64 SeaSource rows from natural-slide, calving or other local pressure and displacement sources. */
  readonly sources?: readonly FieldDescriptor[];
  readonly signal?: AbortSignal;
}

/** A regular XZ patch including offshore water and dry land. Coordinates are metres from the world cell. */
export interface TsunamiOptions {
  /** X and Z grid dimensions, fastest axis X. */
  readonly cells: Pair;
  /** Grid spacing in metres. */
  readonly spacing: number;
  /** Lower XZ corner. Defaults to [0, 0]. */
  readonly origin?: Pair;
  /** Absolute bottom elevations in metres. Negative is below the default sea level. */
  readonly bathymetry: Series;
  /** Sea level in metres. Defaults to zero. */
  readonly seaLevel?: number;
  /** Initial surface altitude in metres. Defaults to seaLevel. */
  readonly surface?: Series;
  /** Initial depth-integrated X discharge in m²/s. Defaults to zero. */
  readonly dischargeX?: Series;
  /** Initial depth-integrated Z discharge in m²/s. Defaults to zero. */
  readonly dischargeZ?: Series;
  /** Water density in kg/m³. Defaults to 1025. */
  readonly waterDensity?: number;
  /** Manning roughness in s/m^(1/3). Defaults to zero. */
  readonly manning?: number;
  /** Threshold in metres for applying discharge in near-dry cells. Defaults to 1e-7. */
  readonly dryDepth?: number;
  /** Open characteristic boundaries at X low, X high, Z low and Z high. Defaults to all closed. */
  readonly open?: readonly [boolean, boolean, boolean, boolean];
  /** Coriolis frequency in rad/s, signed on the XZ plane. Defaults to zero. */
  readonly coriolis?: number;
  /** Optional wet-patch reference depth for a rapid bottom deformation filter. Zero uses the shallow limit. */
  readonly bottomFilterDepth?: number;
  /** Size of one origin cell in metres. Defaults to 4096. */
  readonly originCellSize?: number;
}

/** Natural slide inputs for the prismatic-channel experiment of Heller and Hager. */
export interface LandslideImpulseOptions {
  /** Still water depth in metres. */
  readonly depth: number;
  /** Slide centroid speed at the shoreline in m/s. */
  readonly speed: number;
  /** Slide thickness in metres. */
  readonly thickness: number;
  /** Cross-channel slide width in metres. */
  readonly width: number;
  /** Slide mass in kilograms. */
  readonly mass: number;
  /** Entry slope in radians, between zero and π/2. */
  readonly angle: number;
  /** Water density in kg/m³. Defaults to 1000, as in the hydraulic tests. */
  readonly waterDensity?: number;
  /** Gravity in m/s². Defaults to 9.80665. */
  readonly gravity?: number;
}

/** A natural slide's dimensionless impulse product and maximum fitted near-field crest amplitude. */
export function landslideImpulse(options: LandslideImpulseOptions): {
  readonly impulseProduct: number;
  readonly amplitude: number;
} {
  if (!options) throw new MargoError('state', 'Give the landslide the water depth, slide speed, thickness and mass.');
  const depth = positive('slide water depth', options.depth);
  const density = positive('slide water density', options.waterDensity ?? 1000);
  const width = positive('slide width', options.width);
  const g = positive('slide gravity', options.gravity ?? 9.80665);
  const angle = checked('slide angle', options.angle, 0);
  if (angle > Math.PI / 2)
    throw new MargoError('state', 'Slide angle exceeds vertical. Use an angle from zero to π/2.');
  const froude = checked('slide speed', options.speed, 0) / Math.sqrt(g * depth);
  const thickness = checked('slide thickness', options.thickness, 0) / depth;
  const mass = checked('slide mass', options.mass, 0) / (density * width * depth * depth);
  const impulseProduct = checked(
    'slide impulse product',
    froude * Math.sqrt(thickness) * Math.sqrt(Math.sqrt(mass)) * Math.sqrt(cos((6 * angle) / 7)),
    0,
  );
  return { impulseProduct, amplitude: checked('slide crest amplitude', depth * (4 / 9) * pow(impulseProduct, 0.8), 0) };
}

/** A cell sample including its inundation history. */
export interface TsunamiSample {
  readonly bed: number;
  readonly height: number;
  readonly depth: number;
  readonly discharge: Pair;
  readonly peakDepth: number;
  /** Seconds since the world starts, or -1 for a cell never inundated. */
  readonly firstWet: number;
}

/** Accepted water state for a coastal renderer, in the solver's local metres. */
export interface TsunamiSurfaceSample {
  /** Water above the bed, in metres. */
  depth: number;
  /** Absolute surface altitude relative to the solver's cell. Dry cells give the bed altitude. */
  surface: number;
  /** Depth-averaged X and Z speeds in m/s. Dry cells have zero speed. */
  velocity: [number, number];
}

/** The synchronous grid and cell samples drawn by Water's ShallowWaterSurface. */
export interface TsunamiSurfaceSource {
  /** Cell dimensions and placement in local metres, matching the Water terrain. */
  readonly shape: {
    readonly columns: number;
    readonly rows: number;
    readonly width: number;
    readonly depth: number;
    readonly centre: Pair;
  };
  /** Read the accepted state in the cell containing local X and Z, reusing the caller's sample. */
  sample(x: number, z: number, out: TsunamiSurfaceSample): TsunamiSurfaceSample;
}

/** Water amounts are m³. Wet land area is m² and the highest run-up is metres above sea level. */
export interface TsunamiBudget {
  readonly initialVolume: number;
  readonly storedVolume: number;
  readonly admittedSourceVolume: number;
  readonly unplacedSourceVolume: number;
  readonly boundaryExportVolume: number;
  readonly wetLandArea: number;
  readonly runup: number;
  readonly maximumDepth: number;
  readonly substeps: number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: TsunamiKernel;
  readonly nx: number;
  readonly nz: number;
  readonly count: number;
  readonly origin: Pair;
  readonly spacing: number;
  readonly cellSize: number;
  readonly filterDepth: number;
  readonly sea: number;
  readonly dry: number;
  readonly state: Region;
  readonly candidate: Region;
  readonly rk: Region;
  readonly trial: Region;
  readonly bed: Region;
  readonly trialBed: Region;
  readonly pressure: Region;
  readonly model: Region;
  readonly log: Region;
  readonly trialLog: Region;
  readonly budget: Region;
  readonly results: Region;
  readonly sourceBudget: Region;
  readonly sourceTimes: Region;
  readonly output: Region;
  readonly travel: Region;
  readonly filter?: Region;
  readonly regions: readonly Region[];
}

function checked(label: string, n: number, min = -Infinity): number {
  if (!(Number.isFinite(n) && n >= min))
    throw new MargoError(
      'state',
      `Invalid tsunami ${label}. Use a finite value${Number.isFinite(min) ? ` at least ${min}` : ''}.`,
    );
  return n;
}

function positive(label: string, n: number): number {
  if (!(Number.isFinite(n) && n > 0))
    throw new MargoError('state', `Invalid tsunami ${label}. Use a positive finite value.`);
  return n;
}

function integer(label: string, n: number, min = 1): number {
  if (!(Number.isSafeInteger(n) && n >= min))
    throw new MargoError('state', `Invalid tsunami ${label}. Use a whole number at least ${min}.`);
  return n;
}

function pair(label: string, coordinates: Pair): Pair {
  if (coordinates?.length !== 2 || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]))
    throw new MargoError('state', `Invalid tsunami ${label}. Use two finite coordinates.`);
  return [coordinates[0], coordinates[1]];
}

function gridValues(label: string, source: Series, n: number): Float64Array {
  if (typeof source === 'number') return new Float64Array(n).fill(checked(label, source));
  if (source?.length !== n) throw new MargoError('state', `Invalid tsunami ${label} length. Pass one value per cell.`);
  return Float64Array.from(source, (value) => checked(label, value));
}

function words(s: State, region: Region): Float64Array {
  return regionWords(s.host.memory, region) as Float64Array;
}

function index(s: State, x: number, z: number): number {
  if (integer('X cell', x, 0) >= s.nx || integer('Z cell', z, 0) >= s.nz)
    throw new MargoError('state', 'Tsunami sample is outside the grid. Use a cell inside the patch.');
  return x + z * s.nx;
}

/** Conservative long gravity waves and wet/dry inundation from natural displacement or pressure fields. */
export class TsunamiSolver implements Solver<TsunamiOptions> {
  /** Layout-1 cell records, X fastest. */
  readonly inundationField: FieldDescriptor;
  private readonly fields: readonly FieldUse[];
  private readonly sources: readonly FieldDescriptor[];
  private readonly terrain?: BedShape;
  private state?: State;

  private constructor(
    private readonly builds: TsunamiBuilds,
    private readonly id: string,
    private readonly bottom?: FieldDescriptor,
    terrain?: BedShape,
    sources: readonly FieldDescriptor[] = [],
  ) {
    this.inundationField = Object.freeze({
      name: `${id}.inundation`,
      kind: 'uniformGrid',
      quantity: 'longWaveState',
      unit: 'SI',
      centring: 'cell',
    });
    if (terrain && bottom)
      throw new MargoError('state', 'Tsunami has two moving seabeds. Use terrain or bottomField for the patch.');
    if (terrain) {
      bedVertexCount(terrain);
      this.terrain = { ...terrain, centre: [terrain.centre[0], terrain.centre[1]] };
    }
    if (!Array.isArray(sources))
      throw new MargoError('state', 'Give tsunami sources as an array of distinct seaSource descriptors.');
    this.sources = sources
      .map((s) => {
        if (typeof s?.name !== 'string' || !s.name || s.quantity !== 'seaSource' || s.unit !== 'SI')
          throw new MargoError('state', 'Give tsunami sources distinct seaSource descriptors in SI units.');
        return Object.freeze({ ...s });
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (this.sources.some((s, i) => s.name === this.sources[i - 1]?.name))
      throw new MargoError('state', 'Invalid tsunami source descriptors. Use distinct seaSource fields in SI units.');
    const bed = terrain ? BED_FIELD : bottom;
    this.fields = [
      { field: this.inundationField, access: 'write' },
      ...(bed ? [{ field: bed, access: 'read' as const }] : []),
      ...this.sources.map((field) => ({ field, access: 'read' as const })),
    ];
  }

  /** Load the optional SIMD implementation. */
  static async load({
    id = 'tsunami',
    bottomField,
    terrain,
    sources,
    signal,
  }: TsunamiLoadOptions = {}): Promise<TsunamiSolver> {
    return new TsunamiSolver(await loadTsunamiBuilds(signal), id, bottomField, terrain, sources);
  }

  describe() {
    return { id: this.id, fields: this.fields, rate: 0 as const, stableRate: () => 0 as const };
  }

  init(host: SolverHost, options: TsunamiOptions): void {
    if (this.state) throw new MargoError('state', 'TsunamiSolver already belongs to a world. Load another solver.');
    if (options?.cells?.length !== 2)
      throw new MargoError('state', 'Give the tsunami grid two positive whole cell counts in X and Z.');
    const nx = integer('X cells', options.cells[0]);
    const nz = integer('Z cells', options.cells[1]);
    const count = integer('grid cells', nx * nz);
    const spacing = positive('spacing', options.spacing);
    const cellSize = positive('origin cell size', options.originCellSize ?? 4096);
    const origin = pair('grid origin', options.origin ?? [0, 0]);
    const width = nx * spacing;
    const depth = nz * spacing;
    positive('cell area', spacing * spacing);
    if (
      !Number.isFinite(origin[0] + width) ||
      !Number.isFinite(origin[1] + depth) ||
      origin.some((edge, i) => {
        const end = edge + (i === 0 ? width : depth);
        return edge + spacing / 2 === edge || end - spacing / 2 === end;
      })
    )
      throw new MargoError('state', 'Use a finite tsunami extent and centre the grid in a nearby origin cell.');
    const sea = checked('sea level', options.seaLevel ?? 0);
    const dry = positive('dry discharge threshold', options.dryDepth ?? 1e-7);
    const filterDepth = checked('bottom filter depth', options.bottomFilterDepth ?? 0, 0);
    const open = options.open ?? [false, false, false, false];
    if (!Array.isArray(open) || open.length !== 4 || open.some((side) => typeof side !== 'boolean'))
      throw new MargoError('state', 'Invalid tsunami boundaries. Use four booleans in low/high X and Z order.');
    const mask = open.reduce((bits, side, i) => bits | (side ? 1 << i : 0), 0);
    const parameters = [
      spacing,
      positive('downward gravity', -host.gravity[1]),
      positive('water density', options.waterDensity ?? 1025),
      sea,
      checked('Manning roughness', options.manning ?? 0, 0),
      dry,
      mask,
      ...origin,
      checked('Coriolis frequency', options.coriolis ?? 0),
    ];
    const depths = gridValues('bathymetry', options.bathymetry, count);
    const tops = gridValues('surface altitude', options.surface ?? sea, count);
    const currentX = gridValues('X discharge', options.dischargeX ?? 0, count);
    const currentZ = gridValues('Z discharge', options.dischargeZ ?? 0, count);
    const allocate = (name: string, length: number) =>
      host.allocate(name, integer('region bytes', F64 * length), 'f64', TSUNAMI_LAYOUT);
    const state = allocate('water', 3 * count);
    const candidate = allocate('working-water', 3 * count);
    const rk = allocate('predictor', 3 * count);
    const trial = allocate('corrector', 3 * count);
    const bed = allocate('bathymetry', count);
    const trialBed = allocate('working-bathymetry', count);
    const pressure = allocate('applied-pressure', count);
    const model = allocate('settings', parameters.length);
    const log = allocate('inundation-history', 2 * count);
    const trialLog = allocate('working-inundation-history', 2 * count);
    const budget = allocate('wave-budget', 9);
    const results = allocate('working-totals', 6);
    const sourceBudget = allocate('working-source-budget', 2);
    const sourceTimes = allocate('last-source-ticks', Math.max(1, this.sources.length));
    const output = allocate('inundation', TSUNAMI_WORDS * count);
    const travel = allocate('arrival-query', count);
    const filter = filterDepth > 0 ? allocate('bottom-response-work', 5 * count) : undefined;
    const kernel = bindTsunamiKernel(host, this.builds);
    const s: State = {
      host,
      kernel,
      nx,
      nz,
      count,
      origin,
      spacing,
      cellSize,
      filterDepth,
      sea,
      dry,
      state,
      candidate,
      rk,
      trial,
      bed,
      trialBed,
      pressure,
      model,
      log,
      trialLog,
      budget,
      results,
      sourceBudget,
      sourceTimes,
      output,
      travel,
      filter,
      regions: [state, bed, model, log, budget, sourceTimes, output],
    };
    words(s, model).set(parameters);
    words(s, bed).set(depths);
    words(s, sourceTimes).fill(-1);
    const h = words(s, state);
    const timeline = words(s, log);
    let volumetric = 0;
    let maximum = 0;
    let runup = sea;
    let wetLand = 0;
    for (let i = 0; i < count; i++) {
      const height = Math.max(0, checked('initial depth', tops[i]! - depths[i]!));
      const wet = height > dry;
      const qx = wet ? currentX[i]! : 0;
      const qz = wet ? currentZ[i]! : 0;
      if (wet && (!Number.isFinite(qx / height) || !Number.isFinite(qz / height)))
        throw new MargoError(
          'state',
          'Initial tsunami velocity overflows. Reduce discharge or increase the wet depth.',
        );
      h.set([height, qx, qz], i * 3);
      timeline[2 * i] = height;
      timeline[2 * i + 1] = wet ? 0 : -1;
      volumetric += height;
      maximum = Math.max(maximum, height);
      if (wet && depths[i]! >= sea) {
        runup = Math.max(runup, depths[i]! + height);
        wetLand++;
      }
    }
    const volume = checked('initial water volume', volumetric * spacing * spacing, 0);
    const initialArea = checked('initial wet land area', wetLand * spacing * spacing, 0);
    checked('initial run-up above sea level', runup - sea, 0);
    words(s, budget).set([volume, volume, 0, 0, 0, initialArea, runup, maximum, 0]);
    this.writeRecords(s);
    this.state = s;
  }

  private live(): State {
    if (!this.state) throw new MargoError('state', 'TsunamiSolver is not initialized. Add it to a PhysicsWorld.');
    return this.state;
  }

  private bathymetry(s: State, context: StepContext): void {
    const current = words(s, s.trialBed);
    current.set(words(s, s.bed));
    const field = this.terrain ? BED_FIELD : this.bottom;
    const port = field && context.inputs.get(field.name);
    if (!port) return;
    const r = port.region;
    if (r.layout !== BED_LAYOUT || (r.type !== 'f64' && r.type !== 'f32'))
      throw new MargoError('state', 'Invalid tsunami bathymetry layout. Use layout-1 numeric elevations.');
    const values = regionWords(s.host.memory, r);
    const xCell = (context.cell[0] - port.cell[0]) * s.cellSize;
    const yCell = (context.cell[1] - port.cell[1]) * s.cellSize;
    const zCell = (context.cell[2] - port.cell[2]) * s.cellSize;
    if (this.terrain) {
      if (r.type !== 'f32' || values.length !== bedVertexCount(this.terrain))
        throw new MargoError('state', 'Invalid tsunami terrain. Use TerrainBed on the declared geometry.');
      const surface = bedSurface(this.terrain, values, port.cell);
      const a: BedSample = { elevation: 0, normal: [0, 1, 0] };
      for (let z = 0; z < s.nz; z++) {
        for (let x = 0; x < s.nx; x++) {
          surface.sample(s.origin[0] + (x + 0.5) * s.spacing + xCell, s.origin[1] + (z + 0.5) * s.spacing + zCell, a);
          current[x + z * s.nx] = checked('live bed altitude', a.elevation - yCell);
        }
      }
    } else {
      if (values.length !== s.count || xCell !== 0 || zCell !== 0)
        throw new MargoError(
          'state',
          'Tsunami bottom cells do not align. Use the patch dimensions and the same origin cell.',
        );
      for (let i = 0; i < s.count; i++) current[i] = checked('bottom altitude', values[i]! - yCell);
    }
  }

  private applySources(s: State, context: StepContext): Float64Array {
    words(s, s.pressure).fill(0);
    words(s, s.sourceBudget).fill(0);
    const ticks = words(s, s.sourceTimes).slice();
    for (const [i, descriptor] of this.sources.entries()) {
      const port = context.inputs.get(descriptor.name);
      if (!port) continue;
      const r = port.region;
      if (
        r.layout !== WAKE_SOURCE_LAYOUT ||
        r.type !== 'f64' ||
        r.byteLength % (WAKE_SOURCE_WORDS * F64) !== 0 ||
        (r.memory && r.memory !== s.host.memory)
      )
        throw new MargoError('state', 'Invalid tsunami SeaSource rows. Use layout-1 f64 rows allocated in this world.');
      const code = s.kernel.tsunami_sources(
        s.candidate.byteOffset,
        s.pressure.byteOffset,
        s.nx,
        s.nz,
        s.model.byteOffset,
        r.byteOffset,
        r.byteLength / (WAKE_SOURCE_WORDS * F64),
        (port.cell[0] - context.cell[0]) * s.cellSize,
        (port.cell[2] - context.cell[2]) * s.cellSize,
        ticks[i] === port.tick ? 0 : 1,
        s.sourceBudget.byteOffset,
      );
      if (code)
        throw new MargoError(
          'state',
          'Invalid tsunami source data. Use finite coordinates, pressure and volume with a positive radius.',
        );
      ticks[i] = port.tick;
    }
    return ticks;
  }

  step(context: StepContext, dt: number): void {
    const s = this.live();
    const current = words(s, s.state);
    const candidate = words(s, s.candidate);
    candidate.set(current);
    words(s, s.trialLog).set(words(s, s.log));
    this.bathymetry(s, context);
    if (s.filter) {
      const fit = s.kernel.tsunami_bottom(
        s.candidate.byteOffset,
        s.bed.byteOffset,
        s.trialBed.byteOffset,
        s.model.byteOffset,
        s.nx,
        s.nz,
        s.filterDepth,
        s.filter.byteOffset,
      );
      if (fit === 2)
        throw new MargoError(
          'state',
          'Tsunami bottom response would expose a wet column. Use a smaller deformation interval or disable the near-field filter.',
        );
      if (fit !== 0)
        throw new MargoError(
          'state',
          'Tsunami bottom response did not converge. Use compatible filter and grid scales.',
        );
    }
    const ticks = this.applySources(s, context);
    const status = s.kernel.tsunami_step(
      s.candidate.byteOffset,
      s.rk.byteOffset,
      s.trial.byteOffset,
      s.trialBed.byteOffset,
      s.pressure.byteOffset,
      s.model.byteOffset,
      s.nx,
      s.nz,
      s.trialLog.byteOffset,
      s.results.byteOffset,
      dt,
      (context.tick + 1) * dt,
    );
    if (status === 2)
      throw new MargoError(
        'state',
        'The tsunami tick exceeds 4096 CFL substeps. Use coarser cells or scale the depth, velocity and forcing.',
      );
    if (status)
      throw new MargoError(
        'state',
        'Tsunami update exceeded a numeric or wet/dry stability bound. Use compatible wave, grid and source scales.',
      );
    const budget = words(s, s.budget);
    const source = words(s, s.sourceBudget);
    const result = words(s, s.results);
    const admitted = checked('cumulative admitted source volume', budget[2]! + source[0]!);
    const unplaced = checked('cumulative unplaced source volume', budget[3]! + source[1]!);
    const exported = checked('cumulative exported volume', budget[4]! + result[1]!);
    current.set(candidate);
    words(s, s.bed).set(words(s, s.trialBed));
    words(s, s.log).set(words(s, s.trialLog));
    words(s, s.sourceTimes).set(ticks);
    budget[1] = result[0]!;
    budget[2] = admitted;
    budget[3] = unplaced;
    budget[4] = exported;
    budget[5] = result[2]!;
    budget[6] = Math.max(budget[6]!, result[3]!);
    budget[7] = Math.max(budget[7]!, result[4]!);
    budget[8] = result[5]!;
    this.writeRecords(s);
  }

  private writeRecords(s: State): void {
    const h = words(s, s.state);
    const bed = words(s, s.bed);
    const timeline = words(s, s.log);
    const dst = words(s, s.output);
    for (let i = 0; i < s.count; i++) {
      const water = h[3 * i]!;
      const bottom = bed[i]!;
      const at = TSUNAMI_WORDS * i;
      dst[at] = bottom;
      dst[at + 1] = bottom + water;
      dst[at + 2] = water;
      dst[at + 3] = h[3 * i + 1]!;
      dst[at + 4] = h[3 * i + 2]!;
      dst[at + 5] = timeline[2 * i]!;
      dst[at + 6] = timeline[2 * i + 1]!;
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const s = this.live();
    return [{ field: this.inundationField.name, region: s.output, tick, cell: s.host.cell }];
  }

  stateRegions(): readonly Region[] {
    return this.live().regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Sample a grid cell in current absolute altitude and metres of water. */
  sample(x: number, z: number): TsunamiSample {
    const s = this.live();
    const at = TSUNAMI_WORDS * index(s, x, z);
    const w = words(s, s.output);
    return {
      bed: w[at]!,
      height: w[at + 1]!,
      depth: w[at + 2]!,
      discharge: [w[at + 3]!, w[at + 4]!],
      peakDepth: w[at + 5]!,
      firstWet: w[at + 6]!,
    };
  }

  /** Draw this solver's accepted surface via Water's ShallowWaterSurface, with the same terrain grid and datum. */
  surfaceSource(): TsunamiSurfaceSource {
    const s = this.live();
    const width = s.spacing * s.nx;
    const depth = s.spacing * s.nz;
    const shape = {
      columns: s.nx,
      rows: s.nz,
      width,
      depth,
      centre: [s.origin[0] + width / 2, s.origin[1] + depth / 2] as const,
    };
    return {
      shape,
      sample(x, z, out) {
        const i = Math.floor((x - s.origin[0]) / s.spacing);
        const j = Math.floor((z - s.origin[1]) / s.spacing);
        const at = TSUNAMI_WORDS * index(s, i, j);
        const record = words(s, s.output);
        out.surface = record[at + 1]!;
        out.depth = record[at + 2]!;
        out.velocity[0] = out.depth > s.dry ? record[at + 3]! / out.depth : 0;
        out.velocity[1] = out.depth > s.dry ? record[at + 4]! / out.depth : 0;
        return out;
      },
    };
  }

  /** Linear still-water travel times from a wet cell. Dry or disconnected cells give Infinity. */
  travelTimes(source: Pair, out = new Float64Array(this.live().count)): Float64Array {
    const s = this.live();
    const [x, z] = pair('travel-time source', source);
    const node = index(s, x, z);
    if (!(out instanceof Float64Array) || out.length !== s.count)
      throw new MargoError('state', 'Give tsunami travel times a Float64Array with one value per cell.');
    const status = s.kernel.tsunami_travel(s.bed.byteOffset, s.travel.byteOffset, s.model.byteOffset, s.nx, s.nz, node);
    if (status)
      throw new MargoError(
        'state',
        'The tsunami travel time is outside the numeric range. Use compatible cell sizes, depths and gravity.',
      );
    out.set(words(s, s.travel));
    return out;
  }

  /** Current storage, signed source and boundary volumes, and shoreline history. */
  get budget(): TsunamiBudget {
    const s = this.live();
    const w = words(s, s.budget);
    return {
      initialVolume: w[0]!,
      storedVolume: w[1]!,
      admittedSourceVolume: w[2]!,
      unplacedSourceVolume: w[3]!,
      boundaryExportVolume: w[4]!,
      wetLandArea: w[5]!,
      runup: w[6]! - s.sea,
      maximumDepth: w[7]!,
      substeps: w[8]!,
    };
  }
}
