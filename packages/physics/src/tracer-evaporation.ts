import { MargoError } from '@margoengine/math/errors';
import { exp, ln } from '@margoengine/math/pinned';
import { type FayCoefficients, fayAreaTime } from './tracer-fay.js';

/** Stiver–Mackay evaporative exposure for one oil's modified distillation curve. */
export interface TracerOilEvaporation {
  /** Slick temperature in kelvin. Held constant over the release. */
  temperature: number;
  /** Initial boiling point of the modified distillation curve, in kelvin. */
  initialBoilingPoint: number;
  /** Gradient of that curve in kelvin per unit distilled volume fraction. */
  distillationSlope: number;
  /** Air-side mass-transfer coefficient in m/s. Use 0 for no transfer. */
  massTransferCoefficient: number;
  /** Initial oil volume divided by a prescribed fixed exposure area, in metres. Defaults to the evolving Fay area. */
  referenceThickness?: number;
}

export interface EvaporationRates {
  growth: number;
  slowdown: number;
  fixedArea: boolean;
}

export function evaporationRates(options: TracerOilEvaporation, initialVolume: number): EvaporationRates {
  const { temperature, initialBoilingPoint, distillationSlope, massTransferCoefficient, referenceThickness } = options;
  if (
    !(temperature > 0 && initialBoilingPoint > 0 && distillationSlope >= 0 && massTransferCoefficient >= 0) ||
    ![temperature, initialBoilingPoint, distillationSlope, massTransferCoefficient].every(Number.isFinite)
  )
    throw new MargoError(
      'unsupported',
      'Oil evaporation parameters are outside range; use positive kelvin temperatures and finite nonnegative slope and transfer.',
    );
  if (referenceThickness !== undefined && !(referenceThickness > 0 && Number.isFinite(referenceThickness)))
    throw new MargoError(
      'unsupported',
      'Oil exposure thickness is outside range; use a positive finite referenceThickness.',
    );
  // Stiver and Mackay, EE-49, Eqs. 3 and 13. At fixed area, the area/volume ratio is 1/referenceThickness.
  const growth =
    (massTransferCoefficient / (referenceThickness ?? initialVolume)) *
    exp(6.3 - 10.3 * (initialBoilingPoint / temperature));
  const slowdown = 10.3 * (distillationSlope / temperature);
  if (!(Number.isFinite(growth) && Number.isFinite(slowdown)))
    throw new MargoError(
      'unsupported',
      'Oil exposure coefficients exceed numeric range; use a physical volume, distillation curve and transfer coefficient.',
    );
  return { growth, slowdown, fixedArea: referenceThickness !== undefined };
}

export function evaporatedFraction(rates: EvaporationRates, radius: FayCoefficients, age: number): number {
  if (rates.growth === 0) return 0;
  const exposure = rates.growth * (rates.fixedArea ? age : fayAreaTime(radius, age));
  if (rates.slowdown === 0) return Math.min(1, exposure);
  const argument = rates.slowdown * exposure;
  if (!Number.isFinite(argument)) return Math.min(1, (ln(rates.slowdown) + ln(exposure)) / rates.slowdown);
  const sum = 1 + argument;
  // Correct for rounding in 1+argument so the earliest release ages retain their small mass losses.
  const fraction = sum === 1 ? exposure : (ln(sum) / (sum - 1)) * exposure;
  return Math.min(1, fraction);
}
