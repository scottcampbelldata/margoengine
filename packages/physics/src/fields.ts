// Fields that act on the rigid bodies of a world: an explosion (one radial impulse) and a wind (a drag every step). Each is sampled
// per body, at the body's centre, so it costs a query and a loop over the bodies it reaches.
import type { PhysicsBody } from './body.js';
import { checkVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment, QueryFilter } from './physics.js';

/** Options of {@link explosion}. */
export interface ExplosionOptions {
  /** Impulse in newton seconds at the centre of the blast (a body is pushed by this, scaled by the falloff). */
  impulse: number;
  /** Reach in metres: nothing further than this is touched. */
  radius: number;
  /** How the push falls off with distance: `'linear'` to nothing at the radius (default), `'inverse-square'` (a body at the radius gets a quarter of the impulse at half of it) or `'none'`. */
  falloff?: 'linear' | 'inverse-square' | 'none';
  /** Added to the push as a share of its size, upward along y, so debris flies up (default 0). */
  lift?: number;
  /** Only the bodies these queries let through. */
  filter?: QueryFilter;
}

/**
 * An explosion: every dynamic body within `radius` of `center` gets an impulse away from the centre, scaled by the falloff and
 * applied at its centre of mass (it is thrown, not spun). Returns the bodies that were pushed.
 * @throws RangeError for an impulse or radius that is not a positive finite number.
 */
export function explosion(physics: Physics, center: Vec3, options: ExplosionOptions): PhysicsBody[] {
  checkVec(center, 'Explosion centre');
  const { impulse, radius, falloff = 'linear', lift = 0, filter } = options;
  if (!(impulse > 0 && Number.isFinite(impulse)))
    throw new RangeError('Explosion impulse is a positive number of newton seconds; pass options.impulse above 0.');
  if (!(radius > 0 && Number.isFinite(radius)))
    throw new RangeError('Explosion radius is a positive number of metres; pass options.radius above 0.');
  if (!['linear', 'inverse-square', 'none'].includes(falloff))
    throw new RangeError("Explosion falloff is 'linear', 'inverse-square' or 'none'; pass one of them.");
  const pushed: PhysicsBody[] = [];
  for (const body of physics.intersectAabb(
    [center[0] - radius, center[1] - radius, center[2] - radius],
    [center[0] + radius, center[1] + radius, center[2] + radius],
    filter,
  )) {
    if (body.type !== 'dynamic') continue;
    const [x, y, z] = body.position,
      d: Vec3 = [x - center[0], y - center[1], z - center[2]],
      distance = Math.hypot(d[0], d[1], d[2]);
    if (distance > radius) continue;
    const share =
      falloff === 'none' ? 1 : falloff === 'linear' ? 1 - distance / radius : 1 / (1 + (2 * distance) / radius) ** 2;
    const unit: Vec3 = distance > 1e-9 ? [d[0] / distance, d[1] / distance, d[2] / distance] : [0, 1, 0],
      size = impulse * share;
    body.applyImpulse([unit[0] * size, unit[1] * size + lift * size, unit[2] * size]);
    pushed.push(body);
  }
  return pushed;
}

/** Options of {@link WindField}. */
export interface WindOptions {
  /** The air's velocity in m/s, a vector, or a function of the point and the time in seconds (for gusts and swirls). */
  velocity: Vec3 | ((point: Vec3, time: number) => Vec3);
  /** Air density in kg/m3 (default 1.2). */
  density?: number;
  /** Drag coefficient (default 1). */
  drag?: number;
  /** Only bodies whose centre is in the box from `min` to `max` feel it (default the whole world). */
  region?: { min: Vec3; max: Vec3 };
  /** Only the bodies these queries let through. */
  filter?: QueryFilter;
}

/**
 * A wind: every step each dynamic body in the field feels the drag of the air moving past it, F = 1/2 rho Cd A |u| u for the air's
 * velocity relative to the body u, with A the area the body presents, taken from the box of its colliders (the faces of the box
 * the wind meets, in proportion to how square they face it). Sleeping bodies are woken only by a wind strong enough to move them.
 */
export class WindField implements PhysicsAttachment {
  private time = 0;
  private released = false;
  constructor(
    private readonly physics: Physics,
    private readonly options: WindOptions,
  ) {
    const { density = 1.2, drag = 1, velocity } = options;
    if (!(density > 0 && Number.isFinite(density)))
      throw new RangeError('Air density is a positive number of kg/m3; pass options.density above 0.');
    if (!(drag >= 0 && Number.isFinite(drag)))
      throw new RangeError('Drag coefficient is 0 or more; pass options.drag of 0 or above.');
    if (typeof velocity !== 'function') checkVec(velocity, 'Wind velocity');
    physics.attach(this);
  }

  /** @internal */
  beforeStep(dt: number): void {
    if (this.released) return;
    const { density = 1.2, drag = 1, velocity, region, filter } = this.options,
      min: Vec3 = region?.min ?? [-1e9, -1e9, -1e9],
      max: Vec3 = region?.max ?? [1e9, 1e9, 1e9];
    for (const body of this.physics.intersectAabb(min, max, filter)) {
      if (body.type !== 'dynamic') continue;
      const p = body.position,
        air = typeof velocity === 'function' ? velocity([p[0], p[1], p[2]], this.time) : velocity,
        v = body.linearVelocity,
        u: Vec3 = [air[0] - v[0], air[1] - v[1], air[2] - v[2]],
        speed = Math.hypot(u[0], u[1], u[2]);
      if (!(speed > 1e-6)) continue;
      // The area the box of the body's colliders shows to the stream.
      let lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      for (const collider of body.colliders) {
        if (collider.isSensor()) continue;
        const box = collider.aabb();
        lo = lo.map((x, k) => Math.min(x, box.min[k]!));
        hi = hi.map((x, k) => Math.max(x, box.max[k]!));
      }
      if (!Number.isFinite(lo[0]!)) continue;
      const size = hi.map((x, k) => x - lo[k]!),
        area =
          (Math.abs(u[0]) * size[1]! * size[2]! +
            Math.abs(u[1]) * size[0]! * size[2]! +
            Math.abs(u[2]) * size[0]! * size[1]!) /
          speed,
        force = 0.5 * density * drag * area * speed;
      // A sleeping body is woken only by a wind that would push it a tenth of a metre a second squared.
      if (body.sleeping && !(force * speed >= 0.1 * body.mass)) continue;
      body.applyImpulse([u[0] * force * dt, u[1] * force * dt, u[2] * force * dt]);
    }
    this.time += dt;
  }

  /** Stops the wind. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }
}
