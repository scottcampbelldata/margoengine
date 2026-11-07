// A body of the own solver: a row of the kernel's columns bound to an optional mesh. On the step path, as a game calls
// these from `beforestep`: no `Math`, only + - * / on values the kernel then rounds, and the same in every browser.
import { MargoError } from '@margoengine/math/errors';
import type { Mesh } from '@margoengine/core';
import type { BodyType } from '../body.js';
import { BODY_DISABLED, type KernelWorld } from '../kernel.js';
import { checkVec, type Quat, type Vec3 } from '../math.js';
import type { ColliderOptions } from '../shapes.js';
import type { PhysicsCollider } from './collider.js';

/** Internal hooks the body needs from its world. */
export interface BodyOwner {
  readonly kernel: KernelWorld;
  addCollider(body: PhysicsBody, options: ColliderOptions): PhysicsCollider;
  removeCollider(body: PhysicsBody, collider: PhysicsCollider): void;
  removeBody(body: PhysicsBody): void;
}

const later = (what: string, when: string): MargoError =>
  new MargoError('unsupported', `${what} is not in the own solver yet; it comes with ${when}. Use @margoengine/physics until then.`);

/** @throws RangeError unless `rotation` is four finite numbers that are not all zero. */
export function checkRotation(rotation: Quat): void {
  const [x, y, z, w] = rotation,
    squared = rotation.length === 4 ? x * x + y * y + z * z + w * w : 0;
  if (!(squared > 0) || !Number.isFinite(squared))
    throw new RangeError('A rotation must be a quaternion [x, y, z, w] of finite numbers, not all zero.');
}

/** A rigid body of the own solver, bound to an optional core mesh. */
export class PhysicsBody {
  /** The colliders attached to this body. */
  readonly colliders: PhysicsCollider[] = [];
  userData: unknown;
  /** @internal */
  restWritten = false;
  /** @internal World scale captured for a body attached to a child mesh. */
  fitScale?: [number, number, number];
  /** @internal Parents above the mesh at the last sync, so a parent's body is written before its child's. */
  depth = 0;
  /** @internal */
  dirty = true;
  private removed = false;

  /** @internal */
  constructor(
    private readonly owner: BodyOwner,
    /** The body's row in every column of the kernel. */
    readonly row: number,
    readonly mesh: Mesh | null,
    /** How the body moves. */
    readonly type: BodyType,
  ) {}
  get valid(): boolean {
    return !this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
    for (const collider of this.colliders) collider.markRemoved();
    this.colliders.length = 0;
  }
  private world(): KernelWorld {
    if (this.removed) throw new MargoError('state', 'Physics body was removed; add a new body with physics.addBody.');
    return this.owner.kernel;
  }
  /** The kernel's columns, checked for a live body. Read them through this each time: growth replaces them. */
  private get columns(): KernelWorld['columns'] {
    return this.world().columns;
  }
  /** Not served yet: throws. */
  setType(): never {
    throw later('setType', 'the shapes and queries batch');
  }

  /** Current physics position (end of the last step, not interpolated). */
  get position(): [number, number, number] {
    const { positionX, positionY, positionZ } = this.columns,
      { row } = this;
    return [positionX[row], positionY[row], positionZ[row]];
  }
  /** Current physics rotation quaternion [x, y, z, w]. */
  get rotation(): [number, number, number, number] {
    const { rotationX, rotationY, rotationZ, rotationW } = this.columns,
      { row } = this;
    return [rotationX[row], rotationY[row], rotationZ[row], rotationW[row]];
  }
  private place(position: Vec3, rotation: Quat, wakeUp: boolean): this {
    this.world().setPose(this.row, position, rotation, wakeUp);
    this.dirty = true;
    this.restWritten = false;
    return this;
  }
  /** Teleports the body. Interpolation restarts from the new pose so it does not streak. */
  setPosition(position: Vec3, wakeUp = true): this {
    checkVec(position, 'Position');
    return this.place(position, this.rotation, wakeUp);
  }
  /** Turns the body at once. The kernel normalises the quaternion. */
  setRotation(rotation: Quat, wakeUp = true): this {
    checkRotation(rotation);
    return this.place(this.position, rotation, wakeUp);
  }
  /** Kinematic position-based bodies: the pose to reach at the end of the next step. */
  setNextPosition(position: Vec3): this {
    checkVec(position, 'Position');
    const { targetRotationX, targetRotationY, targetRotationZ, targetRotationW } = this.columns,
      { row } = this;
    this.world().setTarget(row, position, [targetRotationX[row], targetRotationY[row], targetRotationZ[row], targetRotationW[row]]);
    return this;
  }
  setNextRotation(rotation: Quat): this {
    checkRotation(rotation);
    const { targetX, targetY, targetZ } = this.columns,
      { row } = this;
    this.world().setTarget(row, [targetX[row], targetY[row], targetZ[row]], rotation);
    return this;
  }

