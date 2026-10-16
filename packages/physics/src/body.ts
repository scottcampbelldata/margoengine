import type { Collider, RigidBody, World } from './rapier-types.js';
import type { Mesh } from '@margoengine/core';
import { checkVec, quat, tuple, tuple4, vec, type Quat, type Vec3 } from './math.js';
import type { ColliderOptions, RapierModule } from './shapes.js';

export type BodyType = 'dynamic' | 'fixed' | 'kinematicPosition' | 'kinematicVelocity';

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
  dominance?: number;
  userData?: unknown;
}

/** Internal hooks the body needs from its world. */
export interface BodyOwner {
  readonly rapier: RapierModule;
  readonly world: World;
  addCollider(body: PhysicsBody, options: ColliderOptions): Collider;
  removeCollider(body: PhysicsBody, collider: Collider): void;
  removeBody(body: PhysicsBody): void;
}

/** A Rapier rigid body bound to an optional core mesh. */
export class PhysicsBody {
  /** The colliders attached to this body (Rapier `Collider` objects). */
  readonly colliders: Collider[] = [];
  userData: unknown;
  /** @internal previous (0..6) and current (7..13) step poses, xyz + quaternion. */
  readonly pose = new Float64Array(14);
  /** @internal */
  restWritten = false;
  /** @internal Tracks the preceding physics sleep state. */
  slept = false;
  /** @internal World scale captured for a body attached to a child mesh. */
  fitScale?: [number, number, number];
  /** @internal */
  dirty = true;
  private removed = false;

  /** @internal */
  constructor(
    private readonly owner: BodyOwner,
    readonly raw: RigidBody,
    readonly mesh: Mesh | null,
    readonly type: BodyType,
  ) {
    this.snapshot(true);
  }

  get valid(): boolean {
    return !this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
    this.colliders.length = 0;
  }
  private check(): RigidBody {
    if (this.removed) throw new Error('Physics body was removed');
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
  addCollider(options: ColliderOptions): Collider {
    this.check();
    return this.owner.addCollider(this, options);
  }
  removeCollider(collider: Collider): void {
    this.check();
    this.owner.removeCollider(this, collider);
  }
  /** Removes the body and its colliders and joints from the world. The mesh is left where it is. */
  remove(): void {
    if (!this.removed) this.owner.removeBody(this);
  }
}
