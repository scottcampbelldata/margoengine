import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { Bed, BedSample } from '@margoengine/math/fields';
import { hypot, sin } from '@margoengine/math/pinned';
import { BED_CHANGE_FIELD } from '../earth/bed.js';
import { SWIM_WAKE_FIELD } from '../life/wake.js';
import { canShareMemory, MAX_MEMORY_PAGES, regionWords, STACK_BYTES } from '../world/memory.js';
import { isRateLevel, rateOf } from '../world/solver.js';
import type {
  Cell,
  FieldDescriptor,
  FieldUse,
  Port,
  RateLevel,
  Region,
  Solver,
  SolverHost,
  StepContext,
} from '../world/solver.js';

import { GranularLayer, type LayerRaster } from './layer.js';
import { GranularWake, type WakeKernel } from './wake.js';

const GRID_WORDS = 6;
const MODEL_WORDS = 11;
const POINT_BYTES = 28 * 8;
const ZERO: Vec3 = [0, 0, 0];
const EYE = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Layout version of the granular MPM sample records. */
export const GRANULAR_MPM_LAYOUT = 1;
/** f64 values per material point. Position, velocity, two column-major tensors, mass, rest volume, log plastic volume, material index. */
export const GRANULAR_MPM_WORDS = POINT_BYTES / 8;

/** Dense, dry granular friction measured in an independent material test. */
export interface GranularInertialRheology {
  /** Characteristic grain diameter in metres. */
  readonly grainDiameter: number;
  /** True grain density in kg/m³. The material density describes the bulk packing. */
  readonly grainDensity: number;
  /** Low-rate stress ratio μs. */
  readonly staticFriction: number;
  /** High-rate stress ratio μ2, greater than staticFriction. */
  readonly highRateFriction: number;
  /** Inertial number at the midpoint of the two stress ratios. */
  readonly referenceInertialNumber: number;
}

/**
 * A granular material for the MPM solver: sand or snow with optional density in kg/m³, Young modulus in Pa,
 * Poisson ratio, friction angle in radians, cohesion in Pa and inertial rheology. Defaults depend on the kind.
 */
export interface GranularMaterial {
  /** Frictional granular continuum or cohesive compressible snow. Default 'sand'. */
  readonly kind?: 'sand' | 'snow';
  /** Rest bulk density in kg/m³. Default 1600 for sand or 400 for snow. */
  readonly density?: number;
  /** Young modulus in Pa. Default 110000 for sand or 140000 for snow. */
  readonly young?: number;
  /** Poisson ratio from 0 to 0.49. Default 0.2. */
  readonly poisson?: number;
  /** Internal friction angle in radians. Default 34°. Applies to sand. */
  readonly frictionAngle?: number;
  /** Cohesion in Pa, default 0. Applies to sand. */
  readonly cohesion?: number;
  /** Enable implicit μ(I) friction for dry sand. Omitting this uses rate-independent Drucker–Prager. */
  readonly inertial?: GranularInertialRheology;
  /** Snow compression yield strain. Default 0.025. */
  readonly compressiveYield?: number;
  /** Snow tensile yield strain. Default 0.0075. */
  readonly tensileYield?: number;
  /** Snow plastic hardening coefficient, default 10. */
  readonly hardening?: number;
}

/**
 * One material point: rest position in metres, undeformed volume in m³, initial velocity in m/s (default zero)
 * and the material table index (default 0).
 */
export interface GranularPoint {
  /** Rest position in the world cell, metres. */
  readonly position: Vec3;
  /** Undeformed material volume in m³. */
  readonly volume: number;
  /** Initial velocity in m/s. Default zero. */
  readonly velocity?: Vec3;
  /** Material table index. Default 0. */
  readonly material?: number;
}

/**
 * What the granular MPM solver is made from: the points, the material table (default one sand), grid spacing in
 * metres (default 0.08), rate level, speed margin in m/s (default 3), the APIC or PIC transfer (default 'apic')
 * and optional terrain bed surfaces.
 */
