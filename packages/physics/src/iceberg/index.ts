import { pow } from '@margoengine/math/pinned';
import { WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS } from '../sea/wake.js';
import type {
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import {
  bindIcebergKernel,
  type IcebergBuilds,
  type IcebergKernel,
  type IcebergWorkCounts,
  loadIcebergBuilds,
} from './kernel.js';

export type { IcebergWorkerWork, IcebergWorkCounts } from './kernel.js';
import { icebergError } from './errors.js';

/** Binary layout of the cell-volume and iceberg ports. */
export const ICEBERG_FIELD_LAYOUT = 1;
/** f64 words in one ice body row. */
export const ICEBERG_BODY_WORDS = 20;

/** A Cartesian vector, with y up. */
export type IcebergVector = readonly [number, number, number];
/** A unit quaternion in x, y, z, w order. */
export type IcebergRotation = readonly [number, number, number, number];

/** A homogeneous solid ice block in the physics world. */
export interface IcebergBodyOptions {
  /** Size in metres in body x, y and z. */
  readonly size: IcebergVector;
  /** Initial centre in metres. Defaults to the upright hydrostatic equilibrium at x=z=0. */
  readonly position?: IcebergVector;
  /** Initial body-to-world rotation. By default an unstable upright block receives a small heel. */
  readonly orientation?: IcebergRotation;
  /** Initial world velocity in m/s. Defaults to zero. */
  readonly velocity?: IcebergVector;
  /** Initial angular velocity in body axes, rad/s. Defaults to zero. */
  readonly spin?: IcebergVector;
}

/** Site where a volume from the glacier's marine calving field enters the water. */
export interface IcebergReleaseSite {
  /** Index in the configured source's f64 volume array. */
  readonly sourceCell: number;
  /** Horizontal centre of the calving event, [x,z] metres in the local cell. */
  readonly position: readonly [number, number];
  /** Relative x, y and z dimensions. Defaults to [1, 2, 2]. The volume sets their absolute scale. */
  readonly shape?: IcebergVector;
  /** Reusable body rows at the site. Defaults to 1. Further releases wait in a volume budget until a row frees. */
  readonly slots?: number;
}

/** Ice material, water, air and melt forcing in SI units. */
export interface IcebergOptions {
  /** Initially present bodies. Defaults to none. */
  readonly bodies?: readonly IcebergBodyOptions[];
  /** Optional marine source sites, in stable field order. Defaults to none. */
  readonly releaseSites?: readonly IcebergReleaseSite[];
  /** Density of the solid ice in kg/m³. Defaults to 917. */
  readonly iceDensity?: number;
  /** Density of the water in kg/m³. Defaults to 1025. */
  readonly waterDensity?: number;
  /** Density of the air in kg/m³. Defaults to 1.225. */
  readonly airDensity?: number;
  /** Still-water elevation in metres. Defaults to zero. */
  readonly seaLevel?: number;
  /** Uniform world water velocity in m/s. Defaults to zero. */
  readonly current?: IcebergVector;
  /** Uniform world air velocity in m/s. Defaults to zero. */
  readonly wind?: IcebergVector;
  /** Quadratic normal drag coefficient of wet panels. Defaults to 1. Zero disables water drag. */
  readonly waterDrag?: number;
  /** Quadratic normal drag coefficient of exposed panels. Defaults to 1. Zero disables air drag. */
  readonly airDrag?: number;
  /** Ablation recession on wet side faces in m/s perpendicular to each face. Defaults to zero. */
  readonly sideMelt?: number;
  /** Ablation recession on the face most downward in m/s perpendicular to it. Defaults to zero. */
  readonly basalMelt?: number;
}

/** Solver identity, optional source and cancellation. */
export interface IcebergLoadOptions {
  /** ID and output field prefix. Defaults to 'iceberg'. */
  readonly id?: string;
  /** Layout-1 f64 marine released-ice volumes in m³, such as GlacierSolver.calvingField. */
  readonly calving?: FieldDescriptor;
  /** Cancels loading with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Native participants including the caller. Use 1 (default), 2 or 4 with shared memory. */
  readonly threads?: number;
}

/** Physical pose, shape, and the latest signed wave-source volume. */
export interface IcebergSample {
  /** Current centre of mass in metres. */
  readonly position: IcebergVector;
  /** Body-to-world rotation. */
  readonly orientation: IcebergRotation;
  /** World linear velocity, m/s. */
  readonly velocity: IcebergVector;
  /** Angular velocity in body axes, rad/s. */
  readonly spin: IcebergVector;
  /** Current dimensions in metres. A melted or vacant body has [0,0,0]. */
  readonly size: IcebergVector;
  /** Submerged volume in m³. */
  readonly displaced: number;
  /** Signed change in submerged volume in the last world tick, m³. */
  readonly waveVolume: number;
  /** Newly melted solid volume in the last world tick, m³. */
  readonly melted: number;
}

/** Ice volume budgets in m³ of solid ice. */
export interface IcebergBudget {
  /** Current volume of all active bodies. */
  readonly ice: number;
  /** Volume melted since initialization. */
  readonly melted: number;
  /** Calved volume delivered by the source since initialization. */
  readonly calved: number;
  /** Calved volume that is waiting for a free destination row. */
  readonly awaiting: number;
}

const ZERO = [0, 0, 0] as const;
const IDENTITY = [0, 0, 0, 1] as const;
const DEFAULT_SHAPE = [1, 2, 2] as const;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const DEFAULT_HEEL_COMPONENT = 0.0005;
const SETTINGS_WORDS = 15;
const SITE_WORDS = 8;
const BODY = ICEBERG_BODY_WORDS;
const DISPLACED = 16;
const WAVE = 17;
const MELTED = 18;
const TOTAL_MELTED = 19;
const SOURCE_PAIR = 2 * WAKE_SOURCE_WORDS;

interface Regions {
  readonly memory: WebAssembly.Memory;
  readonly host: SolverHost;
  readonly staged: { readonly wave: Float64Array; readonly sources: Float64Array; readonly fresh: Float64Array };
  readonly kernel: IcebergKernel;
  readonly count: number;
  readonly sites: number;
  readonly config: Region;
  readonly placements: Region;
  readonly bodies: Region;
  readonly work: Region;
  readonly queue: Region;
  readonly nextQueue: Region;
  readonly nextReleased: Region;
  readonly wave: Region;
  readonly wakeSources: Region;
  readonly freshWater: Region;
  readonly released: Region;
  readonly state: readonly Region[];
}

function scalar(label: string, value: number, minimum = -Infinity): number {
  if (!Number.isFinite(value) || value < minimum)
    throw icebergError(`Invalid iceberg ${label}. Use a finite value at least ${minimum}.`);
  return value;
}

function positive(label: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0))
    throw icebergError(`Invalid iceberg ${label}. Use a positive finite value.`);
  return value;
}

