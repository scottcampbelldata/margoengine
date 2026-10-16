/// <reference lib="esnext.disposable" preserve="true" />
import type { Collider, EventQueue, PhysicsHooks, Ray, RigidBody, World } from './rapier-types.js';
import type { EngineKernel, EnginePlugin, Mesh } from '@margoengine/core';
import { meshRuntime, Mesh as CoreMesh } from '@margoengine/core/extension';
import { meshTriangles } from '../../shared/mesh-source.js';
import { PhysicsBody, type BodyOptions, type BodyOwner, type BodyType } from './body.js';
import { CharacterController, type CharacterControllerOptions } from './character.js';
import { PhysicsJoint, createJointData, type JointOptions } from './joints.js';
import { checkVec, eulerToQuat, quat, tuple, vec, type Quat, type Vec3 } from './math.js';
import {
  configureCollider,
  createColliderDesc,
  geometryPositions,
  type ColliderOptions,
  type GeometryLike,
  type ColliderSettings,
  type RapierModule,
  type ShapeOptions,
} from './shapes.js';
import { matrixRotation, matrixScale, worldMatrix, type TransformStoreLike } from './transform.js';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';

export interface PhysicsOptions {
  /** The initialized `@dimforge/rapier3d-compat` module. */
  rapier: RapierModule;
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
  /** Solver iterations per step (Rapier default 4). */
  solverIterations?: number;
  /** Return false to make a pair of bodies pass through each other (and suppress sensor events). Runs for every candidate pair, so keep it cheap. */
  contactFilter?: (a: PhysicsBody, b: PhysicsBody) => boolean;
  /** Plugin name (default 'physics'). */
  name?: string;
}

export type CollisionEventType = 'contactstart' | 'contactend' | 'intersectionstart' | 'intersectionend';
export interface CollisionEvent {
  type: CollisionEventType;
  bodyA: PhysicsBody;
  bodyB: PhysicsBody;
  meshA: Mesh | null;
  meshB: Mesh | null;
  colliderA: Collider;
  colliderB: Collider;
  /** True when either collider is a sensor (intersection events). */
  sensor: boolean;
}
export interface PhysicsEventMap {
  contactstart: CollisionEvent;
  contactend: CollisionEvent;
  intersectionstart: CollisionEvent;
  intersectionend: CollisionEvent;
  /** Before each fixed step, with the step length. Drive character controllers and kinematic bodies here. */
  beforestep: number;
  afterstep: number;
}

export interface QueryFilter {
  /** Packed interaction groups of the query, see `collisionGroups`. */
  groups?: number;
  /** Ignore this body. */
  exclude?: PhysicsBody;
  excludeSensors?: boolean;
  excludeFixed?: boolean;
  excludeKinematic?: boolean;
  excludeDynamic?: boolean;
  /** Return false to skip a body. */
  predicate?: (body: PhysicsBody, collider: Collider) => boolean;
}
export interface RaycastOptions extends QueryFilter {
  /** Default unbounded. */
  maxDistance?: number;
  /** Solid shapes report a hit at distance 0 when the ray starts inside (default true). */
  solid?: boolean;
}
export interface Hit {
  body: PhysicsBody;
  mesh: Mesh | null;
  collider: Collider;
}
export interface RaycastHit extends Hit {
  distance: number;
  point: [number, number, number];
  normal: [number, number, number];
}
export interface ShapeCastHit extends Hit {
  /** Distance travelled along the normalized direction before impact. */
  distance: number;
  /** Contact point on the hit collider, world space. */
  point: [number, number, number];
  /** Outward normal of the hit collider at the contact, world space. */
  normal: [number, number, number];
}
export interface PointProjection extends Hit {
  point: [number, number, number];
  inside: boolean;
  distance: number;
}

/**
 * Structural view of a gltf-pro `PBRModel` primitive (also what @margoengine/materials meshes are): node-space vertices,
 * 20 floats each with the position first, and triangle indices. Skinned and morphed primitives are read in their bind pose.
 */
export interface ModelPrimitiveLike {
  readonly node: Mesh;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly nodeIndex?: number;
  /** gltf-pro `PBRInstances`: one collider per drawn instance (24 floats each, node-space matrix first). */
  readonly instances?: { readonly count: number; readonly data: Float32Array };
}
/** Structural view of a gltf-pro `PBRModel`: its `root` node and `primitives`. */
export interface ModelLike {
  readonly root: Mesh;
  readonly primitives: readonly ModelPrimitiveLike[];
}
/** Options for `Physics.addModel`: body options plus how the model's triangles become colliders. */
export interface ModelBodyOptions extends Omit<BodyOptions, 'colliders' | 'position' | 'rotation'> {
  /**
   * Collider per primitive (and per instance of an instanced primitive). Default 'trimesh' for fixed and kinematic
   * bodies, 'convexHull' for dynamic ones (a Rapier trimesh has no volume, so it gives a dynamic body no mass).
   */
  shape?: 'trimesh' | 'convexHull';
  /** One body per glTF node that has primitives (true), or one body on `model.root` holding every collider (false, default). */
  perNode?: boolean;
  /** Return false to leave a primitive out, for example Blender objects tagged `collider = 0`. */
  filter?: (primitive: ModelPrimitiveLike) => boolean;
  /** Material, mass, sensor, group and event settings for every collider. */
  collider?: Omit<ColliderSettings, 'offset' | 'rotation'>;
}

