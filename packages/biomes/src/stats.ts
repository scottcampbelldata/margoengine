// Point-pattern and distribution statistics for checking placement against its target processes (goal G7). These are
// measurements, not decisions, so they use floats. Sources: K, L, G, F, J and the pair correlation function with
// border and translation edge corrections (Diggle 2013; Illian, Penttinen, Stoyan and Stoyan 2008); global envelope
// tests, the studentised maximum deviation and the extreme rank length (Myllymaki, Mrkvicka, Grabarnik, Seijo and
// Hahn 2017); the Kolmogorov distribution (Kolmogorov 1933); the Anderson-Darling statistic (Anderson and Darling 1954)
// with the asymptotic distribution of Marsaglia and Marsaglia 2004; quantile regression (Koenker and Bassett 1978).
import { rangeError, typeError } from '../../shared/errors.js';

/** A window `[minX, minZ, maxX, maxZ]` and the points inside it, as x and z arrays. */
export interface Pattern {
  readonly x: ArrayLike<number>;
  readonly z: ArrayLike<number>;
  readonly window: readonly [number, number, number, number];
}

/** Points bucketed on a grid of `cell` for neighbour searches. */
function buckets(p: Pattern, cell: number) {
  const [x0, z0, x1, z1] = p.window,
    nx = Math.max(1, Math.ceil((x1 - x0) / cell)),
    nz = Math.max(1, Math.ceil((z1 - z0) / cell)),
    heads = new Int32Array(nx * nz).fill(-1),
    next = new Int32Array(p.x.length);
  for (let i = 0; i < p.x.length; i++) {
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((p.x[i] - x0) / cell))),
      cz = Math.min(nz - 1, Math.max(0, Math.floor((p.z[i] - z0) / cell))),
      c = cz * nx + cx;
    next[i] = heads[c];
    heads[c] = i;
  }
  /** Calls `visit(j, d2)` for every point j within `r` of (x, z). */
  return (x: number, z: number, r: number, visit: (j: number, d2: number) => void) => {
    const a0 = Math.max(0, Math.floor((x - r - x0) / cell)),
      a1 = Math.min(nx - 1, Math.floor((x + r - x0) / cell)),
      b0 = Math.max(0, Math.floor((z - r - z0) / cell)),
      b1 = Math.min(nz - 1, Math.floor((z + r - z0) / cell));
    for (let b = b0; b <= b1; b++)
      for (let a = a0; a <= a1; a++)
        for (let j = heads[b * nx + a]; j >= 0; j = next[j]) {
          const dx = p.x[j] - x,
            dz = p.z[j] - z,
            d2 = dx * dx + dz * dz;
          if (d2 <= r * r) visit(j, d2);
        }
  };
}

function check(p: Pattern, radii: ArrayLike<number>): void {
  if (!p || p.x?.length !== p.z?.length || !Array.isArray(p.window) || p.window.length !== 4)
    throw typeError('A pattern is { x, z, window: [minX, minZ, maxX, maxZ] } with x and z of equal length', 'biomes');
  if (!radii?.length || ![...Array.from(radii)].every((r) => r >= 0))
    throw rangeError('Statistic radii must be 0 or more', 'biomes');
}

const area = (w: Pattern['window']) => (w[2] - w[0]) * (w[3] - w[1]);
const border = (w: Pattern['window'], x: number, z: number) => Math.min(x - w[0], w[2] - x, z - w[1], w[3] - z);

/**
 * Ripley's K with the border correction: for each r, the mean number of further points within r of the points at least
 * r from the window edge, over the intensity.
 */
export function kFunction(p: Pattern, radii: ArrayLike<number>): Float64Array {
  check(p, radii);
  const n = p.x.length,
    lambda = n / area(p.window),
    rmax = Math.max(...Array.from(radii)),
    near = buckets(p, Math.max(rmax, 1e-9)),
    out = new Float64Array(radii.length);
  radii = Array.from(radii);
  for (let q = 0; q < radii.length; q++) {
    const r = radii[q];
    let count = 0,
      used = 0;
    for (let i = 0; i < n; i++) {
      if (border(p.window, p.x[i], p.z[i]) < r) continue;
      used++;
      near(p.x[i], p.z[i], r, (j) => {
        if (j !== i) count++;
      });
    }
    out[q] = used && lambda ? count / used / lambda : 0;
  }
  return out;
}

