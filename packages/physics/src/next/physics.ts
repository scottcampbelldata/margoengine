/// <reference lib="esnext.disposable" preserve="true" />
// The own solver behind the names `Physics` has today. On the step path: no `Math`, tests/step-path.test.js holds that.
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel, EnginePlugin, Mesh } from '@margoengine/core';
import type { BodyOptions, BodyType } from '../body.js';
import {
  COLLIDER_OFF,
  COLLIDER_MODIFY,
  COLLIDER_SENSOR,
  EVENT_COLLIDER,
  EVENT_SENSOR,
  KernelWorld,
  loadKernel,
  PAIR_IS_PART,
  QUERY_EXCLUDE_DYNAMIC,
  QUERY_EXCLUDE_FIXED,
  QUERY_EXCLUDE_KINEMATIC,
  QUERY_EXCLUDE_SENSORS,
  QUERY_EXCLUDE_SOLIDS,
  QUERY_ONLY_DYNAMIC,
  QUERY_ONLY_FIXED,
  QUERY_ONLY_KINEMATIC,
  type KernelRayHit,
  type KernelShapeCastHit,
  type KernelLoadOptions,
  type KernelShape,
  type KernelSolverOptions,
} from '../kernel.js';
import { checkVec, type Quat, type Vec3 } from '../math.js';
import { colliderGeometry } from '../mesh-fit.js';
import type { ColliderOptions, ShapeOptions } from '../shapes.js';
import { PhysicsBody, checkRotation, type BodyOwner } from './body.js';
import { PhysicsCollider } from './collider.js';
import { type NextJointOptions, PhysicsJoint, createJoint } from './joint.js';
import { kernelCollider, multiply, queryParts, queryShape, shapeServed, turn, type HullRows } from './shapes.js';
import { MeshSync, meshPose } from './sync.js';

/** Options for creating a Physics world; every field has a default. */
export interface PhysicsOptions {
  /** Default [0, -9.81, 0]. */
  gravity?: Vec3;
  /** Seconds per physics step (default 1/60). */
  fixedTimestep?: number;
  /** Most steps per frame; extra time is dropped so a slow frame cannot snowball (default 4). */
  maxSubsteps?: number;
  /** Interpolate rendered transforms between the last two steps (default true). */
  interpolate?: boolean;
  /** Multiplies frame time, for slow motion (default 1). */
  timeScale?: number;
  /** Start paused (default false). */
  paused?: boolean;
  /** Equal pieces each step is split into; forces reach every piece and impulses land once (default 8). */
  substeps?: number;
  /** Solver passes in each substep (default 2). */
  iterations?: number;
  /** The old name of `substeps`, kept for one release. */
  solverIterations?: number;
  /** Plugin name (default 'physics'). */
  name?: string;
  /** Decides each candidate pair of bodies; false lets them pass through each other and keeps their sensor events quiet. */
  contactFilter?: (a: PhysicsBody, b: PhysicsBody) => boolean;
  /**
   * Called for each touching pair that has a collider with `modifyContacts` set, after its friction and bounce are set and
   * before it is solved, each step: change its friction, restitution and normal, or clear its contacts (a one-way platform,
   * a slippery patch). The object is reused, so keep what you need, not the object.
   */
  contactModifier?: (contact: ContactModification) => void;
}

/** A touching pair shown to `PhysicsOptions.contactModifier`, valid only inside the call. */
export class ContactModification {
  /** @internal */
  row = 0;
  /** @internal */
  colliderA!: PhysicsCollider;
  /** @internal */
  colliderB!: PhysicsCollider;
  /** @internal */
  constructor(private readonly kernel: KernelWorld) {}
  /** The pair's first collider; normals run from it to {@link ContactModification.colliderB}. */
  get first(): PhysicsCollider {
    return this.colliderA;
  }
  /** The pair's second collider. */
  get second(): PhysicsCollider {
    return this.colliderB;
  }
  /** Coulomb friction of the pair, from the colliders' own and their combine rules; set it to override. */
  get friction(): number {
    return this.kernel.columns.pairFriction[this.row];
  }
  set friction(value: number) {
    if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`Friction must be finite and not negative (got ${value}).`);
    this.kernel.columns.pairFriction[this.row] = value;
  }
  /** Restitution of the pair; set it to override. */
  get restitution(): number {
    return this.kernel.columns.pairRestitution[this.row];
  }
  set restitution(value: number) {
    if (!(value >= 0 && value <= 1)) throw new RangeError(`Restitution must be from 0 to 1 (got ${value}).`);
    this.kernel.columns.pairRestitution[this.row] = value;
  }
  /**
   * The velocity the second collider's surface moves relative to the first's, in world space (default zero): a conveyor
   * belt. Friction brings the bodies' sliding to it, so a box on a belt is carried at the belt's speed. Only its part along
   * the contact's surface counts, and it lasts for this step: set it each time the modifier is called.
   */
  get surfaceVelocity(): [number, number, number] {
    const c = this.kernel.columns;
    return [c.pairSurfaceX[this.row], c.pairSurfaceY[this.row], c.pairSurfaceZ[this.row]];
  }
  set surfaceVelocity(value: Vec3) {
    checkVec(value, 'Surface velocity');
    const c = this.kernel.columns;
    [c.pairSurfaceX[this.row], c.pairSurfaceY[this.row], c.pairSurfaceZ[this.row]] = value;
  }
  /** How many contact points the pair has. */
  get contactCount(): number {
    return this.kernel.columns.pairContacts[this.row];
  }
  /** The unit contact normal in world space, from the first collider to the second. */
  get normal(): [number, number, number] {
    const c = this.kernel.columns;
    return [c.pairNormalX[this.row], c.pairNormalY[this.row], c.pairNormalZ[this.row]];
  }
  set normal(value: Vec3) {
    checkVec(value, 'Contact normal');
    const length = Math.hypot(value[0], value[1], value[2]);
    if (!(length > 1e-6)) throw new RangeError('A contact normal needs a direction; pass a vector of some length.');
    const c = this.kernel.columns;
    [c.pairNormalX[this.row], c.pairNormalY[this.row], c.pairNormalZ[this.row]] = [value[0] / length, value[1] / length, value[2] / length];
  }
  /** Drops every contact of the pair for this step: the bodies pass through each other and push nothing. */
  clear(): void {
    this.kernel.columns.pairContacts[this.row] = 0;
  }
  /**
   * Makes the collider `platform` a one-way platform: contacts whose normal, taken from the platform to the other collider,
   * lies within `angle` radians (default a quarter turn: the half space above it) of `direction` stay, and the rest are
   * dropped. A body rising through the underside meets nothing, and standing on top it rests.
   * @throws RangeError when `platform` is neither collider of the pair.
   */
  oneWay(platform: PhysicsCollider, direction: Vec3, angle = Math.PI / 2): void {
    checkVec(direction, 'Platform direction');
    if (platform !== this.colliderA && platform !== this.colliderB)
      throw new RangeError('That collider is not in this pair; pass colliderA or colliderB of the contact.');
    const [nx, ny, nz] = this.normal,
      sign = platform === this.colliderA ? 1 : -1,
      length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(length > 0)) throw new RangeError('A platform direction needs some length.');
    const along = (sign * (nx * direction[0] + ny * direction[1] + nz * direction[2])) / length;
    if (along < Math.cos(angle)) this.clear();
  }
}

