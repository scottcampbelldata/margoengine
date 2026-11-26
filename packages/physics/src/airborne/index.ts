import { MargoError } from '@margoengine/math/errors';
import type { Bed, BedSample, FlowSample, Wind } from '@margoengine/math/fields';
import { exp, pow } from '@margoengine/math/pinned';
import { BED_FIELD, type BedShape, bedFromPort, bedVertexAreas, bedVertexCount } from '../earth/index.js';
import { SEA_FOAM_FIELD, SEA_FOAM_LAYOUT, sprayPerWhitecap } from '../foam/index.js';
import {
  canShareMemory,
  type Cell,
  type FieldDescriptor,
  type FieldUse,
  isShared,
  philox,
  regionWords,
  type Port,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
  solverNumber,
  STACK_BYTES,
  MAX_MEMORY_PAGES,
} from '../world/index.js';
import {
  RHO,
  KINDS,
  BYTES,
  RECORD,
  FORCE,
  MIN_DIAMETER,
  MAX_DIAMETER,
  STANDARD_DENSITY,
  STANDARD_TEMPERATURE,
  range,
  airViscosity,
  DRY_SALT_SCALE,
  parcelDensity,
  dragRate,
  dragIntegrals,
  waterDrying,
  normalDeviates,
  TWO32,
} from './environment.js';

/** Supported environmental suspensions. */
export type AirborneKind = (typeof KINDS)[number];
/** Cartesian vector in metres or metres per second. */
export type AirborneVector = readonly [number, number, number];

/** One representative number of identical rounded environmental particles. Mass is the combined parcel mass. */
export interface AirborneParcel {
  readonly kind: AirborneKind;
  readonly position: AirborneVector;
  /** Diameter in metres. */
  readonly diameter: number;
  /** Kilograms, including liquid if present. */
  readonly mass: number;
  /** Metres per second. Defaults to zero. */
  readonly velocity?: AirborneVector;
}

/** A physical point source such as a wet waterfall or dust from a footstep on terrain. */
export interface AirborneSource extends Omit<AirborneParcel, 'mass'> {
  /** Emitted mass in kg/s. If an emission port is present it adds its reported flux to this rate. Default 0. */
  readonly rate?: number;
}

/** Geometry of the existing layout-1 seaFoam cell field, x fastest. */
export interface SpraySourceGrid {
  readonly columns: number;
  readonly rows: number;
  readonly spacing: number;
  readonly centre: readonly [number, number];
  /** Mean water elevation relative to this world cell, m. Default 0. */
  readonly elevation?: number;
  /** Initial lift from the mean waterline, m. Default one cell width. */
  readonly releaseHeight?: number;
  /** Initial velocity along world Y in m/s. Default 0. */
  readonly liftVelocity?: number;
}

/** Fields the solver declares at creation. */
export interface AirborneOptions {
  /** Unique registry field prefix. Default 'airborne'. */
  readonly id?: string;
  /** Read the live TerrainBed. Supply matching terrain geometry in the world parameters. Default false. */
  readonly terrain?: boolean;
  /** Read laid-out aeolian mineral flux, in kg/(m^2 s) per vertex of the terrain grid. */
  readonly dustField?: FieldDescriptor;
  /** Read the real SEA-13 foam field's active whitecaps. Supply its shape in the world parameters. Default false. */
  readonly whitecaps?: boolean;
  /** Read one kg/s layout-1 f64 value per explicit source. Default false. */
  readonly emissions?: boolean;
  /** Cancels loading and compiling the native assets. */
  readonly signal?: AbortSignal;
}