const noop = (): void => {};
// Set.forEach with the event as thisArg calls listeners without allocating a closure or a snapshot array.
function callListener(this: never, listener: (event: never) => void): void {
  listener(this);
}
const identityRotation: Quat = [0, 0, 0, 1];

/**
 * Rigid-body physics on Rapier as a Margo Engine engine plugin. Steps a fixed timestep with an accumulator and
 * writes interpolated poses through reused buffers and core's extension transform storage.
 */
export class Physics implements EnginePlugin, BodyOwner {
  readonly name: string;
  readonly rapier: RapierModule;
  fixedTimestep: number;
  maxSubsteps: number;
  interpolate: boolean;
  timeScale: number;
  paused: boolean;
  /** Fixed steps taken since creation. */
  stepCount = 0;
  private worldRef: World | null;
  private queue: EventQueue | null;
  private hooks?: PhysicsHooks | null;
  private engine: EngineKernel | null = null;
  private accumulator = 0;
  private lastAlpha = 1;
  private disposed = false;
  private readonly bodies = new Set<PhysicsBody>();
  private readonly byMesh = new Map<Mesh, PhysicsBody>();
  private readonly byCollider = new Map<number, PhysicsBody>();
  private readonly joints = new Set<PhysicsJoint>();
  private readonly controllers = new Set<CharacterController>();
  private readonly listeners = new Map<keyof PhysicsEventMap, Set<(event: never) => void>>();
  private readonly scratch = [0, 0, 0, 0];
  private readonly positionScratch: [number, number, number] = [0, 0, 0];
  private readonly parentScratch = new Float64Array(16);
  private readonly inverseScratch = new Float64Array(16);
  private readonly parentRotation = [0, 0, 0, 1];
  private syncAlpha = 1;
  // Collision events are gathered into a reused array; a step run from inside a listener gathers into its own.
  private readonly eventBuffer: CollisionEvent[] = [];
  private collecting: CollisionEvent[] = this.eventBuffer;
  private dispatching = false;
  private readonly collect = (h1: number, h2: number, started: boolean): void => {
    const bodyA = this.byCollider.get(h1),
      bodyB = this.byCollider.get(h2);
    if (!bodyA || !bodyB) return;
    const world = this.worldRef!,
      colliderA = world.getCollider(h1),
      colliderB = world.getCollider(h2);
    const sensor = !!(colliderA?.isSensor() || colliderB?.isSensor());
    this.collecting.push({
      type: sensor ? (started ? 'intersectionstart' : 'intersectionend') : started ? 'contactstart' : 'contactend',
      bodyA,
      bodyB,
      meshA: bodyA.mesh,
      meshB: bodyB.mesh,
      colliderA,
      colliderB,
      sensor,
    });
  };

