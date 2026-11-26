import type { Wind } from '@margoengine/math/fields';
import { MargoError } from '@margoengine/math/errors';
import { SURFACE_WATER_FIELD, SURFACE_WATER_LAYOUT } from '@margoengine/physics/hydro';
import {
  canShareMemory,
  isShared,
  STACK_BYTES,
  type Cell,
  type FieldDescriptor,
  type FieldUse,
  type Port,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
  regionWords,
} from '@margoengine/physics/world';
import type { EcoPlant, EcoSpecies, EcosystemOptions } from './ecosystem.js';
import { type ForestPopulation, ecosystemConfig, ecosystemYear, plantAdder, seedForest } from './ecosystem-model.js';
import { divFloor, imod } from './fixed.js';
import { hash4 } from './hash.js';

const LAYOUT = 1;
const ZERO: Cell = [0, 0, 0];
const BYTES_F64 = 8;
const BYTES_I32 = 4;
const WORDS = 7;
const FIRE_STREAM = 7171;

/** A forest species and its measured site-response parameters. SI units except for the annual shares. */
export interface ForestSpecies extends EcoSpecies {
  /** Wet-depth threshold and fraction of an ecological year above that depth that kills a plant. Default: disabled. */
  readonly flooding?: { readonly depth: number; readonly fractionOfYear: number };
  /** Cumulative gross incision within a year that uproots a plant, metres. Default: disabled. */
  readonly erosionTolerance?: number;
  /** Fraction of mortality prevented at full fire severity, from 0 to 1. Default 0. */
  readonly fireResistance?: number;
  /** Effective tensile strength times root-area ratio and orientation factor beneath its crown, Pa. Default 0. */
  readonly rootCohesion?: number;
  /** Available canopy fuel per square metre of projected crown, kg/m². Default 0. */
  readonly canopyFuel?: number;
}

/** Layout-1 field inputs, enabled only when their producers are present. */
export interface ForestEcosystemOptions {
  /** Registry identifier and output prefix. Default 'forest'. */
  readonly id?: string;
  /** Read the live HYDRO-01 surfaceWater grid. Its dimensions and cell extent match the forest. Default false. */
  readonly flooding?: boolean;
  /** Read the forest exposure field, containing burn severity and fuel moisture. Default false. */
  readonly exposure?: boolean;
  /** Read cell- or vertex-centred gross vertical incision in m/s, for example LandscapeEvolution.incisionField. */
  readonly erosionField?: FieldDescriptor;
  /** Cancels loading the optional Wasm assets. */
  readonly signal?: AbortSignal;
}

/** Ecology and spatial mapping used in a physics world. */
export interface ForestEcosystemParams extends Omit<EcosystemOptions, 'species' | 'years'> {
  readonly species: readonly ForestSpecies[];
  /** Cell count on X and Z over bounds, X fastest. Default [1, 1]. */
  readonly cells?: readonly [columns: number, rows: number];
  /** 60 Hz world ticks per ecological year, an integer at least 1. Default 60. */
  readonly ticksPerYear?: number;
  /** Pure ambient Wind field, sampled at each patch centre. Default: no wind. */
  readonly wind?: Wind;
  /** Canopy exposure sampling height relative to the supplied forest cell, in m. Default 10. */
  readonly windHeight?: number;
  /** Wind speed producing half the maximum steady growth slope, m/s. Default 12. */
  readonly windReferenceSpeed?: number;
  /** Maximum horizontal/vertical growth slope, in [0, 1]. Default 0.5. */
  readonly maxGrowthLean?: number;
  /** Origin cell that bounds and grid positions refer to. Default [0, 0, 0]. */
  readonly cell?: Cell;
  /** Cell width of the large world, m. Required when sampling Wind in a different cell. */
  readonly cellSize?: number;
  /** Test recruitment with a pure callback as in growEcosystem. Omit to accept all otherwise suitable sites. */
  readonly where?: EcosystemOptions['where'];
  /** Recruitment/mortality seed. Default: the world's seed. */
  readonly seed?: number;
  /** Default fuel moisture, kg/kg dry fuel. Default 0. */
  readonly moisture?: number;
}

/** Durable tree state; birth ID stays constant until its snag falls. */
export interface ForestTree extends EcoPlant {
  readonly id: number;
  readonly radius: number;
  readonly age: number;
  /** Permanent crown-axis X/Z slope (horizontal offset divided by height). */
  readonly lean: readonly [x: number, z: number];
}

