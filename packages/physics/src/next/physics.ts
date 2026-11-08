/// <reference lib="esnext.disposable" preserve="true" />
// The own solver behind the names `Physics` has today. On the step path: no `Math`, tests/step-path.test.js holds that.
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel, EnginePlugin, Mesh } from '@margoengine/core';
import type { BodyOptions, BodyType } from '../body.js';
import {
  COLLIDER_OFF,
  COLLIDER_SENSOR,
  EVENT_COLLIDER,
  EVENT_SENSOR,
  KernelWorld,
  loadKernel,
  PAIR_IS_PART,
  type KernelContactPoint,
  type KernelLoadOptions,
} from '../kernel.js';
import { checkVec, type Quat, type Vec3 } from '../math.js';
import { colliderGeometry } from '../mesh-fit.js';
import type { ColliderOptions, ShapeOptions } from '../shapes.js';
import { PhysicsBody, checkRotation, type BodyOwner } from './body.js';
import { PhysicsCollider } from './collider.js';
import { type NextJointOptions, PhysicsJoint, createJoint } from './joint.js';
import { kernelCollider, shapeServed, type HullRows } from './shapes.js';
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

/** @internal A helper that steps, syncs and is disposed with a world. */
export interface PhysicsAttachment {
  beforeStep?(dt: number): void;
  afterSync?(): void;
  bodyRemoved?(body: PhysicsBody): void;
  dispose(): void;
}

const noop = (): void => {};
// Set.forEach with the event as thisArg calls listeners without allocating a closure or a snapshot array.
function callListener(this: never, listener: (event: never) => void): void {
  listener(this);
}
const attachmentSync = (attachment: PhysicsAttachment): void => attachment.afterSync?.();
const later = (what: string, when: string): MargoError =>
  new MargoError('unsupported', `${what} is not in the own solver yet; it comes with ${when}. Use @margoengine/physics until then.`);
/** A point the shapes reached: overlapping, or pushed on. A speculative point ahead of a body is neither. */
const pressing = (point: KernelContactPoint): boolean => point.separation <= 0 || point.normalImpulse > 0;
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
  private engine: EngineKernel | null = null;
  private accumulator = 0;
  private lastAlpha = 1;
  private disposed = false;
  private readonly meshes: MeshSync;
  private readonly bodies = new Set<PhysicsBody>();
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
    addTrimesh: (vertices, indices, fixInternalEdges) => this.kernel.addTrimesh(vertices, indices, { fixInternalEdges }),
    addHeightfield: (rows, columns, heights, scale, fixInternalEdges) =>
      this.kernel.addHeightfield(rows, columns, heights, [scale[0], scale[1], scale[2]], { fixInternalEdges }),
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
    const substeps = options.substeps ?? options.solverIterations;
    if (substeps !== undefined) this.world.substeps = substeps;
    if (options.iterations !== undefined) this.world.iterations = options.iterations;
    this.meshes = new MeshSync(this.world.columns, (body) => this.removeBody(body));
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
    this.meshes.write(this.bodies, !this.interpolate || alpha > 1 ? 1 : alpha < 0 ? 0 : alpha);
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
    if (options.ccd) throw later('ccd', 'continuous collision');
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
    if (options.gravityScale !== undefined) columns.gravityScale[row] = options.gravityScale;
    if (options.dominance !== undefined) columns.dominance[row] = options.dominance;
    if (options.canSleep !== undefined) kernel.setCanSleep(row, options.canSleep);
    if (options.additionalMass !== undefined) columns.additionalMass[row] = options.additionalMass;
    const angular = options.lockRotations ? 7 : options.enabledRotations ? bits(options.enabledRotations) : 0,
      linear = options.lockTranslations ? 7 : options.enabledTranslations ? bits(options.enabledTranslations) : 0;
    kernel.setLocks(row, { linear, angular });
    body.userData = options.userData;
    body.fitScale = start?.fitScale;
    // A pose taken from the mesh is already on the mesh; writing it back would only round a child's transform.
    if (mesh && !options.position && !options.rotation) body.dirty = false;
    this.bodies.add(body);
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
    const { name, shape, size, options: placed } = kernelCollider(options, fit, this.hulls),
      row = this.kernel.addCollider(body.row, shape, size, placed),
      collider = new PhysicsCollider(this.kernel, row, body, name);
    if (options.collisionGroups !== undefined) this.kernel.columns.colliderGroups[row] = options.collisionGroups;
    if (options.solverGroups !== undefined) this.kernel.columns.colliderSolverGroups[row] = options.solverGroups;
    if (options.sensor || options.enabled === false)
      this.kernel.setColliderState(row, (options.sensor ? COLLIDER_SENSOR : 0) | (options.enabled === false ? COLLIDER_OFF : 0));
    collider.emits = options.events ?? true;
    body.colliders.push(collider);
    this.byRow.set(row, collider);
    return collider;
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
    if (body.mesh) this.byMesh.delete(body.mesh);
    this.kernel.removeBody(body.row);
    body.markRemoved();
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
  /** Not served yet: throws. */
  raycast(): never {
    throw later('raycast', 'queries');
  }
  /** Not served yet: throws. */
  raycastAll(): never {
    throw later('raycastAll', 'queries');
  }
  /** Not served yet: throws. */
  shapeCast(): never {
    throw later('shapeCast', 'queries');
  }
  /** Not served yet: throws. */
  projectPoint(): never {
    throw later('projectPoint', 'queries');
  }
  /** Not served yet: throws. */
  intersectPoint(): never {
    throw later('intersectPoint', 'queries');
  }
  /** Not served yet: throws. */
  intersectShape(): never {
    throw later('intersectShape', 'queries');
  }
  /** Whether two bodies' colliders touch as of the last step. A point still ahead of a moving body does not count. */
  touching(a: PhysicsBody, b: PhysicsBody): boolean {
    for (const contact of this.kernel.contacts()) {
      const one = this.bodyOfCollider(contact.colliderA),
        other = this.bodyOfCollider(contact.colliderB);
      if (((one === a && other === b) || (one === b && other === a)) && contact.points.some(pressing)) return true;
    }
    return false;
  }

  /**
   * Where the solver pushes on this body as of the last step: one world position [x, y, z] per contact point, so a box
   * flat on a floor has its four corners. A point two colliders share comes once for each.
   */
  contactPoints(body: PhysicsBody): [number, number, number][] {
    const points: [number, number, number][] = [];
    for (const contact of this.kernel.contacts())
      if (this.bodyOfCollider(contact.colliderA) === body || this.bodyOfCollider(contact.colliderB) === body)
        for (const point of contact.points) if (pressing(point)) points.push(point.position);
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
