import { MargoError } from '@margoengine/math/errors';
import { exp } from '@margoengine/math/pinned';
import { oneMinusExp } from './ageing/processes.js';

/** Water-in-oil uptake for a finite surface slick, from separate oil weathering measurements. */
export interface TracerOilEmulsification {
  /** Maximum water volume fraction of the mixture, in [0, 1). */
  maximumWaterFraction: number;
  /** Field half time in seconds at 10 m/s wind. */
  halfTimeAt10: number;
  /** Water-free dynamic viscosity in Pa·s, held constant. */
  oilViscosity: number;
  /** Minimum oil-only film thickness for water uptake, in metres. Default zero. */
  minimumOilThickness?: number;
}

/** Current emulsion properties, with water separate from the released oil ledger. */
export interface TracerOilEmulsion {
  /** Water volume fraction, in [0, 1]. */
  waterFraction: number;
  /** Water entrained in the surface oil, in kilograms. */
  waterMass: number;
  /** Bulk mixture density, in kg/m³. */
  density: number;
  /** Dynamic viscosity of the emulsion, in Pa·s. */
  viscosity: number;
}

export function emulsionParameters(
  options: TracerOilEmulsification,
  initialOilVolume: number,
  waterDensity: number,
): Required<TracerOilEmulsification> {
  const { maximumWaterFraction, halfTimeAt10, oilViscosity, minimumOilThickness = 0 } = options;
  const maxWaterVolume = (initialOilVolume * maximumWaterFraction) / (1 - maximumWaterFraction);
  if (
    !(maximumWaterFraction >= 0 && maximumWaterFraction < 1 && halfTimeAt10 > 0 && oilViscosity > 0) ||
    !(minimumOilThickness >= 0) ||
    ![halfTimeAt10, oilViscosity, minimumOilThickness, maxWaterVolume * waterDensity].every(Number.isFinite) ||
    !Number.isFinite(emulsionViscosity(oilViscosity, 1))
  )
    throw new MargoError(
      'unsupported',
      'Oil emulsification is outside range; use finite physical values, a water fraction from zero to less than one, and positive half time and viscosity.',
    );
  return { maximumWaterFraction, halfTimeAt10, oilViscosity, minimumOilThickness };
}

export function emulsionWindFactor(speed: number): number {
  const normalized = (1 + speed) / 11;
  const factor = normalized * normalized;
  if (!Number.isFinite(factor))
    throw new MargoError(
      'unsupported',
      'Oil emulsification wind is outside range; supply finite physical wind velocity.',
    );
  return factor;
}

export function emulsionWaterVolume(
  config: Required<TracerOilEmulsification>,
  oilVolume: number,
  waterVolume: number,
  exposure: number,
): number {
  if (!(oilVolume > 0)) return 0;
  // SINTEF OWM, Eqs. 21–23. Advance the water fraction with the wind-dependent exponential.
  const blend = oneMinusExp((Math.LN2 * exposure) / config.halfTimeAt10);
  const fullVolume = oilVolume + waterVolume;
  const oilShare = (oilVolume / fullVolume) * (1 - blend) + (1 - config.maximumWaterFraction) * blend;
  const waterShare = (waterVolume / fullVolume) * (1 - blend) + config.maximumWaterFraction * blend;
  return (oilVolume * waterShare) / oilShare;
}

function emulsionViscosity(oilViscosity: number, waterFraction: number): number {
  // Mackay et al. EE-8 §4.4, Mooney's viscosity law with K1 = 0.654 for salt water.
  return oilViscosity * exp((2.5 * waterFraction) / (1 - 0.654 * waterFraction));
}

export function emulsionProperties(
  oilMass: number,
  oilDensity: number,
  waterVolume: number,
  waterDensity: number,
  oilViscosity: number,
): TracerOilEmulsion {
  const volume = oilMass / oilDensity + waterVolume;
  const waterFraction = waterVolume / volume;
  const waterMass = waterVolume * waterDensity;
  return {
    waterFraction,
    waterMass,
    density: oilDensity * (1 - waterFraction) + waterDensity * waterFraction,
    viscosity: emulsionViscosity(oilViscosity, waterFraction),
  };
}
