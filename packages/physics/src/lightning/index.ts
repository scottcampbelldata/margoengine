import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { Bed } from '@margoengine/math/fields';
import { exp, hypot, ln, pow } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { canShareMemory, isShared, MAX_MEMORY_PAGES, regionWords, STACK_BYTES } from '../world/memory.js';
import type { Cell, FieldDescriptor, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';

const GROUND = 1;
const CLOUD = 2;
const LEADER = 3;
const ELECTRIC_PERMITTIVITY = 8.8541878128e-12;
const ZERO: Cell = [0, 0, 0];
const OPEN = -1;
const SEED = -2;

/** A count row followed by channel rows [start xyz, order, end xyz, 0] or thunder rows [midpoint xyz, emission s, weight, length m]. */
export const LIGHTNING_LAYOUT = 1;
export const LIGHTNING_CHANNEL_WORDS = 8;
export const LIGHTNING_THUNDER_WORDS = 6;
const STRIDE = LIGHTNING_CHANNEL_WORDS;
const SOUND_WORDS = LIGHTNING_THUNDER_WORDS;

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
  /** Field power in the dielectric breakdown probability. Default 2. */
  exponent?: number;
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
  ): number;
};

const SIZE_DEFAULT = [13, 19, 13] as const;
function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Lightning ${label} must be finite. Pass a finite SI value.`);
  return value;
}
function positive(value: number, label: string): number {
  if (!(finite(value, label) > 0))
    throw new RangeError(`Lightning ${label} must be positive. Pass a value above zero.`);
  return value;
}
function extent(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 3)
    throw new RangeError(`Lightning ${label} needs at least three nodes. Pass a whole count above two.`);
  return value;
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
  private cell: Cell = ZERO;
  private origin: Vec3 = ZERO;
  private size: Vec3 = SIZE_DEFAULT;
  private pitch = 0;
  private slab = 0;
  private volume = 0;
  private spacing = 80;
  private voltage = -1e8;
  private start = 0;
  private leaderStep = 0;
  private returnSpeed = 1e8;
  private exponent = 2;
  private eps = 1e-6;
  private sweeps = 0;
  private potential!: Region;
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
  static async load(options: { id?: string; signal?: AbortSignal } = {}): Promise<LightningSolver> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './lightning-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './lightning-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new LightningSolver(plain, shared, options.id ?? 'lightning');
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
    this.host = host;
    const [nx, ny, nz] = params.size ?? SIZE_DEFAULT;
    this.size = [extent(nx, 'x extent'), extent(ny, 'y extent'), extent(nz, 'z extent')];
    this.pitch = nx + 2;
    this.slab = this.pitch * (ny + 2);
    this.volume = this.slab * (nz + 2);
    const count = nx * ny * nz;
    // Three scalar grids, a boundary byte and a parent index per padded node. Both output fields have two registry mirrors.
    const gridBytes = (3 * 8 + 1 + 4) * this.volume;
    const channelBytes = (4 + 3 * (STRIDE * 4 + SOUND_WORDS * 8)) * count;
    if (gridBytes + channelBytes >= MAX_MEMORY_PAGES * 65536)
      throw new RangeError('Lightning grid exceeds wasm32 memory. Pass smaller grid extents.');
    this.spacing = positive(params.spacing ?? 80, 'node spacing');
    this.origin = [
      finite(params.origin?.[0] ?? 0, 'origin x'),
      finite(params.origin?.[1] ?? 0, 'origin y'),
      finite(params.origin?.[2] ?? 0, 'origin z'),
    ];
    this.cell = params.cell ? [...params.cell] : ZERO;
    this.voltage = finite(params.cloudPotential ?? -1e8, 'cloud potential');
    if (this.voltage === 0)
      throw new RangeError('Lightning cloud potential equals ground. Supply a nonzero atmospheric voltage.');
    this.start = finite(params.start ?? 0, 'start time');
    this.leaderStep = this.spacing / positive(params.leaderSpeed ?? 2e5, 'leader speed');
    this.returnSpeed = positive(params.returnSpeed ?? 1e8, 'return speed');
    this.exponent = positive(params.exponent ?? 2, 'field exponent');
    this.eps = positive(params.tolerance ?? 1e-6, 'relaxation tolerance');
    if (this.eps >= 1)
      throw new RangeError('Lightning tolerance must be below the unit potential difference. Use a smaller fraction.');
    this.sweeps = params.sweeps ?? Math.ceil(2 * ny * ny * ln(1 / this.eps));
    if (!Number.isSafeInteger(this.sweeps) || this.sweeps < 1)
      throw new RangeError('Invalid lightning relaxation sweeps. Pass a positive whole count.');
    const [x, z] = params.startColumn ?? [Math.floor(nx / 2), Math.floor(nz / 2)];
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || x >= nx || z < 0 || z >= nz)
      throw new RangeError('Lightning seed is off the cloud plane. Choose a column in the grid.');
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
    this.initializeGrid(params);
    const seed = this.index(x, ny - 1, z);
    this.i32(this.parent).fill(OPEN);
    this.i32(this.parent)[seed] = SEED;
    this.u8(this.mask)[seed] = LEADER;
    this.i32(this.grown)[0] = seed;
    const header = this.f64(this.header);
    header[0] = 1;
    header[1] = OPEN;
    this.solvePotential();
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
    const bed = params.bed,
      cellSize = positive(params.cellSize ?? 4096, 'origin cell size');
    const bx = bed ? (this.cell[0] - bed.cell[0]) * cellSize : 0,
      by = bed ? (this.cell[1] - bed.cell[1]) * cellSize : 0;
    const bz = bed ? (this.cell[2] - bed.cell[2]) * cellSize : 0;
    const ground = this.f64(this.ground),
      p = this.f64(this.potential),
      f = this.f64(this.forcing),
      mask = this.u8(this.mask);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const px = ox + x * d,
          pz = oz + z * d,
          top = oy + (ny - 1) * d;
        const floor = Math.max(oy, (bed?.sample(px + bx, pz + bz).elevation ?? oy) - by);
        if (!(floor < top))
          throw new RangeError('Lightning grid ends below the bed. Raise the cloud plane above the terrain.');
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
            f[node] =
              (finite(params.charge?.(px, py, pz) ?? 0, 'space charge') * d * d) /
              (ELECTRIC_PERMITTIVITY * this.voltage);
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

  private solvePotential(): void {
    const [nx, ny, nz] = this.size;
    this.f64(this.scratch).fill(0);
    this.f64(this.header)[3] = this.native.relax_potential(
      this.potential.byteOffset,
      this.scratch.byteOffset,
      this.forcing.byteOffset,
      this.mask.byteOffset,
      nx,
      ny,
      nz,
      this.eps,
      this.sweeps,
    );
  }

  private choose(random: RandomStream, count: number): [number, number] {
    const p = this.f64(this.potential),
      mask = this.u8(this.mask),
      ordered = this.i32(this.grown);
    const [nx, ny, nz] = this.size;
    const offsets = [-1, 1, -this.pitch, this.pitch, -this.slab, this.slab];
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
        const delta = 1 - p[to]!;
        if (delta <= 0) continue;
        if (delta > scale) {
          total *= pow(scale / delta, this.exponent);
          scale = delta;
        }
        const weight = pow(delta / scale, this.exponent);
        total += weight;
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
    const start = this.point(from),
      end = this.point(to, isGround);
    this.i32(this.parent)[to] = from;
    this.i32(this.grown)[count] = to;
    const at = count * STRIDE;
    const words = regionWords(this.host.memory, this.segments) as Float32Array;
    words[0] = count;
    words.set([start[0], start[1], start[2], 1, end[0], end[1], end[2], 0], at);
    this.f64(this.header)[0] = count + 1;
    if (!isGround) {
      this.u8(this.mask)[to] = LEADER;
      this.f64(this.potential)[to] = 1;
    }
  }

  private strike(tgt: number, seconds: number): void {
    const header = this.f64(this.header),
      p = this.i32(this.parent),
      order = this.i32(this.grown);
    const segments = regionWords(this.host.memory, this.segments) as Float32Array,
      sonics = this.f64(this.sound);
    header[1] = tgt;
    header[2] = seconds;
    const path = new Set<number>();
    for (let point = tgt; point >= 0; point = p[point]!) path.add(point);
    // Mark the return stroke and record the path distance from strike point to every other node.
    const distance = new Map<number, number>([[tgt, 0]]);
    for (let point = tgt; p[point]! >= 0; point = p[point]!) {
      const root = p[point]!,
        a = this.point(point, point === tgt),
        b = this.point(root);
      distance.set(root, distance.get(point)! + hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      header[4] = distance.get(root)!;
    }
    // Keep the connected cloud-to-ground polyline first, then list branches in growth order.
    let trunk = 0;
    for (let i = 1; i < header[0]!; i++) {
      if (path.has(order[i]!)) trunk++;
    }
    segments[1] = trunk;
    sonics[0] = header[0]! - 1;
    let nextTrunk = 0,
      nextBranch = trunk;
    for (let i = 1; i < header[0]!; i++) {
      const to = order[i]!,
        from = p[to]!,
        a = this.point(from),
        b = this.point(to, to === tgt);
      const length = hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
        main = path.has(to);
      if (!main) distance.set(to, distance.get(from)! + length);
      const index = main ? nextTrunk++ : nextBranch++;
      segments.set([a[0], a[1], a[2], main ? 0 : 1, b[0], b[1], b[2], 0], (index + 1) * STRIDE);
      const at = i * SOUND_WORDS,
        arc = (distance.get(to)! + distance.get(from)!) * 0.5;
      sonics.set(
        [
          (a[0] + b[0]) / 2,
          (a[1] + b[1]) / 2,
          (a[2] + b[2]) / 2,
          seconds + arc / this.returnSpeed,
          main ? 1 : 0.25,
          length,
        ],
        at,
      );
    }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const elapsed = (context.tick + 1) * dt - this.start,
      header = this.f64(this.header);
    if (header[1]! >= 0 || elapsed < this.leaderStep) return;
    const random = new RandomStream(context.seed, this.rngId);
    const limit = Math.floor(elapsed / this.leaderStep),
      capacity = this.i32(this.grown).length;
    for (let n = header[0]!; n <= limit && n < capacity; n++) {
      const [to, root] = this.choose(random, n);
      if (to === OPEN) return;
      const isGround = this.u8(this.mask)[to] === GROUND;
      this.add(to, root, n, isGround);
      if (isGround) {
        this.strike(to, this.start + n * this.leaderStep);
        return;
      }
      this.solvePotential();
    }
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

  /** Electric potential in volts at a node. */
  potentialAt(x: number, y: number, z: number): number {
    if (![x, y, z].every((v, k) => Number.isInteger(v) && v >= 0 && v < this.size[k]!))
      throw new RangeError('Lightning potential node is outside the grid. Pass valid x, y and z indices.');
    return this.voltage * this.f64(this.potential)[this.index(x, y, z)]!;
  }

  /** Maximum normalized potential correction in the last native sweep. */
  get residual(): number {
    return this.f64(this.header)[3]!;
  }

  get flash(): LightningFlash | undefined {
    const record = this.f64(this.header);
    return record[1]! >= 0 ? { position: this.point(record[1]!, true), time: record[2]! } : undefined;
  }

  /** Copies the present channel. Main return path has branch order 0 after grounding. */
  channel(): SolvedLightningChannel {
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

  /** Relative current-like light envelope after the first return stroke reaches the ground. */
  brightness(time: number, rise = 0.00001, fade = 0.05): number {
    const flash = this.flash;
    if (!flash || time < flash.time) return 0;
    const age = finite(time, 'flash time') - flash.time;
    return (1 - exp(-age / positive(rise, 'return rise'))) * exp(-age / positive(fade, 'return fade'));
  }
}
