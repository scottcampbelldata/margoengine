// Bank effects on a ship (SEA-09): the sway force and yaw moment a vertical bank or quay alongside puts on a ship on a
// parallel course, by M. Vantorre, G. Delefortrie, K. Eloot and E. Laforce, "Experimental investigation of ship-bank
// interaction forces", MARSIM 2003, Kanazawa, https://www.vliz.be/imisdocs/publications/ocrd/141422.pdf (all pages read):
// a regression of captive model tests on two bulk carriers and a container carrier at Flanders Hydraulics Research, in
// three parts, the hull's (eqs. 9 to 11), the propeller's at bollard pull (eqs. 12 to 15) and the propeller's with way on
// (eqs. 16 to 18), each a double sum over y_B^i (i = 1, 2) and (T / (h_eff - T))^k (k = 0, 1, 2), its coefficients each
// a + b (a ratio of the hull's particulars). y_B = (B / 2) (1 / y_starboard - 1 / y_port), from the ship's centreline to
// each bank, signed so its square term reads y_B |y_B| as the paper's note on page 9 asks: the bank's side sets the sign.
// h_eff is the depth less the mean sinkage. Evaluated for the paper's container carrier the hull's force attracts the
// ship to the bank above h/T about 1.25 and repels it below, and its moment turns the bow away, as the paper says; the
// propeller ahead draws the stern in.
import { shipError } from './errors.js';

/** A row of a coefficient table: a + b × the named ratio of the hull's particulars. */
type Row = readonly [number, number, 'invCB' | 'CBLT' | 'LT' | 'BT' | 'TL' | 'BL' | 'TB' | 'LB' | 'CBTL' | 'CBTB'];

/** The hull's part, alpha(H)_ik then beta(H)_ik for i = 1, 2 and k = 0, 1, 2 (eq. 11). */
const HULL: readonly Row[] = [
  [-4.61e-1, 3.68e-1, 'invCB'],
  [-1.73e-1, 1.14e-2, 'CBLT'],
  [6.34e-3, -4.6e-4, 'CBLT'],
  [1.36, -6.58e-2, 'LT'],
  [2.57e-1, -8.96e-2, 'BT'],
  [-1.91e-2, 6.34e-3, 'BT'],
  [-1.19e-1, 2.11, 'TL'],
  [-3.54e-2, 1.95e-1, 'BL'],
  [2.29e-4, -6.92e-5, 'BT'],
  [1.34e-1, -2.35, 'TL'],
  [-4.23e-2, 2.93e-3, 'CBLT'],
  [1.23e-3, -8.53e-5, 'CBLT'],
];
/** The propeller at bollard pull, alpha(P)_ik then beta(P)_ik (eq. 15). */
const BOLLARD: readonly Row[] = [
  [5.24e-2, -1.51e-1, 'TB'],
  [8.7e-3, -3.86e-2, 'BL'],
  [-1.05e-4, -9.23e-7, 'LB'],
  [5.92e-2, -2.11e-2, 'BT'],
  [-2.82e-4, -2.42e-4, 'LB'],
  [2.32e-4, -1.98e-5, 'LB'],
  [-4.95e-3, 1.25e-1, 'CBTL'],
  [1.29e-3, -5.37e-3, 'TB'],
  [-2.68e-4, 8.78e-4, 'TB'],
  [3.81e-3, -1.29e-2, 'CBTB'],
  [3.44e-3, -1.1e-3, 'BT'],
  [4.88e-4, -1.52e-3, 'TB'],
];
/** The propeller with way on, alpha(HP)_ik then beta(HP)_ik (eq. 18). */
const AHEAD: readonly Row[] = [
  [-2.37e-1, 4.22e-1, 'TB'],
  [2.89e-2, -2.2e-3, 'LB'],
  [-6.57e-3, 1.18e-3, 'LB'],
  [4.19e-1, -4.79e-2, 'LB'],
  [-4.49e-2, 9.98e-3, 'LB'],
  [1.06e-2, -4.24e-2, 'TB'],
  [-2.89e-1, 5.71, 'TL'],
  [-1.22e-1, 3.53e-1, 'TB'],
  [7.87e-3, -2.33e-2, 'TB'],
  [-9.33e-2, 1.57e-2, 'LB'],
  [2.6e-1, -7.95e-1, 'TB'],
  [-1.99e-2, 5.98e-2, 'TB'],
];

/** A hull as the bank model reads it: length, beam and draught, m, block coefficient and propeller diameter, m. */
export interface BankHull {
  readonly length: number;
  readonly beam: number;
  readonly draught: number;
  readonly block: number;
  readonly diameter: number;
}

