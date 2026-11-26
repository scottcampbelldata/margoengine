import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import {
  canShareMemory,
  isShared,
  regionWords,
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
} from '@margoengine/physics/world';
import type { Branches } from '@margoengine/procedural/lsystem';

const F64 = Float64Array.BYTES_PER_ELEMENT;
const LAYOUT = 1;
const HEADER = 2;
const STRIDE = 13;
const X = 0;
const Z = 2;
const DX = 3;
const RADIUS = 6;
const PARENT = 7;
const APICAL = 8;
const LATERAL = 9;
const PLANT = 10;
const ORDER = 11;
const BIRTH = 12;
const EMPTY = -1;
const NO_LATERAL = -2;
const ORIGIN: Cell = [0, 0, 0];
const UP: GrowthVector = [0, 1, 0];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Read-only Cartesian coordinates in X/Y/Z. */
export type GrowthVector = readonly [number, number, number];

/** Voxel layout used for crown competition and obstacle shadows, in X/Y/Z. X varies fastest, then Y, then Z. */
export interface GrowthVoxels {
  readonly origin: GrowthVector;
  readonly dimensions: readonly [columns: number, layers: number, rows: number];
  /** Cubic voxel side, m. */
  readonly size: number;
  /** Occupancy of each voxel, from 0 (open) to 1 (solid). Default: no obstacles. */
  readonly obstacles?: ArrayLike<number>;
  /** Pyramidal penumbra depth in voxel layers. Default 4. */
  readonly shadowDepth?: number;
  /** Retained shadow strength per layer below the source, in [0, 1]. Default 1/2. */
  readonly shadowTransmission?: number;
}

/** Phenological and geometric parameters for a plant's developmental production. */
export interface GrowthSpecies {
  /** Productive seasons from planting. Older skeletons persist as obstacles and shade. */
  readonly productiveSeasons: number;
  /** Available internode extension per season at full light and soil water, m. */
  readonly seasonalExtension: number;
  /** A bud starts growing after it receives this biomass-equivalent extension, m. */
  readonly minimumExtension: number;
  /** Maximum length of one new internode per developmental season, m. */
  readonly internodeLength: number;
  /** Radius of the vascular strand equivalent of one active terminal leaf, m. */
  readonly tipRadius: number;
  /** Share in the main-axis resource weighting, in (0, 1). Default 0.7. */
  readonly apicalWeight?: number;
  /** Angle of lateral buds relative to their parent axis, radians. Default π/4. */
  readonly branchingAngle?: number;
  /** Consecutive lateral bud divergence angle about the heading, radians. Default the golden angle. */
  readonly divergence?: number;
  /** Bias of a new segment towards the brightest available sector. Default 1/2. */
  readonly phototropism?: number;
  /** Bias in the positive vertical direction. Negative values allow downwards tropism. Default 1/8. */
  readonly gravitropism?: number;
  /** Change in voxel light availability per metamer in the emitting voxel. Default 1/4. */
  readonly leafShadow?: number;
}

/** The axiom of a plant. Position is the persistent seed point in the solver cell, +Y up. */
export interface PlantAxiom {
  readonly position: GrowthVector;
  readonly species: GrowthSpecies;
  readonly direction?: GrowthVector;
  /** Initial phase of the lateral bud's azimuth, radians. Default 0. */
  readonly azimuth?: number;
}

/** HYDRO-02 layout-1 root-zone water storage, row-major x-fast, in metres of liquid water. */
export interface GrowthSoil {
  readonly field: FieldDescriptor;
  /** Grid extents match the published soil-water port. */
  readonly origin: readonly [x: number, z: number];
  readonly dimensions: readonly [columns: number, rows: number];
  readonly size: readonly [dx: number, dz: number];
  /** Water-equivalent storage at wilting, m. Default 0. */
  readonly wilting?: number;
  /** Water-equivalent storage for unrestricted growth, m. */
  readonly full: number;
  /** Large-world cell width in metres, required if roots and water use different origin cells. */
  readonly cellSize?: number;
}

