// The sea against a vertical quay wall (SEA-12): the standing wave in front of it and the pressure the wall feels, the
// run-up it reaches and a ship's wash against it.
// - The linear standing wave at a wall, eta = H cos(kx) cos(omega t) and p = -rho g z + rho g H cosh(k(z + d)) / cosh(kd) cos(omega
//   t) (DNV-RP-C205 2010, 3.4.4, read).
// - Sainflou's wall pressures under the crest and trough of a non-breaking, fully reflected wave, and its crest H + delta_0
//   above still water (USACE Coastal Engineering Manual, EM 1110-2-1100, table VI-5-52, read).
// - Goda's (1974) design pressures with Tanimoto et al.'s (1976) factors for a plain vertical wall (CEM table VI-5-53 and Y.
//   Goda, "New wave pressure formulae for composite breakwaters", Proc. 14th ICCE, 1974, eqs. 1 to 8, read).
// - A ship's wash on the bed at the wall: the efflux of a bow thruster 1.17 (P / (rho D^2))^0.33 and the Dutch method's bed
//   velocity (Blokland 1996), as PIANC report 180 (2015) gives them through F. Tukker's TU Delft thesis (2021, sections 2.2 and
//   2.3, read); its efflux written 1.17 (P / (rho D^2))^0.33.
import { invalidLoad } from './errors.js';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { exp, pow } from '@margoengine/math/pinned';
import { wavenumber } from '../waves/spectral.js';

const TWO_PI = 6.283185307179586;

function cosh(x: number): number {
  const e = exp(x);
  return (e + 1 / e) / 2;
}
function sinh(x: number): number {
  const e = exp(x);
  return (e - 1 / e) / 2;
}
function check(height: number, period: number, depth: number): void {
  if (!(height > 0 && period > 0 && depth > 0 && Number.isFinite(height + period + depth)))
    throw invalidLoad(
      `A wave at a wall has a height, period and still-water depth, finite and above 0 (got ${height} m, ${period} s, ${depth} m); pass them.`,
    );
}

/** The standing wave at a wall for an incident wave of height H: wavenumber, amplitude at the wall, dynamic pressure at height z (<= 0) and the force per metre below still water. */
export function standingWave(
  height: number,
  period: number,
  depth: number,
  options: { readonly density?: number; readonly gravity?: number } = {},
): { wavenumber: number; amplitude: number; pressure: (z: number) => number; force: number } {
  check(height, period, depth);
  const g = options.gravity ?? gravityMagnitude(DEFAULT_GRAVITY),
    rho = options.density ?? 1025,
    k = wavenumber(1 / period, depth, g),
    kd = k * depth,
    tanh = (exp(2 * kd) - 1) / (exp(2 * kd) + 1);
  return {
    wavenumber: k,
    amplitude: height,
    pressure: (z: number) => (rho * g * height * cosh(k * (z + depth))) / cosh(kd),
    force: (rho * g * height * tanh) / k,
  };
}

/** Sainflou's wall pressures (Pa) under the crest at still water (p1) and the base (p2), under the trough (p3), and the crest's rise delta_0, m. */
export function sainflou(
  height: number,
  period: number,
  depth: number,
  options: { readonly density?: number; readonly gravity?: number } = {},
): { p1: number; p2: number; p3: number; rise: number; crest: number } {
  check(height, period, depth);
  const g = options.gravity ?? gravityMagnitude(DEFAULT_GRAVITY),
    rho = options.density ?? 1025,
    L = TWO_PI / wavenumber(1 / period, depth, g),
    q = (TWO_PI * depth) / L,
    coth = cosh(q) / sinh(q),
    rise = ((Math.PI * height * height) / L) * coth,
    p2 = (rho * g * height) / cosh(q),
    p1 = ((p2 + rho * g * depth) * (height + rise)) / (depth + height + rise),
    p3 = rho * g * (height - rise);
  return { p1, p2, p3, rise, crest: height + rise };
}

/**
 * Goda's design pressures on a plain vertical wall (no mound, head-on, lambda = 1) for design height H_D and period T in depth
 * h_s: alpha_1, alpha_3, p1 at still water, p3 at the base, the wave's reach 1.5 H_D (Goda 1974) and the force per metre.
 */
export function goda(
  design: number,
  period: number,
  depth: number,
  options: { readonly density?: number; readonly gravity?: number; readonly freeboard?: number } = {},
): { alpha1: number; alpha3: number; p1: number; p3: number; reach: number; force: number } {
  check(design, period, depth);
  const g = options.gravity ?? gravityMagnitude(DEFAULT_GRAVITY),
    rho = options.density ?? 1025,
    L = TWO_PI / wavenumber(1 / period, depth, g),
    x = (4 * Math.PI * depth) / L,
    ratio = x / sinh(x),
    alpha1 = 0.6 + 0.5 * ratio * ratio,
    alpha3 = 1 - 1 + 1 / cosh((TWO_PI * depth) / L),
    p1 = alpha1 * rho * g * design,
    p3 = alpha3 * p1,
    reach = 1.5 * design,
    top = Math.min(options.freeboard ?? reach, reach),
    p2 = top < reach ? (1 - top / reach) * p1 : 0,
    force = 0.5 * (p1 + p3) * depth + 0.5 * (p1 + p2) * top;
  return { alpha1, alpha3, p1, p3, reach, force };
}