/** Deterministic environmental inputs and storage limits. */
export interface AirborneParams {
  readonly initial?: readonly AirborneParcel[];
  readonly sources?: readonly AirborneSource[];
  /** Maximum active parcels. At capacity, incoming mass waits in per-source storage. Default 4096. */
  readonly capacity?: number;
  /** Shared spatial wind contract, sampled separately at every particle. */
  readonly wind?: Wind;
  /** Homogeneous wind fluctuations, initially zero, relaxing to the stated RMS. Defaults to none. */
  readonly turbulence?: { readonly rms: AirborneVector; readonly time: number };
  /** Uniform relative humidity in [0, 1]. Default 1. */
  readonly humidity?: number;
  /** Uniform air temperature for still air, K. Default 288.15. */
  readonly temperature?: number;
  /** Stokes only within creeping flow, or extended sphere drag. Default 'sphere'. */
  readonly drag?: 'stokes' | 'sphere';
  /** Existing bed, or matching geometry for a live TerrainBed reader. */
  readonly terrain?: Bed | BedShape;
  /** Height of aeolian dust release above the current terrain, m. Default 0.05. */
  readonly dustReleaseHeight?: number;
  /** Vertical launch speed for aeolian dust, m/s. Default 0. */
  readonly dustLiftVelocity?: number;
  /** Geometry for the active whitecap field. */
  readonly spray?: SpraySourceGrid;
  /** Optional open bounds, [minimum, maximum] in metres. Crossing moves mass to the outflow ledger. */
  readonly bounds?: readonly [AirborneVector, AirborneVector];
  /** Width of a large-world origin cell, m. Default 4096. */
  readonly cellSize?: number;
}

/** Cumulative environmental mass, in kg. */
export interface AirborneMass {
  readonly initial: number;
  readonly supplied: number;
  readonly airborne: number;
  readonly deposited: number;
  readonly evaporated: number;
  readonly outflow: number;
  readonly waiting: number;
}

/** A live particle and its stable parcel identifier. */
export interface AirborneSample extends AirborneParcel {
  readonly id: number;
  readonly age: number;
  readonly velocity: AirborneVector;
}

const LAYOUT = 1;
const RATE = 2;
const ZERO: Cell = [0, 0, 0];
const FOUNDER = 0;
const INCOMING = 1;
const ACTIVE = 2;
const DEPOSIT = 3;
const VAPOUR = 4;
const EXIT = 5;
const WAITING = 6;
const STRIDE = 4;
const DUST_DIAMETER = 20e-6;

interface Native extends WebAssembly.Exports {
  __stack_pointer: WebAssembly.Global;
  disperse(parcels: number, air: number, count: number, dt: number): void;
}
interface Source extends AirborneSource {
  kindIndex: number;
  multiplier: number;
  /** Source family and row indexing are immutable after construction. */
  family: 'custom' | 'aeolian' | 'sea';
  portIndex: number;
  terrainHeight: boolean;
}
interface State {
  host: SolverHost;
  native: Native;
  particles: Region;
  samples: Region;
  old: Region;
  ledger: Region;
  count: Region;
  pending: Region;
  sources: readonly Source[];
  wind?: Wind;
  rms: AirborneVector;
  correlation: number;
  humidity: number;
  equilibrium: number;
  temperature: number;
  drag: boolean;
  cellSize: number;
  bed: Bed | undefined;
  terrain: BedShape | undefined;
  bounds?: readonly [AirborneVector, AirborneVector];
  capacity: number;
  sprayCells: number;
  customSources: number;
}

function layout(name: string, quantity: string, unit: string, kind: FieldDescriptor['kind']): FieldDescriptor {
  return { name, quantity, unit, kind, centring: kind === 'particleSet' ? 'particle' : 'cell' };
}
function vector(input: AirborneVector, label: string): AirborneVector {
  if (!input || input.length !== 3 || !input.every(Number.isFinite))
    throw new TypeError(`Provide three finite environmental particle coordinates for ${label}.`);
  return [input[0], input[1], input[2]];
}
function material(value: AirborneKind): number {
  const kind = KINDS.indexOf(value);
  if (kind < 0) throw new RangeError('Choose mineral-dust, freshwater-mist or sea-spray for environmental particles.');
  return kind;
}
function numberOf(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Use a positive integer for ${label}.`);
  return value;
}
function words(s: State, r: Region): Float64Array {
  return regionWords(s.host.memory, r) as Float64Array;
}

async function load(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const name = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
    url.search = '';
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Airborne kernel HTTP ${response.status}. Use the Wasm assets shipped with the package.`,
    );
  return WebAssembly.compile(await response.arrayBuffer());
}

