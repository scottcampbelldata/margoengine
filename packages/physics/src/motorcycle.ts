/// <reference lib="esnext.disposable" preserve="true" />
// A motorcycle: a two-wheeled `Vehicle` on tyre models and a rider who keeps it up. Two wheels in a line have nothing to hold the bike
// upright, so the rider balances it as a person does, by steering into the fall: when the bike leans toward a side the front wheel is
// steered toward it, which puts the tyres' sideways force under the bike's weight again (Sharp, "The Stability and Control of Motorcycles",
// Journal of Mechanical Engineering Science 13(5), 1971; Astrom, Klein and Lennartsson, "Bicycle dynamics and control", IEEE Control
// Systems Magazine 25(4), 2005). The turn asked for becomes a lean (the lean at which a bike's weight and its sideways acceleration
// balance, `atan(v r-dot / g)`), and to reach a lean the rider first steers the other way, which is counter-steering: it drops out of the
// control law, not out of a rule.
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsBody } from './body.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import { Vehicle, type VehicleOptions, type WheelOptions } from './vehicle.js';
import { pacejkaTyre } from './tyres.js';

/** Options of `new Motorcycle(physics, chassis, options)`. */
export interface MotorcycleOptions {
  /** The front wheel (steered); `position` is chassis-local with +Z forward. */
  front: WheelOptions;
  /** The rear wheel (driven). */
  rear: WheelOptions;
  /** Options for the vehicle under it (a `tyre` of the Magic Formula by default; `wheels`, `forward` and each wheel's `steer` and `drive` are set here). */
  vehicle?: Omit<VehicleOptions, 'wheels' | 'forward'>;
  /** The most the front wheel may be steered, radians (default 0.45). */
  maxSteeringAngle?: number;
  /** The most sideways acceleration a turn may ask for, m/s squared (default 7, about 0.7 g). */
  maxLateralAcceleration?: number;
  /** Stiffness of the balance: steering angle per radian of lean error (default 1.2, scaled down above 8 m/s). */
  balanceGain?: number;
  /** Damping of the balance: steering angle per radian a second of roll rate (default 0.35). */
  balanceDamping?: number;
  /** Keep the bike up (default true). With false the rider lets go: `steering` is the handlebars alone. */
  balance?: boolean;
}

/** Driver input for {@link Motorcycle.setInput}. */
export interface MotorcycleInput {
  /** -1 (reverse) to 1 (full throttle), as force on the rear wheel. */
  throttle?: number;
  /** 0 to 1. */
  brake?: number;
  /** -1 to 1: the turn asked for, positive toward +X for a bike facing +Z. */
  steer?: number;
}

const clamp = (v: number, low: number, high: number): number => Math.min(high, Math.max(low, v));

/**
 * A two-wheeled `Vehicle` with a rider that balances it and leans it into turns. `setInput({throttle, brake, steer})`; `lean` is the angle
 * of the bike's up axis from the vertical toward its +X side (positive when it leans toward +X), `leanTarget` the angle the turn asks for.
 */
export class Motorcycle implements PhysicsAttachment {
  /** The vehicle under the rider: its wheels, `speed` and `wheel(i)`. */
  readonly vehicle: Vehicle;
  /** Whether the rider keeps the bike up. */
  balance: boolean;
  private steerInput = 0;
  private lean_ = 0;
  private target_ = 0;
  private disposed = false;
  private readonly maxSteer: number;
  private readonly maxLateral: number;
  private readonly gain: number;
  private readonly damping: number;
  private readonly wheelbase: number;

