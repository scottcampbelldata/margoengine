/// <reference lib="esnext.disposable" preserve="true" />
// Soft bodies: ropes, cloth and particle meshes on their own small Rust kernel (compliant distance constraints, Macklin,
// Mueller and Chentanez, "XPBD", 2016; many small steps, Macklin et al., 2019), coupled both ways with the rigid world.
import { MargoError } from '@margoengine/math/errors';
import { LoadOnce } from '../../shared/load-once.js';
import type { PhysicsBody } from './body.js';
import type { PhysicsCollider } from './collider.js';
import type { ColliderSettings } from './shapes.js';
import { checkVec, type Quat, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import { bindSkin, boundaryTriangles, boundsOf, reaches, type Skin } from './soft-volume.js';
import { crossesBlade, type SoftDestination, type SoftSplit, splitBody } from './soft-split.js';

export type { SoftDestination, SoftSplit } from './soft-split.js';

interface SoftExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  soft_reserve(particles: number, edges: number, bodies: number, colliders: number): void;
  soft_column(id: number): number;
  soft_step(dt: number, substeps: number, iterations: number, gx: number, gy: number, gz: number): void;
  soft_begin(dt: number): void;
  soft_pre(h: number, iterations: number, gx: number, gy: number, gz: number): void;
  soft_apply(h: number, tau: number): void;
  soft_post(h: number): void;
  soft_finish(): void;
  soft_cloth_reserve(triangles: number, contacts: number): number;
  soft_cloth_enable(triangles: number, thickness: number, friction: number): void;
  soft_attach_reserve(attachments: number): void;
  soft_face_reserve(faces: number): void;
  soft_volume_reserve(triangles: number): void;
  soft_volume(body: number): number;
  soft_torn(): number;
  soft_hash(): number;
  soft_fem_reserve(tets: number, clusters: number, members: number): void;
  soft_fem_column(id: number): number;
  soft_tet_set(
    t: number,
    a: number,
    b: number,
    c: number,
    d: number,
    mu: number,
    lambda: number,
    model: number,
  ): number;
  soft_cluster_set(c: number, start: number, count: number, omega: number): void;
  soft_fem_damping(damping: number): void;
  soft_fem_torn(): number;
  soft_fem_trim(tets: number, clusters: number, members: number): void;
  soft_fem_reserve_elements(edges: number, bodies: number): void;
  soft_fem_step_begin(): void;
  soft_fem_proxies(h: number): void;
  soft_fem_implicit_settings(tolerance: number, iterations: number, dense: number): void;
  soft_fem_reserve_particles(particles: number): void;
}

/** The kinds of structural edge a woven sheet has; 0 is any other, with the material's edge softness. */
const THREAD_WARP = 1;
const THREAD_WEFT = 2;
const THREAD_SHEAR = 3;
const PINNED = 1;
const TARGETED = 2;
const TORN = 1;
/** An edge that resists stretch and not squeeze. */
const TENSION = 2;
const INTEGER_COLUMNS = new Set([
  'pflags',
  'pbody',
  'ea',
  'eb',
  'eflags',
  'c_kind',
  'b_on',
  'b_first',
  'b_count',
  'kc',
  'at_p',
  'at_row',
  'bsleep',
  'vtri',
  'vb_on',
  'vb_first',
  'vb_count',
  'fc_a',
  'fc_b',
  'fc_c',
  'fc_row',
]);
const TORN_CELL = 1;
const INTEGER_CELL_COLUMNS = new Set([
  'p0',
  'p1',
  'p2',
  'p3',
  'model',
  'flags',
  'cstart',
  'ccount',
  'member',
  'cbody',
  'nb0',
  'nb1',
  'nb2',
  'nb3',
  'e_flow',
  'bd_tear_max',
  'bd_min_piece',
  'cproxy',
]);
const NO_NEIGHBOUR = 0xffffffff;
const CELL_MODEL = { 'neo-hookean': 0, corotated: 1, volume: 2 } as const;
const INTERIOR_CELL = 2;
const IMPLICIT_CELL = 4;

let columnNames: readonly string[] = [];
let cellColumnNames: readonly string[] = [];
// The blueprint (the deflated kernel) is a chunk of its own: an app that imports this entry but never attaches soft bodies
// does not download it.
const compiled = new LoadOnce<WebAssembly.Module>(async () => {
  const blueprint = await import('./soft-wasm.js');
  columnNames = blueprint.softColumns;
  cellColumnNames = blueprint.femColumns;
  const bytes = Uint8Array.from(atob(blueprint.wasmBase64), (c) => c.charCodeAt(0));
  return WebAssembly.compile(
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer(),
  );
});

/** A spring's stiffness as a frequency and a damping ratio; a natural frequency of 0 makes the constraint rigid. */
export interface SoftSoftness {
  /** Hertz: how fast the constraint's own motion rings. 0 holds it rigid (default for edges). */
  naturalFrequency: number;
  /** 1 settles without overshoot; below 1 rings, above 1 creeps. */
  dampingRatio: number;
}

/** What a soft body is made of (Rapier's `SoftBodyMaterial`, for the elements this entry has). */
export class SoftBodyMaterial {
  /** Structural and shear edges (default rigid: they do not stretch). */
  edgeSoftness: SoftSoftness = { naturalFrequency: 0, dampingRatio: 1 };
  /**
   * The threads of a woven sheet (`cloth`, `clothTube`, `clothAnisotropic`) each have a spring of their own: along the warp (the
   * builder's `du`), along the weft (`dv`) and across the diagonals of each cell, the shear; left out (null, the default),
   * each is {@link SoftBodyMaterial.edgeSoftness}, which is also every other edge's. A natural frequency of 0 holds a thread
   * rigid; a lower one lets it stretch, by about the square of the frequency's ratio between two threads under one load.
   */
  warpSoftness: SoftSoftness | null = null;
  weftSoftness: SoftSoftness | null = null;
  shearSoftness: SoftSoftness | null = null;
  /** Bend edges, which join a particle to the one two along (default 10 Hz, critically damped). */
  bendSoftness: SoftSoftness = { naturalFrequency: 10, dampingRatio: 1 };
  /**
   * Stretch past this fraction of an edge's rest length tears it at the end of the step (0, the default, never tears). Only
   * structural and shear edges tear; a torn edge stays torn.
   */
  tearStrain = 0;
  /**
   * The spring that pulls every particle toward its place in the best-fit rotated rest shape, for a body with shape matching
   * on (default rigid, 0 Hz).
   */
  shapeMatchingSoftness: SoftSoftness = { naturalFrequency: 0, dampingRatio: 1 };
  /** The spring that holds a closed surface to its volume (default rigid: the volume is held exactly). */
  volumeSoftness: SoftSoftness = { naturalFrequency: 0, dampingRatio: 1 };
  /**
   * Plastic flow of the structural edges: a stretch or squeeze (per its `edgePlasticFlow`) past this fraction of the rest length
   * moves the rest length, so the edge keeps the set (0, the default, is elastic all the way).
   */
  edgePlasticYield = 0;
  /** How fast an edge flows, per second (0, the default: at once). */
  edgePlasticCreep = 0;
  /** The most an edge's rest length may change in all, as a fraction of the length it was made with (0: no cap). */
  edgePlasticMax = 0;
  /** Which way an edge flows: when squeezed, when stretched or either (default). */
  edgePlasticFlow: 'compression' | 'stretch' | 'both' = 'both';
  /**
   * A structural edge pulled with more force than this, in newtons, tears at the end of the step (0, the default, never). The
   * force is the constraint's multiplier over the step squared, so it reads as the force that holds the edge at its length.
   */
  tearForce = 0;
  /** Seconds over which an edge's load is smoothed before it is tested against its tear threshold, so a spike does not tear (default 0: not smoothed). */
  tearSmoothing = 0;
  /** The most elements this body tears in one step, the most loaded first (0, the default, any number). A load past twice its threshold tears regardless. */
  maxTearsPerStep = 0;
  /** The fewest cells a tear may split off as a piece of its own; a tear that would leave fewer waits (0 or 1, the default: any). */
  minPiece = 0;
  /** Both edge kinds as one spring, Rapier's `SoftBodyMaterial.uniform(freq, damping)`. */
  static uniform(naturalFrequency: number, dampingRatio: number): SoftBodyMaterial {
    const material = new SoftBodyMaterial();
    material.edgeSoftness = { naturalFrequency, dampingRatio };
    material.bendSoftness = { naturalFrequency, dampingRatio };
    return material;
  }
  /** @internal */
  clone(): SoftBodyMaterial {
    const copy = new SoftBodyMaterial();
    copy.edgeSoftness = { ...this.edgeSoftness };
    copy.bendSoftness = { ...this.bendSoftness };
    copy.warpSoftness = this.warpSoftness && { ...this.warpSoftness };
    copy.weftSoftness = this.weftSoftness && { ...this.weftSoftness };
    copy.shearSoftness = this.shearSoftness && { ...this.shearSoftness };
    copy.tearStrain = this.tearStrain;
    copy.shapeMatchingSoftness = { ...this.shapeMatchingSoftness };
    copy.volumeSoftness = { ...this.volumeSoftness };
    copy.edgePlasticYield = this.edgePlasticYield;
    copy.edgePlasticCreep = this.edgePlasticCreep;
    copy.edgePlasticMax = this.edgePlasticMax;
    copy.edgePlasticFlow = this.edgePlasticFlow;
    copy.tearForce = this.tearForce;
    copy.tearSmoothing = this.tearSmoothing;
    copy.maxTearsPerStep = this.maxTearsPerStep;
    copy.minPiece = this.minPiece;
    return copy;
  }
}

/**
 * How the vertices of a deformable collider follow a soft body (Rapier's `SoftMeshBinding`): `direct(particles)` (vertex `i`
 * is particle `particles[i]`), `directByPosition(eps)` (each vertex is its nearest particle within `eps` metres) and
 * `skinned()` (each vertex is embedded in the tetrahedral cell that holds it, and moves with the cell's corners).
 */
export class SoftMeshBinding {
  /** @internal */
  private constructor(
    readonly mode: 'direct' | 'directByPosition' | 'skinned',
    readonly particles: readonly number[],
    readonly eps: number,
  ) {}
  static direct(particles: ArrayLike<number>): SoftMeshBinding {
    return new SoftMeshBinding('direct', Array.from(particles), 0);
  }
  static directByPosition(eps: number): SoftMeshBinding {
    if (!(eps > 0 && Number.isFinite(eps))) throw new RangeError('eps must be a positive number of metres.');
    return new SoftMeshBinding('directByPosition', [], eps);
  }
  static skinned(): SoftMeshBinding {
    return new SoftMeshBinding('skinned', [], 0);
  }
}

/**
 * What a soft contact hook may edit about one contact of a soft body with a collider before the step uses it (Rapier's
 * `modify_solver_contacts` for soft bodies): the plane (`normal` out of the collider, `point` on it, both at the start of
 * the step), the speed of the surface there, the friction, and whether it counts at all. A contact is a particle's, or a
 * face's (`face` set): the point of one of the body's triangles that faces a collider smaller than the spacing of the
 * particles or lying between them.
 */
export interface SoftContact {
  readonly soft: SoftBody;
  /** The particle, by its index in the body; for a face, the corner with the largest weight. */
  readonly particle: number;
  /** For a face's contact, its three corners by their indices in the body; null for a particle's. */
  readonly face: readonly [number, number, number] | null;
  /** For a face's contact, the weights of its corners at the point facing the collider (they add to 1); null for a particle's. */
  readonly weights: readonly [number, number, number] | null;
  readonly collider: PhysicsCollider;
  /** The particle's velocity now; for a face, the velocity of its point facing the collider. */
  readonly particleVelocity: Vec3;
  normal: Vec3;
  point: Vec3;
  velocity: Vec3;
  friction: number;
  /** Set false to leave the contact out: the particle passes through. */
  enabled: boolean;
}

/** A deformable collider bound to a soft body: where each vertex gets its place. @internal */
interface BoundMesh {
  soft: SoftBody;
  host: PhysicsBody;
  /** Per vertex, the particles it follows (one for a direct binding, four for a skinned one) and their weights. */
  particles: Uint32Array;
  weights: Float32Array;
  per: number;
}

/** The elastic model of a body's cells. */
/**
 * How a body's cells are solved: `'constraints'` (default) as XPBD constraints, whose stiffness grows with the substeps and passes
 * a step is given; `'fem'` as one linear solve a substep (a linearly implicit step, Baraff and Witkin 1998), whose stiffness does not,
 * the choice for very stiff materials. Cells of the `'volume'` model are always constraints.
 */
export type SoftSolver = 'constraints' | 'fem';

/** The elastic model of a body's cells: see {@link CellMaterial.model}. */
export type CellModel = 'neo-hookean' | 'corotated' | 'volume';

/**
 * What the tetrahedral cells of a soft body are made of. The defaults are a soft rubber that is elastic all the way and never
 * tears; set `yieldStrain` for a body that keeps a set (clay, putty, bent metal) and `tearStrain` for one that breaks.
 */
export class CellMaterial {
  /** Stiffness in pascals (default 100 kPa, soft rubber). */
  youngsModulus = 1e5;
  /** How much a stretched body thins: 0 to below 0.5 (default 0.3); near 0.5 it keeps its volume. */
  poissonRatio = 0.3;
  /**
   * `'neo-hookean'` (default) is the stable Neo-Hookean of Smith, de Goes and Kim (2018) held by the constraints of Macklin and
   * Mueller (2021): an inverted cell comes back and nothing locks near zero volume. `'corotated'` is the co-rotated linear
   * elasticity of Mueller and Gross (2004): stiffer for a given modulus at small strain. `'volume'` is one constraint on each cell's
   * volume, held by the bulk modulus, and nothing else: the cheapest, with the shape left to the edges; it never flows or tears.
   */
  model: CellModel = 'neo-hookean';
  /**
   * Damping of the elastic body as a share of critical for a cell's own shear wave (default 0): the cell's constraints lose
   * 2 x this x the cell's wave frequency (shear modulus over density, over its size) of their speed each second, on top of
   * `deformationDamping`. It damps deformation, not the body's motion as a whole.
   */
  elasticDampingRatio = 0;
  /**
   * What the cells' constraints lose of their speed each second, whatever the cell (null, the default: `soft.cellDamping`, 10 per
   * second). Raise it for a body that wobbles after an impact.
   */
  deformationDamping: number | null = null;
  /** Kilograms per cubic metre, for the mass the cells give their particles when no mass was set (default 1000). */
  density = 1000;
  /**
   * Plastic flow: the shape change (the Frobenius norm of the stretch's deviatoric strain) a cell holds before it starts to flow
   * and keep a set, as the multiplicative plasticity of Bargteil et al. (2007). 0 (default) is elastic all the way.
   */
  yieldStrain = 0;
  /** How fast flow follows, per second (default 0: at once, so the cell never holds more than its yield strain). */
  creep = 0;
  /**
   * The most a cell may flow in all, as the sum of the deviatoric strain it has handed to its rest shape (default 0: no cap), so a
   * body bends only so far.
   */
  plasticMax = 0;
  /** Rapier's name for {@link CellMaterial.yieldStrain}. */
  get plasticYield(): number {
    return this.yieldStrain;
  }
  set plasticYield(value: number) {
    this.yieldStrain = value;
  }
  /** Rapier's name for {@link CellMaterial.creep}. */
  get plasticCreep(): number {
    return this.creep;
  }
  set plasticCreep(value: number) {
    this.creep = value;
  }
  /** Seconds over which a cell's load is smoothed before it is tested against `tearStrain` (default 0: not smoothed). */
  tearSmoothing = 0;
  /**
   * How much tougher a cell is that has no outside face and no torn neighbour (default 1: no difference), so tears start at the
   * surface and at damage; the factor multiplies `tearStrain` there.
   */
  interiorStrength = 1;
  /**
   * The stretch (the Frobenius norm of the stretch's strain, about 1.7 times the stretch fraction along one axis) past which a cell
   * is removed at the end of the step (0, the default, never). A torn cell stays torn.
   */
  tearStrain = 0;
  /** @internal */
  clone(): CellMaterial {
    return Object.assign(new CellMaterial(), this);
  }
  /** @internal The Lame parameters. */
  lame(): [number, number] {
    const e = this.youngsModulus,
      nu = this.poissonRatio;
    return [e / (2 * (1 + nu)), (e * nu) / ((1 + nu) * (1 - 2 * nu))];
  }
}

function checkCellMaterial(m: CellMaterial): void {
  if (!(m.youngsModulus > 0 && Number.isFinite(m.youngsModulus)))
    throw new RangeError("Young's modulus must be a positive number of pascals.");
  if (!(m.poissonRatio >= 0 && m.poissonRatio < 0.5))
    throw new RangeError("Poisson's ratio must be 0 or more and below 0.5.");
  if (m.model !== 'neo-hookean' && m.model !== 'corotated' && m.model !== 'volume')
    throw new RangeError("Cell model must be 'neo-hookean', 'corotated' or 'volume'.");
  if (!(m.elasticDampingRatio >= 0 && Number.isFinite(m.elasticDampingRatio)))
    throw new RangeError('elasticDampingRatio must be 0 or more.');
  if (m.deformationDamping !== null && !(m.deformationDamping >= 0 && Number.isFinite(m.deformationDamping)))
    throw new RangeError('deformationDamping must be null, 0 or more.');
  for (const [value, label] of [
    [m.plasticMax, 'plasticMax'],
    [m.tearSmoothing, 'tearSmoothing'],
  ] as const)
    if (!(value >= 0 && Number.isFinite(value))) throw new RangeError(`${label} must be 0 or more.`);
  if (!(m.interiorStrength >= 1 && Number.isFinite(m.interiorStrength)))
    throw new RangeError('interiorStrength must be 1 (no difference) or more.');
  if (!(m.density > 0 && Number.isFinite(m.density)))
    throw new RangeError('Density must be a positive number of kg/m3.');
  for (const [value, label] of [
    [m.yieldStrain, 'yieldStrain'],
    [m.creep, 'creep'],
    [m.tearStrain, 'tearStrain'],
  ] as const)
    if (!(value >= 0 && Number.isFinite(value))) throw new RangeError(`${label} must be 0 or more.`);
}

/** Where a body's cells, clusters and cluster members sit in the kernel's rows. */
interface CellRange {
  first: number;
  count: number;
  clusterFirst: number;
  clusterCount: number;
  memberFirst: number;
  memberCount: number;
}
/** A cluster of a body: the particles it holds, and what was set for it. */
interface ClusterInfo {
  members: number[];
  /** Natural frequency of its shape matching spring, hertz, and whether it is on. */
  hertz: number;
  matching: boolean;
  stiffness: number;
  edgeSoftness: SoftSoftness | null;
  tearResistance: number;
  proxy: PhysicsBody | null;
  /** The velocities its proxy was last given, to see what the rigid world did to it. */
  lin: Vec3;
  ang: Vec3;
}
const DEFAULT_CLUSTER_HERTZ = 10;

const NO_CELLS: CellRange = { first: 0, count: 0, clusterFirst: 0, clusterCount: 0, memberFirst: 0, memberCount: 0 };

/** Six times the signed volume of the tetrahedron `a b c d` in a flat list of positions. */
function tetDeterminant(p: ArrayLike<number>, a: number, b: number, c: number, d: number): number {
  const ux = p[b * 3]! - p[a * 3]!,
    uy = p[b * 3 + 1]! - p[a * 3 + 1]!,
    uz = p[b * 3 + 2]! - p[a * 3 + 2]!,
    vx = p[c * 3]! - p[a * 3]!,
    vy = p[c * 3 + 1]! - p[a * 3 + 1]!,
    vz = p[c * 3 + 2]! - p[a * 3 + 2]!,
    wx = p[d * 3]! - p[a * 3]!,
    wy = p[d * 3 + 1]! - p[a * 3 + 1]!,
    wz = p[d * 3 + 2]! - p[a * 3 + 2]!;
  return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
}

function checkSoftness(softness: SoftSoftness, label: string): void {
  if (!(softness.naturalFrequency >= 0 && Number.isFinite(softness.naturalFrequency)))
    throw new RangeError(`${label}: natural frequency must be 0 (rigid) or a positive number of hertz.`);
  if (!(softness.dampingRatio >= 0 && Number.isFinite(softness.dampingRatio)))
    throw new RangeError(`${label}: damping ratio must be 0 or more.`);
}

function checkMaterial(material: SoftBodyMaterial): void {
  checkSoftness(material.edgeSoftness, 'Edge softness');
  checkSoftness(material.bendSoftness, 'Bend softness');
  if (material.warpSoftness) checkSoftness(material.warpSoftness, 'Warp softness');
  if (material.weftSoftness) checkSoftness(material.weftSoftness, 'Weft softness');
  if (material.shearSoftness) checkSoftness(material.shearSoftness, 'Shear softness');
  checkSoftness(material.shapeMatchingSoftness, 'Shape matching softness');
  checkSoftness(material.volumeSoftness, 'Volume softness');
  if (!(material.tearStrain >= 0 && Number.isFinite(material.tearStrain)))
    throw new RangeError('tearStrain must be 0 (never) or the stretch fraction that tears an edge.');
  for (const [value, label] of [
    [material.edgePlasticYield, 'edgePlasticYield'],
    [material.edgePlasticCreep, 'edgePlasticCreep'],
    [material.edgePlasticMax, 'edgePlasticMax'],
    [material.tearForce, 'tearForce'],
    [material.tearSmoothing, 'tearSmoothing'],
    [material.maxTearsPerStep, 'maxTearsPerStep'],
    [material.minPiece, 'minPiece'],
  ] as const)
    if (!(value >= 0 && Number.isFinite(value))) throw new RangeError(`${label} must be 0 or more.`);
  if (!['compression', 'stretch', 'both'].includes(material.edgePlasticFlow))
    throw new RangeError("edgePlasticFlow must be 'compression', 'stretch' or 'both'.");
}

/** A rotation is four finite numbers, not all zero, as `PhysicsBody.setRotation` asks (this entry may not import the body). */
function checkRotation(rotation: Quat): void {
  const [x, y, z, w] = rotation,
    squared = rotation.length === 4 ? x * x + y * y + z * z + w * w : 0;
  if (!(squared > 0) || !Number.isFinite(squared))
    throw new RangeError('A rotation must be a quaternion [x, y, z, w] of finite numbers, not all zero.');
}

const count = (value: number, label: string, least: number): number => {
  if (!Number.isInteger(value) || value < least) throw new RangeError(`${label} is a whole number, at least ${least}.`);
  return value;
};

/**
 * A soft body before it exists: particles, the edges that hold them and their settings. Builders (`rope`, `cloth`,
 * `clothTube`) and `new SoftBodyDesc(positions)` make one; every setter returns it. Insert it with `SoftBodies.create`.
 */
