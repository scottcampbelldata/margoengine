import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { Bed } from '@margoengine/math/fields';
import { exp, hypot, ln, pow } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import type { NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, DYNAMIC_BASE, isShared, MAX_MEMORY_PAGES, regionWords, STACK_BYTES } from '../world/memory.js';
import type { Cell, FieldDescriptor, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';

const GROUND = 1;
const CLOUD = 2;
const LEADER = 3;
const ELECTRIC_PERMITTIVITY = 8.8541878128e-12;
// SI vacuum speed, BIPM 26th CGPM Resolution 1 (2018).
const LIGHT_SPEED = 299_792_458;
const ZERO: Cell = [0, 0, 0];
const OPEN = -1;
const SEED = -2;
const HALTED = -3;
const MAX_THREADS = 64;
const THREAD_JOB_WORDS = 8;

/** A count row followed by channel rows [start xyz, order, end xyz, 0] or thunder rows [midpoint xyz, emission s, weight, length m]. */
export const LIGHTNING_LAYOUT = 1;
export const LIGHTNING_CHANNEL_WORDS = 8;
export const LIGHTNING_THUNDER_WORDS = 6;
const STRIDE = LIGHTNING_CHANNEL_WORDS;
const SOUND_WORDS = LIGHTNING_THUNDER_WORDS;

/** Load the optional lightning kernel and its execution mode. */
export interface LightningLoadOptions {
  /** Unique solver identifier. Defaults to 'lightning'. */
  readonly id?: string;
  /** Total CPU threads including the caller. Defaults to one. */
  readonly threads?: number;
  /** Cancels loading the native implementation and workers. */
  readonly signal?: AbortSignal;
}

/** Finite-difference work in the most recent accepted electrical update. */
export interface LightningWorkCounts {
  /** Total execution threads including the caller. */
  readonly threads: number;
  /** Completed Jacobi sweeps, including the last stopping sweep of each solve. */
  readonly sweeps: number;
  /** Native two-node SIMD stencil evaluations. */
  readonly simdPairs: number;
  /** Scalar mirror writes on the insulated X and Z boundary halos. */
  readonly haloCopies: number;
  /** SIMD stencil evaluations by partition, in worker order with the caller first. */
  readonly threadSimdPairs: readonly number[];
}

/** Local forward electric fields required for seeded breakdown, in V/m. */
export interface LightningBreakdown {
  /** Threshold along the first bond, relative to the prescribed cloud potential. */
  readonly initiation: number;
  /** Threshold along each later bond after the electric field has relaxed. */
  readonly propagation: number;
}

/** Current state of the single seeded discharge. */
export type LightningStatus = 'pending' | 'growing' | 'halted' | 'grounded';

/** One physical channel frame, borrowing the currently accepted layout-1 records. */
export interface LightningBoltFrame {
  /** World arena holding the accepted channel. */
  readonly memory: WebAssembly.Memory;
  /** Descriptor of the channel. Read the view only for the current draw. */
  readonly channel: Readonly<Pick<Region, 'byteOffset' | 'byteLength' | 'type' | 'layout'>>;
  /** Translation from the solver cell to the rendering cell, in metres. */
  readonly offset: Vec3;
  /** Relative hot core radiance at the requested time. */
  readonly core: number;
  /** Relative glow radiance at the requested time. */
  readonly glow: number;
}

/** Grid and timing for a single natural cloud-to-ground flash. */
export interface LightningParams {
  /** Number of cubic nodes along x, y and z. Defaults to [13, 19, 13]. */
  size?: readonly [number, number, number];
  /** Node separation in metres. Default 80. */
  spacing?: number;
  /** Bottom corner in the solver's cell, metres. Default [0, 0, 0]. */
  origin?: Vec3;
  /** Ground elevations from a TerrainBed when present. Default the bottom plane. */
  bed?: Bed;
  /** World origin cell size, metres, for a bed in a different cell. Default 4096. */
  cellSize?: number;
  /** Initial reference cell for the bed and world frame. Default [0, 0, 0]. */
  cell?: Cell;
  /** Upper-plane voltage relative to the ground. Default -100 MV. */
  cloudPotential?: number;
  /** Optional spatial free charge, C/m³. Default zero. The function is sampled during initialization. */
  charge?: (x: number, y: number, z: number) => number;
  /** Seed location [x,z] in grid indices. Default centred on the cloud base. */
  startColumn?: readonly [number, number];
  /** Leader starts at this world time in seconds. Default 0. */
  start?: number;
  /** Effective leader advance speed, m/s. Default 200,000. */
  leaderSpeed?: number;
  /** Return-stroke speed along the channel, m/s. Default 100,000,000. */
  returnSpeed?: number;
  /** Field power in the growth probability. Defaults to 1 with breakdown and 2 otherwise. */
  exponent?: number;
  /** Optional separate initiation and propagation thresholds. Defaults to unthresholded seeded growth. */
  breakdown?: LightningBreakdown;
  /** Relative potential correction at which relaxation stops. Default 1e-6. */
  tolerance?: number;
  /** Maximum relaxation sweeps; default scales with the square of the longest grid axis. */
  sweeps?: number;
}

/** A packed world channel usable by Sky's lightning renderer. */
export interface SolvedLightningChannel {
  readonly segments: Float32Array;
  readonly count: number;
  readonly trunk: number;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly length: number;
}

/** A returning discharge segment's relative thunder source. */
export interface LightningSoundSource {
  readonly position: Vec3;
  readonly emissionTime: number;
  readonly weight: number;
  readonly length: number;
}

/** The first connection to the grounded surface. Time is in world seconds. */
export interface LightningFlash {
  readonly position: Vec3;
  readonly time: number;
}

type Native = {
  __stack_pointer: WebAssembly.Global;
  relax_potential(
    p: number,
    tmp: number,
    forcing: number,
    mask: number,
    nx: number,
    ny: number,
    nz: number,
    eps: number,
    sweeps: number,
    receipt: number,
  ): number;
  relax_prepare(p: number, nx: number, ny: number, nz: number): void;
  lightning_thread_phase(job: number, stage: number, part: number, parts: number): number;
};

const SIZE_DEFAULT = [13, 19, 13] as const;
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new MargoError('state', `Lightning ${label} must be finite. Use a finite SI value.`);
  return value;
}

