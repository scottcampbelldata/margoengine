// A ship's resistance in level ice (SEA-09): the regression of J. Riska, M. Wilhelmson, K. Englund and T. Leiviskä,
// "Performance of merchant vessels in ice in the Baltic", Winter Navigation Research Board report 52, 1997, fitted to
// full-scale Baltic trials, as J. Hu and L. Zhou, "Experimental and numerical study on ice resistance for icebreaking
// vessels", Int. J. Naval Arch. Ocean Eng. 7, 626-639, 2015, doi:10.1515/ijnaoe-2015-0044, print it (eq. 11 and Table 1,
// read): R = C1 + C2 V, C1 from the ice's breaking along the parallel midbody and the bow, C2 from its submersion and
// clearing, both rising with the stem angle. Hu and Zhou's model tests of MT Uikku in the Aalto ice basin (Tables 3 to 7)
// are the measurements the test holds it to.
import { pow } from '@margoengine/math/pinned';
import { shipError } from './errors.js';

/** A hull's ice-going form: length, beam and draught, m, its stem angle, rad, and the lengths of its bow and parallel midbody, m. */
export interface IceHull {
  readonly length: number;
  readonly beam: number;
  readonly draught: number;
  readonly stem: number;
  readonly bow: number;
  readonly parallel: number;
}

/** Riska et al.'s constants, kN/m^3 and kN s/m^(k+1) (Hu and Zhou Table 1). */
const F1 = 0.23,
  F2 = 4.58,
  F3 = 1.47,
  F4 = 0.29,
  G1 = 18.9,
  G2 = 0.67,
  G3 = 1.55;

/**
 * A ship's resistance in level ice `thickness` m thick at `speed` m/s ahead (Riska et al. 1997), N: `c1` the part that
 * does not grow with speed, N, and `c2`, N per m/s. The regression was fitted to Baltic merchant ships going ahead.
 */
export function iceResistance(
  hull: IceHull,
  thickness: number,
  speed: number,
): { resistance: number; c1: number; c2: number } {
  const { length: L, beam: B, draught: T, stem, bow, parallel } = hull ?? ({} as IceHull);
  if (
    !(L > 0 && B > 0 && T > 0 && bow >= 0 && parallel >= 0 && stem > 0 && stem < Math.PI / 2) ||
    ![L, B, T, stem, bow, parallel].every(Number.isFinite)
  )
    throw shipError(
      `An ice-going hull is {length, beam, draught, stem, bow, parallel}: lengths finite and above 0 (bow and parallel 0 or more) and a stem angle between 0 and pi / 2 rad (got ${[L, B, T, stem, bow, parallel].join(', ')}); pass them.`,
    );
  if (!(thickness >= 0 && Number.isFinite(thickness) && Number.isFinite(speed)))
    throw shipError(
      `Level ice is a finite thickness of 0 m or more at a finite speed (got ${thickness} m, ${speed} m/s); pass them.`,
    );
  if (thickness === 0) return { resistance: 0, c1: 0, c2: 0 };
  const h = thickness,
    phi = (stem * 180) / Math.PI,
    c1 =
      (F1 / ((2 * T) / B + 1)) * B * parallel * h +
      (1 + 0.021 * phi) * (F2 * B * h * h + F3 * bow * h * h + F4 * B * bow * h),
    c2 = (1 + 0.063 * phi) * (G1 * pow(h, 1.5) + G2 * B * h) + (G3 * h * (1 + (1.2 * T) / B) * B * B) / Math.sqrt(L);
  return { resistance: 1000 * (c1 + c2 * Math.max(0, speed)), c1: 1000 * c1, c2: 1000 * c2 };
}