export class SoftBodyDesc {
  /** @internal */ positions: number[];
  /** @internal */ edgePairs: number[] = [];
  /** @internal Which thread each structural edge is (0 for any other), by index as `edgePairs`. */ edgeKinds: number[] =
    [];
  /** @internal */ bendPairs: number[] = [];
  /** @internal The grid a woven sheet was built on (particle (i, j) is i * nv + j), for its texture coordinates. */
  grid: { nu: number; nv: number; wrap: boolean } | null = null;
  /** @internal */ masses: number[];
  /** @internal */ pinned = new Set<number>();
  /** @internal */ radius: number | null = null;
  /** @internal */ material = new SoftBodyMaterial();
  /** @internal */ gravity = 1;
  /** @internal */ damping = 0;
  /** @internal */ shift: Vec3 = [0, 0, 0];
  /** @internal */ shapeMatching = false;
  /** @internal */ volumeFactor: number | null = null;
  /** @internal */ groups: number | undefined = undefined;
  /** @internal */ selfContacts = false;
  /** @internal */ selfFriction = 0;
  /** @internal Dominance group: a body of a higher one is not pushed by this one, and one of a lower one is pushed whole. */
  dominance = 0;
  /** @internal */
  canSleep = true;
  /** @internal Extra constraint passes for this body's step. */
  additionalIterations = 0;
  /** @internal The collider of the body's own surface, made when it is created (null: none, the default). */
  surfaceSettings: Omit<ColliderSettings, 'offset' | 'rotation'> | null = null;
  /** @internal Whether the surface knows its outside (undefined: when the surface is closed). */
  oriented: boolean | undefined = undefined;
  /** @internal Every edge resists stretch only (true), or just the listed ones (indices of the edges, then the bend edges). */
  tension: boolean | number[] = false;
  /** @internal */ triangles: number[] = [];
  /** @internal Four particle indices per tetrahedron. */ cells: number[] = [];
  /** @internal */ cellMaterial = new CellMaterial();
  /** @internal Particle indices of each shape-matching cluster. */ clusterGroups: number[][] = [];
  /** @internal */ clusterHertz = 0;
  /** @internal Whether a mass was given, so the cells' density does not set one. */ massGiven = false;
  /** @internal A mesh that rides in the cells. */ skin: Skin | null = null;
  /** @internal */ solver: SoftSolver = 'constraints';

  /** Raw particles from flat x, y, z numbers or a list of points; add the elements with `setEdges`. */
  constructor(positions: ArrayLike<number> | readonly Vec3[]) {
    const flat: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const item = positions[i] as number | Vec3;
      if (typeof item === 'number') flat.push(item);
      else {
        checkVec(item, 'Particle position');
        flat.push(item[0], item[1], item[2]);
      }
    }
    if (flat.length % 3 !== 0 || flat.some((v) => !Number.isFinite(v)))
      throw new RangeError('Particle positions must be finite numbers, three per particle.');
    this.positions = flat;
    this.masses = new Array<number>(flat.length / 3).fill(1);
  }

  /** Number of particles. */
  get particleCount(): number {
    return this.positions.length / 3;
  }

  /**
   * A rope of `particles` particles from `start` to `end`, joined by edges and, unless `bending` is false, by bend edges that
   * give it some stiffness.
   */
  static rope(start: Vec3, end: Vec3, particles: number, { bending = true }: { bending?: boolean } = {}): SoftBodyDesc {
    checkVec(start, 'Rope start');
    checkVec(end, 'Rope end');
    count(particles, 'A rope has particles; the count', 2);
    const points: number[] = [];
    for (let i = 0; i < particles; i++) {
      const t = i / (particles - 1);
      points.push(
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
        start[2] + (end[2] - start[2]) * t,
      );
    }
    const desc = new SoftBodyDesc(points);
    for (let i = 0; i + 1 < particles; i++) desc.edgePairs.push(i, i + 1);
    if (bending) for (let i = 0; i + 2 < particles; i++) desc.bendPairs.push(i, i + 2);
    return desc;
  }

  /**
   * A sheet of `nu` by `nv` particles: particle (i, j) is at `origin + i*du + j*dv` and has index `i * nv + j`. It has
   * structural edges along both directions, shear edges across each cell and bend edges two along.
   */
  static cloth(origin: Vec3, du: Vec3, dv: Vec3, nu: number, nv: number): SoftBodyDesc {
    return SoftBodyDesc.sheet(origin, du, dv, nu, nv, false);
  }

  /** Like {@link SoftBodyDesc.cloth}, closed around its `u` direction into a tube: particle (nu - 1, j) joins particle (0, j). */
  static clothTube(origin: Vec3, du: Vec3, dv: Vec3, nu: number, nv: number): SoftBodyDesc;
  /**
   * Rapier's `cloth_tube`: `numAlong` rings of `numAround` particles from `origin` to `origin + axis`, the radius going
   * linearly from `radiusStart` to `radiusEnd`; ring `k` is particles `k * numAround` to `(k + 1) * numAround - 1`.
   */
  static clothTube(
    origin: Vec3,
    axis: Vec3,
    radiusStart: number,
    radiusEnd: number,
    numAround: number,
    numAlong: number,
  ): SoftBodyDesc;
  static clothTube(origin: Vec3, a: Vec3, b: number | Vec3, c: number, d: number, e?: number): SoftBodyDesc {
    if (typeof b === 'number') {
      const axis = a,
        radiusStart = b,
        radiusEnd = c,
        around = d,
        along = e!;
      checkVec(origin, 'Tube origin');
      checkVec(axis, 'Tube axis');
      if (!(radiusStart >= 0 && radiusEnd >= 0 && Number.isFinite(radiusStart) && Number.isFinite(radiusEnd)))
        throw new RangeError('Tube radii must be 0 or more metres.');
      count(around, 'A tube has particles around; the count', 3);
      count(along, 'A tube has rings along it; the count', 2);
      const length = Math.hypot(axis[0], axis[1], axis[2]);
      if (!(length > 0)) throw new RangeError('The tube axis must have a length.');
      const k: Vec3 = [axis[0] / length, axis[1] / length, axis[2] / length],
        // Any unit vector across the axis, then the one across both.
        helper: Vec3 = Math.abs(k[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0],
        cross = (p: Vec3, q: Vec3): Vec3 => [
          p[1] * q[2] - p[2] * q[1],
          p[2] * q[0] - p[0] * q[2],
          p[0] * q[1] - p[1] * q[0],
        ],
        n1 = cross(k, helper),
        l1 = Math.hypot(n1[0], n1[1], n1[2]),
        u: Vec3 = [n1[0] / l1, n1[1] / l1, n1[2] / l1],
        v = cross(k, u),
        points: number[] = [];
      // The weave wraps its `u` direction, which here goes around: particle (a, k) is at index a * along + k.
      for (let a_ = 0; a_ < around; a_++)
        for (let ring = 0; ring < along; ring++) {
          const t = ring / (along - 1),
            radius = radiusStart + (radiusEnd - radiusStart) * t,
            angle = (2 * Math.PI * a_) / around;
          points.push(
            origin[0] + axis[0] * t + (u[0] * Math.cos(angle) + v[0] * Math.sin(angle)) * radius,
            origin[1] + axis[1] * t + (u[1] * Math.cos(angle) + v[1] * Math.sin(angle)) * radius,
            origin[2] + axis[2] * t + (u[2] * Math.cos(angle) + v[2] * Math.sin(angle)) * radius,
          );
        }
      const tube = SoftBodyDesc.woven(points, around, along, true);
      // Rapier numbers a tube ring by ring: ring k holds particles k * numAround to (k + 1) * numAround - 1.
      const renumber = (old: number): number => (old % along) * around + Math.floor(old / along);
      const moved = new Array<number>(points.length);
      for (let old = 0; old < around * along; old++) {
        const at = renumber(old);
        for (let c_ = 0; c_ < 3; c_++) moved[at * 3 + c_] = tube.positions[old * 3 + c_]!;
      }
      tube.positions = moved;
      tube.edgePairs = tube.edgePairs.map(renumber);
      tube.bendPairs = tube.bendPairs.map(renumber);
      tube.triangles = tube.triangles.map(renumber);
      return tube;
    }
    count(d, 'A tube has particles around; the count', 3);
    return SoftBodyDesc.sheet(origin, a, b, c, d, true);
  }

  private static sheet(origin: Vec3, du: Vec3, dv: Vec3, nu: number, nv: number, wrap: boolean): SoftBodyDesc {
    checkVec(origin, 'Cloth origin');
    checkVec(du, 'Cloth du');
    checkVec(dv, 'Cloth dv');
    count(nu, 'Cloth nu', 2);
    count(nv, 'Cloth nv', 2);
    const points: number[] = [];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++)
        points.push(
          origin[0] + du[0] * i + dv[0] * j,
          origin[1] + du[1] * i + dv[1] * j,
          origin[2] + du[2] * i + dv[2] * j,
        );
    return SoftBodyDesc.woven(points, nu, nv, wrap);
  }

  /** The edges, triangles and threads of an `nu` by `nv` grid of particles, closed around `u` when `wrap`. */
  private static woven(points: number[], nu: number, nv: number, wrap: boolean): SoftBodyDesc {
    const desc = new SoftBodyDesc(points);
    desc.grid = { nu, nv, wrap };
    const at = (i: number, j: number): number => (((i % nu) + nu) % nu) * nv + j;
    const last = wrap ? nu : nu - 1;
    for (let i = 0; i < last; i++)
      for (let j = 0; j < nv; j++) {
        if (j + 1 < nv) desc.edgePairs.push(at(i, j), at(i, j + 1));
        desc.edgePairs.push(at(i, j), at(i + 1, j));
        if (j + 1 < nv) {
          desc.edgePairs.push(at(i, j), at(i + 1, j + 1), at(i + 1, j), at(i, j + 1));
          desc.triangles.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
        }
        if (j + 2 < nv) desc.bendPairs.push(at(i, j), at(i, j + 2));
        if (wrap || i + 2 < nu) desc.bendPairs.push(at(i, j), at(i + 2, j));
      }
    if (!wrap)
      for (let j = 0; j + 1 < nv; j++) {
        desc.edgePairs.push(at(nu - 1, j), at(nu - 1, j + 1));
        if (j + 2 < nv) desc.bendPairs.push(at(nu - 1, j), at(nu - 1, j + 2));
      }
    // Which thread each edge is: along the weft (one `u` row), along the warp (one `v` column) or across a cell.
    for (let e = 0; e < desc.edgePairs.length; e += 2) {
      const a = desc.edgePairs[e]!,
        b = desc.edgePairs[e + 1]!;
      desc.edgeKinds.push(
        Math.floor(a / nv) === Math.floor(b / nv) ? THREAD_WEFT : a % nv === b % nv ? THREAD_WARP : THREAD_SHEAR,
      );
    }
    return desc;
  }

  /**
   * A woven sheet whose threads have springs of their own: like {@link SoftBodyDesc.cloth}, with the warp along `du` and the
   * weft along `dv`, and the material's `warpSoftness`, `weftSoftness` and `shearSoftness` (and `bendSoftness`) setting how
   * each resists (after Thomaszewski, Wacker and Strasser, 2006, "A consistent bending model for cloth simulation with corotational
   * subdivision finite elements", for the bend, and the separate stretch and shear of Baraff and Witkin, 1998, and Wang, O'Brien and Ramamoorthi, 2011, "Data-driven
   * elastic models for cloth": an orthotropic sheet's stretch along each thread and its shear are separate).
   */
  static clothAnisotropic(
    origin: Vec3,
    du: Vec3,
    dv: Vec3,
    nu: number,
    nv: number,
    warp?: SoftSoftness,
    weft?: SoftSoftness,
    shear?: SoftSoftness,
  ): SoftBodyDesc {
    const desc = SoftBodyDesc.cloth(origin, du, dv, nu, nv);
    // Rapier's `cloth_anisotropic` takes the three springs here; they are the material's thread springs.
    if (warp || weft || shear) {
      const material = desc.material.clone();
      if (warp) material.warpSoftness = { ...warp };
      if (weft) material.weftSoftness = { ...weft };
      if (shear) material.shearSoftness = { ...shear };
      desc.setMaterial(material);
    }
    return desc;
  }

  /**
   * A mesh of triangles as particles at its vertices (flat x, y, z) and edges along its triangle edges, plus bend edges that
   * join the two vertices across each shared edge (unless `bending` is false). Shape matching is on, as in Rapier's `trimesh`,
   * so the body keeps its shape until you soften it with `shapeMatchingSoftness`. `triangles()` gives the mesh back.
   */
  static trimesh(
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
    { bending = true }: { bending?: boolean } = {},
  ): SoftBodyDesc {
    const desc = new SoftBodyDesc(vertices);
    if (indices.length % 3 !== 0 || indices.length === 0)
      throw new RangeError('Indices must be triangles, three per triangle.');
    const seen = new Map<number, number>(),
      key = (a: number, b: number): number => (a < b ? a * desc.particleCount + b : b * desc.particleCount + a),
      opposite = new Map<number, number[]>();
    for (let t = 0; t < indices.length; t += 3) {
      const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      for (const v of tri)
        if (!Number.isInteger(v) || v < 0 || v >= desc.particleCount)
          throw new RangeError(`Triangle index ${v} must be a vertex (0 to ${desc.particleCount - 1}).`);
      if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2])
        throw new RangeError(`Triangle ${t / 3} repeats a vertex; a triangle needs three different vertices.`);
      desc.triangles.push(...tri);
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!,
          b = tri[(k + 1) % 3]!,
          third = tri[(k + 2) % 3]!,
          id = key(a, b);
        if (!seen.has(id)) {
          seen.set(id, desc.edgePairs.length / 2);
          desc.edgePairs.push(Math.min(a, b), Math.max(a, b));
        }
        const list = opposite.get(id) ?? [];
        list.push(third);
        opposite.set(id, list);
      }
    }
    if (bending)
      for (const list of opposite.values())
        if (list.length === 2 && list[0] !== list[1] && !seen.has(key(list[0]!, list[1]!))) {
          seen.set(key(list[0]!, list[1]!), -1);
          desc.bendPairs.push(Math.min(list[0]!, list[1]!), Math.max(list[0]!, list[1]!));
        }
    desc.shapeMatching = true;
    return desc;
  }

  /**
   * Makes the body's triangles collide with each other and with those of other bodies that have it on (Rapier's
   * `setSelfContacts`, default off): cloth falling on itself stays outside itself, a particle radius apart, found before it
   * passes through by a continuous point-triangle and edge-edge search. `friction` is Coulomb's coefficient between touching
   * cloth (default 0.3). The body needs triangles (`cloth`, `clothTube`, `trimesh`). It costs a search every piece of a step.
   */
  setSelfContacts(on: boolean, { friction = 0.3 }: { friction?: number } = {}): this {
    if (!(friction >= 0 && Number.isFinite(friction))) throw new RangeError('Friction must be 0 or more.');
    this.selfContacts = on;
    this.selfFriction = friction;
    return this;
  }

  /**
   * Which colliders the particles meet, as a collider's packed `collisionGroups` word (membership in the high 16 bits, the
   * filter in the low 16): a particle meets a collider when each one's filter has a group the other is a member of.
   * Left out, every collider is met.
   */
  setCollisionGroups(groups: number): this {
    if (!Number.isInteger(groups) || groups < 0 || groups > 0xffffffff)
      throw new RangeError("Collision groups must be a packed 32-bit word, as a collider's collisionGroups.");
    this.groups = groups;
    return this;
  }

  /**
   * A ball of triangles: an icosphere of the given `radius` about `center`, subdivided `detail` times (0 is 12 vertices, 2 the
   * default is 162), with edges, bend edges across shared edges and the volume held (Rapier's `sphere`), so it squashes and
   * springs back as a rubber ball does. Soften it with `setSoftness` and the material's `volumeSoftness`; inflate it with
   * `setVolumeFactor`.
   */
  static sphere(center: Vec3, radius: number, options: number | { detail?: number } = {}): SoftBodyDesc {
    // Rapier's `sphere` takes the number of subdivisions third.
    const detail = typeof options === 'number' ? options : (options.detail ?? 2);
    checkVec(center, 'Sphere centre');
    if (!(radius > 0 && Number.isFinite(radius)))
      throw new RangeError('Sphere radius must be a positive number of metres.');
    count(detail, 'detail', 0);
    if (detail > 5) throw new RangeError('A sphere is subdivided at most 5 times.');
    const t = (1 + Math.sqrt(5)) / 2;
    const points: Vec3[] = [
      [-1, t, 0],
      [1, t, 0],
      [-1, -t, 0],
      [1, -t, 0],
      [0, -1, t],
      [0, 1, t],
      [0, -1, -t],
      [0, 1, -t],
      [t, 0, -1],
      [t, 0, 1],
      [-t, 0, -1],
      [-t, 0, 1],
    ];
    let faces = [
      0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4,
      2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ];
    for (let level = 0; level < detail; level++) {
      const middle = new Map<number, number>(),
        next: number[] = [],
        mid = (a: number, b: number): number => {
          const key = a < b ? a * 100000 + b : b * 100000 + a;
          let m = middle.get(key);
          if (m === undefined) {
            m = points.length;
            points.push([
              (points[a]![0] + points[b]![0]) / 2,
              (points[a]![1] + points[b]![1]) / 2,
              (points[a]![2] + points[b]![2]) / 2,
            ]);
            middle.set(key, m);
          }
          return m;
        };
      for (let f = 0; f < faces.length; f += 3) {
        const a = faces[f]!,
          b = faces[f + 1]!,
          c = faces[f + 2]!,
          ab = mid(a, b),
          bc = mid(b, c),
          ca = mid(c, a);
        next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
      }
      faces = next;
    }
    const vertices: number[] = [];
    for (const p of points) {
      const length = Math.hypot(p[0], p[1], p[2]);
      vertices.push(
        center[0] + (p[0] / length) * radius,
        center[1] + (p[1] / length) * radius,
        center[2] + (p[2] / length) * radius,
      );
    }
    return SoftBodyDesc.trimesh(vertices, faces).setShapeMatching(false).setVolumeFactor(1);
  }

  /**
   * Holds the enclosed volume of the body's closed triangle surface (outward-facing triangles) to `factor` times its volume
   * at creation: 1 keeps it, above 1 inflates, below 1 deflates (Rapier's `setVolumeFactor`). The spring is the material's
   * `volumeSoftness`; `null` turns it off.
   */
  setVolumeFactor(factor: number | null): this {
    if (factor !== null && !(factor > 0 && Number.isFinite(factor)))
      throw new RangeError('Volume factor must be a positive number.');
    this.volumeFactor = factor;
    return this;
  }

  /**
   * Makes every edge and bend edge resist stretching and not squeezing, as Rapier's `tension_only`: a slack rope does not push,
   * a taut one pulls. With a list, only those edges (indices into the edges, then the bend edges).
   */
  setTensionOnly(edges: boolean | readonly number[] = true): this {
    if (typeof edges !== 'boolean') {
      const total = (this.edgePairs.length + this.bendPairs.length) / 2;
      for (const e of edges)
        if (!Number.isInteger(e) || e < 0 || e >= total)
          throw new RangeError(`Edge ${e} is not one of the ${total} edges.`);
    }
    this.tension = typeof edges === 'boolean' ? edges : [...edges];
    return this;
  }

  /**
   * The dominance group of the body, from -128 to 127 as a rigid body's (default 0): the particles do not give way to a rigid
   * body of a higher group (it is as immovable to them as a fixed one), and a rigid body of a lower group is moved by the whole
   * correction while the particles hold their place.
   */
  setDominanceGroup(group: number): this {
    if (!Number.isInteger(group) || group < -128 || group > 127)
      throw new RangeError('A dominance group must be a whole number from -128 to 127.');
    this.dominance = group;
    return this;
  }

  /** Whether the body may fall asleep (default true; see {@link SoftBody.canSleep}). */
  setCanSleep(on: boolean): this {
    this.canSleep = on;
    return this;
  }

  /**
   * Extra constraint passes for this body each piece of a step (Rapier's `setAdditionalSolverIterations`): the world runs
   * `iterations` plus the most any of its soft bodies ask for.
   */
  setAdditionalSolverIterations(passes: number): this {
    count(passes, 'passes', 0);
    this.additionalIterations = passes;
    return this;
  }

  /**
   * Gives the body a surface collider of its own when it is created (see {@link SoftBodies.createSurfaceCollider}) with these
   * settings. A body has none by default: its particles and faces meet rigid bodies in the soft step; a surface collider is for
   * rays and queries.
   */
  setSurfaceCollider(settings: Omit<ColliderSettings, 'offset' | 'rotation'> = {}): this {
    this.surfaceSettings = { ...settings };
    return this;
  }

  /** The body has no surface collider of its own (the default). */
  setNoSurfaceCollider(): this {
    this.surfaceSettings = null;
    return this;
  }

  /**
   * Whether the surface collider knows its outside (Rapier's `setOriented`), so a point inside a closed surface is found
   * inside by queries; false makes a shell. Left out, it is oriented when the surface is closed (a body that holds a volume
   * or has a skin).
   */
  setOriented(oriented: boolean): this {
    this.oriented = oriented;
    return this;
  }

  /** Turns shape matching on or off (on for `trimesh`, off otherwise). It pulls the particles toward their rest shape. */
  setShapeMatching(on: boolean): this {
    this.shapeMatching = on;
    return this;
  }

  /**
   * A solid block of tetrahedral cells: `counts` cubes along x, y and z of side `cell` metres from `origin`, each cut into six
   * tetrahedra around a diagonal (Kuhn's triangulation, which matches across the faces of neighbouring cubes). Particle
   * (i, j, k) has index `(i * (ny + 1) + j) * (nz + 1) + k`. Pass `inside` to keep only the cubes whose centre it accepts, which
   * carves a ball, a ring or any other solid out of the grid; particles no kept cube uses are dropped and the rest renumbered in
   * the same order.
   */
  static solid(
    origin: Vec3,
    cell: number,
    counts: readonly [number, number, number],
    inside?: (x: number, y: number, z: number) => boolean,
    material: CellMaterial = new CellMaterial(),
  ): SoftBodyDesc {
    checkVec(origin, 'Block origin');
    if (!(cell > 0 && Number.isFinite(cell))) throw new RangeError('Cell size must be a positive number of metres.');
    const [nx, ny, nz] = counts.map((n) => count(n, 'Cell counts', 1)) as [number, number, number],
      py = ny + 1,
      pz = nz + 1,
      id = (i: number, j: number, k: number): number => (i * py + j) * pz + k,
      used = new Int32Array((nx + 1) * py * pz).fill(-1),
      kept: [number, number, number][] = [];
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        for (let k = 0; k < nz; k++)
          if (
            !inside ||
            inside(origin[0] + (i + 0.5) * cell, origin[1] + (j + 0.5) * cell, origin[2] + (k + 0.5) * cell)
          )
            kept.push([i, j, k]);
    if (kept.length === 0)
      throw new RangeError(
        'The solid has no cells: `inside` accepted no cube of the grid; widen the grid or accept more cubes.',
      );
    for (const [i, j, k] of kept)
      for (let a = 0; a < 2; a++)
        for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) used[id(i + a, j + b, k + c)] = 0;
    const points: number[] = [];
    for (let i = 0; i <= nx; i++)
      for (let j = 0; j < py; j++)
        for (let k = 0; k < pz; k++)
          if (used[id(i, j, k)] === 0) {
            used[id(i, j, k)] = points.length / 3;
            points.push(origin[0] + i * cell, origin[1] + j * cell, origin[2] + k * cell);
          }
    const tets: number[] = [];
    // The six paths from a cube's first corner to its last along its edges.
    const paths = [
      [0, 4, 6, 7],
      [0, 4, 5, 7],
      [0, 2, 6, 7],
      [0, 2, 3, 7],
      [0, 1, 5, 7],
      [0, 1, 3, 7],
    ];
    for (const [i, j, k] of kept) {
      const corner = (n: number): number => used[id(i + ((n >> 2) & 1), j + ((n >> 1) & 1), k + (n & 1))]!;
      for (const path of paths) tets.push(corner(path[0]!), corner(path[1]!), corner(path[2]!), corner(path[3]!));
    }
    const desc = new SoftBodyDesc(points).setCells(tets, material).setSurface();
    desc.radius = cell * 0.25;
    return desc;
  }

  /** A solid box of tetrahedral cells, `size` metres from `origin`, cut into `counts` cubes along each axis (see {@link SoftBodyDesc.solid}). */
  static box(
    origin: Vec3,
    size: Vec3,
    counts: readonly [number, number, number],
    material: CellMaterial = new CellMaterial(),
  ): SoftBodyDesc {
    checkVec(size, 'Block size');
    const cell = size[0] / counts[0];
    if (
      !(cell > 0) ||
      Math.abs(size[1] / counts[1] - cell) > cell * 1e-6 ||
      Math.abs(size[2] / counts[2] - cell) > cell * 1e-6
    )
      throw new RangeError('A box has cubic cells: size divided by counts must be the same along every axis.');
    return SoftBodyDesc.solid(origin, cell, counts, undefined, material);
  }

  /** Rapier's `cuboid`: a box of cells of `halfExtents` around `centre`, cut into `counts` cubes along each axis (see {@link SoftBodyDesc.box}). */
  static cuboid(
    centre: Vec3,
    halfExtents: Vec3,
    counts: readonly [number, number, number],
    material: CellMaterial = new CellMaterial(),
  ): SoftBodyDesc {
    checkVec(centre, 'Cuboid centre');
    checkVec(halfExtents, 'Cuboid half extents');
    return SoftBodyDesc.box(
      [centre[0] - halfExtents[0], centre[1] - halfExtents[1], centre[2] - halfExtents[2]],
      [halfExtents[0] * 2, halfExtents[1] * 2, halfExtents[2] * 2],
      counts,
      material,
    );
  }

  /**
   * Cells that fill a closed triangle mesh (flat vertices, three indices a triangle, outward): a lattice of cubes of side `size`
   * metres over the mesh's box, every cube kept that holds or touches the mesh, each cut into six tetrahedra. The body contains the
   * mesh rather than following it exactly, as Rapier's `volumetric` does. With `skinned` the mesh rides in the cells as a skin
   * (see {@link SoftBodyDesc.setSkin}), read back with `body.meshVertices()`.
   */
  static volumetric(
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
    size: number,
    skinned = false,
    material: CellMaterial = new CellMaterial(),
  ): SoftBodyDesc {
    if (vertices.length % 3 !== 0 || vertices.length === 0 || indices.length % 3 !== 0 || indices.length === 0)
      throw new RangeError('A volumetric body needs a mesh: vertices three numbers each, indices three to a triangle.');
    if (!(size > 0 && Number.isFinite(size))) throw new RangeError('Cell size must be a positive number of metres.');
    for (let i = 0; i < indices.length; i++)
      if (!Number.isInteger(indices[i]) || indices[i]! < 0 || indices[i]! >= vertices.length / 3)
        throw new RangeError(`Index ${indices[i]} must be a vertex (0 to ${vertices.length / 3 - 1}).`);
    const { min, max } = boundsOf(vertices),
      counts = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a]! - min[a]!) / size - 1e-9))) as [
        number,
        number,
        number,
      ],
      desc = SoftBodyDesc.solid(min, size, counts, reaches(vertices, indices, size), material);
    return skinned ? desc.setSkin(vertices, indices) : desc;
  }

  /**
   * A mesh that rides in the cells: each of its vertices is bound to the cell that holds it, at that cell's barycentric
   * coordinates, and `body.meshVertices()` reads the vertices where the cells have taken them. Draw the skin, not the cells.
   */
  setSkin(vertices: ArrayLike<number>, indices: ArrayLike<number>): this {
    if (this.cells.length === 0)
      throw new RangeError('A skin needs cells to ride in: build the body with cells first.');
    this.skin = bindSkin(vertices, indices, this.positions, this.cells);
    return this;
  }

  /**
   * Gives the body tetrahedral cells: four particle indices per cell, the shape the particles stand in now as the cell's rest
   * shape. A cell listed left-handed has its last two corners swapped. The cells carry the body's elasticity (and its plastic
   * flow and tearing, see {@link CellMaterial}), and when no mass was set they give each particle its share of their density.
   */
  setCells(tets: ArrayLike<number>, material?: CellMaterial): this {
    if (tets.length % 4 !== 0) throw new RangeError('Cells must be four particle indices each.');
    const next: number[] = [];
    for (let t = 0; t < tets.length / 4; t++) {
      const four = [0, 1, 2, 3].map((k) => tets[t * 4 + k]!);
      for (const index of four)
        if (!Number.isInteger(index) || index < 0 || index >= this.particleCount)
          throw new RangeError(`Cell ${t} uses ${index}, which is not a particle; use 0 to ${this.particleCount - 1}.`);
      if (new Set(four).size !== 4)
        throw new RangeError(`Cell ${t} repeats a particle; a cell needs four different particles.`);
      if (!(Math.abs(tetDeterminant(this.positions, four[0]!, four[1]!, four[2]!, four[3]!)) > 1e-18))
        throw new RangeError(`Cell ${t} must be flat: its four particles lie in one plane.`);
      next.push(...four);
    }
    this.cells = next;
    if (material) this.setCellMaterial(material);
    return this;
  }
  /**
   * Adds every edge of every cell as a structural edge that is not one already (rest length the distance now), so the edges and
   * the cells hold the body together: a `'volume'` cell holds only its volume, and these hold its shape. Edges of the cells never
   * overlap an edge set before.
   */
  addCellEdges(): this {
    const have = new Set<number>(),
      n = this.particleCount;
    for (let e = 0; e < this.edgePairs.length; e += 2)
      have.add(
        Math.min(this.edgePairs[e]!, this.edgePairs[e + 1]!) * n + Math.max(this.edgePairs[e]!, this.edgePairs[e + 1]!),
      );
    for (let t = 0; t < this.cells.length; t += 4)
      for (let a = 0; a < 4; a++)
        for (let b = a + 1; b < 4; b++) {
          const i = this.cells[t + a]!,
            j = this.cells[t + b]!,
            key = Math.min(i, j) * n + Math.max(i, j);
          if (!have.has(key)) {
            have.add(key);
            this.edgePairs.push(i, j);
          }
        }
    return this;
  }
  /**
   * Gives the body the triangles of the surface of its cells (every face a single cell has, facing outward): what a surface collider
   * is made of, and how a body of cells that tears gets surfaces on its cracks. `box`, `solid`, `volumetric` and `cuboid` call it.
   */
  setSurface(): this {
    this.triangles = boundaryTriangles(this.cells, this.positions);
    return this;
  }
  /** Picks how the body's cells are solved, Rapier's `setSolver` (see {@link SoftSolver}). */
  setSolver(solver: SoftSolver): this {
    if (solver !== 'constraints' && solver !== 'fem') throw new RangeError("Solver must be 'constraints' or 'fem'.");
    this.solver = solver;
    return this;
  }
  /** Replaces the cells' material (copied). */
  setCellMaterial(material: CellMaterial): this {
    checkCellMaterial(material);
    this.cellMaterial = material.clone();
    return this;
  }
  /**
   * Groups of particles held to their rest shape by shape matching (Mueller et al. 2005): each group is pulled toward its rest
   * shape turned and moved to where the group stands, as an implicit spring of `hertz` natural frequency, so it is stable at any
   * stiffness. A cluster keeps a body's overall shape whatever the cells do; the groups may overlap.
   */
  setClusters(groups: readonly ArrayLike<number>[], hertz: number): this {
    if (!(hertz > 0 && Number.isFinite(hertz)))
      throw new RangeError('Cluster stiffness must be a positive number of hertz.');
    this.clusterGroups = groups.map((group, g) => {
      if (group.length < 4) throw new RangeError(`Cluster ${g} has at least four particles.`);
      return Array.from(group, (index) => {
        if (!Number.isInteger(index) || index < 0 || index >= this.particleCount)
          throw new RangeError(
            `Cluster ${g} uses ${index}, which is not a particle; use 0 to ${this.particleCount - 1}.`,
          );
        return index;
      });
    });
    this.clusterHertz = hertz;
    return this;
  }
  /** @internal The masses the body is created with: the cells' density where none was given. */
  resolvedMasses(): number[] {
    if (this.massGiven || this.cells.length === 0) return this.masses;
    const out = new Array<number>(this.particleCount).fill(0),
      density = this.cellMaterial.density;
    for (let t = 0; t < this.cells.length; t += 4) {
      const volume =
        Math.abs(
          tetDeterminant(this.positions, this.cells[t]!, this.cells[t + 1]!, this.cells[t + 2]!, this.cells[t + 3]!),
        ) / 6;
      for (let k = 0; k < 4; k++) out[this.cells[t + k]!]! += (density * volume) / 4;
    }
    return out.map((m, i) => (m > 0 ? m : this.masses[i]!));
  }

  /** Replaces the structural edges, as pairs of particle indices. */
  setEdges(pairs: ArrayLike<number>): this {
    this.edgePairs = this.checkPairs(pairs, 'Edge');
    this.edgeKinds = [];
    return this;
  }
  /** Replaces the bend edges, as pairs of particle indices. */
  setBendEdges(pairs: ArrayLike<number>): this {
    this.bendPairs = this.checkPairs(pairs, 'Bend edge');
    return this;
  }
  /** Adds structural edges between particles that may belong to pieces joined with `append`; rest length is the distance now. */
  addEdges(pairs: ArrayLike<number>): this {
    this.edgePairs.push(...this.checkPairs(pairs, 'Edge'));
    return this;
  }
  private checkPairs(pairs: ArrayLike<number>, label: string): number[] {
    if (pairs.length % 2 !== 0) throw new RangeError(`${label}s must be pairs of particle indices.`);
    const out: number[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const index = pairs[i]!;
      if (!Number.isInteger(index) || index < 0 || index >= this.particleCount)
        throw new RangeError(`${label} index ${index} must be a particle (0 to ${this.particleCount - 1}).`);
      out.push(index);
    }
    for (let i = 0; i < out.length; i += 2)
      if (out[i] === out[i + 1])
        throw new RangeError(
          `${label} ${i / 2} joins particle ${out[i]} to itself; an edge needs two different particles.`,
        );
    return out;
  }
  /** Merges another description in: its particles follow this one's, and its indices are shifted to match. */
  append(other: SoftBodyDesc): this {
    const base = this.particleCount;
    // Two bodies merged are no longer one grid.
    if (other.particleCount) this.grid = null;
    this.positions.push(...other.positions);
    for (const t of other.triangles) this.triangles.push(t + base);
    this.shapeMatching = this.shapeMatching || other.shapeMatching;
    this.masses.push(...other.masses);
    // The kinds stay in step with the edges: pad what has none with 0 (any other edge).
    while (this.edgeKinds.length < this.edgePairs.length / 2) this.edgeKinds.push(0);
    for (let e = 0; e < other.edgePairs.length / 2; e++) this.edgeKinds.push(other.edgeKinds[e] ?? 0);
    for (const p of other.edgePairs) this.edgePairs.push(p + base);
    for (const p of other.bendPairs) this.bendPairs.push(p + base);
    for (const p of other.pinned) this.pinned.add(p + base);
    if (other.cells.length && !this.cells.length) this.cellMaterial = other.cellMaterial.clone();
    for (const p of other.cells) this.cells.push(p + base);
    for (const group of other.clusterGroups) this.clusterGroups.push(group.map((p) => p + base));
    if (other.clusterGroups.length && !this.clusterHertz) this.clusterHertz = other.clusterHertz;
    this.massGiven ||= other.massGiven;
    return this;
  }
  /** Particles that never move (infinite mass) unless a kinematic target moves them. */
  setPinnedParticles(indices: ArrayLike<number>): this {
    const next = new Set<number>();
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i]!;
      if (!Number.isInteger(index) || index < 0 || index >= this.particleCount)
        throw new RangeError(`Pinned index ${index} must be a particle (0 to ${this.particleCount - 1}).`);
      next.add(index);
    }
    this.pinned = next;
    return this;
  }
  /** Mass of every particle in kilograms (default 1). */
  setParticleMass(mass: number): this {
    if (!(mass > 0 && Number.isFinite(mass)))
      throw new RangeError('Particle mass must be a positive number of kilograms.');
    this.masses.fill(mass);
    this.massGiven = true;
    return this;
  }
  /** Total mass, shared evenly. */
  setMass(mass: number): this {
    if (!(mass > 0 && Number.isFinite(mass))) throw new RangeError('Mass must be a positive number of kilograms.');
    return this.setParticleMass(mass / this.particleCount);
  }
  /** One mass per particle. */
  setMasses(masses: ArrayLike<number>): this {
    if (masses.length !== this.particleCount)
      throw new RangeError(`Give ${this.particleCount} masses, one per particle.`);
    const next = Array.from(masses);
    if (next.some((m) => !(m > 0 && Number.isFinite(m)))) throw new RangeError('Every particle mass must be positive.');
    this.masses = next;
    this.massGiven = true;
    return this;
  }
  /** Contact thickness of every particle in metres, and of the body's faces against rigid bodies (default: for a body of triangles the circumradius of its widest triangle; else half the shortest structural edge, or 0.01 with none). */
  setParticleRadius(radius: number): this {
    if (!(radius >= 0 && Number.isFinite(radius))) throw new RangeError('Particle radius must be 0 or more metres.');
    this.radius = radius;
    return this;
  }
  /** Edge and bend edge stiffness as one spring, Rapier's `setSoftness`. */
  setSoftness(naturalFrequency: number, dampingRatio: number): this {
    return this.setMaterial(
      Object.assign(SoftBodyMaterial.uniform(naturalFrequency, dampingRatio), { tearStrain: this.material.tearStrain }),
    );
  }
  /** Replaces the material (copied). */
  setMaterial(material: SoftBodyMaterial): this {
    checkMaterial(material);
    this.material = material.clone();
    return this;
  }
  /** Stretch fraction that tears an edge (0, the default, never): Rapier's `setEdgeTearResistance`. */
  setEdgeTearResistance(strain: number): this {
    const next = this.material.clone();
    next.tearStrain = strain;
    return this.setMaterial(next);
  }
  /** How much gravity pulls: 1 is the world's gravity (default), 0 none. */
  setGravityScale(scale: number): this {
    if (!Number.isFinite(scale)) throw new RangeError('Gravity scale must be a number.');
    this.gravity = scale;
    return this;
  }
  /** Air drag: speed falls off as 1 / (1 + dt * damping) (default 0). */
  setLinearDamping(damping: number): this {
    if (!(damping >= 0 && Number.isFinite(damping))) throw new RangeError('Linear damping must be 0 or more.');
    this.damping = damping;
    return this;
  }
  /** Moves every particle by this vector when the body is created. */
  setTranslation(translation: Vec3): this {
    checkVec(translation, 'Translation');
    this.shift = [...translation];
    return this;
  }
}

