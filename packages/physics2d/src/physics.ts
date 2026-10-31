/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import { Body2D, type BodyOptions2D, type BodyOwner2D, type BodyType2D, type SpriteLike } from './body.js';
import { CharacterController2D, type CharacterOptions2D } from './character.js';
import { Joint2D, createJointData, type JointOptions2D } from './joint.js';
import type {
  Collider2D,
  EventQueue2D,
  KinematicCharacterController2D,
  RapierModule2D,
  World2D,
} from './rapier-types.js';
import { createColliderDesc, type ColliderOptions2D, type ShapeOptions2D, type Vec2D } from './shapes.js';
import { tileMapColliders, type TileMapBodyOptions, type TileMapSource } from './tilemap.js';

/** Options for creating a Physics2D world; every field has a default. */
export interface Physics2DOptions {
  /** The initialized `@dimforge/rapier2d-compat` module. */
  rapier: RapierModule2D;
  /**
   * World2D units per metre (default 32). Rapier works best with bodies between 0.1 and 10 metres, so a 16 pixel tile is
   * half a metre. Positions, sizes, velocities and gravity are in world units; mass, density, force and impulse stay in
   * Rapier units.
   */
  pixelsPerMeter?: number;
  /** World2D units per second squared, y down. Default [0, 9.81 * pixelsPerMeter]. */
  gravity?: Vec2D;
  /** Seconds per physics step (default 1/60). */
  fixedTimestep?: number;
  /** Most steps per frame; extra time is dropped so a slow frame cannot snowball (default 4). */
  maxSubsteps?: number;
  /** Interpolate sprite poses between the last two steps (default true). */
  interpolate?: boolean;
  /** Multiplies frame time, for slow motion (default 1). */
  timeScale?: number;
  /** Start paused (default false). */
  paused?: boolean;
  /** Plugin name (default 'physics2d'). */
  name?: string;
}

/** Kind of collision event: contacts between solids, intersections for sensors. */
export type CollisionEventType2D = 'contactstart' | 'contactend' | 'intersectionstart' | 'intersectionend';
/** Two colliders began or stopped touching. */
export interface CollisionEvent2D {
  type: CollisionEventType2D;
  bodyA: Body2D;
  bodyB: Body2D;
  colliderA: Collider2D;
  colliderB: Collider2D;
  /** True when either collider is a sensor. */
  sensor: boolean;
}
/** Events a Physics2D world emits, keyed by event name. */
export interface Physics2DEventMap {
  contactstart: CollisionEvent2D;
  contactend: CollisionEvent2D;
  intersectionstart: CollisionEvent2D;
  intersectionend: CollisionEvent2D;
  /** Before each fixed step, with the step length. Drive character controllers and kinematic bodies here. */
  beforestep: number;
  afterstep: number;
}

/** Limits which colliders a scene query can hit. */
export interface QueryFilter2D {
  /** Packed interaction groups of the query, see `interactionGroups`. */
  groups?: number;
  /** Ignore this body. */
  exclude?: Body2D;
  excludeSensors?: boolean;
  excludeFixed?: boolean;
  excludeKinematic?: boolean;
  excludeDynamic?: boolean;
  /** Return false to skip a body. */
  predicate?: (body: Body2D, collider: Collider2D) => boolean;
}
/** Options of `raycast`: the filter plus a distance limit. */
export interface RaycastOptions2D extends QueryFilter2D {
  /** World2D units. Default unbounded. */
  maxDistance?: number;
  /** A ray that starts inside a solid hits at distance 0 (default true). */
  solid?: boolean;
}
/** A scene query hit. */
export interface Hit2D {
  body: Body2D;
  sprite: SpriteLike | null;
  collider: Collider2D;
}
/** A ray or shape-cast hit with its point, normal and travelled distance (world units). */
export interface CastHit2D extends Hit2D {
  distance: number;
  point: [number, number];
  normal: [number, number];
}

const noop = (): void => {};
function callListener(this: never, listener: (event: never) => void): void {
  listener(this);
}
const TWO_PI = Math.PI * 2;

/**
 * 2D rigid-body physics on Rapier as a Margo Engine plugin. Steps a fixed timestep with an accumulator and writes
 * interpolated poses to sprites. Y is down, like sprites; angles are radians, clockwise on screen.
 */
