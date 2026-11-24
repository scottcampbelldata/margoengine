/// <reference lib="esnext.disposable" preserve="true" />
// A character that is a dynamic rigid body: it is pushed, carried and knocked about by the solver like any other body, and a
// controller keeps it upright and walking. The upright torque is a stable proportional-derivative controller, the position term
// taken at the end of the step and the velocity term implicit too, so any stiffness and any step is stable (Tan, Liu and Turk,
// "Stable Proportional-Derivative Controllers", IEEE Computer Graphics and Applications 31(4), 2011). Walking is a velocity
// controller with a limit on how fast the velocity may change, over what the ground under it does.
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsBody } from './body.js';
import { colliderPose, colliderShape } from './character.js';
import { checkVec, type Vec3 } from './math.js';
import type { Physics, ShapeCastHit } from './physics.js';

/** Options of a dynamic character; every field has a default. */
export interface DynamicCharacterOptions {
  /** Up direction in the world (default [0, 1, 0]). */
  up?: Vec3;
  /** The body's own axis that stands along `up` (default [0, 1, 0], a capsule's axis). */
  bodyUp?: Vec3;
  /** Natural frequency of the upright controller, in hertz (default 4): how quickly it rights itself. */
  uprightFrequency?: number;
  /** Damping ratio of the upright controller (default 1, no overshoot). */
  uprightDamping?: number;
  /** The most torque it may use to stay upright, in newton metres (default no limit): a limit lets a hard enough blow knock it over. */
  maxUprightTorque?: number;
  /** Steepest ground it stands and walks on, radians (default 45 degrees); steeper is a slide. */
  maxSlopeClimbAngle?: number;
  /** How far under the feet ground still counts as ground, in metres (default 0.05). */
  groundProbe?: number;
  /** The most the velocity may change on the ground, in m/s squared (default 60): its grip. Use a low-friction collider so this is the grip. */
  groundAcceleration?: number;
  /** The same in the air (default 8). */
  airAcceleration?: number;
  /** Turn rate towards the facing set with `setFacing`, hertz of the same stable controller (default 6). */
  facingFrequency?: number;
  /**
   * A hover spring: the character floats `height` metres above the ground (the gap between its shape and what is under it), held by a
   * critically damped spring that also cancels its weight, so steps lower than the hover pass under it and the ground is felt
   * through the spring, not through contact. `frequency` (default 5 Hz), `damping` ratio (default 1) and `maxForce` newtons (default no
   * limit). The ground it stands on is pushed down by the reaction. Off by default.
   */
  hover?: { height: number; frequency?: number; damping?: number; maxForce?: number };
  /**
   * Steps up what is too high for the hover (or for a plain character): when a riser of `maxHeight` or less blocks the walk and there
   * is ground at least `minDepth` deep on top (default 0.1 m), the character is lifted onto it. Off by default.
   */
  stairs?: { maxHeight: number; minDepth?: number };
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): [number, number, number] => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/**
 * The change of velocity that takes a displacement and a velocity to rest in one implicit step of a damped spring with unit mass (Tan et
 * al. 2011): v' = (v - h k x) / (1 + 2 h zeta w + h^2 k) with k = w^2.
 */