/** Options of {@link SoftBodies.attach}. */
export interface SoftBodiesOptions {
  /** Stops waiting for the kernel to load. */
  signal?: AbortSignal;
  /** Pieces each fixed step is cut into (default 8): more make stiff bodies stiffer and steadier. */
  substeps?: number;
  /** Constraint passes per piece (default 2). */
  iterations?: number;
}

/** Reported once a step tears edges: which edges of which body. */
export interface SoftTearEvent {
  body: SoftBody;
  /** Edge indices, as `body.edges()` numbers them. */
  edges: number[];
  /** Cell indices, as `body.cells()` numbers them: the tetrahedra that tore, empty when only edges did. */
  cells: number[];
  /** The bodies the tear split `body` into (then removed), empty when it stayed whole. */
  pieces: SoftBody[];
  /** Where a particle of `body` (numbered as it was) went: a place in each piece it is part of; none when the body stayed whole. */
  destination(particle: number): SoftDestination[];
}

/** A soft body in a world: read and move its particles, apply forces, pin it, tear it. */
export class SoftBody {
  /** @internal */ constructor(
    private readonly owner: SoftBodies,
    /** The number that names this body in its world; it drops by one when an earlier body is removed. */
    public handle: number,
    /** @internal */ public firstParticle: number,
    /** @internal */ public particles: number,
    /** @internal */ public firstEdge: number,
    /** @internal */ public edgeTotal: number,
    /** @internal */ public structural: number,
    /** @internal */ public masses: Float32Array,
    /** @internal */ public material: SoftBodyMaterial,
    /** @internal */ public cellRange: CellRange = NO_CELLS,
    /** @internal */ public cellMaterial: CellMaterial = new CellMaterial(),
  ) {}
  /** @internal */ removed = false;
  /** @internal */ cellsTornSeen = new Set<number>();
  /** @internal The skin, and the cells (four particle indices each) it was bound against. */ skin: Skin | null = null;
  /** @internal */ skinCells = new Uint32Array(0);
  /** @internal Where each particle stood when the last step began (x, y, z), for drawing between steps. */ previous =
    new Float32Array(0);
  /** @internal */ clusterInfo: ClusterInfo[] = [];
  /** @internal */ solverKind: SoftSolver = 'constraints';
  /** @internal The cluster of all the particles, once the root body is asked for. */ rootCluster = -1;
  /** @internal */ force: Vec3 = [0, 0, 0];
  /** @internal */ pointForces = new Map<number, Vec3>();
  /** @internal */ tornSeen = new Set<number>();
  /** @internal */ triangleList = new Uint32Array(0);
  /** @internal The fixed body that holds this body's surface collider, once it has one. */
  surface: PhysicsBody | null = null;
  /** @internal Whether shape matching holds this body. */ matched = false;
  /** @internal Which thread each structural edge is (see SoftBodyDesc.edgeKinds); empty for a body that is not a woven sheet. */
  edgeKinds = new Uint8Array(0);
  /** @internal Whether its surface holds a volume, and the volume at rest. */ volumeOn = false;
  /** @internal */ surfaceRest = 0;
  /** @internal */ canSleepFlag = true;
  /** @internal */ asleep = false;
  /** @internal Seconds the body has been still. */ quiet = 0;
  /** @internal The packed groups the particles meet colliders by; undefined meets every collider. */ collisionGroups:
    | number
    | undefined = undefined;
  /** @internal */ dominance = 0;
  /**
   * The grid of a body built by `cloth`, `clothAnisotropic` or `clothTube`: `nu` by `nv` particles, particle (i, j) at
   * index `i * nv + j`, and whether it closes around `u` (a tube); null for any other body, a merged one included. A
   * renderer reads its texture coordinates from it (`@margoengine/gltf/soft-mesh`).
   */
  grid: { readonly nu: number; readonly nv: number; readonly wrap: boolean } | null = null;
  /** @internal */ additionalIterations = 0;
  /** @internal */ oriented: boolean | undefined = undefined;
  /** @internal Whether its triangles are in the cloth contact search, and how rough the cloth is. */ selfContacts = false;
  /** @internal */ selfFriction = 0;
  /** @internal How far its triangles are held from each other: its radius, and at most half its shortest edge. */
  selfThickness = 0;

