// Hydrodynamic loads on members and small bodies (SEA-12): the Morison equation and its coefficients, from DNV-RP-C205,
// "Environmental conditions and environmental loads", Det Norske Veritas, October 2010 (sections 6.1 to 6.13, 9.1 and 9.2,
// and appendices D and E, read; page images checked for the figures' formulas):
// - the relative-velocity form f_N = rho A a + rho C_A A a_r + 1/2 rho C_D D |v_r| v_r per length (6.2.4), on small 3D
//   bodies with the volume V and projected area S in place of A and D (6.13.1.2);
// - the steady post-critical drag by roughness C_DS(k / D) (6.7.1.5), its wake amplification psi(KC) (6.7.2.1 to 6.7.2.2),
//   with a current KC* = (v_m + v_c) T / D and C_DS alone when the current passes 0.4 v_m (6.7.2.4), and the added mass's fall
//   with KC (6.9.1);
// - the tangential drag of an inclined member or cable, C_Dt = C_Dn (m + n sin phi) cos phi (Eames 1968, as 6.3.1.3 gives it);
// - vortex shedding at St U / D, St 0.2 (9.1.2 to 9.1.3), and lock-in, 3 < V_R < 16 for low mass ratios (9.1.7).
// The sphere's drag over all Reynolds numbers is F. A. Morrison's fit ("An Introduction to Fluid Mechanics", Cambridge
// University Press, 2013, eq. 1, data correlation for Re <= 1e6, read). The wake oscillator's lift magnification under an
// imposed motion is M. L. Facchinetti, E. de Langre and F. Biolley, "Vortex-induced travelling waves along a cable", Eur. J.
// Mech. B/Fluids 23, 2004 (eq. 5, read), with A / epsilon = 40; its wake oscillator, driven by the cylinder's acceleration
// across the flow, is M. L. Facchinetti, E. de Langre and F. Biolley, "Coupling of structure and wake oscillators in
// vortex-induced vibrations", J. Fluids Struct. 19, 2004 (eq. 2, read), epsilon 0.3 and A 12. Below the drag crisis a
// circular cylinder's drag follows its Reynolds number: C_D = 1 + 10 Re^(-2/3) for 1 < Re < 2e5 (the curve fit of F. M.
// White, "Viscous Fluid Flow", 2nd ed., McGraw-Hill 1991, read), where DNV's steady drag is the post-critical value.
import { invalidLoad } from './errors.js';
import { ln, pow } from '@margoengine/math/pinned';

const LN10 = 2.302585092994046;
const PI = 3.141592653589793;

/** The steady post-critical drag coefficient of a circular cylinder of relative roughness k / D (DNV-RP-C205 6.7.1.5). */
export function steadyDrag(roughness: number): number {
  if (!(roughness >= 0 && Number.isFinite(roughness)))
    throw invalidLoad(`A relative roughness k / D is finite and 0 or more (got ${roughness}); pass one, 0 for smooth.`);
  if (roughness < 1e-4) return 0.65;
  if (roughness > 1e-2) return 1.05;
  return (29 + 4 * (ln(roughness) / LN10)) / 20;
}

/**
 * The wake amplification psi of the drag in oscillatory flow at Keulegan-Carpenter number KC for steady drag C_DS (DNV-RP-
 * C205 6.7.2.2, KC below 12). Above 12 the recommended practice gives only a figure, rising to a peak near KC / C_DS of 10
 * and falling toward 1: here psi falls from its value at 12 toward 1 as 12 / KC (an approximation of that figure).
 */
export function wakeAmplification(kc: number, steady: number): number {
  if (!(kc >= 0 && steady > 0))
    throw invalidLoad(`KC is 0 or more and C_DS above 0 (got ${kc}, ${steady}); pass them.`);
  const cpi = 1.5 - 0.024 * (12 / steady - 10);
  if (kc < 0.75) return cpi - 1 - 2 * (kc - 0.75);
  if (kc < 2) return cpi - 1;
  if (kc < 12) return cpi + 0.1 * (kc - 12);
  return 1 + (cpi - 1) * (12 / kc);
}

/**
 * A circular cylinder's steady drag at Reynolds number `re` and relative roughness k / D: White's subcritical fit 1 + 10
 * Re^(-2/3) up to Re 2e5 (held at its Re 1 value below 1), DNV's post-critical C_DS(k / D) from Re 5e5, and between them a
 * straight line in log Re across the drag crisis (the crisis's dip to about 0.3 on a smooth cylinder near Re 5e5 is not
 * followed: a margin of a few hundred thousand in Re that a hose, a cable or a pile in the sea rarely sits in).
 */
export function reynoldsDrag(re: number, roughness = 0): number {
  if (!(re >= 0 && Number.isFinite(re)))
    throw invalidLoad(`A Reynolds number is finite and 0 or more (got ${re}); pass one.`);
  const post = steadyDrag(roughness),
    white = (r: number) => 1 + 10 * pow(r, -2 / 3);
  if (re <= 2e5) return white(Math.max(re, 1));
  if (re >= 5e5) return post;
  const s = ln(re / 2e5) / ln(2.5);
  return white(2e5) + (post - white(2e5)) * s;
}

/** The added mass coefficient of a circular cylinder at KC with steady drag C_DS (DNV-RP-C205 6.9.1). */
export function cylinderAddedMass(kc: number, steady = 0.65): number {
  if (!(kc >= 0)) throw invalidLoad(`KC is 0 or more (got ${kc}); pass one.`);
  return kc < 3 ? 1 : Math.max(1 - 0.044 * (kc - 3), 0.6 - (steady - 0.65));
}

