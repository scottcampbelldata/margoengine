// Delaunay and constrained Delaunay triangulation. Points are swept in sorted order, each joined to the hull edges it
// sees, with Lawson's flips restoring the empty-circle rule. Constraints go in by flipping the edges they cross (S.
// Sloan, "A fast algorithm for generating constrained Delaunay triangulations", 1993). Predicates are exact: a float
// filter with J. Shewchuk's error bounds (1997), falling back to whole-number arithmetic on the doubles' exact values.
import type { MutableVec2 } from './math.js';

/** Bound on rounding in the float orientation test, as a share of its terms. */
const orientBound = (3 + 16 * 2 ** -53) * 2 ** -53;
/** Bound on rounding in the float in-circle test, as a share of its terms. */
const circleBound = (10 + 96 * 2 ** -53) * 2 ** -53;
/** Below this a float result may have lost bits to underflow, which the bounds above do not cover. */
const underflowFloor = 1e-300;
/** Edge flag: a constraint, which no flip may remove. */
const FIXED = 1;
/** Edge flag: a ring boundary. Crossing one goes from outside to inside, or back. */
const RING = 2;

/** Options of {@link delaunayTriangulate}. */
export interface DelaunayOptions {
  /** Index pairs into `points` that must appear as edges. */
  edges?: readonly (readonly [number, number])[];
}

/** Options of {@link triangulateConstrained}. */
export interface ConstrainedOptions {
  /** Extra points inside the shape, kept as vertices. Their indices follow the rings'. */
  points?: readonly MutableVec2[];
  /** Index pairs into contour, holes and `points`, in that order, that must appear as edges. */
  edges?: readonly (readonly [number, number])[];
}

/** Result of {@link triangulateConstrained}: indices address contour, holes and `points`, in that order. */
export interface ConstrainedTriangulation {
  /** Counter-clockwise triangles. */
  indices: number[];
  contour: MutableVec2[];
  holes: MutableVec2[][];
  points: MutableVec2[];
}

/** The exact value of each double as a whole number, all with one shared power of two taken out. */
function wholeNumbers(values: readonly number[]): bigint[] {
  const view = new DataView(new ArrayBuffer(8)),
    mantissas: bigint[] = [],
    exponents: number[] = [];
  let lowest = Infinity;
  for (const value of values) {
    view.setFloat64(0, value);
    const high = view.getUint32(0),
      biased = (high >>> 20) & 0x7ff,
      fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4)),
      mantissa = biased ? fraction | (1n << 52n) : fraction,
      exponent = (biased || 1) - 1075;
    mantissas.push(value < 0 ? -mantissa : mantissa);
    exponents.push(exponent);
    if (mantissa && exponent < lowest) lowest = exponent;
  }
  return mantissas.map((m, i) => (m ? m << BigInt(exponents[i] - lowest) : 0n));
}

/** Positive when a, b, c run counter-clockwise, negative clockwise, 0 when they are exactly on one line. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const left = (ax - cx) * (by - cy),
    right = (ay - cy) * (bx - cx),
    det = left - right;
  if (Math.abs(det) > orientBound * (Math.abs(left) + Math.abs(right)) + underflowFloor) return det;
  const [x0, y0, x1, y1, x2, y2] = wholeNumbers([ax, ay, bx, by, cx, cy]),
    exact = (x0 - x2) * (y1 - y2) - (y0 - y2) * (x1 - x2);
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}

/** Positive when d is strictly inside the circle through a, b, c, which run counter-clockwise. */
function inCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const adx = ax - dx,
    ady = ay - dy,
    bdx = bx - dx,
    bdy = by - dy,
    cdx = cx - dx,
    cdy = cy - dy,
    bc = bdx * cdy,
    cb = cdx * bdy,
    ca = cdx * ady,
    ac = adx * cdy,
    ab = adx * bdy,
    ba = bdx * ady,
    aLift = adx * adx + ady * ady,
    bLift = bdx * bdx + bdy * bdy,
    cLift = cdx * cdx + cdy * cdy,
    det = aLift * (bc - cb) + bLift * (ca - ac) + cLift * (ab - ba),
    terms =
      aLift * (Math.abs(bc) + Math.abs(cb)) +
      bLift * (Math.abs(ca) + Math.abs(ac)) +
      cLift * (Math.abs(ab) + Math.abs(ba));
  const small =
    (aLift + bLift + cLift + Math.abs(bc) + Math.abs(cb) + Math.abs(ca) + Math.abs(ac) + Math.abs(ab) + Math.abs(ba)) *
    1e-320;
  if (Math.abs(det) > circleBound * terms + small + underflowFloor) return det;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = wholeNumbers([ax, ay, bx, by, cx, cy, dx, dy]),
    a = x0 - x3,
    b = y0 - y3,
    c = x1 - x3,
    d = y1 - y3,
    e = x2 - x3,
    f = y2 - y3,
    exact = (a * a + b * b) * (c * f - e * d) + (c * c + d * d) * (e * b - a * f) + (e * e + f * f) * (a * d - c * b);
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}

