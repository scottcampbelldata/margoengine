// A joint on the own solver: the names of ../joints.ts, written straight into the kernel's joint columns. No `Math`: a value
// that needs a square root goes through the kernel, so a joint set up in one browser is the joint set up in another.
import { MargoError } from '@margoengine/math/errors';
import {
  JOINT_BROKEN,
  JOINT_CONE,
  JOINT_DRIVE,
  JOINT_CONTACTS,
  JOINT_DISABLED,
  JOINT_DISTANCE,
  JOINT_LIMIT,
  JOINT_LOCK,
  JOINT_MOTOR_FORCE,
  JOINT_MOTOR_ON,
  type KernelWorld,
} from './kernel.js';
import { checkVec, type Quat, type Vec3 } from './math.js';
import type { PhysicsBody } from './body.js';

/** Drives a joint axis toward a target velocity or, as a spring, a target position. */
export interface MotorOptions {
  /** Target velocity in radians (revolute) or units (prismatic) per second. */
  targetVelocity?: number;
  /** Target angle (revolute) or offset along the axis (prismatic). Turns the motor into a spring. */
  targetPosition?: number;
  /** Spring stiffness toward `targetPosition` (default 0 when only a velocity is given). */
  stiffness?: number;
  /** Damping toward `targetVelocity` (default 1 for velocity motors). */
  damping?: number;
  /** 'acceleration' (default, mass independent) or 'force'. */
  model?: 'acceleration' | 'force';
  /** The most force (prismatic) or torque (revolute, spherical) the motor applies, in N or N m. Default no cap. */
  maxForce?: number;
}

/** A spring toward a rotation, for {@link PhysicsJoint.setRotationMotor}: no targets, the rotation is the target. */
export type RotationMotorOptions = Pick<MotorOptions, 'stiffness' | 'damping' | 'model' | 'maxForce'> & {
  targetVelocity?: Vec3;
};

interface JointBase {
  /** Anchor in body A's local frame (default origin). */
  anchorA?: Vec3;
  /** Anchor in body B's local frame (default origin). */
  anchorB?: Vec3;
  /** Let the two bodies collide with each other (default false, as in Rapier). */
  contactsEnabled?: boolean;
  /** The joint breaks when its linear rows carry more than this many newtons (default never). */
  breakForce?: number;
  /** The joint breaks when its angular rows carry more than this many newton metres (default never). */
  breakTorque?: number;
  /** Anything you want to find again with the joint; the world never reads it. */
  userData?: unknown;
  /** False makes the joint with nothing solved, until `joint.enabled = true` (default true). */
  enabled?: boolean;
  /** Lets the joint's locks give way as a spring of `hertz` and damping ratio `damping` (default 1); see `setSoftness`. */
  softness?: { hertz: number; damping?: number };
}
/** One degree of freedom of a generic joint: along or about an axis of its frame on body A. */
export type JointDof = 'linX' | 'linY' | 'linZ' | 'angX' | 'angY' | 'angZ';

/** Options for adding a joint between two bodies. */
export type JointOptions =
  | (JointBase & { type: 'fixed'; frameA?: Quat; frameB?: Quat })
  | (JointBase & { type: 'spherical' })
  /**
   * Keeps the anchors at most `length` apart and lets them come closer (a slack rope or chain link). A `motor` is a winch:
   * its `targetVelocity` is the speed the distance between the anchors changes at, so a negative one reels them in.
   */
  | (JointBase & { type: 'rope'; length: number; motor?: MotorOptions })
  /**
   * Pulls the anchors toward `restLength` apart like a damped spring (`stiffness` N/m, `damping` N*s/m). With `model:
   * 'acceleration'` the stiffness and damping are per kilogram (1/s2 and 1/s), so a light and a heavy body swing at the same
   * frequency; the default `'force'` is a spring in newtons, which a heavy body swings slowly on.
   */
  | (JointBase & {
      type: 'spring';
      restLength: number;
      stiffness: number;
      damping?: number;
      model?: 'force' | 'acceleration';
    })
  /**
   * A pin that slides in a slot: it slides along `axis` (or frame X) and turns about it, and holds every other motion. Give
   * it `slideLimits` (metres) and `turnLimits` (radians) to bound either, and `slideMotor` and `turnMotor` to drive them. Rapier's
   * `PinSlotJoint`; it is a generic joint with its other four axes locked.
   */
  | (JointBase & {
      type: 'pinSlot';
      axis?: Vec3;
      frameA?: Quat;
      frameB?: Quat;
      slideLimits?: readonly [number, number];
      turnLimits?: readonly [number, number];
      slideMotor?: MotorOptions;
      turnMotor?: MotorOptions;
    })
  | (JointBase & {
      type: 'revolute' | 'prismatic';
      limits?: readonly [number, number];
      motor?: MotorOptions;
    } & (
        | { axis: Vec3; frameA?: undefined; frameB?: undefined }
        /**
         * The joint's frame on each body, given in place of `axis`: it turns or slides along each frame's x axis. Line
         * the two up at rest and the rest pose reads 0, whatever the bodies' own frames. Rapier 0.20 or later.
         */
        | { axis?: undefined; frameA: Quat; frameB: Quat }
      ))
  /**
   * Six degrees of freedom you choose from, measured from the joint's frame on body A to its frame on body B: `locked`
   * axes do not move, a `limits` axis stays in its range, any other axis is free. `frameA` and `frameB` turn each frame
   * on its body (default identity). Rapier 0.20 or later.
   */
  | (JointBase & {
      type: 'generic';
      frameA?: Quat;
      frameB?: Quat;
      locked?: readonly JointDof[];
      limits?: Readonly<Partial<Record<JointDof, readonly [number, number]>>>;
      motors?: Readonly<Partial<Record<JointDof, MotorOptions>>>;
      /**
       * Axes that share one limit, Rapier's `coupled_axes`: two or three sliding axes (`linY` and `linZ` for a rod in a round
       * hole, a distance in their plane) or `angY` and `angZ` (the swing across X, as one angle). Give the limit on the first
       * of them in `limits`: for sliding axes `[min, max]` of the combined distance, for the swing `[0, max]`.
       */
      coupled?: readonly JointDof[];
    });

