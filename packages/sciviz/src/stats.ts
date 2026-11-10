// Standalone vector statistical charts. Mathematics is also exported by the CPU-only /maths entry.
import { rangeError } from '../../shared/errors.js';
import { ticks } from './ticks.js';
import {
  boxSummary,
  kernelDensity,
  silvermanBandwidth,
  density2D,
  hexbin2D,
  empiricalCDF,
  quantilePairs,
  stepSeries,
  stackSeries,
  errorBarSegments,
  linearTrend,
  loessTrend,
  type StatisticalPoint,
  type StatisticalErrors,
} from './stats-maths.js';
export * from './stats-maths.js';

/** Data-space vector mark; NaN xy pairs split polylines. All returned coordinates are owned. */
export interface StatisticalMark {
  readonly kind: 'line' | 'polygon' | 'point';
  readonly points: readonly StatisticalPoint[];
  readonly color: string;
  readonly opacity?: number;
}
/** SVG layout defaults: 800x480, padding 58, title empty, x/y labels empty, ticks and a white background. */
export interface StatisticalSVGOptions {
  readonly width?: number;
  readonly height?: number;
  readonly padding?: number;
  readonly title?: string;
  readonly xLabel?: string;
  readonly yLabel?: string;
}
/** Named observations for box/violin charts. */
export interface StatisticalGroup {
  readonly label: string;
  readonly values: ArrayLike<number>;
}
const palette = ['#277da8', '#cc6b49', '#5f9366', '#8468a0', '#b48a35', '#377e7b'];
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const fail = (s: string): never => {
  throw Object.assign(rangeError(s, 'sciviz'), { code: 'out-of-range' });
};
function extent(a: ArrayLike<number>): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < a.length; i++)
    if (Number.isFinite(a[i])) {
      lo = Math.min(lo, a[i]);
      hi = Math.max(hi, a[i]);
    }
  if (!(lo <= hi)) fail('Supply finite chart observations');
  return [lo, hi];
}
const mark = (
  kind: StatisticalMark['kind'],
  points: readonly StatisticalPoint[],
  color: string,
  opacity = 1,
): StatisticalMark => ({ kind, points: points.map((p) => [...p] as const), color, opacity });
const path = (p: readonly StatisticalPoint[], color = palette[0]) => mark('line', p, color);
const polygon = (p: readonly StatisticalPoint[], color = palette[0], opacity = 0.5) =>
  mark('polygon', p, color, opacity);
const rect = (x0: number, y0: number, x1: number, y1: number, color: string) =>
  polygon(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    color,
    0.8,
  );