  /** Creates the Physics on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options: PhysicsOptions): Physics {
    return new Physics(engine, options);
  }
  constructor(engine: EngineKernel | null, options: PhysicsOptions) {
    const R = options?.rapier;
    if (!R || typeof R.World !== 'function' || !R.ColliderDesc)
      throw new TypeError(
        'Pass the initialized Rapier module: new Physics(engine, {rapier: RAPIER}) after await RAPIER.init()',
      );
    this.rapier = R;
    this.name = options.name ?? 'physics';
    this.fixedTimestep = options.fixedTimestep ?? 1 / 60;
    this.maxSubsteps = options.maxSubsteps ?? 4;
    this.interpolate = options.interpolate ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.paused = options.paused ?? false;
    if (!(this.fixedTimestep > 0 && this.fixedTimestep <= 1))
      throw new RangeError('fixedTimestep must be in (0, 1] seconds');
    if (!Number.isInteger(this.maxSubsteps) || this.maxSubsteps < 1)
      throw new RangeError('maxSubsteps must be a positive integer');
    const gravity = options.gravity ?? [0, -9.81, 0];
    checkVec(gravity, 'Gravity');
    this.worldRef = new R.World(vec(gravity));
    this.worldRef.timestep = this.fixedTimestep;
    if (options.solverIterations !== undefined) this.worldRef.numSolverIterations = options.solverIterations;
    try {
      this.queue = new R.EventQueue(true);
    } catch (error) {
      this.worldRef!.free();
      throw error;
    }
    const filter = options.contactFilter;
    if (filter) {
      const allow = (h1: number, h2: number): boolean => {
        const a = this.byCollider.get(h1),
          b = this.byCollider.get(h2);
        return !a || !b || filter(a, b) !== false;
      };
      this.hooks = {
        filterContactPair: (h1: number, h2: number) => (allow(h1, h2) ? R.SolverFlags.COMPUTE_IMPULSE : null),
        filterIntersectionPair: allow,
      };
    }
    if (engine)
      try {
        engine.use(this);
      } catch (error) {
        this.dispose();
        throw error;
      }
  }

  /** The Rapier `World`. Use it for anything this wrapper does not cover. */
  get world(): World {
    if (this.disposed) throw new Error('Physics is disposed');
    return this.worldRef!;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  get gravity(): [number, number, number] {
    return tuple(this.world.gravity);
  }
  set gravity(value: Vec3) {
    checkVec(value, 'Gravity');
    this.world.gravity = vec(value);
  }
  /** Interpolation factor used by the last `update`: leftover accumulator time over the step length, 0..1. */
  get alpha(): number {
    return this.lastAlpha;
  }
  /** Leftover simulation time in seconds, less than one step. */
  get pendingTime(): number {
    return this.accumulator;
  }
  get bodyCount(): number {
    return this.bodies.size;
  }

  // Engine plugin hooks.
  setup(engine: EngineKernel): void {
    if (this.disposed) throw new Error('Physics is disposed');
    if (this.engine && this.engine !== engine) throw new Error('Physics is attached to another engine');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.update(delta);
  }

  /** Advances the accumulator by `delta` seconds, runs whole fixed steps, then writes interpolated poses to meshes. Returns the number of steps. */
  update(delta: number): number {
    if (this.disposed) return 0;
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('delta must be a finite, non-negative number of seconds');
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

  /**
   * Runs exactly one fixed step and dispatches its events. Does not touch meshes; call `sync()` to write them.
   * Apart from Rapier's own `World.step` and the event objects of steps that have collisions, it allocates nothing.
   */
  step(): void {
    const world = this.world,
      dt = this.fixedTimestep;
    this.emit('beforestep', dt);
    if (this.disposed) return;
    world.timestep = dt;
    world.step(this.queue!, this.hooks!);
    this.stepCount++;
    this.bodies.forEach(this.snapshotBody);
    const outer = this.dispatching,
      events = (this.collecting = outer ? [] : this.eventBuffer);
    this.queue!.drainCollisionEvents(this.collect);
    this.dispatching = true;
    try {
      for (let i = 0; i < events.length; i++) this.emit(events[i].type, events[i]);
    } finally {
      this.dispatching = outer;
      events.length = 0;
    }
    this.emit('afterstep', dt);
  }
  private readonly snapshotBody = (body: PhysicsBody): void => {
    if (body.type === 'fixed') return;
    const p = body.pose;
    // A dynamic body asleep since the previous step has not moved, so skip Rapier's pose getters (in Rapier 0.21 each
    // allocates a typed-array view). The step that puts a body to sleep can still move it, so that one is read.
    const sleeping = body.type === 'dynamic' && body.raw.isSleeping();
    if (sleeping && body.slept) p.copyWithin(0, 7, 14);
    else body.snapshot();
    body.slept = sleeping;
    for (let i = 0; i < 7; i++)
      if (p[i] !== p[i + 7]) {
        body.restWritten = false;
        break;
      }
  };

  /** Writes body poses to their meshes, interpolated by `alpha` between the last two steps. Allocates nothing. */
  sync(alpha = this.lastAlpha): void {
    if (this.disposed) return;
    if (!Number.isFinite(alpha)) throw new RangeError('Invalid physics interpolation alpha');
    this.syncAlpha = this.interpolate ? Math.min(1, Math.max(0, alpha)) : 1;
    this.bodies.forEach(this.syncBody);
  }
  // A stable callback avoids creating a Set iterator during every synchronization.
  private readonly syncBody = (body: PhysicsBody): void => {
    const out = this.scratch,
      lerp = this.syncAlpha;
    const mesh = body.mesh;
    // A resting body on a child mesh is still rewritten: its parent may have moved, and the body keeps its world pose.
    if (!mesh || (body.type === 'fixed' && !body.dirty) || (body.restWritten && parentOf(mesh) === -1)) return;
    try {
      mesh.check();
    } catch {
      this.removeBody(body);
      return;
    }
    const p = body.pose;
    const position = this.positionScratch;
    position[0] = p[0] + (p[7] - p[0]) * lerp;
    position[1] = p[1] + (p[8] - p[1]) * lerp;
    position[2] = p[2] + (p[9] - p[2]) * lerp;
    // Shortest-arc slerp of the two step rotations, inline: V8 boxes a fractional number passed to a call it does not
    // inline (a heap allocation), and Math.hypot allocates an array for its arguments.
    const ax = p[3],
      ay = p[4],
      az = p[5],
      aw = p[6];
    let bx = p[10],
      by = p[11],
      bz = p[12],
      bw = p[13],
      cos = ax * bx + ay * by + az * bz + aw * bw,
      k0 = 1 - lerp,
      k1 = lerp;
    if (cos < 0) {
      cos = -cos;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    if (cos <= 0.9995) {
      const angle = Math.acos(cos),
        sin = Math.sin(angle);
      k0 = Math.sin((1 - lerp) * angle) / sin;
      k1 = Math.sin(lerp * angle) / sin;
    }
    out[0] = ax * k0 + bx * k1;
    out[1] = ay * k0 + by * k1;
    out[2] = az * k0 + bz * k1;
    out[3] = aw * k0 + bw * k1;
    const length = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]) || 1;
    for (let i = 0; i < 4; i++) out[i] /= length;
    if (mesh instanceof CoreMesh) {
      // Frozen core's setQuaternion maps a fresh array; synchronize through its extension storage.
      const runtime = meshRuntime(mesh),
        store = runtime.engine.store,
        t = store.transforms,
        id = runtime.id,
        parent = store.parents[id];
      // A child mesh gets its pose relative to the parent's current world transform (no frame of lag).
      if (parent !== -1) this.toLocal(store, parent, position, out);
      const x = out[0],
        y = out[1],
        z = out[2],
        w = out[3];
      if (
        !Number.isFinite(Math.fround(position[0])) ||
        !Number.isFinite(Math.fround(position[1])) ||
        !Number.isFinite(Math.fround(position[2]))
      )
        throw new RangeError('Invalid physics position');
      if (
        !Number.isFinite(Math.fround(x)) ||
        !Number.isFinite(Math.fround(y)) ||
        !Number.isFinite(Math.fround(z)) ||
        !Number.isFinite(Math.fround(w))
      )
        throw new RangeError('Invalid physics quaternion');
      mesh.setPosition(position);
      t.qx[id] = x;
      t.qy[id] = y;
      t.qz[id] = z;
      t.qw[id] = w;
      runtime.euler[1] = Math.asin(Math.max(-1, Math.min(1, 2 * (x * z + w * y))));
      runtime.euler[0] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
      runtime.euler[2] = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
    } else {
      if (parentOf(mesh) !== -1)
        throw new Error('Non-core physics bodies need root-level meshes; child meshes require core transform storage');
      mesh.setPosition(position).setQuaternion(out);
    }
    body.dirty = false;
    body.restWritten =
      p[0] === p[7] &&
      p[1] === p[8] &&
      p[2] === p[9] &&
      p[3] === p[10] &&
      p[4] === p[11] &&
      p[5] === p[12] &&
      p[6] === p[13];
  };
  /** World pose (in place) to the pose relative to `parent`: inverse parent matrix on the position, inverse parent rotation on the quaternion. */
  private toLocal(store: TransformStoreLike, parent: number, position: number[], rotation: number[]): void {
    const m = worldMatrix(store, parent, this.parentScratch),
      inverse = invertMatrix(m, this.inverseScratch);
    if (!inverse) throw new RangeError('Physics body parent has a singular world transform');
    const x = position[0],
      y = position[1],
      z = position[2];
    for (let r = 0; r < 3; r++)
      position[r] = inverse[r] * x + inverse[4 + r] * y + inverse[8 + r] * z + inverse[12 + r];
    const q = this.parentRotation;
    matrixRotation(m, q);
    // conjugate(q) * rotation
    const ax = -q[0],
      ay = -q[1],
      az = -q[2],
      aw = q[3],
      bx = rotation[0],
      by = rotation[1],
      bz = rotation[2],
      bw = rotation[3];
    rotation[0] = aw * bx + ax * bw + ay * bz - az * by;
    rotation[1] = aw * by - ax * bz + ay * bw + az * bx;
    rotation[2] = aw * bz + ax * by - ay * bx + az * bw;
    rotation[3] = aw * bw - ax * bx - ay * by - az * bz;
  }

  /**
   * Creates a rigid body, optionally driving `mesh`. Physics works in world space: the body starts at the mesh's world
   * pose, and each frame the interpolated world pose is written to the mesh's position and rotation (relative to its
   * parent for a child mesh, using the parent's current world transform, so there is no frame of lag). Scale is never
   * written.
   */
  addBody(mesh: Mesh | null, options: BodyOptions = {}): PhysicsBody {
    const world = this.world,
      R = this.rapier,
      type: BodyType = options.type ?? 'dynamic';
    let worldPose: Float64Array | null = null;
    if (mesh) {
      mesh.check();
      if (mesh instanceof CoreMesh && this.engine && meshRuntime(mesh).engine !== this.engine)
        throw new TypeError('Physics mesh belongs to another engine');
      if (this.byMesh.has(mesh)) throw new Error('This mesh already has a physics body');
      if (parentOf(mesh) !== -1) {
        if (!(mesh instanceof CoreMesh))
          throw new Error(
            'Non-core physics bodies need root-level meshes; child meshes require core transform storage',
          );
        const runtime = meshRuntime(mesh);
        worldPose = worldMatrix(runtime.engine.store, runtime.id, new Float64Array(16));
      }
    }
    const factory = (
      {
        dynamic: 'dynamic',
        fixed: 'fixed',
        kinematicPosition: 'kinematicPositionBased',
        kinematicVelocity: 'kinematicVelocityBased',
      } as const
    )[type];
    if (!factory) throw new TypeError(`Unknown body type ${type}`);
    const desc = R.RigidBodyDesc[factory]();
    const position =
      options.position ??
      (worldPose
        ? ([worldPose[12], worldPose[13], worldPose[14]] as const)
        : mesh
          ? ([mesh.position.x, mesh.position.y, mesh.position.z] as const)
          : ([0, 0, 0] as const));
    checkVec(position, 'Position');
    let rotation: Quat =
      options.rotation ?? (mesh ? eulerToQuat(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z) : identityRotation);
    if (!options.rotation && worldPose) {
      const q: [number, number, number, number] = [0, 0, 0, 1];
      matrixRotation(worldPose, q);
      rotation = q;
    }
    desc.setTranslation(position[0], position[1], position[2]).setRotation(quat(rotation));
    if (options.linearVelocity) {
      checkVec(options.linearVelocity, 'linearVelocity');
      desc.setLinvel(...options.linearVelocity);
    }
    if (options.angularVelocity) {
      checkVec(options.angularVelocity, 'angularVelocity');
      desc.setAngvel(vec(options.angularVelocity));
    }
    if (options.linearDamping !== undefined) desc.setLinearDamping(options.linearDamping);
    if (options.angularDamping !== undefined) desc.setAngularDamping(options.angularDamping);
    if (options.gravityScale !== undefined) desc.setGravityScale(options.gravityScale);
    if (options.ccd) desc.setCcdEnabled(true);
    if (options.canSleep !== undefined) desc.setCanSleep(options.canSleep);
    if (options.sleeping) desc.setSleeping(true);
    if (options.dominance !== undefined) desc.setDominanceGroup(options.dominance);
    if (options.additionalMass !== undefined) desc.setAdditionalMass(options.additionalMass);
    if (options.lockRotations) desc.lockRotations();
    if (options.lockTranslations) desc.lockTranslations();
    if (options.enabledRotations) desc.enabledRotations(...options.enabledRotations);
    if (options.enabledTranslations) desc.enabledTranslations(...options.enabledTranslations);
    const raw = world.createRigidBody(desc);
    const body = new PhysicsBody(this, raw, mesh, type);
    body.userData = options.userData;
    if (worldPose) body.fitScale = matrixScale(worldPose, [1, 1, 1]) as [number, number, number];
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
    return body;
  }

  /**
   * Colliders for a whole glTF model (gltf-pro `PBRModel`, or a @margoengine/materials mesh) in one call: one collider
   * per primitive (per instance for instanced primitives), built from its triangles with every node, instance and scale
   * transform of the hierarchy applied. By default one body on `model.root` holds them all (a level, or a prop that
   * moves as one); `perNode: true` gives each node with primitives its own body instead (hits and events then report
   * that node, and dynamic nodes move on their own). Returns the new bodies; after an error none are kept.
   */
  addModel(model: ModelLike, options: ModelBodyOptions = {}): PhysicsBody[] {
    const { shape: requested, perNode = false, filter, collider = {}, ...bodyOptions } = options;
    const type: BodyType = bodyOptions.type ?? 'dynamic',
      shape = requested ?? (type === 'dynamic' ? 'convexHull' : 'trimesh');
    if (shape !== 'trimesh' && shape !== 'convexHull')
      throw new TypeError(`Model colliders are 'trimesh' or 'convexHull', not ${String(shape)}`);
    if (!model?.root || !Array.isArray(model.primitives))
      throw new TypeError('addModel needs a gltf-pro model (root and primitives)');
    const groups = new Map<Mesh, ModelPrimitiveLike[]>();
    for (const primitive of model.primitives) {
      if (filter && !filter(primitive)) continue;
      const anchor = perNode ? primitive.node : model.root;
      let list = groups.get(anchor);
      if (!list) groups.set(anchor, (list = []));
      list.push(primitive);
    }
    const created: PhysicsBody[] = [],
      anchorMatrix = new Float64Array(16),
      nodeMatrix = new Float64Array(16),
      instanceMatrix = new Float64Array(16),
      q = [0, 0, 0, 1];
    try {
      for (const [anchor, primitives] of groups) {
        anchor.check();
        const anchorRuntime = meshRuntime(anchor);
        worldMatrix(anchorRuntime.engine.store, anchorRuntime.id, anchorMatrix);
        matrixRotation(anchorMatrix, q);
        // Body space = world space under the inverse of the anchor's rigid pose (position and rotation; scale is baked in).
        const px = anchorMatrix[12],
          py = anchorMatrix[13],
          pz = anchorMatrix[14],
          qx = q[0],
          qy = q[1],
          qz = q[2],
          qw = q[3];
        const r00 = 1 - 2 * (qy * qy + qz * qz),
          r10 = 2 * (qx * qy + qw * qz),
          r20 = 2 * (qx * qz - qw * qy);
        const r01 = 2 * (qx * qy - qw * qz),
          r11 = 1 - 2 * (qx * qx + qz * qz),
          r21 = 2 * (qy * qz + qw * qx);
        const r02 = 2 * (qx * qz + qw * qy),
          r12 = 2 * (qy * qz - qw * qx),
          r22 = 1 - 2 * (qx * qx + qy * qy);
        const colliders: ColliderOptions[] = [];
        for (const primitive of primitives) {
          const node = meshRuntime(primitive.node),
            v = primitive.vertices,
            count = v.length / 20,
            instances = primitive.instances;
          worldMatrix(node.engine.store, node.id, nodeMatrix);
          for (let k = 0; k < (instances ? instances.count : 1); k++) {
            const m = instances
                ? multiplyMatrices(nodeMatrix, instances.data.subarray(k * 24, k * 24 + 16), instanceMatrix)
                : nodeMatrix,
              points = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
              const x = v[i * 20],
                y = v[i * 20 + 1],
                z = v[i * 20 + 2];
              const wx = m[0] * x + m[4] * y + m[8] * z + m[12] - px,
                wy = m[1] * x + m[5] * y + m[9] * z + m[13] - py,
                wz = m[2] * x + m[6] * y + m[10] * z + m[14] - pz;
              points[i * 3] = r00 * wx + r10 * wy + r20 * wz;
              points[i * 3 + 1] = r01 * wx + r11 * wy + r21 * wz;
              points[i * 3 + 2] = r02 * wx + r12 * wy + r22 * wz;
            }
            colliders.push(
              shape === 'trimesh'
                ? { ...collider, shape, vertices: points, indices: primitive.indices }
                : { ...collider, shape, points },
            );
          }
        }
        created.push(
          this.addBody(anchor, { ...bodyOptions, type, position: [px, py, pz], rotation: [qx, qy, qz, qw], colliders }),
        );
        // The pose came from the mesh: nothing to write back until the body moves.
        created[created.length - 1].dirty = false;
      }
    } catch (error) {
      for (const body of created) this.removeBody(body);
      throw error;
    }
    return created;
  }

