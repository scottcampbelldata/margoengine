// Fields that act on the rigid bodies of a world: an explosion (one radial impulse) and a wind force (a drag every step). Each
// is sampled per body, at the body's centre, so it costs a query and a loop over the bodies it reaches. Both run inside a
// step, so they use no host Math: lengths by the pinned hypot and the standard atmosphere by the pinned exp and pow, the same
// bits on every engine (tests/step-path.test.js holds this file to it).
import { standardDensity } from '@margoengine/math/atmosphere';
import { hypot } from '@margoengine/math/pinned';
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { colliderSurface, type Surface } from './aero.js';
import type { PhysicsBody } from './body.js';
import { checkVec, rotateVec, type Vec3 } from './math.js';
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
      distance = hypot(d[0], d[1], d[2]);
    if (distance > radius) continue;
    const share =
      falloff === 'none' ? 1 : falloff === 'linear' ? 1 - distance / radius : inverseSquare(distance / radius);
    const unit: Vec3 = distance > 1e-9 ? [d[0] / distance, d[1] / distance, d[2] / distance] : [0, 1, 0],
      size = impulse * share;
    body.applyImpulse([unit[0] * size, unit[1] * size + lift * size, unit[2] * size]);
    pushed.push(body);
  }
  return pushed;
}

/** Options of {@link WindForce}. */
export interface WindOptions {
  /**
   * The air: its velocity in m/s as a vector, a function of the point and the time in seconds (for gusts and swirls), or a
   * flow field of `@margoengine/math/fields` (a `Wind`, such as the atmosphere's), sampled at each body's centre on the
   * world's clock, whose density it also takes. A flow field's coordinates must be in the world's frame (cell [0, 0, 0]).
   */
  velocity: Vec3 | ((point: Vec3, time: number) => Vec3) | FlowField;
  /**
   * Air density in kg/m3 (default the flow field's at each body, or the standard atmosphere's at the body's height, y metres
   * above sea level: 1.225 at 0, ISO 2533).
   */
  density?: number;
  /**
   * The normal-force coefficient of a surface square to the air, C_N90 (default 1.17, a square flat plate): each windward
   * panel of a body's colliders takes C_N90 sin(a) times the dynamic pressure times its area, a the angle the air meets it.
   */
  drag?: number;
  /** Skin-friction coefficient along the surface (default 0.004, a turbulent plate). */
  friction?: number;
  /** Only bodies whose centre is in the box from `min` to `max` feel it (default the whole world). */
  region?: { min: Vec3; max: Vec3 };
  /** Only the bodies these queries let through. */
  filter?: QueryFilter;
}

/**
 * A wind force: every step each dynamic body in the field feels the drag of the air moving past it, F = 1/2 rho Cd A |u| u
 * for the air's velocity relative to the body u, with A the area the body presents, taken from the box of its colliders (the
 * faces of the box the wind meets, in proportion to how square they face it). The air is sampled at the body's centre at the
 * world's time (its steps times the fixed step), so a wind shared with the rest of a scene is felt where and when the rest
 * feels it. Sleeping bodies are woken only by a wind strong enough to move them.
 */
export class WindForce implements PhysicsAttachment {
  private released = false;
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  constructor(
    private readonly physics: Physics,
    private readonly options: WindOptions,
  ) {
    const { density, drag = 1.17, friction = 0.004, velocity } = options;
    if (density !== undefined && !(density > 0 && Number.isFinite(density)))
      throw new RangeError('Air density is a positive number of kg/m3; pass options.density above 0.');
    if (!(drag >= 0 && Number.isFinite(drag)))
      throw new RangeError('Drag coefficient is 0 or more; pass options.drag of 0 or above.');
    if (!(friction >= 0 && Number.isFinite(friction)))
      throw new RangeError('Friction coefficient is 0 or more; pass options.friction of 0 or above.');
    if (isFlow(velocity)) {
      const c = velocity.cell;
      if (!c || c[0] !== 0 || c[1] !== 0 || c[2] !== 0)
        throw new RangeError(
          "A wind force samples its flow field in the physics world's frame; pass a field whose cell is [0, 0, 0].",
        );
    } else if (typeof velocity !== 'function') checkVec(velocity, 'Wind velocity');
    physics.attach(this);
  }