export interface GranularMpmParams {
  readonly points: readonly GranularPoint[];
  /** Defaults to one sand material. */
  readonly materials?: readonly GranularMaterial[];
  /** Sparse grid spacing in metres. Default 0.08. */
  readonly spacing?: number;
  /** World clock level. Defaults to the first stable level for the initial points and speed margin. */
  readonly rate?: RateLevel;
  /** Expected extra particle travel speed in m/s used to choose the automatic clock, default 3. */
  readonly speedMargin?: number;
  /** APIC preserves affine velocity; PIC is more dissipative. Default 'apic'. */
  readonly transfer?: 'apic' | 'pic';
  /** Optional registered terrain bed sampler for passive grid contact. */
  readonly bed?: Bed;
  /** Optional receiving terrain surface, separate from the contact bed or floor. Enable with projectBed at load. */
  readonly bedSurface?: Bed;
  /** Half-depth of the bed's water-driven active layer, metres. Defaults to the grid spacing. */
  readonly wakeDepth?: number;
  /** Share of impinging impulse converted to resolved bed shear. Defaults to 0.05. */
  readonly wakeFraction?: number;
  /** Horizontal contact elevation in metres if no terrain field is supplied. Omit for an open domain. */
  readonly floor?: number;
  /** Grid-ground Coulomb coefficient, default 0.55. */
  readonly groundFriction?: number;
  /** World floating-origin cell length in metres. Default 4096. */
  readonly cellSize?: number;
}

/**
 * Options for loading the granular MPM solver: its ID (default 'granular-mpm'), whether to publish bed changes
 * (default false), whether to receive swimming wake impulses (default false) and an `AbortSignal`.
 */
export interface GranularMpmLoadOptions {
  /** Solver registry ID. Default 'granular-mpm'. */
  readonly id?: string;
  /** Publish material volume changes to the bedChange field. Default false. */
  readonly projectBed?: boolean;
  /** Receive real swimming wake impulses in the material layer. Also enable projectBed. Default false. */
  readonly bedWakes?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * One material point read back from the granular MPM solver: position in metres, velocity in m/s, mass,
 * reference volume, log plastic volume and material index.
 */
export interface GranularMpmSample {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly mass: number;
  readonly referenceVolume: number;
  readonly logPlasticVolume: number;
  readonly material: number;
}

type Native = {
  readonly __stack_pointer: WebAssembly.Global;
  mpm_layer: LayerRaster;
  mpm_wake: WakeKernel;
  mpm_scatter(
    points: number,
    count: number,
    models: number,
    modelCount: number,
    nodes: number,
    slots: number,
    active: number,
    control: number,
    dt: number,
    kicks: number,
    driven: number,
  ): number;
  mpm_move(
    points: number,
    next: number,
    count: number,
    models: number,
    modelCount: number,
    nodes: number,
    slots: number,
    active: number,
    used: number,
    planes: number,
    control: number,
    dt: number,
  ): number;
  mpm_clear(nodes: number, slots: number, active: number, used: number): void;
};

function invalid(message: string): never {
  throw new MargoError('state', message);
}

function inRange(value: number, name: string, min: number, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max) invalid(`Pass a finite ${name} in [${min}, ${max}].`);
  return value;
}

function positive(value: number, name: string): number {
  if (!(value > 0 && Number.isFinite(value))) invalid(`Pass a finite positive ${name}.`);
  return value;
}

function vec(value: Vec3): Vec3 {
  if (value.length !== 3 || !value.every(Number.isFinite)) invalid('Pass three finite vector coordinates.');
  return value;
}

function xyz(values: Float64Array, at: number): Vec3 {
  return [values[at]!, values[at + 1]!, values[at + 2]!];
}