  /** The body driving `mesh`, if any. */
  bodyOf(mesh: Mesh): PhysicsBody | undefined {
    return this.byMesh.get(mesh);
  }
  /** The body owning a Rapier collider or collider handle. */
  bodyOfCollider(collider: Collider | number): PhysicsBody | undefined {
    return this.byCollider.get(typeof collider === 'number' ? collider : collider?.handle);
  }
  getBodies(): PhysicsBody[] {
    return [...this.bodies];
  }

  /** @internal use `body.addCollider`. */
  addCollider(body: PhysicsBody, options: ColliderOptions): Collider {
    const R = this.rapier,
      mesh = body.mesh;
    const needsGeometry =
      (options.shape === 'box' && !options.halfExtents) ||
      (options.shape === 'sphere' && options.radius === undefined) ||
      (options.shape === 'convexHull' && !options.points && !options.geometry) ||
      (options.shape === 'trimesh' && !options.vertices && !options.geometry);
    const fit =
      mesh && needsGeometry
        ? colliderGeometry(mesh)
        : {
            geometry: null,
            scale: mesh ? ([mesh.scale.x, mesh.scale.y, mesh.scale.z] as const) : ([1, 1, 1] as const),
          };
    if (body.fitScale && mesh?.geometry) fit.scale = body.fitScale;
    const { desc, center } = createColliderDesc(R, options, fit);
    configureCollider(R, desc, options, center, !!this.hooks);
    const collider = this.world.createCollider(desc, body.raw);
    body.colliders.push(collider);
    this.byCollider.set(collider.handle, body);
    return collider;
  }
  /** @internal use `body.removeCollider`. */
  removeCollider(body: PhysicsBody, collider: Collider): void {
    const index = body.colliders.indexOf(collider);
    if (index < 0) throw new Error('Collider does not belong to this body');
    body.colliders.splice(index, 1);
    this.byCollider.delete(collider.handle);
    this.world.removeCollider(collider, true);
  }