/** A bank's force and moment on a ship, N and N m (positive to starboard, bow to starboard), and whether its hull is in the regression's range. */
export interface BankLoads {
  Y: number;
  N: number;
  inRange: boolean;
}

/** The regression's range (page 9): 0.56 < C_B < 0.84, 6.0 < L/B < 7.3, 2.6 < B/T < 3.0, 17.8 < L/T < 21.5, h/T > 1.07. */
export function bankInRange(hull: BankHull, depth: number): boolean {
  const { length: L, beam: B, draught: T, block: CB } = hull;
  return (
    CB > 0.56 &&
    CB < 0.84 &&
    L / B > 6 &&
    L / B < 7.3 &&
    B / T > 2.6 &&
    B / T < 3 &&
    L / T > 17.8 &&
    L / T < 21.5 &&
    depth / T > 1.07
  );
}

/** Σ c_ik y_B^i x^k over i = 1, 2 (y_B then y_B |y_B|) and k = 0, 1, 2, with the coefficients from `rows` at `offset`. */
function sum(rows: readonly Row[], offset: number, ratios: Record<Row[2], number>, yB: number, x: number): number {
  let total = 0;
  for (let i = 0; i < 2; i++) {
    const y = i === 0 ? yB : yB * Math.abs(yB);
    for (let k = 0; k < 3; k++) {
      const [a, b, ratio] = rows[offset + 3 * i + k]!;
      total += (a + b * ratios[ratio]) * y * (k === 0 ? 1 : k === 1 ? x : x * x);
    }
  }
  return total;
}

/**
 * The bank's sway force and yaw moment on a ship (Vantorre et al. 2003): `yB` the signed distance parameter (B / 2)
 * (1 / y_s - 1 / y_p), `depth` the effective depth under it (the depth less its sinkage, Infinity for deep water), `u` its
 * surge speed and `thrust` its propeller's, N (ahead only; astern the regression does not reach). Y and N in MMG's sense:
 * positive to starboard and turning the bow to starboard.
 */
export function bankLoads(
  hull: BankHull,
  yB: number,
  depth: number,
  u: number,
  thrust: number,
  density = 1025,
  gravity = 9.81,
): BankLoads {
  const { length: L, beam: B, draught: T, block: CB, diameter: D } = hull;
  if (
    ![L, B, T, CB, D, density].every((v) => v > 0 && Number.isFinite(v)) ||
    !(gravity >= 0 && Number.isFinite(gravity)) ||
    !Number.isFinite(yB)
  )
    throw shipError(
      `A bank's effect needs a hull's length, beam, draught, block coefficient and propeller diameter and a density, finite and above 0, gravity of 0 or more and a finite y_B (got ${[L, B, T, CB, D, density, gravity, yB].join(', ')}); pass them.`,
    );
  if (!(depth > T))
    throw shipError(
      `The water under a ship beside a bank is deeper than its draught (got ${depth} m for ${T} m); pass the depth.`,
    );
  const ratios: Record<Row[2], number> = {
      invCB: 1 / CB,
      CBLT: (CB * L) / T,
      LT: L / T,
      BT: B / T,
      TL: T / L,
      BL: B / L,
      TB: T / B,
      LB: L / B,
      CBTL: (CB * T) / L,
      CBTB: (CB * T) / B,
    },
    x = Number.isFinite(depth) ? T / (depth - T) : 0,
    // Going astern the regression does not reach: the hull's part is left out.
    speed = u > 0 ? u : 0,
    // The propeller's jet speed V_T = sqrt(T_P / (1/8 rho pi D^2)) (eq. 12), ahead only.
    jet2 = thrust > 0 ? thrust / ((density * Math.PI * D * D) / 8) : 0,
    // With no gravity there is no Froude number: the propeller's part with way on is then left out.
    froude = gravity > 0 ? speed / Math.sqrt(gravity * L) : 0,
    hullY = 0.5 * density * L * T * speed * speed * sum(HULL, 0, ratios, yB, x),
    hullN = 0.5 * density * L * L * T * speed * speed * sum(HULL, 6, ratios, yB, x),
    propY = 0.5 * density * L * T * jet2 * (sum(BOLLARD, 0, ratios, yB, x) + froude * sum(AHEAD, 0, ratios, yB, x)),
    propN = 0.5 * density * L * L * T * jet2 * (sum(BOLLARD, 6, ratios, yB, x) + froude * sum(AHEAD, 6, ratios, yB, x));
  return { Y: hullY + propY, N: hullN + propN, inRange: bankInRange(hull, depth) };
}