/** A CPU-owned chart and its SVG renderer. No engine, DOM, resources or import side effects. */
export class StatisticalChart {
  /** Owned vector marks, available to other renderers and exports. */
  readonly marks: readonly StatisticalMark[];
  /** Optional category labels in x-index order. */
  readonly categories: readonly string[];
  /** Construct from vector marks; chart helpers validate their statistical inputs. */
  constructor(marks: readonly StatisticalMark[], categories: readonly string[] = []) {
    if (
      marks.length > 200000 ||
      marks.some(
        (m) =>
          !['line', 'polygon', 'point'].includes(m.kind) ||
          !Number.isFinite(m.opacity ?? 1) ||
          (m.opacity ?? 1) < 0 ||
          (m.opacity ?? 1) > 1 ||
          m.points.some((p) => p.some((v) => !Number.isNaN(v) && !Number.isFinite(v))),
      )
    )
      fail('Chart marks must have finite coordinates (NaN line breaks), opacity in [0,1] and at most 200000 marks');
    this.marks = marks.map((m) => mark(m.kind, m.points, m.color, m.opacity));
    this.categories = [...categories];
  }
  /** Export axes, ticks, marks and labels as vector SVG. No raster fallback. */
  toSVG(options: StatisticalSVGOptions = {}): string {
    const { width = 800, height = 480, padding = 58, title = '', xLabel = '', yLabel = '' } = options;
    if (
      ![width, height, padding].every(Number.isFinite) ||
      padding < 24 ||
      width <= 2 * padding ||
      height <= 2 * padding
    )
      fail('Statistical SVG needs finite dimensions greater than twice padding, padding at least 24');
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const m of this.marks)
      for (const [x, y] of m.points)
        if (Number.isFinite(x) && Number.isFinite(y)) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    if (!Number.isFinite(x0)) fail('Statistical chart needs at least one finite mark');
    if (x0 === x1) {
      const d = Math.max(0.5, Math.abs(x0) * 0.01);
      x0 -= d;
      x1 += d;
    }
    if (y0 === y1) {
      const d = Math.max(0.5, Math.abs(y0) * 0.01);
      y0 -= d;
      y1 += d;
    }
    const dx = (x1 - x0) * 0.04,
      dy = (y1 - y0) * 0.06;
    x0 -= dx;
    x1 += dx;
    y0 -= dy;
    y1 += dy;
    const sx = (x: number) => padding + ((x - x0) / (x1 - x0)) * (width - 2 * padding),
      sy = (y: number) => height - padding - ((y - y0) / (y1 - y0)) * (height - 2 * padding);
    const d = (p: readonly StatisticalPoint[]) => {
      let connected = false;
      return p
        .map(([x, y]) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            connected = false;
            return '';
          }
          const s = `${connected ? 'L' : 'M'}${sx(x)},${sy(y)}`;
          connected = true;
          return s;
        })
        .join('');
    };
    const marks = this.marks
      .map((m) =>
        m.kind === 'point'
          ? m.points
              .filter((p) => p.every(Number.isFinite))
              .map(
                ([x, y]) =>
                  `<circle cx="${sx(x)}" cy="${sy(y)}" r="2.5" fill="${escape(m.color)}" opacity="${m.opacity ?? 1}"/>`,
              )
              .join('')
          : `<path d="${d(m.points)}${m.kind === 'polygon' ? 'Z' : ''}" fill="${m.kind === 'polygon' ? escape(m.color) : 'none'}" stroke="${escape(m.color)}" stroke-width="1.4" opacity="${m.opacity ?? 1}"/>`,
      )
      .join('');
    const xt = this.categories.length
      ? this.categories.map((label, x) => ({ x, label }))
      : ticks(x0, x1, 6).values.map((x) => ({ x, label: String(Number(x.toPrecision(4))) }));
    const yt = ticks(y0, y1, 5).values;
    const grid = yt
      .map(
        (y) =>
          `<path d="M${padding},${sy(y)}H${width - padding}" stroke="#dde4e8"/><text x="${padding - 8}" y="${sy(y) + 4}" text-anchor="end">${Number(y.toPrecision(4))}</text>`,
      )
      .join('');
    const labels = xt
      .map((t) => `<text x="${sx(t.x)}" y="${height - padding + 20}" text-anchor="middle">${escape(t.label)}</text>`)
      .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(title || 'Statistical chart')}</title><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" font-size="11" fill="#243c4d">${grid}${marks}<path d="M${padding},${padding}V${height - padding}H${width - padding}" stroke="#243c4d" fill="none"/>${labels}<text x="${width / 2}" y="22" text-anchor="middle" font-size="15">${escape(title)}</text><text x="${width / 2}" y="${height - 8}" text-anchor="middle">${escape(xLabel)}</text><text transform="translate(14,${height / 2}) rotate(-90)" text-anchor="middle">${escape(yLabel)}</text></g></svg>`;
  }
}

