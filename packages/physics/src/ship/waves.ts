// A ship's mean wave drift loads (SEA-09): the slowly varying surge force, sway force and yaw moment waves put on a ship
// under way, added to its MMG forces as H. Yasukawa, "Simulations of ship maneuvering in waves (1st report: turning
// motion)", J. JASNAOE 4, 127-136, 2006 (eqs. 1 to 3 and 23 to 27, read) adds X_W, Y_W and N_W.
// - Surge: the added resistance in regular waves of any heading by Liu and Papanikolaou's SNNM formula as the ITTC
//   recommends it, ITTC 7.5-04-01-01.1 "Preparation, conduct and analysis of speed/power trials", rev. 08, 2024, Annex G,
//   eqs. G-13 to G-31 (read): a motion part peaking near lambda / L 1 and the bow's and stern's reflection, for a waterline
//   of entrance and run wedges.
// - Sway and yaw: the short-wave reflection on the waterline's side facing the waves, (1/2) rho g zeta^2 sin^2 of the
//   angle between the waterline and the waves along its inward normal (Faltinsen, Minsaas, Liapis and Skjordal 1980, as
//   K. K. Yang, M. G. Seo and Y. Kim, J. SNAK 52(4), 338-348, 2015, eq. 19, and D. Matulja et al., Brodogradnja 62(3),
//   2011, eq. 19, restate it; read), times Fujii and Takahashi's draft factor pi^2 I1^2(k d) / (pi^2 I1^2 + K1^2) for the
//   waves passing under the keel (M. Kuroda et al. and M. Tsujimoto et al., J. JASNAOE 8, 2008, read), at zero speed as
//   Yasukawa takes the sway and yaw loads.
// - Irregular seas: twice the integral of the regular loads over zeta_A^2 times the spectrum and its spreading (ITTC
//   G-32), on Bretschneider's spectrum in the significant height and mean period (M. A. A. Hasnan, H. Yasukawa et al., J.
//   Mar. Sci. Technol., 2019, eqs. 1 to 3, read), spread as cos^n.
// The modified Bessel functions are Abramowitz and Stegun's polynomial approximations 9.8.3, 9.8.4, 9.8.7 and 9.8.8.
import { atan, atan2, cos, exp, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import { shipError } from './errors.js';

/** A hull for its wave drift loads: L, B, T, m, C_B, the pitch gyration over L, and its waterline's entrance and run, m. */
export interface WaveHull {
  readonly length: number;
  readonly beam: number;
  readonly draught: number;
  readonly block: number;
  /** k_yy / L (default 0.25). */
  readonly pitchGyration?: number;
  /**
   * The waterline's length of entrance and of run, m: wedges from the ends to the full beam (default (1 - C_WP) L each, the
   * wedges that give a waterplane coefficient C_WP = (1 + 2 C_B) / 3, an assumption for a hull whose waterline is not given).
   */
  readonly entrance?: number;
  readonly run?: number;
}

/** Mean drift loads in ship axes: X forward, Y to starboard, N, about the midship, turning the bow to starboard. */
export interface DriftLoads {
  X: number;
  Y: number;
  N: number;
}

/** Regular waves: amplitude, m, period, s, and the direction they travel, rad on the ground plane (from +X toward +Z). */
export interface RegularWaves {
  readonly amplitude: number;
  readonly period: number;
  readonly direction: number;
}

/** Irregular seas: significant height, m, mean period T_1, s, mean travel direction, rad, and the spreading's power n (cos^n, default 2; Infinity long-crested). */
export interface IrregularWaves {
  readonly significantHeight: number;
  readonly period: number;
  readonly direction: number;
  readonly spread?: number;
}

/** I_1(x) (Abramowitz and Stegun 9.8.3, 9.8.4). */
export function besselI1(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 3.75) {
    const t = (x / 3.75) * (x / 3.75);
    return (
      x *
      (0.5 +
        t * (0.87890594 + t * (0.51498869 + t * (0.15084934 + t * (0.02658733 + t * (0.00301532 + t * 0.00032411))))))
    );
  }
  const t = 3.75 / ax,
    v =
      (exp(ax) / Math.sqrt(ax)) *
      (0.39894228 +
        t *
          (-0.03988024 +
            t *
              (-0.00362018 +
                t *
                  (0.00163801 +
                    t * (-0.01031555 + t * (0.02282967 + t * (-0.02895312 + t * (0.01787654 - t * 0.00420059))))))));
  return x < 0 ? -v : v;
}

