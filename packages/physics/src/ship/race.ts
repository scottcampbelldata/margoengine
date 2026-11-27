// A propeller's race resolved (SEA-09): the swirl the torque puts into it, the tip and hub vortices its blades shed, the jet
// a rudder turns, the cavitation in the vortex cores and the air it carries off, as a velocity field and sources for the foam
// and bubbles. A fast analytic tier on top of the axial race of propeller.ts.
// Written from (papers and public documents only; no code read):
// - Swirl from the torque: momentum and vortex theory, the blades' bound circulation shed so that r u_theta = Z Gamma / (2 pi)
//   is carried along a stream surface (Kelvin), Z Gamma from Q = rho Z Gamma (V + u_a)(R^2 - r_h^2) / 2 with constant loading.
//   The torque gives the circulation within 4 percent of a boundary-element value where the thrust gives it 21 percent low
//   (J. Pennings, "Dynamics of vortex cavitation", TU Delft thesis, 2016, its measured propeller, read). In the established
//   jet the swirl's peak falls as x^-2 while the axial speed's falls as x^-1 (the swirling jet's similarity; P. Kumar and K.
//   Mahesh, "Large eddy simulation of propeller wake instabilities", J. Fluid Mech. 814, 2017, read: the far wake is a
//   swirling column whose swirl keeps falling).
// - The slipstream's contraction (R_w / R)^2 = (V + u_a) / (V + 2 u_a) and the tip vortices' helix, pitch (V + u_a) / n, each
//   of the blade's circulation with a Lamb-Oseen core u = Gamma / (2 pi r) (1 - exp(-r^2 / a^2)), coherent to 0.8 D and gone by
//   1.5 D (Kumar and Mahesh 2017, read), the hub vortex of strength -Z Gamma (the Joukowski model, as they state it).
// - Cavitation: the cavitation number sigma_n = (p - p_v) / (1/2 rho (n D)^2); a Lamb-Oseen core's pressure deficit ln 2 rho
//   Gamma^2 / (4 pi^2 a^2), so a vortex cavitates when its core falls to the vapour pressure, the cavity's radius where the
//   core's pressure meets it (Pennings 2016, eqs. 2.3 and 2.4, read); hysteresis: in air-saturated water a tip-vortex cavity
//   that formed at sigma 1.7 persists to 4.0, filled with gas (A. Amini et al., "On the physical mechanism of tip vortex
//   cavitation hysteresis", Exp. Fluids 60, 2019, read).
// - The rudder jet: the rudder's side force turns the race by its momentum, tan phi = F / (rho A_w V_w^2).
import { cos, exp, sin } from '@margoengine/math/pinned';
import { atan2, type PropellerRace, raceVelocity } from './propeller.js';
import { shipError } from './errors.js';

const PI = 3.141592653589793;
const LN2 = 0.6931471805599453;
/** Where the tip vortices go unstable, in diameters downstream (Kumar and Mahesh 2017), and where they are gone. */
export const TIP_VORTEX_STABLE = 0.8;
export const TIP_VORTEX_GONE = 1.5;
/** Water's vapour pressure at 15 degrees C, Pa. */
export const VAPOUR_PRESSURE = 1705;

/** A propeller's working race, resolved: what {@link resolvedRace} needs on top of the axial race. */
export interface ResolvedRace extends PropellerRace {
  /** Blades. */
  readonly blades: number;
  /** Revolutions, rev/s (its sign the sense of rotation: positive turns clockwise seen from astern, a right-handed screw ahead). */
  readonly revolutions: number;
  /** Torque, N m, and thrust, N, on the shaft. */
  readonly torque: number;
  readonly thrust: number;
  /** The water's speed into the propeller, m/s. */
  readonly inflow: number;
  /** The shaft's up direction (default +Y), so the swirl's sense is fixed in the world. */
  readonly up?: readonly [number, number, number];
  /** The tip vortex's core radius, m (default 0.02 of the diameter). */
  readonly core?: number;
  /** A rudder behind it: its distance aft of the propeller, m, and the side force it takes, N (along the world's starboard). */
  readonly rudder?: { readonly distance: number; readonly force: readonly [number, number, number] };
  readonly density?: number;
}

