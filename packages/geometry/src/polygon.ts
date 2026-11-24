// 2D polygon booleans and offsets. Every input point goes onto one integer grid, so all later tests are exact. Segments
// are cut where they cross by snap rounding (J. Hobby, "Practical segment intersection with finite precision output",
// 1999): any segment passing through the grid cell of a vertex or a crossing bends to that cell's centre. A plane sweep
// then gives each edge the winding numbers on its two sides, and the edges with the result on exactly one side are
// joined into rings. An offset is the same sweep run over the outline moved sideways, keeping what it winds around.
import { Path, Shape } from './path.js';
import type { MutableVec2 } from './math.js';

/** Grid coordinates stay within plus or minus this, so every product below fits a double exactly. */
const GRID = 2 ** 25;
/** Multiplier that packs a grid point into one number. */
const ROW = 2 ** 27;
/** Largest item list searched pair by pair. */
const LEAF = 24;

/** How rings count as filled. */
export type PolygonFillRule = 'positive' | 'nonzero' | 'evenodd';
/** How an offset or stroke turns a corner. */
export type PolygonJoin = 'miter' | 'round' | 'bevel';
/** How a stroke ends. */
export type PolygonCap = 'butt' | 'round' | 'square';

/** One filled region: a counter-clockwise outline and the clockwise holes cut out of it. */
export interface Polygon {
  contour: MutableVec2[];
  holes: MutableVec2[][];
}

/** A ring of points, a {@link Polygon}, a `Shape`, or a list of any of these. */
export type PolygonInput = readonly MutableVec2[] | Polygon | Shape | readonly PolygonInput[];

/** Options of the boolean functions. */
export interface PolygonOptions {
  /**
   * `'positive'` (default) turns outlines counter-clockwise and holes clockwise first, so ring direction does not
   * matter and a hole cuts only its own outline. `'nonzero'` and `'evenodd'` keep each ring's direction, for outlines
   * that cross themselves.
   */
  fillRule?: PolygonFillRule;
  /** Points per curve when an input is a `Shape`. Default 12. */
  curveSegments?: number;
}

/** Options of {@link polygonOffset}. */
export interface PolygonOffsetOptions extends PolygonOptions {
  /** Corner style. Default `'miter'`. */
  join?: PolygonJoin;
  /** Longest miter as a multiple of the distance, as in SVG; longer ones become bevels. Default 4. */
  miterLimit?: number;
  /** Largest gap between a round join and its chords. Default 1/500 of the distance. */
  arcTolerance?: number;
}

/** Options of {@link polygonStroke}. */
export interface PolygonStrokeOptions extends Omit<PolygonOffsetOptions, 'fillRule' | 'curveSegments'> {
  /** How the two ends look. Default `'butt'`. */
  cap?: PolygonCap;
  /** Joins the last point to the first, giving a band with no ends. Default false. */
  closed?: boolean;
}

/** A grid segment from its lower end a to its higher end b, with how much it adds to each operand's winding. */
interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Winding of each operand gained going from the right of a->b to its left. */
  windA: number;
  windB: number;
  /** Winding of each operand on the left of a->b; set by the sweep. */
  leftA: number;
  leftB: number;
  /** Grid points this segment must pass through, x then y. */
  splits: number[];
}

/** A result edge, directed so the result lies on its left. */
interface Arc {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  used: boolean;
}

type Inside = (winding: number) => boolean;

/** Maps doubles to the grid and back. The scale is a power of two, so scaling loses nothing. */
class Lattice {
  private scale = 1;
  private cx = 0;
  private cy = 0;
  /** Input values by grid point, so vertices that did not move come back exactly as given. */
  private originals = new Map<number, MutableVec2>();

