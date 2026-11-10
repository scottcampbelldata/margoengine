// Clean-room specialised vector charts. Sources and design choices: docs/clean-room.md, batch 177 job 3.
import { rangeError } from '../../shared/errors.js';
import { ticks } from './ticks.js';

/** A point in the chart's 0..1000 by 0..600 layout coordinate system. */
export type ChartPoint = readonly [number, number];
/** Export dimensions default to 1000x600; title defaults to the chart kind. */
export interface ExtraSVGOptions {
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
}
/** Vector primitive with an optional accessible data label. */
export interface ExtraMark {
  readonly path: string;
  readonly fill: string;
  readonly stroke: string;
  readonly label?: string;
  readonly width?: number;
}
/** Text in layout coordinates. */
export interface ExtraLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly anchor?: 'start' | 'middle' | 'end';
}
const colors = ['#277da8', '#d47a46', '#60956a', '#9971a4', '#bd9a35', '#488e91', '#b85d79', '#697aab'];
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const fail = (s: string): never => {
  throw Object.assign(rangeError(s, 'sciviz'), { code: 'out-of-range' });
};
const finite = (...a: number[]) => {
  if (!a.every(Number.isFinite)) fail('Chart values must be finite');
};
const positive = (a: readonly number[]) => {
  if (!a.length || a.some((v) => !Number.isFinite(v) || v < 0) || !Number.isFinite(a.reduce((s, v) => s + v, 0)))
    fail('Supply finite nonnegative values with a representable total');
};
const line = (p: readonly ChartPoint[], close = false) =>
  p.map((v, i) => `${i ? 'L' : 'M'}${v[0]},${v[1]}`).join(' ') + (close ? ' Z' : '');
