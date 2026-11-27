// A ship's manoeuvring in shallow water (SEA-09). Two ways, one call:
// - A hull with a measured table (`ManoeuvringModel.shallow`, such as KVLCC2's `KVLCC2_SHALLOW`): its linear hull derivatives,
//   surge derivatives, resistance and hull-propeller-rudder interaction constants from captive tests at several depths,
//   interpolated in (T/h)^2, the variable of Furukawa et al.'s (2016) regressions.
// - Any other hull: Ankudinov, Miller, Jakobsen and Daggett's (MARSIM & ICSM 1990) factors on the deep-water hull derivatives
//   and added masses, as M. Vantorre reprints them in "Manoeuvring coefficients for a container carrier in shallow water: an
//   evaluation of semi-empirical formulae" (23rd ITTC Manoeuvring Committee,
//   https://www.vliz.be/imisdocs/publications/ocrd/220165.pdf, eqs. 4 to 8, read): every linear and nonlinear derivative and
//   the sway and yaw added masses scaled by one family of functions of h/T and B1/T. The interaction constants stay as in
//   deep water.
// The surge added mass, which Ankudinov does not give, is Li and Wu's (MARSIM & ICSM 1990; the same review, eq. 26) either
// way, and a table's hull keeps Ankudinov's factors for the terms it does not list. Ankudinov's nonlinear terms are
// |v|v-type; on a model of MMG's cubic form (Yasukawa and Yoshimura 2015) each cubic term takes the factor of its quadratic
// counterpart, an approximation this file states. Kijima et al.'s (1990) factors from the same review were tried and left
// out: on Yasukawa and Yoshimura's KVLCC2 they raise N'v twice as much as N'r, and the ship turns tighter in shallow water,
// against every free-running test. Ankudinov's own factors on KVLCC2 raise Y'v and N'r faster than captive tests measure
// and N'v slower, so the ship is too course-stable at h/T 1.5 to 1.2 (KB-SHIP-SHALLOW1): a hull with a table uses it.
import { pow } from '@margoengine/math/pinned';
import { shipError } from './errors.js';
import type { ManoeuvringModel } from './mmg.js';

/** The shallowest depth over draught the corrections are taken to: h / T 1.2 (Clarke's family, which Ankudinov's extends, is meaningless below it, Vantorre p. 72). */
export const SHALLOW_LIMIT = 1.2;

/** Ankudinov et al.'s (1990) factors on the deep-water derivatives at depth over draught `ratio` (above 1), eqs. 4 to 8. */
export function ankudinovShallow(
  ratio: number,
  hull: { readonly length: number; readonly beam: number; readonly draught: number; readonly block: number },
): { gv: number; gnr: number; fyv: number; fyr: number; fnv: number; fnr: number; vv: number } {
  const { length: L, beam: B, draught: T, block: CB } = hull,
    g = ratio - 1,
    g2 = g * g,
    g3 = g2 * g,
    g5 = g3 * g2,
    K0 = 1 + 0.0775 / g2 - 0.011 / g3 + 0.000068 / g5,
    K1 = -0.0643 / g + 0.0724 / g2 - 0.0113 / g3 + 0.0000767 / g5,
    K2 = B / T > 4 ? (0.137 * (T / B)) / g : 0.0342 / g,
    // B1 = C_B B (1 + B / L)^2 in place of B.
    b = (CB * B * (1 + B / L) * (1 + B / L)) / T,
    fnv = K0 + K1 * b + K2 * b * b;
  return {
    gv: K0 + (2 / 3) * K1 * b + (8 / 15) * K2 * b * b,
    gnr: K0 + (8 / 15) * K1 * b + (40 / 105) * K2 * b * b,
    fnv,
    fyv: 1.5 * fnv - 0.5,
    fyr: K0 + (2 / 5) * K1 * b + (24 / 105) * K2 * b * b,
    fnr: K0 + 0.5 * K1 * b + (1 / 3) * K2 * b * b,
    vv: 2.25 * fnv - 1.25,
  };
}

/** Li and Wu's (1990) added masses over their deep-water values at depth over draught `ratio` (above 1). */
export function liWuAddedMass(
  ratio: number,
  hull: { readonly length: number; readonly beam: number; readonly draught: number; readonly block: number },
): [number, number, number] {
  const { length: L, beam: B, draught: T, block: CB } = hull,
    bt = B / T,
    gap = ratio - 1;
  return [
    1 + (3.77 + 1.14 * bt - 0.233 * (L / T) - 3.43 * CB) / pow(gap, 1.3),
    1 + (0.413 + 0.032 * bt + 0.0129 * bt * bt) / pow(gap, 0.82),
    1 + (0.413 + 0.0192 * bt + 0.00554 * bt * bt) / pow(gap, 0.82),
  ];
}