/** Besag's L, centred: sqrt(K / pi) - r (0 for complete spatial randomness). */
export function lFunction(p: Pattern, radii: ArrayLike<number>): Float64Array {
  const k = kFunction(p, radii);
  return k.map((v, q) => Math.sqrt(v / Math.PI) - radii[q]);
}

/**
 * The pair correlation function g(r), Epanechnikov kernel of half width `bandwidth`, translation edge correction for a
 * rectangle (1 for complete spatial randomness).
 */
export function pairCorrelation(p: Pattern, radii: ArrayLike<number>, bandwidth: number): Float64Array {
  check(p, radii);
  if (!(bandwidth > 0)) throw rangeError('pairCorrelation bandwidth must be above 0', 'biomes');
  const [x0, z0, x1, z1] = p.window,
    wx = x1 - x0,
    wz = z1 - z0,
    n = p.x.length,
    rmax = Math.max(...Array.from(radii)) + bandwidth,
    near = buckets(p, rmax),
    out = new Float64Array(radii.length),
    lambda2 = (n * (n - 1)) / (wx * wz) ** 2;
  for (let i = 0; i < n; i++)
    near(p.x[i], p.z[i], rmax, (j, d2) => {
      if (j === i) return;
      const d = Math.sqrt(d2),
        weight = (wx * wz) / ((wx - Math.abs(p.x[j] - p.x[i])) * (wz - Math.abs(p.z[j] - p.z[i])));
      for (let q = 0; q < radii.length; q++) {
        const t = (radii[q] - d) / bandwidth;
        if (t > -1 && t < 1) out[q] += (0.75 / bandwidth) * (1 - t * t) * weight;
      }
    });
  for (let q = 0; q < radii.length; q++)
    out[q] = radii[q] > 0 && lambda2 ? out[q] / (2 * Math.PI * radii[q] * lambda2 * wx * wz) : 0;
  return out;
}

/** Nearest-neighbour distance distribution G(r), border corrected. */
export function nearestG(p: Pattern, radii: ArrayLike<number>): Float64Array {
  check(p, radii);
  const rmax = Math.max(...Array.from(radii)),
    near = buckets(p, Math.max(rmax, 1e-9)),
    n = p.x.length,
    nn = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++)
    near(p.x[i], p.z[i], rmax, (j, d2) => {
      if (j !== i) nn[i] = Math.min(nn[i], Math.sqrt(d2));
    });
  return Float64Array.from(radii, (r) => {
    let used = 0,
      hit = 0;
    for (let i = 0; i < n; i++)
      if (border(p.window, p.x[i], p.z[i]) >= r) {
        used++;
        if (nn[i] <= r) hit++;
      }
    return used ? hit / used : 0;
  });
}

/** Empty-space function F(r) on a `grid` x `grid` lattice of test points, border corrected. */
export function emptyF(p: Pattern, radii: ArrayLike<number>, grid = 64): Float64Array {
  check(p, radii);
  const [x0, z0, x1, z1] = p.window,
    rmax = Math.max(...Array.from(radii)),
    near = buckets(p, Math.max(rmax, 1e-9)),
    d: number[] = [],
    b: number[] = [];
  for (let j = 0; j < grid; j++)
    for (let i = 0; i < grid; i++) {
      const x = x0 + ((i + 0.5) * (x1 - x0)) / grid,
        z = z0 + ((j + 0.5) * (z1 - z0)) / grid;
      let best = Infinity;
      near(x, z, rmax, (_, d2) => {
        best = Math.min(best, Math.sqrt(d2));
      });
      d.push(best);
      b.push(border(p.window, x, z));
    }
  return Float64Array.from(radii, (r) => {
    let used = 0,
      hit = 0;
    for (let k = 0; k < d.length; k++)
      if (b[k] >= r) {
        used++;
        if (d[k] <= r) hit++;
      }
    return used ? hit / used : 0;
  });
}

