// The Wageningen B-screw series (SEA-09): open-water thrust and torque of a B-series propeller from its blades Z, expanded
// area ratio A_E / A_0 and pitch ratio P / D, by the polynomials of M. W. C. Oosterveld and P. van Oossanen, "Further
// computer-analyzed data of the Wageningen B-screw series", International Shipbuilding Progress 22(251), 1975 (Table 5,
// 39 terms for K_T and 47 for K_Q at R_n 2e6, and Table 6, the correction above it; pages 5 to 9 read from a scan, whose
// plus signs were checked against the paper's own Figures 4 to 6). Valid for Z 2 to 7, A_E / A_0 0.30 to 1.05 and P / D 0.5
// to 1.4. `bSeriesCurves` fits MMG's quadratic K_T(J) and K_Q(J), as the standard method takes them (Yasukawa and Yoshimura
// 2015), to the polynomials between bollard pull and zero thrust, by least squares.
import { ln, pow } from '@margoengine/math/pinned';
import { shipError } from './errors.js';
import type { PropellerCurves } from './propeller.js';

const KT_TERMS: readonly (readonly [number, number, number, number, number])[] = [
  [0.00880496, 0, 0, 0, 0],
  [-0.204554, 1, 0, 0, 0],
  [0.166351, 0, 1, 0, 0],
  [0.158114, 0, 2, 0, 0],
  [-0.147581, 2, 0, 1, 0],
  [-0.481497, 1, 1, 1, 0],
  [0.415437, 0, 2, 1, 0],
  [0.0144043, 0, 0, 0, 1],
  [-0.0530054, 2, 0, 0, 1],
  [0.0143481, 0, 1, 0, 1],
  [0.0606826, 1, 1, 0, 1],
  [-0.0125894, 0, 0, 1, 1],
  [0.0109689, 1, 0, 1, 1],
  [-0.133698, 0, 3, 0, 0],
  [0.00638407, 0, 6, 0, 0],
  [-0.00132718, 2, 6, 0, 0],
  [0.168496, 3, 0, 1, 0],
  [-0.0507214, 0, 0, 2, 0],
  [0.0854559, 2, 0, 2, 0],
  [-0.0504475, 3, 0, 2, 0],
  [0.010465, 1, 6, 2, 0],
  [-0.00648272, 2, 6, 2, 0],
  [-0.00841728, 0, 3, 0, 1],
  [0.0168424, 1, 3, 0, 1],
  [-0.00102296, 3, 3, 0, 1],
  [-0.0317791, 0, 3, 1, 1],
  [0.018604, 1, 0, 2, 1],
  [-0.00410798, 0, 2, 2, 1],
  [-0.000606848, 0, 0, 0, 2],
  [-0.0049819, 1, 0, 0, 2],
  [0.0025983, 2, 0, 0, 2],
  [-0.000560528, 3, 0, 0, 2],
  [-0.00163652, 1, 2, 0, 2],
  [-0.000328787, 1, 6, 0, 2],
  [0.000116502, 2, 6, 0, 2],
  [0.000690904, 0, 0, 1, 2],
  [0.00421749, 0, 3, 1, 2],
  [5.65229e-5, 3, 6, 1, 2],
  [-0.00146564, 0, 3, 2, 2],
];
const KQ_TERMS: readonly (readonly [number, number, number, number, number])[] = [
  [0.00379368, 0, 0, 0, 0],
  [0.00886523, 2, 0, 0, 0],
  [-0.032241, 1, 1, 0, 0],
  [0.00344778, 0, 2, 0, 0],
  [-0.0408811, 0, 1, 1, 0],
  [-0.108009, 1, 1, 1, 0],
  [-0.0885381, 2, 1, 1, 0],
  [0.188561, 0, 2, 1, 0],
  [-0.00370871, 1, 0, 0, 1],
  [0.00513696, 0, 1, 0, 1],
  [0.0209449, 1, 1, 0, 1],
  [0.00474319, 2, 1, 0, 1],
  [-0.00723408, 2, 0, 1, 1],
  [0.00438388, 1, 1, 1, 1],
  [-0.0269403, 0, 2, 1, 1],
  [0.0558082, 3, 0, 1, 0],
  [0.0161886, 0, 3, 1, 0],
  [0.00318086, 1, 3, 1, 0],
  [0.015896, 0, 0, 2, 0],
  [0.0471729, 1, 0, 2, 0],
  [0.0196283, 3, 0, 2, 0],
  [-0.0502782, 0, 1, 2, 0],
  [-0.030055, 3, 1, 2, 0],
  [0.0417122, 2, 2, 2, 0],
  [-0.0397722, 0, 3, 2, 0],
  [-0.00350024, 0, 6, 2, 0],
  [-0.0106854, 3, 0, 0, 1],
  [0.00110903, 3, 3, 0, 1],
  [-0.000313912, 0, 6, 0, 1],
  [0.0035985, 3, 0, 1, 1],
  [-0.00142121, 0, 6, 1, 1],
  [-0.00383637, 1, 0, 2, 1],
  [0.0126803, 0, 2, 2, 1],
  [-0.00318278, 2, 3, 2, 1],
  [0.00334268, 0, 6, 2, 1],
  [-0.00183491, 1, 1, 0, 2],
  [0.000112451, 3, 2, 0, 2],
  [-2.97228e-5, 3, 6, 0, 2],
  [0.000269551, 1, 0, 1, 2],
  [0.00083265, 2, 0, 1, 2],
  [0.00155334, 0, 2, 1, 2],
  [0.000302683, 0, 6, 1, 2],
  [-0.0001843, 0, 0, 2, 2],
  [-0.000425399, 0, 3, 2, 2],
  [8.69243e-5, 3, 3, 2, 2],
  [-0.0004659, 0, 6, 2, 2],
  [5.54194e-5, 1, 6, 2, 2],
];

