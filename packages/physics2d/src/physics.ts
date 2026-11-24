/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import { SharedLoad } from '../../shared/shared-load.js';
import type { Kernel, KernelWasmSource } from './kernel.js';
import { Body2D, Collider2D, type BodyOptions2D, type BodyOwner2D, type BodyType2D, type SpriteLike } from './body.js';
import { CharacterController2D, type CharacterOptions2D } from './character.js';
import { Joint2D, writeJoint, type JointOptions2D } from './joint.js';
import { describeShape, describeShapes, type ColliderOptions2D, type Described, type ShapeOptions2D, type Vec2D } from './shapes.js';
import { tileMapColliders, type TileMapBodyOptions, type TileMapSource } from './tilemap.js';

/** Options of {@link Physics2D.load}. */
export interface Physics2DLoadOptions {
  /**
   * Stops this call's wait. When no other call is waiting on the same load, it also cancels the download, and the next
   * call starts again.
   */
  signal?: AbortSignal;
  /**
   * Where the kernel's Wasm comes from: a URL (a CDN or your own server), a fetched `Response`, its bytes or a compiled
   * `WebAssembly.Module`. Default: `dist/physics2d.wasm` beside this package, which bundlers emit as its own file. It must
   * be the build this package bundles. Calls made while a load runs share that load.
   */
  wasm?: KernelWasmSource;
}

export type { KernelWasmSource };

/** Options for creating a Physics2D world; every field has a default. */
export interface Physics2DOptions {
  /**
   * World units per metre (default 32). The solver works best with bodies between 0.1 and 10 metres, so a 16 pixel tile
   * is half a metre. Positions, sizes, velocities and gravity are in world units; mass, density, force and impulse stay
   * in kernel units (kilograms, metres, seconds).
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
/** A contact pushed with more total force than a collider's `contactForceThreshold` in the last step. */
export interface ContactForceEvent2D {
  bodyA: Body2D;
  bodyB: Body2D;
  colliderA: Collider2D;
  colliderB: Collider2D;
  /** Total force over the step, newtons. */
  force: number;
  /** Contact normal from A to B. */
  normal: [number, number];
}
/** Events a Physics2D world emits, keyed by event name. */
export interface Physics2DEventMap {
  contactstart: CollisionEvent2D;
  contactend: CollisionEvent2D;
  intersectionstart: CollisionEvent2D;
  intersectionend: CollisionEvent2D;
  /** A contact pushed past a force threshold (see `contactForceThreshold`). */
  contactforce: ContactForceEvent2D;
  /** Before each fixed step, with the step length. Drive character controllers and kinematic bodies here. */
  beforestep: number;
  afterstep: number;
}

/** A closest point of a collider to a point. */
export interface ProjectedPoint2D extends Hit2D {
  /** The closest point of the collider (the query point itself when it is inside). */
  point: [number, number];
  inside: boolean;
  /** World units; 0 inside. */
  distance: number;
}
/** One contact of a collider as the world holds it. */
export interface ContactPair2D {
  collider: Collider2D;
  other: Collider2D;
  /** From `collider` to `other`. */
  normal: [number, number];
  points: Array<{ point: [number, number]; distance: number }>;
  impulse: number;
  solverActive: boolean;
  touching: boolean;
}

/** What a `modifyContact` hook sees of a touching contact and may change for the step. */
export interface ContactChange2D {
  readonly colliderA: Collider2D;
  readonly colliderB: Collider2D;
  /** The contact normal from A to B. */
  readonly normal: [number, number];
  /** Contact points in the manifold (1 or 2). */
  readonly points: number;
  /** Set false to let the bodies through each other this step (events still fire). Default true. */
  solverActive: boolean;
  /** Replaces the colliders' combined friction. */
  friction?: number;
  /** Replaces the colliders' combined restitution. */
  restitution?: number;
  /** A direction the contact lets bodies through from: it pushes only while the normal has a positive part along it. */
  oneWay?: Vec2D;
}
/** Code the world asks about pairs of colliders that have `hooks` set; it must be fast and must not change the world. */
export interface Physics2DHooks {
  /** Whether the pair may meet at all; false removes the contact and its events. */
  filterPair?(colliderA: Collider2D, colliderB: Collider2D): boolean;
  /** Changes a touching contact for this step: one-way platforms, conveyors' friction, sticky or slippery pairs. */
  modifyContact?(change: ContactChange2D): void;
}

/** Lines that draw a world: four numbers a line, and a colour code a line. */
export interface DebugLines2D {
  vertices: Float32Array;
  colors: Uint8Array;
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
const NONE = 0xffffffff;

// The kernel `Physics2D.load` loaded, shared by every world of the app. Calls during a load share it; the download is
// cancelled when every call waiting on it has been aborted.
const solver = new SharedLoad<Kernel, KernelWasmSource | undefined>((wasm, signal) =>
  import('./kernel.js').then((chunk) => chunk.startKernel(wasm ?? chunk.defaultWasm(), signal)),
);

const BODY_KIND: Record<BodyType2D, number> = { dynamic: 0, fixed: 1, kinematicPosition: 2, kinematicVelocity: 2 };

/**
 * 2D rigid-body physics on Margo's own 2D kernel as a Margo Engine plugin. Steps a fixed timestep with an accumulator
 * and writes interpolated poses to sprites. Y is down, like sprites; angles are radians, clockwise on screen.
 */
export class Physics2D implements EnginePlugin, BodyOwner2D {
  readonly name: string;
  /** Metres per world unit. */
  readonly scale: number;
  fixedTimestep: number;
  maxSubsteps: number;
  interpolate: boolean;
  timeScale: number;
  paused: boolean;
  /** Fixed steps taken since creation. */
  stepCount = 0;
  /** The kernel and this world's handle in it. @internal */
  readonly kernel: Kernel;
  /** @internal */
  handle: number;
  private engine: EngineKernel | null = null;
  private accumulator = 0;
  private lastAlpha = 1;
  private disposed = false;
  private readonly bodies = new Set<Body2D>();
  private movers: Body2D[] | null = null;
  private readonly byShape = new Map<number, Collider2D>();
  private readonly joints = new Set<Joint2D>();
  private readonly controllers = new Set<CharacterController2D>();
  private readonly listeners = new Map<keyof Physics2DEventMap, Set<(event: never) => void>>();
  private readonly events: Array<[keyof Physics2DEventMap, unknown]> = [];
  private dispatching = false;
  private syncAlpha = 1;
  private gravityValue: [number, number];