/** The race's derived numbers: its circulation per blade, contraction, helix pitch, disc speed and rudder turn. */
export interface RaceNumbers {
  /** Each blade's bound circulation, m^2/s, from the torque. */
  circulation: number;
  /** The slipstream's radius over the propeller's. */
  contraction: number;
  /** The helix's advance per revolution, m. */
  pitch: number;
  /** The water's speed through the disc, V + u_a, m/s. */
  disc: number;
  /** The jet's turn behind the rudder, rad (toward the side the rudder pushes the water). */
  turn: number;
}

/** The race's derived numbers (momentum and vortex theory). */
export function raceNumbers(race: ResolvedRace): RaceNumbers {
  const D = race.diameter,
    R = D / 2,
    rho = race.density ?? 1025,
    xh = (race.hub ?? 0.18 * D) / D,
    V = Math.max(0, race.inflow),
    far = V + race.efflux,
    // u_a is half the far wake's induced speed.
    disc = V + race.efflux / 2,
    contraction = far > 0 ? Math.sqrt(disc / far) : Math.SQRT1_2,
    circulation =
      disc > 0 && race.blades > 0
        ? (2 * Math.abs(race.torque)) / (rho * race.blades * disc * R * R * (1 - xh * xh))
        : 0,
    n = Math.abs(race.revolutions),
    pitch = n > 0 ? disc / n : 0;
  let turn = 0;
  if (race.rudder) {
    const f = race.rudder.force,
      side = Math.sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]),
      area = PI * contraction * contraction * R * R,
      momentum = rho * area * far * far;
    turn = momentum > 0 ? atan2(side, momentum) : 0;
  }
  return { circulation, contraction, pitch, disc, turn };
}

/**
 * The resolved race's velocity at a point, m/s: the axial race (propeller.ts), its swirl about the shaft, the tip vortices'
 * helices while they hold and the hub vortex, all turned by the rudder's jet past the rudder. Writes into `out`.
 */
