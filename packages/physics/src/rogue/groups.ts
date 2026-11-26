// Runs of high waves (SEA-03, the "three sisters" of the Great Lakes): how often a high wave is followed by another, and
// three in a row, and where three such crests stand in a group, so a sea can be given them.
// - Successive heights as a Markov chain with the two-dimensional Rayleigh law of correlation parameter kappa (A. Kimura,
//   "Statistical properties of random wave groups", Proc. 17th ICCE, 1980, eqs. 5 to 19, read): p22 = P(H_2 >= H* | H_1 >=
//   H*), the mean run 1 / (1 - p22), runs of at least j waves p22^(j - 1); the next height given one is Rice's law with s =
//   kappa H_1 and sigma^2 = (1 - kappa^2) H_rms^2 / 2, so p22 is a one-dimensional integral of Marcum's Q.
// - kappa from the spectrum: |int S(f) exp(i 2 pi f tau) df| / m0 at tau = T_m02 (J. A. Battjes and G. Ph. van Vledder,
//   "Verification of Kimura's theory for wave group statistics", Proc. 19th ICCE, 1984, eqs. 4 and 5, read), or G. Ph. van
//   Vledder's corrected estimate of the successive heights' correlation ("Statistics of wave group parameters", Proc. 23rd
//   ICCE, 1992, eqs. 9.6 to 9.8, read), turned back into kappa through Kimura's eq. 7 with the complete elliptic integrals.
// - The group about a large crest: the autocovariance psi(T) = int S(f) cos(2 pi f T) df, its first positive maximum the
//   spacing of a group's crests at a point (Lindgren 1970 and Boccotti, as F. Fedele, "Stochastic wave groups in weakly
//   nonlinear random waves", 2008, restates them, read).
import { cos, exp, pow, sin } from '@margoengine/math/pinned';
import type { WaveSpectrumSample } from '@margoengine/math/fields';
import { bandWidth } from '../waves/spectral.js';

const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;

/** The frequency spectrum's moments and its autocovariance pieces, f in Hz. */
function frequencySpectrum(spectrum: WaveSpectrumSample): { fs: Float64Array; s: Float64Array; df: Float64Array } {
  const { frequencies: fs, directions: ds, energy } = spectrum,
    nf = fs.length,
    nd = ds.length,
    dtheta = TWO_PI / nd,
    s = new Float64Array(nf),
    df = new Float64Array(nf);
  for (let i = 0; i < nf; i++) {
    for (let j = 0; j < nd; j++) s[i]! += energy[i * nd + j]! * dtheta;
    df[i] = bandWidth(fs, i);
  }
  return { fs, s, df };
}

function moment(f: ReturnType<typeof frequencySpectrum>, n: number): number {
  let m = 0;
  for (let i = 0; i < f.fs.length; i++) {
    let p = 1;
    for (let k = 0; k < n; k++) p *= f.fs[i]!;
    m += p * f.s[i]! * f.df[i]!;
  }
  return m;
}

/** The normalised autocovariance's cosine and sine parts at lag tau, s. */
function lagged(f: ReturnType<typeof frequencySpectrum>, tau: number, m0: number): [number, number] {
  let c = 0,
    s = 0;
  for (let i = 0; i < f.fs.length; i++) {
    const v = f.s[i]! * f.df[i]!,
      a = TWO_PI * f.fs[i]! * tau;
    c += v * cos(a);
    s += v * sin(a);
  }
  return [c / m0, s / m0];
}

/** The complete elliptic integrals K and E of modulus k, by the arithmetic-geometric mean. */
function elliptic(k: number): [number, number] {
  let a = 1,
    b = Math.sqrt(1 - k * k),
    sum = (k * k) / 2,
    power = 0.5;
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-16; i++) {
    const c = (a - b) / 2,
      next = (a + b) / 2;
    b = Math.sqrt(a * b);
    a = next;
    power *= 2;
    sum += power * c * c;
  }
  const K = PI / (2 * a);
  return [K, K * (1 - sum)];
}

/** The correlation of successive wave heights for Kimura's kappa (his eq. 7): (E - (1 - k^2) K / 2 - pi / 4) / (1 - pi / 4). */
export function heightCorrelation(kappa: number): number {
  if (!(kappa >= 0 && kappa < 1)) throw new RangeError(`Kimura's kappa lies in [0, 1) (got ${kappa}); pass one.`);
  if (kappa === 0) return 0;
  const [K, E] = elliptic(kappa);
  return (E - 0.5 * (1 - kappa * kappa) * K - PI / 4) / (1 - PI / 4);
}

