/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';
import { hypot, pow } from '@margoengine/math/pinned';
import { STANDARD_GRAVITY } from '@margoengine/math/gravity';
import type { Mesh } from '@margoengine/core';
import type { PhysicsCollider } from './collider.js';
import type { PhysicsBody } from './body.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import type { Vec3 } from './math.js';
import type { Drivetrain } from './drivetrain.js';
import type { TyreModel } from './tyres.js';
import type { DebugLines } from './debug.js';

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

/** Contact region sampled after the wheel's swept or ray query. */
export interface WheelGroundContact {
  readonly collider: PhysicsCollider;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
  readonly width: number;
}

/** One measured running surface. Omit the sample to keep the vehicle's existing tyre settings. */
export interface WheelGroundMaterial {
  /** Upper bound on the combined traction coefficient; dry and wet surfaces may supply different values. */
  readonly grip: number;
  /** Optional Bekker pressure–sinkage relation p = stiffness * z^exponent using the measured tyre footprint. */
  readonly soil?: {
    /** Effective plate stiffness, Pa/m^exponent. */
    readonly stiffness: number;
    /** Positive pressure–sinkage exponent. */
    readonly exponent: number;
    /** Effective loaded patch area, m². */
    readonly area: number;
  };
}

/** Step-local longitudinal soil reaction from an independently resolved wheel contact. */
export interface WheelGroundTraction {
  readonly collider: PhysicsCollider;
  /** Positive normal force at the sampled contact, N. */
  readonly load: number;
  /** Signed chassis force along the rolling direction, N. */
  readonly drawbar: number;
  /** Moment resisting forward spin in N·m. Negative torque spins up a skidding wheel. */
  readonly axleTorque: number;
  /** Optional force along the tyre's lateral axis in N, limited to oppose side slip. */
  readonly sideForce?: number;
}

/** The surface effect used by one wheel in its last step. */
export interface WheelGroundState {
  /** Applied bound on the combined coefficient, or null when the wheel uses its legacy material. */
  readonly grip: number | null;
  /** Vertical displacement into yielding ground along the local surface normal, m. */
  readonly sinkage: number;
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
  /** Optional deterministic material sample for the actual wheel contact, after the query. */
  groundMaterial?: (contact: WheelGroundContact) => WheelGroundMaterial | undefined;
  /** Follow the hit body's surface velocity and apply equal and opposite wheel impulses. Default false. */
  groundReaction?: boolean;
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

/**
 * Options of {@link Vehicle.car}: every field of {@link VehicleOptions} but `wheels`, which the car lays out itself, and three of
 * its own. Each is optional.
 */
export interface CarOptions extends Omit<VehicleOptions, 'wheels'> {
  /**
   * Half sizes of the car's body in the chassis frame, along x, y and z (default the box around the chassis's box colliders, and
   * around the spheres of its sphere, capsule, cylinder and cone colliders). Give it for a chassis of hull or mesh colliders.
   */
  halfExtents?: Vec3;
  /** Settings every wheel takes over the arcade ones, for example `{radius: 0.4, frictionSlip: 2}` (default none). */
  wheel?: Partial<Omit<WheelOptions, 'position' | 'mesh' | 'steer'>>;
  /**
   * Meshes drawn as the four wheels, in the order front left, front right, rear left, rear right: children of the chassis mesh,
   * modelled centred on their hubs with their axle along x (default none).
   */
  wheelMeshes?: readonly (Mesh | null | undefined)[];
}

/** What {@link Vehicle.debugRender} draws. Each part is on unless switched off. */
export interface VehicleDebugOptions {
  /** Each wheel's suspension ray: mount to hub, and hub to the ground (or to full droop in the air). Default true. */
  suspension?: boolean;
  /** Each contact point with a short line along the ground normal. Default true. */
  contacts?: boolean;
  /**
   * Each tyre's push on the chassis in the last step as a line from its contact point, one metre for a push of the wheel's whole load,
   * green while the tyre grips and red as it reaches its grip limit and slides. Default true.
   */
  slip?: boolean;
  /** Each wheel as a circle of its radius around its steered axle. Default true. */
  wheels?: boolean;
  /** Colours, each one left out keeping its default. */
  style?: VehicleDebugStyle;
}

/**
 * Colours of {@link VehicleDebugOptions.style}, red, green, blue and alpha from 0 to 1. Defaults: suspension [0.25, 0.8, 1, 1], airborne
 * [0.55, 0.55, 0.6, 1], contact [1, 0.3, 0.9, 1], grip [0.3, 0.95, 0.35, 1], sliding [1, 0.2, 0.15, 1], wheel [0.92, 0.92, 0.95, 1];
 * `normalLength` 0.25 m.
 */
export interface VehicleDebugStyle {
  suspension?: readonly [number, number, number, number];
  airborne?: readonly [number, number, number, number];
  contact?: readonly [number, number, number, number];
  grip?: readonly [number, number, number, number];
  sliding?: readonly [number, number, number, number];
  wheel?: readonly [number, number, number, number];
  /** The line along each contact normal, metres. */
  normalLength?: number;
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
  /** The suspension direction in the world at the last cast. */
  down: [number, number, number];
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
  groundGrip: number | null;
  sinkage: number;
  camberSine: number;
  traction?: WheelGroundTraction;
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

/**
 * @internal A vehicle input or call that cannot be used: a MargoError (code `unsupported` unless given) whose message names
 * the input and its fix and links the vehicles entry of the error help page.
 */
export function invalidVehicle(message: string, code: MargoErrorCode = 'unsupported'): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#vehicles`);
}
const checkVec = (value: unknown, label: string): void => {
  const v = value as ArrayLike<number> | undefined;
  if (
    !(Array.isArray(v) || ArrayBuffer.isView(v)) ||
    v.length !== 3 ||
    !Number.isFinite(v[0]) ||
    !Number.isFinite(v[1]) ||
    !Number.isFinite(v[2])
  )
    throw invalidVehicle(`${label} must be [x, y, z], three finite numbers.`);
};
const unit = (value: Vec3, label: string): V => {
  checkVec(value, label);
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!length) throw invalidVehicle(`${label} must be nonzero; pass a direction such as [0, -1, 0].`);
  return [value[0] / length, value[1] / length, value[2] / length];
};
const positive = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw invalidVehicle(`${label} must be a positive finite number`);
  return value;
};
const fraction = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1))
    throw invalidVehicle(`${label} must be a number from 0 to 1; use 0.1 for a car that does not tip over.`);
  return value;
};
const clamp = (value: number | undefined, min: number, max: number, label: string): number => {
  const v = value ?? 0;
  if (!Number.isFinite(v)) throw invalidVehicle(`${label} must be a finite number from ${min} to ${max}`);
  return Math.min(max, Math.max(min, v));
};

