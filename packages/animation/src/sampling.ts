import { normalizeQuaternion } from '@margoengine/math/quat';
/** How a keyframe track blends between keys, as in glTF 2.0: `STEP` holds the previous key, `LINEAR` interpolates (slerp for rotations), `CUBICSPLINE` uses in/out tangents (three values per key). */
export type Interpolation = 'STEP' | 'LINEAR' | 'CUBICSPLINE';
/**
 * Samples one keyframe track at `time` and returns the result (allocating `width` numbers unless `target` is given). Checks its arguments and throws on bad ones; use {@link sampleTrackInto} in a hot loop.
 *
 * `times` is increasing seconds; `values` holds `width` numbers per key (three times that for `CUBICSPLINE`). Set `quaternion` for rotation tracks so the result is normalised. Time outside the track clamps to the first or last key.
 *
 * @example
 * ```ts
 * const times = new Float32Array([0, 1]);
 * const values = new Float32Array([0, 0, 0, 10, 0, 0]);
 * sampleTrack(times, values, 3, 0.5, 'LINEAR'); // Float32Array [5, 0, 0]
 * ```
 */
export function sampleTrack(
  times: Float32Array,
  values: Float32Array,
  width: number,
  time: number,
  interpolation: Interpolation,
  quaternion = false,
  target?: Float32Array,
): Float32Array {
  if (
    target !== undefined &&
    (!(target instanceof Float32Array) ||
      target.length !== width ||
      target.buffer === times.buffer ||
      target.buffer === values.buffer)
  )
    throw new TypeError(
      'Invalid animation sample target; pass a Float32Array of the track width that does not share the times or values buffer',
    );
  return sampleTrackInto(times, values, width, time, interpolation, quaternion, target);
}
/** Same as {@link sampleTrack} without the argument checks on `times`, `values` and `target`: pass a preallocated `out` of `width` numbers to avoid allocating. Defaults: `quaternion` false. */
export function sampleTrackInto(
  times: Float32Array,
  values: Float32Array,
  width: number,
  time: number,
  interpolation: Interpolation,
  quaternion = false,
  out?: Float32Array,
): Float32Array {
  if (
    !times.length ||
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isFinite(time) ||
    (interpolation !== 'STEP' && interpolation !== 'LINEAR' && interpolation !== 'CUBICSPLINE')
  )
    throw new TypeError(
      'Invalid animation track; pass times and values arrays, an integer width >= 1, a finite time and STEP, LINEAR or CUBICSPLINE',
    );
  const factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
  if (values.length !== times.length * width * factor)
    throw new RangeError(
      'Animation output count mismatch; values needs times.length * width numbers (three times that for CUBICSPLINE)',
    );
  let lo = 0,
    hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  const a = lo,
    b = Math.min(a + 1, times.length - 1),
    span = times[b] - times[a],
    t = span ? Math.max(0, Math.min(1, (time - times[a]) / span)) : 0;
  out = out?.length === width && (!quaternion || width === 4) ? out : new Float32Array(width);
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