/** Kimura's kappa for a correlation of successive heights (the inverse of {@link heightCorrelation}, by bisection). */
export function kappaFor(correlation: number): number {
  if (!(correlation >= 0 && correlation < 1))
    throw new RangeError(`A height correlation lies in [0, 1) (got ${correlation}); pass one.`);
  let lo = 0,
    hi = 0.999999;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (heightCorrelation(mid) < correlation) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** e^-x I0(x), the exponentially scaled modified Bessel function of order 0. */
function besselI0Scaled(x: number): number {
  const ax = Math.abs(x);
  if (ax < 15) {
    // The power series sum (x^2 / 4)^k / (k!)^2, scaled.
    let term = 1,
      sum = 1;
    const q = (ax * ax) / 4;
    for (let k = 1; k < 200; k++) {
      term *= q / (k * k);
      sum += term;
      if (term < 1e-17 * sum) break;
    }
    return sum * exp(-ax);
  }
  // The asymptotic series 1 / sqrt(2 pi x) (1 + 1/(8x) + 9/(2 (8x)^2) + 225/(6 (8x)^3) + ...).
  let term = 1,
    sum = 1;
  for (let k = 1; k < 12; k++) {
    term *= ((2 * k - 1) * (2 * k - 1)) / (k * 8 * ax);
    sum += term;
  }
  return sum / Math.sqrt(TWO_PI * ax);
}

/** Marcum's Q1(a, b) = int_b^inf x exp(-(x^2 + a^2) / 2) I0(a x) dx, by Simpson's rule over [b, b + a + 12]. */
function marcum(a: number, b: number): number {
  const top = Math.max(b, a) + 12,
    n = 200,
    h = (top - b) / n;
  // Composite Simpson's rule over the scaled integrand.
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    const x = b + k * h,
      w = k === 0 || k === n ? 1 : k % 2 ? 4 : 2,
      d = x - a;
    sum += w * x * exp(-(d * d) / 2) * besselI0Scaled(a * x);
  }
  return (sum * h) / 3;
}

/** The statistics of runs of waves above a threshold. */
export interface RunStatistics {
  /** Kimura's kappa and the correlation of successive heights it gives. */
  kappa: number;
  correlation: number;
  /** The chance a wave passes the threshold, and that the next one does too given it did (p22). */
  exceedance: number;
  persistence: number;
  /** Mean run of high waves 1 / (1 - p22), in waves. */
  meanRun: number;
  /** Mean zero-crossing period, s, and waves an hour. */
  period: number;
  wavesPerHour: number;
  /** Runs of at least `j` waves above the threshold an hour, and j waves in a row (overlapping) an hour. */
  runsPerHour(j: number): number;
  inARowPerHour(j: number): number;
}

/**
 * Runs of high waves in a sea of spectrum `spectrum` above `threshold` (in H_s, default 1): Kimura's chain with kappa from the
 * spectrum (`method` 'spectral', Battjes and van Vledder 1984, the default; or 'corrected', van Vledder 1992, which removes the
 * spectral estimate's bias toward short groups), or a `kappa` given outright; `period` overrides T_m02.
 */