/** Inputs common to the plants on one developmental clock. */
export interface PlantGrowthParams {
  readonly plants: readonly PlantAxiom[];
  readonly voxels: GrowthVoxels;
  /** 60 Hz physics ticks per growth season. Default 60. */
  readonly ticksPerSeason?: number;
  /** Incoming light direction, pointing towards the sky or lamp. Default +Y. */
  readonly lightDirection?: GrowthVector;
  /** Fraction of full light above the canopy, in [0, 1]. Default 1. */
  readonly skyExposure?: number;
  /** Relative soil water supply where no soil field row is available, in [0, 1]. Default 1. */
  readonly fallbackWater?: number;
}

/** Registry and load options. */
export interface PlantGrowthOptions {
  /** ID and field prefix. Default 'plant-growth'. */
  readonly id?: string;
  readonly soil?: GrowthSoil;
  readonly signal?: AbortSignal;
}

/** Layout-1 f64 branch port. Header `[rowCount, season]` precedes 13 f64 per row. */
export const PLANT_GROWTH_LAYOUT = 1;
/** Branch words: end xyz, direction xyz, radius, parent, apical and lateral child, plant, order, birth season. */
export const PLANT_GROWTH_WORDS = STRIDE;

/** A dated stem segment with stable parent index. Seed rows have zero length and are omitted by `internodes()`. */
export interface GrowthInternode {
  readonly id: number;
  readonly plant: number;
  readonly parent: number;
  readonly order: number;
  readonly birthSeason: number;
  readonly start: GrowthVector;
  readonly end: GrowthVector;
  readonly direction: GrowthVector;
  readonly radius: number;
}

interface GrowthKernel extends WebAssembly.Exports {
  readonly __data_end: WebAssembly.Global;
  readonly __stack_pointer: WebAssembly.Global;
  deposit_shadow(
    grid: number,
    nx: number,
    ny: number,
    nz: number,
    x: number,
    y: number,
    z: number,
    depth: number,
    strength: number,
    transmission: number,
  ): void;
}

interface Plant {
  readonly species: Required<GrowthSpecies>;
  readonly azimuth: number;
  readonly sine: number;
  readonly cosine: number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: GrowthKernel;
  readonly plants: readonly Plant[];
  readonly nodes: Region;
  readonly soil: Region;
  readonly shadow: Region;
  readonly resources: Region;
  readonly occupancy: Float64Array;
  readonly obstacleCells: readonly { x: number; y: number; z: number; amount: number }[];
  readonly solidCount: number;
  readonly dimensions: GrowthVoxels['dimensions'];
  readonly origin: GrowthVector;
  readonly size: number;
  readonly depth: number;
  readonly transmission: number;
  readonly light: GrowthVector;
  readonly sky: number;
  readonly fallback: number;
  readonly interval: number;
  readonly lastSeason: number;
}

const finite = (value: number, name: string, low = -Infinity, high = Infinity): number => {
  if (!Number.isFinite(value) || value < low || value > high)
    throw new MargoError('state', `Choose plant growth ${name} as a finite number in [${low}, ${high}].`);
  return value;
};

function integer(value: number, name: string, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min)
    throw new MargoError('state', `Choose plant growth ${name} as a safe integer at least ${min}.`);
  return value;
}

function position(value: GrowthVector, name: string): GrowthVector {
  return [finite(value[0], name), finite(value[1], name), finite(value[2], name)];
}

function direction(value: GrowthVector): GrowthVector {
  const magnitude = hypot(value[0], value[1], value[2]);
  if (!(magnitude > 0 && Number.isFinite(magnitude)))
    throw new MargoError('state', 'Choose a plant growth direction with finite nonzero length.');
  return [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude]; // float division: unit vector
}