/** K_1(x), x above 0 (Abramowitz and Stegun 9.8.7, 9.8.8). */
export function besselK1(x: number): number {
  if (x <= 2) {
    const t = (x / 2) * (x / 2);
    return (
      (x * ln(x / 2) * besselI1(x) +
        1 +
        t *
          (0.15443144 +
            t * (-0.67278579 + t * (-0.18156897 + t * (-0.01919402 + t * (-0.00110404 - t * 0.00004686)))))) /
      x
    );
  }
  const t = 2 / x;
  return (
    (exp(-x) / Math.sqrt(x)) *
    (1.25331414 +
      t * (0.23498619 + t * (-0.0365562 + t * (0.01504268 + t * (-0.00780353 + t * (0.00325614 - t * 0.00068245))))))
  );
}

function check(hull: WaveHull): Required<WaveHull> {
  const { length: L, beam: B, draught: T, block: CB } = hull ?? ({} as WaveHull),
    waterplane = (1 + 2 * CB) / 3,
    out = {
      length: L,
      beam: B,
      draught: T,
      block: CB,
      pitchGyration: hull?.pitchGyration ?? 0.25,
      entrance: hull?.entrance ?? (1 - waterplane) * L,
      run: hull?.run ?? (1 - waterplane) * L,
    };
  if (
    !(L > 0 && B > 0 && T > 0 && CB > 0 && CB <= 1 && out.pitchGyration > 0) ||
    !(out.entrance > 0 && out.run > 0 && out.entrance + out.run <= L) ||
    !Object.values(out).every(Number.isFinite)
  )
    throw shipError(
      `A hull in waves is {length, beam, draught, block}: finite, above 0, C_B up to 1, with an entrance and run above 0 that fit in its length (got ${Object.values(out).join(', ')}); pass them.`,
    );
  return out;
}

/**
 * The added resistance, N, of a hull at `speed` m/s in regular waves of amplitude `amplitude` m and frequency `omega`
 * rad/s, coming from `alpha` rad off the bow (0 head seas, pi following; ITTC 2024 Annex G, Liu and Papanikolaou's SNNM).
 */
