/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { Mesh } from '@margoengine/core';
import type { PhysicsCollider } from './collider.js';
import type { PhysicsBody } from './body.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import { checkVec, type Vec3 } from './math.js';
import type { Drivetrain } from './drivetrain.js';
import type { TyreModel } from './tyres.js';

/** One wheel of a {@link Vehicle}. Positions and directions are in the chassis body's local frame. */
export interface WheelOptions {
  /** Where the suspension is mounted on the chassis (the top of its travel), chassis-local. */
  position: Vec3;
  /** Wheel radius in metres. */
  radius: number;
  /** Direction the suspension extends, chassis-local (default [0, -1, 0], straight down). */
  direction?: Vec3;
  /** Axle the wheel spins around, chassis-local (default [-1, 0, 0], for a chassis whose forward is +Z). */
  axle?: Vec3;
  /** Suspension length at rest in metres (default 0.3). */
  suspensionRestLength?: number;
  /** Spring stiffness of the suspension (default 5.88; about 20 to 50 for a sports car). */
  suspensionStiffness?: number;
  /** Damping while the suspension compresses (default 0.83). */
  suspensionCompression?: number;
  /** Damping while the suspension extends (default 0.88). */
  suspensionRelaxation?: number;
  /** Longest suspension travel in metres (default 5). */
  maxSuspensionTravel?: number;
  /** Strongest suspension force in newtons (default 6000). */
  maxSuspensionForce?: number;
  /**
   * How the suspension finds the ground: `'ray'` (default) casts one ray from the mount, as Rapier's vehicle does; `'shape'` sweeps a
   * cylinder of the wheel's radius and `width` along the suspension, so the wheel meets a kerb, a pothole's edge or the lip of a
   * slot as the wheel does, where a ray passes between them. Defaults to the vehicle's `wheelCast`.
   */
  cast?: 'ray' | 'shape';
  /** Width of the wheel in metres, the cylinder a `'shape'` cast sweeps (default 0.2). */
  width?: number;
  /**
   * Moment of inertia of the wheel about its axle, kg m squared (default half a 20 kg wheel's `m r^2`). With a `tyre`, the wheel has a
   * spin of its own that drive torque, brake torque and the tyre's longitudinal force change, and it is what the slip ratio is made of.
   */
  inertia?: number;
  /** A tyre model of this wheel's own, in place of the vehicle's. */
  tyre?: TyreModel;
  /** Tyre grip along the wheel's rolling direction (default 10.5); lower slides more. */
  frictionSlip?: number;
  /** Tyre grip sideways (default 1). */
  sideFrictionStiffness?: number;
  /**
   * How much of its height above the ground the sideways grip of this wheel turns the chassis by, from 0 (none: it
   * cannot tip the car over) to 1 (the grip pushes at the tyre and tips it as in life); default 0.1. A tyre that grips
   * as hard as a `frictionSlip` of 2 or more tips a light car over in a bend unless this is low.
   */
  rollInfluence?: number;
  /** This wheel turns with `vehicle.steering` (default false). */
  steer?: boolean;
  /** This wheel receives `vehicle.engineForce` (default true). */
  drive?: boolean;
  /** This wheel receives `vehicle.brake` (default true). */
  brake?: boolean;
  /**
   * Mesh drawn as this wheel, a child of the chassis mesh. Its local position and rotation are written after every
   * sync to follow suspension, steering and spin; model it centred on its hub with its axle along `axle`.
   */
  mesh?: Mesh;
}

