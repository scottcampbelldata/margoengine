/// <reference lib="esnext.disposable" preserve="true" />
// A character that stays on its feet: it watches the capture point of its centre of mass (J. Pratt et al., "Capture Point:
// A Step toward Humanoid Push Recovery", Humanoids 2006; the point where a step stops the fall of an inverted pendulum)
// and swings a foot there, in the manner of SIMBICON (K. Yin, K. Loken, M. van de Panne, SIGGRAPH 2007). Joint motors do
// the work: two-bone maths sets each leg from where the hips should be to where its foot is. Motors alone cannot hold a
// body up without a far stronger controller, so this one is an assist and says so: `carry` is an outside force under part
// of the upper body's weight and `upright` an outside torque, both capped, and `carried` reports what they gave.
// Written clean room from those papers; no engine's source was read.
import type { Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { conjugateQuaternion, multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import type { RagdollMotors } from './powered.js';
import type { Ragdoll, RagdollPart } from './ragdoll.js';

type Vec3 = [number, number, number];

/** Options of {@link addRagdollBalance}. */
export interface RagdollBalanceOptions {
  /** The two foot bones. Each foot's parent bone must be a knee hinge, as `humanoidProfile` builds. */
  feet: readonly [Mesh | RagdollPart, Mesh | RagdollPart];
  /** Seconds a step takes. Default 0.28. */
  stepTime?: number;
  /** How high a foot lifts, as a share of the leg's length. Default 0.15. */
  stepHeight?: number;
  /** How far the capture point may leave the feet before a step, as a share of the leg's length. Default 0.2. */
  stepTrigger?: number;
  /** Hip height held, as a share of the height the character was added at. Default 0.97: knees a little bent. */
  stance?: number;
  /** Share of the upper body's weight an outside force carries, 0 to 1. Default 0.6. */
  carry?: number;
  /** Frequency in rad/s of the outside torque that holds the hips upright. Default 10. */
  upright?: number;
  /** Largest turn that torque gives, in rad/s². A harder blow than this can hold knocks the character over. Default 40. */
  maxUpright?: number;
  /** Tilt of the hips in radians past which the character has fallen and every assist stops. Default 0.8. */
  fallTilt?: number;
  /** World gravity along up, in m/s². Default 9.81. */
  gravity?: number;
}

/** What a balancing character is doing. */
export type RagdollBalanceState = 'standing' | 'stepping' | 'fallen';

interface Leg {
  upper: RagdollPart;
  lower: RagdollPart;
  foot: RagdollPart;
  thigh: number;
  shin: number;
  /** Rest directions of the thigh and shin, and each bone's rest rotation in the world. */
  rest: Vec3;
  upperRest: number[];
  footRest: number[];
  /** The hip joint from the hips' origin, at rest. */
  hip: Vec3;
  plant: Vec3;
  swing: { from: Vec3; to: Vec3; t: number } | null;
}

const add = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const minus = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const times = (a: ArrayLike<number>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const size = (a: ArrayLike<number>): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: ArrayLike<number>): Vec3 => times(a, 1 / size(a));
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const turnAbout = (axis: ArrayLike<number>, angle: number): number[] => {
  const sin = Math.sin(angle / 2);
  return [axis[0] * sin, axis[1] * sin, axis[2] * sin, Math.cos(angle / 2)];
};
/** Shortest turn from the unit `a` to the unit `b`. */
function arc(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const c = cross(a, b),
    w = 1 + dot(a, b),
    length = Math.hypot(c[0], c[1], c[2], w);
  return length < 1e-9 ? [1, 0, 0, 0] : [c[0] / length, c[1] / length, c[2] / length, w / length];
}
const ease = (t: number): number => t * t * (3 - 2 * t);
const within = (value: number | undefined, fallback: number, low: number, high: number, name: string): number => {
  const v = value ?? fallback;
  if (!(v >= low && v <= high)) throw new RangeError(`Ragdoll balance ${name} must be from ${low} to ${high}.`);
  return v;
};

/** A character keeping its feet ({@link addRagdollBalance}). */
export class RagdollBalance {
  /** What the character is doing. */
  state: RagdollBalanceState = 'standing';
  /** Steps started so far. */
  steps = 0;
  /** Where a step now would stop the fall, in the world, on the ground. */
  capture: Vec3 = [0, 0, 0];
  /** Share of the whole body's weight the outside force carried at the last physics step. */
  carried = 0;
  private readonly legs: [Leg, Leg];
  private readonly upper: readonly RagdollPart[];
  private readonly standing: readonly number[];
  private readonly up: Vec3 = [0, 1, 0];
  private readonly forward: Vec3;
  private readonly total: number;
  private readonly upperShare: number;
  private readonly height: number;
  private readonly natural: number;
  private readonly stepTime: number;
  private readonly lift: number;
  private readonly trigger: number;
  private readonly stance: number;
  private readonly carry: number;
  private readonly upright: number;
  private readonly maxUpright: number;
  private readonly fallTilt: number;
  private readonly gravity: number;
  private readonly hipsOverFeet: Vec3;
  private readonly off: () => void;
  private disposed = false;

  /** @internal use {@link addRagdollBalance}. */
  constructor(
    private readonly ragdoll: Ragdoll,
    private readonly motors: RagdollMotors,
    options: RagdollBalanceOptions,
  ) {
    const bones = ragdoll.bones,
      hips = bones[0],
      find = (item: Mesh | RagdollPart): RagdollPart => {
        const node = item && 'body' in item ? item.node : item,
          part = bones.find((candidate) => candidate.node === node);
        if (!part) throw new RangeError('That node is not a bone of this ragdoll; pass feet from ragdoll.bones.');
        return part;
      };
    if (!Array.isArray(options?.feet) || options.feet.length !== 2)
      throw new TypeError('addRagdollBalance needs two feet: addRagdollBalance(ragdoll, motors, {feet: [left, right]}).');
    const leg = (item: Mesh | RagdollPart): Leg => {
      const foot = find(item),
        lower = bones[foot.parent],
        upper = lower && bones[lower.parent];
      if (!upper || upper === hips || lower.spec?.type !== 'hinge')
        throw new RangeError('Each foot needs a knee hinge and a thigh above it; build the ragdoll with humanoidProfile.');
      const hip = upper.body.position,
        knee = lower.body.position,
        ankle = foot.body.position;
      return {
        upper,
        lower,
        foot,
        thigh: size(minus(knee, hip)),
        shin: size(minus(ankle, knee)),
        rest: unit(minus(knee, hip)),
        upperRest: [...upper.body.rotation],
        footRest: [...foot.body.rotation],
        hip: minus(hip, hips.body.position),
        plant: [ankle[0], ankle[1], ankle[2]],
        swing: null,
      };
    };
    this.legs = [leg(options.feet[0]), leg(options.feet[1])];
    const [left, right] = this.legs,
      inLegs = new Set(this.legs.flatMap(({ upper, lower, foot }) => [upper, lower, foot]));
    // Every other bone under a leg (toes) moves with its foot.
    for (const part of bones) if (inLegs.has(bones[part.parent])) inLegs.add(part);
    this.upper = bones.filter((part) => !inLegs.has(part));
    this.standing = [...hips.body.rotation];
    const reach = (left.thigh + left.shin + right.thigh + right.shin) / 2,
      centre = times(add(left.plant, right.plant), 0.5),
      sideways = minus(left.plant, right.plant);
    this.hipsOverFeet = minus(hips.body.position, centre);
    // Left of a character is +x when it faces +z with y up: its forward is left x up.
    this.forward = unit(cross(unit(sideways), this.up));
    this.total = bones.reduce((sum, part) => sum + part.mass, 0);
    this.upperShare = this.upper.reduce((sum, part) => sum + part.mass, 0) / this.total;
    this.height = dot(this.hipsOverFeet, this.up);
    let massHeight = 0;
    for (const part of bones) massHeight += part.mass * dot(minus(part.body.position, centre), this.up);
    this.gravity = within(options.gravity, 9.81, 0.01, 1000, 'gravity');
    this.natural = Math.sqrt(this.gravity / (massHeight / this.total));
    this.stepTime = within(options.stepTime, 0.28, 0.05, 2, 'stepTime');
    this.lift = within(options.stepHeight, 0.15, 0, 1, 'stepHeight') * reach;
    this.trigger = within(options.stepTrigger, 0.2, 0, 2, 'stepTrigger') * reach;
    this.stance = within(options.stance, 0.97, 0.5, 1, 'stance');
    this.carry = within(options.carry, 0.6, 0, 1, 'carry');
    this.upright = within(options.upright, 10, 0, 1000, 'upright');
    this.maxUpright = within(options.maxUpright, 40, 0, 1e6, 'maxUpright');
    this.fallTilt = within(options.fallTilt, 0.8, 0.01, Math.PI, 'fallTilt');
    this.off = ragdoll.physics.on('beforestep', (dt) => this.step(dt));
  }

  /** Radians the hips lean from how they stood. */
  get tilt(): number {
    const up = rotateByQuaternion(
      this.up,
      multiplyQuaternions(this.ragdoll.bones[0].body.rotation, conjugateQuaternion(this.standing)),
    );
    return Math.acos(Math.min(1, Math.max(-1, dot(up, this.up))));
  }

  private step(dt: number): void {
    if (this.disposed || this.state === 'fallen' || !this.ragdoll.bones[0].body.valid) return;
    if (this.ragdoll.bones[0].body.type !== 'dynamic') return;
    if (this.tilt > this.fallTilt) {
      this.fall();
      return;
    }
    this.capture = this.capturePoint();
    const [a, b] = this.legs,
      centre = times(add(a.plant, b.plant), 0.5),
      swinging = a.swing ? a : b.swing ? b : null;
    if (!swinging && this.outside(a.plant, b.plant) > this.trigger) this.startStep();
    const moving = a.swing ? a : b.swing ? b : null;
    let support = centre;
    if (moving) {
      const other = moving === a ? b : a,
        t = ease(Math.min(1, moving.swing!.t)),
        landing = times(add(moving.swing!.to, other.plant), 0.5);
      support = add(times(centre, 1 - t), times(landing, t));
    }
    const hips = add(support, [
      this.hipsOverFeet[0] * (this.up[0] ? this.stance : 1),
      this.hipsOverFeet[1] * (this.up[1] ? this.stance : 1),
      this.hipsOverFeet[2] * (this.up[2] ? this.stance : 1),
    ]);
    for (const leg of this.legs) this.driveLeg(leg, hips, dt);
    this.state = this.legs.some((leg) => leg.swing) ? 'stepping' : 'standing';
    this.assist(dt, centre);
  }

  /** The capture point: the centre of mass plus its velocity over the pendulum's natural frequency, on the ground. */
  private capturePoint(): Vec3 {
    const position: Vec3 = [0, 0, 0],
      velocity: Vec3 = [0, 0, 0];
    for (const part of this.ragdoll.bones) {
      const x = part.body.position,
        v = part.body.linearVelocity;
      for (let k = 0; k < 3; k++) {
        position[k] += x[k] * part.mass;
        velocity[k] += v[k] * part.mass;
      }
    }
    const point = add(times(position, 1 / this.total), times(velocity, 1 / (this.total * this.natural))),
      ground = Math.min(dot(this.legs[0].plant, this.up), dot(this.legs[1].plant, this.up));
    return add(point, times(this.up, ground - dot(point, this.up)));
  }

  /** How far the capture point lies from the line between two planted feet, across the ground. */
  private outside(a: Vec3, b: Vec3): number {
    const line = minus(b, a),
      flat = minus(line, times(this.up, dot(line, this.up))),
      t = Math.min(1, Math.max(0, dot(minus(this.capture, a), flat) / Math.max(dot(flat, flat), 1e-9))),
      gap = minus(this.capture, add(a, times(flat, t)));
    return size(minus(gap, times(this.up, dot(gap, this.up))));
  }

  private startStep(): void {
    const [a, b] = this.legs,
      away = (leg: Leg): number => size(minus(this.capture, leg.plant)),
      leg = away(a) >= away(b) ? a : b,
      other = leg === a ? b : a,
      // Land beside the capture point, on the foot's own side, so the feet do not cross.
      side = unit(minus(leg.plant, other.plant)),
      apart = size(minus(leg.plant, other.plant)),
      hip = add(this.ragdoll.bones[0].body.position, leg.hip),
      height = this.height * this.stance;
    let to = add(this.capture, times(side, Math.min(apart, this.trigger) / 2));
    to = add(to, times(this.up, dot(leg.plant, this.up) - dot(to, this.up)));
    // No farther than the leg reaches from the hips at standing height.
    const room = Math.sqrt(Math.max(0, (leg.thigh + leg.shin) ** 2 * 0.9 - height * height)),
      flat = minus(to, hip),
      across = minus(flat, times(this.up, dot(flat, this.up))),
      length = size(across);
    if (length > room) to = add(to, times(across, room / length - 1));
    leg.swing = { from: leg.plant, to, t: 0 };
    this.steps++;
  }

  /** Sets a leg's motors so its foot reaches the plant or the swing from `hips`, where the hips should be. */
  private driveLeg(leg: Leg, hips: Vec3, dt: number): void {
    const motors = this.motors,
      body = this.ragdoll.bones[0].body;
    let target = leg.plant;
    if (leg.swing) {
      const swing = leg.swing;
      swing.t += dt / this.stepTime;
      const t = Math.min(1, swing.t),
        e = ease(t);
      target = add(add(times(swing.from, 1 - e), times(swing.to, e)), times(this.up, this.lift * Math.sin(Math.PI * t)));
      if (t >= 1) {
        leg.plant = swing.to;
        leg.swing = null;
      }
    }
    const line = minus(target, add(hips, leg.hip)),
      { thigh, shin } = leg,
      distance = Math.min(size(line), (thigh + shin) * 0.999),
      direction = unit(line),
      // Law of cosines for the knee, and for the thigh's angle off the hip-to-foot line.
      knee = Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + shin * shin - distance * distance) / (2 * thigh * shin)))),
      lean = Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + distance * distance - shin * shin) / (2 * thigh * distance)))),
      out = rotateByQuaternion(direction, turnAbout(unit(cross(direction, this.forward)), lean)),
      upper = multiplyQuaternions(arc(leg.rest, out), leg.upperRest),
      spec = leg.lower.spec as { axis: ArrayLike<number>; limits: readonly [number, number] },
      bend = Math.min(spec.limits[1], Math.max(spec.limits[0], Math.PI - knee));
    motors.setTarget(leg.upper, multiplyQuaternions(conjugateQuaternion(body.rotation), upper));
    motors.setTarget(leg.lower, multiplyQuaternions(leg.lower.rest, turnAbout(spec.axis, bend)));
    motors.setTarget(leg.foot, multiplyQuaternions(conjugateQuaternion(leg.lower.body.rotation), leg.footRest));
  }

  /** The outside help: a capped torque toward upright and a capped force under the upper body, moved as one rigid body. */
  private assist(dt: number, centre: Vec3): void {
    const hips = this.ragdoll.bones[0].body,
      error = multiplyQuaternions(this.standing, conjugateQuaternion(hips.rotation)),
      sign = error[3] < 0 ? -1 : 1,
      sin = Math.hypot(error[0], error[1], error[2]),
      angle = sin > 1e-9 ? (2 * Math.atan2(sin, error[3] * sign) * sign) / sin : 2 * sign,
      w = this.upright,
      c = 2 * w,
      gain = dt / (1 + c * dt + w * w * dt * dt),
      spin = hips.angularVelocity,
      turn = [0, 1, 2].map((k) => gain * (w * w * error[k] * angle - c * spin[k])),
      cap = this.maxUpright * dt,
      strength = size(turn);
    if (strength > cap) for (let k = 0; k < 3; k++) turn[k] *= cap / strength;
    // Implicit spring to standing height, on top of the share of the weight it carries.
    const v = 8,
      damping = 2 * v,
      share = dt / (1 + damping * dt + v * v * dt * dt),
      want = dot(centre, this.up) + this.height * this.stance,
      height = dot(hips.position, this.up),
      weight = this.gravity * dt * this.carry,
      rise = Math.max(
        0,
        Math.min(share * (v * v * (want - height) - damping * dot(hips.linearVelocity, this.up)) + weight, weight * 1.5),
      );
    this.carried = (rise / (this.gravity * dt)) * this.upperShare;
    const origin = hips.position;
    for (const part of this.upper) {
      const body = part.body,
        x = minus(body.position, origin),
        moved = add(add(body.linearVelocity, cross(turn, x)), times(this.up, rise));
      body.setLinearVelocity(moved);
      body.setAngularVelocity(add(body.angularVelocity, turn));
    }
  }

  private fall(): void {
    this.state = 'fallen';
    this.carried = 0;
    for (const leg of this.legs) {
      leg.swing = null;
      for (const part of [leg.upper, leg.lower, leg.foot]) this.motors.setTarget(part, null);
    }
  }

  /** Stands again from where the feet are, after a get-up or a teleport. */
  reset(): this {
    if (this.disposed) throw new MargoError('disposed', 'This balance is disposed; call addRagdollBalance again.');
    for (const leg of this.legs) {
      const at = leg.foot.body.position;
      leg.plant = [at[0], at[1], at[2]];
      leg.swing = null;
    }
    this.state = 'standing';
    return this;
  }

  /** Stops balancing and hands the legs back to the animation's pose. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.fall();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Keeps a powered ragdoll on its feet: it stands, and steps to where its momentum says it must when pushed. Add it with the
 * character standing still in the pose to hold, before `activate`. It is an assist: part of the body's weight and its
 * upright torque come from outside, capped, so a hard enough blow still knocks it over.
 * @example
 * const motors = addRagdollMotors(ragdoll, { frequency: 8 });
 * const balance = addRagdollBalance(ragdoll, motors, { feet: [leftFoot, rightFoot] });
 * ragdoll.activate();
 * motors.hit(chest, [0, 0, -40]); // it stumbles and catches itself; balance.steps counts how
 * @throws TypeError without a ragdoll, motors or two feet, RangeError for a foot with no knee hinge or an option out of range.
 */
export function addRagdollBalance(
  ragdoll: Ragdoll,
  motors: RagdollMotors,
  options: RagdollBalanceOptions,
): RagdollBalance {
  if (!ragdoll?.bones || typeof motors?.setTarget !== 'function')
    throw new TypeError('addRagdollBalance needs a Ragdoll and its motors: addRagdollBalance(ragdoll, motors, {feet}).');
  return new RagdollBalance(ragdoll, motors, options);
}
