// A body of the own solver: a row of the kernel's columns bound to an optional mesh. On the step path, as a game calls
// these from `beforestep`: no `Math`, only + - * / on values the kernel then rounds, and the same in every browser.
import { MargoError } from '@margoengine/math/errors';
import type { Mesh } from '@margoengine/core';
import { BODY_CCD, BODY_DISABLED, type KernelWorld } from './kernel.js';
import { checkVec, type Quat, type Vec3 } from './math.js';
import type { ColliderOptions } from './shapes.js';
import type { PhysicsCollider } from './collider.js';

/** How a body moves: `dynamic` (simulated), `fixed`, or kinematic (driven by position or by velocity). */
export type BodyType = 'dynamic' | 'fixed' | 'kinematicPosition' | 'kinematicVelocity';

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
  /**
   * How far past where it is a body's contacts reach, in metres (default 0), Rapier's soft CCD: shapes this near each other
   * in the direction of travel get speculative contacts, so a fast body does not tunnel. The own solver already reaches as
   * far as a step moves a body; this adds to that.
   */
  softCcdPrediction?: number;
  /** The fastest the body's centre may travel, in m/s (default no cap). */
  maxLinearSpeed?: number;
  /** The fastest the body may turn, in rad/s (default no cap). */
  maxAngularSpeed?: number;
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

/** The lock bits of a per-axis freedom tuple: a set bit is an axis held still. */
function lockBits(enabled: readonly [boolean, boolean, boolean], name: string): number {
  if (!Array.isArray(enabled) || enabled.length !== 3 || enabled.some((axis) => typeof axis !== 'boolean'))
    throw new TypeError(`${name} must be three booleans [x, y, z]; pass [true, true, true] to free every axis.`);
  return (enabled[0] ? 0 : 1) | (enabled[1] ? 0 : 2) | (enabled[2] ? 0 : 4);
}

/** Internal hooks the body needs from its world. */
export interface BodyOwner {
  readonly kernel: KernelWorld;
  addCollider(body: PhysicsBody, options: ColliderOptions): PhysicsCollider;
  removeCollider(body: PhysicsBody, collider: PhysicsCollider): void;
  removeBody(body: PhysicsBody): void;
  /** The body was placed by hand or changed type: its mesh is written at the next sync, awake or not. */
  moved(body: PhysicsBody): void;
}

