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

/** Constant-rate axisymmetric discharge followed by fixed-volume gravity spreading. */
export function fedOilRadius([inertial, viscous]: FayCoefficients, age: number, duration: number): number {
  const fraction = Math.min(1, age / duration);
  const cap = inertial * Math.sqrt(age) * Math.sqrt(Math.sqrt(fraction));
  // Maderich et al. (2012), Eqs. 27 and 30. Convert from Fay's 1.45 viscous prefactor.
  const spreading =
    age <= duration
      ? (viscous * 0.816 * Math.sqrt(Math.sqrt(age)) * pow(fraction, 1 / 3)) / 1.45
      : (viscous * 1.06 * Math.sqrt(Math.sqrt(age - duration + duration * fourth(0.816 / 1.06)))) / 1.45;
  return Math.min(cap, spreading);
}

/** Integrated circular area since release, m²·s. Each active Fay radius is a power of time. */
export function fayAreaTime([inertial, viscous, surface]: FayCoefficients, age: number): number {
  if (inertial === 0 || viscous === 0) return ((2 * Math.PI) / 5) * surface * surface * age * age * Math.sqrt(age);
  const gravityCrossingRoot = viscous / inertial;
  const surfaceCrossingRoot = inertial / surface;
  const inertialUntil = Math.min(age, fourth(Math.min(gravityCrossingRoot, surfaceCrossingRoot)));
  const inertialScale = inertial * inertialUntil;
  let areaTime = 0.5 * inertialScale * inertialScale;
  let surfaceSince = inertialUntil;
  if (gravityCrossingRoot < surfaceCrossingRoot) {
    const viscousCrossingRoot = viscous / surface;
    surfaceSince = Math.min(age, viscousCrossingRoot * viscousCrossingRoot);
    areaTime +=
      (2 / 3) * viscous * viscous * (surfaceSince * Math.sqrt(surfaceSince) - inertialUntil * Math.sqrt(inertialUntil));
  }
  if (surfaceSince < age)
    areaTime +=
      (2 / 5) *
      surface *
      surface *
      (age * age * Math.sqrt(age) - surfaceSince * surfaceSince * Math.sqrt(surfaceSince));
  return Math.PI * areaTime;
}

function fourth(value: number): number {
  const square = value * value;
  return square * square;
}
