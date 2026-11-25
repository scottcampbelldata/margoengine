// Flight (AERO-03 of docs/physics-solvers.md): wings, rotors and lifting gas on rigid bodies, so aircraft, gliders, birds,
// bats, insects, helicopters, drones, balloons and airships fly from their own shape and motion through the air.
//
// - `WingForce`: a wing (or a mirrored pair) as a vortex lattice in the body's frame (lattice.ts, the method of SailForce,
//   AERO-02), solved every step from the wing's motion through the wind, so its lift, induced drag, the moment about the
//   centre of mass and the downwash between panels come from its planform, twist and attitude. Panels the air meets beyond
//   the stall angle take the quasi-steady lift and drag of a flat wing at that angle of attack: C_L = -0.44 e^(-0.47 a) +
//   1.19 sin(1.74 a + 20 deg) and C_D = 1.04 + sin(1.72 a - 70 deg), a in degrees (Y. Su, Fan, Onoue, Vejdani and Breuer,
//   "An improved aerodynamic model for quasi-steady simulations of animal flight at moderate Reynolds numbers",
//   arXiv:2302.09602, read, eqs. 10 and 11, acting at the quarter chord, eqs. 3 and 4). A wing can flap: `flap(time)` gives a
//   stroke angle about the forward axis at the root and a pitch about the span, and the wing's own motion is part of the air
//   each panel meets, so a downstroke pushes the bird up and forward.
// - `RotorForce`: a rotor or propeller by blade-element momentum theory (the article "Blade element momentum theory" in
//   Wikipedia, read 2026-11-25): each annulus's induced velocity v_i makes the thrust of its blade elements, dT = 1/2 rho W^2 B
//   c (C_L cos phi - C_D sin phi) dr with phi the inflow angle, equal the momentum the annulus gives the air, dT = 4 pi rho r
//   (V + v_i) v_i dr (the actuator disk's F = rho A v_D (v_w - v) with v_w = V + 2 v_i); the torque dQ = 1/2 rho W^2 B c
//   (C_L sin phi + C_D cos phi) r dr turns the body the other way.
// - `LiftingGas`: the buoyancy of a gas envelope, (rho_air - rho_gas) V g, with both densities from the ideal gas at the
//   standard atmosphere's pressure at the body's height (`@margoengine/math/atmosphere`), so a balloon rises to the height
//   where it floats.
//
// Accepted differences: quasi-steady (no wake memory, no unsteady circulation, no added mass of the air), wings are thin
// surfaces (no thickness or airfoil section data; a cambered section is a twisted one), rotors have no swirl, tip loss or
// ground effect, and one envelope temperature for hot air.