/** Options of `new Vehicle(physics, chassis, options)`. Every field but `wheels` has a default. */
export interface VehicleOptions {
  /** The wheels, at least one. */
  wheels: readonly WheelOptions[];
  /** Engine force per driven wheel at full throttle, newtons (default the chassis mass in kg, so four driven wheels give 0.4 g). */
  maxEngineForce?: number;
  /** Brake force per braking wheel at full brake, newtons (default 3 x the chassis mass, so four braking wheels slow 1.2 g). */
  maxBrakeForce?: number;
  /** Steering angle at full lock, radians (default 0.5, about 29 degrees). */
  maxSteeringAngle?: number;
  /**
   * A tyre model for every wheel (`pacejkaTyre()`, `brushTyre()`, or any `{forces(sample)}`): the wheels then keep a spin of their own, the
   * slip ratio and slip angle come from it and the ground speed, and the tyre's forces replace the friction circle of `frictionSlip` and
   * `sideFrictionStiffness`. `engineForce` is then the drive force at the contact patch, so the torque on the axle is that times the
   * radius, and `brake` likewise. Default none: the friction circle.
   */
  tyre?: TyreModel;
  /**
   * An engine, clutch, gearbox and differentials ({@link Drivetrain}) that give each driven wheel its torque from the throttle in place of
   * `engineForce`. Its wheels need a tyre model. Default none.
   */
  drivetrain?: Drivetrain;
  /**
   * Anti-roll bars: each joins two wheels and pushes the more compressed one's side up and the other's down by `stiffness` newtons for each
   * metre of difference in their suspension compression, which resists the chassis leaning in a bend. Default none.
   */
  antiRollBars?: readonly { wheels: readonly [number, number]; stiffness: number }[];
  /** How wheels find the ground unless a wheel says: `'ray'` (default) or `'shape'` (a swept cylinder), see {@link WheelOptions.cast}. */
  wheelCast?: 'ray' | 'shape';
  /** Packed interaction groups of the wheel rays, see `collisionGroups` (default all). */
  groups?: number;
  /** Return false to make the wheels ignore a collider (the chassis's own colliders are always ignored). */
  predicate?: (collider: PhysicsCollider) => boolean;
  /**
   * The direction the chassis faces, in its own frame (default [0, 0, 1], +Z), Rapier's `index_forward_axis`: `speed` is the
   * velocity along it. A chassis that faces another way also gives its wheels an `axle` (the axle is the cross product of up
   * and forward, so for a chassis facing +X it is [0, 0, 1]); steering turns about the up axis, positive towards `up x forward`.
   */
  forward?: Vec3;
}

/** Driver input for {@link Vehicle.setInput}, each axis normalized. */
export interface VehicleInput {
  /** -1 (full reverse) to 1 (full throttle). */
  throttle?: number;
  /** -1 (full lock right) to 1 (full lock left); positive turns toward +X for a chassis facing +Z. */
  steer?: number;
  /** 0 (off) to 1 (full brake). */
  brake?: number;
  /** With a `drivetrain`: the clutch pedal, 0 (up, engaged) to 1 (down, out). */
  clutch?: number;
}

/** The state of one wheel after the last step. */
export interface WheelState {
  /** The wheel touches the ground. */
  inContact: boolean;
  /** Current suspension length in metres. */
  suspensionLength: number;
  /** Suspension force in newtons. */
  suspensionForce: number;
  /** Spin angle around the axle, radians. */
  rotation: number;
  /** Steering angle, radians. */
  steering: number;
  /** World contact point, or null in the air. */
  contactPoint: [number, number, number] | null;
  /** World contact normal, or null in the air. */
  contactNormal: [number, number, number] | null;
  /** The collider the wheel stands on, or null in the air. */
  ground: PhysicsCollider | null;
  /** Where the suspension is mounted, in world space (the top of its travel). */
  hardPoint: [number, number, number];
  /** What the tyre pushed the chassis with along its rolling direction in the last step (drive and brake), in newton seconds. */
  forwardImpulse: number;
  /** What the tyre pushed the chassis with sideways in the last step (grip), in newton seconds. */
  sideImpulse: number;
  /** The wheel's spin about its axle in radians a second (with a `tyre`; otherwise 0). */
  spin: number;
  /** The slip ratio and slip angle the tyre model was given in the last step (0 without a `tyre`). */
  slipRatio: number;
  slipAngle: number;
  /** The load the tyre carried, newtons. */
  load: number;
}

interface WheelSetup {
  connection: [number, number, number];
  direction: [number, number, number];
  axle: [number, number, number];
  steer: boolean;
  drive: boolean;
  brake: boolean;
  mesh: Mesh | null;
  radius: number;
  rest: number;
  stiffness: number;
  compression: number;
  relaxation: number;
  travel: number;
  maxForce: number;
  slip: number;
  side: number;
  roll: number;
  // State after the last step.
  contact: boolean;
  length: number;
  force: number;
  rotation: number;
  steering: number;
  point: [number, number, number];
  normal: [number, number, number];
  ground: PhysicsCollider | null;
  hard: [number, number, number];
  forwardImpulse: number;
  sideImpulse: number;
  cast: 'ray' | 'shape';
  width: number;
  inertia: number;
  tyre: TyreModel | null;
  omega: number;
  kappa: number;
  alpha: number;
  torque: number;
}