  /**
   * Gets the kernel ready, once per app: compiling it is asynchronous, so `new Physics2D(engine)` can stay synchronous.
   * Later calls resolve at once, calls made during a load share it, and a failed load is tried again by the next call.
   * The kernel's Wasm is a file of its own (`dist/physics2d.wasm`), fetched and compiled while it downloads; `wasm`
   * points at another copy.
   * @example await Physics2D.load();
   * const physics = new Physics2D(engine);
   * @throws AbortError (the signal's reason) when `signal` aborts first.
   * @throws MargoError (`failed`) when the Wasm cannot be fetched or is not this package's build.
   */
  static async load({ signal, wasm }: Physics2DLoadOptions = {}): Promise<void> {
    await solver.load(wasm, signal);
  }
  /** Creates the Physics2D on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options: Physics2DOptions = {}): Physics2D {
    return new Physics2D(engine, options);
  }
  /** @throws MargoError (`state`) before {@link Physics2D.load} has finished. */
  constructor(engine: EngineKernel | null, options: Physics2DOptions = {}) {
    const kernel = solver.value;
    if (!kernel) throw new MargoError('state', 'Physics2D is not loaded; call await Physics2D.load() once before new Physics2D().');
    this.kernel = kernel;
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
    this.gravityValue = [g[0], g[1]];
    this.handle = kernel.ok(kernel.exports.world_create(g[0] * this.scale, g[1] * this.scale));
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
  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics2D is disposed; create a new Physics2D.');
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
  /** World units per second squared. */
  get gravity(): [number, number] {
    return [this.gravityValue[0], this.gravityValue[1]];
  }
  set gravity(value: Vec2D) {
    this.live();
    this.checkVec(value, 'Gravity');
    // The kernel wakes sleeping bodies, so they do not float in the old field.
    this.kernel.ok(this.kernel.exports.world_set_gravity(this.handle, value[0] * this.scale, value[1] * this.scale));
    this.gravityValue = [value[0], value[1]];
  }
  /** Interpolation factor used by the last `update`: leftover time over the step length, 0..1. */
  get alpha(): number {
    return this.lastAlpha;
  }
  get bodyCount(): number {
    return this.bodies.size;
  }

  setup(engine: EngineKernel): void {
    this.live();
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
    this.live();
    const dt = this.fixedTimestep;
    this.emit('beforestep', dt);
    if (this.disposed) return;
    const { kernel } = this;
    if (this.hookSet) this.installHooks();
    try {
      kernel.ok(kernel.exports.world_step(this.handle, dt));
    } finally {
      kernel.hooks = null;
    }
    this.stepCount++;
    this.readPoses();
    const outer = this.dispatching,
      events = outer ? [] : this.events;
    this.collectEvents(events);
    this.dispatching = true;
    try {
      for (const [type, event] of events) this.emit(type, event as never);
    } finally {
      this.dispatching = outer;
      events.length = 0;
    }
    this.emit('afterstep', dt);
  }

  /** Reads every moving body's pose in one call. */
  private readPoses(): void {
    const movers = (this.movers ??= [...this.bodies].filter((b) => b.type !== 'fixed'));
    const n = movers.length;
    if (!n) return;
    const { kernel } = this;
    const io = kernel.io(5 * n);
    for (let i = 0; i < n; i++) io.u[i] = movers[i].handle;
    kernel.ok(kernel.exports.body_read_poses(this.handle, n));
    const out = kernel.io(5 * n).f;
    const k = 1 / this.scale;
    for (let i = 0; i < n; i++) movers[i].store(out[n + 4 * i], out[n + 4 * i + 1], out[n + 4 * i + 2], out[n + 4 * i + 3], k);
  }

  private collectEvents(into: Array<[keyof Physics2DEventMap, unknown]>): void {
    const { kernel } = this;
    const count = kernel.ok(kernel.exports.events_read(this.handle));
    if (count) {
      const u = kernel.io(3 * count).u;
      for (let i = 0; i < count; i++) {
        const colliderA = this.byShape.get(u[3 * i]),
          colliderB = this.byShape.get(u[3 * i + 1]);
        if (!colliderA || !colliderB) continue;
        const flags = u[3 * i + 2],
          started = (flags & 3) === 1,
          sensor = (flags & 4) !== 0;
        into.push([
          sensor ? (started ? 'intersectionstart' : 'intersectionend') : started ? 'contactstart' : 'contactend',
          { type: sensor ? (started ? 'intersectionstart' : 'intersectionend') : started ? 'contactstart' : 'contactend', bodyA: colliderA.body, bodyB: colliderB.body, colliderA, colliderB, sensor },
        ]);
      }
    }
    const forces = kernel.ok(kernel.exports.force_events_read(this.handle));
    if (forces) {
      const io = kernel.io(5 * forces);
      for (let i = 0; i < forces; i++) {
        const colliderA = this.byShape.get(io.u[5 * i]),
          colliderB = this.byShape.get(io.u[5 * i + 1]);
        if (!colliderA || !colliderB) continue;
        into.push([
          'contactforce',
          { bodyA: colliderA.body, bodyB: colliderB.body, colliderA, colliderB, force: io.f[5 * i + 2], normal: [io.f[5 * i + 3], io.f[5 * i + 4]] },
        ]);
      }
    }
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
    this.live();
    const type: BodyType2D = options.type ?? 'dynamic',
      k = this.scale;
    if (!(type in BODY_KIND))
      throw new TypeError(`Unknown body type "${type}"; use dynamic, fixed, kinematicPosition or kinematicVelocity.`);
    const position = options.position ?? [sprite?.x ?? 0, sprite?.y ?? 0];
    this.checkVec(position, 'Body position');
    const rotation = options.rotation ?? sprite?.rotation ?? 0;
    if (!Number.isFinite(rotation)) throw new RangeError('Body rotation must be a finite number of radians');
    const lv = options.linearVelocity ?? [0, 0];
    this.checkVec(lv, 'linearVelocity');
    const dominance = options.dominance ?? 0;
    if (!Number.isInteger(dominance) || dominance < -127 || dominance > 127)
      throw new RangeError(`dominance must be an integer from -127 to 127, got ${dominance}.`);
    const io = this.kernel.io(16);
    io.f.set(
      [
        position[0] * k,
        position[1] * k,
        Math.cos(rotation),
        Math.sin(rotation),
        lv[0] * k,
        lv[1] * k,
        options.angularVelocity ?? 0,
        options.linearDamping ?? 0,
        options.angularDamping ?? 0,
        options.gravityScale ?? 1,
      ],
      0,
    );
    new Int32Array(io.u.buffer, io.u.byteOffset, 16)[10] = dominance;
    const flags = (options.canSleep ?? true ? 1 : 0) | (options.lockRotation ? 2 : 0) | (options.ccd ? 4 : 0);
    const handle = this.kernel.ok(this.kernel.exports.body_create(this.handle, BODY_KIND[type], flags));
    const body = new Body2D(this, handle, sprite, type);
    body.userData = options.userData;
    body.params = {
      linearDamping: options.linearDamping ?? 0,
      angularDamping: options.angularDamping ?? 0,
      gravityScale: options.gravityScale ?? 1,
      canSleep: options.canSleep ?? true,
      ccd: options.ccd === true,
      dominance,
    };
    if (options.lockTranslation) {
      const lock = options.lockTranslation === true ? [true, true] : options.lockTranslation;
      try {
        body.lockTranslation(lock[0], lock[1]);
      } catch (error) {
        this.kernel.exports.body_remove(this.handle, handle);
        this.bodies.delete(body);
        throw error;
      }
    }
    if (options.softCcd) {
      try {
        body.softCcd = options.softCcd;
      } catch (error) {
        this.removeBody(body);
        throw error;
      }
    }
    if (options.additionalMass) {
      try {
        body.additionalMass = options.additionalMass;
      } catch (error) {
        this.kernel.exports.body_remove(this.handle, handle);
        throw error;
      }
    }
    this.bodies.add(body);
    this.movers = null;
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
    this.live();
    const parts = describeShapes(options, this.scale);
    const ids: number[] = [];
    try {
      for (const d of parts) ids.push(...this.createShapes(body, d));
    } catch (error) {
      for (const id of ids) this.kernel.exports.shape_remove(this.handle, id);
      throw error;
    }
    const settings = Uint32Array.from(parts[0].settings);
    const collider = new Collider2D(this, body, ids, settings, options.offset ?? [0, 0], options.rotation ?? 0);
    collider.described = parts[0];
    for (const id of ids) this.byShape.set(id, collider);
    body.colliders.push(collider);
    return collider;
  }
  private createShapes(body: Body2D, d: Described): number[] {
    const { kernel } = this;
    const io = kernel.io(8 + d.geometry.length);
    io.u.set(d.settings, 0);
    io.u.set(d.geometry, 8);
    const count = kernel.ok(kernel.exports.shape_create(this.handle, body.handle, d.kind));
    return Array.from(kernel.io(count).u.subarray(0, count));
  }
  /** @internal */
  removeCollider(collider: Collider2D): void {
    if (collider.isRemoved) return;
    for (const id of collider.shapes) {
      this.byShape.delete(id);
      this.kernel.exports.shape_remove(this.handle, id);
    }
    collider.markRemoved();
    const list = collider.body.colliders;
    list.splice(list.indexOf(collider), 1);
  }
  removeBody(body: Body2D): void {
    if (!this.bodies.has(body)) return;
    for (const joint of [...this.joints]) if (joint.bodyA === body || joint.bodyB === body) this.removeJoint(joint);
    for (const controller of [...this.controllers]) if (controller.body === body) controller.dispose();
    for (const collider of body.colliders) {
      for (const id of collider.shapes) this.byShape.delete(id);
      collider.markRemoved();
    }
    body.colliders.length = 0;
    this.bodies.delete(body);
    this.movers = null;
    this.kernel.exports.body_remove(this.handle, body.handle);
    body.markRemoved();
  }

  /** The hooks asked about colliders that set `hooks` (see {@link Physics2DHooks}); null for none. */
  get hooks(): Physics2DHooks | null {
    return this.hookSet;
  }
  set hooks(value: Physics2DHooks | null) {
    this.live();
    this.hookSet = value;
    const { kernel } = this;
    kernel.ok(kernel.exports.world_set_hooks(this.handle, value ? 1 : 0));
    this.installHooks();
  }
  private hookSet: Physics2DHooks | null = null;
  /** Points the kernel's page hooks at this world, for the length of a step. */
  private installHooks(): void {
    this.kernel.hooks = this.hookSet
      ? {
          filter: (a, b) => {
            const ca = this.byShape.get(a),
              cb = this.byShape.get(b);
            return !ca || !cb || !this.hookSet?.filterPair || this.hookSet.filterPair(ca, cb) !== false;
          },
          contact: (a, b, nx, ny, points) => {
            const ca = this.byShape.get(a),
              cb = this.byShape.get(b);
            if (!ca || !cb || !this.hookSet?.modifyContact) return 0;
            const change: ContactChange2D = { colliderA: ca, colliderB: cb, normal: [nx, ny], points, solverActive: true };
            this.hookSet.modifyContact(change);
            let bits = change.solverActive ? 0 : 1;
            const io = this.kernel.current(4);
            if (change.friction !== undefined) {
              io.f[0] = change.friction;
              bits |= 2;
            }
            if (change.restitution !== undefined) {
              io.f[1] = change.restitution;
              bits |= 4;
            }
            if (change.oneWay) {
              io.f[2] = change.oneWay[0];
              io.f[3] = change.oneWay[1];
              bits |= 8;
            }
            return bits;
          },
        }
      : null;
  }

  /** @internal */
  retype(body: Body2D, type: BodyType2D): void {
    this.live();
    if (!(type in BODY_KIND))
      throw new TypeError(`Unknown body type "${type}"; use dynamic, fixed, kinematicPosition or kinematicVelocity.`);
    this.kernel.ok(this.kernel.exports.body_set_kind(this.handle, body.handle, BODY_KIND[type]));
    this.movers = null;
    body.snapshot();
    body.pose.copyWithin(0, 3, 6);
  }

  /** The closest collider to `point`, its closest point and whether `point` is inside it (distance 0), or null. */
  projectPoint(point: Vec2D, filter?: QueryFilter2D): ProjectedPoint2D | null {
    this.live();
    this.checkVec(point, 'Point');
    const k = this.scale;
    this.writeFilter(filter);
    this.kernel.io(8).f.set([point[0] * k, point[1] * k], 4);
    const count = this.kernel.ok(this.kernel.exports.project_point(this.handle));
    const out = this.kernel.io(5 * count);
    for (let i = 0; i < count; i++) {
      const base = this.hitOf(out.u[5 * i], filter);
      if (base) return { ...base, point: [out.f[5 * i + 1] / k, out.f[5 * i + 2] / k], inside: out.u[5 * i + 4] !== 0, distance: out.f[5 * i + 3] / k };
    }
    return null;
  }

  /** The bodies with a collider whose bounds meet the box from `min` to `max` (world units). */
  intersectionsWithBox(min: Vec2D, max: Vec2D, filter?: QueryFilter2D): Body2D[] {
    this.live();
    this.checkVec(min, 'Box min');
    this.checkVec(max, 'Box max');
    this.writeFilter(filter);
    const k = this.scale;
    this.kernel.io(8).f.set([min[0] * k, min[1] * k, max[0] * k, max[1] * k], 4);
    const count = this.kernel.ok(this.kernel.exports.aabb_query(this.handle));
    return this.bodiesOf(this.kernel.io(count).u, count, filter);
  }

  /**
   * The contacts the world holds for a collider as of the last step: each with the other collider, the contact normal
   * from `collider` to it, up to two points with their separation (negative: overlapping), the normal impulse of the
   * last substep and whether it pushes (`solverActive`; false for sensors and ignored solver groups) and touches.
   */
  contactPairs(collider: Collider2D): ContactPair2D[] {
    this.live();
    if (collider.isRemoved) throw new MargoError('state', 'Collider2D was removed; ask for the contacts of a live collider.');
    const out: ContactPair2D[] = [];
    const k = 1 / this.scale;
    for (const shape of collider.shapes) {
      const count = this.kernel.ok(this.kernel.exports.contacts_of(this.handle, shape));
      const { f, u } = this.kernel.io(11 * count);
      for (let i = 0; i < count; i++) {
        const other = this.byShape.get(u[11 * i]);
        if (!other) continue;
        const flags = u[11 * i + 1],
          n = flags >> 2;
        const points: Array<{ point: [number, number]; distance: number }> = [];
        for (let j = 0; j < n; j++)
          points.push({ point: [f[11 * i + 4 + 3 * j] * k, f[11 * i + 5 + 3 * j] * k], distance: f[11 * i + 6 + 3 * j] * k });
        out.push({
          collider,
          other,
          normal: [f[11 * i + 2], f[11 * i + 3]],
          points,
          impulse: f[11 * i + 10],
          solverActive: (flags & 1) !== 0,
          touching: (flags & 2) !== 0,
        });
      }
    }
    return out;
  }

  /** @internal Holds `body` at its position on the axes picked, with a generic joint to a fixed body no one sees. */
  lockTranslation(body: Body2D, x: boolean, y: boolean): void {
    this.live();
    const { kernel } = this;
    if (body.lockJoint >= 0) {
      kernel.exports.joint_remove(this.handle, body.lockJoint);
      body.lockJoint = -1;
    }
    if (!x && !y) return;
    if (this.anchor < 0) {
      const io = kernel.io(16);
      io.u.fill(0, 0, 16);
      io.f.set([0, 0, 1, 0], 0);
      io.f[9] = 1;
      this.anchor = kernel.ok(kernel.exports.body_create(this.handle, 1, 1));
    }
    kernel.ok(kernel.exports.body_read(this.handle, body.handle));
    const at = kernel.io(11).f;
    const [px, py] = [at[0], at[1]];
    const io = kernel.io(32);
    io.u.fill(0, 0, 32);
    io.u[0] = 5;
    io.f.set([px, py, 0, 0], 1);
    io.f.set([1, 0, 1, 0], 16);
    io.u[24] = (x ? 1 : 0) | (y ? 2 : 0);
    body.lockJoint = kernel.ok(kernel.exports.joint_create(this.handle, this.anchor, body.handle, 0));
  }
  private anchor = -1;

  /** Joins two bodies. Anchors are in each body's local space, world units. */
  addJoint(bodyA: Body2D, bodyB: Body2D, options: JointOptions2D): Joint2D {
    this.live();
    if (!this.bodies.has(bodyA) || !this.bodies.has(bodyB))
      throw new MargoError('state', 'Both joint bodies must belong to this Physics2D and not be removed.');
    const unit = writeJoint(this.kernel, options, this.scale);
    const handle = this.kernel.ok(
      this.kernel.exports.joint_create(this.handle, bodyA.handle, bodyB.handle, options.collide === true ? 1 : 0),
    );
    const joint = new Joint2D(this.kernel, this.handle, handle, bodyA, bodyB, options.type, unit, (j) => this.removeJoint(j));
    this.joints.add(joint);
    return joint;
  }
  removeJoint(joint: Joint2D): void {
    if (!this.joints.delete(joint)) return;
    joint.free();
  }

  /** A character controller for a kinematic position body that has a collider. */
  createCharacterController(body: Body2D, options: CharacterOptions2D = {}): CharacterController2D {
    this.live();
    if (body.type !== 'kinematicPosition')
      throw new TypeError(
        "Character bodies must be 'kinematicPosition'; add the body with {type: 'kinematicPosition'}.",
      );
    const controller = new CharacterController2D(this, body, options, (c) => this.controllers.delete(c));
    this.controllers.add(controller);
    return controller;
  }

  /** @internal The kernel's query filter words for `filter`, written at word 0 of the buffer. */
  writeFilter(f: QueryFilter2D = {}): void {
    const io = this.kernel.io(4);
    io.u[0] = f.groups ?? 0xffffffff;
    io.u[1] = (f.excludeSensors ? 1 : 0) | (f.excludeFixed ? 2 : 0) | (f.excludeKinematic ? 4 : 0) | (f.excludeDynamic ? 8 : 0);
    io.u[2] = NONE;
    io.u[3] = f.exclude && this.bodies.has(f.exclude) ? f.exclude.handle : NONE;
  }
  private hitOf(shape: number, filter: QueryFilter2D | undefined): Hit2D | null {
    const collider = this.byShape.get(shape);
    if (!collider) return null;
    const body = collider.body;
    if (filter?.predicate && filter.predicate(body, collider) === false) return null;
    return { body, sprite: body.sprite, collider };
  }

  /** First collider along a ray from `origin` in `direction` (any length), or null. */
  raycast(origin: Vec2D, direction: Vec2D, options: RaycastOptions2D = {}): CastHit2D | null {
    this.live();
    this.checkVec(origin, 'Ray2D origin');
    this.checkVec(direction, 'Ray2D direction');
    const length = Math.hypot(direction[0], direction[1]);
    if (!(length > 0)) throw new RangeError('Ray2D direction must not be zero; pass a direction such as [0, 1].');
    const k = this.scale,
      dx = direction[0] / length,
      dy = direction[1] / length;
    this.writeFilter(options);
    const io = this.kernel.io(16);
    io.f.set([origin[0] * k, origin[1] * k, dx, dy, Math.min((options.maxDistance ?? 1e9) * k, 3e38)], 4);
    io.u[9] = options.solid ?? true ? 1 : 0;
    const count = this.kernel.ok(this.kernel.exports.ray_cast(this.handle));
    const out = this.kernel.io(4 * count);
    for (let i = 0; i < count; i++) {
      const base = this.hitOf(out.u[4 * i], options);
      if (!base) continue;
      const d = out.f[4 * i + 1] / k;
      return { ...base, distance: d, point: [origin[0] + dx * d, origin[1] + dy * d], normal: [out.f[4 * i + 2] + 0, out.f[4 * i + 3] + 0] };
    }
    return null;
  }

  /** The bodies with a collider containing `point`. */
  overlapPoint(point: Vec2D, filter?: QueryFilter2D): Body2D[] {
    this.live();
    this.checkVec(point, 'Point');
    this.writeFilter(filter);
    this.kernel.io(8).f.set([point[0] * this.scale, point[1] * this.scale], 4);
    const count = this.kernel.ok(this.kernel.exports.point_query(this.handle));
    return this.bodiesOf(this.kernel.io(count).u, count, filter);
  }
  private bodiesOf(shapes: Uint32Array, count: number, filter: QueryFilter2D | undefined): Body2D[] {
    const found = new Set<Body2D>();
    for (let i = 0; i < count; i++) {
      const hit = this.hitOf(shapes[i], filter);
      if (hit) found.add(hit.body);
    }
    return [...found];
  }

  /** The bodies with a collider overlapping `shape` (a box, circle, capsule or convex polygon) placed at `position`. */
  overlapShape(shape: ShapeOptions2D, position: Vec2D, rotation = 0, filter?: QueryFilter2D): Body2D[] {
    this.live();
    this.checkVec(position, 'Shape2D position');
    const d = this.queryShape(shape);
    this.writeFilter(filter);
    const io = this.kernel.io(8 + d.geometry.length);
    io.f.set([position[0] * this.scale, position[1] * this.scale, Math.cos(rotation), Math.sin(rotation)], 4);
    io.u.set(d.geometry, 8);
    const count = this.kernel.ok(this.kernel.exports.shape_overlap(this.handle, d.kind));
    return this.bodiesOf(this.kernel.io(count).u, count, filter);
  }

  private queryShape(shape: ShapeOptions2D): Described {
    const d = describeShape(shape, this.scale);
    if (d.kind > 4 || !d.convex)
      throw new RangeError('A query shape must be a box, circle, capsule, segment or a convex polygon of at most 8 points.');
    return d;
  }

  /** Slides `shape` from `position` along `direction` for up to `maxDistance` and reports the first collider it meets. */
  castShape(
    shape: ShapeOptions2D,
    position: Vec2D,
    direction: Vec2D,
    maxDistance: number,
    filter?: QueryFilter2D,
    rotation = 0,
  ): CastHit2D | null {
    this.live();
    this.checkVec(position, 'Shape2D position');
    this.checkVec(direction, 'Shape2D direction');
    const length = Math.hypot(direction[0], direction[1]);
    if (!(length > 0)) throw new RangeError('Shape2D direction must not be zero; pass a direction such as [0, 1].');
    const d = this.queryShape(shape);
    return this.cast(d, position[0] * this.scale, position[1] * this.scale, rotation, direction[0] / length, direction[1] / length, maxDistance * this.scale, filter);
  }

  /** @internal A shape cast in metres; the hit is in world units. */
  cast(d: Described, x: number, y: number, angle: number, dx: number, dy: number, max: number, filter?: QueryFilter2D): CastHit2D | null {
    this.writeFilter(filter);
    const io = this.kernel.io(11 + d.geometry.length);
    io.f.set([x, y, Math.cos(angle), Math.sin(angle), dx, dy, Math.min(max, 3e38)], 4);
    io.u.set(d.geometry, 11);
    const count = this.kernel.ok(this.kernel.exports.shape_cast(this.handle, d.kind));
    const out = this.kernel.io(8 * count);
    const k = 1 / this.scale;
    for (let i = 0; i < count; i++) {
      const base = this.hitOf(out.u[8 * i], filter);
      if (!base) continue;
      const f = out.f;
      return { ...base, distance: f[8 * i + 1] * k, point: [f[8 * i + 4] * k, f[8 * i + 5] * k], normal: [0 - f[8 * i + 6], 0 - f[8 * i + 7]] };
    }
    return null;
  }

  /**
   * The world as bytes: bodies, colliders and joints with their velocities, contacts and sleep timers. `restore` puts a
   * world back to it, and a restored world steps bit for bit as the original would have, so it serves rollback netcode,
   * replays and save games. The bytes are only good for this world's own bodies: see {@link Physics2D.restore}.
   */
  snapshot(): Uint8Array {
    this.live();
    const { kernel } = this;
    const length = kernel.ok(kernel.exports.world_snapshot(this.handle));
    const state = kernel.io(Math.ceil(length / 4)).u;
    const bytes = new Uint8Array(state.buffer.slice(state.byteOffset, state.byteOffset + length));
    const bodies = [...this.bodies].map((b) => [b.handle, b.colliders.map((c) => c.shapes)] as const);
    const header = new TextEncoder().encode(
      JSON.stringify({
        gravity: this.gravityValue,
        bodies,
        joints: [...this.joints].map((j) => j.handle),
        extra: [...this.bodies].map((b) => b.additionalMass),
      }),
    );
    const out = new Uint8Array(8 + header.length + bytes.length);
    new DataView(out.buffer).setUint32(0, 0x50443253, true);
    new DataView(out.buffer).setUint32(4, header.length, true);
    out.set(header, 8);
    out.set(bytes, 8 + header.length);
    return out;
  }

  /**
   * Puts the world back to a {@link Physics2D.snapshot}. The bodies, colliders and joints must be the ones that existed
   * when it was taken (none added or removed since; moving, waking and changing them is fine); the interpolation
   * history of every body restarts at the restored pose, and listeners and sprites stay as they are.
   * @throws MargoError (`state`) when bodies, colliders or joints were added or removed since the snapshot.
   * @throws RangeError when `bytes` is not a snapshot of this package.
   */
  restore(bytes: Uint8Array): void {
    this.live();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8 || view.getUint32(0, true) !== 0x50443253 || 8 + view.getUint32(4, true) > bytes.byteLength)
      throw new RangeError('Physics2D.restore needs the bytes Physics2D.snapshot returned.');
    const headerLength = view.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as {
      gravity: [number, number];
      bodies: Array<[number, number[][]]>;
      joints: number[];
      extra: number[];
    };
    const now = JSON.stringify([...this.bodies].map((b) => [b.handle, b.colliders.map((c) => c.shapes)]));
    if (now !== JSON.stringify(header.bodies) || JSON.stringify([...this.joints].map((j) => j.handle)) !== JSON.stringify(header.joints))
      throw new MargoError('state', 'Physics2D.restore: bodies, colliders or joints were added or removed since the snapshot; restore it before changing them, or take a new snapshot.');
    const state = bytes.subarray(8 + headerLength);
    const { kernel } = this;
    const io = kernel.io(Math.ceil(state.length / 4));
    new Uint8Array(io.u.buffer, io.u.byteOffset, state.length).set(state);
    kernel.ok(kernel.exports.world_restore(this.handle, state.length));
    this.gravityValue = [header.gravity[0], header.gravity[1]];
    this.accumulator = 0;
    let index = 0;
    for (const body of this.bodies) {
      body.snapshot();
      body.pose.copyWithin(0, 3, 6);
      body.dirty = true;
      body.restoreAdditionalMass(header.extra[index++] ?? 0);
    }
  }

