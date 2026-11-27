// Bank effects on a ship (SEA-09): the sway force and yaw moment a vertical bank or quay alongside puts on a ship on a
// parallel course.
// - The hull's part follows E. Lataire's model ("Experiment based mathematical modelling of ship-bank interaction", PhD
//   thesis, Ghent University, 2014, section 9.2, eqs. 9.1 to 9.16, read): a lateral force at the forward perpendicular
//   Y_F that attracts in deep water and turns to repulsion as the keel nears the bottom and the ship speeds up, and one at
//   the aft perpendicular Y_A that always attracts, each the displacement force times the inverse distance to the bank
//   times the Tuck number Tum = (Fr_h / Fr_c)^2 / sqrt(1 - (Fr_h / Fr_c)^2), with Fr_c the critical speed of the water
//   within the influence width y_infl = B (5 Fr_h + 5) (eqs. 9.3, 9.4 and 9.10); Y = Y_F + Y_A and N = (L / 2)(Y_F - Y_A).
//   J. T. Duffy's thesis (Univ. of Tasmania, 2008, read) finds the same: the force reverses above a depth Froude number that
//   falls as T / (h - T) rises.
// - Lataire gives no coefficients (one set per ship). Here one set serves any hull: fitted to M. Vantorre, G. Delefortrie,
//   K. Eloot and E. Laforce's captive tests at Flanders Hydraulics Research ("Experimental investigation of ship-bank
//   interaction forces", MARSIM 2003, https://www.vliz.be/imisdocs/publications/ocrd/141422.pdf, Figs. 4 and 5 read off
//   the page: container carrier D at h/T 1.07 to 1.5 and Fn 0.032 to 0.081, bulk carrier C2 at h/T 1.1 to 1.5), the
//   Froude-dependent repulsion scaling with C_B and the depth-only part with 1 - C_B, as the two hulls' own fits showed
//   (docs/clean-room.md). Each depth was held out in turn and predicted from the others.
// - The propeller's part is Vantorre et al.'s regression, at bollard pull (eqs. 12 to 15) and with way on (eqs. 16 to 18),
//   each a double sum over y_B^i (i = 1, 2) and (T / (h_eff - T))^k (k = 0, 1, 2), its coefficients each a + b (a ratio of
//   the hull's particulars), h_eff the depth less the mean sinkage. y_B = (B / 2) (1 / y_starboard - 1 / y_port), signed
//   so its square term reads y_B |y_B| as the paper's note on page 9 asks.
import { pow, sin } from '@margoengine/math/pinned';
import { shipError } from './errors.js';
import { atan2 } from './propeller.js';
import { SEA_WATER_VISCOSITY } from './resistance.js';

/** A row of a coefficient table: a + b × the named ratio of the hull's particulars. */
type Row = readonly [number, number, 'invCB' | 'CBLT' | 'LT' | 'BT' | 'TL' | 'BL' | 'TB' | 'LB' | 'CBTL' | 'CBTB'];

/**
 * The hull's part (Lataire's form), fitted to Vantorre et al.'s Figs. 4 and 5: Y_A's attraction, Y_F's Froude-dependent
 * and depth-only repulsion, the repulsion's onset in T / (h - T), and how both grow toward the bank, (1 + k |y_B|).
 */
const HULL_ATTRACTION_A = 1.629e-3;
const HULL_REPULSION_FROUDE = 8.468e-4;
const HULL_REPULSION_DEPTH = 1.6133e-3;
const REPULSION_ONSET = 0.5;
const SHAPE = 0.25;
/**
 * Y_F's attraction over Y_A's, 0.8975: Norrbin's vertical-bank formula (as Vantorre et al. reprint it, eq. 1) gives the
 * deep-water moment N / (L Y) = -0.0025 / 0.0926, which (Y_F - Y_A) / 2 (Y_F + Y_A) meets at this ratio; Lataire finds Y_A
 * the larger in deeper water.
 */
const FORE_OVER_AFT = 0.8975;
/**
 * The boundary layer's influence thickness delta_BLI = 0.1 (L / Re^(1/5)) (T / h) (V_T + 2 V) / V (Lataire's eq. 9.11, its
 * constant fitted): Y_A falls in proportion to the under-keel gap inside it (eq. 9.14), at model scale far more than at full.
 */