type V = [number, number, number];
type Q = [number, number, number, number];
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const rotate = (q: readonly number[], v: readonly number[]): V => {
  const [x, y, z, w] = q as Q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const conjugate = (q: readonly number[]): Q => [-q[0], -q[1], -q[2], q[3]!];
const multiply = (a: readonly number[], b: readonly number[]): Q => {
  const [ax, ay, az, aw] = a as Q,
    [bx, by, bz, bw] = b as Q;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
};

const unit = (value: Vec3, label: string): V => {
  checkVec(value, label);
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!length) throw new RangeError(`${label} must be nonzero; pass a direction such as [0, -1, 0].`);
  return [value[0] / length, value[1] / length, value[2] / length];
};
const positive = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new RangeError(`${label} must be a positive finite number`);
  return value;
};
const fraction = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1))
    throw new RangeError(`${label} must be a number from 0 to 1; use 0.1 for a car that does not tip over.`);
  return value;
};
const clamp = (value: number | undefined, min: number, max: number, label: string): number => {
  const v = value ?? 0;
  if (!Number.isFinite(v)) throw new RangeError(`${label} must be a finite number from ${min} to ${max}`);
  return Math.min(max, Math.max(min, v));
};

/**
 * A ray-cast vehicle on a dynamic chassis body. Each wheel casts its suspension ray every fixed step and pushes the
 * chassis with a spring and damper along the contact normal, drive and brake force along its rolling direction and a
 * grip impulse against sideways slip, all limited by the tyre's friction against the suspension load. Set
 * `engineForce`, `steering` and `brake` (or `setInput`) from `physics.on('beforestep')` or once per frame.
 * `new Vehicle(physics, chassis, {wheels})`; it steps with the world and is disposed with it. Import it only where you
 * need it: the `Physics` world never loads it.
 */
export class Vehicle implements PhysicsAttachment {
  /** Engine force applied to every driven wheel, newtons (negative reverses). */
  engineForce = 0;
  /** Steering angle of every steered wheel, radians around the chassis up axis. */
  steering = 0;
  /** Brake force applied to every braking wheel, newtons. */
  brake = 0;
  /** Engine force at full throttle in `setInput`. */
  maxEngineForce: number;
  /** Brake force at full brake in `setInput`. */
  maxBrakeForce: number;
  /** Steering angle at full lock in `setInput`, radians. */
  maxSteeringAngle: number;
  /** The drivetrain, when the vehicle was made with one. */
  readonly drivetrain: Drivetrain | null;
  private readonly bars: { a: number; b: number; stiffness: number }[];
  private readonly wheels: WheelSetup[] = [];
  private readonly groups?: number;
  private readonly facing: [number, number, number];
  private readonly predicate?: (collider: PhysicsCollider) => boolean;
  private disposed = false;
  private readonly position = [0, 0, 0];
  private readonly quaternion = [0, 0, 0, 1];

