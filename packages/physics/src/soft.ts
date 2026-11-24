/// <reference lib="esnext.disposable" preserve="true" />
// Soft bodies: ropes, cloth and particle meshes on their own small Rust kernel (compliant distance constraints, Macklin,
// Mueller and Chentanez, "XPBD", 2016; many small steps, Macklin et al., 2019), coupled both ways with the rigid world.
import { MargoError } from '@margoengine/math/errors';
import { LoadOnce } from '../../shared/load-once.js';
import type { PhysicsBody } from './body.js';
import type { PhysicsCollider } from './collider.js';
import type { ColliderSettings } from './shapes.js';
import { checkVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';

interface SoftExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  soft_reserve(particles: number, edges: number, bodies: number, colliders: number): void;
  soft_column(id: number): number;
  soft_step(dt: number, substeps: number, iterations: number, gx: number, gy: number, gz: number): void;
  soft_begin(dt: number): void;
  soft_pre(h: number, iterations: number, gx: number, gy: number, gz: number): void;
  soft_apply(h: number): void;
  soft_post(h: number): void;
  soft_finish(): void;
  soft_cloth_reserve(triangles: number, contacts: number): number;
  soft_cloth_enable(triangles: number, thickness: number, friction: number): void;
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
}

const PINNED = 1;
const TARGETED = 2;
const TORN = 1;
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
]);
const TORN_CELL = 1;
const INTEGER_CELL_COLUMNS = new Set(['p0', 'p1', 'p2', 'p3', 'model', 'flags', 'cstart', 'ccount', 'member']);

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
    copy.tearStrain = this.tearStrain;
    copy.shapeMatchingSoftness = { ...this.shapeMatchingSoftness };
    return copy;
  }
}

/** The elastic model of a body's cells. */
export type CellModel = 'neo-hookean' | 'corotated';

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
   * elasticity of Mueller and Gross (2004): stiffer for a given modulus at small strain.
   */
  model: CellModel = 'neo-hookean';
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
    throw new RangeError("Young's modulus is a positive number of pascals.");
  if (!(m.poissonRatio >= 0 && m.poissonRatio < 0.5))
    throw new RangeError("Poisson's ratio is 0 or more and below 0.5.");
  if (m.model !== 'neo-hookean' && m.model !== 'corotated')
    throw new RangeError("Cell model is 'neo-hookean' or 'corotated'.");
  if (!(m.density > 0 && Number.isFinite(m.density))) throw new RangeError('Density is a positive number of kg/m3.');
  for (const [value, label] of [
    [m.yieldStrain, 'yieldStrain'],
    [m.creep, 'creep'],
    [m.tearStrain, 'tearStrain'],
  ] as const)
    if (!(value >= 0 && Number.isFinite(value))) throw new RangeError(`${label} is 0 or more.`);
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
    throw new RangeError(`${label}: natural frequency is 0 (rigid) or a positive number of hertz.`);
  if (!(softness.dampingRatio >= 0 && Number.isFinite(softness.dampingRatio)))
    throw new RangeError(`${label}: damping ratio is 0 or more.`);
}

