/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { Mesh } from '@margoengine/core';
import type { PhysicsCollider } from './collider.js';
import type { PhysicsBody } from './body.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import { checkVec, type Vec3 } from './math.js';

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
  /** Tyre grip along the wheel's rolling direction (default 10.5); lower slides more. */
  frictionSlip?: number;
  /** Tyre grip sideways (default 1). */
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
  /** Brake force per braking wheel at full brake, newtons (default 3 x the chassis mass, so four braking wheels slow 1.2 g). */
  maxBrakeForce?: number;
  /** Steering angle at full lock, radians (default 0.5, about 29 degrees). */
  maxSteeringAngle?: number;
  /** Packed interaction groups of the wheel rays, see `collisionGroups` (default all). */
  groups?: number;
  /** Return false to make the wheels ignore a collider (the chassis's own colliders are always ignored). */
  predicate?: (collider: PhysicsCollider) => boolean;
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
  radius: number;
  rest: number;
  stiffness: number;
  compression: number;
  relaxation: number;
  travel: number;
  maxForce: number;
  slip: number;
  side: number;
  // State after the last step.
  contact: boolean;
  length: number;
  force: number;
  rotation: number;
  steering: number;
  point: [number, number, number];
  normal: [number, number, number];
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
  private readonly wheels: WheelSetup[] = [];
  private readonly groups?: number;
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
        contact: false,
        length: rest,
        force: 0,
        rotation: 0,
        steering: 0,
        point: [0, 0, 0],
        normal: [0, 1, 0],
      });
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
    const w = this.wheels[index]!;
    return {
      inContact: w.contact,
      suspensionLength: w.length,
      suspensionForce: w.force,
      rotation: w.rotation,
      steering: w.steering,
      contactPoint: w.contact ? [...w.point] : null,
      contactNormal: w.contact ? [...w.normal] : null,
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
    for (const wheel of this.wheels) {
      const origin = rotate(rotation, wheel.connection).map((c, i) => c + position[i]!) as V,
        down = rotate(rotation, wheel.direction),
        reach = wheel.rest + wheel.radius,
        hit = own.raycast(origin, down, {
          maxDistance: reach,
          exclude: chassis,
          excludeSensors: true,
          groups: this.groups,
          predicate,
        });
      wheel.steering = wheel.steer ? this.steering : 0;
      if (!hit) {
        wheel.contact = false;
        wheel.length = wheel.rest;
        wheel.force = 0;
        continue;
      }
      wheel.contact = true;
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
      const grip = wheel.slip * force * dt;
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
      if (flat < 1e-6) {
        chassis.applyImpulse(
          [normal[0] * force * dt, normal[1] * force * dt, normal[2] * force * dt],
          hit.point,
          false,
        );
        continue;
      }
      forward = [forward[0] / flat, forward[1] / flat, forward[2] / flat];
      const side = cross(forward, normal);
      let drive = wheel.drive ? this.engineForce * dt : 0;
      const rolling = dot(forward, pv);
      if (wheel.brake && this.brake > 0) {
        const stop = -rolling / inverseMass(r, forward),
          limit = this.brake * dt;
        drive += Math.max(-limit, Math.min(limit, stop));
      }
      const slide = (-dot(side, pv) / inverseMass(r, side)) * wheel.side;
      // The friction circle: drive and grip together stay inside what the load can hold.
      let along = drive,
        across = slide;
      const total = Math.hypot(along, across);
      if (total > grip && total > 0) {
        along *= grip / total;
        across *= grip / total;
      }
      const impulse: V = [
        normal[0] * force * dt + forward[0] * along + side[0] * across,
        normal[1] * force * dt + forward[1] * along + side[1] * across,
        normal[2] * force * dt + forward[2] * along + side[2] * across,
      ];
      chassis.applyImpulse(impulse, hit.point, false);
      wheel.rotation += (rolling / wheel.radius) * dt;
    }
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