function plantOf(plant: PlantAxiom): Plant {
  const { species: source } = plant;
  const minimumExtension = finite(source.minimumExtension, 'minimum extension', Number.MIN_VALUE);
  const branchingAngle = finite(source.branchingAngle ?? Math.PI / 4, 'branching angle', 0, Math.PI);
  const species: Required<GrowthSpecies> = {
    productiveSeasons: integer(source.productiveSeasons, 'productive seasons'),
    seasonalExtension: finite(source.seasonalExtension, 'seasonal extension', minimumExtension),
    minimumExtension,
    internodeLength: finite(source.internodeLength, 'internode length', minimumExtension),
    tipRadius: finite(source.tipRadius, 'tip radius', Number.MIN_VALUE),
    apicalWeight: finite(source.apicalWeight ?? 0.7, 'apical weight', Number.EPSILON, 1 - Number.EPSILON),
    branchingAngle,
    divergence: finite(source.divergence ?? GOLDEN_ANGLE, 'divergence'),
    phototropism: finite(source.phototropism ?? 0.5, 'phototropism', 0, 1),
    gravitropism: finite(source.gravitropism ?? 0.125, 'gravitropism', -1, 1),
    leafShadow: finite(source.leafShadow ?? 0.25, 'leaf shadow', 0, 1),
  };
  return {
    species,
    azimuth: finite(plant.azimuth ?? 0, 'azimuth'),
    sine: sin(branchingAngle),
    cosine: cos(branchingAngle),
  };
}

async function loadKernel(file: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (file.protocol === 'file:') {
    const module = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
    file.search = '';
    return WebAssembly.compile(await readFile(file, { signal }));
  }
  const response = await fetch(file, { signal });
  if (!response.ok)
    throw new MargoError('failed', `Plant growth kernel HTTP ${response.status}; serve its Wasm assets with Biomes.`);
  return WebAssembly.compile(await response.arrayBuffer());
}

function words(state: State, region: Region): Float64Array {
  return regionWords(state.host.memory, region) as Float64Array;
}

const row = (id: number): number => HEADER + STRIDE * id;
const triple = (values: Float64Array, at: number): GrowthVector => [values[at]!, values[at + 1]!, values[at + 2]!];
const voxel = (state: State, p: GrowthVector): GrowthVector => [
  Math.floor((p[0] - state.origin[0]) / state.size), // float division: voxel coordinate
  Math.floor((p[1] - state.origin[1]) / state.size), // float division: voxel coordinate
  Math.floor((p[2] - state.origin[2]) / state.size), // float division: voxel coordinate
];

function indexOf(state: State, x: number, y: number, z: number): number {
  const [nx, ny, nz] = state.dimensions;
  return x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? -1 : (z * ny + y) * nx + x;
}

function shift(p: GrowthVector, v: GrowthVector, n: number): GrowthVector {
  return [p[0] + v[0] * n, p[1] + v[1] * n, p[2] + v[2] * n];
}

function cross(a: GrowthVector, b: GrowthVector): GrowthVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function lateralHeading(plant: Plant, heading: GrowthVector, age: number): GrowthVector {
  const normal = direction(cross(Math.abs(heading[1]) > 0.9 ? [1, 0, 0] : UP, heading));
  const binormal = cross(heading, normal);
  const azimuth = plant.azimuth + age * plant.species.divergence;
  const lateral = shift(shift([0, 0, 0], normal, cos(azimuth)), binormal, sin(azimuth));
  return shift(shift([0, 0, 0], heading, plant.cosine), lateral, plant.sine);
}

function castShadows(state: State, nodes: Float64Array, count: number): Float64Array {
  const shadow = words(state, state.shadow);
  shadow.fill(0);
  const [nx, ny, nz] = state.dimensions;
  const deposit = (x: number, y: number, z: number, amount: number) => {
    state.kernel.deposit_shadow(state.shadow.byteOffset, nx, ny, nz, x, y, z, state.depth, amount, state.transmission);
  };
  for (const { x, y, z, amount } of state.obstacleCells) deposit(x, y, z, amount);
  for (let id = state.plants.length; id < count; id++) {
    const at = row(id);
    const leaf = state.plants[nodes[at + PLANT]!]!.species.leafShadow;
    const [x, y, z] = voxel(state, triple(nodes, at + X));
    if (leaf > 0 && indexOf(state, x, y, z) >= 0) deposit(x, y, z, leaf);
  }
  return shadow;
}