export function resolvedRace(
  race: ResolvedRace,
  point: readonly [number, number, number],
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const numbers = raceNumbers(race),
    D = race.diameter,
    R = D / 2,
    [px, py, pz] = race.position;
  let dir = race.direction as readonly [number, number, number],
    p: readonly [number, number, number] = point;
  // Past the rudder the jet runs turned: sample the unturned race at the point turned back about the rudder.
  if (race.rudder && numbers.turn > 0) {
    const along = (point[0] - px) * dir[0] + (point[1] - py) * dir[1] + (point[2] - pz) * dir[2];
    if (along > race.rudder.distance) {
      const f = race.rudder.force,
        fl = Math.sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]),
        // The water is pushed opposite the force on the rudder.
        side = [-f[0] / fl, -f[1] / fl, -f[2] / fl],
        c = cos(numbers.turn),
        s = sin(numbers.turn),
        pivot = [
          px + dir[0] * race.rudder.distance,
          py + dir[1] * race.rudder.distance,
          pz + dir[2] * race.rudder.distance,
        ],
        rel = [point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]],
        a = rel[0] * dir[0] + rel[1] * dir[1] + rel[2] * dir[2],
        b = rel[0] * side[0]! + rel[1] * side[1]! + rel[2] * side[2]!;
      // Turn the point back by -turn in the (dir, side) plane.
      const a2 = c * a + s * b,
        b2 = -s * a + c * b;
      p = [
        pivot[0] + rel[0] + (a2 - a) * dir[0] + (b2 - b) * side[0]!,
        pivot[1] + rel[1] + (a2 - a) * dir[1] + (b2 - b) * side[1]!,
        pivot[2] + rel[2] + (a2 - a) * dir[2] + (b2 - b) * side[2]!,
      ];
      const v = resolvedRace({ ...race, rudder: undefined }, p, [0, 0, 0]);
      // And turn the velocity forward.
      const va = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2],
        vb = v[0] * side[0]! + v[1] * side[1]! + v[2] * side[2]!,
        na = c * va - s * vb,
        nb = s * va + c * vb;
      out[0] = v[0] + (na - va) * dir[0] + (nb - vb) * side[0]!;
      out[1] = v[1] + (na - va) * dir[1] + (nb - vb) * side[1]!;
      out[2] = v[2] + (na - va) * dir[2] + (nb - vb) * side[2]!;
      return out;
    }
    dir = race.direction;
  }
  raceVelocity(race, p, out);
  const rx = p[0] - px,
    ry = p[1] - py,
    rz = p[2] - pz,
    X = rx * dir[0] + ry * dir[1] + rz * dir[2];
  if (!(X > 0) || numbers.circulation === 0) return out;
  const ax = rx - X * dir[0],
    ay = ry - X * dir[1],
    az = rz - X * dir[2],
    r = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(r > 1e-9)) return out;
  // The swirl's sense: the water turns with the blades. A right-handed screw turning ahead turns clockwise seen from astern,
  // looking forward along -direction: a negative turn about `direction` (the way the race leaves).
  const sense = race.revolutions >= 0 ? -1 : 1,
    // Tangential unit: direction x radial.
    tx = (dir[1] * az - dir[2] * ay) / r,
    ty = (dir[2] * ax - dir[0] * az) / r,
    tz = (dir[0] * ay - dir[1] * ax) / r,
    total = race.blades * numbers.circulation,
    xd = X / D,
    // The race's radius: contracted near the propeller, spreading with the established jet (e-folding X / sqrt 22.2).
    width = xd <= 3.25 ? numbers.contraction * R + 0.075 * Math.max(0, X - D / 2) : X / Math.sqrt(22.2),
    hubCore = 0.5 * (race.hub ?? 0.18 * D) * 0.5 + 0.02 * D,
    inside = r < width ? 1 : exp(-((r - width) * (r - width)) / (0.25 * width * width)),
    decay = xd <= 3.25 ? 1 : (3.25 / xd) * (3.25 / xd);
  let swirl = (total / (2 * PI * r)) * (1 - exp(-(r * r) / (hubCore * hubCore))) * inside * decay;
  // The tip vortices while they hold: each a Lamb-Oseen core about its helix, fading from 0.8 D to 1.5 D.
  if (xd < TIP_VORTEX_GONE && numbers.pitch > 0) {
    const fade = xd <= TIP_VORTEX_STABLE ? 1 : 1 - (xd - TIP_VORTEX_STABLE) / (TIP_VORTEX_GONE - TIP_VORTEX_STABLE),
      Rw = numbers.contraction * R,
      a = race.core ?? 0.02 * D,
      // The point's angle about the shaft, measured in a frame fixed by `up`.
      up = race.up ?? [0, 1, 0],
      e1 = normalise([up[0] - dir[0] * dot(up, dir), up[1] - dir[1] * dot(up, dir), up[2] - dir[2] * dot(up, dir)]),
      e2 = [dir[1] * e1[2] - dir[2] * e1[1], dir[2] * e1[0] - dir[0] * e1[2], dir[0] * e1[1] - dir[1] * e1[0]],
      theta = atan2(ax * e2[0]! + ay * e2[1]! + az * e2[2]!, ax * e1[0] + ay * e1[1] + az * e1[2]),
      // The helices' phase at this distance: each blade's vortex turns 2 pi per pitch.
      phase = (sense * 2 * PI * X) / numbers.pitch;
    let near = Number.POSITIVE_INFINITY;
    for (let k = 0; k < race.blades; k++) {
      let d = theta - phase - (2 * PI * k) / race.blades;
      d -= 2 * PI * Math.round(d / (2 * PI));
      const arc = Rw * d,
        radial = r - Rw,
        dist = Math.sqrt(arc * arc + radial * radial);
      if (dist < near) near = dist;
    }
    // The nearest core's swirl about itself. The tip vortices turn against the hub vortex (together they cancel the swirl
    // outside the slipstream), so each adds to the swirl on its inner side and takes from it on its outer.
    const tip = (numbers.circulation / (2 * PI * Math.max(near, 1e-9))) * (1 - exp(-(near * near) / (a * a))) * fade;
    swirl += r < Rw ? tip : -tip;
  }
  swirl *= sense;
  out[0] += swirl * tx;
  out[1] += swirl * ty;
  out[2] += swirl * tz;
  return out;
}

