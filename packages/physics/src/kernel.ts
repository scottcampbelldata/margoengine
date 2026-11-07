// The Rust kernel from JavaScript: loads the blueprint and reads the world's columns through typed-array views.
import { MargoError } from '@margoengine/math/errors';
import { LoadOnce } from '../../shared/load-once.js';
import type { Quat, Vec3 } from './math.js';
import { kernelColumns, wasmBase64 } from './wasm.js';

interface KernelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  world_new(bodies: number, colliders: number): number;
  world_base(): number;
  world_bytes(): number;
  world_capacity(rows: number): number;
  world_offset(column: number): number;
  world_columns(): number;
  world_reserve(bodies: number, colliders: number): number;
  world_hash(): number;
  world_set_gravity(x: number, y: number, z: number): void;
  world_gravity(axis: number): number;
  world_set_substeps(substeps: number): void;
  world_substeps(): number;
  world_set_iterations(iterations: number): void;
  world_iterations(): number;
  world_steps(): number;
  world_step(dt: number): number;
  world_lost(): number;
  world_layout(): number;
  world_pairs(): number;
  world_pair_rows(): number;
  world_solving(): number;
  world_events(): number;
  world_clear_events(): void;
  world_set_filtering(on: number): void;
  collider_set_state(collider: number, state: number): void;
  collider_touch(collider: number): void;
  body_set_enabled(body: number, enabled: number): void;
  body_touch(body: number): void;
  world_awake(): number;
  world_islands(): number;
  world_set_sleep(energy: number, time: number): void;
  world_sleep_energy(): number;
  world_sleep_time(): number;
  body_wake(body: number): void;
  body_sleep(body: number): void;
  world_ensure(bytes: number): number;
  body_set_pose(
    body: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    wake: number,
  ): void;
  body_set_target(body: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void;
  body_add(kind: number): number;
  body_remove(body: number): number;
  body_update_mass(body: number): void;
  body_set_kind(body: number, kind: number): void;
  body_set_own(
    body: number,
    mass: number,
    x: number,
    y: number,
    z: number,
    ix: number,
    iy: number,
    iz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void;
  collider_add(
    body: number,
    shape: number,
    a: number,
    b: number,
    c: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    density: number,
  ): number;
  collider_remove(collider: number): number;
  joint_add(a: number, b: number, flags: number): number;
  joint_remove(joint: number): number;
  joint_set_axis(joint: number, x: number, y: number, z: number): void;
  joint_set_frames(
    joint: number,
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number,
  ): void;
  hull_begin(vertices: number, faces: number, edges: number): number;
  hull_end(vertices: number, faces: number, edges: number): number;
  hull_next(rows: number): number;
}

/** Bits of the `jointFlags` column, each shifted by the axis it is for: 0 to 2 along frame A, 3 to 5 about it. */
export const JOINT_LOCK = 1;
export const JOINT_LIMIT = 1 << 6;
export const JOINT_MOTOR_ON = 1 << 12;
export const JOINT_MOTOR_FORCE = 1 << 18;
/** Not shifted: the two bodies may collide with each other. */
export const JOINT_CONTACTS = 1 << 25;
export const JOINT_CONE = 1 << 26;
export const JOINT_DISTANCE = 1 << 27;
/** Bits of the `colliderFlags` column. */
export const COLLIDER_SENSOR = 1;
export const COLLIDER_OFF = 2;
/** Bit of the `flags` column: the body is out of the world. */
export const BODY_DISABLED = 1 << 11;
/** An event's first word: the first collider's row under this mask, the sensor bit, and the top bit when it started. */
export const EVENT_COLLIDER = (1 << 30) - 1;
export const EVENT_SENSOR = 1 << 30;

/** How a body moves: `dynamic` by forces, `kinematicPosition` to a target, `kinematicVelocity` at its velocity. */
export type KernelBodyKind = 'fixed' | 'dynamic' | 'kinematicPosition' | 'kinematicVelocity';

/**
 * Shapes the kernel holds today. Sizes: a ball's radius; a box's half extents; a capsule's radius and half core length; a
 * hull's row from {@link KernelWorld.addHull}.
 */
export type KernelShape = 'ball' | 'box' | 'capsule' | 'hull';

/** How many numbers each shape's size takes, and its value in the `colliderShape` column. */
const shapes: Readonly<Record<KernelShape, readonly [number, number]>> = {
  ball: [0, 1],
  box: [1, 3],
  capsule: [2, 2],
  hull: [3, 1],
};

/** What each refusal of `hull_end` means, with the fix. */
const hullErrors: Readonly<Record<number, string>> = {
  [-1]: 'A hull needs at least 4 vertices and 4 faces; memory may also be out',
  [-2]: 'A face names a vertex that does not exist, or has under 3 vertices; check the indices',
  [-3]: 'A face is not flat; split it or move its vertices onto one plane',
  [-4]: 'The faces do not close into one surface; each edge must join exactly two faces, running opposite ways',
  [-5]: 'The shape is not convex, or a face runs clockwise from outside; turn the face or build the convex hull',
  [-6]: 'Two neighbouring faces lie in one plane; merge them, as contact clipping sees only one face at a time, or build it with convexHull',
  [-7]: 'A face has over 256 edges; pass fewer points around it',
};

/** A point of a manifold. */
export interface KernelContactPoint {
  /** Midway between the two surfaces when the point was found, in world space. */
  position: [number, number, number];
  /** The gap along the normal in metres, negative when the shapes overlap. */
  separation: number;
  /** Names the features that made the point, and stays the same while they do. */
  id: number;
  /** What the solver pushed with along the normal in the last substep, in newton seconds. */
  normalImpulse: number;
}

/** The manifold of one pair of colliders. */
export interface KernelContact {
  colliderA: number;
  colliderB: number;
  /** Unit vector from A to B, shared by every point. */
  normal: [number, number, number];
  points: KernelContactPoint[];
}

/** How two colliders mix a value. When their rules differ the pair takes the higher: max, multiply, min, average. */
export type KernelCombine = 'average' | 'min' | 'multiply' | 'max';
const combines: readonly KernelCombine[] = ['average', 'min', 'multiply', 'max'];

/** Options of {@link KernelWorld.addCollider}. */
export interface KernelColliderOptions {
  /** Place in the body's frame (default the origin). */
  position?: readonly [number, number, number];
  /** Unit quaternion, x, y, z, w, in the body's frame (default none). */
  rotation?: readonly [number, number, number, number];
  /** In kg/m^3 (default 1000, water). 0 adds no mass. */
  density?: number;
  /** Coulomb friction, 0 or more: a block slides above the slope whose tangent this is (default 0.5). */
  friction?: number;
  /** Share of its approach speed a contact gives back, 0 to 1 (default 0). */
  restitution?: number;
  /** How a pair mixes its two frictions (default 'average'). */
  frictionCombine?: KernelCombine;
  /** How a pair mixes its two restitutions (default 'average'). */
  restitutionCombine?: KernelCombine;
}

/** Bits of the `flags` column (kernel/src/layout.rs). */
const ALIVE = 1,
  SLEEPING = 1 << 9,
  CAN_SLEEP = 1 << 10;

/** The kind bits of the `flags` column (kernel/src/layout.rs). */
const bodyKinds: Readonly<Record<KernelBodyKind, number>> = {
  fixed: 0,
  dynamic: 2,
  kinematicPosition: 4,
  kinematicVelocity: 6,
};

const compiled = new LoadOnce<WebAssembly.Module>(async () => {
  const bytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
  return WebAssembly.compile(
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer(),
  );
});

/** Options of {@link loadKernel}. */
export interface KernelLoadOptions {
  /** Stops waiting for the load; the load itself carries on and a later call reuses it. */
  signal?: AbortSignal;
}

/**
 * Compiles the kernel, once per app: compiling is asynchronous, so `new KernelWorld()` can stay synchronous.
 * @throws AbortError (the signal's reason) when `signal` aborts first.
 */
export async function loadKernel({ signal }: KernelLoadOptions = {}): Promise<void> {
  await compiled.load(signal);
}

/** A column view: float columns are `Float32Array`, integer columns `Uint32Array`. One row per body or collider. */
export type KernelColumn = Float32Array | Uint32Array;

/**
 * One simulated world in its own Wasm instance. Column views alias the kernel's memory: reading a pose is a typed-array
 * read, with no call and no copy. Growth, which a step can cause, replaces every view, so read them from `columns` each
 * time and never keep one.
 * Everything a step can change lives in one block, so {@link KernelWorld.snapshot} is one copy.
 */
export class KernelWorld {
  /** Every column by name, for example `columns.positionX[body]`. */
  readonly columns: Record<string, KernelColumn> = {};
  private readonly api: KernelExports;
  private layout = -1;
  private stepping = false;
  private filter: ((a: number, b: number) => boolean) | null = null;
  private hullRows = 0;

  /**
   * @param bodies Body rows to start with (default 1024); `reserve` adds more.
   * @param colliders Collider rows to start with (default as many as bodies).
   * @throws MargoError (`state`) before {@link loadKernel} has finished.
   * @throws RangeError for a capacity the kernel refuses.
   */
  constructor(bodies = 1024, colliders = bodies) {
    const module = compiled.value;
    if (!module) throw new MargoError('state', 'The physics kernel is not loaded; call await loadKernel() first.');
    this.api = new WebAssembly.Instance(module, { env: { contact_filter: (a: number, b: number) => this.ask(a, b) } }).exports as KernelExports;
    if (!Number.isSafeInteger(bodies) || !Number.isSafeInteger(colliders) || !this.api.world_new(bodies, colliders))
      throw new RangeError(
        `Bodies and colliders must be integers from 1 to 4194304; use a smaller world (got ${bodies}, ${colliders}).`,
      );
    this.bind();
  }

  /** The step asks about a pair. Finding pairs can have grown the world, and a filter may read the columns. */
  private ask(a: number, b: number): number {
    if (this.api.world_layout() !== this.layout) this.bind();
    return this.filter!(a, b) ? 1 : 0;
  }

  private bind(): void {
    const { api } = this,
      { buffer } = api.memory,
      base = api.world_base();
    this.layout = api.world_layout();
    kernelColumns.forEach(([name, kind, rows], column) => {
      const at = base + (api.world_offset(column) >>> 0),
        length = api.world_capacity(rows);
      this.columns[name] = kind === 'f' ? new Float32Array(buffer, at, length) : new Uint32Array(buffer, at, length);
    });
  }

  /** Rows of body columns. */
  get capacity(): number {
    return this.api.world_capacity(0);
  }
  /** Rows of collider columns. */
  get colliderCapacity(): number {
    return this.api.world_capacity(1);
  }
  /** Pairs of colliders whose fat boxes overlap, after the last step. */
  get pairCount(): number {
    return this.api.world_pairs();
  }
  /**
   * Every pair as two collider rows, the lower first, after the last step. A pair is near, not yet touching: a fat box
   * holds what the coming step can reach, plus a margin. Colliders of one body and of two fixed bodies are no pair.
   */
  pairs(): [number, number][] {
    const { pairA, pairB } = this.columns,
      rows = this.api.world_pair_rows(),
      out: [number, number][] = [];
    for (let row = 0; row < rows; row++) if (pairA[row] !== 0xffffffff) out.push([pairA[row], pairB[row]]);
    return out;
  }
  /**
   * Every pair with contact points, after the last step. A point may lie a little apart: anything the step could reach
   * counts, so its `separation` can be above zero.
   */
  contacts(): KernelContact[] {
    const c = this.columns,
      rows = this.api.world_pair_rows(),
      out: KernelContact[] = [];
    for (let row = 0; row < rows; row++) {
      const count = c.pairContacts[row];
      if (c.pairA[row] === 0xffffffff || count === 0) continue;
      const points: KernelContactPoint[] = [];
      for (let at = row * 4; at < row * 4 + count; at++)
        points.push({
          position: [c.contactX[at], c.contactY[at], c.contactZ[at]],
          separation: c.contactSeparation[at],
          id: c.contactId[at],
          normalImpulse: c.contactNormalImpulse[at],
        });
      out.push({
        colliderA: c.pairA[row],
        colliderB: c.pairB[row],
        normal: [c.pairNormalX[row], c.pairNormalY[row], c.pairNormalZ[row]],
        points,
      });
    }
    return out;
  }
  /**
   * Decides each pair of collider rows the step looks at; false keeps them from touching, sensor pairs too. It runs inside
   * the step, so it may read the world and must not change it. Null, the default, asks nothing.
   */
  set contactFilter(filter: ((a: number, b: number) => boolean) | null) {
    this.filter = filter;
    this.api.world_set_filtering(filter ? 1 : 0);
  }
  /** Events waiting in the `events` column, two words each. Read them after a step, then call {@link KernelWorld.clearEvents}. */
  get eventCount(): number {
    return this.api.world_events();
  }
  clearEvents(): void {
    this.api.world_clear_events();
  }
  /** Sets a collider's `COLLIDER_` bits. What it touched ends, and whatever rested on it wakes. */
  setColliderState(collider: number, state: number): void {
    this.api.collider_set_state(collider, state);
  }
  /** Wakes what a collider can reach, after its groups were written. */
  touchCollider(collider: number): void {
    this.api.collider_touch(collider);
  }
  /** Takes a body out of the world or puts it back: out, it keeps its pose and speed, touches nothing and its joints rest. */
  setBodyEnabled(body: number, enabled: boolean): void {
    this.api.body_set_enabled(body, enabled ? 1 : 0);
  }
  /** Pairs the last step solved: the first this many rows of the `solvePairs` column. */
  get solvingPairs(): number {
    return this.api.world_solving();
  }
  /** Bodies a step walks: the moving ones. Sleeping and fixed bodies are on no list, so they cost a step nothing. */
  get awakeCount(): number {
    return this.api.world_awake();
  }
  /** Groups of touching bodies still awake after the last step. Fixed and kinematic bodies join none. */
  get islandCount(): number {
    return this.api.world_islands();
  }
  /** Kinetic energy per unit of mass under which a body counts as still, in J/kg (default 0.0002, a slide of 0.02 m/s). */
  get sleepEnergy(): number {
    return this.api.world_sleep_energy();
  }
  /** Seconds a body must stay still before it may sleep (default 0.5). */
  get sleepTime(): number {
    return this.api.world_sleep_time();
  }
  /**
   * Sets when bodies sleep: under `energy` J/kg for `time` seconds, with no energy gained across that time.
   * @throws RangeError unless both are finite and not negative.
   */
  setSleep(energy: number, time: number): this {
    if (!(energy >= 0) || !(time >= 0) || !Number.isFinite(energy) || !Number.isFinite(time))
      throw new RangeError(`Sleep needs a finite energy and time, not negative; the defaults are 0.0002 and 0.5 (got ${energy}, ${time}).`);
    this.api.world_set_sleep(energy, time);
    return this;
  }
  /** True when the row holds a sleeping body. */
  isSleeping(body: number): boolean {
    const flags = this.columns.flags[body] ?? 0;
    return (flags & ALIVE) !== 0 && (flags & SLEEPING) !== 0;
  }
  /**
   * Wakes a body and every body it sleeps with. Writing a sleeper's velocity or force columns does not wake it, so call
   * this first.
   */
  wake(body: number): this {
    this.api.body_wake(body);
    return this;
  }
  /** Asks a dynamic body to stop and sleep. It goes when every body it touches is ready too. */
  sleep(body: number): this {
    this.api.body_sleep(body);
    return this;
  }
  /** Sets whether a body may sleep (default true). A body that may not keeps everything it touches awake. */
  setCanSleep(body: number, canSleep: boolean): this {
    const { flags } = this.columns;
    flags[body] = canSleep ? flags[body] | CAN_SLEEP : flags[body] & ~CAN_SLEEP;
    return this;
  }
  /** Steps taken so far. */
  get steps(): number {
    return this.api.world_steps() >>> 0;
  }
  /**
   * Equal pieces each step is split into (default 8). Forces reach every piece; impulses land once, before the first.
   * @throws RangeError unless it is a whole number from 1 up.
   */
  get substeps(): number {
    return this.api.world_substeps();
  }
  set substeps(substeps: number) {
    if (!Number.isInteger(substeps) || substeps < 1 || substeps > 0xffff)
      throw new RangeError(`Substeps must be a whole number from 1 to 65535; use 8 unless you measured (got ${substeps}).`);
    this.api.world_set_substeps(substeps);
  }
  /** Solver passes in each substep (default 2). More holds a tall stack stiffer, at that much more solver time. */
  get iterations(): number {
    return this.api.world_iterations();
  }
  set iterations(iterations: number) {
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 0xffff)
      throw new RangeError(`Iterations must be a whole number from 1 to 65535; use 2 unless you measured (got ${iterations}).`);
    this.api.world_set_iterations(iterations);
  }
  /** Gravity as `[x, y, z]`, in m/s^2 (default `[0, -9.81, 0]`, read back as f32). */
  get gravity(): [number, number, number] {
    const { api } = this;
    return [api.world_gravity(0), api.world_gravity(1), api.world_gravity(2)];
  }
  /**
   * Sets gravity.
   * @throws RangeError for a value that is not finite: a NaN in the state would end bit equality.
   */
  setGravity(x: number, y: number, z: number): this {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      throw new RangeError(`Gravity must be three finite numbers; check what fed it (got ${x}, ${y}, ${z}).`);
    this.api.world_set_gravity(x, y, z);
    return this;
  }
  /**
   * Adds a body and returns its row, which is its index in every column. Grows the world when the rows run out, so read
   * views from `columns` after this call. A new row is at the origin with no mass: give a dynamic body `inverseMass`.
   * @throws RangeError for an unknown kind, or when the world cannot grow.
   */
  addBody(kind: KernelBodyKind): number {
    const bits = Object.hasOwn(bodyKinds, kind) ? bodyKinds[kind] : undefined;
    if (bits === undefined)
      throw new RangeError(`Unknown body kind ${String(kind)}; use one of ${Object.keys(bodyKinds).join(', ')}.`);
    let row = this.api.body_add(bits);
    if (row < 0) {
      this.reserve(this.capacity * 2);
      row = this.api.body_add(bits);
    }
    return row;
  }
  /**
   * Removes a body and its colliders. Its row comes back from a later {@link KernelWorld.addBody}, last freed first; the
   * colliders' rows after the next step.
   * @returns false when the row holds no body.
   */
  removeBody(body: number): boolean {
    return Number.isInteger(body) && body >= 0 && this.api.body_remove(body) === 1;
  }
  /**
   * Adds a collider to a body and works out the body's mass, centre and inertia again. Grows the world when the rows run
   * out, so read views from `columns` after this call.
   * @param size A ball's `[radius]`, a box's `[halfX, halfY, halfZ]`, a capsule's `[radius, halfLength]` along local Y, a
   * hull's `[row]`.
   * @returns The collider's row.
   * @throws RangeError for a dead body, an unknown shape, or a size, pose or density the kernel cannot use.
   */
  addCollider(body: number, shape: KernelShape, size: readonly number[], options: KernelColliderOptions = {}): number {
    const {
        position = [0, 0, 0],
        rotation = [0, 0, 0, 1],
        density = 1000,
        friction = 0.5,
        restitution = 0,
        frictionCombine = 'average',
        restitutionCombine = 'average',
      } = options,
      spec = Object.hasOwn(shapes, shape) ? shapes[shape] : undefined,
      { flags } = this.columns;
    if (!spec) throw new RangeError(`Unknown shape ${String(shape)}; use one of ${Object.keys(shapes).join(', ')}.`);
    if (!Number.isInteger(body) || body < 0 || body >= flags.length || !(flags[body] & 1))
      throw new RangeError(`Row ${body} holds no body; use a row addBody returned.`);
    const [code, numbers] = spec;
    if (shape === 'hull') {
      if (size.length !== 1 || !Number.isInteger(size[0]) || size[0] < 0 || size[0] >= this.hullRows)
        throw new RangeError(`A hull collider needs [row], a row addHull returned (got ${size.join(', ')}).`);
    } else if (size.length !== numbers || !size.every((value) => value > 0 && Number.isFinite(value)))
      throw new RangeError(`A ${shape} needs ${numbers} finite sizes above zero (got ${size.join(', ')}).`);
    if (!(density >= 0) || !Number.isFinite(density))
      throw new RangeError(`Density must be finite and not negative; 1000 is water (got ${density}).`);
    if (!(friction >= 0) || !Number.isFinite(friction))
      throw new RangeError(`Friction must be finite and not negative; 0.5 is a common start (got ${friction}).`);
    if (!(restitution >= 0 && restitution <= 1))
      throw new RangeError(`Restitution must be from 0 to 1, as a contact cannot give back more than it took (got ${restitution}).`);
    const frictionRule = combines.indexOf(frictionCombine),
      restitutionRule = combines.indexOf(restitutionCombine);
    if (frictionRule < 0 || restitutionRule < 0)
      throw new RangeError(`Unknown combine rule; use one of ${combines.join(', ')}.`);
    if (![...position, ...rotation].every(Number.isFinite))
      throw new RangeError('A collider pose must be finite; check what fed it.');
    const [qx, qy, qz, qw] = rotation,
      squared = qx * qx + qy * qy + qz * qz + qw * qw;
    if (!(squared >= 0.998001 && squared <= 1.002001))
      throw new RangeError(`A collider rotation must be a unit quaternion; normalize it (its length squared is ${squared}).`);
    const add = (): number =>
      this.api.collider_add(
        body,
        code,
        size[0],
        size[1] ?? 0,
        size[2] ?? 0,
        position[0],
        position[1],
        position[2],
        rotation[0],
        rotation[1],
        rotation[2],
        rotation[3],
        density,
      );
    let row = add();
    if (row < 0) {
      this.reserve(this.capacity, this.colliderCapacity * 2);
      row = add();
    }
    // After the add: a world that grew has new views.
    const { colliderFriction, colliderRestitution, colliderCombine } = this.columns;
    colliderFriction[row] = friction;
    colliderRestitution[row] = restitution;
    colliderCombine[row] = frictionRule | (restitutionRule << 2);
    return row;
  }
  /**
   * Adds a convex polyhedron that colliders can share, for {@link KernelWorld.addCollider} with shape `hull`. Rows stay for
   * the world's life, and a snapshot carries them. Read views from `columns` after this call.
   * @param vertices Points in the hull's frame.
   * @param faces Each face's vertex indices, counter-clockwise seen from outside. Neighbouring faces must not lie in one
   * plane, and a face holds at most 256 edges. `convexHull` builds such faces from points.
   * @returns The hull's row.
   * @throws RangeError for a shape that is not a closed convex polyhedron with flat faces, naming what is wrong.
   */
  addHull(vertices: readonly (readonly [number, number, number])[], faces: readonly (readonly number[])[]): number {
    const { api } = this,
      edges = faces.reduce((sum, face) => sum + face.length, 0);
    if (!vertices.every((vertex) => vertex.length === 3 && vertex.every(Number.isFinite)))
      throw new RangeError('A hull vertex must be three finite numbers; check what fed it.');
    if (!api.hull_begin(vertices.length, faces.length, edges))
      throw new RangeError(`Memory cannot hold a hull of ${vertices.length} vertices; free another world, or simplify the hull.`);
    if (api.world_layout() !== this.layout) this.bind();
    const c = this.columns,
      [v0, e0, f0] = [api.hull_next(0), api.hull_next(1), api.hull_next(2)];
    vertices.forEach(([x, y, z], i) => {
      c.vertexX[v0 + i] = x;
      c.vertexY[v0 + i] = y;
      c.vertexZ[v0 + i] = z;
    });
    let edge = 0;
    faces.forEach((face, f) => {
      c.faceEdge[f0 + f] = edge;
      for (const index of face) {
        if (!Number.isInteger(index) || index < 0) throw new RangeError(`A hull face index must be a whole number; use a place in the vertex list (got ${index}).`);
        c.edgeOrigin[e0 + edge++] = index;
      }
    });
    const row = api.hull_end(vertices.length, faces.length, edges);
    if (row < 0) throw new RangeError(`This hull was refused; fix what this says: ${hullErrors[row]}.`);
    this.hullRows = row + 1;
    return row;
  }
  /**
   * Removes a collider and works out its body's mass again. Its row comes back after the next step.
   * @returns false when the row holds no collider.
   */
  removeCollider(collider: number): boolean {
    return Number.isInteger(collider) && collider >= 0 && this.api.collider_remove(collider) === 1;
  }
  /**
   * Adds a joint between two bodies and returns its row in the joint columns. Grows the world when the rows run out, so
   * read views from `columns` after this call. Its frames start as the identity and every other column as zero.
   * @param flags The `JOINT_` bits; the axes it locks hold from the first step.
   * @throws RangeError for a body that is gone, a body joined to itself, or when the world cannot grow.
   */
  addJoint(a: number, b: number, flags: number): number {
    const { api } = this,
      row = api.joint_add(a, b, flags);
    if (row < 0) throw new RangeError(`Rows ${a} and ${b} cannot take a joint; use two rows addBody returned, or free memory.`);
    if (api.world_layout() !== this.layout) this.bind();
    return row;
  }
  /**
   * Removes a joint and wakes its bodies. Its row comes back from a later {@link KernelWorld.addJoint}, last freed first.
   * @returns false when the row holds no joint.
   */
  removeJoint(joint: number): boolean {
    return Number.isInteger(joint) && joint >= 0 && this.api.joint_remove(joint) === 1;
  }
  /** Turns a joint's frames on both bodies so that frame X runs along `axis`, a direction in each body's own frame. */
  setJointAxis(joint: number, axis: readonly [number, number, number]): void {
    this.api.joint_set_axis(joint, axis[0], axis[1], axis[2]);
  }
  /** Sets a joint's frame on each body, as quaternions `[x, y, z, w]` in that body's frame; the kernel makes them unit length. */
  setJointFrames(joint: number, a: Quat, b: Quat): void {
    this.api.joint_set_frames(joint, a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]);
  }
  /**
   * Works out a body's mass again, after a write to its `additionalMass` column. Extra mass is spread as the colliders
   * are, so it scales the inertia too.
   */
  updateMass(body: number): this {
    this.api.body_update_mass(body);
    return this;
  }
  /**
   * Changes how a body moves, keeping its pose, colliders and joints. It wakes, with what it touches. A body made fixed
   * stops and drops its pairs with other fixed bodies, so what they touched ends; one made `kinematicPosition` holds its
   * pose until given a target.
   * @throws RangeError for an unknown kind.
   */
  setKind(body: number, kind: KernelBodyKind): this {
    const bits = Object.hasOwn(bodyKinds, kind) ? bodyKinds[kind] : undefined;
    if (bits === undefined)
      throw new RangeError(`Unknown body kind ${String(kind)}; use one of ${Object.keys(bodyKinds).join(', ')}.`);
    this.api.body_set_kind(body, bits);
    return this;
  }
  /**
   * Gives a body a solid of its own on top of its colliders and works out its mass again: `mass` kilograms at `center`,
   * and principal moments `inertia` in kg m² along `frame`, all in the body's frame. It replaces an earlier one, and the
   * `additionalMass` column goes to 0. With no collider mass these figures are the body's, exactly.
   */
  setOwnSolid(body: number, mass: number, center: Vec3, inertia: Vec3, frame: Quat = [0, 0, 0, 1]): this {
    this.api.body_set_own(body, mass, center[0], center[1], center[2], inertia[0], inertia[1], inertia[2], frame[0], frame[1], frame[2], frame[3]);
    return this;
  }
  /**
   * Puts a body at a pose by hand: the step starts from it, interpolation holds it, and a `kinematicPosition` body stays
   * there until given a target. The kernel normalises the rotation.
   * @param wake False leaves a sleeper asleep at its new place.
   */
  setPose(body: number, position: Vec3, rotation: Quat, wake = true): this {
    const [x, y, z] = position,
      [qx, qy, qz, qw] = rotation;
    this.api.body_set_pose(body, x, y, z, qx, qy, qz, qw, wake ? 1 : 0);
    return this;
  }
  /** The pose a `kinematicPosition` body reaches at the end of the next step. The kernel normalises the rotation. */
  setTarget(body: number, position: Vec3, rotation: Quat): this {
    const [x, y, z] = position,
      [qx, qy, qz, qw] = rotation;
    this.api.body_set_target(body, x, y, z, qx, qy, qz, qw);
    return this;
  }
  /** Sets the world axes a body may not move along or turn about: bit 0 for x, 1 for y, 2 for z. */
  setLocks(body: number, { linear, angular }: { linear?: number; angular?: number }): this {
    const { flags } = this.columns;
    if (linear !== undefined) flags[body] = (flags[body] & ~(7 << 3)) | (linear << 3);
    if (angular !== undefined) flags[body] = (flags[body] & ~(7 << 6)) | (angular << 6);
    return this;
  }
  /**
   * Says a body's pose was written by hand. Moving bodies are looked at every step anyway; a fixed or sleeping body is
   * not, so call this after writing the pose of one. A sleeper wakes.
   */
  touch(body: number): this {
    this.api.body_touch(body);
    return this;
  }
  /**
   * Advances the world by `dt` seconds, in {@link KernelWorld.substeps} equal pieces. Finding new pairs can grow the world,
   * so read views from `columns` after this call.
   * @throws RangeError unless `dt` is finite and above zero, or when memory cannot hold the pairs found.
   * @throws MargoError (`failed`) when a body went past 1e15 in position or speed: the world keeps its last state and steps no
   * more. {@link KernelWorld.restore} an earlier snapshot, or build the world again with what drove the body limited.
   */
  step(dt: number): this {
    if (!(dt > 0) || !Number.isFinite(dt))
      throw new RangeError(`A step must be finite and above zero; a usual step is 1 / 60 (got ${dt}).`);
    if (this.stepping) throw new MargoError('state', 'A contact filter ran a step; a filter may only read the world.');
    this.stepping = true;
    let failed: number;
    try {
      failed = this.api.world_step(dt);
    } finally {
      this.stepping = false;
    }
    if (this.api.world_layout() !== this.layout) this.bind();
    if (failed) throw new RangeError('Memory cannot hold the pairs of this world; spread the colliders out or use fewer.');
    const lost = this.api.world_lost();
    if (lost >= 0)
      throw new MargoError(
        'failed',
        `Body row ${lost} went past 1e15 in position or speed, where a step has no numbers left to work with. A true path can do this: a bead free on a spinning rail flies out exponentially. This world has stopped; limit the joint that drives the body, then restore a snapshot or build the world again.`,
      );
    return this;
  }
  /** Bytes of the world, and of a {@link KernelWorld.snapshot}. */
  get bytes(): number {
    return this.api.world_bytes() >>> 0;
  }
  /** FNV-1a of the world's bytes: equal in every browser, in Node and on any machine for the same inputs. */
  get hash(): number {
    return this.api.world_hash() >>> 0;
  }
  /** The whole world as one copy of its bytes, for {@link KernelWorld.restore}. Only this kernel build can read them. */
  snapshot(): Uint8Array {
    const { api } = this;
    return new Uint8Array(api.memory.buffer, api.world_base(), this.bytes).slice();
  }
  /**
   * Puts the world back as a {@link KernelWorld.snapshot} found it, in one copy, at the snapshot's size. Rows, pairs, sleep
   * and every value come back, so the steps after it give the same bits as the first time.
   * @throws RangeError for bytes that are not a snapshot of this kernel, or when memory cannot hold them.
   */
  restore(snapshot: Uint8Array): this {
    const { api } = this,
      base = api.world_base(),
      bytes = snapshot.byteLength,
      words = new DataView(snapshot.buffer, snapshot.byteOffset, bytes);
    if (
      bytes < 8 ||
      words.getUint32(0, true) !== new DataView(api.memory.buffer).getUint32(base, true) ||
      words.getUint32(4, true) !== bytes
    )
      throw new RangeError('These bytes are not a snapshot of this kernel; use what snapshot() returned.');
    if (!api.world_ensure(bytes)) throw new RangeError(`Memory cannot hold a snapshot of ${bytes} bytes; free another world, or use a smaller one.`);
    new Uint8Array(api.memory.buffer, base, bytes).set(snapshot);
    this.bind();
    this.hullRows = api.world_capacity(7);
    return this;
  }
  /**
   * Makes room for `bodies` and `colliders` rows. Rows keep their index and values; later steps give the same results.
   * @throws RangeError when the kernel cannot grow that far.
   */
  reserve(bodies: number, colliders: number = this.colliderCapacity): this {
    if (!Number.isSafeInteger(bodies) || !Number.isSafeInteger(colliders) || !this.api.world_reserve(bodies, colliders))
      throw new RangeError(`Cannot reserve ${bodies} bodies and ${colliders} colliders; the limit of each is 4194304 and what memory allows.`);
    this.bind();
    return this;
  }
}
