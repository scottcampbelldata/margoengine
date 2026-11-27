// Blast loading (FIRE-04): the air blast of an explosion and what it does to the bodies it reaches. The free-air blast of
// Kinney and Graham (1985): peak overpressure, positive impulse and positive duration against scaled distance Z = r / W^(1/3)
// (W kg of TNT), scaled to the air's pressure and temperature by Sachs's factors; a modified Friedlander waveform whose decay
// gives that impulse; the shock's arrival from its Rankine-Hugoniot speed; and the normally reflected overpressure where it
// meets a face. A charge at or under the ground makes a hemispherical blast, as a free-air one of twice its air energy (its
// image in the ground).
//
// Sources (docs/clean-room.md): G. F. Kinney and K. J. Graham, "Explosive Shocks in Air", 1985, through I. Sonder et al.,
// "Experimental multiblast craters and ejecta", J. Geophys. Res. Solid Earth, 2022, Appendix B (eqs 28 to 30, Table 5, with
// their corrected impulse constant 5.68e-5 s kg^-1/3, and the kg-unit constants where their SI column misprints two), and
// their eq 4 for the transmission factors; S. R. Ford et al., Bull. Seismol. Soc. Am. 104(2), 2014, through Sonder et al.'s
// eq 9 and Table 6, for the field-measured surface-burst impulse that validates the hemisphere; the Rankine-Hugoniot shock
// relations of a perfect gas (shock speed and normal reflection), as in Glasstone and Dolan, "The Effects of Nuclear
// Weapons" (1977), chapter 3, restated from compressible-flow textbooks.
import type { Vec3 } from '@margoengine/math';
import { exp, ln, pow } from '@margoengine/math/pinned';
import { invalidExplosive } from './errors.js';

/** Joules in a kilogram of TNT. */
const TNT = 4.184e6;
/** The reference atmosphere of the laws: 101,325 Pa and 288.15 K. */
const P0 = 101325,
  T0 = 288.15;
/** Air's ratio of specific heats and gas constant. */
const GAMMA = 1.4,
  R_AIR = 287.05;
/** The scaled distance below which the duration fit fails (the fireball): the impulse ratio is held at its value there. */
const NEAR = 0.5;

/** Peak overpressure over the ambient pressure at scaled distance Z, m kg^-1/3 (Kinney and Graham eq 28). */
export function scaledOverpressure(Z: number): number {
  const a = Z / 4.5,
    b = Z / 0.048,
    c = Z / 0.32,
    d = Z / 1.35;
  return (808 * (1 + a * a)) / Math.sqrt((1 + b * b) * (1 + c * c) * (1 + d * d));
}

/** Positive-phase impulse over the ambient pressure, s kg^-1/3, at scaled distance Z (eq 29, corrected constant). */
export function scaledImpulse(Z: number): number {
  const a = Z / 0.23,
    b = Z / 1.55;
  return (5.68e-5 * Math.sqrt(1 + a * a * a * a)) / (Z * Z * pow(1 + b * b * b, 1 / 3));
}

/** Positive-phase duration, s kg^-1/3, at scaled distance Z (eq 30). */
export function scaledDuration(Z: number): number {
  const a = Z / 0.54,
    b = Z / 0.02,
    c = Z / 0.74,
    d = Z / 6.9;
  const a2 = a * a,
    a5 = a2 * a2 * a,
    c3 = c * c * c;
  return (0.98 * (1 + a5 * a5)) / ((1 + b * b * b) * (1 + c3 * c3) * Math.sqrt(1 + d * d));
}

/** The decay alpha of a modified Friedlander wave p (1 - s) e^(-alpha s) whose integral over 0 <= s <= 1 is k (0 < k < 1). */
export function friedlanderDecay(k: number): number {
  if (!(k > 0 && k < 1)) throw invalidExplosive(`A Friedlander impulse ratio must be between 0 and 1; got ${k}.`);
  // f(alpha) = (alpha - 1 + e^-alpha) / alpha^2 falls from above 1 (alpha = -50) through 1/2 (alpha = 0) towards 0: bisect.
  // Near 0 the closed form cancels; its series 1/2 - x/6 + x^2/24 - x^3/120 is exact to rounding below 1e-3.
  const f = (x: number) =>
    Math.abs(x) < 1e-3 ? 0.5 - x / 6 + (x * x) / 24 - (x * x * x) / 120 : (x - 1 + exp(-x)) / (x * x);
  let lo = -50,
    hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > k) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-13 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}

/** The air a blast runs through. */
export interface Atmosphere {
  /** Ambient pressure, Pa (default 101,325). */
  readonly pressure?: number;
  /** Ambient temperature, K (default 288.15). */
  readonly temperature?: number;
}

/** The blast of one charge at one distance. */
export interface BlastPoint {
  /** When the shock arrives, s after the detonation. */
  readonly arrival: number;
  /** Peak side-on overpressure, Pa. */
  readonly overpressure: number;
  /** Positive-phase side-on impulse, Pa s. */
  readonly impulse: number;
  /** Positive-phase duration, s. */
  readonly duration: number;
  /** The Friedlander decay of the positive phase. */
  readonly decay: number;
  /** Normally reflected peak overpressure, Pa (Rankine-Hugoniot). */
  readonly reflected: number;
}

/** The shock arrival table of a unit charge: scaled arrival (s kg^-1/3) at log-spaced scaled distances. */
const ARRIVAL_POINTS = 512,
  ZMIN = 1e-3,
  ZMAX = 1e4;
