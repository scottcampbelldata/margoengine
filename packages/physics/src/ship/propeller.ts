// A ship's propeller (SEA-09): its open-water thrust and torque in all four quadrants, the momentum it puts into its race, and
// the race as a velocity field behind it, for the rudder, the foam, the bubbles and the bed.
//
// Written from (papers only; no code read):
// - Open water: K_T = T / (rho n^2 D^4), K_Q = Q / (rho n^2 D^5), J = V_a / (n D), eta_0 = J K_T / (2 pi K_Q) (MIT 2.016
//   notes; Holtrop and Mennen 1982); the quadratic K_T(J) of the MMG standard method (H. Yasukawa and Y. Yoshimura, J. Mar.
//   Sci. Technol. 20, 2015, eq. 10, read), its KVLCC2 propeller the default.
// - The four quadrants: T = 1/2 rho c_T(beta) (V_a^2 + (0.7 pi n D)^2) pi D^2 / 4, beta = atan2(V_a, 0.7 pi n D), with the
//   lift and drag idealisation c_L = c_Lmax sin 2 alpha, c_D = c_Dmax (1 - cos 2 alpha) / 2, alpha = phi - beta, c_T = c_L cos
//   beta - c_D sin beta (A. Haeusler, A. Saccon, A. Pascoal, J. Hauser and A. Aguiar, "Four-quadrant propeller modeling",
//   2015, after Healey et al. 1995, read), its two constants fitted so the first quadrant meets the quadratic at bollard
//   pull and at zero thrust.
// - The race: Rankine-Froude momentum theory (the far-wake speed V_a sqrt(1 + 8 K_T / (pi J^2)), the efflux 1.59 n D sqrt(K_T)
//   of Blaauw and van de Kaa 1978) and the jet's zones as G. A. Hamill and C. Kee, "Predicting axial velocity profiles within
//   a diffusing marine propeller jet", Ocean Engineering 124, 2016 (eqs. 7 to 20, read) and G. A. Hamill and J. A. McGarvey,
//   1996, restate them: the zone of flow establishment to X0 = 3.25 D with its ring-shaped profile (Berger et al. 1981) and
//   V_max / V_0 = 1.51 - 0.175 X / D - 0.46 P / D, then the established jet with V_max / V_0 = 0.964 - 0.039 X / D - 0.344 P /
//   D (Hamill and Kee 2016) handing over to Fuehrer and Roemisch's 2.6 D / X, and the profile exp(-22.2 (r / X)^2).
import { cos, exp, pow, sin } from '@margoengine/math/pinned';
import { angleOf } from '../flight.js';

const PI = 3.141592653589793;

/** A propeller's open-water curves: K_T and K_Q quadratic in J over the first quadrant, its diameter and pitch ratio. */
export interface PropellerCurves {
  /** K_T = k0 + k1 J + k2 J^2. */
  readonly thrust: readonly [number, number, number];
  /** K_Q = q0 + q1 J + q2 J^2. */
  readonly torque: readonly [number, number, number];
  /** Pitch ratio P / D at 0.7 R (the four quadrants and the race). */
  readonly pitch: number;
}

/** The KVLCC2 model propeller (Yasukawa and Yoshimura 2015; 10 K_Q as NMRI measured it): P / D 0.721. */
export const KVLCC2_PROPELLER: PropellerCurves = Object.freeze({
  thrust: [0.2931, -0.2753, -0.1385] as const,
  torque: [0.03071, -0.01856, -0.02045] as const,
  pitch: 0.721,
});

/** A propeller's thrust and torque at a moment, with the race it makes. */
export interface PropellerLoad {
  /** Thrust along the shaft, N (negative astern). */
  thrust: number;
  /** Torque the water puts on the shaft, N m (in the sense opposing its turning). */
  torque: number;
  /** Advance ratio V_a / (n D). */
  advance: number;
  kt: number;
  kq: number;
  /** The race's far-wake speed relative to the propeller, m/s (along the thrust; 0 without thrust). */
  race: number;
}

/**
 * A propeller of diameter `diameter` m with `curves`: thrust and torque at `revolutions` per second (negative astern) and
 * the water's speed into it `advance` m/s (negative from astern), in water of `density`.
 */