  /**
   * @param physics The world the chassis belongs to.
   * @param chassis A dynamic body with at least one collider.
   * @param options Wheels and control limits.
   */
  constructor(
    private readonly physics: Physics,
    readonly chassis: PhysicsBody,
    options: VehicleOptions,
  ) {
    if (!physics?.owns?.(chassis))
      throw new MargoError('state', 'Chassis must belong to this physics world; add it with physics.addBody first.');
    if (chassis.type !== 'dynamic')
      throw new TypeError(
        "A vehicle chassis must be a dynamic body; add it with physics.addBody(mesh, {type: 'dynamic'}).",
      );
    if (!chassis.colliders.length)
      throw new TypeError('A vehicle chassis needs a collider to have mass; give the chassis body a box collider.');
    this.facing = options?.forward ? unit(options.forward, 'Vehicle forward') : [0, 0, 1];
    const wheels = options?.wheels;
    if (!Array.isArray(wheels) || !wheels.length)
      throw new RangeError('A vehicle needs at least one wheel: {wheels: [{position: [0.8, 0, 1.2], radius: 0.35}]}');
    for (const wheel of wheels) {
      checkVec(wheel?.position, 'Wheel position');
      positive(wheel.radius, 'Wheel radius');
      const rest =
        wheel.suspensionRestLength === undefined
          ? 0.3
          : positive(wheel.suspensionRestLength, 'Wheel suspensionRestLength');
      this.wheels.push({
        connection: [wheel.position[0], wheel.position[1], wheel.position[2]],
        direction: unit(wheel.direction ?? [0, -1, 0], 'Wheel direction'),
        axle: unit(wheel.axle ?? [-1, 0, 0], 'Wheel axle'),
        steer: wheel.steer ?? false,
        drive: wheel.drive ?? true,
        brake: wheel.brake ?? true,
        mesh: wheel.mesh ?? null,
        radius: wheel.radius,
        rest,
        stiffness: wheel.suspensionStiffness ?? 5.88,
        compression: wheel.suspensionCompression ?? 0.83,
        relaxation: wheel.suspensionRelaxation ?? 0.88,
        travel: wheel.maxSuspensionTravel ?? 5,
        maxForce: wheel.maxSuspensionForce ?? 6000,
        slip: wheel.frictionSlip ?? 10.5,
        side: wheel.sideFrictionStiffness ?? 1,
        roll: wheel.rollInfluence === undefined ? 0.1 : fraction(wheel.rollInfluence, 'Wheel rollInfluence'),
        contact: false,
        length: rest,
        force: 0,
        rotation: 0,
        steering: 0,
        point: [0, 0, 0],
        normal: [0, 1, 0],
        ground: null,
        hard: [0, 0, 0],
        forwardImpulse: 0,
        sideImpulse: 0,
        cast: wheel.cast ?? options.wheelCast ?? 'ray',
        width: wheel.width === undefined ? 0.2 : positive(wheel.width, 'Wheel width'),
        inertia:
          wheel.inertia === undefined
            ? 0.5 * 20 * wheel.radius * wheel.radius
            : positive(wheel.inertia, 'Wheel inertia'),
        tyre: wheel.tyre ?? options.tyre ?? null,
        omega: 0,
        kappa: 0,
        alpha: 0,
        torque: 0,
      });
      const made = this.wheels[this.wheels.length - 1]!;
      if (made.cast !== 'ray' && made.cast !== 'shape')
        throw new RangeError(`Wheel cast must be 'ray' or 'shape'; got ${String(made.cast)}.`);
      if (made.tyre && typeof made.tyre.forces !== 'function')
        throw new TypeError('A tyre model is an object with a forces(sample) method; pass pacejkaTyre() or brushTyre().');
    }
    const mass = chassis.mass;
    this.maxEngineForce = options.maxEngineForce ?? mass;
    this.maxBrakeForce = options.maxBrakeForce ?? 3 * mass;
    this.maxSteeringAngle = options.maxSteeringAngle ?? 0.5;
    for (const [value, label] of [
      [this.maxEngineForce, 'maxEngineForce'],
      [this.maxBrakeForce, 'maxBrakeForce'],
      [this.maxSteeringAngle, 'maxSteeringAngle'],
    ] as const)
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError(`Vehicle ${label} must be a finite number of at least 0`);
    this.groups = options.groups;
    this.predicate = options.predicate;
    this.drivetrain = options.drivetrain ?? null;
    if (this.drivetrain) {
      for (const index of this.drivenIndexes()) {
        if (!Number.isInteger(index) || index >= this.wheels.length)
          throw new RangeError(`The drivetrain names wheel ${index}, but the vehicle has ${this.wheels.length}; use wheel indexes from 0 to ${this.wheels.length - 1}.`);
        if (!this.wheels[index]!.tyre)
          throw new MargoError(
            'state',
            `Wheel ${index} is driven by a drivetrain and needs a tyre model: pass tyre: pacejkaTyre() to the vehicle.`,
          );
      }
    }
    this.bars = (options.antiRollBars ?? []).map((bar, i) => {
      const [a, b] = bar?.wheels ?? [];
      if (
        !Number.isInteger(a) ||
        !Number.isInteger(b) ||
        a! < 0 ||
        b! < 0 ||
        a! >= this.wheels.length ||
        b! >= this.wheels.length ||
        a === b
      )
        throw new RangeError(
          `Anti-roll bar ${i} joins two different wheels of the vehicle; pass {wheels: [0, 1], stiffness: 20000}.`,
        );
      if (!(bar.stiffness >= 0 && Number.isFinite(bar.stiffness)))
        throw new RangeError(`Anti-roll bar ${i} stiffness must be a finite number of 0 or more.`);
      return { a: a!, b: b!, stiffness: bar.stiffness };
    });
    physics.attach(this);
  }

  /** Number of wheels. */
  get wheelCount(): number {
    return this.wheels.length;
  }
  /** False after `dispose()` or once the chassis body is removed. */
  get valid(): boolean {
    return !this.disposed;
  }

  /** Sets `engineForce`, `steering` and `brake` from normalized driver input (keyboard, gamepad or touch). */
  setInput(input: VehicleInput): this {
    const throttle = clamp(input.throttle, -1, 1, 'Vehicle throttle');
    if (this.drivetrain) {
      // Throttle past zero drives forward; pressing back at a standstill selects reverse, and forward again the first gear.
      const gear = this.drivetrain.gear;
      if (throttle < 0 && gear >= 0 && Math.abs(this.speed) < 1) this.drivetrain.gear = -1;
      else if (throttle > 0 && gear < 0 && Math.abs(this.speed) < 1) this.drivetrain.gear = 1;
      this.drivetrain.pedals(Math.abs(throttle), clamp(input.clutch, 0, 1, 'Vehicle clutch'));
    }
    this.engineForce = throttle * this.maxEngineForce;
    this.steering = clamp(input.steer, -1, 1, 'Vehicle steer') * this.maxSteeringAngle;
    this.brake = clamp(input.brake, 0, 1, 'Vehicle brake') * this.maxBrakeForce;
    return this;
  }