  /** Removes a body with its colliders, joints and character controllers. */
  removeBody(body: PhysicsBody): void {
    if (!this.bodies.has(body)) return;
    for (const joint of this.joints) if (joint.bodyA === body || joint.bodyB === body) this.removeJoint(joint);
    for (const controller of this.controllers) if (controller.body === body) controller.dispose();
    for (const collider of body.colliders) this.byCollider.delete(collider.handle);
    this.bodies.delete(body);
    if (body.mesh) this.byMesh.delete(body.mesh);
    this.world.removeRigidBody(body.raw);
    body.markRemoved();
  }

  /** Connects two bodies with a fixed, spherical, revolute or prismatic joint. Anchors are in each body's local frame. */
  addJoint(bodyA: PhysicsBody, bodyB: PhysicsBody, options: JointOptions): PhysicsJoint {
    if (!this.bodies.has(bodyA) || !this.bodies.has(bodyB))
      throw new Error('Both bodies must belong to this physics world');
    if (bodyA === bodyB) throw new Error('A joint needs two different bodies');
    const raw = this.world.createImpulseJoint(createJointData(this.rapier, options), bodyA.raw, bodyB.raw, true);
    const joint = new PhysicsJoint(this, raw, options.type, bodyA, bodyB);
    this.joints.add(joint);
    if (options.contactsEnabled !== undefined) raw.setContactsEnabled(options.contactsEnabled);
    if (options.type === 'revolute' || options.type === 'prismatic') {
      if (options.limits) joint.setLimits(options.limits[0], options.limits[1]);
      if (options.motor) joint.setMotor(options.motor);
    }
    return joint;
  }
  /** @internal use `joint.remove`. */
  removeJoint(joint: PhysicsJoint): void {
    if (!this.joints.delete(joint)) return;
    if (joint.raw.isValid()) this.world.removeImpulseJoint(joint.raw, true);
    joint.markRemoved();
  }

