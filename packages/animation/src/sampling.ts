import { multiplyMatrices as multiply } from '@margoengine/math/mat4';
export type Interpolation = 'STEP' | 'LINEAR' | 'CUBICSPLINE';
export function sampleTrack(
  times: Float32Array,
  values: Float32Array,
  width: number,
  time: number,
  interpolation: Interpolation,
  quaternion = false,
): Float32Array {
  return sampleTrackInto(times, values, width, time, interpolation, quaternion);
}
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
    throw new TypeError('Invalid animation track');
  const factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
  if (values.length !== times.length * width * factor) throw new RangeError('Animation output count mismatch');
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
    const length = width === 4 ? Math.hypot(out[0], out[1], out[2], out[3]) : Math.hypot(...out);
    if (!length) throw new RangeError('Zero animation quaternion');
    for (let c = 0; c < 4; c++) out[c] /= length;
  }
  for (let c = 0; c < width; c++) if (!Number.isFinite(out[c])) throw new RangeError('Animation sample overflow');
  return out;
}
/** out = a * b (column-major); `@margoengine/math/mat4` multiplyMatrices with `out` first. */
export function multiplyMatrices(out: Float32Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  multiply(a, b, out);
}