/** Kind of collision event: `contactstart` and `contactend` for solid contacts, `intersectionstart` and `intersectionend` for sensors. */
export type CollisionEventType = 'contactstart' | 'contactend' | 'intersectionstart' | 'intersectionend';
/** Two colliders began or stopped touching. */
export interface CollisionEvent {
  type: CollisionEventType;
  bodyA: PhysicsBody;
  bodyB: PhysicsBody;
  meshA: Mesh | null;
  meshB: Mesh | null;
  colliderA: PhysicsCollider;
  colliderB: PhysicsCollider;
  /** True when either collider is a sensor (intersection events). */
  sensor: boolean;
}

/** How hard two colliders pressed on each other in the last step. Only the own solver has this event. */
export interface ContactForceEvent {
  type: 'contactforce';
  bodyA: PhysicsBody;
  bodyB: PhysicsBody;
  meshA: Mesh | null;
  meshB: Mesh | null;
  colliderA: PhysicsCollider;
  colliderB: PhysicsCollider;
  /** The normal impulse of the whole step, in newton seconds. */
  impulse: number;
  /** `impulse` over the step's length, in newtons. A box at rest on a floor reads its weight. */
  force: number;
}

/** Events a Physics world emits, keyed by event name. `touching` and `contactPoints` read contacts after a step. */
export interface PhysicsEventMap {
  contactstart: CollisionEvent;
  contactend: CollisionEvent;
  intersectionstart: CollisionEvent;
  intersectionend: CollisionEvent;
  /** After each step that has a listener, once for each pair of colliders that pressed on each other. */
  contactforce: ContactForceEvent;
  /** Before each fixed step, with the step length. Drive kinematic bodies here. */
  beforestep: number;
  afterstep: number;
}

/** Which colliders a scene query sees: the root entry's names, plus Rapier's flags the root does not name. */
export interface QueryFilter {
  /** Packed interaction groups of the query, see `collisionGroups`; a collider is seen when the groups meet both ways. */
  groups?: number;
  /** Leave out every collider of this body. */
  exclude?: PhysicsBody;
  /** Leave out this one collider. */
  excludeCollider?: PhysicsCollider;
  excludeSensors?: boolean;
  /** Leave out colliders that are not sensors. */
  excludeSolids?: boolean;
  excludeFixed?: boolean;
  excludeKinematic?: boolean;
  excludeDynamic?: boolean;
  /** See only colliders of dynamic bodies; with other `only` flags, any of the kinds named. */
  onlyDynamic?: boolean;
  onlyKinematic?: boolean;
  onlyFixed?: boolean;
  /** Return false to skip a collider. */
  predicate?: (body: PhysicsBody, collider: PhysicsCollider) => boolean;
}
/** Options of `Physics.raycast` and `raycastAll`: the query filter plus a distance limit and solid starts. */
export interface PhysicsRaycastOptions extends QueryFilter {
  /** Default unbounded. */
  maxDistance?: number;
  /** A ray that starts inside a shape hits it at distance 0 (default true); false: where it leaves, the normal facing the ray. */
  solid?: boolean;
}
/** A ray hit: the body, its mesh and the collider, how far along the ray, the point and the surface normal. */
export interface RaycastHit {
  body: PhysicsBody;
  mesh: Mesh | null;
  collider: PhysicsCollider;
  distance: number;
  point: [number, number, number];
  /** Outward surface normal, world space; zero for a hit at distance 0 inside a solid shape. */
  normal: [number, number, number];
}

/** Options of `Physics.shapeCast`: the query filter plus Rapier's `ShapeCastOptions`. */
export interface PhysicsShapeCastOptions extends QueryFilter {
  /** Default unbounded. */
  maxDistance?: number;
  /** Stop this far short of touching (default 0). */
  targetDistance?: number;
  /** A cast that starts in contact hits at distance 0 even when it moves out (default true); false lets such a cast go on. */
  stopAtPenetration?: boolean;
  /** A hit at the start gets its normal and points (default true); false leaves them zero. */
  computeImpactGeometryOnPenetration?: boolean;
}
/** A shape cast's first touch: the ray hit's fields on the collider hit, plus the point and normal on the cast shape. */
export interface ShapeCastHit extends RaycastHit {
  queryPoint: [number, number, number];
  queryNormal: [number, number, number];
}
/** The point of a collider nearest a query point, whether the query point is inside it, and how far it is. */
/** What {@link Physics.contactPair} returns for one part of a pair: the normal from the first collider to the second. */
export interface ContactManifold {
  normal: [number, number, number];
  /** Up to four points: where each collider's surface is, how far apart they are (negative when they overlap) and an id that stays with the feature. */
  points: { pointA: [number, number, number]; pointB: [number, number, number]; separation: number; id: number }[];
}

/** What {@link Physics.colliderDistance} returns. */
export interface ColliderDistance {
  /** 0 when the colliders overlap. */
  distance: number;
  pointA: [number, number, number];
  pointB: [number, number, number];
}

export interface PointProjection {
  body: PhysicsBody;
  mesh: Mesh | null;
  collider: PhysicsCollider;
  point: [number, number, number];
  inside: boolean;
  distance: number;
}

/** @internal A helper that steps, syncs and is disposed with a world. */
export interface PhysicsAttachment {
  beforeStep?(dt: number): void;
  afterSync?(): void;
  bodyRemoved?(body: PhysicsBody): void;
  dispose(): void;
}

/** No row: the end of a pair list, and a filter word that leaves nothing out. */
const NONE = 0xffffffff;
const byDistance = (a: RaycastHit, b: RaycastHit): number => a.distance - b.distance;
const noop = (): void => {};
// Set.forEach with the event as thisArg calls listeners without allocating a closure or a snapshot array.
function callListener(this: never, listener: (event: never) => void): void {
  listener(this);
}
const attachmentSync = (attachment: PhysicsAttachment): void => attachment.afterSync?.();
const later = (what: string, when: string): MargoError =>
  new MargoError('unsupported', `${what} is not in the own solver yet; it comes with ${when}. Use @margoengine/physics until then.`);
const ascending = (x: number, y: number): number => x - y;
const bits = (enabled: readonly [boolean, boolean, boolean]): number =>
  (enabled[0] ? 0 : 1) | (enabled[1] ? 0 : 2) | (enabled[2] ? 0 : 4);

/**
 * Rigid-body physics on Margo's own solver as a Margo Engine plugin. The same names as `Physics` from the root entry, with
 * a fixed timestep, an accumulator and interpolation. Bodies fall, turn, collide, sleep and hold joints; a call that needs
 * queries throws `unsupported`. A preview, removed when it becomes the root.
 */
