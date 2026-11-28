// Fields that act on the rigid bodies of a world: an explosion (one radial impulse) and a wind force (a drag every step). Each
// is sampled per body, at the body's centre, so it costs a query and a loop over the bodies it reaches. Both run inside a
// step, so they use no host Math: lengths by the pinned hypot and the standard atmosphere by the pinned exp and pow, the same
// bits on every engine (tests/step-path.test.js holds this file to it).
import { standardDensity } from '@margoengine/math/atmosphere';
import { hypot } from '@margoengine/math/pinned';
import type { FlowCell, FlowField, FlowSample } from '@margoengine/math/fields';
import { colliderSurface, type Surface } from './aero.js';
import type { WindTractionPhase, WindTractionPhaseOptions, WindTractionWorkCounts } from './aero/traction-phase.js';
import type { PhysicsBody } from './body.js';
import { type AirHold, type AirLoad, airHoldOf } from './air-hold.js';
import { implicitWrench, type Wrench } from './held.js';
import { MargoError } from '@margoengine/math/errors';
import { rotateVec, type Vec3 } from './math.js';
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
 * @throws MargoError (code `unsupported`, linking margoengine.com/errors#physics-fields) for an impulse or radius that is
 * not a positive finite number, an unknown falloff or a centre that is not three finite numbers.
 */
export function explosion(physics: Physics, center: Vec3, options: ExplosionOptions): PhysicsBody[] {
  fieldVec(center, 'Explosion centre');
  const { impulse, radius, falloff = 'linear', lift = 0, filter } = options;
  if (!(impulse > 0 && Number.isFinite(impulse)))
    throw fieldInput('Explosion impulse is a positive number of newton seconds; pass options.impulse above 0.');
  if (!(radius > 0 && Number.isFinite(radius)))
    throw fieldInput('Explosion radius is a positive number of metres; pass options.radius above 0.');
  if (!['linear', 'inverse-square', 'none'].includes(falloff))
    throw fieldInput("Explosion falloff is 'linear', 'inverse-square' or 'none'; pass one of them.");
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

/** Origin used by the rigid-body positions handed to a WindForce. */
export interface WindForceFrame {
  /** Current signed origin cell. A getter can follow a PhysicsWorld's rigid solver. */
  readonly cell: FlowCell;
  /** Side length of a world cell, in metres. */
  readonly cellSize: number;
}

/** Options of {@link WindForce}. */
export interface WindOptions {
  /**
   * The air: its velocity in m/s as a vector, a function of the point and the time in seconds (for gusts and swirls), or a
   * flow field of `@margoengine/math/fields` (a `Wind`, such as the atmosphere's). Each panel samples at the world's
   * time and can use the field's local density. Use `frame` if the field and body coordinates have different origins.
   */
  velocity: Vec3 | ((point: Vec3, time: number) => Vec3) | FlowField;
  /** Rigid position origin. Defaults to cell [0, 0, 0] for a flow field in the same cell. */
  frame?: WindForceFrame;
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
 * Loads each dynamic body's collider panels from the relative air velocity at their positions and the world step's time.
 * The normal pressure and skin friction contribute force and torque about the centre of mass. The held RigidSolver load
 * accounts for the change in linear and angular velocity through the step.
 */
export class WindForce implements PhysicsAttachment, AirLoad {
  private native?: WindTractionPhase;
  private released = false;
  private readonly hold: AirHold;
  private readonly sample: FlowSample = {
    velocity: [0, 0, 0],
    density: 0,
    temperature: 0,
  };
  constructor(
    private readonly physics: Physics,
    private readonly options: WindOptions,
  ) {
    if (!options || typeof options !== 'object')
      throw fieldInput('WindForce needs options. Pass a velocity vector, callback or flow field.');
    const { density, drag = 1.17, friction = 0.004, velocity, frame } = options;
    if (frame !== undefined && (!frame || !(frame.cellSize > 0 && Number.isFinite(frame.cellSize))))
      throw fieldInput("The wind frame needs a positive finite cell size in metres. Use the rigid world's cellSize.");
    if (frame) checkedCell(frame.cell, 'Rigid frame');
    if (density !== undefined && !(density > 0 && Number.isFinite(density)))
      throw fieldInput('Air density is a positive number of kg/m3; pass options.density above 0.');
    if (!(drag >= 0 && Number.isFinite(drag)))
      throw fieldInput('Drag coefficient is 0 or more; pass options.drag of 0 or above.');
    if (!(friction >= 0 && Number.isFinite(friction)))
      throw fieldInput('Friction coefficient is 0 or more; pass options.friction of 0 or above.');
    if (isFlow(velocity)) windShift(velocity, frame);
    else if (typeof velocity !== 'function') fieldVec(velocity, 'Wind velocity');
    this.hold = airHoldOf(physics);
    this.hold.loads.add(this);
    physics.attach(this);
  }

  /** Creates a wind load with lazy Wasm SIMD traction. Set threads to 1, 2 or 4. Default 1. */
  static async create(physics: Physics, options: WindOptions, native?: WindTractionPhaseOptions): Promise<WindForce> {
    const { WindTractionPhase } = await import('./aero/traction-phase.js');
    const phase = await WindTractionPhase.load(native);
    try {
      const wind = new WindForce(physics, options);
      wind.native = phase;
      return wind;
    } catch (cause) {
      phase.dispose();
      throw cause;
    }
  }

  /** Traction work performed since this native load was created. Scalar loads return undefined. */
  workCounts(): WindTractionWorkCounts | undefined {
    return this.native?.workCounts();
  }

  /** @internal Stepped alone, the Physics's step computes the load; in a world, an `AirSolver` does. */
  beforeStep(dt: number): void {
    if (!this.hold.driven) this.load(dt);
  }

  /** @internal This step's load on every body the wind reaches, held for the step. */
  load(dt: number): void {
    if (this.released) return;
    const {
        drag: normalCoefficient = 1.17,
        friction: frictionCoefficient = 0.004,
        velocity,
        frame,
        region,
        filter,
      } = this.options,
      min: Vec3 = region?.min ?? [-1e9, -1e9, -1e9],
      max: Vec3 = region?.max ?? [1e9, 1e9, 1e9],
      time = this.hold.now(),
      flow = isFlow(velocity) ? velocity : undefined,
      shift = flow ? windShift(flow, frame) : null;
    const loads: { body: PhysicsBody; force: Vec3; torque: Vec3 }[] = [];
    for (const body of this.physics.intersectAabb(min, max, filter)) {
      if (body.type !== 'dynamic') continue;
      const p = body.position;
      let air: Vec3, density: number;
      if (flow && shift) {
        const s = sampleWind(flow, this.sample, p[0], p[1], p[2], time, shift);
        air = s.velocity;
        density = this.options.density ?? s.density;
      } else {
        air = typeof velocity === 'function' ? velocity([p[0], p[1], p[2]], time) : (velocity as Vec3);
        const elevation = frame ? p[1] + frame.cell[1] * frame.cellSize : p[1];
        density = this.options.density ?? standardDensity(elevation);
      }
      fieldVec(air, 'Body wind velocity');
      windDensity(density, "The wind at a body's centre");
      const surface = this.surfaceOf(body);
      if (!surface?.areas.length) continue;
      const { centres, normals, areas } = surface,
        q = body.rotation,
        pos = body.position,
        com = body.worldCenterOfMass,
        v0 = body.linearVelocity,
        w0 = body.angularVelocity,
        count = areas.length,
        // Each panel's arm from the centre of mass, outward normal and the air at it, once a step.
        arms = new Float64Array(3 * count),
        outward = new Float64Array(3 * count),
        winds = new Float64Array(3 * count),
        rhos = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const local = rotateVec(q, [centres[3 * i]!, centres[3 * i + 1]!, centres[3 * i + 2]!]),
          n = rotateVec(q, [normals[3 * i]!, normals[3 * i + 1]!, normals[3 * i + 2]!]),
          px = pos[0] + local[0],
          py = pos[1] + local[1],
          pz = pos[2] + local[2];
        arms.set([px - com[0], py - com[1], pz - com[2]], 3 * i);
        outward.set(n, 3 * i);
        // The air at the panel and its density: the body's own sample for a constant wind.
        let ax = air[0],
          ay = air[1],
          az = air[2],
          rho = density;
        if (flow && shift) {
          const s = sampleWind(flow, this.sample, px, py, pz, time, shift);
          fieldVec(s.velocity, 'Panel wind velocity');
          ax = s.velocity[0];
          ay = s.velocity[1];
          az = s.velocity[2];
          rho = this.options.density ?? s.density;
        } else if (typeof velocity === 'function') {
          const at = (velocity as (point: Vec3, time: number) => Vec3)([px, py, pz], time);
          fieldVec(at, 'Panel wind velocity');
          ax = at[0];
          ay = at[1];
          az = at[2];
        }
        winds.set([ax, ay, az], 3 * i);
        rhos[i] = windDensity(rho, 'Wind at a collider panel');
      }
      // The load with the body's velocity and spin changed by dv and dw.
      const scalar: Wrench = (dv, dw) => {
        const v: Vec3 = [v0[0] + dv[0], v0[1] + dv[1], v0[2] + dv[2]],
          w: Vec3 = [w0[0] + dw[0], w0[1] + dw[1], w0[2] + dw[2]];
        let fx = 0,
          fy = 0,
          fz = 0,
          tx = 0,
          ty = 0,
          tz = 0;
        for (let i = 0; i < count; i++) {
          const rx = arms[3 * i]!,
            ry = arms[3 * i + 1]!,
            rz = arms[3 * i + 2]!,
            n0 = outward[3 * i]!,
            n1 = outward[3 * i + 1]!,
            n2 = outward[3 * i + 2]!,
            // The air relative to the panel, which moves with the body: v + omega x r.
            wx = winds[3 * i]! - (v[0] + w[1] * rz - w[2] * ry),
            wy = winds[3 * i + 1]! - (v[1] + w[2] * rx - w[0] * rz),
            wz = winds[3 * i + 2]! - (v[2] + w[0] * ry - w[1] * rx),
            speed = hypot(wx, wy, wz);
          if (!(speed > 1e-9)) continue;
          const dn = n0 * wx + n1 * wy + n2 * wz,
            tanx = wx - dn * n0,
            tany = wy - dn * n1,
            tanz = wz - dn * n2,
            tangential = hypot(tanx, tany, tanz),
            half = 0.5 * rhos[i]! * areas[i]!,
            // Windward: the flat-plate normal force C_N90 sin(a) q A along -n, sin(a) = -dn / |w|.
            normal = dn < 0 ? half * normalCoefficient * speed * dn : 0,
            friction = half * frictionCoefficient * tangential,
            f0 = normal * n0 + friction * tanx,
            f1 = normal * n1 + friction * tany,
            f2 = normal * n2 + friction * tanz;
          fx += f0;
          fy += f1;
          fz += f2;
          tx += ry * f2 - rz * f1;
          ty += rz * f0 - rx * f2;
          tz += rx * f1 - ry * f0;
        }
        return checkedWrench([
          [fx, fy, fz],
          [tx, ty, tz],
        ]);
      };
      const native = this.native;
      native?.prepare({
        arms,
        normals: outward,
        winds,
        densities: rhos,
        areas,
        normalCoefficient,
        frictionCoefficient,
      });
      // A sleeping body is woken only by a wind that would push it a tenth of a metre a second squared.
      if (body.sleeping) {
        const [f] = (native?.evaluate(v0, w0, false) ?? scalar)([0, 0, 0], [0, 0, 0]);
        if (!(hypot(f[0], f[1], f[2]) >= 0.1 * body.mass)) continue;
      }
      const wrench = native?.evaluate(v0, w0, dt > 0) ?? scalar;
      const [force, torque] = checkedWrench(implicitWrench(body, wrench, dt, this.physics.gravity));
      loads.push({ body, force, torque });
    }
    for (const { body, force, torque } of loads) this.hold.hold(body, force, torque);
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    this.surfaces.delete(body);
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
        const s = colliderSurface(c, this.physics.kernel),
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
      surface = {
        centres: join((p) => p.centres),
        normals: join((p) => p.normals),
        areas: join((p) => p.areas),
      };
    this.surfaces.set(body, { key, surface });
    return surface;
  }

  /** Stops the wind. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.hold.loads.delete(this);
    this.native?.dispose();
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
    this.hold.loads.delete(this);
    this.native?.dispose();
  }

  [Symbol.dispose](): void {
    this.remove();
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

function checkedCell(cell: FlowCell, label: string): FlowCell {
  if (
    !cell ||
    cell.length !== 3 ||
    !Number.isSafeInteger(cell[0]) ||
    !Number.isSafeInteger(cell[1]) ||
    !Number.isSafeInteger(cell[2])
  )
    throw fieldInput(`${label} requires three signed integer cell coordinates; pass the cell of the active solver.`);
  return cell;
}

function windShift(flow: FlowField, frame?: WindForceFrame): Vec3 {
  const windCell = checkedCell(flow.cell, 'Wind flow');
  if (!frame) {
    if (windCell[0] !== 0 || windCell[1] !== 0 || windCell[2] !== 0)
      throw fieldInput(
        "A wind force without a frame requires that the flow cell is [0, 0, 0]; pass options.frame with the rigid solver's cell and cell size.",
      );
    return [0, 0, 0];
  }
  const rigidCell = checkedCell(frame.cell, 'Rigid frame');
  const { cellSize } = frame;
  const shift: Vec3 = [
    (rigidCell[0] - windCell[0]) * cellSize,
    (rigidCell[1] - windCell[1]) * cellSize,
    (rigidCell[2] - windCell[2]) * cellSize,
  ];
  fieldVec(shift, 'Wind origin conversion; keep origin and wind cells within numeric range');
  return shift;
}

function sampleWind(
  flow: FlowField,
  sample: FlowSample,
  x: number,
  y: number,
  z: number,
  time: number,
  shift: Vec3,
): FlowSample {
  const sx = x + shift[0];
  const sy = y + shift[1];
  const sz = z + shift[2];
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz))
    throw fieldInput('A wind panel position exceeds numeric range. Use local metres or move the wind origin nearer.');
  const value = flow.sample(sx, sy, sz, time, sample);
  if (!value || typeof value !== 'object')
    throw fieldInput(
      'Wind sampler returned no flow sample. Return velocity, density and temperature at the sampled point.',
    );
  return value;
}

function windDensity(value: number, label: string): number {
  if (!(value > 0 && Number.isFinite(value)))
    throw fieldInput(`${label} has a density of ${value}; supply finite kg/m3 above 0 or set options.density.`);
  return value;
}

// The rigid solver holds loads in float32: a load is in its range when it stays finite stored as one. The store rounds as
// `Math.fround` does, without `Math` on the step path (tests/step-path.test.js).
const single = new Float32Array(1);
function inSingleRange(value: number): boolean {
  single[0] = value;
  return Number.isFinite(single[0]);
}

function checkedWrench(result: ReturnType<Wrench>): ReturnType<Wrench> {
  if (result.some((vector) => vector.some((value) => !inSingleRange(value))))
    throw fieldInput(
      "A wind force or torque exceeds the rigid solver's numeric range. Reduce wind speed, density or collider scale.",
    );
  return result;
}

/** The inverse-square falloff at a share `s` of the radius: 1 / (1 + 2 s)^2. */
function inverseSquare(s: number): number {
  const d = 1 + 2 * s;
  return 1 / (d * d);
}

const HELP = ' See https://margoengine.com/errors#physics-fields';
/** A field input that cannot be used: code `unsupported`, the message naming it and its fix, with the fields' help link. */
function fieldInput(message: string): MargoError {
  return new MargoError('unsupported', message + HELP);
}
function fieldVec(value: unknown, label: string): asserts value is Vec3 {
  const v = value as ArrayLike<number> | undefined;
  if (
    !(Array.isArray(v) || ArrayBuffer.isView(v)) ||
    v.length !== 3 ||
    !Number.isFinite(v[0]) ||
    !Number.isFinite(v[1]) ||
    !Number.isFinite(v[2])
  )
    throw fieldInput(`${label} must be [x, y, z], three finite numbers.`);
}
function fieldPositive(value: unknown, label: string): number {
  if (!(typeof value === 'number' && value > 0 && Number.isFinite(value)))
    throw fieldInput(`${label} must be a finite number above 0.`);
  return value;
}
function fieldShare(value: number, label: string): number {
  if (!(value >= 0 && Number.isFinite(value)))
    throw fieldInput(`${label} is a share of strength, 0 or more; pass a finite number of 0 or above.`);
  return value;
}
type Out = [number, number, number];
type Falloff = 'linear' | 'inverse-square' | 'none';
function fieldFalloff(falloff: unknown, label: string): Falloff {
  if (falloff !== 'linear' && falloff !== 'inverse-square' && falloff !== 'none')
    throw fieldInput(`${label} falloff is 'linear', 'inverse-square' or 'none'; pass one of them.`);
  return falloff;
}
/** The share of a field's strength at `s` of its reach (0 at the centre or axis, 1 at the edge). */
function falloffShare(falloff: Falloff, s: number): number {
  return falloff === 'none' ? 1 : falloff === 'linear' ? 1 - s : inverseSquare(s);
}

/** What every continuous field takes: where it is and which bodies feel it. */
export interface FieldOptions {
  /** The centre of a gravity field, or the centre of the base of an updraft's or vortex's upright cylinder. */
  center: Vec3;
  /** Reach in metres: a sphere's radius for a gravity field, the cylinder's for an updraft or vortex. */
  radius: number;
  /**
   * How the strength falls off from the centre (a sphere) or the axis (a cylinder) out to the radius, as an explosion's:
   * `'linear'` (default), `'inverse-square'` or `'none'`.
   */
  falloff?: 'linear' | 'inverse-square' | 'none';
  /** Only the bodies these queries let through (default all). */
  filter?: QueryFilter;
}
/** Options of {@link GravityField}. */
export interface GravityFieldOptions extends FieldOptions {
  /** Acceleration toward the centre in m/s², scaled by the falloff: every mass falls alike, as under gravity. */
  acceleration: number;
}
/** Options of {@link Updraft}. */
export interface UpdraftOptions extends FieldOptions {
  /** Height of the cylinder above `center`, metres. */
  height: number;
  /** Force in newtons on a body on the axis, scaled by the falloff: a light body rises faster than a heavy one. */
  strength: number;
  /** `'perpendicular'` pushes straight up the axis (default); `'center'` pushes away from the centre of the base, a fountain. */
  mode?: 'perpendicular' | 'center';
}
/** Options of {@link Vortex}. */
export interface VortexOptions extends FieldOptions {
  /** Height of the cylinder above `center`, metres. */
  height: number;
  /** Force in newtons around the axis, counter-clockwise seen from above (+y), scaled by the falloff. */
  strength: number;
  /** The pull toward the axis as a share of `strength` (default 0.3), which keeps bodies circling instead of flung out. */
  centripetal?: number;
  /** The push up the axis as a share of `strength` (default 0.1), which lifts the debris as it circles. */
  lift?: number;
}

/**
 * The shared step of the continuous fields: each fixed step, every dynamic body whose centre of mass is inside the field
 * gets the field's force for that step, as an impulse of force times the step at its centre of mass (it is pushed, not
 * spun, and wakes). A field holds no state of its own, so a snapshot and restore of the world replays it bit for bit.
 */
abstract class ForceField implements PhysicsAttachment {
  /** False to stop pushing for now, true to start again (default true). */
  enabled = true;
  private released = false;
  protected readonly center: Vec3;
  protected readonly radius: number;
  protected readonly falloff: Falloff;
  private readonly filter?: QueryFilter;
  constructor(
    protected readonly physics: Physics,
    options: FieldOptions,
    label: string,
  ) {
    fieldVec(options?.center, `${label} center`);
    this.center = [options.center[0], options.center[1], options.center[2]];
    this.radius = fieldPositive(options.radius, `${label} radius`);
    this.falloff = fieldFalloff(options.falloff ?? 'linear', label);
    this.filter = options.filter;
  }
  /** How far the field reaches above its centre, for the box of bodies it looks at. */
  protected abstract readonly top: number;
  /** Writes the force on a body whose centre of mass is at `p` into `out`, or returns false when it is outside the field. */
  protected abstract forceAt(p: Vec3, mass: number, out: Out): boolean;
  /** @internal */
  beforeStep(dt: number): void {
    if (this.released || !this.enabled) return;
    const [x, y, z] = this.center,
      r = this.radius,
      out: Out = [0, 0, 0];
    for (const body of this.physics.intersectAabb([x - r, y - r, z - r], [x + r, y + this.top, z + r], this.filter)) {
      if (body.type !== 'dynamic' || !this.forceAt(body.worldCenterOfMass, body.mass, out)) continue;
      body.applyImpulse([out[0] * dt, out[1] * dt, out[2] * dt]);
    }
  }
  /** Takes the field out of the world; it pushes nothing after this. `using` calls it. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.physics.detach(this);
  }
  /** @internal */
  dispose(): void {
    this.released = true;
  }
  [Symbol.dispose](): void {
    this.remove();
  }
}

/**
 * A gravity field: every dynamic body within `radius` of `center` is pulled toward it at
 * `acceleration` m/s², scaled by the falloff with distance, every step until removed. With `physics.gravity = [0, 0, 0]`
 * it is a small planet of your own.
 * @throws MargoError (code `unsupported`, linking margoengine.com/errors#physics-fields) for a centre, radius, acceleration
 * or falloff it cannot use.
 */
export class GravityField extends ForceField {
  protected readonly top: number;
  private readonly acceleration: number;
  constructor(physics: Physics, options: GravityFieldOptions) {
    super(physics, options, 'Gravity field');
    this.top = this.radius;
    this.acceleration = fieldPositive(options.acceleration, 'Gravity field acceleration');
    physics.attach(this);
  }
  protected forceAt(p: Vec3, mass: number, out: Out): boolean {
    const dx = this.center[0] - p[0],
      dy = this.center[1] - p[1],
      dz = this.center[2] - p[2],
      d = hypot(dx, dy, dz);
    if (d > this.radius || !(d > 1e-9)) return false;
    const size = (mass * this.acceleration * falloffShare(this.falloff, d / this.radius)) / d;
    out[0] = dx * size;
    out[1] = dy * size;
    out[2] = dz * size;
    return true;
  }
}

/**
 * An updraft: every dynamic body inside the upright cylinder of `radius` and `height` standing on
 * `center` is pushed up with `strength` newtons, scaled by the falloff with distance from the axis, every step until
 * removed. `mode: 'center'` pushes away from the centre of the base instead, so bodies spread as they rise.
 * @throws MargoError (code `unsupported`, linking margoengine.com/errors#physics-fields) for an input it cannot use.
 */
export class Updraft extends ForceField {
  protected readonly top: number;
  private readonly strength: number;
  private readonly mode: 'perpendicular' | 'center';
  constructor(physics: Physics, options: UpdraftOptions) {
    super(physics, options, 'Updraft');
    this.top = fieldPositive(options.height, 'Updraft height');
    this.strength = fieldPositive(options.strength, 'Updraft strength');
    const mode = options.mode ?? 'perpendicular';
    if (mode !== 'perpendicular' && mode !== 'center')
      throw fieldInput("Updraft mode is 'perpendicular' or 'center'; pass one of them.");
    this.mode = mode;
    physics.attach(this);
  }
  protected forceAt(p: Vec3, _mass: number, out: Out): boolean {
    const dx = p[0] - this.center[0],
      dy = p[1] - this.center[1],
      dz = p[2] - this.center[2],
      d = hypot(dx, 0, dz);
    if (d > this.radius || dy < 0 || dy > this.top) return false;
    const size = this.strength * falloffShare(this.falloff, d / this.radius),
      length = this.mode === 'center' ? hypot(dx, dy, dz) : 0;
    if (length > 1e-9) {
      out[0] = (dx / length) * size;
      out[1] = (dy / length) * size;
      out[2] = (dz / length) * size;
    } else {
      out[0] = 0;
      out[1] = size;
      out[2] = 0;
    }
    return true;
  }
}

/**
 * A vortex: every dynamic body inside the upright cylinder of `radius` and `height` standing on
 * `center` is pushed around the axis with `strength` newtons, counter-clockwise seen from above, pulled toward the axis by
 * `centripetal` times that and lifted by `lift` times that, all scaled by the falloff with distance from the axis, every
 * step until removed: a whirlwind or a whirlpool.
 * @throws MargoError (code `unsupported`, linking margoengine.com/errors#physics-fields) for an input it cannot use.
 */
export class Vortex extends ForceField {
  protected readonly top: number;
  private readonly strength: number;
  private readonly centripetal: number;
  private readonly lift: number;
  constructor(physics: Physics, options: VortexOptions) {
    super(physics, options, 'Vortex');
    this.top = fieldPositive(options.height, 'Vortex height');
    this.strength = fieldPositive(options.strength, 'Vortex strength');
    this.centripetal = fieldShare(options.centripetal ?? 0.3, 'Vortex centripetal');
    this.lift = fieldShare(options.lift ?? 0.1, 'Vortex lift');
    physics.attach(this);
  }
  protected forceAt(p: Vec3, _mass: number, out: Out): boolean {
    const dx = p[0] - this.center[0],
      dy = p[1] - this.center[1],
      dz = p[2] - this.center[2],
      d = hypot(dx, 0, dz);
    if (d > this.radius || dy < 0 || dy > this.top || !(d > 1e-9)) return false;
    const size = this.strength * falloffShare(this.falloff, d / this.radius),
      ux = dx / d,
      uz = dz / d;
    // Counter-clockwise about +y seen from above: up x outward = (uz, 0, -ux); the pull is along -outward.
    out[0] = (uz - this.centripetal * ux) * size;
    out[1] = this.lift * size;
    out[2] = (-ux - this.centripetal * uz) * size;
    return true;
  }
}