/** A B-series propeller: blades, expanded area ratio and pitch ratio, and the Reynolds number at 0.75 R (default 2e6). */
export interface BSeriesPropeller {
  readonly blades: number;
  readonly area: number;
  readonly pitch: number;
  readonly reynolds?: number;
}

/** Σ C J^s (P/D)^t (A_E/A_0)^u Z^v over `terms`. */
function poly(
  terms: readonly (readonly [number, number, number, number, number])[],
  J: number,
  p: number,
  a: number,
  z: number,
): number {
  let sum = 0;
  for (const [c, s, t, u, v] of terms) sum += c * pow(J, s) * pow(p, t) * pow(a, u) * pow(z, v);
  return sum;
}

/** Checks a B-series propeller's particulars against the series' range. */
function check(prop: BSeriesPropeller): void {
  const { blades: Z, area: A, pitch: P, reynolds = 2e6 } = prop;
  if (
    !(
      Number.isInteger(Z) &&
      Z >= 2 &&
      Z <= 7 &&
      A >= 0.3 &&
      A <= 1.05 &&
      P >= 0.5 &&
      P <= 1.4 &&
      reynolds >= 2e6 &&
      Number.isFinite(reynolds)
    )
  )
    throw shipError(
      `A Wageningen B-series propeller has 2 to 7 blades, an area ratio of 0.30 to 1.05, a pitch ratio of 0.5 to 1.4 and a Reynolds number of 2e6 or more (got ${Z}, ${A}, ${P}, ${reynolds}); pass ones in the series' range.`,
    );
}

/**
 * K_T and K_Q of a B-series propeller at advance ratio J (Oosterveld and van Oossanen 1975, Tables 5 and 6), with the
 * Reynolds number's correction above 2e6.
 */
