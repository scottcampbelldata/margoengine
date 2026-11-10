// Clean room: Nielson/Hamann 1991, Bowyer 1981, Watson 1981. See docs/clean-room.md.
import { rangeError } from '../../shared/errors.js';
import { delaunay2D } from './contour2d-triangulate.js';

/** Coordinate and scalar value. NaN scalars mask incident cells; coordinates must be finite. */
export type ContourPoint2D = readonly [number, number, number];
/** Rectilinear coordinates, strictly ascending or descending; values are x-fastest. */
export interface ContourGrid2D {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly values: ArrayLike<number>;
}
/** A continuous isoline in data coordinates, including its closing point when closed. */
export interface Isoline2D {
  readonly level: number;
  readonly points: readonly (readonly [number, number])[];
  readonly closed: boolean;
}
/** Polygon rings use even-odd filling. Cell boundaries cancel; nested rings represent holes. */
export interface ContourBand2D {
  readonly lower: number;
  readonly upper: number;
  readonly rings: readonly (readonly (readonly [number, number])[])[];
}
/** Owned vector output; no DOM, renderer, file access or import-time side effects. */
export interface Contours2D {
  readonly lines: readonly Isoline2D[];
  readonly bands: readonly ContourBand2D[];
  readonly bounds: readonly [number, number, number, number];
}
/** At most 256 finite strictly increasing levels. Bands span adjacent levels. */
export interface ContourOptions2D {
  readonly levels: readonly number[];
  readonly signal?: AbortSignal;
}
type Vertex = { x: number; y: number; v: number; key: string };
type Segment = readonly [Vertex, Vertex];
const fail = (s: string): never => {
  throw rangeError(s, 'sciviz');
};
const xy = (p: Vertex): [number, number] => [p.x, p.y];
const same = (a: Vertex, b: Vertex) => a.x === b.x && a.y === b.y;

function cut(a: Vertex, b: Vertex, t: number): Vertex {
  if (a.v === t) return a;
  if (b.v === t) return b;
  // Canonical endpoint order makes shared intersections bit-identical.
  if (a.key > b.key) [a, b] = [b, a];
  const u = (t - a.v) / (b.v - a.v);
  return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y), v: t, key: `${a.key}:${b.key}` };
}

function section(p: Vertex[], t: number): { segments: Segment[]; rings: Vertex[][] } {
  const edges: Segment[] = [],
    crossings: { edge: number; p: Vertex }[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length],
      ah = a.v >= t,
      bh = b.v >= t;
    if (ah && bh) edges.push([a, b]);
    else if (ah !== bh) {
      const c = cut(a, b, t);
      crossings.push({ edge: i, p: c });
      edges.push(ah ? [a, c] : [c, b]);
    }
  }
  const segments: Segment[] = [];
  if (crossings.length === 2) segments.push([crossings[0].p, crossings[1].p]);
  if (crossings.length === 4) {
    const v = p.map((a) => a.v - t),
      scale = Math.max(...v.map(Math.abs));
    // Bilinear asymptotic decider; scaling prevents overflow. Exact ties use the 0-2 diagonal.
    const q = (v[0] / scale) * (v[2] / scale) - (v[1] / scale) * (v[3] / scale);
    for (const [a, b] of q >= 0
      ? [
          [0, 1],
          [2, 3],
        ]
      : [
          [0, 3],
          [1, 2],
        ])
      segments.push([crossings[a].p, crossings[b].p]);
  }
  const valid = segments.filter(([a, b]) => !same(a, b));
  // Boundary edges and the cuts form the complete superlevel polygon boundary.
  edges.push(...segments);
  const rings = chains(edges.filter(([a, b]) => !same(a, b)))
    .filter((r) => r.closed)
    .map((r) => r.vertices);
  return { segments: valid, rings };
}

