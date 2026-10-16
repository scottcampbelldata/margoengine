import type {EngineKernel, EnginePlugin, Mesh} from '@margoengine/core';
import {meshRuntime,Mesh as CoreMesh} from '@margoengine/core/extension';
import {meshTriangles} from '../../shared/mesh-source.js';
import {PhysicsBody, type BodyOptions, type BodyOwner, type BodyType} from './body.js';
import {CharacterController, type CharacterControllerOptions} from './character.js';
import {PhysicsJoint, createJointData, type JointOptions} from './joints.js';
import {checkVec, eulerToQuat, quat, slerp, tuple, vec, type Quat, type Vec3} from './math.js';
import {configureCollider, createColliderDesc, geometryPositions, type ColliderOptions, type GeometryLike, type RapierModule, type ShapeOptions} from './shapes.js';

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
  colliderA: any;
  colliderB: any;
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
  predicate?: (body: PhysicsBody, collider: any) => boolean;
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
  collider: any;
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

const noop = (): void => {};

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
  private worldRef: any;
  private queue: any;
  private hooks: any;
  private engine: EngineKernel | null = null;
  private accumulator = 0;
  private lastAlpha = 1;
  private disposed = false;
  private readonly bodies = new Set<PhysicsBody>();
  private readonly byMesh = new Map<Mesh, PhysicsBody>();
  private readonly byCollider = new Map<number, PhysicsBody>();
  private readonly joints = new Set<PhysicsJoint>();
  private readonly controllers = new Set<CharacterController>();
  private readonly listeners = new Map<keyof PhysicsEventMap, Set<(event: any) => void>>();
  private readonly scratch = [0, 0, 0, 0];
  private readonly positionScratch: [number,number,number] = [0,0,0];
  private syncAlpha = 1;

  constructor(engine: EngineKernel | null, options: PhysicsOptions) {
    const R = options?.rapier;
    if (!R || typeof R.World !== 'function' || !R.ColliderDesc) throw new TypeError('Pass the initialized Rapier module: new Physics(engine, {rapier: RAPIER}) after await RAPIER.init()');
    this.rapier = R;
    this.name = options.name ?? 'physics';
    this.fixedTimestep = options.fixedTimestep ?? 1 / 60;
    this.maxSubsteps = options.maxSubsteps ?? 4;
    this.interpolate = options.interpolate ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.paused = options.paused ?? false;
    if (!(this.fixedTimestep > 0 && this.fixedTimestep <= 1)) throw new RangeError('fixedTimestep must be in (0, 1] seconds');
    if (!Number.isInteger(this.maxSubsteps) || this.maxSubsteps < 1) throw new RangeError('maxSubsteps must be a positive integer');
    const gravity = options.gravity ?? [0, -9.81, 0];
    checkVec(gravity, 'Gravity');
    this.worldRef = new R.World(vec(gravity));
    this.worldRef.timestep = this.fixedTimestep;
    if (options.solverIterations !== undefined) this.worldRef.numSolverIterations = options.solverIterations;
    try {this.queue = new R.EventQueue(true);} catch (error) {this.worldRef.free(); throw error;}
    const filter = options.contactFilter;
    if (filter) {
      const allow = (h1: number, h2: number): boolean => {const a = this.byCollider.get(h1), b = this.byCollider.get(h2); return !a || !b || filter(a, b) !== false;};
      this.hooks = {
        filterContactPair: (h1: number, h2: number) => allow(h1, h2) ? R.SolverFlags.COMPUTE_IMPULSE : null,
        filterIntersectionPair: allow,
      };
    }
    if (engine) try {engine.use(this);} catch (error) {this.dispose(); throw error;}
  }

  /** The Rapier `World`. Use it for anything this wrapper does not cover. */
  get world(): any {if (this.disposed) throw new Error('Physics is disposed'); return this.worldRef;}
  get isDisposed(): boolean {return this.disposed;}
  get gravity(): [number, number, number] {return tuple(this.world.gravity);}
  set gravity(value: Vec3) {checkVec(value, 'Gravity'); this.world.gravity = vec(value);}
  /** Interpolation factor used by the last `update`: leftover accumulator time over the step length, 0..1. */
  get alpha(): number {return this.lastAlpha;}
  /** Leftover simulation time in seconds, less than one step. */
  get pendingTime(): number {return this.accumulator;}
  get bodyCount(): number {return this.bodies.size;}

  // Engine plugin hooks.
  setup(engine: EngineKernel): void {
    if (this.disposed) throw new Error('Physics is disposed');
    if (this.engine && this.engine !== engine) throw new Error('Physics is attached to another engine');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {this.update(delta);}

  /** Advances the accumulator by `delta` seconds, runs whole fixed steps, then writes interpolated poses to meshes. Returns the number of steps. */
  update(delta: number): number {
    if (this.disposed) return 0;
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('delta must be a finite, non-negative number of seconds');
    let steps = 0;
    if (!this.paused) {
      const dt = this.fixedTimestep;
      this.accumulator += delta * this.timeScale;
      while (this.accumulator + dt * 1e-6 >= dt && steps < this.maxSubsteps) {this.step(); this.accumulator -= dt; steps++;}
      if (this.accumulator >= dt) this.accumulator %= dt;
      if (this.accumulator < 0) this.accumulator = 0;
      this.lastAlpha = this.interpolate ? this.accumulator / dt : 1;
    }
    this.sync();
    return steps;
  }

  /** Runs exactly one fixed step and dispatches its events. Does not touch meshes; call `sync()` to write them. */
  step(): void {
    const world = this.world, dt = this.fixedTimestep;
    this.emit('beforestep', dt);
    if (this.disposed) return;
    world.timestep = dt;
    world.step(this.queue, this.hooks);
    this.stepCount++;
    for (const body of this.bodies) if (body.type !== 'fixed') {
      body.snapshot();
      const p = body.pose;
      for (let i = 0; i < 7; i++) if (p[i] !== p[i + 7]) {body.restWritten = false; break;}
    }
    const events: CollisionEvent[] = [];
    this.queue.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      const bodyA = this.byCollider.get(h1), bodyB = this.byCollider.get(h2);
      if (!bodyA || !bodyB) return;
      const colliderA = world.getCollider(h1), colliderB = world.getCollider(h2);
      const sensor = !!(colliderA?.isSensor() || colliderB?.isSensor());
      events.push({type: sensor ? (started ? 'intersectionstart' : 'intersectionend') : (started ? 'contactstart' : 'contactend'), bodyA, bodyB, meshA: bodyA.mesh, meshB: bodyB.mesh, colliderA, colliderB, sensor});
    });
    for (const event of events) this.emit(event.type, event);
    this.emit('afterstep', dt);
  }

  /** Writes body poses to their meshes, interpolated by `alpha` between the last two steps. */
  sync(alpha = this.lastAlpha): void {
    if (this.disposed) return;
    if(!Number.isFinite(alpha))throw new RangeError('Invalid physics interpolation alpha');
    this.syncAlpha=this.interpolate ? Math.min(1, Math.max(0, alpha)) : 1;
    this.bodies.forEach(this.syncBody);
  }
  // A stable callback avoids creating a Set iterator during every synchronization.
  private readonly syncBody = (body:PhysicsBody):void => {
      const out=this.scratch,lerp=this.syncAlpha;
      const mesh = body.mesh;
      if (!mesh || body.restWritten || (body.type === 'fixed' && !body.dirty)) return;
      try {mesh.check();} catch {this.removeBody(body); return;}
      if (parentOf(mesh) !== -1) throw new Error('Physics bodies need root-level meshes; this mesh was given a parent after its body was created');
      const p = body.pose;
      const position=this.positionScratch;position[0]=p[0]+(p[7]-p[0])*lerp;position[1]=p[1]+(p[8]-p[1])*lerp;position[2]=p[2]+(p[9]-p[2])*lerp;
      mesh.setPosition(position);
      slerp(p, 3, 10, lerp, out);
      if(mesh instanceof CoreMesh){
        // Frozen core's setQuaternion maps a fresh array; synchronize through its extension storage.
        const runtime=meshRuntime(mesh),t=runtime.engine.store.transforms,id=runtime.id,x=out[0],y=out[1],z=out[2],w=out[3];
        if(!Number.isFinite(Math.fround(x))||!Number.isFinite(Math.fround(y))||!Number.isFinite(Math.fround(z))||!Number.isFinite(Math.fround(w)))throw new RangeError('Invalid physics quaternion');
        t.qx[id]=x;t.qy[id]=y;t.qz[id]=z;t.qw[id]=w;
        runtime.euler[1]=Math.asin(Math.max(-1,Math.min(1,2*(x*z+w*y))));
        runtime.euler[0]=Math.atan2(2*(w*x-y*z),1-2*(x*x+y*y));runtime.euler[2]=Math.atan2(2*(w*z-x*y),1-2*(y*y+z*z));
      }else mesh.setQuaternion(out);
      body.dirty = false;
      body.restWritten = p[0] === p[7] && p[1] === p[8] && p[2] === p[9] && p[3] === p[10] && p[4] === p[11] && p[5] === p[12] && p[6] === p[13];
  };

  /**
   * Creates a rigid body, optionally driving `mesh`. The mesh must be root-level (no parent): physics works
   * in world space and writes world poses straight into the mesh's local transform.
   */
  addBody(mesh: Mesh | null, options: BodyOptions = {}): PhysicsBody {
    const world = this.world, R = this.rapier, type: BodyType = options.type ?? 'dynamic';
    if (mesh) {
      mesh.check();
      if (mesh instanceof CoreMesh && this.engine && meshRuntime(mesh).engine !== this.engine) throw new TypeError('Physics mesh belongs to another engine');
      if (this.byMesh.has(mesh)) throw new Error('This mesh already has a physics body');
      if (parentOf(mesh) !== -1) throw new Error('Physics bodies need root-level meshes (mesh.setParent(null)); physics works in world space');
    }
    const factory = {dynamic: 'dynamic', fixed: 'fixed', kinematicPosition: 'kinematicPositionBased', kinematicVelocity: 'kinematicVelocityBased'}[type];
    if (!factory) throw new TypeError(`Unknown body type ${type}`);
    const desc = R.RigidBodyDesc[factory]();
    const position = options.position ?? (mesh ? [mesh.position.x, mesh.position.y, mesh.position.z] as const : [0, 0, 0] as const);
    checkVec(position, 'Position');
    const rotation: Quat = options.rotation ?? (mesh ? eulerToQuat(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z) : [0, 0, 0, 1]);
    desc.setTranslation(position[0], position[1], position[2]).setRotation(quat(rotation));
    if (options.linearVelocity) {checkVec(options.linearVelocity, 'linearVelocity'); desc.setLinvel(...options.linearVelocity);}
    if (options.angularVelocity) {checkVec(options.angularVelocity, 'angularVelocity'); desc.setAngvel(vec(options.angularVelocity));}
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
    this.bodies.add(body);
    if (mesh) this.byMesh.set(mesh, body);
    const colliders = options.colliders === undefined ? (mesh ? [{shape: 'box'} as ColliderOptions] : []) : Array.isArray(options.colliders) ? options.colliders : [options.colliders as ColliderOptions];
    try {for (const collider of colliders) this.addCollider(body, collider);}
    catch (error) {this.removeBody(body); throw error;}
    return body;
  }

  /** The body driving `mesh`, if any. */
  bodyOf(mesh: Mesh): PhysicsBody | undefined {return this.byMesh.get(mesh);}
  /** The body owning a Rapier collider or collider handle. */
  bodyOfCollider(collider: any): PhysicsBody | undefined {return this.byCollider.get(typeof collider === 'number' ? collider : collider?.handle);}
  getBodies(): PhysicsBody[] {return [...this.bodies];}

  /** @internal use `body.addCollider`. */
  addCollider(body: PhysicsBody, options: ColliderOptions): any {
    const R = this.rapier, mesh = body.mesh;
    const needsGeometry = options.shape === 'box' && !options.halfExtents || options.shape === 'sphere' && options.radius === undefined || options.shape === 'convexHull' && !options.points && !options.geometry || options.shape === 'trimesh' && !options.vertices && !options.geometry;
    const fit = mesh && needsGeometry ? colliderGeometry(mesh) : {geometry: null, scale: mesh ? [mesh.scale.x, mesh.scale.y, mesh.scale.z] as const : [1, 1, 1] as const};
    const {desc, center} = createColliderDesc(R, options, fit);
    configureCollider(R, desc, options, center, !!this.hooks);
    const collider = this.world.createCollider(desc, body.raw);
    body.colliders.push(collider);
    this.byCollider.set(collider.handle, body);
    return collider;
  }
  /** @internal use `body.removeCollider`. */
  removeCollider(body: PhysicsBody, collider: any): void {
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
    if (!this.bodies.has(bodyA) || !this.bodies.has(bodyB)) throw new Error('Both bodies must belong to this physics world');
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
    if (!this.disposed) this.worldRef.removeCharacterController(controller.raw);
  }

  /** Subscribes to collision or step events. Returns an unsubscribe function. */
  on<K extends keyof PhysicsEventMap>(type: K, listener: (event: PhysicsEventMap[K]) => void): () => void {
    if (this.disposed) return noop;
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, set = new Set());
    set.add(listener);
    return () => {set!.delete(listener);};
  }
  private emit<K extends keyof PhysicsEventMap>(type: K, event: PhysicsEventMap[K]): void {
    const set = this.listeners.get(type);
    if (set) for (const listener of [...set]) listener(event);
  }

  // Scene queries. All positions and directions are world space.
  private filterArgs(filter: QueryFilter = {}): [number | undefined, number | undefined, undefined, any, ((collider: any) => boolean) | undefined] {
    const F = this.rapier.QueryFilterFlags;
    let flags = 0;
    if (filter.excludeSensors) flags |= F.EXCLUDE_SENSORS;
    if (filter.excludeFixed) flags |= F.EXCLUDE_FIXED;
    if (filter.excludeKinematic) flags |= F.EXCLUDE_KINEMATIC;
    if (filter.excludeDynamic) flags |= F.EXCLUDE_DYNAMIC;
    const predicate = filter.predicate;
    return [flags || undefined, filter.groups, undefined, filter.exclude?.raw,
      collider => {const body = this.byCollider.get(collider.handle); return !!body && (!predicate || predicate(body, collider));}];
  }
  private hit(collider: any): Hit | null {
    const body = this.byCollider.get(collider.handle);
    return body ? {body, mesh: body.mesh, collider} : null;
  }
  private ray(origin: Vec3, direction: Vec3): {ray: any; dir: [number, number, number]} {
    checkVec(origin, 'Ray origin'); checkVec(direction, 'Ray direction');
    const length = Math.hypot(...direction);
    if (!length) throw new RangeError('Ray direction must be nonzero');
    const dir: [number, number, number] = [direction[0] / length, direction[1] / length, direction[2] / length];
    return {ray: new this.rapier.Ray(vec(origin), vec(dir)), dir};
  }

  /** First hit along a ray, or null. */
  raycast(origin: Vec3, direction: Vec3, options: RaycastOptions = {}): RaycastHit | null {
    const {ray, dir} = this.ray(origin, direction);
    const result = this.world.castRayAndGetNormal(ray, options.maxDistance ?? 1e30, options.solid ?? true, ...this.filterArgs(options));
    if (!result) return null;
    const base = this.hit(result.collider);
    if (!base) return null;
    const t = result.timeOfImpact;
    return {...base, distance: t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], normal: tuple(result.normal)};
  }

  /** Every hit along a ray, nearest first. */
  raycastAll(origin: Vec3, direction: Vec3, options: RaycastOptions = {}): RaycastHit[] {
    const {ray, dir} = this.ray(origin, direction), hits: RaycastHit[] = [];
    const [flags, groups, , excludeBody, predicate] = this.filterArgs(options);
    this.world.intersectionsWithRay(ray, options.maxDistance ?? 1e30, options.solid ?? true, (result: any) => {
      const base = this.hit(result.collider), t = result.timeOfImpact;
      if (base) hits.push({...base, distance: t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], normal: tuple(result.normal)});
      return true;
    }, flags, groups, undefined, excludeBody, predicate);
    return hits.sort((a, b) => a.distance - b.distance);
  }

  /** Sweeps a shape from `position` along `direction` and returns the first hit, or null. */
  shapeCast(shape: ShapeOptions, position: Vec3, rotation: Quat, direction: Vec3, options: QueryFilter & {maxDistance?: number; targetDistance?: number; stopAtPenetration?: boolean} = {}): ShapeCastHit | null {
    checkVec(position, 'Shape position');
    const {dir} = this.ray(position, direction);
    const query = createColliderDesc(this.rapier, shape).desc.shape;
    const result = this.world.castShape(vec(position), quat(rotation), vec(dir), query, options.targetDistance ?? 0, options.maxDistance ?? 1e30, options.stopAtPenetration ?? true, ...this.filterArgs(options));
    if (!result) return null;
    const base = this.hit(result.collider);
    return base ? {...base, distance: result.time_of_impact, point: tuple(result.witness1), normal: tuple(result.normal1)} : null;
  }

  /** Closest point on any collider to `point`, or null. */
  projectPoint(point: Vec3, options: QueryFilter & {solid?: boolean} = {}): PointProjection | null {
    checkVec(point, 'Point');
    const result = this.world.projectPoint(vec(point), options.solid ?? true, ...this.filterArgs(options));
    if (!result) return null;
    const base = this.hit(result.collider);
    if (!base) return null;
    const projected = tuple(result.point);
    return {...base, point: projected, inside: result.isInside, distance: result.isInside ? 0 : Math.hypot(projected[0] - point[0], projected[1] - point[1], projected[2] - point[2])};
  }

  /** Bodies whose colliders contain `point`. */
  intersectPoint(point: Vec3, options: QueryFilter = {}): PhysicsBody[] {
    checkVec(point, 'Point');
    const found = new Set<PhysicsBody>(), [flags, groups, , excludeBody, predicate] = this.filterArgs(options);
    this.world.intersectionsWithPoint(vec(point), (collider: any) => {const body = this.byCollider.get(collider.handle); if (body) found.add(body); return true;}, flags, groups, undefined, excludeBody, predicate);
    return [...found];
  }

  /** Bodies whose colliders overlap a shape placed at `position` and `rotation`. */
  intersectShape(shape: ShapeOptions, position: Vec3, rotation: Quat = [0, 0, 0, 1], options: QueryFilter = {}): PhysicsBody[] {
    checkVec(position, 'Shape position');
    const query = createColliderDesc(this.rapier, shape).desc.shape, found = new Set<PhysicsBody>(), [flags, groups, , excludeBody, predicate] = this.filterArgs(options);
    this.world.intersectionsWithShape(vec(position), quat(rotation), query, (collider: any) => {const body = this.byCollider.get(collider.handle); if (body) found.add(body); return true;}, flags, groups, undefined, excludeBody, predicate);
    return [...found];
  }

  /** Whether two bodies' colliders currently touch (contact) or overlap (sensor), as of the last step. */
  touching(a: PhysicsBody, b: PhysicsBody): boolean {
    const world = this.world;
    for (const ca of a.colliders) for (const cb of b.colliders) {
      if (ca.isSensor() || cb.isSensor()) {if (world.intersectionPair(ca, cb)) return true; continue;}
      let touching = false;
      world.contactPair(ca, cb, (manifold: any) => {if (manifold.numContacts() > 0) touching = true;});
      if (touching) return true;
    }
    return false;
  }

  /**
   * Rapier's debug line buffers: `vertices` (xyz pairs, one segment per pair) and `colors` (rgba per vertex).
   * Draw them with `@margoengine/lines`: `new Line({mode: 'segments', positions: vertices, colors})`.
   */
  debugRender(): {vertices: Float32Array; colors: Float32Array} {
    const buffers = this.world.debugRender();
    return {vertices: buffers.vertices, colors: buffers.colors};
  }

  /** Frees every controller, joint, collider, body and the world. Detaches from the engine if attached. */
  dispose(): void {
    if (this.disposed) return;
    const engine = this.engine;
    if (engine && !engine.disposed && engine.hasPlugin(this.name)) {
      // removePlugin calls back into dispose() after unregistering.
      try {engine.removePlugin(this.name); return;} catch {/* engine is tearing down; free below */}
    }
    for (const controller of [...this.controllers]) controller.dispose();
    for (const joint of [...this.joints]) this.removeJoint(joint);
    for (const body of [...this.bodies]) this.removeBody(body);
    this.listeners.clear();
    this.queue.free();
    this.worldRef.free();
    this.disposed = true;
    this.engine = null;
    this.queue = this.worldRef = this.hooks = null;
  }
}

