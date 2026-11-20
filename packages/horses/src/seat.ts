/// <reference lib="esnext.disposable" preserve="true" />
// The rider's seat: where a rider's hips, knees, feet (stirrups) and hands (reins) go on a horse, and a hip that follows
// the horse's back. Rider segment lengths are ratios of standing height from D. A. Winter, "Biomechanics and Motor
// Control of Human Movement", 4th ed., Wiley 2009, table 4.1 (thigh 0.245 H, shank 0.246 H, hip joint 0.530 H). The
// riding posture (thigh 30 to 50 degrees forward of vertical, knee angle 100 to 130 degrees by discipline) and the
// hip's motion against the saddle follow A. Bystroem, M. Rhodin, K. von Peinen, M. A. Weishaupt and L. Roepstorff,
// "Basic kinematics of the saddle and rider in high-level dressage horses trotting on a treadmill", Equine Veterinary
// Journal 41(3):280-284, 2009, and A. Muenz, F. Eckardt and K. Witte, "Horse-rider interaction in dressage riding",
// Human Movement Science 33:227-237, 2014: the rider's pelvis rides the saddle's vertical motion closely, a little
// behind it and slightly damped. Here the hip is a damped spring on the saddle point, stepped on the horse's fixed
// clock, so a seek gives the same hip as playing.
import type { Horse } from './index.js';

/** Options of {@link riderSeat}. */
export interface RiderSeatOptions {
  /** Rider standing height in metres, 1.4 to 2.1. Default 1.75. */
  height?: number;
  /** Thigh angle forward of vertical, radians. Default 0.7 (40 degrees, a general purpose seat). */
  thigh?: number;
  /** Knee angle between thigh and shank, radians. Default 1.92 (110 degrees). */
  knee?: number;
  /** Half the width of the horse and saddle under the knee, metres. Default 0.21 times the withers height. */
  halfWidth?: number;
  /** Withers height of the horse, metres (for the default halfWidth). Default 1.63. */
  withers?: number;
}

/** The seat in the saddle's frame (metres; +Y up, +Z forward, +X the horse's left), left then right. */
export interface RiderSeat {
  /** The rider's hip joint centre (mid point of the two hip joints). */
  readonly hip: readonly [number, number, number];
  readonly hips: readonly [readonly [number, number, number], readonly [number, number, number]];
  readonly knees: readonly [readonly [number, number, number], readonly [number, number, number]];
  readonly ankles: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** Where the stirrup treads hang, under the balls of the feet. */
  readonly stirrups: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** Where the hands hold the reins, over the withers. */
  readonly hands: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** Segment lengths used, metres. */
  readonly thighLength: number;
  readonly shankLength: number;
}

/**
 * Where a rider's joints go in the saddle for a rider height and seat. Pure: the same numbers every call.
 * @example
 * const seat = riderSeat({height: 1.78, knee: (115 * Math.PI) / 180});
 * @throws RangeError for a height, angle or width out of range.
 */