const rect = (x: number, y: number, w: number, h: number) => `M${x},${y}h${w}v${h}h${-w}Z`;
const point = (a: number, r: number): ChartPoint => [500 + r * Math.sin(a), 310 - r * Math.cos(a)];
const tau = 2 * Math.PI;
function sector(a: number, b: number, r0: number, r1: number): string {
  if (b - a >= tau - 1e-12) return sector(a, a + Math.PI, r0, r1) + ' ' + sector(a + Math.PI, b, r0, r1);
  const p = point(a, r1),
    q = point(b, r1),
    u = point(b, r0),
    v = point(a, r0),
    large = +(b - a > Math.PI);
  return `M${p}A${r1},${r1} 0 ${large} 1 ${q}L${u}` + (r0 ? `A${r0},${r0} 0 ${large} 0 ${v}` : '') + 'Z';
}
/** CPU-owned geometry with scales rendered as vector paths/text. No DOM, engine or import side effects. */
export class ExtraChart {
  readonly marks: readonly ExtraMark[];
  readonly labels: readonly ExtraLabel[];
  constructor(
    readonly kind: string,
    marks: readonly ExtraMark[],
    labels: readonly ExtraLabel[] = [],
  ) {
    this.marks = marks.map((m) => Object.freeze({ ...m }));
    this.labels = labels.map((l) => Object.freeze({ ...l }));
  }
  /** Export all axes, labels and data as SVG. */
  toSVG({ width = 1000, height = 600, title = this.kind }: ExtraSVGOptions = {}): string {
    finite(width, height);
    if (width <= 0 || height <= 0) fail('SVG dimensions must be positive');
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 600" role="img"><title>${esc(title)}</title><rect width="1000" height="600" fill="white"/><g font-family="system-ui" font-size="13" fill="#304650"><text x="500" y="25" text-anchor="middle" font-size="19">${esc(title)}</text>` +
      this.marks
        .map(
          (m) =>
            `<path d="${esc(m.path)}" fill="${esc(m.fill)}" stroke="${esc(m.stroke)}" stroke-width="${m.width ?? 1}">${m.label ? `<title>${esc(m.label)}</title>` : ''}</path>`,
        )
        .join('') +
      this.labels
        .map((l) => `<text x="${l.x}" y="${l.y}" text-anchor="${l.anchor ?? 'middle'}">${esc(l.text)}</text>`)
        .join('') +
      '</g></svg>'
    );
  }
}
class Drawing {
  marks: ExtraMark[] = [];
  labels: ExtraLabel[] = [];
  path(path: string, fill = 'none', stroke = '#80919a', label?: string, width = 1) {
    this.marks.push({ path, fill, stroke, label, width });
  }
  text(x: number, y: number, text: string, anchor: ExtraLabel['anchor'] = 'middle') {
    this.labels.push({ x, y, text, anchor });
  }
  done(kind: string) {
    return new ExtraChart(kind, this.marks, this.labels);
  }
}
/** Polar coordinates: angles in degrees clockwise from north by default; radius linear or logarithmic. */
export interface PolarOptions {
  readonly radians?: boolean;
  readonly radialDomain?: readonly [number, number];
  readonly radialScale?: 'linear' | 'log';
  readonly color?: string;
  readonly close?: boolean;
  readonly fill?: boolean;
}
function polarScale(d: Drawing, domain: readonly [number, number], log = false): (r: number) => number {
  finite(...domain);
  if (domain[1] <= domain[0] || (log && domain[0] <= 0))
    fail('Polar radius needs an increasing domain, positive for log');
  const f = (v: number) => (log ? Math.log(v) : v),
    lo = f(domain[0]),
    span = f(domain[1]) - lo;
  for (let i = 1; i <= 5; i++) {
    const r = (240 * i) / 5;
    d.path(sector(0, tau, r, r));
    d.text(510, 310 - r, Number(log ? Math.exp(lo + (span * i) / 5) : lo + (span * i) / 5).toPrecision(3), 'start');
  }
  for (let i = 0; i < 8; i++) {
    const a = (i * tau) / 8;
    d.path(line([[500, 310], point(a, 240)]));
    const p = point(a, 261);
    d.text(p[0], p[1] + 4, `${i * 45}°`);
  }
  return (r: number) => {
    finite(r);
    if (r < domain[0] || r > domain[1]) fail('Radius lies outside radialDomain');
    return (240 * (f(r) - lo)) / span;
  };
}
/** Draw a polar polyline or filled radial polygon. */
export function polarChart(
  theta: ArrayLike<number>,
  radius: ArrayLike<number>,
  options: PolarOptions = {},
): ExtraChart {
  if (!theta.length || theta.length !== radius.length) fail('Polar arrays must be nonempty and aligned');
  const r = Array.from(radius);
  finite(...r);
  const d = new Drawing(),
    scale = polarScale(d, options.radialDomain ?? [0, Math.max(1, ...r)], options.radialScale === 'log');
  const p = r.map((v, i) => {
    finite(theta[i]);
    return point(theta[i] * (options.radians ? 1 : Math.PI / 180), scale(v));
  });
  d.path(
    line(p, options.close ?? options.fill),
    options.fill ? (options.color ?? colors[0]) : 'none',
    options.color ?? colors[0],
    undefined,
    2,
  );
  return d.done('Polar');
}
/** Wind bins use meteorological direction-from degrees and speed in caller units. Calm defaults to 0.5, sectors 16, speed breaks [0,2,5,10,Infinity], percentage false. */
export interface WindRoseOptions {
  readonly sectors?: number;
  readonly speedBreaks?: readonly number[];
  readonly calm?: number;
  readonly percentage?: boolean;
}
/** Counts include calm separately; missing direction is accepted only for calm observations. */
export interface WindRoseBins {
  readonly counts: readonly (readonly number[])[];
  readonly calm: number;
  readonly total: number;
  readonly breaks: readonly number[];
}
/** Bin finite winds by meteorological direction and speed, retaining calm and total counts. */
export function windRoseBins(
  direction: ArrayLike<number>,
  speed: ArrayLike<number>,
  options: WindRoseOptions = {},
): WindRoseBins {
  const n = options.sectors ?? 16,
    breaks = options.speedBreaks ?? [0, 2, 5, 10, Infinity],
    calm = options.calm ?? 0.5;
  if (
    direction.length !== speed.length ||
    !Number.isInteger(n) ||
    n < 3 ||
    n > 360 ||
    !Number.isFinite(calm) ||
    calm < 0 ||
    breaks.length < 2 ||
    breaks[0] !== 0 ||
    breaks.some((v, i) => Number.isNaN(v) || v < 0 || (i > 0 && v <= breaks[i - 1])) ||
    breaks.at(-1) !== Infinity
  )
    fail('Invalid wind arrays, sector count, calm threshold or speed breaks');
  const counts = Array.from({ length: n }, () => Array(breaks.length - 1).fill(0) as number[]);
  let c = 0,
    total = 0;
  for (let i = 0; i < speed.length; i++) {
    const s = speed[i],
      a = direction[i];
    if (!Number.isFinite(s) || s < 0) continue;
    if (s < calm) {
      c++;
      total++;
      continue;
    }
    if (!Number.isFinite(a)) continue;
    const j = Math.floor(((((a % 360) + 360) % 360) + 180 / n) / (360 / n)) % n,
      k = breaks.findIndex((v) => v > s) - 1;
    counts[j][k]++;
    total++;
  }
  return { counts, calm: c, total, breaks: [...breaks] };
}
/** Stacked directional frequencies with separate calm annotation and a speed-bin legend. */
export function windRoseChart(
  direction: ArrayLike<number>,
  speed: ArrayLike<number>,
  options: WindRoseOptions = {},
): ExtraChart {
  const bins = windRoseBins(direction, speed, options),
    d = new Drawing(),
    factor = options.percentage && bins.total ? 100 / bins.total : 1,
    totals = bins.counts.map((r) => r.reduce((s, v) => s + v, 0) * factor),
    scale = polarScale(d, [0, Math.max(1, ...totals)]),
    n = bins.counts.length;
  bins.counts.forEach((r, i) => {
    let s = 0;
    r.forEach((v, k) => {
      if (v)
        d.path(
          sector(((i - 0.45) * tau) / n, ((i + 0.45) * tau) / n, scale(s), scale(s + v * factor)),
          colors[k % colors.length],
          'white',
          `${(i * 360) / n}°: ${v} observations`,
        );
      s += v * factor;
    });
  });
  bins.breaks.slice(0, -1).forEach((v, i) => {
    d.path(rect(785, 90 + i * 26, 12, 12), colors[i % colors.length], 'none');
    d.text(805, 101 + i * 26, `${v} to ${bins.breaks[i + 1]}`, 'start');
  });
  d.text(
    500,
    590,
    `Calm: ${bins.calm} / ${bins.total}; radial units: ${options.percentage ? 'percent of all observations' : 'count'}`,
  );
  return d.done('Wind rose');
}
/** Ternary corners ordered top, bottom-left, bottom-right; triples are normalized by their sum. */
export interface TernaryOptions {
  readonly labels?: readonly [string, string, string];
  readonly color?: string;
  readonly connect?: boolean;
}
/** Normalize each positive triple to a point on labelled barycentric axes. */
export function ternaryChart(
  values: readonly (readonly [number, number, number])[],
  options: TernaryOptions = {},
): ExtraChart {
  const d = new Drawing(),
    h = 450,
    w = (h * 2) / Math.sqrt(3),
    base = 540;
  const xy = (a: number, b: number, c: number): ChartPoint => [500 + (w * (c - b)) / 2, base - h * a];
  d.path(line([xy(1, 0, 0), xy(0, 1, 0), xy(0, 0, 1)], true));
  for (let i = 1; i < 5; i++) {
    const t = i / 5;
    d.path(line([xy(t, 1 - t, 0), xy(t, 0, 1 - t)]));
    d.path(line([xy(1 - t, t, 0), xy(0, t, 1 - t)]));
    d.path(line([xy(1 - t, 0, t), xy(0, 1 - t, t)]));
    const p = xy(t, 1 - t, 0);
    d.text(p[0] - 18, p[1], `${i * 20}%`);
  }
  const corners = [xy(1, 0, 0), xy(0, 1, 0), xy(0, 0, 1)];
  corners.forEach((p, i) => d.text(p[0], p[1] + (i ? 25 : -14), options.labels?.[i] ?? ['A', 'B', 'C'][i]));
  const points = values.map((v) => {
    positive(v);
    const s = v.reduce((a, b) => a + b, 0);
    if (!s) fail('Ternary triples need a positive sum');
    return xy(v[0] / s, v[1] / s, v[2] / s);
  });
  if (options.connect) d.path(line(points), 'none', options.color ?? colors[0]);
  points.forEach((p, i) =>
    d.path(
      `M${p[0] - 3},${p[1]}a3,3 0 1 0 6,0a3,3 0 1 0 -6,0`,
      options.color ?? colors[0],
      'none',
      values[i].join(', '),
    ),
  );
  return d.done('Ternary');
}
/** Financial row x is numeric, or Unix milliseconds with dateAxis. All prices finite, low <= open/close <= high. */
export interface OHLCRow {
  readonly x: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}
