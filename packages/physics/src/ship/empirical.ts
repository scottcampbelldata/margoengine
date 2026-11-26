// A manoeuvring model for any hull from its main dimensions (SEA-09): the MMG standard method's coefficients estimated by
// the published regressions, so a ship without captive tests (a Great Lakes freighter, a coaster) turns as its form says
// rather than as KVLCC2 does.
// - The hull's linear derivatives and, for full hulls, its nonlinear ones in their own v'|v'| and r'|r'| form: K. Kijima, T.
//   Katsuno, Y. Nakiri and Y. Furukawa, "On the manoeuvring performance of a ship with the parameter of loading condition", J.
//   Soc. Naval Architects of Japan 168, 141-148, 1990 (eqs. 1 to 15 and table 1, read on J-STAGE), mapped to MMG's v' form
//   (odd terms in the drift flip sign) and moved from the centre of gravity to the midship.
// - Fine hulls' cubic terms, the surge terms, the trim corrections and the rudder's interaction coefficients: Y. Yoshimura and
//   Y. Masumoto, "Hydrodynamic database and manoeuvring prediction method with medium high-speed merchant ships and fishing
//   vessels", J. Japan Soc. Naval Architects and Ocean Engineers 14, 63-73, 2011 (eqs. 4.1 to 4.7, read), N'vrr with the sign
//   of their own figure 3.2 and X'vr as Lotovskyi et al. (2025) convert it.
// - Added masses: Clarke, Gedling and Hine (1983) for sway and yaw (its yaw term -0.33 B/L, which reproduces KVLCC2's
//   captive J'z where the -0.0033 of one restatement does not) and Brix (1993) for surge, as Taimuri et al. (2020) restate them.
// - The straight-run wake 0.5 C_B - 0.05 (Kijima 1990 eq. 14), Holtrop's (1984) thrust deduction and form factor, the
//   ITTC-1957 line and Holtrop and Mennen's wetted area for R'_0 (resistance.ts).
// Each estimate holds over the hulls it was fitted to: Kijima L/B 4.5 to 6.9, d/B 0.16 to 0.42, C_B 0.49 to 0.835; Yoshimura
// and Masumoto L/B 2.6 to 7.1, d/B 0.25 to 0.46, C_B 0.51 to 0.65. `range` reports where a hull falls outside; nothing is
// clamped.
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { pow } from '@margoengine/math/pinned';
import type { ManoeuvringModel } from './mmg.js';
import { KVLCC2_PROPELLER, type PropellerCurves, rudderLiftSlope } from './propeller.js';
import { ittc1957, SEA_WATER_VISCOSITY } from './resistance.js';

const PI = 3.141592653589793;

/** A hull's main dimensions and gear, for {@link empiricalModel}. */
export interface EmpiricalHull {
  /** Length between perpendiculars, beam and mean draught, m; block coefficient. */
  readonly length: number;
  readonly beam: number;
  readonly draught: number;
  readonly block: number;
  /** Trim by the stern (aft minus forward draught), m (default 0; by the bow is not in the regressions). */
  readonly trim?: number;
  /** Centre of gravity forward of the midship, m (default 0). */
  readonly centre?: number;
  /** Midship section coefficient (default 0.98) and longitudinal centre of buoyancy, percent of L forward of midship (default 0). */
  readonly midship?: number;
  readonly lcb?: number;
  /** The propeller: diameter, m, open-water curves (default KVLCC2's), place x'_P (default -0.48). */
  readonly propeller: { readonly diameter: number; readonly curves?: PropellerCurves; readonly position?: number };
  /** The rudder: area, m^2, and span, m. */
  readonly rudder: { readonly area: number; readonly span: number };
  /** 'full' (Kijima's nonlinear terms, C_B 0.7 and above), 'fine' (Yoshimura and Masumoto's cubics) or 'auto' (default). */
  readonly family?: 'auto' | 'full' | 'fine';
  /** The service speed for R'_0's Reynolds number, m/s (default Fn 0.15). */
  readonly speed?: number;
  readonly density?: number;
  readonly viscosity?: number;
  readonly gravity?: number;
}

/** Where a hull lies against the regressions' databases. */
export interface EmpiricalRange {
  /** Inside Kijima's (1990) hulls on L/B, d/B and C_B. */
  kijima: boolean;
  /** Inside Yoshimura and Masumoto's (2011) hulls. */
  yoshimura: boolean;
  /** What lies outside, as text (empty when inside the family's own range). */
  outside: string[];
}