  constructor(
    private readonly physics: Physics,
    readonly chassis: PhysicsBody,
    options: MotorcycleOptions,
  ) {
    if (!options?.front || !options?.rear)
      throw new RangeError('A motorcycle has a front and a rear wheel: {front: {...}, rear: {...}}.');
    this.balance = options.balance ?? true;
    this.maxSteer = options.maxSteeringAngle ?? 0.45;
    this.maxLateral = options.maxLateralAcceleration ?? 7;
    this.gain = options.balanceGain ?? 1.2;
    this.damping = options.balanceDamping ?? 0.35;
    for (const [value, name] of [
      [this.maxSteer, 'maxSteeringAngle'],
      [this.maxLateral, 'maxLateralAcceleration'],
      [this.gain, 'balanceGain'],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw new RangeError(`Motorcycle ${name} must be a finite number above 0.`);
    if (!(this.damping >= 0 && Number.isFinite(this.damping)))
      throw new RangeError('Motorcycle balanceDamping must be a finite number of 0 or more.');
    this.wheelbase = Math.abs(options.front.position[2] - options.rear.position[2]);
    if (!(this.wheelbase > 0))
      throw new RangeError(
        "A motorcycle's wheels are apart along the chassis: front.position[2] must differ from rear.position[2].",
      );
    // The rider acts before the vehicle, so it attaches first.
    physics.attach(this);
    try {
      this.vehicle = new Vehicle(physics, chassis, {
        tyre: pacejkaTyre(),
        maxSteeringAngle: this.maxSteer,
        ...options.vehicle,
        wheels: [
          { rollInfluence: 1, ...options.front, steer: true, drive: false },
          { rollInfluence: 1, ...options.rear, steer: false, drive: true },
        ],
      });
    } catch (error) {
      physics.detach(this);
      throw error;
    }
  }

  /** The angle of the bike's up axis from the vertical toward +X, radians (about the bike's forward axis). */
  get lean(): number {
    return this.lean_;
  }
  /** The lean the turn asked for would hold, radians. */
  get leanTarget(): number {
    return this.target_;
  }
  /** Forward speed, m/s. */
  get speed(): number {
    return this.vehicle.speed;
  }
  /** The angle of the front wheel, radians. */
  get steering(): number {
    return this.vehicle.steering;
  }
  /** False after `dispose()` or once the chassis is removed. */
  get valid(): boolean {
    return !this.disposed;
  }

  /** Throttle and brake go to the rear wheel; the steer is the turn the rider asks for, not the angle of the wheel. */
  setInput(input: MotorcycleInput): this {
    this.vehicle.setInput({ throttle: input.throttle, brake: input.brake });
    this.steerInput = clamp(input.steer ?? 0, -1, 1);
    if (!Number.isFinite(this.steerInput))
      throw new RangeError('Motorcycle steer must be a finite number from -1 to 1.');
    return this;
  }

  /** @internal The rider: reads the lean and the roll rate and steers into the fall. */
  beforeStep(): void {
    if (this.disposed || !this.chassis.valid) return;
    const q = this.chassis.rotation,
      v = this.chassis.linearVelocity,
      w = this.chassis.angularVelocity,
      rotate = (a: readonly number[]): [number, number, number] => {
        const [x, y, z, s] = q as [number, number, number, number],
          tx = 2 * (y * a[2]! - z * a[1]!),
          ty = 2 * (z * a[0]! - x * a[2]!),
          tz = 2 * (x * a[1]! - y * a[0]!);
        return [
          a[0]! + s * tx + (y * tz - z * ty),
          a[1]! + s * ty + (z * tx - x * tz),
          a[2]! + s * tz + (x * ty - y * tx),
        ];
      },
      forward = rotate([0, 0, 1]),
      up = rotate([0, 1, 0]),
      flat = Math.hypot(forward[0], forward[2]) || 1,
      // The bike's forward on the ground, and its +X side there: the world's up crossed with it.
      fh: [number, number, number] = [forward[0] / flat, 0, forward[2] / flat],
      side: [number, number, number] = [fh[2], 0, -fh[0]],
      speed = v[0] * fh[0] + v[2] * fh[2];
    // Positive lean toward the side vector; the side of a bike facing +Z is +X, as the steer input has it.
    this.lean_ = Math.atan2(up[0] * side[0] + up[2] * side[2], up[1]);
    // A turn about the forward axis tilts the up axis toward -X for a positive angle there, so the lean's rate is its negative.
    const rollRate = -(w[0] * fh[0] + w[2] * fh[2]);
    // The turn asked for: a yaw rate over the speed, as a sideways acceleration the lean balances.
    const lateral = this.steerInput * this.maxLateral;
    this.target_ = Math.atan2(lateral, 9.81);
    if (!this.balance) return;
    // Steering into the fall: more lean toward the side than asked steers toward it; less steers away (the counter-steer that starts a turn).
    const scale = 8 / Math.max(Math.abs(speed), 8),
      steer = this.gain * scale * (this.lean_ - this.target_) + this.damping * scale * rollRate,
      // Feed-forward: the steering angle that gives the turn's yaw rate at this speed, wheelbase times the yaw rate over the speed.
      ahead = Math.abs(speed) > 1 ? Math.atan((this.wheelbase * lateral) / (speed * speed)) : 0;
    this.vehicle.steering = clamp(steer + ahead, -this.maxSteer, this.maxSteer);
  }

  /** @internal Disposes the bike when its chassis goes. */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.chassis) this.dispose();
  }

  /** Detaches the rider and the vehicle from the world. The chassis stays. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vehicle?.dispose();
    this.physics.detach(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
void MargoError;