export class Propeller {
  readonly diameter: number;
  readonly curves: PropellerCurves;
  /** The bollard and zero-thrust points of the first quadrant: J where K_T = 0. */
  readonly zeroThrust: number;
  private readonly phi: number;
  private readonly liftMax: number;
  private readonly dragMax: number;
  private readonly torqueScale: number;

  /** @throws RangeError for a diameter not above 0 or curves without bollard thrust or a zero-thrust advance. */
  constructor(diameter: number, curves: PropellerCurves = KVLCC2_PROPELLER) {
    if (!(diameter > 0 && Number.isFinite(diameter)))
      throw new RangeError(`A propeller's diameter is finite metres above 0 (got ${diameter}); pass one.`);
    const [k0, k1, k2] = curves?.thrust ?? [],
      [q0] = curves?.torque ?? [];
    if (!(k0! > 0 && q0! > 0 && Number.isFinite(k1) && Number.isFinite(k2) && curves.pitch > 0 && curves.pitch < 3))
      throw new RangeError(
        'Open-water curves have K_T and K_Q above 0 at bollard pull and a pitch ratio in (0, 3); pass {thrust, torque, pitch}.',
      );
    this.diameter = diameter;
    this.curves = curves;
    // The advance where the thrust falls to 0: the positive root of k0 + k1 J + k2 J^2.
    const disc = k1! * k1! - 4 * k2! * k0!,
      root = k2 !== 0 ? (-k1! - Math.sqrt(Math.max(0, disc))) / (2 * k2!) : -k0! / k1!;
    if (!(root > 0 && Number.isFinite(root)))
      throw new RangeError(
        'These open-water curves never lose their thrust as the advance grows; pass measured curves.',
      );
    this.zeroThrust = root;
    // Healey's lift and drag with the hydrodynamic pitch angle phi, fitted so the first quadrant's thrust matches the
    // quadratic's at bollard pull, its slope there and its zero (the geometric pitch angle does not: a real blade's zero lift
    // lies past it).
    const scale = (j: number) => (PI / 8) * (j * j + 0.49 * PI * PI),
      beta0 = angleOf(root, 0.7 * PI),
      cT0 = k0! / scale(0),
      fit = (phi: number): [number, number] => {
        const lift = cT0 / sin(2 * phi),
          a0 = phi - beta0;
        return [lift, (2 * lift * sin(2 * a0) * cos(beta0)) / ((1 - cos(2 * a0)) * sin(beta0))];
      },
      slope = (phi: number): number => {
        const [lift, drag] = fit(phi),
          j = 1e-4,
          beta = angleOf(j, 0.7 * PI),
          a = phi - beta,
          ct = lift * sin(2 * a) * cos(beta) - ((drag * (1 - cos(2 * a))) / 2) * sin(beta);
        return (ct * scale(j) - k0!) / j;
      };
    let lo = beta0 + 1e-6,
      hi = PI / 2 - 1e-3;
    // The slope runs from -infinity (phi just past beta0) upward; bisect to k1, else keep the end nearest it.
    if (slope(hi) < k1!) lo = hi;
    for (let i = 0; i < 100 && lo < hi; i++) {
      const mid = (lo + hi) / 2;
      if (slope(mid) < k1!) lo = mid;
      else hi = mid;
    }
    const phi = (lo + hi) / 2,
      [liftMax, dragMax] = fit(phi);
    this.phi = phi;
    this.liftMax = liftMax;
    this.dragMax = dragMax;
    // Torque: the same shape, scaled to the bollard K_Q (at beta 0, c_Q is 0.35 c_D(phi)).
    const bollardTorque = 0.35 * ((this.dragMax * (1 - cos(2 * phi))) / 2);
    this.torqueScale = bollardTorque > 0 ? q0! / scale(0) / bollardTorque : 0;
  }

  /** K_T and K_Q of the first quadrant (n > 0, 0 <= J <= the zero-thrust advance) from the curves. */
  private firstQuadrant(j: number): [number, number] {
    const [k0, k1, k2] = this.curves.thrust,
      [q0, q1, q2] = this.curves.torque;
    return [k0 + k1 * j + k2 * j * j, Math.max(0, q0 + q1 * j + q2 * j * j)];
  }

