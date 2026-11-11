// Percentiles for every benchmark and performance script: one rule, nearest rank, and no silent gaps.
//
// The p-th percentile of n samples is the sample at rank ceil(p / 100 * n) in ascending order: the smallest sample with
// at least p percent of the samples at or below it. It is always a measured sample, never an interpolated one. The
// median is the 50th percentile, so the median of an even count is the lower of the two middle samples. With fewer than
// 100 samples the 99th percentile is the largest sample, which is why the quiet speed phase takes 1000 (see
// docs/benchmarking.md, "Statistics").
//
// A sample set that is empty, holds a value that is not a finite number, or holds fewer or more samples than the run
// declared throws a RangeError, so a broken measurement fails its script instead of being reported as a number.
//
// No imports and no Node APIs: browser pages served from the repository root import this file too. collect-performance.js
// is pasted into a console and cannot import, so it carries a copy of nearestRank that tests/percentile.test.js keeps
// identical to this one.

/** The p-th percentile (0 < p <= 100) of `values` by nearest rank. Throws on an empty set or a non-finite sample. */
export function nearestRank(values, p) {
  if (!(p > 0 && p <= 100)) throw new RangeError(`Percentile ${p} is outside (0, 100]`);
  const n = values.length;
  if (!n) throw new RangeError('No samples: a measurement that produced nothing has no percentile');
  for (let i = 0; i < n; i++)
    if (typeof values[i] !== 'number' || !Number.isFinite(values[i]))
      throw new RangeError(`Sample ${i} is ${values[i]}, not a finite number`);
  const sorted = Array.from(values).sort((a, b) => a - b);
  // p * n / 100 is exact for whole p and n; the 1e-9 keeps a fractional p such as 99.9 from rounding up one rank.
  return sorted[Math.max(1, Math.ceil((p * n) / 100 - 1e-9)) - 1];
}

/**
 * Checks a sample set before any statistic is taken from it. `count` is the number of samples the run declared (it
 * must match exactly); `min` is the fewest it accepts. `label` names the set in the error. Returns `values`.
 */
export function checkSamples(values, { count, min = 1, label = 'samples' } = {}) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values))
    throw new RangeError(`${label}: expected an array of samples, got ${values === null ? 'null' : typeof values}`);
  if (count !== undefined && values.length !== count)
    throw new RangeError(`${label}: ${values.length} samples, but the run declared ${count}`);
  if (values.length < min) throw new RangeError(`${label}: ${values.length} samples, at least ${min} needed`);
  for (let i = 0; i < values.length; i++)
    if (typeof values[i] !== 'number' || !Number.isFinite(values[i]))
      throw new RangeError(`${label}: sample ${i} is ${values[i]}, not a finite number`);
  return values;
}

/** The p-th percentile of a checked sample set (see checkSamples for the options). */
export const percentile = (values, p, options) => nearestRank(checkSamples(values, options), p);

/** The nearest-rank median: the 50th percentile, the lower middle sample of an even count. */
export const median = (values, options) => percentile(values, 50, options);

/** Count, mean, min, nearest-rank median, p95 and p99, and max of a checked sample set. */
export function distribution(values, options) {
  checkSamples(values, options);
  let sum = 0,
    min = Infinity,
    max = -Infinity;
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    count: values.length,
    mean: sum / values.length,
    min,
    median: nearestRank(values, 50),
    p95: nearestRank(values, 95),
    p99: nearestRank(values, 99),
    max,
  };
}
