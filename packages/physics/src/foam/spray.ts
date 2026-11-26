// Sea spray into the air (SEA-13, for ATMO-06): how many droplets of each size the sea's breakers make, per square metre
// and second. By the whitecap method: the flux per area of whitecap, times the whitecap coverage the breakers make
// (breaking.ts), so spray follows the breaking the waves actually have rather than the wind alone.
//
// - Bubble-burst film and jet drops, r80 from 0.07 to 20 micrometres: S. L. Gong, "A parameterization of sea-salt aerosol
//   source function for sub- and super-micron particles", Global Biogeochem. Cycles 17, 1097, 2003, as G. de Leeuw et al.,
//   "Production flux of sea spray aerosol", Rev. Geophys. 49, RG2001, 2011 (appendix, read) restate it:
//   dF/dr80 = 1.373 U10^3.41 r80^-A (1 + 0.057 r80^3.45) 10^(1.607 exp(-B^2)), A = 4.7 (1 + 30 r80)^(-0.017 r80^-1.44),
//   B = (0.433 - log10 r80) / 0.433, m^-2 s^-1 um^-1. Its U10^3.41 is the whitecap coverage of Monahan and O'Muircheartaigh
//   (1980), W = 3.84e-6 U10^3.41, so the flux per white area is dF/dr80 / W.
// - Monahan, Spiel and Davidson (1986) for r80 0.8 to 8 micrometres, the same shape: the reference the tests hold Gong to.
// - Bag breakup at strong winds: Y. Troitskaya et al., "The 'bag breakup' spume droplet generation mechanism at high winds",
//   Sci. Rep. 7, 1614, 2017 (read): <N> = N0 (u*^2 / U0^2) exp(-U0^2 / u*^2) events per m^2 per s, N0 = 3.73e3, U0 = 2 m/s,
//   about 100 droplets each; dominant from u* of about 0.9 m/s.
// r80 is the radius at 80 percent relative humidity, about half the radius r0 at formation (de Leeuw et al. 2011).
import { exp, ln, pow } from '@margoengine/math/pinned';

const LN10 = 2.302585092994046;

/**
 * The film and jet drop flux of Gong (2003) per area of whitecap, droplets per m^2 of white water per s per micrometre of
 * r80, for r80 in micrometres (valid 0.07 to 20).
 */
export function sprayPerWhitecap(r80: number): number {
  if (!(r80 > 0)) return 0;
  const log = ln(r80) / LN10,
    a = 4.7 * pow(1 + 30 * r80, -0.017 * pow(r80, -1.44)),
    b = (0.433 - log) / 0.433;
  // 1.373 / 3.84e-6: Gong's U10^3.41 divided out as Monahan and O'Muircheartaigh's coverage.
  return (1.373 / 3.84e-6) * pow(r80, -a) * (1 + 0.057 * pow(r80, 3.45)) * exp(LN10 * 1.607 * exp(-b * b));
}

/**
 * The spray flux from a sea of whitecap coverage `coverage` (0 to 1), droplets per m^2 per s per micrometre of r80 at
 * `r80` micrometres: the whitecap method with Gong's flux per white area.
 */
export function sprayFlux(coverage: number, r80: number): number {
  return coverage > 0 ? coverage * sprayPerWhitecap(r80) : 0;
}

/** Bag-breakup events per m^2 per s at friction velocity `ustar` m/s (Troitskaya et al. 2017, eq. 1). */
export function bagBreakups(ustar: number): number {
  if (!(ustar > 0)) return 0;
  const ratio = (ustar * ustar) / 4;
  return 3.73e3 * ratio * exp(-1 / ratio);
}
