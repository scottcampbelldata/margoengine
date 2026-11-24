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
  /** Set by optional partial-path surfaces when the original goal is unreachable. Default false when absent. */
  partial?: boolean;
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

/**
 * The A* estimate scale that keeps the straight-line estimate a lower bound with off-mesh links: walks cost at least
 * their length (area costs are 1 or more), but a link may cost less than the straight line between its ends (a
 * teleporter, a cheap jump). Scaling the estimate by k = min(1, min over links of cost / length) keeps it admissible
 * and consistent (Hart, Nilsson, Raphael 1968), so the first closed path to a polygon stays the cheapest; k is 0, plain
 * Dijkstra, when a link is free. Pass every link a search may cross.
 */
export function heuristicScale(links: Iterable<{ start: Vec3; end: Vec3; cost: number }>): number {
  let scale = 1;
  for (const { start, end, cost } of links) {
    const length = distance(start, end);
    if (cost < length * scale) scale = cost / length;
  }
  return scale;
}

/**
 * Where on the portal from `a` to `b` (as a fraction from `a`) the walk from the entry (ex, ez) to the goal
 * (gx, gz) through it is shortest, in XZ. That walk's length is convex along the portal, so the answer is its
 * unconstrained minimum clamped to the portal: where the straight line to the goal crosses the portal's line, or, with
 * both on one side, where the line to the goal mirrored in the portal crosses it (Heron's reflection).
 */