export function runStatistics(
  spectrum: WaveSpectrumSample,
  threshold = 1,
  options: { readonly method?: 'spectral' | 'corrected'; readonly kappa?: number; readonly period?: number } = {},
): RunStatistics {
  if (!(threshold > 0 && Number.isFinite(threshold)))
    throw new RangeError(`A threshold is a finite height in H_s above 0 (got ${threshold}); pass one, such as 1.5.`);
  const f = frequencySpectrum(spectrum),
    m0 = moment(f, 0),
    m1 = moment(f, 1),
    m2 = moment(f, 2);
  if (!(m0 > 0)) throw new RangeError('This spectrum carries no energy; pass a sea with waves.');
  const tz = options.period ?? Math.sqrt(m0 / m2);
  let kappa: number;
  if (options.kappa !== undefined) {
    if (!(options.kappa >= 0 && options.kappa < 0.999))
      throw new RangeError(`Kimura's kappa lies in [0, 0.999) (got ${options.kappa}); pass one.`);
    kappa = options.kappa;
  } else {
    const at = (tau: number) => {
      const [c, s] = lagged(f, tau, m0);
      return Math.min(0.999, Math.sqrt(c * c + s * s));
    };
    if (options.method === 'corrected') {
      const nu = Math.sqrt(Math.max(0, (m0 * m2) / (m1 * m1) - 1)),
        T = Math.sqrt(m0 / m2) * (1 - (nu * nu) / 2),
        rho = (tau: number) => heightCorrelation(at(tau)),
        correlation = (rho(T / 2) + 2 * rho(T) + rho((3 * T) / 2)) / (2 + 2 * rho(T / 2));
      kappa = kappaFor(Math.min(0.999, correlation));
    } else kappa = at(Math.sqrt(m0 / m2));
  }
  // Normalised to H_rms = sqrt(8 m0): H_s = sqrt 2 H_rms.
  const x = threshold * Math.SQRT2,
    q = exp(-x * x),
    sc = Math.sqrt((1 - kappa * kappa) / 2);
  let p22: number;
  if (kappa === 0) p22 = q;
  else {
    // p22 = (1 / q) int_x^inf 2 u e^(-u^2) Q1(kappa u / sc, x / sc) du, Simpson's rule to x + 7.
    const n = 200,
      h = 7 / n;
    let sum = 0;
    for (let k = 0; k <= n; k++) {
      const u = x + k * h,
        w = k === 0 || k === n ? 1 : k % 2 ? 4 : 2;
      sum += w * 2 * u * exp(-u * u) * marcum((kappa * u) / sc, x / sc);
    }
    p22 = Math.min(1, (sum * h) / 3 / q);
  }
  const waves = 3600 / tz;
  return {
    kappa,
    correlation: heightCorrelation(kappa),
    exceedance: q,
    persistence: p22,
    meanRun: 1 / (1 - p22),
    period: tz,
    wavesPerHour: waves,
    runsPerHour: (j: number) => waves * q * (1 - p22) * pow(p22, Math.max(1, j) - 1),
    inARowPerHour: (j: number) => waves * q * pow(p22, Math.max(1, j) - 1),
  };
}

/**
 * The spacing of a group's crests at a point, s: the first positive maximum of the autocovariance psi(T) = int S cos(2 pi f
 * T) df after its first minimum (the expected wave group about a large crest, Lindgren and Boccotti).
 */
export function groupSpacing(spectrum: WaveSpectrumSample): number {
  const f = frequencySpectrum(spectrum),
    m0 = moment(f, 0),
    m2 = moment(f, 2);
  if (!(m0 > 0)) throw new RangeError('This spectrum carries no energy; pass a sea with waves.');
  const tz = Math.sqrt(m0 / m2),
    step = tz / 400,
    psi = (t: number) => lagged(f, t, m0)[0];
  let t = step,
    prev = psi(0),
    now = psi(t),
    passedMinimum = false;
  for (let k = 0; k < 4000; k++) {
    const next = psi(t + step);
    if (!passedMinimum && now < prev && now <= next) passedMinimum = true;
    else if (passedMinimum && now > prev && now >= next) return t;
    prev = now;
    now = next;
    t += step;
  }
  return tz;
}

/**
 * Three sisters: three crests at one place, a group's crest spacing apart, for a {@link NonlinearSea}'s `rogues` (it stands
 * them together, each at its height). `crests` are their heights, m, first to last (one number for three equal), the first at
 * `time`; `spacing` defaults to {@link groupSpacing} of the sea.
 */
export function sisters(
  spectrum: WaveSpectrumSample,
  at: { readonly position: readonly [number, number]; readonly time: number },
  crests: number | readonly [number, number, number],
  spacing = groupSpacing(spectrum),
): { position: [number, number]; time: number; crest: number }[] {
  const heights = typeof crests === 'number' ? [crests, crests, crests] : crests;
  if (!(heights.length === 3 && heights.every((h) => h > 0 && Number.isFinite(h))))
    throw new RangeError('Three sisters are three crests in metres above 0 (or one for all three); pass them.');
  if (!(spacing > 0 && Number.isFinite(spacing)))
    throw new RangeError(
      `The sisters' spacing is finite seconds above 0 (got ${spacing}); pass one, or leave it to the sea.`,
    );
  if (!(at?.position?.length === 2 && [...at.position, at.time].every(Number.isFinite)))
    throw new RangeError('The sisters stand at {position: [x, z], time}; pass them.');
  return heights.map((crest, k) => ({
    position: [at.position[0], at.position[1]],
    time: at.time + k * spacing,
    crest,
  }));
}
