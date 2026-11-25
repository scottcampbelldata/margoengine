// The standard atmosphere (ISO 2533:1975 and ICAO Doc 7488, the same model): temperature, pressure and density of dry air
// by height, the shared default of the physics framework wherever air is not simulated (docs/physics-framework.md, K03).
// Heights are taken as given, in metres above sea level, without the geopotential correction (under 0.2 % in
// temperature below 11 km). The sea-level temperature and the tropopause height may be shifted for a warmer or colder day,
// the layers above keeping their lapse rates. It is computed with the pinned exp and pow (K01), so every engine gives the same
// bits and a simulation that reads it stays deterministic.
import { exp, pow } from './pinned.js';

/** Standard gravity, m/s^2 (3rd CGPM, 1901; ISO 80000-3). */
export const STANDARD_GRAVITY = 9.80665;
/** The gas constant of dry air the standard atmosphere uses, J/(kg K) (ICAO Doc 7488). */
export const DRY_AIR_GAS_CONSTANT = 287.05287;
/** Sea-level pressure, Pa. */
export const SEA_LEVEL_PRESSURE = 101325;
/** Sea-level temperature, K. */
export const SEA_LEVEL_TEMPERATURE = 288.15;

/**
 * The standard atmosphere at `z` metres: [temperature K, pressure Pa]. Layers: -6.5 K/km to the tropopause (11 km), then
 * isothermal for 9 km, +1 K/km to 32 km, +2.8 K/km to 47 km, isothermal above. `seaLevel` shifts the sea-level temperature
 * and `tropopause` its height.
 */
export function standardAtmosphere(z: number, seaLevel = SEA_LEVEL_TEMPERATURE, tropopause = 11000): [number, number] {
  // Below sea level (ISO 2533 tabulates to -2 km) the first layer's lapse continues downward.
  if (z < 0) {
    const T1 = seaLevel - 0.0065 * z;
    return [T1, SEA_LEVEL_PRESSURE * pow(T1 / seaLevel, STANDARD_GRAVITY / (0.0065 * DRY_AIR_GAS_CONSTANT))];
  }
  const layers: [number, number][] = [
    [tropopause, -0.0065],
    [tropopause + 9000, 0],
    [32000, 0.001],
    [47000, 0.0028],
    [Infinity, 0],
  ];
  let T = seaLevel,
    P = SEA_LEVEL_PRESSURE,
    base = 0;
  for (const [top, lapse] of layers) {
    const h = Math.min(Math.max(z, base), Math.max(top, base)) - base;
    const T1 = T + lapse * h;
    P =
      lapse === 0
        ? P * exp((-STANDARD_GRAVITY * h) / (DRY_AIR_GAS_CONSTANT * T))
        : P * pow(T1 / T, -STANDARD_GRAVITY / (lapse * DRY_AIR_GAS_CONSTANT));
    T = T1;
    if (z <= top) break;
    base = Math.max(top, base);
  }
  return [T, P];
}

/** Density of dry air, kg/m^3, at temperature `temperature` K and pressure `pressure` Pa (the ideal gas law). */
export function airDensity(temperature: number, pressure: number): number {
  return pressure / (DRY_AIR_GAS_CONSTANT * temperature);
}

/** Density of the standard atmosphere at `z` metres, kg/m^3: 1.225 at sea level. */
export function standardDensity(z: number, seaLevel = SEA_LEVEL_TEMPERATURE, tropopause = 11000): number {
  const [T, P] = standardAtmosphere(z, seaLevel, tropopause);
  return airDensity(T, P);
}