export function addedResistance(
  hull: WaveHull,
  amplitude: number,
  omega: number,
  alpha: number,
  speed: number,
  gravity = 9.80665,
  density = 1025,
): number {
  const h = check(hull);
  if (![amplitude, omega, alpha, speed, gravity, density].every(Number.isFinite) || !(omega > 0 && gravity > 0))
    throw shipError(
      `Waves are a finite amplitude, a frequency above 0 and a direction, met at a finite speed in gravity above 0 (got ${[amplitude, omega, alpha, speed, gravity].join(', ')}); pass them.`,
    );
  if (amplitude === 0) return 0;
  const { length: L, beam: B, draught: T, block: CB, pitchGyration: kyy } = h,
    g = gravity,
    V = Math.max(0, speed),
    a = Math.min(Math.PI, Math.abs(atan2(sin(alpha), cos(alpha)))),
    fr = V / Math.sqrt(g * L),
    zeta2 = amplitude * amplitude,
    lnBT = ln(B / T),
    // The motion part (G-14 to G-22), level keel; stern-oblique seas between beam and following by interpolation.
    motion = (angle: number): number => {
      const ca = cos(angle),
        vg = g / (2 * omega),
        frRel = (V - vg) / Math.sqrt(g * L),
        w =
          2.142 *
          pow(kyy, 1 / 3) *
          Math.sqrt(L / (2 * Math.PI * g)) *
          pow(CB / 0.65, 0.17) *
          (1 - (0.111 / CB) * (lnBT - ln(2.75))) *
          ((-1.377 * fr * fr + 1.157 * fr) * Math.abs(ca) + (0.618 * (13 + cos(2 * angle))) / 14) *
          omega,
        following = angle >= Math.PI - 1e-12,
        a1 = following
          ? V > vg && frRel >= 0.12
            ? pow(0.87 / CB, 1 + frRel) / lnBT
            : 0.87 / CB / lnBT
          : (pow(0.87 / CB, (1 + fr) * ca) / lnBT) * ((1 + 2 * ca) / 3),
        a2 = following
          ? V <= vg
            ? 0.0072 * ((2 * V) / vg - 1)
            : frRel < 0.12
              ? 0.0072 + 0.1676 * frRel
              : pow(frRel, 1.5) * exp(-3.5 * frRel)
          : fr < 0.12
            ? 0.0072 + 0.1676 * fr
            : pow(fr, 1.5) * exp(-3.5 * fr),
        b1 = w < 1 ? 11 : -8.5,
        d1 = w < 1 ? 566 * pow((L * CB) / B, -2.66) : -566 * pow(L / B, -2.66) * 4;
      return (
        3859.2 *
        density *
        g *
        zeta2 *
        ((B * B) / L) *
        pow(CB, 1.34) *
        kyy *
        kyy *
        a1 *
        a2 *
        pow(w, b1) *
        exp((b1 / d1) * (1 - pow(w, d1)))
      );
    },
    rawm =
      a <= Math.PI / 2
        ? motion(a)
        : motion(Math.PI / 2) + ((a - Math.PI / 2) / (Math.PI / 2)) * (motion(Math.PI) - motion(Math.PI / 2)),
    // The reflection (G-23 to G-31) off the entrance and run wedges.
    e1 = atan((0.495 * B) / h.entrance),
    e2 = atan((0.495 * B) / h.run),
    lambda = (2 * Math.PI * g) / (omega * omega),
    reach = (t: number) => (lambda / L <= 2.5 ? 1 - exp(-4 * Math.PI * (t / lambda - t / (2.5 * L))) : 0),
    speedTerm = (2 * omega * V) / g,
    front = (2.25 / 4) * density * g * B * zeta2 * reach(T),
    tStern = CB <= 0.75 ? (T * (4 + Math.sqrt(Math.abs(cos(a))))) / 5 : (T * (2 + Math.sqrt(Math.abs(cos(a))))) / 3,
    back = (2.25 / 4) * density * g * B * zeta2 * reach(tStern),
    bluff = pow(0.87 / CB, (1 + 4 * Math.sqrt(fr)) * (a <= e1 ? cos(a) : 0)),
    term = (e: number, s: number) => sin(e + s) * sin(e + s) + speedTerm * (cos(a) - cos(e) * cos(e + s));
  let rawr = 0;
  if (a <= Math.PI - e1) rawr += front * term(e1, a) * bluff;
  if (a <= e1) rawr += front * term(e1, -a) * bluff;
  if (a >= e2) rawr -= back * term(e2, -a);
  if (a >= Math.PI - e2) rawr -= back * term(e2, a);
  return rawm + rawr;
}

/**
 * The mean drift loads on a hull heading `heading` rad at `speed` m/s in regular waves (Yasukawa 2006's X_W, Y_W, N_W):
 * X the SNNM added resistance, Y and N the short-wave reflection on the waterline's wedges times Fujii and Takahashi's
 * draft factor.
 */
export function driftLoads(
  hull: WaveHull,
  waves: RegularWaves,
  heading: number,
  speed: number,
  gravity = 9.80665,
  density = 1025,
  out?: DriftLoads,
): DriftLoads {
  const h = check(hull),
    o = out ?? { X: 0, Y: 0, N: 0 },
    { amplitude, period, direction } = waves ?? ({} as RegularWaves);
  if (!(amplitude >= 0 && period > 0) || ![amplitude, period, direction, heading, speed].every(Number.isFinite))
    throw shipError(
      `Regular waves are {amplitude, period, direction}: an amplitude of 0 m or more, a period above 0 s and a direction in rad (got ${[amplitude, period, direction].join(', ')}); pass them.`,
    );
  const omega = (2 * Math.PI) / period,
    // The waves' travel in ship axes (x forward, y to starboard), and where they come from off the bow.
    rel = direction - heading,
    dx = cos(rel),
    dy = sin(rel);
  o.X = -addedResistance(h, amplitude, omega, atan2(-dy, -dx), speed, gravity, density);
  const k = (omega * omega) / gravity,
    kd = k * h.draught,
    i1 = besselI1(kd),
    k1 = besselK1(kd),
    transmit = (Math.PI * Math.PI * i1 * i1) / (Math.PI * Math.PI * i1 * i1 + k1 * k1),
    L = h.length,
    half = h.beam / 2,
    bow = L / 2 - h.entrance,
    stern = -L / 2 + h.run,
    // The waterline: bow, starboard shoulder and quarter, stern, port quarter and shoulder.
    xs = [L / 2, bow, stern, -L / 2, stern, bow],
    ys = [0, half, half, 0, -half, -half],
    q = 0.5 * density * gravity * amplitude * amplitude * transmit;
  let Y = 0,
    N = 0;
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6,
      ex = xs[j]! - xs[i]!,
      ey = ys[j]! - ys[i]!,
      len = hypot(ex, ey),
      // Outward normal: the edge turned toward the outside of the waterline.
      nx = ey / len,
      ny = -ex / len,
      facing = nx * dx + ny * dy;
    if (facing >= 0) continue;
    const f = q * facing * facing * len,
      fx = -nx * f,
      fy = -ny * f,
      mx = 0.5 * (xs[i]! + xs[j]!),
      my = 0.5 * (ys[i]! + ys[j]!);
    Y += fy;
    N += mx * fy - my * fx;
  }
  o.Y = Y;
  o.N = N;
  return o;
}

