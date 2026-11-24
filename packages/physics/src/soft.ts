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
  soft_torn(): number;
  soft_hash(): number;
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

let columnNames: readonly string[] = [];
// The blueprint (the deflated kernel) is a chunk of its own: an app that imports this entry but never attaches soft bodies
// does not download it.
const compiled = new LoadOnce<WebAssembly.Module>(async () => {
  const blueprint = await import('./soft-wasm.js');
  columnNames = blueprint.softColumns;
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
  /** @internal */ triangles: number[] = [];

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

  /** Turns shape matching on or off (on for `trimesh`, off otherwise). It pulls the particles toward their rest shape. */
  setShapeMatching(on: boolean): this {
    this.shapeMatching = on;
    return this;
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
  ) {}
  /** @internal */ removed = false;
  /** @internal */ force: Vec3 = [0, 0, 0];
  /** @internal */ pointForces = new Map<number, Vec3>();
  /** @internal */ tornSeen = new Set<number>();
  /** @internal */ triangleList = new Uint32Array(0);
  /** @internal The fixed body that holds this body's surface collider, once it has one. */
  surface: PhysicsBody | null = null;
  /** @internal Whether shape matching holds this body. */ matched = false;

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
  private disposed = false;
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

  private reserve(particles: number, edges: number, bodies: number, colliders: number): void {
    this.exports.soft_reserve(particles, edges, bodies, colliders);
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
      masses = Float32Array.from(desc.masses);
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
    );
    body.triangleList = Uint32Array.from(desc.triangles);
    body.matched = desc.shapeMatching;
    this.bodies.push(body);
    this.writeMaterial(body);
    return body;
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
    let particles = 0,
      edges = 0;
    for (const b of keep) {
      particles += b.particles;
      edges += b.edgeTotal;
    }
    this.exports.soft_reserve(particles, edges, keep.length, 0);
    this.view = null;
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
    this.particleCount = particles;
    this.edgeCount = edges;
    body.removed = true;
    body.surface?.remove();
    body.surface = null;
    this.bodies.splice(at, 1);
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
    if (this.exports.soft_torn() > 0) this.report(c);
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
      const fresh: number[] = [];
      for (let e = 0; e < body.structural; e++)
        if ((c.eflags[body.firstEdge + e]! & TORN) !== 0 && !body.tornSeen.has(e)) {
          body.tornSeen.add(e);
          fresh.push(e);
        }
      if (fresh.length) for (const listener of [...this.listeners]) listener({ body, edges: fresh });
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