  constructor(rings: readonly (readonly MutableVec2[])[]) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const ring of rings)
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    const half = Math.max(maxX / 2 - minX / 2, maxY / 2 - minY / 2);
    if (!(half > 0)) return;
    this.scale = 2 ** Math.min(1023, Math.max(-1022, Math.floor(Math.log2(GRID / half))));
    // log2 can round up across a power of two.
    if (half * this.scale > GRID) this.scale /= 2;
    this.cx = Math.round((minX / 2 + maxX / 2) * this.scale);
    this.cy = Math.round((minY / 2 + maxY / 2) * this.scale);
  }

  /** The grid point of (x, y), remembered as coming from there. */
  snap(x: number, y: number): MutableVec2 {
    const gx = Math.round(x * this.scale - this.cx),
      gy = Math.round(y * this.scale - this.cy),
      key = pack(gx, gy);
    if (!this.originals.has(key)) this.originals.set(key, [x, y]);
    return [gx, gy];
  }

  point(x: number, y: number): MutableVec2 {
    const original = this.originals.get(pack(x, y));
    return original ? [original[0], original[1]] : [(x + this.cx) / this.scale, (y + this.cy) / this.scale];
  }
}

const pack = (x: number, y: number): number => (x + GRID + 2) * ROW + y + GRID + 2;

/** Positive when c is left of a->b. Exact on the grid. */
const side = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Twice the signed area of a ring. */
function ringArea(ring: readonly MutableVec2[]): number {
  let sum = 0;
  const [ox, oy] = ring[0] ?? [0, 0];
  for (let i = 1; i + 1 < ring.length; i++)
    sum += (ring[i][0] - ox) * (ring[i + 1][1] - oy) - (ring[i][1] - oy) * (ring[i + 1][0] - ox);
  return sum;
}

const turned = (ring: MutableVec2[], area: number): MutableVec2[] =>
  ringArea(ring) * area < 0 ? ring.slice().reverse() : ring;

function ringOf(points: readonly MutableVec2[]): MutableVec2[] {
  for (const p of points)
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new RangeError('Invalid polygon point; pass finite [x, y] pairs');
  return points as MutableVec2[];
}

const isShape = (input: object): input is Shape => 'extractPoints' in input;
const isPolygon = (input: object): input is Polygon => 'contour' in input;

/** Flattens an input into rings, turned as the fill rule asks. */
function collect(input: PolygonInput, rule: PolygonFillRule, segments: number, out: MutableVec2[][]): MutableVec2[][] {
  const add = (contour: readonly MutableVec2[], holes: readonly (readonly MutableVec2[])[]) => {
    out.push(rule === 'positive' ? turned(ringOf(contour), 1) : ringOf(contour));
    for (const hole of holes) out.push(rule === 'positive' ? turned(ringOf(hole), -1) : ringOf(hole));
  };
  if (Array.isArray(input)) {
    if (typeof input[0]?.[0] === 'number') add(input as readonly MutableVec2[], []);
    else for (const item of input as readonly PolygonInput[]) collect(item, rule, segments, out);
  } else if (isShape(input as object)) {
    const { shape, holes } = (input as Shape).extractPoints(segments);
    add(shape, holes);
  } else if (isPolygon(input as object)) {
    const { contour, holes } = input as Polygon;
    add(contour, holes ?? []);
  } else throw new TypeError('Invalid polygon input; pass a ring of [x, y] points, a Polygon, a Shape or a list');
  return out;
}

/** Puts every segment low end first, then adds up copies of the same segment and drops those that cancel. */
function merged(segments: Segment[]): Segment[] {
  for (const s of segments)
    if (s.ax > s.bx || (s.ax === s.bx && s.ay > s.by)) {
      [s.ax, s.bx, s.ay, s.by] = [s.bx, s.ax, s.by, s.ay];
      s.windA = -s.windA;
      s.windB = -s.windB;
    }
  segments.sort((p, q) => p.ax - q.ax || p.ay - q.ay || p.bx - q.bx || p.by - q.by);
  const out: Segment[] = [];
  for (const s of segments) {
    if (s.ax === s.bx && s.ay === s.by) continue;
    const last = out[out.length - 1];
    if (last && last.ax === s.ax && last.ay === s.ay && last.bx === s.bx && last.by === s.by) {
      last.windA += s.windA;
      last.windB += s.windB;
    } else out.push(s);
  }
  return out.filter((s) => s.windA !== 0 || s.windB !== 0);
}

const segment = (ax: number, ay: number, bx: number, by: number, windA: number, windB: number): Segment => ({
  ax,
  ay,
  bx,
  by,
  windA,
  windB,
  leftA: 0,
  leftB: 0,
  splits: [],
});