function shade(state: State, shadow: Float64Array, x: number, y: number, z: number): number {
  const cell = indexOf(state, x, y, z);
  return cell < 0 ? 0 : shadow[cell]!;
}

function crossesSolid(state: State, start: GrowthVector, end: GrowthVector): boolean {
  if (state.solidCount === 0) return false;
  // Traverse every voxel intersected by the segment interior. A point contact at an edge does not occupy the voxel.
  const delta = end.map((v, axis) => v - start[axis]!);
  let startTime = 0;
  let endTime = 1;
  for (const axis of [0, 1, 2] as const) {
    const low = state.origin[axis];
    const high = low + state.dimensions[axis] * state.size;
    const speed = delta[axis]!;
    if (speed === 0) {
      if (start[axis] < low || start[axis] >= high) return false;
    } else {
      const a = (low - start[axis]) / speed; // float division: entering face
      const b = (high - start[axis]) / speed; // float division: exiting face
      startTime = Math.max(startTime, Math.min(a, b));
      endTime = Math.min(endTime, Math.max(a, b));
    }
  }
  if (startTime >= endTime) return false;
  const [dx, dy, dz] = delta as [number, number, number];
  const cell = voxel(state, shift(start, [dx, dy, dz], startTime)).map((coordinate, axis) =>
    Math.min(state.dimensions[axis]! - 1, Math.max(0, coordinate)),
  );
  const increment = delta.map(Math.sign);
  const travel = delta.map((v) => (v === 0 ? Infinity : state.size / Math.abs(v))); // float division: voxel crossing time
  const next = delta.map((v, axis) => {
    if (v === 0) return Infinity;
    const edge = state.origin[axis]! + (cell[axis]! + (v > 0 ? 1 : 0)) * state.size;
    return Math.max(startTime, (edge - start[axis]!) / v); // float division: first crossing time
  });
  let time = startTime;
  while (time < endTime) {
    const until = Math.min(next[0]!, next[1]!, next[2]!);
    const index = indexOf(state, cell[0]!, cell[1]!, cell[2]!);
    if (until > time && index >= 0 && state.occupancy[index] === 1) return true;
    if (until >= endTime) break;
    for (let axis = 0; axis < 3; axis++) {
      if (next[axis] !== until) continue;
      cell[axis] = cell[axis]! + increment[axis]!;
      next[axis] = next[axis]! + travel[axis]!;
    }
    time = until;
  }
  return false;
}

function soilOf(value: GrowthSoil): GrowthSoil {
  const { field } = value;
  if (field.kind !== 'uniformGrid' || field.centring !== 'cell' || field.unit !== 'm')
    throw new MargoError('state', 'Use a cell-centred soil water grid in liquid-water metres.');
  const wilting = finite(value.wilting ?? 0, 'wilting storage', 0);
  const full = finite(value.full, 'full soil storage', wilting);
  if (!(full > wilting)) throw new MargoError('state', 'Set full soil storage above the wilting threshold.');
  return {
    field: { ...field },
    origin: [finite(value.origin[0], 'soil origin'), finite(value.origin[1], 'soil origin')],
    dimensions: [integer(value.dimensions[0], 'soil columns'), integer(value.dimensions[1], 'soil rows')],
    size: [finite(value.size[0], 'soil dx', Number.MIN_VALUE), finite(value.size[1], 'soil dz', Number.MIN_VALUE)],
    wilting,
    full,
    cellSize: value.cellSize === undefined ? undefined : finite(value.cellSize, 'world cell size', Number.MIN_VALUE),
  };
}

