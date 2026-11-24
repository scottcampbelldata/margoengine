// Mechanical constraints between two bodies' motions: a gear, a rack and pinion and a pulley. Each is one velocity constraint on a
// combination of two joints' speeds, solved every step as the soft constraint of Catto, "Soft Constraints", GDC 2011 (rigid by
// default: the position error of the combination is fed back by a share of the step), with the effective mass of the combination
// from the masses and inertias of the two bodies. They are written over a world, as `DragJoint` is, and act next to the
// ordinary joints that guide the bodies (a hinge for each gear, a slider for a rack); their impulses are the rope, tooth and
// belt forces. Baraff, "Linear-Time Dynamics using Lagrange Multipliers", SIGGRAPH 1996, is the form of a constraint between two
// bodies' coordinates as one row of the system.
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import type { PhysicsBody } from './body.js';
import { checkVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';

type V = [number, number, number];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3, label: string): V => {
  checkVec(a, label);
  const n = Math.hypot(a[0], a[1], a[2]);
  if (!(n > 0)) throw new RangeError(`${label} must not be zero.`);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** The inverse inertia of a body applied to a world vector. */
function inverseInertia(body: PhysicsBody, v: Vec3): V {
  if (body.type !== 'dynamic') return [0, 0, 0];
  const frame = multiplyQuaternions(body.rotation, body.inertiaFrame),
    moments = body.principalInertia;
  let out: V = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (!(moments[k]! > 0)) continue;
    const axis = rotateByQuaternion(k === 0 ? [1, 0, 0] : k === 1 ? [0, 1, 0] : [0, 0, 1], frame) as V;
    out = add(out, scale(axis, dot(axis, v) / moments[k]!));
  }
  return out;
}
const inverseMass = (body: PhysicsBody): number => (body.type === 'dynamic' && body.mass > 0 ? 1 / body.mass : 0);
const local = (body: PhysicsBody, v: Vec3): V => rotateByQuaternion(v, body.rotation) as V;

/** Options of a mechanism's constraint. */
export interface MechanismOptions {
  /** The constraint's stiffness as a natural frequency in hertz (default 0: rigid, its error corrected by `correction`). */
  frequency?: number;
  /** Damping ratio of a soft constraint (default 1). */
  damping?: number;
  /** The share of the position error a rigid constraint removes each step (default 0.2). */
  correction?: number;
}

abstract class Mechanism implements PhysicsAttachment {
  protected error = 0;
  /** Whether `measure` reads the position error itself instead of leaving it to follow from the speed. */
  protected absolute = false;
  private released = false;
  private readonly frequency: number;
  private readonly softRatio: number;
  private readonly share: number;
  protected last = 1 / 60;

  protected constructor(
    protected readonly physics: Physics,
    protected readonly a: PhysicsBody,
    protected readonly b: PhysicsBody,
    options: MechanismOptions,
  ) {
    const { frequency = 0, damping = 1, correction = 0.2 } = options;
    if (!(frequency >= 0 && Number.isFinite(frequency)))
      throw new RangeError('Frequency is 0 (rigid) or a number of hertz.');
    if (!(damping >= 0 && Number.isFinite(damping))) throw new RangeError('Damping ratio is 0 or more.');
    if (!(correction >= 0 && correction <= 1)) throw new RangeError('Correction is a share from 0 to 1.');
    this.frequency = frequency;
    this.softRatio = damping;
    this.share = correction;
    physics.attach(this);
  }

  /** The speed of the constrained combination now, its inverse mass, and where to apply a unit of impulse. */
  protected abstract measure(): { speed: number; inverse: number };
  protected abstract apply(impulse: number): void;