/** Whether a segment comes within a cell of the box. */
function nearBox(s: Segment, x0: number, y0: number, x1: number, y1: number): boolean {
  if (s.bx < x0 - 1 || s.ax > x1 + 1 || Math.max(s.ay, s.by) < y0 - 1 || Math.min(s.ay, s.by) > y1 + 1) return false;
  const dx = s.bx - s.ax,
    dy = s.by - s.ay;
  return (
    Math.abs(dx * ((y0 + y1) / 2 - s.ay) - dy * ((x0 + x1) / 2 - s.ax)) <=
    ((x1 - x0) / 2 + 1) * Math.abs(dy) + ((y1 - y0) / 2 + 1) * Math.abs(dx)
  );
}

/** Halves the box until few items remain, and hands each small list to `leaf`. Dense spots get small boxes. */
function search(
  items: Segment[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  leaf: (items: Segment[]) => void,
): void {
  if (items.length > LEAF && (x1 - x0 > 2 || y1 - y0 > 2)) {
    const wide = x1 - x0 >= y1 - y0;
    for (const alongX of [wide, !wide]) {
      const midX = (x0 + x1) / 2,
        midY = (y0 + y1) / 2,
        low = items.filter((s) => (alongX ? nearBox(s, x0, y0, midX, y1) : nearBox(s, x0, y0, x1, midY))),
        high = items.filter((s) => (alongX ? nearBox(s, midX, y0, x1, y1) : nearBox(s, x0, midY, x1, y1)));
      // Splitting pays only while most items fall on one side.
      if (low.length + high.length > items.length * 1.5) continue;
      if (alongX) {
        search(low, x0, y0, midX, y1, leaf);
        search(high, midX, y0, x1, y1, leaf);
      } else {
        search(low, x0, y0, x1, midY, leaf);
        search(high, x0, midY, x1, y1, leaf);
      }
      return;
    }
  }
  leaf(items);
}

/** Records where p and q properly cross, as a grid point both must pass through. */
function crossing(p: Segment, q: Segment, hot: Map<number, Segment>): void {
  if (p.bx < q.ax || q.bx < p.ax) return;
  if (Math.max(p.ay, p.by) < Math.min(q.ay, q.by) || Math.max(q.ay, q.by) < Math.min(p.ay, p.by)) return;
  const c = side(p.ax, p.ay, p.bx, p.by, q.ax, q.ay),
    d = side(p.ax, p.ay, p.bx, p.by, q.bx, q.by);
  if ((c > 0 && d > 0) || (c < 0 && d < 0) || c === 0 || d === 0) return;
  const e = side(q.ax, q.ay, q.bx, q.by, p.ax, p.ay),
    f = side(q.ax, q.ay, q.bx, q.by, p.bx, p.by);
  if ((e > 0 && f > 0) || (e < 0 && f < 0) || e === 0 || f === 0) return;
  const t = c / (c - d),
    x = Math.round(q.ax + (q.bx - q.ax) * t),
    y = Math.round(q.ay + (q.by - q.ay) * t);
  addHot(hot, x, y);
  p.splits.push(x, y);
  q.splits.push(x, y);
}

function addHot(hot: Map<number, Segment>, x: number, y: number): void {
  const key = pack(x, y);
  if (!hot.has(key)) hot.set(key, segment(x, y, x, y, 0, 0));
}

/** Cuts the segments until they meet only at shared end points. */
function arrange(input: Segment[]): Segment[] {
  let segments = merged(input);
  const edge = GRID + 1;
  for (;;) {
    const hot = new Map<number, Segment>();
    for (const s of segments) {
      addHot(hot, s.ax, s.ay);
      addHot(hot, s.bx, s.by);
    }
    search(segments, -edge, -edge, edge, edge, (items) => {
      for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++) crossing(items[i], items[j], hot);
    });
    search(segments.concat([...hot.values()]), -edge, -edge, edge, edge, (items) => {
      for (const s of items) {
        if (s.ax === s.bx && s.ay === s.by) continue;
        const dx = s.bx - s.ax,
          dy = s.by - s.ay,
          reach = Math.abs(dx) + Math.abs(dy),
          low = Math.min(s.ay, s.by),
          high = Math.max(s.ay, s.by);
        for (const h of items) {
          if (h.ax !== h.bx || h.ay !== h.by || h.ax < s.ax || h.ax > s.bx || h.ay < low || h.ay > high) continue;
          // The cell around h is one wide: the segment reaches it when the cell's corners are not all on one side.
          if (2 * Math.abs(dx * (h.ay - s.ay) - dy * (h.ax - s.ax)) <= reach) s.splits.push(h.ax, h.ay);
        }
      }
    });
    const next: Segment[] = [];
    let changed = false;
    for (const s of segments) {
      const stops: MutableVec2[] = [];
      for (let i = 0; i < s.splits.length; i += 2) {
        const x = s.splits[i],
          y = s.splits[i + 1];
        if ((x !== s.ax || y !== s.ay) && (x !== s.bx || y !== s.by)) stops.push([x, y]);
      }
      s.splits = [];
      if (!stops.length) {
        next.push(s);
        continue;
      }
      changed = true;
      const dx = s.bx - s.ax,
        dy = s.by - s.ay,
        along = (p: MutableVec2) => (p[0] - s.ax) * dx + (p[1] - s.ay) * dy;
      stops.sort((p, q) => along(p) - along(q));
      let x = s.ax,
        y = s.ay;
      for (const [px, py] of [...stops, [s.bx, s.by]]) {
        next.push(segment(x, y, px, py, s.windA, s.windB));
        x = px;
        y = py;
      }
    }
    segments = merged(next);
    if (!changed) return segments;
  }
}

