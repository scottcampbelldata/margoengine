// The search shared by every navmesh shape: A* over polygons, then the funnel through the corridor it found.
import type { Vec3 } from '@margoengine/math';

/** One way out of a polygon: a shared-edge portal, or an off-mesh link when `offMesh` is set. */
export interface Link {
  to: number;
  left: Vec3;
  right: Vec3;
  /** Path cost of crossing an off-mesh link; a portal costs the walk to it. */
  cost?: number;
  /** Off-mesh link id, for a jump, ladder or teleport link; undefined for a shared-edge portal. */
  offMesh?: number;
  /** Off-mesh link ends: where the agent leaves this polygon and where it lands. */
  start?: Vec3;
  end?: Vec3;
}

/** A path with the waypoints where off-mesh links start. */
export interface NavRoute {
  /** Corner points from the start to the end, both included. */
  points: Vec3[];
  /** Indices `i` into `points` where the segment from `points[i]` to `points[i + 1]` crosses an off-mesh link. */
  offMesh: number[];
}

/** Signed XZ area of the triangle (a, b, c), doubled. */
export const cross = (a: Vec3, b: Vec3, c: Vec3) => (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
/** Same point within the point-equality floor (1e-8 per axis, our own choice). */
const same = (a: Vec3, b: Vec3) =>
  a === b || (Math.abs(a[0] - b[0]) <= 1e-8 && Math.abs(a[1] - b[1]) <= 1e-8 && Math.abs(a[2] - b[2]) <= 1e-8);
export const copy = (v: Vec3) => [v[0], v[1], v[2]] as unknown as Vec3;
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Checks a point. */
export function point(value: Vec3): void {
  if (value.length !== 3 || value.some((v) => !Number.isFinite(Math.fround(v))))
    throw new RangeError('Point must be finite [x, y, z]; pass numbers.');
}

/**
 * Checks a route filter. A* finds the cheapest route only while its straight line estimate stays a lower bound of the
 * cost (Hart, Nilsson, Raphael 1968, Theorem 1), so no multiplier may fall below 1.
 */
export function checkFilter(filter: ArrayLike<number>): void {
  for (let i = 0; i < filter.length; i++)
    if (!(filter[i] >= 1))
      throw new RangeError('A route filter cost must not fall below 1; use 1 or more, or Infinity to forbid an area.');
}

/** A* state reused by every path call; the heap holds one entry per improved polygon cost. */
export class CorridorSearch {
  private g = new Float64Array(0);
  private f = new Float64Array(0);
  private parent = new Int32Array(0);
  private parentLink = new Int32Array(0);
  private state = new Uint8Array(0);
  /** Where the search entered each polygon: x, y, z. */
  private entry = new Float64Array(0);
  private heapKey = new Float64Array(1);
  private heapNode = new Int32Array(1);
  /** What the last corridor {@link CorridorSearch.find} returned costs, the walk to its end included. */
  cost = 0;
  /** Makes room for `polygons` polygons and `links` links in all. */
  reserve(polygons: number, links: number): void {
    if (this.g.length < polygons) {
      this.g = new Float64Array(polygons);
      this.f = new Float64Array(polygons);
      this.parent = new Int32Array(polygons);
      this.parentLink = new Int32Array(polygons);
      this.state = new Uint8Array(polygons);
      this.entry = new Float64Array(polygons * 3);
    }
    if (this.heapKey.length < links + 1) {
      this.heapKey = new Float64Array(links + 1);
      this.heapNode = new Int32Array(links + 1);
    }
  }
  /**
   * The links of the cheapest corridor from `start` in polygon `from` to `end` in polygon `to` over `adjacency`, or
   * null. A polygon's cost is the walk from where the search entered it to the middle of the portal it leaves by,
   * times `costs[p]` (Infinity blocks it); off-mesh links cost what they say. Measuring from the portals and not the
   * polygon centres keeps routes straight when polygons differ in size, as they do at a tile line. `polygons` is the
   * used length of `adjacency`.
   */
  find(
    from: number,
    to: number,
    start: Vec3,
    end: Vec3,
    polygons: number,
    adjacency: readonly (readonly Link[])[],
    costs: ArrayLike<number>,
  ): Link[] | null {
    const { g, f, parent, parentLink, state, entry, heapKey, heapNode } = this,
      gx = end[0],
      gy = end[1],
      gz = end[2];
    g.fill(Infinity, 0, polygons);
    state.fill(0, 0, polygons);
    g[from] = 0;
    f[from] = distance(start, end);
    state[from] = 1;
    entry[from * 3] = start[0];
    entry[from * 3 + 1] = start[1];
    entry[from * 3 + 2] = start[2];
    // Open set as a binary heap ordered by (f, polygon index): the same pick as a lowest-f, lowest-index scan.
    let size = 1;
    heapKey[0] = f[from];
    heapNode[0] = from;
    while (true) {
      let current = -1;
      while (size) {
        const key = heapKey[0],
          node = heapNode[0],
          lastKey = heapKey[--size],
          lastNode = heapNode[size];
        let i = 0;
        for (let child = 1; child < size; child = i * 2 + 1) {
          if (
            child + 1 < size &&
            (heapKey[child + 1] < heapKey[child] ||
              (heapKey[child + 1] === heapKey[child] && heapNode[child + 1] < heapNode[child]))
          )
            child++;
          if (lastKey < heapKey[child] || (lastKey === heapKey[child] && lastNode < heapNode[child])) break;
          heapKey[i] = heapKey[child];
          heapNode[i] = heapNode[child];
          i = child;
        }
        heapKey[i] = lastKey;
        heapNode[i] = lastNode;
        // Entries left behind by a later cost improvement or an already closed polygon are stale.
        if (state[node] === 1 && f[node] === key) {
          current = node;
          break;
        }
      }
      if (current < 0) return null;
      if (current === to) break;
      state[current] = 2;
      const links = adjacency[current],
        ex = entry[current * 3],
        ey = entry[current * 3 + 1],
        ez = entry[current * 3 + 2],
        // An agent standing in a blocked polygon may still walk out of it.
        rate = costs[current] < Infinity ? costs[current] : 1;
      for (let l = 0; l < links.length; l++) {
        const link = links[l],
          next = link.to;
        if (state[next] === 2 || !(costs[next] < Infinity)) continue;
        const a = link.start ?? link.left,
          b = link.start ?? link.right,
          mx = (a[0] + b[0]) / 2,
          my = (a[1] + b[1]) / 2,
          mz = (a[2] + b[2]) / 2,
          landing = link.end ?? null,
          nx = landing ? landing[0] : mx,
          ny = landing ? landing[1] : my,
          nz = landing ? landing[2] : mz,
          candidate = g[current] + Math.hypot(mx - ex, my - ey, mz - ez) * rate + (link.cost ?? 0);
        if (candidate < g[next]) {
          const key = candidate + Math.hypot(nx - gx, ny - gy, nz - gz);
          entry[next * 3] = nx;
          entry[next * 3 + 1] = ny;
          entry[next * 3 + 2] = nz;
          parent[next] = current;
          parentLink[next] = l;
          g[next] = candidate;
          f[next] = key;
          state[next] = 1;
          let i = size++;
          for (
            let up = (i - 1) >> 1;
            i > 0 && (key < heapKey[up] || (key === heapKey[up] && next < heapNode[up]));
            i = up, up = (i - 1) >> 1
          ) {
            heapKey[i] = heapKey[up];
            heapNode[i] = heapNode[up];
          }
          heapKey[i] = key;
          heapNode[i] = next;
        }
      }
    }
    this.cost = g[to] + Math.hypot(gx - entry[to * 3], gy - entry[to * 3 + 1], gz - entry[to * 3 + 2]) * costs[to];
    const corridor: Link[] = [];
    for (let node = to; node !== from; node = parent[node]) corridor.push(adjacency[parent[node]][parentLink[node]]);
    return corridor.reverse();
  }
}

/** Funnel deque reused by {@link pull}: the left chain grows down from the apex slot, the right chain up. */
const funnel: Vec3[] = [];

/**
 * Shortest XZ polyline from `start` to `end` through `portals`: the funnel of D. T. Lee and F. P. Preparata
 * (Networks 14, 1984), as used by J. Hershberger and J. Snoeyink (CGTA 4, 1994). The deque holds the shortest paths
 * from the apex to the latest left and right portal ends; the left chain only turns counter-clockwise, the right one
 * only clockwise. A new end point pops the vertices of its own chain it can see past; when it crosses the other
 * chain, the apex walks along that chain and every vertex passed is a corner.
 */
function pull(portals: readonly Link[], start: Vec3, end: Vec3): Vec3[] {
  const result: Vec3[] = [copy(start)],
    middle = portals.length + 2,
    deque = funnel;
  if (deque.length < 2 * middle + 1) deque.length = 2 * middle + 1;
  deque[middle] = start;
  let low = middle,
    apex = middle,
    high = middle;
  const corner = (v: Vec3) => {
    if (!same(v, result[result.length - 1])) result.push(copy(v));
  };
  const addLeft = (p: Vec3) => {
    if (same(p, deque[low])) return;
    while (low < apex && cross(deque[low + 1], deque[low], p) <= 0) low++;
    if (low === apex) {
      // p is clockwise of the right chain's first edge: the path to p wraps that chain's vertices.
      while (apex < high && cross(deque[apex], deque[apex + 1], p) < 0) corner(deque[++apex]);
      low = apex;
    }
    deque[--low] = p;
  };
  const addRight = (p: Vec3) => {
    if (same(p, deque[high])) return;
    while (high > apex && cross(deque[high - 1], deque[high], p) >= 0) high--;
    if (high === apex) {
      while (apex > low && cross(deque[apex], deque[apex - 1], p) > 0) corner(deque[--apex]);
      high = apex;
    }
    deque[++high] = p;
  };
  for (const link of portals) {
    addLeft(link.left);
    addRight(link.right);
  }
  // The end is a portal of zero width; the left chain then runs from the apex to it.
  addLeft(end);
  for (let i = apex - 1; i > low; i--) corner(deque[i]);
  if (!same(end, result[result.length - 1])) result.push(copy(end));
  deque.fill(undefined as unknown as Vec3, 0, 2 * middle + 1);
  return result;
}

/** The route through a corridor: each stretch between off-mesh links pulled taut on its own, a link joining two. */
export function routeThrough(corridor: readonly Link[], start: Vec3, end: Vec3): NavRoute {
  const points: Vec3[] = [],
    offMesh: number[] = [];
  const append = (part: Vec3[]) => {
    for (const v of part) if (!points.length || !same(v, points[points.length - 1])) points.push(v);
  };
  let first = 0,
    origin: Vec3 = start;
  for (let i = 0; i < corridor.length; i++) {
    const link = corridor[i];
    if (link.offMesh === undefined) continue;
    append(pull(corridor.slice(first, i), origin, link.start!));
    offMesh.push(points.length - 1);
    points.push(copy(link.end!));
    origin = link.end!;
    first = i + 1;
  }
  const last = pull(corridor.slice(first), origin, end);
  // The first point of the last stretch is the landing point already added.
  append(offMesh.length ? last.slice(1) : last);
  return { points, offMesh };
}