  /** Wraps Rapier's KinematicCharacterController around a kinematicPosition body. */
  createCharacterController(body: PhysicsBody, options?: CharacterControllerOptions): CharacterController {
    if (!this.bodies.has(body)) throw new Error('Body must belong to this physics world');
    const controller = new CharacterController(this, body, options);
    this.controllers.add(controller);
    return controller;
  }
  /** @internal use `controller.dispose`. */
  removeController(controller: CharacterController): void {
    if (!this.controllers.delete(controller)) return;
    if (!this.disposed) this.worldRef!.removeCharacterController(controller.raw);
  }

  /** Subscribes to collision or step events. Returns an unsubscribe function. */
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

  // Scene queries. All positions and directions are world space.
  private filterArgs(
    filter: QueryFilter = {},
  ): [
    number | undefined,
    number | undefined,
    undefined,
    RigidBody | undefined,
    ((collider: Collider) => boolean) | undefined,
  ] {
    const F = this.rapier.QueryFilterFlags;
    let flags = 0;
    if (filter.excludeSensors) flags |= F.EXCLUDE_SENSORS;
    if (filter.excludeFixed) flags |= F.EXCLUDE_FIXED;
    if (filter.excludeKinematic) flags |= F.EXCLUDE_KINEMATIC;
    if (filter.excludeDynamic) flags |= F.EXCLUDE_DYNAMIC;
    const predicate = filter.predicate;
    return [
      flags || undefined,
      filter.groups,
      undefined,
      filter.exclude?.raw,
      (collider) => {
        const body = this.byCollider.get(collider.handle);
        return !!body && (!predicate || predicate(body, collider));
      },
    ];
  }
  private hit(collider: Collider): Hit | null {
    const body = this.byCollider.get(collider.handle);
    return body ? { body, mesh: body.mesh, collider } : null;
  }
  private ray(origin: Vec3, direction: Vec3): { ray: Ray; dir: [number, number, number] } {
    checkVec(origin, 'Ray origin');
    checkVec(direction, 'Ray direction');
    const length = Math.hypot(...direction);
    if (!length) throw new RangeError('Ray direction must be nonzero');
    const dir: [number, number, number] = [direction[0] / length, direction[1] / length, direction[2] / length];
    return { ray: new this.rapier.Ray(vec(origin), vec(dir)), dir };
  }