export function riderSeat(options: RiderSeatOptions = {}): RiderSeat {
  const h = options.height ?? 1.75,
    th = options.thigh ?? 0.7,
    kn = options.knee ?? 1.92,
    withers = options.withers ?? 1.63,
    w = options.halfWidth ?? 0.21 * withers;
  if (!(h >= 1.4 && h <= 2.1)) throw new RangeError('riderSeat height must be 1.4 to 2.1 metres');
  if (!(th >= 0.2 && th <= 1.2)) throw new RangeError('riderSeat thigh must be 0.2 to 1.2 radians forward of vertical');
  if (!(kn >= 1.4 && kn <= 2.6)) throw new RangeError('riderSeat knee must be 1.4 to 2.6 radians');
  if (!(w >= 0.1 && w <= 0.5)) throw new RangeError('riderSeat halfWidth must be 0.1 to 0.5 metres');
  if (!(withers >= 1.2 && withers <= 2.1)) throw new RangeError('riderSeat withers must be 1.2 to 2.1 metres');
  const thigh = 0.245 * h,
    shank = 0.246 * h,
    hipHalf = 0.0955 * h * 0.5,
    // The hip joints sit above the seat bones.
    hy = 0.055 * h,
    out = (side: 1 | -1) => {
      const hip = [side * hipHalf, hy, 0] as const,
        kx = side * (w + 0.06),
        dx = Math.abs(kx - hip[0]),
        sag = Math.sqrt(Math.max(0, thigh * thigh - dx * dx)),
        knee = [kx, hy - sag * Math.cos(th), sag * Math.sin(th)] as const,
        // Shank angle from vertical: the thigh's angle less the knee's bend from straight; negative points back.
        sa = th - (Math.PI - kn),
        ankle = [kx - side * 0.01, knee[1] - shank * Math.cos(sa), knee[2] + shank * Math.sin(sa)] as const,
        stirrup = [ankle[0], ankle[1] - 0.045 * h, ankle[2] + 0.075 * h] as const,
        hand = [side * 0.055 * h, 0.17 * h, 0.21 * h] as const;
      return { hip, knee, ankle, stirrup, hand };
    },
    l = out(1),
    r = out(-1);
  return {
    hip: [0, hy, 0],
    hips: [l.hip, r.hip],
    knees: [l.knee, r.knee],
    ankles: [l.ankle, r.ankle],
    stirrups: [l.stirrup, r.stirrup],
    hands: [l.hand, r.hand],
    thighLength: thigh,
    shankLength: shank,
  };
}

/** Options of {@link SeatFollower}. */
export interface SeatFollowerOptions {
  /** Natural frequency of the rider's give, Hz. Default 9. */
  frequency?: number;
  /** Damping ratio. Default 0.8. */
  damping?: number;
}

/**
 * The rider's hip riding the saddle point: a damped spring (critically near) per axis, stepped on fixed steps. Feed it
 * the saddle point every step; read `position`.
 */
export class SeatFollower {
  readonly position: [number, number, number] = [0, 0, 0];
  readonly velocity: [number, number, number] = [0, 0, 0];
  private started = false;
  private readonly w: number;
  private readonly z: number;
  constructor(options: SeatFollowerOptions = {}) {
    const f = options.frequency ?? 9,
      d = options.damping ?? 0.8;
    if (!(f >= 1 && f <= 60)) throw new RangeError('SeatFollower frequency must be 1 to 60 Hz');
    if (!(d >= 0.2 && d <= 3)) throw new RangeError('SeatFollower damping must be 0.2 to 3');
    this.w = 2 * Math.PI * f;
    this.z = d;
  }
  /** Forgets the state: the next step starts on the saddle. */
  reset(): void {
    this.started = false;
  }
  step(dt: number, target: readonly number[]): readonly [number, number, number] {
    if (!this.started) {
      for (let k = 0; k < 3; k++) {
        this.position[k] = target[k]!;
        this.velocity[k] = 0;
      }
      this.started = true;
      return this.position;
    }
    // Semi-implicit Euler on x'' = w^2 (t - x) - 2 z w x'.
    for (let k = 0; k < 3; k++) {
      const a = this.w * this.w * (target[k]! - this.position[k]!) - 2 * this.z * this.w * this.velocity[k]!;
      this.velocity[k]! += a * dt;
      this.position[k]! += this.velocity[k]! * dt;
    }
    return this.position;
  }
}

/** Anything with a scene root to place: a `@margoengine/humans` Person's `model`, any loaded model. */
export interface RiderModel {
  readonly root: { setPosition(p: readonly number[]): unknown; setQuaternion(q: readonly number[]): unknown };
}

/** Options of {@link mountRider}. */
export interface MountOptions extends RiderSeatOptions, SeatFollowerOptions {
  /** Height of the rider model's hip joint above its origin in the riding pose, metres. Default 0.53 x height (Winter 2009). */
  hipHeight?: number;
  /** How much of the horse's trunk pitch the rider's trunk takes, 0 to 1. Default 0.4 (riders stay near upright). */
  pitchShare?: number;
}