  /** @internal */
  beforeStep(dt: number): void {
    if (this.released || !this.a.valid || !this.b.valid) return;
    const { speed, inverse } = this.measure();
    // The position error of the combination follows from its speed one step behind.
    if (!this.absolute) this.error += speed * this.last;
    this.last = dt;
    if (!(inverse > 0)) return;
    let beta = this.share / dt,
      gamma = 0;
    if (this.frequency > 0) {
      const mass = 1 / inverse,
        omega = 2 * Math.PI * this.frequency,
        d = 2 * mass * this.softRatio * omega,
        k = mass * omega * omega;
      gamma = 1 / (dt * (d + dt * k));
      beta = k / (d + dt * k);
    }
    this.apply(-(speed + beta * this.error) / (inverse + gamma));
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.a || body === this.b) this.remove();
  }

  /** Lets go of the constraint. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }
}

/** Options of {@link GearJoint}. */
export interface GearOptions extends MechanismOptions {
  /** Turn axis of the first gear in its own frame (default z). */
  axisA?: Vec3;
  /** Turn axis of the second gear in its own frame (default z). */
  axisB?: Vec3;
  /** Teeth ratio (default 1): the first gear's angle plus `ratio` times the second's stays constant, so with a positive ratio the gears turn opposite ways about their axes. */
  ratio?: number;
}

/**
 * A gear: the angle of the first body about its axis plus `ratio` times the angle of the second about its own stays what it was
 * when the gear was made (Box2D's and Jolt's gear joint, for two hinged bodies). Hinge each body to the world or a frame, then join
 * them.
 */
export class GearJoint extends Mechanism {
  private readonly axisA: V;
  private readonly axisB: V;
  private readonly ratio: number;
  constructor(physics: Physics, bodyA: PhysicsBody, bodyB: PhysicsBody, options: GearOptions = {}) {
    super(physics, bodyA, bodyB, options);
    this.axisA = unit(options.axisA ?? [0, 0, 1], 'Axis A');
    this.axisB = unit(options.axisB ?? [0, 0, 1], 'Axis B');
    this.ratio = options.ratio ?? 1;
    if (!Number.isFinite(this.ratio) || this.ratio === 0) throw new RangeError('A gear ratio is a nonzero number.');
  }
  private worldAxes(): [V, V] {
    return [local(this.a, this.axisA), local(this.b, this.axisB)];
  }
  protected override measure(): { speed: number; inverse: number } {
    const [wa, wb] = this.worldAxes();
    return {
      speed: dot(this.a.angularVelocity, wa) + this.ratio * dot(this.b.angularVelocity, wb),
      inverse: dot(wa, inverseInertia(this.a, wa)) + this.ratio * this.ratio * dot(wb, inverseInertia(this.b, wb)),
    };
  }
  protected override apply(impulse: number): void {
    const [wa, wb] = this.worldAxes();
    this.a.applyTorqueImpulse(scale(wa, impulse));
    this.b.applyTorqueImpulse(scale(wb, impulse * this.ratio));
  }
}

/** Options of {@link RackAndPinionJoint}. */
export interface RackAndPinionOptions extends MechanismOptions {
  /** Turn axis of the pinion in its frame (default z). */
  pinionAxis?: Vec3;
  /** Direction the rack slides, in its frame (default x). */
  rackAxis?: Vec3;
  /** Pitch radius of the pinion in metres (default 1): the rack moves this far a radian. */
  radius?: number;
}

/**
 * A rack and pinion: the rack slides `radius` metres for each radian the pinion turns (with the pinion's angle times the radius
 * plus the rack's position along its axis staying what it was when the joint was made). Hinge the pinion and slide the rack on
 * their own joints, then join them.
 */
export class RackAndPinionJoint extends Mechanism {
  private readonly pinion: V;
  private readonly rack: V;
  private readonly radius: number;
  constructor(physics: Physics, pinion: PhysicsBody, rack: PhysicsBody, options: RackAndPinionOptions = {}) {
    super(physics, pinion, rack, options);
    this.pinion = unit(options.pinionAxis ?? [0, 0, 1], 'Pinion axis');
    this.rack = unit(options.rackAxis ?? [1, 0, 0], 'Rack axis');
    this.radius = options.radius ?? 1;
    if (!(this.radius > 0 && Number.isFinite(this.radius)))
      throw new RangeError('Pinion radius is a positive number of metres.');
  }
  protected override measure(): { speed: number; inverse: number } {
    const wp = local(this.a, this.pinion),
      wr = local(this.b, this.rack);
    return {
      speed: this.radius * dot(this.a.angularVelocity, wp) + dot(this.b.linearVelocity, wr),
      inverse: this.radius * this.radius * dot(wp, inverseInertia(this.a, wp)) + inverseMass(this.b),
    };
  }
  protected override apply(impulse: number): void {
    const wp = local(this.a, this.pinion),
      wr = local(this.b, this.rack);
    this.a.applyTorqueImpulse(scale(wp, impulse * this.radius));
    this.b.applyImpulse(scale(wr, impulse));
  }
}