/** A wheel's axle in the world, turned by its steering about the chassis up axis. */
function steeredAxle(w: { direction: V; axle: V; steering: number }, rotation: readonly number[]): V {
  const s = w.steering / 2,
    sine = Math.sin(s);
  return rotate(
    rotation,
    rotate([-w.direction[0] * sine, -w.direction[1] * sine, -w.direction[2] * sine, Math.cos(s)], w.axle),
  );
}

function groundInverse(body: PhysicsBody, point: V, direction: V): number {
  if (body.type !== 'dynamic') return 0;
  const centre = body.worldCenterOfMass;
  const r: V = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
  const principal = rotate(conjugate(multiply(body.rotation, body.inertiaFrame)), cross(r, direction));
  const inverse = body.inversePrincipalInertia;
  return (
    body.inverseMass + dot(principal, [principal[0] * inverse[0], principal[1] * inverse[1], principal[2] * inverse[2]])
  );
}

function contactVelocity(chassis: PhysicsBody, support: PhysicsBody | undefined, point: V): V {
  const speed = chassis.velocityAtPoint(point);
  if (!support) return speed;
  const other = support.velocityAtPoint(point);
  return [speed[0] - other[0], speed[1] - other[1], speed[2] - other[2]];
}

function tractionInverse(body: PhysicsBody, point: V, forward: V): number {
  if (body.type !== 'dynamic') return 0;
  const centre = body.worldCenterOfMass;
  const [a, b, c] = cross([point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]], forward);
  const m = body.effectiveInverseMass;
  const I = body.effectiveWorldInverseInertia;
  return (
    dot(forward, [m[0] * forward[0], m[1] * forward[1], m[2] * forward[2]]) +
    a * (I[0]! * a + I[1]! * b + I[2]! * c) +
    b * (I[3]! * a + I[4]! * b + I[5]! * c) +
    c * (I[6]! * a + I[7]! * b + I[8]! * c)
  );
}

function passiveTraction(
  traction: WheelGroundTraction,
  wheel: WheelSetup,
  travel: number,
  inverse: number,
  dt: number,
): [forward: number, axle: number] {
  const load = Math.min(1, wheel.force / traction.load);
  const forceCap = (wheel.groundGrip ?? Infinity) * wheel.force;
  const impulse = Math.max(-forceCap, Math.min(forceCap, traction.drawbar)) * load * dt;
  const moment = -traction.axleTorque * load * dt;
  const spin = wheel.omega;
  const work = impulse * travel + moment * spin;
  const compliance = 0.5 * (impulse * impulse * inverse + (moment * moment) / wheel.inertia);
  // Scale both components together so the sampled pair cannot add kinetic energy or reverse travel or spin.
  const scale = Math.min(
    1,
    compliance > 0 ? Math.max(0, -work / compliance) : 0,
    impulse < 0 && inverse > 0 ? -travel / (impulse * inverse) : 1,
    moment < 0 ? (-spin * wheel.inertia) / moment : 1,
  );
  return [impulse * scale, moment * scale];
}

