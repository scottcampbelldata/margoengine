// A ship's resistance and its propulsion factors (SEA-09): the ITTC-1957 friction line and the Holtrop and Mennen statistical
// method, the standard estimate of a hull's calm-water resistance from its main dimensions, with the wake fraction, thrust
// deduction and relative rotative efficiency its propeller works in.
//
// Written from (papers only; no code read):
// - J. Holtrop and G. G. J. Mennen, "An approximate power prediction method", International Shipbuilding Progress 29(335),
//   166-170, 1982 (sections 2 to 5, read): R = R_F (1 + k1) + R_APP + R_W + R_B + R_TR + R_A with every coefficient, the
//   wetted area, the wake fraction w, thrust deduction t and eta_R, and Keller's blade area; its worked example (205 m, 25 kn)
//   is the test.
// - J. Holtrop, "A statistical re-analysis of resistance and propulsion data", International Shipbuilding Progress 31(363),
//   272-276, 1984 (read): the form factor and the wave resistance's Fn < 0.4 and Fn > 0.55 branches.
// - ITTC Recommended Procedure 7.5-02-03-01.4, "1978 ITTC Performance Prediction Method" (read): the ITTC-1957 line
//   C_F = 0.075 / (log10 Re - 2)^2 and the air resistance C_AA = C_DA rho_A A_VS / (rho S).
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { cos, exp, ln, pow } from '@margoengine/math/pinned';

const LN10 = 2.302585092994046;
/** Sea water's kinematic viscosity at 15 degrees C, m^2/s (the value that gives Holtrop and Mennen's example its C_F). */
export const SEA_WATER_VISCOSITY = 1.1883e-6;
/** Sea water's density, kg/m^3 (Holtrop and Mennen's). */
export const SEA_WATER_DENSITY = 1025;

/** The ITTC-1957 model-ship correlation line: C_F = 0.075 / (log10 Re - 2)^2. */
export function ittc1957(reynolds: number): number {
  if (!(reynolds > 100 && Number.isFinite(reynolds)))
    throw new RangeError(`The friction line takes a Reynolds number above 100 (got ${reynolds}); pass V L / nu.`);
  const l = ln(reynolds) / LN10 - 2;
  return 0.075 / (l * l);
}

/** A hull for {@link holtropMennen}, in metres, m^2 and m^3. */
export interface HoltropHull {
  /** Length on the waterline, m. */
  readonly length: number;
  readonly beam: number;
  /** Draughts at the forward and aft perpendiculars, m. */
  readonly draughtFore: number;
  readonly draughtAft: number;
  /** Displaced volume, m^3. */
  readonly volume: number;
  /** Longitudinal centre of buoyancy forward of half the length, percent of the length (aft negative). */
  readonly lcb: number;
  /** Midship section coefficient C_M. */
  readonly midship: number;
  /** Waterplane area coefficient C_WP. */
  readonly waterplane: number;
  /** A bulbous bow: its transverse area at the forward perpendicular, m^2, and its centre's height above the keel, m. */
  readonly bulb?: { readonly area: number; readonly centre: number };
  /** The immersed transom's area at rest, m^2 (default 0). */
  readonly transom?: number;
  /** The appendages' wetted areas, m^2, each with its form factor 1 + k2 (a rudder behind a skeg 1.5 to 2.0, a skeg 1.5 to 2.0, shafts 2.0 to 4.0, bilge keels 1.4). */
  readonly appendages?: readonly { readonly area: number; readonly factor: number }[];
  /** The afterbody's form: -25 a pram with gondola, -10 V sections, 0 normal, 10 U sections with a Hogner stern (default 0). */
  readonly stern?: number;
  /** The hull's wetted area, m^2 (default Holtrop and Mennen's estimate). */
  readonly wettedArea?: number;
  /** The half angle of entrance of the waterline, degrees (default Holtrop and Mennen's estimate). */
  readonly entrance?: number;
  /** The propeller: diameter, m, blades, and its tip's clearance above the keel, m (for the propulsion factors). */
  readonly propeller?: {
    readonly diameter: number;
    readonly blades: number;
    /** Its tip's clearance above the keel, m (default 0.2). */
    readonly clearance?: number;
    /** Its pitch ratio P / D (default 1; twin screws' eta_R). */
    readonly pitch?: number;
  };
  /** One screw (default) or two. */
  readonly screws?: 1 | 2;
}

