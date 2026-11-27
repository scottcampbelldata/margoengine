// A ship's manoeuvring in shallow water (SEA-09): the hull derivatives and added masses of a deep-water MMG model corrected
// for the depth under the keel, by Ankudinov, Miller, Jakobsen and Daggett, MARSIM & ICSM 1990, as M. Vantorre reprints them
// in "Manoeuvring coefficients for a container carrier in shallow water: an evaluation of semi-empirical formulae" (23rd ITTC
// Manoeuvring Committee, https://www.vliz.be/imisdocs/publications/ocrd/220165.pdf, eqs. 4 to 8, read): every linear and
// nonlinear derivative and the sway and yaw added masses scaled by one family of functions of h/T and B1/T. The surge
// added mass, which Ankudinov does not give, by Li and Wu, MARSIM & ICSM 1990 (the same review, eq. 26). Ankudinov's
// nonlinear terms are |v|v-type; on a model of MMG's cubic form (Yasukawa and Yoshimura 2015) each cubic term takes the
// factor of its quadratic counterpart, an approximation this file states. Kijima et al.'s (1990) factors from the same
// review were tried and left out: on Yasukawa and Yoshimura's KVLCC2 they raise N'v twice as much as N'r, and the ship
// turns tighter in shallow water, against every free-running test. The rudder and propeller interaction constants are
// left as in deep water.
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
 * The deep-water model `model` in water `depth` m deep: its hull derivatives and sway and yaw added masses by Ankudinov et
 * al. (1990) and its surge added mass by Li and Wu (1990), held at h / T 1.2 below that. Deep water, or a depth of 10
 * draughts or more, gives the model back.
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
  return {
    ...model,
    addedMass: [mx * ax, my * f.gv, jz * f.gnr],
    sway: [yv * f.fyv, yr * f.fyr, yvvv * f.vv, yvvr * f.fyv, yvrr * f.fyv, yrrr * f.fnr],
    yaw: [nv * f.fnv, nr * f.fnr, nvvv * f.vv, nvvr * f.gnr, nvrr * f.gnr, nrrr * f.gv],
  };
}
