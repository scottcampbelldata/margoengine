/// <reference lib="esnext.disposable" preserve="true" />
// A ray cast vehicle in 2D, Rapier's `DynamicRayCastVehicleController` seen from the side (a hill-climb car, a cart, a
// truck on a ramp): each wheel casts a ray from its mount along its suspension, a spring and damper on the suspension
// holds the chassis up, and the tyre drives, brakes and grips along the ground inside what its load can hold. The model is
// the 3D `Vehicle`'s of `@margoengine/physics` with the axle out of the plane, so there is no steering and no side grip.
import type { Body2D, Collider2D } from './body.js';
import type { Physics2D } from './physics.js';
import type { Vec2D } from './shapes.js';

/** One wheel of a {@link Vehicle2D}. Positions and directions are in the chassis body's frame, in world units. */
export interface WheelOptions2D {
  /** Where the suspension is mounted on the chassis (the top of its travel). */
  position: Vec2D;
  /** Wheel radius, world units. */
  radius: number;
  /** Direction the suspension extends (default [0, 1], down on screen). */
  direction?: Vec2D;
  /** Suspension length at rest, world units (default 0.3 m). */
  suspensionRestLength?: number;
  /** Spring stiffness of the suspension, per second squared of the chassis's mass (default 5.88, as Rapier's). */
  suspensionStiffness?: number;
  /** Damping while the suspension compresses (default 0.83). */
  suspensionCompression?: number;
  /** Damping while the suspension extends (default 0.88). */
  suspensionRelaxation?: number;
  /** Longest suspension travel, world units (default 5 m). */
  maxSuspensionTravel?: number;
  /** Strongest suspension force, newtons (default 6000). */
  maxSuspensionForce?: number;
  /** Tyre grip along the ground (default 10.5); lower slides more. */
  frictionSlip?: number;
  /** This wheel receives the engine force (default true). */
  drive?: boolean;
  /** This wheel receives the brake (default true). */
  brake?: boolean;
}

/** Options of `new Vehicle2D(physics, chassis, options)`. Every field but `wheels` has a default. */
export interface VehicleOptions2D {
  /** The wheels, at least one. */
  wheels: readonly WheelOptions2D[];
  /** The way the chassis faces, in its own frame (default [1, 0]): forward speed and drive are along it. */
  forward?: Vec2D;
  /** Engine force per driven wheel at full throttle, newtons (default the chassis mass in kg times 2, so two driven wheels give 0.4 g). */
  maxEngineForce?: number;
  /** Brake force per braking wheel at full brake, newtons (default 6 times the chassis mass). */
  maxBrakeForce?: number;
  /** Packed interaction groups of the wheel rays (default all). */
  groups?: number;
  /** Return false to make the wheels ignore a collider (the chassis's own are always ignored). */
  predicate?: (collider: Collider2D) => boolean;
  /** Apply each wheel's push back on a dynamic body it stands on, and drive relative to it (default true). */
  groundReaction?: boolean;
}

/** Driver input for {@link Vehicle2D.setInput}, each axis normalized. */
export interface VehicleInput2D {
  /** -1 (full reverse) to 1 (full throttle). */
  throttle?: number;
  /** 0 (off) to 1 (full brake). */
  brake?: number;
}

/** The state of one wheel after the last step. Lengths and points are in world units. */
export interface WheelState2D {
  /** The wheel touches the ground. */
  inContact: boolean;
  /** Current suspension length. */
  suspensionLength: number;
  /** Suspension force, newtons. */
  suspensionForce: number;
  /** Spin angle, radians, clockwise on screen as the wheel rolls forward. */
  rotation: number;
  /** Contact point, or null in the air. */
  contactPoint: [number, number] | null;
  /** Contact normal, or null in the air. */
  contactNormal: [number, number] | null;
  /** The collider the wheel stands on, or null in the air. */
  ground: Collider2D | null;
  /** Where the suspension is mounted, in world space. */
  hardPoint: [number, number];
  /** What the tyre pushed the chassis with along the ground in the last step (drive and brake), newton seconds. */
  forwardImpulse: number;
}

interface Wheel {
  readonly position: [number, number];
  readonly direction: [number, number];
  readonly radius: number;
  readonly rest: number;
  readonly travel: number;
  readonly stiffness: number;
  readonly compression: number;
  readonly relaxation: number;
  readonly maxForce: number;
  readonly slip: number;
  readonly drive: boolean;
  readonly brake: boolean;
  contact: boolean;
  length: number;
  force: number;
  rotation: number;
  point: [number, number];
  normal: [number, number];
  ground: Collider2D | null;
  hard: [number, number];
  forwardImpulse: number;
}