  /** Forward speed in metres per second along the chassis's forward axis (+Z unless `forward` says otherwise; negative when reversing). */
  get speed(): number {
    const v = this.chassis.linearVelocity,
      f = rotate(this.chassis.rotation, this.facing);
    return v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
  }

  /** State of wheel `index` after the last step. */
  wheel(index: number): WheelState {
    this.checkWheel(index);
    const w = this.wheels[index]!;
    return {
      inContact: w.contact,
      suspensionLength: w.length,
      suspensionForce: w.force,
      rotation: w.rotation,
      steering: w.steering,
      contactPoint: w.contact ? [...w.point] : null,
      contactNormal: w.contact ? [...w.normal] : null,
      ground: w.contact ? w.ground : null,
      hardPoint: [...w.hard],
      forwardImpulse: w.forwardImpulse,
      sideImpulse: w.sideImpulse,
      spin: w.tyre ? w.omega : 0,
      slipRatio: w.kappa,
      slipAngle: w.alpha,
      load: w.force,
    };
  }

  /**
   * Wheel `index`'s hub pose in the chassis frame: position on the suspension, then steering around the chassis up
   * axis and spin around the axle. Writes into `position` and `quaternion` when given.
   */
  wheelLocalPose(
    index: number,
    position: number[] = [0, 0, 0],
    quaternion: number[] = [0, 0, 0, 1],
  ): { position: number[]; quaternion: number[] } {
    this.checkWheel(index);
    const setup = this.wheels[index]!,
      length = setup.length;
    for (let a = 0; a < 3; a++) position[a] = setup.connection[a]! + setup.direction[a]! * length;
    // Steering turns around the chassis up axis (opposite the suspension direction), spin around the axle.
    const s = setup.steering / 2,
      r = -setup.rotation / 2,
      ss = Math.sin(s),
      sc = Math.cos(s),
      rs = Math.sin(r),
      rc = Math.cos(r),
      d = setup.direction,
      a = setup.axle;
    const turn: Q = [-d[0] * ss, -d[1] * ss, -d[2] * ss, sc],
      spin: Q = [a[0] * rs, a[1] * rs, a[2] * rs, rc],
      q = multiply(turn, spin);
    quaternion[0] = q[0];
    quaternion[1] = q[1];
    quaternion[2] = q[2];
    quaternion[3] = q[3];
    return { position, quaternion };
  }

