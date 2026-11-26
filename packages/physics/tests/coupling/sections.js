// A free box section in a beam wave, for the seakeeping tests (its motions from the wave's load on it held still and its own
// radiation, and the waves it then sends out).
import { GRAVITY, heaveSection, lateralSection, lewisForm, SEA_WATER, scatterSection } from '../../dist/seakeeping.js';

/**
 * A free box section's motions in a beam wave of unit amplitude (e^(-i w t), the book's heave down), from the wave's load on
 * it held still and its own added mass, damping, mass, waterplane and roll stiffness: B, T, D its breadth, draft and depth.
 */
export function freeSection([B, T, D], w, rho = SEA_WATER) {
  const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
    sub = (a, b) => [a[0] - b[0], a[1] - b[1]],
    div = (a, b) => {
      const q = b[0] * b[0] + b[1] * b[1];
      return [(a[0] * b[0] + a[1] * b[1]) / q, (a[1] * b[0] - a[0] * b[1]) / q];
    },
    form = lewisForm(B, T, B * T),
    m = rho * B * T,
    inertia = (m * (D * D + B * B)) / 12,
    pivot = T - D / 2,
    gm = T / 2 + (B * B) / (12 * T) - D / 2,
    held = scatterSection(form, w, pivot, {}, GRAVITY, 16, 64, rho),
    h = heaveSection(form, w, rho, GRAVITY),
    l = lateralSection(form, w, rho, pivot, GRAVITY),
    a24 = (l.swayOfRoll.addedMass + l.rollOfSway.addedMass) / 2,
    b24 = (l.swayOfRoll.damping + l.rollOfSway.damping) / 2,
    m22 = [-w * w * (m + l.sway.addedMass), -w * l.sway.damping],
    m24 = [-w * w * a24, -w * b24],
    m44 = [rho * GRAVITY * B * T * gm - w * w * (inertia + l.roll.addedMass), -w * l.roll.damping],
    det = sub(mul(m22, m44), mul(m24, m24)),
    heave = div(held.heaveForce, [rho * GRAVITY * B - w * w * (m + h.addedMass), -w * h.damping]),
    sway = div(sub(mul(held.swayForce, m44), mul(m24, held.rollMoment)), det),
    roll = div(sub(mul(m22, held.rollMoment), mul(m24, held.swayForce)), det),
    velocity = (x) => [w * x[1], -w * x[0]];
  return {
    form,
    pivot,
    scattered: scatterSection(
      form,
      w,
      pivot,
      { heave: velocity(heave), sway: velocity(sway), roll: velocity(roll) },
      GRAVITY,
      16,
      64,
      rho,
    ),
  };
}

/** A prismatic V hull of deadrise `beta`, half-breadth `b` at its chine, `length` long, closed by a flat deck at the chine. */
export function vHull(beta, b, length) {
  const h = b * Math.tan(beta),
    v = [],
    indices = [];
  for (const x of [-length / 2, length / 2]) v.push(x, 0, 0, x, h, b, x, h, -b);
  for (const t of [
    [0, 2, 1],
    [3, 4, 5],
    [0, 1, 4],
    [0, 4, 3],
    [0, 3, 5],
    [0, 5, 2],
    [1, 2, 5],
    [1, 5, 4],
  ])
    indices.push(...t);
  return { vertices: Float64Array.from(v), indices: Uint32Array.from(indices) };
}