  /** c_T and c_Q of the four-quadrant model at angle beta (radians, atan2 of advance over 0.7 pi n D). */
  private quadrants(beta: number): [number, number] {
    const a = this.phi - beta,
      cl = this.liftMax * sin(2 * a),
      cd = (this.dragMax * (1 - cos(2 * a))) / 2,
      cb = cos(beta),
      sb = sin(beta);
    return [cl * cb - cd * sb, this.torqueScale * 0.35 * (cl * sb + cd * cb)];
  }

  /** The load at `revolutions` rev/s and inflow `advance` m/s in water of `density` kg/m^3. */
  load(revolutions: number, advance: number, density = 1025, out?: PropellerLoad): PropellerLoad {
    const o = out ?? { thrust: 0, torque: 0, advance: 0, kt: 0, kq: 0, race: 0 },
      D = this.diameter,
      n = revolutions,
      va = advance;
    if (n === 0 && va === 0) {
      o.thrust = o.torque = o.advance = o.kt = o.kq = o.race = 0;
      return o;
    }
    const j = n !== 0 ? va / (n * D) : Number.POSITIVE_INFINITY;
    let kt: number, kq: number;
    if (n > 0 && j >= 0 && j <= this.zeroThrust) [kt, kq] = this.firstQuadrant(j);
    else {
      // The four-quadrant form, for a propeller turning astern, water coming from astern or a windmilling screw.
      const vp = 0.7 * PI * n * D,
        beta = atan2(va, vp),
        [ct, cq] = this.quadrants(beta),
        speed2 = va * va + vp * vp,
        force = 0.5 * density * speed2 * PI * D * D * 0.25;
      o.thrust = ct * force;
      o.torque = cq * force * D;
      if (n !== 0) {
        const nd = density * n * n * D * D * D * D;
        kt = o.thrust / nd;
        kq = o.torque / (nd * D);
      } else kt = kq = 0;
      o.advance = j;
      o.kt = kt;
      o.kq = kq;
      o.race = this.raceSpeed(o.thrust, va, density);
      return o;
    }
    const nd = density * n * n * D * D * D * D;
    o.thrust = kt * nd;
    o.torque = kq * nd * D;
    o.advance = j;
    o.kt = kt;
    o.kq = kq;
    o.race = this.raceSpeed(o.thrust, va, density);
    return o;
  }

  /**
   * The race's far-wake speed relative to the propeller by momentum theory, m/s: sqrt(V_a^2 + 8 T / (rho pi D^2)) for thrust
   * ahead (V_a sqrt(1 + 8 K_T / (pi J^2)) in coefficients), 0 when the propeller pushes nothing.
   */
  private raceSpeed(thrust: number, inflow: number, density: number): number {
    const t = Math.abs(thrust);
    if (t === 0) return 0;
    const along = thrust > 0 ? inflow : -inflow;
    return Math.sqrt(
      Math.max(0, along) * Math.max(0, along) + (8 * t) / (density * PI * this.diameter * this.diameter),
    );
  }

  /** Open-water efficiency J K_T / (2 pi K_Q) at advance ratio `j` in the first quadrant. */
  efficiency(j: number): number {
    const [kt, kq] = this.firstQuadrant(j);
    return kq > 0 && kt > 0 ? (j * kt) / (2 * PI * kq) : 0;
  }
}

/** Where a propeller is and how it pushes, for {@link raceVelocity}. */
export interface PropellerRace {
  /** The propeller's centre, [x, y, z] m. */
  readonly position: readonly [number, number, number];
  /** Unit vector the race leaves along (behind the propeller for thrust ahead). */
  readonly direction: readonly [number, number, number];
  readonly diameter: number;
  /** Pitch ratio P / D. */
  readonly pitch: number;
  /** The efflux speed V_0, m/s: about 1.59 n D sqrt(K_T) at bollard pull (Blaauw and van de Kaa), the race speed under way. */
  readonly efflux: number;
  /** The hub's diameter, m (default 0.18 D). */
  readonly hub?: number;
}

