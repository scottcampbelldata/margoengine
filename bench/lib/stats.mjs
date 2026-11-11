// Summary statistics for benchmark samples. One sample is one run's value (a run's own median for frame metrics).
// spread is the relative range (max - min) / |median|: with the default 5 runs it is the plainest noise measure, and a
// metric whose spread is over the noise threshold is noisy (a noisy primary metric makes the whole run invalid).

import { distribution, percentile } from '../../scripts/lib/percentile.mjs';

const round = (x, digits = 4) => (Number.isFinite(x) ? +x.toFixed(digits) : null);

/**
 * Nearest-rank median and p95, min, max, mean and spread of `samples` (scripts/lib/percentile.mjs). An empty set gives
 * the all-null summary; a NaN or other non-finite sample throws, so a failed run is never dropped from the summary.
 */
export function summarize(samples) {
  if (!samples.length) return { n: 0, median: null, p95: null, min: null, max: null, mean: null, spread: null };
  const { count, median, p95, min, max, mean } = distribution(samples);
  return {
    n: count,
    median: round(median),
    p95: round(p95),
    min: round(min),
    max: round(max),
    mean: round(mean),
    spread: median ? round((max - min) / Math.abs(median)) : 0,
  };
}

/**
 * The metrics some runs measured and others did not, or measured as NaN: each is an error, never a summary of the runs
 * that happened to work. `runs` is the declared run count. A metric no run measured is absent, not partial.
 */
export function partialMetrics(names, samples, runs) {
  return names.filter(
    (m) => samples[m]?.some(Number.isFinite) && (samples[m].length !== runs || !samples[m].every(Number.isFinite)),
  );
}

/**
 * The metric record kept in a result: its definition, raw samples and summary. `noise` is the relative spread over
 * which the metric counts as noisy; exact metrics (sizes, counts) never are.
 */
export function metricRecord(definition, samples, noise) {
  const summary = summarize(samples),
    exact = definition.exact === true;
  return {
    unit: definition.unit ?? '',
    better: definition.better ?? 'lower',
    primary: definition.primary === true,
    ...(exact ? { exact } : {}),
    ...(definition.threshold !== undefined ? { threshold: definition.threshold } : {}),
    samples: samples.map((x) => round(x)),
    ...summary,
    noisy: !exact && summary.n > 1 && summary.spread > noise,
  };
}

/**
 * Relative change from `before` to `after` for a metric, signed so that positive is worse. Returns null when either
 * side is missing or the baseline is zero.
 */
export function worsening(before, after, better) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return null;
  const change = (after - before) / Math.abs(before);
  return better === 'higher' ? -change : change;
}

/** Frame intervals from rAF timestamps: mean, p95, p99 and total duration (ms). Throws on a decreasing timestamp. */
export function frameIntervals(timestamps) {
  if (!(timestamps.length > 1)) throw new RangeError('frameIntervals needs two or more timestamps');
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    const value = timestamps[i] - timestamps[i - 1];
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid frame timestamp: pass increasing times');
    intervals.push(value);
  }
  return {
    mean: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
    p95: percentile(intervals, 95),
    p99: percentile(intervals, 99),
    duration: timestamps.at(-1) - timestamps[0],
  };
}