export class Physics implements EnginePlugin, BodyOwner {
  readonly name: string;
  fixedTimestep: number;
  maxSubsteps: number;
  interpolate: boolean;
  timeScale: number;
  paused: boolean;
  /** Fixed steps taken since creation. */
  stepCount = 0;
  private world: KernelWorld | null;
  private hasModifier = false;
  private engine: EngineKernel | null = null;
  private accumulator = 0;
  private lastAlpha = 1;
  private disposed = false;
  private readonly meshes: MeshSync;
  private readonly bodies = new Set<PhysicsBody>();
  /** Pair rows of one `contactPoints` call, kept between calls. */
  private readonly rowScratch: number[] = [];
  private readonly joints = new Set<PhysicsJoint>();
  private readonly byMesh = new Map<Mesh, PhysicsBody>();
  private readonly byRow = new Map<number, PhysicsCollider>();
  // A hull's rows stay for the world's life, so colliders built from the same points share one.
  private readonly hullRows = new Map<string, number>();
  private readonly hulls: HullRows = {
    addHull: (vertices, faces) => {
      const key = JSON.stringify([vertices, faces]);
      let row = this.hullRows.get(key);
      if (row === undefined) {
        row = this.kernel.addHull(vertices, faces);
        this.hullRows.set(key, row);
      }
      return row;
    },
    hullVolume: (row) => this.kernel.columns.hullVolume[row],
    addTrimesh: (vertices, indices, fixInternalEdges, oriented) => this.kernel.addTrimesh(vertices, indices, { fixInternalEdges, oriented }),
    addHeightfield: (rows, columns, heights, scale, fixInternalEdges) =>
      this.kernel.addHeightfield(rows, columns, heights, [scale[0], scale[1], scale[2]], { fixInternalEdges }),
    addVoxels: (cells, size) => this.kernel.addVoxels(cells, [size[0], size[1], size[2]]),
  };
  private readonly attachments = new Set<PhysicsAttachment>();
  private readonly listeners = new Map<keyof PhysicsEventMap, Set<(event: never) => void>>();
  // Gathered into a reused array; a step run from inside a listener gathers into its own.
  private readonly eventBuffer: (CollisionEvent | ContactForceEvent)[] = [];
  private dispatching = false;

  /**
   * Gets the solver ready, once per app: compiling it is asynchronous, so `new Physics(engine)` can stay synchronous.
   * Later calls resolve at once, calls made during a load share it, and a failed load is tried again by the next call.
   * @example await Physics.load();
   * const physics = new Physics(engine);
   * @throws AbortError (the signal's reason) when `signal` aborts first.
   */
  static async load(options: KernelLoadOptions = {}): Promise<void> {
    await loadKernel(options);
  }
  /** Creates the Physics on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options: PhysicsOptions = {}): Physics {
    return new Physics(engine, options);
  }
  /**
   * @throws MargoError (`state`) before {@link Physics.load} has finished.
   * @throws MargoError (`unsupported`) for an option the own solver does not hold yet.
   */
  constructor(engine: EngineKernel | null, options: PhysicsOptions = {}) {
    if ('rapier' in options) throw new TypeError('The own solver takes no rapier option; leave it out.');
    this.name = options.name ?? 'physics';
    this.fixedTimestep = options.fixedTimestep ?? 1 / 60;
    this.maxSubsteps = options.maxSubsteps ?? 4;
    this.interpolate = options.interpolate ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.paused = options.paused ?? false;
    if (!(this.fixedTimestep > 0 && this.fixedTimestep <= 1)) throw new RangeError('fixedTimestep must be in (0, 1] seconds');
    if (!Number.isInteger(this.maxSubsteps) || this.maxSubsteps < 1)
      throw new RangeError('maxSubsteps must be a positive integer');
    const gravity = options.gravity ?? [0, -9.81, 0];
    checkVec(gravity, 'Gravity');
    this.world = new KernelWorld();
    this.world.setGravity(...gravity);
    const filter = options.contactFilter;
    if (filter) this.world.contactFilter = (a, b) => filter(this.byRow.get(a)!.body, this.byRow.get(b)!.body);
    const modifier = options.contactModifier;
    if (modifier) {
      const world = this.world,
        view = new ContactModification(world);
      this.hasModifier = true;
      world.setContactModifier((row) => {
        const c = world.columns,
          a = this.byRow.get(c.pairA[row]),
          b = this.byRow.get(c.pairB[row]);
        if (!a || !b) return;
        view.row = row;
        view.colliderA = a;
        view.colliderB = b;
        modifier(view);
      });
    }
    const substeps = options.substeps ?? options.solverIterations;
    if (substeps !== undefined) this.world.substeps = substeps;
    if (options.iterations !== undefined) this.world.iterations = options.iterations;
    this.meshes = new MeshSync(this.world, (body) => this.removeBody(body));
    if (engine)
      try {
        engine.use(this);
      } catch (error) {
        this.dispose();
        throw error;
      }
  }

  /** The kernel's world: its columns, `hash`, `snapshot` and `restore`. A preview; it may change while the solver is built. */
  get kernel(): KernelWorld {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    return this.world!;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  get gravity(): [number, number, number] {
    return this.kernel.gravity;
  }
  set gravity(value: Vec3) {
    checkVec(value, 'Gravity');
    const kernel = this.kernel,
      old = kernel.gravity;
    kernel.setGravity(value[0], value[1], value[2]);
    // A sleeper would float in the old field: wake it.
    if (old[0] !== value[0] || old[1] !== value[1] || old[2] !== value[2])
      for (const body of this.bodies) if (body.type === 'dynamic') kernel.wake(body.row);
  }
  /** Interpolation factor used by the last `update`: leftover accumulator time over the step length, 0..1. */
  get alpha(): number {
    return this.lastAlpha;
  }
  /** Leftover simulation time in seconds, less than one step. */
  get pendingTime(): number {
    return this.accumulator;
  }
  /** Equal pieces each step is split into (default 8). */
  get substeps(): number {
    return this.kernel.substeps;
  }
  set substeps(substeps: number) {
    this.kernel.substeps = substeps;
  }
  /** The solver settings (contact stiffness, allowed penetration, joint shares); see {@link KernelWorld.setSolver}. */
  get solver(): Required<KernelSolverOptions> {
    return this.kernel.solver;
  }
  /** Tunes the solver from the next step on; leave out what stays. Wakes every dynamic body, so a sleeper meets the new settings. */
  setSolver(options: KernelSolverOptions): this {
    this.kernel.setSolver(options);
    for (const body of this.bodies) if (body.type === 'dynamic') this.kernel.wake(body.row);
    return this;
  }
  /** Solver passes in each substep (default 2). */
  get iterations(): number {
    return this.kernel.iterations;
  }
  set iterations(iterations: number) {
    this.kernel.iterations = iterations;
  }
  /** The old name of {@link Physics.substeps}, kept for one release. */
  get solverIterations(): number {
    return this.substeps;
  }
  set solverIterations(passes: number) {
    this.substeps = passes;
  }
  /** How many colliders the world holds. */
  get colliderCount(): number {
    return this.byRow.size;
  }
  get bodyCount(): number {
    return this.bodies.size;
  }

  // Engine plugin hooks.
  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    if (this.engine && this.engine !== engine)
      throw new MargoError('attached', 'Physics is attached to another engine; create one Physics per engine.');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.update(delta);
  }