function writeParcel(out: Float64Array, i: number, id: number, kind: number, a: AirborneParcel, elevation = 0): void {
  const p = vector(a.position, 'position');
  const v = vector(a.velocity ?? ZERO, 'velocity');
  const d = range(a.diameter, 'diameter', MIN_DIAMETER, MAX_DIAMETER[kind]!);
  const mass = range(a.mass, 'mass', Number.MIN_VALUE, Number.MAX_VALUE);
  out.set(
    [
      p[0],
      p[1] + elevation,
      p[2],
      ...v,
      0,
      0,
      0,
      mass,
      d,
      kind === 2 ? DRY_SALT_SCALE * d : kind === 0 ? d : 0,
      d,
      kind,
      id,
      0,
    ],
    i * RECORD,
  );
}

function makeDust(shape: BedShape, lift: number, vertical: number): Source[] {
  const { columns, rows, centre, width, depth } = shape;
  const areas = bedVertexAreas(shape);
  return Array.from(areas, (area, index) => {
    const x = Math.floor(index / (rows + 1));
    const z = index % (rows + 1);
    const position: AirborneVector = [
      centre[0] + width * (x / columns - 0.5),
      lift,
      centre[1] + depth * (z / rows - 0.5),
    ];
    return {
      family: 'aeolian',
      kind: 'mineral-dust',
      kindIndex: 0,
      position,
      velocity: [0, vertical, 0],
      diameter: DUST_DIAMETER,
      portIndex: index,
      multiplier: area,
      terrainHeight: true,
    };
  });
}
function makeSpray(grid: SpraySourceGrid): Source[] {
  const nx = numberOf(grid.columns, 'spray columns');
  const nz = numberOf(grid.rows, 'spray rows');
  if (!Number.isSafeInteger(nx * nz) || 3 * nx * nz * BYTES >= MAX_MEMORY_PAGES * 65536)
    throw new RangeError('Reduce the spray grid so its three mass bands fit in the world arena.');
  const dx = range(grid.spacing, 'spray spacing', Number.MIN_VALUE, 1e5);
  const centre = grid.centre;
  if (!centre || centre.length !== 2 || !centre.every(Number.isFinite))
    throw new RangeError('Provide the two coordinates of the sea spray grid centre.');
  const y =
    range(grid.elevation ?? 0, 'spray elevation', -1e5, 1e5) +
    range(grid.releaseHeight ?? dx, 'spray release height', 0, 1e5);
  const v = range(grid.liftVelocity ?? 0, 'spray lift velocity', 0, 120);
  const sources: Source[] = [];
  // Three log-separated representative bands inside Gong's film/jet range. Mid-band integration preserves each
  // band's formation mass as representative parcels rather than one tracked point per individual droplet.
  for (const [r80, span] of [
    [1.5, 1],
    [4.5, 5],
    [13.5, 13],
  ] as const) {
    const diameter = r80 * 4e-6;
    const dropMass = RHO[2] * (Math.PI / 6) * diameter * diameter * diameter;
    const multiplier = dx * dx * span * dropMass * sprayPerWhitecap(r80);
    for (let i = 0; i < nx * nz; i++) {
      const x = i % nx;
      const z = Math.floor(i / nx);
      sources.push({
        family: 'sea',
        kind: 'sea-spray',
        kindIndex: 2,
        position: [centre[0] + dx * (x + 0.5 - nx / 2), y, centre[1] + dx * (z + 0.5 - nz / 2)],
        velocity: [0, v, 0],
        terrainHeight: false,
        diameter,
        portIndex: i,
        multiplier,
      });
    }
  }
  return sources;
}

function fieldData(
  s: State,
  context: StepContext,
  name: string,
  count: number,
  type: 'f64' | 'f32',
): Float64Array | Float32Array | undefined {
  const port = context.inputs.get(name);
  if (!port) return;
  const size = type === 'f64' ? 8 : 4;
  if (
    port.region.layout !== LAYOUT ||
    port.region.type !== type ||
    port.region.byteLength !== count * size ||
    !port.cell.every((v, i) => v === context.cell[i])
  )
    throw new RangeError(`Invalid ${name} port. Use layout 1 with the matching data type, dimensions and origin cell.`);
  return regionWords(s.host.memory, port.region) as Float64Array | Float32Array;
}

