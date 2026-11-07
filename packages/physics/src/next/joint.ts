// A joint on the own solver: the names of ../joints.ts, written straight into the kernel's joint columns. No `Math`: a value
// that needs a square root goes through the kernel, so a joint set up in one browser is the joint set up in another.
import { MargoError } from '@margoengine/math/errors';
import type { JointOptions, JointType, MotorOptions } from '../joints.js';
import { JOINT_CONTACTS, JOINT_LIMIT, JOINT_LOCK, JOINT_MOTOR_FORCE, JOINT_MOTOR_ON, type KernelWorld } from '../kernel.js';
import { checkVec, type Quat } from '../math.js';
import type { PhysicsBody } from './body.js';

const later = (what: string, when: string): MargoError =>
  new MargoError('unsupported', `${what} is not in the own solver yet; it comes with ${when}. Use @margoengine/physics until then.`);

/** The axis limits and motors of a hinge and of a slider work on: about frame X, along frame X. */
const TURN = 3,
  SLIDE = 0;
const LINEAR = 7,
  ANGULAR = 7 << 3;
const locks: Readonly<Partial<Record<JointType, number>>> = {
  fixed: JOINT_LOCK * (LINEAR | ANGULAR),
  spherical: JOINT_LOCK * LINEAR,
  revolute: JOINT_LOCK * (LINEAR | (6 << 3)),
  prismatic: JOINT_LOCK * (6 | ANGULAR),
};

function checkLimits(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new RangeError('Joint limits need finite min <= max');
}
function checkFrame(frame: Quat): void {
  if (frame.length !== 4 || !frame.every(Number.isFinite) || !frame.some((value) => value !== 0))
    throw new RangeError('Joint frames must be four finite numbers, not all zero; pass a quaternion [x, y, z, w].');
}

/** The world a joint belongs to. */
export interface JointOwner {
  readonly kernel: KernelWorld;
  removeJoint(joint: PhysicsJoint): void;
}

