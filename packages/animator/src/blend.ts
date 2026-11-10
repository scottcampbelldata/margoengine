import type { BlendTree } from './index.js';
/**
 * Weights for a 1D blend tree: the two samples around `value` share the weight linearly, and a value outside the
 * range clamps to the nearest end sample.
 * @param samples Strictly increasing, finite sample positions.
 * @param value The blend parameter, finite.
 * @returns One weight per sample; they sum to 1.
 * @throws RangeError when the samples are empty, not strictly increasing or not finite.
 * @example
 * blend1D([0, 1, 3], 2); // Float32Array [0, 0.5, 0.5]
 */
export function blend1D(samples: readonly number[], value: number): Float32Array {
  if (
    !samples.length ||
    !Number.isFinite(value) ||
    samples.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= samples[i - 1]))
  )
    throw new RangeError(
      'Invalid 1D blend samples; pass finite sample values in strictly increasing order and a finite blend value',
    );
  const weights = new Float32Array(samples.length);
  if (value <= samples[0]) {
    weights[0] = 1;
    return weights;
  }
  if (value >= samples.at(-1)!) {
    weights[weights.length - 1] = 1;
    return weights;
  }
  const high = samples.findIndex((v) => v >= value),
    low = high - 1,
    t = (value - samples[low]) / (samples[high] - samples[low]);
  weights[low] = 1 - t;
  weights[high] = t;
  return weights;
}
/**
 * Weights for a 2D blend tree: normalised inverse-square distance to every sample, so a point exactly on a sample
 * reproduces that sample alone.
 * @param samples Unique, finite `[x, y]` positions.
 * @param x The first blend parameter, finite.
 * @param y The second blend parameter, finite.
 * @returns One weight per sample; they sum to 1.
 * @throws RangeError when the samples are empty, duplicated or not finite.
 * @example
 * blend2D([[0, 0], [1, 0]], 0, 0); // Float32Array [1, 0]
 */
export function blend2D(samples: readonly (readonly [number, number])[], x: number, y: number): Float32Array {
  if (
    !samples.length ||
    ![x, y].every(Number.isFinite) ||
    samples.some((v) => v.length !== 2 || v.some((n) => !Number.isFinite(n))) ||
    new Set(samples.map((v) => v.join(','))).size !== samples.length
  )
    throw new RangeError('Invalid 2D blend samples; pass finite [x, y] pairs without duplicates and a finite x and y');
  const weights = new Float32Array(samples.length),
    distances = samples.map((v) => Math.hypot(v[0] - x, v[1] - y)),
    nearest = Math.min(...distances),
    exact = distances.indexOf(0);
  if (exact !== -1) {
    weights[exact] = 1;
    return weights;
  }
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    weights[i] = (nearest / distances[i]) ** 2;
    sum += weights[i];
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return weights;
}
/** The clips a state plays and their weights at `parameters`. */
export function treeWeights(
  tree: BlendTree,
  parameters: Readonly<Record<string, number>>,
): { clips: string[]; weights: ArrayLike<number> } {
  if (typeof tree === 'string') return { clips: [tree], weights: [1] };
  const clips = tree.samples.map((sample) => sample.clip);
  if ('weights' in tree) {
    const weights = tree.weights(parameters);
    if (weights.length !== clips.length || Array.from(weights).some((w) => !Number.isFinite(w) || w < 0))
      throw new RangeError('Compiled tree needs one finite nonnegative weight per clip; correct the weight evaluator');
    return { clips, weights };
  }
  if ('parameter' in tree)
    return {
      clips,
      weights: blend1D(
        tree.samples.map((sample) => sample.value),
        parameters[tree.parameter] ?? 0,
      ),
    };
  return {
    clips,
    weights: blend2D(
      tree.samples.map((sample) => sample.value),
      parameters[tree.parameters[0]] ?? 0,
      parameters[tree.parameters[1]] ?? 0,
    ),
  };
}
/** Writes into `out` when given (it may be `a`); otherwise returns a fresh array. */
export function quaternionBlend(a: ArrayLike<number>, b: ArrayLike<number>, weight: number, out?: number[]): number[] {
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a[i] * b[i];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  let x = 1 - weight,
    y = weight;
  if (dot < 0.9995) {
    const angle = Math.acos(dot),
      s = Math.sin(angle);
    x = Math.sin((1 - weight) * angle) / s;
    y = Math.sin(weight * angle) / s;
  }
  const q0 = a[0] * x + b[0] * y * sign,
    q1 = a[1] * x + b[1] * y * sign,
    q2 = a[2] * x + b[2] * y * sign,
    q3 = a[3] * x + b[3] * y * sign,
    length = Math.hypot(q0, q1, q2, q3);
  if (!length)
    throw new RangeError(
      'Zero blend quaternion; the two rotations cancel out, so use unit quaternions and a weight away from the exact opposite pose',
    );
  if (!out) return [q0 / length, q1 / length, q2 / length, q3 / length];
  out[0] = q0 / length;
  out[1] = q1 / length;
  out[2] = q2 / length;
  out[3] = q3 / length;
  return out;
}