function checkMaterial(material: SoftBodyMaterial): void {
  checkSoftness(material.edgeSoftness, 'Edge softness');
  checkSoftness(material.bendSoftness, 'Bend softness');
  checkSoftness(material.shapeMatchingSoftness, 'Shape matching softness');
  if (!(material.tearStrain >= 0 && Number.isFinite(material.tearStrain)))
    throw new RangeError('tearStrain is 0 (never) or the stretch fraction that tears an edge.');
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
  /** @internal */ bendPairs: number[] = [];
  /** @internal */ masses: number[];
  /** @internal */ pinned = new Set<number>();
  /** @internal */ radius: number | null = null;
  /** @internal */ material = new SoftBodyMaterial();
  /** @internal */ gravity = 1;
  /** @internal */ damping = 0;
  /** @internal */ shift: Vec3 = [0, 0, 0];
  /** @internal */ shapeMatching = false;
  /** @internal */ selfContacts = false;
  /** @internal */ selfFriction = 0;
  /** @internal */ triangles: number[] = [];
  /** @internal Four particle indices per tetrahedron. */ cells: number[] = [];
  /** @internal */ cellMaterial = new CellMaterial();
  /** @internal Particle indices of each shape-matching cluster. */ clusterGroups: number[][] = [];
  /** @internal */ clusterHertz = 0;
  /** @internal Whether a mass was given, so the cells' density does not set one. */ massGiven = false;

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
      throw new RangeError('Particle positions are finite numbers, three per particle.');
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
  static clothTube(origin: Vec3, du: Vec3, dv: Vec3, nu: number, nv: number): SoftBodyDesc {
    count(nu, 'A tube has particles around; the count', 3);
    return SoftBodyDesc.sheet(origin, du, dv, nu, nv, true);
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
    const desc = new SoftBodyDesc(points);
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
      throw new RangeError('Indices are triangles, three per triangle.');
    const seen = new Map<number, number>(),
      key = (a: number, b: number): number => (a < b ? a * desc.particleCount + b : b * desc.particleCount + a),
      opposite = new Map<number, number[]>();
    for (let t = 0; t < indices.length; t += 3) {
      const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      for (const v of tri)
        if (!Number.isInteger(v) || v < 0 || v >= desc.particleCount)
          throw new RangeError(`Triangle index ${v} is not a vertex (0 to ${desc.particleCount - 1}).`);
      if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2])
        throw new RangeError(`Triangle ${t / 3} repeats a vertex.`);
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
    if (!(friction >= 0 && Number.isFinite(friction))) throw new RangeError('Friction is 0 or more.');
    this.selfContacts = on;
    this.selfFriction = friction;
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
    if (!(cell > 0 && Number.isFinite(cell))) throw new RangeError('Cell size is a positive number of metres.');
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
    if (kept.length === 0) throw new RangeError('The solid has no cells: `inside` accepted no cube of the grid.');
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
    const desc = new SoftBodyDesc(points).setCells(tets, material);
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
      throw new RangeError('A box has cubic cells: size divided by counts is the same along every axis.');
    return SoftBodyDesc.solid(origin, cell, counts, undefined, material);
  }

  /**
   * Gives the body tetrahedral cells: four particle indices per cell, the shape the particles stand in now as the cell's rest
   * shape. A cell listed left-handed has its last two corners swapped. The cells carry the body's elasticity (and its plastic
   * flow and tearing, see {@link CellMaterial}), and when no mass was set they give each particle its share of their density.
   */
  setCells(tets: ArrayLike<number>, material?: CellMaterial): this {
    if (tets.length % 4 !== 0) throw new RangeError('Cells are four particle indices each.');
    const next: number[] = [];
    for (let t = 0; t < tets.length / 4; t++) {
      const four = [0, 1, 2, 3].map((k) => tets[t * 4 + k]!);
      for (const index of four)
        if (!Number.isInteger(index) || index < 0 || index >= this.particleCount)
          throw new RangeError(`Cell ${t} uses ${index}, which is not a particle (0 to ${this.particleCount - 1}).`);
      if (new Set(four).size !== 4) throw new RangeError(`Cell ${t} repeats a particle.`);
      if (!(Math.abs(tetDeterminant(this.positions, four[0]!, four[1]!, four[2]!, four[3]!)) > 1e-18))
        throw new RangeError(`Cell ${t} is flat: its four particles lie in one plane.`);
      next.push(...four);
    }
    this.cells = next;
    if (material) this.setCellMaterial(material);
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
      throw new RangeError('Cluster stiffness is a positive number of hertz.');
    this.clusterGroups = groups.map((group, g) => {
      if (group.length < 4) throw new RangeError(`Cluster ${g} has at least four particles.`);
      return Array.from(group, (index) => {
        if (!Number.isInteger(index) || index < 0 || index >= this.particleCount)
          throw new RangeError(`Cluster ${g} uses ${index}, which is not a particle (0 to ${this.particleCount - 1}).`);
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
    if (pairs.length % 2 !== 0) throw new RangeError(`${label}s are pairs of particle indices.`);
    const out: number[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const index = pairs[i]!;
      if (!Number.isInteger(index) || index < 0 || index >= this.particleCount)
        throw new RangeError(`${label} index ${index} is not a particle (0 to ${this.particleCount - 1}).`);
      out.push(index);
    }
    for (let i = 0; i < out.length; i += 2)
      if (out[i] === out[i + 1]) throw new RangeError(`${label} ${i / 2} joins particle ${out[i]} to itself.`);
    return out;
  }
  /** Merges another description in: its particles follow this one's, and its indices are shifted to match. */
  append(other: SoftBodyDesc): this {
    const base = this.particleCount;
    this.positions.push(...other.positions);
    for (const t of other.triangles) this.triangles.push(t + base);
    this.shapeMatching = this.shapeMatching || other.shapeMatching;
    this.masses.push(...other.masses);
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
        throw new RangeError(`Pinned index ${index} is not a particle (0 to ${this.particleCount - 1}).`);
      next.add(index);
    }
    this.pinned = next;
    return this;
  }
  /** Mass of every particle in kilograms (default 1). */
  setParticleMass(mass: number): this {
    if (!(mass > 0 && Number.isFinite(mass))) throw new RangeError('Particle mass is a positive number of kilograms.');
    this.masses.fill(mass);
    this.massGiven = true;
    return this;
  }
  /** Total mass, shared evenly. */
  setMass(mass: number): this {
    if (!(mass > 0 && Number.isFinite(mass))) throw new RangeError('Mass is a positive number of kilograms.');
    return this.setParticleMass(mass / this.particleCount);
  }
  /** One mass per particle. */
  setMasses(masses: ArrayLike<number>): this {
    if (masses.length !== this.particleCount)
      throw new RangeError(`Give ${this.particleCount} masses, one per particle.`);
    const next = Array.from(masses);
    if (next.some((m) => !(m > 0 && Number.isFinite(m)))) throw new RangeError('Every particle mass is positive.');
    this.masses = next;
    this.massGiven = true;
    return this;
  }
  /** Contact thickness of every particle in metres (default: half the shortest structural edge, or 0.01 with none). */
  setParticleRadius(radius: number): this {
    if (!(radius >= 0 && Number.isFinite(radius))) throw new RangeError('Particle radius is 0 or more metres.');
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
    if (!Number.isFinite(scale)) throw new RangeError('Gravity scale is a number.');
    this.gravity = scale;
    return this;
  }
  /** Air drag: speed falls off as 1 / (1 + dt * damping) (default 0). */
  setLinearDamping(damping: number): this {
    if (!(damping >= 0 && Number.isFinite(damping))) throw new RangeError('Linear damping is 0 or more.');
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
  /** @internal */ force: Vec3 = [0, 0, 0];
  /** @internal */ pointForces = new Map<number, Vec3>();
  /** @internal */ tornSeen = new Set<number>();
  /** @internal */ triangleList = new Uint32Array(0);
  /** @internal The fixed body that holds this body's surface collider, once it has one. */
  surface: PhysicsBody | null = null;
  /** @internal Whether shape matching holds this body. */ matched = false;
  /** @internal Whether its triangles are in the cloth contact search, and how rough the cloth is. */ selfContacts = false;
  /** @internal */ selfFriction = 0;

  /** False once the body was removed. */
  get valid(): boolean {
    return !this.removed;
  }
  private check(index?: number): void {
    if (this.removed) throw new MargoError('state', 'Soft body was removed; create a new one with SoftBodies.create.');
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= this.particles))
      throw new RangeError(`Particle ${index} is not in this body (0 to ${this.particles - 1}).`);
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
  /** Every particle's position as flat x, y, z (a copy, so it is safe to keep). */
  particlePositions(): Float32Array {
    this.check();
    const { x, y, z } = this.c,
      out = new Float32Array(this.particles * 3);
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i;
      out[i * 3] = x[row]!;
      out[i * 3 + 1] = y[row]!;
      out[i * 3 + 2] = z[row]!;
    }
    return out;
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
    checkVec(position, 'Position');
    const { x, y, z, px, py, pz } = this.c,
      row = this.firstParticle + index;
    x[row] = px[row] = position[0];
    y[row] = py[row] = position[1];
    z[row] = pz[row] = position[2];
    return this;
  }
  setParticleVelocity(index: number, velocity: Vec3): this {
    this.check(index);
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
  /** The triangles of a body built from a mesh (`SoftBodyDesc.trimesh`), as particle indices, three per triangle. */
  triangles(): Uint32Array {
    this.check();
    return this.triangleList.slice();
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
  /** True once an edge (numbered as {@link SoftBody.edges}) has torn. */
  isEdgeTorn(edge: number): boolean {
    this.check();
    if (!Number.isInteger(edge) || edge < 0 || edge >= this.structural)
      throw new RangeError(`Edge ${edge} is not a structural edge.`);
    return (this.c.eflags[this.firstEdge + edge]! & TORN) !== 0;
  }
  /** Tears one edge now. */
  tearEdge(edge: number): this {
    if (this.isEdgeTorn(edge)) return this;
    const { eflags } = this.c;
    eflags[this.firstEdge + edge] = eflags[this.firstEdge + edge]! | TORN;
    return this;
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
      throw new RangeError(`Cell ${cell} is not in this body (0 to ${this.cellRange.count - 1}).`);
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
    if (!(damping >= 0 && Number.isFinite(damping))) throw new RangeError('Linear damping is 0 or more.');
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
    checkVec(force, 'Force');
    this.force = [this.force[0] + force[0], this.force[1] + force[1], this.force[2] + force[2]];
    return this;
  }
  /** A force on one particle until {@link SoftBody.resetForces}. */
  addParticleForce(index: number, force: Vec3): this {
    this.check(index);
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
    if (!(radius > 0 && Number.isFinite(radius))) throw new RangeError('Radius is a positive number of metres.');
    const { x, y, z } = this.c;
    for (let i = 0; i < this.particles; i++) {
      const row = this.firstParticle + i,
        d = Math.hypot(x[row]! - point[0], y[row]! - point[1], z[row]! - point[2]),
        k = d >= radius ? 0 : (1 - d / radius) / this.masses[i]!;
      if (k > 0) this.kick(i, impulse[0] * k, impulse[1] * k, impulse[2] * k);
    }
    return this;
  }
  private kick(index: number, dx: number, dy: number, dz: number): void {
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
  private capacity = [0, 0, 0, 0];
  private particleCount = 0;
  private edgeCount = 0;
  private cellView: Columns | null = null;
  private cellViewBuffer: ArrayBuffer | null = null;
  private cellCapacity = [0, 0, 0];
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
    if (this.disposed) throw new MargoError('state', 'SoftBodies was disposed.');
    const buffer = this.exports.memory.buffer;
    if (this.view && this.viewBuffer === buffer) return this.view;
    const [particles, edges, bodies, colliders] = this.capacity,
      view: Columns = {};
    columnNames.forEach((name, id) => {
      const rows = rowsOf(name, particles!, edges!, bodies!, colliders!),
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
    if (this.disposed) throw new MargoError('state', 'SoftBodies was disposed.');
    const buffer = this.exports.memory.buffer;
    if (this.cellView && this.cellViewBuffer === buffer) return this.cellView;
    const [tets, clusters, members] = this.cellCapacity,
      view: Columns = {};
    cellColumnNames.forEach((name, id) => {
      const rows = /^(cstart|ccount|comega)$/.test(name)
          ? clusters!
          : /^(member|rest\d)$/.test(name)
            ? members!
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
    ];
    this.view = null;
  }

  /** Inserts a soft body: its particles join the world at their positions. */
  create(desc: SoftBodyDesc): SoftBody {
    if (this.disposed) throw new MargoError('state', 'SoftBodies was disposed.');
    const particles = desc.particleCount;
    if (desc.selfContacts && desc.triangles.length === 0)
      throw new RangeError('Self contacts need triangles; build the body with trimesh, cloth or clothTube.');
    if (particles === 0) throw new RangeError('A soft body has at least one particle.');
    const structural = desc.edgePairs.length / 2,
      edges = structural + desc.bendPairs.length / 2,
      firstParticle = this.particleCount,
      firstEdge = this.edgeCount,
      handle = this.bodies.length;
    this.reserve(firstParticle + particles, firstEdge + edges, handle + 1, 0);
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
    const radius = desc.radius ?? (Number.isFinite(shortest) ? shortest * 0.5 : 0.01);
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
    body.triangleList = Uint32Array.from(desc.triangles);
    body.matched = desc.shapeMatching;
    body.selfContacts = desc.selfContacts;
    body.selfFriction = desc.selfFriction;
    if (cells) {
      const [mu, lambda] = desc.cellMaterial.lame(),
        model = desc.cellMaterial.model === 'corotated' ? 1 : 0;
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
    }
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
    this.writeMaterial(body);
    this.writeCellMaterial(body);
    this.syncCloth();
    return body;
  }

  /** Lays the triangles of the bodies that collide with themselves into the kernel's cloth search. */
  private syncCloth(): void {
    const on = this.bodies.filter((b) => b.selfContacts);
    let triangles = 0,
      thickness = Infinity,
      friction = 0;
    const radius = this.columns().radius;
    for (const b of on) {
      triangles += b.triangleList.length / 3;
      friction = Math.max(friction, b.selfFriction);
      for (let i = 0; i < b.particles; i++) thickness = Math.min(thickness, radius[b.firstParticle + i]!);
    }
    const at = this.exports.soft_cloth_reserve(triangles, Math.max(triangles * 8 + 64, 16384)),
      buffer = new Uint32Array(this.exports.memory.buffer, at, triangles * 3);
    let k = 0;
    for (const b of on) for (const v of b.triangleList) buffer[k++] = b.firstParticle + v;
    this.exports.soft_cloth_enable(triangles, on.length ? thickness : 0, friction);
    this.view = null;
  }

  /** @internal Writes a body's cell material into its cell rows; the rest shapes stay. */
  writeCellMaterial(body: SoftBody): void {
    const { first, count } = body.cellRange;
    if (count === 0) return;
    const f = this.cellColumns(),
      m = body.cellMaterial,
      [mu, lambda] = m.lame();
    for (let t = first; t < first + count; t++) {
      f.mu![t] = mu;
      f.lambda![t] = lambda;
      (f.model as unknown as Uint32Array)[t] = m.model === 'corotated' ? 1 : 0;
      f.yield_strain![t] = m.yieldStrain;
      f.creep![t] = m.creep;
      f.tear![t] = m.tearStrain;
    }
  }

  /** @internal Writes a body's material into its edge rows. */
  writeMaterial(body: SoftBody): void {
    const c = this.columns(),
      { edgeSoftness, bendSoftness, tearStrain, shapeMatchingSoftness } = body.material;
    c.b_omega[body.handle] = shapeMatchingSoftness.naturalFrequency * 2 * Math.PI;
    c.b_zeta[body.handle] = shapeMatchingSoftness.dampingRatio;
    for (let e = 0; e < body.edgeTotal; e++) {
      const row = body.firstEdge + e,
        bend = e >= body.structural,
        softness = bend ? bendSoftness : edgeSoftness;
      c.omega[row] = softness.naturalFrequency * 2 * Math.PI;
      c.zeta[row] = softness.dampingRatio;
      c.tear[row] = bend ? 0 : tearStrain;
    }
  }

  /** Removes a body and its particles; later bodies keep their order, but their numbers shift down by one. */
  remove(body: SoftBody): void {
    if (body.removed) return;
    const at = this.bodies.indexOf(body);
    if (at < 0) throw new MargoError('state', 'That soft body belongs to another world.');
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
      bcols = ['b_on', 'b_omega', 'b_zeta', 'bqx', 'bqy', 'bqz', 'bqw'] as const,
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
      ],
      memberNames = ['member', 'rest0', 'rest1', 'rest2'],
      cellSaved = keep.map((b) => {
        const r = b.cellRange;
        if (r.count === 0 && r.memberCount === 0) return null;
        const f = this.cellColumns();
        return {
          tets: tetNames.map((name) => {
            const part = f[name]!.slice(r.first, r.first + r.count);
            return /^p\d$/.test(name) ? part.map((v) => v - b.firstParticle) : part;
          }),
          cstart: f.cstart!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount).map((v) => v - r.memberFirst),
          ccount: f.ccount!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
          comega: f.comega!.slice(r.clusterFirst, r.clusterFirst + r.clusterCount),
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
    this.cellCapacity = [tets, clusters, members];
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
      if (saved) {
        const f = this.cellColumns();
        tetNames.forEach((name, n) => {
          const part = saved.tets[n]!;
          f[name]!.set(/^p\d$/.test(name) ? part.map((v) => v + b.firstParticle) : part, next.first);
        });
        f.cstart!.set(
          saved.cstart.map((v) => v + next.memberFirst),
          next.clusterFirst,
        );
        f.ccount!.set(saved.ccount, next.clusterFirst);
        f.comega!.set(saved.comega, next.clusterFirst);
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
    body.surface?.remove();
    body.surface = null;
    this.bodies.splice(at, 1);
    this.syncCloth();
  }

  /** @internal Steps with the world: forces first, then the kernel's pieces with the rigid world's contacts between them. */
  beforeStep(dt: number): void {
    if (this.particleCount === 0) return;
    this.applyForces(this.columns(), dt);
    const h = dt / this.substeps,
      g = this.physics.gravity,
      rows = new Map<number, number>(),
      bodies: PhysicsBody[] = [];
    this.reserve(this.particleCount, this.edgeCount, this.bodies.length, 0);
    this.view = null;
    this.exports.soft_fem_damping(this.cellDamping);
    this.exports.soft_begin(dt);
    for (let piece = 0; piece < this.substeps; piece++) {
      this.exports.soft_pre(h, this.iterations, g[0], g[1], g[2]);
      // Two asks a piece: the second finds what the first's push-out ran the particle into (a corner).
      for (let pass = 0; pass < 2; pass++) this.meet(h, rows, bodies);
      this.exports.soft_post(h);
    }
    this.exports.soft_finish();
    const c = this.columns();
    bodies.forEach((body, row) => {
      if (body.type !== 'dynamic') return;
      const j: Vec3 = [c.jx[row]!, c.jy[row]!, c.jz[row]!],
        k: Vec3 = [c.kx[row]!, c.ky[row]!, c.kz[row]!];
      if (j[0] !== 0 || j[1] !== 0 || j[2] !== 0) body.applyImpulse(j, [c.mx[row]!, c.my[row]!, c.mz[row]!]);
      if (k[0] !== 0 || k[1] !== 0 || k[2] !== 0) body.applyTorqueImpulse(k);
    });
    const cellsTorn = this.exports.soft_fem_torn();
    if (this.exports.soft_torn() > 0 || cellsTorn !== this.cellsTornSeen || this.cellTornByHand) {
      this.cellsTornSeen = cellsTorn;
      this.cellTornByHand = false;
      this.report(c);
    }
    for (const body of this.bodies) if (body.surface) this.moveSurface(body, c);
  }

  /** Asks the rigid world what each free particle's move met, hands the kernel the contacts and lets it resolve them. */
  private meet(h: number, rows: Map<number, number>, bodies: PhysicsBody[]): void {
    let c = this.columns();
    const kernel = this.physics.kernel;
    for (const soft of this.bodies) {
      const free: number[] = [];
      for (let i = 0; i < soft.particles; i++) if (c.w[soft.firstParticle + i]! > 0) free.push(soft.firstParticle + i);
      if (free.length === 0) continue;
      const from = new Float32Array(free.length * 3),
        to = new Float32Array(free.length * 3),
        radius = new Float32Array(free.length);
      free.forEach((row, k) => {
        from[k * 3] = c.px[row]!;
        from[k * 3 + 1] = c.py[row]!;
        from[k * 3 + 2] = c.pz[row]!;
        to[k * 3] = c.x[row]!;
        to[k * 3 + 1] = c.y[row]!;
        to[k * 3 + 2] = c.z[row]!;
        radius[k] = c.radius[row]!;
      });
      // Sensors are left out (query flag 8), and so is the body's own surface collider.
      const contacts = kernel.probeParticles(from, to, radius, { flags: 8, excludeBody: soft.surface?.row });
      contacts.forEach((contact, k) => {
        if (!contact) return;
        const row = free[k]!,
          n = contact.normal,
          // Past a thin wall the move ends beyond the surface: push the end back onto the plane the sweep touched.
          push = Math.max(
            contact.depth,
            (contact.point[0] - to[k * 3]!) * n[0] +
              (contact.point[1] - to[k * 3 + 1]!) * n[1] +
              (contact.point[2] - to[k * 3 + 2]!) * n[2] +
              radius[k]!,
          );
        if (!(push > 0)) return;
        const owner = this.physics.bodyOfCollider(contact.collider);
        if (!owner) return;
        let table = rows.get(contact.body);
        if (table === undefined) {
          table = bodies.length;
          rows.set(contact.body, table);
          bodies.push(owner);
          this.reserve(this.particleCount, this.edgeCount, this.bodies.length, bodies.length);
          c = this.columns();
          this.writeBody(c, table, owner);
        }
        c.kc[row] = table + 1;
        c.knx[row] = n[0];
        c.kny[row] = n[1];
        c.knz[row] = n[2];
        c.kd[row] = push;
        c.kpx[row] = contact.point[0];
        c.kpy[row] = contact.point[1];
        c.kpz[row] = contact.point[2];
        c.kf[row] = owner.colliders.find((collider) => collider.handle === contact.collider)?.friction() ?? 0.5;
      });
    }
    this.exports.soft_apply(h);
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
    c.lvx[row] = lv[0];
    c.lvy[row] = lv[1];
    c.lvz[row] = lv[2];
    c.avx[row] = av[0];
    c.avy[row] = av[1];
    c.avz[row] = av[2];
    c.wm[row] = inverse[0]!;
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
    if (body.surface) throw new MargoError('state', 'This soft body already has a surface collider.');
    if (body.triangleList.length === 0)
      throw new RangeError('This body has no triangles; build it with trimesh, cloth or clothTube.');
    const host = this.physics.addBody(null, {
      type: 'fixed',
      colliders: {
        shape: 'trimesh',
        vertices: body.particlePositions(),
        indices: body.triangleList,
        deformable: true,
        ...settings,
      },
    });
    body.surface = host;
    return host.colliders[0]!;
  }

  private moveSurface(body: SoftBody, c: Columns): void {
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
    for (const body of this.bodies) {
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
      if (fresh.length || freshCells.length)
        for (const listener of [...this.listeners]) listener({ body, edges: fresh, cells: freshCells });
    }
  }

  /** @internal Nothing to do after the sync: the particles are read on demand. */
  afterSync(): void {}
  /** @internal */
  bodyRemoved(_body: PhysicsBody): void {}

  /** Removes every soft body and leaves the world. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.physics.detach(this);
    for (const body of this.bodies) {
      body.removed = true;
      body.surface?.remove();
      body.surface = null;
    }
    this.bodies.length = 0;
    this.listeners.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** What a dynamic body's inverse mass and world inverse inertia are, for the kernel to share a contact's correction with it. */
function inverseMass(body: PhysicsBody): number[] {
  if (body.type !== 'dynamic' || !(body.mass > 0)) return [0, 0, 0, 0, 0, 0, 0];
  const f = body.inertiaFrame,
    r = body.rotation,
    q: [number, number, number, number] = [
      r[3] * f[0] + r[0] * f[3] + r[1] * f[2] - r[2] * f[1],
      r[3] * f[1] - r[0] * f[2] + r[1] * f[3] + r[2] * f[0],
      r[3] * f[2] + r[0] * f[1] - r[1] * f[0] + r[2] * f[3],
      r[3] * f[3] - r[0] * f[0] - r[1] * f[1] - r[2] * f[2],
    ],
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

function rowsOf(name: string, particles: number, edges: number, bodies: number, colliders: number): number {
  if (/^(ea|eb|rest|omega|zeta|lambda|tear|eflags)$/.test(name)) return edges;
  if (/^(gravity_scale|linear_damping|b_on|b_omega|b_zeta|b_first|b_count|bq[xyzw])$/.test(name)) return bodies;
  if (
    /^(c_kind|cx|cy|cz|q[xyzw]|s[xyz]|friction|lv[xyz]|av[xyz]|m[xyz]|j[xyz]|k[xyz]|wm|ii(xx|xy|xz|yy|yz|zz))$/.test(
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