const unit = (v: Vec2D, label: string): [number, number] => {
  const length = Math.hypot(v[0], v[1]);
  if (!(length > 0) || !Number.isFinite(length))
    throw new RangeError(`Vehicle2D ${label} must be a finite vector that is not zero; got [${v[0]}, ${v[1]}].`);
  return [v[0] / length, v[1] / length];
};
const amount = (value: number | undefined, fallback: number, label: string, positive = false): number => {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < 0 || (positive && v === 0))
    throw new RangeError(
      `Vehicle2D ${label} must be a finite number ${positive ? 'above' : 'of'} 0${positive ? '' : ' or more'}; got ${v}.`,
    );
  return v;
};

/**
 * A ray cast vehicle in 2D (Rapier's `DynamicRayCastVehicleController`, seen from the side). Steps itself before every
 * fixed step of its world; `engineForce` and `brake` (or `setInput`) drive it. Its pushes are held on the chassis (and on a
 * dynamic body under a wheel) as forces for the step, beside the body's own: `resetForces` on the chassis clears them until
 * the next step. `dispose()` (or `using`) detaches it and takes them back.
 */
export class Vehicle2D {
  /** Engine force on each driven wheel this step, newtons; negative drives backward. */
  engineForce = 0;
  /** Brake force on each braking wheel this step, newtons. */
  brake = 0;
  private readonly wheels: Wheel[];
  private readonly forward: [number, number];
  private readonly maxEngine: number;
  private readonly maxBrake: number;
  private readonly groups: number | undefined;
  private readonly predicate: ((collider: Collider2D) => boolean) | undefined;
  private readonly groundReaction: boolean;
  private readonly detach: () => void;
  private disposed = false;
  /** The force (newtons) and torque (newton metres) this vehicle holds on each body for the step, so the next step changes only its own share. */
  private held = new Map<Body2D, { force: [number, number]; torque: number }>();

  /** @throws RangeError for no wheels or a wheel setting that is not finite or below 0. */
  constructor(
    private readonly physics: Physics2D,
    readonly chassis: Body2D,
    options: VehicleOptions2D,
  ) {
    if (!options?.wheels?.length)
      throw new RangeError('A Vehicle2D needs at least one wheel; pass wheels: [{ position, radius }].');
    const metre = 1 / physics.scale;
    this.wheels = options.wheels.map((w, i) => {
      const at = `wheel ${i}`;
      if (!Number.isFinite(w.position?.[0]) || !Number.isFinite(w.position?.[1]))
        throw new RangeError(`Vehicle2D ${at} position must be two finite numbers; got ${w.position}.`);
      return {
        position: [w.position[0], w.position[1]],
        direction: unit(w.direction ?? [0, 1], `${at} direction`),
        radius: amount(w.radius, NaN, `${at} radius`, true),
        rest: amount(w.suspensionRestLength, 0.3 * metre, `${at} suspensionRestLength`),
        travel: amount(w.maxSuspensionTravel, 5 * metre, `${at} maxSuspensionTravel`),
        stiffness: amount(w.suspensionStiffness, 5.88, `${at} suspensionStiffness`),
        compression: amount(w.suspensionCompression, 0.83, `${at} suspensionCompression`),
        relaxation: amount(w.suspensionRelaxation, 0.88, `${at} suspensionRelaxation`),
        maxForce: amount(w.maxSuspensionForce, 6000, `${at} maxSuspensionForce`),
        slip: amount(w.frictionSlip, 10.5, `${at} frictionSlip`),
        drive: w.drive ?? true,
        brake: w.brake ?? true,
        contact: false,
        length: 0,
        force: 0,
        rotation: 0,
        point: [0, 0],
        normal: [0, 0],
        ground: null,
        hard: [0, 0],
        forwardImpulse: 0,
      };
    });
    for (const w of this.wheels) w.length = w.rest;
    this.forward = unit(options.forward ?? [1, 0], 'forward');
    this.maxEngine = amount(options.maxEngineForce, 2 * chassis.mass, 'maxEngineForce');
    this.maxBrake = amount(options.maxBrakeForce, 6 * chassis.mass, 'maxBrakeForce');
    this.groups = options.groups;
    this.predicate = options.predicate;
    this.groundReaction = options.groundReaction ?? true;
    this.detach = physics.on('beforestep', (dt) => this.update(dt));
  }

  /** Sets `engineForce` and `brake` from normalized input. @returns this vehicle. */
  setInput(input: VehicleInput2D): this {
    const throttle = Math.max(-1, Math.min(1, input.throttle ?? 0)),
      brake = Math.max(0, Math.min(1, input.brake ?? 0));
    this.engineForce = throttle * this.maxEngine;
    this.brake = brake * this.maxBrake;
    return this;
  }

