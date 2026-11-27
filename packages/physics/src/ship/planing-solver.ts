// Planing boats as a solver of the physics framework (SEA-09): each boat's prismatic bottom is cut into strips across its
// keel, and each strip is a wedge entering the water, by E. E. Zarnick, "A nonlinear mathematical model of motions of a
// planing boat in regular waves", DTNSRDC-78/032, 1978 (eqs. 2 to 16 and Appendix A, read):
// - a strip's force normal to the keel is the rate of change of its added mass's momentum, m_a V' + m_a' V - U d(m_a V)/dxi,
//   and its cross-flow drag C_D,c rho b V^2 (C_D,c = cos beta), U and V the bottom's velocity along and into the water;
// - its added mass is a wedge's, (pi / 2) rho b^2, b its wetted half-beam (pi / 2) d cot(beta) with Wagner's pile-up, held
//   once the chine is wet; its immersed area's buoyancy acts upward;
// - the added masses' share of the strip forces is moved to the left of the heave and pitch equations, so the body is held
//   to accelerate as (M + M_a) a_n + Q_a theta'' = F, Q_a a_n + (I + I_a) theta'' = M (Zarnick eq. 14 in body axes).
// Near the transom the strips' forces and buoyancy fall to zero as K. Garme's function tanh(2.5 x / (0.34 B C_V)) (KTH
// thesis 2004 and Int. Shipbuilding Progress 52(3), 2005; the form as P. Ghadimi, S. M. Sajedi and S. Tavakoli, Scientia
// Iranica B 26(3), 2019, eqs. 21 to 24, and R. Algarin and O. Tascon, Ship Sci. Technol. 8(15), 2014, eqs. 28 to 30, print
// it, read), x forward of the transom. The bottom's friction is the ITTC-1957 line on its wetted area.
// Steady, a boat runs at its own trim and rise: G. Fridsma's prismatic models (Davidson Laboratory report 1275, 1969, Fig.
// 11, read) are what the test holds it to. Couple it before the rigid solver: `world.couple(['planing', 'rigid'],
// 'staggered')`.
//
// Surge, heave and pitch only: no side force or yaw moment of a planing hull is modelled (docs/limits.md).
import { DEFAULT_GRAVITY } from '@margoengine/math/gravity';
import { atan2, cos, exp, hypot, ln, sin } from '@margoengine/math/pinned';
import { regionWords } from '../world/memory.js';
import type { Port, RateLevel, Region, Solver, SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { shipError } from './errors.js';

type Vec3 = [number, number, number];
const LAYOUT = 1;
/** Strips along the bottom. */
const STRIPS = 40;

/** A planing boat: its body row and its prismatic bottom, laid on the body. */
export interface PlaningBoat {
  readonly row: number;
  /** Chine beam, m, and deadrise, rad. */
  readonly beam: number;
  readonly deadrise: number;
  /** The bottom's length along the keel from the transom, m. */
  readonly length: number;
  /** The keel at the transom, in the body's frame, m (default the body's origin). */
  readonly transom?: readonly [number, number, number];
  /** The body's forward (along the keel) and up axes, unit vectors in its frame (default +X and +Y). */
  readonly forward?: readonly [number, number, number];
  readonly up?: readonly [number, number, number];
  /** Where the thrust acts, in the body's frame (default the transom), and its angle up from the keel, rad (default 0). */
  readonly propeller?: readonly [number, number, number];
  readonly thrustAngle?: number;
}

/** What a {@link PlaningSolver} is made from. */
export interface PlaningParams {
  readonly boats: readonly PlaningBoat[];
  /** The still water's height along the vertical, m (default 0). */
  readonly waterLevel?: number;
  /** The water's density, kg/m^3 (default 1025), kinematic viscosity, m^2/s (default 1.19e-6), and roughness allowance Delta C_F (default 0.0004). */
  readonly density?: number;
  readonly viscosity?: number;
  readonly roughness?: number;
  /** Body rows its `bodyForces` port covers (default the world's). */
  readonly capacity?: number;
  /** Its rate level (default 0); step with the rigid solver. */
  readonly level?: RateLevel;
}

/** A boat's control: its thrust, N, along its shaft line. */
export interface PlaningControl {
  thrust: number;
}

/** What a planing boat did in the last step. */
export interface PlaningStatus {
  /** Its trim, rad (bow up), the keel's immersion at the transom, m, and its speed along its course, m/s. */
  trim: number;
  immersion: number;
  speed: number;
  /** C_v = V / sqrt(g B). */
  speedCoefficient: number;
  /** The water's force normal to its bottom, N (with buoyancy), and the bottom's friction, N. */
  normal: number;
  friction: number;
  /** The keel's and chine's wetted lengths, m, and the mean wetted length over the beam. */
  keel: number;
  chine: number;
  lambda: number;
  /** The water's drag on it along its course, N. */
  resistance: number;
  /** Whether its bottom is out of the water. */
  airborne: boolean;
}

/** Planing boats on rigid bodies, by Zarnick's strips with Garme's transom. `id` is `'planing'` by default. */
export class PlaningSolver implements Solver<PlaningParams> {
  private readonly id: string;
  private host!: SolverHost;
  private rate: RateLevel = 0;
  private capacity = 0;
  private density = 1025;
  private viscosity = 1.19e-6;
  private roughness = 0.0004;
  private g = 9.80665;
  private levelHeight = 0;
  private vertical: Vec3 = [0, 1, 0];
  private boats: readonly PlaningBoat[] = [];
  private controls: PlaningControl[] = [];
  private statuses: PlaningStatus[] = [];
  private forces!: Region;
  private cell: [number, number, number] = [0, 0, 0];
  private work = { boats: 0, strips: 0 };
  private readonly strips = {
    ma: new Float64Array(STRIPS),
    vn: new Float64Array(STRIPS),
    half: new Float64Array(STRIPS),
    rate: new Float64Array(STRIPS),
    area: new Float64Array(STRIPS),
  };

  constructor(id = 'planing') {
    this.id = id;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
      ],
      rate: this.rate,
      stableRate: () => this.rate,
    };
  }

  init(host: SolverHost, params: PlaningParams): void {
    const {
      boats,
      waterLevel = 0,
      level: rate = 0,
      density = 1025,
      viscosity = 1.19e-6,
      roughness = 0.0004,
    } = params ?? ({} as PlaningParams);
    if (!Array.isArray(boats) || boats.length === 0)
      throw shipError('Planing boats need their bodies: pass {boats: [{row, beam, deadrise, length}]}.');
    for (const b of boats) {
      if (!(Number.isInteger(b?.row) && b.row >= 0))
        throw shipError(`A planing boat's body row is a whole number, 0 or more (got ${b?.row}); pass the body's row.`);
      if (
        !(b.beam > 0 && b.length > 0 && b.deadrise > 0 && b.deadrise < Math.PI / 2) ||
        ![b.beam, b.length, b.deadrise, b.thrustAngle ?? 0].every(Number.isFinite)
      )
        throw shipError(
          `A planing boat's beam and length are finite metres above 0 and its deadrise between 0 and pi / 2 rad (got ${[b.beam, b.length, b.deadrise].join(', ')}); pass them.`,
        );
    }
    if (!Number.isFinite(waterLevel))
      throw shipError(`The water's level is finite metres (got ${waterLevel}); pass one, or 0.`);
    if (!(density > 0 && viscosity > 0 && roughness >= 0) || ![density, viscosity, roughness].every(Number.isFinite))
      throw shipError(
        `Planing water needs a density and viscosity above 0 and a roughness of 0 or more (got ${[density, viscosity, roughness].join(', ')}); pass them.`,
      );
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw shipError(`A rate level is a whole number from 0 to 7 (got ${rate}); pass one.`);
    const gv = host.gravity ?? DEFAULT_GRAVITY,
      gl = hypot(gv[0], gv[1], gv[2]);
    if (!(gl > 0))
      throw shipError(
        'A planing boat rises on its speed against its weight, and this world has no gravity; give the PhysicsWorld its gravity.',
      );
    this.host = host;
    this.rate = rate as RateLevel;
    this.density = density;
    this.viscosity = viscosity;
    this.roughness = roughness;
    this.g = gl;
    this.vertical = [-gv[0] / gl, -gv[1] / gl, -gv[2] / gl];
    this.levelHeight = waterLevel;
    this.boats = boats;
    this.controls = boats.map(() => ({ thrust: 0 }));
    this.statuses = boats.map(() => ({
      trim: 0,
      immersion: 0,
      speed: 0,
      speedCoefficient: 0,
      normal: 0,
      friction: 0,
      keel: 0,
      chine: 0,
      lambda: 0,
      resistance: 0,
      airborne: true,
    }));
    this.capacity = bodyRowsOf(
      host,
      'A PlaningSolver',
      boats.map((b) => b.row),
      params.capacity,
    );
    this.forces = host.allocate('forces', this.capacity * FORCE_WORDS * 8, 'f64', LAYOUT);
  }

  /** Boat `index`'s control: `planing.control(0).thrust = 2000`. */
  control(index: number): PlaningControl {
    const c = this.controls[index];
    if (!c) throw shipError(`There is no planing boat ${index}; pass 0 to ${this.controls.length - 1}.`);
    return c;
  }

  /** What boat `index` did in the last step. */
  status(index: number): PlaningStatus {
    const s = this.statuses[index];
    if (!s) throw shipError(`There is no planing boat ${index}; pass 0 to ${this.statuses.length - 1}.`);
    return s;
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array;
    out.fill(0);
    this.work = { boats: 0, strips: 0 };
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    const memory = port.region.memory ?? this.host.memory,
      bodies = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4);
    this.boats.forEach((boat, index) => {
      this.work.boats++;
      const at = boat.row * BODY_WORDS;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) return;
      this.boat(boat, index, bodies, at, out);
    });
  }

  /** One boat's strips, its heave and pitch with their added masses, and the forces that hold its body to them. */
  private boat(boat: PlaningBoat, index: number, bodies: Float32Array, at: number, out: Float64Array): void {
    const status = this.statuses[index]!,
      vertical = this.vertical,
      rho = this.density,
      g = this.g,
      q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
      origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
      centre: Vec3 = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!],
      velocity: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
      spin: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
      inverseMass = bodies[at + 16]!,
      up = rotate(q, boat.up ?? [0, 1, 0]),
      fwd = rotate(q, boat.forward ?? [1, 0, 0]),
      // The pitch axis: a rotation about it turns the bow up.
      side = cross(fwd, up),
      transom = add(origin, rotate(q, boat.transom ?? [0, 0, 0])),
      sinTrim = Math.max(-1, Math.min(1, dot(fwd, vertical))),
      trim = atan2(sinTrim, Math.sqrt(1 - sinTrim * sinTrim)),
      cosTrim = cos(trim),
      levelled = sub(fwd, scale(vertical, sinTrim)),
      levelLength = hypot(levelled[0], levelled[1], levelled[2]),
      course = levelLength > 1e-9 ? scale(levelled, 1 / levelLength) : fwd,
      speed = dot(velocity, course),
      // U: the bottom's speed along the keel; the pitch rate, bow up.
      along = dot(velocity, fwd),
      pitchRate = dot(spin, side),
      mass = inverseMass > 0 ? 1 / inverseMass : 0,
      B = boat.beam,
      half = B / 2,
      cosBeta = cos(boat.deadrise),
      tanBeta = sin(boat.deadrise) / cosBeta,
      cv = speed / Math.sqrt(g * B),
      // The centre of gravity forward of the transom along the keel.
      lcg = dot(sub(centre, transom), fwd);
    status.trim = trim;
    status.immersion = this.levelHeight - dot(transom, vertical);
    status.speed = speed;
    status.speedCoefficient = cv;
    status.airborne = true;
    status.normal = status.friction = status.keel = status.chine = status.lambda = status.resistance = 0;
    if (mass === 0) return;
    const { ma, vn, half: halfBeam, rate, area } = this.strips,
      dx = boat.length / STRIPS,
      // A strip's chine wets when its wetted half-beam (pi / 2) d cot(beta) reaches the chine.
      chineDepth = (2 / Math.PI) * half * tanBeta;
    let keel = 0,
      chine = 0;
    for (let i = 0; i < STRIPS; i++) {
      const point = add(transom, scale(fwd, (i + 0.5) * dx)),
        d = (this.levelHeight - dot(point, vertical)) / cosTrim;
      // V: the strip's velocity into the water, normal to the keel; and its sinking, which changes its immersion.
      const pointVelocity = add(velocity, cross(spin, sub(point, centre)));
      vn[i] = -dot(pointVelocity, up);
      const sinking = -dot(pointVelocity, vertical) / cosTrim;
      ma[i] = rate[i] = area[i] = halfBeam[i] = 0;
      if (!(d > 0)) continue;
      this.work.strips++;
      keel = (i + 1) * dx;
      const wet = d >= chineDepth,
        b = wet ? half : ((Math.PI / 2) * d) / tanBeta;
      if (wet) chine = (i + 1) * dx;
      halfBeam[i] = b;
      ma[i] = (Math.PI / 2) * rho * b * b;
      // Dry chine: m_a' = pi rho b (pi / 2) cot(beta) d', d' the strip's sinking (Zarnick's (z' - r') / cos(theta)).
      rate[i] = wet ? 0 : Math.PI * rho * b * (Math.PI / 2 / tanBeta) * sinking;
      // The immersed area across the strip without the pile-up: the wedge, then the chine's walls.
      area[i] = wet ? half * half * tanBeta + (d - half * tanBeta) * B : (d * d) / tanBeta;
    }
    status.keel = keel;
    status.chine = chine;
    status.lambda = (0.5 * (keel + chine)) / B;
    if (keel === 0) return;
    status.airborne = false;
    // The strips' forces up the normal less their added masses' accelerations, and their moment about G (bow up); the
    // integrals M_a, Q_a and I_a; all weighted by Garme's transom function.
    let lift = 0,
      moment = 0,
      Ma = 0,
      Qa = 0,
      Ia = 0,
      buoyancy = 0,
      buoyancyMoment = 0,
      wetted = 0;
    for (let i = 0; i < STRIPS; i++) {
      if (ma[i] === 0) continue;
      const x = (i + 0.5) * dx,
        xi = x - lcg,
        fall = cv > 0 ? 1 - 2 / (exp((5 * x) / (0.34 * B * cv)) + 1) : 1,
        // d(m_a V)/dxi forward from the strip (no added mass beyond the wetted bow).
        ahead = i + 1 < STRIPS ? ma[i + 1]! * vn[i + 1]! : 0,
        gradient = (ahead - ma[i]! * vn[i]!) / dx,
        v = vn[i]!,
        // Up the normal: m_a theta' U + m_a' V - U d(m_a V)/dxi + C_D,c rho b V |V|, C_D,c = cos(beta).
        f =
          fall *
          (ma[i]! * pitchRate * along +
            rate[i]! * v -
            along * gradient +
            cosBeta * rho * halfBeam[i]! * v * Math.abs(v)) *
          dx;
      lift += f;
      moment += f * xi;
      const w = fall * ma[i]! * dx;
      Ma += w;
      Qa += w * xi;
      Ia += w * xi * xi;
      const fb = fall * rho * g * area[i]! * dx;
      buoyancy += fb;
      buoyancyMoment += fb * xi * cosTrim;
      wetted += (2 * halfBeam[i]! * dx) / cosBeta;
    }
    // The bottom's friction on its wetted area by the ITTC-1957 line at the bottom's speed along the keel, aft, a quarter
    // beam's deadrise rise above the keel.
    const re = (Math.abs(along) * keel) / this.viscosity,
      log = re > 1 ? ln(re) * 0.4342944819032518 - 2 : 1,
      cf = re > 1 ? 0.075 / (log * log) + this.roughness : 0,
      friction = 0.5 * rho * along * Math.abs(along) * cf * wetted,
      frictionLever = dot(sub(centre, transom), up) - (B / 4) * tanBeta,
      // Gravity (which the rigid solver gives the body), the thrust and the buoyancy (vertical).
      gravity = scale(vertical, -mass * g),
      thrust = this.controls[index]!.thrust,
      e = boat.thrustAngle ?? 0,
      thrustVector = Number.isFinite(thrust) ? scale(add(scale(fwd, cos(e)), scale(up, sin(e))), thrust) : [0, 0, 0],
      thrustPoint = boat.propeller ? add(origin, rotate(q, boat.propeller)) : transom,
      thrustMoment = dot(cross(sub(thrustPoint, centre), thrustVector), side),
      buoyant = scale(vertical, buoyancy),
      normal = lift + dot(gravity, up) + dot(thrustVector, up) + dot(buoyant, up),
      pitch = moment + buoyancyMoment + thrustMoment - friction * frictionLever,
      // (M + M_a) a_n + Q_a theta'' = normal; Q_a a_n + (I + I_a) theta'' = pitch.
      si =
        side[0] * (bodies[at + 17]! * side[0] + bodies[at + 18]! * side[1] + bodies[at + 19]! * side[2]) +
        side[1] * (bodies[at + 18]! * side[0] + bodies[at + 20]! * side[1] + bodies[at + 21]! * side[2]) +
        side[2] * (bodies[at + 19]! * side[0] + bodies[at + 21]! * side[1] + bodies[at + 22]! * side[2]),
      inertia = si > 0 ? 1 / si : 0,
      a11 = mass + Ma,
      a22 = inertia + Ia,
      det = a11 * a22 - Qa * Qa,
      an = det > 0 ? (normal * a22 - Qa * pitch) / det : 0,
      alpha = det > 0 ? (a11 * pitch - Qa * normal) / det : 0,
      w = boat.row * FORCE_WORDS,
      // The body's own share: m a_n up the normal less the gravity the rigid solver gives it, the thrust, friction and
      // buoyancy along the keel, and I theta'' in pitch.
      normalForce = mass * an - dot(gravity, up),
      alongForce = dot(thrustVector, fwd) - friction + dot(buoyant, fwd);
    for (let k = 0; k < 3; k++) {
      out[w + k]! += normalForce * up[k]! + alongForce * fwd[k]!;
      out[w + 3 + k]! += inertia * alpha * side[k]!;
    }
    status.normal = lift + dot(buoyant, up);
    status.friction = friction;
    status.resistance = -dot(add(scale(up, lift), add(buoyant, scale(fwd, -friction))), course);
  }

  /** The work of the last step: boats stepped and wetted strips summed (deterministic counts). */
  workCounts(): Readonly<{ boats: number; strips: number }> {
    return this.work;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [];
  }

  extraState(): readonly Region[] {
    return [this.forces];
  }
}

function rotate(q: readonly [number, number, number, number], v: readonly [number, number, number]): Vec3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function add(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}
function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function scale(a: readonly number[], k: number): Vec3 {
  return [a[0]! * k, a[1]! * k, a[2]! * k];
}
function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