/** Walks a vertical line left to right, giving every segment the winding numbers on its left. */
function sweep(segments: Segment[]): void {
  const ends = segments.slice().sort((p, q) => p.bx - q.bx || p.by - q.by),
    active: Segment[] = [];
  let start = 0,
    end = 0;
  while (end < ends.length) {
    const e = ends[end],
      s = segments[start],
      fromStart = s && (s.ax < e.bx || (s.ax === e.bx && s.ay <= e.by)),
      x = fromStart ? s.ax : e.bx,
      y = fromStart ? s.ay : e.by;
    // The first active segment that this point is not above.
    let low = 0,
      high = active.length;
    while (low < high) {
      const mid = (low + high) >> 1,
        m = active[mid];
      if (side(m.ax, m.ay, m.bx, m.by, x, y) > 0) low = mid + 1;
      else high = mid;
    }
    let removed = 0;
    while (end < ends.length && ends[end].bx === x && ends[end].by === y) {
      removed++;
      end++;
    }
    const added: Segment[] = [];
    while (start < segments.length && segments[start].ax === x && segments[start].ay === y)
      added.push(segments[start++]);
    // From the lowest direction up.
    added.sort((p, q) => (q.bx - x) * (p.by - y) - (q.by - y) * (p.bx - x));
    const below = active[low - 1];
    let windA = below ? below.leftA : 0,
      windB = below ? below.leftB : 0;
    for (const s of added) {
      s.leftA = windA += s.windA;
      s.leftB = windB += s.windB;
    }
    active.splice(low, removed, ...added);
  }
}

/** Of the arcs leaving the end of `arc`, the first one clockwise from the way back, which keeps the result on the left. */
function nextArc(arc: Arc, leaving: readonly Arc[]): Arc | undefined {
  const open = leaving.filter((a) => !a.used);
  if (open.length < 2) return open[0];
  const rx = arc.x0 - arc.x1,
    ry = arc.y0 - arc.y1,
    half = (a: Arc) => (rx * (a.y1 - a.y0) - ry * (a.x1 - a.x0) > 0 ? 1 : 0);
  let best = open[0];
  for (const a of open) {
    const order =
      half(a) - half(best) ||
      (a.x1 - a.x0) * (best.y1 - best.y0) - (a.y1 - a.y0) * (best.x1 - best.x0);
    if (order < 0) best = a;
  }
  return best;
}

/** Cuts a ring that visits a point twice into rings that do not. */
function splitAtRepeats(ring: readonly MutableVec2[], out: MutableVec2[][]): void {
  const stack: MutableVec2[] = [],
    seen = new Map<number, number>();
  for (const p of ring) {
    const key = pack(p[0], p[1]),
      at = seen.get(key);
    if (at === undefined) {
      seen.set(key, stack.length);
      stack.push(p);
    } else {
      const loop = stack.splice(at + 1);
      for (const q of loop) seen.delete(pack(q[0], q[1]));
      loop.unshift(p);
      out.push(loop);
    }
  }
  out.push(stack);
}