  /** The chassis's speed along the way it faces, world units a second (Rapier's `currentVehicleSpeed`). */
  get speed(): number {
    const v = this.chassis.linearVelocity,
      f = this.facing();
    return v[0] * f[0] + v[1] * f[1];
  }

  /** How many wheels the vehicle has. */
  get wheelCount(): number {
    return this.wheels.length;
  }

  /** The state of wheel `index` after the last step. @throws RangeError for an index out of range. */
  wheel(index: number): WheelState2D {
    const w = this.wheels[index];
    if (!w) throw new RangeError(`Vehicle2D has wheels 0 to ${this.wheels.length - 1}; got ${index}.`);
    return {
      inContact: w.contact,
      suspensionLength: w.length,
      suspensionForce: w.force,
      rotation: w.rotation,
      contactPoint: w.contact ? [w.point[0], w.point[1]] : null,
      contactNormal: w.contact ? [w.normal[0], w.normal[1]] : null,
      ground: w.ground,
      hardPoint: [w.hard[0], w.hard[1]],
      forwardImpulse: w.forwardImpulse,
    };
  }

  /** Where wheel `index`'s centre is, in world units, from its mount down its suspension. */
  wheelCenter(index: number): [number, number] {
    const w = this.wheels[index];
    if (!w) throw new RangeError(`Vehicle2D has wheels 0 to ${this.wheels.length - 1}; got ${index}.`);
    const d = this.turn(w.direction);
    return [w.hard[0] + d[0] * w.length, w.hard[1] + d[1] * w.length];
  }