function chains(edges: Segment[]): { vertices: Vertex[]; closed: boolean }[] {
  const adjacent = new Map<string, number[]>(),
    used = new Set<number>();
  edges.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const ids = adjacent.get(p.key) ?? [];
      ids.push(i);
      adjacent.set(p.key, ids);
    }
  });
  const out: { vertices: Vertex[]; closed: boolean }[] = [];
  const walk = (i: number, start: Vertex) => {
    const vertices = [start];
    let p = start;
    while (!used.has(i)) {
      used.add(i);
      const edge = edges[i];
      p = edge[0].key === p.key ? edge[1] : edge[0];
      vertices.push(p);
      if (p.key === start.key) break;
      const next = adjacent.get(p.key)?.find((k) => !used.has(k));
      if (next === undefined) break;
      i = next;
    }
    out.push({ vertices, closed: p.key === start.key });
  };
  // Open chains first: starting in their middle would split a continuous isoline.
  for (const [key, ids] of adjacent)
    if (ids.length === 1 && !used.has(ids[0])) {
      const edge = edges[ids[0]];
      walk(ids[0], edge[0].key === key ? edge[0] : edge[1]);
    }
  edges.forEach((e, i) => {
    if (!used.has(i)) walk(i, e[0]);
  });
  return out;
}

async function compute(points: Vertex[], cells: number[][], options: ContourOptions2D): Promise<Contours2D> {
  const { levels, signal } = options;
  signal?.throwIfAborted();
  if (
    levels.length < 1 ||
    levels.length > 256 ||
    levels.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= levels[i - 1]))
  )
    fail('contour2d levels must be 1 to 256 finite strictly increasing numbers');
  if (cells.length * levels.length > 4_000_000)
    fail('contour2d supports at most 4000000 cell-level combinations; reduce the grid or level count');
  const all = levels.map(() => [] as Segment[]),
    rings = levels.slice(1).map(() => [] as Vertex[][]);
  for (let i = 0; i < cells.length; i++) {
    if (i % 1024 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
      signal?.throwIfAborted();
    }
    const cell = cells[i].map((k) => points[k]);
    if (cell.some((p) => Number.isNaN(p.v))) continue;
    const sections = levels.map((t) => section(cell, t));
    sections.forEach((s, k) => all[k].push(...s.segments));
    for (let k = 0; k < rings.length; k++) rings[k].push(...sections[k].rings, ...sections[k + 1].rings);
  }
  signal?.throwIfAborted();
  const bounds: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of points) {
    bounds[0] = Math.min(bounds[0], p.x);
    bounds[1] = Math.max(bounds[1], p.x);
    bounds[2] = Math.min(bounds[2], p.y);
    bounds[3] = Math.max(bounds[3], p.y);
  }
  return {
    bounds,
    lines: all.flatMap((s, k) =>
      chains(s).map((c) => ({ level: levels[k], points: c.vertices.map(xy), closed: c.closed })),
    ),
    bands: rings.map((r, k) => ({ lower: levels[k], upper: levels[k + 1], rings: r.map((p) => p.map(xy)) })),
  };
}

/** Marching squares with bilinear saddle disambiguation, stitched lines and polygon bands. */
export async function contour2D(grid: ContourGrid2D, options: ContourOptions2D): Promise<Contours2D> {
  options.signal?.throwIfAborted();
  const x = Array.from(grid.x),
    y = Array.from(grid.y),
    values = Array.from(grid.values);
  if (x.length < 2 || y.length < 2 || x.length * y.length > 1_000_000 || values.length !== x.length * y.length)
    fail('contour2d requires at least 2 x 2 and at most 1000000 grid samples with matching values');
  for (const a of [x, y])
    if (
      a.some(
        (v, i) => !Number.isFinite(v) || Math.abs(v) > 1e100 || (i > 0 && (v - a[i - 1]) * Math.sign(a[1] - a[0]) <= 0),
      )
    )
      fail('contour2d coordinates must be finite, monotone and at most 1e100 in magnitude');
  if (values.some((v) => !Number.isNaN(v) && (!Number.isFinite(v) || Math.abs(v) > 1e100)))
    fail('contour2d scalars must be finite up to 1e100 or NaN');
  const points = values.map((v, i) => ({ x: x[i % x.length], y: y[Math.floor(i / x.length)], v, key: String(i) })),
    cells: number[][] = [];
  for (let j = 0; j < y.length - 1; j++)
    for (let i = 0; i < x.length - 1; i++) {
      const k = j * x.length + i;
      cells.push([k, k + 1, k + x.length + 1, k + x.length]);
    }
  return compute(points, cells, { ...options, levels: [...options.levels] });
}

