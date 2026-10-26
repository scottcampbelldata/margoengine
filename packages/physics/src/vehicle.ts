/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { Mesh } from '@margoengine/core';
import type { Collider, DynamicRayCastVehicleController } from './rapier-types.js';
import type { PhysicsBody } from './body.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import { checkVec, vec, tuple, type Vec3 } from './math.js';

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
  /** Spring stiffness of the suspension (default Rapier's 5.88; about 20 to 50 for a sports car). */
  suspensionStiffness?: number;
  /** Damping while the suspension compresses (default Rapier's 0.83). */
  suspensionCompression?: number;
  /** Damping while the suspension extends (default Rapier's 0.88). */
  suspensionRelaxation?: number;
  /** Longest suspension travel in metres (default Rapier's 5). */
  maxSuspensionTravel?: number;
  /** Strongest suspension force in newtons (default Rapier's 6000). */
  maxSuspensionForce?: number;
  /** Tyre grip along the wheel's rolling direction (default Rapier's 10.5); lower slides more. */
  frictionSlip?: number;
  /** Tyre grip sideways (default Rapier's 1). */
  sideFrictionStiffness?: number;
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
  /** Brake force per braking wheel at full brake (default 0.05 x the chassis mass). */
  maxBrakeForce?: number;
  /** Steering angle at full lock, radians (default 0.5, about 29 degrees). */
  maxSteeringAngle?: number;
  /** Packed interaction groups of the wheel rays, see `collisionGroups` (default all). */
  groups?: number;
  /** Return false to make the wheels ignore a collider (the chassis's own colliders are always ignored). */
  predicate?: (collider: Collider) => boolean;
}

/** Driver input for {@link Vehicle.setInput}, each axis normalized. */
export interface VehicleInput {
  /** -1 (full reverse) to 1 (full throttle). */
  throttle?: number;
  /** -1 (full lock right) to 1 (full lock left); positive turns toward +X for a chassis facing +Z. */
  steer?: number;
  /** 0 (off) to 1 (full brake). */
  brake?: number;
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
}

interface WheelSetup {
  connection: [number, number, number];
  direction: [number, number, number];
  axle: [number, number, number];
  steer: boolean;
  drive: boolean;
  brake: boolean;
  mesh: Mesh | null;
}