  get linearVelocity(): [number, number, number] {
    const { linearX, linearY, linearZ } = this.columns,
      { row } = this;
    return [linearX[row], linearY[row], linearZ[row]];
  }
  setLinearVelocity(velocity: Vec3, wakeUp = true): this {
    checkVec(velocity, 'Velocity');
    if (wakeUp) this.world().wake(this.row);
    const { linearX, linearY, linearZ } = this.columns,
      { row } = this;
    linearX[row] = velocity[0];
    linearY[row] = velocity[1];
    linearZ[row] = velocity[2];
    return this;
  }
  get angularVelocity(): [number, number, number] {
    const { angularX, angularY, angularZ } = this.columns,
      { row } = this;
    return [angularX[row], angularY[row], angularZ[row]];
  }
  setAngularVelocity(velocity: Vec3, wakeUp = true): this {
    checkVec(velocity, 'Angular velocity');
    if (wakeUp) this.world().wake(this.row);
    const { angularX, angularY, angularZ } = this.columns,
      { row } = this;
    angularX[row] = velocity[0];
    angularY[row] = velocity[1];
    angularZ[row] = velocity[2];
    return this;
  }

  /** The turn `value` given at world `point` makes about the centre of mass. */
  private moment(point: Vec3, value: Vec3): [number, number, number] {
    const [x, y, z, w] = this.rotation,
      [px, py, pz] = this.position,
      [cx, cy, cz] = this.centerOfMass,
      // The centre in world space: q c q*, written as c + 2 w (u x c) + 2 u x (u x c).
      tx = 2 * (y * cz - z * cy),
      ty = 2 * (z * cx - x * cz),
      tz = 2 * (x * cy - y * cx),
      rx = point[0] - (px + cx + w * tx + y * tz - z * ty),
      ry = point[1] - (py + cy + w * ty + z * tx - x * tz),
      rz = point[2] - (pz + cz + w * tz + x * ty - y * tx);
    return [ry * value[2] - rz * value[1], rz * value[0] - rx * value[2], rx * value[1] - ry * value[0]];
  }
  /** Adds a force (persists across steps until `resetForces`), optionally at a world point. It reaches every substep. */
  addForce(force: Vec3, point?: Vec3, wakeUp = true): this {
    checkVec(force, 'Force');
    if (point) checkVec(point, 'Point');
    if (wakeUp) this.world().wake(this.row);
    const { forceX, forceY, forceZ } = this.columns,
      { row } = this;
    forceX[row] += force[0];
    forceY[row] += force[1];
    forceZ[row] += force[2];
    return point ? this.addTorque(this.moment(point, force), wakeUp) : this;
  }
  /** Applies an instantaneous impulse, optionally at a world point. It lands once, at the start of the next step. */
  applyImpulse(impulse: Vec3, point?: Vec3, wakeUp = true): this {
    checkVec(impulse, 'Impulse');
    if (point) checkVec(point, 'Point');
    if (wakeUp) this.world().wake(this.row);
    const { impulseX, impulseY, impulseZ } = this.columns,
      { row } = this;
    impulseX[row] += impulse[0];
    impulseY[row] += impulse[1];
    impulseZ[row] += impulse[2];
    return point ? this.applyTorqueImpulse(this.moment(point, impulse), wakeUp) : this;
  }
  addTorque(torque: Vec3, wakeUp = true): this {
    checkVec(torque, 'Torque');
    if (wakeUp) this.world().wake(this.row);
    const { torqueX, torqueY, torqueZ } = this.columns,
      { row } = this;
    torqueX[row] += torque[0];
    torqueY[row] += torque[1];
    torqueZ[row] += torque[2];
    return this;
  }
  applyTorqueImpulse(torque: Vec3, wakeUp = true): this {
    checkVec(torque, 'Torque impulse');
    if (wakeUp) this.world().wake(this.row);
    const { angularImpulseX, angularImpulseY, angularImpulseZ } = this.columns,
      { row } = this;
    angularImpulseX[row] += torque[0];
    angularImpulseY[row] += torque[1];
    angularImpulseZ[row] += torque[2];
    return this;
  }
  resetForces(wakeUp = true): this {
    if (wakeUp) this.world().wake(this.row);
    const { forceX, forceY, forceZ, torqueX, torqueY, torqueZ } = this.columns,
      { row } = this;
    forceX[row] = forceY[row] = forceZ[row] = torqueX[row] = torqueY[row] = torqueZ[row] = 0;
    return this;
  }
  /** Force in newtons left on the body by `addForce`, until `resetForces`. */
  get appliedForce(): [number, number, number] {
    const { forceX, forceY, forceZ } = this.columns,
      { row } = this;
    return [forceX[row], forceY[row], forceZ[row]];
  }
  /** Torque in newton metres left on the body by `addTorque`, until `resetForces`. */
  get appliedTorque(): [number, number, number] {
    const { torqueX, torqueY, torqueZ } = this.columns,
      { row } = this;
    return [torqueX[row], torqueY[row], torqueZ[row]];
  }