export function wageningenB(prop: BSeriesPropeller, J: number): { kt: number; kq: number } {
  check(prop);
  if (!(J >= 0 && Number.isFinite(J)))
    throw shipError(`An advance ratio is finite and 0 or more (got ${J}); pass one.`);
  const { blades: Z, area: A, pitch: P, reynolds = 2e6 } = prop;
  let kt = poly(KT_TERMS, J, P, A, Z),
    kq = poly(KQ_TERMS, J, P, A, Z);
  if (reynolds > 2e6) {
    // log10 R_n by the pinned natural logarithm, so every machine gets the same bits.
    const L = ln(reynolds) * 0.4342944819032518 - 0.301,
      L2 = L * L,
      J2 = J * J,
      P2 = P * P,
      P3 = P2 * P,
      P6 = P3 * P3;
    kt +=
      0.000353485 -
      0.00333758 * A * J2 -
      0.00478125 * A * P * J +
      0.000257792 * L2 * A * J2 +
      0.0000643192 * L * P6 * J2 -
      0.0000110636 * L2 * P6 * J2 -
      0.0000276305 * L2 * Z * A * J2 +
      0.0000954 * L * Z * A * P * J +
      0.0000032049 * L * Z * Z * A * P3 * J;
    kq +=
      -0.000591412 +
      0.00696898 * P -
      0.0000666654 * Z * P6 +
      0.0160818 * A * A -
      0.000938091 * L * P -
      0.00059593 * L * P2 +
      0.0000782099 * L2 * P2 +
      0.0000052199 * L * Z * A * J2 -
      0.00000088528 * L2 * Z * A * P * J +
      0.0000230171 * L * Z * P6 -
      0.00000184341 * L2 * Z * P6 -
      0.00400252 * L * A * A +
      0.000220915 * L2 * A * A;
  }
  return { kt, kq };
}

/**
 * MMG's quadratic open-water curves for a B-series propeller: K_T and K_Q fitted by least squares at 64 advance ratios from
 * bollard pull to the polynomial's zero thrust, with the fit's largest error, for `new Propeller(diameter, curves)` and a
 * ship's model.
 */
export function bSeriesCurves(
  prop: BSeriesPropeller,
): PropellerCurves & { readonly error: number; readonly zeroThrust: number } {
  check(prop);
  // The advance of zero thrust, by bisection between 0 and 2.
  let lo = 0,
    hi = 2;
  if (!(wageningenB(prop, 0).kt > 0 && wageningenB(prop, hi).kt < 0))
    throw shipError(
      'This B-series propeller has no zero-thrust advance below J 2; pass a propeller in the series range.',
    );
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (wageningenB(prop, mid).kt > 0) lo = mid;
    else hi = mid;
  }
  const zero = (lo + hi) / 2,
    n = 64,
    fit = (pick: (j: number) => number): [number, number, number] => {
      // Normal equations of a quadratic in J.
      const s = new Float64Array(5),
        b = new Float64Array(3);
      for (let i = 0; i <= n; i++) {
        const j = (zero * i) / n,
          y = pick(j);
        let jp = 1;
        for (let k = 0; k < 5; k++) {
          s[k]! += jp;
          if (k < 3) b[k]! += y * jp;
          jp *= j;
        }
      }
      const m = [
        [s[0]!, s[1]!, s[2]!, b[0]!],
        [s[1]!, s[2]!, s[3]!, b[1]!],
        [s[2]!, s[3]!, s[4]!, b[2]!],
      ];
      for (let c = 0; c < 3; c++) {
        for (let r = c + 1; r < 3; r++) {
          const f = m[r]![c]! / m[c]![c]!;
          for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
        }
      }
      const x = [0, 0, 0];
      for (let r = 2; r >= 0; r--) {
        let v = m[r]![3]!;
        for (let k = r + 1; k < 3; k++) v -= m[r]![k]! * x[k]!;
        x[r] = v / m[r]![r]!;
      }
      return [x[0]!, x[1]!, x[2]!];
    },
    thrust = fit((j) => wageningenB(prop, j).kt),
    torque = fit((j) => wageningenB(prop, j).kq);
  let error = 0;
  for (let i = 0; i <= n; i++) {
    const j = (zero * i) / n,
      { kt, kq } = wageningenB(prop, j);
    error = Math.max(
      error,
      Math.abs(thrust[0] + j * (thrust[1] + j * thrust[2]) - kt),
      10 * Math.abs(torque[0] + j * (torque[1] + j * torque[2]) - kq),
    );
  }
  return { thrust, torque, pitch: prop.pitch, error, zeroThrust: zero };
}