/** Bretschneider's spectral density, m^2 s, at `omega` for significant height `h` and mean period `t1` (172.8 H^2 / T_1^4, 691.2 / T_1^4). */
export function waveSpectrum(omega: number, h: number, t1: number): number {
  if (!(omega > 0)) return 0;
  const w4 = omega * omega * omega * omega;
  return ((172.8 * h * h) / (t1 * t1 * t1 * t1) / (w4 * omega)) * exp(-691.2 / (t1 * t1 * t1 * t1) / w4);
}

/** Frequencies and directions the irregular loads are summed over. */
const FREQUENCIES = 32,
  DIRECTIONS = 15;

/**
 * The mean drift loads in an irregular sea: twice the regular loads per zeta_A^2 summed over Bretschneider's spectrum and
 * a cos^n spreading about the mean direction (ITTC 2024 G-32).
 */
export function irregularDriftLoads(
  hull: WaveHull,
  sea: IrregularWaves,
  heading: number,
  speed: number,
  gravity = 9.80665,
  density = 1025,
  out?: DriftLoads,
): DriftLoads {
  const o = out ?? { X: 0, Y: 0, N: 0 },
    { significantHeight: H, period: T1, direction, spread = 2 } = sea ?? ({} as IrregularWaves);
  if (!(H >= 0 && T1 > 0 && spread > 0) || ![H, T1, direction, heading, speed].every(Number.isFinite))
    throw shipError(
      `An irregular sea is {significantHeight, period, direction, spread}: a height of 0 m or more, a mean period above 0 s, a direction in rad and a spreading power above 0 (got ${[H, T1, direction, spread].join(', ')}); pass them.`,
    );
  o.X = o.Y = o.N = 0;
  if (H === 0) return o;
  // The spectrum's peak is at omega_p = (0.8 * 691.2)^(1/4) / T_1; summed from 0.4 to 3.5 times it.
  const peak = pow(0.8 * 691.2, 0.25) / T1,
    lo = 0.4 * peak,
    hi = 3.5 * peak,
    dw = (hi - lo) / FREQUENCIES,
    longCrested = !Number.isFinite(spread),
    angles = longCrested ? 1 : DIRECTIONS,
    dth = Math.PI / angles,
    one: DriftLoads = { X: 0, Y: 0, N: 0 };
  let norm = 0;
  const weights: number[] = [];
  for (let j = 0; j < angles; j++) {
    const th = longCrested ? 0 : -Math.PI / 2 + (j + 0.5) * dth,
      w = longCrested ? 1 : pow(cos(th), spread) * dth;
    weights.push(w);
    norm += w;
  }
  for (let i = 0; i < FREQUENCIES; i++) {
    const omega = lo + (i + 0.5) * dw,
      s = waveSpectrum(omega, H, T1) * dw,
      period = (2 * Math.PI) / omega;
    for (let j = 0; j < angles; j++) {
      const th = longCrested ? 0 : -Math.PI / 2 + (j + 0.5) * dth,
        share = (2 * s * weights[j]!) / norm;
      driftLoads(hull, { amplitude: 1, period, direction: direction + th }, heading, speed, gravity, density, one);
      o.X += share * one.X;
      o.Y += share * one.Y;
      o.N += share * one.N;
    }
  }
  return o;
}