  /** @internal casts the wheels and applies suspension, drive, brake and grip; called by the world before each step. */
  beforeStep(dt: number): void {
    if (this.disposed || !this.chassis.valid) return;
    const chassis = this.chassis;
    if (chassis.sleeping) {
      if (this.engineForce === 0 && this.brake === 0) return;
      chassis.wakeUp();
    }
    const position = chassis.position,
      rotation = chassis.rotation,
      velocity = chassis.linearVelocity,
      angular = chassis.angularVelocity,
      mass = chassis.mass,
      centre = chassis.centerOfMass,
      centreWorld = rotate(rotation, centre).map((c, i) => c + position[i]!) as V,
      inertia = chassis.principalInertia,
      frame = multiply(rotation, chassis.inertiaFrame),
      back = conjugate(frame);
    // The inverse inertia applied to a world vector: into the principal frame, divided, and back.
    const invInertia = (v: V): V => {
      const p = rotate(back, v);
      return rotate(frame, [
        inertia[0] > 0 ? p[0] / inertia[0] : 0,
        inertia[1] > 0 ? p[1] / inertia[1] : 0,
        inertia[2] > 0 ? p[2] / inertia[2] : 0,
      ]);
    };
    const pointVelocity = (r: V): V => {
      const w = cross(angular, r);
      return [velocity[0] + w[0], velocity[1] + w[1], velocity[2] + w[2]];
    };
    // 1 / (effective mass) of the chassis along a unit direction through a world point.
    const inverseMass = (r: V, d: V): number => {
      const rd = cross(r, d);
      return 1 / mass + dot(cross(invInertia(rd), r), d);
    };
    const own = this.physics;
    const predicate =
      this.predicate && ((_body: PhysicsBody, collider: PhysicsCollider): boolean => this.predicate!(collider));
    // An engine and a gearbox first: the torque of every driven wheel for this step.
    if (this.drivetrain) {
      const indexes = this.drivenIndexes(),
        torques = this.drivetrain.step(
          dt,
          indexes.map((i) => ({ spin: this.wheels[i]!.omega, inertia: this.wheels[i]!.inertia })),
        );
      for (const wheel of this.wheels) wheel.torque = 0;
      indexes.forEach((i, k) => (this.wheels[i]!.torque = torques[k]!));
    }
    // The springs first, every one seeing the same chassis.
    for (const wheel of this.wheels) {
      const origin = rotate(rotation, wheel.connection).map((c, i) => c + position[i]!) as V,
        down = rotate(rotation, wheel.direction);
      wheel.steering = wheel.steer ? this.steering : 0;
      let hit: { point: V; normal: V; distance: number; collider: PhysicsCollider } | null;
      if (wheel.cast === 'shape') {
        // A cylinder of the wheel's size, its axis along the steered axle, swept from the mount down the suspension to full droop.
        const steered = wheel.steer
            ? rotate(
                [
                  -wheel.direction[0] * Math.sin(wheel.steering / 2),
                  -wheel.direction[1] * Math.sin(wheel.steering / 2),
                  -wheel.direction[2] * Math.sin(wheel.steering / 2),
                  Math.cos(wheel.steering / 2),
                ],
                wheel.axle,
              )
            : wheel.axle,
          a = rotate(rotation, steered),
          // The shortest turn that takes a cylinder's own axis (y) to the axle.
          turn: Q = a[1] < -1 + 1e-6 ? [1, 0, 0, 0] : [a[2], 0, -a[0], 1 + a[1]],
          size = Math.hypot(turn[0], turn[1], turn[2], turn[3]),
          cast = own.shapeCast(
            { shape: 'cylinder', halfHeight: wheel.width / 2, radius: wheel.radius },
            origin,
            [turn[0] / size, turn[1] / size, turn[2] / size, turn[3] / size],
            down,
            {
              maxDistance: wheel.rest,
              exclude: chassis,
              excludeSensors: true,
              groups: this.groups,
              predicate,
              stopAtPenetration: false,
            },
          );
        // The cast gives how far the wheel's centre travelled; the suspension reaches `rest` at the most.
        hit = cast && {
          point: cast.point,
          normal: cast.normal,
          distance: cast.distance + wheel.radius,
          collider: cast.collider,
        };
      } else
        hit = own.raycast(origin, down, {
          maxDistance: wheel.rest + wheel.radius,
          exclude: chassis,
          excludeSensors: true,
          groups: this.groups,
          predicate,
        });
      wheel.hard = origin;
      wheel.forwardImpulse = wheel.sideImpulse = 0;
      if (!hit) {
        wheel.ground = null;
        wheel.contact = false;
        wheel.length = wheel.rest;
        wheel.force = 0;
        continue;
      }
      wheel.contact = true;
      wheel.ground = hit.collider;
      wheel.point = hit.point;
      wheel.normal = hit.normal;
      const minimum = Math.max(0, wheel.rest - wheel.travel),
        length = Math.min(wheel.rest, Math.max(minimum, hit.distance - wheel.radius));
      wheel.length = length;
      const normal = hit.normal,
        r: V = [hit.point[0] - centreWorld[0], hit.point[1] - centreWorld[1], hit.point[2] - centreWorld[2]],
        cosine = -dot(normal, down),
        pv = pointVelocity(r);
      let inverse = 10,
        relative = 0;
      if (cosine > 0.1) {
        inverse = 1 / cosine;
        relative = dot(normal, pv) * inverse;
      }
      let force = wheel.stiffness * (wheel.rest - length) * inverse;
      force -= (relative < 0 ? wheel.compression : wheel.relaxation) * relative;
      force = Math.min(wheel.maxForce, Math.max(0, force * mass));
      wheel.force = force;
      chassis.applyImpulse([normal[0] * force * dt, normal[1] * force * dt, normal[2] * force * dt], hit.point, false);
    }
    // Anti-roll bars: a force on each end of a bar that follows the difference of its two wheels' compression, up where the wheel is more
    // compressed and down where it is less, so the chassis is resisted in leaning over.
    for (const bar of this.bars) {
      const a = this.wheels[bar.a]!,
        b = this.wheels[bar.b]!,
        force = bar.stiffness * (a.rest - a.length - (b.rest - b.length)) * dt;
      if (force === 0) continue;
      for (const [wheel, sign] of [
        [a, 1],
        [b, -1],
      ] as const) {
        const up = wheel.contact
            ? wheel.normal
            : (rotate(rotation, [-wheel.direction[0], -wheel.direction[1], -wheel.direction[2]]) as V),
          at = wheel.contact ? wheel.point : wheel.hard;
        chassis.applyImpulse([up[0] * force * sign, up[1] * force * sign, up[2] * force * sign], at, false);
      }
    }
    // Then drive, brake and grip. Every wheel sees the same chassis, so a wheel that cancelled all of a slide or a roll by
    // itself would have it cancelled once for each wheel on the ground: the chassis would rock from side to side at every
    // step, its grip clipped, and a car at rest would not drive at full force. The wheels share it instead.
    const grounded = this.wheels.filter((wheel) => wheel.contact).length;
    for (const wheel of this.wheels) {
      if (!wheel.contact) {
        if (wheel.tyre) {
          this.driveBrake(wheel, dt);
          wheel.rotation += wheel.omega * dt;
          wheel.kappa = wheel.alpha = 0;
        }
        continue;
      }
      const normal = wheel.normal,
        r: V = [wheel.point[0] - centreWorld[0], wheel.point[1] - centreWorld[1], wheel.point[2] - centreWorld[2]],
        pv = pointVelocity(r),
        grip = wheel.slip * wheel.force * dt;
      // The wheel's rolling direction: the surface normal crossed with the steered axle, on the ground plane.
      const axle = wheel.steer
          ? rotate(
              [
                -wheel.direction[0] * Math.sin(wheel.steering / 2),
                -wheel.direction[1] * Math.sin(wheel.steering / 2),
                -wheel.direction[2] * Math.sin(wheel.steering / 2),
                Math.cos(wheel.steering / 2),
              ],
              wheel.axle,
            )
          : wheel.axle,
        axleWorld = rotate(rotation, axle);
      let forward = cross(normal, axleWorld);
      const flat = Math.hypot(forward[0], forward[1], forward[2]);
      if (flat < 1e-6) continue;
      forward = [forward[0] / flat, forward[1] / flat, forward[2] / flat];
      const side = cross(forward, normal);
      let drive = wheel.drive ? this.engineForce * dt : 0;
      const rolling = dot(forward, pv);
      if (wheel.brake && this.brake > 0) {
        const stop = -rolling / inverseMass(r, forward) / grounded,
          limit = this.brake * dt;
        drive += Math.max(-limit, Math.min(limit, stop));
      }
      // The grip's push on the chassis is felt at a point drawn up toward the centre of mass by the roll influence, so a
      // grippy tyre turns the car about its length less than it would at the ground.
      const up = rotate(rotation, [-wheel.direction[0], -wheel.direction[1], -wheel.direction[2]]),
        height = dot(r, up) * (1 - wheel.roll),
        lifted: V = [r[0] - up[0] * height, r[1] - up[1] * height, r[2] - up[2] * height],
        slide = ((-dot(side, pv) / inverseMass(lifted, side)) * wheel.side) / grounded;
      if (wheel.tyre) {
        // A tyre model: the wheel keeps its own spin, and the model turns the slips and the load into forces. The forces are those the
        // step ends with, found implicitly: a force changes the wheel's surface speed and the chassis's speed at the contact, which
        // changes the slip the force came from, so the step takes the force that agrees with the slip it leaves (bisection on a
        // force that rises as the slip falls, taken over a few sweeps for the two that act together). A stiff tyre at low speed then
        // brings the slip to rest, where a force found at the slip the step began with would ring.
        this.driveBrake(wheel, dt);
        const radius = wheel.radius,
          forwardSpeed = dot(forward, pv),
          sideSpeed = dot(side, pv),
          surface = wheel.omega * radius - forwardSpeed,
          reference = Math.max(Math.abs(forwardSpeed), 1),
          floorSpeed = Math.max(Math.abs(forwardSpeed), 0.5),
          gainForward = dt * ((radius * radius) / wheel.inertia + inverseMass(r, forward) * grounded),
          gainSide = dt * inverseMass(lifted, side) * grounded,
          rolling = Math.sign(surface) || 1,
          sliding = Math.sign(sideSpeed) || 1,
          tyre = wheel.tyre;
        let fx = 0,
          fy = 0;
        const slips = (f: number, g: number): [number, number] => [
          (rolling * (Math.abs(surface) - f * gainForward)) / reference,
          sliding * Math.atan2(Math.abs(sideSpeed) - g * gainSide, floorSpeed),
        ];
        for (let sweep = 0; sweep < 3; sweep++) {
          for (const which of [0, 1] as const) {
            let low = 0,
              high = which === 0 ? Math.abs(surface) / gainForward : Math.abs(sideSpeed) / gainSide;
            if (!(high > 0)) continue;
            for (let i = 0; i < 14; i++) {
              const mid = (low + high) / 2,
                [kappa, alpha] = which === 0 ? slips(mid, fy) : slips(fx, mid),
                model = tyre.forces({ slipRatio: kappa, slipAngle: alpha, load: wheel.force }),
                wanted = which === 0 ? rolling * model.longitudinal : sliding * model.lateral;
              if (mid < wanted) low = mid;
              else high = mid;
            }
            if (which === 0) fx = (low + high) / 2;
            else fy = (low + high) / 2;
          }
        }
        [wheel.kappa, wheel.alpha] = slips(fx, fy);
        const longitudinal = rolling * fx,
          lateral = sliding * fy;
        wheel.omega -= (longitudinal * radius * dt) / wheel.inertia;
        wheel.rotation += wheel.omega * dt;
        wheel.forwardImpulse = longitudinal * dt;
        wheel.sideImpulse = -lateral * dt;
        chassis.applyImpulse(
          [forward[0] * wheel.forwardImpulse, forward[1] * wheel.forwardImpulse, forward[2] * wheel.forwardImpulse],
          wheel.point,
          false,
        );
        chassis.applyImpulse(
          [side[0] * wheel.sideImpulse, side[1] * wheel.sideImpulse, side[2] * wheel.sideImpulse],
          [centreWorld[0] + lifted[0], centreWorld[1] + lifted[1], centreWorld[2] + lifted[2]],
          false,
        );
        continue;
      }
      // The friction circle: drive and grip together stay inside what the load can hold.
      let along = drive,
        across = slide;
      const total = Math.hypot(along, across);
      if (total > grip && total > 0) {
        along *= grip / total;
        across *= grip / total;
      }
      wheel.forwardImpulse = along;
      wheel.sideImpulse = across;
      chassis.applyImpulse([forward[0] * along, forward[1] * along, forward[2] * along], wheel.point, false);
      chassis.applyImpulse(
        [side[0] * across, side[1] * across, side[2] * across],
        [centreWorld[0] + lifted[0], centreWorld[1] + lifted[1], centreWorld[2] + lifted[2]],
        false,
      );
      wheel.rotation += (rolling / wheel.radius) * dt;
    }
  }

