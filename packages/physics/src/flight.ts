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
import { MargoError } from '@margoengine/math/errors';
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { cos, exp, hypot, pow, sin } from '@margoengine/math/pinned';
import type { PhysicsBody } from './body.js';
import { type AirHold, type AirLoad, airHoldOf } from './air-hold.js';
import type { WindForceFrame } from './fields.js';
import type { WingLatticeKernel, WingLatticeWorkCounts } from './flight/lattice-kernel.js';

export type { WingLatticeWorkCounts, WingLatticeWorkerWork } from './flight/lattice-kernel.js';
import { implicitWrench, type Wrench } from './held.js';

/** The air's loads in a `PhysicsWorld`: `world.add(new AirSolver(), {physics})`, coupled air before rigid. */
export { AirSolver, type AirSolverParams } from './world/solvers/air.js';
import { add, crossOf, dot, flatPlate, latticeLoads, scale, sub } from './lattice.js';
import { rotateVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';

const DEGREE = 0.017453292519943295;
/** A flat plate's separated flow, its normal-force coefficient 1.17 square to the air (Hoerner, as `WindForce` takes it). */
const PLATE = flatPlate(1.17);
const TWO_PI = 6.283185307179586;
const FOUR_PI = 12.566370614359172;

function flightInput(message: string): MargoError {
  return new MargoError('unsupported', message + ' See https://margoengine.com/errors#physics-flight');
}

function flightRange(message: string): MargoError {
  return new MargoError('failed', message + ' See https://margoengine.com/errors#physics-flight');
}

function flightVector(value: unknown, label: string): asserts value is Vec3 {
  const v = value as ArrayLike<number> | null | undefined;
  if (v?.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2]))
    throw flightInput(label + ' must be three finite components. Pass a finite [x, y, z] vector.');
}

function flightCell(value: unknown): asserts value is Vec3 {
  const cell = value as ArrayLike<number> | null | undefined;
  if (
    cell?.length !== 3 ||
    !Number.isSafeInteger(cell[0]) ||
    !Number.isSafeInteger(cell[1]) ||
    !Number.isSafeInteger(cell[2])
  )
    throw flightInput(
      'The flight wind and body frames need three signed integer coordinates. Pass their solver cells.',
    );
}

function checkWrench(force: Vec3, torque: Vec3): void {
  for (let axis = 0; axis < 3; axis++)
    if (!Number.isFinite(Math.fround(force[axis]!)) || !Number.isFinite(Math.fround(torque[axis]!)))
      throw flightRange(
        'The flight force or torque exceeds the rigid force range. Reduce speed, area or the load arm.',
      );
}

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
  /** Air density, kg/m^3 (default the flow field's, or the standard atmosphere's at the body's local height). */
  density?: number;
  /** Body frame for a cell-based wind field. Default cell [0, 0, 0]. Use a getter for a moving world origin. */
  frame?: WindForceFrame;
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
  /** Profile drag coefficient of attached panels, along the relative wind. Default 0.008 for both sides' skin friction. */
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
  flightVector(v, label);
  const length = hypot(v[0], v[1], v[2]);
  if (length > 0 && Number.isFinite(length)) return [v[0] / length, v[1] / length, v[2] / length];
  const magnitude = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  if (magnitude === 0) throw flightInput(label + ' must be nonzero. Pass a direction of any finite length.');
  const x = v[0] / magnitude,
    y = v[1] / magnitude,
    z = v[2] / magnitude;
  const scaledLength = hypot(x, y, z);
  return [x / scaledLength, y / scaledLength, z / scaledLength];
}

function isFlowField(air: Air): air is FlowField {
  return typeof air === 'object' && air !== null && 'sample' in air && typeof air.sample === 'function';
}

/** Shared by the forces: the air at a point and its density. */
class AirSampler {
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  constructor(
    private readonly air: Air,
    private readonly density: number | undefined,
    private readonly frame: WindForceFrame | undefined,
  ) {
    if (frame !== undefined && (!frame || !(frame.cellSize > 0 && Number.isFinite(frame.cellSize))))
      throw flightInput('The flight frame requires a finite positive cell size. Use your rigid world cellSize.');
    if (density !== undefined && !(density > 0 && Number.isFinite(density)))
      throw flightInput(
        `Air density is a finite number of kg/m^3 above 0 (got ${density}); pass one, or leave it unset.`,
      );
    if (!(typeof air === 'function' || isFlowField(air))) flightVector(air, 'Wind');
  }