/** The parts of a hull's resistance at a speed, N, and the factors its propeller works in. */
export interface HoltropResistance {
  total: number;
  friction: number;
  formFactor: number;
  appendages: number;
  wave: number;
  bulb: number;
  transom: number;
  correlation: number;
  /** Froude number V / sqrt(g L). */
  froude: number;
  frictionCoefficient: number;
  correlationCoefficient: number;
  wettedArea: number;
  /** Effective power R V, W. */
  power: number;
  /** Taylor wake fraction w, thrust deduction t and relative rotative efficiency (with a propeller). */
  wake: number;
  thrustDeduction: number;
  relativeRotative: number;
  /** The blade area ratio Keller's criterion asks for (with a propeller), and the thrust it was found at, N. */
  bladeArea: number;
  thrust: number;
}

/** Options of {@link holtropMennen}. */
export interface HoltropOptions {
  readonly density?: number;
  readonly viscosity?: number;
  readonly gravity?: number;
  /** The 1984 form factor and wave resistance (default false: the 1982 set the worked example uses). */
  readonly revised?: boolean;
}

/**
 * A hull's calm-water resistance at `speed` m/s by Holtrop and Mennen (1982; with `revised`, Holtrop 1984), and its
 * propulsion factors when it has a propeller. Valid for hulls like the merchant ships the method was fitted to.
 */
