import { MargoError } from '@margoengine/math/errors';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { hypot, ln } from '@margoengine/math/pinned';
import { canShareMemory, isShared, regionWords, STACK_BYTES } from '../world/memory.js';
import {
  type Cell,
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverHost,
  type StepContext,
  rateOf,
} from '../world/solver.js';
import { momentFraction, seismicCyclicStress } from './model.js';
import { SEISMIC_LAYOUT, SEISMIC_SURFACE_WORDS as SURFACE_WORDS } from './ports.js';

export { momentFraction, seismicCyclicStress } from './model.js';
export { SEISMIC_LAYOUT } from './ports.js';
export { SeismicInertialLoad, type SeismicInertialParams } from './rigid.js';

const ZERO: Cell = [0, 0, 0];
const KERNEL_FIELDS = 11;
const VX = 0;
const VZ = 1;
const SXX = 2;
const SZZ = 3;
const SXZ = 4;
const SITE_WORDS = 6;

/** Homogeneous material assigned per cell of the elastic cross-section. */
export interface SeismicMaterial {
  /** kg/m³. */
  density: number;
  /** P-wave speed in m/s. */
  compressionalSpeed: number;
  /** S-wave speed in m/s. Zero is a fluid. */
  shearSpeed: number;
  /** Diagonal amplitude damping per second. Default 0. */
  damping?: number;
}

/** A prescribed natural-earthquake moment tensor in the x/depth plane. */
export interface SeismicSource {
  /** x and depth in metres relative to the top-left of the cross-section. */
  position: readonly [x: number, depth: number];
  /** [Mxx, Mzz, Mxz] in N m per metre out of plane. Depth is positive down. */
  moment: readonly [number, number, number];
  /** Brune timescale in seconds. */
  timescale: number;
  /** Start on the world clock, in seconds. Default 0. */
  start?: number;
}

/** A surface building mode and/or saturated soil site. */
export interface SeismicSite {
  /** Horizontal location in metres from the cross-section's left side. */
  x: number;
  /** Natural frequency of the building's horizontal sway in Hz. Omit for a soil-only receiver. */
  frequency?: number;
  /** Building damping ratio. Default 0.05. */
  dampingRatio?: number;
  /** Site properties for the cyclic-stress screening model. Omit for a dry site. */
  saturatedSoil?: {
    overburdenRatio: number;
    depthReduction: number;
    cyclicResistance: number;
  };
}

/** A vertical elastic cross-section with a traction-free surface. */
export interface SeismicParams {
  width: number;
  depth: number;
  /** Cell width and height in metres. Default [10, 10]. */
  spacing?: readonly [dx: number, dz: number];
  /** The top-left point in the solver's origin cell, in world x, y, z metres. Default [0, 0, 0]. */
  origin?: readonly [number, number, number];
  material: SeismicMaterial | ((x: number, depth: number) => SeismicMaterial);
  /** Quiet by default. Uses prescribed moment release, in the order supplied. */
  sources?: readonly SeismicSource[];
  /** Quiet by default. Sets x and upward velocities in m/s from cross-section x and depth. */
  initialVelocity?: (x: number, depth: number) => readonly [number, number];
  /** Number of absorbing cells at the sides and bottom. Defaults to min(12, floor(width/3), floor(depth/3)). */
  absorbingCells?: number;
  /** Target outgoing-wave amplitude after crossing the absorbing strip. Default 0.001. */
  boundaryAttenuation?: number;
  /** Building and soil receivers. Default none. */
  sites?: readonly SeismicSite[];
}

/** Current surface motion in the world frame. */
export interface SeismicMotion {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number];
  readonly acceleration: readonly [number, number];
  readonly peakHorizontalAcceleration: number;
}

/** Relative building response and screening demand at one receiver. */
export interface SeismicSiteReading {
  readonly displacement: number;
  readonly velocity: number;
  readonly relativeAcceleration: number;
  readonly absoluteAcceleration: number;
  readonly cyclicStress: number;
  readonly liquefactionPotential: boolean;
}