/** Financial styles: dateAxis false, up/down colors green/orange, width auto in layout units. */
export interface FinancialOptions {
  readonly dateAxis?: boolean;
  readonly upColor?: string;
  readonly downColor?: string;
  readonly width?: number;
}
function financial(rows: readonly OHLCRow[], ohlc: boolean, options: FinancialOptions): ExtraChart {
  if (!rows.length) fail('Financial chart needs observations');
  rows.forEach((r, i) => {
    finite(r.x, r.open, r.high, r.low, r.close);
    if (r.low > Math.min(r.open, r.close) || r.high < Math.max(r.open, r.close) || (i && r.x <= rows[i - 1].x))
      fail('OHLC rows need ordered unique x and consistent price bounds');
  });
  const d = new Drawing(),
    min = Math.min(...rows.map((r) => r.low)),
    max = Math.max(...rows.map((r) => r.high)),
    span = max - min || 1,
    x0 = rows[0].x,
    dx = rows.at(-1)!.x - x0 || 1;
  const x = (v: number) => 90 + (820 * (v - x0)) / dx,
    y = (v: number) => 525 - (450 * (v - min)) / span;
  const t = ticks(min, max);
  t.values.forEach((v, i) => {
    d.path(
      line([
        [75, y(v)],
        [940, y(v)],
      ]),
    );
    d.text(65, y(v) + 4, t.labels[i], 'end');
  });
  const step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => {
    if (i % step === 0) d.text(x(r.x), 555, options.dateAxis ? new Date(r.x).toISOString().slice(0, 10) : String(r.x));
  });
  const bw = options.width ?? Math.min(20, 600 / rows.length);
  finite(bw);
  if (bw <= 0) fail('Financial width must be positive');
  rows.forEach((r) => {
    const c = r.close >= r.open ? (options.upColor ?? colors[2]) : (options.downColor ?? colors[1]),
      px = x(r.x);
    d.path(
      line([
        [px, y(r.low)],
        [px, y(r.high)],
      ]),
      'none',
      c,
      `${r.x}: O ${r.open}, H ${r.high}, L ${r.low}, C ${r.close}`,
      2,
    );
    d.path(
      ohlc
        ? `M${px - bw / 2},${y(r.open)}h${bw / 2}M${px},${y(r.close)}h${bw / 2}`
        : rect(px - bw / 2, Math.min(y(r.open), y(r.close)), bw, Math.max(1, Math.abs(y(r.open) - y(r.close)))),
      ohlc ? 'none' : c,
      c,
      undefined,
      2,
    );
  });
  return d.done(ohlc ? 'OHLC' : 'Candlestick');
}
/** Draw OHLC bodies and high/low wicks on numeric or date axes. */
export function candlestickChart(rows: readonly OHLCRow[], options: FinancialOptions = {}): ExtraChart {
  return financial(rows, false, options);
}
/** Draw open/close ticks and high/low stems on numeric or date axes. */
export function ohlcChart(rows: readonly OHLCRow[], options: FinancialOptions = {}): ExtraChart {
  return financial(rows, true, options);
}
/** Named nonnegative magnitude. */
export interface NamedValue {
  readonly label: string;
  readonly value: number;
  readonly color?: string;
}
/** Hole is a radius fraction in [0,1); startAngle degrees clockwise from north, sort false. */
export interface PieOptions {
  readonly hole?: number;
  readonly startAngle?: number;
  readonly sort?: boolean;
}
/** Draw proportional sectors with named labels and exact annular paths. */
export function pieChart(values: readonly NamedValue[], options: PieOptions = {}): ExtraChart {
  positive(values.map((v) => v.value));
  const hole = options.hole ?? 0,
    start = options.startAngle ?? 0;
  finite(hole, start);
  if (hole < 0 || hole >= 1) fail('Pie hole must be in [0,1)');
  const a = options.sort ? [...values].sort((a, b) => b.value - a.value) : values,
    total = a.reduce((s, v) => s + v.value, 0),
    d = new Drawing();
  if (!total) fail('Pie needs a positive total');
  let angle = (start * Math.PI) / 180;
  a.forEach((v, i) => {
    const end = angle + (tau * v.value) / total;
    if (v.value)
      d.path(
        sector(angle, end, 240 * hole, 240),
        v.color ?? colors[i % colors.length],
        'white',
        `${v.label}: ${v.value} (${((100 * v.value) / total).toFixed(2)}%)`,
      );
    const p = point((angle + end) / 2, 265);
    if (v.value) d.text(p[0], p[1], v.label);
    angle = end;
  });
  return d.done(hole ? 'Donut' : 'Pie');
}
/** Draw proportional sectors with a central hole, default radius fraction 0.5. */
export function donutChart(values: readonly NamedValue[], options: PieOptions = {}): ExtraChart {
  return pieChart(values, { ...options, hole: options.hole ?? 0.5 });
}
/** Internal nodes sum descendants. Only leaves carry value; labels need not be unique. */
export interface HierarchyNode {
  readonly label: string;
  readonly value?: number;
  readonly color?: string;
  readonly children?: readonly HierarchyNode[];
}
interface Tree {
  node: HierarchyNode;
  value: number;
  depth: number;
  children: Tree[];
}
function tree(root: HierarchyNode): Tree {
  const seen = new Set<HierarchyNode>();
  let count = 0;
  const visit = (node: HierarchyNode, depth: number): Tree => {
    if (seen.has(node) || depth > 64 || ++count > 10000)
      fail('Hierarchy must be a tree, at most 64 levels and 10000 nodes');
    seen.add(node);
    const children = node.children?.map((n) => visit(n, depth + 1)) ?? [];
    if (children.length && node.value !== undefined) fail('Only hierarchy leaves carry value');
    const value = children.length ? children.reduce((s, n) => s + n.value, 0) : (node.value ?? 0);
    positive([value]);
    return { node, value, depth, children };
  };
  const t = visit(root, 0);
  if (!t.value) fail('Hierarchy needs a positive total');
  return t;
}
/** Radial partition with equal depth bands; children occupy their parent's complete angle. */
export function sunburstChart(root: HierarchyNode): ExtraChart {
  const t = tree(root),
    d = new Drawing();
  let depth = 0;
  const scan = (n: Tree) => {
    depth = Math.max(depth, n.depth);
    n.children.forEach(scan);
  };
  scan(t);
  let index = 0;
  const draw = (n: Tree, a: number, b: number, color: string) => {
    if (n.value) {
      const r0 = (240 * n.depth) / (depth + 1),
        r1 = (240 * (n.depth + 1)) / (depth + 1);
      d.path(sector(a, b, r0, r1), n.node.color ?? color, 'white', `${n.node.label}: ${n.value}`);
      if (b - a > 0.15) {
        const p = point((a + b) / 2, (r0 + r1) / 2);
        d.text(p[0], p[1], n.node.label);
      }
    }
    let at = a;
    n.children.forEach((c) => {
      const end = at + ((b - a) * c.value) / n.value;
      draw(c, at, end, n.depth === 0 ? colors[index++ % colors.length] : color);
      at = end;
    });
  };
  draw(t, 0, tau, colors[0]);
  return d.done('Sunburst');
}
/** Squarified hierarchical rectangles with data area conserved at each level; no padded loss. */
export interface TreemapCell {
  readonly label: string;
  readonly value: number;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}
