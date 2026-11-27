// Rowing boats as a solver of the physics framework (SEA-09): each oar is swept through its stroke about its pin, and its
// blade in the water takes the lift and drag N. Caplan and T. Gardner measured on a Macon blade in a flume ("A fluid
// dynamic investigation of the Big Blade and Macon oar blade designs in rowing propulsion", J. Sports Sci. 25, 643-650,
// 2007), as A. Coppel, T. Gardner, N. Caplan and D. Hargreaves, "Oar blade force coefficients and a mathematical model of
// rowing", ISBS 2009, Table 1, print them (read): F = (1/2) rho |V|^2 A C(alpha), V the blade's velocity through the water,
// alpha the angle between the oar's shaft and that velocity, the drag against the motion and the lift across it, the
// coefficients a cubic spline through the measured points as Caplan and Gardner interpolate them (Coppel et al. p. 2).
// The stroke is Coppel et al.'s: the oar turned from its catch to its finish angle in the drive with a half-cosine sweep,
// back in the recovery with the blade out of the water, and the crew moving fore and aft along the boat in half-cosine
// motion each phase (A. L. Coppel, PhD thesis, University of Birmingham, 2010, eqs. 5.3 to 5.5, read); the water's drag
// is on the hull, which moves against the crew. The blades' forces act on the boat at their blades, so the oars' yaw
// moments are the boat's.
import { atan2, cos, hypot, sin } from '@margoengine/math/pinned';
import { regionWords } from '../world/memory.js';
import type { Port, RateLevel, Region, Solver, SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { rateOf } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { shipError } from './errors.js';

type Vec3 = [number, number, number];
const LAYOUT = 1;

/** Caplan and Gardner's Macon blade (0.108 m^2): angle of attack, deg, C_L and C_D as measured (Coppel et al. 2009, Table 1). */
export const MACON_BLADE: readonly (readonly [number, number, number])[] = Object.freeze([
  [0, 0.02, -0.03],
  [20, 0.7, 0.22],
  [45, 1.2, 1.16],
  [70, 0.66, 1.72],
  [90, 0.04, 1.85],
  [115, -0.77, 1.74],
  [135, -1.19, 1.25],
  [160, -0.8, 0.03],
  [180, -0.14, 0.04],
] as const);

/** A natural cubic spline's second derivatives through (x, y). */
function splineMoments(x: readonly number[], y: readonly number[]): Float64Array {
  const n = x.length,
    m = new Float64Array(n),
    c = new Float64Array(n),
    d = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const h0 = x[i]! - x[i - 1]!,
      h1 = x[i + 1]! - x[i]!,
      a = h0 / 6,
      b = (h0 + h1) / 3,
      r = (y[i + 1]! - y[i]!) / h1 - (y[i]! - y[i - 1]!) / h0,
      w = b - a * c[i - 1]!;
    c[i] = h1 / 6 / w;
    d[i] = (r - a * d[i - 1]!) / w;
  }
  for (let i = n - 2; i >= 1; i--) m[i] = d[i]! - c[i]! * m[i + 1]!;
  return m;
}

const ALPHA = MACON_BLADE.map((r) => r[0]),
  LIFT = MACON_BLADE.map((r) => r[1]),
  DRAG = MACON_BLADE.map((r) => r[2]),
  LIFT_M = splineMoments(ALPHA, LIFT),
  DRAG_M = splineMoments(ALPHA, DRAG);

function spline(y: readonly number[], m: Float64Array, a: number): number {
  let i = 0;
  while (i < ALPHA.length - 2 && a > ALPHA[i + 1]!) i++;
  const x0 = ALPHA[i]!,
    x1 = ALPHA[i + 1]!,
    h = x1 - x0,
    t = (a - x0) / h,
    u = 1 - t;
  return u * y[i]! + t * y[i + 1]! + ((u * u * u - u) * m[i]! + (t * t * t - t) * m[i + 1]!) * ((h * h) / 6);
}

/** The Macon blade's lift and drag coefficients at an angle of attack `alpha` rad (0 to pi), the drag held at 0 or more. */
export function bladeCoefficients(alpha: number): { lift: number; drag: number } {
  const a = (Math.max(0, Math.min(Math.PI, alpha)) * 180) / Math.PI;
  return { lift: spline(LIFT, LIFT_M, a), drag: Math.max(0, spline(DRAG, DRAG_M, a)) };
}