function parentOf(mesh: Mesh): number {
  const runtime = meshRuntime(mesh) as unknown as {id?: number; engine?: {store?: {parents?: ArrayLike<number>}}};
  const parents = runtime.engine?.store?.parents;
  return parents && runtime.id !== undefined ? parents[runtime.id] : -1;
}

/** Static bind-pose triangle data from optional PBR loaders; never attach a second core draw geometry. */
function primitiveGeometry(mesh: Mesh): GeometryLike | null {
  const triangles = meshTriangles(meshRuntime(mesh));
  if (!triangles) return null;
  if (triangles.kind === 'core') return triangles.geometry;
  if (triangles.source.skinned || triangles.source.morphed) throw new Error('Skinned mesh needs an explicit collider');
  const {primitives} = triangles.source;
  if (!primitives.length) return null;
  let vertexCount = 0, indexCount = 0;
  for (const primitive of primitives) {
    if (primitive.vertices.length % 20) throw new RangeError('PBR vertex array length is not a multiple of its stride');
    vertexCount += primitive.vertices.length / 20;
    indexCount += primitive.indices.length;
  }
  const vertices = new Float32Array(vertexCount * 3), indices = new Uint32Array(indexCount);
  let vertexOffset = 0, indexOffset = 0;
  for (const primitive of primitives) {
    const count = primitive.vertices.length / 20;
    for (let i = 0; i < count; i++) vertices.set(primitive.vertices.subarray(i * 20, i * 20 + 3), (vertexOffset + i) * 3);
    for (const index of primitive.indices) indices[indexOffset++] = vertexOffset + index;
    vertexOffset += count;
  }
  return {vertices, indices, stride: 3};
}