export function holtropMennen(hull: HoltropHull, speed: number, options: HoltropOptions = {}): HoltropResistance {
  const {
    length: L,
    beam: B,
    draughtFore: TF,
    draughtAft: TA,
    volume: V,
    lcb,
    midship: CM,
    waterplane: CWP,
    transom: AT = 0,
    stern = 0,
  } = hull ?? ({} as HoltropHull);
  for (const [name, value] of [
    ['length', L],
    ['beam', B],
    ['draughtFore', TF],
    ['draughtAft', TA],
    ['volume', V],
    ['midship', CM],
    ['waterplane', CWP],
  ] as const)
    if (!(value > 0 && Number.isFinite(value)))
      throw new RangeError(`A hull's ${name} is finite and above 0 (got ${value}); pass it.`);
  if (!Number.isFinite(lcb) || !(AT >= 0) || !Number.isFinite(stern))
    throw new RangeError(`A hull's lcb (percent of L) and stern are finite and its transom area 0 or more; pass them.`);
  if (!(speed >= 0 && Number.isFinite(speed)))
    throw new RangeError(`A speed is finite m/s, 0 or more (got ${speed}); pass one.`);
  const rho = options.density ?? SEA_WATER_DENSITY,
    nu = options.viscosity ?? SEA_WATER_VISCOSITY,
    g = options.gravity ?? gravityMagnitude(DEFAULT_GRAVITY),
    T = (TF + TA) / 2,
    CB = V / (L * B * T),
    CP = CB / CM,
    ABT = hull.bulb?.area ?? 0,
    hB = hull.bulb?.centre ?? 0,
    q = 0.5 * rho * speed * speed,
    Fn = speed / Math.sqrt(g * L),
    // The run's length and the form factor.
    LR = L * (1 - CP + (0.06 * CP * lcb) / (4 * CP - 1)),
    S =
      hull.wettedArea ??
      L * (2 * T + B) * Math.sqrt(CM) * (0.453 + 0.4425 * CB - 0.2862 * CM - 0.003467 * (B / T) + 0.3696 * CWP) +
        (2.38 * ABT) / CB,
    appendageArea = (hull.appendages ?? []).reduce((sum, a) => sum + a.area, 0),
    appendageFactor =
      appendageArea > 0 ? (hull.appendages ?? []).reduce((sum, a) => sum + a.area * a.factor, 0) / appendageArea : 1;
  let k1: number;
  if (options.revised) {
    const c14 = 1 + 0.011 * stern;
    k1 =
      0.93 +
      0.487118 *
        c14 *
        pow(B / L, 1.06806) *
        pow(T / L, 0.46106) *
        pow(L / LR, 0.121563) *
        pow((L * L * L) / V, 0.36486) *
        pow(1 - CP, -0.604247);
  } else {
    const tl = T / L,
      c12 = tl > 0.05 ? pow(tl, 0.2228446) : tl > 0.02 ? 48.2 * pow(tl - 0.02, 2.078) + 0.479948 : 0.479948,
      c13 = 1 + 0.003 * stern;
    k1 = c13 * (0.93 + c12 * pow(B / LR, 0.92497) * pow(0.95 - CP, -0.521448) * pow(1 - CP + 0.0225 * lcb, 0.6906));
  }
  const reynolds = speed > 0 ? (speed * L) / nu : 0,
    CF = speed > 0 ? ittc1957(reynolds) : 0,
    friction = q * S * CF,
    appendages = q * appendageArea * appendageFactor * CF;
  // Wave resistance.
  const c7 = B / L < 0.11 ? 0.229577 * pow(B / L, 1 / 3) : B / L < 0.25 ? B / L : 0.5 - 0.0625 * (L / B),
    iE =
      hull.entrance ??
      1 +
        89 *
          exp(
            -pow(L / B, 0.80856) *
              pow(1 - CWP, 0.30484) *
              pow(1 - CP - 0.0225 * lcb, 0.6367) *
              pow(LR / B, 0.34574) *
              pow((100 * V) / (L * L * L), 0.16302),
          ),
    c1 = 2223105 * pow(c7, 3.78613) * pow(T / B, 1.07961) * pow(90 - iE, -1.37565),
    c3 = ABT > 0 ? (0.56 * pow(ABT, 1.5)) / (B * T * (0.31 * Math.sqrt(ABT) + TF - hB)) : 0,
    c2 = exp(-1.89 * Math.sqrt(c3)),
    c5 = 1 - (0.8 * AT) / (B * T * CM),
    lambda = L / B < 12 ? 1.446 * CP - 0.03 * (L / B) : 1.446 * CP - 0.36,
    c16 = CP < 0.8 ? 8.07981 * CP - 13.8673 * CP * CP + 6.984388 * CP * CP * CP : 1.73014 - 0.7067 * CP,
    m1 = 0.0140407 * (L / T) - (1.75254 * pow(V, 1 / 3)) / L - 4.79323 * (B / L) - c16,
    slenderness = (L * L * L) / V,
    c15 = slenderness < 512 ? -1.69385 : slenderness < 1727 ? -1.69385 + (L / pow(V, 1 / 3) - 8) / 2.36 : 0,
    d = -0.9,
    weight = rho * g * V;
  const waveA = (fn: number, m4: (f: number) => number) =>
    fn > 0 ? c1 * c2 * c5 * weight * exp(m1 * pow(fn, d) + m4(fn) * cos(lambda / (fn * fn))) : 0;
  let wave: number;
  if (!options.revised) wave = waveA(Fn, (f) => c15 * CP * CP * exp(-0.1 / (f * f)));
  else {
    const m4 = (f: number) => c15 * 0.4 * exp(-0.034 * pow(f, -3.29)),
      c17 = 6919.3 * pow(CM, -1.3346) * pow(V / (L * L * L), 2.00977) * pow(L / B - 2, 1.40692),
      m3 = -7.2035 * pow(B / L, 0.326869) * pow(T / B, 0.605375),
      waveB = (f: number) => c17 * c2 * c5 * weight * exp(m3 * pow(f, d) + m4(f) * cos(lambda / (f * f)));
    if (Fn <= 0.4) wave = waveA(Fn, m4);
    else if (Fn >= 0.55) wave = waveB(Fn);
    else wave = waveA(0.4, m4) + ((10 * Fn - 4) * (waveB(0.55) - waveA(0.4, m4))) / 1.5;
  }
  // The bulb near the surface, the immersed transom and the model-ship correlation.
  let bulb = 0;
  if (ABT > 0 && speed > 0) {
    const PB = (0.56 * Math.sqrt(ABT)) / (TF - 1.5 * hB),
      Fni = speed / Math.sqrt(g * (TF - hB - 0.25 * Math.sqrt(ABT)) + 0.15 * speed * speed);
    bulb = (0.11 * exp(-3 / (PB * PB)) * Fni * Fni * Fni * pow(ABT, 1.5) * rho * g) / (1 + Fni * Fni);
  }
  let transom = 0;
  if (AT > 0) {
    const FnT = speed / Math.sqrt((2 * g * AT) / (B + B * CWP));
    transom = FnT < 5 ? q * AT * 0.2 * (1 - 0.2 * FnT) : 0;
  }
  const c4 = Math.min(TF / L, 0.04),
    CA = 0.006 * pow(L + 100, -0.16) - 0.00205 + 0.003 * Math.sqrt(L / 7.5) * CB * CB * CB * CB * c2 * (0.04 - c4),
    correlation = q * (S + appendageArea) * CA,
    total = friction * k1 + appendages + wave + bulb + transom + correlation;
  // The propulsion factors.
  let wake = 0,
    thrustDeduction = 0,
    relativeRotative = 0,
    bladeArea = 0,
    thrust = 0;
  const prop = hull.propeller;
  if (prop) {
    const D = prop.diameter,
      Z = prop.blades;
    if (!(D > 0 && Number.isFinite(D) && Number.isInteger(Z) && Z >= 2 && Z <= 9))
      throw new RangeError(`A propeller has a diameter above 0 and 2 to 9 blades (got ${D} m, ${Z}); pass them.`);
    const CV = k1 * CF + CA,
      CP1 = 1.45 * CP - 0.315 - 0.0225 * lcb;
    if (hull.screws === 2) {
      const ratio = D / Math.sqrt(B * T);
      wake = 0.3095 * CB + 10 * CV * CB - 0.23 * ratio;
      thrustDeduction = 0.325 * CB - 0.1885 * ratio;
    } else {
      const wet = S + appendageArea,
        c8 = B / TA < 5 ? (B * wet) / (L * D * TA) : (wet * ((7 * B) / TA - 25)) / (L * D * (B / TA - 3)),
        c9 = c8 < 28 ? c8 : 32 - 16 / (c8 - 24),
        c11 = TA / D < 2 ? TA / D : 0.0833333 * pow(TA / D, 3) + 1.33333,
        c10 = L / B > 5.2 ? B / L : 0.25 - 0.003328402 / (B / L - 0.134615385);
      wake =
        c9 * CV * (L / TA) * (0.0661875 + (1.21756 * c11 * CV) / (1 - CP1)) +
        0.24558 * Math.sqrt(B / (L * (1 - CP1))) -
        0.09726 / (0.95 - CP) +
        0.11434 / (0.95 - CB) +
        0.75 * stern * CV +
        0.002 * stern;
      thrustDeduction =
        (0.001979 * L) / (B - B * CP1) + 1.0585 * c10 - 0.00524 - (0.1418 * D * D) / (B * T) + 0.0015 * stern;
    }
    thrust = total / (1 - thrustDeduction);
    // Keller's criterion with the shaft's immersion: p0 - p_v = 99,047 Pa for sea water at 15 degrees C.
    const shaft = TA - (prop.clearance ?? 0.2) - D / 2,
      K = hull.screws === 2 ? 0.1 : 0.2;
    bladeArea = K + ((1.3 + 0.3 * Z) * thrust) / (D * D * (99047 + rho * g * shaft));
    relativeRotative =
      hull.screws === 2
        ? 0.9737 + 0.111 * (CP - 0.0225 * lcb) - 0.06325 * (prop.pitch ?? 1)
        : 0.9922 - 0.05908 * bladeArea + 0.07424 * (CP - 0.0225 * lcb);
  }
  return {
    total,
    friction,
    formFactor: k1,
    appendages,
    wave,
    bulb,
    transom,
    correlation,
    froude: Fn,
    frictionCoefficient: CF,
    correlationCoefficient: CA,
    wettedArea: S,
    power: total * speed,
    wake,
    thrustDeduction,
    relativeRotative,
    bladeArea,
    thrust,
  };
}