  /** @internal */
  beforeStep(dt: number): void {
    if (this.released) return;
    const {
        drag: normalCoefficient = 1.17,
        friction: frictionCoefficient = 0.004,
        velocity,
        region,
        filter,
      } = this.options,
      min: Vec3 = region?.min ?? [-1e9, -1e9, -1e9],
      max: Vec3 = region?.max ?? [1e9, 1e9, 1e9],
      time = this.physics.stepCount * this.physics.fixedTimestep,
      flow = isFlow(velocity) ? velocity : undefined;
    for (const body of this.physics.intersectAabb(min, max, filter)) {
      if (body.type !== 'dynamic') continue;
      const p = body.position;
      let air: Vec3, density: number;
      if (flow) {
        const s = flow.sample(p[0], p[1], p[2], time, this.sample);
        air = s.velocity;
        density = this.options.density ?? s.density;
        if (!(density > 0 && Number.isFinite(density)))
          throw new RangeError(
            `The wind's flow field gave a density of ${density} at (${p[0]}, ${p[1]}, ${p[2]}); a flow field's density is kg/m3 above 0.`,
          );
      } else {
        air =
          typeof velocity === 'function'
            ? (velocity as (point: Vec3, time: number) => Vec3)([p[0], p[1], p[2]], time)
            : (velocity as Vec3);
        density = this.options.density ?? standardDensity(p[1]);
      }
      const surface = this.surfaceOf(body);
      if (!surface) continue;
      const { centres, normals, areas } = surface,
        q = body.rotation,
        pos = body.position,
        com = body.worldCenterOfMass,
        v = body.linearVelocity,
        w = body.angularVelocity;
      let fx = 0,
        fy = 0,
        fz = 0,
        tx = 0,
        ty = 0,
        tz = 0;
      for (let i = 0; i < areas.length; i++) {
        const local = rotateVec(q, [centres[3 * i]!, centres[3 * i + 1]!, centres[3 * i + 2]!]),
          n = rotateVec(q, [normals[3 * i]!, normals[3 * i + 1]!, normals[3 * i + 2]!]),
          px = pos[0] + local[0],
          py = pos[1] + local[1],
          pz = pos[2] + local[2],
          rx = px - com[0],
          ry = py - com[1],
          rz = pz - com[2];
        // The air at the panel and its density: the body's own sample for a constant or functional wind.
        let ax = air[0],
          ay = air[1],
          az = air[2],
          rho = density;
        if (flow && areas.length > 0) {
          const s = flow.sample(px, py, pz, time, this.sample);
          ax = s.velocity[0];
          ay = s.velocity[1];
          az = s.velocity[2];
          rho = this.options.density ?? s.density;
        } else if (typeof velocity === 'function') {
          const at = (velocity as (point: Vec3, time: number) => Vec3)([px, py, pz], time);
          ax = at[0];
          ay = at[1];
          az = at[2];
        }
        // The air relative to the panel, which moves with the body: v + omega x r.
        const wx = ax - (v[0] + w[1] * rz - w[2] * ry),
          wy = ay - (v[1] + w[2] * rx - w[0] * rz),
          wz = az - (v[2] + w[0] * ry - w[1] * rx),
          speed = hypot(wx, wy, wz);
        if (!(speed > 1e-9)) continue;
        const dn = n[0] * wx + n[1] * wy + n[2] * wz,
          tanx = wx - dn * n[0],
          tany = wy - dn * n[1],
          tanz = wz - dn * n[2],
          tangential = hypot(tanx, tany, tanz),
          half = 0.5 * rho * areas[i]!,
          // Windward: the flat-plate normal force C_N90 sin(a) q A along -n, sin(a) = -dn / |w|.
          normal = dn < 0 ? half * normalCoefficient * speed * dn : 0,
          friction = half * frictionCoefficient * tangential,
          f0 = normal * n[0] + friction * tanx,
          f1 = normal * n[1] + friction * tany,
          f2 = normal * n[2] + friction * tanz;
        fx += f0;
        fy += f1;
        fz += f2;
        tx += ry * f2 - rz * f1;
        ty += rz * f0 - rx * f2;
        tz += rx * f1 - ry * f0;
      }
      // A sleeping body is woken only by a wind that would push it a tenth of a metre a second squared.
      if (body.sleeping && !(hypot(fx, fy, fz) >= 0.1 * body.mass)) continue;
      body.applyImpulse([fx * dt, fy * dt, fz * dt]);
      body.applyTorqueImpulse([tx * dt, ty * dt, tz * dt]);
    }
  }