/** A Lamb-Oseen vortex's core pressure deficit ln 2 rho Gamma^2 / (4 pi^2 a^2), Pa. */
export function coreDeficit(circulation: number, core: number, density = 1025): number {
  return (LN2 * density * circulation * circulation) / (4 * PI * PI * core * core);
}

/** The inception cavitation index of a Lamb-Oseen vortex of circulation Gamma and core a in a flow of speed W: 2 ln 2 (Gamma / (2 pi a W))^2. */
export function inceptionIndex(circulation: number, core: number, speed: number): number {
  const q = circulation / (2 * PI * core * speed);
  return 2 * LN2 * q * q;
}

/** The radius of the vapour cavity in a Lamb-Oseen core where the pressure falls to `vapour`, m (0 when it does not). */
export function cavityRadius(
  circulation: number,
  core: number,
  ambient: number,
  vapour = VAPOUR_PRESSURE,
  density = 1025,
): number {
  // p(r) = p_inf - rho int_r^inf u^2 / s ds; bisect p(r) = p_v on (0, 10 a).
  const deficit = (r: number) => {
    let sum = 0;
    const top = 12 * core,
      n = 400,
      h = (top - r) / n;
    for (let k = 0; k <= n; k++) {
      const s = r + k * h,
        u = (circulation / (2 * PI * s)) * (1 - exp(-(s * s) / (core * core))),
        w = k === 0 || k === n ? 1 : k % 2 ? 4 : 2;
      sum += (w * u * u) / s;
    }
    // Beyond 12 a the vortex is potential: int u^2 / s = Gamma^2 / (8 pi^2 s^2).
    return density * ((sum * h) / 3 + (circulation * circulation) / (8 * PI * PI * top * top));
  };
  if (ambient - coreDeficit(circulation, core, density) >= vapour) return 0;
  let lo = 1e-6 * core,
    hi = 10 * core;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ambient - deficit(mid) < vapour) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * A tip-vortex cavity's state over time, with hysteresis: it forms when sigma falls to inception, and in gassy water it
 * persists, filled with gas, until sigma rises past desinence, about 4.0 / 1.7 times inception in air-saturated water and the
 * same in degassed water (Amini et al. 2019). `gas` is the water's saturation, 0 to 1 (default 1).
 */
export class VortexCavity {
  private on = false;
  constructor(private readonly gas = 1) {
    if (!(gas >= 0 && gas <= 1))
      throw shipError(`A gas saturation lies in [0, 1] (got ${gas}); pass one, 1 for harbour water.`);
  }
  /** Updates with the flow's sigma against the vortex's inception index; returns whether a cavity stands. */
  update(sigma: number, inception: number): boolean {
    const desinence = inception * (1 + this.gas * (4.0 / 1.7 - 1));
    if (!this.on && sigma <= inception) this.on = true;
    else if (this.on && sigma > desinence) this.on = false;
    return this.on;
  }
  get cavitating(): boolean {
    return this.on;
  }
}

/** Rayleigh's collapse time of a vapour bubble of radius R0 under a pressure difference dp: 0.915 R0 sqrt(rho / dp), s. */
export function collapseTime(radius: number, difference: number, density = 1025): number {
  return 0.915 * radius * Math.sqrt(density / difference);
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function normalise(a: [number, number, number]): [number, number, number] {
  const l = Math.sqrt(dot(a, a)) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