  at(point: Vec3, time: number): [Vec3, number] {
    flightVector(point, 'The flight sample position');
    const air = this.air;
    let velocity: unknown;
    let density = this.density;
    if (typeof air === 'function') {
      velocity = air(point, time);
    } else if (isFlowField(air)) {
      const cell = air.cell ?? [0, 0, 0];
      const local = this.frame ? this.frame.cell : [0, 0, 0];
      flightCell(cell);
      flightCell(local);
      if (!this.frame && (cell[0] || cell[1] || cell[2]))
        throw flightInput(
          'The wind is in a nonzero cell. Provide the rigid world cell and cellSize in the flight frame.',
        );
      const shifted = this.frame ? add(point, scale(sub(local, cell), this.frame.cellSize)) : point;
      if (!shifted.every(Number.isFinite))
        throw flightRange('The wind sample position overflows. Use cell sizes and offsets that fit the local scene.');
      const sample = air.sample(shifted[0], shifted[1], shifted[2], time, this.sample);
      velocity = sample?.velocity;
      density ??= sample?.density;
      if (!(density !== undefined && density > 0 && Number.isFinite(density)))
        throw flightInput(
          'The flight field returned an invalid air density. Return a finite positive density or set density explicitly.',
        );
    } else {
      velocity = air;
    }
    density ??= standardAirDensity(point[1]);
    flightVector(velocity, 'The flight wind sample');
    if (!(density > 0 && Number.isFinite(density)))
      throw flightRange(
        'The ISA density is outside the representable range. Use a lower absolute altitude or supply an air density.',
      );
    return [[velocity[0], velocity[1], velocity[2]], density];
  }
}

function standardAirDensity(height: number): number {
  const [t, p] = standardAtmosphere(height);
  return p / (DRY_AIR_GAS_CONSTANT * t);
}

/**
 * A wing on a rigid body: a vortex lattice solved every step from the body's motion, the wing's flapping and the wind, its
 * load applied to the body. Separated panels take the quasi-steady flat-wing coefficients of Su et al.
 */
export class WingForce implements PhysicsAttachment, AirLoad {
  /** The wing's total aerodynamic force in the last step, N. */
  readonly force: [number, number, number] = [0, 0, 0];
  /** Its moment about the body's centre of mass in the last step, N m. */
  readonly torque: [number, number, number] = [0, 0, 0];
  /** Each panel's circulation in the last step, m^2/s, chord first then span from the left tip. */
  circulation: Float64Array = new Float64Array(0);
  private released = false;
  private readonly hold: AirHold;
  private readonly forward: Vec3;
  private readonly up: Vec3;
  private readonly side: Vec3;
  private readonly air: AirSampler;
  private readonly nc: number;
  private readonly perInterval: number;
  private kernel: WingLatticeKernel | null = null;
  private acceptedWork: WingLatticeWorkCounts | null = null;

  /**
   * Creates a wing and lazily loads the native SIMD lattice. Threads include the caller (default one).
   * More than one thread requires Node or an isolated browser worker. Abort before attachment with signal.
   */
  static async load(
    physics: Physics,
    body: PhysicsBody,
    options: WingOptions,
    native: { readonly threads?: number; readonly signal?: AbortSignal } = {},
  ): Promise<WingForce> {
    const { loadWingLattice } = await import('./flight/lattice-kernel.js');
    const kernel = await loadWingLattice(native);
    try {
      const wing = new WingForce(physics, body, options);
      wing.kernel = kernel;
      return wing;
    } catch (error) {
      kernel.close();
      throw error;
    }
  }

  /** Work performed during the last accepted native load, or null before stepping or when using the scalar constructor. */
  workCounts(): WingLatticeWorkCounts | null {
    return this.acceptedWork;
  }