type Native = {
  __stack_pointer: WebAssembly.Global;
  seismic_step(ptr: number, width: number, depth: number, dx: number, dz: number, dt: number): void;
};
type Weights = readonly (readonly [index: number, weight: number])[];
type Source = {
  readonly normal: Weights;
  readonly shear: Weights;
  readonly moment: SeismicSource['moment'];
  readonly timescale: number;
  readonly start: number;
};
type Site = {
  readonly x: number;
  readonly omega: number;
  readonly damping: number;
  readonly soil: SeismicSite['saturatedSoil'];
};

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Seismic ${label} must be finite. Pass a finite SI value.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!(finite(value, label) > 0)) throw new RangeError(`Seismic ${label} must be positive. Pass a value above zero.`);
  return value;
}

function extent(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 2)
    throw new RangeError(`Seismic ${label} needs at least two complete cells. Pass a whole number.`);
  return value;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const module = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ module);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError('failed', 'Seismic kernel is unavailable. You must serve both optional Wasm assets.');
  return WebAssembly.compile(await response.arrayBuffer());
}

/** Elastodynamic P/SV waves, surface ground motion, building acceleration and liquefaction screening. */
export class SeismicGround implements Solver<SeismicParams> {
  readonly groundField: FieldDescriptor;
  /** Layout-1 f64 site records ordered as the properties of `SeismicSiteReading`. */
  readonly siteField: FieldDescriptor;
  private host!: SolverHost;
  private elastic!: Region;
  private surface!: Region;
  private responses!: Region;
  private kernel!: Native;
  private cell: Cell = ZERO;
  private width = 0;
  private depth = 0;
  private pitch = 0;
  private count = 0;
  private dx = 10;
  private dz = 10;
  private origin: Cell = ZERO;
  private level: RateLevel = 0;
  private gravity = 0;
  private sources: readonly Source[] = [];
  private sites: readonly Site[] = [];

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    readonly id: string,
  ) {
    this.groundField = {
      name: `${id}:ground`,
      kind: 'particleSet',
      quantity: 'ground motion',
      unit: 'm, m/s, m/s^2',
      centring: 'particle',
    };
    this.siteField = {
      name: `${id}:sites`,
      kind: 'particleSet',
      quantity: 'sway, acceleration and cyclic stress ratio',
      unit: 'm, m/s, m/s^2, 1',
      centring: 'particle',
    };
  }

  /** Compiles the optional SIMD kernel for both memory modes supported by the host. */
  static async load(options: { id?: string; signal?: AbortSignal } = {}): Promise<SeismicGround> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './seismic-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './seismic-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new SeismicGround(plain, shared, options.id ?? 'seismic');
  }

  describe() {
    return {
      id: this.id,
      rate: 0 as const,
      stableRate: () => this.level,
      fields: [
        { field: this.groundField, access: 'write' as const },
        { field: this.siteField, access: 'write' as const },
      ],
    };
  }

  init(host: SolverHost, params: SeismicParams): void {
    if (!params?.material)
      throw new RangeError('Seismic ground needs a material. Provide density and P/S wave speeds.');
    this.host = host;
    this.width = extent(params.width, 'width');
    this.depth = extent(params.depth, 'depth');
    this.pitch = this.width + 2;
    this.count = this.pitch * (this.depth + 2);
    this.dx = positive(params.spacing?.[0] ?? 10, 'horizontal spacing');
    this.dz = positive(params.spacing?.[1] ?? 10, 'depth spacing');
    this.origin = [
      finite(params.origin?.[0] ?? 0, 'origin x'),
      finite(params.origin?.[1] ?? 0, 'origin y'),
      finite(params.origin?.[2] ?? 0, 'origin z'),
    ];
    this.gravity = gravityMagnitude(host.gravity);
    this.sources = (params.sources ?? []).map((source) => this.source(source));
    this.sites = (params.sites ?? []).map((site) => this.site(site));
    const layers = params.absorbingCells ?? Math.min(12, Math.floor(this.width / 3), Math.floor(this.depth / 3));
    const residual = params.boundaryAttenuation ?? 0.001;
    if (!Number.isInteger(layers) || layers < 0 || layers * 2 >= this.width || layers >= this.depth)
      throw new RangeError('Seismic absorbing cells must leave an interior and a free surface. Use fewer cells.');
    if (!(residual > 0 && residual <= 1))
      throw new RangeError('Invalid seismic boundary amplitude. Pass a fraction above zero and at most 1.');
    const module =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]'
        ? this.shared
        : this.plain;
    if (!module)
      throw new MargoError('failed', 'Shared seismic kernel is unavailable. Create the world with plain memory.');
    const stack = host.allocate('seismic-stack', STACK_BYTES, 'u8', SEISMIC_LAYOUT);
    this.kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as Native;
    if (!(this.kernel.__stack_pointer instanceof WebAssembly.Global) || typeof this.kernel.seismic_step !== 'function')
      throw new MargoError('failed', 'Unexpected seismic kernel ABI. You must rebuild both optional Wasm assets.');
    this.kernel.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    this.elastic = host.allocate('seismic-wave', KERNEL_FIELDS * this.count * 8, 'f64', SEISMIC_LAYOUT);
    this.surface = host.allocate('seismic-ground-motion', this.width * SURFACE_WORDS * 8, 'f64', SEISMIC_LAYOUT);
    this.responses = host.allocate('seismic-building-soil', this.sites.length * SITE_WORDS * 8, 'f64', SEISMIC_LAYOUT);
    this.fillMaterials(params, layers, residual);
    this.publishMotion(0);
  }

  private source(source: SeismicSource): Source {
    const [x, z] = source.position;
    if (!(x >= 0 && x <= this.width * this.dx && z >= 0 && z <= this.depth * this.dz))
      throw new RangeError('Seismic source lies outside the section. You must move it into the grid.');
    return {
      normal: this.weights(x / this.dx - 0.5, z / this.dz - 0.5),
      shear: this.weights(x / this.dx - 1, z / this.dz - 1),
      moment: [finite(source.moment[0], 'Mxx'), finite(source.moment[1], 'Mzz'), finite(source.moment[2], 'Mxz')],
      timescale: positive(source.timescale, 'source timescale'),
      start: finite(source.start ?? 0, 'source start'),
    };
  }

  private weights(x: number, z: number): Weights {
    const xx = Math.max(0, Math.min(this.width - 1, x)),
      zz = Math.max(0, Math.min(this.depth - 1, z));
    const ix = Math.floor(xx),
      iz = Math.floor(zz),
      wx = xx - ix,
      wz = zz - iz;
    const at = (1 + iz) * this.pitch + ix + 1;
    const right = ix + 1 < this.width ? 1 : 0;
    const lower = iz + 1 < this.depth ? this.pitch : 0;
    return [
      [at, (1 - wx) * (1 - wz)],
      [at + right, wx * (1 - wz)],
      [at + lower, (1 - wx) * wz],
      [at + lower + right, wx * wz],
    ];
  }

  private site(site: SeismicSite): Site {
    if (!(site.x >= 0 && site.x <= this.width * this.dx))
      throw new RangeError('Seismic receiver lies outside the section. You must place it over the grid.');
    const omega = site.frequency === undefined ? 0 : 2 * Math.PI * positive(site.frequency, 'building frequency');
    const ratio = finite(site.dampingRatio ?? 0.05, 'building damping ratio');
    if (ratio < 0) throw new RangeError('Seismic building damping cannot be negative. Pass a nonnegative ratio.');
    const soil = site.saturatedSoil && { ...site.saturatedSoil };
    if (soil) {
      seismicCyclicStress(0, this.gravity, soil.overburdenRatio, soil.depthReduction);
      positive(soil.cyclicResistance, 'soil cyclic resistance');
    }
    return { x: site.x, omega, damping: 2 * ratio * omega, soil };
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private fillMaterials(params: SeismicParams, layers: number, residual: number): void {
    const words = this.words(this.elastic),
      { dx, dz, count, pitch, width, depth } = this;
    const densities = new Float64Array(count);
    let fastest = 0;
    for (let z = 0; z < depth + 2; z++) {
      for (let x = 0; x < width + 2; x++) {
        const realX = Math.min(width, Math.max(1, x)),
          realZ = Math.min(depth, Math.max(1, z));
        const cx = (realX - 0.5) * dx,
          cz = (realZ - 0.5) * dz;
        const mat = typeof params.material === 'function' ? params.material(cx, cz) : params.material;
        const p = positive(mat.compressionalSpeed, 'P-wave speed'),
          s = finite(mat.shearSpeed, 'S-wave speed');
        const density = positive(mat.density, 'density'),
          loss = finite(mat.damping ?? 0, 'material damping');
        if (s < 0 || loss < 0 || p * p <= (4 / 3) * s * s)
          throw new RangeError(
            'Seismic material needs nonnegative shear speed and damping, with positive bulk modulus. Adjust its wave speeds.',
          );
        const index = z * pitch + x;
        densities[index] = density;
        const shear = density * s * s;
        words[7 * count + index] = density * p * p - 2 * shear;
        words[8 * count + index] = shear;
        const edge =
          layers === 0 ? 0 : Math.max(0, layers - Math.min(realX - 1, width - realX, depth - realZ)) / layers;
        const damping = layers === 0 ? 0 : (-3 * p * ln(residual) * edge * edge) / (layers * Math.min(dx, dz));
        words[10 * count + index] = loss + damping;
        fastest = Math.max(fastest, p);
        if (params.initialVelocity && realX === x && realZ === z) {
          const horizontal = params.initialVelocity(x * dx, cz)[0];
          const vertical = params.initialVelocity(cx, z * dz)[1];
          words[index] = finite(horizontal, 'initial horizontal velocity');
          words[count + index] = -finite(vertical, 'initial vertical velocity');
          if (z === 1) words[count + x] = -finite(params.initialVelocity(cx, 0)[1], 'initial surface velocity');
        }
        if (z === 0) words[6 * count + index] = 1 / density;
      }
    }
    for (let z = 1; z <= depth; z++) {
      for (let x = 1; x <= width; x++) {
        const at = z * pitch + x;
        words[5 * count + at] = 2 / (densities[at]! + densities[at + 1]!);
        words[6 * count + at] = 2 / (densities[at]! + densities[at + pitch]!);
        const mu = 8 * count + at;
        const a = words[mu]!,
          b = words[mu + 1]!,
          c = words[mu + pitch]!,
          d = words[mu + pitch + 1]!;
        words[9 * count + at] = a === 0 || b === 0 || c === 0 || d === 0 ? 0 : 4 / (1 / a + 1 / b + 1 / c + 1 / d);
      }
    }
    const required = (fastest / 0.95) * hypot(1 / dx, 1 / dz);
    for (let level = 0; level <= 7; level++) {
      if (rateOf(level as RateLevel) >= required) {
        this.level = level as RateLevel;
        return;
      }
    }
    throw new RangeError(
      'Seismic Courant rate exceeds the world clock. Increase cell spacing or lower the wave speeds.',
    );
  }

  private publishMotion(dt: number): void {
    const motion = this.words(this.surface),
      field = this.words(this.elastic);
    for (let x = 0; x < this.width; x++) {
      const at = x * SURFACE_WORDS,
        cell = this.pitch + x + 1;
      const vx = 0.5 * (field[cell - 1]! + field[cell]!);
      const vy = -field[this.count + x + 1]!;
      const ax = dt > 0 ? (vx - motion[at + 3]!) / dt : 0;
      const ay = dt > 0 ? (vy - motion[at + 4]!) / dt : 0;
      motion[at] = this.origin[0] + (x + 0.5) * this.dx;
      motion[at + 1] = this.origin[1];
      motion[at + 2] = this.origin[2];
      motion[at + 3] = vx;
      motion[at + 4] = vy;
      motion[at + 5] = ax;
      motion[at + 6] = ay;
      motion[at + 7] = Math.max(motion[at + 7]!, Math.abs(ax));
    }
  }

  private respond(dt: number): void {
    const waves = this.words(this.surface),
      sites = this.words(this.responses);
    for (let i = 0; i < this.sites.length; i++) {
      const site = this.sites[i]!,
        at = SITE_WORDS * i;
      const x = Math.max(0, Math.min(this.width - 1, site.x / this.dx - 0.5));
      const left = Math.floor(x),
        blend = x - left;
      const l = left * SURFACE_WORDS + 5,
        r = Math.min(left + 1, this.width - 1) * SURFACE_WORDS + 5;
      const ground = waves[l]! + (waves[r]! - waves[l]!) * blend;
      if (site.omega > 0) {
        const acceleration = sites[at + 2]!,
          stiffness = site.omega * site.omega;
        const q = sites[at]! + dt * sites[at + 1]! + 0.25 * dt * dt * acceleration;
        const velocity = sites[at + 1]! + 0.5 * dt * acceleration;
        const a =
          (-ground - site.damping * velocity - stiffness * q) /
          (1 + 0.5 * dt * site.damping + 0.25 * dt * dt * stiffness);
        sites[at] = q + 0.25 * dt * dt * a;
        sites[at + 1] = velocity + 0.5 * dt * a;
        sites[at + 2] = a;
        sites[at + 3] = a + ground;
      } else sites[at + 3] = ground;
      if (site.soil) {
        const { overburdenRatio, depthReduction, cyclicResistance } = site.soil;
        const demand = seismicCyclicStress(Math.abs(ground), this.gravity, overburdenRatio, depthReduction);
        sites[at + 4] = Math.max(sites[at + 4]!, demand);
        sites[at + 5] = Number(sites[at + 4]! >= cyclicResistance);
      }
    }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const waves = this.words(this.elastic),
      n = this.count;
    const now = context.tick * dt;
    for (const { normal, shear, moment, timescale, start } of this.sources) {
      const time = now - start;
      const amount = (momentFraction(time + dt, timescale) - momentFraction(time, timescale)) / (this.dx * this.dz);
      for (const [at, weight] of normal) {
        waves[SXX * n + at]! -= moment[0] * weight * amount;
        waves[SZZ * n + at]! -= moment[1] * weight * amount;
      }
      for (const [at, weight] of shear) waves[SXZ * n + at]! -= moment[2] * weight * amount;
    }
    this.kernel.seismic_step(this.elastic.byteOffset, this.width, this.depth, this.dx, this.dz, dt);
    this.publishMotion(dt);
    this.respond(dt);
  }

  exportPorts(tick: number): readonly Port[] {
    return [
      { field: this.groundField.name, region: this.surface, tick, cell: this.cell },
      { field: this.siteField.name, region: this.responses, tick, cell: this.cell },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.elastic, this.surface, this.responses];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Read the nearest surface column by index. */
  motion(column: number): SeismicMotion {
    if (!Number.isInteger(column) || column < 0 || column >= this.width)
      throw new RangeError('Seismic surface column is outside the grid. Pass a configured column index.');
    const at = column * SURFACE_WORDS,
      w = this.words(this.surface);
    return {
      position: [w[at]!, w[at + 1]!, w[at + 2]!],
      velocity: [w[at + 3]!, w[at + 4]!],
      acceleration: [w[at + 5]!, w[at + 6]!],
      peakHorizontalAcceleration: w[at + 7]!,
    };
  }

  /** Velocity at its staggered grid locations: x on the right cell face, y on its lower face. */
  velocity(column: number, row: number): readonly [number, number] {
    if (
      !Number.isInteger(column) ||
      !Number.isInteger(row) ||
      column < 0 ||
      row < 0 ||
      column >= this.width ||
      row >= this.depth
    )
      throw new RangeError('Seismic cell is outside the section. Pass a configured column and row.');
    const at = (row + 1) * this.pitch + column + 1,
      w = this.words(this.elastic);
    return [w[VX * this.count + at]!, -w[VZ * this.count + at]!];
  }

  /** Read a configured building or soil receiver by index. */
  reading(index = 0): SeismicSiteReading {
    if (!Number.isInteger(index) || index < 0 || index >= this.sites.length)
      throw new RangeError('Seismic site is outside the list. Pass a configured site index.');
    const at = index * SITE_WORDS,
      w = this.words(this.responses);
    return {
      displacement: w[at]!,
      velocity: w[at + 1]!,
      relativeAcceleration: w[at + 2]!,
      absoluteAcceleration: w[at + 3]!,
      cyclicStress: w[at + 4]!,
      liquefactionPotential: w[at + 5]! !== 0,
    };
  }
}