function vec(label: string, value: IcebergVector): IcebergVector {
  if (value?.length !== 3 || !value.every(Number.isFinite))
    throw icebergError(`Invalid iceberg ${label}. Use three finite coordinates.`);
  return value;
}

function dimensions(value: IcebergVector): IcebergVector {
  const [x, y, z] = vec('dimensions', value);
  positive('dimension x', x);
  positive('dimension y', y);
  positive('dimension z', z);
  positive('volume', x * y * z);
  return value;
}

function rotor(source: IcebergRotation): IcebergRotation {
  if (source?.length !== 4 || !source.every(Number.isFinite))
    throw icebergError('Invalid iceberg orientation. Use four finite quaternion components.');
  const [x, y, z, w] = source;
  const length = positive('orientation norm', Math.sqrt(x * x + y * y + z * z + w * w));
  return [x / length, y / length, z / length, w / length];
}

/** The critical width-to-height ratio for a freely floating homogeneous rectangular block. */
export function icebergCriticalAspect(iceDensity = 917, waterDensity = 1025): number {
  const densityRatio = positive('ice density', iceDensity) / positive('water density', waterDensity);
  if (!(densityRatio < 1))
    throw icebergError('The ice must be less dense than its water. Increase waterDensity or lower iceDensity.');
  return Math.sqrt(6 * densityRatio * (1 - densityRatio));
}

function calmHeel(size: IcebergVector, ice: number, water: number): IcebergRotation {
  const [x, y, z] = size;
  if (Math.min(x, z) / y >= icebergCriticalAspect(ice, water)) return IDENTITY;
  const s = DEFAULT_HEEL_COMPONENT;
  const w = Math.sqrt(1 - s * s);
  return x <= z ? [0, 0, s, w] : [s, 0, 0, w];
}