/** A cap column holds 0 for no cap. */
const capOf = (stored: number): number => (stored > 0 ? stored : Infinity);
function capIn(speed: number, name: string, unit: string): number {
  if (!(speed > 0))
    throw new RangeError(
      `${name} must be above 0, or Infinity for no cap; pass ${unit}. To stop a body, lock its axes.`,
    );
  return speed === Infinity ? 0 : speed;
}

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
  /** @internal The mesh drives this body; see {@link BodyOptions.follow}. */
  follow = false;
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
    private kind: BodyType,
  ) {}
  /** How the body moves now; change it with {@link PhysicsBody.setType}. */
  get type(): BodyType {
    return this.kind;
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
  private world(): KernelWorld {
    if (this.removed) throw new MargoError('state', 'Physics body was removed; add a new body with physics.addBody.');
    return this.owner.kernel;
  }
  /** The kernel's columns, checked for a live body. Read them through this each time: growth replaces them. */
  private get columns(): KernelWorld['columns'] {
    return this.world().columns;
  }
  /**
   * Switches how the body moves, keeping its pose, colliders and joints: a ragdoll going limp (`'dynamic'`) or back under
   * animation (`'kinematicPosition'`), a door that unlocks. A dynamic or kinematic body keeps its velocity; one made fixed
   * stops, and what it touched among fixed bodies ends. A body made `'kinematicPosition'` holds its pose until given a
   * target. With `wakeUp` (default true) a body made dynamic or kinematic wakes now. A sleeper otherwise, or made fixed,
   * reads asleep until the next step, which wakes it and what it touches whatever `wakeUp` said, as on the root entry.
   */
  setType(type: BodyType, wakeUp = true): this {
    const kernel = this.world();
    if (typeof type !== 'string' || !['dynamic', 'fixed', 'kinematicPosition', 'kinematicVelocity'].includes(type))
      throw new TypeError(
        `Unknown body type ${String(type)}; use dynamic, fixed, kinematicPosition or kinematicVelocity.`,
      );
    if (type === this.kind) return this;
    kernel.setKind(this.row, type, wakeUp !== false);
    this.kind = type;
    this.dirty = true;
    this.restWritten = false;
    this.owner.moved(this);
    return this;
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
  private readonly poseBuffer = new Float64Array(14);
  /**
   * The previous and current pose, for rendering between steps: previous position (0..2) and rotation (3..6), then
   * current position (7..9) and rotation (10..13). One buffer, rewritten by each read.
   */
  get pose(): Float64Array {
    const c = this.columns,
      { row } = this,
      p = this.poseBuffer;
    p[0] = c.previousX[row]!;
    p[1] = c.previousY[row]!;
    p[2] = c.previousZ[row]!;
    p[3] = c.previousRotationX[row]!;
    p[4] = c.previousRotationY[row]!;
    p[5] = c.previousRotationZ[row]!;
    p[6] = c.previousRotationW[row]!;
    p[7] = c.positionX[row]!;
    p[8] = c.positionY[row]!;
    p[9] = c.positionZ[row]!;
    p[10] = c.rotationX[row]!;
    p[11] = c.rotationY[row]!;
    p[12] = c.rotationZ[row]!;
    p[13] = c.rotationW[row]!;
    return p;
  }
  private place(position: Vec3, rotation: Quat, wakeUp: boolean): this {
    this.world().setPose(this.row, position, rotation, wakeUp);
    this.dirty = true;
    this.restWritten = false;
    this.owner.moved(this);
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
    this.world().setTarget(row, position, [
      targetRotationX[row],
      targetRotationY[row],
      targetRotationZ[row],
      targetRotationW[row],
    ]);
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
  /** Adds a force at a world `point`: it pushes the body and turns it by the arm from the centre of mass. Persists until `resetForces`. */
  addForceAtPoint(force: Vec3, point: Vec3, wakeUp = true): this {
    return this.addForce(force, point, wakeUp);
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
  /** Applies an instantaneous impulse at a world `point`: it pushes the body and turns it by the arm from the centre of mass. */
  applyImpulseAtPoint(impulse: Vec3, point: Vec3, wakeUp = true): this {
    return this.applyImpulse(impulse, point, wakeUp);
  }
  /** Adds a torque in newton metres (persists across steps until `resetForces` or `resetTorques`). */
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
  /** Clears the torque left by `addTorque` and by forces at a point, and keeps the force. `resetForces` clears both. */
  resetTorques(wakeUp = true): this {
    if (wakeUp) this.world().wake(this.row);
    const { torqueX, torqueY, torqueZ } = this.columns,
      { row } = this;
    torqueX[row] = torqueY[row] = torqueZ[row] = 0;
    return this;
  }
  /** Clears the force and the torque left on the body. */
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
   * Mass in kilograms and inertia in kg m² (about the body's x, y and z axes) on top of what the colliders give: the mass
   * sits at the centre of mass the body has now, so alone it leaves the inertia as it is. Replaces what an earlier call,
   * `setMassProperties` or the `additionalMass` option added; 0 removes it. Takes effect at once.
   */
  setAdditionalMass(mass: number, inertia: Vec3 = [0, 0, 0]): this {
    checkVec(inertia, 'Inertia');
    if (!(mass >= 0) || mass === Infinity || inertia.some((value) => value < 0))
      throw new RangeError(
        'Additional mass and inertia must be finite numbers of at least 0; pass kilograms and kg m².',
      );
    this.world().setOwnSolid(this.row, mass, this.centerOfMass, inertia);
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
  /**
   * Replaces what the colliders give with these figures, for a mass and inertia that come from a file or a measurement.
   * Any figure left out keeps the body's present value; a new `mass` alone scales the inertia with it, as a shape's does.
   * Inertia is about the axes `inertiaFrame` names, and a 0 moment reads as infinite. Takes effect at once. The body's
   * colliders get density 0, and colliders added later add the mass of their own density.
   */
  setMassProperties(properties: { mass?: number; centerOfMass?: Vec3; inertia?: Vec3; inertiaFrame?: Quat }): this {
    const kernel = this.world(),
      { mass, centerOfMass, inertia, inertiaFrame } = properties,
      computed = this.mass,
      total = mass ?? computed;
    if (!(total >= 0) || total === Infinity)
      throw new RangeError('Mass must be a finite number of at least 0; pass kilograms.');
    if (centerOfMass) checkVec(centerOfMass, 'Centre of mass');
    if (inertia) {
      checkVec(inertia, 'Inertia');
      if (inertia.some((value) => value < 0)) throw new RangeError('Inertia must not be negative; pass kg m².');
    }
    if (inertiaFrame) checkRotation(inertiaFrame);
    const [px, py, pz] = this.principalInertia,
      // A shape's inertia grows with its mass.
      over = computed > 0 ? total / computed : 0,
      center = centerOfMass ?? this.centerOfMass,
      moments: Vec3 = inertia ?? [px * over, py * over, pz * over],
      frame = inertiaFrame ?? (inertia ? [0, 0, 0, 1] : this.inertiaFrame),
      { colliderDensity } = kernel.columns;
    for (const collider of this.colliders) colliderDensity[collider.handle] = 0;
    kernel.setOwnSolid(this.row, total, center, moments, frame);
    kernel.wake(this.row);
    return this;
  }
  get gravityScale(): number {
    return this.columns.gravityScale[this.row];
  }
  set gravityScale(value: number) {
    if (!Number.isFinite(value)) throw new RangeError('Gravity scale must be a finite number; 1 is full gravity.');
    this.world().wake(this.row);
    this.columns.gravityScale[this.row] = value;
  }
  /** Solver passes the island of this body takes on top of the world's `solverIterations` (default 0). */
  get additionalSolverIterations(): number {
    return this.columns.extraPasses[this.row];
  }
  set additionalSolverIterations(passes: number) {
    if (!Number.isInteger(passes) || passes < 0 || passes > 0xffffffff)
      throw new RangeError(
        'Additional solver iterations must be a whole number from 0 to 4294967295; pass extra passes.',
      );
    this.columns.extraPasses[this.row] = passes;
  }
  /**
   * Continuous collision (default false), Rapier's `enableCcd`: a fast dynamic body is swept from where each step starts
   * to where it ends and put back to its first touch, so it cannot pass through a thin wall.
   */
  get ccd(): boolean {
    this.world();
    return (this.columns.flags[this.row] & BODY_CCD) !== 0;
  }
  set ccd(enabled: boolean) {
    this.world().setCcd(this.row, enabled);
  }
  /** How far past what a step moves it this body's contacts reach, in metres (default 0): soft CCD, as Rapier's `softCcdPrediction`. */
  get softCcdPrediction(): number {
    return this.columns.softCcd[this.row];
  }
  set softCcdPrediction(distance: number) {
    if (!(distance >= 0) || !Number.isFinite(distance))
      throw new RangeError(`softCcdPrediction must be 0 or more and finite (got ${distance}).`);
    this.columns.softCcd[this.row] = distance;
  }
  /** True when the last step's CCD pass checked this body: CCD is on and it moved further than it is thick. */
  get ccdActive(): boolean {
    return this.world().isCcdActive(this.row);
  }
  /** False takes the body out of the world: it keeps its pose and speed, touches nothing and its joints rest. */
  get enabled(): boolean {
    return (this.columns.flags[this.row] & BODY_DISABLED) === 0;
  }
  set enabled(value: boolean) {
    this.world().setBodyEnabled(this.row, value);
  }
  /** The fastest the body's centre may travel, in m/s (default Infinity, no cap). The step cuts a faster body to it, keeping its direction. */
  get maxLinearSpeed(): number {
    return capOf(this.columns.maxLinear[this.row]);
  }
  set maxLinearSpeed(speed: number) {
    this.columns.maxLinear[this.row] = capIn(speed, 'maxLinearSpeed', 'm/s');
  }
  /** The fastest the body may turn, in rad/s (default Infinity, no cap). */
  get maxAngularSpeed(): number {
    return capOf(this.columns.maxAngular[this.row]);
  }
  set maxAngularSpeed(speed: number) {
    this.columns.maxAngular[this.row] = capIn(speed, 'maxAngularSpeed', 'rad/s');
  }
  /**
   * Kinetic energy per unit of mass under which this body counts as still, in J/kg (default the world's, 0.0002, a slide of
   * 0.02 m/s). A higher value lets a body sleep while it still creeps; an island sleeps when every body of it is still.
   * `Infinity` clears it back to the world's.
   */
  get sleepThreshold(): number {
    const own = this.columns.sleepLimit[this.row];
    return own > 0 ? own : this.world().sleepEnergy;
  }
  set sleepThreshold(energy: number) {
    if (!(energy > 0))
      throw new RangeError('sleepThreshold must be above 0 J/kg; use canSleep: false to keep a body awake.');
    this.columns.sleepLimit[this.row] = energy === Infinity ? 0 : energy;
  }
  /** Seconds this body must stay still before it sleeps (default the world's, 0.5). `Infinity` clears it back to the world's. */
  get sleepTime(): number {
    const own = this.columns.sleepAfter[this.row];
    return own > 0 ? own : this.world().sleepTime;
  }
  set sleepTime(seconds: number) {
    if (!(seconds > 0))
      throw new RangeError('sleepTime must be above 0 seconds; use canSleep: false to keep a body awake.');
    this.columns.sleepAfter[this.row] = seconds === Infinity ? 0 : seconds;
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

  /**
   * Which world axes the body may travel along, for example `[true, false, true]` to keep it on a floor. The tuple is
   * the `enabledTranslations` option of `addBody`; `lockTranslations` is every axis at once.
   */
  get enabledTranslations(): [boolean, boolean, boolean] {
    return this.axes(3);
  }
  set enabledTranslations(enabled: readonly [boolean, boolean, boolean]) {
    this.world().setLocks(this.row, { linear: lockBits(enabled, 'enabledTranslations') });
  }
  /** Which world axes the body may turn about, for example `[false, true, false]` to only spin around Y. */
  get enabledRotations(): [boolean, boolean, boolean] {
    return this.axes(6);
  }
  set enabledRotations(enabled: readonly [boolean, boolean, boolean]) {
    this.world().setLocks(this.row, { angular: lockBits(enabled, 'enabledRotations') });
  }
  private axes(shift: number): [boolean, boolean, boolean] {
    const locked = (this.columns.flags[this.row] >>> shift) & 7;
    return [(locked & 1) === 0, (locked & 2) === 0, (locked & 4) === 0];
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