/** Kind of joint, the `type` of {@link JointOptions}. */
export type JointType = JointOptions['type'];

/**
 * A ball joint held inside a cone, the joint of a shoulder or a hip. Frame X on `bodyB` stays within `swing` of frame X on
 * `bodyA`, and `bodyB` turns about it within `twist`. Past its edge a cone pushes back as a contact does, so a limb a floor
 * holds outside its cone comes to rest there.
 */
export interface ConeJointOptions {
  type: 'cone';
  /** Where the joint holds `bodyA`, in that body's frame (default the origin). */
  anchorA?: Vec3;
  /** Where the joint holds `bodyB`, in that body's frame (default the origin). */
  anchorB?: Vec3;
  /** The middle of the cone, in the frame of both bodies at rest (default X). Takes the place of `frameA` and `frameB`. */
  axis?: Vec3;
  /** The joint's frame on `bodyA`, whose X is the middle of the cone. */
  frameA?: Quat;
  /** The joint's frame on `bodyB`. */
  frameB?: Quat;
  /** The widest swing in radians, or `[aboutY, aboutZ]` for an ellipse of the frame's Y and Z turns. */
  swing: number | readonly [number, number];
  /** Radians about frame X, as `[min, max]`; a joint without one twists freely. */
  twist?: readonly [number, number];
  /** Lets the two bodies collide (default false). */
  contactsEnabled?: boolean;
  /** The joint breaks when its linear rows carry more than this many newtons (default never). */
  breakForce?: number;
  /** The joint breaks when its angular rows carry more than this many newton metres (default never). */
  breakTorque?: number;
  /** Anything you want to find again with the joint; the world never reads it. */
  userData?: unknown;
  /** False makes the joint with nothing solved, until `joint.enabled = true` (default true). */
  enabled?: boolean;
  /** Lets the joint's locks give way as a spring of `hertz` and damping ratio `damping` (default 1); see `setSoftness`. */
  softness?: { hertz: number; damping?: number };
}

/** What `physics.addJoint` takes on the own solver: the root's joints and the cone. */
export type NextJointOptions = JointOptions | ConeJointOptions;

/** The axis limits and motors of a hinge and of a slider work on: about frame X, along frame X. */
const TURN = 3,
  SLIDE = 0;
/** A cone's rows: the twist, the swing's distance past its edge, and the columns of the axis it has no row for hold the ellipse. */
const TWIST = 3,
  SWING = 4,
  ELLIPSE = 5;
const LINEAR = 7,
  ANGULAR = 7 << 3;
/** A generic joint's axes, in the order of the kernel's axis columns. */
const DOFS: readonly JointDof[] = ['linX', 'linY', 'linZ', 'angX', 'angY', 'angZ'];
const locks: Readonly<Partial<Record<JointType | 'cone', number>>> = {
  fixed: JOINT_LOCK * (LINEAR | ANGULAR),
  spherical: JOINT_LOCK * LINEAR,
  revolute: JOINT_LOCK * (LINEAR | (6 << 3)),
  prismatic: JOINT_LOCK * (6 | ANGULAR),
  pinSlot: JOINT_LOCK * (6 | (6 << 3)),
  cone: (JOINT_LOCK * LINEAR) | JOINT_CONE | (JOINT_LIMIT << SWING),
  // The first axis of these two is the line between the anchors, and what it reads is their distance.
  rope: JOINT_DISTANCE | (JOINT_LIMIT << SLIDE),
  spring: JOINT_DISTANCE | (JOINT_MOTOR_ON << SLIDE) | (JOINT_MOTOR_FORCE << SLIDE),
};

function checkLimits(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
    throw new RangeError('Joint limits need finite min <= max');
}
function swingLimits(swing: number | readonly [number, number]): readonly [number, number] {
  const [y, z] = typeof swing === 'number' ? [swing, swing] : swing;
  if (!(y > 0 && z > 0 && Number.isFinite(y) && Number.isFinite(z)))
    throw new RangeError('A cone needs a swing above 0; pass radians, or [aboutY, aboutZ].');
  return [y, z];
}
function checkFrame(frame: Quat): void {
  if (frame.length !== 4 || !frame.every(Number.isFinite) || !frame.some((value) => value !== 0))
    throw new RangeError('Joint frames must be four finite numbers, not all zero; pass a quaternion [x, y, z, w].');
}

/** What a joint's rows read as the force on body B: the sign of the solver's impulse on body A. */
const LOAD_SIGN = 1;

/** The product of two quaternions [x, y, z, w]: `b` turned first, then `a`. */
function multiply(a: readonly number[], b: readonly number[]): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
/** A vector turned by a unit quaternion. */
function rotate(q: readonly number[], v: Vec3): Vec3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The world a joint belongs to. */
export interface JointOwner {
  readonly kernel: KernelWorld;
  /** The length in seconds of one substep of a step, which the solver's impulses are over. */
  readonly substepLength: number;
  removeJoint(joint: PhysicsJoint): void;
  /** True for a joint that a multibody holds, which `flip` leaves alone. */
  holdsMultibody(joint: PhysicsJoint): boolean;
}