function positive(value: unknown, label: string): number {
  const checked = finite(value, label);
  if (!(checked > 0)) throw new MargoError('state', `Lightning ${label} must be positive. Use a value above zero.`);
  return checked;
}

function extent(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 3)
    throw new MargoError('state', `Lightning ${label} needs at least three nodes. Use a whole count above two.`);
  return value;
}

function speed(value: number, label: string): number {
  const checked = positive(value, label);
  if (checked > LIGHT_SPEED)
    throw new MargoError('state', `Lightning ${label} exceeds light speed. Use at most ${LIGHT_SPEED} m/s.`);
  return checked;
}

function checkedCell(value: Cell, label: string): Cell {
  if (
    value?.length !== 3 ||
    !Number.isSafeInteger(value[0]) ||
    !Number.isSafeInteger(value[1]) ||
    !Number.isSafeInteger(value[2])
  )
    throw new MargoError('state', `Invalid lightning ${label}. Use three safe integer origin cells.`);
  return [value[0], value[1], value[2]];
}

function packedSpacing(origin: number, spacing: number, count: number): void {
  let previous = -Infinity;
  for (let i = 0; i < count; i++) {
    const coordinate = Math.fround(origin + i * spacing);
    if (!Number.isFinite(coordinate) || coordinate <= previous)
      throw new MargoError(
        'state',
        'Lightning nodes cannot be distinguished in the channel. Use a closer origin cell or wider node spacing.',
      );
    previous = coordinate;
  }
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const fs = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ fs);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new MargoError('failed', 'Lightning kernel could not load. Serve its optional Wasm assets.');
  return WebAssembly.compile(await response.arrayBuffer());
}