/** Drops points on a straight run. */
function withoutStraightRuns(ring: readonly MutableVec2[]): MutableVec2[] {
  const out: MutableVec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length],
      b = ring[i],
      c = ring[(i + 1) % ring.length];
    if (side(a[0], a[1], b[0], b[1], c[0], c[1]) !== 0) out.push(b);
  }
  return out;
}

/** Whether the point halfway along a ring's first edge is inside `outer`. It cannot be on it: edges meet only at ends. */
function contains(outer: readonly MutableVec2[], ring: readonly MutableVec2[]): boolean {
  const x2 = ring[0][0] + ring[1][0],
    y2 = ring[0][1] + ring[1][1];
  let inside = false;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = outer[j],
      b = outer[i];
    if (a[1] * 2 > y2 === b[1] * 2 > y2) continue;
    const across = (b[0] - a[0]) * (y2 - 2 * a[1]) - (b[1] - a[1]) * (x2 - 2 * a[0]);
    if (b[1] > a[1] ? across > 0 : across < 0) inside = !inside;
  }
  return inside;
}

/** Joins the result edges into polygons. */
function assemble(arcs: Arc[], lattice: Lattice): Polygon[] {
  const leaving = new Map<number, Arc[]>();
  for (const arc of arcs) {
    const key = pack(arc.x0, arc.y0),
      list = leaving.get(key);
    if (list) list.push(arc);
    else leaving.set(key, [arc]);
  }
  const rings: MutableVec2[][] = [];
  for (const first of arcs) {
    if (first.used) continue;
    const walk: MutableVec2[] = [];
    let arc: Arc | undefined = first;
    while (arc) {
      arc.used = true;
      walk.push([arc.x0, arc.y0]);
      arc = nextArc(arc, leaving.get(pack(arc.x1, arc.y1))!);
    }
    splitAtRepeats(walk, rings);
  }
  const outers: { ring: MutableVec2[]; area: number; holes: MutableVec2[][] }[] = [],
    holes: MutableVec2[][] = [];
  for (const raw of rings) {
    const ring = withoutStraightRuns(raw);
    if (ring.length < 3) continue;
    const area = ringArea(ring);
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      perimeter += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    }
    // No wider than the grid: what is left of an exact touch after rounding.
    if (Math.abs(area) <= perimeter) continue;
    if (area > 0) outers.push({ ring, area, holes: [] });
    else holes.push(ring);
  }
  outers.sort((p, q) => p.area - q.area);
  for (const hole of holes) outers.find((o) => contains(o.ring, hole))?.holes.push(hole);
  const real = (ring: MutableVec2[]) => ring.map((p) => lattice.point(p[0], p[1]));
  return outers.reverse().map((o) => ({ contour: real(o.ring), holes: o.holes.map(real) }));
}

const fills: Record<PolygonFillRule, Inside> = {
  positive: (w) => w > 0,
  nonzero: (w) => w !== 0,
  evenodd: (w) => (w & 1) !== 0,
};

/** The boolean itself: `keep` says whether a point in or out of each operand belongs to the result. */
function combine(
  a: readonly MutableVec2[][],
  b: readonly MutableVec2[][],
  rule: PolygonFillRule,
  keep: (inA: boolean, inB: boolean) => boolean,
): Polygon[] {
  const lattice = new Lattice([...a, ...b]),
    segments: Segment[] = [],
    add = (rings: readonly MutableVec2[][], windA: number, windB: number) => {
      for (const ring of rings) {
        const grid = ring.map((p) => lattice.snap(p[0], p[1]));
        for (let i = 0; i < grid.length; i++) {
          const p = grid[i],
            q = grid[(i + 1) % grid.length];
          segments.push(segment(p[0], p[1], q[0], q[1], windA, windB));
        }
      }
    };
  add(a, 1, 0);
  add(b, 0, 1);
  const edges = arrange(segments),
    inside = fills[rule],
    arcs: Arc[] = [];
  sweep(edges);
  for (const s of edges) {
    const left = keep(inside(s.leftA), inside(s.leftB)),
      right = keep(inside(s.leftA - s.windA), inside(s.leftB - s.windB));
    if (left === right) continue;
    arcs.push(
      left
        ? { x0: s.ax, y0: s.ay, x1: s.bx, y1: s.by, used: false }
        : { x0: s.bx, y0: s.by, x1: s.ax, y1: s.ay, used: false },
    );
  }
  return assemble(arcs, lattice);
}