/** Van Lieshout and Baddeley's J(r) = (1 - G) / (1 - F): 1 for randomness, above for regular, below for clustered. */
export function jFunction(p: Pattern, radii: ArrayLike<number>, grid = 64): Float64Array {
  const g = nearestG(p, radii),
    f = emptyF(p, radii, grid);
  return g.map((v, q) => (f[q] < 1 ? (1 - v) / (1 - f[q]) : Number.NaN));
}

/** The result of a global envelope test. */
export interface EnvelopeTest {
  /** p-value of the observed curve among the simulations (the observed curve counts as one of them). */
  readonly p: number;
  /** Lower and upper global envelope at level alpha. */
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  /** The observed curve leaves the envelope somewhere. */
  readonly reject: boolean;
}

/**
 * A global envelope test of an observed summary curve against curves of simulations of the target process
 * (Myllymaki et al. 2017): `'mad'` is the studentised maximum absolute deviation (199 simulations suffice at alpha
 * 0.05), `'rank'` the extreme rank length ordering (use 2,499 or more). Points where every simulation agrees are
 * skipped.
 */
export function globalEnvelope(
  observed: ArrayLike<number>,
  simulations: readonly ArrayLike<number>[],
  options: { readonly type?: 'mad' | 'rank'; readonly alpha?: number } = {},
): EnvelopeTest {
  const type = options.type ?? 'mad',
    alpha = options.alpha ?? 0.05,
    s = simulations.length,
    m = observed.length;
  if (s < 19 || !simulations.every((c) => c.length === m))
    throw rangeError('globalEnvelope needs 19 or more simulated curves as long as the observed one', 'biomes');
  if (!(alpha > 0 && alpha < 1)) throw rangeError('globalEnvelope alpha must be in 0..1', 'biomes');
  const all = [observed, ...simulations],
    mean = new Float64Array(m),
    sd = new Float64Array(m),
    lo = new Float64Array(m),
    hi = new Float64Array(m);
  for (let r = 0; r < m; r++) {
    let sum = 0;
    for (const c of simulations) sum += c[r];
    mean[r] = sum / s;
    let v = 0;
    for (const c of simulations) v += (c[r] - mean[r]) ** 2;
    sd[r] = Math.sqrt(v / (s - 1));
  }
  if (type === 'mad') {
    const u = all.map((c) => {
        let worst = 0;
        for (let r = 0; r < m; r++) if (sd[r] > 0) worst = Math.max(worst, Math.abs(c[r] - mean[r]) / sd[r]);
        return worst;
      }),
      sims = u.slice(1).sort((a, b) => b - a),
      k = Math.max(1, Math.floor(alpha * (s + 1))),
      crit = sims[k - 1];
    for (let r = 0; r < m; r++) {
      lo[r] = mean[r] - crit * sd[r];
      hi[r] = mean[r] + crit * sd[r];
    }
    const p = (1 + sims.filter((v) => v >= u[0]).length) / (s + 1);
    return { p, lo, hi, reject: u[0] > crit };
  }
  if (type !== 'rank') throw rangeError("globalEnvelope type is 'mad' or 'rank'", 'biomes');
  // Pointwise two-sided extreme ranks, then each curve's ranks sorted ascending (its extreme rank length vector).
  const n = s + 1,
    ranks = all.map(() => new Int32Array(m));
  for (let r = 0; r < m; r++) {
    const order = all.map((c, i) => [c[r], i] as const).sort((a, b) => a[0] - b[0]);
    for (let q = 0; q < n; q++) {
      // Ties share the most extreme rank of their run.
      let a = q;
      while (a > 0 && order[a - 1][0] === order[q][0]) a--;
      let b = q;
      while (b < n - 1 && order[b + 1][0] === order[q][0]) b++;
      ranks[order[q][1]][r] = Math.min(a + 1, n - b);
    }
  }
  for (const v of ranks) v.sort();
  const compare = (a: Int32Array, b: Int32Array) => {
    for (let r = 0; r < m; r++) if (a[r] !== b[r]) return a[r] - b[r];
    return 0;
  };
  const extreme = ranks.filter((v) => compare(v, ranks[0]) <= 0).length,
    p = extreme / n;
  // Envelope: the range of the simulations that are not among the alpha most extreme.
  const keep = ranks
    .map((v, i) => [v, i] as const)
    .slice(1)
    .sort((a, b) => compare(a[0], b[0]))
    .slice(Math.floor(alpha * n))
    .map(([, i]) => all[i]);
  for (let r = 0; r < m; r++) {
    lo[r] = Math.min(...keep.map((c) => c[r]));
    hi[r] = Math.max(...keep.map((c) => c[r]));
  }
  return { p, lo, hi, reject: p <= alpha };
}