function sampleWater(state: State, nodes: Float64Array, soil: GrowthSoil, port: Port, receiver: Cell): void {
  const [nx, nz] = soil.dimensions;
  const { region } = port;
  if (region.layout !== LAYOUT || region.type !== 'f64' || region.byteLength !== nx * nz * F64)
    throw new MargoError(
      'state',
      'Match the plant soil grid dimensions and use the layout-1 f64 HYDRO-02 storage port.',
    );
  if (!soil.cellSize && (port.cell[0] !== receiver[0] || port.cell[2] !== receiver[2]))
    throw new MargoError('state', 'Set the world cell size when the soil and plant roots are in different cells.');
  const offsetX = (receiver[0] - port.cell[0]) * (soil.cellSize ?? 0);
  const offsetZ = (receiver[2] - port.cell[2]) * (soil.cellSize ?? 0);
  const sampled = words(state, region);
  const history = words(state, state.soil);
  const low = soil.wilting!;
  const extent = soil.full - low;
  for (let i = 0; i < state.plants.length; i++) {
    const at = row(i);
    const x = Math.floor((nodes[at + X]! + offsetX - soil.origin[0]) / soil.size[0]); // float division: soil column
    const z = Math.floor((nodes[at + Z]! + offsetZ - soil.origin[1]) / soil.size[1]); // float division: soil row
    const value = x < 0 || x >= nx || z < 0 || z >= nz ? undefined : sampled[z * nx + x];
    if (value !== undefined && !Number.isFinite(value))
      throw new MargoError('state', 'Provide finite soil water depths at all plant roots.');
    const supply = value === undefined ? state.fallback : Math.max(0, Math.min(1, (value - low) / extent)); // float division: water response
    history[i] = history[i]! + supply;
  }
}

const LIGHT = 0;
const TOTAL = 1;
const VIGOUR = 2;
const AREA = 3;
const WORK = 4;

function newInternode(
  state: State,
  nodes: Float64Array,
  id: number,
  startIndex: number,
  axis: number,
  length: number,
  season: number,
  shadow: Float64Array,
): number {
  const plantIndex = nodes[startIndex + PLANT]!;
  const plant = state.plants[plantIndex]!;
  const { species } = plant;
  if (length < species.minimumExtension) return id;
  const head = triple(nodes, startIndex + DX);
  const defaultDirection = axis === APICAL ? head : lateralHeading(plant, head, nodes[startIndex + BIRTH]!);
  const start = triple(nodes, startIndex + X);
  const [x, y, z] = voxel(state, start);
  const localLight: GrowthVector = [
    shade(state, shadow, x - 1, y, z) - shade(state, shadow, x + 1, y, z),
    shade(state, shadow, x, y - 1, z) - shade(state, shadow, x, y + 1, z),
    shade(state, shadow, x, y, z - 1) - shade(state, shadow, x, y, z + 1),
  ];
  const lightHeading = shift(state.light, localLight, 1);
  const preferred = hypot(...lightHeading) > 0 ? direction(lightHeading) : state.light;
  const growthDirection = shift(shift(defaultDirection, preferred, species.phototropism), UP, species.gravitropism);
  const heading = hypot(...growthDirection) > 0 ? direction(growthDirection) : defaultDirection;
  const end = shift(start, heading, Math.min(length, species.internodeLength));
  if (!end.every(Number.isFinite) || end.every((value, index) => value === start[index]))
    throw new MargoError('state', 'Use a closer origin cell so its shoots remain representable.');
  if (crossesSolid(state, start, end)) return id;
  const at = row(id);
  if (at + STRIDE > nodes.length)
    throw new MargoError(
      'failed',
      'Plant growth exceeded its derived carbon budget; check the growth species parameters.',
    );
  nodes.set(
    [
      ...end,
      ...heading,
      species.tipRadius,
      (startIndex - HEADER) / STRIDE, // exact division: parent row index
      EMPTY,
      EMPTY,
      plantIndex,
      nodes[startIndex + ORDER]! + (axis === LATERAL ? 1 : 0),
      season,
    ],
    at,
  );
  nodes[startIndex + axis] = id;
  return id + 1;
}