  /** False once the body was removed. */
  get valid(): boolean {
    return !this.removed;
  }
  private check(index?: number): void {
    if (this.removed) throw new MargoError('state', 'Soft body was removed; create a new one with SoftBodies.create.');
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= this.particles))
      throw new RangeError(`Particle ${index} must be in this body (0 to ${this.particles - 1}).`);
  }
  private get c(): ReturnType<SoftBodies['columns']> {
    return this.owner.columns();
  }
  numParticles(): number {
    return this.particles;
  }
  /** World position of one particle. */
  particlePosition(index: number): Vec3 {
    this.check(index);
    const { x, y, z } = this.c,
      row = this.firstParticle + index;
    return [x[row]!, y[row]!, z[row]!];
  }
  /**
   * Every particle's position as flat x, y, z: a copy, so it is safe to keep, written into `target` when one is given
   * (three numbers a particle), so a frame loop allocates nothing.
   */
  particlePositions(target?: Float32Array): Float32Array {
    this.check();
    if (target !== undefined && (!(target instanceof Float32Array) || target.length !== this.particles * 3))
      throw new RangeError(
        `particlePositions needs a Float32Array target of ${this.particles * 3} numbers, three a particle.`,
      );
    const { x, y, z } = this.c,
      out = target ?? new Float32Array(this.particles * 3);
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i;
      out[i * 3] = x[row]!;
      out[i * 3 + 1] = y[row]!;
      out[i * 3 + 2] = z[row]!;
    }
    return out;
  }
  /**
   * Every particle's position between the last two steps, as flat x, y, z: where it stood when the last step began, moved by
   * `alpha` of the way to where the step left it (the rigid bodies' {@link Physics.sync} does the same), so a body drawn each
   * frame moves smoothly when the frame rate and the step rate differ, and inside a motion-blur shutter. `alpha` defaults to the
   * world's {@link Physics.alpha} and is held to 0..1; at 1 it is {@link SoftBody.particlePositions}. A teleport
   * (`setParticlePosition`) leaves no trail. Writes into `out` when given (three numbers a particle).
   * @throws RangeError for an alpha that is not a number, or an `out` of the wrong length.
   */
  interpolatedPositions(
    alpha: number = this.owner.alpha,
    out: Float32Array = new Float32Array(this.particles * 3),
  ): Float32Array {
    this.check();
    if (!Number.isFinite(alpha))
      throw new RangeError('Interpolation alpha must be a finite number; pass a value from 0 to 1.');
    if (out.length !== this.particles * 3)
      throw new RangeError(
        `out holds ${out.length} numbers for ${this.particles} particles; pass three numbers a particle.`,
      );
    const a = alpha > 1 ? 1 : alpha < 0 ? 0 : alpha,
      { x, y, z } = this.c,
      before = this.previous;
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i,
        o = i * 3;
      out[o] = before[o]! + a * (x[row]! - before[o]!);
      out[o + 1] = before[o + 1]! + a * (y[row]! - before[o + 1]!);
      out[o + 2] = before[o + 2]! + a * (z[row]! - before[o + 2]!);
    }
    return out;
  }
  /**
   * The skin's vertices between the last two steps (see {@link SoftBody.interpolatedPositions}): the skin of
   * {@link SoftBody.meshVertices} carried by the interpolated particles. Empty for a body with no skin.
   * @throws RangeError for an alpha that is not a number.
   */
  interpolatedMeshVertices(alpha: number = this.owner.alpha): Float32Array {
    const skin = this.skin;
    if (!skin) {
      this.check();
      return new Float32Array(0);
    }
    const at = this.interpolatedPositions(alpha),
      out = new Float32Array(skin.cell.length * 3);
    for (let i = 0; i < skin.cell.length; i++) {
      const cell = skin.cell[i]!;
      for (let k = 0; k < 4; k++) {
        const p = this.skinCells[cell * 4 + k]! * 3,
          w = skin.weight[i * 4 + k]!;
        out[i * 3] = out[i * 3]! + w * at[p]!;
        out[i * 3 + 1] = out[i * 3 + 1]! + w * at[p + 1]!;
        out[i * 3 + 2] = out[i * 3 + 2]! + w * at[p + 2]!;
      }
    }
    return out;
  }
  /** @internal Keeps where every particle stands now, as the start of the next step. */
  remember(): void {
    const { x, y, z } = this.c;
    if (this.previous.length !== this.particles * 3) this.previous = new Float32Array(this.particles * 3);
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i;
      this.previous[i * 3] = x[row]!;
      this.previous[i * 3 + 1] = y[row]!;
      this.previous[i * 3 + 2] = z[row]!;
    }
  }
  particleVelocity(index: number): Vec3 {
    this.check(index);
    const { vx, vy, vz } = this.c,
      row = this.firstParticle + index;
    return [vx[row]!, vy[row]!, vz[row]!];
  }
  particleVelocities(): Float32Array {
    this.check();
    const { vx, vy, vz } = this.c,
      out = new Float32Array(this.particles * 3);
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i;
      out[i * 3] = vx[row]!;
      out[i * 3 + 1] = vy[row]!;
      out[i * 3 + 2] = vz[row]!;
    }
    return out;
  }
  /** Teleports a particle: contacts do not see the move. Use {@link SoftBody.setParticleKinematicTarget} to drive one. */
  setParticlePosition(index: number, position: Vec3): this {
    this.check(index);
    this.wake();
    checkVec(position, 'Position');
    const { x, y, z, px, py, pz } = this.c,
      row = this.firstParticle + index;
    x[row] = px[row] = position[0];
    y[row] = py[row] = position[1];
    z[row] = pz[row] = position[2];
    // A teleport leaves no trail between steps.
    if (this.previous.length === this.particles * 3) this.previous.set(position, index * 3);
    return this;
  }
  setParticleVelocity(index: number, velocity: Vec3): this {
    this.check(index);
    this.wake();
    checkVec(velocity, 'Velocity');
    const { vx, vy, vz } = this.c,
      row = this.firstParticle + index;
    vx[row] = velocity[0];
    vy[row] = velocity[1];
    vz[row] = velocity[2];
    return this;
  }
  /** Pins a particle (it holds still, a rigid anchor for the others) or releases it with its mass back and its velocity kept. */
  setParticlePinned(index: number, pinned: boolean): this {
    this.check(index);
    this.wake();
    const { w, pflags } = this.c,
      row = this.firstParticle + index;
    if (pinned) {
      w[row] = 0;
      pflags[row] = pflags[row]! | PINNED;
    } else {
      w[row] = 1 / this.masses[index]!;
      pflags[row] = pflags[row]! & ~(PINNED | TARGETED);
    }
    return this;
  }
  /**
   * Pins a particle to a rigid body at the point where it is now, as Rapier's `attachParticle`: the body's pose carries the
   * particle, and the particle's pull is the body's weight on it, so a rope hangs a crate and a crate drags a rope. A particle
   * may be pinned to several bodies. It ends when the body or this soft body is removed, or with {@link SoftBody.detachParticle}.
   */
  attachParticle(index: number, body: PhysicsBody): this {
    this.check(index);
    this.wake();
    this.owner.attach(this, index, body);
    return this;
  }
  /** Lets a particle go from one rigid body, or from all of them. Returns false when it was not pinned. */
  detachParticle(index: number, body?: PhysicsBody): boolean {
    this.check(index);
    return this.owner.release(this, index, body);
  }
  isParticlePinned(index: number): boolean {
    this.check(index);
    return (this.c.pflags[this.firstParticle + index]! & PINNED) !== 0;
  }
  /**
   * Pins a particle and moves it to `position` over the next step, at a steady speed, so contacts and friction see it move.
   * It stays pinned there.
   */
  setParticleKinematicTarget(index: number, position: Vec3): this {
    this.check(index);
    this.wake();
    checkVec(position, 'Target');
    this.setParticlePinned(index, true);
    const { tx, ty, tz, pflags } = this.c,
      row = this.firstParticle + index;
    tx[row] = position[0];
    ty[row] = position[1];
    tz[row] = position[2];
    pflags[row] = pflags[row]! | TARGETED;
    return this;
  }
  /** The volume the body's closed triangle surface encloses now, in cubic metres (0 for a body that holds no volume). */
  surfaceVolume(): number {
    this.check();
    return this.volumeOn ? this.owner.surfaceVolume(this) : 0;
  }
  /** Changes the volume the body holds: `factor` times the volume it was made with (null lets it go). */
  setVolumeFactor(factor: number | null): this {
    this.check();
    if (factor !== null && !(factor > 0 && Number.isFinite(factor)))
      throw new RangeError('Volume factor must be a positive number.');
    if (factor !== null && !this.volumeOn)
      throw new RangeError('This body needs a closed triangle surface to hold a volume.');
    this.owner.setVolume(this, factor);
    return this;
  }
  /** @internal The spring of a woven sheet's thread, or null for an edge that is none of them. */
  threadSoftness(edge: number): SoftSoftness | null {
    const kind = this.edgeKinds[edge];
    const m = this.material;
    return kind === THREAD_WARP
      ? m.warpSoftness
      : kind === THREAD_WEFT
        ? m.weftSoftness
        : kind === THREAD_SHEAR
          ? m.shearSoftness
          : null;
  }
  /**
   * Whether the body may fall asleep (default true): after two seconds with every particle slower than 2 mm/s it stops being
   * stepped until something touches it (a force, an impulse, a moved or pinned particle, a collider moving past it). Bodies with
   * cells, clusters or particles attached to rigid bodies stay awake.
   */
  get canSleep(): boolean {
    return this.canSleepFlag;
  }
  set canSleep(value: boolean) {
    this.canSleepFlag = value;
    if (!value) this.wake();
  }
  /** Whether the body is asleep now. */
  get sleeping(): boolean {
    return this.asleep;
  }
  /** Puts the body to sleep now, its particles still. */
  sleep(): this {
    this.check();
    this.owner.setSleep(this, true);
    return this;
  }
  /** Wakes the body. */
  wakeUp(): this {
    return this.wake();
  }
  /** @internal */
  wake(): this {
    if (this.asleep && !this.removed) this.owner.setSleep(this, false);
    this.quiet = 0;
    return this;
  }
  /** The triangles of a body built from a mesh (`SoftBodyDesc.trimesh`), as particle indices, three per triangle. */
  triangles(): Uint32Array {
    this.check();
    return this.triangleList.slice();
  }
  /** @internal The number of structural edges. */
  structuralEdges(): number {
    return this.structural;
  }
  /** Structural edges as flat pairs of particle indices (shear edges included; bend edges are in {@link SoftBody.bendEdges}). */
  edges(): Uint32Array {
    this.check();
    return this.pairs(0, this.structural);
  }
  bendEdges(): Uint32Array {
    this.check();
    return this.pairs(this.structural, this.edgeTotal);
  }
  private pairs(from: number, to: number): Uint32Array {
    const { ea, eb } = this.c,
      out = new Uint32Array((to - from) * 2);
    for (let e = from; e < to; e++) {
      out[(e - from) * 2] = ea[this.firstEdge + e]! - this.firstParticle;
      out[(e - from) * 2 + 1] = eb[this.firstEdge + e]! - this.firstParticle;
    }
    return out;
  }
  /** Makes every edge and bend edge of the body resist stretch only (true) or both (false). */
  setTensionOnly(on = true): this {
    this.check();
    const { eflags } = this.c;
    for (let e = 0; e < this.edgeTotal; e++) {
      const row = this.firstEdge + e;
      eflags[row] = on ? eflags[row]! | TENSION : eflags[row]! & ~TENSION;
    }
    return this;
  }
  /** True once an edge (numbered as {@link SoftBody.edges}) has torn. */
  isEdgeTorn(edge: number): boolean {
    this.check();
    if (!Number.isInteger(edge) || edge < 0 || edge >= this.structural)
      throw new RangeError(`Edge ${edge} must be a structural edge.`);
    return (this.c.eflags[this.firstEdge + edge]! & TORN) !== 0;
  }
  /** Tears one edge now. */
  tearEdge(edge: number): this {
    if (this.isEdgeTorn(edge)) return this;
    const { eflags } = this.c;
    eflags[this.firstEdge + edge] = eflags[this.firstEdge + edge]! | TORN;
    return this;
  }
  /** How the body's cells are solved. */
  get solver(): SoftSolver {
    return this.solverKind;
  }
  /** Changes how the body's cells are solved, from the next step. */
  setSolver(solver: SoftSolver): this {
    this.check();
    if (solver !== 'constraints' && solver !== 'fem') throw new RangeError("Solver must be 'constraints' or 'fem'.");
    this.solverKind = solver;
    this.owner.writeCellMaterial(this);
    return this;
  }
  /** Number of clusters. */
  numClusters(): number {
    return this.clusterInfo.length;
  }
  private checkCluster(cluster: number): ClusterInfo {
    this.check();
    const info = this.clusterInfo[cluster];
    if (!Number.isInteger(cluster) || !info)
      throw new RangeError(`Cluster ${cluster} must be in this body (0 to ${this.clusterInfo.length - 1}).`);
    return info;
  }
  /**
   * Makes a cluster of these particles and returns its number. A cluster has a frame of its own, its centre and the rotation that
   * best fits its particles (Mueller et al. 2005), that {@link SoftBody.clusterProxy} gives as a rigid body. Its shape matching
   * spring is off until `enableClusterShapeMatching` or `hertz` turns it on (hertz above 0).
   */
  addCluster(indices: ArrayLike<number>, hertz = 0): number {
    this.check();
    return this.owner.addCluster(this, indices, hertz);
  }
  /**
   * Removes a cluster and its proxy. Particles that only it held stay; the clusters after it move down by one.
   */
  removeCluster(cluster: number): this {
    this.checkCluster(cluster);
    this.owner.removeCluster(this, cluster);
    return this;
  }
  /**
   * The rigid body that stands for a cluster: it is dynamic, with the cluster's mass and its frame as its pose, and each step it is
   * put where the cluster stands and given the cluster's velocity. Whatever the rigid world does to its velocity (joints,
   * contacts of colliders added to it) is handed to the particles at the next step, so a joint to it holds the cluster. Its
   * rotational inertia is that of a ball of the cluster's spread, and it feels no gravity (the particles do).
   */
  clusterProxy(cluster: number): PhysicsBody {
    this.checkCluster(cluster);
    return this.owner.clusterProxy(this, cluster);
  }
  /** The cluster of every particle, with its proxy: the body's frame (Rapier's root body). Moving it has no effect. */
  rootBody(): PhysicsBody {
    this.check();
    if (this.rootCluster < 0) {
      const all = Array.from({ length: this.particles }, (_, i) => i);
      this.rootCluster = this.addCluster(all, 0);
    }
    return this.clusterProxy(this.rootCluster);
  }
  /** Multiplies Young's modulus (both Lame parameters) of every cell all four of whose particles are in the cluster (default 1). */
  setClusterStiffnessScale(cluster: number, scale: number): this {
    const info = this.checkCluster(cluster);
    if (!(scale >= 0 && Number.isFinite(scale))) throw new RangeError('A stiffness scale must be 0 or more.');
    info.stiffness = scale;
    this.owner.writeCellMaterial(this);
    return this;
  }
  /** Overrides the softness of every structural edge with both ends in the cluster (null gives the body's back). */
  setClusterEdgeSoftness(cluster: number, softness: SoftSoftness | null): this {
    const info = this.checkCluster(cluster);
    if (softness) checkSoftness(softness, 'Cluster edge softness');
    info.edgeSoftness = softness ? { ...softness } : null;
    this.owner.writeMaterial(this);
    return this;
  }
  /** Multiplies the tear thresholds (strain and force) of the cells and edges that lie wholly in the cluster (default 1). */
  setClusterTearResistance(cluster: number, scale: number): this {
    const info = this.checkCluster(cluster);
    if (!(scale > 0 && Number.isFinite(scale))) throw new RangeError('A tear resistance must be a positive number.');
    info.tearResistance = scale;
    this.owner.writeCellMaterial(this);
    this.owner.writeMaterial(this);
    return this;
  }
  /** Turns the cluster's shape matching spring on (at `hertz`, default its last or 10 Hz) or off: it pulls the particles toward the frame. */
  enableClusterShapeMatching(cluster: number, on = true, hertz?: number): this {
    const info = this.checkCluster(cluster);
    if (hertz !== undefined) {
      if (!(hertz > 0 && Number.isFinite(hertz)))
        throw new RangeError('Shape matching stiffness must be a positive number of hertz.');
      info.hertz = hertz;
    }
    info.matching = on;
    this.owner.writeClusterSprings(this);
    return this;
  }
  /** Pins every particle of the cluster, or lets them go. */
  setClusterPinned(cluster: number, pinned: boolean): this {
    const info = this.checkCluster(cluster);
    for (const i of info.members) this.setParticlePinned(i, pinned);
    return this;
  }
  /**
   * Moves the cluster rigidly to a pose over the next step: every particle goes to where its place in the cluster's rest shape
   * lies in that pose, as a kinematic target (so contacts and friction see it move), and it stays pinned there.
   */
  setClusterKinematicTarget(cluster: number, position: Vec3, rotation: Quat = [0, 0, 0, 1]): this {
    const info = this.checkCluster(cluster);
    checkVec(position, 'Cluster position');
    checkRotation(rotation);
    const f = this.owner.cellColumns(),
      start = f.cstart![this.cellRange.clusterFirst + cluster]!;
    info.members.forEach((particle, k) => {
      const q: Vec3 = [f.rest0![start + k]!, f.rest1![start + k]!, f.rest2![start + k]!],
        turned = rotate(rotation, q);
      this.setParticleKinematicTarget(particle, [
        position[0] + turned[0],
        position[1] + turned[1],
        position[2] + turned[2],
      ]);
    });
    return this;
  }
  /** The skin's vertices where the cells have taken them, as flat x, y, z (a copy); empty when the body has no skin. */
  meshVertices(): Float32Array {
    this.check();
    const skin = this.skin;
    if (!skin) return new Float32Array(0);
    const { x, y, z } = this.c,
      out = new Float32Array(skin.cell.length * 3);
    for (let i = 0; i < skin.cell.length; i++) {
      const cell = skin.cell[i]!;
      for (let k = 0; k < 4; k++) {
        const row = this.firstParticle + this.skinCells[cell * 4 + k]!,
          w = skin.weight[i * 4 + k]!;
        out[i * 3] = out[i * 3]! + w * x[row]!;
        out[i * 3 + 1] = out[i * 3 + 1]! + w * y[row]!;
        out[i * 3 + 2] = out[i * 3 + 2]! + w * z[row]!;
      }
    }
    return out;
  }
  /** The skin's triangles (three indices each; a copy). */
  meshIndices(): Uint32Array {
    this.check();
    return this.skin ? this.skin.indices.slice() : new Uint32Array(0);
  }
  /** Number of tetrahedral cells (0 for a rope or cloth). */
  numCells(): number {
    return this.cellRange.count;
  }
  /** The cells as flat groups of four particle indices (a left-handed cell has its last two corners swapped). */
  cells(): Uint32Array {
    this.check();
    const f = this.owner.cellColumns(),
      { first, count } = this.cellRange,
      out = new Uint32Array(count * 4);
    for (let t = 0; t < count; t++)
      for (let k = 0; k < 4; k++) out[t * 4 + k] = f[`p${k}`]![first + t]! - this.firstParticle;
    return out;
  }
  private checkCell(cell: number): void {
    this.check();
    if (!Number.isInteger(cell) || cell < 0 || cell >= this.cellRange.count)
      throw new RangeError(`Cell ${cell} must be in this body (0 to ${this.cellRange.count - 1}).`);
  }
  /** True once a cell has torn away. */
  isCellTorn(cell: number): boolean {
    this.checkCell(cell);
    return (this.owner.cellColumns().flags![this.cellRange.first + cell]! & TORN_CELL) !== 0;
  }
  /** Indices of the cells that have torn. */
  tornCells(): number[] {
    this.check();
    const { flags } = this.owner.cellColumns(),
      out: number[] = [];
    for (let t = 0; t < this.cellRange.count; t++)
      if ((flags![this.cellRange.first + t]! & TORN_CELL) !== 0) out.push(t);
    return out;
  }
  /** Tears one cell away now. */
  tearCell(cell: number): this {
    this.checkCell(cell);
    const { flags } = this.owner.cellColumns(),
      row = this.cellRange.first + cell;
    if ((flags![row]! & TORN_CELL) === 0) {
      flags![row] = flags![row]! | TORN_CELL;
      this.owner.cellTornByHand = true;
    }
    return this;
  }
  /** Volume of the cells that have not torn, in cubic metres, as the particles stand now. */
  volume(): number {
    this.check();
    const f = this.owner.cellColumns(),
      { x, y, z } = this.c,
      position = new Float64Array(this.particles * 3);
    for (let i = 0; i < this.particles; i++) {
      position[i * 3] = x[this.firstParticle + i]!;
      position[i * 3 + 1] = y[this.firstParticle + i]!;
      position[i * 3 + 2] = z[this.firstParticle + i]!;
    }
    let total = 0;
    for (let t = 0; t < this.cellRange.count; t++) {
      const row = this.cellRange.first + t;
      if ((f.flags![row]! & TORN_CELL) !== 0) continue;
      const at = (k: number): number => f[`p${k}`]![row]! - this.firstParticle;
      total += tetDeterminant(position, at(0), at(1), at(2), at(3)) / 6;
    }
    return total;
  }
  /** Volume of the cells that have not torn, as they were made, in cubic metres. */
  restVolume(): number {
    this.check();
    const f = this.owner.cellColumns();
    let total = 0;
    for (let t = 0; t < this.cellRange.count; t++) {
      const row = this.cellRange.first + t;
      if ((f.flags![row]! & TORN_CELL) === 0) total += f.vol0![row]!;
    }
    return total;
  }
  /** Takes back every permanent deformation, of cells and edges alike: the rest shapes and rest lengths are the ones the body was made with. */
  resetPlasticity(): this {
    this.check();
    const f = this.owner.cellColumns(),
      c = this.c,
      { first, count } = this.cellRange;
    for (let t = first; t < first + count; t++) {
      for (let k = 0; k < 9; k++) f[`b${k}`]![t] = f[`o${k}`]![t]!;
      f.flowed![t] = 0;
    }
    for (let e = 0; e < this.edgeTotal; e++) c.rest[this.firstEdge + e] = f.e_rest0![this.firstEdge + e]!;
    return this;
  }
  /** Replaces the cells' material, taking effect at once; a cell keeps the shape it has flowed into. */
  setCellMaterial(material: CellMaterial): this {
    this.check();
    checkCellMaterial(material);
    this.cellMaterial = material.clone();
    this.owner.writeCellMaterial(this);
    return this;
  }
  /** A copy of the cells' material; change it and pass it to {@link SoftBody.setCellMaterial}. */
  getCellMaterial(): CellMaterial {
    return this.cellMaterial.clone();
  }
  /** Replaces the material, taking effect on every edge. */
  setMaterial(material: SoftBodyMaterial): this {
    this.check();
    checkMaterial(material);
    this.material = material.clone();
    this.owner.writeMaterial(this);
    return this;
  }
  /** A copy of the material; change it and pass it to {@link SoftBody.setMaterial}. */
  getMaterial(): SoftBodyMaterial {
    return this.material.clone();
  }
  setGravityScale(scale: number): this {
    this.check();
    this.c.gravity_scale[this.handle] = scale;
    return this;
  }
  setLinearDamping(damping: number): this {
    this.check();
    if (!(damping >= 0 && Number.isFinite(damping))) throw new RangeError('Linear damping must be 0 or more.');
    this.c.linear_damping[this.handle] = damping;
    return this;
  }
  /** Total mass in kilograms (pinned particles count). */
  mass(): number {
    let total = 0;
    for (const m of this.masses) total += m;
    return total;
  }
  /** Mass-weighted centre of the free and pinned particles. */
  centerOfMass(): Vec3 {
    this.check();
    const { x, y, z } = this.c;
    let sx = 0,
      sy = 0,
      sz = 0;
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i,
        m = this.masses[i]!;
      sx += x[row]! * m;
      sy += y[row]! * m;
      sz += z[row]! * m;
    }
    const total = this.mass();
    return [sx / total, sy / total, sz / total];
  }
  /** A force in newtons on the whole body, shared by mass, until {@link SoftBody.resetForces}. Pinned particles ignore it. */
  addForce(force: Vec3): this {
    this.check();
    this.wake();
    checkVec(force, 'Force');
    this.force = [this.force[0] + force[0], this.force[1] + force[1], this.force[2] + force[2]];
    return this;
  }
  /** A force on one particle until {@link SoftBody.resetForces}. */
  addParticleForce(index: number, force: Vec3): this {
    this.check(index);
    this.wake();
    checkVec(force, 'Force');
    const had = this.pointForces.get(index) ?? [0, 0, 0];
    this.pointForces.set(index, [had[0] + force[0], had[1] + force[1], had[2] + force[2]]);
    return this;
  }
  resetForces(): this {
    this.force = [0, 0, 0];
    this.pointForces.clear();
    return this;
  }
  /** An impulse in newton-seconds on the whole body, shared by mass: every free particle's velocity changes by impulse / mass. */
  applyImpulse(impulse: Vec3): this {
    this.check();
    checkVec(impulse, 'Impulse');
    const total = this.mass();
    for (let i = 0; i < this.particles; i++) this.kick(i, impulse[0] / total, impulse[1] / total, impulse[2] / total);
    return this;
  }
  /** An impulse on one particle: its velocity changes by impulse / its mass. */
  applyParticleImpulse(index: number, impulse: Vec3): this {
    this.check(index);
    checkVec(impulse, 'Impulse');
    const m = this.masses[index]!;
    this.kick(index, impulse[0] / m, impulse[1] / m, impulse[2] / m);
    return this;
  }
  /** An impulse that falls off linearly to nothing at `radius` metres from `point`, scaled by each particle's mass. */
  applyImpulseAtPoint(impulse: Vec3, point: Vec3, radius: number): this {
    this.check();
    checkVec(impulse, 'Impulse');
    checkVec(point, 'Point');
    if (!Number.isFinite(radius)) throw new RangeError('Radius must be a number of metres.');
    const { x, y, z } = this.c;
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i,
        d = Math.hypot(x[row]! - point[0], y[row]! - point[1], z[row]! - point[2]),
        // A radius of zero or less gives every particle the whole impulse, as Rapier's does.
        k = radius <= 0 ? 1 / this.masses[i]! : d >= radius ? 0 : (1 - d / radius) / this.masses[i]!;
      if (k > 0) this.kick(i, impulse[0] * k, impulse[1] * k, impulse[2] * k);
    }
    return this;
  }
  /**
   * An impulse of `magnitude` pointing away from `center`, falling linearly to nothing at `radius` metres (a radius of zero or
   * less pushes every particle fully), divided by each particle's mass; a particle exactly at the centre gets nothing.
   */
  applyRadialImpulse(center: Vec3, magnitude: number, radius: number): this {
    this.check();
    checkVec(center, 'Centre');
    if (!Number.isFinite(magnitude) || !Number.isFinite(radius))
      throw new RangeError('Magnitude and radius must be numbers.');
    const { x, y, z } = this.c;
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i,
        dx = x[row]! - center[0],
        dy = y[row]! - center[1],
        dz = z[row]! - center[2],
        d = Math.hypot(dx, dy, dz);
      if (d === 0 || (radius > 0 && d >= radius)) continue;
      const k = (magnitude * (radius > 0 ? 1 - d / radius : 1)) / (d * this.masses[i]!);
      this.kick(i, dx * k, dy * k, dz * k);
    }
    return this;
  }
  private kick(index: number, dx: number, dy: number, dz: number): void {
    this.wake();
    const { vx, vy, vz, w } = this.c,
      row = this.firstParticle + index;
    if (w[row] === 0) return;
    vx[row] = vx[row]! + dx;
    vy[row] = vy[row]! + dy;
    vz[row] = vz[row]! + dz;
  }
}