/** Kolmogorov's distribution: P(sqrt(n) D > t), the asymptotic tail. */
function kolmogorov(t: number): number {
  if (t <= 0) return 1;
  let sum = 0;
  for (let k = 1; k < 100; k++) {
    const term = 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * t * t);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return Math.min(1, Math.max(0, sum));
}

/** Kolmogorov-Smirnov test of samples against a continuous CDF: the statistic D and its asymptotic p-value. */
export function ksTest(samples: ArrayLike<number>, cdf: (x: number) => number): { d: number; p: number } {
  const x = Float64Array.from(samples).sort(),
    n = x.length;
  if (n < 8) throw rangeError('ksTest needs 8 or more samples', 'biomes');
  let d = 0;
  for (let i = 0; i < n; i++) {
    const f = cdf(x[i]);
    d = Math.max(d, (i + 1) / n - f, f - i / n);
  }
  // Stephens' finite-sample adjustment of the argument.
  return { d, p: kolmogorov((Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d) };
}

/** Anderson-Darling test of samples against a continuous CDF: A^2 and its asymptotic p-value. */
export function andersonDarling(samples: ArrayLike<number>, cdf: (x: number) => number): { a2: number; p: number } {
  const x = Float64Array.from(samples).sort(),
    n = x.length;
  if (n < 8) throw rangeError('andersonDarling needs 8 or more samples', 'biomes');
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.min(1 - 1e-12, Math.max(1e-12, cdf(x[i]))),
      b = Math.min(1 - 1e-12, Math.max(1e-12, cdf(x[n - 1 - i])));
    s += (2 * i + 1) * (Math.log(a) + Math.log(1 - b));
  }
  const a2 = -n - s / n,
    z = a2;
  // Marsaglia and Marsaglia 2004: the limiting distribution P(A^2 < z).
  const below =
    z <= 0
      ? 0
      : z < 2
        ? (Math.exp(-1.2337141 / z) / Math.sqrt(z)) *
          (2.00012 + (0.247105 - (0.0649821 - (0.0347962 - (0.011672 - 0.00168691 * z) * z) * z) * z) * z)
        : Math.exp(-Math.exp(1.0776 - (2.30695 - (0.43424 - (0.082433 - (0.008056 - 0.0003146 * z) * z) * z) * z) * z));
  return { a2, p: 1 - below };
}

/**
 * Linear quantile regression of y on x at quantile `tau` (0.95 for an upper frontier): the line through two of the
 * points that minimises the check loss (an optimum always passes through two points). For up to a few hundred points.
 */
export function quantileFit(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  tau: number,
): { slope: number; intercept: number } {
  const n = x.length;
  if (n < 3 || y.length !== n) throw rangeError('quantileFit needs 3 or more (x, y) pairs', 'biomes');
  if (!(tau > 0 && tau < 1)) throw rangeError('quantileFit tau must be in 0..1', 'biomes');
  let best = Infinity,
    slope = 0,
    intercept = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (x[i] === x[j]) continue;
      const b = (y[j] - y[i]) / (x[j] - x[i]),
        a = y[i] - b * x[i];
      let loss = 0;
      for (let k = 0; k < n && loss < best; k++) {
        const e = y[k] - a - b * x[k];
        loss += e >= 0 ? tau * e : (tau - 1) * e;
      }
      if (loss < best) [best, slope, intercept] = [loss, b, a];
    }
  return { slope, intercept };
}