function groundYield(
  soil: NonNullable<WheelGroundMaterial['soil']>,
  load: number,
  spring: number,
  travel: number,
  capacity: number,
): { depth: number; force: number } {
  const stiffness = positive(soil.stiffness, 'Soil pressure stiffness') * positive(soil.area, 'Soil footprint area');
  const exponent = positive(soil.exponent, 'Soil pressure exponent');
  const support = (depth: number) => stiffness * (exponent === 1 ? depth : pow(depth, exponent));
  const springLoad = (depth: number) => Math.min(capacity, Math.max(0, load - spring * depth));
  let low = 0;
  let high = travel;
  if (support(high) <= springLoad(high)) return { depth: high, force: support(high) };
  // Pressure increases with depth; available spring load decreases. The bracket contracts by 2^-22.
  for (let i = 0; i < 22; i++) {
    const mid = 0.5 * (low + high);
    if (support(mid) < springLoad(mid)) low = mid;
    else high = mid;
  }
  const depth = 0.5 * (low + high);
  return { depth, force: springLoad(depth) };
}

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
  private readonly groundMaterial?: VehicleOptions['groundMaterial'];
  private readonly groundReaction: boolean;
  private disposed = false;
  private lastStep = 0;
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
      throw invalidVehicle('Chassis must belong to this physics world; add it with physics.addBody first.', 'state');
    if (chassis.type !== 'dynamic')
      throw invalidVehicle(
        "A vehicle chassis must be a dynamic body; add it with physics.addBody(mesh, {type: 'dynamic'}).",
      );
    if (!chassis.colliders.length)
      throw invalidVehicle('A vehicle chassis needs a collider to have mass; give the chassis body a box collider.');
    this.facing = options?.forward ? unit(options.forward, 'Vehicle forward') : [0, 0, 1];
    const wheels = options?.wheels;
    if (!Array.isArray(wheels) || !wheels.length)
      throw invalidVehicle('A vehicle needs at least one wheel: {wheels: [{position: [0.8, 0, 1.2], radius: 0.35}]}');
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
        down: [0, -1, 0],
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
        groundGrip: null,
        sinkage: 0,
        camberSine: 0,
      });
      const made = this.wheels[this.wheels.length - 1]!;
      if (made.cast !== 'ray' && made.cast !== 'shape')
        throw invalidVehicle(`Wheel cast must be 'ray' or 'shape'; got ${String(made.cast)}.`);
      if (made.tyre && typeof made.tyre.forces !== 'function')
        throw invalidVehicle(
          'A tyre model is an object with a forces(sample) method; pass pacejkaTyre() or brushTyre().',
        );
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
        throw invalidVehicle(`Vehicle ${label} must be a finite number of at least 0`);
    this.groups = options.groups;
    this.predicate = options.predicate;
    this.groundMaterial = options.groundMaterial;
    this.groundReaction = options.groundReaction ?? false;
    this.drivetrain = options.drivetrain ?? null;
    if (this.drivetrain) {
      for (const index of this.drivenIndexes()) {
        if (!Number.isInteger(index) || index >= this.wheels.length)
          throw invalidVehicle(
            `The drivetrain names wheel ${index}, but the vehicle has ${this.wheels.length}; use wheel indexes from 0 to ${this.wheels.length - 1}.`,
          );
        if (!this.wheels[index]!.tyre)
          throw invalidVehicle(
            `Wheel ${index} is driven by a drivetrain and needs a tyre model: pass tyre: pacejkaTyre() to the vehicle.`,
            'state',
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
        throw invalidVehicle(
          `Anti-roll bar ${i} joins two different wheels of the vehicle; pass {wheels: [0, 1], stiffness: 20000}.`,
        );
      if (!(bar.stiffness >= 0 && Number.isFinite(bar.stiffness)))
        throw invalidVehicle(`Anti-roll bar ${i} stiffness must be a finite number of 0 or more.`);
      return { a: a!, b: b!, stiffness: bar.stiffness };
    });
    physics.attach(this);
  }

  /**
   * An arcade car that drives at once with no tuning: four wheels laid out from the chassis's own size, the front pair steering
   * and all four driving and braking, as `new Vehicle(physics, chassis, {wheels})` with these wheels.
   *
   * From the half sizes of the body (`halfExtents`, or its box colliders) along its forward, left and up axes, `L`, `W` and `H`:
   * wheel radius `r = 0.35 min(W, L)`, suspension rest length `0.85 r`, wheel centres on the body's sides (`W` either side,
   * half of each tyre outside the body) and `0.7 L` ahead and behind its centre, mounted so that at rest each hub stands
   * `0.2 r` above the bottom of the body (which rides `0.8 r` off the ground). The springs
   * are set so the car rests with each spring a third of the way in (`suspensionStiffness = g / (4 sag)` per kilogram of
   * chassis, `sag = rest / 3`), damped at 0.3 of critical on compression and 0.5 on extension, each carrying up to six times
   * its share of the weight. Grip, engine force (the chassis mass in newtons a wheel, 0.4 g in all), brakes and steering keep
   * the {@link Vehicle} defaults. `wheel` overrides any of these for every wheel; `forward` turns the whole layout (default +Z).
   * @param physics The world the chassis belongs to.
   * @param chassis A dynamic body with a collider, for example `{shape: 'box', halfExtents: [0.9, 0.3, 2], mass: 1200}`.
   * @param options Overrides; see {@link CarOptions}.
   * @throws MargoError (code `unsupported`, or `state` for a chassis of another world) naming the input and its fix.
   */
  static car(physics: Physics, chassis: PhysicsBody, options: CarOptions = {}): Vehicle {
    if (!physics?.owns?.(chassis))
      throw invalidVehicle('Chassis must belong to this physics world; add it with physics.addBody first.', 'state');
    const { halfExtents, wheel = {} as NonNullable<CarOptions['wheel']>, wheelMeshes = [], ...rest } = options;
    const forward = rest.forward ? unit(rest.forward, 'Vehicle forward') : ([0, 0, 1] as V),
      up: V = [0, 1, 0],
      side = cross(up, forward),
      span = hypot(side[0], side[1], side[2]);
    if (!(span > 1e-6))
      throw invalidVehicle('Vehicle.car forward must not point along the chassis up axis (+y); pass [0, 0, 1] for +Z.');
    const left: V = [side[0] / span, side[1] / span, side[2] / span];
    let low: V = [Infinity, Infinity, Infinity],
      high: V = [-Infinity, -Infinity, -Infinity];
    if (halfExtents) {
      checkVec(halfExtents, 'Vehicle.car halfExtents');
      for (let a = 0; a < 3; a++) {
        positive(halfExtents[a], 'Vehicle.car halfExtents');
        low[a] = -halfExtents[a]!;
        high[a] = halfExtents[a]!;
      }
    } else
      for (const collider of chassis.colliders) {
        const box = collider.halfExtents(),
          radius = box ? null : collider.boundingRadius,
          t = collider.translationWrtParent(),
          q = collider.rotationWrtParent();
        if (!box && radius === null) continue;
        for (let corner = 0; corner < 8; corner++) {
          const local: V = box
              ? [corner & 1 ? box.x : -box.x, corner & 2 ? box.y : -box.y, corner & 4 ? box.z : -box.z]
              : [corner & 1 ? radius! : -radius!, corner & 2 ? radius! : -radius!, corner & 4 ? radius! : -radius!],
            p = box ? rotate([q.x, q.y, q.z, q.w], local) : local;
          low = [Math.min(low[0], p[0] + t.x), Math.min(low[1], p[1] + t.y), Math.min(low[2], p[2] + t.z)];
          high = [Math.max(high[0], p[0] + t.x), Math.max(high[1], p[1] + t.y), Math.max(high[2], p[2] + t.z)];
        }
      }
    if (!(high[0] > low[0] && high[1] > low[1] && high[2] > low[2]))
      throw invalidVehicle(
        'Vehicle.car needs the size of the car: give the chassis a box collider, or pass halfExtents: [0.9, 0.3, 2].',
      );
    const centre: V = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2],
      half: V = [(high[0] - low[0]) / 2, (high[1] - low[1]) / 2, (high[2] - low[2]) / 2],
      // The body's centre and half size along a unit axis of the chassis frame.
      along = (u: V): [number, number] => [
        dot(centre, u),
        Math.abs(u[0]) * half[0] + Math.abs(u[1]) * half[1] + Math.abs(u[2]) * half[2],
      ],
      [atForward, length] = along(forward),
      [atLeft, width] = along(left),
      [atUp, height] = along(up),
      radius = wheel.radius ?? 0.35 * Math.min(width, length),
      restLength = wheel.suspensionRestLength ?? 0.85 * radius,
      gravity = physics.gravity,
      g = hypot(gravity[0], gravity[1], gravity[2]) || STANDARD_GRAVITY,
      sag = restLength / 3,
      stiffness = g / (4 * sag),
      // Each spring carries a quarter of the car: four of them ring at sqrt(4 k), so a damper of c a kilogram is 2 zeta sqrt(4 k) / 4.
      critical = Math.sqrt(4 * stiffness) / 2,
      // At rest each hub stands 0.2 r above the bottom of the body, so the body rides 0.8 r off the ground.
      mount = atUp - height + 0.2 * radius + (restLength - sag),
      axle: V = [-left[0], -left[1], -left[2]];
    const wheels = (
      [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ] as const
    ).map(([toLeft, ahead], i): WheelOptions => {
      const x = atLeft + toLeft * width,
        z = atForward + ahead * 0.7 * length;
      return {
        position: [
          left[0] * x + forward[0] * z + up[0] * mount,
          left[1] * x + forward[1] * z + up[1] * mount,
          left[2] * x + forward[2] * z + up[2] * mount,
        ],
        radius,
        axle,
        suspensionRestLength: restLength,
        suspensionStiffness: stiffness,
        suspensionCompression: 0.3 * critical,
        suspensionRelaxation: 0.5 * critical,
        maxSuspensionForce: (6 * chassis.mass * g) / 4,
        width: 0.6 * radius,
        steer: ahead > 0,
        ...(wheelMeshes[i] ? { mesh: wheelMeshes[i]! } : {}),
        ...wheel,
      };
    });
    return new Vehicle(physics, chassis, { ...rest, wheels });
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

  /** Replace forward tyre traction for the next step on this collider. The tyre still handles lateral slip. */
  setWheelGroundTraction(index: number, traction: WheelGroundTraction): void {
    this.checkWheel(index);
    const wheel = this.wheels[index]!;
    if (!wheel.tyre)
      throw invalidVehicle(
        'A wheel needs its own spin for ground traction. Configure a tyre model on the wheel.',
        'state',
      );
    if (
      !(
        Number.isFinite(Math.fround(traction.load)) &&
        traction.load > 0 &&
        Number.isFinite(Math.fround(traction.drawbar)) &&
        Number.isFinite(Math.fround(traction.axleTorque)) &&
        (traction.sideForce === undefined || Number.isFinite(Math.fround(traction.sideForce)))
      )
    )
      throw invalidVehicle(
        'The wheel ground traction is invalid. Provide positive load and finite force and torque.',
        'state',
      );
    wheel.traction = { ...traction };
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

  /** Vertical component of the wheel's world right-axis unit vector at its last contact. */
  wheelCamberSine(index: number): number {
    this.checkWheel(index);
    return this.wheels[index]!.camberSine;
  }

  /** Number of f64 words needed to retain the attachment's controls, wheel spin and drivetrain. */
  get motionStateWords(): number {
    return 3 + 2 * this.wheels.length + (this.drivetrain ? 7 : 0);
  }

  /** Copies the physical running state into a caller-owned buffer for a world snapshot. */
  writeMotionState(output: Float64Array): void {
    if (output.length !== this.motionStateWords)
      throw invalidVehicle('Use a vehicle motion buffer of motionStateWords f64 values.', 'state');
    output[0] = this.engineForce;
    output[1] = this.steering;
    output[2] = this.brake;
    let at = 3;
    for (const wheel of this.wheels) {
      output[at++] = wheel.omega;
      output[at++] = wheel.rotation;
    }
    this.drivetrain?.writeMotionState(output.subarray(at));
  }

  /** Restores an attachment buffer written by writeMotionState for this vehicle configuration. */
  readMotionState(source: Float64Array): void {
    if (source.length !== this.motionStateWords || !source.every(Number.isFinite))
      throw invalidVehicle('Use a finite motion state made by a vehicle with the same wheels and drivetrain.', 'state');
    this.engineForce = source[0]!;
    this.steering = source[1]!;
    this.brake = source[2]!;
    let at = 3;
    for (const wheel of this.wheels) {
      wheel.omega = source[at++]!;
      wheel.rotation = source[at++]!;
    }
    this.drivetrain?.readMotionState(source.subarray(at));
  }

  /** Current traction bound and sinkage from the last contact of the specified wheel. */
  wheelGround(index: number): WheelGroundState {
    this.checkWheel(index);
    const { groundGrip, sinkage } = this.wheels[index]!;
    return { grip: groundGrip, sinkage };
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
    this.lastStep = dt;
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
    const pushWheel = (wheel: WheelSetup, impulse: V, at: V): void => {
      chassis.applyImpulse(impulse, at, false);
      const support = this.groundReaction ? wheel.ground?.body : undefined;
      if (support?.type === 'dynamic' && impulse.some((value) => value !== 0))
        support.applyImpulse([-impulse[0], -impulse[1], -impulse[2]], at);
    };
    const relativeVelocity = (wheel: WheelSetup, arm: V): V => {
      const v = pointVelocity(arm);
      if (!this.groundReaction || !wheel.ground) return v;
      const other = wheel.ground.body.velocityAtPoint(wheel.point);
      return [v[0] - other[0], v[1] - other[1], v[2] - other[2]];
    };
    // A damper reads how fast its length changed over the last step. The kernel splits a step into n substeps and adds gravity in
    // each (v += g h, x += v h), so a body ends the step g dt (n - 1) / (2 n) further along gravity than its mean speed over it: a
    // chassis held still read -7/16 g dt at 8 substeps, and its dampers carried weight its springs should (KB-PHYS-VEHICLEREST1).
    const substeps = Math.max(1, this.physics.substeps),
      lag = (dt * (substeps - 1)) / (2 * substeps),
      gravity = this.physics.gravity,
      fall = (body: PhysicsBody | undefined): number => (body?.type === 'dynamic' ? body.gravityScale * lag : 0);
    const meanVelocity = (wheel: WheelSetup, arm: V): V => {
      const v = relativeVelocity(wheel, arm),
        shift = fall(chassis) - (this.groundReaction ? fall(wheel.ground?.body) : 0);
      return [v[0] - gravity[0] * shift, v[1] - gravity[1] * shift, v[2] - gravity[2] * shift];
    };
    const contactInverse = (wheel: WheelSetup, arm: V, at: V, axis: V): number =>
      inverseMass(arm, axis) + (this.groundReaction && wheel.ground ? groundInverse(wheel.ground.body, at, axis) : 0);
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
      wheel.down = down;
      wheel.forwardImpulse = wheel.sideImpulse = 0;
      wheel.groundGrip = null;
      wheel.sinkage = 0;
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
      const material = this.groundMaterial?.({
        collider: hit.collider,
        point: hit.point,
        normal: hit.normal,
        radius: wheel.radius,
        width: wheel.width,
      });
      if (material) {
        if (!(Number.isFinite(material.grip) && material.grip >= 0))
          throw invalidVehicle('Provide a finite nonnegative wheel-ground grip coefficient.', 'state');
        wheel.groundGrip = material.grip;
      }
      const minimum = Math.max(0, wheel.rest - wheel.travel),
        length = Math.min(wheel.rest, Math.max(minimum, hit.distance - wheel.radius));
      wheel.length = length;
      const normal = hit.normal,
        r: V = [hit.point[0] - centreWorld[0], hit.point[1] - centreWorld[1], hit.point[2] - centreWorld[2]],
        cosine = -dot(normal, down),
        pv = meanVelocity(wheel, r);
      let inverse = 10,
        relative = 0;
      if (cosine > 0.1) {
        inverse = 1 / cosine;
        relative = dot(normal, pv) * inverse;
      }
      let force = wheel.stiffness * (wheel.rest - length) * inverse;
      force -= (relative < 0 ? wheel.compression : wheel.relaxation) * relative;
      force *= mass;
      if (material?.soil && force > 0) {
        const projection = 1 / inverse;
        const result = groundYield(
          material.soil,
          force,
          wheel.stiffness * inverse * inverse * mass,
          (wheel.rest - length) * projection,
          wheel.maxForce,
        );
        wheel.sinkage = result.depth;
        wheel.length += result.depth * inverse;
        wheel.point = [
          hit.point[0] - normal[0] * result.depth,
          hit.point[1] - normal[1] * result.depth,
          hit.point[2] - normal[2] * result.depth,
        ];
        force = result.force;
      }
      force = Math.min(wheel.maxForce, Math.max(0, force));
      wheel.force = force;
      pushWheel(wheel, [normal[0] * force * dt, normal[1] * force * dt, normal[2] * force * dt], wheel.point);
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
        pushWheel(wheel, [up[0] * force * sign, up[1] * force * sign, up[2] * force * sign], at);
      }
    }
    // Then drive, brake and grip. Every wheel sees the same chassis, so a wheel that cancelled all of a slide or a roll by
    // itself would have it cancelled once for each wheel on the ground: the chassis would rock from side to side at every
    // step, its grip clipped, and a car at rest would not drive at full force. The wheels share it instead.
    const grounded = this.wheels.filter((wheel) => wheel.contact).length;
    for (const wheel of this.wheels) {
      const traction = wheel.traction;
      wheel.traction = undefined;
      wheel.camberSine = 0;
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
        pv = relativeVelocity(wheel, r),
        grip = Math.min(wheel.slip, wheel.groundGrip ?? Infinity) * wheel.force * dt;
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
      wheel.camberSine = Math.max(-1, Math.min(1, -axleWorld[1]));
      let forward = cross(normal, axleWorld);
      const flat = Math.hypot(forward[0], forward[1], forward[2]);
      if (flat < 1e-6) continue;
      forward = [forward[0] / flat, forward[1] / flat, forward[2] / flat];
      const side = cross(forward, normal);
      const forwardInverse = contactInverse(wheel, r, wheel.point, forward);
      let drive = wheel.drive ? this.engineForce * dt : 0;
      const rolling = dot(forward, pv);
      if (wheel.brake && this.brake > 0) {
        const stop = -rolling / forwardInverse / grounded,
          limit = this.brake * dt;
        drive += Math.max(-limit, Math.min(limit, stop));
      }
      // The grip's push on the chassis is felt at a point drawn up toward the centre of mass by the roll influence, so a
      // grippy tyre turns the car about its length less than it would at the ground.
      const up = rotate(rotation, [-wheel.direction[0], -wheel.direction[1], -wheel.direction[2]]),
        height = dot(r, up) * (1 - wheel.roll),
        lifted: V = [r[0] - up[0] * height, r[1] - up[1] * height, r[2] - up[2] * height],
        elevated: V = [centreWorld[0] + lifted[0], centreWorld[1] + lifted[1], centreWorld[2] + lifted[2]],
        sideInverse = contactInverse(wheel, lifted, elevated, side),
        slide = ((-dot(side, pv) / sideInverse) * wheel.side) / grounded;
      if (wheel.tyre) {
        // A tyre model: the wheel keeps its own spin, and the model turns the slips and the load into forces. The forces are those the
        // step ends with, found implicitly: a force changes the wheel's surface speed and the chassis's speed at the contact, which
        // changes the slip the force came from, so the step takes the force that agrees with the slip it leaves (bisection on a
        // force that rises as the slip falls, taken over a few sweeps for the two that act together). A stiff tyre at low speed then
        // brings the slip to rest, where a force found at the slip the step began with would ring.
        this.driveBrake(wheel, dt);
        let soilImpulse: number | undefined;
        let soilSide: number | undefined;
        let contactSpeed = pv;
        if (traction?.collider === wheel.ground && wheel.force > 0) {
          const support = this.groundReaction ? traction.collider.body : undefined;
          const current = contactVelocity(chassis, support, wheel.point);
          const travel = dot(forward, current);
          const rimSpeed = wheel.omega * wheel.radius;
          const matches =
            traction.axleTorque < 0
              ? rimSpeed >= 0 && rimSpeed <= travel
              : rimSpeed >= travel && !(wheel.brake && this.brake > 0);
          if (travel >= 0 && matches) {
            const inverse =
              tractionInverse(chassis, wheel.point, forward) +
              (support ? tractionInverse(support, wheel.point, forward) : 0);
            const [impulse, axle] = passiveTraction(traction, wheel, travel, inverse, dt);
            soilImpulse = impulse;
            wheel.omega += axle / wheel.inertia;
            pushWheel(
              wheel,
              [forward[0] * soilImpulse, forward[1] * soilImpulse, forward[2] * soilImpulse],
              wheel.point,
            );
            contactSpeed = contactVelocity(chassis, support, wheel.point);
            if (traction.sideForce !== undefined) {
              const crossing = dot(side, contactSpeed);
              const inverseSide =
                tractionInverse(chassis, wheel.point, side) +
                (support ? tractionInverse(support, wheel.point, side) : 0);
              const gripImpulse = (wheel.groundGrip ?? Infinity) * wheel.force * dt;
              const longitudinal = Math.abs(soilImpulse);
              const available = Math.sqrt(Math.max(0, (gripImpulse - longitudinal) * (gripImpulse + longitudinal)));
              const lateral = traction.sideForce * Math.min(1, wheel.force / traction.load) * dt;
              const stop = inverseSide > 0 ? Math.abs(crossing) / inverseSide : Infinity;
              soilSide = crossing * lateral < 0 ? Math.sign(lateral) * Math.min(Math.abs(lateral), stop, available) : 0;
              pushWheel(wheel, [side[0] * soilSide, side[1] * soilSide, side[2] * soilSide], wheel.point);
              contactSpeed = contactVelocity(chassis, support, wheel.point);
            }
          }
        }
        const radius = wheel.radius,
          forwardSpeed = dot(forward, contactSpeed),
          sideSpeed = dot(side, contactSpeed),
          surface = wheel.omega * radius - forwardSpeed,
          reference = Math.max(Math.abs(forwardSpeed), 1),
          floorSpeed = Math.max(Math.abs(forwardSpeed), 0.5),
          gainForward = dt * ((radius * radius) / wheel.inertia + forwardInverse * grounded),
          gainSide = dt * sideInverse * grounded,
          rolling = Math.sign(surface) || 1,
          sliding = Math.sign(sideSpeed) || 1,
          tyre = wheel.tyre;
        const soilForce = Math.abs(soilImpulse ?? 0) / dt;
        let fx = 0,
          fy = 0;
        const slips = (f: number, g: number): [number, number] => [
          (rolling * (Math.abs(surface) - f * gainForward)) / reference,
          sliding * Math.atan2(Math.abs(sideSpeed) - g * gainSide, floorSpeed),
        ];
        for (let sweep = 0; sweep < 3; sweep++) {
          for (const which of [0, 1] as const) {
            if (which === 0 && soilImpulse !== undefined) continue;
            if (which === 1 && soilSide !== undefined) continue;
            let low = 0,
              high = which === 0 ? Math.abs(surface) / gainForward : Math.abs(sideSpeed) / gainSide;
            if (!(high > 0)) continue;
            for (let i = 0; i < 14; i++) {
              const mid = (low + high) / 2,
                [kappa, alpha] = which === 0 ? slips(mid, fy) : slips(fx, mid),
                model = tyre.forces({ slipRatio: kappa, slipAngle: alpha, load: wheel.force }),
                total =
                  wheel.groundGrip === null
                    ? 0
                    : hypot(soilImpulse === undefined ? model.longitudinal : soilForce, model.lateral),
                limit =
                  wheel.groundGrip === null ? 1 : total > 0 ? Math.min(1, (wheel.groundGrip * wheel.force) / total) : 1,
                wanted = limit * (which === 0 ? rolling * model.longitudinal : sliding * model.lateral);
              if (mid < wanted) low = mid;
              else high = mid;
            }
            if (which === 0) fx = (low + high) / 2;
            else fy = (low + high) / 2;
          }
        }
        if (wheel.groundGrip !== null) {
          const force = hypot(fx, fy);
          const available = wheel.groundGrip * wheel.force;
          if (soilImpulse !== undefined) {
            fy = Math.min(fy, Math.sqrt(Math.max(0, (available - soilForce) * (available + soilForce))));
          } else if (force > available) {
            const scale = available / force; // float division: exact combined contact limit
            fx *= scale;
            fy *= scale;
          }
        }
        [wheel.kappa, wheel.alpha] = slips(fx, fy);
        const longitudinal = rolling * fx,
          lateral = sliding * fy;
        wheel.omega -= (longitudinal * radius * dt) / wheel.inertia;
        wheel.rotation += wheel.omega * dt;
        wheel.forwardImpulse = soilImpulse ?? longitudinal * dt;
        wheel.sideImpulse = soilSide ?? -lateral * dt;
        if (soilImpulse === undefined)
          pushWheel(
            wheel,
            [forward[0] * wheel.forwardImpulse, forward[1] * wheel.forwardImpulse, forward[2] * wheel.forwardImpulse],
            wheel.point,
          );
        if (soilSide === undefined)
          pushWheel(
            wheel,
            [side[0] * wheel.sideImpulse, side[1] * wheel.sideImpulse, side[2] * wheel.sideImpulse],
            elevated,
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
      pushWheel(wheel, [forward[0] * along, forward[1] * along, forward[2] * along], wheel.point);
      pushWheel(wheel, [side[0] * across, side[1] * across, side[2] * across], elevated);
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

  /**
   * The vehicle's debug lines from its last step, in the same `{vertices, colors}` form as `physics.debugRender()` (x, y, z, two
   * vertices a segment; r, g, b, a a vertex), to draw with `@margoengine/lines` beside the world's: each suspension ray, each
   * contact point and its normal, each tyre's push and whether it slides, and each wheel. It reads, and never changes, the state.
   */
  debugRender(options: VehicleDebugOptions = {}): DebugLines {
    this.checkWheel(0);
    const { suspension = true, contacts = true, slip = true, wheels = true } = options,
      style = options.style ?? {},
      colour = (
        name: Exclude<keyof VehicleDebugStyle, 'normalLength'>,
        fallback: readonly number[],
      ): readonly number[] => style[name] ?? fallback,
      normalLength = style.normalLength ?? 0.25,
      positions: number[] = [],
      colors: number[] = [],
      segment = (a: readonly number[], b: readonly number[], c: readonly number[]): void => {
        positions.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
        colors.push(c[0]!, c[1]!, c[2]!, c[3]!, c[0]!, c[1]!, c[2]!, c[3]!);
      },
      along = (p: readonly number[], d: readonly number[], s: number): V => [
        p[0]! + d[0]! * s,
        p[1]! + d[1]! * s,
        p[2]! + d[2]! * s,
      ],
      rotation = this.chassis.rotation,
      dt = this.lastStep;
    for (const w of this.wheels) {
      const hub = along(w.hard, w.down, w.length);
      if (suspension) {
        segment(w.hard, hub, colour('suspension', [0.25, 0.8, 1, 1]));
        segment(hub, w.contact ? w.point : along(hub, w.down, w.radius), colour('airborne', [0.55, 0.55, 0.6, 1]));
      }
      if (contacts && w.contact) {
        const c = colour('contact', [1, 0.3, 0.9, 1]);
        segment(w.point, along(w.point, w.normal, normalLength), c);
      }
      if (slip && w.contact && dt > 0 && w.force > 0) {
        // The push the tyre gave, as a share of its load: one metre for a push as large as the load.
        const axleWorld = steeredAxle(w, rotation),
          rolling = cross(w.normal, axleWorld),
          size = Math.hypot(rolling[0], rolling[1], rolling[2]);
        if (size > 1e-6) {
          const forward: V = [rolling[0] / size, rolling[1] / size, rolling[2] / size],
            across = cross(forward, w.normal),
            limit = w.tyre ? 0 : Math.min(w.slip, w.groundGrip ?? Infinity) * w.force * dt,
            push = Math.hypot(w.forwardImpulse, w.sideImpulse),
            // Friction circle: the share of the grip used. Tyre model: the combined slip against 0.1, about where the Magic Formula peaks.
            used = Math.min(1, w.tyre ? Math.hypot(w.kappa, w.alpha) / 0.1 : limit > 0 ? push / limit : 1),
            grip = colour('grip', [0.3, 0.95, 0.35, 1]),
            sliding = colour('sliding', [1, 0.2, 0.15, 1]),
            c = grip.map((g, i) => g + (sliding[i]! - g) * used),
            scale = 1 / (w.force * dt);
          segment(
            w.point,
            [
              w.point[0] + (forward[0] * w.forwardImpulse + across[0] * w.sideImpulse) * scale,
              w.point[1] + (forward[1] * w.forwardImpulse + across[1] * w.sideImpulse) * scale,
              w.point[2] + (forward[2] * w.forwardImpulse + across[2] * w.sideImpulse) * scale,
            ],
            c,
          );
        }
      }
      if (wheels) {
        // A circle of the wheel's radius about the steered axle through the hub.
        const a = steeredAxle(w, rotation),
          d = w.down,
          f = cross(d, a),
          c = colour('wheel', [0.92, 0.92, 0.95, 1]),
          n = 24;
        let previous = along(hub, d, w.radius);
        for (let i = 1; i <= n; i++) {
          const t = (2 * Math.PI * i) / n,
            p: V = [
              hub[0] + (d[0] * Math.cos(t) + f[0] * Math.sin(t)) * w.radius,
              hub[1] + (d[1] * Math.cos(t) + f[1] * Math.sin(t)) * w.radius,
              hub[2] + (d[2] * Math.cos(t) + f[2] * Math.sin(t)) * w.radius,
            ];
          segment(previous, p, c);
          previous = p;
        }
      }
    }
    return { vertices: new Float32Array(positions), colors: new Float32Array(colors) };
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
      throw invalidVehicle(
        'Vehicle is disposed; create a new one with new Vehicle(physics, chassis, options).',
        'disposed',
      );
    if (!Number.isInteger(index) || index < 0 || index >= this.wheels.length)
      throw invalidVehicle(`Wheel index must be an integer from 0 to ${this.wheels.length - 1}`);
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