// The integer columns are Uint32Array at run time; typed as Float32Array they index, slice and copy the same, and every
// value in them is a whole number below 2^24.
type Columns = Record<string, Float32Array>;

/**
 * The soft bodies of one {@link Physics} world: `await SoftBodies.attach(physics)`, then `create` bodies. Each fixed step
 * the particles move under gravity, their edges and the rigid world's colliders (spheres, boxes, capsules and half-spaces
 * so far), and every body they press on takes the impulse. Import this entry only where you need it: the `Physics` root
 * entry never loads it.
 */
export class SoftBodies implements PhysicsAttachment {
  private readonly bodies: SoftBody[] = [];
  private readonly listeners = new Set<(event: SoftTearEvent) => void>();
  private view: Columns | null = null;
  private viewBuffer: ArrayBuffer | null = null;
  private capacity = [0, 0, 0, 0, 0, 0, 0];
  private rowGroups: number[] = [];
  private contactHook: ((contact: SoftContact) => void) | null = null;
  private readonly pushes = new Map<PhysicsBody, [Vec3, Vec3]>();
  private bound: BoundMesh[] = [];
  private attachments: { soft: SoftBody; index: number; body: PhysicsBody; local: Vec3 }[] = [];
  private particleCount = 0;
  private edgeCount = 0;
  private cellView: Columns | null = null;
  private cellViewBuffer: ArrayBuffer | null = null;
  private cellCapacity = [0, 0, 0, 0, 0];
  private cellTotal = 0;
  private clusterTotal = 0;
  private memberTotal = 0;
  private cellsTornSeen = 0;
  /** @internal A cell was torn by a call, so the next step reports it. */
  cellTornByHand = false;
  private disposed = false;
  /**
   * How much of the speed along a cell's constraints the cells take out each second (default 10): the damping of the elastic
   * body, so a block that was struck stops ringing. 0 never settles, and a very large value makes the body feel like putty.
   */
  cellDamping = 10;
  /** The relative residual that ends the linear solve of the `'fem'` solver (default 1e-5). */
  femLinearTolerance = 1e-5;
  /** The most passes of that linear solve (default 20). */
  femMaxLinearIterations = 20;
  /**
   * A body with this many unknowns (three a free particle) or fewer is iterated until its residual is gone, as many passes as it
   * has unknowns if need be, as a direct solve would finish (default 600).
   */
  femMaxDenseDofs = 600;
  /**
   * Whether a tear that parts a body makes pieces of it: `'cells'` (default) for bodies of cells, `'all'` for every body made of
   * edges alone too (a rope in two ropes), `'never'`. A body with triangles (cloth, a trimesh) or a surface collider is never split.
   */
  splitOnTear: 'cells' | 'all' | 'never' = 'cells';
  /** @internal Fixed step pieces and passes: change them between steps. */
  substeps: number;
  iterations: number;

  private constructor(
    private readonly physics: Physics,
    private readonly exports: SoftExports,
    options: SoftBodiesOptions,
  ) {
    this.substeps = count(options.substeps ?? 8, 'substeps', 1);
    this.iterations = count(options.iterations ?? 2, 'iterations', 1);
    physics.attach(this);
  }

  /** Loads the kernel (once per app) and joins `physics`. @throws AbortError when `signal` aborts first. */
  static async attach(physics: Physics, options: SoftBodiesOptions = {}): Promise<SoftBodies> {
    const module = await compiled.load(options.signal);
    const instance = await WebAssembly.instantiate(module, {});
    return new SoftBodies(physics, instance.exports as SoftExports, options);
  }

