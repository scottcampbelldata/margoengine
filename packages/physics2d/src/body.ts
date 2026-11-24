import { MargoError } from '@margoengine/math/errors';
import type { Kernel, Words } from './kernel.js';
import { describeShape, type ColliderOptions2D, type Described, type Vec2D } from './shapes.js';

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
  /**
   * Soft CCD: how far ahead, in world units, the body's contacts reach, so the solver holds a fast body at what it would
   * hit one step on; set it to about the body's speed times the step. Default 0: the world's own margin, 0.02 m.
   */
  softCcd?: number;
  canSleep?: boolean;
  lockRotation?: boolean;
  /**
   * In a contact with a body of lower dominance, this body acts as if it had infinite mass. Integers from -127 to 127,
   * default 0.
   */
  dominance?: number;
  /**
   * Holds the body's translation on an axis: `true` locks both, `[x, y]` picks. The body stays where it is on a locked
   * axis and moves freely on the other (it still turns unless `lockRotation`).
   */
  lockTranslation?: boolean | readonly [boolean, boolean];
  /** Mass in kilograms added to what the colliders weigh; the body turns as a heavier body of the same build. Default 0. */
  additionalMass?: number;
  userData?: unknown;
}

/** @internal What a body needs from its world. */
export interface BodyOwner2D {
  readonly kernel: Kernel;
  readonly handle: number;
  readonly scale: number;
  addCollider(body: Body2D, options: ColliderOptions2D): Collider2D;
  removeCollider(collider: Collider2D): void;
  removeBody(body: Body2D): void;
  lockTranslation(body: Body2D, x: boolean, y: boolean): void;
  retype(body: Body2D, type: BodyType2D): void;
}