  /** The wheels a drivetrain drives, as vehicle wheel indexes: the first axle's two, then the second's. */
  private drivenIndexes(): number[] {
    return this.drivetrain ? this.drivetrain.drivenWheels : [];
  }

  /** Drive and brake torque on a wheel with a tyre model, over a step: the brake stops the wheel and does not turn it back. */
  private driveBrake(wheel: WheelSetup, dt: number): void {
    let omega = wheel.omega;
    if (this.drivetrain) omega += (wheel.torque * dt) / wheel.inertia;
    else if (wheel.drive) omega += (this.engineForce * wheel.radius * dt) / wheel.inertia;
    if (wheel.brake && this.brake > 0) {
      const cut = (this.brake * wheel.radius * dt) / wheel.inertia;
      omega = Math.abs(omega) <= cut ? 0 : omega - Math.sign(omega) * cut;
    }
    wheel.omega = omega;
  }

  /** @internal disposes the vehicle when its chassis goes. */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.chassis) this.dispose();
  }

  /** @internal writes wheel meshes; called by the world after each sync. */
  afterSync(): void {
    if (this.disposed) return;
    for (let i = 0; i < this.wheels.length; i++) {
      const mesh = this.wheels[i]!.mesh;
      if (!mesh) continue;
      // A disposed wheel mesh is let go, as the world lets go of a body whose mesh was disposed.
      try {
        mesh.check();
      } catch {
        this.wheels[i]!.mesh = null;
        continue;
      }
      this.wheelLocalPose(i, this.position, this.quaternion);
      mesh
        .setPosition(this.position as unknown as Vec3)
        .setQuaternion(this.quaternion as unknown as [number, number, number, number]);
    }
  }

  private checkWheel(index: number): void {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        'Vehicle is disposed; create a new one with new Vehicle(physics, chassis, options).',
      );
    if (!Number.isInteger(index) || index < 0 || index >= this.wheels.length)
      throw new RangeError(`Wheel index must be an integer from 0 to ${this.wheels.length - 1}`);
  }

  /** Detaches the vehicle from the world. The chassis body stays; wheel meshes keep their last pose. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.physics.detach(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