function boolean(
  a: PolygonInput,
  b: PolygonInput,
  options: PolygonOptions,
  keep: (inA: boolean, inB: boolean) => boolean,
): Polygon[] {
  const { fillRule = 'positive', curveSegments = 12 } = options;
  if (!(fillRule in fills)) throw new RangeError(`Unknown polygon fill rule: ${String(fillRule)}; pass 'positive', 'nonzero' or 'evenodd'`);
  return combine(collect(a, fillRule, curveSegments, []), collect(b, fillRule, curveSegments, []), fillRule, keep);
}

/**
 * Everything inside `a` or `b`. With `b` left out, it cleans one input: overlaps merge and crossings resolve.
 * Result outlines run counter-clockwise, holes clockwise, largest polygon first.
 */
export function polygonUnion(a: PolygonInput, b: PolygonInput = [], options: PolygonOptions = {}): Polygon[] {
  return boolean(a, b, options, (inA, inB) => inA || inB);
}

/** Everything inside `a` and outside `b`. */
export function polygonDifference(a: PolygonInput, b: PolygonInput, options: PolygonOptions = {}): Polygon[] {
  return boolean(a, b, options, (inA, inB) => inA && !inB);
}

/** Everything inside both `a` and `b`. */
export function polygonIntersection(a: PolygonInput, b: PolygonInput, options: PolygonOptions = {}): Polygon[] {
  return boolean(a, b, options, (inA, inB) => inA && inB);
}

/** Everything inside exactly one of `a` and `b`. */
export function polygonXor(a: PolygonInput, b: PolygonInput, options: PolygonOptions = {}): Polygon[] {
  return boolean(a, b, options, (inA, inB) => inA !== inB);
}

/** Adds the points strictly inside an arc around `v`, starting from offset `o` and turning `angle` radians. */
function addArc(
  ring: MutableVec2[],
  v: MutableVec2,
  o: MutableVec2,
  angle: number,
  radius: number,
  tolerance: number,
): void {
  const step = 2 * Math.acos(Math.max(0, 1 - tolerance / radius)),
    count = Math.ceil(Math.abs(angle) / step);
  for (let i = 1; i < count; i++) {
    const c = Math.cos((angle * i) / count),
      s = Math.sin((angle * i) / count);
    ring.push([v[0] + o[0] * c - o[1] * s, v[1] + o[0] * s + o[1] * c]);
  }
}

/** The offset to the right of a->b, at length `distance`; to the left when negative. */
function rightOffset(a: MutableVec2, b: MutableVec2, distance: number): MutableVec2 {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    scale = distance / Math.hypot(dx, dy);
  return [dy * scale, -dx * scale];
}

interface Corners {
  join: PolygonJoin;
  miterLimit: number;
  arcTolerance: number;
  cap: PolygonCap;
}

function cornerOptions(options: PolygonOffsetOptions & { cap?: PolygonCap }, radius: number): Corners {
  const { join = 'miter', miterLimit = 4, arcTolerance = radius / 500, cap = 'butt' } = options;
  if (join !== 'miter' && join !== 'round' && join !== 'bevel') throw new RangeError(`Unknown polygon join: ${join}; pass 'miter', 'round' or 'bevel'`);
  if (cap !== 'butt' && cap !== 'round' && cap !== 'square') throw new RangeError(`Unknown polygon cap: ${cap}; pass 'butt', 'round' or 'square'`);
  if (!(miterLimit >= 1)) throw new RangeError('Invalid miterLimit; pass a number of at least 1');
  if (!(arcTolerance > 0)) throw new RangeError('Invalid arcTolerance; pass a positive number');
  return { join, miterLimit, arcTolerance, cap };
}

/**
 * The raw offset curve of a ring whose inside is on its left: each edge moved sideways, with corners added where the
 * moved edges part. Where they overlap, the curve just cuts across. It may cross itself, but the points of the true
 * offset are exactly those it winds around a positive number of times (Chen and McMains, "Polygon offsetting by
 * computing winding numbers", 2005), so the boolean's sweep finishes the job. A ring that doubles back on itself is
 * how a stroke goes round the end of a line.
 */