/**
 * A circular member's drag and added mass coefficients at KC, its relative roughness and a current's share (DNV 6.7 to 6.9).
 * With its Reynolds number `re`, the steady drag is {@link reynoldsDrag}'s, so a thin member below the drag crisis takes its
 * subcritical drag; without, DNV's post-critical steady drag.
 */
export function cylinderCoefficients(
  kc: number,
  roughness = 0,
  current = 0,
  orbital = 1,
  re?: number,
): { drag: number; addedMass: number } {
  const steady = re === undefined ? steadyDrag(roughness) : reynoldsDrag(re, roughness),
    // A current above 0.4 of the waves' velocity: the steady drag alone; else KC* with the current in it.
    drag =
      current > 0.4 * orbital
        ? steady
        : steady * wakeAmplification(kc * (orbital > 0 ? (orbital + current) / orbital : 1), steady);
  // The added mass falls with KC by DNV's post-critical steady drag, whatever the drag at this Reynolds number.
  return { drag, addedMass: cylinderAddedMass(kc, re === undefined ? steady : steadyDrag(roughness)) };
}

/**
 * The Morison load per unit length normal to a member, N/m: rho A a + rho C_A A (a - r'') + 1/2 rho C_D D |v_r| v_r, for the
 * water's normal velocity `v` and acceleration `a`, the member's `r1` and `r2` (velocity, acceleration), its diameter D and
 * section area A (default pi D^2 / 4). Each argument is the component normal to the member along one direction.
 */
export function morison(
  density: number,
  diameter: number,
  drag: number,
  addedMass: number,
  v: number,
  a: number,
  r1 = 0,
  r2 = 0,
  area = (PI * diameter * diameter) / 4,
): number {
  const vr = v - r1;
  return (
    density * area * a + density * addedMass * area * (a - r2) + 0.5 * density * drag * diameter * Math.abs(vr) * vr
  );
}

/**
 * The tangential drag coefficient of a member or cable at angle phi between its axis and the flow (Eames 1968), from sin phi
 * and cos phi: C_Dn (m + n sin phi) cos phi, m 0.03 and n 0.055 for a rough riser (0.02 to 0.03 and 0.04 to 0.05 a smooth
 * cable).
 */
export function tangentialDrag(normal: number, sinPhi: number, cosPhi: number, m = 0.03, n = 0.055): number {
  return normal * (m + n * sinPhi) * cosPhi;
}

/** A sphere's drag coefficient at Reynolds number `re` (Morrison 2013, valid to 1e6). */
export function sphereDrag(re: number): number {
  if (!(re > 0 && Number.isFinite(re)))
    throw invalidLoad(`A Reynolds number is finite and above 0 (got ${re}); pass one.`);
  const r = Math.min(re, 1e6),
    a = r / 5,
    b = r / 263000;
  return 24 / r + (2.6 * a) / (1 + pow(a, 1.52)) + (0.411 * pow(b, -7.94)) / (1 + pow(b, -8)) + pow(r, 0.8) / 461000;
}

/** A circular cylinder's vortex-shedding frequency St U / D, Hz, St 0.2 (DNV-RP-C205 9.1.3). */
export function sheddingFrequency(speed: number, diameter: number, strouhal = 0.2): number {
  if (!(diameter > 0)) throw invalidLoad(`A diameter is above 0 (got ${diameter}); pass one.`);
  return (strouhal * Math.abs(speed)) / diameter;
}

/**
 * The magnification K = C_L / C_L0 of a cylinder's lift under an imposed cross-flow motion of amplitude y0 diameters
 * (Facchinetti et al. 2004, eq. 5, A / epsilon = 40): (X / 36)^(1/3) + (4 / (3 X))^(1/3), X = 9 s + sqrt(81 s^2 - 48), s =
 * (A / eps) y0. That is Cardano's root of K^3 - K = s / 2 (the two cube roots multiply to 1/3 and their cubes sum to s / 2),
 * solved here directly, which also holds where X is complex.
 */
export function liftMagnification(amplitude: number, ratio = 40): number {
  if (!(amplitude >= 0 && Number.isFinite(amplitude) && ratio > 0))
    throw invalidLoad(`An amplitude in diameters is finite and 0 or more (got ${amplitude}); pass one.`);
  const target = (ratio * amplitude) / 2;
  let k = Math.max(1, pow(target, 1 / 3) + 0.5);
  for (let i = 0; i < 60; i++) {
    const next = k - (k * k * k - k - target) / (3 * k * k - 1);
    if (Math.abs(next - k) < 1e-15 * k) break;
    k = next;
  }
  return k;
}

/**
 * One step `dt` of a cylinder's wake oscillator q (Facchinetti, de Langre and Biolley 2004): q'' + eps w_f (q^2 - 1) q' +
 * w_f^2 q = forcing, eps 0.3, at the shedding's angular frequency `wf`, `forcing` the coupling to the cylinder, A / D times
 * its acceleration across the flow (0 for a cylinder held still). `state` holds q and q' at `2 index` and `2 index + 1`;
 * it is stepped in substeps of at most 0.05 rad of the shedding's phase by semi-implicit Euler, and the new q returned.
 */
export function wakeStep(state: Float64Array, index: number, wf: number, forcing: number, dt: number): number {
  const eps = 0.3,
    steps = Math.max(1, Math.ceil((wf * dt) / 0.05)),
    h = dt / steps;
  let q = state[2 * index]!,
    dq = state[2 * index + 1]!;
  for (let k = 0; k < steps; k++) {
    // Semi-implicit Euler: the velocity first, then the position with it.
    dq += h * (-eps * wf * (q * q - 1) * dq - wf * wf * q + forcing);
    q += h * dq;
  }
  state[2 * index] = q;
  state[2 * index + 1] = dq;
  return q;
}
