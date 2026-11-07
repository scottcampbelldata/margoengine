/// <reference lib="esnext.disposable" preserve="true" />
// A powered ragdoll: every joint's motor (a solver spring from @margoengine/physics) pulls its bone toward the pose the
// animation gives it, so a character keeps moving while it is physical, takes a hit, stumbles and comes back. Motors are
// joint torques: equal and opposite on the two bodies, so they cannot hold a character up by themselves. `root` adds a
// spring from the world to the root bone for that, in the implicit form of J. Tan, K. Liu, G. Turk, "Stable
// Proportional-Derivative Controllers", IEEE CG&A 2011. Written clean room from that description; no engine's source
// was read.
import type { Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import {
  conjugateQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import type { Ragdoll, RagdollJoint, RagdollPart } from './ragdoll.js';

/** Options of {@link addRagdollMotors}. Every field has a default. */
export interface RagdollMotorOptions {
  /** How fast a motor closes on its target, as a natural frequency in hertz, above 0. Default 6. */
  frequency?: number;
  /** Damping ratio, above 0: 1 settles without overshoot, less rings. Default 1. */
  damping?: number;
  /** Share of the motors' pull, 0 (limp) to 1. Default 1. */
  strength?: number;
  /**
   * The largest angular acceleration a motor may give the bones it carries, in rad/s², above 0. Each joint's torque cap
   * is this times the inertia of its limb about the joint at the pose motors were added in. Default 400, what the hands
   * and feet of a real walk clip need; less gives floppier limbs, and a hit stronger than the cap bends the joint.
   */
  maxAcceleration?: number;
  /**
   * Share of a spring from the world to the root bone, toward where the animation puts it, 0 to 1. Default 0: joint
   * motors alone, so a character with no support falls while keeping its pose. Above 0 it stays up, and a hit knocks it
   * away and it comes back. This is an outside force, not a muscle.
   */
  root?: number;
}

/** Options of {@link RagdollMotors.hit}. */
export interface RagdollHitOptions {
  /** World point of the hit. Default the body's centre of mass. */
  point?: readonly [number, number, number];
  /** Share of motor strength the struck limb loses at once, 0 to 1. Default 0.8. */
  weaken?: number;
  /** Seconds the limb takes to get its strength back, 0 or more. Default 0.6. */
  recover?: number;
}

const TWO_PI = Math.PI * 2,
  MASS_RATIO = 8,
  INERTIA_RATIO = 10;
const unitRange = (value: number, label: string): number => {
  if (!(value >= 0 && value <= 1)) throw new RangeError(`${label} must be from 0 to 1; pass a share.`);
  return value;
};
const above = (value: number, label: string): number => {
  if (!(value > 0) || value === Infinity) throw new RangeError(`${label} must be a finite number above 0.`);
  return value;
};

/** The swing and twist of the unit quaternion `d` about the unit `axis`: `d` is swing * twist. */
function swingTwist(d: ArrayLike<number>, axis: ArrayLike<number>): { swing: number[]; twist: number } {
  const dot = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2],
    length = Math.hypot(dot, d[3]);
  if (length < 1e-9) return { swing: [d[0], d[1], d[2], d[3]], twist: 0 };
  const twist = [(axis[0] * dot) / length, (axis[1] * dot) / length, (axis[2] * dot) / length, d[3] / length];
  let angle = 2 * Math.atan2(dot, d[3]);
  if (angle > Math.PI) angle -= TWO_PI;
  else if (angle < -Math.PI) angle += TWO_PI;
  return { swing: multiplyQuaternions([d[0], d[1], d[2], d[3]], conjugateQuaternion(twist)), twist: angle };
}
const aboutAxis = (axis: ArrayLike<number>, angle: number): number[] => {
  const sin = Math.sin(angle / 2);
  return [axis[0] * sin, axis[1] * sin, axis[2] * sin, Math.cos(angle / 2)];
};

/** The turn from the parent body that draws the part's animated pose. */
const bodyTurn = (part: RagdollPart): number[] =>
  multiplyQuaternions(
    [part.animated[3], part.animated[4], part.animated[5], part.animated[6]],
    conjugateQuaternion(part.bind),
  );

/**
 * The rotation a joint can reach nearest `rotation` (a bone relative to its parent), inside its limits, so a motor
 * never pulls against the limit it would have to pass. `part.spec` must be a cone or free joint.
 */
function insideLimits(part: RagdollPart, rotation: number[]): number[] {
  const spec = part.spec as Extract<RagdollJoint, { type: 'cone' | 'free' }>;
  if (spec.type === 'free') return rotation;
  const rest = part.rest,
    d = multiplyQuaternions(conjugateQuaternion(rest), rotation);
  if (d[3] < 0) for (let k = 0; k < 4; k++) d[k] = -d[k];
  const { swing, twist } = swingTwist(d, part.axis),
    [min, max] = spec.twist!,
    limit = spec.swing!,
    sin = Math.hypot(swing[0], swing[1], swing[2]),
    angle = 2 * Math.atan2(sin, Math.abs(swing[3]));
  const held = Math.min(max, Math.max(min, twist));
  if (angle <= limit && held === twist) return rotation;
  const sign = swing[3] < 0 ? -1 : 1,
    kept =
      angle > limit && sin > 1e-9
        ? aboutAxis([(swing[0] / sin) * sign, (swing[1] / sin) * sign, (swing[2] / sin) * sign], limit)
        : swing;
  return multiplyQuaternions(rest, multiplyQuaternions(kept, aboutAxis(part.axis, held)));
}

/** The motors of a ragdoll ({@link addRagdollMotors}). */
export class RagdollMotors {
  /** Largest angle between a powered bone and the pose its motor drives it to at the last physics step, in radians. */
  error = 0;
  private global: number;
  private goal: number;
  private rate = 0;
  private rootShare: number;
  private readonly omega: number;
  private readonly zeta: number;
  private readonly parts: readonly RagdollPart[];
  /** Inertia of each limb about its joint, kg m²: from where its mass lies, and as a rod per body. */
  private readonly limbs: Float64Array;
  private readonly rods: Float64Array;
  /** The inertia each motor's gains come from: the limb's, or the rod figure's for a foot on the floor, see {@link standing}. */
  private readonly gains: Float64Array;
  private readonly acceleration: number;
  /** The limb's own share of the strength, set by {@link setStrength}. */
  private readonly limb: Float64Array;
  /** Share lost to a hit, fading at `heal` per second. */
  private readonly lost: Float64Array;
  private readonly heal: Float64Array;
  private readonly running: Uint8Array;
  /** Each bone's share of the pull at the last step. */
  private readonly shares: Float64Array;
  /** Each bone's target when it last moved (xyzw, or the hinge angle first), and the spin that move gave it. */
  private readonly last: Float64Array;
  private readonly spin: Float64Array;
  private readonly waited: Float64Array;
  private readonly gap: Float64Array;
  private readonly seen: Uint8Array;
  /** Targets set by {@link setTarget}, by bone index, in place of the animation's pose. */
  private readonly targets = new Map<number, ArrayLike<number>>();
  private readonly off: () => void;
  private disposed = false;

  /** @internal use {@link addRagdollMotors}. */
  constructor(
    private readonly ragdoll: Ragdoll,
    options: RagdollMotorOptions,
  ) {
    this.omega = TWO_PI * above(options.frequency ?? 6, 'Ragdoll motor frequency');
    this.zeta = above(options.damping ?? 1, 'Ragdoll motor damping');
    this.global = this.goal = unitRange(options.strength ?? 1, 'Ragdoll motor strength');
    this.rootShare = unitRange(options.root ?? 0, 'Ragdoll motor root');
    this.acceleration = above(options.maxAcceleration ?? 400, 'Ragdoll motor maxAcceleration');
    const parts = (this.parts = ragdoll.bones),
      count = parts.length,
      rods = parts.map((part) => {
        const reach = rotateByQuaternion(part.axis, part.body.rotation),
          origin = part.body.position;
        return [0, 1, 2].map((k) => origin[k] + (reach[k] * part.length) / 2);
      }),
      centres = parts.map((part) => {
        const from = rotateByQuaternion(part.body.centerOfMass, part.body.rotation),
          origin = part.body.position;
        return [0, 1, 2].map((k) => origin[k] + from[k]);
      });
    this.limbs = new Float64Array(count);
    this.rods = new Float64Array(count);
    this.limb = new Float64Array(count).fill(1);
    this.lost = new Float64Array(count);
    this.heal = new Float64Array(count);
    this.running = new Uint8Array(count);
    this.shares = new Float64Array(count);
    this.last = new Float64Array(count * 4);
    this.spin = new Float64Array(count * 3);
    this.waited = new Float64Array(count);
    this.gap = new Float64Array(count);
    this.seen = new Uint8Array(count);
    // Each limb's inertia about its joint, by the parallel axis theorem: from where the mass really lies for the motors,
    // which must hold it against its weight, and as a rod per body for what steadies the solver (see addSteadying).
    const about = (joint: number, at: readonly number[][], own: (part: RagdollPart) => number): number => {
      const origin = parts[joint].body.position;
      let total = 0;
      for (let i = joint; i < count; i++) {
        if (!this.within(i, joint)) continue;
        const part = parts[i],
          d = Math.hypot(at[i][0] - origin[0], at[i][1] - origin[1], at[i][2] - origin[2]);
        total += part.body.mass * d * d + own(part);
      }
      return total;
    };
    const real = (part: RagdollPart): number => {
        const [x, y, z] = part.body.principalInertia;
        return (x + y + z) / 3;
      },
      rod = (part: RagdollPart): number => (part.body.mass * part.length * part.length) / 12;
    for (let i = 1; i < count; i++) {
      this.limbs[i] = about(i, centres, real);
      this.rods[i] = about(i, rods, rod);
    }
    this.gains = this.limbs.slice();
    for (const part of parts) this.addSteadying(part);
    this.off = ragdoll.physics.on('beforestep', (dt) => this.step(dt));
  }

  /**
   * Skeletons put small bodies between big limbs (a chest node between two arms, a foot under a shin), and an iterative
   * solver cannot hold a strong motor against a body hundreds of times lighter: on RiggedFigure the character flew apart.
   * Each body gets the extra mass and inertia that keep it within MASS_RATIO and INERTIA_RATIO of what it carries, and
   * `inertia` on top. This is what suits the solver, not a limb's true inertia, so it reckons with rods: the same ratio on the
   * true figures shook RiggedFigure at 0.009 m/s at 20 passes, on 85 of 96 hull roundings.
   * @internal for `@margoengine/ragdoll/balance`.
   */
  addSteadying(part: RagdollPart, inertia = 0): void {
    const parts = this.parts,
      i = parts.indexOf(part);
    let heaviest = part.parent === -1 ? 0 : parts[part.parent].mass,
      limb = 0;
    for (let j = i + 1; j < parts.length; j++)
      if (parts[j].parent === i) {
        heaviest = Math.max(heaviest, parts[j].mass);
        limb = Math.max(limb, this.rods[j]);
      }
    const mass = Math.max(0, heaviest / MASS_RATIO - part.mass),
      total = inertia + limb / INERTIA_RATIO;
    part.body.setAdditionalMass(mass, [total, total, total]);
  }

  /** True when bone `i` is `top` or hangs under it. Parents come first in the list. */
  private within(i: number, top: number): boolean {
    while (i > top) i = this.parts[i].parent;
    return i === top;
  }
  private live(): this {
    if (this.disposed) throw new MargoError('disposed', 'Ragdoll motors are disposed; call addRagdollMotors again.');
    return this;
  }
  private index(bone: Mesh | RagdollPart): number {
    const target = 'body' in bone ? bone.node : bone,
      index = this.parts.findIndex((part) => part.node === target);
    if (index < 0) throw new RangeError('That node is not a bone of this ragdoll; pass one of ragdoll.bones.');
    return index;
  }

  /** Inertia of `bone` and all that hangs from it about its joint, kg m², from where their mass lay when the motors were added. */
  limbInertia(bone: Mesh | RagdollPart): number {
    return this.limbs[this.index(bone)];
  }

  /** Share of the motors' pull, 0 (limp) to 1. Setting it stops a running {@link fade}. */
  get strength(): number {
    return this.global;
  }
  set strength(value: number) {
    this.global = this.goal = unitRange(value, 'Ragdoll motor strength');
    this.rate = 0;
  }
  /** Share of the world spring on the root bone, 0 to 1 (see {@link RagdollMotorOptions.root}). */
  get root(): number {
    return this.rootShare;
  }
  set root(value: number) {
    this.rootShare = unitRange(value, 'Ragdoll motor root');
  }
  /** Moves {@link strength} to `to` over `seconds`: to 0 to go limp gradually, to 1 to get up to speed. */
  fade(to: number, seconds: number): this {
    this.live();
    unitRange(to, 'Ragdoll motor strength');
    if (!(seconds >= 0) || seconds === Infinity)
      throw new RangeError('Ragdoll motor fade must be a finite number of seconds, 0 or more.');
    this.goal = to;
    if (seconds === 0) {
      this.global = to;
      this.rate = 0;
    } else this.rate = Math.abs(to - this.global) / seconds;
    return this;
  }
  /**
   * Drives `bone` to `rotation`, relative to its parent bone, in place of the pose the animation gives it: a controller
   * sets a leg from where its foot must go. Pass `null` to go back to the animation.
   * @throws RangeError for a node that is not a bone of this ragdoll.
   */
  setTarget(bone: Mesh | RagdollPart, rotation: readonly number[] | null): this {
    const index = this.index(bone);
    if (rotation) this.targets.set(index, rotation);
    else this.targets.delete(index);
    return this;
  }

  /** Sets the strength share of `bone` and every bone under it, 0 to 1: a limp arm on a powered body. */
  setStrength(bone: Mesh | RagdollPart, value: number): this {
    this.live();
    unitRange(value, 'Ragdoll motor strength');
    const top = this.index(bone);
    for (let i = top; i < this.parts.length; i++) if (this.within(i, top)) this.limb[i] = value;
    return this;
  }
  /**
   * Tells the motor of `bone` whether the floor carries that bone. Inertia sets a motor's gains so that it can hold a limb
   * against its weight, and a foot on the floor hangs from nothing: the floor holds it, and what its ankle carries is the
   * balance's. The limb's own inertia there slid Knight's feet 0.003 m, and a share of it growing with the foot's tilt shook
   * Mage at 0.041 m/s at 8 passes, so a standing foot keeps the rod figure's gains.
   * @internal for `@margoengine/ragdoll/balance`.
   */
  standing(bone: Mesh | RagdollPart, on: boolean): void {
    const i = this.index(bone);
    this.gains[i] = (on ? this.rods : this.limbs)[i];
  }
  /**
   * A hit: applies `impulse` (N s, world) to `bone` and weakens it, the bones under it and the bones above it up to
   * the root, so the blow travels through the body before the motors take the pose back.
   */
  hit(bone: Mesh | RagdollPart, impulse: readonly [number, number, number], options: RagdollHitOptions = {}): this {
    this.live();
    const struck = this.index(bone),
      weaken = unitRange(options.weaken ?? 0.8, 'Ragdoll hit weaken'),
      recover = options.recover ?? 0.6;
    if (!(recover >= 0) || recover === Infinity)
      throw new RangeError('Ragdoll hit recover must be a finite number of seconds, 0 or more.');
    const mark = (i: number): void => {
      this.lost[i] = Math.max(this.lost[i], weaken);
      this.heal[i] = recover > 0 ? this.lost[i] / recover : Infinity;
    };
    for (let i = struck; i < this.parts.length; i++) if (this.within(i, struck)) mark(i);
    for (let i = this.parts[struck].parent; i !== -1; i = this.parts[i].parent) mark(i);
    this.parts[struck].body.applyImpulse(impulse, options.point);
    return this;
  }

  private step(dt: number): void {
    if (this.disposed || !this.parts[0].body.valid) return;
    if (this.rate > 0) {
      const left = this.goal - this.global,
        move = this.rate * dt;
      this.global = Math.abs(left) <= move ? this.goal : this.global + Math.sign(left) * move;
      if (this.global === this.goal) this.rate = 0;
    }
    const { parts, omega, zeta, lost, heal, running } = this;
    let worst = 0;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i],
        joint = part.joint!;
      if (lost[i] > 0) lost[i] = Math.max(0, lost[i] - heal[i] * dt);
      const share = (this.shares[i] = this.global * this.limb[i] * (1 - lost[i]));
      if (part.body.type !== 'dynamic' || share <= 0) {
        if (running[i]) joint.clearMotor();
        running[i] = 0;
        continue;
      }
      running[i] = 1;
      const a = part.animated,
        inertia = this.gains[i],
        set = this.targets.get(i),
        rotation = set ? [set[0], set[1], set[2], set[3]] : bodyTurn(part),
        // Force based, with gains from the whole limb's inertia: an acceleration based motor sees only the two bodies at
        // the joint, not what hangs from them.
        motor = {
          model: 'force' as const,
          stiffness: inertia * omega * omega * share,
          damping: 2 * zeta * inertia * omega * Math.sqrt(share),
          maxForce: inertia * this.acceleration * share,
        };
      const spec = part.spec!;
      if (spec.type === 'hinge') {
        const [min, max] = spec.limits!,
          d = multiplyQuaternions(conjugateQuaternion(part.rest), rotation),
          { twist } = swingTwist(d, spec.axis),
          angle = Math.min(max, Math.max(min, twist));
        joint.setMotor({ targetPosition: angle, targetVelocity: this.hingeSpeed(i, angle, dt), ...motor });
        worst = Math.max(worst, this.apart(i, multiplyQuaternions(part.rest, aboutAxis(spec.axis, angle))));
      } else {
        const target = insideLimits(part, rotation);
        joint.setRotationMotor(target as [number, number, number, number], {
          ...motor,
          targetVelocity: this.ballSpeed(i, target, dt),
        });
        worst = Math.max(worst, this.apart(i, target));
      }
    }
    this.error = worst;
    if (this.rootShare > 0 && parts[0].body.type === 'dynamic') this.pullRoot(dt);
  }

  /**
   * The spin of the target itself, so a motor tracks a moving pose without lagging it by its damping. The animation moves
   * once a frame and physics steps at its own rate, so the spin is what changed over the steps since it last moved.
   */
  private ballSpeed(i: number, target: readonly number[], dt: number): [number, number, number] {
    const before = this.last.subarray(i * 4, i * 4 + 4),
      spin = this.spin.subarray(i * 3, i * 3 + 3);
    this.waited[i] += dt;
    if (before[0] === target[0] && before[1] === target[1] && before[2] === target[2] && before[3] === target[3])
      this.settle(i, dt);
    else {
      if (this.seen[i]) {
        // The change in the target's own frame: conj(before) * target, as a rotation vector over the time it took.
        const change = multiplyQuaternions(conjugateQuaternion(before), target),
          sign = change[3] < 0 ? -1 : 1,
          sin = Math.hypot(change[0], change[1], change[2]),
          scale = sin > 1e-9 ? ((2 * Math.atan2(sin, change[3] * sign)) / sin) * sign : 2 * sign;
        for (let k = 0; k < 3; k++) spin[k] = (change[k] * scale) / this.waited[i];
      }
      before.set(target);
      this.moved(i);
    }
    return [spin[0], spin[1], spin[2]];
  }
  private moved(i: number): void {
    this.seen[i] = 1;
    this.gap[i] = this.waited[i];
    this.waited[i] = 0;
  }
  /** A target that has stood still for longer than its last move took has stopped: its spin is 0. */
  private settle(i: number, dt: number): void {
    if (this.waited[i] > this.gap[i] + dt / 2) this.spin.fill(0, i * 3, i * 3 + 3);
  }
  private hingeSpeed(i: number, angle: number, dt: number): number {
    this.waited[i] += dt;
    if (this.last[i * 4] === angle) this.settle(i, dt);
    else {
      if (this.seen[i]) this.spin[i * 3] = (angle - this.last[i * 4]) / this.waited[i];
      this.last[i * 4] = angle;
      this.moved(i);
    }
    return this.spin[i * 3];
  }

  /** Angle between bone `i` and `target` (relative to its parent). */
  private apart(i: number, target: readonly number[]): number {
    const part = this.parts[i],
      relative = multiplyQuaternions(conjugateQuaternion(this.parts[part.parent].body.rotation), part.body.rotation),
      dot = Math.abs(
        relative[0] * target[0] + relative[1] * target[1] + relative[2] * target[2] + relative[3] * target[3],
      );
    return 2 * Math.acos(Math.min(1, dot));
  }

  /** The implicit spring from the world to the root bone. */
  private pullRoot(dt: number): void {
    const root = this.parts[0],
      node = root.node,
      store = node.engine.store,
      parentId = store.parents[node.id],
      a = root.animated;
    let position = [a[0], a[1], a[2]],
      rotation = bodyTurn(root);
    if (parentId !== -1) {
      const m = node.engine.meshes.get(parentId)!.matrix,
        sx = Math.hypot(m[0], m[1], m[2]),
        sy = Math.hypot(m[4], m[5], m[6]),
        sz = Math.hypot(m[8], m[9], m[10]),
        turn = normalizeQuaternion(rotationToQuaternion(m, new Float64Array(4), sx, sy, sz));
      rotation = multiplyQuaternions(turn, rotation);
      position = [0, 1, 2].map((k) => m[k] * a[0] + m[k + 4] * a[1] + m[k + 8] * a[2] + m[k + 12]);
    }
    // One change of velocity for the whole body, as if it were rigid: the spring moves the character and bends no joint,
    // and a light root is not flung ahead of the limbs it carries. Each bone takes it by its motor's share, so a limp limb
    // is carried by its joint and gravity still takes it.
    const w = this.omega * Math.sqrt(this.rootShare),
      c = 2 * this.zeta * w,
      implicit = dt / (1 + c * dt + w * w * dt * dt),
      origin = root.body.position,
      speed = root.body.linearVelocity,
      spin = root.body.angularVelocity,
      off = multiplyQuaternions(rotation, conjugateQuaternion(root.body.rotation)),
      sign = off[3] < 0 ? -1 : 1,
      sin = Math.hypot(off[0], off[1], off[2]),
      scale = sin > 1e-9 ? ((2 * Math.atan2(sin, off[3] * sign)) / sin) * sign : 2 * sign,
      move = [0, 1, 2].map((k) => implicit * (w * w * (position[k] - origin[k]) - c * speed[k])),
      turn = [0, 1, 2].map((k) => implicit * (w * w * off[k] * scale - c * spin[k]));
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i],
        share = i ? this.shares[i] : 1;
      if (share <= 0 || part.body.type !== 'dynamic') continue;
      const from = part.body.position,
        x = from[0] - origin[0],
        y = from[1] - origin[1],
        z = from[2] - origin[2],
        v = part.body.linearVelocity,
        a = part.body.angularVelocity;
      part.body.setLinearVelocity([
        v[0] + share * (move[0] + turn[1] * z - turn[2] * y),
        v[1] + share * (move[1] + turn[2] * x - turn[0] * z),
        v[2] + share * (move[2] + turn[0] * y - turn[1] * x),
      ]);
      part.body.setAngularVelocity([a[0] + share * turn[0], a[1] + share * turn[1], a[2] + share * turn[2]]);
    }
  }

  /** Turns the motors off and leaves the ragdoll as it was. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    if (!this.parts[0].body.valid) return;
    for (const part of this.parts) part.body.setAdditionalMass(0);
    for (let i = 1; i < this.parts.length; i++) if (this.running[i]) this.parts[i].joint!.clearMotor();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Adds joint motors to a ragdoll: while a bone is physical (`activate()`), its joint pulls it toward the pose the
 * animation gives it, inside the joint's limits, so the character keeps moving, takes hits and recovers instead of
 * going limp. Add it to a ragdoll built in a standing pose (each joint's torque cap comes from the limb's inertia).
 * @example
 * const ragdoll = Ragdoll.attach(physics, { root: hips });
 * const motors = addRagdollMotors(ragdoll, { root: 1 });
 * ragdoll.activate();
 * motors.hit(ragdoll.bones[1], [0, 0, -60]); // stumbles, then the animation has it back
 * @throws TypeError without a ragdoll, RangeError for an option out of range.
 */
export function addRagdollMotors(ragdoll: Ragdoll, options: RagdollMotorOptions = {}): RagdollMotors {
  if (!ragdoll?.bones || typeof ragdoll.physics?.on !== 'function')
    throw new TypeError('addRagdollMotors needs a Ragdoll: addRagdollMotors(ragdoll, {root: 1}).');
  return new RagdollMotors(ragdoll, options ?? {});
}