  /** First hit along a ray, or null. */
  raycast(origin: Vec3, direction: Vec3, options: RaycastOptions = {}): RaycastHit | null {
    const { ray, dir } = this.ray(origin, direction);
    const result = this.world.castRayAndGetNormal(
      ray,
      options.maxDistance ?? 1e30,
      options.solid ?? true,
      ...this.filterArgs(options),
    );
    if (!result) return null;
    const base = this.hit(result.collider);
    if (!base) return null;
    const t = result.timeOfImpact;
    return {
      ...base,
      distance: t,
      point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
      normal: tuple(result.normal),
    };
  }

  /** Every hit along a ray, nearest first. */
  raycastAll(origin: Vec3, direction: Vec3, options: RaycastOptions = {}): RaycastHit[] {
    const { ray, dir } = this.ray(origin, direction),
      hits: RaycastHit[] = [];
    const [flags, groups, , excludeBody, predicate] = this.filterArgs(options);
    this.world.intersectionsWithRay(
      ray,
      options.maxDistance ?? 1e30,
      options.solid ?? true,
      (result) => {
        const base = this.hit(result.collider),
          t = result.timeOfImpact;
        if (base)
          hits.push({
            ...base,
            distance: t,
            point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
            normal: tuple(result.normal),
          });
        return true;
      },
      flags,
      groups,
      undefined,
      excludeBody,
      predicate,
    );
    return hits.sort((a, b) => a.distance - b.distance);
  }

  /** Sweeps a shape from `position` along `direction` and returns the first hit, or null. */
  shapeCast(
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat,
    direction: Vec3,
    options: QueryFilter & { maxDistance?: number; targetDistance?: number; stopAtPenetration?: boolean } = {},
  ): ShapeCastHit | null {
    checkVec(position, 'Shape position');
    const { dir } = this.ray(position, direction);
    const query = createColliderDesc(this.rapier, shape).desc.shape;
    const result = this.world.castShape(
      vec(position),
      quat(rotation),
      vec(dir),
      query,
      options.targetDistance ?? 0,
      options.maxDistance ?? 1e30,
      options.stopAtPenetration ?? true,
      ...this.filterArgs(options),
    );
    if (!result) return null;
    const base = this.hit(result.collider);
    return base
      ? { ...base, distance: result.time_of_impact, point: tuple(result.witness1), normal: tuple(result.normal1) }
      : null;
  }

  /** Closest point on any collider to `point`, or null. */
  projectPoint(point: Vec3, options: QueryFilter & { solid?: boolean } = {}): PointProjection | null {
    checkVec(point, 'Point');
    const result = this.world.projectPoint(vec(point), options.solid ?? true, ...this.filterArgs(options));
    if (!result) return null;
    const base = this.hit(result.collider);
    if (!base) return null;
    const projected = tuple(result.point);
    return {
      ...base,
      point: projected,
      inside: result.isInside,
      distance: result.isInside
        ? 0
        : Math.hypot(projected[0] - point[0], projected[1] - point[1], projected[2] - point[2]),
    };
  }

  /** Bodies whose colliders contain `point`. */
  intersectPoint(point: Vec3, options: QueryFilter = {}): PhysicsBody[] {
    checkVec(point, 'Point');
    const found = new Set<PhysicsBody>(),
      [flags, groups, , excludeBody, predicate] = this.filterArgs(options);
    this.world.intersectionsWithPoint(
      vec(point),
      (collider) => {
        const body = this.byCollider.get(collider.handle);
        if (body) found.add(body);
        return true;
      },
      flags,
      groups,
      undefined,
      excludeBody,
      predicate,
    );
    return [...found];
  }

  /** Bodies whose colliders overlap a shape placed at `position` and `rotation`. */
  intersectShape(
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat = [0, 0, 0, 1],
    options: QueryFilter = {},
  ): PhysicsBody[] {
    checkVec(position, 'Shape position');
    const query = createColliderDesc(this.rapier, shape).desc.shape,
      found = new Set<PhysicsBody>(),
      [flags, groups, , excludeBody, predicate] = this.filterArgs(options);
    this.world.intersectionsWithShape(
      vec(position),
      quat(rotation),
      query,
      (collider) => {
        const body = this.byCollider.get(collider.handle);
        if (body) found.add(body);
        return true;
      },
      flags,
      groups,
      undefined,
      excludeBody,
      predicate,
    );
    return [...found];
  }

  /** Whether two bodies' colliders currently touch (contact) or overlap (sensor), as of the last step. */
  touching(a: PhysicsBody, b: PhysicsBody): boolean {
    const world = this.world;
    for (const ca of a.colliders)
      for (const cb of b.colliders) {
        if (ca.isSensor() || cb.isSensor()) {
          if (world.intersectionPair(ca, cb)) return true;
          continue;
        }
        let touching = false;
        world.contactPair(ca, cb, (manifold) => {
          if (manifold.numContacts() > 0) touching = true;
        });
        if (touching) return true;
      }
    return false;
  }