/** A joint between two bodies, with the names of the root entry. */
export class PhysicsJoint {
  private removed = false;
  /** @internal */
  constructor(
    private readonly owner: JointOwner,
    /** The joint's row in the kernel's joint columns. */
    readonly row: number,
    readonly type: JointType,
    readonly bodyA: PhysicsBody,
    readonly bodyB: PhysicsBody,
  ) {}
  get valid(): boolean {
    return !this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  /** Where the joint holds `bodyA`, in that body's frame. */
  get anchorA(): [number, number, number] {
    const { jointAnchorAX: x, jointAnchorAY: y, jointAnchorAZ: z } = this.owner.kernel.columns,
      { row } = this;
    return [x[row], y[row], z[row]];
  }
  /** Where the joint holds `bodyB`, in that body's frame. */
  get anchorB(): [number, number, number] {
    const { jointAnchorBX: x, jointAnchorBY: y, jointAnchorBZ: z } = this.owner.kernel.columns,
      { row } = this;
    return [x[row], y[row], z[row]];
  }
  /** The one axis a hinge or a slider moves on. */
  private unit(): number {
    if (this.removed) throw new MargoError('state', 'Joint was removed; create a new one with physics.addJoint.');
    if (this.type === 'revolute') return TURN;
    if (this.type === 'prismatic') return SLIDE;
    throw new TypeError('Limits and motors need a revolute or prismatic joint');
  }
  /** Angle (revolute, radians) or translation (prismatic) limits. */
  setLimits(min: number, max: number): this {
    checkLimits(min, max);
    const axis = this.unit(),
      { row } = this,
      columns = this.owner.kernel.columns;
    columns[`jointMin${axis}`][row] = min;
    columns[`jointMax${axis}`][row] = max;
    columns.jointFlags[row] |= JOINT_LIMIT << axis;
    this.wake();
    return this;
  }
  get limits(): [number, number] | null {
    const axis = this.unit(),
      { row } = this,
      columns = this.owner.kernel.columns;
    return columns.jointFlags[row] & (JOINT_LIMIT << axis) ? [columns[`jointMin${axis}`][row], columns[`jointMax${axis}`][row]] : null;
  }
  /** Drives the joint's axis: toward `targetVelocity`, or as a spring toward `targetPosition`. */
  setMotor(motor: MotorOptions): this {
    const axis = this.unit(),
      { row } = this,
      columns = this.owner.kernel.columns,
      cap = motor.maxForce ?? Infinity,
      position = motor.targetPosition;
    if (!(cap >= 0)) throw new RangeError('Motor maxForce must be 0 or more; pass newtons or newton metres.');
    columns[`jointTarget${axis}`][row] = position ?? 0;
    columns[`jointSpeed${axis}`][row] = motor.targetVelocity ?? 0;
    columns[`jointStiffness${axis}`][row] = position === undefined ? 0 : (motor.stiffness ?? 1);
    columns[`jointDamping${axis}`][row] = motor.damping ?? (position === undefined ? 1 : 0);
    columns[`jointCap${axis}`][row] = cap;
    const force = JOINT_MOTOR_FORCE << axis;
    columns.jointFlags[row] = (columns.jointFlags[row] & ~force) | (JOINT_MOTOR_ON << axis) | (motor.model === 'force' ? force : 0);
    this.wake();
    return this;
  }
  /** Not served yet: throws. */
  setRotationMotor(): never {
    throw later('setRotationMotor', 'spherical motors');
  }
  /** Not served yet: throws. */
  setAxisLimits(): never {
    throw later('The generic joint', 'the shapes and queries batch');
  }
  /** Not served yet: throws. */
  setAxisMotor(): never {
    throw later('The generic joint', 'the shapes and queries batch');
  }
  /** Turns the motor off. */
  clearMotor(): this {
    const axis = this.unit(),
      { row } = this,
      columns = this.owner.kernel.columns;
    columns.jointFlags[row] &= ~(JOINT_MOTOR_ON << axis);
    columns[`jointMotor${axis}`][row] = 0;
    this.wake();
    return this;
  }
  set contactsEnabled(value: boolean) {
    if (this.removed) return;
    const { jointFlags } = this.owner.kernel.columns;
    jointFlags[this.row] = value ? jointFlags[this.row] | JOINT_CONTACTS : jointFlags[this.row] & ~JOINT_CONTACTS;
  }
  get contactsEnabled(): boolean {
    return !this.removed && (this.owner.kernel.columns.jointFlags[this.row] & JOINT_CONTACTS) !== 0;
  }
  remove(): void {
    if (!this.removed) this.owner.removeJoint(this);
  }
  private wake(): void {
    const { kernel } = this.owner;
    if (this.bodyA.valid) kernel.wake(this.bodyA.row);
    if (this.bodyB.valid) kernel.wake(this.bodyB.row);
  }
}

/**
 * Puts a joint on two bodies in the kernel.
 * @throws MargoError (`unsupported`) for a kind the own solver does not hold yet.
 */
export function createJoint(owner: JointOwner, bodyA: PhysicsBody, bodyB: PhysicsBody, options: JointOptions): PhysicsJoint {
  const { type, anchorA = [0, 0, 0], anchorB = [0, 0, 0] } = options,
    locked = locks[type];
  if (type === 'generic') throw later('The generic joint', 'the shapes and queries batch');
  if (type === 'rope' || type === 'spring') throw later(`The ${type} joint`, 'rope and spring joints');
  if (locked === undefined)
    throw new TypeError(`Unknown joint type ${String(type)}; use fixed, spherical, revolute, prismatic, rope, spring or generic.`);
  checkVec(anchorA, 'anchorA');
  checkVec(anchorB, 'anchorB');
  const { frameA, frameB } = options as { frameA?: Quat; frameB?: Quat };
  if (type === 'revolute' || type === 'prismatic') {
    const { axis, limits } = options;
    if ((frameA || frameB) && (!frameA || !frameB || axis))
      throw new TypeError('A joint takes an axis, or frameA and frameB together; pass one or the other.');
    if (!frameA) {
      checkVec(axis, 'Joint axis');
      if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) throw new RangeError('Joint axis must be nonzero');
    }
    if (limits) checkLimits(limits[0], limits[1]);
  }
  if (frameA) checkFrame(frameA);
  if (frameB) checkFrame(frameB);
  const { kernel } = owner,
    row = kernel.addJoint(bodyA.row, bodyB.row, locked | (options.contactsEnabled ? JOINT_CONTACTS : 0)),
    columns = kernel.columns,
    joint = new PhysicsJoint(owner, row, type, bodyA, bodyB);
  columns.jointAnchorAX[row] = anchorA[0];
  columns.jointAnchorAY[row] = anchorA[1];
  columns.jointAnchorAZ[row] = anchorA[2];
  columns.jointAnchorBX[row] = anchorB[0];
  columns.jointAnchorBY[row] = anchorB[1];
  columns.jointAnchorBZ[row] = anchorB[2];
  if (frameA || frameB) kernel.setJointFrames(row, frameA ?? [0, 0, 0, 1], frameB ?? [0, 0, 0, 1]);
  if (type === 'revolute' || type === 'prismatic') {
    const { axis, limits, motor } = options;
    if (axis) kernel.setJointAxis(row, axis);
    if (limits) joint.setLimits(limits[0], limits[1]);
    if (motor) joint.setMotor(motor);
  }
  return joint;
}