/** Fit a geometry-free root to its static descendants without altering the hierarchy. */
function colliderGeometry(mesh: Mesh): {geometry: GeometryLike; scale: Vec3} {
  const direct = primitiveGeometry(mesh);
  if (direct) return {geometry: direct, scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z]};
  const root = meshRuntime(mesh), engine = root.engine;
  if (!engine.meshes || !engine.store.tick) throw new Error('No geometry');
  engine.store.tick(false);
  const sources: {node: CoreMesh; positions: Float32Array; indices: ArrayLike<number>}[] = [];
  let vertexCount = 0, indexCount = 0;
  for (const node of engine.meshes.values()) {
    let ancestor = engine.store.parents[node.id], depth = 0;
    while (ancestor !== -1 && ancestor !== root.id && depth++ < 64) ancestor = engine.store.parents[ancestor];
    if (ancestor !== root.id) continue;
    const geometry = primitiveGeometry(node);
    if (!geometry) continue;
    const positions = geometryPositions(geometry);
    if (!positions.length || !geometry.indices?.length) continue;
    sources.push({node, positions, indices: geometry.indices});
    vertexCount += positions.length / 3;
    indexCount += geometry.indices.length;
  }
  if (!vertexCount) throw new Error('No geometry');

  const vertices = new Float32Array(vertexCount * 3), indices = new Uint32Array(indexCount);
  const [qx, qy, qz, qw] = eulerToQuat(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z);
  const px = mesh.position.x, py = mesh.position.y, pz = mesh.position.z;
  let vertexOffset = 0, indexOffset = 0;
  for (const {node, positions, indices: sourceIndices} of sources) {
    const m = node.matrix;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12] - px;
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13] - py;
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14] - pz;
      // Invert the body's rigid pose, not its scaled world matrix: Rapier has no body scale.
      // The descendant world matrix already includes every scale, including the root's, once.
      const tx = -2 * (qy * wz - qz * wy), ty = -2 * (qz * wx - qx * wz), tz = -2 * (qx * wy - qy * wx);
      const offset = vertexOffset * 3 + i;
      vertices[offset] = wx + qw * tx - qy * tz + qz * ty;
      vertices[offset + 1] = wy + qw * ty - qz * tx + qx * tz;
      vertices[offset + 2] = wz + qw * tz - qx * ty + qy * tx;
      if (!Number.isFinite(vertices[offset]) || !Number.isFinite(vertices[offset + 1]) || !Number.isFinite(vertices[offset + 2])) throw new RangeError('Geometry positions must be finite');
    }
    for (let i = 0; i < sourceIndices.length; i++) indices[indexOffset++] = vertexOffset + sourceIndices[i];
    vertexOffset += positions.length / 3;
  }
  return {geometry: {vertices, indices, stride: 3}, scale: [1, 1, 1]};
}