function isBelow(terrain: Bed, sample: BedSample, x: number, y: number, z: number, radius: number): boolean {
  return y < terrain.sample(x, z, sample).elevation + radius;
}
function hitsBed(terrain: Bed, sample: BedSample, prev: Float64Array, p: Float64Array, i: number, o: number): boolean {
  const x = prev[i]!,
    y = prev[i + 1]!,
    z = prev[i + 2]!;
  const dx = p[o]! - x,
    dy = p[o + 1]! - y,
    dz = p[o + 2]! - z;
  const radius = p[o + 10]! * 0.5;
  const steps = Math.max(
    1,
    Math.ceil(
      Math.max((2 * Math.abs(dx) * terrain.columns) / terrain.width, (2 * Math.abs(dz) * terrain.rows) / terrain.depth),
    ),
  );
  for (let j = 1; j <= steps; j++) {
    const f = j / steps;
    if (isBelow(terrain, sample, x + f * dx, y + f * dy, z + f * dz, radius)) return true;
  }
  return false;
}

/** Natural dust and water droplet transport on the fixed physics world clock. */
export class AirborneParticles implements Solver<AirborneParams> {
  readonly id: string;
  /** Optional layout-1 f64 kg/s per explicitly described natural source. */
  readonly emissionField: FieldDescriptor;
  /** Layout-1 f64 16-word rows. See {@link readParticles} for typed copies. Unused rows are zero. */
  readonly particleField: FieldDescriptor;
  /** Layout-1 f64 mass ledger in the same order as {@link AirborneMass}. */
  readonly massField: FieldDescriptor;
  readonly #options: AirborneOptions;
  #state?: State;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: AirborneOptions,
  ) {
    this.id = options.id ?? 'airborne';
    if (!this.id) throw new RangeError('Choose a nonempty airborne particle solver id.');
    const dust = options.dustField;
    if (dust && (dust.kind !== 'uniformGrid' || dust.centring !== 'vertex' || dust.unit !== 'kg/(m^2 s)'))
      throw new RangeError('Provide aeolian dust as a vertex-centred mass flux grid in kg/(m^2 s).');
    this.#options = { ...options, dustField: dust ? { ...dust } : undefined, signal: undefined };
    this.emissionField = layout(`${this.id}:emissions`, 'environmentalMassFlux', 'kg/s', 'scalarSeries');
    this.particleField = layout(`${this.id}:particles`, 'environmentalParticleState', 'record', 'particleSet');
    this.massField = layout(`${this.id}:mass`, 'environmentalParticleMass', 'kg', 'scalarSeries');
  }

  /** Loads the native kernel without importing it into the Physics root. */
  static async load(options: AirborneOptions = {}): Promise<AirborneParticles> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      load(new URL(/* @vite-ignore */ './airborne-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? load(new URL(/* @vite-ignore */ './airborne-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new AirborneParticles(plain, shared, options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [
      { field: this.particleField, access: 'write' },
      { field: this.massField, access: 'write' },
    ];
    if (this.#options.terrain) fields.push({ field: BED_FIELD, access: 'read' });
    if (this.#options.dustField) fields.push({ field: this.#options.dustField, access: 'read' });
    if (this.#options.whitecaps) fields.push({ field: SEA_FOAM_FIELD, access: 'read' });
    if (this.#options.emissions) fields.push({ field: this.emissionField, access: 'read' });
    return { id: this.id, fields, rate: RATE, stableRate: () => RATE };
  }

  init(host: SolverHost, params: AirborneParams): void {
    if (this.#state) throw new MargoError('attached', 'Load a new airborne solver for the next world.');
    if (!params) throw new TypeError('Provide airborne particle parameters or an empty settings object.');
    if (params.drag !== undefined && params.drag !== 'stokes' && params.drag !== 'sphere')
      throw new RangeError('Choose either Stokes or sphere drag for environmental particles.');
    const capacity = numberOf(params.capacity ?? 4096, 'airborne capacity');
    const initial = params.initial ?? [];
    if (initial.length > capacity || capacity * (RECORD + FORCE + STRIDE) * BYTES >= MAX_MEMORY_PAGES * 65536)
      throw new RangeError('Choose a capacity that fits the initial airborne parcels and the world memory.');
    const wind = params.wind;
    if (wind && (wind.medium !== 'air' || !wind.cell.every(Number.isSafeInteger)))
      throw new TypeError('Provide a valid air Wind field for environmental particles.');
    const terrain = params.terrain;
    if ((this.#options.terrain || this.#options.dustField) && !terrain)
      throw new TypeError('Provide the matching terrain shape for the live bed and aeolian dust grids.');
    if (this.#options.whitecaps && !params.spray)
      throw new TypeError('Provide the SEA-13 whitecap grid shape for its spray source.');
    const bed = terrain && 'sample' in terrain ? terrain : undefined;
    if (this.#options.dustField && !this.#options.terrain && !bed)
      throw new TypeError('Provide a live TerrainBed or a static Bed to locate aeolian dust above the surface.');
    const humidity = range(params.humidity ?? 1, 'relative humidity', 0, 1);
    const temperature = range(params.temperature ?? STANDARD_TEMPERATURE, 'temperature in K', 200, 340);
    const cellSize = range(params.cellSize ?? 4096, 'world cell size', Number.MIN_VALUE, 1e12);
    const rms = vector(params.turbulence?.rms ?? ZERO, 'turbulence RMS');
    if (rms.some((v) => v < 0)) throw new RangeError('Choose nonnegative wind fluctuation RMS on each axis.');
    const correlation = range(params.turbulence?.time ?? 1, 'turbulence correlation time', Number.MIN_VALUE, 1e7);
    const [lo, hi] = params.bounds ?? [undefined, undefined];
    const bounds = lo && hi ? ([vector(lo, 'bounds min'), vector(hi, 'bounds max')] as const) : undefined;
    if (bounds && !bounds[0].every((v, i) => v < bounds[1][i]!))
      throw new RangeError('Provide airborne bounds with positive extent on each axis.');
    const sources: Source[] = (params.sources ?? []).map((a, i) => ({
      ...a,
      position: vector(a.position, 'source position'),
      velocity: vector(a.velocity ?? ZERO, 'source velocity'),
      family: 'custom',
      kindIndex: material(a.kind),
      portIndex: i,
      multiplier: 1,
      terrainHeight: false,
    }));
    for (const source of sources) {
      range(source.diameter, 'source diameter', MIN_DIAMETER, MAX_DIAMETER[source.kindIndex]!);
      range(source.rate ?? 0, 'source mass rate', 0, Number.MAX_VALUE);
    }
    const customSources = sources.length;
    const dustLift = range(params.dustReleaseHeight ?? 0.05, 'dust release height', 0, 1e5);
    const dustVelocity = range(params.dustLiftVelocity ?? 0, 'dust lift speed', 0, 120);
    if (this.#options.dustField) for (const source of makeDust(terrain!, dustLift, dustVelocity)) sources.push(source);
    const spray = this.#options.whitecaps ? makeSpray(params.spray!) : [];
    for (const source of spray) sources.push(source);
    const module = isShared(host.memory) ? this.shared : this.plain;
    if (!module) throw new MargoError('unsupported', 'Use plain world memory when shared Wasm is unavailable.');
    const native = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as Native;
    const reserve = (name: string, count: number) => host.allocate(`airborne-${name}`, BYTES * count, 'f64', LAYOUT);
    const stack = host.allocate('airborne-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    native.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    const state: State = {
      host,
      native,
      particles: reserve('parcels', capacity * RECORD),
      samples: reserve('air', capacity * FORCE),
      old: reserve('step-begin', capacity * STRIDE),
      ledger: reserve('mass', 7),
      count: reserve('count', 3),
      pending: reserve('source-mass', Math.max(1, sources.length)),
      sources,
      capacity,
      wind,
      rms,
      correlation,
      humidity,
      equilibrium: humidity < 1 ? pow(1 + (1.12 * humidity) / (1 - humidity), 1 / 3) : 1,
      temperature,
      drag: params.drag === 'stokes',
      bed,
      terrain,
      bounds,
      cellSize,
      customSources,
      sprayCells: spray.length / 3,
    };
    const p = words(state, state.particles);
    const count = words(state, state.count);
    const mass = words(state, state.ledger);
    for (const [i, a] of initial.entries()) {
      writeParcel(p, i, i, material(a.kind), a);
      mass[FOUNDER]! += a.mass;
    }
    count[0] = initial.length;
    count[1] = initial.length;
    mass[ACTIVE] = mass[FOUNDER]!;
    this.#state = state;
  }

  step(context: StepContext, dt: number): void {
    const s = this.#live();
    const body = words(s, s.particles);
    const mass = words(s, s.ledger);
    const count = words(s, s.count);
    const pending = words(s, s.pending);
    const before = words(s, s.old);
    const air = words(s, s.samples);
    const terrainPort = context.inputs.get(BED_FIELD.name);
    const terrain = terrainPort ? bedFromPort(s.host.memory, terrainPort, s.terrain!) : s.bed;
    if (terrain && !terrain.cell.every((coordinate, axis) => coordinate === context.cell[axis]))
      throw new RangeError('Use the same world origin cell for the airborne terrain grid and solver.');
    const dustField = this.#options.dustField;
    const dust = dustField ? fieldData(s, context, dustField.name, bedVertexCount(s.terrain!), 'f64') : undefined;
    const foam = fieldData(s, context, SEA_FOAM_FIELD.name, s.sprayCells * 2, 'f32');
    const emissions = fieldData(s, context, this.emissionField.name, s.customSources, 'f64');
    const ground: BedSample = { elevation: 0, normal: [0, 1, 0] };
    if (foam && SEA_FOAM_LAYOUT !== LAYOUT) throw new RangeError('Use the current layout-1 SEA-13 whitecap output.');
    let n = count[0]!;
    for (const [i, source] of s.sources.entries()) {
      const f = source.family;
      const rate =
        f === 'custom'
          ? (source.rate ?? 0) + (emissions?.[source.portIndex] ?? 0)
          : f === 'aeolian'
            ? (dust?.[source.portIndex] ?? 0)
            : (foam?.[source.portIndex * 2 + 1] ?? 0);
      const received = range(rate, 'source flux value', 0, f === 'sea' ? 1 : Number.MAX_VALUE) * source.multiplier * dt;
      pending[i]! += received;
      mass[INCOMING]! += received;
    }
    const sourceCount = s.sources.length;
    const head = count[2]!;
    for (let j = 0; j < sourceCount && n < s.capacity; j++) {
      const i = (head + j) % sourceCount;
      const source = s.sources[i]!;
      const amount = pending[i]!;
      if (!amount || (source.terrainHeight && !terrain)) continue;
      const elevation = source.terrainHeight
        ? terrain!.sample(source.position[0], source.position[2], ground).elevation
        : 0;
      writeParcel(body, n++, count[1]!++, source.kindIndex, { ...source, mass: amount }, elevation);
      count[2] = (i + 1) % sourceCount;
      pending[i] = 0;
    }
    let pendingTotal = 0;
    for (let i = 0; i < sourceCount; i++) pendingTotal += pending[i]!;
    mass[WAITING] = pendingTotal;
    const wind = s.wind;
    const cellOffset = wind ? context.cell.map((value, i) => (value - wind.cell[i]!) * s.cellSize) : ZERO;
    const dtWind = exp(-dt / s.correlation);
    const noiseScale = Math.sqrt(1 - dtWind * dtWind);
    const stochastic = s.rms.some((value) => value > 0);
    const draw = new Uint32Array(4);
    const gust = new Float64Array(3);
    const windSample: FlowSample = { velocity: [0, 0, 0], density: STANDARD_DENSITY, temperature: s.temperature };
    const stream = solverNumber(this.id);
    for (let i = 0; i < n; i++) {
      const p = i * RECORD,
        a = i * FORCE,
        o = i * STRIDE;
      for (let k = 0; k < 3; k++) before[o + k] = body[p + k]!;
      before[o + 3] = body[p + 9]!;
      const sampled =
        wind?.sample(
          body[p]! + cellOffset[0]!,
          body[p + 1]! + cellOffset[1]!,
          body[p + 2]! + cellOffset[2]!,
          context.tick * dt,
          windSample,
        ) ?? windSample;
      const temperature = range(sampled.temperature, 'sample temperature in K', 200, 340);
      const density = range(sampled.density, 'sample density', 0.05, 3);
      const kind = body[p + 13]!;
      const d = body[p + 10]!;
      const rho = parcelDensity(kind, d, body[p + 11]!);
      if (stochastic) {
        const id = body[p + 14]!;
        philox(
          id % TWO32,
          Math.floor(id / TWO32),
          context.tick % TWO32,
          Math.floor(context.tick / TWO32),
          context.seed,
          stream,
          draw,
        );
        normalDeviates(draw, gust);
      }
      let speed2 = 0;
      for (let ax = 0; ax < 3; ax++) {
        body[p + 6 + ax] = dtWind * body[p + 6 + ax]! + noiseScale * s.rms[ax]! * gust[ax]!;
        const u = range(sampled.velocity[ax]!, 'sample wind velocity', -150, 150) + body[p + 6 + ax]!;
        air[a + ax] = u;
        const relative = body[p + 3 + ax]! - u;
        speed2 += relative * relative;
        air[a + 3 + ax] = s.host.gravity[ax]! * (1 - density / rho);
      }
      const beta = dragRate(d, rho, density, airViscosity(temperature), Math.sqrt(speed2), s.drag, temperature);
      const [drag, velocityTime, positionTime] = dragIntegrals(beta, dt);
      air[a + 6] = drag;
      air[a + 7] = velocityTime;
      air[a + 8] = positionTime;
      air[a + 9] = kind && s.humidity < 1 ? waterDrying(temperature, s.humidity, RHO[1]) : 0;
      air[a + 10] = kind === 2 ? s.equilibrium * body[p + 11]! : 0;
    }
    s.native.disperse(s.particles.byteOffset, s.samples.byteOffset, n, dt);
    let live = 0;
    let airborne = 0;
    for (let i = 0; i < n; i++) {
      const p = i * RECORD;
      const previous = i * STRIDE;
      const remaining = body[p + 9]!;
      mass[VAPOUR]! += before[previous + 3]! - remaining;
      if (!remaining) continue;
      if (terrain && hitsBed(terrain, ground, before, body, previous, p)) {
        mass[DEPOSIT]! += remaining;
        continue;
      }
      if (s.bounds && s.bounds[0].some((v, k) => body[p + k]! < v || body[p + k]! > s.bounds![1][k]!)) {
        mass[EXIT]! += remaining;
        continue;
      }
      if (live < i) body.copyWithin(live * RECORD, p, p + RECORD);
      live++;
      airborne += remaining;
    }
    body.fill(0, live * RECORD, n * RECORD);
    count[0] = live;
    mass[ACTIVE] = airborne;
  }

  /** Copy the live parcels in their stable emission order. */
  readParticles(): readonly AirborneSample[] {
    const s = this.#live();
    const p = words(s, s.particles);
    return Array.from({ length: words(s, s.count)[0]! }, (_, i) => {
      const at = i * RECORD;
      return {
        kind: KINDS[p[at + 13]!]!,
        id: p[at + 14]!,
        age: p[at + 15]!,
        position: [p[at]!, p[at + 1]!, p[at + 2]!],
        velocity: [p[at + 3]!, p[at + 4]!, p[at + 5]!],
        diameter: p[at + 10]!,
        mass: p[at + 9]!,
      };
    });
  }

  /** Cumulative source, deposition, vapour and open-boundary mass. */
  get budget(): AirborneMass {
    const s = this.#live();
    const m = words(s, s.ledger);
    return {
      initial: m[FOUNDER]!,
      supplied: m[INCOMING]!,
      airborne: m[ACTIVE]!,
      deposited: m[DEPOSIT]!,
      evaporated: m[VAPOUR]!,
      outflow: m[EXIT]!,
      waiting: m[WAITING]!,
    };
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.#live();
    return [
      { field: this.particleField.name, region: s.particles, tick, cell: ZERO },
      { field: this.massField.name, region: s.ledger, tick, cell: ZERO },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const s = this.#live();
    return [s.particles, s.ledger, s.count, s.pending];
  }

  extraState(): readonly Region[] {
    return [];
  }

  #live(): State {
    if (!this.#state) throw new MargoError('state', 'Add the airborne solver to a PhysicsWorld before reading it.');
    return this.#state;
  }
}