/**
 * One quantity of a {@link ShallowTable} at several depths: rows of [h/T, ...values], deepest first, each h/T above 1. Deep
 * water is the model itself: a value is interpolated in (T/h)^2 between deep water (T/h 0) and the rows, and held at the
 * shallowest row below it.
 */
export type ShallowRows = readonly (readonly number[])[];

/** A hull's shallow-water corrections from captive tests at several depths ({@link ManoeuvringModel.shallow}). */
export interface ShallowTable {
  /** [h/T, Y'v, N'v, N'r] over their deep-water values. */
  readonly hull: ShallowRows;
  /** [h/T, X'vv, X'vr + m'y, X'rr, X'vvvv] over their deep-water values (default unchanged). */
  readonly surge?: ShallowRows;
  /** [h/T, R'0] over its deep-water value (default unchanged). */
  readonly resistance?: ShallowRows;
  /** [h/T, a_H, x'_H]: added to the deep-water values (default unchanged). */
  readonly interaction?: ShallowRows;
  /** [h/T, gamma_R] over the deep-water flow straightening, both sides (default unchanged). */
  readonly straightening?: ShallowRows;
  /** [h/T, epsilon] over the deep-water ratio of the rudder's wake to the propeller's (default unchanged). */
  readonly wakeRatio?: ShallowRows;
  /** [h/T, 1 - t_P] over its deep-water value (default unchanged). */
  readonly thrustDeduction?: ShallowRows;
  /** [h/T, w_P0] over the deep-water straight-run wake (default unchanged). */
  readonly wake?: ShallowRows;
}

/**
 * KVLCC2's shallow-water table, from captive tests (docs/clean-room.md):
 * - Y'v, N'v, N'r at h/T 1.5 and 1.2: KVLCC2 itself, Nguyen, Nguyen and Yoon 2020, Table 3. At h/T 2.0: Esso Osaka, a tanker
 *   of the same form, Kijima et al. 1984, Table 3. N'r at h/T 1.2 is calibrated (2.4): the captive tests disagree there
 *   (Esso Osaka 1.99, KVLCC2's 1.4 m model 4.10), and 2.4 gives KRISO's measured 20/5 overshoot at h/T 1.2, 3.8 degrees.
 * - Surge derivatives and R'0: a bare hull of KVLCC2's L/B, B/T and C_B, Furukawa et al. 2016, Table 2.
 * - a_H, x'_H, gamma_R and 1 - t_P: Esso Osaka, Hirano et al. 1984 and Yoshimura 1986, read off their figures.
 * - w_P0 at every depth and gamma_R at h/T 2.0: Amin and Hasegawa's 2010 regression for KVLCC2's form, as Sherif, Xin and
 *   Zhou reprint it (Brodogradnja 78(1), 2026, Appendix C).
 * - epsilon: a pure car carrier's, Yoshimura 1986, the only measured series.
 */
export const KVLCC2_SHALLOW: ShallowTable = Object.freeze({
  hull: [
    [2, 1.01, 1.73, 0.97],
    [1.5, 1.89, 2.61, 1.22],
    [1.2, 4.79, 4.99, 2.4],
  ],
  surge: [
    [2, 2.97, 1.63, 1.31, 2.05],
    [1.5, 3.4, 2.31, 1.73, 3.82],
    [1.2, -9.2, 3.6, 2.14, 6.42],
  ],
  resistance: [
    [2, 1.02],
    [1.5, 1.047],
    [1.2, 1.158],
  ],
  interaction: [
    [1.5, 0.22, 0.22],
    [1.2, 0.39, 0.39],
  ],
  straightening: [
    [2, 1.403],
    [1.5, 1.82],
    [1.2, 1.37],
  ],
  wakeRatio: [
    [1.5, 1.2],
    [1.2, 1.34],
  ],
  thrustDeduction: [
    [1.5, 0.987],
    [1.2, 0.962],
  ],
  wake: [
    [2, 1.162],
    [1.5, 1.261],
    [1.2, 1.378],
  ],
});

/** Checks a table's rows, naming the first fault. */
function checkTable(table: ShallowTable): void {
  const widths: Record<string, number> = {
    hull: 4,
    surge: 5,
    resistance: 2,
    interaction: 3,
    straightening: 2,
    wakeRatio: 2,
    thrustDeduction: 2,
    wake: 2,
  };
  if (!table.hull) throw shipError("A shallow-water table needs its hull rows, [h/T, Y'v, N'v, N'r]; pass them.");
  for (const key in widths) {
    const rows = (table as unknown as Record<string, ShallowRows | undefined>)[key];
    if (rows === undefined) continue;
    let last = Infinity;
    for (const row of rows) {
      if (row.length !== widths[key] || !row.every(Number.isFinite) || !(row[0] > 1 && row[0] < last))
        throw shipError(
          `A shallow-water table's ${key} rows are [h/T, ...${widths[key] - 1} values], finite, h/T above 1 and deepest first; got [${row.join(', ')}].`,
        );
      last = row[0];
    }
  }
}

