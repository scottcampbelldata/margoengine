import { MargoError } from '@margoengine/math/errors';
import type { RigidBody, World } from './rapier-types.js';
import type { PhysicsCollider } from './collider.js';
import type { Mesh } from '@margoengine/core';
import { checkVec, quat, tuple, tuple4, vec, type Quat, type Vec3 } from './math.js';
import type { ColliderOptions, RapierModule } from './shapes.js';

/** How a body moves: `dynamic` (simulated), `fixed`, or kinematic (driven by position or by velocity). */
export type BodyType = 'dynamic' | 'fixed' | 'kinematicPosition' | 'kinematicVelocity';

const RAPIER_BODY_TYPES = {
  dynamic: 'Dynamic',
  fixed: 'Fixed',
  kinematicPosition: 'KinematicPositionBased',
  kinematicVelocity: 'KinematicVelocityBased',
} as const;

/** Options for adding a rigid body; every field has a default. */
export interface BodyOptions {
  /** Default 'dynamic'. */
  type?: BodyType;
  /** World position. Defaults to the mesh position (or the origin without a mesh). */
  position?: Vec3;
  /** World rotation quaternion [x, y, z, w]. Defaults to the mesh rotation. */
  rotation?: Quat;
  /** One or more colliders. Defaults to a box fitted to static mesh geometry, or a geometry-free root's descendants; pass [] for none. */
  colliders?: ColliderOptions | readonly ColliderOptions[];
  linearVelocity?: Vec3;
  angularVelocity?: Vec3;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  /** Continuous collision detection for fast bodies. */
  ccd?: boolean;
  canSleep?: boolean;
  sleeping?: boolean;
  lockRotations?: boolean;
  lockTranslations?: boolean;
  /** Per-axis rotation freedom, for example [false, true, false] to only spin around Y. */
  enabledRotations?: readonly [boolean, boolean, boolean];
  enabledTranslations?: readonly [boolean, boolean, boolean];
  /** Mass added on top of what the colliders contribute. */
  additionalMass?: number;
  /**
   * `kinematicPosition` bodies on a core mesh: the mesh drives the body. Before each step the body takes the mesh's
   * world pose as its target, at any depth of the hierarchy, and nothing is written back: a moving or animated part of a
   * model that pushes what it touches. Default false.
   */
  follow?: boolean;
  dominance?: number;
  userData?: unknown;
}

/** Internal hooks the body needs from its world. */
export interface BodyOwner {
  readonly rapier: RapierModule;
  readonly world: World;
  addCollider(body: PhysicsBody, options: ColliderOptions): PhysicsCollider;
  removeCollider(body: PhysicsBody, collider: PhysicsCollider): void;
  removeBody(body: PhysicsBody): void;
}

/** A Rapier rigid body bound to an optional core mesh. */
export class PhysicsBody {
  /** The colliders attached to this body. */
  readonly colliders: PhysicsCollider[] = [];
  userData: unknown;
  /** @internal previous (0..6) and current (7..13) step poses, xyz + quaternion. */
  readonly pose = new Float64Array(14);
  /** @internal */
  restWritten = false;
  /** @internal Tracks the preceding physics sleep state. */
  slept = false;
  /** @internal World scale captured for a body attached to a child mesh. */
  fitScale?: [number, number, number];
  /** @internal The mesh drives this body; see {@link BodyOptions.follow}. */
  follow = false;
  /** @internal Parents above the mesh at the last sync, so a parent's body is written before its child's. */
  depth = 0;
  /** @internal */
  dirty = true;
  private removed = false;
  private kind: BodyType;

  /** @internal */
  constructor(
    private readonly owner: BodyOwner,
    readonly raw: RigidBody,
    readonly mesh: Mesh | null,
    type: BodyType,
  ) {
    this.kind = type;
    this.snapshot(true);
  }
  /** How the body moves now; change it with {@link PhysicsBody.setType}. */
  get type(): BodyType {
    return this.kind;
  }
  /**
   * Switches how the body moves, keeping its pose, colliders and joints: a ragdoll going limp (`'dynamic'`) or back
   * under animation (`'kinematicPosition'`), a door that unlocks. Rapier keeps the velocity a dynamic body had; set
   * it with `setLinearVelocity` when the body was kinematic. A character controller's body must stay
   * `'kinematicPosition'`.
   */
  setType(type: BodyType, wakeUp = true): this {
    const raw = this.check();
    if (typeof type !== 'string' || !Object.hasOwn(RAPIER_BODY_TYPES, type))
      throw new TypeError(`Unknown body type ${type}; use dynamic, fixed, kinematicPosition or kinematicVelocity.`);
    if (type === this.kind) return this;
    raw.setBodyType(this.owner.rapier.RigidBodyType[RAPIER_BODY_TYPES[type]], wakeUp);
    this.kind = type;
    this.dirty = true;
    this.restWritten = false;
    this.slept = false;
    return this;
  }