  /** @throws MargoError for fewer than two sections, a chord or panel count out of range, or bad settings. */
  constructor(
    private readonly physics: Physics,
    private readonly body: PhysicsBody,
    private readonly options: WingOptions,
  ) {
    if (!options) throw flightInput('Wing settings are missing. Pass at least two wing sections.');
    const { sections, panels = [2, 4], stall = 0.26, wind = [0, 0, 0], density, profileDrag = PROFILE_DRAG } = options;
    if (!(profileDrag >= 0 && Number.isFinite(profileDrag)))
      throw flightInput(
        `A profile drag coefficient is 0 or more (got ${profileDrag}); pass a finite number, or leave it unset.`,
      );
    if (!(Array.isArray(sections) && sections.length >= 2))
      throw flightInput(`A wing has two or more sections from root to tip (got ${sections?.length}); pass them.`);
    for (const [i, s] of sections.entries()) {
      flightVector(s?.leadingEdge, `Section ${i}'s leading edge`);
      if (!(s.chord > 0 && Number.isFinite(s.chord)))
        throw flightInput(`Section ${i}'s chord is a finite number of metres above 0 (got ${s.chord}); pass one.`);
      if (s.twist !== undefined && !Number.isFinite(s.twist))
        throw flightInput(
          `Section ${i}'s twist is a finite number of radians (got ${s.twist}); pass one or leave it unset.`,
        );
    }
    if (
      !(Array.isArray(panels) && panels.length === 2 && panels.every((p) => Number.isInteger(p) && p >= 1 && p <= 32))
    )
      throw flightInput(
        `A wing's panels are two whole numbers from 1 to 32, [chordwise, spanwise] (got ${panels}); pass them.`,
      );
    if (!(stall > 0 && stall <= 1.5707963267948966))
      throw flightInput(
        `A stall angle lies in (0, pi/2] radians (got ${stall}); pass one in that range, or leave it unset.`,
      );
    if (options.separation !== undefined && options.separation !== 'plate' && options.separation !== 'flapping')
      throw flightInput(`A wing's separation is 'plate' or 'flapping' (got ${options.separation}); pass one of them.`);
    if (options.flap !== undefined && typeof options.flap !== 'function')
      throw flightInput(
        'A wing flap must return its stroke and pitch at the requested time. Pass a function or omit flap.',
      );
    if (options.mirror !== undefined && typeof options.mirror !== 'boolean')
      throw flightInput('The wing mirror setting must be a boolean. Pass true for a pair or false for a single wing.');
    this.forward = unit(options.forward ?? [0, 0, 1], 'The forward direction');
    this.up = unit(options.up ?? [0, 1, 0], 'The up direction');
    const side = crossOf(this.up, this.forward),
      length = hypot(side[0], side[1], side[2]);
    if (!(length > 1e-9))
      throw flightInput('The forward and up directions must not be parallel; pass two directions at right angles.');
    this.side = scale(side, 1 / length);
    this.air = new AirSampler(wind, density, options.frame);
    [this.nc, this.perInterval] = panels;
    this.hold = airHoldOf(physics);
    this.hold.loads.add(this);
    physics.attach(this);
  }

