import type { Quat, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { Bed, BedSample, FlowSample, Wind } from '@margoengine/math/fields';
import { exp, hypot } from '@margoengine/math/pinned';
import { canShareMemory, isShared, MAX_MEMORY_PAGES, regionWords, STACK_BYTES } from '../world/memory.js';
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
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, bodyRowsOf, IMPULSE_WORDS } from '../world/solvers/rigid.js';

const IDENTITY: Quat = [0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];
const Z: Vec3 = [0, 0, 1];
const MATERIAL_WORDS = 13;
const ENVIRONMENT_WORDS = 8;
const SCRATCH_WORDS = 25;
const ROOT_WORDS = 9;
const CAPSULE_WORDS = 7;
const RIGID_CAPSULE_WORDS = 24;
const BODY_INDEX = 16;
const PREVIOUS_POSE = 17;
const RIGID_MASS_WORDS = 7;
const CAPSULE_HIT_WORDS = 6;
const DIRECT_BLOCK_WORDS = 138;

/** Field layout 1 stores centreline position, velocity, material frame and angular velocity. */
export const STRAND_LAYOUT = 1;
/** f64 words per point. Positions and velocities are XYZ. The frame is XYZW. Angular velocity is XYZ. */
export const STRAND_WORDS = 13;

/** Time-dependent rigid transform of the authored root. */
export interface StrandAnchor {
  /** World-cell position in metres. */
  readonly position: Vec3;
  /** Rotation of the strand's authored root frame. Defaults to identity. */
  readonly rotation?: Quat;
}

/** Section properties for a single link. Omitted values inherit the guide settings. */
export interface StrandSection {
  /** Outer contact radius in metres. Default 40 μm. */
  readonly radius?: number;
  /** Load-bearing area in square metres. Defaults to the solid circular section. */
  readonly area?: number;
  /** Mean transverse area moment in metres to the fourth power. Defaults to the solid circular section. */
  readonly secondMoment?: number;
  /** Saint-Venant torsion constant in metres to the fourth power. Defaults to twice the second moment. */
  readonly torsionConstant?: number;
  /** Material density in kg/m³. Default 1300. */
  readonly density?: number;
  /** Young's modulus in Pa. Default 3 GPa. */
  readonly young?: number;
  /** Shear modulus in Pa. Defaults to E / 2.6. */
  readonly shear?: number;
  /** Width in metres for drag, allowing a vane or bundle wider than its shaft. Defaults to the fibre diameter. */
  readonly dragWidth?: number;
}

/** A fibre guide, feather shaft, ponytail or spring-bone chain. */
export interface StrandSpec extends StrandSection {
  /** Ordered rest points in metres, in the root's authored coordinates. At least two. */
  readonly points: readonly Vec3[];
  /** Optional section properties in root-to-tip link order. Supply one entry per link. */
  readonly sections?: readonly StrandSection[];
  /** Dimensionless cross-flow drag coefficient. Default 1.2. */
  readonly drag?: number;
  /** Prescribed pose relative to `points[0]`. Defaults to a stationary root. */
  readonly anchor?: (time: number) => StrandAnchor;
}

/** A body capsule or sphere in the solver's origin cell. Equal ends describe a sphere. */
export interface StrandCapsule {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly radius: number;
}

/** Capsule endpoints in a rigid body's local metres, bound to its dynamic body row. */
export interface StrandRigidCapsule extends StrandCapsule {
  readonly body: number;
}

/** Native strand loader options. */
export interface StrandLoadOptions {
  /** Solver registry id. Default 'strands'. */
  readonly id?: string;
  readonly signal?: AbortSignal;
  /** Optional reciprocal rigid contacts. Add the RigidSolver first and use the rod tier. */
  readonly rigidCapsules?: readonly StrandRigidCapsule[];
}