function material(data: GranularMaterial) {
  const kind = data.kind ?? 'sand';
  if (kind !== 'sand' && kind !== 'snow') invalid('Choose sand or snow for the constitutive model.');
  const snow = kind === 'snow';
  const density = positive(data.density ?? (snow ? 400 : 1600), 'bulk density');
  const young = positive(data.young ?? (snow ? 140000 : 110000), 'Young modulus');
  const poisson = inRange(data.poisson ?? 0.2, 'Poisson ratio', 0, 0.49);
  const shear = young / (2 * (1 + poisson));
  const lambda = (young * poisson) / ((1 + poisson) * (1 - 2 * poisson));
  const theta = positive(data.frictionAngle ?? (34 * Math.PI) / 180, 'internal friction angle');
  if (theta >= Math.PI / 2) invalid('Use an internal friction angle below π/2.');
  const sine = sin(theta);
  const alpha = (Math.sqrt(2 / 3) * 2 * sine) / (3 - sine);
  const cohesion = inRange(data.cohesion ?? 0, 'cohesion', 0);
  let inertialScale = 0;
  let staticFriction = 0;
  let frictionRange = 0;
  if (data.inertial) {
    if (snow || cohesion > 0) invalid('Use inertial friction on dry sand with zero cohesion.');
    const settings = data.inertial;
    const diameter = positive(settings.grainDiameter, 'grain diameter');
    const grainDensity = positive(settings.grainDensity, 'grain density');
    const reference = positive(settings.referenceInertialNumber, 'reference inertial number');
    staticFriction = inRange(settings.staticFriction, 'static friction ratio', 0);
    frictionRange = positive(settings.highRateFriction - staticFriction, 'increase in friction at high rates');
    if (grainDensity < density) invalid('Use a true grain density at least as large as the bulk density.');
    inertialScale = positive(reference / Math.sqrt(grainDensity) / diameter, 'inertial scale');
  }
  const values = [
    shear,
    lambda,
    alpha,
    cohesion,
    Number(snow),
    inRange(data.compressiveYield ?? 0.025, 'compressive yield strain', 0, 0.99),
    inRange(data.tensileYield ?? 0.0075, 'tensile yield strain', 0),
    inRange(data.hardening ?? 10, 'hardening coefficient', 0),
    staticFriction,
    frictionRange,
    inertialScale,
  ];
  return { values, density, speed: Math.sqrt((2 * shear + lambda) / density) };
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok) invalid(`Serve the granular MPM asset. The request returned HTTP ${response.status}.`);
    if (response.headers.get('content-type')?.split(';')[0] === 'application/wasm')
      return await WebAssembly.compileStreaming(response);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    throw Object.assign(
      new MargoError('failed', 'Use a Wasm SIMD runtime and serve the optional granular MPM module.'),
      { cause },
    );
  }
}

/** Sparse, three-dimensional MLS material point solver for frictional sand and compressible snow. */
export class GranularMpmSolver implements Solver<GranularMpmParams> {
  readonly field: FieldDescriptor;
  private host!: SolverHost;
  private native!: Native;
  private points!: Region;
  private next!: Region;
  private models!: Region;
  private nodes!: Region;
  private active!: Region;
  private planes!: Region;
  private control!: Region;
  private work!: Region;
  private pointCount = 0;
  private modelCount = 0;
  private slots = 1;
  private rate: RateLevel = 0;
  private spacing = 0.08;
  private cell: Cell = [0, 0, 0];
  private cellSize = 4096;
  private floor: number | undefined;
  private bed: Bed | undefined;
  private layer?: GranularLayer;
  private wake?: GranularWake;

  private constructor(
    readonly id: string,
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    private readonly projectBed: boolean,
    private readonly bedWakes: boolean,
  ) {
    this.field = {
      name: `${id}:materialPoints`,
      kind: 'particleSet',
      centring: 'particle',
      quantity:
        'position, velocity, affine velocity, elastic deformation, mass, rest volume, log plastic volume, material',
      unit: 'm, m/s, 1/s, 1, kg, m³, 1, 1',
    };
  }

  static async load(options: GranularMpmLoadOptions = {}): Promise<GranularMpmSolver> {
    const signal = options.signal;
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './granular-mpm-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './granular-mpm-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new GranularMpmSolver(
      options.id ?? 'granular-mpm',
      plain,
      shared,
      options.projectBed ?? false,
      options.bedWakes ?? false,
    );
  }

  describe() {
    const fields: FieldUse[] = [{ field: this.field, access: 'write' }];
    if (this.projectBed) fields.push({ field: BED_CHANGE_FIELD, access: 'accumulate' });
    if (this.bedWakes) fields.push({ field: SWIM_WAKE_FIELD, access: 'read' });
    return { id: this.id, rate: 0 as const, stableRate: () => this.rate, fields };
  }

