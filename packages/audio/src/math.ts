export type Vec3 = readonly [number, number, number];
export type DistanceModel = 'linear' | 'inverse' | 'exponential';

/**
 * Distance attenuation exactly as the Web Audio PannerNode applies it (spec section "Distance Effects").
 * Useful for UI meters and for tests that check rendered output against the selected model.
 */
export function distanceGain(model: DistanceModel, distance: number, refDistance = 1, maxDistance = 10000, rolloffFactor = 1): number {
  if (![distance, refDistance, maxDistance, rolloffFactor].every(Number.isFinite)) throw new RangeError('Distance parameters must be finite');
  if (model === 'linear') {
    const rolloff = Math.min(1, Math.max(0, rolloffFactor));
    const lo = Math.min(refDistance, maxDistance), hi = Math.max(refDistance, maxDistance);
    if (lo === hi) return 1 - rolloff;
    const d = Math.min(hi, Math.max(lo, distance));
    return 1 - rolloff * (d - refDistance) / (maxDistance - refDistance);
  }
  if (refDistance === 0) return 0;
  const d = Math.max(distance, refDistance);
  if (model === 'inverse') return refDistance / (refDistance + rolloffFactor * (d - refDistance));
  if (model === 'exponential') return Math.pow(d / refDistance, -rolloffFactor);
  throw new TypeError(`Unknown distance model ${String(model)}`);
}

/** Sound cone gain as the Web Audio PannerNode computes it, with angles in degrees. */
export function coneGain(source: Vec3, direction: Vec3, listener: Vec3, innerAngle = 360, outerAngle = 360, outerGain = 0): number {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!length || innerAngle === 360 && outerAngle === 360) return 1;
  const dx = listener[0] - source[0], dy = listener[1] - source[1], dz = listener[2] - source[2], distance = Math.hypot(dx, dy, dz);
  if (!distance) return 1;
  const cosine = (dx * direction[0] + dy * direction[1] + dz * direction[2]) / (distance * length);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
  const inner = Math.abs(innerAngle) / 2, outer = Math.abs(outerAngle) / 2;
  if (angle <= inner) return 1;
  if (angle >= outer) return outerGain;
  const x = (angle - inner) / (outer - inner);
  return (1 - x) + outerGain * x;
}

/** Normalizes `value`, returning `fallback` for a zero vector. */
export function normalize(x: number, y: number, z: number, out: number[] | Float64Array, fallback: Vec3 = [0, 0, -1]): boolean {
  const length = Math.hypot(x, y, z);
  if (!length || !Number.isFinite(length)) {out[0] = fallback[0]; out[1] = fallback[1]; out[2] = fallback[2]; return false;}
  out[0] = x / length; out[1] = y / length; out[2] = z / length; return true;
}

/**
 * Moves an AudioParam to `value`. With a positive time constant and a running context it eases there with
 * `setTargetAtTime`, which avoids zipper noise and clicks; otherwise (first write, suspended or offline context)
 * it sets the value at the current time so nothing sweeps in from the previous value.
 */
export function smoothParam(param: AudioParam, value: number, context: BaseAudioContext, timeConstant: number, immediate = false): void {
  if (!Number.isFinite(value)) throw new RangeError('Audio parameter value must be finite');
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  // Assigning .value applies at once and is reflected by the getter immediately, even before the audio thread
  // renders its next quantum (or when the output device is slow to start).
  if (immediate || timeConstant <= 0 || context.state !== 'running') {param.setValueAtTime(value, now); param.value = value;}
  else param.setTargetAtTime(value, now, timeConstant);
}