  /** Advances the accumulator by `delta` seconds, runs whole fixed steps, then writes interpolated poses to meshes. Returns the number of steps. */
  update(delta: number): number {
    if (this.disposed) return 0;
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('delta must be a finite, non-negative number of seconds');
    let steps = 0;
    if (!this.paused) {
      const dt = this.fixedTimestep;
      this.accumulator += delta * this.timeScale;
      while (this.accumulator + dt * 1e-6 >= dt && steps < this.maxSubsteps) {
        this.step();
        this.accumulator -= dt;
        steps++;
      }
      if (this.accumulator >= dt) this.accumulator %= dt;
      if (this.accumulator < 0) this.accumulator = 0;
      this.lastAlpha = this.interpolate ? this.accumulator / dt : 1;
    }
    this.sync();
    return steps;
  }

  /** Runs exactly one fixed step. Does not touch meshes; call `sync()` to write them. */
  step(): void {
    const kernel = this.kernel,
      dt = this.fixedTimestep;
    this.emit('beforestep', dt);
    if (this.disposed) return;
    this.attachments.forEach(this.attachmentStep);
    kernel.step(dt);
    this.stepCount++;
    this.dispatch(dt);
    this.emit('afterstep', dt);
  }
  private readonly attachmentStep = (attachment: PhysicsAttachment): void => attachment.beforeStep?.(this.fixedTimestep);
  /** Reads what the step found into events, then calls listeners: one may change the world, so nothing is read after one runs. */
  private dispatch(dt: number): void {
    const outer = this.dispatching,
      events = outer ? [] : this.eventBuffer;
    this.gatherEvents(events);
    this.gatherForces(events, dt);
    this.dispatching = true;
    try {
      for (let i = 0; i < events.length; i++) this.emit(events[i].type, events[i] as never);
    } finally {
      this.dispatching = outer;
      events.length = 0;
    }
  }
  private gatherEvents(events: (CollisionEvent | ContactForceEvent)[]): void {
    const kernel = this.kernel,
      words = kernel.columns.events,
      count = kernel.eventCount;
    for (let i = 0; i < count; i++) {
      const first = words[2 * i],
        colliderA = this.byRow.get(first & EVENT_COLLIDER),
        colliderB = this.byRow.get(words[2 * i + 1]);
      if (!colliderA || !colliderB || !(colliderA.emits || colliderB.emits)) continue;
      const sensor = (first & EVENT_SENSOR) !== 0,
        started = first >>> 31 !== 0,
        bodyA = colliderA.body,
        bodyB = colliderB.body;
      events.push({
        type: sensor ? (started ? 'intersectionstart' : 'intersectionend') : started ? 'contactstart' : 'contactend',
        bodyA,
        bodyB,
        meshA: bodyA.mesh,
        meshB: bodyB.mesh,
        colliderA,
        colliderB,
        sensor,
      });
    }
    kernel.clearEvents();
  }
  private gatherForces(events: (CollisionEvent | ContactForceEvent)[], dt: number): void {
    if (!this.listeners.get('contactforce')?.size) return;
    const kernel = this.kernel,
      { solvePairs, pairForce, pairA, pairB, pairFlags } = kernel.columns,
      count = kernel.solvingPairs;
    // A mesh pair is solved as one part a triangle: its event sums them, as one pair of colliders felt one push.
    let meshed: Map<number, number> | null = null;
    for (let i = 0; i < count; i++) {
      const row = solvePairs[i];
      if (!(pairFlags[row] & PAIR_IS_PART)) continue;
      meshed ??= new Map();
      const key = pairA[row] * 0x400000 + pairB[row];
      meshed.set(key, (meshed.get(key) ?? 0) + pairForce[row]);
    }
    for (let i = 0; i < count; i++) {
      const row = solvePairs[i],
        key = pairA[row] * 0x400000 + pairB[row];
      let impulse = pairForce[row];
      if (meshed && pairFlags[row] & PAIR_IS_PART) {
        impulse = meshed.get(key) ?? 0;
        // The first part of the pair speaks; the rest are in its sum.
        meshed.delete(key);
      }
      const colliderA = this.byRow.get(pairA[row]),
        colliderB = this.byRow.get(pairB[row]);
      if (!(impulse > 0) || !colliderA || !colliderB) continue;
      if (!(colliderA.forceEvents || colliderB.forceEvents)) continue;
      if (impulse / dt <= Math.max(colliderA.forceThreshold, colliderB.forceThreshold)) continue;
      const bodyA = colliderA.body,
        bodyB = colliderB.body;
      events.push({
        type: 'contactforce',
        bodyA,
        bodyB,
        meshA: bodyA.mesh,
        meshB: bodyB.mesh,
        colliderA,
        colliderB,
        impulse,
        force: impulse / dt,
      });
    }
  }

  /** Writes body poses to their meshes, interpolated by `alpha` between the last two steps. Allocates nothing. */
  sync(alpha = this.lastAlpha): void {
    if (this.disposed) return;
    if (!Number.isFinite(alpha)) throw new RangeError('Interpolation alpha must be a finite number; pass a value from 0 to 1.');
    this.meshes.write(!this.interpolate || alpha > 1 ? 1 : alpha < 0 ? 0 : alpha);
    this.attachments.forEach(attachmentSync);
  }