  /**
   * Debug lines of every soft body (Rapier's soft-body debug modes): `edges` draws each structural edge that has not torn, and
   * with `stress` colours it by its strain, green at rest, towards red as it stretches and towards blue as it is squeezed (full
   * colour at `stressRange`, default 0.2 of its rest length); `particles` draws a small cross at each particle; `contacts` draws
   * a tick along the normal of each particle's contact with a collider. Same layout as `physics.debugRender`: `vertices`
   * (two points a segment) and `colors` (r, g, b, a a vertex).
   */
  debugRender(
    options: { edges?: boolean; stress?: boolean; stressRange?: number; particles?: boolean; contacts?: boolean } = {},
  ): { vertices: Float32Array; colors: Float32Array } {
    const { edges = true, stress = false, stressRange = 0.2, particles = false, contacts = false } = options,
      positions: number[] = [],
      colors: number[] = [],
      line = (a: readonly number[], b: readonly number[], color: readonly number[]): void => {
        positions.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
        colors.push(...color, ...color);
      };
    if (!(stressRange > 0) || !Number.isFinite(stressRange))
      throw new RangeError(
        `The stress range is a positive fraction of the rest length (got ${stressRange}); pass 0.2, say.`,
      );
    const c = this.columns();
    for (const body of this.bodies) {
      const at = (row: number): [number, number, number] => [c.x![row]!, c.y![row]!, c.z![row]!];
      if (edges)
        for (let e = 0; e < body.structuralEdges(); e++) {
          const row = body.firstEdge + e;
          if (c.eflags![row]! & TORN) continue;
          const a = at(c.ea![row]!),
            b = at(c.eb![row]!);
          let color: readonly number[] = [0.4, 0.8, 0.5, 1];
          if (stress) {
            const rest = c.rest![row]!,
              strain = rest > 0 ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / rest - 1 : 0,
              k = Math.min(1, Math.abs(strain) / stressRange);
            color =
              strain >= 0
                ? [0.4 + 0.6 * k, 0.8 * (1 - k), 0.5 * (1 - k), 1]
                : [0.4 * (1 - k), 0.8 * (1 - k), 0.5 + 0.5 * k, 1];
          }
          line(a, b, color);
        }
      for (let i = 0; i < body.numParticles(); i++) {
        const row = body.firstParticle + i,
          p = at(row);
        if (particles) {
          const r = Math.max(c.radius![row]!, 0.02);
          line([p[0] - r, p[1], p[2]], [p[0] + r, p[1], p[2]], [0.9, 0.9, 0.9, 1]);
          line([p[0], p[1] - r, p[2]], [p[0], p[1] + r, p[2]], [0.9, 0.9, 0.9, 1]);
          line([p[0], p[1], p[2] - r], [p[0], p[1], p[2] + r], [0.9, 0.9, 0.9, 1]);
        }
        if (contacts && c.kc![row]! > 0) {
          const k: [number, number, number] = [c.kpx![row]!, c.kpy![row]!, c.kpz![row]!];
          line(k, [k[0] + c.knx![row]! * 0.1, k[1] + c.kny![row]! * 0.1, k[2] + c.knz![row]! * 0.1], [1, 0.3, 0.9, 1]);
        }
      }
    }
    return { vertices: new Float32Array(positions), colors: new Float32Array(colors) };
  }
  /** The world's interpolation factor between the last two steps ({@link Physics.alpha}), which drawing soft bodies reads. */
  get alpha(): number {
    return this.physics.alpha;
  }
  /** Every live soft body, oldest first. */
  list(): readonly SoftBody[] {
    return this.bodies;
  }
  /** Calls `listener` after a step that tore edges; returns a function that stops it. */
  onTear(listener: (event: SoftTearEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** A number that changes whenever any particle moves: equal across two runs that did the same. */
  hash(): number {
    return this.exports.soft_hash() >>> 0;
  }

  /** @internal The columns as typed arrays over the kernel's memory; read them fresh, as growth replaces them. */
  columns(): Columns {
    if (this.disposed)
      throw new MargoError('state', 'SoftBodies was disposed; attach a new one with SoftBodies.attach.');
    const buffer = this.exports.memory.buffer;
    if (this.view && this.viewBuffer === buffer) return this.view;
    const [particles, edges, bodies, colliders, attachments, volumeTriangles, faces] = this.capacity,
      view: Columns = {};
    columnNames.forEach((name, id) => {
      const rows = rowsOf(name, particles!, edges!, bodies!, colliders!, attachments!, volumeTriangles!, faces!),
        at = this.exports.soft_column(id);
      view[name] = (
        INTEGER_COLUMNS.has(name) ? new Uint32Array(buffer, at, rows) : new Float32Array(buffer, at, rows)
      ) as Float32Array;
    });
    this.viewBuffer = buffer;
    return (this.view = view);
  }

  /** @internal The cell and cluster columns as typed arrays over the kernel's memory; read them fresh, as growth replaces them. */
  cellColumns(): Columns {
    if (this.disposed)
      throw new MargoError('state', 'SoftBodies was disposed; attach a new one with SoftBodies.attach.');
    const buffer = this.exports.memory.buffer;
    if (this.cellView && this.cellViewBuffer === buffer) return this.cellView;
    const [tets, clusters, members, edges, bodies] = this.cellCapacity,
      view: Columns = {};
    cellColumnNames.forEach((name, id) => {
      const rows = /^(cstart|ccount|comega|cproxy|cp[xyz]|cq[xyzw]|cl[xyz]|ca[xyz])$/.test(name)
          ? clusters!
          : /^(member|rest\d)$/.test(name)
            ? members!
            : name.startsWith('e_')
              ? edges!
              : name.startsWith('bd_')
                ? bodies!
                : tets!,
        at = this.exports.soft_fem_column(id);
      view[name] = (
        INTEGER_CELL_COLUMNS.has(name) ? new Uint32Array(buffer, at, rows) : new Float32Array(buffer, at, rows)
      ) as Float32Array;
    });
    this.cellViewBuffer = buffer;
    return (this.cellView = view);
  }

  private reserveCells(tets: number, clusters: number, members: number): void {
    this.exports.soft_fem_reserve(tets, clusters, members);
    this.cellCapacity = [
      Math.max(this.cellCapacity[0]!, tets),
      Math.max(this.cellCapacity[1]!, clusters),
      Math.max(this.cellCapacity[2]!, members),
      this.cellCapacity[3]!,
      this.cellCapacity[4]!,
    ];
    this.view = null;
    this.cellView = null;
  }

  /** Makes room for the per-edge and per-body settings the cells' module keeps. */
  private reserveElements(edges: number, bodies: number): void {
    this.exports.soft_fem_reserve_elements(edges, bodies);
    this.cellCapacity = [
      this.cellCapacity[0]!,
      this.cellCapacity[1]!,
      this.cellCapacity[2]!,
      Math.max(this.cellCapacity[3]!, edges),
      Math.max(this.cellCapacity[4]!, bodies),
    ];
    this.view = null;
    this.cellView = null;
  }

  private reserve(particles: number, edges: number, bodies: number, colliders: number): void {
    this.exports.soft_reserve(particles, edges, bodies, colliders);
    this.view = null;
    this.cellView = null;
    this.capacity = [
      Math.max(this.capacity[0]!, particles),
      Math.max(this.capacity[1]!, edges),
      Math.max(this.capacity[2]!, bodies),
      Math.max(this.capacity[3]!, colliders),
      this.capacity[4]!,
      this.capacity[5]!,
      this.capacity[6]!,
    ];
    this.view = null;
  }

  /** Inserts a soft body: its particles join the world at their positions. */
  create(desc: SoftBodyDesc): SoftBody {
    if (this.disposed)
      throw new MargoError('state', 'SoftBodies was disposed; attach a new one with SoftBodies.attach.');
    const particles = desc.particleCount;
    if (desc.selfContacts && desc.triangles.length === 0)
      throw new RangeError('Self contacts need triangles; build the body with trimesh, cloth or clothTube.');
    if (particles === 0) throw new RangeError('A soft body has at least one particle.');
    // A body that holds its volume needs a closed surface whose triangles face outward.
    const restVolume = desc.volumeFactor === null ? 0 : this.meshVolume(desc.positions, desc.triangles);
    if (desc.volumeFactor !== null && !(restVolume > 0))
      throw new RangeError('A body that holds its volume needs a closed surface whose triangles face outward.');
    const structural = desc.edgePairs.length / 2,
      edges = structural + desc.bendPairs.length / 2,
      firstParticle = this.particleCount,
      firstEdge = this.edgeCount,
      handle = this.bodies.length;
    this.reserve(firstParticle + particles, firstEdge + edges, handle + 1, 0);
    this.reserveElements(firstEdge + edges, handle + 1);
    this.exports.soft_fem_reserve_particles(firstParticle + particles);
    this.particleCount += particles;
    this.edgeCount += edges;
    const c = this.columns(),
      pos = desc.positions,
      masses = Float32Array.from(desc.resolvedMasses());
    // The radius a body gets: half its shortest structural edge, so neighbours do not push one another.
    let shortest = Infinity;
    const length = (a: number, b: number): number =>
      Math.hypot(pos[a * 3]! - pos[b * 3]!, pos[a * 3 + 1]! - pos[b * 3 + 1]!, pos[a * 3 + 2]! - pos[b * 3 + 2]!);
    for (let e = 0; e < structural; e++)
      shortest = Math.min(shortest, length(desc.edgePairs[e * 2]!, desc.edgePairs[e * 2 + 1]!));
    // A body of triangles gets particles that cover them: no triangle has a gap, at its middle, wide enough for a small thing to pass
    // between three spheres (the circumradius of the widest triangle); a rope or a raw mesh gets half its shortest edge.
    let covering = 0;
    for (let t = 0; t + 2 < desc.triangles.length; t += 3) {
      const [a, b, d] = [desc.triangles[t]!, desc.triangles[t + 1]!, desc.triangles[t + 2]!],
        ab = length(a, b),
        bd = length(b, d),
        da = length(d, a),
        s2 = (ab + bd + da) / 2,
        area = Math.sqrt(Math.max(0, s2 * (s2 - ab) * (s2 - bd) * (s2 - da)));
      if (area > 1e-12) covering = Math.max(covering, (ab * bd * da) / (4 * area));
    }
    const half = Number.isFinite(shortest) ? shortest * 0.5 : 0.01;
    const radius = desc.radius ?? (covering > 0 ? covering : half);
    for (let i = 0; i < particles; i++) {
      const row = firstParticle + i;
      c.x[row] = c.px[row] = pos[i * 3]! + desc.shift[0];
      c.y[row] = c.py[row] = pos[i * 3 + 1]! + desc.shift[1];
      c.z[row] = c.pz[row] = pos[i * 3 + 2]! + desc.shift[2];
      c.vx[row] = c.vy[row] = c.vz[row] = 0;
      c.radius[row] = radius;
      c.pbody[row] = handle;
      const pinned = desc.pinned.has(i);
      c.w[row] = pinned ? 0 : 1 / masses[i]!;
      c.pflags[row] = pinned ? PINNED : 0;
    }
    // Shape matching: each particle's offset from the mass-weighted centre of the rest shape.
    let total = 0,
      sx = 0,
      sy = 0,
      sz = 0;
    for (let i = 0; i < particles; i++) {
      total += masses[i]!;
      sx += masses[i]! * pos[i * 3]!;
      sy += masses[i]! * pos[i * 3 + 1]!;
      sz += masses[i]! * pos[i * 3 + 2]!;
    }
    for (let i = 0; i < particles; i++) {
      const row = firstParticle + i;
      c.sw[row] = masses[i]!;
      c.rx[row] = pos[i * 3]! - sx / total;
      c.ry[row] = pos[i * 3 + 1]! - sy / total;
      c.rz[row] = pos[i * 3 + 2]! - sz / total;
      c.slx[row] = c.sly[row] = c.slz[row] = 0;
    }
    c.b_on[handle] = desc.shapeMatching ? 1 : 0;
    c.b_first[handle] = firstParticle;
    c.b_count[handle] = particles;
    c.bqx[handle] = c.bqy[handle] = c.bqz[handle] = c.bqw[handle] = 0;
    const writeEdges = (pairs: number[], first: number): void => {
      for (let e = 0; e < pairs.length / 2; e++) {
        const row = firstEdge + first + e,
          a = pairs[e * 2]!,
          b = pairs[e * 2 + 1]!;
        c.ea[row] = firstParticle + a;
        c.eb[row] = firstParticle + b;
        c.rest[row] = length(a, b);
        c.eflags[row] = 0;
      }
    };
    writeEdges(desc.edgePairs, 0);
    writeEdges(desc.bendPairs, structural);
    for (let e = 0; e < edges; e++)
      if (desc.tension === true || (Array.isArray(desc.tension) && desc.tension.includes(e)))
        c.eflags[firstEdge + e] = c.eflags[firstEdge + e]! | TENSION;
    {
      const fem = this.cellColumns();
      for (let e = 0; e < edges; e++) fem.e_rest0![firstEdge + e] = c.rest[firstEdge + e]!;
    }
    c.gravity_scale[handle] = desc.gravity;
    c.linear_damping[handle] = desc.damping;
    const cells = desc.cells.length / 4,
      memberCount = desc.clusterGroups.reduce((sum, group) => sum + group.length, 0),
      range: CellRange = {
        first: this.cellTotal,
        count: cells,
        clusterFirst: this.clusterTotal,
        clusterCount: desc.clusterGroups.length,
        memberFirst: this.memberTotal,
        memberCount,
      };
    if (cells || memberCount) {
      this.reserveCells(this.cellTotal + cells, this.clusterTotal + range.clusterCount, this.memberTotal + memberCount);
      this.cellTotal += cells;
      this.clusterTotal += range.clusterCount;
      this.memberTotal += memberCount;
    }
    const body = new SoftBody(
      this,
      handle,
      firstParticle,
      particles,
      firstEdge,
      edges,
      structural,
      masses,
      desc.material.clone(),
      range,
      desc.cellMaterial.clone(),
    );
    body.solverKind = desc.solver;
    body.triangleList = Uint32Array.from(desc.triangles);
    body.edgeKinds = Uint8Array.from(desc.edgeKinds);
    body.grid = desc.grid && { ...desc.grid };
    if (desc.skin) {
      body.skin = desc.skin;
      body.skinCells = Uint32Array.from(desc.cells);
    }
    body.matched = desc.shapeMatching;
    body.collisionGroups = desc.groups;
    body.selfContacts = desc.selfContacts;
    if (restVolume > 0) {
      body.surfaceRest = restVolume;
      body.volumeOn = true;
    }
    body.selfFriction = desc.selfFriction;
    body.selfThickness = Math.min(radius, half);
    body.dominance = desc.dominance;
    body.canSleepFlag = desc.canSleep;
    body.additionalIterations = desc.additionalIterations;
    body.oriented = desc.oriented;
    if (cells) {
      const [mu, lambda] = desc.cellMaterial.lame(),
        model = CELL_MODEL[desc.cellMaterial.model];
      for (let t = 0; t < cells; t++) {
        const [a, b, d, e] = [0, 1, 2, 3].map((k) => firstParticle + desc.cells[t * 4 + k]!) as [
          number,
          number,
          number,
          number,
        ];
        // The cells were checked when they were set, so none is flat.
        this.exports.soft_tet_set(range.first + t, a, b, d, e, mu, lambda, model);
      }
      this.linkCells(range, handle);
    }
    body.clusterInfo = desc.clusterGroups.map((group) => ({
      members: [...group],
      hertz: desc.clusterHertz,
      matching: true,
      stiffness: 1,
      edgeSoftness: null,
      tearResistance: 1,
      proxy: null,
      lin: [0, 0, 0],
      ang: [0, 0, 0],
    }));
    if (memberCount) {
      const members = this.cellColumns().member!;
      let at = range.memberFirst;
      desc.clusterGroups.forEach((group, k) => {
        for (const particle of group) members[at++] = firstParticle + particle;
        this.exports.soft_cluster_set(
          range.clusterFirst + k,
          at - group.length,
          group.length,
          desc.clusterHertz * 2 * Math.PI,
        );
      });
    }
    this.bodies.push(body);
    body.remember();
    this.writeMaterial(body);
    this.writeCellMaterial(body);
    this.syncCloth();
    this.syncVolume(desc.volumeFactor);
    // A surface collider only when asked: the particles and the faces meet rigid bodies in the soft step, and a mesh would answer
    // a second time.
    if (desc.surfaceSettings) this.createSurfaceCollider(body, desc.surfaceSettings);
    return body;
  }

  /**
   * Calls `hook` for each contact a particle has with a collider that asks for it (`collider.setActiveHooks({modifyContacts:
   * true})`), once a step before it is used, so a one-way platform, a conveyor or a sticky patch can edit or drop it (Rapier's
   * `modify_solver_contacts`). Pass null to stop. Rapier's soft hook also offers its edge, vertex and volume-patch candidates,
   * which are its contact solver's own; here a contact is the plane a particle meets.
   */
  setContactHook(hook: ((contact: SoftContact) => void) | null): void {
    this.contactHook = hook;
  }

  /** @internal Puts a body to sleep or wakes it: its particles are left out of the prediction while it sleeps. */
  setSleep(body: SoftBody, asleep: boolean): void {
    this.columns().bsleep[body.handle] = asleep ? 1 : 0;
    body.asleep = asleep;
    body.quiet = 0;
    if (asleep) {
      const { vx, vy, vz } = this.columns();
      for (let i = 0; i < body.particles; i++)
        vx[body.firstParticle + i] = vy[body.firstParticle + i] = vz[body.firstParticle + i] = 0;
    }
  }

  /** Counts how long each body has been still, and puts the ones that may sleep to sleep. */
  private updateSleep(dt: number, c: Columns): void {
    for (const body of this.bodies) {
      if (body.asleep || !body.canSleepFlag) continue;
      if (
        body.cellRange.count > 0 ||
        body.clusterInfo.length > 0 ||
        body.force.some((f) => f !== 0) ||
        body.pointForces.size > 0 ||
        this.attachments.some((a) => a.soft === body)
      ) {
        body.quiet = 0;
        continue;
      }
      let fastest = 0;
      for (let i = 0; i < body.particles; i++) {
        const row = body.firstParticle + i;
        if (c.w[row] === 0) continue;
        fastest = Math.max(fastest, Math.hypot(c.vx[row]!, c.vy[row]!, c.vz[row]!));
      }
      body.quiet = fastest < 0.002 ? body.quiet + dt : 0;
      if (body.quiet >= 2) this.setSleep(body, true);
    }
  }

  /** @internal Sets a body's volume target to `factor` times its rest volume and puts its triangles in the volume search. */
  setVolumeFactorOf(body: SoftBody, factor: number): void {
    this.syncVolume(factor);
    this.setVolume(body, factor);
  }

  /** @internal The volume a closed triangle surface encloses, in cubic metres (positive when it faces outward). */
  private meshVolume(positions: readonly number[], triangles: readonly number[]): number {
    let v = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t]! * 3, triangles[t + 1]! * 3, triangles[t + 2]! * 3] as [number, number, number],
        p = positions;
      v +=
        (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) +
          p[a + 1]! * (p[b + 2]! * p[c]! - p[b]! * p[c + 2]!) +
          p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
        6;
    }
    return v;
  }

  /** @internal The current volume of a body's closed surface. */
  surfaceVolume(body: SoftBody): number {
    return this.exports.soft_volume(body.handle);
  }

  /** @internal Sets the volume a body holds, as a factor of its rest volume, or lets it go. */
  setVolume(body: SoftBody, factor: number | null): void {
    const c = this.columns();
    c.vb_on[body.handle] = factor === null ? 0 : 1;
    c.vb_target[body.handle] = (factor ?? 1) * body.surfaceRest;
  }

  /** Lays the triangles of the bodies that hold a volume into the kernel and, for a new body, its target. */
  private syncVolume(factor: number | null): void {
    const on = this.bodies.filter((b) => b.volumeOn);
    let triangles = 0;
    for (const b of on) triangles += b.triangleList.length / 3;
    this.exports.soft_volume_reserve(triangles);
    this.capacity[5] = Math.max(this.capacity[5]!, triangles);
    this.view = null;
    const c = this.columns();
    let at = 0;
    for (const b of on) {
      c.vb_first[b.handle] = at / 3;
      c.vb_count[b.handle] = b.triangleList.length / 3;
      for (const v of b.triangleList) c.vtri[at++] = b.firstParticle + v;
    }
    if (factor !== null) {
      const b = this.bodies[this.bodies.length - 1]!;
      if (b.volumeOn) this.setVolume(b, factor);
    }
  }

  /** @internal Pins a particle to a point fixed in a rigid body: where the particle is now, in the body's frame. */
  attach(soft: SoftBody, index: number, body: PhysicsBody): void {
    if (!body.valid)
      throw new MargoError('state', 'That rigid body was removed; pass a body that is still in the world.');
    if (this.attachments.some((a) => a.soft === soft && a.index === index && a.body === body)) return;
    const p = soft.particlePosition(index),
      q = body.rotation,
      d = [p[0] - body.position[0], p[1] - body.position[1], p[2] - body.position[2]],
      local = rotate([-q[0], -q[1], -q[2], q[3]], d);
    this.attachments.push({ soft, index, body, local });
  }

  /** @internal Lets a particle go: from one body, or from every body it is pinned to. */
  release(soft: SoftBody, index: number, body?: PhysicsBody): boolean {
    const before = this.attachments.length;
    this.attachments = this.attachments.filter(
      (a) => !(a.soft === soft && a.index === index && (!body || a.body === body)),
    );
    return this.attachments.length !== before;
  }

  /** Lays the triangles of the bodies that collide with themselves into the kernel's cloth search. */
  private syncCloth(): void {
    const on = this.bodies.filter((b) => b.selfContacts);
    let triangles = 0,
      thickness = Infinity,
      friction = 0;
    for (const b of on) {
      triangles += b.triangleList.length / 3;
      friction = Math.max(friction, b.selfFriction);
      thickness = Math.min(thickness, b.selfThickness);
    }
    const at = this.exports.soft_cloth_reserve(triangles, Math.max(triangles * 8 + 64, 16384)),
      buffer = new Uint32Array(this.exports.memory.buffer, at, triangles * 3);
    let k = 0;
    for (const b of on) for (const v of b.triangleList) buffer[k++] = b.firstParticle + v;
    this.exports.soft_cloth_enable(triangles, on.length ? thickness : 0, friction);
    this.view = null;
  }

  /** @internal Sets every cluster's spring of a body: on at its stiffness, or off. */
  writeClusterSprings(body: SoftBody): void {
    const f = this.cellColumns();
    body.clusterInfo.forEach((info, k) => {
      f.comega![body.cellRange.clusterFirst + k] = info.matching && info.hertz > 0 ? info.hertz * 2 * Math.PI : 0;
    });
  }

  /**
   * @internal Writes the clusters of a body again from `infos`, in a block at the end of the cluster rows (the old block is left
   * dead, its counts zero, until a removal packs the rows), keeping the rest places of the clusters it had.
   */
  rewriteClusters(
    body: SoftBody,
    infos: ClusterInfo[],
    keep: number[],
    extra?: { members: number[]; hertz: number },
  ): void {
    const old = this.cellColumns(),
      r = body.cellRange,
      oldStart = old.cstart!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
      oldCount = old.ccount!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
      oldOmega = old.comega!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
      oldProxy = old.cproxy!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
      rest = [old.rest0!, old.rest1!, old.rest2!].map((column) => column.slice()),
      members = old.member!.slice();
    const newClusters = keep.length + (extra ? 1 : 0),
      newMembers = keep.reduce((sum, k) => sum + oldCount[k]!, 0) + (extra ? extra.members.length : 0);
    this.reserveCells(this.cellTotal, this.clusterTotal + newClusters, this.memberTotal + newMembers);
    const f = this.cellColumns();
    // The old rows go dead.
    for (let k = 0; k < r.clusterCount; k++) {
      f.ccount![r.clusterFirst + k] = 0;
      (f.cproxy as unknown as Uint32Array)[r.clusterFirst + k] = 0;
    }
    const first = this.clusterTotal;
    let at = this.memberTotal;
    keep.forEach((k, row) => {
      (f.cstart as unknown as Uint32Array)[first + row] = at;
      (f.ccount as unknown as Uint32Array)[first + row] = oldCount[k]!;
      f.comega![first + row] = oldOmega[k]!;
      (f.cproxy as unknown as Uint32Array)[first + row] = oldProxy[k]!;
      for (let j = 0; j < oldCount[k]!; j++) {
        (f.member as unknown as Uint32Array)[at + j] = members[oldStart[k]! + j]!;
        f.rest0![at + j] = rest[0]![oldStart[k]! + j]!;
        f.rest1![at + j] = rest[1]![oldStart[k]! + j]!;
        f.rest2![at + j] = rest[2]![oldStart[k]! + j]!;
      }
      at += oldCount[k]!;
    });
    if (extra) {
      for (const particle of extra.members) (f.member as unknown as Uint32Array)[at++] = body.firstParticle + particle;
      this.exports.soft_cluster_set(
        first + keep.length,
        at - extra.members.length,
        extra.members.length,
        extra.hertz > 0 ? extra.hertz * 2 * Math.PI : 0,
      );
    }
    this.clusterTotal += newClusters;
    this.memberTotal += newMembers;
    body.cellRange = {
      ...r,
      clusterFirst: first,
      clusterCount: newClusters,
      memberFirst: this.memberTotal - newMembers,
      memberCount: newMembers,
    };
    body.clusterInfo = infos;
    this.writeClusterSprings(body);
  }

  /** @internal Makes a cluster of a body's particles. */
  addCluster(body: SoftBody, indices: ArrayLike<number>, hertz: number): number {
    if (!(hertz >= 0 && Number.isFinite(hertz)))
      throw new RangeError('Shape matching stiffness must be 0 (off) or a number of hertz.');
    const members = Array.from(indices, (index) => {
      if (!Number.isInteger(index) || index < 0 || index >= body.particles)
        throw new RangeError(`Cluster particle ${index} must be in this body (0 to ${body.particles - 1}).`);
      return index;
    });
    if (members.length < 1) throw new RangeError('A cluster has at least one particle.');
    const info: ClusterInfo = {
      members,
      hertz: hertz || DEFAULT_CLUSTER_HERTZ,
      matching: hertz > 0,
      stiffness: 1,
      edgeSoftness: null,
      tearResistance: 1,
      proxy: null,
      lin: [0, 0, 0],
      ang: [0, 0, 0],
    };
    this.rewriteClusters(
      body,
      [...body.clusterInfo, info],
      body.clusterInfo.map((_, k) => k),
      { members, hertz: info.matching ? hertz : 0 },
    );
    this.writeClusterSprings(body);
    return body.clusterInfo.length - 1;
  }

  /** @internal Removes a cluster of a body and its proxy. */
  removeCluster(body: SoftBody, cluster: number): void {
    const info = body.clusterInfo[cluster]!;
    if (info.proxy) this.physics.removeBody(info.proxy);
    const keep = body.clusterInfo.map((_, k) => k).filter((k) => k !== cluster);
    this.rewriteClusters(
      body,
      keep.map((k) => body.clusterInfo[k]!),
      keep,
    );
    if (body.rootCluster === cluster) body.rootCluster = -1;
    else if (body.rootCluster > cluster) body.rootCluster--;
    this.writeCellMaterial(body);
    this.writeMaterial(body);
  }

  /** @internal The rigid body of a cluster, made when first asked for. */
  clusterProxy(body: SoftBody, cluster: number): PhysicsBody {
    const info = body.clusterInfo[cluster]!;
    if (info.proxy) return info.proxy;
    const f = this.cellColumns(),
      row = body.cellRange.clusterFirst + cluster;
    (f.cproxy as unknown as Uint32Array)[row] = 1;
    this.exports.soft_fem_proxies(1);
    const after = this.cellColumns(),
      c = this.columns(),
      start = after.cstart![row]!;
    let mass = 0,
      spread = 0;
    const px = after.cpx![row]!,
      py = after.cpy![row]!,
      pz = after.cpz![row]!;
    for (let k = 0; k < info.members.length; k++) {
      const particle = body.firstParticle + info.members[k]!,
        m = c.w[particle]! > 0 ? 1 / c.w[particle]! : 1e6;
      mass += m;
      spread += m * ((c.x[particle]! - px) ** 2 + (c.y[particle]! - py) ** 2 + (c.z[particle]! - pz) ** 2);
    }
    void start;
    const proxy = this.physics.addBody(null, {
      type: 'dynamic',
      position: [px, py, pz],
      rotation: [after.cqx![row]!, after.cqy![row]!, after.cqz![row]!, after.cqw![row]!],
      gravityScale: 0,
    });
    const inertia = Math.max((2 / 3) * spread, 1e-9);
    proxy.setMassProperties({ mass, centerOfMass: [0, 0, 0], inertia: [inertia, inertia, inertia] });
    info.proxy = proxy;
    info.lin = [0, 0, 0];
    info.ang = [0, 0, 0];
    return proxy;
  }

  /** @internal What the rigid world did to the proxies' velocities in its step goes to the particles. */
  private takeFromProxies(): void {
    for (const body of this.bodies)
      body.clusterInfo.forEach((info, k) => {
        const proxy = info.proxy;
        if (!proxy || !proxy.valid) return;
        const c = this.columns(),
          f = this.cellColumns(),
          row = body.cellRange.clusterFirst + k,
          lin = proxy.linearVelocity,
          ang = proxy.angularVelocity,
          dv: Vec3 = [lin[0] - info.lin[0], lin[1] - info.lin[1], lin[2] - info.lin[2]],
          dw: Vec3 = [ang[0] - info.ang[0], ang[1] - info.ang[1], ang[2] - info.ang[2]];
        if (dv[0] === 0 && dv[1] === 0 && dv[2] === 0 && dw[0] === 0 && dw[1] === 0 && dw[2] === 0) return;
        const centre = [f.cpx![row]!, f.cpy![row]!, f.cpz![row]!];
        for (const i of info.members) {
          const particle = body.firstParticle + i;
          if (c.w[particle] === 0) continue;
          const rx = c.x[particle]! - centre[0]!,
            ry = c.y[particle]! - centre[1]!,
            rz = c.z[particle]! - centre[2]!;
          c.vx[particle] = c.vx[particle]! + dv[0] + dw[1] * rz - dw[2] * ry;
          c.vy[particle] = c.vy[particle]! + dv[1] + dw[2] * rx - dw[0] * rz;
          c.vz[particle] = c.vz[particle]! + dv[2] + dw[0] * ry - dw[1] * rx;
        }
      });
  }

  /** @internal Puts every proxy where its cluster stands, with the cluster's velocity. */
  private giveToProxies(dt: number): void {
    for (const body of this.bodies)
      body.clusterInfo.forEach((info, k) => {
        const proxy = info.proxy;
        if (!proxy || !proxy.valid) return;
        const f = this.cellColumns(),
          row = body.cellRange.clusterFirst + k;
        info.lin = [f.clx![row]!, f.cly![row]!, f.clz![row]!];
        info.ang = [f.cax![row]!, f.cay![row]!, f.caz![row]!];
        // The rigid step moves the proxy on by one step, so it is put that far back and lands where the cluster is.
        const [x, y, z, w] = [f.cqx![row]!, f.cqy![row]!, f.cqz![row]!, f.cqw![row]!],
          [ox, oy, oz] = info.ang,
          half = 0.5 * dt,
          nx = x - half * (ox * w + oy * z - oz * y),
          ny = y - half * (oy * w + oz * x - ox * z),
          nz = z - half * (oz * w + ox * y - oy * x),
          nw = w - half * (-ox * x - oy * y - oz * z),
          length = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1;
        proxy.setPosition(
          [f.cpx![row]! - info.lin[0] * dt, f.cpy![row]! - info.lin[1] * dt, f.cpz![row]! - info.lin[2] * dt],
          false,
        );
        proxy.setRotation([nx / length, ny / length, nz / length, nw / length], false);
        proxy.setLinearVelocity(info.lin, false);
        proxy.setAngularVelocity(info.ang, false);
      });
  }

  /** @internal Finds again the cells across each face of a body's cells, after their corners were rewritten. */
  relinkCells(body: SoftBody): void {
    this.linkCells(body.cellRange, body.handle);
  }

  /** @internal Writes a body's cell material into its cell rows; the rest shapes stay. */
  writeCellMaterial(body: SoftBody): void {
    const { first, count } = body.cellRange;
    if (count === 0) return;
    const f = this.cellColumns(),
      m = body.cellMaterial,
      [baseMu, baseLambda] = m.lame(),
      sets = body.clusterInfo.map((info) => new Set(info.members));
    for (let t = first; t < first + count; t++) {
      let stiffness = 1,
        resistance = 1;
      body.clusterInfo.forEach((info, k) => {
        const inside = [0, 1, 2, 3].every((j) => sets[k]!.has(f[`p${j}`]![t]! - body.firstParticle));
        if (inside) {
          stiffness *= info.stiffness;
          resistance *= info.tearResistance;
        }
      });
      const mu = baseMu * stiffness,
        lambda = baseLambda * stiffness;
      f.mu![t] = mu;
      f.lambda![t] = lambda;
      (f.model as unknown as Uint32Array)[t] = CELL_MODEL[m.model];
      f.yield_strain![t] = m.yieldStrain;
      f.creep![t] = m.creep;
      f.tear![t] = m.tearStrain * resistance;
      f.flow_max![t] = m.plasticMax;
      f.smooth![t] = m.tearSmoothing;
      f.interior![t] = m.interiorStrength;
      // A cell's shear wave crosses it in size / sqrt(mu / density): damping 2 zeta of that frequency.
      const size = Math.cbrt(6 * f.vol0![t]!),
        wave = Math.sqrt(mu / m.density) / size;
      const rate = (m.deformationDamping ?? this.cellDamping) + 2 * m.elasticDampingRatio * wave;
      f.damp![t] = rate;
      // The implicit solver damps by a factor on the stiffness: the rate over the square of the cell's wave frequency.
      f.imp_beta![t] = wave > 0 ? rate / (wave * wave) : 0;
      const flags = f.flags as unknown as Uint32Array;
      flags[t] =
        body.solverKind === 'fem' && m.model !== 'volume' ? flags[t]! | IMPLICIT_CELL : flags[t]! & ~IMPLICIT_CELL;
    }
  }

  /** @internal Finds the cell across each face of a body's cells, marks the ones with no outside face, and names their body. */
  private linkCells(range: CellRange, handle: number): void {
    const f = this.cellColumns(),
      faces = new Map<string, [number, number]>(),
      none = NO_NEIGHBOUR;
    for (let t = range.first; t < range.first + range.count; t++) {
      const corner = [f.p0![t]!, f.p1![t]!, f.p2![t]!, f.p3![t]!];
      (f.cbody as unknown as Uint32Array)[t] = handle;
      (f.flags as unknown as Uint32Array)[t] = (f.flags as unknown as Uint32Array)[t]! & ~INTERIOR_CELL;
      for (let k = 0; k < 4; k++) {
        (f[`nb${k}`] as unknown as Uint32Array)[t] = none;
        const key = corner
          .filter((_, j) => j !== k)
          .sort((a, b) => a - b)
          .join(',');
        const other = faces.get(key);
        if (other) {
          (f[`nb${k}`] as unknown as Uint32Array)[t] = other[0];
          (f[`nb${other[1]}`] as unknown as Uint32Array)[other[0]] = t;
        } else faces.set(key, [t, k]);
      }
    }
    for (let t = range.first; t < range.first + range.count; t++)
      if ([0, 1, 2, 3].every((k) => (f[`nb${k}`] as unknown as Uint32Array)[t] !== none))
        (f.flags as unknown as Uint32Array)[t] = (f.flags as unknown as Uint32Array)[t]! | INTERIOR_CELL;
  }

  /** @internal Writes a body's material into its edge rows. */
  writeMaterial(body: SoftBody): void {
    const c = this.columns(),
      fem = this.cellColumns(),
      { edgeSoftness, bendSoftness, tearStrain, shapeMatchingSoftness } = body.material;
    c.b_omega[body.handle] = shapeMatchingSoftness.naturalFrequency * 2 * Math.PI;
    c.b_zeta[body.handle] = shapeMatchingSoftness.dampingRatio;
    c.vb_omega[body.handle] = body.material.volumeSoftness.naturalFrequency * 2 * Math.PI;
    c.vb_zeta[body.handle] = body.material.volumeSoftness.dampingRatio;
    const sets = body.clusterInfo.map((info) => new Set(info.members));
    for (let e = 0; e < body.edgeTotal; e++) {
      const row = body.firstEdge + e,
        bend = e >= body.structural,
        ends = [c.ea[row]! - body.firstParticle, c.eb[row]! - body.firstParticle];
      let softness = bend ? bendSoftness : (body.threadSoftness(e) ?? edgeSoftness),
        resistance = 1;
      body.clusterInfo.forEach((info, k) => {
        if (!ends.every((end) => sets[k]!.has(end))) return;
        if (!bend && info.edgeSoftness) softness = info.edgeSoftness;
        resistance *= info.tearResistance;
      });
      c.omega[row] = softness.naturalFrequency * 2 * Math.PI;
      c.zeta[row] = softness.dampingRatio;
      // The cells' module tears and flows the edges (it smooths the load, shields the interior and keeps the pieces), so the
      // solver's own test is off.
      c.tear[row] = 0;
      const m = body.material,
        flow = { compression: 0, stretch: 1, both: 2 }[m.edgePlasticFlow];
      fem.e_strain![row] = bend ? 0 : tearStrain * resistance;
      fem.e_force![row] = bend ? 0 : m.tearForce * resistance;
      fem.e_smooth![row] = m.tearSmoothing;
      fem.e_yield![row] = bend ? 0 : m.edgePlasticYield;
      fem.e_creep![row] = m.edgePlasticCreep;
      fem.e_max![row] = m.edgePlasticMax;
      (fem.e_flow as unknown as Uint32Array)[row] = flow;
    }
    (fem.bd_tear_max as unknown as Uint32Array)[body.handle] = body.material.maxTearsPerStep;
    (fem.bd_min_piece as unknown as Uint32Array)[body.handle] = body.material.minPiece;
  }

  /** Removes a body and its particles; later bodies keep their order, but their numbers shift down by one. */
  remove(body: SoftBody): void {
    if (body.removed) return;
    const at = this.bodies.indexOf(body);
    if (at < 0)
      throw new MargoError('state', 'That soft body belongs to another world; pass it to the SoftBodies that made it.');
    // Keep the rows of the other bodies, in order, and write them back without the removed one.
    const keep = this.bodies.filter((b) => b !== body),
      c = this.columns(),
      cols = [
        'x',
        'y',
        'z',
        'px',
        'py',
        'pz',
        'vx',
        'vy',
        'vz',
        'w',
        'radius',
        'tx',
        'ty',
        'tz',
        'pflags',
        'rx',
        'ry',
        'rz',
        'slx',
        'sly',
        'slz',
        'sw',
      ] as const,
      bcols = [
        'b_on',
        'b_omega',
        'b_zeta',
        'bqx',
        'bqy',
        'bqz',
        'bqw',
        'vb_on',
        'vb_omega',
        'vb_zeta',
        'vb_target',
      ] as const,
      ecols = ['rest', 'omega', 'zeta', 'lambda', 'tear', 'eflags'] as const,
      saved = keep.map((b) => ({
        body: b,
        p: cols.map((name) => c[name]!.slice(b.firstParticle, b.firstParticle + b.particles)),
        e: ecols.map((name) => c[name]!.slice(b.firstEdge, b.firstEdge + b.edgeTotal)),
        ea: c.ea.slice(b.firstEdge, b.firstEdge + b.edgeTotal).map((v) => v - b.firstParticle),
        eb: c.eb.slice(b.firstEdge, b.firstEdge + b.edgeTotal).map((v) => v - b.firstParticle),
        b: bcols.map((name) => c[name]![b.handle]!),
        gravity: c.gravity_scale[b.handle]!,
        damping: c.linear_damping[b.handle]!,
      }));
    // The cells, clusters and cluster members of the others, with particle and member numbers made relative to their body.
    const tetNames = [
        'p0',
        'p1',
        'p2',
        'p3',
        ...Array.from({ length: 9 }, (_, k) => `b${k}`),
        'vol0',
        'mu',
        'lambda',
        'model',
        'yield_strain',
        'creep',
        'tear',
        'flags',
        'damp',
        ...Array.from({ length: 9 }, (_, k) => `o${k}`),
        'flowed',
        'flow_max',
        'smooth',
        'interior',
        'cbody',
        'nb0',
        'nb1',
        'nb2',
        'nb3',
      ],
      edgeNames = ['e_yield', 'e_creep', 'e_max', 'e_flow', 'e_rest0', 'e_force', 'e_strain', 'e_smooth'],
      bodyNames = ['bd_tear_max', 'bd_min_piece'],
      edgeSaved = keep.map((b) => {
        const f = this.cellColumns();
        return edgeNames.map((name) => f[name]!.slice(b.firstEdge, b.firstEdge + b.edgeTotal));
      }),
      bodySaved = keep.map((b) => {
        const f = this.cellColumns();
        return bodyNames.map((name) => f[name]![b.handle]!);
      }),
      memberNames = ['member', 'rest0', 'rest1', 'rest2'],
      cellSaved = keep.map((b) => {
        const r = b.cellRange;
        if (r.count === 0 && r.memberCount === 0) return null;
        const f = this.cellColumns();
        return {
          tets: tetNames.map((name) => {
            const part = f[name]!.slice(r.first, r.first + r.count);
            if (/^nb\d$/.test(name)) return part.map((v) => (v === NO_NEIGHBOUR ? v : v - r.first));
            return /^p\d$/.test(name) ? part.map((v) => v - b.firstParticle) : part;
          }),
          cstart: f.cstart!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount).map((v) => v - r.memberFirst),
          ccount: f.ccount!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
          comega: f.comega!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
          cproxy: f.cproxy!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
          members: memberNames.map((name) => {
            const part = f[name]!.slice(r.memberFirst, r.memberFirst + r.memberCount);
            return name === 'member' ? part.map((v) => v - b.firstParticle) : part;
          }),
        };
      });
    let particles = 0,
      edges = 0;
    for (const b of keep) {
      particles += b.particles;
      edges += b.edgeTotal;
    }
    this.exports.soft_reserve(particles, edges, keep.length, 0);
    this.view = null;
    this.cellView = null;
    const d = this.columns();
    let pi = 0,
      ei = 0;
    keep.forEach((b, handle) => {
      const s = saved[handle]!;
      cols.forEach((name, k) => d[name]!.set(s.p[k]!, pi));
      for (let i = 0; i < b.particles; i++) d.pbody[pi + i] = handle;
      ecols.forEach((name, k) => d[name]!.set(s.e[k]!, ei));
      for (let e = 0; e < b.edgeTotal; e++) {
        d.ea[ei + e] = s.ea[e]! + pi;
        d.eb[ei + e] = s.eb[e]! + pi;
      }
      bcols.forEach((name, k) => {
        d[name]![handle] = s.b[k]!;
      });
      d.b_first[handle] = pi;
      d.b_count[handle] = b.particles;
      d.gravity_scale[handle] = s.gravity;
      d.linear_damping[handle] = s.damping;
      b.handle = handle;
      b.firstParticle = pi;
      b.firstEdge = ei;
      pi += b.particles;
      ei += b.edgeTotal;
    });
    // Cells, clusters and members follow in the same order, with their particles and members renumbered.
    let tets = 0,
      clusters = 0,
      members = 0;
    for (const b of keep) {
      tets += b.cellRange.count;
      clusters += b.cellRange.clusterCount;
      members += b.cellRange.memberCount;
    }
    this.exports.soft_fem_reserve(tets, clusters, members);
    this.exports.soft_fem_trim(tets, clusters, members);
    this.exports.soft_fem_reserve_elements(edges, keep.length);
    this.exports.soft_fem_reserve_particles(particles);
    this.cellCapacity = [tets, clusters, members, edges, keep.length];
    this.view = null;
    this.cellView = null;
    this.cellTotal = this.clusterTotal = this.memberTotal = 0;
    keep.forEach((b, k) => {
      const saved = cellSaved[k],
        r = b.cellRange,
        next: CellRange = {
          first: this.cellTotal,
          count: r.count,
          clusterFirst: this.clusterTotal,
          clusterCount: r.clusterCount,
          memberFirst: this.memberTotal,
          memberCount: r.memberCount,
        };
      const fem = this.cellColumns();
      edgeNames.forEach((name, n) => fem[name]!.set(edgeSaved[k]![n]!, b.firstEdge));
      bodyNames.forEach((name, n) => {
        fem[name]![k] = bodySaved[k]![n]!;
      });
      if (saved) {
        const f = fem;
        tetNames.forEach((name, n) => {
          const part = saved.tets[n]!;
          if (name === 'cbody') f[name]!.fill(k, next.first, next.first + next.count);
          else if (/^nb\d$/.test(name))
            f[name]!.set(
              part.map((v) => (v === NO_NEIGHBOUR ? v : v + next.first)),
              next.first,
            );
          else f[name]!.set(/^p\d$/.test(name) ? part.map((v) => v + b.firstParticle) : part, next.first);
        });
        f.cstart!.set(
          saved.cstart.map((v) => v + next.memberFirst),
          next.clusterFirst,
        );
        f.ccount!.set(saved.ccount, next.clusterFirst);
        f.comega!.set(saved.comega, next.clusterFirst);
        f.cproxy!.set(saved.cproxy, next.clusterFirst);
        memberNames.forEach((name, n) => {
          const part = saved.members[n]!;
          f[name]!.set(name === 'member' ? part.map((v) => v + b.firstParticle) : part, next.memberFirst);
        });
      }
      b.cellRange = next;
      this.cellTotal += r.count;
      this.clusterTotal += r.clusterCount;
      this.memberTotal += r.memberCount;
    });
    this.particleCount = particles;
    this.edgeCount = edges;
    body.removed = true;
    for (const info of body.clusterInfo) {
      if (info.proxy?.valid) this.physics.removeBody(info.proxy);
      info.proxy = null;
    }
    this.attachments = this.attachments.filter((a) => a.soft !== body);
    for (const mesh of this.bound.filter((m) => m.soft === body)) mesh.host.remove();
    this.bound = this.bound.filter((m) => m.soft !== body);
    body.surface?.remove();
    body.surface = null;
    this.bodies.splice(at, 1);
    this.syncCloth();
    this.syncVolume(null);
  }

  /** @internal Steps with the world: forces first, then the kernel's pieces with the rigid world's contacts between them. */
  beforeStep(dt: number): void {
    // The force and torque the bodies were pushed with last step come off (the rigid world keeps a force until it is taken back;
    // the impulse part of a push lands once).
    for (const [body, [force, torque]] of this.pushes) {
      if (!body.valid) continue;
      body.addForce([-force[0], -force[1], -force[2]], undefined, false);
      body.addTorque([-torque[0], -torque[1], -torque[2]], false);
    }
    this.pushes.clear();
    if (this.particleCount === 0) return;
    // Where every particle starts the step, for drawing between steps.
    for (const body of this.bodies) body.remember();
    this.applyForces(this.columns(), dt);
    const h = dt / this.substeps,
      g = this.physics.gravity,
      rows = new Map<number, number>(),
      bodies: PhysicsBody[] = [];
    this.reserve(this.particleCount, this.edgeCount, this.bodies.length, 0);
    this.view = null;
    this.exports.soft_fem_damping(this.cellDamping);
    this.exports.soft_fem_implicit_settings(this.femLinearTolerance, this.femMaxLinearIterations, this.femMaxDenseDofs);
    this.findPlanes(dt, rows, bodies);
    this.takeFromProxies();
    this.exports.soft_fem_step_begin();
    this.exports.soft_begin(dt);
    // The passes of the body that asks for the most are the world's (the passes of a coupled island are the largest asked).
    let extra = 0;
    for (const b of this.bodies) extra = Math.max(extra, b.additionalIterations);
    for (let piece = 0; piece < this.substeps; piece++) {
      this.exports.soft_pre(h, this.iterations + extra, g[0], g[1], g[2]);
      // A body touched by many particles settles over a few passes, each meeting the body where the last left it.
      for (let pass = 0; pass < 4; pass++) this.exports.soft_apply(h, h * (piece + 1));
      this.exports.soft_post(h);
    }
    this.exports.soft_finish();
    this.giveToProxies(dt);
    const c = this.columns();
    // The rigid step moves each body the soft bodies pushed: it gets an impulse at its start and a steady force over it, chosen so
    // the rigid world's own substeps carry a free body to the velocity and the place the soft step took it to. A push that
    // stopped a body at the first touch lands at once (as a force spread over the step, it would let the body sink on through
    // the step and be thrown back out the next), and a push that holds a body up is a force, which neither lifts nor drops it.
    // The spin lands whole at the start: the change of angular velocity the soft step gave the body, which it worked out with the
    // body's inertia turning as the body turned. A body at rest takes no turn from what holds it (gravity has no moment about its
    // centre of mass), so nothing creeps; and handing over the angular impulse instead would have the rigid world turn it into a
    // velocity with the inertia of another moment, which on a body of very uneven inertia (a thin rod, whose inertia about its own
    // axis is tiny) is a spin the soft step never gave.
    // A cluster's proxy is put where its cluster is by giveToProxies; it takes its push as a force and a torque over the step and no
    // motion of its own.
    const hostShare = (this.physics.substeps + 1) / (2 * this.physics.substeps),
      softShare = (this.substeps + 1) / (2 * this.substeps),
      proxies = new Set<PhysicsBody>();
    for (const b of this.bodies) for (const info of b.clusterInfo) if (info.proxy) proxies.add(info.proxy);
    bodies.forEach((body, row) => {
      // A body of a higher dominance group than the soft body's is not pushed by it.
      if (body.type !== 'dynamic' || body.dominance > (this.rowGroups[row] ?? 0)) return;
      const j: Vec3 = [c.jx[row]!, c.jy[row]!, c.jz[row]!],
        k: Vec3 = [c.kx[row]!, c.ky[row]!, c.kz[row]!];
      if (j[0] === 0 && j[1] === 0 && j[2] === 0 && k[0] === 0 && k[1] === 0 && k[2] === 0) return;
      if (proxies.has(body)) {
        const force: Vec3 = [j[0] / dt, j[1] / dt, j[2] / dt],
          torque: Vec3 = [k[0] / dt, k[1] / dt, k[2] / dt];
        body.addForce(force);
        body.addTorque(torque);
        const had = this.pushes.get(body);
        this.pushes.set(
          body,
          had
            ? [
                [had[0][0] + force[0], had[0][1] + force[1], had[0][2] + force[2]],
                [had[1][0] + torque[0], had[1][1] + torque[1], had[1][2] + torque[2]],
              ]
            : [force, torque],
        );
        return;
      }
      const impulse = startOfStep(body, c, row, j, dt, g, hostShare, softShare),
        force: Vec3 = [(j[0] - impulse[0]) / dt, (j[1] - impulse[1]) / dt, (j[2] - impulse[2]) / dt];
      body.applyImpulse(impulse);
      const spin = body.angularVelocity;
      body.setAngularVelocity([
        spin[0] + c.avx[row]! - c.a0x[row]!,
        spin[1] + c.avy[row]! - c.a0y[row]!,
        spin[2] + c.avz[row]! - c.a0z[row]!,
      ]);
      body.addForce(force);
      const had = this.pushes.get(body);
      this.pushes.set(
        body,
        had ? [[had[0][0] + force[0], had[0][1] + force[1], had[0][2] + force[2]], had[1]] : [force, [0, 0, 0]],
      );
    });
    const cellsTorn = this.exports.soft_fem_torn();
    if (this.exports.soft_torn() > 0 || cellsTorn !== this.cellsTornSeen || this.cellTornByHand) {
      this.cellsTornSeen = cellsTorn;
      this.cellTornByHand = false;
      this.report(c);
    }
    for (const body of this.bodies) if (body.surface) this.moveSurface(body, c);
    for (const mesh of this.bound) this.moveBound(mesh, c);
    this.updateSleep(dt, c);
  }

  /**
   * Asks the rigid world once for the step what each free particle will meet: up to four planes each, from the rigid world's
   * swept contact query (every shape, a moving collider swept along its own motion, a deformable mesh's vertex speeds), and
   * hands them to the kernel, which keeps the particle outside every one at each piece of the step. Then the same for each
   * triangle of a body (the face query): a body smaller than the spacing of the particles, or a thin one lying between them,
   * meets the triangle under it, which the kernel holds a thickness (the particles' radius) out of it.
   */
  private findPlanes(dt: number, rows: Map<number, number>, bodies: PhysicsBody[]): void {
    let c = this.columns();
    c.kc.fill(0);
    const g = this.physics.gravity;
    interface Found {
      row: number;
      slot: number;
      collider: number;
      body: number;
      soft: SoftBody;
      normal: Vec3;
      point: Vec3;
      velocity: Vec3;
      curvature: number;
      friction?: number;
    }
    const found: Found[] = [];
    for (const soft of this.bodies) {
      const free: number[] = [];
      for (let i = 0; i < soft.particles; i++) if (c.w[soft.firstParticle + i]! > 0) free.push(soft.firstParticle + i);
      if (free.length === 0) continue;
      const scale = c.gravity_scale[soft.handle]!,
        from = new Float32Array(free.length * 3),
        to = new Float32Array(free.length * 3),
        radius = new Float32Array(free.length),
        margin = new Float32Array(free.length);
      free.forEach((row, k) => {
        const v = [c.vx[row]! + g[0] * scale * dt, c.vy[row]! + g[1] * scale * dt, c.vz[row]! + g[2] * scale * dt];
        from[k * 3] = c.x[row]!;
        from[k * 3 + 1] = c.y[row]!;
        from[k * 3 + 2] = c.z[row]!;
        to[k * 3] = c.x[row]! + v[0]! * dt;
        to[k * 3 + 1] = c.y[row]! + v[1]! * dt;
        to[k * 3 + 2] = c.z[row]! + v[2]! * dt;
        radius[k] = c.radius[row]!;
        // A particle may end the step elsewhere than this guess (other forces, the edges), so planes within twice its move are kept.
        margin[k] = Math.max(0.03, 2 * Math.hypot(v[0]! * dt, v[1]! * dt, v[2]! * dt) + c.radius[row]!);
      });
      // Sensors are left out (query flag 8), and so is the body's own surface collider.
      const hit = this.physics.softContacts({ from, to, radius, margin }, 4, {
        dt,
        flags: 8,
        groups: soft.collisionGroups,
        exclude: soft.surface ?? undefined,
      });
      for (let k = 0; k < free.length; k++)
        for (let slot = 0; slot < 4; slot++) {
          const at = k * 4 + slot;
          if (hit.collider[at] === 0xffffffff) continue;
          // The body's own deformable meshes are not obstacles to it.
          if (this.bound.some((m) => m.soft === soft && m.host.row === hit.body[at])) continue;
          if (
            soft.asleep &&
            Math.hypot(hit.velocity[at * 3]!, hit.velocity[at * 3 + 1]!, hit.velocity[at * 3 + 2]!) > 0.05
          )
            soft.wake();
          found.push({
            row: free[k]!,
            slot,
            collider: hit.collider[at]!,
            body: hit.body[at]!,
            soft,
            normal: [hit.normal[at * 3]!, hit.normal[at * 3 + 1]!, hit.normal[at * 3 + 2]!],
            point: [hit.point[at * 3]!, hit.point[at * 3 + 1]!, hit.point[at * 3 + 2]!],
            velocity: [hit.velocity[at * 3]!, hit.velocity[at * 3 + 1]!, hit.velocity[at * 3 + 2]!],
            curvature: hit.curvature[at]!,
          });
        }
    }
    // The faces: each triangle where its corners are and where they end the step (a pinned corner stays, or goes to its target),
    // as thick as its corners' radius, so the corner balls and the faces make one surface.
    interface FoundFace {
      corners: [number, number, number];
      weights: [number, number, number];
      collider: number;
      body: number;
      soft: SoftBody;
      normal: Vec3;
      point: Vec3;
      velocity: Vec3;
      thickness: number;
      curvature: number;
      friction?: number;
    }
    const faces: FoundFace[] = [];
    for (const soft of this.bodies) {
      const list = soft.triangleList,
        count = list.length / 3;
      if (count === 0) continue;
      const scale = c.gravity_scale[soft.handle]!,
        from = new Float32Array(count * 9),
        to = new Float32Array(count * 9),
        thickness = new Float32Array(count),
        margin = new Float32Array(count),
        end = (row: number): Vec3 => {
          if (c.w[row]! > 0)
            return [
              c.x[row]! + (c.vx[row]! + g[0] * scale * dt) * dt,
              c.y[row]! + (c.vy[row]! + g[1] * scale * dt) * dt,
              c.z[row]! + (c.vz[row]! + g[2] * scale * dt) * dt,
            ];
          if (c.pflags[row]! & TARGETED) return [c.tx[row]!, c.ty[row]!, c.tz[row]!];
          return [c.x[row]!, c.y[row]!, c.z[row]!];
        };
      for (let t = 0; t < count; t++) {
        let move = 0,
          thick = 0;
        for (let k = 0; k < 3; k++) {
          const row = soft.firstParticle + list[t * 3 + k]!,
            e = end(row);
          from[t * 9 + k * 3] = c.x[row]!;
          from[t * 9 + k * 3 + 1] = c.y[row]!;
          from[t * 9 + k * 3 + 2] = c.z[row]!;
          to[t * 9 + k * 3] = e[0];
          to[t * 9 + k * 3 + 1] = e[1];
          to[t * 9 + k * 3 + 2] = e[2];
          move = Math.max(move, Math.hypot(e[0] - c.x[row]!, e[1] - c.y[row]!, e[2] - c.z[row]!));
          thick = Math.max(thick, c.radius[row]!);
        }
        thickness[t] = thick;
        // The triangle may end the step elsewhere than this guess, so contacts within twice its move past the thickness are kept.
        margin[t] = Math.max(0.01, 2 * move);
      }
      const hit = this.physics.softFaceContacts({ from, to, thickness, margin }, 4, {
        dt,
        flags: 8,
        groups: soft.collisionGroups,
        exclude: soft.surface ?? undefined,
      });
      for (let t = 0; t < count; t++)
        for (let slot = 0; slot < 4; slot++) {
          const at = t * 4 + slot;
          if (hit.collider[at] === 0xffffffff) continue;
          if (this.bound.some((m) => m.soft === soft && m.host.row === hit.body[at])) continue;
          if (
            soft.asleep &&
            Math.hypot(hit.velocity[at * 3]!, hit.velocity[at * 3 + 1]!, hit.velocity[at * 3 + 2]!) > 0.05
          )
            soft.wake();
          faces.push({
            corners: [list[t * 3]!, list[t * 3 + 1]!, list[t * 3 + 2]!],
            weights: [hit.weights[at * 3]!, hit.weights[at * 3 + 1]!, hit.weights[at * 3 + 2]!],
            collider: hit.collider[at]!,
            body: hit.body[at]!,
            soft,
            normal: [hit.normal[at * 3]!, hit.normal[at * 3 + 1]!, hit.normal[at * 3 + 2]!],
            point: [hit.point[at * 3]!, hit.point[at * 3 + 1]!, hit.point[at * 3 + 2]!],
            velocity: [hit.velocity[at * 3]!, hit.velocity[at * 3 + 1]!, hit.velocity[at * 3 + 2]!],
            thickness: thickness[t]!,
            curvature: hit.curvature[at]!,
          });
        }
    }
    // The bodies the planes and the attachments belong to get a row each, with what the kernel needs to share a contact with
    // them.
    if (this.contactHook) {
      const hook = this.contactHook,
        kept: typeof found = [];
      for (const f of found) {
        const collider = this.physics.colliderOf(f.collider);
        if (!collider || !collider.activeHooks().modifyContacts) {
          kept.push(f);
          continue;
        }
        const row = f.row,
          contact: SoftContact = {
            soft: f.soft,
            particle: row - f.soft.firstParticle,
            face: null,
            weights: null,
            collider,
            particleVelocity: [c.vx[row]!, c.vy[row]!, c.vz[row]!],
            normal: [...f.normal],
            point: [...f.point],
            velocity: [...f.velocity],
            friction: collider.friction(),
            enabled: true,
          };
        hook(contact);
        if (!contact.enabled) continue;
        const length = Math.hypot(...contact.normal);
        if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('A contact normal must have a length.');
        f.normal = [contact.normal[0] / length, contact.normal[1] / length, contact.normal[2] / length];
        f.point = [...contact.point];
        f.velocity = [...contact.velocity];
        f.friction = contact.friction;
        kept.push(f);
      }
      found.length = 0;
      found.push(...kept);
      const keptFaces: FoundFace[] = [];
      for (const f of faces) {
        const collider = this.physics.colliderOf(f.collider);
        if (!collider || !collider.activeHooks().modifyContacts) {
          keptFaces.push(f);
          continue;
        }
        const rows3 = f.corners.map((k) => f.soft.firstParticle + k),
          heaviest =
            f.weights[0] >= f.weights[1] && f.weights[0] >= f.weights[2] ? 0 : f.weights[1] >= f.weights[2] ? 1 : 2,
          contact: SoftContact = {
            soft: f.soft,
            particle: f.corners[heaviest],
            face: [...f.corners],
            weights: [...f.weights],
            collider,
            particleVelocity: [
              rows3.reduce((sum, row, k) => sum + f.weights[k]! * c.vx[row]!, 0),
              rows3.reduce((sum, row, k) => sum + f.weights[k]! * c.vy[row]!, 0),
              rows3.reduce((sum, row, k) => sum + f.weights[k]! * c.vz[row]!, 0),
            ],
            normal: [...f.normal],
            point: [...f.point],
            velocity: [...f.velocity],
            friction: collider.friction(),
            enabled: true,
          };
        hook(contact);
        if (!contact.enabled) continue;
        const length = Math.hypot(...contact.normal);
        if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('A contact normal must have a length.');
        f.normal = [contact.normal[0] / length, contact.normal[1] / length, contact.normal[2] / length];
        f.point = [...contact.point];
        f.velocity = [...contact.velocity];
        f.friction = contact.friction;
        keptFaces.push(f);
      }
      faces.length = 0;
      faces.push(...keptFaces);
    }
    // A row is one rigid body as one soft body's dominance group sees it, so two groups at one body have two rows.
    const key = (bodyRow: number, soft: SoftBody): number => bodyRow * 256 + ((soft.dominance + 128) & 255);
    this.rowGroups = [];
    const live = this.attachments.filter((a) => !a.soft.removed && a.body.valid);
    for (const a of live) {
      if (rows.has(key(a.body.row, a.soft))) continue;
      rows.set(key(a.body.row, a.soft), bodies.length);
      bodies.push(a.body);
      this.rowGroups.push(a.soft.dominance);
    }
    for (const f of [...found, ...faces]) {
      if (rows.has(key(f.body, f.soft))) continue;
      const owner = this.physics.bodyOfCollider(f.collider);
      if (!owner) continue;
      rows.set(key(f.body, f.soft), bodies.length);
      bodies.push(owner);
      this.rowGroups.push(f.soft.dominance);
    }
    this.exports.soft_face_reserve(faces.length);
    this.capacity[6] = Math.max(this.capacity[6]!, faces.length);
    this.exports.soft_attach_reserve(live.length);
    this.capacity[4] = Math.max(this.capacity[4]!, live.length);
    if (bodies.length) this.reserve(this.particleCount, this.edgeCount, this.bodies.length, bodies.length);
    this.view = null;
    c = this.columns();
    bodies.forEach((owner, row) => this.writeBody(c, row, owner));
    live.forEach((a, k) => {
      const lever = rotate(a.body.rotation, [
        a.local[0] - a.body.centerOfMass[0],
        a.local[1] - a.body.centerOfMass[1],
        a.local[2] - a.body.centerOfMass[2],
      ]);
      c.at_p[k] = a.soft.firstParticle + a.index;
      c.at_row[k] = rows.get(key(a.body.row, a.soft))! + 1;
      c.at_rx[k] = lever[0];
      c.at_ry[k] = lever[1];
      c.at_rz[k] = lever[2];
    });
    for (const f of found) {
      const table = rows.get(key(f.body, f.soft));
      if (table === undefined) continue;
      const k = f.row * 4 + f.slot;
      c.kc[k] = table + 1;
      c.knx[k] = f.normal[0];
      c.kny[k] = f.normal[1];
      c.knz[k] = f.normal[2];
      c.kpx[k] = f.point[0];
      c.kpy[k] = f.point[1];
      c.kpz[k] = f.point[2];
      c.kvx[k] = f.velocity[0];
      c.kvy[k] = f.velocity[1];
      c.kvz[k] = f.velocity[2];
      c.kf[k] = f.friction ?? this.physics.colliderOf(f.collider)?.friction() ?? 0.5;
      c.kr[k] = f.curvature;
    }
    faces.forEach((f, k) => {
      const table = rows.get(key(f.body, f.soft));
      c.fc_row[k] = table === undefined ? 0 : table + 1;
      c.fc_a[k] = f.soft.firstParticle + f.corners[0];
      c.fc_b[k] = f.soft.firstParticle + f.corners[1];
      c.fc_c[k] = f.soft.firstParticle + f.corners[2];
      c.fc_wa[k] = f.weights[0];
      c.fc_wb[k] = f.weights[1];
      c.fc_wc[k] = f.weights[2];
      c.fc_nx[k] = f.normal[0];
      c.fc_ny[k] = f.normal[1];
      c.fc_nz[k] = f.normal[2];
      c.fc_px[k] = f.point[0];
      c.fc_py[k] = f.point[1];
      c.fc_pz[k] = f.point[2];
      c.fc_vx[k] = f.velocity[0];
      c.fc_vy[k] = f.velocity[1];
      c.fc_vz[k] = f.velocity[2];
      c.fc_f[k] = f.friction ?? this.physics.colliderOf(f.collider)?.friction() ?? 0.5;
      c.fc_r[k] = f.thickness;
      c.fc_j[k] = 0;
      c.fc_k[k] = f.curvature;
    });
  }

  /** Writes what the kernel needs to share a contact with a body: where it turns, how it moves, how heavy it is. */
  private writeBody(c: Columns, row: number, body: PhysicsBody): void {
    const r = rotate(body.rotation, body.centerOfMass),
      lv = body.linearVelocity,
      av = body.angularVelocity,
      inverse = inverseMass(body);
    c.mx[row] = body.position[0] + r[0];
    c.my[row] = body.position[1] + r[1];
    c.mz[row] = body.position[2] + r[2];
    c.m0x[row] = c.mx[row]!;
    c.m0y[row] = c.my[row]!;
    c.m0z[row] = c.mz[row]!;
    c.a0x[row] = av[0];
    c.a0y[row] = av[1];
    c.a0z[row] = av[2];
    c.l0x[row] = lv[0];
    c.l0y[row] = lv[1];
    c.l0z[row] = lv[2];
    c.lvx[row] = lv[0];
    c.lvy[row] = lv[1];
    c.lvz[row] = lv[2];
    c.avx[row] = av[0];
    c.avy[row] = av[1];
    c.avz[row] = av[2];
    // Dominance: a rigid body of a higher group than the soft body's is immovable to its particles; of a lower one, it takes the
    // whole correction while the particles hold.
    const group = this.rowGroups[row] ?? 0;
    if (body.dominance > group) for (let k = 0; k < 7; k++) inverse[k] = 0;
    c.dom[row] = group > body.dominance ? 1 : 0;
    c.wm[row] = inverse[0]!;
    c.gs[row] = body.gravityScale;
    c.iixx[row] = inverse[1]!;
    c.iixy[row] = inverse[2]!;
    c.iixz[row] = inverse[3]!;
    c.iiyy[row] = inverse[4]!;
    c.iiyz[row] = inverse[5]!;
    c.iizz[row] = inverse[6]!;
    c.jx[row] = c.jy[row] = c.jz[row] = c.kx[row] = c.ky[row] = c.kz[row] = 0;
  }

  private applyForces(c: Columns, dt: number): void {
    for (const body of this.bodies) {
      const total = body.mass();
      for (let i = 0; i < body.particles; i++) {
        const row = body.firstParticle + i;
        if (c.w[row] === 0) continue;
        // The whole-body force is shared by mass, so every particle accelerates by force / total mass.
        let fx = body.force[0] / total,
          fy = body.force[1] / total,
          fz = body.force[2] / total;
        const own = body.pointForces.get(i);
        if (own) {
          fx += own[0] * c.w[row]!;
          fy += own[1] * c.w[row]!;
          fz += own[2] * c.w[row]!;
        }
        c.vx[row] = c.vx[row]! + fx * dt;
        c.vy[row] = c.vy[row]! + fy * dt;
        c.vz[row] = c.vz[row]! + fz * dt;
      }
    }
  }

  /**
   * Gives a body made from triangles (`trimesh`, `cloth`, `clothTube`) a deformable triangle-mesh collider that follows its
   * particles each step, so every rigid shape, meshes and hulls included, meets the moving surface (the collider's contacts
   * see each vertex's speed, so friction and bounce count it). Particles still meet spheres, boxes and capsules directly and
   * push them back; a surface collider is how the other shapes feel the body. It is removed with the body.
   */
  createSurfaceCollider(body: SoftBody, settings: Omit<ColliderSettings, 'offset' | 'rotation'> = {}): PhysicsCollider {
    if (body.removed) throw new MargoError('state', 'Soft body was removed; create a new one with SoftBodies.create.');
    if (body.surface)
      throw new MargoError('state', 'This soft body already has a surface collider; use the one it has.');
    // A body with a skin collides by its skin (Rapier's skin collision): the mesh a game draws is the mesh that is met.
    const skin = body.skin !== null;
    if (!skin && body.triangleList.length === 0)
      throw new RangeError('This body has no triangles or skin; build it with trimesh, cloth, clothTube or setSkin.');
    const host = this.physics.addBody(null, {
      type: 'fixed',
      colliders: {
        shape: 'trimesh',
        vertices: skin ? body.meshVertices() : body.particlePositions(),
        indices: skin ? body.meshIndices() : body.triangleList,
        deformable: true,
        oriented: body.oriented ?? (body.volumeOn || skin),
        ...settings,
      },
    });
    body.surface = host;
    return host.colliders[0]!;
  }

  /**
   * A deformable triangle-mesh collider of its own (any mesh, `vertices` flat x, y, z and `indices` three a triangle) whose
   * vertices follow a soft body by `binding`, so every rigid shape meets the mesh as it moves, with each vertex's speed
   * counted (Rapier's `createDeformableCollider`). Its vertices are moved to their particles at once. It goes with the body.
   * @throws RangeError for a binding that does not fit: a particle that is not the body's, a vertex with no particle within
   * `eps`, or a skinned binding on a body with no cells.
   */
  createDeformableCollider(
    soft: SoftBody,
    mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> },
    binding: SoftMeshBinding,
    settings: Omit<ColliderSettings, 'offset' | 'rotation'> = {},
  ): PhysicsCollider {
    if (soft.removed) throw new MargoError('state', 'Soft body was removed; create a new one with SoftBodies.create.');
    const count = mesh.vertices.length / 3;
    if (!Number.isInteger(count) || count < 3)
      throw new RangeError('A mesh has vertices, three numbers each; pass at least three of them.');
    const c = this.columns(),
      near: number[] = [],
      bound: BoundMesh = {
        soft,
        host: null as unknown as PhysicsBody,
        particles: new Uint32Array(0),
        weights: new Float32Array(0),
        per: 1,
      };
    if (binding.mode === 'direct') {
      if (binding.particles.length !== count)
        throw new RangeError(
          `A direct binding names one particle for each of the ${count} vertices; pass one particle for each vertex.`,
        );
      for (const k of binding.particles)
        if (!Number.isInteger(k) || k < 0 || k >= soft.particles)
          throw new RangeError(`Particle ${k} must be in this body (0 to ${soft.particles - 1}).`);
      bound.particles = Uint32Array.from(binding.particles, (k) => soft.firstParticle + k);
      bound.weights = new Float32Array(count).fill(1);
    } else if (binding.mode === 'directByPosition') {
      for (let v = 0; v < count; v++) {
        let best = -1,
          bestD = binding.eps;
        for (let i = 0; i < soft.particles; i++) {
          const row = soft.firstParticle + i,
            d = Math.hypot(
              c.x[row]! - mesh.vertices[v * 3]!,
              c.y[row]! - mesh.vertices[v * 3 + 1]!,
              c.z[row]! - mesh.vertices[v * 3 + 2]!,
            );
          if (d <= bestD) {
            bestD = d;
            best = row;
          }
        }
        if (best < 0) throw new RangeError(`Vertex ${v} has no particle within ${binding.eps} m.`);
        near.push(best);
      }
      bound.particles = Uint32Array.from(near);
      bound.weights = new Float32Array(count).fill(1);
    } else {
      if (soft.cellRange.count === 0)
        throw new RangeError('A skinned binding needs a body of cells: build it with box or solid.');
      const f = this.cellColumns(),
        { first, count: cells } = soft.cellRange;
      bound.per = 4;
      bound.particles = new Uint32Array(count * 4);
      bound.weights = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) {
        const p: Vec3 = [mesh.vertices[v * 3]!, mesh.vertices[v * 3 + 1]!, mesh.vertices[v * 3 + 2]!];
        let bestCell = -1,
          bestWorst = -Infinity,
          bestWeights = [0, 0, 0, 0];
        for (let t = 0; t < cells; t++) {
          const idx = [0, 1, 2, 3].map((k) => f[`p${k}`]![first + t]!),
            a = idx.map((i) => [c.x[i]!, c.y[i]!, c.z[i]!] as Vec3),
            weights = barycentric(a as [Vec3, Vec3, Vec3, Vec3], p);
          // The cell that holds the point has all its weights non-negative; failing that, the one it is nearest to.
          const worst = Math.min(...weights);
          if (worst > bestWorst) {
            bestWorst = worst;
            bestCell = t;
            bestWeights = weights;
          }
        }
        for (let k = 0; k < 4; k++) {
          bound.particles[v * 4 + k] = f[`p${k}`]![first + bestCell]!;
          bound.weights[v * 4 + k] = bestWeights[k]!;
        }
      }
    }
    const positions = this.boundPositions(bound, c, count).positions;
    bound.host = this.physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'trimesh', vertices: positions, indices: mesh.indices, deformable: true, ...settings },
    });
    this.bound.push(bound);
    return bound.host.colliders[0]!;
  }

  private boundPositions(
    mesh: BoundMesh,
    c: Columns,
    count: number,
  ): { positions: Float32Array; velocities: Float32Array } {
    const positions = new Float32Array(count * 3),
      velocities = new Float32Array(count * 3);
    for (let v = 0; v < count; v++)
      for (let k = 0; k < mesh.per; k++) {
        const row = mesh.particles[v * mesh.per + k]!,
          w = mesh.weights[v * mesh.per + k]!;
        positions[v * 3] += w * c.x[row]!;
        positions[v * 3 + 1] += w * c.y[row]!;
        positions[v * 3 + 2] += w * c.z[row]!;
        velocities[v * 3] += w * c.vx[row]!;
        velocities[v * 3 + 1] += w * c.vy[row]!;
        velocities[v * 3 + 2] += w * c.vz[row]!;
      }
    return { positions, velocities };
  }

  private moveBound(mesh: BoundMesh, c: Columns): void {
    if (mesh.soft.removed || !mesh.host.valid) return;
    const count = mesh.particles.length / mesh.per,
      { positions, velocities } = this.boundPositions(mesh, c, count);
    mesh.host.colliders[0]!.setVertices(positions, { velocities });
  }

  private moveSurface(body: SoftBody, c: Columns): void {
    if (body.skin) {
      // The skin's vertices ride the cells; their speeds are the cells' corners' speeds by the same weights.
      const positions = body.meshVertices(),
        velocities = new Float32Array(positions.length);
      for (let i = 0; i < body.skin.cell.length; i++)
        for (let k = 0; k < 4; k++) {
          const row = body.firstParticle + body.skinCells[body.skin.cell[i]! * 4 + k]!,
            w = body.skin.weight[i * 4 + k]!;
          velocities[i * 3] = velocities[i * 3]! + w * c.vx[row]!;
          velocities[i * 3 + 1] = velocities[i * 3 + 1]! + w * c.vy[row]!;
          velocities[i * 3 + 2] = velocities[i * 3 + 2]! + w * c.vz[row]!;
        }
      body.surface!.colliders[0]!.setVertices(positions, { velocities });
      return;
    }
    const positions = new Float32Array(body.particles * 3),
      velocities = new Float32Array(body.particles * 3);
    for (let i = 0; i < body.particles; i++) {
      const row = body.firstParticle + i;
      positions[i * 3] = c.x[row]!;
      positions[i * 3 + 1] = c.y[row]!;
      positions[i * 3 + 2] = c.z[row]!;
      velocities[i * 3] = c.vx[row]!;
      velocities[i * 3 + 1] = c.vy[row]!;
      velocities[i * 3 + 2] = c.vz[row]!;
    }
    body.surface!.colliders[0]!.setVertices(positions, { velocities });
  }

  private report(c: Columns): void {
    for (const body of [...this.bodies]) {
      c = this.columns();
      const fresh: number[] = [],
        freshCells: number[] = [];
      for (let e = 0; e < body.structural; e++)
        if ((c.eflags[body.firstEdge + e]! & TORN) !== 0 && !body.tornSeen.has(e)) {
          body.tornSeen.add(e);
          fresh.push(e);
        }
      if (body.cellRange.count) {
        const { flags } = this.cellColumns();
        for (let t = 0; t < body.cellRange.count; t++)
          if ((flags![body.cellRange.first + t]! & TORN_CELL) !== 0 && !body.cellsTornSeen.has(t)) {
            body.cellsTornSeen.add(t);
            freshCells.push(t);
          }
      }
      if (fresh.length || freshCells.length) this.announce(body, fresh, freshCells, this.splitAfterTear(body));
    }
  }

  private splitAfterTear(body: SoftBody, cut?: ReadonlySet<number>): SoftSplit | null {
    if (this.splitOnTear === 'never' || (body.cellRange.count === 0 && this.splitOnTear !== 'all')) return null;
    return splitBody(this, body, (positions) => new SoftBodyDesc(positions), cut);
  }

  private announce(body: SoftBody, edges: number[], cells: number[], split: SoftSplit | null): SoftTearEvent {
    const event: SoftTearEvent = {
      body,
      edges,
      cells,
      pieces: split?.pieces ?? [],
      destination: (particle) => split?.destinations(particle) ?? [],
    };
    for (const listener of [...this.listeners]) listener(event);
    return event;
  }

  /**
   * Tears the given cells and edges of a body at once (numbered as `body.cells()` and `body.edges()` do), splits the body where it
   * is parted, and tells the tear listeners. Returns the event: its `pieces` and `destination` say what became of the body.
   */
  tear(
    body: SoftBody,
    { cells = [], edges = [] }: { cells?: readonly number[]; edges?: readonly number[] } = {},
  ): SoftTearEvent {
    if (body.removed) throw new MargoError('state', 'Soft body was removed; create a new one with SoftBodies.create.');
    const freshCells: number[] = [],
      freshEdges: number[] = [];
    for (const cell of cells)
      if (!body.isCellTorn(cell)) {
        body.tearCell(cell);
        body.cellsTornSeen.add(cell);
        freshCells.push(cell);
      }
    for (const edge of edges)
      if (!body.isEdgeTorn(edge)) {
        body.tearEdge(edge);
        body.tornSeen.add(edge);
        freshEdges.push(edge);
      }
    this.cellTornByHand = false;
    return this.announce(body, freshEdges, freshCells, this.splitAfterTear(body));
  }

  /**
   * Cuts a body along a blade, a triangle of three points: every face of its cells that the blade meets is parted, the particles
   * along it are duplicated and the body becomes the pieces the cut leaves. No material is removed. Returns the event.
   */
  cut(body: SoftBody, blade: readonly [Vec3, Vec3, Vec3]): SoftTearEvent {
    if (body.removed) throw new MargoError('state', 'Soft body was removed; create a new one with SoftBodies.create.');
    for (const point of blade) checkVec(point, 'Blade point');
    const f = this.cellColumns(),
      c = this.columns(),
      { first, count } = body.cellRange,
      at = (row: number): Vec3 => [c.x[row]!, c.y[row]!, c.z[row]!],
      cutFaces = new Set<number>();
    // A cell is on the side of the blade's plane its centre is on; a face the blade meets is parted when the cells either side of it
    // are on opposite sides, so no cell is cut in two and no material is removed.
    const [p0, p1, p2] = blade,
      u: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]],
      v: Vec3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]],
      normal: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      side = (t: number): number => {
        let d = 0;
        for (let k = 0; k < 4; k++) {
          const q = at(f[`p${k}`]![t]!);
          d += (normal[0] * (q[0] - p0[0]) + normal[1] * (q[1] - p0[1]) + normal[2] * (q[2] - p0[2])) / 4;
        }
        return d;
      };
    for (let t = first; t < first + count; t++) {
      if ((f.flags![t]! & TORN_CELL) !== 0) continue;
      const corner = [0, 1, 2, 3].map((k) => at(f[`p${k}`]![t]!));
      for (let k = 0; k < 4; k++) {
        const other = f[`nb${k}`]![t]!;
        if (other === NO_NEIGHBOUR || (f.flags![other]! & TORN_CELL) !== 0) continue;
        if (side(t) > 0 === side(other) > 0) continue;
        // The face's centre, carried onto the blade's plane, lies inside the blade.
        const mid = [0, 1, 2, 3]
            .filter((j) => j !== k)
            .reduce(
              (sum, j) => [sum[0]! + corner[j]![0] / 3, sum[1]! + corner[j]![1] / 3, sum[2]! + corner[j]![2] / 3],
              [0, 0, 0],
            ),
          w: Vec3 = [mid[0]! - p0[0], mid[1]! - p0[1], mid[2]! - p0[2]],
          area = normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2],
          cross = (a: Vec3, b: Vec3): number =>
            (a[1] * b[2] - a[2] * b[1]) * normal[0] +
            (a[2] * b[0] - a[0] * b[2]) * normal[1] +
            (a[0] * b[1] - a[1] * b[0]) * normal[2],
          beta = cross(w, v) / area,
          gamma = cross(u, w) / area;
        if (area > 0 && beta >= 0 && gamma >= 0 && beta + gamma <= 1) cutFaces.add(t * 4 + k);
      }
    }
    // An edge the blade passes through tears (cells' own edges lie on faces the cut already parts).
    const torn: number[] = [];
    if (count === 0)
      for (let e = 0; e < body.structural; e++) {
        if (body.isEdgeTorn(e)) continue;
        const p = at(c.ea[body.firstEdge + e]!),
          q = at(c.eb[body.firstEdge + e]!);
        if (crossesBlade([p, q, q], blade)) {
          body.tearEdge(e);
          body.tornSeen.add(e);
          torn.push(e);
        }
      }
    return this.announce(body, torn, [], this.splitAfterTear(body, cutFaces));
  }

  /** @internal Nothing to do after the sync: the particles are read on demand. */
  afterSync(): void {}
  /** @internal */
  bodyRemoved(_body: PhysicsBody): void {
    this.attachments = this.attachments.filter((a) => a.body !== _body);
  }

  /** Removes every soft body and leaves the world. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.physics.detach(this);
    for (const mesh of this.bound) mesh.host.remove();
    this.bound = [];
    for (const body of this.bodies) {
      body.removed = true;
      body.surface?.remove();
      body.surface = null;
      for (const info of body.clusterInfo) if (info.proxy?.valid) this.physics.removeBody(info.proxy);
    }
    this.bodies.length = 0;
    this.listeners.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** What a dynamic body's inverse mass and world inverse inertia are, for the kernel to share a contact's correction with it. */