/** Quaternion rotating +Y to this tree's permanent growth axis. */
export function forestOrientation(tree: Pick<ForestTree, 'lean'>): readonly [number, number, number, number] {
  const [x, z] = tree.lean;
  if (!Number.isFinite(x * x + z * z)) throw new MargoError('state', 'Provide a tree with a finite lean direction.');
  const inverseLength = 1 / Math.sqrt(1 + x * x + z * z); // float division: normalized direction
  const w = Math.sqrt((1 + inverseLength) * 0.5);
  const scale = inverseLength / (2 * w); // float division: normalized quaternion
  return [z * scale, 0, -x * scale, w];
}

interface ForestKernel extends WebAssembly.Exports {
  __stack_pointer: WebAssembly.Global;
  forest_shade(
    population: number,
    shade: number,
    scratch: number,
    capacity: number,
    n: number,
    tableSize: number,
    cell: number,
  ): void;
}

async function loadForestKernel(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const moduleName = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName);
    url.search = '';
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Forest kernel HTTP ${response.status}; serve the forest Wasm assets with this package.`,
    );
  return WebAssembly.compile(await response.arrayBuffer());
}

interface SpeciesResponse {
  floodDepth: number;
  floodTicks: number;
  erosionTolerance: number;
  fireResistance: number;
  root: number;
  fuel: number;
}

interface ForestData {
  host: SolverHost;
  population: Region;
  lean: Region;
  clock: Region;
  annual: Region;
  roots: Region;
  cover: Region;
  fuel: Region;
  moisture: Region;
  config: ReturnType<typeof ecosystemConfig>;
  customSeed: boolean;
  responses: readonly SpeciesResponse[];
  cell: Cell;
  columns: number;
  rows: number;
  dx: number;
  dz: number;
  ticksPerYear: number;
  wind?: Wind;
  windOffset: Cell;
  windReference: number;
  windHeight: number;
  maxLean: number;
  kernel: ForestKernel;
  shade: Region;
  scratch: Region;
  tableSize: number;
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, quantity, unit, kind: 'uniformGrid', centring: 'cell' };
}

function finite(value: number, label: string, min: number, max = Number.MAX_VALUE): number {
  if (!(Number.isFinite(value) && value >= min && value <= max))
    throw new MargoError('state', `Choose forest ${label} in [${min}, ${max}].`);
  return value;
}

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new MargoError('state', `Choose forest ${label} as a positive integer.`);
  return value;
}

function floats(data: ForestData, region: Region): Float64Array {
  return regionWords(data.host.memory, region) as Float64Array;
}

function population(data: ForestData, clock: Float64Array): ForestPopulation {
  const words = regionWords(data.host.memory, data.population) as Int32Array;
  const n = data.config.limit;
  return {
    length: clock[1]!,
    births: clock[2]!,
    crowded: clock[3]!,
    columns: {
      x: words.subarray(0, n),
      z: words.subarray(n, 2 * n),
      radius: words.subarray(2 * n, 3 * n),
      age: words.subarray(3 * n, 4 * n),
      death: words.subarray(4 * n, 5 * n),
      species: words.subarray(5 * n, 6 * n),
      identity: words.subarray(6 * n, 7 * n),
    },
  };
}

function cellAt(data: ForestData, xCm: number, zCm: number): number {
  const { config, columns, rows } = data;
  const x = Math.floor((xCm - config.x0) / (100 * data.dx)); // float division: metres to grid coordinate
  const z = Math.floor((zCm - config.z0) / (100 * data.dz)); // float division: metres to grid coordinate
  return x < 0 || z < 0 || x >= columns || z >= rows ? -1 : z * columns + x;
}

function readGrid(
  data: ForestData,
  port: Port | undefined,
  length: number,
  layout = LAYOUT,
): Float32Array | Float64Array | undefined {
  if (!port) return;
  const { region } = port;
  if (
    region.layout !== layout ||
    (region.type !== 'f32' && region.type !== 'f64') ||
    region.byteLength !== length * (region.type === 'f32' ? 4 : 8) ||
    !port.cell.every((coordinate, axis) => coordinate === data.cell[axis])
  )
    throw new MargoError('state', `Publish ${port.field} on the forest grid. Use its dimensions and origin cell.`);
  return regionWords(data.host.memory, region) as Float32Array | Float64Array;
}

// The exposure fields are reduced every preceding tick. Per-species flood duration uses a block for each distinct
// tolerance depth, and so tracks many species without re-reading the same grid or conflating deep and shallow years.
const ANNUAL = 4;
const LOAD_X = 0;
const LOAD_Z = 1;
const BURN = 2;
const INCISION = 3;

function publish(data: ForestData, stand: ForestPopulation): void {
  const roots = floats(data, data.roots);
  const cover = floats(data, data.cover);
  const fuel = floats(data, data.fuel);
  const { columns: plants } = stand;
  const factor = Math.PI / (1000000 * data.dx * data.dz); // float division: cover per squared mm
  roots.fill(0);
  cover.fill(0);
  fuel.fill(0);
  for (let i = 0; i < stand.length; i++) {
    if (plants.death[i]! >= 0) continue;
    const patch = cellAt(data, plants.x[i]!, plants.z[i]!);
    if (patch < 0) continue;
    const response = data.responses[plants.species[i]!]!;
    const radius = plants.radius[i]!;
    const share = radius * radius * factor;
    roots[patch]! += share * response.root;
    cover[patch]! += share;
    fuel[patch]! += share * response.fuel;
  }
  for (let i = 0; i < cover.length; i++) {
    const over = Math.max(1, cover[i]!);
    cover[i]! /= over; // float division: area fraction normalized for overlapping crowns
    roots[i]! /= over; // float division: weighted root cohesion bounded by full cover
  }
}

/** Annual growth, recruitment, mortality, cover and environmental feedback using the physics world clock. */
export class ForestEcosystemSolver implements Solver<ForestEcosystemParams> {
  readonly id: string;
  /** Optional layout-1 [burn severity (0–1), fuel moisture (kg/kg)] per grid cell. */
  readonly exposureField: FieldDescriptor;
  /** Layout-1 f64 root cohesion, Pa per patch. */
  readonly rootCohesionField: FieldDescriptor;
  /** Layout-1 f64 crown cover fraction per patch. */
  readonly coverField: FieldDescriptor;
  /** Layout-1 f64 live canopy fuel, kg/m² per patch. */
  readonly fuelField: FieldDescriptor;
  /** Layout-1 f64 most recent fuel moisture, kg/kg dry fuel, per patch. */
  readonly moistureField: FieldDescriptor;
  readonly #options: ForestEcosystemOptions;
  #data?: ForestData;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: ForestEcosystemOptions,
  ) {
    this.id = options.id ?? 'forest';
    if (!this.id) throw new MargoError('state', 'Choose a nonempty forest solver ID.');
    const erosionField = options.erosionField && { ...options.erosionField };
    if (erosionField && (erosionField.unit !== 'm/s' || !['cell', 'vertex'].includes(erosionField.centring)))
      throw new MargoError('state', 'Provide the forest erosion rate as cell or vertex scalars in m/s.');
    this.#options = { exposure: options.exposure, flooding: options.flooding, erosionField };
    this.exposureField = field(`${this.id}:exposure`, 'forestExposure', '1, kg/kg');
    this.rootCohesionField = field(`${this.id}:roots`, 'rootCohesion', 'Pa');
    this.coverField = field(`${this.id}:cover`, 'canopyCover', '1');
    this.fuelField = field(`${this.id}:fuel`, 'canopyFuelLoad', 'kg/m^2');
    this.moistureField = field(`${this.id}:moisture`, 'fuelMoisture', 'kg/kg');
  }

  /** Load the optional native competition kernel before adding this solver to a world. */
  static async load(options: ForestEcosystemOptions = {}): Promise<ForestEcosystemSolver> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      loadForestKernel(new URL(/* @vite-ignore */ './forest-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? loadForestKernel(new URL(/* @vite-ignore */ './forest-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new ForestEcosystemSolver(plain, shared, options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [this.rootCohesionField, this.coverField, this.fuelField, this.moistureField].map(
      (output) => ({ field: output, access: 'write' }),
    );
    const { erosionField, exposure, flooding } = this.#options;
    if (erosionField) fields.push({ field: erosionField, access: 'read' });
    if (exposure) fields.push({ field: this.exposureField, access: 'read' });
    if (flooding) fields.push({ field: SURFACE_WATER_FIELD, access: 'read' });
    return { id: this.id, rate: 0, stableRate: () => 0, fields };
  }

  init(host: SolverHost, params: ForestEcosystemParams): void {
    if (this.#data) throw new MargoError('attached', 'Create a new ForestEcosystemSolver for another world.');
    if (!params) throw new MargoError('state', 'Provide forest bounds, species and optional founders.');
    const config = ecosystemConfig({ ...params, limit: params.limit ?? 16384 });
    if ((params.plants?.length ?? 0) > config.limit)
      throw new MargoError('state', 'Increase forest capacity to hold every founder.');
    const ticksPerYear = count(params.ticksPerYear ?? 60, 'ticksPerYear');
    const columns = count(params.cells?.[0] ?? 1, 'columns');
    const rows = count(params.cells?.[1] ?? 1, 'rows');
    const n = columns * rows;
    const dx = (config.x1 - config.x0) / (100 * columns); // float division: metres per cell
    const dz = (config.z1 - config.z0) / (100 * rows); // float division: metres per cell
    if (!(dx >= 0.01 && dz >= 0.01) || !Number.isSafeInteger(n))
      throw new MargoError('state', 'Use forest cells at least one centimetre wide and deep.');
    const winds = params.wind;
    const cell = [...(params.cell ?? ZERO)] as unknown as Cell;
    if (
      cell.length !== 3 ||
      !cell.every(Number.isSafeInteger) ||
      (winds && (winds.medium !== 'air' || !winds.cell.every(Number.isSafeInteger)))
    )
      throw new MargoError('state', 'Provide a valid Wind and whole-number forest and Wind origin cells.');
    const separateCell = winds?.cell.some((coordinate, i) => coordinate !== cell[i]);
    const cellSize = finite(params.cellSize ?? (separateCell ? NaN : 1), 'cellSize', Number.MIN_VALUE, 1e12);
    const windOffset = (winds ? cell.map((coordinate, i) => (coordinate - winds.cell[i]!) * cellSize) : ZERO) as Cell;
    const windReference = finite(params.windReferenceSpeed ?? 12, 'windReferenceSpeed', 0.001, 1e6);
    const windHeight = finite(params.windHeight ?? 10, 'windHeight', -100000, 100000);
    const maxLean = finite(params.maxGrowthLean ?? 0.5, 'maxGrowthLean', 0, 1);
    const baselineMoisture = finite(params.moisture ?? 0, 'fuel moisture', 0, 1000);
    const depths = new Map<number, number>();
    const responses = params.species.map((species) => {
      const depth =
        this.#options.flooding && species.flooding
          ? finite(species.flooding.depth, 'flooding.depth', Number.MIN_VALUE)
          : 0;
      if (depth && !depths.has(depth)) depths.set(depth, depths.size);
      return {
        floodDepth: depth,
        floodTicks: depth
          ? Math.ceil(
              ticksPerYear * finite(species.flooding!.fractionOfYear, 'flooding.fractionOfYear', Number.MIN_VALUE, 1),
            )
          : Infinity,
        erosionTolerance: finite(species.erosionTolerance ?? Number.MAX_VALUE, 'erosionTolerance', Number.MIN_VALUE),
        fireResistance: finite(species.fireResistance ?? 0, 'fireResistance', 0, 1),
        root: finite(species.rootCohesion ?? 0, 'root cohesion', 0, 1e9),
        fuel: finite(species.canopyFuel ?? 0, 'canopy fuel', 0, 1e6),
      };
    });
    const module = isShared(host.memory) ? this.shared : this.plain;
    if (!module) throw new MargoError('unsupported', 'Use a plain world or enable shared forest Wasm support.');
    const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as ForestKernel;
    const stack = host.allocate('forest-kernel-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    kernel.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    let tableSize = 2;
    while (tableSize < 2 * config.limit) tableSize *= 2;
    const shade = host.allocate('forest-crown-shade', BYTES_I32 * config.limit, 'i32', LAYOUT);
    const scratch = host.allocate('forest-neighbour-table', BYTES_I32 * (config.limit + 3 * tableSize), 'i32', LAYOUT);
    const allocate = (name: string, length: number) => host.allocate(name, length * BYTES_F64, 'f64', LAYOUT);
    const data: ForestData = {
      host,
      config,
      customSeed: params.seed !== undefined,
      responses,
      cell,
      columns,
      rows,
      dx,
      dz,
      ticksPerYear,
      wind: winds,
      windOffset,
      windReference,
      windHeight,
      maxLean,
      kernel,
      tableSize,
      shade,
      scratch,
      population: host.allocate('forest-population', config.limit * WORDS * BYTES_I32, 'i32', LAYOUT),
      lean: allocate('forest-lean', 2 * config.limit),
      clock: allocate('forest-clock', 8),
      annual: allocate('forest-exposure', n * (ANNUAL + depths.size)),
      roots: allocate('forest-roots', n),
      cover: allocate('forest-cover', n),
      fuel: allocate('forest-fuel', n),
      moisture: allocate('forest-moisture', n),
    };
    const clock = floats(data, data.clock);
    const initial = population(data, clock);
    seedForest(config, params.plants, plantAdder(initial));
    clock[1] = initial.length;
    clock[2] = initial.births;
    clock[4] = initial.length;
    floats(data, data.moisture).fill(baselineMoisture);
    publish(data, initial);
    this.#depths = [...depths.keys()];
    this.#floodIndices = responses.map(({ floodDepth }) => depths.get(floodDepth) ?? -1);
    this.#data = data;
  }

  #depths: readonly number[] = [];
  #floodIndices: readonly number[] = [];

  step(context: StepContext, dt: number): void {
    const data = this.#live();
    const { columns, rows, wind, ticksPerYear } = data;
    const { config } = data;
    if (!context.cell.every((coordinate, i) => coordinate === data.cell[i]))
      throw new MargoError('state', 'Use the same forest origin cell in world.add and the forest parameters.');
    const n = columns * rows;
    const options = this.#options;
    const annual = floats(data, data.annual);
    const moisture = floats(data, data.moisture);
    const water = readGrid(data, context.inputs.get(SURFACE_WATER_FIELD.name), 3 * n, SURFACE_WATER_LAYOUT);
    const exposure = readGrid(data, context.inputs.get(this.exposureField.name), 2 * n);
    const vertices = options.erosionField?.centring === 'vertex';
    const incision =
      options.erosionField &&
      readGrid(data, context.inputs.get(options.erosionField.name), vertices ? (rows + 1) * (columns + 1) : n);
    const sample: ReturnType<Wind['sample']> = { velocity: [0, 0, 0], density: 0, temperature: 0 };
    if (water || exposure || incision || wind)
      for (let i = 0; i < n; i++) {
        const x = imod(i, columns);
        const z = divFloor(i, columns);
        const a = i * ANNUAL;
        if (water) {
          const depth = finite(water[3 * i]!, 'water depth', 0);
          for (const [j, threshold] of this.#depths.entries())
            if (depth >= threshold) annual[ANNUAL * n + i * this.#depths.length + j]!++;
        }
        if (exposure) {
          annual[a + BURN] = Math.max(annual[a + BURN]!, finite(exposure[2 * i]!, 'burn severity', 0, 1));
          moisture[i] = finite(exposure[2 * i + 1]!, 'fuel moisture', 0, 1000);
        }
        if (incision) {
          const base = x * (rows + 1) + z;
          const rate = vertices
            ? (incision[base]! + incision[base + 1]! + incision[base + rows + 1]! + incision[base + rows + 2]!) / 4
            : incision[i]!;
          annual[a + INCISION]! += dt * finite(rate, 'incision rate', 0, 1e12);
        }
        if (wind) {
          const [wx, , wz] = wind.sample(
            config.x0 / 100 + (x + 0.5) * data.dx + data.windOffset[0],
            data.windHeight + data.windOffset[1],
            config.z0 / 100 + (z + 0.5) * data.dz + data.windOffset[2],
            (context.tick + 0.5) * dt,
            sample,
          ).velocity;
          finite(wx, 'wind velocity', -1e6, 1e6);
          finite(wz, 'wind velocity', -1e6, 1e6);
          const speed = Math.sqrt(wx * wx + wz * wz);
          annual[a + LOAD_X]! += wx * speed;
          annual[a + LOAD_Z]! += wz * speed;
        }
      }
    const clock = floats(data, data.clock);
    if (++clock[7]! < ticksPerYear) return;
    const lean = floats(data, data.lean);
    const stand = population(data, clock);
    const year = clock[0]! + 1;
    const flooded = (patch: number, species: number) => {
      const j = this.#floodIndices[species]!;
      return j >= 0 && annual[ANNUAL * n + patch * this.#depths.length + j]! >= data.responses[species]!.floodTicks;
    };
    const eroded = (patch: number, species: number) =>
      annual[ANNUAL * patch + INCISION]! >= data.responses[species]!.erosionTolerance;
    const results = ecosystemYear(
      data.customSeed ? config : { ...config, seed: context.seed },
      stand,
      year,
      plantAdder(stand),
      {
        kills(x, z, species, identity, year) {
          const p = cellAt(data, x, z);
          if (p < 0) return false;
          const death = annual[p * ANNUAL + BURN]! * (1 - data.responses[species]!.fireResistance);
          return (
            flooded(p, species) ||
            eroded(p, species) ||
            hash4(data.customSeed ? config.seed : context.seed, identity, year, FIRE_STREAM) >>> 0 < death * 4294967296
          );
        },
        establishes(x, z, species) {
          const p = cellAt(data, x, z);
          return p >= 0 && !flooded(p, species) && !eroded(p, species);
        },
        grows(i, x, z, _species, oldRadius, radius) {
          const p = cellAt(data, x, z);
          if (!wind || p < 0 || radius === oldRadius) return;
          const ageWeight = (oldRadius * oldRadius) / (radius * radius); // float division: ratio of projected wood areas
          const loadX = annual[p * ANNUAL + LOAD_X]! / ticksPerYear; // float division: mean exposure through the completed year
          const loadZ = annual[p * ANNUAL + LOAD_Z]! / ticksPerYear; // float division: mean exposure through the completed year
          const magnitude = Math.sqrt(loadX * loadX + loadZ * loadZ);
          const share = ((1 - ageWeight) * data.maxLean) / (data.windReference * data.windReference + magnitude); // float division: load saturation with positive scale
          lean[2 * i] = ageWeight * lean[2 * i]! + share * loadX;
          lean[2 * i + 1] = ageWeight * lean[2 * i + 1]! + share * loadZ;
        },
        born(i) {
          lean[2 * i] = 0;
          lean[2 * i + 1] = 0;
        },
        moves(from, to) {
          lean[2 * to] = lean[2 * from]!;
          lean[2 * to + 1] = lean[2 * from + 1]!;
        },
      },
      (stand, cell) => {
        const { kernel, shade, scratch, tableSize } = data;
        kernel.forest_shade(
          data.population.byteOffset,
          shade.byteOffset,
          scratch.byteOffset,
          config.limit,
          stand.length,
          tableSize,
          cell,
        );
        return regionWords(data.host.memory, shade) as Int32Array;
      },
    );
    annual.fill(0);
    clock.set([year, stand.length, stand.births, stand.crowded, results.alive, results.born, results.died, 0]);
    publish(data, stand);
  }

  /** Most recently completed ecological year and its turnover. */
  get year(): {
    readonly year: number;
    readonly alive: number;
    readonly born: number;
    readonly died: number;
    readonly crowded: number;
  } {
    const data = this.#live();
    const c = floats(data, data.clock);
    return { year: c[0]!, alive: c[4]!, born: c[5]!, died: c[6]!, crowded: c[3]! };
  }

  /** Copy living trees followed by standing snags, in stable birth order within each group. */
  trees(): readonly ForestTree[] {
    const data = this.#live();
    const { columns: p, length } = population(data, floats(data, data.clock));
    const lean = floats(data, data.lean);
    const forest: ForestTree[] = [];
    for (const living of [true, false])
      for (let i = 0; i < length; i++) {
        if (p.death[i]! < 0 !== living) continue;
        forest.push({
          id: p.identity[i]!,
          species: data.config.kinds[p.species[i]!]!.id,
          age: p.age[i]!,
          x: p.x[i]! / 100,
          z: p.z[i]! / 100,
          radius: p.radius[i]! / 1000,
          lean: [lean[2 * i]!, lean[2 * i + 1]!],
          ...(living ? {} : { died: p.death[i]! }),
        });
      }
    return forest;
  }

  exportPorts(tick: number): readonly Port[] {
    const d = this.#live();
    return [
      { tick, cell: d.cell, field: this.rootCohesionField.name, region: d.roots },
      { tick, cell: d.cell, field: this.coverField.name, region: d.cover },
      { tick, cell: d.cell, field: this.fuelField.name, region: d.fuel },
      { tick, cell: d.cell, field: this.moistureField.name, region: d.moisture },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const d = this.#live();
    return [d.population, d.lean, d.clock, d.annual, d.roots, d.cover, d.fuel, d.moisture];
  }

  extraState(): readonly Region[] {
    return [];
  }

  #live(): ForestData {
    if (!this.#data) throw new MargoError('state', 'Add the forest solver to a PhysicsWorld before reading it.');
    return this.#data;
  }
}