  /** The wing's corners in the body's frame at `time`: chord index fastest, then span from the left tip. */
  private geometry(time: number): { corners: Vec3[]; stations: number } {
    const { sections, mirror = true, flap } = this.options;
    const motion = flap ? flap(time) : {};
    if (!motion || typeof motion !== 'object')
      throw flightInput('Wing flap did not return a pose. Return an object with optional stroke and pitch angles.');
    const { stroke = 0, pitch = 0 } = motion;
    if (!(Number.isFinite(stroke) && Number.isFinite(pitch)))
      throw flightInput('The wing flap angles are not finite. Return finite stroke and pitch in radians.');
    const root = sections[0]!.leadingEdge;
    const half: Vec3[][] = [];
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

  /** @internal Stepped alone, the Physics's step computes the load; in a world, an `AirSolver` does. */
  beforeStep(dt: number): void {
    if (!this.hold.driven) this.load(dt);
  }

  /** @internal This step's load, held for the step. */
  load(dt: number): void {
    if (this.released) return;
    const body = this.body,
      time = this.hold.now(),
      { corners, stations } = this.geometry(time),
      nc = this.nc,
      ns = stations - 1,
      q = body.rotation,
      pos = body.position,
      com = body.centerOfMass,
      v0 = body.linearVelocity,
      w0 = body.angularVelocity,
      // Circulation and moment arms need relative geometry even when the body is far from the local origin.
      centred = corners.map((p) => rotateVec(q, sub(p, com))),
      comPosition = add(pos, rotateVec(q, com)),
      // The flapping's own velocity, by a central difference of the wing's shape over a tenth of a millisecond.
      h = 1e-4,
      moving = this.options.flap
        ? (() => {
            const ahead = this.geometry(time + h).corners,
              behind = this.geometry(time - h).corners;
            return ahead.map((p, i) => rotateVec(q, scale(sub(p, behind[i]!), 1 / (2 * h))));
          })()
        : undefined,
      corner = (c: number, s: number) => centred[c + (nc + 1) * s]!,
      air: Vec3[] = [],
      rho: number[] = [];
    for (let s = 0; s < ns; s++)
      for (let c = 0; c < nc; c++) {
        const p00 = corner(c, s),
          p10 = corner(c + 1, s),
          p01 = corner(c, s + 1),
          p11 = corner(c + 1, s + 1),
          normal = crossOf(sub(p11, p00), sub(p01, p10)),
          area = hypot(normal[0], normal[1], normal[2]);
        if (!(area > 0 && Number.isFinite(area)))
          throw flightRange(
            'A wing panel has zero or unrepresentable area. Separate its sections and use a finite planform.',
          );
        const mid = (k: number) => (p00[k]! + 0.75 * (p10[k]! - p00[k]!) + p01[k]! + 0.75 * (p11[k]! - p01[k]!)) / 2,
          [wind, density] = this.air.at(add(comPosition, [mid(0), mid(1), mid(2)]), time);
        air.push(wind);
        rho.push(density);
      }
    const separation = this.options.separation ?? (this.options.flap ? 'flapping' : 'plate'),
      law = separation === 'flapping' ? separatedWing : PLATE,
      stall = this.options.stall ?? 0.26;
    const profileDrag = this.options.profileDrag ?? PROFILE_DRAG;
    let circulation: Float64Array = new Float64Array(0);
    const kernel = this.kernel;
    kernel?.resetWork();
    const wrench: Wrench = (dv, dw) => {
      const v = add(v0, dv),
        w = add(w0, dw),
        velocity = centred.map((p, i): Vec3 => {
          const spin = crossOf(w, p),
            own = moving ? moving[i]! : ([0, 0, 0] as Vec3);
          return [v[0] + spin[0] + own[0], v[1] + spin[1] + own[1], v[2] + spin[2] + own[2]];
        }),
        vel = (a: number, b: number) => velocity[a + (nc + 1) * b]!,
        relative: Vec3[] = [];
      for (let s = 0; s < ns; s++)
        for (let c = 0; c < nc; c++) {
          const mean = scale(add(add(vel(c, s), vel(c + 1, s)), add(vel(c, s + 1), vel(c + 1, s + 1))), 0.25);
          const flow = sub(air[c + nc * s]!, mean);
          if (!Number.isFinite(dot(flow, flow)))
            throw flightRange('The wing relative speed is too large to square. Reduce the wind or flap speed.');
          relative.push(flow);
        }
      const loads = latticeLoads(
        { nc, ns, corner, relative, density: rho, profileDrag },
        stall,
        law,
        false,
        kernel ?? undefined,
      );
      if (dv[0] === 0 && dv[1] === 0 && dv[2] === 0 && dw[0] === 0 && dw[1] === 0 && dw[2] === 0)
        circulation = loads.circulation;
      let force: Vec3 = [0, 0, 0],
        torque: Vec3 = [0, 0, 0];
      for (let m = 0; m < loads.forces.length; m++) {
        const f = loads.forces[m]!;
        force = add(force, f);
        torque = add(torque, crossOf(loads.points[m]!, f));
      }
      checkWrench(force, torque);
      return [force, torque];
    };
    const [force, torque] = implicitWrench(body, wrench, dt, this.physics.gravity);
    checkWrench(force, torque);
    this.hold.hold(body, force, torque);
    this.acceptedWork = kernel?.workCounts() ?? null;
    this.circulation = circulation;
    [this.force[0], this.force[1], this.force[2]] = force;
    [this.torque[0], this.torque[1], this.torque[2]] = torque;
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.body) this.remove();
  }