  get sleeping(): boolean {
    return this.world().isSleeping(this.row);
  }
  /** Asks the body to stop and sleep. It goes at the next step, when every body it touches is ready too. */
  sleep(): this {
    this.world().sleep(this.row);
    return this;
  }
  wakeUp(): this {
    this.world().wake(this.row);
    return this;
  }
  get mass(): number {
    const inverse = this.columns.inverseMass[this.row];
    return inverse > 0 ? 1 / inverse : 0;
  }
  /**
   * Mass in kilograms on top of what the colliders give, spread as they are, so it scales the inertia too. Replaces what an
   * earlier call added; 0 removes it. Takes effect at once. Inertia of its own is not served yet.
   */
  setAdditionalMass(mass: number, inertia: Vec3 = [0, 0, 0]): this {
    checkVec(inertia, 'Inertia');
    if (!(mass >= 0) || mass === Infinity || inertia.some((value) => value < 0))
      throw new RangeError('Additional mass and inertia must be finite numbers of at least 0; pass kilograms and kg m².');
    if (inertia.some((value) => value > 0)) throw later('Inertia of its own', 'the shapes and queries batch');
    this.columns.additionalMass[this.row] = mass;
    this.world().updateMass(this.row);
    return this;
  }
  /** Centre of mass in the body's frame. */
  get centerOfMass(): [number, number, number] {
    const { localCenterX, localCenterY, localCenterZ } = this.columns,
      { row } = this;
    return [localCenterX[row], localCenterY[row], localCenterZ[row]];
  }
  /** Moments of inertia in kg m² about the principal axes, which {@link PhysicsBody.inertiaFrame} turns from the body's frame. */
  get principalInertia(): [number, number, number] {
    const { inertiaX, inertiaY, inertiaZ } = this.columns,
      { row } = this;
    return [inertiaX[row], inertiaY[row], inertiaZ[row]];
  }
  /** Rotation of the principal axes of inertia in the body's frame, a quaternion [x, y, z, w]. */
  get inertiaFrame(): [number, number, number, number] {
    const { inertiaFrameX, inertiaFrameY, inertiaFrameZ, inertiaFrameW } = this.columns,
      { row } = this;
    return [inertiaFrameX[row], inertiaFrameY[row], inertiaFrameZ[row], inertiaFrameW[row]];
  }
  /** Not served yet: throws. */
  setMassProperties(): never {
    throw later('setMassProperties', 'the shapes and queries batch');
  }
  get gravityScale(): number {
    return this.columns.gravityScale[this.row];
  }
  set gravityScale(value: number) {
    if (!Number.isFinite(value)) throw new RangeError('Gravity scale must be a finite number; 1 is full gravity.');
    this.world().wake(this.row);
    this.columns.gravityScale[this.row] = value;
  }
  /** Not served yet: reads 0, and any other value throws. */
  get additionalSolverIterations(): number {
    this.world();
    return 0;
  }
  set additionalSolverIterations(passes: number) {
    if (passes !== 0) throw later('additionalSolverIterations', 'the shapes and queries batch');
  }
  /** Not served yet: reads false, and true throws. */
  get ccd(): boolean {
    this.world();
    return false;
  }
  set ccd(enabled: boolean) {
    if (enabled) throw later('ccd', 'continuous collision');
  }
  /** False takes the body out of the world: it keeps its pose and speed, touches nothing and its joints rest. */
  get enabled(): boolean {
    return (this.columns.flags[this.row] & BODY_DISABLED) === 0;
  }
  set enabled(value: boolean) {
    this.world().setBodyEnabled(this.row, value);
  }
  /** Stops all turning, on every world axis, or frees it again. */
  lockRotations(locked = true): this {
    this.world().setLocks(this.row, { angular: locked ? 7 : 0 });
    return this;
  }
  /** Stops all travel, on every world axis, or frees it again. */
  lockTranslations(locked = true): this {
    this.world().setLocks(this.row, { linear: locked ? 7 : 0 });
    return this;
  }

  /** Adds a collider and works out the body's mass again. */
  addCollider(options: ColliderOptions): PhysicsCollider {
    this.world();
    return this.owner.addCollider(this, options);
  }
  removeCollider(collider: PhysicsCollider): void {
    this.world();
    this.owner.removeCollider(this, collider);
  }
  /** Removes the body with its colliders. */
  remove(): void {
    if (!this.removed) this.owner.removeBody(this);
  }
}