function develop(state: State, nodes: Float64Array, season: number): void {
  const count = nodes[0]!;
  const seedCount = state.plants.length;
  const shadow = castShadows(state, nodes, count);
  const work = words(state, state.resources);
  const water = words(state, state.soil);
  work.fill(0, 0, count * WORK);
  for (let id = count - 1; id >= 0; id--) {
    const at = row(id);
    const { species } = state.plants[nodes[at + PLANT]!]!;
    if (season > species.productiveSeasons) continue;
    const own = id < seedCount ? 0 : species.leafShadow;
    const [x, y, z] = voxel(state, triple(nodes, at + X));
    const light = Math.max(0, state.sky - Math.max(0, shade(state, shadow, x, y, z) - own));
    let total = work[id * WORK + TOTAL]!;
    if (nodes[at + APICAL] === EMPTY) total += light;
    if (nodes[at + LATERAL] === EMPTY) total += light;
    work[id * WORK + LIGHT] = light;
    work[id * WORK + TOTAL] = total;
    const parent = nodes[at + PARENT]!;
    if (parent >= 0) work[parent * WORK + TOTAL] = work[parent * WORK + TOTAL]! + total;
  }
  for (let i = 0; i < seedCount; i++) {
    const available = water[i]! / state.interval; // float division: mean relative root-zone water
    work[i * WORK + VIGOUR] =
      state.plants[i]!.species.seasonalExtension * available * Math.min(1, work[i * WORK + TOTAL]!);
  }
  let next = count;
  for (let id = 0; id < count; id++) {
    const at = row(id);
    const vigor = work[id * WORK + VIGOUR]!;
    if (!(vigor > 0)) continue;
    const { species } = state.plants[nodes[at + PLANT]!]!;
    const main = nodes[at + APICAL]!;
    const side = nodes[at + LATERAL]!;
    const local = work[id * WORK + LIGHT]!;
    const a = (main < 0 ? local : work[main * WORK + TOTAL]!) * species.apicalWeight;
    const b = (side < EMPTY ? 0 : side === EMPTY ? local : work[side * WORK + TOTAL]!) * (1 - species.apicalWeight);
    const denominator = a + b;
    if (!(denominator > 0)) continue;
    // The normalized main and lateral shares sum to the available parent budget.
    const apical = Math.min(vigor, (vigor * a) / denominator); // float division: normalized apical share
    const lateral = vigor - apical;
    if (main >= 0) work[main * WORK + VIGOUR] = apical;
    else next = newInternode(state, nodes, next, at, APICAL, apical, season, shadow);
    if (side >= 0) work[side * WORK + VIGOUR] = lateral;
    else if (side === EMPTY) next = newInternode(state, nodes, next, at, LATERAL, lateral, season, shadow);
  }
  work.fill(0, count * WORK, next * WORK);
  for (let id = next - 1; id >= seedCount; id--) {
    const at = row(id);
    const tip = state.plants[nodes[at + PLANT]!]!.species.tipRadius;
    const distalArea = work[id * WORK + AREA]!;
    const area = distalArea > 0 ? distalArea : tip * tip;
    nodes[at + RADIUS] = Math.max(nodes[at + RADIUS]!, Math.sqrt(area));
    const parent = nodes[at + PARENT]!;
    work[parent * WORK + AREA] = work[parent * WORK + AREA]! + area;
  }
  nodes[0] = next;
  water.fill(0);
}