  /** Stops the load and closes native worker resources. */
  remove(): void {
    if (this.released) return;
    this.dispose();
    this.physics.detach(this);
  }

  /** Removes it, as `remove()` does, so `using` releases it at the end of its scope. */
  [Symbol.dispose](): void {
    this.remove();
  }

  /** @internal */
  dispose(): void {
    this.released = true;
    this.hold.loads.delete(this);
    this.kernel?.close();
    this.kernel = null;
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
  /** Air density, kg/m^3 (default the flow field's, or the standard atmosphere's at the hub's local height). */
  density?: number;
  /** Body frame for a cell-based wind field. Default cell [0, 0, 0]. Use a getter for a moving world origin. */
  frame?: WindForceFrame;
}

/** A rotor or propeller on a rigid body: blade-element momentum theory every step; thrust along its axis, torque against it. */
export class RotorForce implements PhysicsAttachment, AirLoad {
  /** Thrust in the last step, N (along the axis; negative pulls the other way). */
  thrust = 0;
  /** Torque the air puts on the blades in the last step, N m (the body turns the other way). */
  torque = 0;
  /** Power the rotor gives the air in the last step, W. */
  power = 0;
  private released = false;
  private readonly hold: AirHold;
  private readonly axis: Vec3;
  private readonly air: AirSampler;

  /** @throws MargoError for a radius, blade count, chord, pitch or speed out of range. */
  constructor(
    private readonly physics: Physics,
    private readonly body: PhysicsBody,
    private readonly options: RotorOptions,
  ) {
    if (!options) throw flightInput('Rotor settings are missing. Pass radius, chord, pitch and speed.');
    const {
      radius,
      hubRadius = 0.1 * radius,
      blades = 2,
      stations = 16,
      liftSlope = TWO_PI,
      profileDrag = PROFILE_DRAG,
      stall = 0.26,
    } = options;
    if (!(radius > 0 && Number.isFinite(radius)))
      throw flightInput(`A rotor's radius is a finite number of metres above 0 (got ${radius}); pass one.`);
    if (!(hubRadius >= 0 && hubRadius < radius))
      throw flightInput(
        `A rotor's hub radius lies in [0, radius) (got ${hubRadius} for radius ${radius}); pass a smaller one.`,
      );
    if (!(Number.isInteger(blades) && blades >= 1 && blades <= 64))
      throw flightInput(`A rotor has 1 to 64 whole blades (got ${blades}); pass a whole number.`);
    if (!(Number.isInteger(stations) && stations >= 2 && stations <= 256))
      throw flightInput(`A rotor's stations are a whole number from 2 to 256 (got ${stations}); pass one.`);
    if (!(liftSlope > 0 && Number.isFinite(liftSlope) && profileDrag >= 0 && Number.isFinite(profileDrag)))
      throw flightInput('A rotor needs a finite lift slope above 0 and a profile drag of 0 or more; pass them.');
    if (!(stall > 0 && stall <= 1.5707963267948966))
      throw flightInput('The rotor stall threshold is outside (0, pi/2]. Pass an angle within that range in radians.');
    if (!(typeof options.chord === 'function' || (Number.isFinite(options.chord) && options.chord > 0)))
      throw flightInput('The rotor chord must be positive. Pass a chord in metres or a radial function.');
    if (!(typeof options.pitch === 'function' || Number.isFinite(options.pitch)))
      throw flightInput('The rotor pitch must be finite. Pass an angle in radians or a radial function.');
    if (!(typeof options.speed === 'function' || Number.isFinite(options.speed)))
      throw flightInput('The rotor speed must be finite. Pass a speed in rad/s or a time function.');
    this.axis = unit(options.axis ?? [0, 1, 0], "The rotor's axis");
    if (options.hub !== undefined) flightVector(options.hub, "The rotor's hub");
    this.air = new AirSampler(options.wind ?? [0, 0, 0], options.density, options.frame);
    this.hold = airHoldOf(physics);
    this.hold.loads.add(this);
    physics.attach(this);
  }