/** Asymmetric x/y error bars with visible caps and observed points. Cap size defaults to 1% of each axis range. */
export function errorBarChart(x: ArrayLike<number>, y: ArrayLike<number>, errors: StatisticalErrors): StatisticalChart {
  const [xa, xb] = extent(x),
    [ya, yb] = extent(y),
    cx = (xb - xa || 1) * 0.01,
    cy = (yb - ya || 1) * 0.01;
  const marks = errorBarSegments(x, y, errors).flatMap(([a, b]) => [
    path([a, b]),
    ...[a, b].map((p) =>
      a[0] === b[0]
        ? path([
            [p[0] - cx, p[1]],
            [p[0] + cx, p[1]],
          ])
        : path([
            [p[0], p[1] - cy],
            [p[0], p[1] + cy],
          ]),
    ),
  ]);
  marks.push(
    mark(
      'point',
      Array.from(x, (v, i) => [v, y[i]] as const),
      palette[1],
    ),
  );
  return new StatisticalChart(marks);
}
/** Tukey box plots, median lines, adjacent-value whiskers and outliers; width defaults to 0.6 category units. */
export function boxChart(groups: readonly StatisticalGroup[], width = 0.6): StatisticalChart {
  if (!(width > 0 && width <= 1) || !groups.length) fail('Box chart needs groups and width in (0,1]');
  return new StatisticalChart(
    groups.flatMap((g, x) => {
      const b = boxSummary(g.values),
        l = x - width / 2,
        r = x + width / 2,
        c = palette[x % palette.length];
      return [
        rect(l, b.q1, r, b.q3, c),
        path(
          [
            [l, b.median],
            [r, b.median],
          ],
          '#172c3a',
        ),
        path(
          [
            [x, b.lower],
            [x, b.q1],
          ],
          c,
        ),
        path(
          [
            [x, b.q3],
            [x, b.upper],
          ],
          c,
        ),
        path(
          [
            [l, b.lower],
            [r, b.lower],
          ],
          c,
        ),
        path(
          [
            [l, b.upper],
            [r, b.upper],
          ],
          c,
        ),
        mark(
          'point',
          b.outliers.map((y) => [x, y]),
          c,
        ),
      ];
    }),
    groups.map((g) => g.label),
  );
}
/** Symmetric Gaussian KDE violins using Silverman bandwidth, each normalized to the same maximum half-width 0.4. */
export function violinChart(groups: readonly StatisticalGroup[]): StatisticalChart {
  if (!groups.length) fail('Violin chart needs at least one group');
  return new StatisticalChart(
    groups.flatMap((g, x) => {
      const [lo, hi] = extent(g.values),
        h = silvermanBandwidth(g.values),
        at = Array.from({ length: 96 }, (_, i) => lo - 3 * h + ((hi - lo + 6 * h) * i) / 95),
        density = kernelDensity(g.values, at, h),
        max = Math.max(...density.map((p) => p[1])),
        c = palette[x % palette.length];
      const points = density
        .map(([y, d]) => [x - (0.4 * d) / max, y] as const)
        .concat([...density].reverse().map(([y, d]) => [x + (0.4 * d) / max, y] as const));
      const b = boxSummary(g.values);
      return [
        polygon(points, c, 0.65),
        path(
          [
            [x, b.q1],
            [x, b.q3],
          ],
          '#172c3a',
        ),
        mark('point', [[x, b.median]], '#172c3a'),
      ];
    }),
    groups.map((g) => g.label),
  );
}
/** Area under a finite xy sequence, baseline zero by default; NaN splits both the boundary and fill. */
export function areaChart(x: ArrayLike<number>, y: ArrayLike<number>, baseline = 0): StatisticalChart {
  errorBarSegments(x, y, {});
  if (!Number.isFinite(baseline)) fail('Area baseline must be finite');
  const chunks: StatisticalPoint[][] = [];
  let current: StatisticalPoint[] = [];
  for (let i = 0; i <= x.length; i++) {
    if (i === x.length || !Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      if (current.length) chunks.push(current);
      current = [];
    } else current.push([x[i], y[i]]);
  }
  return new StatisticalChart(
    chunks.flatMap((p) => [polygon([[p[0][0], baseline], ...p, [p.at(-1)![0], baseline]]), path(p)]),
  );
}
/** Signed stacked areas or bars, with optional sign-wise unit normalization. Bar width defaults to 0.8 of the smallest x gap. */
export function stackedChart(
  x: ArrayLike<number>,
  series: readonly ArrayLike<number>[],
  options: { readonly kind?: 'area' | 'bar'; readonly normalize?: boolean; readonly width?: number } = {},
): StatisticalChart {
  if (series.some((s) => s.length !== x.length) || Array.from(x).some((v) => !Number.isFinite(v)))
    fail('Stack x and series lengths must match, with finite x');
  const bands = stackSeries(series, options.normalize),
    sorted = Array.from(x).sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1]) gap = Math.min(gap, sorted[i] - sorted[i - 1]);
  const width = options.width ?? 0.8 * (Number.isFinite(gap) ? gap : 1);
  if (
    !(width > 0) ||
    !Number.isFinite(width) ||
    (options.kind !== undefined && !['area', 'bar'].includes(options.kind))
  )
    fail('Stack kind must be area/bar, width positive and finite');
  return new StatisticalChart(
    bands.flatMap((b, k) => {
      const c = palette[k % palette.length];
      return options.kind === 'bar'
        ? Array.from(x, (v, i) => rect(v - width / 2, b.lower[i], v + width / 2, b.upper[i], c))
        : [
            polygon(
              [
                ...Array.from(x, (v, i) => [v, b.upper[i]] as const),
                ...Array.from(x, (v, i) => [v, b.lower[i]] as const).reverse(),
              ],
              c,
              0.8,
            ),
          ];
    }),
  );
}
/** Step-line chart, post-step by default. */
export function stepChart(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  mode: 'pre' | 'post' | 'mid' = 'post',
): StatisticalChart {
  return new StatisticalChart([path(stepSeries(x, y, mode))]);
}
/** Empirical cumulative distribution chart, right-continuous with a zero-probability leading step. */
export function cdfChart(values: ArrayLike<number>): StatisticalChart {
  const p = empiricalCDF(values),
    points = [[p[0][0], 0] as const, ...p];
  return stepChart(
    points.map((p) => p[0]),
    points.map((p) => p[1]),
  );
}
/** Two-sample Q-Q plot, with y=x reference. */
export function qqChart(values: ArrayLike<number>, reference: ArrayLike<number>): StatisticalChart {
  const p = quantilePairs(values, reference),
    [lo, hi] = extent(p.flatMap((p) => [...p]));
  return new StatisticalChart([
    path(
      [
        [lo, lo],
        [hi, hi],
      ],
      '#8796a0',
    ),
    mark('point', p, palette[0]),
  ]);
}
/** Rectangular Gaussian 2D density raster cells exported as vector polygons, 32x32 queries by default. */
export function densityChart(x: ArrayLike<number>, y: ArrayLike<number>, resolution = 32): StatisticalChart {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 256)
    fail('Density resolution must be an integer from 2 to 256');
  const [xa, xb] = extent(x),
    [ya, yb] = extent(y),
    hx = silvermanBandwidth(x),
    hy = silvermanBandwidth(y),
    x0 = xa - 3 * hx,
    x1 = xb + 3 * hx,
    y0 = ya - 3 * hy,
    y1 = yb + 3 * hy;
  const gx = Array.from({ length: resolution }, (_, i) => x0 + ((x1 - x0) * (i + 0.5)) / resolution),
    gy = Array.from({ length: resolution }, (_, i) => y0 + ((y1 - y0) * (i + 0.5)) / resolution),
    v = density2D(x, y, gx, gy, [hx, hy]),
    max = Math.max(...v),
    dx = (x1 - x0) / resolution,
    dy = (y1 - y0) / resolution;
  return new StatisticalChart(
    Array.from(v, (value, i) => {
      const x = gx[i % resolution],
        y = gy[Math.floor(i / resolution)],
        c = Math.round(250 - (170 * value) / max);
      return rect(
        x - dx / 2,
        y - dy / 2,
        x + dx / 2,
        y + dy / 2,
        `rgb(${c},${Math.round(c * 0.9)},${Math.min(255, c + 35)})`,
      );
    }),
  );
}
/** Hexagonal bin counts, with original membership exposed by hexbin2D in /maths. */
export function hexbinChart(x: ArrayLike<number>, y: ArrayLike<number>, radius: number): StatisticalChart {
  const bins = hexbin2D(x, y, radius),
    max = Math.max(...bins.map((b) => b.count));
  return new StatisticalChart(bins.map((b) => polygon(b.vertices, palette[0], 0.15 + (0.85 * b.count) / max)));
}
/** Linear or robust local-linear trend plus pointwise mean confidence band (default 95%). */
export function trendChart(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  options: {
    readonly method?: 'linear' | 'loess';
    readonly span?: number;
    readonly iterations?: number;
    readonly confidence?: number;
  } = {},
): StatisticalChart {
  if (options.method !== undefined && !['linear', 'loess'].includes(options.method))
    fail('Trend method must be linear or loess');
  const points = options.method === 'loess' ? loessTrend(x, y, options) : linearTrend(x, y, options).points;
  return new StatisticalChart([
    polygon(
      [...points.map((p) => [p.x, p.lower] as const), ...[...points].reverse().map((p) => [p.x, p.upper] as const)],
      palette[0],
      0.2,
    ),
    mark(
      'point',
      Array.from(x, (v, i) => [v, y[i]] as const),
      '#78909c',
      0.5,
    ),
    path(points.map((p) => [p.x, p.y])),
  ]);
}
