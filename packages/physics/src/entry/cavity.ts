// The air cavity behind a body that goes into the water fast enough (SEA-14), from the papers below (read as text; no
// code; docs/clean-room.md "Water entry and exit"):
// - C. Duez, C. Ybert, C. Clanet and L. Bocquet, "Making a splash with water repellency", Nature Physics 3, 180-183,
//   2007, https://doi.org/10.1038/nphys545 (arXiv cond-mat/0701093): a wetting sphere (contact angle under 90 degrees)
//   drags air down only above U* = xi gamma / mu with xi about 0.1, some 7 m/s in water; a water-repellent one above
//   U* = g0 / (9 l zeta) (gamma / mu) (pi - theta0)^3 with l = 15, zeta = 2 and g0 about 7. Size and gas pressure do not
//   change the threshold (7 to 25 mm spheres).
// - V. Duclaux, F. Caille, C. Duez, C. Ybert, L. Bocquet and C. Clanet, "Dynamics of transient cavities", J. Fluid Mech.
//   591, 1-19, 2007, as J. M. Aristoff, T. T. Truscott, A. H. Techet and J. W. M. Bush, "The water entry of decelerating
//   spheres", Phys. Fluids 22, 032102, 2010, https://doi.org/10.1063/1.3309454, give it: each depth z of the cavity
//   opens as the body passes and then closes under the water's weight, d^2(R^2)/dt^2 = -2 g z, from R = R0 at the
//   speed sqrt(alpha) U(z), where U(z) is the body's speed as it passed (G. V. Logvinovich's independent expansion of
//   each section) and alpha = cot^2(theta_c - pi/2) with the cavity's cone angle theta_c about 160 degrees; the contact
//   line is pinned at the body's widest section. The cavity pinches (deep seal) at the first depth to close, the least
//   t(z) + t_c(z) (their eq. 14): for a body at constant speed at z = sqrt(2) alpha^(1/4) F^(1/2) R0 after
//   2 sqrt(2) alpha^(1/4) F^(1/2) R0 / U0, F = U0^2 / (g R0) (eqs. 18 and 19 with no deceleration).
// - S. Gekle and J. M. Gordillo, "Generation and breakup of Worthington jets after cavity collapse. Part 1", J. Fluid
//   Mech. 663, 293-330, 2010, arXiv 0907.5154: the jet the collapse throws up leaves at about three times the fastest
//   radial speed of the walls before the pinch, and in their measurements at 10 to 12 times the impact speed (a 42.75 mm
//   golf ball at 2.03 m/s threw a jet at about 20 m/s; a 22 mm disc at 1.85 m/s one above 22.7 m/s).

/** f64 words a cavity section holds: where its centre is (x, y, z), when it opened, its opening rate R0 sqrt(alpha) U, R0. */
export const SECTION_WORDS = 6;

/** The cavity's cone angle, about 160 degrees (Aristoff et al. 2010), as alpha = cot^2(theta_c - pi/2). */
export const CAVITY_ALPHA = 0.13247433143179413;

/** Duez et al.'s xi for wetting bodies: U* = xi gamma / mu. */
export const WETTING_XI = 0.1;

/**
 * The speed above which a body with contact angle `theta` (radians) drags an air cavity down into water of surface
 * tension `gamma` (N/m) and viscosity `mu` (Pa s), m/s (Duez et al. 2007).
 */
export function cavityThreshold(theta: number, gamma: number, mu: number): number {
  const speed = gamma / mu;
  if (theta < Math.PI / 2) return WETTING_XI * speed;
  const d = Math.PI - theta;
  return (7 / (9 * 15 * 2)) * speed * d * d * d;
}

/** The squared radius of a cavity section `tau` s after it opened at `depth` m with opening rate `rate` and radius `r0`. */
export function sectionRadius2(r0: number, rate: number, depth: number, g: number, tau: number): number {
  return r0 * r0 + 2 * rate * tau - g * depth * tau * tau;
}

/** The deep-seal depth and time of a cavity behind a body at constant speed `u` with widest radius `r0` (no deceleration). */
export function constantSpeedPinch(u: number, r0: number, g: number): { depth: number; time: number } {
  const a = Math.sqrt(Math.sqrt(CAVITY_ALPHA)),
    f = Math.sqrt((u * u) / (g * r0));
  return { depth: Math.SQRT2 * a * f * r0, time: (2 * Math.SQRT2 * a * f * r0) / u };
}