  get valid(): boolean {
    return !this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
    for (const collider of this.colliders) collider.markRemoved();
    this.colliders.length = 0;
  }
  private check(): RigidBody {
    if (this.removed) throw new MargoError('state', 'Physics body was removed; add a new body with physics.addBody.');
    return this.raw;
  }

  /** @internal copies the current Rapier pose into the interpolation buffer. */
  snapshot(reset = false): void {
    const p = this.pose,
      t = this.raw.translation(),
      r = this.raw.rotation();
    if (!reset) p.copyWithin(0, 7, 14);
    p[7] = t.x;
    p[8] = t.y;
    p[9] = t.z;
    p[10] = r.x;
    p[11] = r.y;
    p[12] = r.z;
    p[13] = r.w;
    if (reset) p.copyWithin(0, 7, 14);
  }

  /** Current physics position (end of the last step, not interpolated). */
  get position(): [number, number, number] {
    return tuple(this.check().translation());
  }
  /** Current physics rotation quaternion [x, y, z, w]. */
  get rotation(): [number, number, number, number] {
    return tuple4(this.check().rotation());
  }
  /** Teleports the body. Interpolation restarts from the new pose so it does not streak. */
  setPosition(position: Vec3, wakeUp = true): this {
    checkVec(position, 'Position');
    this.check().setTranslation(vec(position), wakeUp);
    this.snapshot(true);
    this.dirty = true;
    this.restWritten = false;
    return this;
  }
  setRotation(rotation: Quat, wakeUp = true): this {
    this.check().setRotation(quat(rotation), wakeUp);
    this.snapshot(true);
    this.dirty = true;
    this.restWritten = false;
    return this;
  }
  /** Kinematic position-based bodies: the pose to reach at the end of the next step. */
  setNextPosition(position: Vec3): this {
    checkVec(position, 'Position');
    this.check().setNextKinematicTranslation(vec(position));
    return this;
  }
  setNextRotation(rotation: Quat): this {
    this.check().setNextKinematicRotation(quat(rotation));
    return this;
  }

  get linearVelocity(): [number, number, number] {
    return tuple(this.check().linvel());
  }
  setLinearVelocity(velocity: Vec3, wakeUp = true): this {
    checkVec(velocity, 'Velocity');
    this.check().setLinvel(vec(velocity), wakeUp);
    return this;
  }
  get angularVelocity(): [number, number, number] {
    return tuple(this.check().angvel());
  }
  setAngularVelocity(velocity: Vec3, wakeUp = true): this {
    checkVec(velocity, 'Angular velocity');
    this.check().setAngvel(vec(velocity), wakeUp);
    return this;
  }

  /** Adds a force (persists across steps until `resetForces`), optionally at a world point. */
  addForce(force: Vec3, point?: Vec3, wakeUp = true): this {
    checkVec(force, 'Force');
    if (point) {
      checkVec(point, 'Point');
      this.check().addForceAtPoint(vec(force), vec(point), wakeUp);
    } else this.check().addForce(vec(force), wakeUp);
    return this;
  }
  /** Applies an instantaneous impulse, optionally at a world point. */
  applyImpulse(impulse: Vec3, point?: Vec3, wakeUp = true): this {
    checkVec(impulse, 'Impulse');
    if (point) {
      checkVec(point, 'Point');
      this.check().applyImpulseAtPoint(vec(impulse), vec(point), wakeUp);
    } else this.check().applyImpulse(vec(impulse), wakeUp);
    return this;
  }
  addTorque(torque: Vec3, wakeUp = true): this {
    checkVec(torque, 'Torque');
    this.check().addTorque(vec(torque), wakeUp);
    return this;
  }
  applyTorqueImpulse(torque: Vec3, wakeUp = true): this {
    checkVec(torque, 'Torque impulse');
    this.check().applyTorqueImpulse(vec(torque), wakeUp);
    return this;
  }
  resetForces(wakeUp = true): this {
    this.check().resetForces(wakeUp);
    this.raw.resetTorques(wakeUp);
    return this;
  }