/** Whether two test results have strictly opposite signs. Signs, because the product of two results could underflow. */
const apart = (a: number, b: number): boolean => (a > 0 && b < 0) || (a < 0 && b > 0);
const next = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1);
const previous = (e: number): number => (e % 3 === 0 ? e + 2 : e - 1);

/** A triangle mesh over half-edges: edge `e` runs from `from[e]` to `from[next(e)]`, and `twin[e]` is -1 on the hull. */
class Mesh {
  readonly from: Int32Array;
  readonly twin: Int32Array;
  readonly flags: Uint8Array;
  /** One outgoing edge per vertex, -1 for vertices not in the mesh. */
  readonly out: Int32Array;
  /** The hull edge leaving each hull vertex, while sweeping. */
  readonly hullEdge: Int32Array;
  size = 0;

  constructor(
    readonly x: Float64Array,
    readonly y: Float64Array,
  ) {
    const count = x.length,
      capacity = Math.max(1, 2 * count) * 3;
    this.from = new Int32Array(capacity);
    this.twin = new Int32Array(capacity).fill(-1);
    this.flags = new Uint8Array(capacity);
    this.out = new Int32Array(count).fill(-1);
    this.hullEdge = new Int32Array(count).fill(-1);
  }

  orient(a: number, b: number, c: number): number {
    const { x, y } = this;
    return orient(x[a], y[a], x[b], y[b], x[c], y[c]);
  }

  /** Adds a counter-clockwise triangle and returns its first edge. */
  triangle(a: number, b: number, c: number): number {
    const e = this.size;
    this.size += 3;
    this.from[e] = a;
    this.from[e + 1] = b;
    this.from[e + 2] = c;
    this.out[a] = e;
    this.out[b] = e + 1;
    this.out[c] = e + 2;
    return e;
  }

  link(a: number, b: number): void {
    this.twin[a] = b;
    if (b >= 0) this.twin[b] = a;
    else this.hullEdge[this.from[a]] = a;
  }

  /** Turns the diagonal shared by the two triangles of `e`. Both keep their ids. */
  flip(e: number): void {
    const { from, twin, flags, out } = this,
      t = twin[e],
      e1 = next(e),
      e2 = previous(e),
      t1 = next(t),
      t2 = previous(t),
      u = from[e],
      v = from[t],
      w = from[e2],
      x = from[t2],
      twinE1 = twin[e1],
      twinE2 = twin[e2],
      twinT1 = twin[t1],
      twinT2 = twin[t2],
      flagE1 = flags[e1],
      flagE2 = flags[e2],
      flagT1 = flags[t1],
      flagT2 = flags[t2];
    from[e] = x;
    from[e1] = w;
    from[e2] = u;
    from[t] = w;
    from[t1] = x;
    from[t2] = v;
    this.link(e, t);
    this.link(e1, twinE2);
    this.link(e2, twinT1);
    this.link(t1, twinT2);
    this.link(t2, twinE1);
    flags[e] = flags[t] = 0;
    flags[e1] = flagE2;
    flags[e2] = flagT1;
    flags[t1] = flagT2;
    flags[t2] = flagE1;
    out[x] = e;
    out[w] = e1;
    out[u] = e2;
    out[v] = t2;
  }

  /** Flips edges off `stack` until none breaks the empty-circle rule; constraints stay. */
  legalize(stack: number[]): void {
    const { from, twin, flags, x, y } = this;
    while (stack.length) {
      const e = stack.pop()!,
        t = twin[e];
      if (t < 0 || flags[e] & FIXED) continue;
      const a = from[e],
        b = from[next(e)],
        c = from[previous(e)],
        d = from[previous(t)];
      if (inCircle(x[a], y[a], x[b], y[b], x[c], y[c], x[d], y[d]) <= 0) continue;
      this.flip(e);
      stack.push(next(e), previous(e), next(t), previous(t));
    }
  }

