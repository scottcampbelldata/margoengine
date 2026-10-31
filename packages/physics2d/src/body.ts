import { MargoError } from '@margoengine/math/errors';
import type { Collider2D, RapierModule2D, RigidBody2D, World2D } from './rapier-types.js';
import type { ColliderOptions2D, Vec2D } from './shapes.js';

/** How a body moves: `dynamic` (simulated), `fixed`, or kinematic (driven by position or by velocity). */
export type BodyType2D = 'dynamic' | 'fixed' | 'kinematicPosition' | 'kinematicVelocity';

/** Anything with a position and a rotation in world units and radians: a `Sprite` from `@margoengine/sprites` fits. */
export interface SpriteLike {
  x: number;
  y: number;
  rotation: number;
  /** With `rect`, the default collider is a box of that size around the pivot. */
  readonly rect?: readonly [number, number, number, number];
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
}

/** Options for adding a body; every field has a default. */
export interface BodyOptions2D {
  /** Default 'dynamic'. */
  type?: BodyType2D;
  /** World2D position. Defaults to the sprite's position, or [0, 0]. */
  position?: Vec2D;
  /** Radians, clockwise on screen. Defaults to the sprite's rotation, or 0. */
  rotation?: number;
  /** One or more colliders. Without any, a box fitted to the sprite's `rect`, else none. */
  colliders?: ColliderOptions2D | readonly ColliderOptions2D[];
  linearVelocity?: Vec2D;
  angularVelocity?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  /** Continuous collision detection for fast bodies. */
  ccd?: boolean;
  canSleep?: boolean;
  lockRotation?: boolean;
  userData?: unknown;
}

/** @internal What a body needs from its world. */
export interface BodyOwner2D {
  readonly rapier: RapierModule2D;
  readonly world: World2D;
  readonly scale: number;
  addCollider(body: Body2D, options: ColliderOptions2D): Collider2D;
  /** @internal Queries must refresh Rapier's broad phase before the next answer. */
  markStale(): void;
  removeBody(body: Body2D): void;
}

/** A Rapier rigid body bound to an optional sprite. Positions are in world units, y down. */
export class Body2D {
  /** The Rapier colliders attached to this body. */
  readonly colliders: Collider2D[] = [];
  userData: unknown;
  /** @internal previous (0..2) and current (3..5) step poses: x, y, angle. */
  readonly pose = new Float64Array(6);
  /** @internal */
  dirty = true;
  private removed = false;

  /** @internal */
  constructor(
    private readonly owner: BodyOwner2D,
    readonly raw: RigidBody2D,
    readonly sprite: SpriteLike | null,
    readonly type: BodyType2D,
  ) {
    this.snapshot();
    this.pose.copyWithin(0, 3, 6);
  }

  /** @internal Stores the current pose as the newest step. */
  snapshot(): void {
    const p = this.pose,
      t = this.raw.translation(),
      k = 1 / this.owner.scale;
    p.copyWithin(0, 3, 6);
    p[3] = t.x * k;
    p[4] = t.y * k;
    p[5] = this.raw.rotation();
  }
  private check(): void {
    if (this.removed) throw new MargoError('state', 'Body2D was removed; add a new body with Physics2D.addBody.');
  }
  get isRemoved(): boolean {
    return this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  /** Position at the latest step. */
  get position(): [number, number] {
    this.check();
    return [this.pose[3], this.pose[4]];
  }
  /** Rotation at the latest step, radians. */
  get rotation(): number {
    this.check();
    return this.pose[5];
  }
  /** Moves the body now with no interpolation sweep. For a kinematic position body, use `moveTo`. */
  teleport(position: Vec2D, rotation?: number): this {
    this.check();
    const k = this.owner.scale;
    this.raw.setTranslation({ x: position[0] * k, y: position[1] * k }, true);
    if (rotation !== undefined) this.raw.setRotation(rotation, true);
    this.snapshot();
    this.pose.copyWithin(0, 3, 6);
    this.dirty = true;
    this.owner.markStale();
    return this;
  }
  /** Sets where a kinematic position body should be after the next step. */
  moveTo(position: Vec2D, rotation?: number): this {
    this.check();
    const k = this.owner.scale;
    this.raw.setNextKinematicTranslation({ x: position[0] * k, y: position[1] * k });
    if (rotation !== undefined) this.raw.setNextKinematicRotation(rotation);
    return this;
  }
  /** Velocity in world units per second. */
  get linearVelocity(): [number, number] {
    this.check();
    const v = this.raw.linvel(),
      k = 1 / this.owner.scale;
    return [v.x * k, v.y * k];
  }
  set linearVelocity(value: Vec2D) {
    this.check();
    this.raw.setLinvel({ x: value[0] * this.owner.scale, y: value[1] * this.owner.scale }, true);
  }
  /** Radians per second. */
  get angularVelocity(): number {
    this.check();
    return this.raw.angvel();
  }
  set angularVelocity(value: number) {
    this.check();
    this.raw.setAngvel(value, true);
  }
  /** Impulse in Rapier units (kilogram metres per second); a body of mass m gains impulse / m metres per second. */
  applyImpulse(impulse: Vec2D): this {
    this.check();
    this.raw.applyImpulse({ x: impulse[0], y: impulse[1] }, true);
    return this;
  }
  applyTorqueImpulse(torque: number): this {
    this.check();
    this.raw.applyTorqueImpulse(torque, true);
    return this;
  }
  /** Force in Rapier units (newtons), held until reset: call it every step you want it applied. */
  applyForce(force: Vec2D): this {
    this.check();
    this.raw.addForce({ x: force[0], y: force[1] }, true);
    return this;
  }
  get mass(): number {
    return this.raw.mass();
  }
  get sleeping(): boolean {
    return this.raw.isSleeping();
  }
  wakeUp(): this {
    this.raw.wakeUp();
    return this;
  }
  /** Adds a collider. */
  addCollider(options: ColliderOptions2D): Collider2D {
    this.check();
    return this.owner.addCollider(this, options);
  }
  /** Removes the body, its colliders and its joints from the world. */
  remove(): void {
    this.owner.removeBody(this);
  }
}
