// Clean room: Silverman 1986, Cleveland 1979, Carr et al. 1987, NIST statistical handbook.
import { rangeError } from '../../shared/errors.js';
/** Owned xy coordinates in data units. */
export type StatisticalPoint = readonly [number, number];
const fail = (s: string): never => {
  throw Object.assign(rangeError(s, 'sciviz'), { code: 'out-of-range' });
};
function samples(input: ArrayLike<number>, minimum = 1): number[] {
  if (input.length > 100000) fail('Statistical charts support at most 100000 samples per series');
  const a = Array.from(input).filter((v) => !Number.isNaN(v));
  if (a.length < minimum || a.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e100))
    fail(`Supply at least ${minimum} finite samples up to magnitude 1e100; NaN denotes missing`);
  return a;
}
function pairs(x: ArrayLike<number>, y: ArrayLike<number>, minimum = 1): StatisticalPoint[] {
  if (x.length !== y.length || x.length > 100000) fail('Statistical x and y arrays need matching lengths up to 100000');
  const p = Array.from(x, (v, i) => [v, y[i]] as const).filter((p) => !p.some(Number.isNaN));
  if (p.length < minimum || p.some((p) => p.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e100)))
    fail(`Supply at least ${minimum} finite xy pairs; NaN denotes a missing pair`);
  return p;
}
const q = (sorted: number[], p: number) => {
  const h = (sorted.length - 1) * p,
    i = Math.floor(h);
  return sorted[i] + (h - i) * ((sorted[i + 1] ?? sorted[i]) - sorted[i]);
};
const mean = (a: number[]) => a.reduce((s, v) => s + v / a.length, 0);
const deviation = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
};