  /** Calls `visit` with every edge leaving `v`, until it returns true; returns that edge, or -1. */
  aroundVertex(v: number, visit: (e: number) => boolean): number {
    const { twin, out } = this,
      first = out[v];
    if (first < 0) return -1;
    let e = first;
    do {
      if (visit(e)) return e;
      const turned = twin[previous(e)];
      if (turned < 0) break;
      e = turned;
    } while (e !== first);
    if (e === first && twin[previous(e)] >= 0) return -1;
    // Stopped at the hull: go round the other way from the start.
    for (let t = twin[first]; t >= 0; ) {
      const turned = next(t);
      if (visit(turned)) return turned;
      t = twin[turned];
    }
    return -1;
  }

  /** An edge between `a` and `b`, in either direction, or -1. On the hull only one direction exists. */
  find(a: number, b: number): number {
    const { from } = this;
    let found = -1;
    this.aroundVertex(a, (e) => {
      if (from[next(e)] === b) found = e;
      else if (from[previous(e)] === b) found = previous(e);
      return found >= 0;
    });
    return found;
  }

  /** Forces an edge from `a` to `b`, passing through any vertex exactly on the way, and marks it with `flag`. */
  constrain(a: number, b: number, flag: number): void {
    const { from, twin, flags } = this;
    let at = a;
    while (at !== b) {
      // A vertex exactly on the line to b, ahead of us, ends this stretch.
      let stop = -1,
        along = -1;
      const onLine = (w: number, e: number): boolean => {
        if (w !== b && (this.orient(at, b, w) !== 0 || !this.ahead(at, b, w))) return false;
        stop = w;
        along = e;
        return true;
      };
      this.aroundVertex(at, (e) => onLine(from[next(e)], e) || onLine(from[previous(e)], previous(e)));
      if (along >= 0) {
        this.mark(along, flag);
        at = stop;
        continue;
      }
      // Otherwise the line leaves `at` through one triangle's far edge.
      const leaving = this.aroundVertex(at, (e) => {
        const v = from[next(e)],
          w = from[previous(e)];
        return this.orient(at, b, v) < 0 && this.orient(at, b, w) > 0;
      });
      if (leaving < 0)
        throw new RangeError('Constrained triangulation lost an edge; pass points without repeats on the constraint');
      const crossing: [number, number][] = [];
      let h = next(leaving);
      for (;;) {
        if (flags[h] & FIXED)
          throw new RangeError('Constrained triangulation edges cross; split them where they meet or remove one');
        crossing.push([from[h], from[next(h)]]);
        const g = twin[h],
          far = from[previous(g)],
          side = far === b ? 0 : this.orient(at, b, far);
        if (side === 0) {
          stop = far;
          break;
        }
        h = side > 0 ? next(g) : previous(g);
      }
      this.clear(crossing, at, stop);
      this.mark(this.find(at, stop), flag);
      at = stop;
    }
  }

  /** Whether `w`, on the line through `a` and `b`, lies past `a` towards `b`. */
  private ahead(a: number, b: number, w: number): boolean {
    const { x, y } = this,
      dx = x[b] - x[a];
    return dx ? x[w] - x[a] > 0 === dx > 0 : y[w] - y[a] > 0 === y[b] - y[a] > 0;
  }

  private mark(e: number, flag: number): void {
    const { flags, twin } = this,
      t = twin[e],
      // Two rings on one side cancel out, like a hole cut along the outline.
      value = (flags[e] | FIXED) ^ (flag & RING);
    flags[e] = value | (flag & FIXED);
    if (t >= 0) flags[t] = flags[e];
  }

  /** Flips away every edge crossing `a`-`b`, then restores the empty-circle rule around the new edges. */
  private clear(crossing: [number, number][], a: number, b: number): void {
    const { from, twin } = this,
      fresh: [number, number][] = [];
    let head = 0;
    while (head < crossing.length) {
      const [p, q] = crossing[head++],
        e = this.find(p, q),
        w = from[previous(e)],
        x = from[previous(twin[e])];
      // The two triangles must form a strictly convex quad for the flip to be legal; if not, come back later.
      if (!apart(this.orient(x, w, p), this.orient(x, w, q))) {
        crossing.push([p, q]);
        continue;
      }
      this.flip(e);
      const still = x !== a && x !== b && w !== a && w !== b && apart(this.orient(a, b, x), this.orient(a, b, w));
      if (still) crossing.push([x, w]);
      else fresh.push([x, w]);
    }
    this.mark(this.find(a, b), FIXED);
    // Later flips reuse edge ids, so the new edges are looked up again by their ends.
    this.legalize(fresh.map(([p, q]) => this.find(p, q)));
  }
}