export class Physics2D implements EnginePlugin, BodyOwner2D {
  readonly name: string;
  readonly rapier: RapierModule2D;
  /** Metres per world unit. */
  readonly scale: number;
  fixedTimestep: number;
  maxSubsteps: number;
  interpolate: boolean;
  timeScale: number;
  paused: boolean;
  /** Fixed steps taken since creation. */
  stepCount = 0;
  private worldRef: World2D | null;
  private queue: EventQueue2D | null;
  private engine: EngineKernel | null = null;
  private accumulator = 0;
  private lastAlpha = 1;
  private disposed = false;
  private readonly bodies = new Set<Body2D>();
  private readonly byCollider = new Map<number, Body2D>();
  private readonly joints = new Set<Joint2D>();
  private readonly controllers = new Set<CharacterController2D>();
  private readonly listeners = new Map<keyof Physics2DEventMap, Set<(event: never) => void>>();
  private readonly events: CollisionEvent2D[] = [];
  private dispatching = false;
  private syncAlpha = 1;
  private stale = false;

  /** Creates the Physics2D on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options: Physics2DOptions): Physics2D {
    return new Physics2D(engine, options);
  }
  constructor(engine: EngineKernel | null, options: Physics2DOptions) {
    const R = options?.rapier;
    if (!R || typeof R.World !== 'function' || !R.ColliderDesc)
      throw new TypeError(
        'Pass the initialized Rapier 2D module: new Physics2D(engine, {rapier: RAPIER}) after await RAPIER.init()',
      );
    this.rapier = R;
    this.name = options.name ?? 'physics2d';
    const ppm = options.pixelsPerMeter ?? 32;
    if (!(ppm > 0) || !Number.isFinite(ppm)) throw new RangeError('pixelsPerMeter must be a finite number above 0');
    this.scale = 1 / ppm;
    const { fixedTimestep: dt = 1 / 60, maxSubsteps: cap = 4 } = options;
    if (!(dt > 0 && dt <= 1)) throw new RangeError(`fixedTimestep must be in (0, 1] seconds, got ${dt}; try 1/60.`);
    if (!Number.isInteger(cap) || cap < 1)
      throw new RangeError(`maxSubsteps must be a positive integer, got ${cap}; try 4.`);
    this.fixedTimestep = dt;
    this.maxSubsteps = cap;
    this.interpolate = options.interpolate ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.paused = options.paused ?? false;
    const g = options.gravity ?? [0, 9.81 * ppm];
    this.checkVec(g, 'Gravity');
    this.worldRef = new R.World({ x: g[0] * this.scale, y: g[1] * this.scale });
    this.worldRef.timestep = this.fixedTimestep;
    try {
      this.queue = new R.EventQueue(true);
    } catch (error) {
      this.worldRef.free();
      throw error;
    }
    if (engine)
      try {
        engine.use(this);
      } catch (error) {
        this.dispose();
        throw error;
      }
  }
  private checkVec(value: unknown, label: string): asserts value is Vec2D {
    const v = value as ArrayLike<number> | null;
    if (!v || v.length !== 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]))
      throw new TypeError(`${label} must be two finite numbers [x, y]; fix the value.`);
  }

  /** The Rapier `World2D`, in metres. Use it for anything this wrapper does not cover. */
  get world(): World2D {
    if (this.disposed) throw new MargoError('disposed', 'Physics2D is disposed; create a new Physics2D.');
    return this.worldRef as World2D;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  /** World2D units per second squared. */
  get gravity(): [number, number] {
    const g = this.world.gravity;
    return [g.x / this.scale, g.y / this.scale];
  }
  set gravity(value: Vec2D) {
    this.checkVec(value, 'Gravity');
    this.world.gravity = { x: value[0] * this.scale, y: value[1] * this.scale };
    // Rapier leaves sleeping bodies asleep when gravity changes: wake them so they do not float in the old field.
    for (const body of this.bodies) if (body.type === 'dynamic' && body.raw.isSleeping()) body.raw.wakeUp();
  }
  /** Interpolation factor used by the last `update`: leftover time over the step length, 0..1. */
  get alpha(): number {
    return this.lastAlpha;
  }
  get bodyCount(): number {
    return this.bodies.size;
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics2D is disposed; create a new Physics2D.');
    if (this.engine && this.engine !== engine)
      throw new MargoError('attached', 'Physics2D is attached to another engine; create one Physics2D per engine.');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.update(delta);
  }

  /** Advances the accumulator by `delta` seconds, runs whole fixed steps, then writes interpolated poses to sprites. Returns the number of steps. */
  update(delta: number): number {
    if (this.disposed) return 0;
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError(`delta must be a finite, non-negative number of seconds, got ${delta}.`);
    let steps = 0;
    if (!this.paused) {
      const dt = this.fixedTimestep;
      this.accumulator += delta * this.timeScale;
      steps = Math.min(this.maxSubsteps, Math.floor(this.accumulator / dt + 1e-6));
      for (let i = 0; i < steps; i++) this.step();
      // Time past the cap is dropped, so a slow frame cannot snowball into ever more steps.
      this.accumulator = Math.max(0, this.accumulator - steps * dt) % dt;
      this.lastAlpha = this.interpolate ? this.accumulator / dt : 1;
    }
    this.sync();
    return steps;
  }

  /** Runs exactly one fixed step and dispatches its events. Does not touch sprites; call `sync()` to write them. */
  step(): void {
    const world = this.world,
      dt = this.fixedTimestep;
    this.emit('beforestep', dt);
    if (this.disposed) return;
    world.timestep = dt;
    world.step(this.queue as EventQueue2D);
    this.stale = false;
    this.stepCount++;
    for (const body of this.bodies) if (body.type !== 'fixed') body.snapshot();
    const outer = this.dispatching,
      events = outer ? [] : this.events;
    (this.queue as EventQueue2D).drainCollisionEvents((h1, h2, started) => {
      const bodyA = this.byCollider.get(h1),
        bodyB = this.byCollider.get(h2);
      if (!bodyA || !bodyB) return;
      const colliderA = world.getCollider(h1),
        colliderB = world.getCollider(h2),
        sensor = colliderA.isSensor() || colliderB.isSensor();
      events.push({
        type: sensor ? (started ? 'intersectionstart' : 'intersectionend') : started ? 'contactstart' : 'contactend',
        bodyA,
        bodyB,
        colliderA,
        colliderB,
        sensor,
      });
    });
    this.dispatching = true;
    try {
      for (const event of events) this.emit(event.type, event);
    } finally {
      this.dispatching = outer;
      events.length = 0;
    }
    this.emit('afterstep', dt);
  }

  /** Writes body poses to their sprites, interpolated by `alpha` between the last two steps. */
  sync(alpha = this.lastAlpha): void {
    if (this.disposed) return;
    if (!Number.isFinite(alpha))
      throw new RangeError('Interpolation alpha must be a finite number; pass a value from 0 to 1.');
    this.syncAlpha = this.interpolate ? Math.min(1, Math.max(0, alpha)) : 1;
    for (const body of this.bodies) {
      const sprite = body.sprite;
      if (!sprite || (body.type === 'fixed' && !body.dirty)) continue;
      const p = body.pose,
        t = this.syncAlpha;
      sprite.x = p[0] + (p[3] - p[0]) * t;
      sprite.y = p[1] + (p[4] - p[1]) * t;
      // Shortest way round, so a body crossing +-pi does not spin back.
      let turn = (p[5] - p[2]) % TWO_PI;
      if (turn > Math.PI) turn -= TWO_PI;
      else if (turn < -Math.PI) turn += TWO_PI;
      sprite.rotation = p[2] + turn * t;
      body.dirty = false;
    }
  }

  /**
   * Creates a rigid body, optionally driving `sprite`: each frame the interpolated pose is written to the sprite's
   * `x`, `y` and `rotation`. The body starts at the sprite's position.
   */
  addBody(sprite: SpriteLike | null, options: BodyOptions2D = {}): Body2D {
    const R = this.rapier,
      type: BodyType2D = options.type ?? 'dynamic',
      k = this.scale;
    const factory = {
      dynamic: R.RigidBodyDesc.dynamic,
      fixed: R.RigidBodyDesc.fixed,
      kinematicPosition: R.RigidBodyDesc.kinematicPositionBased,
      kinematicVelocity: R.RigidBodyDesc.kinematicVelocityBased,
    }[type];
    if (!factory)
      throw new TypeError(`Unknown body type "${type}"; use dynamic, fixed, kinematicPosition or kinematicVelocity.`);
    const position = options.position ?? [sprite?.x ?? 0, sprite?.y ?? 0];
    this.checkVec(position, 'Body position');
    const rotation = options.rotation ?? sprite?.rotation ?? 0;
    if (!Number.isFinite(rotation)) throw new RangeError('Body rotation must be a finite number of radians');
    const desc = factory
      .call(R.RigidBodyDesc)
      .setTranslation(position[0] * k, position[1] * k)
      .setRotation(rotation);
    if (options.linearVelocity) desc.setLinvel(options.linearVelocity[0] * k, options.linearVelocity[1] * k);
    if (options.angularVelocity !== undefined) desc.setAngvel(options.angularVelocity);
    if (options.linearDamping !== undefined) desc.setLinearDamping(options.linearDamping);
    if (options.angularDamping !== undefined) desc.setAngularDamping(options.angularDamping);
    if (options.gravityScale !== undefined) desc.setGravityScale(options.gravityScale);
    if (options.ccd) desc.setCcdEnabled(true);
    if (options.canSleep !== undefined) desc.setCanSleep(options.canSleep);
    if (options.lockRotation) desc.lockRotations();
    const body = new Body2D(this, this.world.createRigidBody(desc), sprite, type);
    body.userData = options.userData;
    this.bodies.add(body);
    try {
      let colliders = options.colliders;
      if (colliders === undefined) colliders = fitBox(sprite);
      for (const c of Array.isArray(colliders) ? colliders : colliders ? [colliders as ColliderOptions2D] : [])
        this.addCollider(body, c);
    } catch (error) {
      this.removeBody(body);
      throw error;
    }
    return body;
  }

  /**
   * One fixed body holding the collision of a tile map: tiles with collision shapes (or a `solid: true` property) in
   * the chosen layers. Whole-cell squares merge into outline loops, so a body slides over neighbouring tiles without
   * catching on the seams. The map's top left sits at `options.position`.
   */
  addTileMap(map: TileMapSource, options: TileMapBodyOptions = {}): Body2D {
    const body = this.addBody(null, { type: 'fixed', colliders: [], userData: options.userData });
    try {
      for (const c of tileMapColliders(map, options)) this.addCollider(body, c);
    } catch (error) {
      this.removeBody(body);
      throw error;
    }
    return body;
  }

  /** @internal */
  addCollider(body: Body2D, options: ColliderOptions2D): Collider2D {
    const collider = this.world.createCollider(createColliderDesc(this.rapier, options, this.scale), body.raw);
    this.stale = true;
    body.colliders.push(collider);
    this.byCollider.set(collider.handle, body);
    return collider;
  }
  removeBody(body: Body2D): void {
    if (!this.bodies.has(body)) return;
    for (const joint of [...this.joints]) if (joint.bodyA === body || joint.bodyB === body) this.removeJoint(joint);
    for (const controller of [...this.controllers]) if (controller.body === body) controller.dispose();
    for (const collider of body.colliders) this.byCollider.delete(collider.handle);
    this.bodies.delete(body);
    this.world.removeRigidBody(body.raw);
    this.stale = true;
    body.markRemoved();
  }

  /** Joins two bodies. Anchors are in each body's local space, world units. */
  addJoint(bodyA: Body2D, bodyB: Body2D, options: JointOptions2D): Joint2D {
    if (!this.bodies.has(bodyA) || !this.bodies.has(bodyB))
      throw new MargoError('state', 'Both joint bodies must belong to this Physics2D and not be removed.');
    const raw = this.world.createImpulseJoint(
      createJointData(this.rapier, options, this.scale),
      bodyA.raw,
      bodyB.raw,
      true,
    );
    raw.setContactsEnabled(options.collide === true);
    const unit = options.type === 'prismatic' ? this.scale : 1;
    const joint = new Joint2D(this.world, raw, bodyA, bodyB, unit, (j) => this.removeJoint(j));
    this.joints.add(joint);
    if ((options.type === 'revolute' || options.type === 'prismatic') && options.limits)
      joint.setLimits(options.limits[0], options.limits[1]);
    if ((options.type === 'revolute' || options.type === 'prismatic') && options.motor) joint.setMotor(options.motor);
    return joint;
  }
  removeJoint(joint: Joint2D): void {
    if (!this.joints.delete(joint)) return;
    joint.free();
  }

  /** A character controller for a kinematic position body that has a collider. */
  createCharacterController(body: Body2D, options: CharacterOptions2D = {}): CharacterController2D {
    if (body.type !== 'kinematicPosition')
      throw new TypeError(
        "Character bodies must be 'kinematicPosition'; add the body with {type: 'kinematicPosition'}.",
      );
    const k = this.scale,
      raw: KinematicCharacterController2D = this.world.createCharacterController((options.offset ?? 0.5) * k),
      up = options.up ?? [0, -1];
    raw.setUp({ x: up[0], y: up[1] });
    raw.setMaxSlopeClimbAngle(options.maxSlopeClimbAngle ?? Math.PI / 4);
    raw.setMinSlopeSlideAngle(options.minSlopeSlideAngle ?? Math.PI / 6);
    if (options.autostep)
      raw.enableAutostep(
        options.autostep.maxHeight * k,
        options.autostep.minWidth * k,
        options.autostep.includeDynamic ?? false,
      );
    if (options.snapToGround !== undefined) raw.enableSnapToGround(options.snapToGround * k);
    raw.setSlideEnabled(options.slide ?? true);
    if (options.pushDynamic) {
      raw.setApplyImpulsesToDynamicBodies(true);
      if (options.mass !== undefined) raw.setCharacterMass(options.mass);
    }
    const controller = new CharacterController2D(
      this.world,
      raw,
      body,
      k,
      (c) => this.controllers.delete(c),
      () => this.refresh(),
    );
    this.controllers.add(controller);
    return controller;
  }

  /**
   * @internal Rapier answers queries from its broad phase, which only a step updates, so a collider added since the last
   * step would be invisible. A zero-length step brings it up to date without moving anything or raising events.
   */
  refresh(): void {
    if (!this.stale) return;
    const world = this.world;
    world.timestep = 0;
    world.step();
    world.timestep = this.fixedTimestep;
    this.stale = false;
  }
  /** @internal */
  markStale(): void {
    this.stale = true;
  }
  private filter(
    f: QueryFilter2D = {},
  ): [number, number | undefined, undefined, undefined, ((c: Collider2D) => boolean) | undefined] {
    const Q = this.rapier.QueryFilterFlags;
    const flags =
      (f.excludeSensors ? Q.EXCLUDE_SENSORS : 0) |
      (f.excludeFixed ? Q.EXCLUDE_FIXED : 0) |
      (f.excludeKinematic ? Q.EXCLUDE_KINEMATIC : 0) |
      (f.excludeDynamic ? Q.EXCLUDE_DYNAMIC : 0);
    const { exclude, predicate } = f;
    const test =
      exclude || predicate
        ? (c: Collider2D): boolean => {
            const body = this.byCollider.get(c.handle);
            return !!body && body !== exclude && (!predicate || predicate(body, c) !== false);
          }
        : undefined;
    return [flags, f.groups, undefined, undefined, test];
  }
  private hit(collider: Collider2D): Hit2D | null {
    const body = this.byCollider.get(collider.handle);
    return body ? { body, sprite: body.sprite, collider } : null;
  }

  /** First collider along a ray from `origin` in `direction` (any length), or null. */
  raycast(origin: Vec2D, direction: Vec2D, options: RaycastOptions2D = {}): CastHit2D | null {
    this.refresh();
    this.checkVec(origin, 'Ray2D origin');
    this.checkVec(direction, 'Ray2D direction');
    const length = Math.hypot(direction[0], direction[1]);
    if (!(length > 0)) throw new RangeError('Ray2D direction must not be zero; pass a direction such as [0, 1].');
    const k = this.scale,
      dx = direction[0] / length,
      dy = direction[1] / length;
    const ray = new this.rapier.Ray({ x: origin[0] * k, y: origin[1] * k }, { x: dx, y: dy });
    const hit = this.world.castRayAndGetNormal(
      ray,
      (options.maxDistance ?? 1e9) * k,
      options.solid ?? true,
      ...this.filter(options),
    );
    const base = hit && this.hit(hit.collider);
    if (!hit || !base) return null;
    const d = hit.timeOfImpact;
    return {
      ...base,
      distance: d / k,
      point: [origin[0] + dx * (d / k), origin[1] + dy * (d / k)],
      normal: [hit.normal.x, hit.normal.y],
    };
  }

  /** The bodies with a collider containing `point`. */
  overlapPoint(point: Vec2D, filter?: QueryFilter2D): Body2D[] {
    this.refresh();
    this.checkVec(point, 'Point');
    const found = new Set<Body2D>();
    this.world.intersectionsWithPoint(
      { x: point[0] * this.scale, y: point[1] * this.scale },
      (c) => {
        const h = this.hit(c);
        if (h) found.add(h.body);
        return true;
      },
      ...this.filter(filter),
    );
    return [...found];
  }

  /** The bodies with a collider overlapping `shape` (a box, circle, capsule or polygon) placed at `position`. */
  overlapShape(shape: ShapeOptions2D, position: Vec2D, rotation = 0, filter?: QueryFilter2D): Body2D[] {
    this.refresh();
    this.checkVec(position, 'Shape2D position');
    const found = new Set<Body2D>();
    this.world.intersectionsWithShape(
      { x: position[0] * this.scale, y: position[1] * this.scale },
      rotation,
      createColliderDesc(this.rapier, shape, this.scale).shape,
      (c) => {
        const h = this.hit(c);
        if (h) found.add(h.body);
        return true;
      },
      ...this.filter(filter),
    );
    return [...found];
  }

  /** Slides `shape` from `position` along `direction` for up to `maxDistance` and reports the first collider it meets. */
  castShape(
    shape: ShapeOptions2D,
    position: Vec2D,
    direction: Vec2D,
    maxDistance: number,
    filter?: QueryFilter2D,
  ): CastHit2D | null {
    this.refresh();
    this.checkVec(position, 'Shape2D position');
    this.checkVec(direction, 'Shape2D direction');
    const length = Math.hypot(direction[0], direction[1]);
    if (!(length > 0)) throw new RangeError('Shape2D direction must not be zero; pass a direction such as [0, 1].');
    const k = this.scale,
      dx = direction[0] / length,
      dy = direction[1] / length;
    const hit = this.world.castShape(
      { x: position[0] * k, y: position[1] * k },
      0,
      { x: dx, y: dy },
      createColliderDesc(this.rapier, shape, k).shape,
      0,
      maxDistance * k,
      true,
      ...this.filter(filter),
    );
    const base = hit && this.hit(hit.collider);
    if (!hit || !base) return null;
    return {
      ...base,
      distance: hit.time_of_impact / k,
      point: [hit.witness1.x / k, hit.witness1.y / k],
      normal: [hit.normal1.x, hit.normal1.y],
    };
  }

  /** Adds a listener; returns a function that removes it. */
  on<K extends keyof Physics2DEventMap>(type: K, listener: (event: Physics2DEventMap[K]) => void): () => void {
    if (this.disposed) return noop;
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const own = set;
    own.add(listener as (event: never) => void);
    return () => {
      own.delete(listener as (event: never) => void);
    };
  }
  private emit<K extends keyof Physics2DEventMap>(type: K, event: Physics2DEventMap[K]): void {
    this.listeners.get(type)?.forEach(callListener, event);
  }

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
    for (const controller of [...this.controllers]) controller.dispose();
    for (const joint of [...this.joints]) this.removeJoint(joint);
    for (const body of [...this.bodies]) this.removeBody(body);
    this.listeners.clear();
    (this.queue as EventQueue2D).free();
    (this.worldRef as World2D).free();
    this.disposed = true;
    this.engine = null;
    this.queue = this.worldRef = null;
  }
  declare [Symbol.dispose]: () => void;
}
Physics2D.prototype[Symbol.dispose] = Physics2D.prototype.dispose;

function fitBox(sprite: SpriteLike | null): ColliderOptions2D | undefined {
  if (!sprite?.rect) return undefined;
  const w = Math.abs(sprite.rect[2] * (sprite.scaleX ?? 1)),
    h = Math.abs(sprite.rect[3] * (sprite.scaleY ?? 1));
  if (!(w > 0 && h > 0)) return undefined;
  return {
    shape: 'box',
    width: w,
    height: h,
    offset: [(0.5 - (sprite.pivotX ?? 0)) * w, (0.5 - (sprite.pivotY ?? 0)) * h],
  };
}