/** Controls for a world-clock set of physical guides. */
export interface StrandParams {
  readonly strands: readonly StrandSpec[];
  /** Cosserat rod projection with bending and twist, or a single inextensible follow-the-leader pass. Default 'rod'. */
  readonly fidelity?: 'rod' | 'follow';
  /** Rod constraint solve. Default 'direct'. Select 'local' for the sequential projection profile. */
  readonly rodSolve?: 'local' | 'direct';
  /** Solver rate level, 60 × 2^level Hz, default 2 (240 Hz). */
  readonly rate?: RateLevel;
  /** Rod constraint passes per substep. Default 6 for direct and 12 for local. */
  readonly iterations?: number;
  /** Additional viscous damping per second, default 2. */
  readonly damping?: number;
  /** Dynamic follow-the-leader velocity correction, default 0.9. */
  readonly followDamping?: number;
  /** Coulomb contact coefficient, default 0.25. */
  readonly friction?: number;
  /** Cloth-like contacts between nonadjacent points, default true in the rod tier. */
  readonly selfCollision?: boolean;
  /** Rod contact geometry. 'swept' also tests trajectories between substeps. Default 'points'. */
  readonly contactGeometry?: 'points' | 'segments' | 'swept';
  /** World-owned wind, sampled for each point. Default still air at 1.225 kg/m³. */
  readonly wind?: Wind;
  /** Ground in SI world units. Omit for no terrain contact. */
  readonly bed?: Bed;
  /** Prescribed body volumes, sampled at the same tick as the anchors. */
  readonly colliders?: readonly (StrandCapsule | ((time: number) => StrandCapsule))[];
  /** Length of one world origin cell, metres. Default 4096. */
  readonly cellSize?: number;
}

/** One point's live position, velocities and material frame in world coordinates. */
export interface StrandReading {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly rotation: Quat;
  readonly spin: Vec3;
}

type Native = {
  __stack_pointer: WebAssembly.Global;
  advance_strands(
    state: number,
    material: number,
    environment: number,
    scratch: number,
    roots: number,
    obstacles: number,
    config: number,
    links: number,
    buckets: number,
    points: number,
    chains: number,
    colliders: number,
    bucketCount: number,
    movingCapsules: number,
    movingCount: number,
    capsuleHits: number,
    reactions: number,
    reactionCount: number,
    directBlocks: number,
    previousObstacles: number,
    rigidMasses: number,
  ): number;
};

type Guide = {
  readonly spec: StrandSpec;
  readonly first: number;
  readonly count: number;
  readonly root: Vec3;
  readonly frame: Quat;
  readonly drag: number;
  readonly width: number;
  readonly radius: number;
  readonly dragAreas?: Float64Array;
};

function invalid(fix: string): never {
  throw new MargoError('state', fix);
}