/** Options of {@link PulleyJoint}. */
export interface PulleyOptions extends MechanismOptions {
  /** World point the rope runs over on the first side. */
  groundA: Vec3;
  /** World point the rope runs over on the second side. */
  groundB: Vec3;
  /** Where the rope is tied to the first body, in its frame (default its centre). */
  anchorA?: Vec3;
  /** Where the rope is tied to the second body, in its frame (default its centre). */
  anchorB?: Vec3;
  /** The second length counts this many times (default 1): the block and tackle of a lifting pulley. */
  ratio?: number;
}

/**
 * A pulley: the rope length on the first side plus `ratio` times the length on the second stays what it was when the joint was made,
 * so one body rises as the other falls (Box2D's and Jolt's pulley). The rope may go slack where gravity does not pull it taut: it
 * only pulls, never pushes.
 */
export class PulleyJoint extends Mechanism {
  private readonly groundA: V;
  private readonly groundB: V;
  private readonly anchorA: V;
  private readonly anchorB: V;
  private readonly ratio: number;
  private readonly total: number;
  constructor(physics: Physics, bodyA: PhysicsBody, bodyB: PhysicsBody, options: PulleyOptions) {
    super(physics, bodyA, bodyB, options);
    checkVec(options.groundA, 'Ground A');
    checkVec(options.groundB, 'Ground B');
    this.groundA = [...options.groundA];
    this.groundB = [...options.groundB];
    this.anchorA = options.anchorA ? ([...options.anchorA] as V) : [0, 0, 0];
    this.anchorB = options.anchorB ? ([...options.anchorB] as V) : [0, 0, 0];
    this.ratio = options.ratio ?? 1;
    if (!(this.ratio > 0 && Number.isFinite(this.ratio))) throw new RangeError('A pulley ratio is a positive number.');
    this.total = this.lengthA() + this.ratio * this.lengthB();
    this.absolute = true;
  }
  private point(body: PhysicsBody, anchor: V): V {
    return add(body.position, local(body, anchor));
  }
  private lengthA(): number {
    const d = sub(this.point(this.a, this.anchorA), this.groundA);
    return Math.hypot(d[0], d[1], d[2]);
  }
  private lengthB(): number {
    const d = sub(this.point(this.b, this.anchorB), this.groundB);
    return Math.hypot(d[0], d[1], d[2]);
  }
  private ropes(): { ua: V; ub: V; ra: V; rb: V } {
    const pa = this.point(this.a, this.anchorA),
      pb = this.point(this.b, this.anchorB),
      da = sub(pa, this.groundA),
      db = sub(pb, this.groundB),
      la = Math.hypot(da[0], da[1], da[2]) || 1,
      lb = Math.hypot(db[0], db[1], db[2]) || 1;
    return { ua: scale(da, 1 / la), ub: scale(db, 1 / lb), ra: sub(pa, this.a.position), rb: sub(pb, this.b.position) };
  }
  protected override measure(): { speed: number; inverse: number } {
    const { ua, ub, ra, rb } = this.ropes(),
      va = add(this.a.linearVelocity, cross(this.a.angularVelocity, ra)),
      vb = add(this.b.linearVelocity, cross(this.b.angularVelocity, rb)),
      speed = dot(ua, va) + this.ratio * dot(ub, vb);
    this.error = this.lengthA() + this.ratio * this.lengthB() - this.total;
    const k = (u: V, r: V, body: PhysicsBody): number => {
      const n = cross(r, u);
      return inverseMass(body) + dot(n, inverseInertia(body, n));
    };
    return { speed, inverse: k(ua, ra, this.a) + this.ratio * this.ratio * k(ub, rb, this.b) };
  }
  protected override apply(impulse: number): void {
    // A rope pulls and does not push: only an impulse that shortens the whole (negative along the ropes' growth) is kept.
    if (impulse > 0 || this.error < -1e-4) return;
    const { ua, ub, ra, rb } = this.ropes(),
      pa = scale(ua, impulse),
      pb = scale(ub, impulse * this.ratio);
    this.a.applyImpulse(pa, add(this.a.position, ra));
    this.b.applyImpulse(pb, add(this.b.position, rb));
  }
}