/** The zone of flow establishment's length, in diameters (Stewart 1992, as Hamill and Kee 2016 give it). */
export const ESTABLISHMENT_LENGTH = 3.25;

/**
 * The race's axial speed at a point, m/s, along its direction: the ring-shaped zone of flow establishment to 3.25 D, then
 * the established jet, Gaussian in r / X (Hamill and Kee 2016; Fuehrer and Roemisch 1977). 0 ahead of the propeller.
 * Writes the velocity vector into `out` when given.
 */
export function raceVelocity(
  race: PropellerRace,
  point: readonly [number, number, number],
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const [px, py, pz] = race.position,
    [dx, dy, dz] = race.direction,
    D = race.diameter,
    rx = point[0] - px,
    ry = point[1] - py,
    rz = point[2] - pz,
    X = rx * dx + ry * dy + rz * dz;
  out[0] = out[1] = out[2] = 0;
  if (!(X > 0) || !(race.efflux > 0)) return out;
  const ax = rx - X * dx,
    ay = ry - X * dy,
    az = rz - X * dz,
    r = Math.sqrt(ax * ax + ay * ay + az * az),
    xd = X / D,
    pd = race.pitch,
    V0 = race.efflux;
  let speed: number;
  if (xd <= ESTABLISHMENT_LENGTH) {
    const vmax = xd <= 0.35 ? V0 : V0 * (1.51 - 0.175 * xd - 0.46 * pd),
      Rp = D / 2,
      Rh = (race.hub ?? 0.18 * D) / 2,
      Rm0 = 0.67 * (Rp - Rh),
      sigma = xd < 0.5 ? 0.5 * Rm0 : 0.5 * Rm0 + 0.075 * (X - D / 2),
      off = r - Rm0;
    speed = vmax * exp((-0.5 * off * off) / (sigma * sigma));
  } else {
    // The established jet: Hamill and Kee's linear decay, matched from the zone's end, handing over to 2.6 D / X where that
    // is the larger (it never reaches 0).
    const linear = 0.964 - 0.039 * xd - 0.344 * pd,
      far = 2.6 / xd,
      vmax = V0 * Math.max(linear, Math.min(far, 0.964 - 0.039 * ESTABLISHMENT_LENGTH - 0.344 * pd)),
      q = r / X;
    speed = vmax * exp(-22.2 * q * q);
  }
  out[0] = speed * dx;
  out[1] = speed * dy;
  out[2] = speed * dz;
  return out;
}

/** Fujii's rudder lift slope f_alpha = 6.13 Lambda / (Lambda + 2.25) for aspect ratio Lambda (MMG standard method, eq. 38). */
export function rudderLiftSlope(aspect: number): number {
  if (!(aspect > 0 && Number.isFinite(aspect)))
    throw new RangeError(`A rudder's aspect ratio is finite and above 0 (got ${aspect}); pass span^2 / area.`);
  return (6.13 * aspect) / (aspect + 2.25);
}

/** A tunnel thruster's ideal thrust (4 rho A)^(1/3) P^(2/3), N, for power `power` W through a tunnel of `diameter` m. */
export function thrusterThrust(power: number, diameter: number, density = 1025): number {
  if (!(power >= 0 && diameter > 0 && Number.isFinite(power) && Number.isFinite(diameter)))
    throw new RangeError(
      `A thruster has a power of 0 W or more and a tunnel above 0 m (got ${power}, ${diameter}); pass them.`,
    );
  const area = (PI * diameter * diameter) / 4;
  return pow(4 * density * area, 1 / 3) * pow(power, 2 / 3);
}

/** atan2(y, x) in (-pi, pi] from the first quadrant's pinned arctangent. */
export function atan2(y: number, x: number): number {
  if (y === 0 && x === 0) return 0;
  const a = angleOf(Math.abs(y), Math.abs(x)) || (Math.abs(y) > 0 && x === 0 ? PI / 2 : 0);
  if (x >= 0) return y >= 0 ? a : -a;
  return y >= 0 ? PI - a : a - PI;
}