function finite(value: number, label: string, min = -Infinity): number {
  if (!Number.isFinite(value) || value < min) invalid(`Pass a finite ${label} at or above ${min}.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!(value > 0 && Number.isFinite(value))) invalid(`Pass a finite positive ${label}.`);
  return value;
}

function readSection(guide: StrandSection, section?: StrandSection) {
  const radius = positive(section?.radius ?? guide.radius ?? 40e-6, 'fibre radius');
  const density = positive(section?.density ?? guide.density ?? 1300, 'fibre density');
  const young = positive(section?.young ?? guide.young ?? 3e9, 'Young modulus');
  const shear = positive(section?.shear ?? guide.shear ?? young / 2.6, 'shear modulus');
  const frontal = Math.PI * radius * radius;
  const area = positive(section?.area ?? guide.area ?? frontal, 'section area');
  const inertia = positive(
    section?.secondMoment ?? guide.secondMoment ?? (frontal * radius * radius) / 4,
    'second moment',
  );
  const torsion = positive(section?.torsionConstant ?? guide.torsionConstant ?? 2 * inertia, 'torsion constant');
  const width = positive(section?.dragWidth ?? guide.dragWidth ?? 2 * radius, 'projected drag width');
  return { radius, density, young, shear, area, inertia, torsion, width, frontal, lineDensity: density * area };
}

function vector(value: Vec3): Vec3 {
  if (value.length !== 3 || !value.every(Number.isFinite)) invalid('Pass three finite coordinate values in metres.');
  return [value[0], value[1], value[2]];
}

const difference = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const sum = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (v: Vec3, x: number): Vec3 => [v[0] * x, v[1] * x, v[2] * x];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const xyz = (a: ArrayLike<number>, at: number): Vec3 => [a[at]!, a[at + 1]!, a[at + 2]!];
const quaternion = (a: ArrayLike<number>, at: number): Quat => [a[at]!, a[at + 1]!, a[at + 2]!, a[at + 3]!];

function normalized(q: Quat): Quat {
  const r = positive(Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]), 'anchor quaternion length');
  return [q[0] / r, q[1] / r, q[2] / r, q[3] / r];
}

function multiply(a: Quat, b: Quat): Quat {
  const av = xyz(a, 0),
    bv = xyz(b, 0);
  return [...sum(sum(scaled(av, b[3]), scaled(bv, a[3])), cross(av, bv)), a[3] * b[3] - dot(av, bv)];
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const axis = xyz(q, 0),
    twice = scaled(cross(axis, v), 2);
  return sum(v, sum(scaled(twice, q[3]), cross(axis, twice)));
}

function align(frame: Quat, direction: Vec3): Quat {
  const before = rotate(frame, Z),
    w = 1 + dot(before, direction);
  return normalized(
    multiply(w <= 1e-12 ? [...rotate(frame, [1, 0, 0]), 0] : normalized([...cross(before, direction), w]), frame),
  );
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const fs = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ fs);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError('failed', 'Strand Wasm could not load. Provide both native variants beside strands.js.');
  return WebAssembly.compile(await response.arrayBuffer());
}

/** SI strand guides with Cosserat bending and twist, inextensible fast following, and body and ground contact. */
export class StrandSolver implements Solver<StrandParams> {
  readonly field: FieldDescriptor;
  private host!: SolverHost;
  private native!: Native;
  private cell: Cell = ZERO;
  private clock: RateLevel = 2;
  private count = 0;
  private bucketCount = 1;
  private cellSize = 4096;
  private damping = 2;
  private wind: Wind | undefined;
  private bed: Bed | undefined;
  private colliders: NonNullable<StrandParams['colliders']> = [];
  private readonly guides: Guide[] = [];
  private nodes!: Region;
  private material!: Region;
  private environment!: Region;
  private scratch!: Region;
  private roots!: Region;
  private obstacles!: Region;
  private config!: Region;
  private ledger!: Region;
  private links!: Region;
  private buckets!: Region;
  private movingCapsules?: Region;
  private capsuleHits?: Region;
  private rigidMasses?: Region;
  private reactions?: Region;
  private rigidRows = 0;
  private directBlocks?: Region;
  private previousObstacles?: Region;
  private swept = false;

  private constructor(
    readonly id: string,
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    private readonly rigidCapsules: readonly StrandRigidCapsule[],
  ) {
    this.field = {
      name: `${id}:strand`,
      kind: 'particleSet',
      centring: 'particle',
      quantity: 'strand position, linear velocity, frame and angular velocity',
      unit: 'm, m/s, 1, rad/s',
    };
  }

  /** Loads the optional SIMD variants. No native asset is fetched on import. */
  static async load(options: StrandLoadOptions = {}): Promise<StrandSolver> {
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './strand-kernel.wasm?no-inline', import.meta.url), options.signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './strand-kernel-shared.wasm?no-inline', import.meta.url), options.signal)
        : undefined,
    ]);
    options.signal?.throwIfAborted();
    const rigidCapsules = (options.rigidCapsules ?? []).map(({ start, end, radius, body }) => ({
      start: vector(start),
      end: vector(end),
      radius: positive(radius, 'rigid capsule radius'),
      body,
    }));
    return new StrandSolver(options.id ?? 'strands', plain, shared, rigidCapsules);
  }

  describe() {
    const fields: FieldUse[] = [{ field: this.field, access: 'write' }];
    if (this.rigidCapsules.length)
      fields.push({ field: BODIES_FIELD, access: 'read' }, { field: BODY_IMPULSES_FIELD, access: 'accumulate' });
    return { id: this.id, rate: 0 as const, stableRate: () => this.clock, fields };
  }

  init(host: SolverHost, params: StrandParams): void {
    if (this.host) invalid('Load a fresh solver to attach another world.');
    if (!params?.strands?.length) invalid('Supply at least one strand with two or more points.');
    const fidelity = params.fidelity ?? 'rod';
    if (fidelity !== 'rod' && fidelity !== 'follow') invalid('Select the rod or follow tier.');
    if (this.rigidCapsules.length) {
      if (fidelity !== 'rod') invalid('Use the rod tier for reciprocal rigid contacts.');
      this.rigidRows = bodyRowsOf(
        host,
        this.id,
        this.rigidCapsules.map((shape) => shape.body),
      );
    }
    this.clock = params.rate ?? 2;
    if (!Number.isInteger(this.clock) || this.clock < 0 || this.clock > 7)
      invalid('Choose a world clock level from 0 through 7.');
    const follow = finite(params.followDamping ?? 0.9, 'follower damping', 0);
    if (follow > 1) invalid('Set follower damping between zero and one.');
    const self = params.selfCollision ?? fidelity === 'rod';
    if (self && fidelity === 'follow') invalid('Use the rod tier for self contact.');
    const contactGeometry = params.contactGeometry ?? 'points';
    if (contactGeometry !== 'points' && contactGeometry !== 'segments' && contactGeometry !== 'swept')
      invalid('Choose point, segment or swept body contact.');
    if (contactGeometry !== 'points' && fidelity !== 'rod') invalid('Use the rod tier for segment contact.');
    this.swept = contactGeometry === 'swept';
    const rodSolve = params.rodSolve ?? (fidelity === 'rod' ? 'direct' : 'local');
    if (rodSolve !== 'local' && rodSolve !== 'direct') invalid('Choose a local or direct rod constraint solve.');
    const direct = rodSolve === 'direct';
    if (direct && fidelity !== 'rod') invalid('Use the rod tier with the direct constraint solve.');
    const iterations = params.iterations ?? (direct ? 6 : 12);
    if (!Number.isSafeInteger(iterations) || iterations < 1) invalid('Use a whole positive rod iteration count.');
    this.damping = finite(params.damping ?? 2, 'damping per second', 0);
    this.cellSize = positive(params.cellSize ?? 4096, 'origin cell length');
    this.wind = params.wind;
    this.bed = params.bed;
    this.colliders = [...(params.colliders ?? [])];
    this.count = params.strands.reduce((n, guide) => n + guide.points.length, 0);
    const bytes =
      this.count * 8 * (3 * STRAND_WORDS + MATERIAL_WORDS + ENVIRONMENT_WORDS + SCRATCH_WORDS + ROOT_WORDS + 4) +
      (this.colliders.length * CAPSULE_WORDS * (this.swept ? 2 : 1) +
        (direct ? this.count * DIRECT_BLOCK_WORDS : 0) +
        (this.rigidRows
          ? this.count * CAPSULE_HIT_WORDS +
            this.rigidCapsules.length * (RIGID_CAPSULE_WORDS + RIGID_MASS_WORDS) +
            this.rigidRows * IMPULSE_WORDS
          : 0)) *
        8;
    if (!Number.isSafeInteger(bytes) || bytes >= MAX_MEMORY_PAGES * 65536)
      invalid('Reduce the guides to fit the wasm32 arena.');
    while (this.bucketCount < 2 * this.count) this.bucketCount *= 2;
    const native =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]'
        ? this.shared
        : this.plain;
    if (!native) throw new MargoError('failed', 'Shared strand Wasm is unavailable. Use a plain-memory world.');
    this.host = host;
    const area = (label: string, words: number) => host.allocate(label, words * 8, 'f64', STRAND_LAYOUT);
    const stack = host.allocate('strand-stack', STACK_BYTES, 'u8', STRAND_LAYOUT);
    this.nodes = area('strand-centreline-and-frames', this.count * STRAND_WORDS);
    this.material = area('strand-material-coefficients', this.count * MATERIAL_WORDS);
    this.environment = area('strand-wind-and-terrain', this.count * ENVIRONMENT_WORDS);
    this.scratch = area('strand-snapshot-of-substep', this.count * SCRATCH_WORDS);
    this.roots = area('strand-anchors', params.strands.length * ROOT_WORDS);
    this.obstacles = area('strand-body-capsules', Math.max(1, this.colliders.length) * CAPSULE_WORDS);
    if (this.swept && this.colliders.length)
      this.previousObstacles = area('strand-previous-prescribed-capsules', this.colliders.length * CAPSULE_WORDS);
    this.config = area('strand-step-parameters', 10);
    this.ledger = area('strand-contact-work-and-cell', 4);
    this.links = host.allocate('strand-grid-links', this.count * 16, 'i32', STRAND_LAYOUT);
    this.buckets = host.allocate('strand-grid-buckets', this.bucketCount * 4, 'i32', STRAND_LAYOUT);
    if (direct) this.directBlocks = area('strand-direct-rod-blocks', this.count * DIRECT_BLOCK_WORDS);
    if (this.rigidRows) {
      this.movingCapsules = area('strand-dynamic-body-capsules', this.rigidCapsules.length * RIGID_CAPSULE_WORDS);
      this.capsuleHits = area('strand-rigid-contact-witness', this.count * CAPSULE_HIT_WORDS);
      this.reactions = area('strand-rigid-body-impulses', this.rigidRows * IMPULSE_WORDS);
      this.rigidMasses = area('strand-rigid-inverse-inertia', this.rigidCapsules.length * RIGID_MASS_WORDS);
      const poses = this.words(this.movingCapsules);
      for (let i = 0; i < this.rigidCapsules.length; i++) poses[i * RIGID_CAPSULE_WORDS + BODY_INDEX] = -1;
    }
    this.native = new WebAssembly.Instance(native, { env: { memory: host.memory } }).exports as Native;
    if (
      typeof this.native.advance_strands !== 'function' ||
      !(this.native.__stack_pointer instanceof WebAssembly.Global)
    )
      throw new MargoError('failed', 'Unexpected strand Wasm layout. Run the strand kernel build for both variants.');
    this.native.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    let first = 0,
      maxRadius = 0;
    for (const spec of params.strands) {
      const guide = this.initialize(spec, first);
      this.guides.push(guide);
      maxRadius = Math.max(maxRadius, guide.radius);
      first += guide.count;
    }
    this.words(this.config).set([
      ...host.gravity,
      0,
      1,
      fidelity === 'rod' ? iterations : 0,
      follow,
      finite(params.friction ?? 0.25, 'contact friction', 0),
      Number(self) + 2 * Number(contactGeometry !== 'points') + 4 * Number(direct) + 8 * Number(this.swept),
      2 * maxRadius,
    ]);
    this.anchorAndColliders(0);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private initialize(spec: StrandSpec, first: number): Guide {
    const points = spec.points.map(vector);
    if (points.length < 2) invalid('Supply at least two distinct points per guide.');
    if (spec.sections && spec.sections.length !== points.length - 1)
      invalid('Supply one strand section for each link between consecutive points.');
    const base = readSection(spec);
    const simpleCylinder = spec.sections === undefined && spec.area === undefined && spec.secondMoment === undefined;
    const sections = spec.sections && Array.from(spec.sections, (section) => readSection(spec, section));
    const dragAreas = sections ? new Float64Array(2 * points.length) : undefined;
    let maxRadius = 0;
    const length: number[] = [],
      frames: Quat[] = [];
    let frame = IDENTITY;
    for (let i = 0; i + 1 < points.length; i++) {
      const edge = difference(points[i + 1]!, points[i]!);
      const l = positive(hypot(edge[0], edge[1], edge[2]), 'rest edge length');
      frame = align(frame, scaled(edge, 1 / l));
      frames.push(frame);
      length.push(l);
    }
    frames.push(frame);
    const root = points[0]!,
      anchor = spec.anchor?.(0) ?? { position: root };
    const origin = vector(anchor.position),
      orientation = normalized(anchor.rotation ?? IDENTITY);
    const state = this.words(this.nodes),
      material = this.words(this.material);
    for (let i = 0; i < points.length; i++) {
      const node = first + i,
        q = frames[i]!,
        next = frames[i + 1] ?? q;
      const l = length[i] ?? 0,
        previous = length[i - 1] ?? 0,
        span = 0.5 * (l + previous);
      const section = sections?.[i] ?? sections?.[i - 1] ?? base;
      const before = sections?.[i - 1] ?? section;
      const nextSection = sections?.[i + 1];
      const { area, density, radius, inertia, young, shear, torsion } = section;
      const edgeMass = section.lineDensity * l;
      const mass = positive(
        sections ? 0.5 * (edgeMass + before.lineDensity * previous) : section.lineDensity * span,
        'point mass',
      );
      const edgeBend = simpleCylinder
        ? (edgeMass * (l * l + 3 * radius * radius)) / 12
        : (edgeMass * l * l) / 12 + density * inertia * l;
      const edgeTwist = simpleCylinder ? edgeMass * radius * radius * 0.5 : 2 * density * inertia * l;
      const restRotation = normalized(multiply([-q[0], -q[1], -q[2], q[3]], next));
      const joint = (l + (length[i + 1] ?? l)) * 0.5;
      const bending = nextSection
        ? (0.5 * l) / (young * inertia) + (0.5 * length[i + 1]!) / (nextSection.young * nextSection.inertia)
        : joint / (young * inertia);
      const twisting = nextSection
        ? (0.5 * l) / (shear * torsion) + (0.5 * length[i + 1]!) / (nextSection.shear * nextSection.torsion)
        : joint / (shear * torsion);
      if (dragAreas) {
        dragAreas[2 * i] = 0.5 * (section.width * l + before.width * previous);
        dragAreas[2 * i + 1] = (section.frontal * l + before.frontal * previous) / (l + previous);
      }
      maxRadius = Math.max(maxRadius, radius);
      state.set(
        [
          ...sum(origin, rotate(orientation, difference(points[i]!, root))),
          0,
          0,
          0,
          ...normalized(multiply(orientation, q)),
          0,
          0,
          0,
        ],
        node * STRAND_WORDS,
      );
      material.set(
        [
          i === 0 ? 0 : 1 / mass,
          i === 0 || l === 0 ? 0 : 1 / edgeBend,
          i === 0 || l === 0 ? 0 : 1 / edgeTwist,
          radius,
          l,
          l === 0 ? 0 : 1 / (shear * area * l),
          l === 0 ? 0 : 1 / (young * area * l),
          bending,
          twisting,
          ...restRotation,
        ],
        node * MATERIAL_WORDS,
      );
    }
    return {
      spec,
      first,
      count: points.length,
      root,
      frame: frames[0]!,
      radius: maxRadius,
      width: base.width,
      drag: finite(spec.drag ?? 1.2, 'drag coefficient', 0),
      dragAreas,
    };
  }

  private anchorAndColliders(t: number, previousTime = t): void {
    const roots = this.words(this.roots);
    for (const [i, guide] of this.guides.entries()) {
      const pose = guide.spec.anchor?.(t) ?? { position: guide.root };
      const frame = normalized(multiply(normalized(pose.rotation ?? IDENTITY), guide.frame));
      roots.set([guide.first, guide.count, ...vector(pose.position), ...frame], ROOT_WORDS * i);
    }
    const data = this.words(this.obstacles);
    const previous = this.previousObstacles && this.words(this.previousObstacles);
    for (const [i, source] of this.colliders.entries()) {
      const body = typeof source === 'function' ? source(t) : source;
      if (previous) {
        const old = typeof source === 'function' ? source(previousTime) : source;
        previous.set(
          [...vector(old.start), ...vector(old.end), positive(old.radius, 'previous body capsule radius')],
          CAPSULE_WORDS * i,
        );
      }
      data.set(
        [...vector(body.start), ...vector(body.end), positive(body.radius, 'body capsule radius')],
        CAPSULE_WORDS * i,
      );
    }
  }

  private sampleEnvironment(t: number, dt: number): void {
    const env = this.words(this.environment),
      state = this.words(this.nodes),
      material = this.words(this.material);
    const wind = this.wind,
      bed = this.bed;
    const air: FlowSample = { density: 1.225, velocity: [0, 0, 0], temperature: 288.15 };
    const ground: BedSample = { normal: [0, 1, 0], elevation: 0 };
    const windOffset = wind ? scaled(difference(this.cell, wind.cell), this.cellSize) : ZERO;
    const bedOffset = bed ? scaled(difference(this.cell, bed.cell), this.cellSize) : ZERO;
    for (const guide of this.guides)
      for (let i = guide.first; i < guide.first + guide.count; i++) {
        const at = ENVIRONMENT_WORDS * i,
          p = xyz(state, STRAND_WORDS * i),
          v = xyz(state, STRAND_WORDS * i + 3);
        const position = sum(p, windOffset);
        const flow = wind ? wind.sample(position[0], position[1], position[2], t, air) : air;
        const tangent = rotate(quaternion(state, STRAND_WORDS * i + 6), Z);
        const relative = difference(flow.velocity, v),
          along = dot(tangent, relative),
          magnitude = dot(relative, relative);
        const crossFraction = magnitude > 0 ? Math.sqrt(Math.max(0, 1 - (along * along) / magnitude)) : 0;
        const span =
          0.5 * (material[MATERIAL_WORDS * i + 4]! + (i > guide.first ? material[MATERIAL_WORDS * (i - 1) + 4]! : 0));
        const profileIndex = 2 * (i - guide.first);
        const side = guide.dragAreas?.[profileIndex] ?? guide.width * span;
        const frontal = guide.dragAreas?.[profileIndex + 1] ?? Math.PI * guide.radius * guide.radius;
        const factor =
          0.5 *
          finite(flow.density, 'air density', 0) *
          guide.drag *
          (side * crossFraction + frontal * (1 - crossFraction));
        env.set([...vector(flow.velocity), factor * material[MATERIAL_WORDS * i]!], at);
        if (bed) {
          const x = p[0] + v[0] * dt,
            z = p[2] + v[2] * dt;
          const sample = bed.sample(x + bedOffset[0], z + bedOffset[2], ground);
          env.set([...sample.normal, dot(sample.normal, [x, sample.elevation - bedOffset[1], z])], at + 4);
        }
      }
  }

  private updateRigidCapsules(port: Port | undefined, dt: number): void {
    if (!this.movingCapsules || !this.reactions || !this.rigidMasses) return;
    this.words(this.reactions).fill(0);
    const capsules = this.words(this.movingCapsules),
      masses = this.words(this.rigidMasses);
    if (
      port &&
      (port.region.layout !== 2 ||
        port.region.type !== 'f32' ||
        port.region.byteLength !== 4 * BODY_WORDS * this.rigidRows)
    )
      invalid('Use the layout-2 RigidSolver bodies port with the same body rows.');
    const bodies = port ? regionWords(this.host.memory, port.region) : undefined;
    const offset = port ? scaled(difference(port.cell, this.cell), this.cellSize) : ZERO;
    for (const [index, capsule] of this.rigidCapsules.entries()) {
      const at = index * RIGID_CAPSULE_WORDS,
        body = capsule.body * BODY_WORDS;
      const existed = capsules[at + BODY_INDEX] === capsule.body;
      capsules[at + BODY_INDEX] = -1;
      if (bodies?.[body + 23] !== 1) continue;
      const origin = sum(xyz(bodies, body), offset);
      const frame = normalized(quaternion(bodies, body + 3));
      const start = sum(origin, rotate(frame, capsule.start)),
        end = sum(origin, rotate(frame, capsule.end));
      const centre = sum(xyz(bodies, body + 7), offset);
      const linear = xyz(bodies, body + 10),
        angular = xyz(bodies, body + 13);
      if (this.swept) {
        if (existed) capsules.copyWithin(at + PREVIOUS_POSE, at, at + CAPSULE_WORDS);
        else {
          const rewind = (point: Vec3) =>
            difference(point, scaled(sum(linear, cross(angular, difference(point, centre))), dt));
          capsules.set([...rewind(start), ...rewind(end), capsule.radius], at + PREVIOUS_POSE);
        }
      }
      capsules.set([...start, ...end, capsule.radius, ...centre, ...linear, ...angular, capsule.body], at);
      masses.set(bodies.subarray(body + 16, body + 23), index * RIGID_MASS_WORDS);
    }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const t = (context.tick + 1) * dt;
    this.anchorAndColliders(t, context.tick * dt);
    this.sampleEnvironment(t, dt);
    this.updateRigidCapsules(context.inputs.get(BODIES_FIELD.name), dt);
    const config = this.words(this.config);
    config[3] = dt;
    config[4] = exp(-this.damping * dt);
    const checks = this.native.advance_strands(
      this.nodes.byteOffset,
      this.material.byteOffset,
      this.environment.byteOffset,
      this.scratch.byteOffset,
      this.roots.byteOffset,
      this.obstacles.byteOffset,
      this.config.byteOffset,
      this.links.byteOffset,
      this.buckets.byteOffset,
      this.count,
      this.guides.length,
      this.colliders.length,
      this.bucketCount,
      this.movingCapsules?.byteOffset ?? this.config.byteOffset,
      this.rigidCapsules.length,
      this.capsuleHits?.byteOffset ?? this.config.byteOffset,
      this.reactions?.byteOffset ?? this.config.byteOffset,
      this.rigidRows,
      this.directBlocks?.byteOffset ?? this.config.byteOffset,
      this.previousObstacles?.byteOffset ?? this.config.byteOffset,
      this.rigidMasses?.byteOffset ?? this.config.byteOffset,
    );
    if (checks < 0)
      throw new MargoError(
        'failed',
        'The direct rod constraint matrix became singular. Increase the solver rate or use fewer points on this guide.',
      );
    const ledger = this.words(this.ledger);
    ledger[0]! += checks;
    ledger.set(context.cell, 1);
  }

  exportPorts(tick: number): readonly Port[] {
    const cell = xyz(this.words(this.ledger), 1);
    const ports = [{ field: this.field.name, region: this.nodes, tick, cell }];
    if (this.reactions) ports.push({ field: BODY_IMPULSES_FIELD.name, region: this.reactions, tick, cell });
    return ports;
  }
  importPorts(): void {}
  stateRegions(): readonly Region[] {
    return [this.nodes, this.material, this.config, this.ledger];
  }
  extraState(): readonly Region[] {
    if (!this.reactions) return [];
    return this.swept && this.movingCapsules ? [this.reactions, this.movingCapsules] : [this.reactions];
  }

  /** The current point in an authored guide. */
  sample(strand: number, point: number): StrandReading {
    const guide = this.guides[strand];
    if (!guide || !Number.isInteger(point) || point < 0 || point >= guide.count)
      invalid('Choose an existing strand and point index.');
    const at = STRAND_WORDS * (guide.first + point),
      state = this.words(this.nodes);
    return {
      position: xyz(state, at),
      velocity: xyz(state, at + 3),
      rotation: quaternion(state, at + 6),
      spin: xyz(state, at + 10),
    };
  }

  /** Number of candidate self-contact pairs checked since initialization. */
  get candidatePairs(): number {
    return this.words(this.ledger)[0]!;
  }
}