  /** Thrust, torque and power at speed `omega` rad/s with the air meeting the disk at `inflow` m/s along the axis, density `rho`. */
  evaluate(omega: number, inflow: number, rho: number): { thrust: number; torque: number; power: number } {
    if (!(Number.isFinite(omega) && Number.isFinite(inflow) && rho > 0 && Number.isFinite(rho)))
      throw flightInput(
        'The rotor needs finite speed and inflow and positive finite density. Pass rad/s, m/s and kg/m³.',
      );
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
      dr = (radius - hubRadius) / stations,
      reach = spin * radius + Math.abs(inflow) + 1;
    if (!(dr > 0 && Number.isFinite(reach)))
      throw flightRange('The annulus spacing or tip speed is unrepresentable. Rescale the rotor or reduce its speed.');
    let thrust = 0,
      torque = 0;
    for (let k = 0; k < stations; k++) {
      const r = hubRadius + (k + 0.5) * dr,
        c = chordAt(r),
        theta = pitchAt(r);
      if (!(c > 0 && Number.isFinite(c) && Number.isFinite(theta)))
        throw flightInput(
          'A blade station returned invalid chord or pitch. Return a positive finite chord and a finite pitch.',
        );
      // Blade-element thrust minus the momentum the annulus gives the air, for an induced velocity v_i.
      const element = (vi: number): [number, number, number] => {
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
        const residual = dT - FOUR_PI * rho * r * dr * (axial < 0 ? -axial : axial) * vi;
        if (!(Number.isFinite(residual) && Number.isFinite(dT) && Number.isFinite(dQ)))
          throw flightRange(
            'The blade load or momentum is unrepresentable. Reduce tip speed, inflow, density or blade size.',
          );
        return [residual, dT, dQ];
      };
      // The induced velocity solves element(v_i)[0] = 0, which falls as v_i rises: bisect it within the tip speed and the inflow.
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
    const power = torque * spin;
    if (!(Number.isFinite(thrust) && Number.isFinite(torque) && Number.isFinite(power)))
      throw flightRange('The integrated rotor load exceeds numerical range. Reduce tip speed, density or blade area.');
    return { thrust, torque: omega < 0 ? -torque : torque, power };
  }

  /** @internal Stepped alone, the Physics's step computes the load; in a world, an `AirSolver` does. */
  beforeStep(dt: number): void {
    if (!this.hold.driven) this.load(dt);
  }

  /** @internal This step's load, held for the step. */
  load(dt: number): void {
    if (this.released) return;
    const body = this.body,
      time = this.hold.now(),
      q = body.rotation,
      axis = rotateVec(q, this.axis),
      hubLocal = this.options.hub ?? [0, 0, 0],
      hub = add(body.position, rotateVec(q, hubLocal)),
      lever = rotateVec(q, sub(hubLocal, body.centerOfMass)),
      omega = typeof this.options.speed === 'function' ? this.options.speed(time) : this.options.speed;
    if (!Number.isFinite(omega))
      throw flightInput(`A rotor's speed is a finite number of rad/s (got ${omega}); pass one.`);
    const [air, rho] = this.air.at(hub, time),
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
    const moment = add(pushMoment, scale(axis, -torque));
    checkWrench(force, moment);
    this.hold.hold(body, force, moment);
    this.thrust = thrust;
    this.torque = torque;
    this.power = power;
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.body) this.remove();
  }

  /** Stops the rotor's load. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.hold.loads.delete(this);
    this.physics.detach(this);
  }

  /** Removes it, as `remove()` does, so `using` releases it at the end of its scope. */
  [Symbol.dispose](): void {
    this.remove();
  }