  /**
   * Rapier's debug line buffers: `vertices` (xyz pairs, one segment per pair) and `colors` (rgba per vertex).
   * Draw them with `@margoengine/lines`: `new Line({mode: 'segments', positions: vertices, colors})`.
   */
  debugRender(): { vertices: Float32Array; colors: Float32Array } {
    const buffers = this.world.debugRender();
    return { vertices: buffers.vertices, colors: buffers.colors };
  }

  /** Frees every controller, joint, collider, body and the world. Detaches from the engine if attached. */
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
    this.queue!.free();
    this.worldRef!.free();
    this.disposed = true;
    this.engine = null;
    this.queue = this.worldRef = this.hooks = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

function parentOf(mesh: Mesh): number {
  const runtime = meshRuntime(mesh) as unknown as { id?: number; engine?: { store?: { parents?: ArrayLike<number> } } };
  const parents = runtime.engine?.store?.parents;
  return parents && runtime.id !== undefined ? parents[runtime.id] : -1;
}

/** Static bind-pose triangle data from optional PBR loaders; never attach a second core draw geometry. */
function primitiveGeometry(mesh: Mesh): GeometryLike | null {
  const triangles = meshTriangles(meshRuntime(mesh));
  if (!triangles) return null;
  if (triangles.kind === 'core') return triangles.geometry;
  if (triangles.source.skinned || triangles.source.morphed) throw new Error('Skinned mesh needs an explicit collider');
  const { primitives } = triangles.source;
  if (!primitives.length) return null;
  let vertexCount = 0,
    indexCount = 0;
  for (const primitive of primitives) {
    if (primitive.vertices.length % 20) throw new RangeError('PBR vertex array length is not a multiple of its stride');
    vertexCount += primitive.vertices.length / 20;
    indexCount += primitive.indices.length;
  }
  const vertices = new Float32Array(vertexCount * 3),
    indices = new Uint32Array(indexCount);
  let vertexOffset = 0,
    indexOffset = 0;
  for (const primitive of primitives) {
    const count = primitive.vertices.length / 20;
    for (let i = 0; i < count; i++)
      vertices.set(primitive.vertices.subarray(i * 20, i * 20 + 3), (vertexOffset + i) * 3);
    for (const index of primitive.indices) indices[indexOffset++] = vertexOffset + index;
    vertexOffset += count;
  }
  return { vertices, indices, stride: 3 };
}

/** Fit a geometry-free root to its static descendants without altering the hierarchy. */
function colliderGeometry(mesh: Mesh): { geometry: GeometryLike; scale: Vec3 } {
  const direct = primitiveGeometry(mesh);
  if (direct) return { geometry: direct, scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z] };
  const root = meshRuntime(mesh),
    engine = root.engine;
  if (!engine.meshes || !engine.store.tick) throw new Error('No geometry');
  engine.store.tick(false);
  const sources: { node: CoreMesh; positions: Float32Array; indices: ArrayLike<number> }[] = [];
  let vertexCount = 0,
    indexCount = 0;
  for (const node of engine.meshes.values()) {
    let ancestor = engine.store.parents[node.id],
      depth = 0;
    while (ancestor !== -1 && ancestor !== root.id && depth++ < 64) ancestor = engine.store.parents[ancestor];
    if (ancestor !== root.id) continue;
    const geometry = primitiveGeometry(node);
    if (!geometry) continue;
    const positions = geometryPositions(geometry);
    if (!positions.length || !geometry.indices?.length) continue;
    sources.push({ node, positions, indices: geometry.indices });
    vertexCount += positions.length / 3;
    indexCount += geometry.indices.length;
  }
  if (!vertexCount) throw new Error('No geometry');

  const vertices = new Float32Array(vertexCount * 3),
    indices = new Uint32Array(indexCount);
  const [qx, qy, qz, qw] = eulerToQuat(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z);
  const px = mesh.position.x,
    py = mesh.position.y,
    pz = mesh.position.z;
  let vertexOffset = 0,
    indexOffset = 0;
  for (const { node, positions, indices: sourceIndices } of sources) {
    const m = node.matrix;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i],
        y = positions[i + 1],
        z = positions[i + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12] - px;
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13] - py;
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14] - pz;
      // Invert the body's rigid pose, not its scaled world matrix: Rapier has no body scale.
      // The descendant world matrix already includes every scale, including the root's, once.
      const tx = -2 * (qy * wz - qz * wy),
        ty = -2 * (qz * wx - qx * wz),
        tz = -2 * (qx * wy - qy * wx);
      const offset = vertexOffset * 3 + i;
      vertices[offset] = wx + qw * tx - qy * tz + qz * ty;
      vertices[offset + 1] = wy + qw * ty - qz * tx + qx * tz;
      vertices[offset + 2] = wz + qw * tz - qx * ty + qy * tx;
      if (
        !Number.isFinite(vertices[offset]) ||
        !Number.isFinite(vertices[offset + 1]) ||
        !Number.isFinite(vertices[offset + 2])
      )
        throw new RangeError('Geometry positions must be finite');
    }
    for (let i = 0; i < sourceIndices.length; i++) indices[indexOffset++] = vertexOffset + sourceIndices[i];
    vertexOffset += positions.length / 3;
  }
  return { geometry: { vertices, indices, stride: 3 }, scale: [1, 1, 1] };
}