/**
 * The part of a soft step's push `j` on a body that lands at the start of the rigid step. The soft step took the body's centre
 * `D` past where a free body would be; the rigid step adds an impulse `I` at its start and a force `(j - I) / dt` over its `n`
 * substeps, which move a free body by `I dt / m` plus `(j - I) dt (n + 1) / (2 n m)` (semi-implicit Euler, the rigid kernel's
 * integration). Equal to `D` that gives `I = m (D - c dt j / m) / ((1 - c) dt)` with `c = (n + 1) / 2n`. With one substep a force
 * and an impulse move a body alike, and all of it is a force.
 */
function startOfStep(
  body: PhysicsBody,
  c: Columns,
  row: number,
  j: Vec3,
  dt: number,
  gravity: readonly number[],
  hostShare: number,
  softShare: number,
): Vec3 {
  const wm = inverseMass(body)[0]!;
  if (!(1 - hostShare > 1e-6) || !(wm > 0)) return [0, 0, 0];
  const fall = (axis: number): number => gravity[axis]! * c.gs[row]! * dt * dt * softShare,
    // Where the soft step took the centre, past a free body's fall from where it was at the speed it had.
    beyond: Vec3 = [
      c.mx[row]! - (c.m0x[row]! + c.l0x[row]! * dt + fall(0)),
      c.my[row]! - (c.m0y[row]! + c.l0y[row]! * dt + fall(1)),
      c.mz[row]! - (c.m0z[row]! + c.l0z[row]! * dt + fall(2)),
    ],
    split = (1 - hostShare) * dt;
  return [0, 1, 2].map((a) => (beyond[a]! - hostShare * wm * j[a]! * dt) / (split * wm)) as unknown as Vec3;
}