/** Sweeps the points into a Delaunay triangulation of their convex hull. Repeated points map to their first copy. */
function sweep(x: Float64Array, y: Float64Array): { mesh: Mesh; first: Uint32Array } {
  const count = x.length,
    order = Array.from({ length: count }, (_, i) => i).sort((a, b) => x[a] - x[b] || y[a] - y[b] || a - b),
    first = new Uint32Array(count),
    unique: number[] = [];
  for (const i of order) {
    const last = unique[unique.length - 1];
    if (last !== undefined && x[last] === x[i] && y[last] === y[i]) first[i] = last;
    else {
      first[i] = i;
      unique.push(i);
    }
  }
  const mesh = new Mesh(x, y);
  if (unique.length < 3) return { mesh, first };
  // The first point off the line through the first two starts the mesh; those before it make a fan.
  let apex = 2;
  while (apex < unique.length && mesh.orient(unique[0], unique[1], unique[apex]) === 0) apex++;
  if (apex === unique.length) return { mesh, first };
  const p = unique[apex],
    turn = mesh.orient(unique[0], unique[1], p) > 0,
    hullNext = new Int32Array(count).fill(-1),
    hullPrevious = new Int32Array(count).fill(-1),
    stack: number[] = [];
  const hull = (a: number, b: number, e: number): void => {
    hullNext[a] = b;
    hullPrevious[b] = a;
    mesh.hullEdge[a] = e;
  };
  let before = -1;
  for (let i = 0; i + 1 < apex; i++) {
    const a = unique[i],
      b = unique[i + 1],
      e = turn ? mesh.triangle(a, b, p) : mesh.triangle(b, a, p);
    if (turn) {
      hull(a, b, e);
      if (before >= 0) mesh.link(e + 2, before + 1);
      if (before >= 0) stack.push(e + 2);
      if (i === 0) hull(p, a, e + 2);
      if (i + 2 === apex) hull(b, p, e + 1);
    } else {
      hull(b, a, e);
      if (before >= 0) mesh.link(e + 1, before + 2);
      if (before >= 0) stack.push(e + 1);
      if (i === 0) hull(a, p, e + 1);
      if (i + 2 === apex) hull(p, b, e + 2);
    }
    before = e;
  }
  mesh.legalize(stack);

  let last = p;
  for (let i = apex + 1; i < unique.length; i++) {
    const v = unique[i],
      sees = (a: number): boolean => mesh.orient(a, hullNext[a], v) < 0;
    // The new point lies beyond everything swept so far, so the hull edges it sees sit next to the last point added.
    let begin = last;
    if (!sees(begin) && !sees(hullPrevious[begin])) {
      const around = begin;
      do begin = hullNext[begin];
      while (!sees(begin) && begin !== around);
    }
    while (sees(hullPrevious[begin])) begin = hullPrevious[begin];
    let a = begin,
      earlier = -1,
      firstNew = -1;
    do {
      const b = hullNext[a],
        outer = mesh.hullEdge[a],
        e = mesh.triangle(b, a, v);
      mesh.link(e, outer);
      if (earlier >= 0) mesh.link(e + 1, earlier + 2);
      else firstNew = e;
      stack.push(e);
      earlier = e;
      a = b;
    } while (sees(a) && a !== begin);
    hull(begin, v, firstNew + 1);
    hull(v, a, earlier + 2);
    last = v;
    mesh.legalize(stack);
  }
  return { mesh, first };
}

function coordinates(points: readonly MutableVec2[], label: string): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(points.length),
    y = new Float64Array(points.length);
  points.forEach((p, i) => {
    x[i] = p?.[0];
    y[i] = p?.[1];
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i]))
      throw new RangeError(`${label} point ${i} is not finite; pass [x, y] with finite numbers`);
  });
  return { x, y };
}

function checkEdge(edge: readonly [number, number], count: number, label: string): void {
  if (!(Number.isInteger(edge?.[0]) && Number.isInteger(edge?.[1]) && edge[0] >= 0 && edge[1] >= 0))
    throw new RangeError(`${label} edge ${edge} is invalid; pass two point indices`);
  if (edge[0] >= count || edge[1] >= count)
    throw new RangeError(`${label} edge ${edge} is past ${count} points; fix the indices`);
}

