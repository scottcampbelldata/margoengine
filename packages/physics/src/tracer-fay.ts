import { pow } from '@margoengine/math/pinned';

/** Radius coefficients for Fay's axisymmetric inertial, viscous and surface tension regimes. */
export type FayCoefficients = readonly [inertial: number, viscous: number, surface: number];

export function fayCoefficients(
  volume: number,
  reducedGravity: number,
  waterDensity: number,
  viscosity: number,
  spreadingCoefficient: number,
): FayCoefficients {
  // Fay (1971), Tables I and II. Volume is m³, water viscosity is kinematic, and the spreading coefficient is N/m.
  return [
    1.14 * pow(reducedGravity * volume, 0.25),
    1.45 * pow((reducedGravity * volume * volume) / Math.sqrt(viscosity), 1 / 6),
    2.3 * pow((spreadingCoefficient * spreadingCoefficient) / (waterDensity * waterDensity * viscosity), 0.25),
  ];
}

export function fayRadius([inertial, viscous, surface]: FayCoefficients, age: number): number {
  const half = Math.sqrt(age);
  const quarter = Math.sqrt(half);
  // Viscous resistance eventually slows gravity spreading. Surface tension takes over when its radius exceeds it.
  return Math.max(Math.min(inertial * half, viscous * quarter), surface * half * quarter);
}
