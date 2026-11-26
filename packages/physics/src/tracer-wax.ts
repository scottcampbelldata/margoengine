import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';

/** Mean-to-centre thickness ratio for Nihoul's finite axisymmetric oil film. */
export const WAX_FILM_MEAN = 2 / 3;

export function waxLimit(volume: number, oilDensity: number, reducedGravity: number, yieldStress: number): number {
  // Brönner et al. (2018), Eq. A7. Convert shear yield stress to elongational yield stress.
  const terminalThickness = (2 * Math.sqrt(3) * yieldStress) / (oilDensity * reducedGravity);
  const radius = Math.sqrt(volume / (Math.PI * WAX_FILM_MEAN * terminalThickness));
  if (!(radius > 0 && Number.isFinite(radius)))
    throw new MargoError(
      'unsupported',
      'The waxy oil stopping radius is invalid; use physical buoyancy and yield stress.',
    );
  return radius;
}

/** Solve the fixed-volume form of Brönner et al.'s Eq. A8 without time-stepping the singular radius. */
export function waxRadius(limit: number, freeRadius: number): number {
  const ratio = freeRadius / limit;
  const square = ratio * ratio;
  const time = (square * square) / 2;
  if (time >= 2.25) return limit;
  if (time <= Number.EPSILON * Number.EPSILON) return freeRadius;

  // With y=(R/limit)² and u=1-(1-y)^(1/3), the integral of y/(1-y)^(2/3) is
  // 3u²(u²-4u+6)/4. Bound the root relative to u, even for a newly released film.
  let low = Math.sqrt(time / 4.5);
  let high = Math.min(1, Math.sqrt(time / 2.25));
  for (let step = 0; step < 48; step++) {
    const u = (low + high) / 2;
    const distance = 2 - u;
    if (0.75 * u * u * (distance * distance + 2) < time) low = u;
    else high = u;
  }
  const u = (low + high) / 2;
  return limit * Math.sqrt(u * (3 - 3 * u + u * u));
}

/** Inverse radial mass CDF of the profile h/h0=sqrt(1-r²/R²). */
export function waxMassRadius(fraction: number): number {
  return Math.sqrt(1 - pow(1 - fraction, 2 / 3));
}