/** A joint between two bodies, with the names of the root entry. `bodyA` holds the joint's frame A and anchor A; {@link PhysicsJoint.flip} swaps the bodies. */
export class PhysicsJoint {
  private removed = false;
  /** Anything you want to find again with the joint; the world never reads it. */
  userData: unknown;
  /** @internal */
  constructor(
    private readonly owner: JointOwner,
    /** The joint's row in the kernel's joint columns. */
    readonly row: number,
    readonly type: JointType | 'cone',
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
  /** Moves where the joint holds `bodyA`, a point in that body's frame; the bodies wake. */
  setAnchorA(anchor: Vec3): this {
    return this.anchor(anchor, 'A');
  }
  /** Moves where the joint holds `bodyB`, a point in that body's frame; the bodies wake. */
  setAnchorB(anchor: Vec3): this {
    return this.anchor(anchor, 'B');
  }
  private anchor(anchor: Vec3, side: 'A' | 'B'): this {
    this.live();
    checkVec(anchor, `anchor${side}`);
    const columns = this.owner.kernel.columns,
      { row } = this;
    columns[`jointAnchor${side}X`][row] = anchor[0];
    columns[`jointAnchor${side}Y`][row] = anchor[1];
    columns[`jointAnchor${side}Z`][row] = anchor[2];
    this.wake();
    return this;
  }
  /** The joint's frame on `bodyA`, a unit quaternion [x, y, z, w]: its axes are the ones limits and motors measure along. */
  get frameA(): [number, number, number, number] {
    const { jointFrameAX: x, jointFrameAY: y, jointFrameAZ: z, jointFrameAW: w } = this.owner.kernel.columns,
      { row } = this;
    return [x[row], y[row], z[row], w[row]];
  }
  /** The joint's frame on `bodyB`. */
  get frameB(): [number, number, number, number] {
    const { jointFrameBX: x, jointFrameBY: y, jointFrameBZ: z, jointFrameBW: w } = this.owner.kernel.columns,
      { row } = this;
    return [x[row], y[row], z[row], w[row]];
  }
  /**
   * Turns the joint's frame on each body, in place of the ones it was made with: the axis a hinge turns about, the axes a
   * generic joint locks and limits. Turn both together to keep the rest pose; the bodies wake.
   * @throws RangeError for a frame that is not four finite numbers, not all zero.
   */
  setFrames(frameA: Quat, frameB: Quat): this {
    this.live();
    checkFrame(frameA);
    checkFrame(frameB);
    this.owner.kernel.setJointFrames(this.row, frameA, frameB);
    this.wake();
    return this;
  }
  private live(): void {
    if (this.removed) throw new MargoError('state', 'Joint was removed; create a new one with physics.addJoint.');
  }
  /**
   * False takes the joint out of the solve, and true puts it back; the joint keeps its limits, motors and break limits. The
   * bodies wake. A broken joint stays broken until {@link PhysicsJoint.repair}.
   */
  get enabled(): boolean {
    return !this.removed && (this.owner.kernel.columns.jointFlags[this.row] & JOINT_DISABLED) === 0;
  }
  set enabled(value: boolean) {
    this.live();
    const { jointFlags } = this.owner.kernel.columns;
    jointFlags[this.row] = value ? jointFlags[this.row] & ~JOINT_DISABLED : jointFlags[this.row] | JOINT_DISABLED;
    this.wake();
  }
  /**
   * The force the joint applied to `bodyB` in the last step, in newtons and the world's axes: the load that rows, limits and
   * motors together carried in its last substep. {@link PhysicsJoint.torque} is its couple about the anchor. A body held
   * still by a joint reads its weight; a joint that rests or did not run reads zero.
   */
  get force(): [number, number, number] {
    return this.load(0);
  }
  /** The couple the joint applied to `bodyB` in the last step, in newton metres about the anchor, in the world's axes. */
  get torque(): [number, number, number] {
    return this.load(3);
  }
  private load(first: number): [number, number, number] {
    this.live();
    const { row } = this,
      columns = this.owner.kernel.columns,
      h = this.owner.substepLength;
    const sum = (k: number): number =>
      (columns[`jointImpulse${first + k}`][row] + columns[`jointMotor${first + k}`][row]) / h;
    if (columns.jointFlags[row] & JOINT_DISTANCE) {
      // A rope's or a spring's one row acts along the line between the anchors, and nothing turns.
      if (first !== 0) return [0, 0, 0];
      const pa = this.bodyA.rotation,
        pb = this.bodyB.rotation,
        [ax, ay, az] = this.anchorA,
        [bx, by, bz] = this.anchorB,
        from = rotate(pa, [ax, ay, az]),
        to = rotate(pb, [bx, by, bz]),
        a = this.bodyA.position,
        b = this.bodyB.position,
        line: Vec3 = [b[0] + to[0] - a[0] - from[0], b[1] + to[1] - a[1] - from[1], b[2] + to[2] - a[2] - from[2]],
        length = sqrtOf(line[0] * line[0] + line[1] * line[1] + line[2] * line[2]),
        scale = length > 0 ? (LOAD_SIGN * sum(0)) / length : 0;
      return [line[0] * scale, line[1] * scale, line[2] * scale];
    }
    const local: Vec3 = [LOAD_SIGN * sum(0), LOAD_SIGN * sum(1), LOAD_SIGN * sum(2)],
      a = this.bodyA.rotation,
      f = this.frameA,
      world = rotate(multiply(a, f), local);
    return [world[0], world[1], world[2]];
  }
  /**
   * Swaps the two bodies, anchors and frames, and mirrors every limit, motor target and joint angle, so the joint holds
   * the same pose as before from the other body. A hinge or slider, a ball joint, a fixed joint, a rope, a spring and a
   * generic joint with at most one limited or driven axis flip exactly.
   * @throws TypeError for a cone, a rotation motor, a joint in a multibody, and a joint with limits or motors on more than one
   *   turning axis, or on a sliding axis together with a free turning axis: those do not mirror axis by axis.
   * @throws MargoError (`state`) for a removed joint.
   */
  flip(): this {
    this.live();
    if (this.owner.holdsMultibody(this))
      throw new TypeError('A joint of a multibody cannot be flipped; flip the tree by choosing its root.');
    const columns = this.owner.kernel.columns,
      { row } = this,
      flags = columns.jointFlags[row];
    if (flags & (JOINT_CONE | JOINT_DRIVE) || columns.jointCouple[row] !== 0 || this.softAxes !== 0)
      throw new TypeError(
        'A cone, a rotation motor, coupled axes or a soft joint does not mirror axis by axis; make it again with the bodies swapped.',
      );
    const distance = (flags & JOINT_DISTANCE) !== 0,
      acted = (axis: number): boolean => (flags & ((JOINT_LIMIT | JOINT_MOTOR_ON) << axis)) !== 0,
      lockedTurns = [3, 4, 5].filter((axis) => (flags & (JOINT_LOCK << axis)) !== 0).length,
      actedTurns = [3, 4, 5].filter(acted).length,
      actedSlides = [0, 1, 2].filter(acted).length;
    if (!distance) {
      if (actedTurns > 0 && lockedTurns < 2)
        throw new TypeError(
          'Only one turning axis may be free when a joint flips; lock the other two, or make the joint again with the bodies swapped.',
        );
      if (actedSlides > 0 && lockedTurns < 3)
        throw new TypeError(
          'A joint with a limit or motor on a sliding axis flips only with all its turning axes locked.',
        );
    }
    const swap = (a: string, b: string): void => {
      const x = columns[a][row];
      columns[a][row] = columns[b][row];
      columns[b][row] = x;
    };
    for (const name of ['jointA:jointB', 'jointNextA:jointNextB']) swap(...(name.split(':') as [string, string]));
    for (const axis of 'XYZ') swap(`jointAnchorA${axis}`, `jointAnchorB${axis}`);
    for (const axis of 'XYZW') swap(`jointFrameA${axis}`, `jointFrameB${axis}`);
    const bodies = this as { -readonly [K in 'bodyA' | 'bodyB']: PhysicsBody };
    [bodies.bodyA, bodies.bodyB] = [this.bodyB, this.bodyA];
    if (!distance)
      for (let axis = 0; axis < 6; axis++) {
        const lo = columns[`jointMin${axis}`][row],
          hi = columns[`jointMax${axis}`][row];
        columns[`jointMin${axis}`][row] = -hi;
        columns[`jointMax${axis}`][row] = -lo;
        columns[`jointTarget${axis}`][row] = -columns[`jointTarget${axis}`][row];
        columns[`jointSpeed${axis}`][row] = -columns[`jointSpeed${axis}`][row];
      }
    if (!distance) columns.jointAngle[row] = -columns.jointAngle[row];
    for (let axis = 0; axis < 6; axis++) {
      columns[`jointImpulse${axis}`][row] = 0;
      columns[`jointMotor${axis}`][row] = 0;
    }
    this.wake();
    return this;
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
    return columns.jointFlags[row] & (JOINT_LIMIT << axis)
      ? [columns[`jointMin${axis}`][row], columns[`jointMax${axis}`][row]]
      : null;
  }
  /** A cone's limits: its swing and, with `twist` given, its twist. With no `twist` the joint twists freely. */
  setCone(swing: number | readonly [number, number], twist?: readonly [number, number]): this {
    if (this.removed) throw new MargoError('state', 'Joint was removed; create a new one with physics.addJoint.');
    if (this.type !== 'cone') throw new TypeError('setCone needs a cone joint');
    const [y, z] = swingLimits(swing),
      { row } = this,
      columns = this.owner.kernel.columns;
    if (twist) checkLimits(twist[0], twist[1]);
    columns[`jointMin${SWING}`][row] = -Infinity;
    columns[`jointMax${SWING}`][row] = 0;
    columns[`jointMin${ELLIPSE}`][row] = y;
    columns[`jointMax${ELLIPSE}`][row] = z;
    columns[`jointMin${TWIST}`][row] = twist ? twist[0] : 0;
    columns[`jointMax${TWIST}`][row] = twist ? twist[1] : 0;
    columns.jointFlags[row] = twist
      ? columns.jointFlags[row] | (JOINT_LIMIT << TWIST)
      : columns.jointFlags[row] & ~(JOINT_LIMIT << TWIST);
    this.wake();
    return this;
  }
  /** A cone's limits as `setCone` took them, the swing as `[aboutY, aboutZ]`. */
  get cone(): { swing: [number, number]; twist: [number, number] | null } | null {
    if (this.type !== 'cone' || this.removed) return null;
    const { row } = this,
      columns = this.owner.kernel.columns,
      twisted = columns.jointFlags[row] & (JOINT_LIMIT << TWIST);
    return {
      swing: [columns[`jointMin${ELLIPSE}`][row], columns[`jointMax${ELLIPSE}`][row]],
      twist: twisted ? [columns[`jointMin${TWIST}`][row], columns[`jointMax${TWIST}`][row]] : null,
    };
  }
  /** Drives the joint's axis: toward `targetVelocity`, or as a spring toward `targetPosition`. */
  setMotor(motor: MotorOptions): this {
    return this.drive(this.type === 'rope' ? SLIDE : this.unit(), motor);
  }
  private drive(axis: number, motor: MotorOptions): this {
    const { row } = this,
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
    columns.jointFlags[row] =
      (columns.jointFlags[row] & ~force) | (JOINT_MOTOR_ON << axis) | (motor.model === 'force' ? force : 0);
    this.wake();
    return this;
  }
  /** A generic joint's axis by name, one it does not lock. */
  private free(dof: JointDof): number {
    if (this.removed) throw new MargoError('state', 'Joint was removed; create a new one with physics.addJoint.');
    if (this.type !== 'generic' && this.type !== 'pinSlot')
      throw new TypeError(
        'Axis limits and motors need a generic joint (or a pin-slot joint); use setLimits or setMotor.',
      );
    const axis = DOFS.indexOf(dof);
    if (axis < 0) throw new TypeError(`Unknown joint axis ${String(dof)}; use linX, linY, linZ, angX, angY or angZ.`);
    if (this.owner.kernel.columns.jointFlags[this.row] & (JOINT_LOCK << axis))
      throw new RangeError(`The joint locks ${dof}, so it has no range to limit or drive; leave it out of locked.`);
    return axis;
  }
  /**
   * A spherical joint's spring toward `rotation`, a unit quaternion [x, y, z, w] of `bodyB` in the frame of `bodyA`. The
   * joint's frame on `bodyA` moves onto the target and three motors drive the turn left to 0, so it reads true near half a
   * turn, where the vector part of a rotation no longer tells rotations apart. `targetVelocity` is the target's own spin,
   * rad/s in its frame.
   * @throws TypeError on any other joint type, RangeError for a rotation that is not a unit quaternion.
   */
  setRotationMotor(rotation: Quat, motor: RotationMotorOptions = {}): this {
    if (this.removed) throw new MargoError('state', 'Joint was removed; create a new one with physics.addJoint.');
    if (this.type !== 'spherical' && this.type !== 'cone')
      throw new TypeError('Rotation motors need a spherical joint or a cone joint; use setMotor on a hinge.');
    const [x, y, z, w] = rotation;
    const squared = x * x + y * y + z * z + w * w;
    if (!(squared > 0.998 && squared < 1.002))
      throw new RangeError('Rotation motors need a unit quaternion [x, y, z, w]; normalize the rotation.');
    const cap = motor.maxForce ?? Infinity;
    if (!(cap >= 0)) throw new RangeError('Motor maxForce must be 0 or more; pass newtons or newton metres.');
    const { row } = this,
      columns = this.owner.kernel.columns,
      spin = motor.targetVelocity;
    if (this.type === 'cone') {
      // A cone's frames hold its axis, so the target lives in columns of its own, and its limits keep acting.
      const n = 1 / sqrtOf(squared);
      columns.jointDriveX[row] = x * n;
      columns.jointDriveY[row] = y * n;
      columns.jointDriveZ[row] = z * n;
      columns.jointDriveW[row] = w * n;
      columns.jointFlags[row] |= JOINT_DRIVE;
    } else {
      columns.jointFrameAX[row] = x;
      columns.jointFrameAY[row] = y;
      columns.jointFrameAZ[row] = z;
      columns.jointFrameAW[row] = w;
    }
    for (let k = 0; k < 3; k++) {
      const axis = TURN + k,
        force = JOINT_MOTOR_FORCE << axis;
      columns[`jointTarget${axis}`][row] = 0;
      columns[`jointSpeed${axis}`][row] = spin?.[k] ?? 0;
      columns[`jointStiffness${axis}`][row] = motor.stiffness ?? 1;
      columns[`jointDamping${axis}`][row] = motor.damping ?? 0;
      columns[`jointCap${axis}`][row] = cap;
      columns.jointFlags[row] =
        (columns.jointFlags[row] & ~force) | (JOINT_MOTOR_ON << axis) | (motor.model === 'force' ? force : 0);
    }
    this.wake();
    return this;
  }
  /**
   * A drag on a hinge or a slider's one free axis: a force or torque of `coefficient` times its speed against it (N s/m or N m s/rad),
   * Rapier's joint damping. It takes the axis's motor, so it replaces a motor set before; `0` takes it off.
   * @throws RangeError for a coefficient below 0 or not finite; TypeError for any joint but a revolute or a prismatic.
   */
  setDamping(coefficient: number): this {
    if (!(coefficient >= 0) || !Number.isFinite(coefficient))
      throw new RangeError('Joint damping must be a finite number of at least 0; pass N s/m or N m s/rad.');
    const axis = this.unit();
    return coefficient === 0
      ? this.clearMotor()
      : this.drive(axis, { targetVelocity: 0, damping: coefficient, model: 'force' });
  }
  /**
   * Dry friction on a hinge or a slider's one free axis: a force or torque of at most `maxForce` (N or N m) against its motion, which
   * brings it to a stop and holds it there while the load stays under that. Takes the axis's motor like {@link PhysicsJoint.setDamping}; `0` takes it off.
   * @throws RangeError for a force below 0 or not finite; TypeError for any joint but a revolute or a prismatic.
   */
  setFriction(maxForce: number): this {
    if (!(maxForce >= 0) || !Number.isFinite(maxForce))
      throw new RangeError('Joint friction must be a finite number of at least 0; pass N or N m.');
    const axis = this.unit();
    return maxForce === 0
      ? this.clearMotor()
      : this.drive(axis, { targetVelocity: 0, damping: 1e6, model: 'force', maxForce });
  }
  /** Generic joints: keeps one free axis between `min` and `max`, in radians or units, from frame A to frame B. */
  setAxisLimits(dof: JointDof, min: number, max: number): this {
    const axis = this.free(dof);
    checkLimits(min, max);
    const { row } = this,
      columns = this.owner.kernel.columns;
    columns[`jointMin${axis}`][row] = min;
    columns[`jointMax${axis}`][row] = max;
    columns.jointFlags[row] |= JOINT_LIMIT << axis;
    this.wake();
    return this;
  }
  /** Generic joints: a motor on one axis, its target in the same measure as {@link PhysicsJoint.setAxisLimits}. */
  setAxisMotor(dof: JointDof, motor: MotorOptions): this {
    return this.drive(this.free(dof), motor);
  }
  /** Turns the motor off: every axis's, on a spherical or generic joint. */
  clearMotor(): this {
    const many =
        (this.type === 'spherical' || this.type === 'generic' || this.type === 'pinSlot' || this.type === 'cone') &&
        !this.removed,
      first = many
        ? this.type === 'generic' || this.type === 'pinSlot'
          ? 0
          : TURN
        : this.type === 'rope'
          ? SLIDE
          : this.unit(),
      { row } = this,
      columns = this.owner.kernel.columns;
    for (let axis = first; axis < first + (many ? 6 - first : 1); axis++) {
      columns.jointFlags[row] &= ~(JOINT_MOTOR_ON << axis);
      columns[`jointMotor${axis}`][row] = 0;
    }
    if (this.type === 'cone') columns.jointFlags[row] &= ~JOINT_DRIVE;
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
  /**
   * Lets this joint's limits give way past their edge as a spring of `hertz` and damping ratio `damping` (default 1), where the
   * default is a stop as stiff as a contact. A softer limit lets a limb go a little past its range under a load and brings it
   * back, as a ragdoll's limits do. `0` takes the world's contact stiffness again. The limit is still rigid up to its edge.
   * @throws RangeError unless `hertz` is 0 or above and finite, and `damping` above 0.
   */
  setLimitSoftness(hertz: number, damping = 1): this {
    if (!(hertz >= 0) || !Number.isFinite(hertz) || !(damping > 0) || !Number.isFinite(damping))
      throw new RangeError(
        "Limit softness needs a frequency of 0 or more hertz (0 is a contact's stiffness) and a damping ratio above 0.",
      );
    const { columns } = this.owner.kernel;
    columns.jointLimitHertz[this.row] = hertz;
    columns.jointLimitZeta[this.row] = damping;
    this.wake();
    return this;
  }
  /** The limit softness as `[hertz, damping]`, hertz 0 for a contact's stiffness. */
  get limitSoftness(): [number, number] {
    const { jointLimitHertz, jointLimitZeta } = this.owner.kernel.columns;
    return [jointLimitHertz[this.row], jointLimitZeta[this.row]];
  }
  private softAxes = 0;
  private softHertz = 0;
  private softDamping = 1;
  /**
   * Lets the joint's locks give way as a spring of its own, `hertz` and a damping ratio `damping` (default 1), in the
   * acceleration model: the spring is per kilogram, so a light body and a heavy one sag alike under a steady load, by its
   * acceleration over (2 pi hertz) squared. `0` makes the joint rigid again. The sliding locks go soft always, and the turning
   * locks when the joint locks all three or none: a hinge's or a slider's other turning locks stay rigid. A soft joint takes
   * no break limit (its load is a motor's, not a lock's), and `flip` refuses it.
   * @throws RangeError unless `hertz` is 0 or above and finite, and `damping` above 0.
   */
  setSoftness(hertz: number, damping = 1): this {
    this.live();
    if (!(hertz >= 0) || !Number.isFinite(hertz) || !(damping > 0) || !Number.isFinite(damping))
      throw new RangeError(
        'Joint softness needs a frequency of 0 or more hertz (0 is rigid) and a damping ratio above 0.',
      );
    const { row } = this,
      columns = this.owner.kernel.columns;
    if (hertz === 0 && this.softAxes === 0) return this;
    if (this.softAxes === 0) {
      const flags = columns.jointFlags[row],
        turns = [3, 4, 5].filter((axis) => flags & (JOINT_LOCK << axis)).length;
      for (let axis = 0; axis < 6; axis++)
        if (flags & (JOINT_LOCK << axis) && (axis < 3 || turns === 3)) this.softAxes |= 1 << axis;
    }
    const omega = 6.283185307179586 * hertz;
    for (let axis = 0; axis < 6; axis++) {
      if (!(this.softAxes & (1 << axis))) continue;
      if (hertz === 0) {
        columns.jointFlags[row] =
          (columns.jointFlags[row] & ~((JOINT_MOTOR_ON | JOINT_MOTOR_FORCE) << axis)) | (JOINT_LOCK << axis);
        columns[`jointStiffness${axis}`][row] = columns[`jointDamping${axis}`][row] = 0;
        columns[`jointCap${axis}`][row] = 0;
        columns[`jointMotor${axis}`][row] = 0;
      } else {
        columns[`jointTarget${axis}`][row] = columns[`jointSpeed${axis}`][row] = 0;
        columns[`jointStiffness${axis}`][row] = omega * omega;
        columns[`jointDamping${axis}`][row] = 2 * damping * omega;
        columns[`jointCap${axis}`][row] = Infinity;
        columns.jointFlags[row] =
          (columns.jointFlags[row] & ~((JOINT_LOCK | JOINT_MOTOR_FORCE) << axis)) | (JOINT_MOTOR_ON << axis);
      }
    }
    if (hertz === 0) this.softAxes = 0;
    this.softHertz = hertz;
    this.softDamping = hertz === 0 ? 1 : damping;
    this.wake();
    return this;
  }
  /** The softness as `[hertz, damping]`; `[0, 1]` for a rigid joint. */
  get softness(): [number, number] {
    return [this.softHertz, this.softDamping];
  }
  /**
   * The load that breaks the joint: newtons on its linear rows and newton metres on its angular rows, each `Infinity` for
   * never (the default). The load is what the joint's rows give in a substep over the substep's length, taken at the last
   * substep of a step. A joint that breaks solves nothing from then on, lets its bodies collide, wakes them and raises a
   * `jointbreak` event; {@link PhysicsJoint.repair} puts it back.
   * @throws RangeError unless each limit is above 0 or `Infinity`.
   */
  setBreakLimits(force: number, torque: number = Infinity): this {
    if (!(force > 0) || !(torque > 0))
      throw new RangeError('Break limits must be above 0, or Infinity for never; pass newtons and newton metres.');
    const { columns } = this.owner.kernel;
    columns.jointBreakForce[this.row] = force === Infinity ? 0 : force;
    columns.jointBreakTorque[this.row] = torque === Infinity ? 0 : torque;
    this.watched = force !== Infinity || torque !== Infinity;
    return this;
  }
  /** The break limits as `[force, torque]`, `Infinity` for never. */
  get breakLimits(): [number, number] {
    const { jointBreakForce, jointBreakTorque } = this.owner.kernel.columns;
    return [
      jointBreakForce[this.row] > 0 ? jointBreakForce[this.row] : Infinity,
      jointBreakTorque[this.row] > 0 ? jointBreakTorque[this.row] : Infinity,
    ];
  }
  /** True once the joint has broken, until {@link PhysicsJoint.repair}. */
  get broken(): boolean {
    return !this.removed && (this.owner.kernel.columns.jointFlags[this.row] & JOINT_BROKEN) !== 0;
  }
  /** Puts a broken joint back to work, with its limits as they were; the bodies wake. */
  repair(): this {
    if (this.removed) return this;
    const { jointFlags } = this.owner.kernel.columns;
    jointFlags[this.row] &= ~JOINT_BROKEN;
    this.reported = false;
    this.wake();
    return this;
  }
  /** @internal Has break limits, so the world looks at it after each step. */
  watched = false;
  /** @internal The world has raised its `jointbreak` event. */
  reported = false;
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
export function createJoint(
  owner: JointOwner,
  bodyA: PhysicsBody,
  bodyB: PhysicsBody,
  options: NextJointOptions,
): PhysicsJoint {
  const { type, anchorA = [0, 0, 0], anchorB = [0, 0, 0] } = options,
    couple = type === 'generic' ? coupling(options) : undefined,
    locked =
      type === 'generic'
        ? genericLocks(options.locked ?? []) | (couple?.swing ? JOINT_CONE | (JOINT_LIMIT << SWING) : 0)
        : locks[type];
  if (type === 'spring' && options.model !== undefined && options.model !== 'force' && options.model !== 'acceleration')
    throw new RangeError(`Spring model must be 'force' or 'acceleration'; got ${String(options.model)}.`);
  if (locked === undefined)
    throw new TypeError(
      `Unknown joint type ${String(type)}; use fixed, spherical, revolute, prismatic, cone, rope, spring or generic.`,
    );
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
  if (type === 'rope' && !(options.length > 0 && Number.isFinite(options.length)))
    throw new RangeError('Rope joint length must be a positive finite number; pass the longest anchor distance.');
  if (type === 'spring') {
    const { restLength, stiffness, damping = 0 } = options;
    if (!(restLength >= 0) || !Number.isFinite(restLength))
      throw new RangeError('Spring restLength must be a finite number of at least 0; pass the relaxed distance.');
    if (!(stiffness >= 0 && damping >= 0) || !Number.isFinite(stiffness) || !Number.isFinite(damping))
      throw new RangeError('Spring stiffness and damping must be finite numbers of at least 0; pass N/m and N*s/m.');
  }
  if (type === 'cone') {
    const { axis, swing, twist } = options;
    if ((frameA || frameB) && (!frameA || !frameB || axis))
      throw new TypeError('A joint takes an axis, or frameA and frameB together; pass one or the other.');
    if (axis) {
      checkVec(axis, 'Joint axis');
      if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) throw new RangeError('Joint axis must be nonzero');
    }
    swingLimits(swing);
    if (twist) checkLimits(twist[0], twist[1]);
  }
  if (type === 'pinSlot') {
    const { axis, slideLimits, turnLimits } = options;
    if (!axis && !(frameA && frameB))
      throw new TypeError(
        'A pin-slot joint needs an axis, or frameA and frameB together; pass the line it slides and turns on.',
      );
    if (axis && (frameA || frameB))
      throw new TypeError('A joint takes an axis, or frameA and frameB together; pass one or the other.');
    if (axis) {
      checkVec(axis, 'Joint axis');
      if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) throw new RangeError('Joint axis must be nonzero');
    }
    if (slideLimits) checkLimits(slideLimits[0], slideLimits[1]);
    if (turnLimits) checkLimits(turnLimits[0], turnLimits[1]);
  }
  if (frameA) checkFrame(frameA);
  if (frameB) checkFrame(frameB);
  if (options.breakForce !== undefined || options.breakTorque !== undefined)
    if (!((options.breakForce ?? Infinity) > 0) || !((options.breakTorque ?? Infinity) > 0))
      throw new RangeError('Break limits must be above 0, or Infinity for never; pass newtons and newton metres.');
  const spring = type === 'spring' && options.model === 'acceleration' ? ~(JOINT_MOTOR_FORCE << SLIDE) : -1,
    { kernel } = owner,
    row = kernel.addJoint(bodyA.row, bodyB.row, (locked & spring) | (options.contactsEnabled ? JOINT_CONTACTS : 0)),
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
  if (options.breakForce !== undefined || options.breakTorque !== undefined)
    joint.setBreakLimits(options.breakForce ?? Infinity, options.breakTorque ?? Infinity);
  joint.userData = options.userData;
  if (options.softness) {
    joint.setSoftness(options.softness.hertz, options.softness.damping);
  }
  if (options.enabled === false) columns.jointFlags[row] |= JOINT_DISABLED;
  if (type === 'rope') {
    columns.jointMin0[row] = -Infinity;
    columns.jointMax0[row] = options.length;
    if (options.motor) joint.setMotor(options.motor);
  }
  if (type === 'pinSlot') {
    if (options.axis) kernel.setJointAxis(row, options.axis);
    if (options.slideLimits) joint.setAxisLimits('linX', options.slideLimits[0], options.slideLimits[1]);
    if (options.turnLimits) joint.setAxisLimits('angX', options.turnLimits[0], options.turnLimits[1]);
    if (options.slideMotor) joint.setAxisMotor('linX', options.slideMotor);
    if (options.turnMotor) joint.setAxisMotor('angX', options.turnMotor);
  }
  if (type === 'spring') {
    columns.jointTarget0[row] = options.restLength;
    columns.jointStiffness0[row] = options.stiffness;
    columns.jointDamping0[row] = options.damping ?? 0;
    columns.jointCap0[row] = Infinity;
  }
  if (type === 'cone') {
    if (options.axis) kernel.setJointAxis(row, options.axis);
    joint.setCone(options.swing, options.twist);
  }
  if (type === 'generic') {
    if (couple?.swing) {
      // The swing across X is a cone's: no limit below it, an edge at `max` about Y and about Z.
      columns[`jointMin${SWING}`][row] = -Infinity;
      columns[`jointMax${SWING}`][row] = 0;
      columns[`jointMin${ELLIPSE}`][row] = couple.range[1];
      columns[`jointMax${ELLIPSE}`][row] = couple.range[1];
    } else if (couple) {
      columns.jointCouple[row] = couple.slide;
      // The measure is a distance, so a minimum of 0 is no limit at all (as a rope's).
      const axis = DOFS.indexOf(couple.first);
      columns[`jointMin${axis}`][row] = couple.range[0] > 0 ? couple.range[0] : -Infinity;
      columns[`jointMax${axis}`][row] = couple.range[1];
      columns.jointFlags[row] |= JOINT_LIMIT << axis;
    }
    for (const [dof, range] of Object.entries(options.limits ?? {}))
      if (range && !(couple && dof === couple.first)) joint.setAxisLimits(dof as JointDof, range[0], range[1]);
    for (const [dof, motor] of Object.entries(options.motors ?? {}))
      if (motor) joint.setAxisMotor(dof as JointDof, motor);
  }
  return joint;
}

/** What a generic joint's `coupled` axes ask for: the sliding axes' mask or the swing, and the axis the limit sits on. */
interface Coupling {
  slide: number;
  swing: boolean;
  first: JointDof;
  range: readonly [number, number];
}
function coupling(options: Extract<JointOptions, { type: 'generic' }>): Coupling | undefined {
  const { coupled, locked = [], limits = {}, motors = {} } = options;
  if (!coupled) return undefined;
  const axes = [...new Set(coupled)].sort((a, b) => DOFS.indexOf(a) - DOFS.indexOf(b));
  for (const dof of axes)
    if (!DOFS.includes(dof))
      throw new TypeError(`Unknown joint axis ${String(dof)}; use linX, linY, linZ, angX, angY or angZ.`);
  const slides = axes.filter((dof) => dof.startsWith('lin')),
    turns = axes.filter((dof) => dof.startsWith('ang'));
  if (slides.length && turns.length)
    throw new TypeError(
      'Coupled axes are of one kind: sliding axes together, or angY and angZ together; pass one group.',
    );
  if (axes.length < 2)
    throw new TypeError('Coupled axes need two or three axes to share a limit; pass linY and linZ, for example.');
  if (turns.length && !(turns.length === 2 && turns[0] === 'angY' && turns[1] === 'angZ'))
    throw new TypeError('Coupled turning axes are angY and angZ, the swing across X; pass both of them.');
  const first = axes[0]!;
  for (const dof of axes) {
    if (locked.includes(dof))
      throw new RangeError(`The joint locks ${dof}, so it cannot be coupled; leave it out of locked.`);
    if (dof !== first && limits[dof])
      throw new RangeError(
        `Coupled axes share one limit; put it on the first of them, limits.${first}, not limits.${dof}.`,
      );
    if (motors[dof])
      throw new RangeError(`Coupled axes have no motor of their own; drive ${dof} with a joint of its own.`);
  }
  const range = limits[first];
  if (!range)
    throw new RangeError(`Coupled axes need their limit on the first of them, limits.${first}; pass [min, max].`);
  checkLimits(range[0], range[1]);
  if (slides.length && range[0] < 0)
    throw new RangeError(
      'A coupled sliding limit measures a distance, so its min is 0 or more; pass [min, max] from 0.',
    );
  if (turns.length && range[0] !== 0)
    throw new RangeError('A coupled swing limit has a min of 0 and a max in radians; pass [0, max].');
  if (turns.length && !(range[1] > 0))
    throw new RangeError('A coupled swing limit needs a max above 0; pass [0, max] in radians.');
  return {
    slide: slides.reduce((mask, dof) => mask | (1 << DOFS.indexOf(dof)), 0),
    swing: turns.length > 0,
    first,
    range,
  };
}

/** The lock bits of a generic joint's `locked` axes. */
function genericLocks(locked: readonly JointDof[]): number {
  let bits = 0;
  for (const dof of locked) {
    const axis = DOFS.indexOf(dof);
    if (axis < 0) throw new TypeError(`Unknown joint axis ${String(dof)}; use linX, linY, linZ, angX, angY or angZ.`);
    bits |= JOINT_LOCK << axis;
  }
  return bits;
}

/** The square root by Newton's method, so a joint set up in one browser is the joint set up in another. */
function sqrtOf(value: number): number {
  let r = value > 1 ? value : 1;
  for (let i = 0; i < 40; i++) r = 0.5 * (r + value / r);
  return r;
}