/** What {@link mountRider} returns. */
export interface Mount {
  readonly seat: RiderSeat;
  /** The rider's hip in world space now. */
  readonly hip: readonly [number, number, number];
  /** World positions of the seat's points now (stirrups, hands, knees), from the horse's frame. */
  world(point: readonly number[]): [number, number, number];
  dispose(): void;
  [Symbol.dispose](): void;
}

const rotate = (q: readonly number[], v: readonly number[]): [number, number, number] => {
  const [x, y, z, w] = q as [number, number, number, number],
    tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
};

/**
 * Seats a rider on a horse from {@link addHorse}: every fixed step the rider's hip rides the saddle through a
 * {@link SeatFollower}, and the rider model's root is placed so its hip joint sits there, facing the horse's way with
 * part of the trunk's pitch. The rider plays its own riding clip (a `@margoengine/humans` person: `person.play('ride')`);
 * {@link Mount.seat} gives the knee, stirrup and rein targets for its leg and arm IK.
 * @example
 * const mount = mountRider(horse, person.model, {height: 1.78});
 * @throws TypeError for a horse or rider of the wrong shape; RangeError for bad options.
 */
export function mountRider(horse: Horse, rider: RiderModel, options: MountOptions = {}): Mount {
  if (!horse || typeof horse.onStep !== 'function' || typeof horse.frame !== 'function')
    throw new TypeError('mountRider needs a horse from addHorse');
  if (!rider?.root || typeof rider.root.setPosition !== 'function' || typeof rider.root.setQuaternion !== 'function')
    throw new TypeError('mountRider needs a rider model with a root (a loaded model, or a person.model)');
  const height = options.height ?? 1.75,
    seat = riderSeat({ withers: horse.body.withers, ...options }),
    follower = new SeatFollower(options),
    hipHeight = options.hipHeight ?? 0.53 * height,
    share = options.pitchShare ?? 0.4;
  if (!(hipHeight > 0 && hipHeight < 1.5)) throw new RangeError('mountRider hipHeight must be 0 to 1.5 metres');
  if (!(share >= 0 && share <= 1)) throw new RangeError('mountRider pitchShare must be 0 to 1');
  const place = () => {
    const f = horse.frame(),
      yaw = [0, Math.sin(f.heading / 2), 0, Math.cos(f.heading / 2)],
      // The trunk's own pitch is the saddle rotation with the yaw taken off.
      inv = [0, -yaw[1]!, 0, yaw[3]!],
      p = [
        inv[3]! * f.saddleRotation[0]! + inv[0]! * f.saddleRotation[3]! + inv[1]! * f.saddleRotation[2]! - inv[2]! * f.saddleRotation[1]!,
        0,
        0,
        inv[3]! * f.saddleRotation[3]! - inv[0]! * f.saddleRotation[0]! - inv[1]! * f.saddleRotation[1]! - inv[2]! * f.saddleRotation[2]!,
      ],
      pitch = 2 * Math.atan2(p[0]!, p[3]!) * share,
      q = [
        yaw[3]! * Math.sin(pitch / 2) + 0,
        yaw[1]! * Math.cos(pitch / 2),
        -yaw[1]! * Math.sin(pitch / 2),
        yaw[3]! * Math.cos(pitch / 2),
      ],
      hip = follower.position,
      down = rotate(q, [0, -hipHeight, 0]);
    rider.root.setPosition([hip[0] + down[0], hip[1] + down[1], hip[2] + down[2]]);
    rider.root.setQuaternion(q);
  };
  const target = () => {
    const f = horse.frame(),
      off = rotate(f.saddleRotation, seat.hip);
    return [f.saddle[0] + off[0], f.saddle[1] + off[1], f.saddle[2] + off[2]];
  };
  const off = horse.onStep(
    (dt) => {
      follower.step(dt, target());
      place();
    },
    () => follower.reset(),
  );
  follower.step(0, target());
  place();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    off();
  };
  return {
    seat,
    get hip() {
      return [...follower.position] as [number, number, number];
    },
    world(point: readonly number[]) {
      const f = horse.frame(),
        o = rotate(f.saddleRotation, point);
      return [f.saddle[0] + o[0], f.saddle[1] + o[1], f.saddle[2] + o[2]];
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