/** Value `index` of `rows` at depth over draught `ratio`, in (T/h)^2; `identity` in deep water. */
function rowValue(rows: ShallowRows | undefined, ratio: number, index: number, identity: number): number {
  if (!rows || rows.length === 0) return identity;
  const x = 1 / (ratio * ratio);
  let x0 = 0,
    v0 = identity;
  for (const row of rows) {
    const x1 = 1 / (row[0] * row[0]);
    if (x <= x1) return v0 + ((row[index] - v0) * (x - x0)) / (x1 - x0);
    x0 = x1;
    v0 = row[index];
  }
  return v0;
}

/**
 * The deep-water model `model` in water `depth` m deep, held at h / T 1.2 below that: by its own
 * {@link ManoeuvringModel.shallow} table when it has one (its linear hull derivatives, surge derivatives, resistance and
 * interaction constants), with Ankudinov et al.'s (1990) factors on its other hull derivatives and its sway and yaw added
 * masses, and Li and Wu's (1990) surge added mass. Deep water, or a depth of 10 draughts or more, gives the model back.
 * @throws MargoError for a depth not above 0 or a malformed table.
 */
export function shallowWater(model: ManoeuvringModel, depth: number): ManoeuvringModel {
  if (!(depth > 0))
    throw shipError(`A water depth is metres above 0 (got ${depth}); pass one, or Infinity for deep water.`);
  const T = model.draught;
  if (!Number.isFinite(depth) || depth >= 10 * T) return model;
  const ratio = Math.max(depth / T, SHALLOW_LIMIT),
    L = model.length,
    hull = { length: L, beam: model.beam, draught: T, block: model.volume / (L * model.beam * T) },
    f = ankudinovShallow(ratio, hull),
    [ax] = liWuAddedMass(ratio, hull),
    [mx, my, jz] = model.addedMass,
    [yv, yr, yvvv, yvvr, yvrr, yrrr] = model.sway,
    [nv, nr, nvvv, nvvr, nvrr, nrrr] = model.yaw;
  const shallow: ManoeuvringModel = {
    ...model,
    addedMass: [mx * ax, my * f.gv, jz * f.gnr],
    sway: [yv * f.fyv, yr * f.fyr, yvvv * f.vv, yvvr * f.fyv, yvrr * f.fyv, yrrr * f.fnr],
    yaw: [nv * f.fnv, nr * f.fnr, nvvv * f.vv, nvvr * f.gnr, nvrr * f.gnr, nrrr * f.gv],
  };
  const table = model.shallow;
  if (!table) return shallow;
  checkTable(table);
  const at = (rows: ShallowRows | undefined, index: number, identity = 1) => rowValue(rows, ratio, index, identity),
    [xvv, xvr, xrr, xvvvv] = model.surge,
    myShallow = shallow.addedMass[1],
    { sway, yaw } = shallow,
    { propeller: P, rudder: R } = model,
    gamma = at(table.straightening, 1),
    aH = at(table.interaction, 1, 0),
    xH = at(table.interaction, 2, 0);
  return {
    ...shallow,
    resistance: model.resistance * at(table.resistance, 1),
    // X'vr is measured with the sway added mass's reaction in it, X'vr + m'y (Furukawa et al. 2016).
    surge: [
      xvv * at(table.surge, 1),
      (xvr + my) * at(table.surge, 2) - myShallow,
      xrr * at(table.surge, 3),
      xvvvv * at(table.surge, 4),
    ],
    sway: [yv * at(table.hull, 1), sway[1], sway[2], sway[3], sway[4], sway[5]],
    yaw: [nv * at(table.hull, 2), nr * at(table.hull, 3), yaw[2], yaw[3], yaw[4], yaw[5]],
    propeller: {
      ...P,
      thrustDeduction: 1 - (1 - P.thrustDeduction) * at(table.thrustDeduction, 1),
      wake: P.wake * at(table.wake, 1),
    },
    rudder: {
      ...R,
      forceIncrease: R.forceIncrease + aH,
      forcePosition: R.forcePosition + xH,
      straightening: [R.straightening[0] * gamma, R.straightening[1] * gamma],
      wakeRatio: R.wakeRatio * at(table.wakeRatio, 1),
    },
  };
}