function settings(host: SolverHost, options: IcebergOptions): readonly number[] {
  const ice = positive('ice density', options.iceDensity ?? 917);
  const water = positive('water density', options.waterDensity ?? 1025);
  icebergCriticalAspect(ice, water);
  return [
    positive('downward gravity', -host.gravity[1]),
    ice,
    scalar('sea level', options.seaLevel ?? 0),
    water,
    ...vec('water current', options.current ?? ZERO),
    scalar('water drag', options.waterDrag ?? 1, 0),
    positive('air density', options.airDensity ?? 1.225),
    ...vec('air velocity', options.wind ?? ZERO),
    scalar('air drag', options.airDrag ?? 1, 0),
    scalar('side recession', options.sideMelt ?? 0, 0),
    scalar('basal recession', options.basalMelt ?? 0, 0),
  ];
}

function words(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64);
}

function triplet(words: Float64Array, start: number): IcebergVector {
  return [words[start]!, words[start + 1]!, words[start + 2]!];
}

function volume(words: Float64Array, at: number): number {
  return words[at + 13]! * words[at + 14]! * words[at + 15]!;
}

function descriptor(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, kind: 'bodySet', quantity, unit, centring: 'particle' });
}

function seedBody(values: Float64Array, offset: number, spec: IcebergBodyOptions, model: ArrayLike<number>): void {
  const size = dimensions(spec.size);
  const ice = model[1]!;
  const water = model[3]!;
  const origin = [0, model[2]! + size[1] * (0.5 - ice / water), 0] as const;
  const orientation = spec.orientation ? rotor(spec.orientation) : calmHeel(size, ice, water);
  values.fill(0, offset, offset + BODY);
  values.set(vec('starting position', spec.position ?? origin), offset);
  values.set(orientation, offset + 3);
  values.set(vec('starting velocity', spec.velocity ?? ZERO), offset + 7);
  values.set(vec('starting angular velocity', spec.spin ?? ZERO), offset + 10);
  values.set(size, offset + 13);
}

function siteRecords(sites: readonly IcebergReleaseSite[], initial: number): { count: number; records: number[] } {
  const records: number[] = [];
  const cells = new Set<number>();
  let count = initial;
  for (const site of sites) {
    const slots = site.slots ?? 1;
    if (!Number.isSafeInteger(slots) || slots < 1 || !Number.isSafeInteger(count + slots))
      throw icebergError('Invalid calving slot count. Use a positive integer representable by the arena.');
    const cell = site.sourceCell;
    if (!Number.isSafeInteger(cell) || cell < 0 || cells.has(cell))
      throw icebergError('Invalid iceberg release site. Use a unique nonnegative source cell index.');
    cells.add(cell);
    const { position } = site;
    if (position?.length !== 2 || !position.every(Number.isFinite))
      throw icebergError('Invalid iceberg release position. Use finite x and z coordinates in metres.');
    records.push(cell, ...position, ...dimensions(site.shape ?? DEFAULT_SHAPE), count, slots);
    count += slots;
  }
  // Two body buffers and two scalar output arrays must fit wasm32, in addition to other world allocations.
  if (count * (2 * BODY + 2 + SOURCE_PAIR) * F64 >= 0x1_0000_0000)
    throw icebergError('Iceberg body capacity exceeds wasm32 memory. Reduce the initial bodies or release slots.');
  return { count, records };
}

function projectedArea(words: Float64Array, at: number): number {
  const [qx, qy, qz] = triplet(words, at + 3);
  const qw = words[at + 6]!;
  const [x, y, z] = triplet(words, at + 13);
  return (
    Math.abs(2 * (qx * qy + qw * qz)) * y * z +
    Math.abs(1 - 2 * (qx * qx + qz * qz)) * x * z +
    Math.abs(2 * (qy * qz - qw * qx)) * x * y
  );
}

function wakePair(sources: Float64Array, slot: number, body: Float64Array, before: Float64Array, at: number) {
  const delta = body[at + WAVE]!;
  if (delta === 0) return;
  const area = projectedArea(volume(body, at) > 0 ? body : before, at);
  const radius = positive('projected wake radius', Math.sqrt(area / Math.PI));
  const x = body[at]!;
  const z = body[at + 2]!;
  const word = slot * SOURCE_PAIR;
  sources.set([x, z, radius, 0, -delta, x, z, radius * Math.SQRT2, 0, delta], word);
}