/** Compute owned squarified rectangles recursively, conserving parent area. */
export function treemapLayout(root: HierarchyNode): readonly TreemapCell[] {
  const t = tree(root),
    out: TreemapCell[] = [];
  let color = 0;
  const draw = (n: Tree, x: number, y: number, w: number, h: number, c: string) => {
    out.push({
      label: n.node.label,
      value: n.value,
      depth: n.depth,
      x,
      y,
      width: w,
      height: h,
      color: n.node.color ?? c,
    });
    const pending = n.children.filter((v) => v.value > 0).sort((a, b) => b.value - a.value);
    let left = n.value;
    while (pending.length) {
      const short = Math.min(w, h),
        unit = (w * h) / left,
        row: Tree[] = [];
      let sum = 0;
      const worst = (items: Tree[], s: number) =>
        items.length
          ? Math.max(
              (short * short * Math.max(...items.map((v) => v.value * unit))) / (s * unit) ** 2,
              (s * unit) ** 2 / (short * short * Math.min(...items.map((v) => v.value * unit))),
            )
          : Infinity;
      while (pending.length) {
        const next = pending[0];
        if (row.length && worst([...row, next], sum + next.value) > worst(row, sum)) break;
        row.push(pending.shift()!);
        sum += next.value;
      }
      const thick = (sum * unit) / short;
      let offset = 0;
      row.forEach((v) => {
        const length = (v.value * unit) / thick,
          cc = n.depth === 0 ? colors[color++ % colors.length] : c;
        if (w >= h) draw(v, x, y + offset, thick, length, cc);
        else draw(v, x + offset, y, length, thick, cc);
        offset += length;
      });
      if (w >= h) {
        x += thick;
        w = Math.max(0, w - thick);
      } else {
        y += thick;
        h = Math.max(0, h - thick);
      }
      left -= sum;
    }
  };
  draw(t, 80, 60, 840, 480, colors[0]);
  return out;
}
/** Render the squarified hierarchy with leaf labels and data titles. */
export function treemapChart(root: HierarchyNode): ExtraChart {
  const cells = treemapLayout(root),
    d = new Drawing();
  cells.forEach((c) => {
    d.path(rect(c.x, c.y, c.width, c.height), c.color, 'white', `${c.label}: ${c.value}`);
  });
  cells
    .filter((c, i) => i === cells.length - 1 || cells[i + 1].depth <= c.depth)
    .forEach((c) => {
      if (c.width > 35 && c.height > 18) d.text(c.x + c.width / 2, c.y + c.height / 2, c.label);
    });
  return d.done('Treemap');
}