/**
 * The MMG model of a hull from its dimensions: Kijima's (1990) linear derivatives (and his nonlinear ones for a full hull),
 * Yoshimura and Masumoto's (2011) cubics for a fine one, their surge terms, trim corrections and rudder interaction set,
 * Clarke's and Brix's added masses, and R'_0 by the ITTC-1957 line and Holtrop's form factor. `range` says where the hull lies
 * against the databases; a hull outside them (a Great Lakes freighter at L/B 9.5) is an extrapolation.
 */
export function empiricalModel(hull: EmpiricalHull): ManoeuvringModel & { readonly range: EmpiricalRange } {
  const {
    length: L,
    beam: B,
    draught: d,
    block: Cb,
    trim = 0,
    centre = 0,
    midship: CM = 0.98,
    lcb = 0,
  } = hull ?? ({} as EmpiricalHull);
  for (const [name, v] of [
    ['length', L],
    ['beam', B],
    ['draught', d],
  ] as const)
    if (!(v > 0 && Number.isFinite(v)))
      throw new RangeError(`A hull's ${name} is finite metres above 0 (got ${v}); pass it.`);
  if (!(Cb > 0.3 && Cb < 1)) throw new RangeError(`A block coefficient lies in (0.3, 1) (got ${Cb}); pass one.`);
  if (!(trim >= 0 && Number.isFinite(trim)))
    throw new RangeError(
      `Trim by the stern is finite metres, 0 or more (got ${trim}); the regressions hold no trim by the bow.`,
    );
  if (!(hull.propeller?.diameter > 0 && hull.rudder?.area > 0 && hull.rudder?.span > 0))
    throw new RangeError('A hull needs its propeller {diameter} and rudder {area, span} in metres; pass them.');
  const rho = hull.density ?? 1025,
    nu = hull.viscosity ?? SEA_WATER_VISCOSITY,
    g = hull.gravity ?? gravityMagnitude(DEFAULT_GRAVITY),
    k = (2 * d) / L,
    cbl = (Cb * B) / L,
    dB = d / B,
    tau = trim / d,
    volume = Cb * L * B * d,
    mass = rho * volume,
    half = 0.5 * rho * L * L * d,
    xG = centre / L;
  // Added masses: Brix for surge, Clarke for sway and yaw (MMG units).
  const mx = mass / (PI * Math.sqrt((L * L * L) / volume) - 14) / half,
    my = PI * (d / L) * (d / L) * (1 + 0.16 * Cb * (B / d) - 5.1 * (B / L) * (B / L)) * (L / d),
    jz = PI * (d / L) * (d / L) * (1 / 12 + 0.017 * Cb * (B / d) - 0.33 * (B / L)) * (L / d);
  // Kijima's linear set at G, with Yoshimura and Masumoto's trim corrections.
  const yvG = -(0.5 * PI * k + 1.4 * cbl) * (1 + 0.54 * tau * tau),
    yrG = mx + 0.5 * cbl * (1 + 1.82 * tau * tau),
    nvG = -k * (1 - 0.85 * tau),
    nrG = (-0.54 * k + k * k) * (1 + 0.33 * tau),
    // Moved to the midship: v'_mid = v'_G - x'_G r'.
    yv = yvG,
    yr = yrG + xG * yvG,
    nv = nvG + xG * yvG,
    nr = nrG + xG * (nvG + yrG) + xG * xG * yvG;
  const family = hull.family === 'full' || hull.family === 'fine' ? hull.family : Cb >= 0.7 ? 'full' : 'fine',
    lb = L / B;
  let sway: [number, number, number, number, number, number], yaw: [number, number, number, number, number, number];
  if (family === 'full') {
    // Kijima's v'|v'|, r'|r'| and mixed terms, even keel.
    sway = [yv, yr, -(2.5 * dB * (1 - Cb) + 0.5), 1.5 * dB * Cb - 0.65, -5.95 * dB * (1 - Cb), 0.343 * dB * Cb - 0.07];
    yaw = [
      nv,
      nr,
      0.96 * dB * (1 - Cb) - 0.066,
      -(57.5 * cbl * cbl - 18.4 * cbl + 1.6),
      0.5 * dB * Cb - 0.05,
      0.5 * cbl - 0.09,
    ];
  } else {
    sway = [
      yv,
      yr,
      -(0.185 * lb + 0.48),
      (0.97 * tau) / Cb - 0.75,
      -(0.26 * (1 - Cb) * lb + 0.11),
      0.069 * tau - 0.051,
    ];
    yaw = [nv, nr, 0.69 * Cb - 0.66, 1.55 * cbl - 0.76, -0.075 * (1 - Cb) * lb + 0.098, 0.25 * cbl - 0.056];
  }
  const surge: [number, number, number, number] = [
    1.15 * cbl - 0.18,
    -my + 1.91 * cbl - 0.08,
    -0.085 * cbl + 0.008 - xG * my,
    -6.68 * cbl + 1.1,
  ];
  // R'_0: the ITTC-1957 line with Holtrop's (1984) form factor over Holtrop and Mennen's wetted area.
  const Cp = Cb / CM,
    cwp = (1 + 2 * Cb) / 3,
    LR = L * (1 - Cp + (0.06 * Cp * lcb) / (4 * Cp - 1)),
    k1 =
      0.93 +
      0.487118 *
        pow(B / L, 1.06806) *
        pow(d / L, 0.46106) *
        pow(L / LR, 0.121563) *
        pow((L * L * L) / volume, 0.36486) *
        pow(1 - Cp, -0.604247),
    S = L * (2 * d + B) * Math.sqrt(CM) * (0.453 + 0.4425 * Cb - 0.2862 * CM - 0.003467 * (B / d) + 0.3696 * cwp),
    speed = hull.speed ?? 0.15 * Math.sqrt(g * L),
    resistance = (k1 * ittc1957((speed * L) / nu) * S) / (L * d);
  // The propeller's wake and thrust deduction.
  const D = hull.propeller.diameter,
    wake = 0.5 * Cb - 0.05,
    thrustDeduction =
      (0.25014 * pow(B / L, 0.28956) * pow(Math.sqrt(B * d) / D, 0.2624)) / pow(1 - Cp + 0.0225 * lcb, 0.01762),
    epsilon = 2.26 - 1.82 * (1 - wake),
    straightening = 2.06 * cbl + 0.14,
    { area, span } = hull.rudder;
  // Ranges.
  const outside: string[] = [],
    inK = lb >= 4.5 && lb <= 6.9 && dB >= 0.16 && dB <= 0.42 && Cb >= 0.49 && Cb <= 0.835,
    inY = lb >= 2.6 && lb <= 7.1 && dB >= 0.25 && dB <= 0.46 && Cb >= 0.51 && Cb <= 0.65;
  if (!(family === 'full' ? inK : inY)) {
    const [lo, hi, dlo, dhi, clo, chi] =
      family === 'full' ? [4.5, 6.9, 0.16, 0.42, 0.49, 0.835] : [2.6, 7.1, 0.25, 0.46, 0.51, 0.65];
    if (lb < lo || lb > hi) outside.push(`L/B ${lb.toFixed(2)} outside ${lo} to ${hi}`);
    if (dB < dlo || dB > dhi) outside.push(`d/B ${dB.toFixed(3)} outside ${dlo} to ${dhi}`);
    if (Cb < clo || Cb > chi) outside.push(`C_B ${Cb} outside ${clo} to ${chi}`);
  }
  return {
    length: L,
    beam: B,
    draught: d,
    volume,
    centre,
    gyration: 0.25 * L,
    addedMass: [mx, my, jz],
    resistance,
    surge,
    sway,
    yaw,
    form: family === 'full' ? 'kijima' : 'cubic',
    propeller: {
      diameter: D,
      curves: hull.propeller.curves ?? KVLCC2_PROPELLER,
      position: hull.propeller.position ?? -0.48,
      thrustDeduction,
      wake,
      wakeChange: [2.0, 1.6, 1.1],
    },
    rudder: {
      area,
      span,
      liftSlope: rudderLiftSlope((span * span) / area),
      resistanceDeduction: 1 - (0.32 * tau + 0.61),
      forceIncrease: 3.6 * cbl,
      forcePosition: -0.4,
      straightening: [straightening, straightening],
      lever: -0.9,
      wakeRatio: epsilon,
      kappa: 0.55 / epsilon,
    },
    range: { kijima: inK, yoshimura: inY, outside },
  };
}