function advance(state: Regions, dt: number): void {
  const result = state.kernel.iceberg_step(state.work.byteOffset, state.count, state.config.byteOffset, dt);
  if (result !== 0)
    throw icebergError(
      'Iceberg state left numeric range. Use practical dimensions and reduce forcing or melt rates.',
      'failed',
    );
  const {
    memory,
    staged: { wave, sources, fresh },
  } = state;
  const target = words(memory, state.work);
  if (!target.every(Number.isFinite))
    throw icebergError('Iceberg state contains nonfinite rows. Reduce forcing, body sizes or step duration.', 'failed');
  const before = words(memory, state.bodies);
  sources.fill(0);
  const densityRatio = words(memory, state.config)[1]! / 1000;
  for (let i = 0; i < state.count; i++) {
    const at = i * BODY;
    wave[i] = target[at + WAVE]!;
    wakePair(sources, i, target, before, at);
    const flux = dt > 0 ? (target[at + MELTED]! * densityRatio) / dt : 0;
    if (!(flux >= 0 && Number.isFinite(flux)))
      throw icebergError(
        'Iceberg meltwater flux exceeded its finite range. Reduce melt rates or use a larger step duration.',
        'failed',
      );
    fresh[i] = flux;
  }
  words(memory, state.wave).set(wave);
  words(memory, state.wakeSources).set(sources);
  words(memory, state.freshWater).set(fresh);
  before.set(target);
}

function calvingWords(port: Port, fallback: WebAssembly.Memory): Float64Array {
  const { region } = port;
  if (region.type !== 'f64' || region.layout !== ICEBERG_FIELD_LAYOUT)
    throw icebergError('Invalid calving field layout. Use layout-1 f64 solid volumes in cubic metres.');
  const memory = region.memory ?? fallback;
  if (
    !(
      Number.isSafeInteger(region.byteOffset) &&
      region.byteOffset >= 0 &&
      region.byteOffset % F64 === 0 &&
      Number.isSafeInteger(region.byteLength) &&
      region.byteLength >= 0 &&
      region.byteLength % F64 === 0 &&
      region.byteOffset + region.byteLength <= memory.buffer.byteLength
    )
  )
    throw icebergError('Invalid calving region. Publish an aligned f64 region from its owning memory.');
  return words(memory, region);
}

function spawn(state: Regions, target: Float64Array, config: Float64Array, incoming: Float64Array | undefined): void {
  const { memory, sites } = state;
  const meta = words(memory, state.placements);
  const pending = words(memory, state.nextQueue);
  const releases = words(memory, state.nextReleased);
  for (let i = 0; i < sites; i++) {
    const at = i * SITE_WORDS;
    const received = incoming ? incoming[meta[at]!]! : 0;
    scalar('incoming calving volume', received, 0);
    const queue = scalar('pending calving volume', pending[i]! + received, 0);
    pending[sites + i] = scalar('cumulative calving volume', pending[sites + i]! + received, 0);
    pending[i] = queue;
    if (queue === 0) continue;
    const first = meta[at + 6]!;
    const count = meta[at + 7]!;
    for (let slot = first; slot < first + count; slot++) {
      const offset = slot * BODY;
      if (volume(target, offset) > 0) continue;
      const shape = triplet(meta, at + 3);
      const scale = positive('calving scale', pow(queue / (shape[0] * shape[1] * shape[2]), 1 / 3));
      const size = shape.map((width) => width * scale) as unknown as IcebergVector;
      const previousMelt = target[offset + TOTAL_MELTED]!;
      seedBody(
        target,
        offset,
        { size, position: [meta[at + 1]!, config[2]! + size[1] * (0.5 - config[1]! / config[3]!), meta[at + 2]!] },
        config,
      );
      target[offset + TOTAL_MELTED] = previousMelt;
      releases[i] = queue;
      pending[i] = 0;
      break;
    }
  }
}

/** Six-degree-of-freedom iceberg hydrodynamics and marine release from a glacier field. */
export class IcebergSolver implements Solver<IcebergOptions> {
  readonly #id: string;
  readonly #builds: IcebergBuilds;
  readonly #calving: FieldDescriptor | undefined;
  #data?: Regions;
  #disposed = false;
  #nativeWork?: IcebergWorkCounts;

