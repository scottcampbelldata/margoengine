/**
 * Normalized Schroeder integration of a finite room impulse response. Values are squared pressure accumulated
 * backward in time, relative to the starting energy. A silent response stays zero.
 */
export function roomEnergyDecay(pressure: ArrayLike<number>): Float64Array {
  const out = new Float64Array(pressure.length);
  let peak = 0;
  for (let i = 0; i < pressure.length; i++) {
    const value = pressure[i]!;
    if (!Number.isFinite(value)) throw new RangeError('Provide finite pressure samples for the room energy decay.');
    peak = Math.max(peak, Math.abs(value));
  }
  if (!peak) return out;
  let total = 0;
  for (let i = pressure.length - 1; i >= 0; i--) {
    const sample = pressure[i]! / peak;
    total += sample * sample;
    out[i] = total;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}
