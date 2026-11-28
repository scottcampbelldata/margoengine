import { exp, hypot, ln, pow } from '@margoengine/math/pinned';
import { soundError } from './errors.js';

/** Octave-band centres in Hz, ordered from bass to treble. */
export const OUTDOOR_SOUND_BANDS = Object.freeze([63, 125, 250, 500, 1000, 2000, 4000, 8000] as const);

const LN_10 = ln(10);
const STANDARD_PRESSURE = 101325;
const STANDARD_TEMPERATURE = 293.15;

/** Atmospheric absorption of a pure tone in dB/m (ISO 9613-1 equations 3–5 and B.1). */
export function outdoorAirAbsorption(
  frequency: number,
  temperature = STANDARD_TEMPERATURE,
  relativeHumidity = 0.5,
  pressure = STANDARD_PRESSURE,
): number {
  if (
    !(frequency >= 0 && Number.isFinite(frequency)) ||
    !(temperature > 0 && Number.isFinite(temperature)) ||
    !(relativeHumidity >= 0 && relativeHumidity <= 1) ||
    !(pressure > 0 && Number.isFinite(pressure))
  )
    throw soundError(
      'unsupported',
      'Invalid air absorption inputs; pass Hz, positive kelvins and pascals, and humidity from 0 to 1.',
    );
  const tr = temperature / STANDARD_TEMPERATURE;
  const pr = pressure / STANDARD_PRESSURE;
  const saturation = pow(10, -6.8346 * pow(273.16 / temperature, 1.261) + 4.6151);
  const h = (100 * relativeHumidity * saturation) / pr;
  const oxygen = pr * (24 + (40400 * h * (0.02 + h)) / (0.391 + h));
  const nitrogen = pr * pow(tr, -0.5) * (9 + 280 * h * exp(-4.17 * (pow(tr, -1 / 3) - 1)));
  const square = frequency * frequency;
  const relaxation =
    (0.01275 * exp(-2239.1 / temperature) * oxygen) / (oxygen * oxygen + square) +
    (0.1068 * exp(-3352 / temperature) * nitrogen) / (nitrogen * nitrogen + square);
  const loss = 8.686 * square * ((1.84e-11 * pow(tr, 0.5)) / pr + pow(tr, -2.5) * relaxation);
  if (!(loss >= 0 && Number.isFinite(loss)))
    throw soundError(
      'failed',
      'The ISO air loss is unrepresentable. Use terrestrial temperature and pressure, or reduce frequency.',
    );
  return loss;
}

/** Fresnel–Kirchhoff single-edge attenuation, in dB (P.526-16, equation 31). */
export function outdoorDiffractionLoss(fresnelNumber: number): number {
  if (!Number.isFinite(fresnelNumber))
    throw soundError(
      'unsupported',
      'Fresnel clearance must be finite; pass the signed clearance scaled by the Fresnel radius.',
    );
  if (fresnelNumber <= -0.78) return 0;
  const v = fresnelNumber - 0.1;
  const sum = hypot(v, 1) + v;
  // Beyond the range of the squared norm, its relative correction to v is below floating precision.
  const log = Number.isFinite(sum) ? ln(sum) : ln(v) + ln(2);
  return Math.max(0, 6.9 + (20 * log) / LN_10);
}

/** A prescribed far-field aviation N-wave, sampled as signed acoustic pressure. */
export function aviationNWave(secondsSinceArrival: number, duration: number, peak: number, rise = 0.002): number {
  if (
    !Number.isFinite(secondsSinceArrival) ||
    !(duration > 0 && Number.isFinite(duration)) ||
    !(peak >= 0 && Number.isFinite(peak)) ||
    !(rise >= 0 && rise < duration / 2)
  )
    throw soundError(
      'unsupported',
      'Invalid aviation N-wave; pass finite time, positive duration, nonnegative peak and a rise below half its duration.',
    );
  if (secondsSinceArrival < 0 || secondsSinceArrival >= duration) return 0;
  if (secondsSinceArrival < rise) return peak * (secondsSinceArrival / rise);
  if (secondsSinceArrival > duration - rise) return (peak * (secondsSinceArrival - duration)) / rise;
  return peak * (1 - (2 * (secondsSinceArrival - rise)) / (duration - 2 * rise));
}