const encode = (value: number, what: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}; fix the value.`);
  return value;
};

/**
 * A collider: one or more kernel shapes (a concave polygon or a polyline is several) on a body, with the settings that
 * can change after it exists. Positions are in world units.
 */
export class Collider2D {
  /** The kernel shapes this collider is made of. @internal */
  readonly shapes: number[];
  /** The shape as the kernel was given it, for the queries a character controller makes. @internal */
  described: Described | null = null;
  private removed = false;
  private enabled = true;
  private savedGroups = 0;
  /** @internal */
  constructor(
    private readonly owner: BodyOwner2D,
    readonly body: Body2D,
    shapes: number[],
    private readonly settings: Uint32Array,
    private readonly offset: readonly [number, number],
    private readonly turn: number,
  ) {
    this.shapes = shapes;
  }
  /** The kernel's handle of its first shape: unique among live colliders. */
  get handle(): number {
    return this.shapes[0];
  }
  /** The body this collider is on. */
  parent(): Body2D {
    return this.body;
  }
  get isRemoved(): boolean {
    return this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  private push(): void {
    if (this.removed) throw new MargoError('state', 'Collider2D was removed; add a new collider with Body2D.addCollider.');
    const { kernel, handle } = this.owner;
    for (const shape of this.shapes) {
      const io = kernel.io(8);
      io.u.set(this.settings);
      kernel.ok(kernel.exports.shape_set(handle, shape));
    }
  }
  isSensor(): boolean {
    return (this.settings[5] & (1 << 16)) !== 0;
  }
  /** A sensor reports overlaps (`intersectionstart`) and pushes nothing. It also senses fixed and kinematic bodies. */
  setSensor(sensor: boolean): void {
    if (sensor === this.isSensor()) return;
    this.settings[5] = sensor ? this.settings[5] | (1 << 16) : this.settings[5] & ~(1 << 16);
    this.settings[5] = (this.settings[5] & ~0xff00) | ((sensor ? 63 : 7) << 8);
    this.push();
  }
  setFriction(value: number): void {
    new Float32Array(this.settings.buffer)[1] = encode(value, 'friction');
    this.push();
  }
  setRestitution(value: number): void {
    new Float32Array(this.settings.buffer)[2] = encode(value, 'restitution');
    this.push();
  }
  setDensity(value: number): void {
    new Float32Array(this.settings.buffer)[0] = encode(value, 'density');
    this.push();
  }
  /** Packed interaction groups, see `interactionGroups`. */
  setCollisionGroups(groups: number): void {
    if (this.enabled) this.settings[3] = groups >>> 0;
    else this.savedGroups = groups >>> 0;
    this.push();
  }
  setSolverGroups(groups: number): void {
    this.settings[4] = groups >>> 0;
    this.push();
  }
  /** A disabled collider meets nothing, reports nothing and is skipped by queries; its mass still counts. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.savedGroups = this.settings[3];
      this.settings[3] = 0;
    } else this.settings[3] = this.savedGroups;
    this.push();
  }
  get isEnabled(): boolean {
    return this.enabled;
  }
  /** The collider's centre in world units, at the body's latest step. */
  translation(): [number, number] {
    const [x, y] = this.body.position,
      a = this.body.rotation,
      c = Math.cos(a),
      s = Math.sin(a);
    return [x + c * this.offset[0] - s * this.offset[1], y + s * this.offset[0] + c * this.offset[1]];
  }
  /** The collider's rotation in radians, at the body's latest step. */
  rotation(): number {
    return this.body.rotation + this.turn;
  }
  /** Removes the collider from its body. */
  remove(): void {
    this.owner.removeCollider(this);
  }
}

/** A rigid body in the kernel, bound to an optional sprite. Positions are in world units, y down. */
export class Body2D {
  /** The colliders on this body. */
  readonly colliders: Collider2D[] = [];
  userData: unknown;
  /** @internal previous (0..2) and current (3..5) step poses: x, y, angle. */
  readonly pose = new Float64Array(6);
  /** @internal */
  dirty = true;
  private removed = false;
  private extraMass = 0;

  /** @internal */
  constructor(
    private readonly owner: BodyOwner2D,
    /** The kernel's handle. @internal */
    readonly handle: number,
    readonly sprite: SpriteLike | null,
    private kind: BodyType2D,
  ) {
    this.snapshot();
    this.pose.copyWithin(0, 3, 6);
  }

  /** @internal Stores the current pose as the newest step. */
  snapshot(): void {
    const { kernel, handle, scale } = this.owner;
    kernel.ok(kernel.exports.body_read(handle, this.handle));
    const io = kernel.io(4);
    this.store(io.f[0], io.f[1], io.f[2], io.f[3], 1 / scale);
  }
  /** @internal */
  store(x: number, y: number, c: number, s: number, k: number): void {
    const p = this.pose;
    p.copyWithin(0, 3, 6);
    p[3] = x * k;
    p[4] = y * k;
    p[5] = Math.atan2(s, c);
  }
  /** How the body moves: `dynamic`, `fixed`, `kinematicPosition` or `kinematicVelocity`. */
  get type(): BodyType2D {
    return this.kind;
  }
  /**
   * Changes how the body moves. A dynamic body is weighed again from its colliders; a fixed body stops. A body locked on an
   * axis keeps its lock only while it is dynamic or kinematic.
   */
  setType(type: BodyType2D): this {
    this.check();
    this.owner.retype(this, type);
    this.kind = type;
    return this;
  }
  /** @internal Damping, gravity scale, sleep permission, ccd and dominance as the kernel holds them. */
  params = { linearDamping: 0, angularDamping: 0, gravityScale: 1, canSleep: true, ccd: false, dominance: 0 };
  private setParams(change: Partial<Body2D['params']>): void {
    const { x, h, kernel } = this.k;
    const next = { ...this.params, ...change };
    const flags = (next.canSleep ? 1 : 0) | (next.ccd ? 4 : 0);
    if (!Number.isInteger(next.dominance) || next.dominance < -127 || next.dominance > 127)
      throw new RangeError(`dominance must be an integer from -127 to 127, got ${next.dominance}.`);
    kernel.ok(x.body_set_params(h, this.handle, encode(next.linearDamping, 'damping'), encode(next.angularDamping, 'damping'), encode(next.gravityScale, 'gravity scale'), flags, next.dominance));
    this.params = next;
  }
  get linearDamping(): number {
    return this.params.linearDamping;
  }
  set linearDamping(value: number) {
    this.setParams({ linearDamping: value });
  }
  get angularDamping(): number {
    return this.params.angularDamping;
  }
  set angularDamping(value: number) {
    this.setParams({ angularDamping: value });
  }
  get gravityScale(): number {
    return this.params.gravityScale;
  }
  set gravityScale(value: number) {
    this.setParams({ gravityScale: value });
  }
  get canSleep(): boolean {
    return this.params.canSleep;
  }
  set canSleep(value: boolean) {
    this.setParams({ canSleep: value });
  }
  /** Continuous collision for a fast body. */
  get ccd(): boolean {
    return this.params.ccd;
  }
  set ccd(value: boolean) {
    this.setParams({ ccd: value });
  }
  /** Soft CCD reach in world units, see `BodyOptions2D.softCcd`. */
  get softCcd(): number {
    return this.soft;
  }
  set softCcd(value: number) {
    const { x, h, kernel, scale } = this.k;
    kernel.ok(x.body_set_soft_ccd(h, this.handle, encode(value, 'softCcd') * scale));
    this.soft = value;
  }
  private soft = 0;
  get dominance(): number {
    return this.params.dominance;
  }
  set dominance(value: number) {
    this.setParams({ dominance: value });
  }
  private check(): void {
    if (this.removed) throw new MargoError('state', 'Body2D was removed; add a new body with Physics2D.addBody.');
  }
  private get k(): { x: Kernel['exports']; h: number; kernel: Kernel; scale: number } {
    this.check();
    const { kernel, handle, scale } = this.owner;
    return { x: kernel.exports, h: handle, kernel, scale };
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
    const { x, h, kernel, scale } = this.k;
    const a = rotation ?? this.pose[5];
    encode(position[0], 'position x');
    encode(position[1], 'position y');
    encode(a, 'rotation');
    kernel.ok(x.body_set_transform(h, this.handle, position[0] * scale, position[1] * scale, Math.cos(a), Math.sin(a)));
    this.snapshot();
    this.pose.copyWithin(0, 3, 6);
    this.dirty = true;
    if (this.locked[0] || this.locked[1]) this.owner.lockTranslation(this, this.locked[0], this.locked[1]);
    return this;
  }
  /** Sets where a kinematic position body should be after the next step. */
  moveTo(position: Vec2D, rotation?: number): this {
    const { x, h, kernel, scale } = this.k;
    const a = rotation ?? this.pose[5];
    kernel.ok(x.body_set_next(h, this.handle, position[0] * scale, position[1] * scale, Math.cos(a), Math.sin(a)));
    return this;
  }
  private read(): Words {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_read(h, this.handle));
    return kernel.io(11);
  }
  /** Velocity in world units per second. */
  get linearVelocity(): [number, number] {
    const { f } = this.read(),
      k = 1 / this.owner.scale;
    return [f[4] * k, f[5] * k];
  }
  set linearVelocity(value: Vec2D) {
    const { x, h, kernel, scale } = this.k;
    const av = this.read().f[6];
    kernel.ok(x.body_set_velocity(h, this.handle, encode(value[0], 'velocity x') * scale, encode(value[1], 'velocity y') * scale, av));
  }
  /** Radians per second. */
  get angularVelocity(): number {
    return this.read().f[6];
  }
  set angularVelocity(value: number) {
    const { x, h, kernel } = this.k;
    const { f } = this.read();
    kernel.ok(x.body_set_velocity(h, this.handle, f[4], f[5], encode(value, 'angular velocity')));
  }
  /** Impulse in kernel units (kilogram metres per second); a body of mass m gains impulse / m metres per second. */
  applyImpulse(impulse: Vec2D): this {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_impulse(h, this.handle, encode(impulse[0], 'impulse x'), encode(impulse[1], 'impulse y'), 0, 0, 0));
    return this;
  }
  /** Impulse applied at a world point (world units), which also spins the body. */
  applyImpulseAtPoint(impulse: Vec2D, point: Vec2D): this {
    const { x, h, kernel, scale } = this.k;
    kernel.ok(
      x.body_impulse(h, this.handle, encode(impulse[0], 'impulse x'), encode(impulse[1], 'impulse y'), 1, point[0] * scale, point[1] * scale),
    );
    return this;
  }
  applyTorqueImpulse(torque: number): this {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_torque_impulse(h, this.handle, encode(torque, 'torque impulse')));
    return this;
  }
  /** Force in kernel units (newtons), held until `resetForces`: it acts every step. */
  applyForce(force: Vec2D): this {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_add_force(h, this.handle, encode(force[0], 'force x'), encode(force[1], 'force y'), 0));
    return this;
  }
  /** A torque held until `resetForces`. */
  applyTorque(torque: number): this {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_add_force(h, this.handle, 0, 0, encode(torque, 'torque')));
    return this;
  }
  /** Clears the forces and torques that act every step. */
  resetForces(): this {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_reset_forces(h, this.handle));
    return this;
  }
  get mass(): number {
    return this.read().f[7];
  }
  /** @internal The added mass a restored snapshot carries. */
  restoreAdditionalMass(value: number): void {
    this.extraMass = value;
  }
  /** Mass added to what the colliders weigh, in kilograms. */
  get additionalMass(): number {
    return this.extraMass;
  }
  set additionalMass(value: number) {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_set_additional_mass(h, this.handle, encode(value, 'additional mass')));
    this.extraMass = value;
  }
  get sleeping(): boolean {
    return this.read().u[8] === 0;
  }
  wakeUp(): this {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_wake(h, this.handle));
    return this;
  }
  /** Puts the body to sleep now; a contact or a call to `wakeUp` wakes it. */
  sleep(): this {
    const { x, h, kernel } = this.k;
    kernel.ok(x.body_sleep(h, this.handle));
    return this;
  }
  /**
   * Locks the body's translation on the x axis, the y axis or both (default both); `lockTranslation(false)` frees it. The
   * lock holds the body at its position now, with an exact constraint; `teleport` moves the lock with the body.
   */
  lockTranslation(x = true, y = x): this {
    this.check();
    if (this.type === 'fixed') throw new TypeError('A fixed body does not move; lock the translation of a dynamic or kinematic body.');
    this.owner.lockTranslation(this, x, y);
    this.locked = [x, y];
    return this;
  }
  /** Which axes are locked, [x, y]. */
  get translationLocked(): [boolean, boolean] {
    return [this.locked[0], this.locked[1]];
  }
  /** @internal The kernel handle of the joint that holds the lock, or -1. */
  lockJoint = -1;
  private locked: [boolean, boolean] = [false, false];

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

/** @internal */
export { describeShape };