/** Interpolated quartiles and Tukey 1.5-IQR adjacent-value whiskers, with owned outlier values. */
export interface BoxSummary {
  readonly count: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly lower: number;
  readonly upper: number;
  readonly outliers: readonly number[];
}
/** NaNs are ignored; whisker multiplier defaults to 1.5, including constant/singleton series. */
export function boxSummary(values: ArrayLike<number>, whisker = 1.5): BoxSummary {
  if (!(whisker >= 0) || !Number.isFinite(whisker)) fail('Box whisker multiplier must be finite and nonnegative');
  const a = samples(values).sort((a, b) => a - b),
    q1 = q(a, 0.25),
    median = q(a, 0.5),
    q3 = q(a, 0.75),
    span = whisker * (q3 - q1);
  const inside = a.filter((v) => v >= q1 - span && v <= q3 + span);
  return {
    count: a.length,
    q1,
    median,
    q3,
    lower: inside[0],
    upper: inside.at(-1)!,
    outliers: a.filter((v) => v < q1 - span || v > q3 + span),
  };
}
/** Silverman's robust Gaussian bandwidth, with a finite unit-relative bandwidth for zero spread. */
export function silvermanBandwidth(values: ArrayLike<number>): number {
  const a = samples(values).sort((a, b) => a - b),
    sd = deviation(a),
    iqr = (q(a, 0.75) - q(a, 0.25)) / 1.34;
  const scale = Math.min(sd, iqr) || sd || Math.max(1, Math.abs(a[0])) * 0.01;
  return 0.9 * scale * a.length ** -0.2;
}
/** Gaussian kernel density with optional positive bandwidth; at most 4000000 sample/query pairs. */
export function kernelDensity(
  values: ArrayLike<number>,
  at: ArrayLike<number>,
  bandwidth?: number,
): StatisticalPoint[] {
  const a = samples(values),
    positions = samples(at),
    h = bandwidth ?? silvermanBandwidth(a);
  if (!(h > 0) || !Number.isFinite(h) || a.length * positions.length > 4000000)
    fail('Supply a positive bandwidth and at most 4000000 KDE sample/query pairs');
  return positions.map((x) => [
    x,
    a.reduce((s, v) => s + Math.exp(-0.5 * ((x - v) / h) ** 2), 0) / (a.length * h * Math.sqrt(2 * Math.PI)),
  ]);
}
/** Two-dimensional Gaussian KDE on a rectilinear query grid, x fastest; independently scaled bandwidths. */
export function density2D(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  gridX: ArrayLike<number>,
  gridY: ArrayLike<number>,
  bandwidth?: readonly [number, number],
): Float64Array {
  const p = pairs(x, y),
    gx = samples(gridX),
    gy = samples(gridY),
    [hx, hy] = bandwidth ?? [silvermanBandwidth(p.map((p) => p[0])), silvermanBandwidth(p.map((p) => p[1]))];
  if (![hx, hy].every((v) => v > 0 && Number.isFinite(v)) || p.length * gx.length * gy.length > 4000000)
    fail('2D KDE requires positive bandwidths and at most 4000000 sample/query pairs');
  return Float64Array.from(
    gy.flatMap((y) =>
      gx.map(
        (x) =>
          p.reduce((s, v) => s + Math.exp(-0.5 * (((x - v[0]) / hx) ** 2 + ((y - v[1]) / hy) ** 2)), 0) /
          (p.length * hx * hy * 2 * Math.PI),
      ),
    ),
  );
}
/** Pointy-top hexagonal bin, with original input indices and count. */
export interface StatisticalHexbin {
  readonly center: StatisticalPoint;
  readonly vertices: readonly StatisticalPoint[];
  readonly indices: readonly number[];
  readonly count: number;
}
/** Cube-coordinate nearest-hex assignment. Radius is in data units and must be positive. */
export function hexbin2D(x: ArrayLike<number>, y: ArrayLike<number>, radius: number): StatisticalHexbin[] {
  pairs(x, y);
  if (!(radius > 0) || !Number.isFinite(radius)) fail('Hexbin radius must be positive and finite');
  const bins = new Map<string, { q: number; r: number; indices: number[] }>();
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i]) || Number.isNaN(y[i])) continue;
    const q = ((Math.sqrt(3) / 3) * x[i] - y[i] / 3) / radius,
      r = (2 * y[i]) / (3 * radius),
      s = -q - r;
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) > 1e12)
      fail('Hexbin coordinates/radius must fit within 1e12 hex cells; rescale units');
    let a = Math.round(q),
      b = Math.round(r);
    const c = Math.round(s),
      da = Math.abs(a - q),
      db = Math.abs(b - r),
      dc = Math.abs(c - s);
    if (da > db && da > dc) a = -b - c;
    else if (db > dc) b = -a - c;
    const key = `${a},${b}`,
      bin = bins.get(key) ?? { q: a, r: b, indices: [] };
    bin.indices.push(i);
    bins.set(key, bin);
  }
  return [...bins.values()].map((b) => {
    const cx = radius * Math.sqrt(3) * (b.q + b.r / 2),
      cy = radius * 1.5 * b.r;
    return {
      center: [cx, cy],
      vertices: Array.from(
        { length: 6 },
        (_, i) =>
          [
            cx + radius * Math.cos(((i * 60 - 30) * Math.PI) / 180),
            cy + radius * Math.sin(((i * 60 - 30) * Math.PI) / 180),
          ] as const,
      ),
      indices: b.indices,
      count: b.indices.length,
    };
  });
}
/** Right-continuous empirical CDF, one point per distinct finite value. */
export function empiricalCDF(values: ArrayLike<number>): StatisticalPoint[] {
  const a = samples(values).sort((a, b) => a - b);
  return a.flatMap((v, i) => (i === a.length - 1 || v !== a[i + 1] ? [[v, (i + 1) / a.length] as const] : []));
}
/** Two-sample Q-Q pairs at common midpoint probabilities, interpolating each sample's order statistics. */
export function quantilePairs(
  values: ArrayLike<number>,
  reference: ArrayLike<number>,
  count?: number,
): StatisticalPoint[] {
  const a = samples(values).sort((a, b) => a - b),
    b = samples(reference).sort((a, b) => a - b),
    n = count ?? Math.max(a.length, b.length);
  if (!Number.isInteger(n) || n < 1 || n > 100000) fail('Q-Q count must be an integer from 1 to 100000');
  return Array.from({ length: n }, (_, i) => [q(b, (i + 0.5) / n), q(a, (i + 0.5) / n)]);
}
/** Step interpolation; pre/post/mid mean the jump occurs before/after/between successive samples. */
export function stepSeries(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  mode: 'pre' | 'post' | 'mid' = 'post',
): StatisticalPoint[] {
  pairs(x, y);
  const p = Array.from(x, (v, i) => [v, y[i]] as const);
  if (!['pre', 'post', 'mid'].includes(mode)) fail('Step mode must be pre, post or mid');
  return p.flatMap((v, i) =>
    v.some(Number.isNaN)
      ? [[NaN, NaN] as const]
      : i === 0 || p[i - 1].some(Number.isNaN)
        ? [v]
        : mode === 'pre'
          ? [[p[i - 1][0], v[1]] as const, v]
          : mode === 'post'
            ? [[v[0], p[i - 1][1]] as const, v]
            : [[(p[i - 1][0] + v[0]) / 2, p[i - 1][1]] as const, [(p[i - 1][0] + v[0]) / 2, v[1]] as const, v],
  );
}
/** A stack band has lower/upper values per column; positive and negative accumulators are separate. */
export interface StatisticalStack {
  readonly lower: Float64Array;
  readonly upper: Float64Array;
}
/** Stack series with matching lengths. NaN contributes zero; normalize divides each sign's stack to unit magnitude. */
export function stackSeries(series: readonly ArrayLike<number>[], normalize = false): StatisticalStack[] {
  if (!series.length || series.some((s) => s.length !== series[0].length) || series.length * series[0].length > 1000000)
    fail('Stacks need matching lengths and at most 1000000 total values');
  const n = series[0].length,
    pos = new Float64Array(n),
    neg = new Float64Array(n),
    positive = new Float64Array(n),
    negative = new Float64Array(n);
  const values = series.map((s) => Array.from(s, (v) => (Number.isNaN(v) ? 0 : v)));
  for (const s of values)
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(s[i]) || Math.abs(s[i]) > 1e100) fail('Stack values must be finite up to 1e100 or NaN');
      if (s[i] >= 0) positive[i] += s[i];
      else negative[i] -= s[i];
    }
  return values.map((s) => {
    const lower = new Float64Array(n),
      upper = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = normalize ? s[i] / ((s[i] >= 0 ? positive[i] : negative[i]) || 1) : s[i],
        a = v >= 0 ? pos : neg;
      lower[i] = a[i];
      upper[i] = a[i] += v;
    }
    return { lower, upper };
  });
}
/** Asymmetric x/y error amounts, default absent. Every supplied amount must be finite and nonnegative. */
export interface StatisticalErrors {
  readonly xMinus?: ArrayLike<number>;
  readonly xPlus?: ArrayLike<number>;
  readonly yMinus?: ArrayLike<number>;
  readonly yPlus?: ArrayLike<number>;
}
/** Error segments without caps; omitted plus arrays use the corresponding minus array symmetrically. */
export function errorBarSegments(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  errors: StatisticalErrors,
): readonly (readonly [StatisticalPoint, StatisticalPoint])[] {
  pairs(x, y);
  for (const a of [errors.xMinus, errors.xPlus, errors.yMinus, errors.yPlus])
    if (a && (a.length !== x.length || Array.from(a).some((v) => !Number.isFinite(v) || v < 0)))
      fail('Error arrays need one finite nonnegative amount per observation');
  const out: [StatisticalPoint, StatisticalPoint][] = [];
  for (let i = 0; i < x.length; i++)
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      if (errors.xMinus || errors.xPlus)
        out.push([
          [x[i] - (errors.xMinus?.[i] ?? errors.xPlus![i]), y[i]],
          [x[i] + (errors.xPlus?.[i] ?? errors.xMinus![i]), y[i]],
        ]);
      if (errors.yMinus || errors.yPlus)
        out.push([
          [x[i], y[i] - (errors.yMinus?.[i] ?? errors.yPlus![i])],
          [x[i], y[i] + (errors.yPlus?.[i] ?? errors.yMinus![i])],
        ]);
    }
  return out;
}