function crossing(ex: number, ez: number, a: Vec3, b: Vec3, gx: number, gz: number): number {
  const dx = b[0] - a[0],
    dz = b[2] - a[2],
    length2 = dx * dx + dz * dz;
  if (!(length2 > 0)) return 0;
  // Signed distances (times the portal length) from the portal's line.
  const se = dx * (ez - a[2]) - dz * (ex - a[0]);
  let sg = dx * (gz - a[2]) - dz * (gx - a[0]),
    tx = gx,
    tz = gz;
  if ((se > 0 && sg > 0) || (se < 0 && sg < 0)) {
    // Mirror the goal in the portal's line: n = (-dz, dx), distance sg / |n|.
    tx = gx + (2 * sg * dz) / length2;
    tz = gz - (2 * sg * dx) / length2;
    sg = -sg;
  }
  const u = se === sg ? 0 : se / (se - sg),
    px = ex + u * (tx - ex),
    pz = ez + u * (tz - ez),
    t = ((px - a[0]) * dx + (pz - a[2]) * dz) / length2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** A* state reused by every path call. The search runs over portals, not polygons: a node is one way into a polygon
 * (a link, in the direction it is crossed), so a polygon entered by two portals keeps both ways in and the one that
 * leads on more cheaply wins later. One node per polygon lost the other way in, and with it the straight corridor
 * (KB2604b). Node `offset[p] + l` is link `l` of polygon `p`; the node after the last link is the start.
 */
export class CorridorSearch {
  private g = new Float64Array(0);
  private f = new Float64Array(0);
  private parent = new Int32Array(0);
  /** The polygon whose link each node is. */
  private source = new Int32Array(0);
  private offset = new Int32Array(0);
  private state = new Uint8Array(0);
  /** Where each node crosses into its polygon: x, y, z. */
  private entry = new Float64Array(0);
  private heapKey = new Float64Array(1);
  private heapNode = new Int32Array(1);
  /** What the last corridor {@link CorridorSearch.find} returned costs, the walk to its end included. */
  cost = 0;
  /** Makes room for `polygons` polygons and `links` links in all; {@link CorridorSearch.find} grows it as needed. */
  reserve(polygons: number, links: number): void {
    if (this.offset.length < polygons + 1) this.offset = new Int32Array(polygons + 1);
    const nodes = links + 1;
    if (this.g.length < nodes) {
      this.g = new Float64Array(nodes);
      this.f = new Float64Array(nodes);
      this.parent = new Int32Array(nodes);
      this.source = new Int32Array(nodes);
      this.state = new Uint8Array(nodes);
      this.entry = new Float64Array(nodes * 3);
    }
    if (this.heapKey.length < nodes) {
      this.heapKey = new Float64Array(nodes);
      this.heapNode = new Int32Array(nodes);
    }
  }
  /**
   * The links of the cheapest corridor from `start` in polygon `from` to `end` in polygon `to` over `adjacency`, or
   * null. Crossing a polygon costs the walk from where the search entered it to where it leaves, times `costs[p]`
   * (Infinity blocks it); off-mesh links cost what they say. A portal is crossed where the line from the entry to the
   * goal meets it, or at its end nearer that line: where a taut path crosses it, so a corridor costs about what the
   * funnel pulls through it. Portal middles made straight corridors zigzag and lose to bent ones (KB2604b); Demyen and
   * Buro (2006) and Cui, Harabor and Grastien (2017) measure corridors by the taut path for the same reason. A node
   * keeps the entry with the lower cost so far plus straight line on: entries at different points of a portal are not
   * comparable by cost so far alone. `polygons` is the used length of `adjacency`. `scale` multiplies the straight-line
   * estimate: {@link heuristicScale} of the links in `adjacency` (default 1, right when no link costs less than its
   * length).
   */
  find(
    from: number,
    to: number,
    start: Vec3,
    end: Vec3,
    polygons: number,
    adjacency: readonly (readonly Link[])[],
    costs: ArrayLike<number>,
    scale = 1,
  ): Link[] | null {
    if (this.offset.length < polygons + 1) this.offset = new Int32Array(polygons + 1);
    let total = 0;
    for (let p = 0; p < polygons; p++) {
      this.offset[p] = total;
      total += adjacency[p].length;
    }
    this.reserve(polygons, total);
    const { g, f, parent, source, offset, state, entry } = this,
      gx = end[0],
      gy = end[1],
      gz = end[2],
      first = total;
    for (let p = 0; p < polygons; p++) source.fill(p, offset[p], offset[p] + adjacency[p].length);
    g.fill(Infinity, 0, total + 1);
    f.fill(Infinity, 0, total + 1);
    state.fill(0, 0, total + 1);
    // The start node enters `from` at `start`.
    source[first] = -1;
    g[first] = 0;
    f[first] = scale * distance(start, end);
    state[first] = 1;
    entry[first * 3] = start[0];
    entry[first * 3 + 1] = start[1];
    entry[first * 3 + 2] = start[2];
    const linkOf = (node: number) => adjacency[source[node]][node - offset[source[node]]];
    // Heap order: f, then where a node crosses and the middle of its portal, so equal costs fall the same way whatever
    // order polygons and links are kept in (a mesh loaded from a file numbers and stitches its tiles in another
    // order); the node index only splits what is left, parallel links.
    const tie = (n: number, node: number) => {
      for (let i = 0; i < 3; i++) {
        const d = entry[n * 3 + i] - entry[node * 3 + i];
        if (d) return d < 0;
      }
      if (n === first || node === first) return n === first;
      const p = linkOf(n),
        q = linkOf(node);
      for (let i = 0; i < 3; i++) {
        const d = p.left[i] + p.right[i] - q.left[i] - q.right[i];
        if (d) return d < 0;
      }
      return n < node;
    };
    const before = (k: number, n: number, key: number, node: number) => k < key || (k === key && n !== node && tie(n, node));
    // Open set as a binary heap in `before` order.
    let size = 1,
      heapKey = this.heapKey,
      heapNode = this.heapNode,
      goal = -1;
    heapKey[0] = f[first];
    heapNode[0] = first;
    while (goal < 0) {
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
            before(heapKey[child + 1], heapNode[child + 1], heapKey[child], heapNode[child])
          )
            child++;
          if (before(lastKey, lastNode, heapKey[child], heapNode[child])) break;
          heapKey[i] = heapKey[child];
          heapNode[i] = heapNode[child];
          i = child;
        }
        heapKey[i] = lastKey;
        heapNode[i] = lastNode;
        // Entries left behind by a later cost improvement or an already closed node are stale.
        if (state[node] === 1 && f[node] === key) {
          current = node;
          break;
        }
      }
      if (current < 0) return null;
      const polygon = current === first ? from : linkOf(current).to;
      if (polygon === to) {
        goal = current;
        break;
      }
      state[current] = 2;
      const links = adjacency[polygon],
        ex = entry[current * 3],
        ey = entry[current * 3 + 1],
        ez = entry[current * 3 + 2],
        // An agent standing in a blocked polygon may still walk out of it.
        rate = costs[polygon] < Infinity ? costs[polygon] : 1;
      for (let l = 0; l < links.length; l++) {
        const link = links[l],
          next = offset[polygon] + l;
        if (state[next] === 2 || !(costs[link.to] < Infinity)) continue;
        const a = link.start ?? link.left,
          b = link.start ?? link.right,
          t = crossing(ex, ez, a, b, gx, gz),
          mx = a[0] + t * (b[0] - a[0]),
          my = a[1] + t * (b[1] - a[1]),
          mz = a[2] + t * (b[2] - a[2]),
          landing = link.end ?? null,
          nx = landing ? landing[0] : mx,
          ny = landing ? landing[1] : my,
          nz = landing ? landing[2] : mz,
          candidate = g[current] + Math.hypot(mx - ex, my - ey, mz - ez) * rate + (link.cost ?? 0),
          key = candidate + scale * Math.hypot(nx - gx, ny - gy, nz - gz);
        if (!(key < f[next])) continue;
        entry[next * 3] = nx;
        entry[next * 3 + 1] = ny;
        entry[next * 3 + 2] = nz;
        parent[next] = current;
        g[next] = candidate;
        f[next] = key;
        state[next] = 1;
        if (size === heapKey.length) {
          const keys = new Float64Array(size * 2),
            nodes = new Int32Array(size * 2);
          keys.set(heapKey);
          nodes.set(heapNode);
          this.heapKey = heapKey = keys;
          this.heapNode = heapNode = nodes;
        }
        let i = size++;
        for (
          let up = (i - 1) >> 1;
          i > 0 && before(key, next, heapKey[up], heapNode[up]);
          i = up, up = (i - 1) >> 1
        ) {
          heapKey[i] = heapKey[up];
          heapNode[i] = heapNode[up];
        }
        heapKey[i] = key;
        heapNode[i] = next;
      }
    }
    this.cost =
      g[goal] + Math.hypot(gx - entry[goal * 3], gy - entry[goal * 3 + 1], gz - entry[goal * 3 + 2]) * costs[to];
    const corridor: Link[] = [];
    for (let node = goal; node !== first; node = parent[node]) corridor.push(linkOf(node));
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
