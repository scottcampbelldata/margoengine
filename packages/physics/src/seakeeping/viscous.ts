// A hull's viscous roll damping (SEA-08): the eddies a rolling hull sheds at its bilges and the friction of its skin, which
// potential flow leaves out and which damp a real hull's roll most near its resonance. Ikeda's component method as the ITTC
// gives it (ITTC Recommended Procedure 7.5-02-07-04.5, "Estimation of Roll Damping", revision 02, 2024, section 4.2.1,
// after Ikeda, Himeno and Tanaka 1978, Ikeda et al. 1977 and Katayama et al. 2022):
// - eddy making at zero speed (eqs. 42-44): a section of draft d sheds a moment -1/2 rho d^4 C_R phi' |phi'| per metre, C_R
//   from its Lewis form, its area coefficient and the depth OG of the roll axis under the waterline (Ikeda's pressure
//   coefficient Cp as a function of the ratio gamma of the greatest to the mean speed on the hull);
// - skin friction (eqs. 37-39, Kato 1957): laminar, B = (4 / (3 pi)) rho S r^3 phi_a w Cf with Cf = 1.328 (3.22 r^2 phi_a^2 /
//   (T nu))^-0.5, so B = (4 / (3 pi)) (1.328 / sqrt 3.22) rho S r^2 sqrt(2 pi nu w), linear in the roll rate, taken at the
//   hull's natural roll frequency (eq. 29's assumption). S and r are the section's wetted girth and the mean distance of its
//   girth from the roll axis, integrated on its Lewis contour (Kato's regressions in S and r are for a whole ship's lines).
// The wave component is the radiation's (radiation.ts, memory.ts), never counted twice. Forward speed (the lift component,
// eq. 33, and the speed corrections, eqs. 41 and 45) and bilge keels (eqs. 47-55) are not here.
import { cos, exp, hypot, sin } from '@margoengine/math/pinned';
import type { LewisForm } from './strips.js';

/**
 * Ikeda's eddy-making coefficient C_R (ITTC 7.5-02-07-04.5 eqs. 43-44) of a section of breadth B and draft d with Lewis form
 * `form`, rolling about an axis `pivot` under the waterline (OG, down positive): the section sheds a roll moment
 * -1/2 rho d^4 C_R phi' |phi'| per metre. A bilge radius follows from the area coefficient (eq. 57); a box section (sigma 1) has
 * sharp corners. The axis is held at most 0.95 d deep, the formula's range (gamma takes sqrt(1 - OG / d)).
 */
export function eddyRollCoefficient(form: LewisForm, breadth: number, draft: number, pivot: number): number {
  const { a1, a3, sigma } = form,
    d = draft,
    og = Math.min(pivot, 0.95 * d),
    h0 = breadth / (2 * d),
    m = breadth / (2 * (1 + a1 + a3)),
    rmax = (p: number) => m * hypot((1 + a1) * sin(p) - a3 * sin(3 * p), (1 - a1) * cos(p) + a3 * cos(3 * p)),
    // The point of the contour farthest from its centre: the keel (psi 0) or where the bilge turns.
    c = (a1 * (1 + a3)) / (4 * a3),
    psi2 = a3 !== 0 && Math.abs(c) <= 1 ? 0.5 * arccos(c) : 0,
    psi = rmax(0) >= rmax(psi2) ? 0 : psi2,
    r = rmax(psi),
    h = 1 + a1 * a1 + 9 * a3 * a3 + 2 * a1 * (1 - 3 * a3) * cos(2 * psi) - 6 * a3 * cos(4 * psi),
    a0 =
      -2 * a3 * cos(5 * psi) +
      a1 * (1 - a3) * cos(3 * psi) +
      ((6 - 3 * a1) * a3 * a3 + (a1 * a1 - 3 * a1) * a3 + a1 * a1) * cos(psi),
    b0 =
      -2 * a3 * sin(5 * psi) +
      a1 * (1 - a3) * sin(3 * psi) +
      ((6 + 3 * a1) * a3 * a3 + (3 * a1 + a1 * a1) * a3 + a1 * a1) * sin(psi),
    f1 = 0.5 * (1 + tanh(20 * (sigma - 0.7))),
    s = sin(Math.PI * sigma),
    f2 = 0.5 * (1 - cos(Math.PI * sigma)) - 1.5 * (1 - exp(-5 * (1 - sigma))) * s * s,
    f3 = 1 + 4 * exp(-1.65e5 * (1 - sigma) * (1 - sigma)),
    h0p = h0 / (1 - og / d),
    sp = (sigma - og / d) / (1 - og / d),
    gamma =
      (Math.sqrt(Math.PI) * f3 * (r + ((2 * m) / h) * hypot(a0, b0))) /
      (2 * d * (1 - og / d) * Math.sqrt(Math.max(h0p * sp, 1e-12))),
    cp = 0.5 * (0.87 * exp(-gamma) - 4 * exp(-0.187 * gamma) + 3),
    rd = bilgeRadius(h0, sigma, d, breadth) / d,
    bracket = (1 - f1 * rd) * (1 - 1.5 * (og / d) - f1 * rd) + f2 * (h0 - f1 * rd) * (h0 - f1 * rd);
  return Math.max(0, bracket * cp * (r / d) * (r / d));
}

/** tanh by the pinned exponential. */
function tanh(x: number): number {
  const e = exp(-2 * Math.abs(x)),
    t = (1 - e) / (1 + e);
  return x < 0 ? -t : t;
}

/** The angle in [0, pi] whose pinned cosine is c (|c| <= 1), by bisection: cos falls over the range. */
function arccos(c: number): number {
  let lo = 0,
    hi = Math.PI;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cos(mid) > c) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The bilge radius of a section of half-breadth-to-draft ratio H0 and area coefficient sigma, a quarter circle joining its
 * side and its bottom (ITTC 7.5-02-07-04.5 eq. 57): 0 for a full box section.
 */
function bilgeRadius(h0: number, sigma: number, d: number, breadth: number): number {
  if (sigma >= 1) return 0;
  const r = 2 * d * Math.sqrt((h0 * (sigma - 1)) / (Math.PI - 4));
  if (r < d && r < breadth / 2) return r;
  return h0 >= 1 ? d : breadth / 2;
}

/**
 * The girth S of a Lewis section under the waterline and the mean distance r of its girth from a roll axis `pivot` under the
 * waterline, for its skin friction (Kato's S r^2): returns S r^2 per metre of hull.
 */
export function frictionGirth(form: LewisForm, pivot: number, points = 64): number {
  const { scale, a1, a3 } = form;
  let girth = 0,
    moment = 0;
  // The contour from the waterline on one side (theta -pi/2) round the keel (0) to the other (pi/2); y runs down.
  let [px, py] = [0, 0];
  for (let i = 0; i <= points; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / points,
      x = scale * ((1 + a1) * sin(t) - a3 * sin(3 * t)),
      y = scale * ((1 - a1) * cos(t) + a3 * cos(3 * t));
    if (i > 0) {
      const ds = hypot(x - px, y - py),
        mx = (x + px) / 2,
        my = (y + py) / 2;
      girth += ds;
      moment += ds * hypot(mx, my - pivot);
    }
    [px, py] = [x, y];
  }
  const r = girth > 0 ? moment / girth : 0;
  return girth * r * r;
}

/** Kato's laminar skin-friction factor: B = FRICTION * rho * (S r^2) * sqrt(2 pi nu w). */
export const FRICTION = ((4 / (3 * Math.PI)) * 1.328) / Math.sqrt(3.22);