// Stirling's asymptotic log-gamma after recurrence to x>=16; Bernoulli terms through x^-9.
function logGamma(x: number): number {
  let shift = 0;
  while (x < 16) {
    shift -= Math.log(x);
    x++;
  }
  const z = 1 / x;
  return (
    shift +
    (x - 0.5) * Math.log(x) -
    x +
    0.5 * Math.log(2 * Math.PI) +
    z / 12 -
    z ** 3 / 360 +
    z ** 5 / 1260 -
    z ** 7 / 1680 +
    z ** 9 / 1188
  );
}
/** Positive Student-t mean-band critical value, confidence 0.95 by default; fractional residual df is supported. */
export function studentTCritical(df: number, confidence = 0.95): number {
  if (!(confidence > 0 && confidence <= 0.999) || !Number.isFinite(confidence))
    fail('Trend confidence must be positive and at most 0.999');
  if (!(df > 0 && df <= 100000) || !Number.isFinite(df))
    fail('Student-t degrees of freedom must be positive and at most 100000');
  // NIST DLMF 8.17.22: alternating continued-fraction coefficients, evaluated with scaled ratios.
  const fraction = (a: number, b: number, x: number) => {
    const safe = (v: number) => (Math.abs(v) < 1e-300 ? (v < 0 ? -1e-300 : 1e-300) : v);
    let c = 1,
      d = 1 / safe(1 - ((a + b) * x) / (a + 1)),
      h = d;
    for (let m = 1; m <= 2048; m++) {
      const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
      d = 1 / safe(1 + even * d);
      c = safe(1 + even / c);
      h *= d * c;
      const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
      d = 1 / safe(1 + odd * d);
      c = safe(1 + odd / c);
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) <= 4 * Number.EPSILON) return h;
    }
    return fail('Student-t continued fraction did not converge; increase residual degrees of freedom');
  };
  const beta = (x: number, a: number, b: number): number => {
    if (x === 0) return 0;
    if (x === 1) return 1;
    const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
    return x < (a + 1) / (a + b + 2) ? (factor * fraction(a, b, x)) / a : 1 - (factor * fraction(b, a, 1 - x)) / b;
  };
  const tail = (t: number) => 0.5 * beta(df / (df + t * t), df / 2, 0.5),
    target = (1 - confidence) / 2;
  let lo = 0,
    hi = 1;
  while (tail(hi) > target) {
    hi *= 2;
    if (hi > 1e150) fail('Student-t critical value exceeds 1e150; increase residual degrees of freedom');
  }
  for (let i = 0; i < 56; i++) {
    const m = (lo + hi) / 2;
    if (tail(m) > target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
/** Fitted mean and pointwise confidence limits, not observation prediction limits. */
export interface StatisticalTrendPoint {
  readonly x: number;
  readonly y: number;
  readonly lower: number;
  readonly upper: number;
}
/** OLS slope/intercept and pointwise Student-t confidence bands; confidence defaults to 0.95. */
export function linearTrend(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  options: { readonly at?: ArrayLike<number>; readonly confidence?: number } = {},
): {
  readonly slope: number;
  readonly intercept: number;
  readonly points: readonly StatisticalTrendPoint[];
  readonly residualVariance: number;
} {
  const p = pairs(x, y, 3),
    xs = p.map((p) => p[0]),
    ys = p.map((p) => p[1]),
    mx = mean(xs),
    my = mean(ys),
    xx = xs.reduce((s, v) => s + (v - mx) ** 2, 0);
  if (!(xx > 0)) fail('Linear trend needs distinct x values');
  const slope = p.reduce((s, v) => s + (v[0] - mx) * (v[1] - my), 0) / xx,
    intercept = my - slope * mx,
    variance = p.reduce((s, v) => s + (v[1] - (my + slope * (v[0] - mx))) ** 2, 0) / (p.length - 2),
    t = studentTCritical(p.length - 2, options.confidence ?? 0.95);
  const positions = options.at ? samples(options.at) : [...xs].sort((a, b) => a - b);
  return {
    slope,
    intercept,
    residualVariance: variance,
    points: positions.map((x) => {
      const y = my + slope * (x - mx),
        d = t * Math.sqrt(variance * (1 / p.length + (x - mx) ** 2 / xx));
      return { x, y, lower: y - d, upper: y + d };
    }),
  };
}
/** Local-linear LOWESS with tricube distance and optional bisquare robustness iterations (default 2), span 0.5. */
export function loessTrend(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  options: {
    readonly at?: ArrayLike<number>;
    readonly span?: number;
    readonly iterations?: number;
    readonly confidence?: number;
  } = {},
): StatisticalTrendPoint[] {
  const p = pairs(x, y, 3).sort((a, b) => a[0] - b[0]),
    n = p.length,
    span = options.span ?? 0.5,
    iterations = options.iterations ?? 2;
  if (!(span > 0 && span <= 1) || !Number.isInteger(iterations) || iterations < 0 || iterations > 10)
    fail('LOESS span must be in (0,1], iterations an integer from 0 to 10');
  const at = options.at ? samples(options.at) : p.map((v) => v[0]);
  if (n * (n * (iterations + 1) + at.length) > 4000000)
    fail('LOESS supports at most 4000000 fit/sample pairs; reduce samples, evaluation count or iterations');
  const robust = new Float64Array(n).fill(1),
    k = Math.min(n, Math.max(3, Math.ceil(span * n)));
  const fit = (x: number) => {
    const distances = p.map((v) => Math.abs(v[0] - x)),
      h = [...distances].sort((a, b) => a - b)[k - 1];
    const w = distances.map((d, i) => (h === 0 ? (d === 0 ? 1 : 0) : (1 - Math.min(1, d / h) ** 3) ** 3) * robust[i]);
    const sum = w.reduce((a, v) => a + v, 0);
    if (!(sum > 0)) fail('LOESS has no positive local weight; increase span or reduce robust iterations');
    const mx = p.reduce((s, v, i) => s + w[i] * (v[0] - x), 0) / sum,
      my = p.reduce((s, v, i) => s + w[i] * v[1], 0) / sum;
    const xx = p.reduce((s, v, i) => s + w[i] * (v[0] - x - mx) ** 2, 0),
      slope = xx ? p.reduce((s, v, i) => s + w[i] * (v[0] - x - mx) * (v[1] - my), 0) / xx : 0;
    const coefficients = w.map((v, i) => v * (1 / sum - (xx ? (mx * (p[i][0] - x - mx)) / xx : 0)));
    return { y: my - slope * mx, coefficients };
  };
  for (let r = 0; r < iterations; r++) {
    const residuals = p.map((v) => Math.abs(v[1] - fit(v[0]).y)),
      median = q(
        [...residuals].sort((a, b) => a - b),
        0.5,
      );
    if (median === 0) break;
    residuals.forEach((v, i) => {
      const u = v / (6 * median);
      robust[i] = u < 1 ? (1 - u * u) ** 2 : 0;
    });
  }
  const fitted = p.map((v) => fit(v[0]));
  let trace = 0,
    square = 0,
    rss = 0;
  fitted.forEach((f, i) => {
    trace += f.coefficients[i];
    square += f.coefficients.reduce((s, v) => s + v * v, 0);
    rss += (p[i][1] - f.y) ** 2;
  });
  const df = n - 2 * trace + square;
  if (!(df > 0)) fail('LOESS confidence needs positive residual degrees of freedom; increase span');
  const variance = rss / df,
    t = studentTCritical(df, options.confidence ?? 0.95);
  return at.map((x) => {
    const f = fit(x),
      d = t * Math.sqrt(variance * f.coefficients.reduce((s, v) => s + v * v, 0));
    return { x, y: f.y, lower: f.y - d, upper: f.y + d };
  });
}