/**
 * Delaunay triangulation of the convex hull of a point set: no point lies inside any triangle's circumcircle, which
 * makes the smallest angles as large as they can be. With `edges`, those edges are kept and the rule holds as far as
 * they allow. Every distinct point is a vertex, collinear ones included. Exact arithmetic decides every test, so
 * cocircular grids and near-collinear points are safe. Points all on one line give no triangles.
 *
 * @param points - `[x, y]` points.
 * @param options - See {@link DelaunayOptions}.
 * @returns Counter-clockwise triangles as indices into `points`; a repeated point is its first copy.
 * @throws RangeError when a point is not finite, an edge index is invalid, or two edges cross.
 */
export function delaunayTriangulate(points: readonly MutableVec2[], options: DelaunayOptions = {}): Uint32Array {
  const { x, y } = coordinates(points, 'delaunayTriangulate'),
    { mesh, first } = sweep(x, y);
  for (const edge of options.edges ?? []) {
    checkEdge(edge, points.length, 'delaunayTriangulate');
    if (mesh.size && first[edge[0]] !== first[edge[1]]) mesh.constrain(first[edge[0]], first[edge[1]], FIXED);
  }
  return Uint32Array.from(mesh.from.subarray(0, mesh.size));
}

/**
 * Constrained Delaunay triangulation of a polygon with holes, a drop-in for `triangulateShape` that keeps every outline
 * point as a vertex: collinear points are not dropped, so extruded caps meet their walls without T-junctions, and large
 * flat caps get well-shaped triangles. Rings are filled by the even-odd rule in any winding; a hole may touch the
 * outline at a point or along a side. Adds no vertices of its own.
 *
 * @param contour - The outer ring.
 * @param holes - Hole rings.
 * @param options - See {@link ConstrainedOptions}.
 * @throws RangeError when a point is not finite, a ring has under 3 points, an edge index is invalid, or edges cross:
 *   a ring that crosses itself or another ring has no single answer, so it must be fixed first.
 */
export function triangulateConstrained(
  contour: readonly MutableVec2[],
  holes: readonly (readonly MutableVec2[])[] = [],
  options: ConstrainedOptions = {},
): ConstrainedTriangulation {
  const extra = options.points ?? [],
    rings = [contour, ...holes],
    all: MutableVec2[] = [];
  for (const ring of rings) {
    if (ring.length < 3) throw new RangeError(`triangulateConstrained ring of ${ring.length} points; pass at least 3`);
    all.push(...ring);
  }
  all.push(...extra);
  const { x, y } = coordinates(all, 'triangulateConstrained'),
    { mesh, first } = sweep(x, y);
  if (mesh.size) {
    let base = 0;
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const a = first[base + k],
          b = first[base + ((k + 1) % ring.length)];
        if (a !== b) mesh.constrain(a, b, FIXED | RING);
      }
      base += ring.length;
    }
    for (const edge of options.edges ?? []) {
      checkEdge(edge, all.length, 'triangulateConstrained');
      if (first[edge[0]] !== first[edge[1]]) mesh.constrain(first[edge[0]], first[edge[1]], FIXED);
    }
  }
  return {
    indices: insideTriangles(mesh),
    contour: contour.map((p) => [p[0], p[1]]),
    holes: holes.map((h) => h.map((p) => [p[0], p[1]])),
    points: extra.map((p) => [p[0], p[1]]),
  };
}

/** Triangles an odd number of ring edges in from the hull. */
function insideTriangles(mesh: Mesh): number[] {
  const { from, twin, flags, size } = mesh,
    seen = new Uint8Array(size / 3),
    out: number[] = [];
  let level: number[] = [],
    deeper: number[] = [];
  for (let e = 0; e < size; e++) if (twin[e] < 0) (flags[e] & RING ? deeper : level).push((e / 3) | 0);
  for (let depth = 0; level.length || deeper.length; depth++) {
    while (level.length) {
      const t = level.pop()!;
      if (seen[t]) continue;
      seen[t] = 1;
      if (depth & 1) out.push(from[t * 3], from[t * 3 + 1], from[t * 3 + 2]);
      for (let e = t * 3; e < t * 3 + 3; e++) {
        const across = twin[e];
        if (across >= 0) (flags[e] & RING ? deeper : level).push((across / 3) | 0);
      }
    }
    level = deeper;
    deeper = [];
  }
  return out;
}