/** A bow thruster's efflux speed 1.17 (P / (rho D^2))^0.33, m/s, for power `power` W through a tunnel `diameter` m (PIANC 2015, its exponent as printed). */
export function thrusterEfflux(power: number, diameter: number, density = 1025): number {
  if (!(power >= 0 && diameter > 0))
    throw invalidLoad(
      `A thruster has power 0 W or more and a tunnel above 0 m (got ${power}, ${diameter}); pass them.`,
    );
  return 1.17 * pow(power / (density * diameter * diameter), 0.33);
}

/**
 * The bed velocity at a quay wall under a thruster's jet (Dutch method, Blokland 1996, as PIANC 2015 gives it): V_0 D / h
 * when the wall is nearer than 1.8 h (L / h < 1.8), else 2.8 V_0 D / (L + h), for the jet's efflux V_0, tunnel diameter D,
 * distance to the wall L and the tunnel axis's height above the bed h. An upper bound: field data run about a quarter of it.
 */
export function washOnBed(efflux: number, diameter: number, distance: number, height: number): number {
  if (!(efflux >= 0 && diameter > 0 && distance >= 0 && height > 0))
    throw invalidLoad(
      'Wash on the bed takes an efflux 0 or more, a diameter and height above 0, and a distance 0 or more; pass them.',
    );
  return distance / height < 1.8 ? (efflux * diameter) / height : (2.8 * efflux * diameter) / (distance + height);
}

/** A point along a quay wall: where it is, the water's height there with the reflection, the wash against the face, a splash. */
export interface QuayPoint {
  position: [number, number];
  /** The water's height at the face, m: the incident surface times 1 + R (the standing wave's antinode at the wall). */
  height: number;
  /** The water's speed toward the face, m/s (the wash a race or a current drives at it; 0 when it moves away). */
  wash: number;
  /** Whether the water tops the quay's edge here (a splash over it). */
  over: boolean;
}

/**
 * A vertical quay wall along `from` to `to` [x, z] m, its edge `freeboard` m above still water, reflecting the waves that
 * reach it with coefficient `reflection` (default 1, a vertical wall): sampled at `points` along it, the incident surface (a
 * SeaSurface, a WakeSolver or any `{elevation}` or `{sample(x, z).height}`) doubles at its face as the linear standing wave
 * does (DNV-RP-C205 3.4.4), and a flow (a ship's race, a current) gives the wash against it.
 */
export class QuayWall {
  readonly from: [number, number];
  readonly to: [number, number];
  readonly freeboard: number;
  readonly reflection: number;
  private readonly points: number;

  constructor(options: {
    readonly from: readonly [number, number];
    readonly to: readonly [number, number];
    readonly freeboard: number;
    readonly reflection?: number;
    readonly points?: number;
  }) {
    const { from, to, freeboard, reflection = 1, points = 32 } = options ?? ({} as never);
    if (
      !(
        from?.length === 2 &&
        to?.length === 2 &&
        [...from, ...to].every(Number.isFinite) &&
        (from[0] !== to[0] || from[1] !== to[1])
      )
    )
      throw invalidLoad(
        'A quay wall runs {from: [x, z], to: [x, z]} between two different points in metres; pass them.',
      );
    if (!(freeboard >= 0 && Number.isFinite(freeboard)))
      throw invalidLoad(
        `A quay's edge stands finite metres, 0 or more, above still water (got ${freeboard}); pass one.`,
      );
    if (!(reflection >= 0 && reflection <= 1))
      throw invalidLoad(
        `A reflection coefficient lies in [0, 1] (got ${reflection}); pass one, or 1 for a vertical wall.`,
      );
    if (!(Number.isInteger(points) && points >= 2 && points <= 4096))
      throw invalidLoad(`A wall is sampled at 2 to 4096 points (got ${points}); pass a whole number.`);
    this.from = [from[0], from[1]];
    this.to = [to[0], to[1]];
    this.freeboard = freeboard;
    this.reflection = reflection;
    this.points = points;
  }

  /**
   * The wall's state at time `t`: `surface` the incident sea (elevation(x, z, t), or sample(x, z) with a height), `flow` an
   * optional water flow (velocity at (x, y, z, t)) whose speed into the face is the wash, sampled at still water.
   */
  sample(
    t: number,
    surface:
      | { elevation(x: number, z: number, t: number): number }
      | { sample(x: number, z: number): { readonly height: number } },
    flow?: { sample(x: number, y: number, z: number, t: number): { readonly velocity: readonly number[] } },
  ): QuayPoint[] {
    const [ax, az] = this.from,
      [bx, bz] = this.to,
      length = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az)),
      // The face's normal toward the water: to the left walking from `from` to `to`.
      nx = -(bz - az) / length,
      nz = (bx - ax) / length,
      out: QuayPoint[] = [];
    for (let i = 0; i < this.points; i++) {
      const s = (i + 0.5) / this.points,
        x = ax + s * (bx - ax),
        z = az + s * (bz - az),
        incident =
          'elevation' in surface
            ? surface.elevation(x, z, t)
            : (surface as { sample(x: number, z: number): { height: number } }).sample(x, z).height,
        height = (1 + this.reflection) * incident,
        v = flow?.sample(x + nx * 0.5, 0, z + nz * 0.5, t).velocity,
        wash = v ? Math.max(0, -(v[0]! * nx + v[2]! * nz)) : 0;
      out.push({ position: [x, z], height, wash, over: height > this.freeboard });
    }
    return out;
  }
}