  /**
   * Creates a rigid body, optionally driving `mesh`. Physics works in world space: the body starts at the mesh's world
   * pose, and each frame the interpolated world pose is written to the mesh's position and rotation (relative to its
   * parent for a child mesh, using the parent's current world transform, so there is no frame of lag). Scale is never
   * written.
   * @throws MargoError (`unsupported`) for an option the own solver does not hold yet.
   */
  addBody(mesh: Mesh | null, options: BodyOptions = {}): PhysicsBody {
    const kernel = this.kernel,
      type: BodyType = options.type ?? 'dynamic';
    if (!['dynamic', 'fixed', 'kinematicPosition', 'kinematicVelocity'].includes(type))
      throw new TypeError(`Unknown body type ${type}; use dynamic, fixed, kinematicPosition or kinematicVelocity.`);
    if (mesh && this.byMesh.has(mesh))
      throw new MargoError('state', 'This mesh already has a physics body; remove it first or use the existing body.');
    if (options.follow) throw later('follow', 'the character and vehicle batch');
    const start = mesh ? meshPose(mesh, this.engine) : null,
      position = options.position ?? start?.position ?? [0, 0, 0],
      rotation: Quat = options.rotation ?? start?.rotation ?? [0, 0, 0, 1];
    checkVec(position, 'Position');
    checkRotation(rotation);
    if (options.linearVelocity) checkVec(options.linearVelocity, 'linearVelocity');
    if (options.angularVelocity) checkVec(options.angularVelocity, 'angularVelocity');
    const row = kernel.addBody(type),
      body = new PhysicsBody(this, row, mesh, type),
      columns = kernel.columns;
    kernel.setPose(row, position, rotation);
    if (options.linearVelocity) body.setLinearVelocity(options.linearVelocity);
    if (options.angularVelocity) body.setAngularVelocity(options.angularVelocity);
    if (options.linearDamping !== undefined) columns.linearDamping[row] = options.linearDamping;
    if (options.angularDamping !== undefined) columns.angularDamping[row] = options.angularDamping;
    if (options.maxLinearSpeed !== undefined) body.maxLinearSpeed = options.maxLinearSpeed;
    if (options.maxAngularSpeed !== undefined) body.maxAngularSpeed = options.maxAngularSpeed;
    if (options.gravityScale !== undefined) columns.gravityScale[row] = options.gravityScale;
    if (options.dominance !== undefined) columns.dominance[row] = options.dominance;
    if (options.canSleep !== undefined) kernel.setCanSleep(row, options.canSleep);
    if (options.ccd) kernel.setCcd(row, true);
    if (options.softCcdPrediction !== undefined) body.softCcdPrediction = options.softCcdPrediction;
    if (options.additionalMass !== undefined) columns.additionalMass[row] = options.additionalMass;
    const angular = options.lockRotations ? 7 : options.enabledRotations ? bits(options.enabledRotations) : 0,
      linear = options.lockTranslations ? 7 : options.enabledTranslations ? bits(options.enabledTranslations) : 0;
    kernel.setLocks(row, { linear, angular });
    body.userData = options.userData;
    body.fitScale = start?.fitScale;
    // A pose taken from the mesh is already on the mesh; writing it back would only round a child's transform.
    if (mesh && !options.position && !options.rotation) body.dirty = false;
    this.bodies.add(body);
    this.meshes.add(body);
    if (mesh) this.byMesh.set(mesh, body);
    const colliders =
      options.colliders === undefined
        ? mesh
          ? [{ shape: 'box' } as ColliderOptions]
          : []
        : Array.isArray(options.colliders)
          ? options.colliders
          : [options.colliders as ColliderOptions];
    try {
      for (const collider of colliders) this.addCollider(body, collider);
    } catch (error) {
      this.removeBody(body);
      throw error;
    }
    kernel.updateMass(row);
    if (options.sleeping) kernel.sleep(row);
    return body;
  }

  /** The body of a mesh, if it has one. */
  bodyOf(mesh: Mesh): PhysicsBody | undefined {
    return this.byMesh.get(mesh);
  }
  /** The body a collider or its handle belongs to. */
  bodyOfCollider(collider: PhysicsCollider | number): PhysicsBody | undefined {
    return this.byRow.get(typeof collider === 'number' ? collider : collider.handle)?.body;
  }
  /** True when the own solver holds this shape. */
  supportsShape(shape: ShapeOptions['shape']): boolean {
    return shapeServed(shape);
  }
  getBodies(): PhysicsBody[] {
    return [...this.bodies];
  }

  /** @internal use `body.addCollider`. */
  addCollider(body: PhysicsBody, options: ColliderOptions): PhysicsCollider {
    const { mesh } = body,
      fitted =
        (options.shape === 'box' && !options.halfExtents) ||
        (options.shape === 'sphere' && options.radius === undefined) ||
        (options.shape === 'convexHull' && !options.points && !options.geometry),
      fit =
        mesh && fitted
          ? colliderGeometry(mesh, body.fitScale)
          : { geometry: null, scale: mesh ? ([mesh.scale.x, mesh.scale.y, mesh.scale.z] as const) : ([1, 1, 1] as const) };
    if (body.fitScale && mesh?.geometry) fit.scale = body.fitScale;
    const { name, shape, size, parts, options: placed } = kernelCollider(options, fit, this.hulls),
      row = parts ? this.kernel.addCompound(body.row, parts, placed) : this.kernel.addCollider(body.row, shape as KernelShape, size, placed),
      collider = new PhysicsCollider(this.kernel, row, body, name);
    if (options.collisionGroups !== undefined) this.kernel.columns.colliderGroups[row] = options.collisionGroups;
    if (options.solverGroups !== undefined) this.kernel.columns.colliderSolverGroups[row] = options.solverGroups;
    if (options.sensor || options.enabled === false)
      this.kernel.setColliderState(row, (options.sensor ? COLLIDER_SENSOR : 0) | (options.enabled === false ? COLLIDER_OFF : 0));
    collider.reshape = (next) => this.reshapeCollider(body, collider, next);
    collider.emits = options.events ?? true;
    collider.forceEvents = options.contactForceEvents ?? true;
    collider.forceThreshold = options.contactForceThreshold ?? 0;
    // A round triangle meets what it touches a border away: its contacts are made with that skin, its queries with the border.
    const skin = (options.contactSkin ?? 0) + (options.shape === 'triangle' ? (placed.border ?? 0) : 0);
    if (skin > 0) collider.setContactSkin(skin);
    if (options.contactForceThreshold !== undefined) collider.setContactForceEventThreshold(options.contactForceThreshold);
    if (options.activeCollisionTypes) collider.setActiveCollisionTypes(options.activeCollisionTypes);
    if (options.modifyContacts) {
      if (!this.hasModifier) throw new MargoError('state', 'modifyContacts needs a contactModifier: pass one in the Physics options.');
      this.kernel.setColliderState(row, this.kernel.columns.colliderFlags[row] | COLLIDER_MODIFY);
    }
    body.colliders.push(collider);
    this.byRow.set(row, collider);
    return collider;
  }
  /** @internal use `collider.setShape`. */
  private reshapeCollider(body: PhysicsBody, collider: PhysicsCollider, options: ColliderOptions): void {
    const { mesh } = body,
      fitted =
        (options.shape === 'box' && !options.halfExtents) ||
        (options.shape === 'sphere' && options.radius === undefined) ||
        (options.shape === 'convexHull' && !options.points && !options.vertices && !options.geometry),
      fit =
        mesh && fitted
          ? colliderGeometry(mesh, body.fitScale)
          : { geometry: null, scale: mesh ? ([mesh.scale.x, mesh.scale.y, mesh.scale.z] as const) : ([1, 1, 1] as const) };
    if (body.fitScale && mesh?.geometry) fit.scale = body.fitScale;
    const { name, shape, size, parts, options: placed } = kernelCollider(options, fit, this.hulls);
    if (parts) throw new MargoError('unsupported', 'A collider cannot become a compound; remove it and add a compound collider to the body.');
    const row = collider.handle;
    this.kernel.setColliderShape(row, shape as KernelShape, size);
    this.kernel.setColliderPose(row, placed.position ?? [0, 0, 0], placed.rotation ?? [0, 0, 0, 1]);
    if (placed.border) this.kernel.setColliderBorder(row, placed.border);
    if (options.shape === 'triangle') collider.setContactSkin((options.contactSkin ?? 0) + (placed.border ?? 0));
    if (options.mass !== undefined || options.density !== undefined || options.massless) {
      this.kernel.columns.colliderDensity[row] = placed.density ?? 0;
      this.kernel.updateMass(body.row);
    }
    collider.shape = name;
  }
  /** @internal use `body.removeCollider`. */
  removeCollider(body: PhysicsBody, collider: PhysicsCollider): void {
    const index = body.colliders.indexOf(collider);
    if (index < 0) throw new MargoError('state', 'Collider does not belong to this body; pass a collider from body.colliders.');
    body.colliders.splice(index, 1);
    this.byRow.delete(collider.handle);
    this.kernel.removeCollider(collider.handle);
    collider.markRemoved();
  }

