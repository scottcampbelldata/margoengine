/// <reference lib="esnext.disposable" preserve="true" />
// A tracked vehicle on a dynamic chassis: two (or more) tracks, each a row of road wheels on springs that find the ground with a ray, and a
// belt that drives the ground under it at a speed of its own. The ground pushes back along the belt by how fast the belt slips against it,
// with the shear of Wong, "Theory of Ground Vehicles", 4th ed., Wiley 2008, chapter 3: the shear stress rises with the slip as
// `1 - exp(-slip / K)` up to the friction the load allows, and a track is held harder against sliding sideways than along its belt (the
// lateral and longitudinal coefficients of Wong's skid steering), so a vehicle turns by driving its tracks at different speeds and the
// ground resists the turn as it does a real tank's.
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsBody } from './body.js';
import type { PhysicsCollider } from './collider.js';
import { checkVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';

/** One track of a {@link TrackedVehicle}. Positions and directions are in the chassis body's frame. */
export interface TrackOptions {
  /** The middle of the track where its suspension is mounted, chassis-local; its side of the chassis sets which way a steer turns it. */
  position: Vec3;
  /** The contact length of the track along the chassis's forward axis, in metres. */
  length: number;
  /** Road wheels (contact points) along the length, 2 or more (default 5). */
  roadWheels?: number;
  /** Width of the belt in metres; used for nothing but the contact normals' spread (default 0.4). */
  width?: number;
  /** Suspension length at rest in metres (default 0.3). */
  suspensionRestLength?: number;
  /** Spring stiffness of each road wheel's suspension, as a frequency squared per unit mass like `Vehicle`'s (default 30). */
  suspensionStiffness?: number;
  /** Damping while the suspension compresses (default 4). */
  suspensionCompression?: number;
  /** Damping while it extends (default 5). */
  suspensionRelaxation?: number;
  /** Strongest suspension force of each road wheel, newtons (default 20000). */
  maxSuspensionForce?: number;
}

/** Options of `new TrackedVehicle(physics, chassis, options)`. */
export interface TrackedVehicleOptions {
  /** The tracks, at least one. */
  tracks: readonly TrackOptions[];
  /** The belt speed at full throttle, m/s (default 8). */
  maxSpeed?: number;
  /** How fast a belt speed may change, m/s squared (default 10). */
  trackAcceleration?: number;
  /** Friction of the belt along itself (default 0.9) and sideways (default 0.5 times that, the skid-steer resistance of Wong). */
  longitudinalFriction?: number;
  lateralFriction?: number;
  /** The slip speed at which the shear has risen to 63 percent of its friction, m/s (default 0.2): Wong's shear parameter. */
  shearSlip?: number;
  /** The direction the chassis faces, in its own frame (default [0, 0, 1]). */
  forward?: Vec3;
  /** Packed interaction groups of the road wheels' rays (default all). */
  groups?: number;
  /** Return false to make the tracks ignore a collider (the chassis's own are always ignored). */
  predicate?: (collider: PhysicsCollider) => boolean;
}

type V = [number, number, number];
type Q = [number, number, number, number];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const rotate = (q: readonly number[], v: readonly number[]): V => {
  const [x, y, z, w] = q as Q,
    tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
};
const clamp = (v: number, low: number, high: number): number => Math.min(high, Math.max(low, v));

interface Track {
  mount: V;
  length: number;
  count: number;
  rest: number;
  stiffness: number;
  compression: number;
  relaxation: number;
  maxForce: number;
  side: number;
  /** The speed the belt is asked to go and the speed it has, m/s. */
  target: number;
  speed: number;
  /** Per road wheel: the suspension length it had. */
  lengths: number[];
  loads: number[];
  contacts: boolean[];
}

/**
 * A tracked vehicle: `setInput({throttle, steer})` drives the belts at `maxSpeed` times throttle, the side the steer turns toward slower,
 * so a steer with no throttle spins the vehicle on the spot. Each track's road wheels cast rays down, the springs hold the chassis up and the
 * belt pushes the ground by its slip. It steps with the world.
 */
export class TrackedVehicle implements PhysicsAttachment {
  /** Belt speed at full throttle, m/s. */
  maxSpeed: number;
  private readonly tracks: Track[] = [];
  private readonly facing: V;
  private readonly accel: number;
  private readonly muX: number;
  private readonly muY: number;
  private readonly shear: number;
  private disposed = false;

  constructor(
    private readonly physics: Physics,
    readonly chassis: PhysicsBody,
    private readonly options: TrackedVehicleOptions,
  ) {
    if (!physics?.owns?.(chassis))
      throw new MargoError('state', 'Chassis must belong to this physics world; add it with physics.addBody first.');
    if (chassis.type !== 'dynamic') throw new TypeError('A tracked vehicle chassis must be a dynamic body.');
    if (!chassis.colliders.length) throw new TypeError('A tracked vehicle chassis needs a collider to have mass.');
    if (!Array.isArray(options?.tracks) || !options.tracks.length)
      throw new RangeError('A tracked vehicle needs at least one track: {tracks: [{position: [-1, 0, 0], length: 3}]}');
    this.maxSpeed = options.maxSpeed ?? 8;
    this.accel = options.trackAcceleration ?? 10;
    this.muX = options.longitudinalFriction ?? 0.9;
    this.muY = options.lateralFriction ?? 0.45;
    this.shear = options.shearSlip ?? 0.2;
    for (const [value, name] of [
      [this.maxSpeed, 'maxSpeed'],
      [this.accel, 'trackAcceleration'],
      [this.muX, 'longitudinalFriction'],
      [this.muY, 'lateralFriction'],
      [this.shear, 'shearSlip'],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw new RangeError(`Tracked vehicle ${name} must be a finite number above 0.`);
    const f = options.forward ?? [0, 0, 1];
    checkVec(f, 'Tracked vehicle forward');
    const size = Math.hypot(f[0], f[1], f[2]);
    if (!size) throw new RangeError('Tracked vehicle forward must be nonzero.');
    this.facing = [f[0] / size, f[1] / size, f[2] / size];
    for (const track of options.tracks) {
      checkVec(track?.position, 'Track position');
      if (!(track.length > 0 && Number.isFinite(track.length)))
        throw new RangeError('A track length must be a finite number above 0 metres.');
      const count = track.roadWheels ?? 5;
      if (!Number.isInteger(count) || count < 2 || count > 64) throw new RangeError('A track has 2 to 64 road wheels.');
      const rest = track.suspensionRestLength ?? 0.3;
      if (!(rest > 0)) throw new RangeError('A track suspensionRestLength must be above 0 metres.');
      this.tracks.push({
        mount: [track.position[0], track.position[1], track.position[2]],
        length: track.length,
        count,
        rest,
        stiffness: track.suspensionStiffness ?? 30,
        compression: track.suspensionCompression ?? 4,
        relaxation: track.suspensionRelaxation ?? 5,
        maxForce: track.maxSuspensionForce ?? 20000,
        side: Math.sign(dot(track.position, cross([0, 1, 0], this.facing))) || 0,
        target: 0,
        speed: 0,
        lengths: new Array<number>(count).fill(rest),
        loads: new Array<number>(count).fill(0),
        contacts: new Array<boolean>(count).fill(false),
      });
    }
    physics.attach(this);
  }

  /** The number of tracks. */
  get trackCount(): number {
    return this.tracks.length;
  }
  /** False after `dispose()` or once the chassis body is removed. */
  get valid(): boolean {
    return !this.disposed;
  }
  /** Forward speed of the chassis in metres a second along its forward axis. */
  get speed(): number {
    const v = this.chassis.linearVelocity,
      f = rotate(this.chassis.rotation, this.facing);
    return v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
  }
  /**
   * Drives the belts: `throttle` from -1 to 1 sets their speed, `steer` from -1 to 1 takes speed off the side it turns toward and adds it to
   * the other (positive turns toward +X for a chassis facing +Z), so full steer with no throttle drives the two belts against each other.
   */
  setInput(input: { throttle?: number; steer?: number }): this {
    const throttle = clamp(input.throttle ?? 0, -1, 1),
      steer = clamp(input.steer ?? 0, -1, 1);
    if (!Number.isFinite(throttle) || !Number.isFinite(steer))
      throw new RangeError('Tracked vehicle throttle and steer must be finite numbers.');
    // The track on the side the vehicle turns toward is the slower; `side` is the track's sign along forward cross up.
    for (const track of this.tracks) track.target = this.maxSpeed * clamp(throttle - steer * track.side, -1, 1);
    return this;
  }
  /** The belt speed of track `index` now, m/s, and what it was asked for. */
  track(index: number): { speed: number; target: number; inContact: number; load: number } {
    if (!Number.isInteger(index) || index < 0 || index >= this.tracks.length)
      throw new RangeError(`Track index must be an integer from 0 to ${this.tracks.length - 1}`);
    const t = this.tracks[index]!;
    return {
      speed: t.speed,
      target: t.target,
      inContact: t.contacts.filter(Boolean).length,
      load: t.loads.reduce((a, b) => a + b, 0),
    };
  }

  /** @internal Casts the road wheels, holds the chassis up on the springs and pushes the ground with the belts. */
  beforeStep(dt: number): void {
    if (this.disposed || !this.chassis.valid) return;
    const chassis = this.chassis;
    if (chassis.sleeping) {
      if (this.tracks.every((t) => t.target === 0)) return;
      chassis.wakeUp();
    }
    const position = chassis.position,
      rotation = chassis.rotation,
      velocity = chassis.linearVelocity,
      angular = chassis.angularVelocity,
      mass = chassis.mass,
      centre = chassis.centerOfMass,
      centreWorld = rotate(rotation, centre).map((c, i) => c + position[i]!) as V,
      forwardWorld = rotate(rotation, this.facing),
      up = rotate(rotation, [0, 1, 0]),
      wheelTotal = this.tracks.reduce((sum, t) => sum + t.count, 0),
      predicate =
        this.options.predicate &&
        ((_body: PhysicsBody, collider: PhysicsCollider): boolean => this.options.predicate!(collider));
    const pointVelocity = (r: V): V => {
      const w = cross(angular, r);
      return [velocity[0] + w[0], velocity[1] + w[1], velocity[2] + w[2]];
    };
    for (const track of this.tracks) {
      // The belt speeds up or down by its acceleration at the most.
      track.speed += clamp(track.target - track.speed, -this.accel * dt, this.accel * dt);
      for (let k = 0; k < track.count; k++) {
        const along = (k / (track.count - 1) - 0.5) * track.length,
          local: V = [
            track.mount[0] + this.facing[0] * along,
            track.mount[1] + this.facing[1] * along,
            track.mount[2] + this.facing[2] * along,
          ],
          origin = rotate(rotation, local).map((c, i) => c + position[i]!) as V,
          hit = this.physics.raycast(origin, [-up[0], -up[1], -up[2]], {
            maxDistance: track.rest,
            exclude: chassis,
            excludeSensors: true,
            groups: this.options.groups,
            predicate,
          });
        track.contacts[k] = !!hit;
        if (!hit) {
          track.lengths[k] = track.rest;
          track.loads[k] = 0;
          continue;
        }
        const length = Math.min(track.rest, Math.max(0, hit.distance)),
          normal = hit.normal,
          r: V = [hit.point[0] - centreWorld[0], hit.point[1] - centreWorld[1], hit.point[2] - centreWorld[2]],
          pv = pointVelocity(r),
          cosine = dot(normal, up);
        track.lengths[k] = length;
        // The spring along the normal, with the damping on the closing speed, scaled so the ride height is that of a four-wheeler whatever the road wheels.
        const relative = cosine > 0.1 ? dot(normal, pv) / cosine : 0;
        let force = (track.stiffness * (track.rest - length)) / (cosine > 0.1 ? cosine : 10);
        force -= (relative < 0 ? track.compression : track.relaxation) * relative;
        force = clamp((force * 4 * mass) / wheelTotal, 0, track.maxForce);
        track.loads[k] = force;
        chassis.applyImpulse(
          [normal[0] * force * dt, normal[1] * force * dt, normal[2] * force * dt],
          hit.point,
          false,
        );
        // The belt against the ground: the ground's velocity under the belt along forward and sideways on the contact plane.
        let forward = [
          forwardWorld[0] - normal[0] * dot(forwardWorld, normal),
          forwardWorld[1] - normal[1] * dot(forwardWorld, normal),
          forwardWorld[2] - normal[2] * dot(forwardWorld, normal),
        ] as V;
        const size = Math.hypot(forward[0], forward[1], forward[2]);
        if (size < 1e-6) continue;
        forward = [forward[0] / size, forward[1] / size, forward[2] / size];
        const side = cross(forward, normal),
          slideAlong = track.speed - dot(forward, pv),
          slideAcross = -dot(side, pv),
          slip = Math.hypot(slideAlong, slideAcross);
        if (slip === 0) continue;
        // Wong's shear: the share of the friction the slip has mobilised, along the slip's direction, the friction larger along the belt.
        const share = 1 - Math.exp(-slip / this.shear),
          fx = this.muX * force * share * (slideAlong / slip),
          fy = this.muY * force * share * (slideAcross / slip);
        chassis.applyImpulse(
          [
            forward[0] * fx * dt + side[0] * fy * dt,
            forward[1] * fx * dt + side[1] * fy * dt,
            forward[2] * fx * dt + side[2] * fy * dt,
          ],
          hit.point,
          false,
        );
      }
    }
  }

  /** @internal Disposes the vehicle when its chassis goes. */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.chassis) this.dispose();
  }

  /** Detaches the vehicle from the world. The chassis stays. */
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