  /** f64 rows: position 3, rotation 4, velocity 3, spin 3, size 3, displacement, wave volume, melt, cumulative melt. */
  readonly bodyField: FieldDescriptor;
  /** Signed displaced-volume change per body in m³ for the last step. */
  readonly waveField: FieldDescriptor;
  /** Equal-and-opposite layout-1 SeaSource patches for a WakeSolver, in SI units. */
  readonly wakeSourceField: FieldDescriptor;
  /** Freshwater released by melting at 1000 kg/m³, in m³/s per body. */
  readonly meltwaterField: FieldDescriptor;
  /** Newly admitted solid ice volume per calving site, in m³. */
  readonly releaseField: FieldDescriptor;

  private constructor(id: string, builds: IcebergBuilds, calving?: FieldDescriptor) {
    this.#id = id;
    this.#builds = builds;
    this.#calving = calving ? { ...calving } : undefined;
    this.bodyField = descriptor(id + '.bodies', 'kinematics', 'SI');
    this.waveField = descriptor(id + '.waveVolume', 'displacementVolume', 'm^3');
    this.wakeSourceField = descriptor(id + '.wakeSources', 'seaSource', 'SI');
    this.meltwaterField = descriptor(id + '.meltwater', 'discharge', 'm^3/s');
    this.releaseField = descriptor(id + '.release', 'iceReleaseVolume', 'm^3');
  }