const unit = (value: Vec3, label: string): [number, number, number] => {
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
const clamp = (value: number | undefined, min: number, max: number, label: string): number => {
  const v = value ?? 0;
  if (!Number.isFinite(v)) throw new RangeError(`${label} must be a finite number from ${min} to ${max}`);
  return Math.min(max, Math.max(min, v));
};

/**
 * A ray-cast vehicle: Rapier's dynamic ray-cast vehicle controller on a dynamic chassis body. Each wheel casts its
 * suspension down every fixed step; set `engineForce`, `steering` and `brake` (or `setInput`) from
 * `physics.on('beforestep')` or once per frame. `new Vehicle(physics, chassis, {wheels})`; it steps with the world and
 * is disposed with it. Import it only where you need it: the `Physics` world never loads it.
 */
export class Vehicle implements PhysicsAttachment {
  /** Rapier's `DynamicRayCastVehicleController`, for anything not wrapped. */
  readonly raw: DynamicRayCastVehicleController;
  /** Engine force applied to every driven wheel, newtons (negative reverses). */
  engineForce = 0;
  /** Steering angle of every steered wheel, radians around the chassis up axis. */
  steering = 0;
  /** Brake force applied to every braking wheel. */
  brake = 0;
  /** Engine force at full throttle in `setInput`. */
  maxEngineForce: number;
  /** Brake force at full brake in `setInput`. */
  maxBrakeForce: number;
  /** Steering angle at full lock in `setInput`, radians. */
  maxSteeringAngle: number;
  private readonly wheels: WheelSetup[] = [];
  private readonly groups?: number;
  private readonly predicate?: (collider: Collider) => boolean;
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
    const world = physics.world;
    if (typeof world.createVehicleController !== 'function')
      throw new MargoError('unsupported', 'Vehicles need Rapier 0.12 or later; upgrade @dimforge/rapier3d-compat.');
    const wheels = options?.wheels;
    if (!Array.isArray(wheels) || !wheels.length)
      throw new RangeError('A vehicle needs at least one wheel: {wheels: [{position: [0.8, 0, 1.2], radius: 0.35}]}');
    // Validate every wheel before Rapier allocates anything.
    for (const wheel of wheels) {
      checkVec(wheel?.position, 'Wheel position');
      positive(wheel.radius, 'Wheel radius');
      if (wheel.suspensionRestLength !== undefined) positive(wheel.suspensionRestLength, 'Wheel suspensionRestLength');
      this.wheels.push({
        connection: [wheel.position[0], wheel.position[1], wheel.position[2]],
        direction: unit(wheel.direction ?? [0, -1, 0], 'Wheel direction'),
        axle: unit(wheel.axle ?? [-1, 0, 0], 'Wheel axle'),
        steer: wheel.steer ?? false,
        drive: wheel.drive ?? true,
        brake: wheel.brake ?? true,
        mesh: wheel.mesh ?? null,
      });
    }
    const mass = chassis.mass;
    this.maxEngineForce = options.maxEngineForce ?? mass;
    this.maxBrakeForce = options.maxBrakeForce ?? 0.05 * mass;
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
    const raw = world.createVehicleController(chassis.raw);
    this.raw = raw;
    wheels.forEach((wheel, i) => {
      const setup = this.wheels[i];
      raw.addWheel(
        vec(setup.connection),
        vec(setup.direction),
        vec(setup.axle),
        wheel.suspensionRestLength ?? 0.3,
        wheel.radius,
      );
      if (wheel.suspensionStiffness !== undefined) raw.setWheelSuspensionStiffness(i, wheel.suspensionStiffness);
      if (wheel.suspensionCompression !== undefined) raw.setWheelSuspensionCompression(i, wheel.suspensionCompression);
      if (wheel.suspensionRelaxation !== undefined) raw.setWheelSuspensionRelaxation(i, wheel.suspensionRelaxation);
      if (wheel.maxSuspensionTravel !== undefined) raw.setWheelMaxSuspensionTravel(i, wheel.maxSuspensionTravel);
      if (wheel.maxSuspensionForce !== undefined) raw.setWheelMaxSuspensionForce(i, wheel.maxSuspensionForce);
      if (wheel.frictionSlip !== undefined) raw.setWheelFrictionSlip(i, wheel.frictionSlip);
      if (wheel.sideFrictionStiffness !== undefined) raw.setWheelSideFrictionStiffness(i, wheel.sideFrictionStiffness);
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
    this.engineForce = clamp(input.throttle, -1, 1, 'Vehicle throttle') * this.maxEngineForce;
    this.steering = clamp(input.steer, -1, 1, 'Vehicle steer') * this.maxSteeringAngle;
    this.brake = clamp(input.brake, 0, 1, 'Vehicle brake') * this.maxBrakeForce;
    return this;
  }

  /** Forward speed in metres per second along the chassis +Z axis (negative when reversing). */
  get speed(): number {
    const v = this.chassis.linearVelocity,
      [x, y, z, w] = this.chassis.rotation;
    // Chassis +Z in world space: the third column of the rotation matrix.
    const fx = 2 * (x * z + w * y),
      fy = 2 * (y * z - w * x),
      fz = 1 - 2 * (x * x + y * y);
    return v[0] * fx + v[1] * fy + v[2] * fz;
  }

  /** State of wheel `index` after the last step. */
  wheel(index: number): WheelState {
    this.checkWheel(index);
    const raw = this.raw,
      point = raw.wheelContactPoint(index),
      normal = raw.wheelContactNormal(index),
      contact = raw.wheelIsInContact(index);
    return {
      inContact: contact,
      suspensionLength: raw.wheelSuspensionLength(index) ?? 0,
      suspensionForce: raw.wheelSuspensionForce(index) ?? 0,
      rotation: raw.wheelRotation(index) ?? 0,
      steering: raw.wheelSteering(index) ?? 0,
      contactPoint: contact && point ? tuple(point) : null,
      contactNormal: contact && normal ? tuple(normal) : null,
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
    const setup = this.wheels[index],
      raw = this.raw,
      length = raw.wheelSuspensionLength(index) ?? 0;
    for (let a = 0; a < 3; a++) position[a] = setup.connection[a] + setup.direction[a] * length;
    // Steering turns around the chassis up axis (opposite the suspension direction), spin around the axle.
    const s = (raw.wheelSteering(index) ?? 0) / 2,
      r = -(raw.wheelRotation(index) ?? 0) / 2,
      ss = Math.sin(s),
      sc = Math.cos(s),
      rs = Math.sin(r),
      rc = Math.cos(r),
      d = setup.direction,
      a = setup.axle;
    const ax = -d[0] * ss,
      ay = -d[1] * ss,
      az = -d[2] * ss,
      aw = sc,
      bx = a[0] * rs,
      by = a[1] * rs,
      bz = a[2] * rs,
      bw = rc;
    quaternion[0] = aw * bx + ax * bw + ay * bz - az * by;
    quaternion[1] = aw * by - ax * bz + ay * bw + az * bx;
    quaternion[2] = aw * bz + ax * by - ay * bx + az * bw;
    quaternion[3] = aw * bw - ax * bx - ay * by - az * bz;
    return { position, quaternion };
  }

  /** @internal applies the controls and casts the wheels; called by the world before each step. */
  beforeStep(dt: number): void {
    if (this.disposed || !this.chassis.valid) return;
    const raw = this.raw;
    // Engine force on a sleeping chassis is ignored by Rapier, so a parked car would not pull away: wake it.
    if (this.engineForce !== 0 && this.chassis.raw.isSleeping()) this.chassis.raw.wakeUp();
    for (let i = 0; i < this.wheels.length; i++) {
      const setup = this.wheels[i];
      raw.setWheelEngineForce(i, setup.drive ? this.engineForce : 0);
      raw.setWheelSteering(i, setup.steer ? this.steering : 0);
      raw.setWheelBrake(i, setup.brake ? this.brake : 0);
    }
    raw.updateVehicle(dt, undefined, this.groups, this.predicate);
  }

  /** @internal disposes the vehicle when its chassis goes. */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.chassis) this.dispose();
  }

  /** @internal writes wheel meshes; called by the world after each sync. */
  afterSync(): void {
    if (this.disposed) return;
    for (let i = 0; i < this.wheels.length; i++) {
      const mesh = this.wheels[i].mesh;
      if (!mesh) continue;
      // A disposed wheel mesh is let go, as the world lets go of a body whose mesh was disposed.
      try {
        mesh.check();
      } catch {
        this.wheels[i].mesh = null;
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

  /** Removes the vehicle controller. The chassis body stays; wheel meshes keep their last pose. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.physics.detach(this) && !this.physics.isDisposed) this.physics.world.removeVehicleController?.(this.raw);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