function offsetCurve(ring: readonly MutableVec2[], distance: number, corners: Corners): MutableVec2[] {
  const { join, miterLimit, arcTolerance, cap } = corners,
    radius = Math.abs(distance),
    curve: MutableVec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length],
      b = ring[i],
      c = ring[(i + 1) % ring.length],
      o1 = rightOffset(a, b, distance),
      o2 = rightOffset(b, c, distance),
      turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]),
      dot = (o1[0] * o2[0] + o1[1] * o2[1]) / (radius * radius);
    curve.push([b[0] + o1[0], b[1] + o1[1]]);
    if (turn === 0 && dot < 0) {
      if (cap === 'round') addArc(curve, b, o1, Math.PI, radius, arcTolerance);
      else if (cap === 'square')
        curve.push([b[0] + o1[0] - o1[1], b[1] + o1[1] + o1[0]], [b[0] - o1[0] - o1[1], b[1] - o1[1] + o1[0]]);
    } else if (turn * distance > 0) {
      if (join === 'round')
        addArc(curve, b, o1, Math.atan2((o1[0] * o2[1] - o1[1] * o2[0]) / (radius * radius), dot), radius, arcTolerance);
      else if (join === 'miter' && Math.SQRT2 / Math.sqrt(1 + dot) <= miterLimit)
        curve.push([b[0] + (o1[0] + o2[0]) / (1 + dot), b[1] + (o1[1] + o2[1]) / (1 + dot)]);
    }
    curve.push([b[0] + o2[0], b[1] + o2[1]]);
  }
  return curve;
}

const inFirst = (inA: boolean): boolean => inA;

/**
 * Grows the input by `distance`, or shrinks it when negative. Parts thinner than twice an inset vanish and gaps
 * narrower than twice an outset close. An outset rounds or mitres outer corners; an inset does the same to inner ones.
 */
export function polygonOffset(input: PolygonInput, distance: number, options: PolygonOffsetOptions = {}): Polygon[] {
  if (!Number.isFinite(distance)) throw new RangeError('Invalid offset distance; pass a finite number');
  const clean = polygonUnion(input, [], options);
  if (!distance) return clean;
  const corners = cornerOptions(options, Math.abs(distance)),
    curves: MutableVec2[][] = [];
  for (const { contour, holes } of clean)
    for (const ring of [contour, ...holes]) curves.push(offsetCurve(ring, distance, corners));
  return combine(curves, [], 'positive', inFirst);
}

/** A band `width` wide around a line of points, for roads, walls and outlines. It may cross itself. */
export function polygonStroke(
  points: readonly MutableVec2[],
  width: number,
  options: PolygonStrokeOptions = {},
): Polygon[] {
  if (!(width >= 0) || !Number.isFinite(width))
    throw new RangeError('Invalid stroke width; pass a finite number of 0 or more');
  const corners = cornerOptions(options, width / 2 || 1),
    { closed = false } = options,
    line = ringOf(points).filter((p, i, all) => !i || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (closed && line.length > 1 && line[0][0] === line.at(-1)![0] && line[0][1] === line.at(-1)![1]) line.pop();
  if (!width || line.length < 2) return [];
  const back = line.slice().reverse();
  return combine(
    // Round a loop, the band has two sides; along an open line, one ring goes up one side and back down the other.
    closed
      ? [offsetCurve(line, width / 2, corners), offsetCurve(back, width / 2, corners)]
      : [offsetCurve([...line, ...back.slice(1, -1)], width / 2, corners)],
    [],
    'positive',
    inFirst,
  );
}

/** The filled area of a result: outlines minus holes. */
export function polygonArea(polygons: readonly Polygon[]): number {
  let sum = 0;
  for (const { contour, holes } of polygons) {
    sum += Math.abs(ringArea(contour));
    for (const hole of holes) sum -= Math.abs(ringArea(hole));
  }
  return sum / 2;
}

/** Results as `Shape`s, for `extrudeGeometry` and `shapeGeometry`. */
export function polygonShapes(polygons: readonly Polygon[]): Shape[] {
  return polygons.map(({ contour, holes }) => {
    const shape = new Shape(contour);
    shape.holes = holes.map((hole) => new Path(hole));
    return shape;
  });
}