  init(host: SolverHost, params: GranularMpmParams): void {
    if (this.host) invalid('Load a fresh granular solver for another world.');
    if (!params?.points?.length) invalid('Supply at least one granular material point.');
    const data = (params.materials ?? [{}]).map(material);
    if (!data.length) invalid('Supply at least one granular material.');
    const transfer = params.transfer ?? 'apic';
    if (transfer !== 'apic' && transfer !== 'pic') invalid('Select APIC or PIC particle transfer.');
    this.spacing = positive(params.spacing ?? 0.08, 'grid spacing');
    this.cellSize = positive(params.cellSize ?? 4096, 'origin cell length');
    this.floor = params.floor === undefined ? undefined : inRange(params.floor, 'horizontal floor', -Infinity);
    this.bed = params.bed;
    if (this.projectBed !== Boolean(params.bedSurface))
      invalid('Set projectBed and supply the receiving bedSurface together.');
    if (this.bedWakes && !params.bedSurface)
      invalid('Enable bed projection and supply a bedSurface when receiving swim wakes.');
    if (params.bedSurface && params.bedSurface === params.bed)
      invalid('Use the receiving surface for deposition and a separate bed or floor for support.');
    this.pointCount = params.points.length;
    this.modelCount = data.length;
    const support = this.pointCount * 27;
    while (this.slots < 2 * support) this.slots *= 2;
    const bytes = this.slots * GRID_WORDS * 8 + support * 36 + this.pointCount * POINT_BYTES * 2;
    if (!Number.isSafeInteger(bytes) || bytes + STACK_BYTES >= MAX_MEMORY_PAGES * 65536)
      invalid('Reduce the number of points or partition the granular domain into cells.');
    const wave = data.reduce((max, value) => Math.max(max, value.speed), 0);
    const speed = params.points.reduce((max, value) => Math.max(max, hypot(...vec(value.velocity ?? ZERO))), 0);
    const margin = inRange(params.speedMargin ?? 3, 'speed margin', 0);
    let level = 0;
    while (level <= 7 && wave + speed + margin > 0.4 * this.spacing * (60 * (1 << level))) level++;
    const rate = params.rate ?? level;
    if (!isRateLevel(rate) || wave + speed > 0.4 * this.spacing * rateOf(rate))
      invalid(
        'Increase the rate level or spacing or lower the stiffness and initial speed to satisfy the elastic CFL bound.',
      );
    this.rate = rate;
    const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
    const wasm = shared ? this.shared : this.plain;
    if (!wasm) invalid('Load the shared granular MPM module or use a plain-memory world.');
    this.host = host;
    const area = (name: string, count: number) => host.allocate(name, count * 8, 'f64', GRANULAR_MPM_LAYOUT);
    const stack = host.allocate('granular-mpm-stack', STACK_BYTES, 'u8', GRANULAR_MPM_LAYOUT);
    this.points = area('granular-mpm-points', this.pointCount * GRANULAR_MPM_WORDS);
    this.next = area('granular-mpm-trial-points', this.pointCount * GRANULAR_MPM_WORDS);
    this.models = area('granular-mpm-materials', this.modelCount * MODEL_WORDS);
    this.nodes = area('granular-mpm-grid', this.slots * GRID_WORDS);
    this.active = host.allocate('granular-mpm-occupied-nodes', support * 4, 'i32', GRANULAR_MPM_LAYOUT);
    this.planes = area('granular-mpm-contact-planes', support * 4);
    this.control = area('granular-mpm-control', 6);
    this.work = area('granular-mpm-last-work', 1);
    this.native = new WebAssembly.Instance(wasm, { env: { memory: host.memory } }).exports as Native;
    if (!(this.native.__stack_pointer instanceof WebAssembly.Global))
      invalid('Rebuild both granular MPM module variants with the world stack export.');
    if (params.bedSurface)
      this.layer = new GranularLayer(host, params.bedSurface, this.cellSize, this.native.mpm_layer);
    if (this.bedWakes && params.bedSurface)
      this.wake = new GranularWake(
        host,
        params.bedSurface,
        positive(params.wakeDepth ?? this.spacing, 'active wake depth'),
        inRange(params.wakeFraction ?? 0.05, 'wake impulse fraction', 0, 1),
        this.cellSize,
        this.pointCount,
        this.native.mpm_wake,
      );
    this.native.__stack_pointer.value = (stack.byteOffset + stack.byteLength) & ~15;
    this.words(this.control).set([
      ...host.gravity,
      this.spacing,
      inRange(params.groundFriction ?? 0.55, 'ground friction', 0),
      Number(transfer === 'apic'),
    ]);
    const rows = this.words(this.points);
    const models = this.words(this.models);
    for (const [index, model] of data.entries()) models.set(model.values, index * MODEL_WORDS);
    for (const [index, point] of params.points.entries()) {
      const materialId = point.material ?? 0;
      const selected = data[materialId];
      if (!Number.isInteger(materialId) || !selected)
        invalid('Choose an existing material table index for each point.');
      const volume = positive(point.volume, 'reference point volume');
      rows.set(
        [
          ...vec(point.position),
          ...vec(point.velocity ?? ZERO),
          ...Array<number>(9).fill(0),
          ...EYE,
          positive(volume * selected.density, 'point mass'),
          volume,
          0,
          materialId,
        ],
        index * GRANULAR_MPM_WORDS,
      );
    }
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private terrain(used: number): void {
    const planes = this.words(this.planes);
    const bed = this.bed;
    if (!bed) {
      const floor = this.floor;
      for (let i = 0; i < used; i++) planes.set([0, floor === undefined ? 0 : 1, 0, floor ?? 0], i * 4);
      return;
    }
    const memory = this.host.memory.buffer;
    const nodes = new Int32Array(memory, this.nodes.byteOffset, this.nodes.byteLength / 4);
    const active = new Uint32Array(memory, this.active.byteOffset, used);
    const offset = this.cell.map((coord, i) => (coord - bed.cell[i]!) * this.cellSize);
    const reuse: BedSample = { elevation: 0, normal: [0, 1, 0] };
    for (let i = 0; i < used; i++) {
      const at = active[i]! * GRID_WORDS * 2;
      const x = nodes[at]! * this.spacing;
      const z = nodes[at + 2]! * this.spacing;
      const ground = bed.sample(x + offset[0]!, z + offset[2]!, reuse);
      const [nx, ny, nz] = vec(ground.normal);
      const length = positive(hypot(nx, ny, nz), 'ground normal length');
      const elevation = inRange(ground.elevation, 'ground elevation', -Infinity) - offset[1]!;
      planes.set([nx / length, ny / length, nz / length, (nx * x + ny * elevation + nz * z) / length], 4 * i);
    }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const point = this.points.byteOffset,
      model = this.models.byteOffset,
      node = this.nodes.byteOffset,
      list = this.active.byteOffset;
    const delivered = this.wake?.prepare(context, this.points, this.pointCount);
    const used = this.native.mpm_scatter(
      point,
      this.pointCount,
      model,
      this.modelCount,
      node,
      this.slots,
      list,
      this.control.byteOffset,
      dt,
      this.wake?.kicks.byteOffset ?? this.control.byteOffset,
      Number(this.wake !== undefined),
    );
    this.check(used);
    try {
      this.layer?.seed(this.points, this.pointCount, this.cell);
      this.terrain(used);
      this.check(
        this.native.mpm_move(
          point,
          this.next.byteOffset,
          this.pointCount,
          model,
          this.modelCount,
          node,
          this.slots,
          list,
          used,
          this.planes.byteOffset,
          this.control.byteOffset,
          dt,
        ),
      );
      this.layer?.update(this.points, this.pointCount, this.cell);
      if (delivered) this.wake?.commit(delivered);
      this.words(this.work)[0] = used;
    } finally {
      this.native.mpm_clear(node, this.slots, list, used);
    }
  }

  private check(result: number): void {
    if (result === -1)
      invalid(
        'Raise the clock level or spacing, or reduce material stiffness and velocity to satisfy the elastic CFL bound.',
      );
    if (result === -2)
      invalid('Recenter the granular world cell or increase its grid spacing to keep integer nodes in range.');
    if (result === -3)
      invalid('Use a higher clock level or lower the applied strain rate to keep deformation orientation positive.');
  }

  exportPorts(tick: number): readonly Port[] {
    const ports = [{ field: this.field.name, region: this.points, tick, cell: this.cell }];
    if (this.layer) ports.push(this.layer.port(tick));
    return ports;
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.points, this.work, ...(this.layer?.regions() ?? []), ...(this.wake ? [this.wake.ledger] : [])];
  }

  extraState(): readonly Region[] {
    return [];
  }

  sample(index: number): GranularMpmSample {
    if (!Number.isInteger(index) || index < 0 || index >= this.pointCount)
      invalid('Choose an existing granular point index.');
    const at = index * GRANULAR_MPM_WORDS;
    const data = this.words(this.points);
    return {
      position: xyz(data, at),
      velocity: xyz(data, at + 3),
      mass: data[at + 24]!,
      referenceVolume: data[at + 25]!,
      logPlasticVolume: data[at + 26]!,
      material: data[at + 27]!,
    };
  }

  /** Cumulative net horizontal impulse accepted from swimming wakes, in N·s. */
  get wakeImpulse(): Vec3 {
    return this.wake?.impulse ?? [0, 0, 0];
  }

  /** Number of occupied grid nodes in the last completed step. */
  get activeNodes(): number {
    return this.words(this.work)[0]!;
  }
}