/** An oar: its pin in the body's frame, m, its side (1 starboard, -1 port), the pin-to-blade-centre length, m, and blade area, m^2. */
export interface Oar {
  readonly pin: readonly [number, number, number];
  readonly side: 1 | -1;
  readonly outboard: number;
  /** Projected blade area, m^2 (default 0.108, the Macon blade's). */
  readonly area?: number;
}

/** A rowing boat: its body row, oars, crew mass, kg, and the crew's travel along the boat, m; its hull's drag. */
export interface RowingBoat {
  readonly row: number;
  readonly oars: readonly Oar[];
  /** The crew's mass, kg (part of the body's), and how far its centre moves fore and aft each stroke, m (default 0.6). */
  readonly crew: number;
  readonly travel?: number;
  /** The hull's water and air drag at its speed, N: k for k v^2, or a function of the speed, m/s. */
  readonly drag: number | ((speed: number) => number);
  /** The body's forward and up axes, unit vectors in its frame (default +X and +Y). */
  readonly forward?: readonly [number, number, number];
  readonly up?: readonly [number, number, number];
}

/** What a {@link RowingSolver} is made from. */
export interface RowingParams {
  readonly boats: readonly RowingBoat[];
  /** The water's density, kg/m^3 (default 1000). */
  readonly density?: number;
  readonly capacity?: number;
  readonly level?: RateLevel;
}

/**
 * A boat's stroke: rate, strokes a minute, drive time, s, catch and finish angles, rad (0 the oar square to the hull,
 * negative toward the bow), and `turn` from -1 to 1, which shortens the starboard (positive) or port oars' sweep by that
 * fraction to turn the boat. A rate of 0 holds the oars square, out of the water.
 */
export interface RowingControl {
  rate: number;
  drive: number;
  catchAngle: number;
  finishAngle: number;
  turn: number;
}

/** What a rowing boat did in the last step. */
export interface RowingStatus {
  /** The stroke's phase, 0 to 1 (the drive first), whether the blades are in, and the oars' angle, rad. */
  phase: number;
  driving: boolean;
  angle: number;
  /** The body's speed along its course and the hull's (less the crew's own motion), m/s. */
  speed: number;
  hull: number;
  /** The blades' force along the course, N, the power they put into the boat, W, and the rowers' power at the pins, W. */
  propulsion: number;
  propulsivePower: number;
  rowingPower: number;
  /** The crew's place along the boat from its mid-stroke, m (positive toward the bow). */
  crewOffset: number;
}

/** Rowing boats on rigid bodies, by Caplan and Gardner's blade forces. `id` is `'rowing'` by default. */
export class RowingSolver implements Solver<RowingParams> {
  private readonly id: string;
  private host!: SolverHost;
  private rate: RateLevel = 0;
  private capacity = 0;
  private density = 1000;
  private boats: readonly RowingBoat[] = [];
  private controls: RowingControl[] = [];
  private statuses: RowingStatus[] = [];
  private forces!: Region;
  private phases!: Region;
  private cell: [number, number, number] = [0, 0, 0];