  /** @internal */
  dispose(): void {
    this.released = true;
    this.hold.loads.delete(this);
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
export class LiftingGas implements PhysicsAttachment, AirLoad {
  /** The net lift in the last step, N. */
  lift = 0;
  private released = false;
  private readonly hold: AirHold;

  /** @throws MargoError for a volume or temperature that is not finite and above 0, or an unknown gas. */
  constructor(
    private readonly physics: Physics,
    private readonly body: PhysicsBody,
    private readonly options: LiftingGasOptions,
  ) {
    if (!options) throw flightInput('Lifting gas settings are missing. Pass an envelope volume.');
    const { volume, gas = 'helium', temperature = 373.15, altitude = 0, seaLevelTemperature } = options;
    if (!Number.isFinite(altitude))
      throw flightInput('The envelope reference altitude is not finite. Pass metres above sea level.');
    if (seaLevelTemperature !== undefined && !(seaLevelTemperature > 0 && Number.isFinite(seaLevelTemperature)))
      throw flightInput(
        'The sea-level temperature is invalid. Pass positive finite kelvin or omit seaLevelTemperature.',
      );
    if (!(volume > 0 && Number.isFinite(volume)))
      throw flightInput(`An envelope's volume is a finite number of m^3 above 0 (got ${volume}); pass one.`);
    if (gas !== 'helium' && gas !== 'hydrogen' && gas !== 'hotAir')
      throw flightInput(`A lifting gas is 'helium', 'hydrogen' or 'hotAir' (got ${gas}); pass one of them.`);
    if (!(temperature > 0 && Number.isFinite(temperature)))
      throw flightInput(`Hot air's temperature is a finite number of kelvin above 0 (got ${temperature}); pass one.`);
    if (options.centre !== undefined) flightVector(options.centre, "The envelope's centre");
    this.hold = airHoldOf(physics);
    this.hold.loads.add(this);
    physics.attach(this);
  }

  /** The net lift, N, of the envelope at `height` m (y) under gravity `g` m/s^2. */
  liftAt(height: number, g: number): number {
    if (!(Number.isFinite(height) && Number.isFinite(g) && g >= 0))
      throw flightInput('Envelope height and gravity must be finite and gravity nonnegative. Pass metres and m/s².');
    if (g === 0) return 0;
    const { volume, gas = 'helium', temperature = 373.15, altitude = 0, seaLevelTemperature } = this.options;
    const elevation = altitude + height;
    if (!Number.isFinite(elevation))
      throw flightRange('Envelope altitude is unrepresentable. Reduce the reference altitude or height.');
    const [t, p] = standardAtmosphere(elevation, seaLevelTemperature);
    if (!(t > 0 && Number.isFinite(t) && p >= 0 && Number.isFinite(p)))
      throw flightRange(
        'The atmosphere cannot be evaluated at this altitude and temperature. Use an Earth-like profile.',
      );
    const air = p / (DRY_AIR_GAS_CONSTANT * t),
      inside =
        gas === 'hotAir' ? p / (DRY_AIR_GAS_CONSTANT * temperature) : (p * GASES[gas]) / (UNIVERSAL_GAS_CONSTANT * t);
    const lift = (air - inside) * volume * g;
    if (!Number.isFinite(lift))
      throw flightRange('Envelope lift is unrepresentable. Reduce volume or gravity or use a warmer atmosphere.');
    return lift;
  }

  /** @internal Stepped alone, the Physics's step computes the load; in a world, an `AirSolver` does. */
  beforeStep(dt: number): void {
    if (!this.hold.driven) this.load(dt);
  }

  /** @internal This step's buoyancy, held for the step. */
  load(_dt: number): void {
    if (this.released) return;
    const body = this.body,
      gravity = this.physics.gravity,
      g = hypot(gravity[0], gravity[1], gravity[2]);
    if (!(g > 0)) {
      this.lift = 0;
      return;
    }
    const q = body.rotation,
      centre = this.options.centre ?? [0, 0, 0],
      height = body.position[1] + rotateVec(q, centre)[1],
      lift = this.liftAt(height, g),
      up = scale([gravity[0] / g, gravity[1] / g, gravity[2] / g], -lift),
      moment = crossOf(rotateVec(q, sub(centre, body.centerOfMass)), up);
    checkWrench(up, moment);
    this.hold.hold(body, up, moment);
    this.lift = lift;
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.body) this.remove();
  }

  /** Stops the buoyancy. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.hold.loads.delete(this);
    this.physics.detach(this);
  }

  /** Removes it, as `remove()` does, so `using` releases it at the end of its scope. */
  [Symbol.dispose](): void {
    this.remove();
  }

  /** @internal */
  dispose(): void {
    this.released = true;
    this.hold.loads.delete(this);
  }
}