import { DRY_AIR_GAS_CONSTANT, standardAtmosphere } from '@margoengine/math/atmosphere';
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { cos, exp, hypot, pow, sin } from '@margoengine/math/pinned';
import type { PhysicsBody } from './body.js';
import { add, crossOf, dot, flatPlate, latticeLoads, scale, solve, sub } from './lattice.js';
import { checkVec, rotateVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';

const DEGREE = 0.017453292519943295;
/** A flat plate's separated flow, its normal-force coefficient 1.17 square to the air (Hoerner, as `WindForce` takes it). */
const PLATE = flatPlate(1.17);
const TWO_PI = 6.283185307179586;
const FOUR_PI = 12.566370614359172;

/** The air: a velocity in m/s, a function of the point and the time, or a flow field (whose density it takes too). */
export type Air = Vec3 | ((point: Vec3, time: number) => Vec3) | FlowField;

/** One spanwise section of a wing, in the body's frame. */
export interface WingSection {
  /** Where the section's leading edge is, m from the body's origin. */
  leadingEdge: Vec3;
  /** Its chord, m. */
  chord: number;
  /** Its twist, radians, nose up positive (an incidence; a cambered section's zero-lift angle adds here). Default 0. */
  twist?: number;
}

/** A wing's flapping at a time: angles in radians. */
export interface WingStroke {
  /** Rotation about the forward axis at the root, tip up positive (both wings of a pair together). Default 0. */
  stroke?: number;
  /** Rotation of every section about the span, nose up positive. Default 0. */
  pitch?: number;
}

/** Settings of a {@link WingForce}. */
export interface WingOptions {
  /** The wing's sections from root to tip, two or more, in the body's frame. */
  sections: readonly WingSection[];
  /** The body's forward direction, along which air meets the leading edge (default [0, 0, 1]). */
  forward?: Vec3;
  /** The body's up direction (default [0, 1, 0]). */
  up?: Vec3;
  /** Whether the wing is mirrored across the body's plane of forward and up, making a pair (default true). */
  mirror?: boolean;
  /** Panels along the chord, and along the span between each pair of sections (default [2, 4]). */
  panels?: readonly [number, number];
  /** The wind the wing flies through (default still air). */
  wind?: Air;
  /** Air density, kg/m^3 (default the flow field's, or the standard atmosphere's at the body's height). */
  density?: number;
  /** The angle of attack, radians, past which a panel's flow has separated (default 0.26, 15 degrees). */
  stall?: number;
  /** The flapping, as a function of time in seconds (default none: a fixed wing). */
  flap?: (time: number) => WingStroke;
  /**
   * How a stalled panel is loaded: 'plate', a flat plate's separated flow (C_N90 sin(a) across it, as `WindForce`; a fixed
   * wing loses lift past the stall), or 'flapping', the quasi-steady coefficients of a flapping or revolving wing whose
   * leading-edge vortex holds its lift (Su et al.). Default 'flapping' with `flap`, 'plate' without.
   */
  separation?: 'plate' | 'flapping';
  /** Profile drag coefficient of the wing's surface, along the air past each panel (default 0.008: both sides' skin friction). */
  profileDrag?: number;
}

/** Skin friction of a turbulent plate on both sides, 2 x 0.004 (as `WindForce` takes C_f, Hoerner). */
const PROFILE_DRAG = 0.008;

/**
 * The angle, radians in [0, pi/2], whose tangent is y / x for y, x >= 0, from + - * / and the pinned hypot only (the same bits on every
 * engine): the argument is kept at most 1, halved twice by tan(a/2) = t / (1 + sqrt(1 + t^2)), then summed as atan's series.
 */
export function angleOf(y: number, x: number): number {
  if (!(y > 0)) return 0;
  if (!(x > 0)) return 1.5707963267948966;
  const flip = y > x,
    t0 = flip ? x / y : y / x,
    t1 = t0 / (1 + hypot(1, t0)),
    t = t1 / (1 + hypot(1, t1)),
    t2 = t * t;
  let term = t,
    sum = t;
  for (let k = 1; k <= 16; k++) {
    term *= -t2;
    sum += term / (2 * k + 1);
  }
  return flip ? 1.5707963267948966 - 4 * sum : 4 * sum;
}

/** The quasi-steady lift and drag coefficients of a flat wing at `alpha` degrees (Su et al., eqs. 10 and 11). */
export function flatWingCoefficients(alpha: number): [number, number] {
  return [
    -0.44 * exp(-0.47 * alpha) + 1.19 * sin((1.74 * alpha + 20) * DEGREE),
    1.04 + sin((1.72 * alpha - 70) * DEGREE),
  ];
}

/** The separated panel's load: lift across the air in the plane of the panel's normal, drag along it. */
function separatedWing(v: Vec3, normal: Vec3, area: number, density: number): Vec3 {
  const speed = hypot(v[0], v[1], v[2]),
    vn = dot(v, normal),
    sinA = (vn < 0 ? -vn : vn) / speed,
    s = sinA < 1 ? sinA : 1,
    alpha = angleOf(s, pow(1 - s * s, 0.5)) / DEGREE,
    [cl, cd] = flatWingCoefficients(alpha),
    q = 0.5 * density * speed * speed * area,
    along = scale(v, 1 / speed),
    pushed = vn < 0 ? scale(normal, -1) : normal,
    across = sub(pushed, scale(along, dot(pushed, along))),
    length = hypot(across[0], across[1], across[2]),
    lift = length > 1e-12 ? scale(across, 1 / length) : ([0, 0, 0] as Vec3);
  return add(scale(lift, q * cl), scale(along, q * cd));
}

/** Rodrigues's rotation of `v` about the unit `axis` by `angle`. */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = cos(angle),
    s = sin(angle),
    k = crossOf(axis, v),
    d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

function unit(v: Vec3, label: string): Vec3 {
  checkVec(v, label);
  const l = hypot(v[0], v[1], v[2]);
  if (!(l > 0)) throw new RangeError(`${label} must be a direction, not zero; pass a vector of any length.`);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Shared by the forces: the air at a point and its density. */
class AirSampler {
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  constructor(
    private readonly air: Air,
    private readonly density: number | undefined,
  ) {
    if (density !== undefined && !(density > 0 && Number.isFinite(density)))
      throw new RangeError(
        `Air density is a finite number of kg/m^3 above 0 (got ${density}); pass one, or leave it unset.`,
      );
    if (!(typeof air === 'function' || (typeof air === 'object' && air !== null && 'sample' in air)))
      checkVec(air, 'Wind');
  }

  at(point: Vec3, time: number): [Vec3, number] {
    const air = this.air;
    if (typeof air === 'function') return [air(point, time), this.density ?? standardAirDensity(point[1])];
    if ('sample' in (air as object)) {
      const s = (air as FlowField).sample(point[0], point[1], point[2], time, this.sample);
      return [[s.velocity[0], s.velocity[1], s.velocity[2]], this.density ?? s.density];
    }
    return [air as Vec3, this.density ?? standardAirDensity(point[1])];
  }
}

function standardAirDensity(height: number): number {
  const [t, p] = standardAtmosphere(height);
  return p / (DRY_AIR_GAS_CONSTANT * t);
}

/**
 * A load held on a body as a force through the whole step (`addForce`, `addTorque`), changed each step by the difference
 * from the last, so it acts as a force does. An impulse at the start of a step would let gravity pull back through it, and a
 * hovering drone would creep up half g dt^2 a step (the soft attachments' finding, docs/known-bugs.md).
 */
/** A body's force and torque about its centre of mass, as a function of a change of its velocity and spin. */
type Wrench = (dv: Vec3, dw: Vec3) => [Vec3, Vec3];

/**
 * The load to hold through a step of `dt`, taken implicitly in the body's motion: the air's force and torque depend on the
 * body's velocity and spin, and a light body with a large wing would be over-damped by them in one explicit step (its roll
 * damping times the step reaches past 2, where an explicit step diverges). The load W(nu) is linearised about the motion at
 * the start, J = dW/dnu by central differences of 1 mm/s and 1 mrad/s, and the change of motion solves (I - dt M^-1 J) dnu =
 * dt (M^-1 W(0) + g), the backward Euler step of the load with the body's fall (M the body's mass and world inertia, g its
 * gravity); the load held is then W(0) + J dnu, the load at the end of the step.
 */
function implicitWrench(body: PhysicsBody, wrench: Wrench, dt: number, gravity: Vec3): [Vec3, Vec3] {
  const [f0, t0] = wrench([0, 0, 0], [0, 0, 0]);
  if (body.type !== 'dynamic' || !(dt > 0)) return [f0, t0];
  const h = 1e-3,
    jacobian = new Float64Array(36);
  for (let k = 0; k < 6; k++) {
    const d: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    d[k] = h;
    const [fp, tp] = wrench([d[0], d[1], d[2]], [d[3], d[4], d[5]]);
    d[k] = -h;
    const [fm, tm] = wrench([d[0], d[1], d[2]], [d[3], d[4], d[5]]),
      column = [...sub(fp, fm), ...sub(tp, tm)];
    for (let r = 0; r < 6; r++) jacobian[6 * r + k] = column[r]! / (2 * h);
  }
  const inverseMass = body.effectiveInverseMass,
    inverseInertia = body.effectiveWorldInverseInertia,
    // M^-1 applied to a row block: the inverse mass on the force rows, the inverse inertia on the torque rows.
    mInv = (r: number, c: number): number =>
      r < 3 ? (r === c ? inverseMass[r]! : 0) : c < 3 ? 0 : inverseInertia[3 * (r - 3) + (c - 3)]!,
    system = new Float64Array(36),
    rhs = new Float64Array(6),
    w0 = [...f0, ...t0],
    // The body's own fall through the step is part of its change of motion: a rotor holding a drone up meets no climb.
    fall = scale(gravity, body.gravityScale);
  for (let r = 0; r < 6; r++) {
    let b = r < 3 && inverseMass[r]! > 0 ? fall[r]! : 0;
    for (let k = 0; k < 6; k++) b += mInv(r, k) * w0[k]!;
    rhs[r] = dt * b;
    for (let c = 0; c < 6; c++) {
      let mj = 0;
      for (let k = 0; k < 6; k++) mj += mInv(r, k) * jacobian[6 * k + c]!;
      system[6 * r + c] = (r === c ? 1 : 0) - dt * mj;
    }
  }
  const dnu = solve(system, rhs, 6),
    held = [0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 6; r++) {
    let jd = 0;
    for (let c = 0; c < 6; c++) jd += jacobian[6 * r + c]! * dnu[c]!;
    held[r] = w0[r]! + jd;
  }
  return [
    [held[0]!, held[1]!, held[2]!],
    [held[3]!, held[4]!, held[5]!],
  ];
}

class HeldLoad {
  private readonly force: [number, number, number] = [0, 0, 0];
  private readonly torque: [number, number, number] = [0, 0, 0];

  set(body: PhysicsBody, force: Vec3, torque: Vec3): void {
    if (body.type !== 'dynamic') return;
    body.addForce([force[0] - this.force[0], force[1] - this.force[1], force[2] - this.force[2]]);
    body.addTorque([torque[0] - this.torque[0], torque[1] - this.torque[1], torque[2] - this.torque[2]]);
    [this.force[0], this.force[1], this.force[2]] = force;
    [this.torque[0], this.torque[1], this.torque[2]] = torque;
  }

  /** Takes the load off. */
  clear(body: PhysicsBody): void {
    this.set(body, [0, 0, 0], [0, 0, 0]);
  }
}

/**
 * A wing on a rigid body: a vortex lattice solved every step from the body's motion, the wing's flapping and the wind, its
 * load applied to the body. Separated panels take the quasi-steady flat-wing coefficients of Su et al.
 */
export class WingForce implements PhysicsAttachment {
  /** The wing's total aerodynamic force in the last step, N. */
  readonly force: [number, number, number] = [0, 0, 0];
  /** Its moment about the body's centre of mass in the last step, N m. */
  readonly torque: [number, number, number] = [0, 0, 0];
  /** Each panel's circulation in the last step, m^2/s, chord first then span from the left tip. */
  circulation: Float64Array = new Float64Array(0);
  private released = false;
  private readonly held = new HeldLoad();
  private readonly forward: Vec3;
  private readonly up: Vec3;
  private readonly side: Vec3;
  private readonly air: AirSampler;
  private readonly nc: number;
  private readonly perInterval: number;

  /** @throws RangeError for fewer than two sections, a chord or panel count out of range, or bad settings. */
  constructor(
    private readonly physics: Physics,
    private readonly body: PhysicsBody,
    private readonly options: WingOptions,
  ) {
    const { sections, panels = [2, 4], stall = 0.26, wind = [0, 0, 0], density, profileDrag = PROFILE_DRAG } = options;
    if (!(profileDrag >= 0 && Number.isFinite(profileDrag)))
      throw new RangeError(
        `A profile drag coefficient is 0 or more (got ${profileDrag}); pass a finite number, or leave it unset.`,
      );
    if (!(Array.isArray(sections) && sections.length >= 2))
      throw new RangeError(`A wing has two or more sections from root to tip (got ${sections?.length}); pass them.`);
    sections.forEach((s, i) => {
      checkVec(s.leadingEdge, `Section ${i}'s leading edge`);
      if (!(s.chord > 0 && Number.isFinite(s.chord)))
        throw new RangeError(`Section ${i}'s chord is a finite number of metres above 0 (got ${s.chord}); pass one.`);
      if (s.twist !== undefined && !Number.isFinite(s.twist))
        throw new RangeError(
          `Section ${i}'s twist is a finite number of radians (got ${s.twist}); pass one or leave it unset.`,
        );
    });
    if (!(panels.length === 2 && panels.every((p) => Number.isInteger(p) && p >= 1 && p <= 32)))
      throw new RangeError(
        `A wing's panels are two whole numbers from 1 to 32, [chordwise, spanwise] (got ${panels}); pass them.`,
      );
    if (!(stall > 0 && stall <= 1.5707963267948966))
      throw new RangeError(
        `A stall angle lies in (0, pi/2] radians (got ${stall}); pass one in that range, or leave it unset.`,
      );
    if (options.separation !== undefined && options.separation !== 'plate' && options.separation !== 'flapping')
      throw new RangeError(
        `A wing's separation is 'plate' or 'flapping' (got ${options.separation}); pass one of them.`,
      );
    this.forward = unit(options.forward ?? [0, 0, 1], 'The forward direction');
    this.up = unit(options.up ?? [0, 1, 0], 'The up direction');
    const side = crossOf(this.up, this.forward),
      length = hypot(side[0], side[1], side[2]);
    if (!(length > 1e-9))
      throw new RangeError('The forward and up directions must not be parallel; pass two directions at right angles.');
    this.side = scale(side, 1 / length);
    this.air = new AirSampler(wind, density);
    [this.nc, this.perInterval] = panels;
    physics.attach(this);
  }

  /** The wing's corners in the body's frame at `time`: chord index fastest, then span from the left tip. */
  private geometry(time: number): { corners: Vec3[]; stations: number } {
    const { sections, mirror = true, flap } = this.options,
      { stroke = 0, pitch = 0 } = flap ? flap(time) : {},
      root = sections[0]!.leadingEdge,
      half: Vec3[][] = [];
    for (let i = 0; i + 1 < sections.length; i++)
      for (let k = i === 0 ? 0 : 1; k <= this.perInterval; k++) {
        const t = k / this.perInterval,
          a = sections[i]!,
          b = sections[i + 1]!,
          lead: Vec3 = [
            a.leadingEdge[0] + (b.leadingEdge[0] - a.leadingEdge[0]) * t,
            a.leadingEdge[1] + (b.leadingEdge[1] - a.leadingEdge[1]) * t,
            a.leadingEdge[2] + (b.leadingEdge[2] - a.leadingEdge[2]) * t,
          ],
          chord = a.chord + (b.chord - a.chord) * t,
          twist = (a.twist ?? 0) + ((b.twist ?? 0) - (a.twist ?? 0)) * t,
          // Nose up turns the chord (leading to trailing edge, backward) about the span so the trailing edge drops.
          back = rotateAbout(scale(this.forward, -1), this.side, -(twist + pitch)),
          column: Vec3[] = [];
        for (let c = 0; c <= this.nc; c++) {
          const local = add(lead, scale(back, (chord * c) / this.nc)),
            fromRoot = sub(local, root),
            sign = dot(fromRoot, this.side) < 0 ? -1 : 1;
          column.push(add(root, rotateAbout(fromRoot, this.forward, sign * stroke)));
        }
        half.push(column);
      }
    if (!mirror) return { corners: half.flat(), stations: half.length };
    const reflect = (p: Vec3): Vec3 => sub(p, scale(this.side, 2 * dot(p, this.side))),
      across = dot(root, this.side),
      onPlane = (across < 0 ? -across : across) <= 1e-9 * (1 + hypot(root[0], root[1], root[2])),
      mirrored = half.map((column) => column.map(reflect)).reverse(),
      columns = onPlane ? [...mirrored.slice(0, -1), ...half] : [...mirrored, ...half];
    // Spanwise order must run one way, so the panels' normals agree: from the side the mirror image is on.
    const firstSide = dot(columns[0]![0]!, this.side),
      lastSide = dot(columns[columns.length - 1]![0]!, this.side);
    if (firstSide > lastSide) columns.reverse();
    return { corners: columns.flat(), stations: columns.length };
  }

  /** @internal */
  beforeStep(dt: number): void {
    if (this.released) return;
    const body = this.body,
      time = this.physics.stepCount * this.physics.fixedTimestep,
      { corners, stations } = this.geometry(time),
      nc = this.nc,
      ns = stations - 1,
      q = body.rotation,
      pos = body.position,
      com = body.worldCenterOfMass,
      v0 = body.linearVelocity,
      w0 = body.angularVelocity,
      world = corners.map((p): Vec3 => add(pos, rotateVec(q, p))),
      // The flapping's own velocity, by a central difference of the wing's shape over a tenth of a millisecond.
      h = 1e-4,
      moving = this.options.flap
        ? (() => {
            const ahead = this.geometry(time + h).corners,
              behind = this.geometry(time - h).corners;
            return ahead.map((p, i) => rotateVec(q, scale(sub(p, behind[i]!), 1 / (2 * h))));
          })()
        : undefined,
      corner = (c: number, s: number) => world[c + (nc + 1) * s]!,
      air: Vec3[] = [],
      rho: number[] = [];
    for (let s = 0; s < ns; s++)
      for (let c = 0; c < nc; c++) {
        const p00 = corner(c, s),
          p10 = corner(c + 1, s),
          p01 = corner(c, s + 1),
          p11 = corner(c + 1, s + 1),
          mid = (k: number) => (p00[k]! + 0.75 * (p10[k]! - p00[k]!) + p01[k]! + 0.75 * (p11[k]! - p01[k]!)) / 2,
          [wind, density] = this.air.at([mid(0), mid(1), mid(2)], time);
        air.push(wind);
        rho.push(density);
      }
    const separation = this.options.separation ?? (this.options.flap ? 'flapping' : 'plate'),
      law = separation === 'flapping' ? separatedWing : PLATE,
      stall = this.options.stall ?? 0.26;
    const profileDrag = this.options.profileDrag ?? PROFILE_DRAG,
      areas: number[] = [];
    for (let s = 0; s < ns; s++)
      for (let c = 0; c < nc; c++) {
        const d = crossOf(sub(corner(c + 1, s + 1), corner(c, s)), sub(corner(c, s + 1), corner(c + 1, s)));
        areas.push(hypot(d[0], d[1], d[2]) / 2);
      }
    let circulation: Float64Array = new Float64Array(0);
    const wrench: Wrench = (dv, dw) => {
      const v = add(v0, dv),
        w = add(w0, dw),
        velocity = world.map((p, i): Vec3 => {
          const spin = crossOf(w, sub(p, com)),
            own = moving ? moving[i]! : ([0, 0, 0] as Vec3);
          return [v[0] + spin[0] + own[0], v[1] + spin[1] + own[1], v[2] + spin[2] + own[2]];
        }),
        vel = (a: number, b: number) => velocity[a + (nc + 1) * b]!,
        relative: Vec3[] = [];
      for (let s = 0; s < ns; s++)
        for (let c = 0; c < nc; c++) {
          const mean = scale(add(add(vel(c, s), vel(c + 1, s)), add(vel(c, s + 1), vel(c + 1, s + 1))), 0.25);
          relative.push(sub(air[c + nc * s]!, mean));
        }
      const loads = latticeLoads({ nc, ns, corner, relative, density: rho }, stall, law);
      // Profile drag along the air past each panel: 1/2 rho |v| v A C_d0.
      for (let m = 0; m < loads.forces.length; m++) {
        const r = relative[m]!,
          speed = hypot(r[0], r[1], r[2]);
        loads.forces[m] = add(loads.forces[m]!, scale(r, 0.5 * rho[m]! * speed * areas[m]! * profileDrag));
      }
      if (dv[0] === 0 && dv[1] === 0 && dv[2] === 0 && dw[0] === 0 && dw[1] === 0 && dw[2] === 0)
        circulation = loads.circulation;
      let force: Vec3 = [0, 0, 0],
        torque: Vec3 = [0, 0, 0];
      for (let m = 0; m < loads.forces.length; m++) {
        const f = loads.forces[m]!;
        force = add(force, f);
        torque = add(torque, crossOf(sub(loads.points[m]!, com), f));
      }
      return [force, torque];
    };
    const [force, torque] = implicitWrench(body, wrench, dt, this.physics.gravity);
    this.circulation = circulation;
    [this.force[0], this.force[1], this.force[2]] = force;
    [this.torque[0], this.torque[1], this.torque[2]] = torque;
    this.held.set(body, force, torque);
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.body) this.remove();
  }

  /** Stops the load. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.held.clear(this.body);
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }
}

/** Settings of a {@link RotorForce}. */
export interface RotorOptions {
  /** The rotor's hub, m from the body's origin in its frame (default [0, 0, 0]). */
  hub?: Vec3;
  /** The direction it pushes air away from, in the body's frame: its thrust is along this for a positive speed (default [0, 1, 0]). */
  axis?: Vec3;
  /** Blade tip radius, m. */
  radius: number;
  /** Where the blades start, m (default a tenth of the radius). */
  hubRadius?: number;
  /** Number of blades (default 2). */
  blades?: number;
  /** Blade chord, m, constant or as a function of radius. */
  chord: number | ((r: number) => number);
  /** Blade pitch angle, radians from the rotor plane, constant or as a function of radius. */
  pitch: number | ((r: number) => number);
  /** Rotor speed, rad/s (positive turns about `axis` by the right hand), or a function of time. */
  speed: number | ((time: number) => number);
  /** Lift-curve slope of the blade sections, per radian (default 2 pi, a thin airfoil). */
  liftSlope?: number;
  /** Profile drag coefficient of the sections (default 0.008, both sides' skin friction). */
  profileDrag?: number;
  /** Angle of attack past which a section stalls, radians (default 0.26). */
  stall?: number;
  /** Annuli along the blade (default 16). */
  stations?: number;
  /** The wind (default still air). */
  wind?: Air;
  /** Air density, kg/m^3 (default the flow field's, or the standard atmosphere's at the hub). */
  density?: number;
}

/** A rotor or propeller on a rigid body: blade-element momentum theory every step; thrust along its axis, torque against it. */
export class RotorForce implements PhysicsAttachment {
  /** Thrust in the last step, N (along the axis; negative pulls the other way). */
  thrust = 0;
  /** Torque the air puts on the blades in the last step, N m (the body turns the other way). */
  torque = 0;
  /** Power the rotor gives the air in the last step, W. */
  power = 0;
  private released = false;
  private readonly held = new HeldLoad();
  private readonly axis: Vec3;
  private readonly air: AirSampler;

  /** @throws RangeError for a radius, blade count, chord, pitch or speed out of range. */
  constructor(
    private readonly physics: Physics,
    private readonly body: PhysicsBody,
    private readonly options: RotorOptions,
  ) {
    const {
      radius,
      hubRadius = 0.1 * radius,
      blades = 2,
      stations = 16,
      liftSlope = TWO_PI,
      profileDrag = PROFILE_DRAG,
    } = options;
    if (!(radius > 0 && Number.isFinite(radius)))
      throw new RangeError(`A rotor's radius is a finite number of metres above 0 (got ${radius}); pass one.`);
    if (!(hubRadius >= 0 && hubRadius < radius))
      throw new RangeError(
        `A rotor's hub radius lies in [0, radius) (got ${hubRadius} for radius ${radius}); pass a smaller one.`,
      );
    if (!(Number.isInteger(blades) && blades >= 1 && blades <= 64))
      throw new RangeError(`A rotor has 1 to 64 whole blades (got ${blades}); pass a whole number.`);
    if (!(Number.isInteger(stations) && stations >= 2 && stations <= 256))
      throw new RangeError(`A rotor's stations are a whole number from 2 to 256 (got ${stations}); pass one.`);
    if (!(liftSlope > 0 && Number.isFinite(liftSlope) && profileDrag >= 0 && Number.isFinite(profileDrag)))
      throw new RangeError('A rotor needs a finite lift slope above 0 and a profile drag of 0 or more; pass them.');
    this.axis = unit(options.axis ?? [0, 1, 0], "The rotor's axis");
    if (options.hub !== undefined) checkVec(options.hub, "The rotor's hub");
    this.air = new AirSampler(options.wind ?? [0, 0, 0], options.density);
    physics.attach(this);
  }

  /** Thrust, torque and power at speed `omega` rad/s with the air meeting the disk at `inflow` m/s along the axis, density `rho`. */
  evaluate(omega: number, inflow: number, rho: number): { thrust: number; torque: number; power: number } {
    const {
        radius,
        hubRadius = 0.1 * radius,
        blades = 2,
        stations = 16,
        liftSlope = TWO_PI,
        profileDrag = PROFILE_DRAG,
        stall = 0.26,
      } = this.options,
      chordAt = (r: number) => (typeof this.options.chord === 'function' ? this.options.chord(r) : this.options.chord),
      pitchAt = (r: number) => (typeof this.options.pitch === 'function' ? this.options.pitch(r) : this.options.pitch),
      spin = omega < 0 ? -omega : omega,
      dr = (radius - hubRadius) / stations;
    let thrust = 0,
      torque = 0;
    for (let k = 0; k < stations; k++) {
      const r = hubRadius + (k + 0.5) * dr,
        c = chordAt(r),
        theta = pitchAt(r),
        // Blade-element thrust minus the momentum the annulus gives the air, for an induced velocity v_i.
        element = (vi: number): [number, number, number] => {
          const axial = inflow + vi,
            tangential = spin * r,
            w2 = axial * axial + tangential * tangential,
            phi = axial < 0 ? -angleOf(-axial, tangential) : angleOf(axial, tangential),
            alpha = theta - phi,
            stalled = (alpha < 0 ? -alpha : alpha) > stall,
            [cls, cds] = stalled ? flatWingCoefficients((alpha < 0 ? -alpha : alpha) / DEGREE) : [0, 0],
            cl = stalled ? (alpha < 0 ? -cls : cls) : liftSlope * alpha,
            cd = stalled ? cds : profileDrag,
            q = 0.5 * rho * w2 * blades * c * dr,
            dT = q * (cl * cos(phi) - cd * sin(phi)),
            dQ = q * (cl * sin(phi) + cd * cos(phi)) * r;
          // The annulus's mass flow is rho dA |V + v_i| whichever way it goes, and the air leaves with 2 v_i.
          return [dT - FOUR_PI * rho * r * dr * (axial < 0 ? -axial : axial) * vi, dT, dQ];
        };
      // The induced velocity solves element(v_i)[0] = 0, which falls as v_i rises: bisect it within the tip speed and the inflow.
      const reach = spin * radius + (inflow < 0 ? -inflow : inflow) + 1;
      let lo = -reach,
        hi = reach;
      for (let i = 0; i < 80; i++) {
        const mid = 0.5 * (lo + hi);
        if (element(mid)[0] > 0) lo = mid;
        else hi = mid;
      }
      const [, dT, dQ] = element(0.5 * (lo + hi));
      thrust += dT;
      torque += dQ;
    }
    return { thrust, torque: omega < 0 ? -torque : torque, power: torque * spin };
  }

  /** @internal */
  beforeStep(dt: number): void {
    if (this.released) return;
    const body = this.body,
      time = this.physics.stepCount * this.physics.fixedTimestep,
      q = body.rotation,
      axis = rotateVec(q, this.axis),
      hub = add(body.position, rotateVec(q, this.options.hub ?? [0, 0, 0])),
      com = body.worldCenterOfMass,
      omega = typeof this.options.speed === 'function' ? this.options.speed(time) : this.options.speed;
    if (!Number.isFinite(omega))
      throw new RangeError(`A rotor's speed is a finite number of rad/s (got ${omega}); pass one.`);
    const [air, rho] = this.air.at(hub, time),
      lever = sub(hub, com),
      wrench: Wrench = (dv, dw) => {
        const hubVelocity = add(add(body.linearVelocity, dv), crossOf(add(body.angularVelocity, dw), lever)),
          // The air through the disk along the thrust's opposite: climbing into still air, it meets the disk from above.
          inflow = -dot(sub(air, hubVelocity), axis),
          { thrust } = this.evaluate(omega, inflow, rho),
          force = scale(axis, thrust);
        return [force, crossOf(lever, force)];
      },
      [force, pushMoment] = implicitWrench(body, wrench, dt, this.physics.gravity),
      hubVelocity = add(body.linearVelocity, crossOf(body.angularVelocity, lever)),
      { thrust, torque, power } = this.evaluate(omega, -dot(sub(air, hubVelocity), axis), rho);
    this.thrust = thrust;
    this.torque = torque;
    this.power = power;
    this.held.set(body, force, add(pushMoment, scale(axis, -torque)));
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.body) this.remove();
  }

  /** Stops the rotor's load. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.held.clear(this.body);
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }
}

/** Molar masses, kg/mol. */
const UNIVERSAL_GAS_CONSTANT = 8.314462618;
const GASES = { helium: 0.0040026, hydrogen: 0.00201588 } as const;

/** Settings of a {@link LiftingGas}. */
export interface LiftingGasOptions {
  /** The envelope's volume, m^3. */
  volume: number;
  /** The gas: 'helium', 'hydrogen' (at the air's temperature) or 'hotAir' (at `temperature`). Default 'helium'. */
  gas?: 'helium' | 'hydrogen' | 'hotAir';
  /** The hot air's temperature, K (default 373.15). */
  temperature?: number;
  /** Where the buoyancy acts, m from the body's origin in its frame (default [0, 0, 0]). */
  centre?: Vec3;
  /** The height above sea level of y = 0, m (default 0). */
  altitude?: number;
  /** Sea-level temperature of the standard atmosphere, K (default 288.15). */
  seaLevelTemperature?: number;
}

/** The buoyancy of a gas envelope on a rigid body: (rho_air - rho_gas) V g up, at the standard atmosphere's air. */
export class LiftingGas implements PhysicsAttachment {
  /** The net lift in the last step, N. */
  lift = 0;
  private released = false;
  private readonly held = new HeldLoad();

  /** @throws RangeError for a volume or temperature that is not finite and above 0, or an unknown gas. */
  constructor(
    private readonly physics: Physics,
    private readonly body: PhysicsBody,
    private readonly options: LiftingGasOptions,
  ) {
    const { volume, gas = 'helium', temperature = 373.15 } = options;
    if (!(volume > 0 && Number.isFinite(volume)))
      throw new RangeError(`An envelope's volume is a finite number of m^3 above 0 (got ${volume}); pass one.`);
    if (gas !== 'helium' && gas !== 'hydrogen' && gas !== 'hotAir')
      throw new RangeError(`A lifting gas is 'helium', 'hydrogen' or 'hotAir' (got ${gas}); pass one of them.`);
    if (!(temperature > 0 && Number.isFinite(temperature)))
      throw new RangeError(
        `Hot air's temperature is a finite number of kelvin above 0 (got ${temperature}); pass one.`,
      );
    if (options.centre !== undefined) checkVec(options.centre, "The envelope's centre");
    physics.attach(this);
  }

  /** The net lift, N, of the envelope at `height` m (y) under gravity `g` m/s^2. */
  liftAt(height: number, g: number): number {
    const { volume, gas = 'helium', temperature = 373.15, altitude = 0, seaLevelTemperature } = this.options,
      [t, p] = standardAtmosphere(altitude + height, seaLevelTemperature),
      air = p / (DRY_AIR_GAS_CONSTANT * t),
      inside =
        gas === 'hotAir' ? p / (DRY_AIR_GAS_CONSTANT * temperature) : (p * GASES[gas]) / (UNIVERSAL_GAS_CONSTANT * t);
    return (air - inside) * volume * g;
  }

  /** @internal */
  beforeStep(_dt: number): void {
    if (this.released) return;
    const body = this.body,
      gravity = this.physics.gravity,
      g = hypot(gravity[0], gravity[1], gravity[2]);
    if (!(g > 0)) {
      this.lift = 0;
      this.held.clear(body);
      return;
    }
    const centre = add(body.position, rotateVec(body.rotation, this.options.centre ?? [0, 0, 0])),
      lift = this.liftAt(centre[1], g),
      up = scale(gravity, -lift / g),
      moment = crossOf(sub(centre, body.worldCenterOfMass), up);
    this.lift = lift;
    this.held.set(body, up, moment);
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.body) this.remove();
  }

  /** Stops the buoyancy. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.held.clear(this.body);
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }
}