const BOUNDARY_LAYER = 0.1;
/** The highest Fr_h / Fr_c the fit saw (Vantorre's container carrier at Fn 0.081, h/T 1.07). */
export const BANK_TUCK_LIMIT = 0.62;

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
 * The bank's sway force and yaw moment on a ship: the hull's by Lataire's model fitted to Vantorre et al.'s tests, the
 * propeller's by Vantorre et al.'s regression. `yB` is the signed distance parameter (B / 2) (1 / y_s - 1 / y_p), `depth`
 * the water's depth under it (Infinity for deep water), `u` its surge speed and `thrust` its propeller's, N (ahead only;
 * astern neither reaches). `sinkage` (m, default 0) makes the propeller's effective depth h - z_m and narrows the hull's
 * under-keel gap; `sides` (m, default from `yB`, the far side open) are the distances from the centreline to the starboard
 * and port walls, for the water within the influence width; `viscosity` (m^2/s, default sea water's) sets the boundary
 * layer. Y and N in MMG's sense: positive to starboard and turning the bow to starboard.
 * @throws MargoError for a hull, density, gravity, y_B, depth or sides it cannot use.
 */
export function bankLoads(
  hull: BankHull,
  yB: number,
  depth: number,
  u: number,
  thrust: number,
  density = 1025,
  gravity = 9.81,
  sinkage = 0,
  sides?: readonly [number, number],
  viscosity = SEA_WATER_VISCOSITY,
): BankLoads {
  const { length: L, beam: B, draught: T, block: CB, diameter: D } = hull;
  if (
    ![L, B, T, CB, D, density].every((v) => v > 0 && Number.isFinite(v)) ||
    !(gravity >= 0 && Number.isFinite(gravity)) ||
    !Number.isFinite(yB) ||
    !(sinkage >= 0 && Number.isFinite(sinkage)) ||
    !(viscosity > 0 && Number.isFinite(viscosity)) ||
    (sides !== undefined && !sides.every((v) => v > 0))
  )
    throw shipError(
      `A bank's effect needs a hull's length, beam, draught, block coefficient and propeller diameter and a density, finite and above 0, gravity of 0 or more, a finite y_B, a sinkage of 0 or more and walls above 0 m from the centreline (got ${[L, B, T, CB, D, density, gravity, yB, sinkage].join(', ')}); pass them.`,
    );
  if (!(depth - sinkage > T))
    throw shipError(
      `The water under a ship beside a bank is deeper than its draught and sinkage (got ${depth} m for ${T} m and ${sinkage} m); pass the depth.`,
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
    x = Number.isFinite(depth) ? T / (depth - sinkage - T) : 0,
    // Going astern neither part reaches: the hull's part is left out.
    speed = u > 0 ? u : 0,
    // The propeller's jet speed V_T = sqrt(T_P / (1/8 rho pi D^2)) (eq. 12), ahead only.
    jet2 = thrust > 0 ? thrust / ((density * Math.PI * D * D) / 8) : 0,
    // With no gravity there is no Froude number: the hull's part and the propeller's part with way on are then left out.
    froude = gravity > 0 ? speed / Math.sqrt(gravity * L) : 0,
    hull_ = hullBank(L, B, T, CB, yB, depth, speed, gravity, density, sides, sinkage, Math.sqrt(jet2), viscosity),
    propY = 0.5 * density * L * T * jet2 * (sum(BOLLARD, 0, ratios, yB, x) + froude * sum(AHEAD, 0, ratios, yB, x)),
    propN = 0.5 * density * L * L * T * jet2 * (sum(BOLLARD, 6, ratios, yB, x) + froude * sum(AHEAD, 6, ratios, yB, x));
  return {
    Y: hull_.Y + propY,
    N: hull_.N + propN,
    inRange: bankInRange(hull, depth - sinkage) && hull_.tuck <= BANK_TUCK_LIMIT && depth / T <= 1.5,
  };
}

/**
 * The hull's part (Lataire's form): Y_F = K e s Tum (0.8975 a_A - (r_F C_B Fr_h^2 + r_0 (1 - C_B)) max(0, T / (h - T) - 0.5))
 * and Y_A = K e s Tum a_A min(1, gap / delta_BLI), s = 1 + 0.25 |y_B|: K = rho g V the displacement force, e = 2 y_B / B the
 * signed inverse distance to the bank (1 / y_s for one wall), Tum that of the water within the influence width;
 * Y = Y_F + Y_A and N = (L / 2)(Y_F - Y_A).
 */
function hullBank(
  L: number,
  B: number,
  T: number,
  CB: number,
  yB: number,
  depth: number,
  speed: number,
  gravity: number,
  density: number,
  sides: readonly [number, number] | undefined,
  sinkage: number,
  jet: number,
  viscosity: number,
): { Y: number; N: number; tuck: number } {
  if (!(gravity > 0) || !Number.isFinite(depth) || speed === 0 || yB === 0) return { Y: 0, N: 0, tuck: 0 };
  const froudeDepth = speed / Math.sqrt(gravity * depth),
    reach = B * (5 * froudeDepth + 5),
    near = B / (2 * Math.abs(yB)),
    [starboard, port] = sides ?? (yB > 0 ? [near, Number.POSITIVE_INFINITY] : [Number.POSITIVE_INFINITY, near]),
    // The midship section 0.98 B T (ICORELS's) over the water within the influence width each side.
    blockage = (0.98 * B * T) / (depth * (Math.min(starboard, reach) + Math.min(port, reach))),
    open = Math.min(1, Math.max(0, 1 - blockage)),
    // Fr_c = (2 sin(arcsin(1 - m) / 3))^(3/2) (eq. 9.4), arcsin by atan2.
    critical = pow(2 * sin(atan2(open, Math.sqrt(1 - open * open)) / 3), 1.5),
    // Past the critical speed the Tuck number has no meaning: held just under it.
    tuck = Math.min(froudeDepth / critical, 0.99),
    number = (tuck * tuck) / Math.sqrt(1 - tuck * tuck),
    shape = 1 + SHAPE * Math.abs(yB),
    scale = density * gravity * CB * L * B * T * ((2 * yB) / B) * number * shape,
    onset = Math.max(0, T / (depth - T) - REPULSION_ONSET),
    YF =
      scale *
      (FORE_OVER_AFT * HULL_ATTRACTION_A -
        (HULL_REPULSION_FROUDE * CB * froudeDepth * froudeDepth + HULL_REPULSION_DEPTH * (1 - CB)) * onset),
    // The boundary layer: Y_A in proportion to the running under-keel gap inside delta_BLI (eqs. 9.11 and 9.14).
    layer = ((BOUNDARY_LAYER * L) / pow((speed * L) / viscosity, 0.2)) * (T / depth) * ((jet + 2 * speed) / speed),
    YA = scale * HULL_ATTRACTION_A * Math.min(1, (depth - T - sinkage) / layer);
  return { Y: YF + YA, N: (L / 2) * (YF - YA), tuck };
}
