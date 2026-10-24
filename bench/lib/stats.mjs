// Summary statistics for benchmark samples. One sample is one run's value (a run's own median for frame metrics).
// spread is the relative range (max - min) / |median|: with the default 5 runs it is the plainest noise measure, and a
// metric whose spread is over the noise threshold is noisy (a noisy primary metric makes the whole run invalid).

const round = (x, digits = 4) => (Number.isFinite(x) ? +x.toFixed(digits) : null);

/** Median, p95 (nearest rank), min, max, mean and spread of `samples` (non-finite values are dropped). */
export function summarize(samples) {
  const v = samples.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p95: null, min: null, max: null, mean: null, spread: null };
  const median = v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return {
    n: v.length,
    median: round(median),
    p95: round(v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)]),
    min: round(v[0]),
    max: round(v.at(-1)),
    mean: round(v.reduce((a, b) => a + b, 0) / v.length),
    spread: median ? round((v.at(-1) - v[0]) / Math.abs(median)) : 0,
  };
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
  intervals.sort((a, b) => a - b);
  return {
    mean: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
    p95: intervals[Math.ceil(intervals.length * 0.95) - 1],
    p99: intervals[Math.ceil(intervals.length * 0.99) - 1],
    duration: timestamps.at(-1) - timestamps[0],
  };
}