  /** Removes a body with its colliders and joints. */
  removeBody(body: PhysicsBody): void {
    if (!this.bodies.has(body)) return;
    for (const attachment of [...this.attachments]) attachment.bodyRemoved?.(body);
    for (const joint of this.joints) if (joint.bodyA === body || joint.bodyB === body) this.removeJoint(joint);
    for (const collider of body.colliders) this.byRow.delete(collider.handle);
    this.bodies.delete(body);
    this.meshes.remove(body);
    if (body.mesh) this.byMesh.delete(body.mesh);
    this.kernel.removeBody(body.row);
    body.markRemoved();
  }
  /** @internal use `body.setTranslation` and the like: the mesh follows at the next sync. */
  moved(body: PhysicsBody): void {
    this.meshes.mark(body);
  }
  owns(body: PhysicsBody): boolean {
    return this.bodies.has(body);
  }
  /** @internal Registers a helper that steps and syncs with the world. */
  attach(attachment: PhysicsAttachment): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    this.attachments.add(attachment);
  }
  /** @internal Unregisters a helper; returns false when it was not attached. */
  detach(attachment: PhysicsAttachment): boolean {
    return this.attachments.delete(attachment);
  }

  /** Subscribes to step and contact events. Returns an unsubscribe function. */
  on<K extends keyof PhysicsEventMap>(type: K, listener: (event: PhysicsEventMap[K]) => void): () => void {
    if (this.disposed) return noop;
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }
  private emit<K extends keyof PhysicsEventMap>(type: K, event: PhysicsEventMap[K]): void {
    // Listeners removed during dispatch are skipped; listeners added during dispatch also run for this event.
    this.listeners.get(type)?.forEach(callListener, event);
  }

  /** Not served yet: throws. */
  addModel(): never {
    throw later('addModel', 'trimesh shapes');
  }
  /**
   * Connects two bodies with a fixed, spherical, revolute or prismatic joint. Anchors are in each body's local frame.
   * @throws MargoError (`state`) unless both bodies belong to this world and are two bodies.
   * @throws MargoError (`unsupported`) for a kind the own solver does not hold yet.
   */
  addJoint(bodyA: PhysicsBody, bodyB: PhysicsBody, options: NextJointOptions): PhysicsJoint {
    if (!this.bodies.has(bodyA) || !this.bodies.has(bodyB))
      throw new MargoError('state', 'Both bodies must belong to this physics world; add them with physics.addBody first.');
    if (bodyA === bodyB)
      throw new MargoError('state', 'A joint needs two different bodies; pass bodyA and bodyB that are not the same.');
    const joint = createJoint(this, bodyA, bodyB, options);
    this.joints.add(joint);
    return joint;
  }
  /** @internal use `joint.remove`. */
  removeJoint(joint: PhysicsJoint): void {
    if (!this.joints.delete(joint)) return;
    this.kernel.removeJoint(joint.row);
    joint.markRemoved();
  }
  /** Not served yet: throws. */
  createCharacterController(): never {
    throw later('createCharacterController', 'the character and vehicle batch');
  }
  /** Not served yet: throws. */
  removeController(): never {
    throw later('removeController', 'the character and vehicle batch');
  }
  /** The kernel's filter words for a query filter: flags, groups, collider row and body row to leave out. */
  private filterWords(filter: QueryFilter): [number, number, number, number] {
    let flags = 0;
    if (filter.excludeFixed) flags |= QUERY_EXCLUDE_FIXED;
    if (filter.excludeKinematic) flags |= QUERY_EXCLUDE_KINEMATIC;
    if (filter.excludeDynamic) flags |= QUERY_EXCLUDE_DYNAMIC;
    if (filter.excludeSensors) flags |= QUERY_EXCLUDE_SENSORS;
    if (filter.excludeSolids) flags |= QUERY_EXCLUDE_SOLIDS;
    if (filter.onlyDynamic) flags |= QUERY_ONLY_DYNAMIC;
    if (filter.onlyKinematic) flags |= QUERY_ONLY_KINEMATIC;
    if (filter.onlyFixed) flags |= QUERY_ONLY_FIXED;
    const groups = filter.groups === undefined ? 0xffffffff : filter.groups >>> 0;
    const collider = filter.excludeCollider ? filter.excludeCollider.handle : NONE;
    const body = filter.exclude ? filter.exclude.row : NONE;
    return [flags, groups, collider, body];
  }
  private rayHit(hit: KernelRayHit): RaycastHit | null {
    const collider = this.byRow.get(hit.collider);
    return collider ? { body: collider.body, mesh: collider.body.mesh, collider, distance: hit.distance, point: hit.point, normal: hit.normal } : null;
  }
  private passes(hit: RaycastHit, predicate: QueryFilter['predicate']): boolean {
    return !predicate || predicate(hit.body, hit.collider);
  }
  /**
   * The first hit along a ray, or null. Queries see the poses of the last step, as Rapier's do.
   * @throws RangeError for an origin or direction that is not three finite numbers, or a zero direction.
   */
  raycast(origin: Vec3, direction: Vec3, options: PhysicsRaycastOptions = {}): RaycastHit | null {
    checkVec(origin, 'Ray origin');
    checkVec(direction, 'Ray direction');
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    const max = options.maxDistance ?? Infinity,
      solid = options.solid ?? true,
      words = this.filterWords(options);
    if (options.predicate) {
      let best: RaycastHit | null = null;
      for (const raw of this.kernel.raycastAll(origin, direction, max, solid, ...words)) {
        const hit = this.rayHit(raw);
        if (hit && this.passes(hit, options.predicate) && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    }
    const raw = this.kernel.raycast(origin, direction, max, solid, ...words);
    return raw ? this.rayHit(raw) : null;
  }
  /**
   * Every hit along a ray, nearest first: one a collider. Return false from `options.stop` to end the list there.
   * @throws RangeError for an origin or direction that is not three finite numbers, or a zero direction.
   */
  raycastAll(origin: Vec3, direction: Vec3, options: PhysicsRaycastOptions & { stop?: (hit: RaycastHit) => boolean } = {}): RaycastHit[] {
    checkVec(origin, 'Ray origin');
    checkVec(direction, 'Ray direction');
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    const hits: RaycastHit[] = [];
    for (const raw of this.kernel.raycastAll(origin, direction, options.maxDistance ?? Infinity, options.solid ?? true, ...this.filterWords(options))) {
      const hit = this.rayHit(raw);
      if (hit && this.passes(hit, options.predicate)) hits.push(hit);
    }
    hits.sort(byDistance);
    if (options.stop)
      for (let i = 0; i < hits.length; i++) if (!options.stop(hits[i]!)) return hits.slice(0, i + 1);
    return hits;
  }
  private castHit(hit: KernelShapeCastHit): ShapeCastHit | null {
    const collider = this.byRow.get(hit.collider);
    return collider
      ? {
          body: collider.body,
          mesh: collider.body.mesh,
          collider,
          distance: hit.distance,
          point: hit.point,
          normal: hit.normal,
          queryPoint: hit.queryPoint,
          queryNormal: hit.queryNormal,
        }
      : null;
  }
  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
  }
  /**
   * Sweeps a convex shape (sphere, box, capsule, cylinder, cone or convexHull, with its size given) from `position` and
   * `rotation` along `direction` and returns the first collider it touches, or null. `distance` is along the direction's
   * unit. Queries see the poses of the last step, as Rapier's do.
   * @throws RangeError for a position, rotation or direction that is not finite, or a zero direction; MargoError
   * `unsupported` for another query shape.
   */
  shapeCast(shape: ShapeOptions, position: Vec3, rotation: Quat, direction: Vec3, options: PhysicsShapeCastOptions = {}): ShapeCastHit | null {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    checkVec(direction, 'Cast direction');
    this.live();
    const parts = queryParts(shape);
    if (parts) {
      // A compound is cast piece by piece: the first touch is the nearest of its pieces'.
      let best: ShapeCastHit | null = null;
      for (const part of parts) {
        const moved = turn(rotation, part.offset),
          hit = this.shapeCast(part.shape, [position[0] + moved[0], position[1] + moved[1], position[2] + moved[2]], multiply(rotation, part.rotation), direction, options);
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    }
    const query = queryShape(shape, this.hulls),
      cast = {
        max: options.maxDistance ?? Infinity,
        target: options.targetDistance ?? 0,
        stop: options.stopAtPenetration ?? true,
        geometry: options.computeImpactGeometryOnPenetration ?? true,
      },
      words = this.filterWords(options);
    if (options.predicate) {
      let best: ShapeCastHit | null = null;
      for (const raw of this.kernel.shapeCastAll(query, position, rotation, direction, cast, ...words)) {
        const hit = this.castHit(raw);
        if (hit && options.predicate(hit.body, hit.collider) && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    }
    const raw = this.kernel.shapeCast(query, position, rotation, direction, cast, ...words);
    return raw ? this.castHit(raw) : null;
  }
  /**
   * The point on any collider nearest `point`, or null when no collider is seen. Inside a shape with `solid` true (the
   * default) the point itself; with `solid` false the nearest point of its surface. Inside, `inside` is true and
   * `distance` 0 either way, as on the root entry.
   * @throws RangeError for a point that is not three finite numbers.
   */
  projectPoint(point: Vec3, options: QueryFilter & { solid?: boolean } = {}): PointProjection | null {
    checkVec(point, 'Point');
    this.live();
    const solid = options.solid ?? true,
      words = this.filterWords(options);
    const raws = options.predicate ? this.kernel.projectPointAll(point, solid, ...words) : [this.kernel.projectPoint(point, solid, ...words)];
    let best: PointProjection | null = null;
    for (const raw of raws) {
      const collider = raw && this.byRow.get(raw.collider);
      if (!raw || !collider || (options.predicate && !options.predicate(collider.body, collider))) continue;
      const distance = raw.inside ? 0 : raw.distance,
        hit = { body: collider.body, mesh: collider.body.mesh, collider, point: raw.point, inside: raw.inside, distance };
      if (!best || distance < best.distance || (distance === best.distance && hit.inside && !best.inside)) best = hit;
    }
    return best;
  }
  /**
   * The bodies whose colliders hold `point`, in the order they were added. A trimesh or height field holds no point.
   * @throws RangeError for a point that is not three finite numbers.
   */
  intersectPoint(point: Vec3, options: QueryFilter = {}): PhysicsBody[] {
    checkVec(point, 'Point');
    this.live();
    return this.bodiesOf(this.kernel.intersectPoint(point, ...this.filterWords(options)), options.predicate);
  }
  /**
   * The bodies whose colliders overlap a convex shape (as `shapeCast` takes) at `position` and `rotation`, in the order
   * they were added.
   * @throws RangeError for a position or rotation that is not finite; MargoError `unsupported` for another query shape.
   */
  intersectShape(shape: ShapeOptions, position: Vec3, rotation: Quat = [0, 0, 0, 1], options: QueryFilter = {}): PhysicsBody[] {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    this.live();
    const parts = queryParts(shape);
    if (parts) {
      const found = new Set<PhysicsBody>();
      for (const part of parts) {
        const moved = turn(rotation, part.offset);
        for (const body of this.intersectShape(part.shape, [position[0] + moved[0], position[1] + moved[1], position[2] + moved[2]], multiply(rotation, part.rotation), options)) found.add(body);
      }
      // In the order the bodies were added, as every query lists them.
      return [...this.bodies].filter((body) => found.has(body));
    }
    const query = queryShape(shape, this.hulls);
    return this.bodiesOf(this.kernel.intersectShape(query, position, rotation, ...this.filterWords(options)), options.predicate);
  }
  /**
   * The bodies whose colliders' boxes meet the box from `min` to `max`, in the order they were added. A collider's box is
   * tight to its shape at its pose of the last step (see {@link PhysicsCollider.aabb}).
   * @throws RangeError for a box that is not finite or has a `min` over its `max`.
   */
  intersectAabb(min: Vec3, max: Vec3, options: QueryFilter = {}): PhysicsBody[] {
    checkVec(min, 'Box min');
    checkVec(max, 'Box max');
    this.live();
    return this.bodiesOf(this.kernel.intersectAabb(min, max, ...this.filterWords(options)), options.predicate);
  }
  /**
   * The contact manifolds of two colliders within `prediction` metres of touching (default 0), whether or not their bodies
   * touch in the world: one for two convex colliders, one a pair of children for a compound, one a triangle or cell for a
   * mesh. Normals run from `a` to `b`. A mesh's triangles give their own normals, without the seam smoothing of
   * `fixInternalEdges`.
   * @throws RangeError for a collider that was removed or a prediction below 0.
   */
  contactPair(a: PhysicsCollider, b: PhysicsCollider, prediction = 0): ContactManifold[] {
    this.live();
    return this.kernel.pairContacts(this.rowOf(a), this.rowOf(b), prediction).map(({ normal, points }) => ({
      normal,
      points: points.map((p) => ({ pointA: p.onA, pointB: p.onB, separation: p.separation, id: p.id })),
    }));
  }
  /**
   * Whether two colliders overlap now, whether or not their bodies touch in the world. Sensors count.
   * @throws RangeError for a collider that was removed.
   */
  intersectionPair(a: PhysicsCollider, b: PhysicsCollider): boolean {
    this.live();
    return this.kernel.pairIntersects(this.rowOf(a), this.rowOf(b));
  }
  /**
   * How far apart two colliders are, with the nearest point on each; 0 when they overlap. Null when none can be read (a
   * half space against a mesh).
   * @throws RangeError for a collider that was removed.
   */
  colliderDistance(a: PhysicsCollider, b: PhysicsCollider): ColliderDistance | null {
    this.live();
    return this.kernel.pairDistance(this.rowOf(a), this.rowOf(b));
  }
  /**
   * A ray against one collider, as Rapier's `collider.castRay`: the hit or null. `maxDistance` defaults to unbounded and
   * `solid` to true.
   * @throws RangeError for an origin or direction that is not three finite numbers, a zero direction or a removed collider.
   */
  raycastCollider(collider: PhysicsCollider, origin: Vec3, direction: Vec3, options: { maxDistance?: number; solid?: boolean } = {}): RaycastHit | null {
    checkVec(origin, 'Ray origin');
    checkVec(direction, 'Ray direction');
    this.live();
    const raw = this.kernel.colliderRay(this.rowOf(collider), origin, direction, options.maxDistance ?? Infinity, options.solid ?? true);
    return raw ? this.rayHit(raw) : null;
  }
  /**
   * The point of one collider nearest `point`, as Rapier's `collider.projectPoint`: inside, with `solid` true (the default)
   * the point itself. Null when nothing can be projected (a mesh holds no inside).
   * @throws RangeError for a point that is not three finite numbers or a removed collider.
   */
  projectPointOnCollider(collider: PhysicsCollider, point: Vec3, options: { solid?: boolean } = {}): { point: [number, number, number]; inside: boolean; distance: number } | null {
    checkVec(point, 'Point');
    this.live();
    const raw = this.kernel.colliderProject(this.rowOf(collider), point, options.solid ?? true);
    return raw ? { point: raw.point, inside: raw.inside, distance: raw.inside ? 0 : raw.distance } : null;
  }
  /**
   * Whether `point` is inside one collider, as Rapier's `collider.containsPoint`; a mesh or height field holds no point.
   * @throws RangeError for a point that is not three finite numbers or a removed collider.
   */
  colliderContainsPoint(collider: PhysicsCollider, point: Vec3): boolean {
    return this.projectPointOnCollider(collider, point, { solid: true })?.inside ?? false;
  }
  /**
   * A shape cast against one collider, as Rapier's `collider.castShape`, with the options of `shapeCast`.
   * @throws RangeError for a pose or direction that is not finite, a removed collider; MargoError `unsupported` for a query shape the solver does not hold.
   */
  castShapeAtCollider(collider: PhysicsCollider, shape: ShapeOptions, position: Vec3, rotation: Quat, direction: Vec3, options: PhysicsShapeCastOptions = {}): ShapeCastHit | null {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    checkVec(direction, 'Cast direction');
    this.live();
    const query = queryShape(shape, this.hulls),
      raw = this.kernel.colliderShapeCast(this.rowOf(collider), query, position, rotation, direction, {
        max: options.maxDistance ?? Infinity,
        target: options.targetDistance ?? 0,
        stop: options.stopAtPenetration ?? true,
        geometry: options.computeImpactGeometryOnPenetration ?? true,
      });
    return raw ? this.castHit(raw) : null;
  }
  /**
   * Whether a convex shape overlaps one collider, as Rapier's `collider.intersectsShape`.
   * @throws RangeError for a pose that is not finite or a removed collider; MargoError `unsupported` for a query shape the solver does not hold.
   */
  colliderIntersectsShape(collider: PhysicsCollider, shape: ShapeOptions, position: Vec3, rotation: Quat = [0, 0, 0, 1]): boolean {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    this.live();
    return this.kernel.colliderOverlaps(this.rowOf(collider), queryShape(shape, this.hulls), position, rotation);
  }
  /** A collider's row, for the kernel; refuses what is not this world's. */
  private rowOf(collider: PhysicsCollider): number {
    if (!collider.valid || this.byRow.get(collider.handle) !== collider)
      throw new RangeError('That collider was removed or belongs to another world; pass a collider from body.colliders.');
    return collider.handle;
  }
  private bodiesOf(rows: readonly number[], predicate: QueryFilter['predicate']): PhysicsBody[] {
    const found = new Set<PhysicsBody>();
    for (const row of rows) {
      const collider = this.byRow.get(row);
      if (collider && (!predicate || predicate(collider.body, collider))) found.add(collider.body);
    }
    return [...found];
  }
  /**
   * Whether two bodies' colliders touch as of the last step. A point still ahead of a moving body does not count. It walks
   * only the pairs of `a`'s colliders and allocates nothing.
   */
  touching(a: PhysicsBody, b: PhysicsBody): boolean {
    const { kernel } = this,
      c = kernel.columns,
      { colliders } = a;
    for (let i = 0; i < colliders.length; i++) {
      const self = colliders[i].handle;
      for (let row = kernel.firstPair(self); row !== NONE; row = kernel.nextPair(row, self)) {
        if (this.bodyOfCollider(c.pairA[row] === self ? c.pairB[row] : c.pairA[row]) !== b) continue;
        // A mesh or compound pair keeps its points on its parts, one row each down the pairChild chain.
        for (let part = row; part !== NONE; part = c.pairChild[part])
          for (let at = part * 4; at < part * 4 + c.pairContacts[part]; at++)
            if (c.contactSeparation[at] <= 0 || c.contactNormalImpulse[at] > 0) return true;
      }
    }
    return false;
  }

  /**
   * Where the solver pushes on this body as of the last step: one world position [x, y, z] per contact point, so a box
   * flat on a floor has its four corners. A point two colliders share comes once for each. It walks only the pairs of the
   * body's colliders and their mesh parts, in the order of their rows, and allocates only what it returns.
   */
  contactPoints(body: PhysicsBody): [number, number, number][] {
    const points: [number, number, number][] = [],
      { kernel } = this,
      c = kernel.columns,
      { colliders } = body,
      rows = this.rowScratch;
    rows.length = 0;
    for (let i = 0; i < colliders.length; i++) {
      const self = colliders[i].handle;
      for (let row = kernel.firstPair(self); row !== NONE; row = kernel.nextPair(row, self))
        for (let part = row; part !== NONE; part = c.pairChild[part]) if (c.pairContacts[part] !== 0) rows.push(part);
    }
    rows.sort(ascending);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (let at = row * 4; at < row * 4 + c.pairContacts[row]; at++)
        if (c.contactSeparation[at] <= 0 || c.contactNormalImpulse[at] > 0) points.push([c.contactX[at], c.contactY[at], c.contactZ[at]]);
    }
    rows.length = 0;
    return points;
  }

  /** Not served yet: throws. */
  debugRender(): never {
    throw later('debugRender', 'the debug entry');
  }

  /** Frees every body and the world. Detaches from the engine if attached. */
  dispose(): void {
    if (this.disposed) return;
    const engine = this.engine;
    if (engine && !engine.disposed && engine.hasPlugin(this.name)) {
      // removePlugin calls back into dispose() after unregistering.
      try {
        engine.removePlugin(this.name);
        return;
      } catch {
        /* engine is tearing down; free below */
      }
    }
    for (const attachment of [...this.attachments]) attachment.dispose();
    for (const body of [...this.bodies]) this.removeBody(body);
    this.listeners.clear();
    this.disposed = true;
    this.engine = null;
    this.world = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
