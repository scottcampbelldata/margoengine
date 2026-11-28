// Liquid water properties for the hydraulics entry (HYDRO-07), from published correlations:
// - density: G. S. Kell, "Density, thermal expansivity, and compressibility of liquid water from 0 to 150 °C",
//   J. Chem. Eng. Data 20(1), 97-105 (1975), the density and isothermal-compressibility fits, 0 to 150 °C;
// - viscosity: J. Kestin, M. Sokolov and W. A. Wakeham, "Viscosity of liquid water in the range -8 °C to 150 °C",
//   J. Phys. Chem. Ref. Data 7(3), 941-948 (1978), https://srd.nist.gov/jpcrdreprint/1.555581.pdf, the cubic
//   correlation relative to 1.0016 mPa s at 20 °C;
// - vapour pressure: A. L. Buck, "New equations for computing vapor pressure and enhancement factor",
//   J. Appl. Meteorol. 20, 1527-1532 (1981), the over-water equation.
// Every transcendental goes through @margoengine/math/pinned, so the same temperature gives the same bits everywhere.
import { DEFAULT_GRAVITY } from '@margoengine/math/gravity';
import { exp, pow } from '@margoengine/math/pinned';

/** The engine's gravity magnitude in m/s² (9.81, `DEFAULT_GRAVITY`), the default of every function here. */
export const GRAVITY = -DEFAULT_GRAVITY[1];
/** Standard sea-level atmospheric pressure in Pa (ISO 2533). */
export const ATMOSPHERE = 101325;
/** ln 10, for base-10 logarithms through the pinned natural log. */
export const LN10 = 2.302585092994046;

/** Physical properties of a liquid, in SI units. */
export interface Liquid {
  /** Mass density, kg/m³. */
  readonly density: number;
  /** Dynamic viscosity, Pa s. */
  readonly dynamicViscosity: number;
  /** Kinematic viscosity, m²/s. */
  readonly kinematicViscosity: number;
  /** Saturated vapour pressure, Pa absolute. */
  readonly vaporPressure: number;
  /** Isothermal bulk modulus, Pa. */
  readonly bulkModulus: number;
}

/** Liquid water at a temperature, with the temperature it was evaluated at. */
export interface Water extends Liquid {
  /** Temperature, °C. */
  readonly temperature: number;
}

function checkTemperature(celsius: number): void {
  if (!Number.isFinite(celsius) || celsius < 0 || celsius > 100)
    throw new RangeError(`Water temperature ${celsius} °C is outside 0 to 100 °C; pass a liquid water temperature.`);
}

/** Density of air-free liquid water at one atmosphere, kg/m³ (Kell 1975). 998.21 at 20 °C. */
export function waterDensity(celsius = 20): number {
  checkTemperature(celsius);
  const t = celsius;
  return (
    (999.83952 +
      t * (16.945176 + t * (-7.9870401e-3 + t * (-46.170461e-6 + t * (105.56302e-9 + t * -280.54253e-12))))) /
    (1 + 16.87985e-3 * t)
  );
}

/**
 * Dynamic viscosity of liquid water, Pa s (Kestin, Sokolov and Wakeham 1978):
 * log₁₀(μ/μ₂₀) = (20 - t)/(96 + t) [1.2378 - 1.303e-3 (20 - t) + 3.06e-6 (20 - t)² + 2.55e-8 (20 - t)³], μ₂₀ = 1.0016 mPa s.
 * 1.0016e-3 at 20 °C, 0.6525e-3 at 40 °C, 0.2818e-3 at 100 °C.
 */
export function waterViscosity(celsius = 20): number {
  checkTemperature(celsius);
  const d = 20 - celsius;
  const log10Ratio = (d / (celsius + 96)) * (1.2378 + d * (-1.303e-3 + d * (3.06e-6 + d * 2.55e-8)));
  return 1.0016e-3 * exp(log10Ratio * LN10);
}

/** Saturated vapour pressure of water, Pa absolute (Buck 1981). 2338 Pa at 20 °C, 101.3 kPa at 100 °C. */
export function waterVaporPressure(celsius = 20): number {
  checkTemperature(celsius);
  const t = celsius;
  return 611.21 * exp((18.678 - t / 234.5) * (t / (257.14 + t)));
}

/** Isothermal bulk modulus of water, Pa (the inverse of Kell's 1975 compressibility fit). 2.18 GPa at 20 °C. */
export function waterBulkModulus(celsius = 20): number {
  checkTemperature(celsius);
  const t = celsius;
  const kappa =
    (50.88496 + t * (0.6163813 + t * (1.459187e-3 + t * (20.08438e-9 + t * (-58.47727e-12 + t * 410.411e-15))))) /
    (1 + 19.67348e-3 * t);
  return 1e11 / kappa;
}

/** Every property of liquid water at `celsius` (default 20 °C), from the correlations above. */
export function water(celsius = 20): Water {
  const density = waterDensity(celsius),
    dynamicViscosity = waterViscosity(celsius);
  return Object.freeze({
    temperature: celsius,
    density,
    dynamicViscosity,
    kinematicViscosity: dynamicViscosity / density,
    vaporPressure: waterVaporPressure(celsius),
    bulkModulus: waterBulkModulus(celsius),
  });
}

/** Water at 20 °C, the default liquid of every function in this entry. */
export const WATER: Water = water(20);

/** Argument checks shared by the hydraulics modules. */
export function positive(name: string, value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`${name} must be a positive finite number; got ${value}.`);
  return value;
}

export function nonNegative(name: string, value: number): number {
  if (!(value >= 0) || !Number.isFinite(value))
    throw new RangeError(`${name} must be zero or a positive finite number; got ${value}.`);
  return value;
}

export function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number; got ${value}.`);
  return value;
}

/** Circle area from a diameter. */
export const circleArea = (diameter: number): number => 0.25 * Math.PI * diameter * diameter;

/** The real cube root, through the pinned pow. */
export const cbrt = (x: number): number => (x === 0 ? 0 : x < 0 ? -pow(-x, 1 / 3) : pow(x, 1 / 3));