  constructor(id = 'rowing') {
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

  init(host: SolverHost, params: RowingParams): void {
    const { boats, density = 1000, level = 0 } = params ?? ({} as RowingParams);
    if (!Array.isArray(boats) || boats.length === 0)
      throw shipError('Rowing boats need their bodies: pass {boats: [{row, oars, crew, drag}]}.');
    for (const b of boats) {
      if (!(Number.isInteger(b?.row) && b.row >= 0))
        throw shipError(`A rowing boat's body row is a whole number, 0 or more (got ${b?.row}); pass the body's row.`);
      if (!Array.isArray(b.oars) || b.oars.length === 0)
        throw shipError('A rowing boat has oars: pass {oars: [{pin: [x, y, z], side: 1 or -1, outboard}]}.');
      for (const o of b.oars)
        if (
          !(o?.pin?.length === 3 && o.pin.every(Number.isFinite) && (o.side === 1 || o.side === -1)) ||
          !(o.outboard > 0 && Number.isFinite(o.outboard) && (o.area ?? 0.108) > 0 && Number.isFinite(o.area ?? 0.108))
        )
          throw shipError(
            "An oar is {pin: [x, y, z] in the body's frame, side: 1 (starboard) or -1 (port), outboard and area above 0}; pass them.",
          );
      if (!(b.crew >= 0 && Number.isFinite(b.crew) && (b.travel ?? 0.6) >= 0 && Number.isFinite(b.travel ?? 0.6)))
        throw shipError(
          `A rowing crew's mass and travel are finite and 0 or more (got ${b.crew}, ${b.travel}); pass them.`,
        );
      if (!(typeof b.drag === 'function' || (b.drag >= 0 && Number.isFinite(b.drag))))
        throw shipError(
          `A rowing hull's drag is k (N s^2/m^2) for k v^2, or a function of the speed (got ${String(b.drag)}); pass one.`,
        );
    }
    if (!(density > 0 && Number.isFinite(density)))
      throw shipError(`Water's density is finite kg/m^3 above 0 (got ${density}); pass one, or 1000.`);
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw shipError(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    this.host = host;
    this.rate = level as RateLevel;
    this.density = density;
    this.boats = boats;
    this.controls = boats.map(() => ({
      rate: 0,
      drive: 0.9,
      catchAngle: (-55 * Math.PI) / 180,
      finishAngle: (35 * Math.PI) / 180,
      turn: 0,
    }));
    this.statuses = boats.map(() => ({
      phase: 0,
      driving: false,
      angle: 0,
      speed: 0,
      hull: 0,
      propulsion: 0,
      propulsivePower: 0,
      rowingPower: 0,
      crewOffset: 0,
    }));
    this.capacity = bodyRowsOf(
      host,
      'A RowingSolver',
      boats.map((b) => b.row),
      params.capacity,
    );
    this.forces = host.allocate('forces', this.capacity * FORCE_WORDS * 8, 'f64', LAYOUT);
    // Each boat's stroke phase, in strokes.
    this.phases = host.allocate('phases', boats.length * 8, 'f64', LAYOUT);
  }

  /** Boat `index`'s stroke: `rowing.control(0).rate = 30`. */
  control(index: number): RowingControl {
    const c = this.controls[index];
    if (!c) throw shipError(`There is no rowing boat ${index}; pass 0 to ${this.controls.length - 1}.`);
    return c;
  }

  /** What boat `index` did in the last step. */
  status(index: number): RowingStatus {
    const s = this.statuses[index];
    if (!s) throw shipError(`There is no rowing boat ${index}; pass 0 to ${this.statuses.length - 1}.`);
    return s;
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array,
      phases = regionWords(this.host.memory, this.phases) as Float64Array,
      dt = 1 / rateOf(context.level);
    out.fill(0);
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    const memory = port.region.memory ?? this.host.memory,
      bodies = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4);
    this.boats.forEach((boat, index) => {
      const at = boat.row * BODY_WORDS,
        c = this.controls[index]!,
        status = this.statuses[index]!;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) return;
      const rate = Math.max(0, Number.isFinite(c.rate) ? c.rate : 0),
        cycle = rate > 0 ? 60 / rate : Infinity,
        drive = Math.min(Math.max(c.drive, 0.05 * cycle), 0.95 * cycle);
      if (rate > 0 && !(drive > 0 && Number.isFinite(c.catchAngle) && Number.isFinite(c.finishAngle)))
        throw shipError('A stroke has a drive time above 0 s and finite catch and finish angles; pass them.');
      const phase = rate > 0 ? phases[index]! - Math.floor(phases[index]!) : 0,
        time = phase * cycle,
        driving = rate > 0 && time < drive,
        // The sweep's own phase, 0 to 1, in the drive or the recovery, and its rate.
        s = driving ? time / drive : rate > 0 ? (time - drive) / (cycle - drive) : 0,
        span = driving ? drive : cycle - drive,
        shape = 0.5 * (1 - cos(Math.PI * s)),
        shapeRate = rate > 0 ? (0.5 * Math.PI * sin(Math.PI * s)) / span : 0,
        q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
        origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
        centre: Vec3 = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!],
        velocity: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
        spin: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
        inverseMass = bodies[at + 16]!,
        mass = inverseMass > 0 ? 1 / inverseMass : 0,
        up = rotate(q, boat.up ?? [0, 1, 0]),
        fwd = rotate(q, boat.forward ?? [1, 0, 0]),
        side = cross(fwd, up),
        speed = dot(velocity, fwd),
        // The crew: -a cos(pi s) in the drive (from the stern toward the bow), a cos(pi s) in the recovery.
        a = 0.5 * (boat.travel ?? 0.6),
        crewOffset = rate > 0 ? (driving ? -a : a) * cos(Math.PI * s) : 0,
        crewRate = rate > 0 ? (driving ? a : -a) * sin(Math.PI * s) * (Math.PI / span) : 0,
        hull = mass > 0 ? speed - (boat.crew / mass) * crewRate : speed,
        k = boat.drag,
        drag = typeof k === 'function' ? k(Math.abs(hull)) : k * hull * hull,
        w = boat.row * FORCE_WORDS;
      status.phase = phase;
      status.driving = driving;
      status.speed = speed;
      status.hull = hull;
      status.crewOffset = crewOffset;
      let propulsion = 0,
        propulsivePower = 0,
        rowingPower = 0,
        angle = 0;
      if (mass > 0) {
        for (const oar of boat.oars) {
          // The oar's angle and its rate: a starboard oar's turn shortened by `turn` > 0, a port oar's by `turn` < 0.
          const shorten = Math.max(0, Math.min(1, oar.side * (Number.isFinite(c.turn) ? c.turn : 0))),
            finish = c.finishAngle - shorten * (c.finishAngle - c.catchAngle),
            sweep = finish - c.catchAngle,
            theta = rate > 0 ? (driving ? c.catchAngle + sweep * shape : finish - sweep * shape) : 0,
            thetaRate = driving ? sweep * shapeRate : -sweep * shapeRate;
          angle = theta;
          if (!driving) continue;
          // The shaft from the pin to the blade: square to the hull at 0, toward the bow at the catch.
          const dir = add(scale(side, oar.side * cos(theta)), scale(fwd, -sin(theta))),
            sweepDir = add(scale(side, -oar.side * sin(theta)), scale(fwd, -cos(theta))),
            pin = add(origin, rotate(q, oar.pin)),
            blade = add(pin, scale(dir, oar.outboard)),
            // The blade's velocity through the still water: the body's at the blade plus the sweep, laid level.
            moving = add(add(velocity, cross(spin, sub(blade, centre))), scale(sweepDir, thetaRate * oar.outboard)),
            v = sub(moving, scale(up, dot(moving, up))),
            V = hypot(v[0], v[1], v[2]);
          // The blade goes in as it starts to move aft through the water and comes out when it would move forward again (the
          // rower's catch and release), so it never drags the boat back.
          if (!(V > 1e-9) || dot(v, fwd) > 0) continue;
          const vh = scale(v, 1 / V),
            cosAlpha = Math.max(-1, Math.min(1, dot(dir, vh))),
            alpha = atan2(Math.sqrt(1 - cosAlpha * cosAlpha), cosAlpha),
            { lift, drag: cd } = bladeCoefficients(alpha),
            q2 = 0.5 * this.density * V * V * (oar.area ?? 0.108),
            perp = sub(dir, scale(vh, cosAlpha)),
            pl = hypot(perp[0], perp[1], perp[2]),
            force = add(scale(vh, -q2 * cd), pl > 1e-9 ? scale(perp, (q2 * lift) / pl) : [0, 0, 0]),
            // At the pin's height, so the blades roll the boat no more than its oars do.
            at = add(blade, scale(up, dot(sub(pin, blade), up)));
          apply(out, w, centre, at, force);
          propulsion += dot(force, fwd);
          propulsivePower += dot(force, fwd) * speed;
          // The rower's power: the blade's force's moment about the pin times the oar's turn.
          rowingPower += Math.abs(dot(cross(sub(blade, pin), force), up) * thetaRate);
        }
        // The water's and air's drag on the hull, at its own speed, along its course.
        apply(out, w, centre, centre, scale(fwd, -Math.sign(hull) * drag));
      }
      status.angle = angle;
      status.propulsion = propulsion;
      status.propulsivePower = propulsivePower;
      status.rowingPower = rowingPower;
      if (rate > 0) phases[index] = phases[index]! + dt / cycle;
    });
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [this.phases];
  }

  extraState(): readonly Region[] {
    return [this.forces];
  }
}

function apply(out: Float64Array, w: number, centre: Vec3, point: Vec3, f: Vec3): void {
  const m = cross(sub(point, centre), f);
  for (let k = 0; k < 3; k++) {
    out[w + k]! += f[k]!;
    out[w + 3 + k]! += m[k]!;
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