/** A parallel parametric bud-production solver with environmental light and soil inputs. */
export class PlantGrowth implements Solver<PlantGrowthParams> {
  readonly id: string;
  readonly branchesField: FieldDescriptor;
  private readonly soil: GrowthSoil | undefined;
  private state: State | undefined;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: PlantGrowthOptions,
  ) {
    this.id = options.id ?? 'plant-growth';
    this.soil = options.soil && soilOf(options.soil);
    this.branchesField = {
      name: `${this.id}:branches`,
      kind: 'particleSet',
      centring: 'particle',
      quantity: 'plantInternode',
      unit: 'm',
    };
  }

  /** Compiles the optional crown-shadow kernel. Add the resulting solver to a PhysicsWorld. */
  static async load(options: PlantGrowthOptions = {}): Promise<PlantGrowth> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      loadKernel(new URL(/* @vite-ignore */ './growth-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? loadKernel(new URL(/* @vite-ignore */ './growth-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new PlantGrowth(plain, shared, options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [{ field: this.branchesField, access: 'write' }];
    if (this.soil) fields.push({ field: this.soil.field, access: 'read' });
    return { id: this.id, rate: 0, stableRate: () => 0, fields };
  }

  init(host: SolverHost, params: PlantGrowthParams): void {
    if (!params?.voxels || !Array.isArray(params.plants))
      throw new MargoError('state', 'Provide the growth voxel domain and plant axioms.');
    const { plants: axioms, voxels } = params;
    integer(axioms.length, 'number of plant axioms');
    const plants = axioms.map(plantOf);
    const dimensions: GrowthVoxels['dimensions'] = [
      integer(voxels.dimensions[0], 'voxel columns'),
      integer(voxels.dimensions[1], 'voxel layers'),
      integer(voxels.dimensions[2], 'voxel rows'),
    ];
    const cells = dimensions[0] * dimensions[1] * dimensions[2];
    const size = finite(voxels.size, 'voxel side', Number.MIN_VALUE);
    const origin = position(voxels.origin, 'voxel origin');
    for (const axis of [0, 1, 2] as const) {
      const high = origin[axis] + dimensions[axis] * size;
      if (!(high > origin[axis] && Number.isFinite(high)))
        throw new MargoError('state', 'Choose representable bounds for the growth domain in the current origin cell.');
    }
    const interval = integer(params.ticksPerSeason ?? 60, 'ticks per season');
    const lastSeason = plants.reduce((max, p) => Math.max(max, p.species.productiveSeasons), 0);
    const capacity = plants.reduce((needed, { species }) => {
      const iterations = species.productiveSeasons;
      const lengthBound = Math.ceil(species.seasonalExtension / species.minimumExtension); // float division: segment cost
      // At most two successor buds per internode, including when the biological budget is very large.
      let buds = 1;
      let season = 0;
      while (season < iterations && buds < lengthBound && Number.isSafeInteger(buds)) {
        buds *= 2;
        season++;
      }
      return needed + buds + (iterations - season) * lengthBound;
    }, 0);
    const memoryWords = cells + (HEADER + capacity * STRIDE) * 3 + capacity * WORK + plants.length;
    if (!Number.isSafeInteger(memoryWords) || memoryWords * F64 >= 0x1_0000_0000)
      throw new MargoError(
        'state',
        'Choose a smaller voxel domain or a shorter developmental period so growth fits Wasm memory.',
      );
    if (voxels.obstacles && voxels.obstacles.length !== cells)
      throw new MargoError('state', 'Provide one obstacle occupancy per growth voxel with X fastest.');
    const occupancy = new Float64Array(cells);
    const obstacleCells: State['obstacleCells'][number][] = [];
    let solidCount = 0;
    if (voxels.obstacles) {
      const obstacles = voxels.obstacles;
      const [nx, ny, nz] = dimensions;
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++) {
            const i = (z * ny + y) * nx + x;
            const amount = finite(obstacles[i]!, 'obstacle occupancy', 0, 1);
            occupancy[i] = amount;
            if (amount === 1) solidCount++;
            if (amount) obstacleCells.push({ x, y, z, amount });
          }
    }
    const shared =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
    const module = shared ? this.shared : this.plain;
    if (!module)
      throw new MargoError('unsupported', 'Shared plant growth Wasm is unavailable; choose plain world memory.');
    const stack = host.allocate('plant-growth-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as GrowthKernel;
    if (kernel.__data_end?.value !== 0 || !(kernel.__stack_pointer instanceof WebAssembly.Global))
      throw new MargoError('failed', 'Invalid plant growth Wasm placement; rebuild its slot-free kernel assets.');
    kernel.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16; // exact division: stack alignment
    const allocate = (name: string, n: number): Region => host.allocate(`plant-growth-${name}`, n * F64, 'f64', LAYOUT);
    const state: State = {
      host,
      kernel,
      plants,
      dimensions,
      origin,
      size,
      interval,
      lastSeason,
      occupancy,
      obstacleCells,
      solidCount,
      depth: Math.min(dimensions[1] - 1, integer(voxels.shadowDepth ?? 4, 'shadow depth', 0)),
      transmission: finite(voxels.shadowTransmission ?? 0.5, 'shadow transmission', 0, 1),
      light: direction(params.lightDirection ?? UP),
      sky: finite(params.skyExposure ?? 1, 'sky exposure', 0, 1),
      fallback: finite(params.fallbackWater ?? 1, 'fallback water', 0, 1),
      nodes: allocate('internodes', HEADER + capacity * STRIDE),
      soil: allocate('soil-history', plants.length),
      shadow: allocate('shadow-grid', cells),
      resources: allocate('resource-scratch', capacity * WORK),
    };
    const nodes = words(state, state.nodes);
    for (let i = 0; i < axioms.length; i++) {
      const seed = axioms[i]!;
      const point = position(seed.position, 'seed point');
      const heading = direction(seed.direction ?? UP);
      const where = indexOf(state, ...voxel(state, point));
      if (where < 0 || occupancy[where] === 1)
        throw new MargoError(
          'state',
          'Choose plant seeds inside the growth grid and outside its solid obstacle voxels.',
        );
      nodes.set([...point, ...heading, 0, EMPTY, EMPTY, NO_LATERAL, i, 0, 0], row(i));
    }
    nodes[0] = plants.length;
    this.state = state;
  }

  step(context: StepContext): void {
    const state = this.requireState();
    const nodes = words(state, state.nodes);
    if (nodes[1]! >= state.lastSeason) return;
    const port = this.soil && context.inputs.get(this.soil.field.name);
    if (this.soil && port) sampleWater(state, nodes, this.soil, port, context.cell);
    else {
      const water = words(state, state.soil);
      for (let i = 0; i < water.length; i++) water[i] = water[i]! + state.fallback;
    }
    if ((context.tick + 1) % state.interval === 0) {
      develop(state, nodes, nodes[1]! + 1);
      nodes[1] = nodes[1]! + 1;
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.branchesField.name, region: this.requireState().nodes, tick, cell: ORIGIN }];
  }

  stateRegions(): readonly Region[] {
    return [this.requireState().nodes];
  }

  extraState(): readonly Region[] {
    return [this.requireState().soil];
  }

  /** The number of completed productive seasons for this planting. */
  get season(): number {
    const state = this.requireState();
    return words(state, state.nodes)[1]!;
  }

  /** Copy the branch skeleton without retaining a view into the world memory. Parent IDs refer to port row IDs. */
  internodes(): readonly GrowthInternode[] {
    const state = this.requireState();
    const nodes = words(state, state.nodes);
    const output: GrowthInternode[] = [];
    for (let id = state.plants.length; id < nodes[0]!; id++) {
      const at = row(id);
      const parent = nodes[at + PARENT]!;
      output.push({
        id,
        parent,
        plant: nodes[at + PLANT]!,
        order: nodes[at + ORDER]!,
        birthSeason: nodes[at + BIRTH]!,
        start: triple(nodes, row(parent) + X),
        end: triple(nodes, at + X),
        direction: triple(nodes, at + DX),
        radius: nodes[at + RADIUS]!,
      });
    }
    return output;
  }

  /** Copies the live internodes as a Procedural branch graph for `tubes()` or an application renderer. */
  toBranches(): Branches {
    const starts = this.requireState().plants.length;
    const nodes = this.internodes();
    const positions = new Float32Array(6 * nodes.length);
    const radii = new Float32Array(nodes.length);
    const ups = new Float32Array(3 * nodes.length);
    const parents = new Int32Array(nodes.length);
    const depths = new Uint16Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const heading = node.direction;
      const guide: GrowthVector = Math.abs(heading[1]) > 0.9 ? [1, 0, 0] : UP;
      const right = direction(cross(guide, heading));
      positions.set(node.start, 6 * i);
      positions.set(node.end, 6 * i + 3);
      ups.set(cross(heading, right), 3 * i);
      radii[i] = node.radius;
      parents[i] = Math.max(-1, node.parent - starts);
      depths[i] = Math.min(0xffff, node.order);
    }
    return { positions, radii, ups, parents, depths };
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('state', 'Add PlantGrowth to a PhysicsWorld before calling its state methods.');
    return this.state;
  }
}