  /**
   * Lines that draw the world, in world units: `vertices` holds x1, y1, x2, y2 for each line and `colors` its colour
   * code (0 fixed, 1 awake, 2 sleeping, 3 kinematic, 4 sensor, 5 joint, 6 contact point, 7 contact normal, 8 broad
   * phase box). Everything is drawn unless `options` picks parts.
   */
  debugRender(options: { shapes?: boolean; joints?: boolean; contacts?: boolean; boxes?: boolean } = {}): DebugLines2D {
    this.live();
    const all = Object.keys(options).length === 0;
    const what =
      (all || options.shapes ? 1 : 0) | (all || options.joints ? 2 : 0) | (all || options.contacts ? 4 : 0) | (all || options.boxes ? 8 : 0);
    const { kernel } = this;
    const count = kernel.ok(kernel.exports.debug_lines(this.handle, what));
    const f = kernel.io(5 * count).f;
    const k = 1 / this.scale;
    const vertices = new Float32Array(4 * count),
      colors = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < 4; j++) vertices[4 * i + j] = f[5 * i + j] * k;
      colors[i] = f[5 * i + 4];
    }
    return { vertices, colors };
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
    const engine = this.engine,
      // The scene this world is in, not the active one: a world in a second scene is disposed while another is active.
      scene = engine && !engine.disposed ? engine.sceneOf(this) : undefined;
    if (scene) {
      // removePlugin calls back into dispose() after unregistering.
      try {
        scene.removePlugin(this.name);
        return;
      } catch {
        /* engine is tearing down; free below */
      }
    }
    for (const controller of [...this.controllers]) controller.dispose();
    for (const joint of [...this.joints]) this.removeJoint(joint);
    for (const body of [...this.bodies]) this.removeBody(body);
    this.listeners.clear();
    this.kernel.exports.world_destroy(this.handle);
    this.disposed = true;
    this.engine = null;
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