  get sleeping(): boolean {
    return this.check().isSleeping();
  }
  sleep(): this {
    this.check().sleep();
    return this;
  }
  wakeUp(): this {
    this.check().wakeUp();
    return this;
  }
  get mass(): number {
    return this.check().mass();
  }
  /**
   * Mass in kilograms and inertia in kg m² (about the body's x, y and z axes) on top of what the colliders give. Replaces
   * what an earlier call added; 0 removes it. Takes effect at the next step.
   */
  setAdditionalMass(mass: number, inertia: Vec3 = [0, 0, 0]): this {
    checkVec(inertia, 'Inertia');
    if (!(mass >= 0) || mass === Infinity || inertia.some((value) => value < 0))
      throw new RangeError('Additional mass and inertia must be finite numbers of at least 0; pass kilograms and kg m².');
    this.check().setAdditionalMassProperties(mass, this.raw.localCom(), vec(inertia), { x: 0, y: 0, z: 0, w: 1 }, true);
    return this;
  }
  /** Centre of mass in the body's frame. */
  get centerOfMass(): [number, number, number] {
    return tuple(this.check().localCom());
  }
  /** Moments of inertia in kg m² about the principal axes, which {@link PhysicsBody.inertiaFrame} turns from the body's frame. */
  get principalInertia(): [number, number, number] {
    return tuple(this.check().principalInertia());
  }
  /** Rotation of the principal axes of inertia in the body's frame, a quaternion [x, y, z, w]. */
  get inertiaFrame(): [number, number, number, number] {
    return tuple4(this.check().principalInertiaLocalFrame());
  }
  /**
   * Replaces what the colliders give with these figures, for a mass and inertia that come from a file or a measurement.
   * Any figure left out keeps the body's present value; a new `mass` alone scales the inertia with it, as a shape's does.
   * Inertia is about the axes `inertiaFrame` names, a 0 moment reads as infinite. Takes effect at once. Colliders added
   * later have density 0 of their own to set.
   */
  setMassProperties(properties: { mass?: number; centerOfMass?: Vec3; inertia?: Vec3; inertiaFrame?: Quat }): this {
    const raw = this.check(),
      { mass, centerOfMass, inertia, inertiaFrame } = properties,
      computed = raw.mass(),
      total = mass ?? computed;
    if (!(total >= 0) || total === Infinity) throw new RangeError('Mass must be a finite number of at least 0; pass kilograms.');
    if (centerOfMass) checkVec(centerOfMass, 'Centre of mass');
    if (inertia) {
      checkVec(inertia, 'Inertia');
      if (inertia.some((value) => value < 0)) throw new RangeError('Inertia must not be negative; pass kg m².');
    }
    const principal = raw.principalInertia(),
      // A shape's inertia grows with its mass.
      over = computed > 0 ? total / computed : 0;
    const center = centerOfMass ? vec(centerOfMass) : raw.localCom(),
      moments = inertia ? vec(inertia) : vec([principal.x * over, principal.y * over, principal.z * over]),
      frame = inertiaFrame ? quat(inertiaFrame) : inertia ? { x: 0, y: 0, z: 0, w: 1 } : raw.principalInertiaLocalFrame();
    for (const collider of this.colliders) collider.setDensity(0);
    raw.setAdditionalMassProperties(total, center, moments, frame, true);
    raw.recomputeMassPropertiesFromColliders();
    return this;
  }
  /** Force in newtons left on the body by `addForce`, until `resetForces`. */
  get appliedForce(): [number, number, number] {
    return tuple(this.check().userForce());
  }
  /** Torque in newton metres left on the body by `addTorque`, until `resetForces`. */
  get appliedTorque(): [number, number, number] {
    return tuple(this.check().userTorque());
  }
  /** Solver passes the island of this body takes on top of the world's `solverIterations` (default 0). */
  get additionalSolverIterations(): number {
    return this.check().additionalSolverIterations();
  }
  set additionalSolverIterations(passes: number) {
    if (!Number.isInteger(passes) || passes < 0)
      throw new RangeError('Additional solver iterations must be a whole number of at least 0; pass extra passes.');
    this.check().setAdditionalSolverIterations(passes);
  }
  get gravityScale(): number {
    return this.check().gravityScale();
  }
  set gravityScale(value: number) {
    this.check().setGravityScale(value, true);
  }
  get ccd(): boolean {
    return this.check().isCcdEnabled();
  }
  set ccd(enabled: boolean) {
    this.check().enableCcd(enabled);
  }
  get enabled(): boolean {
    return this.check().isEnabled();
  }
  set enabled(value: boolean) {
    this.check().setEnabled(value);
  }
  lockRotations(locked = true): this {
    this.check().lockRotations(locked, true);
    return this;
  }
  lockTranslations(locked = true): this {
    this.check().lockTranslations(locked, true);
    return this;
  }

  /** Attaches another collider to this body. */
  addCollider(options: ColliderOptions): PhysicsCollider {
    this.check();
    return this.owner.addCollider(this, options);
  }
  removeCollider(collider: PhysicsCollider): void {
    this.check();
    this.owner.removeCollider(this, collider);
  }
  /** Removes the body and its colliders and joints from the world. The mesh is left where it is. */
  remove(): void {
    if (!this.removed) this.owner.removeBody(this);
  }
}