/** A directed weighted flow. Node identifiers must be unique. */
export interface FlowNode {
  readonly id: string;
  readonly label?: string;
  readonly color?: string;
}
/** Positive source-to-target flow magnitude in consistent caller units. */
export interface FlowLink {
  readonly source: string;
  readonly target: string;
  readonly value: number;
}
/** Padding defaults 12 layout units, node width 16, crossing-reduction sweeps 8. Explicit layers are optional and must increase along links. */
export interface SankeyOptions {
  readonly padding?: number;
  readonly nodeWidth?: number;
  readonly sweeps?: number;
  readonly layers?: Readonly<Record<string, number>>;
}
/** Owned layered node rectangle with its data magnitude. */
export interface SankeyNodeLayout {
  readonly id: string;
  readonly label: string;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly value: number;
  readonly color: string;
}
/** Owned routed flow centerline and globally proportional stroke width. */
export interface SankeyLinkLayout {
  readonly source: string;
  readonly target: string;
  readonly value: number;
  readonly width: number;
  readonly points: readonly ChartPoint[];
  readonly color: string;
}
/** Owned nodes, routed links and common value-to-layout scale. */
export interface SankeyLayout {
  readonly nodes: readonly SankeyNodeLayout[];
  readonly links: readonly SankeyLinkLayout[];
  readonly nodeWidth: number;
  readonly scale: number;
}
/** Longest-path DAG layering, dummy vertices for long edges, weighted barycentric sweeps and one global flow scale. */
export function sankeyLayout(
  nodes: readonly FlowNode[],
  links: readonly FlowLink[],
  options: SankeyOptions = {},
): SankeyLayout {
  if (!nodes.length || nodes.length > 10000 || links.length > 50000)
    fail('Sankey needs 1..10000 nodes and at most 50000 links');
  const pad = options.padding ?? 12,
    nw = options.nodeWidth ?? 16,
    sweeps = options.sweeps ?? 8;
  finite(pad, nw, sweeps);
  if (pad < 0 || nw <= 0 || nw >= 400 || !Number.isInteger(sweeps) || sweeps < 0 || sweeps > 64)
    fail('Invalid Sankey layout options');
  const ids = new Map(nodes.map((n, i) => [n.id, i]));
  if (ids.size !== nodes.length) fail('Sankey IDs must be unique');
  const input = nodes.map(() => 0),
    output = nodes.map(() => 0),
    indeg = nodes.map(() => 0),
    out = nodes.map(() => [] as number[]),
    level = nodes.map(() => 0);
  links.forEach((l, i) => {
    const a = ids.get(l.source),
      b = ids.get(l.target);
    if (a === undefined || b === undefined || a === b || !Number.isFinite(l.value) || l.value <= 0)
      fail('Links need distinct existing endpoints and positive finite values');
    output[a!] += l.value;
    input[b!] += l.value;
    indeg[b!]++;
    out[a!].push(i);
  });
  finite(...input, ...output);
  const queue = indeg.map((n, i) => (n === 0 ? i : -1)).filter((i) => i >= 0);
  let visited = 0;
  while (visited < queue.length) {
    const a = queue[visited++];
    for (const i of out[a]) {
      const b = ids.get(links[i].target)!;
      level[b] = Math.max(level[b], level[a] + 1);
      if (--indeg[b] === 0) queue.push(b);
    }
  }
  if (visited !== nodes.length) fail('Sankey requires an acyclic flow graph');
  if (options.layers)
    nodes.forEach((n, i) => {
      const v = options.layers![n.id];
      if (!Number.isInteger(v) || v < 0 || v > 128) fail('Explicit layers must give every node an integer in [0,128]');
      level[i] = v;
    });
  const max = Math.max(1, ...level);
  if (max > 128) fail('Sankey supports at most 129 layers');
  const vertices = nodes.map((_, i) => ({ layer: level[i], value: Math.max(input[i], output[i]), order: 0, y: 0 })),
    chains: number[][] = [],
    edges: { a: number; b: number; value: number }[] = [];
  links.forEach((l) => {
    const a = ids.get(l.source)!,
      b = ids.get(l.target)!;
    if (level[b] <= level[a]) fail('Layers must increase along links');
    const chain = [a];
    for (let j = level[a] + 1; j < level[b]; j++) {
      if (vertices.length >= 50000) fail('Sankey expanded layout exceeds 50000 vertices');
      chain.push(vertices.length);
      vertices.push({ layer: j, value: l.value, order: 0, y: 0 });
    }
    chain.push(b);
    chains.push(chain);
    for (let j = 1; j < chain.length; j++) edges.push({ a: chain[j - 1], b: chain[j], value: l.value });
  });
  const layers = Array.from({ length: max + 1 }, () => [] as number[]);
  vertices.forEach((v, i) => layers[v.layer].push(i));
  layers.forEach((a) => a.forEach((v, i) => (vertices[v].order = i)));
  const incoming = vertices.map(() => [] as { other: number; weight: number }[]),
    outgoing = vertices.map(() => [] as { other: number; weight: number }[]);
  edges.forEach((e) => {
    incoming[e.b].push({ other: e.a, weight: e.value });
    outgoing[e.a].push({ other: e.b, weight: e.value });
  });
  for (let pass = 0; pass < sweeps; pass++) {
    const forward = pass % 2 === 0;
    for (let k = 0; k <= max; k++) {
      const a = layers[forward ? k : max - k],
        neighbors = forward ? incoming : outgoing;
      const bary = (v: number) => {
        let sum = 0,
          weight = 0;
        for (const e of neighbors[v]) {
          sum += vertices[e.other].order * e.weight;
          weight += e.weight;
        }
        return weight ? sum / weight : vertices[v].order;
      };
      a.sort((u, v) => bary(u) - bary(v) || vertices[u].order - vertices[v].order);
      a.forEach((v, i) => (vertices[v].order = i));
    }
  }
  let scale = Infinity;
  for (const a of layers) {
    const sum = a.reduce((s, i) => s + vertices[i].value, 0),
      space = 450 - pad * Math.max(0, a.length - 1);
    if (space <= 0) fail('Sankey padding leaves no node space');
    if (sum) scale = Math.min(scale, space / sum);
  }
  if (!Number.isFinite(scale)) scale = 1;
  for (const a of layers) {
    const used = a.reduce((s, i) => s + vertices[i].value * scale, 0) + pad * Math.max(0, a.length - 1);
    let y = 75 + (450 - used) / 2;
    a.forEach((i) => {
      vertices[i].y = y;
      y += vertices[i].value * scale + pad;
    });
  }
  const offsetIn = vertices.map(() => 0),
    offsetOut = vertices.map(() => 0),
    positions = new Map<string, number>(),
    portIn = vertices.map(() => [] as number[]),
    portOut = vertices.map(() => [] as number[]);
  edges.forEach((e, i) => {
    portIn[e.b].push(i);
    portOut[e.a].push(i);
  });
  // Sort ports by neighbor order, preserving the same value-to-width scale everywhere.
  for (let v = 0; v < vertices.length; v++) {
    const port = (indices: number[], source: boolean) => {
      indices.sort(
        (i, j) => vertices[source ? edges[i].b : edges[i].a].order - vertices[source ? edges[j].b : edges[j].a].order,
      );
      for (const i of indices) {
        const key = `${i}:${source ? 0 : 1}`,
          at = source ? offsetOut : offsetIn;
        positions.set(key, vertices[v].y + at[v] + (edges[i].value * scale) / 2);
        at[v] += edges[i].value * scale;
      }
    };
    port(portOut[v], true);
    port(portIn[v], false);
  }
  let edge = 0;
  const resultLinks = links.map((l, i) => {
    const points: ChartPoint[] = [];
    for (let j = 1; j < chains[i].length; j++) {
      const a = chains[i][j - 1],
        b = chains[i][j];
      points.push(
        [80 + (vertices[a].layer * 740) / max + nw, positions.get(`${edge}:0`)!],
        [80 + (vertices[b].layer * 740) / max, positions.get(`${edge}:1`)!],
      );
      edge++;
    }
    return {
      ...l,
      width: l.value * scale,
      points,
      color: nodes[ids.get(l.source)!].color ?? colors[ids.get(l.source)! % colors.length],
    };
  });
  return {
    nodes: nodes.map((n, i) => ({
      id: n.id,
      label: n.label ?? n.id,
      layer: level[i],
      x: 80 + (level[i] * 740) / max,
      y: vertices[i].y,
      height: vertices[i].value * scale,
      value: vertices[i].value,
      color: n.color ?? colors[i % colors.length],
    })),
    links: resultLinks,
    nodeWidth: nw,
    scale,
  };
}
/** Render layered weighted flow paths and node magnitudes as vector SVG. */
export function sankeyChart(
  nodes: readonly FlowNode[],
  links: readonly FlowLink[],
  options: SankeyOptions = {},
): ExtraChart {
  const layout = sankeyLayout(nodes, links, options),
    d = new Drawing();
  layout.links.forEach((l) => {
    let path = '';
    for (let i = 0; i < l.points.length; i += 2) {
      const a = l.points[i],
        b = l.points[i + 1],
        mid = (a[0] + b[0]) / 2;
      path += `${i ? 'L' : 'M'}${a}C${mid},${a[1]} ${mid},${b[1]} ${b}`;
    }
    d.path(path, 'none', l.color, `${l.source} → ${l.target}: ${l.value}`, l.width);
  });
  layout.nodes.forEach((n) => {
    d.path(rect(n.x, n.y, layout.nodeWidth, n.height), n.color, 'white', `${n.label}: ${n.value}`);
    d.text(
      n.x + (n.layer === 0 ? -6 : layout.nodeWidth + 6),
      n.y + n.height / 2 + 4,
      n.label,
      n.layer === 0 ? 'end' : 'start',
    );
  });
  return d.done('Sankey');
}
/** Each weighted record carries one category per stage. Matching categories in adjacent stages are aggregated. */
export interface AlluvialRow {
  readonly stages: readonly string[];
  readonly value: number;
}
/** Aggregate weighted stage transitions and render a layered alluvial chart. */
export function alluvialChart(rows: readonly AlluvialRow[], options: SankeyOptions = {}): ExtraChart {
  const count = rows[0]?.stages.length ?? 0;
  if (count < 2 || count > 129) fail('Alluvial needs 2..129 stages');
  const nodes = new Map<string, FlowNode>(),
    links = new Map<string, FlowLink>(),
    layers: Record<string, number> = {};
  rows.forEach((row) => {
    if (row.stages.length !== count || !Number.isFinite(row.value) || row.value <= 0)
      fail('Alluvial rows must have equal stages and positive finite values');
    row.stages.forEach((s, i) => {
      const id = JSON.stringify([i, s]);
      nodes.set(id, { id, label: s });
      layers[id] = i;
      if (i) {
        const source = JSON.stringify([i - 1, row.stages[i - 1]]),
          key = JSON.stringify([source, id]),
          old = links.get(key);
        links.set(key, { source, target: id, value: (old?.value ?? 0) + row.value });
      }
    });
  });
  const c = sankeyChart([...nodes.values()], [...links.values()], { ...options, layers });
  return new ExtraChart('Alluvial', c.marks, c.labels);
}
/** Each radar spoke has an independent finite increasing domain, default [0,max(series values,1)]. */
export interface RadarAxis {
  readonly label: string;
  readonly domain?: readonly [number, number];
}
/** One value per spoke; color defaults to the categorical palette. */
export interface RadarSeries {
  readonly label: string;
  readonly values: readonly number[];
  readonly color?: string;
}
/** Draw radial series using a separate labelled scale for each spoke. */
export function radarChart(axes: readonly RadarAxis[], series: readonly RadarSeries[]): ExtraChart {
  if (axes.length < 3 || !series.length) fail('Radar needs at least three axes and one series');
  series.forEach((s) => {
    if (s.values.length !== axes.length) fail('Radar values must match axes');
    finite(...s.values);
  });
  const d = new Drawing(),
    n = axes.length;
  for (let j = 1; j <= 5; j++)
    d.path(
      line(
        axes.map((_, i) => point((i * tau) / n, j * 48)),
        true,
      ),
    );
  const domains = axes.map((a, i) => a.domain ?? ([0, Math.max(1, ...series.map((s) => s.values[i]))] as const));
  domains.forEach((r) => {
    finite(...r);
    if (r[1] <= r[0]) fail('Radar domains must increase');
  });
  axes.forEach((a, i) => {
    d.path(line([[500, 310], point((i * tau) / n, 240)]));
    const p = point((i * tau) / n, 270);
    d.text(p[0], p[1], a.label);
    for (let j = 1; j <= 5; j++) {
      const p = point((i * tau) / n, j * 48);
      d.text(p[0] + 6, p[1] + 4, (domains[i][0] + ((domains[i][1] - domains[i][0]) * j) / 5).toPrecision(2), 'start');
    }
  });
  series.forEach((s, k) => {
    const p = s.values.map((v, i) => {
      const [lo, hi] = domains[i];
      if (v < lo || v > hi) fail('Radar value outside domain');
      return point((i * tau) / n, (240 * (v - lo)) / (hi - lo));
    });
    d.path(line(p, true), 'none', s.color ?? colors[k % colors.length], s.label, 2);
    d.text(810, 70 + k * 23, s.label, 'start');
  });
  return d.done('Radar');
}
/** UTC ISO date YYYY-MM-DD; duplicate days reject. Missing days are left empty. */
export interface CalendarValue {
  readonly date: string;
  readonly value: number;
}
/** UTC year defaults to first observation year; weekStart Monday, range data including zero. */
export interface CalendarOptions {
  readonly year?: number;
  readonly weekStart?: 0 | 1;
  readonly range?: readonly [number, number];
}
/** Draw every day of a UTC year, with month/week axes and a numeric color key. */
export function calendarHeatmap(values: readonly CalendarValue[], options: CalendarOptions = {}): ExtraChart {
  const year = options.year ?? Number(values[0]?.date.slice(0, 4)),
    weekStart = options.weekStart ?? 1;
  if (!Number.isInteger(year) || year < 100 || year > 9998 || (weekStart !== 0 && weekStart !== 1))
    fail('Calendar year must be in [100,9998]');
  const dates = new Map<string, number>();
  values.forEach((v) => {
    const t = Date.parse(v.date + 'T00:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(v.date) ||
      !Number.isFinite(t) ||
      new Date(t).toISOString().slice(0, 10) !== v.date ||
      dates.has(v.date)
    )
      fail('Calendar requires unique valid UTC dates');
    finite(v.value);
    dates.set(v.date, v.value);
  });
  const a = values.filter((v) => Number(v.date.slice(0, 4)) === year).map((v) => v.value),
    range = options.range ?? [Math.min(...a, 0), Math.max(...a, 1)];
  finite(...range);
  if (range[1] <= range[0]) fail('Calendar color range must increase');
  const d = new Drawing(),
    start = Date.UTC(year, 0, 1),
    offset = (new Date(start).getUTCDay() - weekStart + 7) % 7,
    day = 86400000,
    size = 15;
  for (let t = start; t < Date.UTC(year + 1, 0, 1); t += day) {
    const date = new Date(t),
      i = Math.round((t - start) / day),
      x = 85 + Math.floor((i + offset) / 7) * size,
      y = 200 + ((i + offset) % 7) * size,
      key = date.toISOString().slice(0, 10),
      v = dates.get(key);
    let color = '#eef2f3';
    if (v !== undefined) {
      const u = Math.max(0, Math.min(1, (v - range[0]) / (range[1] - range[0])));
      color = `rgb(${Math.round(235 - 200 * u)},${Math.round(245 - 120 * u)},${Math.round(250 - 80 * u)})`;
    }
    d.path(rect(x, y, size - 1, size - 1), color, 'none', `${key}: ${v ?? 'missing'}`);
    if (date.getUTCDate() === 1)
      d.text(x + 8, 180, date.toLocaleString('en', { month: 'short', timeZone: 'UTC' }), 'start');
  }
  for (let i = 0; i < 7; i++)
    d.text(72, 212 + i * size, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][(i + weekStart) % 7], 'end');
  for (let i = 0; i <= 5; i++) {
    const u = i / 5;
    d.path(
      rect(290 + i * 65, 370, 65, 14),
      `rgb(${Math.round(235 - 200 * u)},${Math.round(245 - 120 * u)},${Math.round(250 - 80 * u)})`,
      'none',
    );
    d.text(290 + i * 65, 410, (range[0] + u * (range[1] - range[0])).toPrecision(3), 'start');
  }
  d.text(500, 460, String(year));
  return d.done('Calendar heatmap');
}