  /** Detaches the vehicle from its world; the chassis stays. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.hold(new Map());
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  private turn(v: readonly [number, number]): [number, number] {
    const a = this.chassis.rotation,
      c = Math.cos(a),
      s = Math.sin(a);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1]];
  }
  private facing(): [number, number] {
    return this.turn(this.forward);
  }

  private update(dt: number): void {
    const chassis = this.chassis;
    if (this.disposed || chassis.isRemoved) return;
    if (chassis.sleeping) {
      // A sleeping car holds nothing: it wakes when driven.
      if (this.engineForce === 0 && this.brake === 0) return this.hold(new Map());
      chassis.wakeUp();
    }
    const m = this.physics.scale,
      position = chassis.position,
      com = chassis.centerOfMass,
      v = chassis.linearVelocity,
      w = chassis.angularVelocity,
      mass = chassis.mass;
    // The velocity of a body at a world point (world units a second), and 1 / effective mass (kernel units) along a unit
    // direction there.
    const velocityAt = (body: Body2D, p: [number, number]): [number, number] => {
      const bv = body === chassis ? v : body.linearVelocity,
        bw = body === chassis ? w : body.angularVelocity,
        c = body === chassis ? com : body.centerOfMass;
      return [bv[0] - bw * (p[1] - c[1]), bv[1] + bw * (p[0] - c[0])];
    };
    const inverse = (body: Body2D | null, p: [number, number], d: [number, number]): number => {
      if (!body) return 0;
      const c = body.centerOfMass,
        r = ((p[0] - c[0]) * d[1] - (p[1] - c[1]) * d[0]) * m,
        bm = body.mass,
        bi = body.rotationLocked ? 0 : body.inertia * m * m;
      return (bm > 0 ? 1 / bm : 0) + (bi > 0 ? (r * r) / bi : 0);
    };
    const support = (wheel: Wheel): Body2D | null => {
      const body = this.groundReaction ? wheel.ground?.body : undefined;
      return body && body.type === 'dynamic' ? body : null;
    };
    const relative = (wheel: Wheel, p: [number, number]): [number, number] => {
      const own = velocityAt(chassis, p),
        other = this.groundReaction && wheel.ground ? velocityAt(wheel.ground.body, p) : [0, 0];
      return [own[0] - other[0], own[1] - other[1]];
    };
    // Each push is held as a force over the step (the impulse over dt), so it acts in every substep as gravity does and the
    // chassis's velocity does not saw-tooth inside the step; it is gathered per body as a force and a torque about the centre.
    const pushes = new Map<Body2D, { force: [number, number]; torque: number }>();
    const add = (body: Body2D, impulse: [number, number], at: [number, number]): void => {
      const f: [number, number] = [impulse[0] / dt, impulse[1] / dt],
        c = body === chassis ? com : body.centerOfMass,
        entry = pushes.get(body) ?? { force: [0, 0], torque: 0 };
      entry.force[0] += f[0];
      entry.force[1] += f[1];
      entry.torque += ((at[0] - c[0]) * f[1] - (at[1] - c[1]) * f[0]) * m;
      pushes.set(body, entry);
    };
    const push = (wheel: Wheel, impulse: [number, number], at: [number, number]): void => {
      if (impulse[0] === 0 && impulse[1] === 0) return;
      add(chassis, impulse, at);
      const other = support(wheel);
      if (other) add(other, [-impulse[0], -impulse[1]], at);
    };
    const filter = this.predicate && ((_: Body2D, collider: Collider2D) => this.predicate!(collider));
    // The springs first, every one seeing the same chassis.
    for (const wheel of this.wheels) {
      const mount = this.turn(wheel.position),
        origin: [number, number] = [position[0] + mount[0], position[1] + mount[1]],
        down = this.turn(wheel.direction);
      wheel.hard = origin;
      wheel.forwardImpulse = 0;
      const hit = this.physics.raycast(origin, down, {
        maxDistance: wheel.rest + wheel.radius,
        exclude: chassis,
        excludeSensors: true,
        groups: this.groups,
        predicate: filter,
      });
      if (!hit) {
        wheel.contact = false;
        wheel.ground = null;
        wheel.length = wheel.rest;
        wheel.force = 0;
        continue;
      }
      wheel.contact = true;
      wheel.ground = hit.collider;
      wheel.point = hit.point;
      wheel.normal = hit.normal;
      const lowest = Math.max(0, wheel.rest - wheel.travel);
      wheel.length = Math.min(wheel.rest, Math.max(lowest, hit.distance - wheel.radius));
      const cosine = -(hit.normal[0] * down[0] + hit.normal[1] * down[1]);
      let projection = 10,
        closing = 0;
      if (cosine > 0.1) {
        projection = 1 / cosine;
        const pv = relative(wheel, hit.point);
        closing = (hit.normal[0] * pv[0] + hit.normal[1] * pv[1]) * m * projection;
      }
      // Rapier's suspension: a spring on the compression and a damper on the closing speed, per kilogram of chassis.
      let force = wheel.stiffness * (wheel.rest - wheel.length) * m * projection;
      force -= (closing < 0 ? wheel.compression : wheel.relaxation) * closing;
      force = Math.min(wheel.maxForce, Math.max(0, force * mass));
      wheel.force = force;
      push(wheel, [hit.normal[0] * force * dt, hit.normal[1] * force * dt], hit.point);
    }
    // Then drive and brake along the ground, the wheels on it sharing a stop so a car at rest drives at full force.
    const grounded = this.wheels.filter((wheel) => wheel.contact).length;
    const facing = this.facing();
    for (const wheel of this.wheels) {
      if (!wheel.contact) continue;
      const n = wheel.normal;
      // The rolling direction: along the ground, the way the chassis faces.
      let along: [number, number] = [-n[1], n[0]];
      if (along[0] * facing[0] + along[1] * facing[1] < 0) along = [n[1], -n[0]];
      const pv = relative(wheel, wheel.point),
        rolling = (along[0] * pv[0] + along[1] * pv[1]) * m,
        reach = inverse(chassis, wheel.point, along) + inverse(support(wheel), wheel.point, along);
      let impulse = wheel.drive ? this.engineForce * dt : 0;
      if (wheel.brake && this.brake > 0 && reach > 0) {
        const stop = -rolling / reach / grounded,
          limit = this.brake * dt;
        impulse += Math.max(-limit, Math.min(limit, stop));
      }
      const grip = wheel.slip * wheel.force * dt;
      impulse = Math.max(-grip, Math.min(grip, impulse));
      wheel.forwardImpulse = impulse;
      push(wheel, [along[0] * impulse, along[1] * impulse], wheel.point);
      wheel.rotation += (rolling / m / wheel.radius) * dt;
    }
    this.hold(pushes);
  }

  /** Holds `next` on its bodies in place of what the vehicle held before, changing each body by the difference only. */
  private hold(next: Map<Body2D, { force: [number, number]; torque: number }>): void {
    for (const body of new Set([...this.held.keys(), ...next.keys()])) {
      if (body.isRemoved) continue;
      const was = this.held.get(body) ?? { force: [0, 0], torque: 0 },
        now = next.get(body) ?? { force: [0, 0], torque: 0 },
        df: [number, number] = [now.force[0] - was.force[0], now.force[1] - was.force[1]],
        dt = now.torque - was.torque;
      if (df[0] !== 0 || df[1] !== 0) body.applyForce(df);
      if (dt !== 0) body.applyTorque(dt);
    }
    this.held = next;
  }
}