/** The world rotation of a body's principal axes of inertia. */
function inertiaAxes(body: PhysicsBody): [number, number, number, number] {
  const f = body.inertiaFrame,
    r = body.rotation;
  return [
    r[3] * f[0] + r[0] * f[3] + r[1] * f[2] - r[2] * f[1],
    r[3] * f[1] - r[0] * f[2] + r[1] * f[3] + r[2] * f[0],
    r[3] * f[2] + r[0] * f[1] - r[1] * f[0] + r[2] * f[3],
    r[3] * f[3] - r[0] * f[0] - r[1] * f[1] - r[2] * f[2],
  ];
}

function inverseMass(body: PhysicsBody): number[] {
  if (body.type !== 'dynamic' || !(body.mass > 0)) return [0, 0, 0, 0, 0, 0, 0];
  const q = inertiaAxes(body),
    inertia = body.principalInertia,
    out = [1 / body.mass, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (!(inertia[k]! > 0)) continue;
    const e: Vec3 = [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0],
      a = rotate(q, e),
      w = 1 / inertia[k]!;
    out[1]! += w * a[0] * a[0];
    out[2]! += w * a[0] * a[1];
    out[3]! += w * a[0] * a[2];
    out[4]! += w * a[1] * a[1];
    out[5]! += w * a[1] * a[2];
    out[6]! += w * a[2] * a[2];
  }
  return out;
}

function rowsOf(
  name: string,
  particles: number,
  edges: number,
  bodies: number,
  colliders: number,
  attachments: number,
  volumeTriangles: number,
  faces: number,
): number {
  if (name === 'vtri') return volumeTriangles * 3;
  if (name.startsWith('fc_')) return faces;
  if (/^vb_/.test(name)) return bodies;
  if (/^at_(p|row|r[xyz])$/.test(name)) return attachments;
  if (/^(kc|kn[xyz]|kp[xyz]|kv[xyz]|kf|kj|kr)$/.test(name)) return particles * 4;
  if (/^(ea|eb|rest|omega|zeta|lambda|tear|eflags)$/.test(name)) return edges;
  if (/^(gravity_scale|linear_damping|bsleep|b_on|b_omega|b_zeta|b_first|b_count|bq[xyzw])$/.test(name)) return bodies;
  if (
    /^(c_kind|cx|cy|cz|q[xyzw]|s[xyz]|friction|lv[xyz]|av[xyz]|m[xyz]|j[xyz]|k[xyz]|wm|gs|dom|m0[xyz]|l0[xyz]|a0[xyz]|ro[xyz]|ii(xx|xy|xz|yy|yz|zz))$/.test(
      name,
    )
  )
    return colliders;
  return particles;
}

function rotate(q: readonly number[], v: readonly number[]): Vec3 {
  const [x, y, z, w] = q as [number, number, number, number],
    tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}

/** The barycentric weights of `p` in the tetrahedron `a` (they sum to 1; all are non-negative inside it). */
function barycentric(a: [Vec3, Vec3, Vec3, Vec3], p: Vec3): number[] {
  const m = [0, 1, 2].map((r) => [a[1][r]! - a[0][r]!, a[2][r]! - a[0][r]!, a[3][r]! - a[0][r]!]),
    b = [p[0] - a[0][0], p[1] - a[0][1], p[2] - a[0][2]],
    det = (x: number[][]): number =>
      x[0]![0]! * (x[1]![1]! * x[2]![2]! - x[1]![2]! * x[2]![1]!) -
      x[0]![1]! * (x[1]![0]! * x[2]![2]! - x[1]![2]! * x[2]![0]!) +
      x[0]![2]! * (x[1]![0]! * x[2]![1]! - x[1]![1]! * x[2]![0]!),
    d = det(m);
  if (Math.abs(d) < 1e-20) return [1, 0, 0, 0];
  const solve = (column: number): number => det(m.map((row, r) => row.map((v, c) => (c === column ? b[r]! : v)))) / d,
    w1 = solve(0),
    w2 = solve(1),
    w3 = solve(2);
  return [1 - w1 - w2 - w3, w1, w2, w3];
}