/** Bowyer-Watson Delaunay interpolation inside the convex hull. Coincident sites reject. */
export async function scatteredContour2D(
  input: readonly ContourPoint2D[],
  options: ContourOptions2D,
): Promise<Contours2D> {
  options.signal?.throwIfAborted();
  options = { ...options, levels: [...options.levels] };
  if (input.length < 3 || input.length > 10000) fail('scatteredContour2D supports 3 to 10000 sites');
  const points = input.map(([x, y, v], i) => {
    if (
      ![x, y].every(Number.isFinite) ||
      Math.max(Math.abs(x), Math.abs(y)) > 1e100 ||
      (!Number.isNaN(v) && (!Number.isFinite(v) || Math.abs(v) > 1e100))
    )
      fail('Invalid scattered contour coordinate or scalar');
    return { x, y, v, key: String(i) };
  });
  const cells = await delaunay2D(points, options.signal);
  return compute(points, cells, { ...options, levels: [...options.levels] });
}

/** SVG defaults: 800 x 500, 36 px padding, labels on, 1 px lines and a blue-red band palette. */
export interface ContourSVGOptions {
  readonly width?: number;
  readonly height?: number;
  readonly padding?: number;
  readonly labels?: boolean;
  readonly lineColor?: string;
  readonly lineWidth?: number;
  readonly colors?: readonly string[];
  readonly title?: string;
}
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Standalone vector SVG, polygon bands with holes and rotated inline labels with a background halo. */
export function contourSVG(data: Contours2D, options: ContourSVGOptions = {}): string {
  const {
    width = 800,
    height = 500,
    padding = 36,
    labels = true,
    lineColor = '#263744',
    lineWidth = 1,
    title = 'Contour plot',
    colors = ['#d9edf7', '#8ac8db', '#4b9ac3', '#f4d58d', '#e99b66', '#be5148'],
  } = options;
  if (
    ![width, height, padding, lineWidth].every(Number.isFinite) ||
    padding < 0 ||
    lineWidth < 0 ||
    width <= 2 * padding ||
    height <= 2 * padding ||
    colors.length === 0
  )
    fail('Invalid contour SVG dimensions, padding, line width or palette');
  const [x0, x1, y0, y1] = data.bounds;
  if (!(x1 > x0 && y1 > y0)) fail('Contour SVG requires nonzero x and y extents');
  const project = ([x, y]: readonly number[]) => [
    padding + ((x - x0) / (x1 - x0)) * (width - 2 * padding),
    height - padding - ((y - y0) / (y1 - y0)) * (height - 2 * padding),
  ];
  const path = (p: readonly (readonly number[])[]) =>
    p.map((a, i) => `${i ? 'L' : 'M'}${project(a).join(',')}`).join('');
  const bands = data.bands
    .map(
      (b, i) =>
        `<path fill="${escape(colors[i % colors.length])}" fill-rule="evenodd" d="${b.rings.map((r) => path(r) + 'Z').join('')}"/>`,
    )
    .join('');
  const lines = data.lines
    .map((l) => `<path fill="none" stroke="${escape(lineColor)}" stroke-width="${lineWidth}" d="${path(l.points)}"/>`)
    .join('');
  const text = labels
    ? data.lines
        .map((l) => {
          const p = l.points.map(project),
            lengths = p.slice(1).map((b, i) => Math.hypot(b[0] - p[i][0], b[1] - p[i][1])),
            total = lengths.reduce((a, b) => a + b, 0);
          if (total < 48) return '';
          let d = total / 2,
            i = 0;
          while (i < lengths.length - 1 && d > lengths[i]) d -= lengths[i++];
          const a = p[i],
            b = p[i + 1],
            u = lengths[i] ? d / lengths[i] : 0,
            x = a[0] + u * (b[0] - a[0]),
            y = a[1] + u * (b[1] - a[1]);
          let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
          if (angle > 90) angle -= 180;
          if (angle < -90) angle += 180;
          return `<text transform="translate(${x},${y}) rotate(${angle})" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="12" fill="${escape(lineColor)}" stroke="white" stroke-width="4" paint-order="stroke">${l.level}</text>`;
        })
        .join('')
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"><title>${escape(title)}</title>${bands}${lines}${text}</svg>`;
}
