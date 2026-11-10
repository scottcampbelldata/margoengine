import { normalizeQuaternion } from '@margoengine/math/quat';
import type { Interpolation } from './sampling.js';

/**
 * Blends keys `a` and `b` (b is a or a + 1) at `time`, with `ta` and `tb` their times, into `out` (width numbers).
 * `sampleTrackInto` and the player's cursor sampler both call it, so they give the same bits for the same key pair.
 */
export function interpolateKeys(
  values: Float32Array,
  width: number,
  a: number,
  b: number,
  ta: number,
  tb: number,
  time: number,
  interpolation: Interpolation,
  quaternion: boolean,
  out: Float32Array,
): Float32Array {
  const factor = interpolation === 'CUBICSPLINE' ? 3 : 1,
    span = tb - ta,
    t = span ? Math.max(0, Math.min(1, (time - ta) / span)) : 0;
  const ai = (a * factor + (factor === 3 ? 1 : 0)) * width,
    bi = (b * factor + (factor === 3 ? 1 : 0)) * width;
  if (interpolation === 'STEP' || a === b) for (let c = 0; c < width; c++) out[c] = values[ai + c];
  else if (interpolation === 'CUBICSPLINE') {
    const t2 = t * t,
      t3 = t2 * t;
    for (let c = 0; c < width; c++)
      out[c] =
        (2 * t3 - 3 * t2 + 1) * values[ai + c] +
        (t3 - 2 * t2 + t) * span * values[(a * 3 + 2) * width + c] +
        (-2 * t3 + 3 * t2) * values[bi + c] +
        (t3 - t2) * span * values[b * 3 * width + c];
  } else if (quaternion) {
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += values[ai + c] * values[bi + c];
    const sign = dot < 0 ? -1 : 1;
    dot = Math.abs(dot);
    let x = 1 - t,
      y = t;
    if (dot < 0.9995) {
      const angle = Math.acos(Math.min(1, dot)),
        s = Math.sin(angle);
      x = Math.sin((1 - t) * angle) / s;
      y = Math.sin(t * angle) / s;
    }
    for (let c = 0; c < 4; c++) out[c] = values[ai + c] * x + values[bi + c] * y * sign;
  } else for (let c = 0; c < width; c++) out[c] = values[ai + c] * (1 - t) + values[bi + c] * t;
  if (quaternion) {
    if (!(out[0] || out[1] || out[2] || out[3]))
      throw new RangeError('Zero animation quaternion; rotation keys must be non-zero quaternions');
    normalizeQuaternion(out, out);
  }
  for (let c = 0; c < width; c++)
    if (!Number.isFinite(out[c])) throw new RangeError('Animation sample overflow; use finite keyframe values');
  return out;
}

/** The track-invalid error `sampleTrackInto` throws, word for word. */
export const invalidTrack = (): TypeError =>
  new TypeError(
    'Invalid animation track; pass times and values arrays, an integer width >= 1, a finite time and STEP, LINEAR or CUBICSPLINE',
  );

/** A track the Animation constructor already checked (width, value count, increasing times), plus its last key. */
export interface CursorTrack {
  times: Float32Array;
  values: Float32Array;
  width: number;
  interpolation: Interpolation;
  /** The key found by the previous sample; 0 before the first. */
  cursor: number;
}

/**
 * Samples a checked track into `out` (width numbers) with the same bits as `sampleTrackInto`. Playing forward walks on
 * from the previous key (per-track sorted key cursors, as in ACL's notes on keyframe decompression), reading two or
 * three key times instead of a binary search; a seek back or a loop wrap searches as before.
 */
export function sampleCursor(track: CursorTrack, time: number, quaternion: boolean, out: Float32Array): Float32Array {
  const times = track.times,
    n = times.length;
  if (!n || !Number.isFinite(time)) throw invalidTrack();
  let a = track.cursor < n ? track.cursor : 0,
    ta = times[a],
    b = a,
    tb = ta;
  if (a === 0 || ta <= time) {
    // The last key at or before `time`, or key 0 when `time` is before every key (the binary search's answer).
    while (a + 1 < n) {
      const next = times[a + 1];
      if (next <= time) {
        a++;
        ta = next;
      } else {
        b = a + 1;
        tb = next;
        break;
      }
    }
    if (b < a) (b = a), (tb = ta);
  } else {
    let lo = 0,
      hi = n - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (times[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    a = lo;
    b = Math.min(a + 1, n - 1);
    ta = times[a];
    tb = times[b];
  }
  track.cursor = a;
  return interpolateKeys(track.values, track.width, a, b, ta, tb, time, track.interpolation, quaternion, out);
}