  /** Each body's surface as panels in its frame, made again when its colliders change. */
  private readonly surfaces = new Map<PhysicsBody, { key: string; surface: Surface }>();

  private surfaceOf(body: PhysicsBody): Surface | undefined {
    const colliders = body.colliders.filter((c) => !c.isSensor()),
      key = colliders
        .map((c) => {
          const t = c.translationWrtParent(),
            r = c.rotationWrtParent();
          return `${c.handle}:${c.shape}:${c.shape === 'box' ? JSON.stringify(c.halfExtents()) : ''}:${c.shape === 'sphere' || c.shape === 'capsule' || c.shape === 'cylinder' || c.shape === 'cone' ? `${c.radius()},${c.halfHeight()}` : ''}:${t.x},${t.y},${t.z}:${r.x},${r.y},${r.z},${r.w}`;
        })
        .join('|');
    if (!colliders.length) return undefined;
    const cached = this.surfaces.get(body);
    if (cached?.key === key) return cached.surface;
    const parts = colliders.map((c) => {
        const s = colliderSurface(c),
          t = c.translationWrtParent(),
          r = c.rotationWrtParent(),
          q = [r.x, r.y, r.z, r.w],
          centres = new Float64Array(s.centres.length),
          normals = new Float64Array(s.normals.length);
        for (let i = 0; i < s.areas.length; i++) {
          const p = rotateVec(q, [s.centres[3 * i]!, s.centres[3 * i + 1]!, s.centres[3 * i + 2]!]),
            n = rotateVec(q, [s.normals[3 * i]!, s.normals[3 * i + 1]!, s.normals[3 * i + 2]!]);
          centres.set([p[0] + t.x, p[1] + t.y, p[2] + t.z], 3 * i);
          normals.set(n, 3 * i);
        }
        return { centres, normals, areas: s.areas };
      }),
      join = (pick: (p: Surface) => Float64Array) => {
        const out = new Float64Array(parts.reduce((n, p) => n + pick(p).length, 0));
        let at = 0;
        for (const p of parts) {
          out.set(pick(p), at);
          at += pick(p).length;
        }
        return out;
      },
      surface = { centres: join((p) => p.centres), normals: join((p) => p.normals), areas: join((p) => p.areas) };
    this.surfaces.set(body, { key, surface });
    return surface;
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

/**
 * The wind force under its old name.
 * @deprecated Use {@link WindForce}. Renamed so it no longer clashes with `@margoengine/weather`'s `WindField`, the wind
 * itself, which a `WindForce` takes as its `velocity`.
 */
export const WindField = WindForce;
/** @deprecated Use {@link WindForce}. */
export type WindField = WindForce;

function isFlow(velocity: WindOptions['velocity']): velocity is FlowField {
  return typeof velocity === 'object' && velocity !== null && typeof (velocity as FlowField).sample === 'function';
}

/** The inverse-square falloff at a share `s` of the radius: 1 / (1 + 2 s)^2. */
function inverseSquare(s: number): number {
  const d = 1 + 2 * s;
  return 1 / (d * d);
}