/** Finite-difference electric field, dielectric-breakdown leader growth and a timed return stroke. */
export class LightningSolver implements Solver<LightningParams> {
  readonly channelField: FieldDescriptor;
  readonly thunderField: FieldDescriptor;
  private host!: SolverHost;
  private native!: Native;
  private initialized = false;
  private disposed = false;
  private threads?: NativePhasePool;
  private threadWork?: { readonly job: Region; readonly residuals: Region };
  private solveReceipt!: Region;
  private trialSweeps = 0;
  private acceptedSweeps = 0;
  private cell: Cell = ZERO;
  private origin: Vec3 = ZERO;
  private size: Vec3 = SIZE_DEFAULT;
  private pitch = 0;
  private slab = 0;
  private volume = 0;
  private spacing = 80;
  private originCellSize = 4096;
  private voltage = -1e8;
  private start = 0;
  private leaderStep = 0;
  private returnSpeed = 1e8;
  private exponent = 2;
  private thresholds?: readonly [number, number];
  private eps = 1e-6;
  private sweeps = 0;
  private potential!: Region;
  private candidate!: Region;
  private scratch!: Region;
  private forcing!: Region;
  private mask!: Region;
  private parent!: Region;
  private grown!: Region;
  private ground!: Region;
  private header!: Region;
  private segments!: Region;
  private sound!: Region;
  private readonly rngId: number;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    readonly id: string,
  ) {
    this.rngId = solverNumber(id);
    this.channelField = {
      name: `${id}:channel`,
      kind: 'particleSet',
      quantity: 'strike segment endpoints and branch order',
      unit: 'm, 1',
      centring: 'particle',
    };
    this.thunderField = {
      name: `${id}:thunder`,
      kind: 'particleSet',
      quantity: 'source position, emission time, weight and segment length',
      unit: 'm, s, 1',
      centring: 'particle',
    };
  }

  /** Loads the optional native Poisson solver. */
  static async load(options: LightningLoadOptions = {}): Promise<LightningSolver> {
    if (!options || typeof options !== 'object')
      throw new MargoError('state', 'Load lightning with an options object.');
    const { signal, threads = 1 } = options;
    if (!Number.isInteger(threads) || threads < 1 || threads > MAX_THREADS)
      throw new MargoError('state', `Choose a whole number of lightning threads from 1 to ${MAX_THREADS}.`);
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './lightning-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './lightning-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    const solver = new LightningSolver(plain, shared, options.id ?? 'lightning');
    if (threads > 1) {
      if (!shared)
        throw new MargoError(
          'unsupported',
          'Use a shared-memory runtime for lightning threads or load with threads: 1.',
        );
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.threads = await createNativePhasePool(threads, {
        subject: 'Lightning',
        phaseExport: 'lightning_thread_phase',
        phase: 'relaxation',
        signal,
      });
    }
    return solver;
  }

  /** Stop optional workers. Remove the solver from its world before disposal. */
  [Symbol.dispose](): void {
    this.disposed = true;
    this.threads?.close();
  }

  describe() {
    return {
      id: this.id,
      rate: 0 as const,
      stableRate: () => 0 as const,
      fields: [
        { field: this.channelField, access: 'write' as const },
        { field: this.thunderField, access: 'write' as const },
      ],
    };
  }

  init(host: SolverHost, params: LightningParams = {}): void {
    if (this.disposed) throw new MargoError('state', 'This lightning solver was disposed. Load a new solver.');
    if (this.threads && !isShared(host.memory))
      throw new MargoError('unsupported', 'Give lightning threads a shared-memory world or load with threads: 1.');
    if (this.initialized)
      throw new MargoError('state', 'Lightning solver already belongs to a world. Load another solver.');
    if (!params || typeof params !== 'object')
      throw new MargoError('state', 'Invalid lightning configuration. Use an options object.');
    this.host = host;
    const size = params.size ?? SIZE_DEFAULT;
    if (size.length !== 3)
      throw new MargoError('state', 'Lightning requires a three-dimensional grid. Use three whole node counts.');
    const nx = extent(size[0], 'x extent');
    const ny = extent(size[1], 'y extent');
    const nz = extent(size[2], 'z extent');
    this.size = [nx, ny, nz];
    this.pitch = nx + 2;
    this.slab = this.pitch * (ny + 2);
    this.volume = this.slab * (nz + 2);
    const count = nx * ny * nz;
    // Four scalar grids, a boundary byte and parent index per padded node.
    // Each output field has two registry mirrors beyond its owned buffer.
    const gridBytes = (4 * 8 + 1 + 4) * this.volume + 8 * nx * nz;
    const channelBytes = (4 + 3 * (STRIDE * 4 + SOUND_WORDS * 8)) * count;
    const workerBytes = this.threads ? (this.threads.count - 1) * (STACK_BYTES + 32) + 48 : 0;
    if (gridBytes + channelBytes + workerBytes + STACK_BYTES + DYNAMIC_BASE + 128 >= MAX_MEMORY_PAGES * 65536)
      throw new MargoError('state', 'Lightning grid exceeds wasm32 memory. Use smaller grid extents.');
    this.spacing = positive(params.spacing ?? 80, 'node spacing');
    const origin = params.origin ?? ZERO;
    if (origin.length !== 3)
      throw new MargoError('state', 'Invalid lightning origin. Use three finite local coordinates.');
    this.origin = [finite(origin[0], 'origin x'), finite(origin[1], 'origin y'), finite(origin[2], 'origin z')];
    for (let axis = 0; axis < 3; axis++) packedSpacing(this.origin[axis]!, this.spacing, this.size[axis]!);
    this.cell = checkedCell(params.cell ?? ZERO, 'origin cell');
    this.voltage = finite(params.cloudPotential ?? -1e8, 'cloud potential');
    if (this.voltage === 0)
      throw new MargoError('state', 'Lightning cloud potential equals ground. Use a nonzero atmospheric voltage.');
    this.start = finite(params.start ?? 0, 'start time');
    this.leaderStep = this.spacing / speed(params.leaderSpeed ?? 2e5, 'leader speed');
    this.returnSpeed = speed(params.returnSpeed ?? 1e8, 'return speed');
    const lastEvent = this.start + (count - 1) * this.leaderStep;
    const oneReturnStep = this.spacing / this.returnSpeed;
    if (
      !(this.start + this.leaderStep > this.start) ||
      !Number.isFinite(lastEvent) ||
      !(lastEvent > this.start + (count - 2) * this.leaderStep) ||
      !(oneReturnStep > 0 && Number.isFinite(oneReturnStep))
    )
      throw new MargoError(
        'state',
        'Lightning timing exceeds numeric resolution. Use a nearer start time, a wider spacing or compatible propagation speeds.',
      );
    this.originCellSize = positive(params.cellSize ?? 4096, 'origin cell size');
    const breakdown = params.breakdown;
    this.thresholds = undefined;
    if (breakdown !== undefined) {
      if (!breakdown || typeof breakdown !== 'object')
        throw new MargoError('state', 'Give lightning breakdown initiation and propagation fields in V/m.');
      const fieldScale = positive(Math.abs(this.voltage) / this.spacing, 'normalized electric field scale');
      this.thresholds = [
        positive(
          positive(breakdown.initiation, 'initiation threshold') / fieldScale,
          'normalized initiation threshold',
        ),
        positive(
          positive(breakdown.propagation, 'propagation threshold') / fieldScale,
          'normalized propagation threshold',
        ),
      ];
    }
    this.exponent = positive(params.exponent ?? (breakdown ? 1 : 2), 'field exponent');
    this.eps = positive(params.tolerance ?? 1e-6, 'relaxation tolerance');
    if (this.eps >= 1)
      throw new MargoError(
        'state',
        'Lightning tolerance must be below the unit potential difference. Use a smaller fraction.',
      );
    const reciprocal = 1 / this.eps;
    this.sweeps =
      params.sweeps ?? Math.ceil(2 * ny * ny * (Number.isFinite(reciprocal) ? ln(reciprocal) : -ln(this.eps)));
    if (!Number.isInteger(this.sweeps) || this.sweeps < 1 || this.sweeps > 0xffff_ffff)
      throw new MargoError(
        'state',
        'Invalid lightning relaxation sweeps. Use a positive whole count that fits wasm32.',
      );
    const start = params.startColumn ?? [Math.floor(nx / 2), Math.floor(nz / 2)];
    const x = start[0];
    const z = start[1];
    if (start.length !== 2 || !Number.isInteger(x) || !Number.isInteger(z) || x < 0 || x >= nx || z < 0 || z >= nz)
      throw new MargoError('state', 'Lightning seed is off the cloud plane. Use a column in the grid.');
    if (params.charge !== undefined && typeof params.charge !== 'function')
      throw new MargoError('state', 'Invalid lightning charge field. Use a function returning finite C/m³.');
    if (params.bed !== undefined && typeof params.bed?.sample !== 'function')
      throw new MargoError('state', 'Invalid lightning bed. Use a TerrainBed or a finite bed sampler.');
    const module =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]'
        ? this.shared
        : this.plain;
    if (!module)
      throw new MargoError('failed', 'Shared lightning kernel is unavailable. Create the world with plain memory.');
    const stack = host.allocate('lightning-stack', STACK_BYTES, 'u8', LIGHTNING_LAYOUT);
    this.native = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as Native;
    if (
      !(this.native.__stack_pointer instanceof WebAssembly.Global) ||
      typeof this.native.relax_potential !== 'function'
    )
      throw new MargoError('failed', 'Unexpected lightning kernel ABI. Rebuild both native assets.');
    this.native.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    const reserve = (name: string, words: number) => host.allocate(name, words * 8, 'f64', LIGHTNING_LAYOUT);
    this.potential = reserve('potential', this.volume);
    this.candidate = reserve('candidate-potential', this.volume);
    this.scratch = reserve('relaxation-scratch', this.volume);
    this.forcing = reserve('charge', this.volume);
    this.mask = host.allocate('electrical-boundary', this.volume, 'u8', LIGHTNING_LAYOUT);
    this.parent = host.allocate('leader-parent', this.volume * 4, 'i32', LIGHTNING_LAYOUT);
    this.grown = host.allocate('leader-order', count * 4, 'i32', LIGHTNING_LAYOUT);
    this.ground = reserve('ground-elevations', nx * nz);
    // Header: grown nodes, grounded tip index, flash time, potential correction and trunk length.
    this.header = reserve('flash-state', 5);
    this.segments = host.allocate('lightning-channel', count * STRIDE * 4, 'f32', LIGHTNING_LAYOUT);
    this.sound = reserve('lightning-thunder', count * SOUND_WORDS);
    this.solveReceipt = host.allocate('lightning-sweep-receipt', 4, 'u32', LIGHTNING_LAYOUT);
    if (this.threads) this.bindWorkers(this.threads);
    this.trialSweeps = 0;
    this.initializeGrid(params);
    const seed = this.index(x, ny - 1, z);
    this.i32(this.parent).fill(OPEN);
    this.i32(this.parent)[seed] = SEED;
    this.u8(this.mask)[seed] = LEADER;
    this.i32(this.grown)[0] = seed;
    const header = this.f64(this.header);
    header[0] = 1;
    header[1] = OPEN;
    this.f64(this.candidate).set(this.f64(this.potential));
    this.acceptPotential(this.solvePotential());
    this.initialized = true;
  }

  private index(x: number, y: number, z: number): number {
    return (z + 1) * this.slab + (y + 1) * this.pitch + x + 1;
  }

  private grid(index: number): [number, number, number] {
    const z = Math.floor(index / this.slab),
      rem = index - z * this.slab,
      y = Math.floor(rem / this.pitch);
    return [rem - y * this.pitch - 1, y - 1, z - 1];
  }

  private point(index: number, ground = false): Vec3 {
    const [x, y, z] = this.grid(index),
      scale = this.spacing;
    return [
      this.origin[0] + scale * x,
      ground ? this.f64(this.ground)[z * this.size[0] + x]! : this.origin[1] + scale * y,
      this.origin[2] + scale * z,
    ];
  }

  private initializeGrid(params: LightningParams): void {
    const [nx, ny, nz] = this.size,
      d = this.spacing,
      [ox, oy, oz] = this.origin;
    const bed = params.bed;
    const bedCell = bed ? checkedCell(bed.cell, 'bed cell') : this.cell;
    const offset = (axis: number) => {
      const delta = this.cell[axis]! - bedCell[axis]!;
      if (!Number.isSafeInteger(delta))
        throw new MargoError('state', 'Lightning bed offset exceeds safe cells. Use neighbouring origin cells.');
      return finite(delta * this.originCellSize, 'bed cell offset');
    };
    const bx = offset(0);
    const by = offset(1);
    const bz = offset(2);
    const ground = this.f64(this.ground),
      p = this.f64(this.potential),
      f = this.f64(this.forcing),
      mask = this.u8(this.mask);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const px = ox + x * d,
          pz = oz + z * d,
          top = oy + (ny - 1) * d;
        const elevation = bed
          ? finite(
              bed.sample(finite(px + bx, 'bed sample x'), finite(pz + bz, 'bed sample z'))?.elevation,
              'bed elevation',
            )
          : oy;
        const floor = Math.max(oy, finite(elevation - by, 'local bed elevation'));
        if (!(floor < top))
          throw new MargoError(
            'state',
            'Lightning cloud plane reaches the bed. Raise the cloud plane above the terrain.',
          );
        ground[z * nx + x] = floor;
        for (let y = 0; y < ny; y++) {
          const node = this.index(x, y, z),
            py = oy + y * d;
          if (py <= floor) {
            mask[node] = GROUND;
            p[node] = 0;
          } else if (y === ny - 1) {
            mask[node] = CLOUD;
            p[node] = 1;
          } else {
            p[node] = (py - floor) / (top - floor);
            const charge = params.charge ? finite(params.charge(px, py, pz), 'space charge') : 0;
            const normalized = (charge * d * d) / (ELECTRIC_PERMITTIVITY * this.voltage);
            if (charge === 0 && !Number.isFinite(normalized)) {
              f[node] = 0;
            } else {
              if (!Number.isFinite(normalized) || (normalized === 0 && charge !== 0))
                throw new MargoError(
                  'state',
                  'Lightning space charge exceeds numeric resolution. Use compatible charge, grid spacing and cloud voltage.',
                );
              f[node] = normalized;
            }
          }
        }
      }
  }

  private f64(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }
  private i32(region: Region): Int32Array {
    return regionWords(this.host.memory, region) as Int32Array;
  }
  private u8(region: Region): Uint8Array {
    return regionWords(this.host.memory, region) as Uint8Array;
  }

  private bindWorkers(threads: NativePhasePool): void {
    const host = this.host;
    const job = host.allocate('lightning-thread-job', THREAD_JOB_WORDS * 4, 'u32', LIGHTNING_LAYOUT);
    const residuals = host.allocate('lightning-thread-residuals', threads.count * 8, 'f64', LIGHTNING_LAYOUT);
    const control = host.allocate('lightning-thread-control', threads.controlWords * 4, 'i32', LIGHTNING_LAYOUT);
    const stackTops = Array.from({ length: threads.count - 1 }, (_, i) => {
      const stack = host.allocate(`lightning-worker-stack-${i + 1}`, STACK_BYTES, 'u8', LIGHTNING_LAYOUT);
      return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    });
    threads.init({
      module: this.shared!,
      memory: host.memory,
      control: control.byteOffset,
      job: job.byteOffset,
      stackTops,
    });
    this.threadWork = { job, residuals };
  }

  private solveThreaded(
    threads: NativePhasePool,
    job: Region,
    residuals: Region,
  ): { residual: number; sweeps: number } {
    const [nx, ny, nz] = this.size;
    const at = job.byteOffset;
    const addresses = regionWords(this.host.memory, job) as Uint32Array;
    addresses.set([0, 0, this.forcing.byteOffset, this.mask.byteOffset, nx, ny, nz, residuals.byteOffset]);
    const partition = () => this.native.lightning_thread_phase(at, 0, 0, threads.count);
    const parts = this.f64(residuals);
    let source = this.candidate;
    let target = this.scratch;
    let residual = 0;
    let sweeps = 0;
    while (sweeps < this.sweeps) {
      addresses[0] = source.byteOffset;
      addresses[1] = target.byteOffset;
      this.native.relax_prepare(source.byteOffset, nx, ny, nz);
      const status = threads.phase(0, partition);
      if (status !== 0) return { residual: Infinity, sweeps };
      residual = 0;
      for (const correction of parts) residual = Math.max(residual, correction);
      const previous = source;
      source = target;
      target = previous;
      sweeps++;
      if (residual <= this.eps) break;
    }
    if (source !== this.candidate) this.f64(this.candidate).set(this.f64(source));
    return { residual, sweeps };
  }

  private solvePotential(): number {
    const [nx, ny, nz] = this.size;
    this.f64(this.scratch).fill(0);
    const receipt = regionWords(this.host.memory, this.solveReceipt) as Uint32Array;
    const work = this.threadWork;
    let residual: number;
    let completed: number;
    if (work) {
      const result = this.solveThreaded(this.threads!, work.job, work.residuals);
      residual = result.residual;
      completed = result.sweeps;
    } else {
      residual = this.native.relax_potential(
        this.candidate.byteOffset,
        this.scratch.byteOffset,
        this.forcing.byteOffset,
        this.mask.byteOffset,
        nx,
        ny,
        nz,
        this.eps,
        this.sweeps,
        this.solveReceipt.byteOffset,
      );
      completed = receipt[0]!;
    }
    if (!(Number.isFinite(residual) && residual >= 0))
      throw new MargoError(
        'failed',
        'Lightning potential solve exceeded numeric range. Use smaller charge, voltage or grid spacing.',
      );
    const potential = this.f64(this.candidate);
    const mask = this.u8(this.mask);
    for (let i = 0; i < potential.length; i++) {
      const value = potential[i]!;
      const rail = mask[i]!;
      if (!Number.isFinite(this.voltage * value) || (rail !== 0 && value !== (rail === GROUND ? 0 : 1)))
        throw new MargoError(
          'failed',
          'Lightning potential or boundary rail is invalid. Use compatible charge, voltage and grounded geometry.',
        );
    }
    const total = this.trialSweeps + completed;
    if (!Number.isSafeInteger(total * Math.max(Math.ceil(nx / 2) * ny * nz, 2 * ny * (nx + nz))))
      throw new MargoError('failed', 'Lightning work exceeds numeric range. Use fewer sweeps or a smaller grid.');
    this.trialSweeps = total;
    return residual;
  }

  private acceptPotential(residual: number): void {
    this.acceptedSweeps = this.trialSweeps;
    this.f64(this.potential).set(this.f64(this.candidate));
    this.f64(this.header)[3] = residual;
  }

  private choose(random: RandomStream, count: number): [number, number] {
    const p = this.f64(this.candidate),
      mask = this.u8(this.mask),
      ordered = this.i32(this.grown);
    const [nx, ny, nz] = this.size;
    const offsets = [-1, 1, -this.pitch, this.pitch, -this.slab, this.slab];
    const threshold = this.thresholds?.[count === 1 ? 0 : 1] ?? 0;
    // Weighted reservoir sampling over bonds avoids a second scan or a candidate collection.
    let total = 0,
      scale = 0,
      chosen = OPEN,
      root = OPEN;
    for (let i = 0; i < count; i++) {
      const from = ordered[i]!,
        [x, y, z] = this.grid(from);
      const enabled = [x > 0, x + 1 < nx, y > 0, y + 1 < ny, z > 0, z + 1 < nz];
      for (let dir = 0; dir < 6; dir++) {
        if (!enabled[dir]) continue;
        const to = from + offsets[dir]!,
          boundary = mask[to]!;
        if (boundary === CLOUD || boundary === LEADER) continue;
        const delta = 1 - p[to]! - threshold;
        if (delta <= 0) continue;
        if (delta > scale) {
          total *= pow(scale / delta, this.exponent);
          scale = delta;
        }
        const weight = pow(delta / scale, this.exponent);
        total += weight;
        if (!Number.isFinite(total))
          throw new MargoError(
            'failed',
            'Lightning bond weights exceeded numeric range. Use a smaller field exponent.',
          );
        const randomValue = random.block(count, i, dir)[0]!;
        if (((randomValue + 0.5) / 4294967296) * total < weight) {
          chosen = to;
          root = from;
        }
      }
    }
    return [chosen, root];
  }

  private add(to: number, from: number, count: number, isGround: boolean): void {
    const start = this.point(from);
    const end = this.point(to, isGround);
    if (start.every((position, axis) => Math.fround(position) === Math.fround(end[axis]!)))
      throw new MargoError(
        'state',
        'Lightning attachment is too short to pack. Move the terrain away from the node or use a closer origin.',
      );
    const duration = hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) / LIGHT_SPEED;
    if (duration > this.leaderStep * (1 + 8 * Number.EPSILON))
      throw new MargoError(
        'state',
        'Lightning attachment would cross faster than light. Use a slower leader or resolve the terrain with the grid.',
      );
    this.i32(this.parent)[to] = from;
    this.i32(this.grown)[count] = to;
    const at = count * STRIDE;
    const words = regionWords(this.host.memory, this.segments) as Float32Array;
    words[0] = count;
    words.set([start[0], start[1], start[2], 1, end[0], end[1], end[2], 0], at);
    this.f64(this.header)[0] = count + 1;
    if (!isGround) {
      this.u8(this.mask)[to] = LEADER;
      this.f64(this.candidate)[to] = 1;
    }
  }

  private strike(tgt: number, seconds: number): void {
    const header = this.f64(this.header);
    const parent = this.i32(this.parent);
    const order = this.i32(this.grown);
    const count = header[0]!;
    // The stroke reorders existing segments. Stage its whole receipt before
    // modifying any of the published rows.
    const segments = new Float32Array(count * STRIDE);
    const sonics = new Float64Array(count * SOUND_WORDS);
    const path = new Set<number>();
    for (let point = tgt; point >= 0; point = parent[point]!) path.add(point);
    // Mark the return stroke and record the path distance from strike point to every other node.
    const distance = new Map<number, number>([[tgt, 0]]);
    let trunkLength = 0;
    for (let point = tgt; parent[point]! >= 0; point = parent[point]!) {
      const root = parent[point]!;
      const a = this.point(point, point === tgt);
      const b = this.point(root);
      trunkLength += hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      distance.set(root, trunkLength);
    }
    let trunk = 0;
    for (let i = 1; i < count; i++) {
      if (path.has(order[i]!)) trunk++;
    }
    segments[0] = count - 1;
    segments[1] = trunk;
    sonics[0] = count - 1;
    let nextTrunk = 0;
    let nextBranch = trunk;
    for (let i = 1; i < count; i++) {
      const to = order[i]!;
      const from = parent[to]!;
      const a = this.point(from);
      const b = this.point(to, to === tgt);
      const length = hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const main = path.has(to);
      if (!main) distance.set(to, distance.get(from)! + length);
      const index = main ? nextTrunk++ : nextBranch++;
      segments.set([a[0], a[1], a[2], main ? 0 : 1, b[0], b[1], b[2], 0], (index + 1) * STRIDE);
      const arc = (distance.get(to)! + distance.get(from)!) * 0.5;
      const emission = seconds + arc / this.returnSpeed;
      if (!(Number.isFinite(emission) && emission > seconds))
        throw new MargoError(
          'state',
          'Lightning return-stroke delay exceeds numeric resolution. Use a nearer start time or compatible return speed and spacing.',
        );
      sonics.set(
        [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, emission, main ? 1 : 0.25, length],
        i * SOUND_WORDS,
      );
    }
    (regionWords(this.host.memory, this.segments) as Float32Array).set(segments);
    this.f64(this.sound).set(sonics);
    header[1] = tgt;
    header[2] = seconds;
    header[4] = trunkLength;
  }

  private discardGrowth(first: number): void {
    const header = this.f64(this.header);
    const parent = this.i32(this.parent);
    const order = this.i32(this.grown);
    const mask = this.u8(this.mask);
    const count = header[0]!;
    for (let i = first; i < count; i++) {
      const node = order[i]!;
      if (mask[node] === LEADER) mask[node] = 0;
      parent[node] = OPEN;
      order[i] = 0;
    }
    const segments = regionWords(this.host.memory, this.segments) as Float32Array;
    segments.fill(0, first * STRIDE, count * STRIDE);
    segments[0] = first - 1;
    header[0] = first;
  }

  step(context: StepContext, dt: number): void {
    this.requireInitialized();
    const cell = checkedCell(context.cell, 'step cell');
    const elapsed = finite((context.tick + 1) * positive(dt, 'step duration') - this.start, 'elapsed leader time');
    const header = this.f64(this.header);
    const first = header[0]!;
    if (header[1] !== OPEN || elapsed / this.leaderStep < first) {
      this.cell = cell;
      return;
    }
    const capacity = this.i32(this.grown).length;
    const limit = Math.min(capacity - 1, Math.floor(elapsed / this.leaderStep));
    if (first >= capacity)
      throw new MargoError(
        'failed',
        'Lightning exhausted the channel grid before grounding. Use a grid that reaches the grounded surface.',
      );
    const random = new RandomStream(context.seed, this.rngId);
    this.f64(this.candidate).set(this.f64(this.potential));
    this.trialSweeps = 0;
    let residual = header[3]!;
    try {
      for (let n = first; n <= limit; n++) {
        const [to, root] = this.choose(random, n);
        if (to === OPEN) {
          if (!this.thresholds)
            throw new MargoError(
              'failed',
              'Lightning leader has no downhill electric bond. Use another start column or adjust charge and grounded geometry.',
            );
          header[1] = HALTED;
          break;
        }
        const isGround = this.u8(this.mask)[to] === GROUND;
        this.add(to, root, n, isGround);
        if (isGround) {
          this.strike(to, this.start + n * this.leaderStep);
          break;
        }
        residual = this.solvePotential();
      }
    } catch (cause) {
      this.discardGrowth(first);
      throw cause;
    }
    this.acceptPotential(residual);
    this.cell = cell;
  }

  exportPorts(tick: number): readonly Port[] {
    return [
      { field: this.channelField.name, region: this.segments, tick, cell: this.cell },
      { field: this.thunderField.name, region: this.sound, tick, cell: this.cell },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [
      this.potential,
      this.forcing,
      this.mask,
      this.parent,
      this.grown,
      this.ground,
      this.header,
      this.segments,
      this.sound,
    ];
  }

  extraState(): readonly Region[] {
    return [];
  }

  private requireInitialized(): void {
    if (this.disposed) throw new MargoError('state', 'This lightning solver was disposed. Load a new solver.');
    if (!this.initialized)
      throw new MargoError('state', 'Lightning solver is not initialized. Add it to a PhysicsWorld.');
  }

  /** Electric potential in volts at a node. */
  potentialAt(x: number, y: number, z: number): number {
    this.requireInitialized();
    if (![x, y, z].every((v, k) => Number.isInteger(v) && v >= 0 && v < this.size[k]!))
      throw new MargoError('state', 'Lightning potential node is outside the grid. Use valid x, y and z indices.');
    return this.voltage * this.f64(this.potential)[this.index(x, y, z)]!;
  }

  /** Counts the last accepted electrical update. Execution receipts are kept outside snapshots. */
  workCounts(): LightningWorkCounts {
    this.requireInitialized();
    const [nx, ny, nz] = this.size;
    const threads = this.threads?.count ?? 1;
    const sweeps = this.acceptedSweeps;
    const rows = ny * nz;
    const pairsPerRow = Math.ceil(nx / 2);
    return {
      threads,
      sweeps,
      simdPairs: sweeps * rows * pairsPerRow,
      haloCopies: sweeps * 2 * ny * (nx + nz),
      threadSimdPairs: Array.from({ length: threads }, (_, part) => {
        const span = Math.floor(((part + 1) * rows) / threads) - Math.floor((part * rows) / threads);
        return sweeps * span * pairsPerRow;
      }),
    };
  }

  /** Maximum normalized potential correction in the last native sweep. */
  get residual(): number {
    this.requireInitialized();
    return this.f64(this.header)[3]!;
  }

  /** Lifecycle of the accepted channel in the current world state. */
  get status(): LightningStatus {
    this.requireInitialized();
    const header = this.f64(this.header);
    const contact = header[1]!;
    if (contact >= 0) return 'grounded';
    if (contact === HALTED) return 'halted';
    return header[0]! > 1 ? 'growing' : 'pending';
  }

  get flash(): LightningFlash | undefined {
    this.requireInitialized();
    const record = this.f64(this.header);
    return record[1]! >= 0 ? { position: this.point(record[1]!, true), time: record[2]! } : undefined;
  }

  /** Copies the present channel. Main return path has branch order 0 after grounding. */
  channel(): SolvedLightningChannel {
    this.requireInitialized();
    const header = this.f64(this.header),
      count = header[0]! - 1;
    const packed = regionWords(this.host.memory, this.segments) as Float32Array;
    const trunk = packed[1]!;
    const start = this.point(this.i32(this.grown)[0]!);
    const end = header[1]! >= 0 ? this.point(header[1]!, true) : start;
    return { segments: packed.slice(STRIDE, (count + 1) * STRIDE), count, trunk, start, end, length: header[4]! };
  }

  /** Timed thunder source segments in parent-to-child order. Empty until the leader grounds. */
  thunder(): LightningSoundSource[] {
    if (!this.flash) return [];
    const count = this.f64(this.header)[0]! - 1,
      words = this.f64(this.sound);
    return Array.from({ length: count }, (_, i) => {
      const at = (i + 1) * SOUND_WORDS;
      return {
        position: [words[at]!, words[at + 1]!, words[at + 2]!],
        emissionTime: words[at + 3]!,
        weight: words[at + 4]!,
        length: words[at + 5]!,
      };
    });
  }

  /**
   * Reads the accepted channel in the rendering cell, at the specified world time.
   * The leader's relative brightness is an appearance control, default 0.1.
   */
  boltSource(time: number, renderCell = this.host?.cell, leaderBrightness = 0.1): LightningBoltFrame | undefined {
    this.requireInitialized();
    const seconds = finite(time, 'render time');
    const light = finite(leaderBrightness, 'leader brightness');
    if (light < 0 || !Number.isFinite(Math.fround(light)))
      throw new MargoError('state', 'Give the lightning leader a nonnegative float32 brightness.');
    const header = this.f64(this.header);
    const links = header[0]! - 1;
    if (links === 0 || seconds < this.start + this.leaderStep) return undefined;
    const sourceCell = this.host.cell;
    const targetCell = checkedCell(renderCell, 'render cell');
    const shift = (axis: number): number => {
      const cells = sourceCell[axis]! - targetCell[axis]!;
      const metres = cells * this.originCellSize;
      if (!Number.isSafeInteger(cells) || !Number.isFinite(Math.fround(metres)))
        throw new MargoError(
          'state',
          'Lightning render translation exceeds local precision. Use a nearer origin cell.',
        );
      return metres;
    };
    const offset: Vec3 = [shift(0), shift(1), shift(2)];
    const contact = header[1]!;
    const amplitude =
      contact >= 0 && seconds >= header[2]!
        ? this.brightness(seconds)
        : contact === HALTED
          ? light * exp(-Math.max(0, seconds - (this.start + links * this.leaderStep)) / 0.05)
          : light;
    return { memory: this.host.memory, channel: this.segments, offset, core: amplitude, glow: amplitude };
  }

  /** Relative current-like light envelope after the first return stroke reaches the ground. */
  brightness(time: number, rise = 0.00001, fade = 0.05): number {
    const seconds = finite(time, 'flash time');
    const riseSeconds = positive(rise, 'return rise');
    const fadeSeconds = positive(fade, 'return fade');
    const flash = this.flash;
    if (!flash || seconds < flash.time) return 0;
    const age = finite(seconds - flash.time, 'flash age');
    return (1 - exp(-age / riseSeconds)) * exp(-age / fadeSeconds);
  }
}