function implicit(dt: number, displacement: number, velocity: number, frequency: number, ratio: number): number {
  const k = frequency * frequency;
  return (velocity - dt * k * displacement) / (1 + dt * 2 * ratio * frequency + dt * dt * k) - velocity;
}
function rotateBy(q: readonly number[], v: Vec3): [number, number, number] {
  const [x, y, z, w] = q as [number, number, number, number],
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/**
 * A dynamic rigid body kept upright and walking by a controller. Call `update()` once per fixed step before the step (for
 * example from `physics.on('beforestep')`), after `setTargetVelocity` and `jump`.
 *
 * ```ts
 * const hero = physics.addBody(null, { colliders: { shape: 'capsule', halfHeight: 0.4, radius: 0.3, friction: 0 } });
 * const character = physics.createDynamicCharacter(hero);
 * physics.on('beforestep', () => {
 *   character.setTargetVelocity([2, 0, 0]);
 *   character.update();
 * });
 * ```
 */
export class DynamicCharacter {
  private disposed = false;
  private readonly up: [number, number, number];
  private readonly bodyUp: [number, number, number];
  private readonly frequency: number;
  private readonly damping: number;
  private readonly maxTorque: number;
  private readonly cosClimb: number;
  private readonly probe: number;
  private readonly groundAcceleration: number;
  private readonly airAcceleration: number;
  private readonly facingFrequency: number;
  private wish: [number, number, number] = [0, 0, 0];
  private facing: [number, number, number] | null = null;
  private jumpSpeed: number | null = null;
  private isGrounded = false;
  private ground: ShapeCastHit | null = null;
  private held: [number, number, number] = [0, 0, 0];
  private readonly hoverSpring: { height: number; frequency: number; damping: number; maxForce: number } | null;
  private readonly stairs: { maxHeight: number; minDepth: number } | null;
  private airborne = 0;

  /** @internal */
  constructor(
    private readonly owner: Pick<Physics, 'shapeCast' | 'fixedTimestep' | 'gravity'> & {
      removeDynamicCharacter(character: DynamicCharacter): void;
    },
    readonly body: PhysicsBody,
    options: DynamicCharacterOptions = {},
  ) {
    if (body.type !== 'dynamic') throw new TypeError('A dynamic character needs a dynamic body');
    if (!body.colliders.length) throw new TypeError('A dynamic character body needs a collider');
    const unit = (v: Vec3, name: string): [number, number, number] => {
      checkVec(v, name);
      const l = len(v);
      if (!(l > 0)) throw new RangeError(`${name} must not be the zero vector`);
      return scale(v, 1 / l);
    };
    this.up = unit(options.up ?? [0, 1, 0], 'Up');
    this.bodyUp = unit(options.bodyUp ?? [0, 1, 0], 'Body up');
    this.frequency = options.uprightFrequency ?? 4;
    this.damping = options.uprightDamping ?? 1;
    this.maxTorque = options.maxUprightTorque ?? Infinity;
    this.cosClimb = Math.cos(options.maxSlopeClimbAngle ?? Math.PI / 4);
    this.probe = options.groundProbe ?? 0.05;
    this.groundAcceleration = options.groundAcceleration ?? 60;
    this.airAcceleration = options.airAcceleration ?? 8;
    this.facingFrequency = options.facingFrequency ?? 6;
    for (const [name, value] of [
      ['uprightFrequency', this.frequency],
      ['maxUprightTorque', this.maxTorque],
      ['groundAcceleration', this.groundAcceleration],
      ['airAcceleration', this.airAcceleration],
      ['facingFrequency', this.facingFrequency],
    ] as const)
      if (!(value > 0)) throw new RangeError(`${name} must be more than zero`);
    const hover = options.hover;
    this.hoverSpring = hover
      ? {
          height: hover.height,
          frequency: hover.frequency ?? 5,
          damping: hover.damping ?? 1,
          maxForce: hover.maxForce ?? Infinity,
        }
      : null;
    if (this.hoverSpring) {
      const { height, frequency, damping, maxForce } = this.hoverSpring;
      if (!(height >= 0)) throw new RangeError('hover height must be zero or more metres');
      if (!(frequency > 0) || !(maxForce > 0))
        throw new RangeError('hover frequency and maxForce must be more than zero');
      if (!(damping >= 0)) throw new RangeError('hover damping must be zero or more');
    }
    const stairs = options.stairs;
    this.stairs = stairs ? { maxHeight: stairs.maxHeight, minDepth: stairs.minDepth ?? 0.1 } : null;
    if (this.stairs && !(this.stairs.maxHeight > 0 && this.stairs.minDepth >= 0))
      throw new RangeError('stairs maxHeight must be more than zero and minDepth zero or more');
    if (!(this.damping >= 0)) throw new RangeError('uprightDamping must be zero or more');
    if (!(this.probe >= 0)) throw new RangeError('groundProbe must be zero or more');
  }

  /** Whether the last `update` found ground it can stand on within the probe distance. */
  get grounded(): boolean {
    return this.isGrounded;
  }
  /** The body it stood on at the last `update`, or null in the air. */
  get platform(): PhysicsBody | null {
    return this.ground ? this.ground.body : null;
  }
  /** The normal of the ground under it at the last `update`, or `up` in the air. */
  get groundNormal(): [number, number, number] {
    return this.ground ? [...this.ground.normal] : [...this.up];
  }

  /**
   * The velocity it is to walk at, in the world's frame, relative to the ground under it. The part along `up` is ignored; on a
   * slope the velocity is turned to follow it. Zero to stand still.
   * @throws TypeError unless three finite numbers.
   */
  setTargetVelocity(velocity: Vec3): this {
    checkVec(velocity, 'Velocity');
    this.wish = [velocity[0], velocity[1], velocity[2]];
    return this;
  }
  /** The direction to turn to face (the part along `up` is ignored), or null to turn freely. */
  setFacing(direction: Vec3 | null): this {
    if (direction === null) this.facing = null;
    else {
      checkVec(direction, 'Facing');
      this.facing = [direction[0], direction[1], direction[2]];
    }
    return this;
  }
  /**
   * Asks for a jump at the next `update`: the velocity along `up` becomes `speed` (relative to the ground) when it is grounded.
   * `speed` = sqrt(2 g h) reaches a height `h`. Returns whether it was grounded and so will jump.
   */
  jump(speed: number): boolean {
    if (!(speed > 0)) throw new RangeError('A jump speed must be more than zero metres per second.');
    if (!this.isGrounded) return false;
    this.jumpSpeed = speed;
    return true;
  }

  /**
   * Finds the ground, steers the velocity towards the target within the grip, and applies the stable upright torque. Run it once
   * per fixed step, before the step.
   * @throws MargoError (`disposed`) on a disposed character; (`state`) when the body was removed.
   */
  update(): void {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        'Dynamic character is disposed; create a new one with physics.createDynamicCharacter.',
      );
    if (!this.body.valid) throw new MargoError('state', 'Dynamic character body was removed; create a new body.');
    const { body, up } = this,
      dt = this.owner.fixedTimestep,
      mass = body.mass;
    // Ground: the first collider's shape swept down by the probe distance.
    const collider = body.colliders[0]!,
      pose = colliderPose(body, collider),
      hit = this.owner.shapeCast(colliderShape(collider), pose.position, pose.rotation, scale(up, -1), {
        exclude: body,
        excludeSensors: true,
        maxDistance: this.hoverSpring ? this.hoverSpring.height + this.probe : this.probe,
        stopAtPenetration: true,
      });
    this.airborne = Math.max(0, this.airborne - dt);
    this.ground = hit && this.airborne === 0 && dot(hit.normal, up) >= this.cosClimb - 1e-6 ? hit : null;
    this.isGrounded = this.ground !== null;

    // Velocity: relative to what it stands on.
    const v = body.linearVelocity,
      base: [number, number, number] =
        this.ground && this.ground.body.type !== 'fixed'
          ? this.ground.body.velocityAtPoint(this.ground.point)
          : [0, 0, 0],
      rel = sub(v, base),
      flat = (a: Vec3): [number, number, number] => sub(a, scale(up, dot(a, up)));
    let change: [number, number, number] = [0, 0, 0];
    if (this.ground) {
      const n = this.ground.normal,
        wishFlat = flat(this.wish),
        // The wish turned to lie in the ground plane, keeping its horizontal part, so it climbs and descends.
        along = sub(wishFlat, scale(up, dot(wishFlat, n) / dot(up, n))),
        inPlane = sub(rel, scale(n, dot(rel, n)));
      change = this.limit(sub(along, inPlane), this.groundAcceleration * dt);
    } else if (len(this.wish) > 0) {
      change = this.limit(sub(flat(this.wish), flat(rel)), this.airAcceleration * dt);
    }
    // Standing on a slope: a force that cancels the share of gravity along the ground over the whole step, in place of a velocity that
    // gravity would wear away within it. The force it left last step is taken off first, so the body's own forces stay.
    let hold: [number, number, number] = [0, 0, 0];
    if (this.ground) {
      const n = this.ground.normal,
        g = scale(this.owner.gravity, body.gravityScale);
      // A hover spring carries the whole weight; resting on the ground only the share along it.
      hold = this.hoverSpring ? scale(g, -mass) : scale(sub(scale(n, dot(g, n)), g), mass);
    }
    const adjust = sub(hold, this.held);
    if (adjust[0] !== 0 || adjust[1] !== 0 || adjust[2] !== 0) body.addForce(adjust);
    this.held = hold;
    // The hover spring: the gap to the ground against the height asked, the implicit step of a damped spring on the velocity along up.
    if (this.hoverSpring && this.ground && hit) {
      const spring = this.hoverSpring,
        along = implicit(
          dt,
          hit.distance - spring.height,
          dot(rel, up),
          spring.frequency * 2 * Math.PI,
          spring.damping,
        ),
        wanted = along * mass,
        capped = Math.max(-spring.maxForce * dt, Math.min(spring.maxForce * dt, wanted));
      change = add(change, scale(up, capped / mass));
      if (this.ground.body.type === 'dynamic') this.ground.body.applyImpulse(scale(up, -capped), this.ground.point);
    }
    if (this.jumpSpeed !== null && this.ground) {
      change = add(change, scale(up, this.jumpSpeed - dot(rel, up)));
      this.isGrounded = false;
      this.ground = null;
      // The spring would hold it down: leave it alone for the time a jump needs to clear its reach.
      this.airborne = 0.15;
    }
    if (this.stairs && this.ground && len(flat(this.wish)) > 1e-6) this.stepUp(flat(this.wish), pose);
    this.jumpSpeed = null;
    if (change[0] !== 0 || change[1] !== 0 || change[2] !== 0) body.applyImpulse(scale(change, mass));

    // Upright, and facing: the implicit proportional-derivative step on the axes across `up` and the turn about it.
    const w = this.frequency * 2 * Math.PI,
      spin = body.angularVelocity,
      inverse = body.effectiveWorldInverseInertia,
      bu = rotateBy(body.rotation, this.bodyUp),
      axis = cross(bu, up),
      sin = len(axis),
      angle = Math.atan2(sin, dot(bu, up));
    // How far the body's axis is from `up`, as the rotation vector that would bring it there; upside down it turns about any axis across up.
    let displaced: [number, number, number] = [0, 0, 0];
    if (sin > 1e-9) displaced = scale(axis, -angle / sin);
    else if (angle > 1) displaced = scale(cross(up, Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]), -angle);
    const across = flat(spin),
      shift = len(displaced);
    let delta: [number, number, number];
    if (shift > 0) {
      const dir = scale(displaced, 1 / shift),
        along = dot(across, dir);
      delta = add(
        scale(dir, implicit(dt, shift, along, w, this.damping)),
        scale(sub(across, scale(dir, along)), implicit(dt, 0, 1, w, this.damping)),
      );
    } else delta = scale(across, implicit(dt, 0, 1, w, this.damping));
    if (this.facing) {
      const want = flat(this.facing),
        forward = flat(rotateBy(body.rotation, this.forwardAxis()));
      if (len(want) > 1e-6 && len(forward) > 1e-6) {
        const yaw = Math.atan2(dot(cross(forward, want), up), dot(forward, want));
        delta = add(delta, scale(up, implicit(dt, -yaw, dot(spin, up), this.facingFrequency * 2 * Math.PI, 1)));
      }
    }
    const dl = len(delta);
    if (dl > 0) {
      // The torque impulse that gives that change of spin: the change over the inverse inertia along it.
      const u = scale(delta, 1 / dl),
        stiff =
          inverse[0]! * u[0] * u[0] +
          (inverse[1]! + inverse[3]!) * u[0] * u[1] +
          (inverse[2]! + inverse[6]!) * u[0] * u[2] +
          inverse[4]! * u[1] * u[1] +
          (inverse[5]! + inverse[7]!) * u[1] * u[2] +
          inverse[8]! * u[2] * u[2];
      if (stiff > 0) body.applyTorqueImpulse(scale(u, Math.min(dl / stiff, this.maxTorque * dt)));
    }
  }

  /**
   * A riser that blocks the walk, of `maxHeight` or less, with ground `minDepth` deep on top: the body is put on top of it. The shape is
   * cast along the walk, up the height it may step, forward over the riser and down again.
   */
  private stepUp(
    walk: [number, number, number],
    pose: { position: [number, number, number]; rotation: [number, number, number, number] },
  ): void {
    const stairs = this.stairs!,
      { body, up } = this,
      dt = this.owner.fixedTimestep,
      way = scale(walk, 1 / len(walk)),
      reach = Math.max(len(walk) * dt * 2, 0.05),
      shape = colliderShape(body.colliders[0]!),
      cast = (from: Vec3, direction: Vec3, max: number) =>
        this.owner.shapeCast(shape, from, pose.rotation, direction, {
          exclude: body,
          excludeSensors: true,
          maxDistance: max,
          stopAtPenetration: false,
        });
    const ahead = cast(pose.position, way, reach);
    // Only a riser: a surface too steep to walk on and in the way.
    if (!ahead || dot(ahead.normal, up) >= this.cosClimb) return;
    const rise = cast(pose.position, up, stairs.maxHeight),
      height = rise ? rise.distance : stairs.maxHeight;
    if (!(height > 1e-3)) return;
    const raised = add(pose.position, scale(up, height)),
      depth = reach + stairs.minDepth,
      onto = cast(raised, way, depth);
    if (onto && onto.distance < depth - 1e-4) return;
    const over = add(raised, scale(way, depth)),
      land = cast(over, scale(up, -1), height + 1e-3);
    if (!land || dot(land.normal, up) < this.cosClimb - 1e-6) return;
    const lift = height - land.distance;
    if (lift > 1e-3) {
      body.setPosition(add(body.position, scale(up, lift)));
      // What was going into the riser is gone with it.
      const v = body.linearVelocity;
      body.setLinearVelocity(sub(v, scale(up, Math.min(0, dot(v, up)))));
    }
  }

  private forwardAxis(): [number, number, number] {
    // The body's forward is its local +z unless that is along its up axis, then +x.
    return Math.abs(this.bodyUp[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  }
  private limit(v: [number, number, number], max: number): [number, number, number] {
    const l = len(v);
    return l > max ? scale(v, max / l) : v;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.body.valid && (this.held[0] !== 0 || this.held[1] !== 0 || this.held[2] !== 0))
      this.body.addForce(scale(this.held, -1));
    this.held = [0, 0, 0];
    this.owner.removeDynamicCharacter(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