  /** Loads separate ordinary and shared-memory SIMD variants on demand. */
  static async load(options: IcebergLoadOptions = {}): Promise<IcebergSolver> {
    const id = options.id ?? 'iceberg';
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id)
      throw icebergError('Invalid iceberg solver ID. Use a nonempty identifier without outer whitespace.');
    if (options.calving && options.calving.unit !== 'm^3')
      throw icebergError('Invalid iceberg source unit. Use a marine calving field in cubic metres.');
    return new IcebergSolver(id, await loadIcebergBuilds(options.signal, options.threads), options.calving);
  }

  /** Release optional helper threads after the world stops using this solver. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#builds[Symbol.dispose]();
  }

  /** Declares its registry fields at the base 60 Hz dyadic interval. */
  describe(): SolverDescription {
    return {
      id: this.#id,
      fields: [
        ...[this.bodyField, this.waveField, this.wakeSourceField, this.meltwaterField, this.releaseField].map(
          (field) => ({
            field,
            access: 'write' as const,
          }),
        ),
        ...(this.#calving ? [{ field: this.#calving, access: 'read' as const }] : []),
      ],
      rate: 0,
      stableRate: () => 0,
    };
  }

  /** Initializes world-owned bodies, the environment, and fixed calving-site storage. */
  init(host: SolverHost, options: IcebergOptions = {}): void {
    if (this.#disposed) throw icebergError('The iceberg solver was disposed. Load a new instance.', 'disposed');
    if (this.#data)
      throw icebergError('IcebergSolver already has a world. Load a fresh solver to attach again.', 'attached');
    try {
      this.#initialize(host, options);
    } catch (cause) {
      if (this.#builds.pool) this[Symbol.dispose]();
      throw cause;
    }
  }

  #initialize(host: SolverHost, options: IcebergOptions): void {
    const bodies = options.bodies ?? [];
    const sites = options.releaseSites ?? [];
    if (sites.length && !this.#calving)
      throw icebergError('Iceberg releases need a source. Bind a calving field when loading the solver.');
    const { count, records } = siteRecords(sites, bodies.length);
    if (count === 0) throw icebergError('IcebergSolver needs bodies. Use an initial body or a marine release site.');
    const model = settings(host, options);
    const initial = new Float64Array(count * BODY);
    for (const [i, body] of bodies.entries()) seedBody(initial, i * BODY, body, model);
    const kernel = bindIcebergKernel(host, this.#builds);
    const make = (name: string, length: number) =>
      host.allocate('iceberg-' + name, length * F64, 'f64', ICEBERG_FIELD_LAYOUT);
    const config = make('config', SETTINGS_WORDS);
    const placements = make('release-sites', records.length);
    const storage = make('state', count * BODY);
    const work = make('work', count * BODY);
    const queue = make('pending', 2 * sites.length);
    const nextQueue = make('next-pending', 2 * sites.length);
    const wave = make('waves', count);
    const wakeSources = host.allocate('iceberg-wake-sources', count * SOURCE_PAIR * F64, 'f64', WAKE_SOURCE_LAYOUT);
    const freshWater = make('meltwater', count);
    const released = make('release', sites.length);
    const nextReleased = make('next-release', sites.length);
    const { memory } = host;
    const data = {
      memory,
      host,
      staged: {
        wave: new Float64Array(count),
        sources: new Float64Array(count * SOURCE_PAIR),
        fresh: new Float64Array(count),
      },
      kernel,
      count,
      sites: sites.length,
      config,
      placements,
      bodies: storage,
      work,
      queue,
      nextQueue,
      wave,
      wakeSources,
      freshWater,
      released,
      nextReleased,
      state: [config, placements, storage, queue, wave, wakeSources, freshWater, released],
    };
    const env = words(memory, config);
    env.set(model);
    words(memory, placements).set(records);
    const prepared = words(memory, work);
    prepared.set(initial);
    advance(data, 0);
    this.#data = data;
  }

  /** Steps the physical iceberg poses, consuming any calving volume at this coupling tick. */
  step(context: StepContext, dt: number): void {
    if (this.#disposed) throw icebergError('The iceberg solver was disposed. Load a new instance.', 'disposed');
    positive('step duration', dt);
    const state = this.#state();
    const { memory, config, bodies, work, queue, nextQueue, released, nextReleased, sites } = state;
    const input = this.#calving && context.inputs.get(this.#calving.name);
    const incoming = input && calvingWords(input, memory);
    const env = words(memory, config);
    const target = words(memory, work);
    target.set(words(memory, bodies));
    if (sites > 0) {
      words(memory, nextQueue).set(words(memory, queue));
      words(memory, nextReleased).fill(0);
      spawn(state, target, env, incoming);
    }
    advance(state, dt);
    if (sites > 0) {
      words(memory, queue).set(words(memory, nextQueue));
      words(memory, released).set(words(memory, nextReleased));
    }
    this.#nativeWork = state.kernel.workCounts();
  }

  /** Copies native counts from the last accepted physical step. */
  readNativeWork(): IcebergWorkCounts | undefined {
    const work = this.#nativeWork;
    return work && { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  /** The glacier field is sampled at the current step. There are no incoming accumulators. */
  importPorts(_tick: number): void {}

  /** Publishes the current body rows and the co-located wave, melt and release data. */
  exportPorts(tick: number): readonly Port[] {
    const { bodies, wave, wakeSources, freshWater, released, host } = this.#state();
    const cell = host.cell;
    return [
      { field: this.bodyField.name, region: bodies, tick, cell },
      { field: this.waveField.name, region: wave, tick, cell },
      { field: this.wakeSourceField.name, region: wakeSources, tick, cell },
      { field: this.meltwaterField.name, region: freshWater, tick, cell },
      { field: this.releaseField.name, region: released, tick, cell },
    ];
  }

  /** Lists the initialized shape, environments, saved volumes and physical state. */
  stateRegions(): readonly Region[] {
    return this.#state().state;
  }

  /** The entire continuation is in the declared world-owned regions. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Total number of body rows, including empty calving destinations. */
  get count(): number {
    return this.#state().count;
  }

  /** Reads the current geometry and pose of one body row. */
  sample(row: number): IcebergSample {
    const { memory, bodies, count } = this.#state();
    if (!Number.isInteger(row) || row < 0 || row >= count)
      throw icebergError(`Iceberg body row is out of range. Use an integer from 0 to ${count - 1}.`);
    const data = words(memory, bodies);
    const at = row * BODY;
    return {
      position: triplet(data, at),
      orientation: [data[at + 3]!, data[at + 4]!, data[at + 5]!, data[at + 6]!],
      velocity: triplet(data, at + 7),
      spin: triplet(data, at + 10),
      size: triplet(data, at + 13),
      displaced: data[at + DISPLACED]!,
      waveVolume: data[at + WAVE]!,
      melted: data[at + MELTED]!,
    };
  }

  /** Reads the conserved solid-ice volume budget. */
  get budget(): IcebergBudget {
    const { memory, bodies, queue, sites, count } = this.#state();
    const data = words(memory, bodies);
    const waiting = words(memory, queue);
    let ice = 0;
    let melted = 0;
    let calved = 0;
    let awaiting = 0;
    for (let i = 0; i < count; i++) {
      const at = i * BODY;
      ice += volume(data, at);
      melted += data[at + TOTAL_MELTED]!;
    }
    for (let i = 0; i < sites; i++) {
      awaiting += waiting[i]!;
      calved += waiting[sites + i]!;
    }
    return { ice, melted, calved, awaiting };
  }

  #state(): Regions {
    if (!this.#data)
      throw icebergError('IcebergSolver has no state. Add it to a PhysicsWorld with bodies first.', 'state');
    return this.#data;
  }
}
