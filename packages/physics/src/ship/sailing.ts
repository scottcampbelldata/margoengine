// A sailing yacht (SEA-09): its hull's and appendages' resistance and side force by the Delft Systematic Yacht Hull Series
// and its sails' lift and drag by the ORC's, balanced into a velocity prediction.
// - Bare hull upright: J. A. Keuning and M. Katgert's 2008 residuary regression and the ITTC-1957 line at 0.7 L_WL with no
//   form factor, and the canoe body's wetted area, as N. Kleijweg, MSc thesis, TU Delft (eqs. 2.5 to 2.9, Table B.2) and
//   G. Borba Labi, EMSHIP thesis, Liege / Rostock 2019 (eq. 76, Table 10) reprint them (read).
// - Heel, keel, side force and induced drag: J. A. Keuning and U. B. Sonnenberg, 1998: the heeled wetted area, the heeled
//   residuary resistance (6 phi^1.7 of its value at 20 degrees), the keel's residuary resistance and its change with heel,
//   the side force's slope and the effective span, as Borba Labi reprints them (eqs. 77 to 91, Tables 11 to 16, read);
//   the appendages' friction by the ITTC line on both faces with the form factor 1 + 2 t/c + 60 (t/c)^4.
// - Sails: the ORC VPP Documentation 2023, section 5 (Tables 5.1 and 5.4, eqs. 5.34 to 5.48, read): the mainsail's and
//   jib's lift and drag against the apparent wind angle (the low-tech sets), combined over the reference area with the
//   parasitic, quadratic and induced drag, flattened by FLAT down to 0.42, the effective height by the span correction.
// - The heel's effect on the apparent wind in the sails' plane: tan(AWA_e) = tan(AWA) cos(phi), AWS_e = AWS sqrt(1 -
//   sin^2(AWA) sin^2(phi)) (the wind's component normal to the heeled rig).
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { DEFAULT_GRAVITY } from '@margoengine/math/gravity';
import { atan2, cos, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import { regionWords } from '../world/memory.js';
import {
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { shipError } from './errors.js';

type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

/** Keuning and Katgert 2008, a0 to a7 for Fn 0.15 to 0.75 in steps of 0.05 (Kleijweg Table B.2). */
const UPRIGHT: readonly (readonly number[])[] = [
  [-0.0005, 0.0023, -0.0086, -0.0015, 0.0061, 0.001, 0.0001, 0.0052],
  [-0.0003, 0.0059, -0.0064, 0.007, 0.0014, 0.0013, 0.0005, -0.002],
  [-0.0002, -0.0156, 0.0031, -0.0021, -0.007, 0.0148, 0.001, -0.0043],
  [-0.0009, 0.0016, 0.0337, -0.0285, -0.0367, 0.0218, 0.0015, -0.0172],
  [-0.0026, -0.0567, 0.0446, -0.1091, -0.0707, 0.0914, 0.0021, -0.0078],
  [-0.0064, -0.4034, -0.125, 0.0273, -0.1341, 0.3578, 0.0045, 0.1115],
  [-0.0218, -0.5261, -0.2945, 0.2485, -0.2428, 0.6293, 0.0081, 0.2086],
  [-0.0388, -0.5986, -0.3038, 0.6033, -0.043, 0.8332, 0.0106, 0.1336],
  [-0.0347, -0.4764, -0.2361, 0.8726, 0.4219, 0.899, 0.0096, -0.2272],
  [-0.0361, 0.0037, -0.296, 0.9661, 0.6123, 0.7534, 0.01, -0.3352],
  [0.0008, 0.3728, -0.3667, 1.3957, 1.0343, 0.323, 0.0072, -0.4632],
  [0.0108, -0.1238, -0.2026, 1.1282, 1.1836, 0.4973, 0.0038, -0.4477],
  [0.1023, 0.7726, 0.504, 1.7867, 2.1934, -1.5479, -0.0115, -0.0977],
];
/** Keuning and Sonnenberg 1998: the heeled wetted area's s0 to s3 at 5 to 35 degrees (Borba Labi Table 11). */
const WETTED_HEEL: readonly (readonly number[])[] = [
  [-4.112, 0.054, -0.027, 6.329],
  [-4.522, -0.132, -0.077, 8.738],
  [-3.291, -0.389, -0.118, 8.949],
  [1.85, -1.2, -0.109, 5.364],
  [6.51, -2.305, -0.066, 3.443],
  [12.334, -3.911, 0.024, 1.767],
  [14.648, -5.182, 0.102, 3.497],
];
/** Their heeled residuary resistance at 20 degrees, u0 to u5 x 10^-3, Fn 0.25 to 0.55 (Borba Labi Table 12). */
const HEEL_20: readonly (readonly number[])[] = [
  [-0.0268, -0.0014, -0.0057, 0.0016, -0.007, -0.0017],
  [0.6628, -0.0632, -0.0699, 0.0069, 0.0459, -0.0004],
  [1.6433, -0.2144, -0.164, 0.0199, -0.054, -0.0268],
  [-0.8659, -0.0354, 0.2226, 0.0188, -0.58, -0.1133],
  [-3.2715, 0.1372, 0.5547, 0.0268, -1.0064, -0.2026],
  [-0.1976, -0.148, -0.6593, 0.1862, -0.7489, -0.1648],
  [1.5873, -0.3749, -0.7105, 0.2146, -0.4818, -0.1174],
];
/** The keel's residuary resistance, A0 to A3, Fn 0.2 to 0.6 (Borba Labi Table 13). */
const KEEL: readonly (readonly number[])[] = [
  [-0.00104, 0.00172, 0.00117, -0.00008],
  [-0.0055, 0.00597, 0.0039, -0.00009],
  [-0.0111, 0.01421, 0.00069, 0.00021],
  [-0.00713, 0.02632, -0.00232, 0.00039],
  [-0.03581, 0.08649, 0.00999, 0.00017],
  [-0.0047, 0.11592, -0.00064, 0.00035],
  [0.00553, 0.07371, 0.05991, -0.00114],
  [0.04822, 0.0066, 0.07048, -0.00035],
  [0.01021, 0.14173, 0.06409, -0.00192],
];
/** The side force's slope, b1 to b4, and the effective span's A1 to A4, B0, B1, at 0, 10, 20 and 30 degrees (Tables 15, 16). */
const SIDE: readonly (readonly number[])[] = [
  [2.025, 9.551, 0.631, -6.575],
  [1.989, 6.729, 0.494, -4.745],
  [1.98, 0.633, 0.194, -0.792],
  [1.762, -4.957, -0.087, 2.766],
];
const SPAN: readonly (readonly number[])[] = [
  [3.7455, -3.6246, 0.0589, -0.0296, 1.2306, -0.7256],
  [4.4892, -4.8454, 0.0294, -0.0176, 1.4231, -1.2971],
  [3.9592, -3.9804, 0.0283, -0.0075, 1.545, -1.5622],
  [3.4891, -2.9577, 0.025, -0.0272, 1.4744, -1.3499],
];
/** ORC 2023 mainsail (Table 5.1, low set) and jib (Table 5.4, low set): AWA, deg; C_L; C_D. */
const MAIN: readonly (readonly number[])[] = [
  [0, 7, 9, 12, 28, 60, 90, 120, 150, 180],
  [0, 0.86207, 1.05172, 1.16379, 1.34698, 1.35345, 1.26724, 0.93103, 0.38793, -0.11207],
  [0.0431, 0.02586, 0.02328, 0.02328, 0.03259, 0.11302, 0.3825, 0.96888, 1.31578, 1.34483],
];
const JIB: readonly (readonly number[])[] = [
  [7, 15, 20, 27, 50, 60, 100, 150, 180],
  [0, 1, 1.375, 1.45, 1.45, 1.25, 0.4, 0, -0.1],
  [0.05, 0.032, 0.031, 0.037, 0.25, 0.35, 0.73, 0.95, 0.9],
];
/** ORC's fcdmult against FLAT, 0.55 to 1.00. */
const FLAT_DRAG = [1.06, 1.055, 1.048, 1.035, 1.02, 1.008, 1.002, 1.0, 1.004, 1.06];

/** Rows `table` at `x` from `x0` in steps of `dx`, linearly, held at the ends. */
function row(table: readonly (readonly number[])[], x0: number, dx: number, x: number): number[] {
  const f = Math.max(0, Math.min(table.length - 1, (x - x0) / dx)),
    i = Math.min(table.length - 2, Math.floor(f)),
    t = f - i;
  return table[i]!.map((v, k) => v + t * (table[i + 1]![k]! - v));
}

/** Linear interpolation in the sail tables' columns. */
function column(table: readonly (readonly number[])[], awa: number): [number, number] {
  const xs = table[0]!,
    a = Math.max(xs[0]!, Math.min(xs[xs.length - 1]!, awa));
  let i = 0;
  while (i < xs.length - 2 && a > xs[i + 1]!) i++;
  const t = (a - xs[i]!) / (xs[i + 1]! - xs[i]!);
  return [
    table[1]![i]! + t * (table[1]![i + 1]! - table[1]![i]!),
    table[2]![i]! + t * (table[2]![i + 1]! - table[2]![i]!),
  ];
}

/** A yacht's canoe body (the DSYHS's parameters) and appendages. */
export interface YachtHull {
  /** Waterline length and beam, canoe-body draught, m; displaced volume, m^3; waterplane area, m^2. */
  readonly length: number;
  readonly beam: number;
  readonly draught: number;
  readonly volume: number;
  readonly waterplane: number;
  /** Centres of buoyancy and flotation aft of the forward perpendicular, m. */
  readonly lcb: number;
  readonly lcf: number;
  /** Prismatic and midship-section coefficients. */
  readonly prismatic: number;
  readonly midship: number;
  /** The keel: total draught, m, volume, m^3, root and tip chords, m, thickness over chord, and its volume's centre below the canoe body, m. */
  readonly keel: {
    readonly draught: number;
    readonly volume: number;
    readonly root: number;
    readonly tip: number;
    readonly thickness: number;
    readonly centre: number;
  };
  /** The rudder: lateral area, m^2, mean chord, m, thickness over chord. */
  readonly rudder: { readonly area: number; readonly chord: number; readonly thickness: number };
}

/** A yacht's rig and stability: I, J, P, E, m; the boom's and the sheer's height above the water, m; mass, kg; GM, m. */
export interface YachtRig {
  readonly I: number;
  readonly J: number;
  readonly P: number;
  readonly E: number;
  readonly boom: number;
  readonly freeboard: number;
  readonly mass: number;
  readonly metacentricHeight: number;
}

/** The water's and air's properties for a yacht (defaults: 1025 and 1.19e-6 sea water, 1.225 air, 9.80665 gravity). */
export interface YachtFluids {
  readonly density?: number;
  readonly viscosity?: number;
  readonly air?: number;
  readonly gravity?: number;
}

function friction(re: number): number {
  const log = ln(re) * 0.4342944819032518 - 2;
  return re > 1 ? 0.075 / (log * log) : 0;
}

function checkHull(h: YachtHull): void {
  const k = h?.keel,
    r = h?.rudder;
  const values = [
    h?.length,
    h?.beam,
    h?.draught,
    h?.volume,
    h?.waterplane,
    h?.lcb,
    h?.lcf,
    h?.prismatic,
    h?.midship,
    k?.draught,
    k?.volume,
    k?.root,
    k?.tip,
    k?.thickness,
    r?.area,
    r?.chord,
    r?.thickness,
  ];
  if (
    !values.every((v) => (v as number) > 0 && Number.isFinite(v)) ||
    !Number.isFinite(k?.centre) ||
    !(k.draught > h.draught)
  )
    throw shipError(
      `A yacht hull needs its waterline length, beam, canoe draught, volume, waterplane, LCB and LCF from the bow, prismatic and midship coefficients, and its keel (draught beyond the canoe body's, volume, root and tip chords, thickness, centre) and rudder (area, chord, thickness), all finite and above 0 (got ${values.join(', ')}); pass them.`,
    );
}

/** The canoe body's wetted area at rest, m^2 (Borba Labi eq. 76). */
export function yachtWettedArea(h: YachtHull): number {
  return (1.97 + (0.171 * h.beam) / h.draught) * pow(0.65 / h.midship, 1 / 3) * Math.sqrt(h.volume * h.length);
}

/** A yacht's water forces at a speed, heel and leeway: resistance along its course and side force across it, N, and their parts. */
export interface YachtWater {
  resistance: number;
  side: number;
  upright: number;
  heeled: number;
  appendages: number;
  induced: number;
  /** The side force per radian of leeway, N. */
  slope: number;
}

/**
 * The hull's and appendages' water forces at `speed` m/s, `heel` rad and `leeway` rad (DSYHS: Keuning and Katgert 2008,
 * Keuning and Sonnenberg 1998).
 */
export function yachtWater(
  h: YachtHull,
  speed: number,
  heel: number,
  leeway: number,
  fluids: YachtFluids = {},
): YachtWater {
  checkHull(h);
  const rho = fluids.density ?? 1025,
    nu = fluids.viscosity ?? 1.19e-6,
    g = fluids.gravity ?? 9.80665,
    V = Math.max(0, speed),
    L = h.length,
    B = h.beam,
    Tc = h.draught,
    vol = h.volume,
    fn = V / Math.sqrt(g * L),
    phi = Math.min(Math.abs(heel), 35 * DEG),
    phiDeg = phi / DEG,
    q = 0.5 * rho * V * V,
    S0 = yachtWettedArea(h),
    // The heeled wetted area (zero change upright, the table from 5 degrees).
    s = row(WETTED_HEEL, 5, 5, phiDeg),
    heelShare = Math.min(1, phiDeg / 5),
    S = S0 * (1 + (heelShare * (s[0]! + (s[1]! * B) / Tc + s[2]! * (B / Tc) * (B / Tc) + s[3]! * h.midship)) / 100),
    cf = friction((0.7 * L * V) / nu),
    a = row(UPRIGHT, 0.15, 0.05, fn),
    residuary =
      rho *
      g *
      vol *
      Math.max(
        0,
        a[0]! +
          (pow(vol, 1 / 3) / L) *
            ((a[1]! * h.lcb) / L +
              a[2]! * h.prismatic +
              (a[3]! * pow(vol, 2 / 3)) / h.waterplane +
              (a[4]! * B) / L +
              (a[5]! * h.lcb) / h.lcf +
              (a[6]! * B) / Tc +
              a[7]! * h.midship),
      ) *
      Math.min(1, fn / 0.15),
    upright = q * S0 * cf + residuary,
    // The heeled residuary resistance: its value at 20 degrees times 6 phi^1.7 (phi in rad), from Fn 0.25.
    u = row(HEEL_20, 0.25, 0.05, fn),
    lcbPercent = (100 * (L / 2 - h.lcb)) / L,
    heel20 =
      fn < 0.2
        ? 0
        : rho *
          g *
          vol *
          1e-3 *
          (u[0]! +
            (u[1]! * L) / B +
            (u[2]! * B) / Tc +
            u[3]! * (B / Tc) * (B / Tc) +
            u[4]! * lcbPercent +
            u[5]! * lcbPercent * lcbPercent) *
          Math.min(1, (fn - 0.2) / 0.05),
    heeled = q * (S - S0) * cf + heel20 * 6 * pow(phi, 1.7),
    // The keel's residuary resistance and its change with heel, and both appendages' friction with their form factors.
    k = h.keel,
    T = k.draught,
    A = row(KEEL, 0.2, 0.05, fn),
    keelResiduary =
      vol > 0
        ? Math.max(
            0,
            k.volume *
              rho *
              g *
              (A[0]! + (A[1]! * T) / B + (A[2]! * (Tc + k.centre)) / pow(k.volume, 1 / 3) + (A[3]! * vol) / k.volume),
          ) * Math.min(1, fn / 0.2)
        : 0,
    keelHeel =
      (-3.5837 * (Tc / T) - (0.0518 * B) / Tc + (0.5958 * B) / T + (0.2055 * L) / pow(k.volume, 1 / 3)) *
      fn *
      fn *
      phi *
      k.volume *
      rho *
      g,
    keelChord = 0.5 * (k.root + k.tip),
    keelArea = (T - Tc) * keelChord,
    form = (t: number) => 1 + 2 * t + 60 * t * t * t * t,
    appendages =
      q * 2 * keelArea * friction((V * keelChord) / nu) * form(k.thickness) +
      q * 2 * h.rudder.area * friction((V * h.rudder.chord) / nu) * form(h.rudder.thickness) +
      keelResiduary +
      Math.max(0, keelHeel),
    // The side force (Keuning and Sonnenberg), perpendicular to the keel, and the induced drag on the effective span.
    b = row(SIDE, 0, 10, Math.min(30, phiDeg)),
    t2 = (T * T) / S,
    slope = (q * S * (b[0]! * t2 + b[1]! * t2 * t2 + (b[2]! * Tc) / T + (b[3]! * Tc * T) / S)) / cos(phi),
    side = slope * leeway,
    sp = row(SPAN, 0, 10, Math.min(30, phiDeg)),
    span =
      T *
      (sp[0]! * (Tc / T) + sp[1]! * (Tc / T) * (Tc / T) + (sp[2]! * B) / Tc + sp[3]! * (k.tip / k.root)) *
      (sp[4]! + sp[5]! * fn),
    induced = q > 0 && span > 0 ? (side * side) / (Math.PI * span * span * q) : 0;
  return { resistance: upright + heeled + appendages + induced, side, upright, heeled, appendages, induced, slope };
}

/** A yacht's sail forces: driving force along the course and heeling force across the heeled rig, N, and the centre of effort's height above the water, m. */
export interface YachtSails {
  drive: number;
  heel: number;
  centre: number;
  /** The effective apparent wind angle, rad, and speed, m/s. */
  angle: number;
  speed: number;
}

/**
 * The mainsail's and jib's forces (ORC 2023, low-tech sets) at apparent wind `awa` rad and `aws` m/s, heeled `heel` rad,
 * flattened to `flat` (0.42 to 1) and reefed to `reef` of their area (0 to 1).
 */
export function yachtSails(
  rig: YachtRig,
  awa: number,
  aws: number,
  heel: number,
  flat = 1,
  reef = 1,
  fluids: YachtFluids = {},
): YachtSails {
  const { I, J, P, E, boom, freeboard } = rig ?? ({} as YachtRig);
  if (![I, J, P, E, boom, freeboard].every((v) => v > 0 && Number.isFinite(v)))
    throw shipError(
      `A yacht's rig is {I, J, P, E, boom, freeboard} in metres above 0 (got ${[I, J, P, E, boom, freeboard].join(', ')}); pass them.`,
    );
  // The wind in the heeled rig's plane.
  const a = Math.abs(awa),
    eff = atan2(sin(a) * cos(heel), cos(a)),
    speed = aws * Math.sqrt(Math.max(0, 1 - sin(a) * sin(a) * sin(heel) * sin(heel))),
    deg = eff / DEG,
    r = Math.max(0.05, Math.min(1, reef)),
    main = 0.5 * P * E * r,
    jib = 0.5 * I * J * r,
    ref = main + jib,
    [clm, cdm] = column(MAIN, deg),
    [clj, cdj] = column(JIB, deg),
    // The jib is blanketed by the main from 135 degrees (ORC p. 57).
    bkj = deg <= 135 ? 1 : Math.max(0, 1 - (deg - 135) / 45),
    clMax = (clm * main + clj * bkj * jib) / ref,
    cd0 = (cdm * main + cdj * bkj * jib) / ref,
    kpp = clMax !== 0 ? (0.01379 * clm * clm * main + 0.016 * clj * clj * bkj * jib) / (ref * clMax * clMax) : 0,
    // The effective height: ORC's span correction for a masthead rig (fractionality 1, overlap 1, roach 0.2) times kheff,
    // 1.4513 at 20 degrees to 0.80 at 80 degrees (its plot's ends; between them a straight line, an assumption).
    kheff = 1.4513 + (Math.max(20, Math.min(80, deg)) - 20) * ((0.8 - 1.4513) / 60),
    heff = (1.1 + 0.5 * (0.68 + 0.31 + 0.075 - 1.1)) * kheff * (Math.max(I, P + boom) * r + freeboard),
    ce = kpp + ref / (Math.PI * heff * heff),
    f = Math.max(0.42, Math.min(1, flat)),
    fcd =
      f <= 0.55
        ? 1.06
        : row(
            FLAT_DRAG.map((v) => [v]),
            0.55,
            0.05,
            f,
          )[0]!,
    fcdj = cd0 > 0 ? (cdj * bkj * jib) / (cd0 * ref) : 0,
    cd = cd0 * (f * fcd * fcdj + (1 - fcdj)) + ce * clMax * clMax * f * f * fcd,
    cl = f * clMax,
    q = 0.5 * (fluids.air ?? 1.225) * speed * speed * ref,
    // The centres of effort: the main's at 0.39 P above its boom, the jib's at 0.39 I, weighted by their forces.
    zm = boom + 0.39 * P * r,
    zj = freeboard + 0.39 * I * r,
    wm = Math.hypot(clm, cdm) * main,
    wj = Math.hypot(clj, cdj) * bkj * jib,
    centre = (zm * wm + zj * wj) / (wm + wj);
  return {
    drive: q * (cl * sin(eff) - cd * cos(eff)),
    heel: q * (cl * cos(eff) + cd * sin(eff)),
    centre,
    angle: eff,
    speed,
  };
}

/** A yacht sailing steady: boat speed, m/s, heel and leeway, rad, the sails' flattening, and the apparent wind. */
export interface YachtRun {
  speed: number;
  heel: number;
  leeway: number;
  flat: number;
  /** The share of the sail area set, 0.4 to 1. */
  reef: number;
  apparentAngle: number;
  apparentSpeed: number;
  drive: number;
  side: number;
}

/**
 * A velocity prediction: the steady speed of a yacht in a true wind `tws` m/s at `twa` rad off its course, its sails
 * flattened for the most speed (ORC's FLAT, 0.42 to 1), heeled where the righting moment m g GM sin(phi) meets the sails'
 * heeling moment and drifting at the leeway where the keel's side force meets the sails'; heeled past `maxHeel` (default
 * 30 degrees, an assumption for a crew that depowers) it flattens and then reefs.
 */
export function velocityPrediction(
  hull: YachtHull,
  rig: YachtRig,
  tws: number,
  twa: number,
  fluids: YachtFluids & { readonly maxHeel?: number } = {},
): YachtRun {
  checkHull(hull);
  if (!(tws > 0 && Number.isFinite(tws) && Number.isFinite(twa)))
    throw shipError(`A true wind is a speed above 0 m/s and an angle in rad (got ${tws}, ${twa}); pass them.`);
  if (!(rig?.mass > 0 && rig.metacentricHeight > 0))
    throw shipError(
      `A yacht's rig has its mass, kg, and metacentric height, m, above 0 (got ${rig?.mass}, ${rig?.metacentricHeight}); pass them.`,
    );
  const g = fluids.gravity ?? 9.80665,
    lateral = hull.draught + 0.45 * (hull.keel.draught - hull.draught),
    maxHeel = fluids.maxHeel ?? 30 * DEG,
    at = (V: number, flat: number, reef = 1) => {
      // The apparent wind on the course, then the heel where the moments meet (iterated: the heel changes the wind).
      const wx = tws * cos(twa) + V,
        wy = tws * sin(Math.abs(twa)),
        awa = atan2(wy, wx),
        aws = Math.hypot(wx, wy);
      let heel = 0,
        sails = yachtSails(rig, awa, aws, heel, flat, reef, fluids);
      for (let i = 0; i < 40; i++) {
        const moment = sails.heel * (sails.centre + lateral) * cos(heel),
          s = moment / (rig.mass * g * rig.metacentricHeight),
          next = s >= 1 ? 1.2 : atan2(s, Math.sqrt(1 - s * s));
        if (Math.abs(next - heel) < 1e-7) break;
        heel = 0.5 * (heel + next);
        sails = yachtSails(rig, awa, aws, heel, flat, reef, fluids);
      }
      const unit = yachtWater(hull, V, heel, 1, fluids),
        leeway = unit.slope > 0 ? (sails.heel * cos(heel)) / unit.slope : 0,
        water = yachtWater(hull, V, heel, leeway, fluids);
      return { drive: sails.drive, resistance: water.resistance, heel, leeway, sails, side: water.side };
    },
    // The speed where the drive meets the resistance, at a flattening: the fastest such speed (at a crawl the leeway's
    // induced drag outruns the drive too), found stepping down from Fn 1 and then by bisection.
    speedAt = (flat: number, reef = 1) => {
      const top = Math.sqrt(g * hull.length),
        steps = 40;
      let lo = 0,
        hi = top;
      for (let i = steps - 1; i >= 1; i--) {
        const v = (top * i) / steps,
          r = at(v, flat, reef);
        if (r.drive > r.resistance) {
          lo = v;
          hi = (top * (i + 1)) / steps;
          break;
        }
      }
      if (lo === 0) return 0;
      for (let i = 0; i < 50; i++) {
        const mid = 0.5 * (lo + hi),
          r = at(mid, flat, reef);
        if (r.drive > r.resistance) lo = mid;
        else hi = mid;
      }
      return 0.5 * (lo + hi);
    };
  // The flattening that gives the most speed (golden-section search over 0.42 to 1).
  let a = 0.42,
    b = 1;
  const k = (Math.sqrt(5) - 1) / 2;
  let c = b - k * (b - a),
    d = a + k * (b - a),
    fc = speedAt(c),
    fd = speedAt(d);
  for (let i = 0; i < 25; i++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - k * (b - a);
      fc = speedAt(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + k * (b - a);
      fd = speedAt(d);
    }
  }
  let flat = speedAt(1) >= Math.max(fc, fd) ? 1 : 0.5 * (a + b),
    reef = 1,
    speed = speedAt(flat),
    r = at(speed, flat);
  // Over-pressed (heeled past `maxHeel`), the crew depowers as the ORC's VPP does: flattens to 0.42, then reefs to 40
  // percent of the area, taking the fastest setting that heels no further.
  if (r.heel > maxHeel) {
    let best = -1;
    for (let i = 0; i <= 24; i++) {
      const p = i / 24,
        f = p <= 0.5 ? 1 - 0.58 * (p / 0.5) : 0.42,
        rf = p <= 0.5 ? 1 : 1 - 0.6 * ((p - 0.5) / 0.5),
        v = speedAt(f, rf),
        run = at(v, f, rf);
      if ((run.heel <= maxHeel || i === 24) && v > best) {
        best = v;
        flat = f;
        reef = rf;
        speed = v;
        r = run;
        if (run.heel <= maxHeel) break;
      }
    }
  }
  return {
    speed,
    heel: r.heel,
    leeway: r.leeway,
    flat,
    reef,
    apparentAngle: r.sails.angle,
    apparentSpeed: r.sails.speed,
    drive: r.drive,
    side: r.side,
  };
}

/** A yacht on a rigid body: its row, hull, rig (none when its sails are another solver's, AERO-02's cloth), and frame. */
export interface Yacht {
  readonly row: number;
  readonly hull: YachtHull;
  readonly rig?: YachtRig;
  /** The waterline at the midship, in the body's frame, m (default the body's origin), and the body's forward and up axes. */
  readonly waterline?: readonly [number, number, number];
  readonly forward?: readonly [number, number, number];
  readonly up?: readonly [number, number, number];
  /** What holds it upright: 'model' (default) g m GM sin(phi), or 'hull' a HullSolver floating the body. */
  readonly roll?: 'model' | 'hull';
  /** GM, m, for 'model' (default the rig's): a yacht whose sails are another solver's gives its own. */
  readonly metacentricHeight?: number;
}

/** What a {@link SailingSolver} is made from. */
export interface SailingParams extends YachtFluids {
  readonly yachts: readonly Yacht[];
  /** The true wind: a velocity, m/s, or a flow field of air (a gusting wind solver's); default calm. */
  readonly wind?: readonly [number, number, number] | FlowField;
  readonly capacity?: number;
  readonly level?: RateLevel;
}

/** A yacht's helm and sails: the heading the helm holds, rad (null leaves the yaw free), and the sails' FLAT and reef. */
export interface SailingControl {
  heading: number | null;
  flat: number;
  reef: number;
}

/** What a yacht did in the last step. */
export interface SailingStatus {
  speed: number;
  leeway: number;
  heel: number;
  heading: number;
  apparentAngle: number;
  apparentSpeed: number;
  drive: number;
  side: number;
  resistance: number;
}

/**
 * Sailing yachts on rigid bodies: each step the hull's and keel's water forces at the body's speed, leeway and heel
 * (`yachtWater`) and, with a rig, the sails' forces in the wind at their centre of effort (`yachtSails`), the keel's side
 * force at its centre of lateral resistance so the yacht heels and rolls against its righting moment. The helm holds the
 * heading by a yaw moment that answers its error critically damped (the rudder's own forces are not modelled). `id` is
 * `'sailing'` by default.
 */
export class SailingSolver implements Solver<SailingParams> {
  private readonly id: string;
  private host!: SolverHost;
  private rate: RateLevel = 0;
  private capacity = 0;
  private fluids: YachtFluids = {};
  private wind: SailingParams['wind'];
  private vertical: Vec3 = [0, 1, 0];
  private g = 9.80665;
  private yachts: readonly Yacht[] = [];
  private controls: SailingControl[] = [];
  private statuses: SailingStatus[] = [];
  private forces!: Region;
  private cell: [number, number, number] = [0, 0, 0];
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0 } as unknown as FlowSample;

  constructor(id = 'sailing') {
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

  init(host: SolverHost, params: SailingParams): void {
    const { yachts, wind, level = 0 } = params ?? ({} as SailingParams);
    if (!Array.isArray(yachts) || yachts.length === 0)
      throw shipError('Sailing yachts need their bodies: pass {yachts: [{row, hull, rig}]}.');
    for (const y of yachts) {
      if (!(Number.isInteger(y?.row) && y.row >= 0))
        throw shipError(`A yacht's body row is a whole number, 0 or more (got ${y?.row}); pass the body's row.`);
      checkHull(y.hull);
      if (y.rig) yachtSails(y.rig, 0.5, 1, 0);
      if (y.roll !== undefined && y.roll !== 'model' && y.roll !== 'hull')
        throw shipError(`A yacht's roll is held by 'model' or 'hull' (got ${String(y.roll)}); pass one.`);
      if (y.roll !== 'hull' && !((y.metacentricHeight ?? y.rig?.metacentricHeight)! > 0))
        throw shipError(
          "A yacht the model holds upright needs its metacentric height (its own or its rig's); pass it, or roll: 'hull' with a HullSolver.",
        );
    }
    if (
      wind !== undefined &&
      !(Array.isArray(wind)
        ? wind.length === 3 && wind.every(Number.isFinite)
        : typeof (wind as FlowField).sample === 'function')
    )
      throw shipError('A true wind is a velocity [x, y, z] in m/s or a flow field of air; pass one.');
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw shipError(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    const gv = host.gravity ?? DEFAULT_GRAVITY,
      gl = hypot(gv[0], gv[1], gv[2]);
    if (!(gl > 0))
      throw shipError(
        'A yacht heels against its weight, and this world has no gravity; give the PhysicsWorld its gravity.',
      );
    this.host = host;
    this.rate = level as RateLevel;
    this.g = gl;
    this.vertical = [-gv[0] / gl, -gv[1] / gl, -gv[2] / gl];
    this.fluids = { density: params.density, viscosity: params.viscosity, air: params.air, gravity: gl };
    this.wind = wind;
    this.yachts = yachts;
    this.controls = yachts.map(() => ({ heading: null, flat: 1, reef: 1 }));
    this.statuses = yachts.map(() => ({
      speed: 0,
      leeway: 0,
      heel: 0,
      heading: 0,
      apparentAngle: 0,
      apparentSpeed: 0,
      drive: 0,
      side: 0,
      resistance: 0,
    }));
    this.capacity = bodyRowsOf(
      host,
      'A SailingSolver',
      yachts.map((y) => y.row),
      params.capacity,
    );
    this.forces = host.allocate('forces', this.capacity * FORCE_WORDS * 8, 'f64', 1);
  }

  /** Yacht `index`'s helm and sails: `sailing.control(0).heading = 0.5`. */
  control(index: number): SailingControl {
    const c = this.controls[index];
    if (!c) throw shipError(`There is no yacht ${index}; pass 0 to ${this.controls.length - 1}.`);
    return c;
  }

  /** What yacht `index` did in the last step. */
  status(index: number): SailingStatus {
    const s = this.statuses[index];
    if (!s) throw shipError(`There is no yacht ${index}; pass 0 to ${this.statuses.length - 1}.`);
    return s;
  }

  private windAt(p: Vec3, t: number): Vec3 {
    const w = this.wind;
    if (!w) return [0, 0, 0];
    if (Array.isArray(w)) return [w[0]!, w[1]!, w[2]!];
    const field = w as FlowField,
      s = field.sample(p[0], p[1], p[2], t, this.sample);
    return [s.velocity[0], s.velocity[1], s.velocity[2]];
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array;
    out.fill(0);
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    const memory = port.region.memory ?? this.host.memory,
      bodies = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4),
      vertical = this.vertical,
      time = (context.tick + 1) / rateOf(context.level),
      g = this.g;
    this.yachts.forEach((yacht, index) => {
      const at = yacht.row * BODY_WORDS,
        c = this.controls[index]!,
        status = this.statuses[index]!;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) return;
      const q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
        origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
        centre: Vec3 = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!],
        velocity: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
        spin: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
        inverseMass = bodies[at + 16]!,
        mass = inverseMass > 0 ? 1 / inverseMass : 0,
        up = vrotate(q, yacht.up ?? [0, 1, 0]),
        ahead = vrotate(q, yacht.forward ?? [1, 0, 0]),
        flat = vsub(ahead, vscale(vertical, vdot(ahead, vertical))),
        fl = hypot(flat[0], flat[1], flat[2]),
        f = fl > 1e-9 ? vscale(flat, 1 / fl) : ahead,
        s = vcross(f, vertical),
        heading = atan2(f[2], f[0]),
        heel = atan2(vdot(up, s), vdot(up, vertical)),
        water = vadd(origin, vrotate(q, yacht.waterline ?? [0, 0, 0])),
        H = yacht.hull,
        // The keel's centre of lateral resistance: 45 percent of the way down the fin, below the waterline in the heeled hull.
        lateralDepth = H.draught + 0.45 * (H.keel.draught - H.draught),
        clr = vsub(water, vscale(up, lateralDepth)),
        vk = vadd(velocity, vcross(spin, vsub(clr, centre))),
        u = vdot(vk, f),
        v = vdot(vk, s),
        speed = Math.hypot(u, v),
        leeway = u > 1e-6 ? atan2(v, u) : 0,
        w = yacht.row * FORCE_WORDS;
      status.speed = vdot(velocity, f);
      status.heel = heel;
      status.heading = heading;
      status.leeway = leeway;
      if (mass === 0) return;
      // The water: resistance against the keel's motion through it and the side force against its leeway, at the keel.
      const wat = yachtWater(H, speed, heel, Math.abs(leeway), this.fluids),
        along = speed > 1e-9 ? vscale(vadd(vscale(f, u), vscale(s, v)), -wat.resistance / speed) : [0, 0, 0],
        across = vscale(s, -Math.sign(leeway) * wat.side * cos(heel));
      status.resistance = wat.resistance;
      status.side = wat.side;
      // Applied at the keel's depth but the centre of gravity's length: the helm, not the hull, balances the yaw.
      const lever = vadd(centre, vscale(up, vdot(vsub(clr, centre), up)));
      apply(out, w, centre, lever, vadd(along as Vec3, across));
      let drive = 0;
      if (yacht.rig) {
        // The sails: the apparent wind at the centre of effort (the true wind less the boat's motion there), its angle off
        // the bow; the drive along the heading and the heeling force across it, at the centre of effort's height.
        const rig = yacht.rig,
          probe = vadd(water, vscale(up, rig.boom + 0.39 * rig.P)),
          air = vsub(this.windAt(probe, time), vadd(velocity, vcross(spin, vsub(probe, centre)))),
          ax = -vdot(air, f),
          ay = -vdot(air, s),
          awa = atan2(Math.abs(ay), ax),
          aws = Math.hypot(ax, ay),
          sails = yachtSails(rig, awa, aws, heel, c.flat, c.reef, this.fluids),
          // The heeling force pushes to leeward: away from the side the wind comes from.
          leeward = ay > 0 ? -1 : 1,
          force = vadd(vscale(f, sails.drive), vscale(s, leeward * sails.heel * cos(heel))),
          point = vadd(centre, vscale(up, vdot(vsub(vadd(water, vscale(up, sails.centre)), centre), up)));
        apply(out, w, centre, point, force);
        drive = sails.drive;
        status.apparentAngle = awa;
        status.apparentSpeed = aws;
      }
      status.drive = drive;
      // Upright: the model's righting moment, or a HullSolver's.
      if (yacht.roll !== 'hull') {
        const righting = -mass * g * (yacht.metacentricHeight ?? yacht.rig!.metacentricHeight) * sin(heel);
        for (let k = 0; k < 3; k++) out[w + 3 + k]! += righting * f[k]!;
      }
      // The helm: a yaw moment answering the heading's error critically damped at 1 rad/s.
      if (c.heading !== null && Number.isFinite(c.heading)) {
        const iz =
            1 /
            Math.max(
              1e-12,
              vertical[0] *
                (bodies[at + 17]! * vertical[0] + bodies[at + 18]! * vertical[1] + bodies[at + 19]! * vertical[2]) +
                vertical[1] *
                  (bodies[at + 18]! * vertical[0] + bodies[at + 20]! * vertical[1] + bodies[at + 21]! * vertical[2]) +
                vertical[2] *
                  (bodies[at + 19]! * vertical[0] + bodies[at + 21]! * vertical[1] + bodies[at + 22]! * vertical[2]),
            ),
          err = atan2(sin(c.heading - heading), cos(c.heading - heading)),
          yawRate = -vdot(spin, vertical),
          omega = 1,
          moment = iz * (omega * omega * err - 2 * omega * yawRate);
        // A heading toward +Z (positive) turns about -vertical.
        for (let k = 0; k < 3; k++) out[w + 3 + k]! -= moment * vertical[k]!;
      }
    });
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

function apply(out: Float64Array, w: number, centre: Vec3, point: Vec3, force: Vec3): void {
  const m = vcross(vsub(point, centre), force);
  for (let k = 0; k < 3; k++) {
    out[w + k]! += force[k]!;
    out[w + 3 + k]! += m[k]!;
  }
}
function vrotate(q: readonly [number, number, number, number], v: readonly [number, number, number]): Vec3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function vadd(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}
function vsub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function vscale(a: readonly number[], k: number): Vec3 {
  return [a[0]! * k, a[1]! * k, a[2]! * k];
}
function vdot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function vcross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
