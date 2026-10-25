// Chart geometry, CPU only: histogram bins (the Freedman-Diaconis rule, D. Freedman and P. Diaconis, "On the
// histogram as a density estimator: L2 theory", Z. Wahrscheinlichkeitstheorie verw. Gebiete 57, 1981; Sturges' rule,
// H. A. Sturges, JASA 21(153), 1926, when the spread is zero) and the rectangles of bar charts, histograms and heatmaps
// as [x0, y0, x1, y1] per rectangle in data units.
import { rangeError, typeError } from '../../shared/errors.js';

/** Histogram counts over `bins` equal bins: `edges` has one more entry than `counts`. */
export interface Bins {
  readonly edges: Float64Array;
  readonly counts: Float64Array;
}

/** Options for {@link histogram}. */
export interface BinOptions {
  /** Number of equal bins, or `'auto'` (Freedman-Diaconis, Sturges when the interquartile range is 0). Default 'auto'. */
  readonly bins?: number | 'auto';
  /** Range the bins cover. Default the data's min and max. Values outside it are not counted. */
  readonly range?: readonly [number, number];
  /** Divide counts so the bars' areas sum to 1. Default false. */
  readonly density?: boolean;
}

const finiteSorted = (values: ArrayLike<number>): Float64Array => {
  const out = new Float64Array(values.length);
  let n = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) out[n++] = values[i];
  return out.subarray(0, n).sort();
};

// The p-quantile of sorted values by linear interpolation between order statistics.
const quantile = (sorted: Float64Array, p: number): number => {
  const h = (sorted.length - 1) * p,
    i = Math.floor(h);
  return i + 1 < sorted.length ? sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]) : sorted[i];
};

/**
 * Counts `values` (NaN and infinities skipped) into equal bins.
 * @example histogram([1, 2, 2, 3], { bins: 2 }) // edges [1, 2, 3], counts [1, 3]
 */
export function histogram(values: ArrayLike<number>, options: BinOptions = {}): Bins {
  if (!values || typeof values.length !== 'number')
    throw typeError('histogram takes an array of numbers or a TypedArray', 'sciviz');
  const sorted = finiteSorted(values);
  let lo: number, hi: number;
  if (options.range) {
    [lo, hi] = options.range;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo))
      throw rangeError(`histogram range must be finite [min, max] with min < max, got [${lo}, ${hi}]`, 'sciviz');
  } else if (sorted.length) {
    lo = sorted[0];
    hi = sorted[sorted.length - 1];
    if (lo === hi) {
      lo -= 0.5;
      hi += 0.5;
    }
  } else {
    lo = 0;
    hi = 1;
  }
  let bins = options.bins ?? 'auto';
  if (bins === 'auto') {
    const n = sorted.length,
      iqr = n > 1 ? quantile(sorted, 0.75) - quantile(sorted, 0.25) : 0;
    const width = 2 * iqr * n ** (-1 / 3);
    bins = width > 0 ? Math.ceil((hi - lo) / width) : Math.ceil(Math.log2(Math.max(n, 1)) + 1);
    bins = Math.min(Math.max(bins, 1), 10_000);
  }
  if (!Number.isInteger(bins) || bins < 1)
    throw rangeError(`histogram bins must be a whole number of at least 1 or 'auto', got ${bins}`, 'sciviz');
  const edges = new Float64Array(bins + 1),
    counts = new Float64Array(bins),
    step = (hi - lo) / bins;
  for (let k = 0; k <= bins; k++) edges[k] = k === bins ? hi : lo + k * step;
  for (const v of sorted) {
    if (v < lo || v > hi) continue;
    // The last bin is closed: the maximum counts in it.
    counts[Math.min(bins - 1, Math.floor((v - lo) / step))]++;
  }
  if (options.density) {
    let total = 0;
    for (const c of counts) total += c;
    if (total > 0) for (let k = 0; k < bins; k++) counts[k] /= total * step;
  }
  return { edges, counts };
}

/**
 * Bar rectangles: one per (x, y), `width` wide centred on x, from `base` to y. The default width is 0.8 of the
 * smallest gap between neighbouring x values (0.8 for a single bar). NaN heights give empty bars.
 */
export function barRects(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  options: { readonly width?: number; readonly base?: number } = {},
): Float32Array {
  if (x.length !== y.length) throw rangeError(`bar x has ${x.length} values for ${y.length} heights`, 'sciviz');
  let width = options.width;
  if (width === undefined) {
    const sorted = Float64Array.from(x).sort();
    let gap = Infinity;
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i] > sorted[i - 1]) gap = Math.min(gap, sorted[i] - sorted[i - 1]);
    width = 0.8 * (gap === Infinity ? 1 : gap);
  }
  if (!(width > 0) || !Number.isFinite(width)) throw rangeError(`bar width must be positive, got ${width}`, 'sciviz');
  const base = options.base ?? 0,
    out = new Float32Array(x.length * 4);
  for (let i = 0; i < x.length; i++) {
    const h = y[i] === y[i] ? y[i] : base;
    out.set([x[i] - width / 2, Math.min(base, h), x[i] + width / 2, Math.max(base, h)], i * 4);
  }
  return out;
}

/**
 * Heatmap cells: `nx` x `ny` rectangles (row j, column i at index j * nx + i) whose centres span `x` and `y`. Cells
 * whose value is NaN are empty.
 */
export function heatmapRects(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  x: readonly [number, number],
  y: readonly [number, number],
): Float32Array {
  const dx = nx > 1 ? (x[1] - x[0]) / (nx - 1) : 1,
    dy = ny > 1 ? (y[1] - y[0]) / (ny - 1) : 1,
    out = new Float32Array(nx * ny * 4);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i,
        cx = x[0] + i * dx,
        cy = y[0] + j * dy;
      if (values[k] === values[k]) out.set([cx - dx / 2, cy - dy / 2, cx + dx / 2, cy + dy / 2], k * 4);
      else out.set([cx, cy, cx, cy], k * 4);
    }
  return out;
}

/** The rectangle (index) containing data (x, y), the last drawn on overlaps, or -1. */
export function rectAt(rects: ArrayLike<number>, x: number, y: number): number {
  for (let k = rects.length / 4 - 1; k >= 0; k--) {
    const x0 = rects[k * 4],
      y0 = rects[k * 4 + 1],
      x1 = rects[k * 4 + 2],
      y1 = rects[k * 4 + 3];
    if (x1 > x0 && y1 > y0 && x >= x0 && x <= x1 && y >= y0 && y <= y1) return k;
  }
  return -1;
}