let arrivalTable: Float64Array | null = null;

/** Scaled arrival time, s kg^-1/3, at the reference sound speed: the integral of dZ / U(Z), U = c0 sqrt(1 + 6/7 p/pa). */
function scaledArrival(Z: number): number {
  const c0 = Math.sqrt(GAMMA * R_AIR * T0);
  if (!arrivalTable) {
    const table = new Float64Array(ARRIVAL_POINTS);
    const ratio = ln(ZMAX / ZMIN) / (ARRIVAL_POINTS - 1);
    // From Z = 0 to ZMIN the shock speed is its near value; then Simpson's rule on each log-spaced interval.
    const speed = (z: number) => c0 * Math.sqrt(1 + ((GAMMA + 1) / (2 * GAMMA)) * scaledOverpressure(z));
    table[0] = ZMIN / speed(ZMIN / 2);
    for (let i = 1; i < ARRIVAL_POINTS; i++) {
      const a = ZMIN * exp(ratio * (i - 1)),
        b = ZMIN * exp(ratio * i),
        m = (a + b) / 2;
      table[i] = table[i - 1]! + ((b - a) / 6) * (1 / speed(a) + 4 / speed(m) + 1 / speed(b));
    }
    arrivalTable = table;
  }
  if (Z <= ZMIN) return (arrivalTable[0]! * Z) / ZMIN;
  if (Z >= ZMAX) return arrivalTable[ARRIVAL_POINTS - 1]! + (Z - ZMAX) / c0;
  const x = ln(Z / ZMIN) / (ln(ZMAX / ZMIN) / (ARRIVAL_POINTS - 1));
  const i = Math.min(Math.floor(x), ARRIVAL_POINTS - 2);
  return arrivalTable[i]! + (arrivalTable[i + 1]! - arrivalTable[i]!) * (x - i);
}

/** Normally reflected overpressure of a side-on overpressure `p` in air at `ambient` Pa (Rankine-Hugoniot, gamma 1.4). */
export function reflectedOverpressure(p: number, ambient = P0): number {
  return (2 * p * (7 * ambient + 4 * p)) / (7 * ambient + p);
}

/**
 * The free-air blast of `energy` joules at `distance` metres, in the given air (Sachs scaling: distances by
 * (rho / rho0)^(1/3), times by that and c / c0).
 * @throws MargoError (`unsupported`) for an energy or distance that is not finite and above 0.
 */
export function blastAt(energy: number, distance: number, air: Atmosphere = {}): BlastPoint {
  if (!(Number.isFinite(energy) && energy > 0))
    throw invalidExplosive(`Blast energy must be a finite number of joules above 0; got ${energy}.`);
  if (!(Number.isFinite(distance) && distance > 0))
    throw invalidExplosive(`Blast distance must be a finite number of metres above 0; got ${distance}.`);
  const pa = air.pressure ?? P0,
    T = air.temperature ?? T0;
  if (!(Number.isFinite(pa) && pa > 0 && Number.isFinite(T) && T > 0))
    throw invalidExplosive(`The air's pressure and temperature must be above 0; got ${pa} Pa and ${T} K.`);
  const fd = pow((pa / P0) * (T0 / T), 1 / 3),
    ft = fd * Math.sqrt(T / T0);
  const w = pow(energy / TNT, 1 / 3);
  const Z = (fd * distance) / w;
  const ps = scaledOverpressure(Z) * pa;
  const impulse = (scaledImpulse(Z) * pa * w) / ft;
  const near = Math.max(Z, NEAR);
  const k = scaledImpulse(near) / (scaledOverpressure(near) * scaledDuration(near));
  const duration = impulse / (k * ps);
  return {
    arrival: (scaledArrival(Z) * w) / ft,
    overpressure: ps,
    impulse,
    duration,
    decay: friedlanderDecay(k),
    reflected: reflectedOverpressure(ps, pa),
  };
}

/** The impulse of a Friedlander positive phase so far, Pa s, `t` seconds after the shock arrived (all of it after `duration`). */
export function impulseSoFar(point: BlastPoint, t: number, reflected = false): number {
  if (!(t > 0)) return 0;
  const s = Math.min(t / point.duration, 1);
  const a = point.decay;
  const peak = reflected ? point.reflected : point.overpressure;
  // The integral of (1 - s) e^(-a s) from 0 to s: (1 - e^(-a s)) / a - (1 - e^(-a s)(1 + a s)) / a^2.
  const part = Math.abs(a) < 1e-6 ? s - (s * s) / 2 : (1 - exp(-a * s)) / a - (1 - exp(-a * s) * (1 + a * s)) / (a * a);
  return peak * point.duration * part;
}

/** The overpressure of a Friedlander positive phase `t` seconds after the shock arrived, Pa (0 before and after it). */
export function overpressureAt(point: BlastPoint, t: number, reflected = false): number {
  if (!(t >= 0) || t > point.duration) return 0;
  const s = t / point.duration;
  return (reflected ? point.reflected : point.overpressure) * (1 - s) * exp(-point.decay * s);
}

/** The projected area, m^2, of a box of half extents `e` seen along the unit direction `n`. */
export function projectedArea(e: Vec3, n: Vec3): number {
  return 4 * (Math.abs(n[0]) * e[1] * e[2] + Math.abs(n[1]) * e[0] * e[2] + Math.abs(n[2]) * e[0] * e[1]);
}
