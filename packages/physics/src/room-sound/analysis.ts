import { MargoError } from '@margoengine/math/errors';

/**
 * Normalized Schroeder integration of a finite room impulse response. Values are squared pressure accumulated
 * backward in time, relative to the starting energy. A silent response stays zero.
 */
export function roomEnergyDecay(pressure: ArrayLike<number>): Float64Array {
  const length = pressure?.length;
  if (!Number.isSafeInteger(length) || length < 0)
    throw new MargoError('state', 'You must supply an array of finite pressure samples for the room energy decay.');
  let out: Float64Array;
  try {
    out = new Float64Array(length);
  } catch (cause) {
    throw Object.assign(new MargoError('state', 'Room energy decay exceeds available PCM memory. Use fewer samples.'), {
      cause,
    });
  }
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const value = pressure[i]!;
    if (!Number.isFinite(value))
      throw new MargoError('state', 'Provide finite pressure samples for the room energy decay.');
    peak = Math.max(peak, Math.abs(value));
  }
  if (!peak) return out;
  let total = 0;
  for (let i = length - 1; i >= 0; i--) {
    const sample = pressure[i]! / peak;
    total += sample * sample;
    out[i] = total;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}
