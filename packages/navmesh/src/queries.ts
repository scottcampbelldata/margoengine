// Clean-room convex clipping and local portal searches. Sources: docs/clean-room.md, batch 252.
import type { NavFilter, NavMesh, NavSurface, Vec3 } from './index.js';
import type { TiledNavMesh } from './tiles.js';
import { CorridorSearch, checkFilter, copy, cross, point, routeThrough, type NavRoute } from './search.js';

/** Meshes supported by the optional surface queries. Tile polygon ids are valid only until a rebuild. */
export type QueryMesh = NavMesh | TiledNavMesh;

/** Shared query settings. */
export interface NavQueryOptions {
  /** Area multipliers, as for `NavMesh.route`; Infinity forbids an area. Default no filter. */
  filter?: NavFilter;
  /** Starting polygon, useful on a shared edge. Default the vertically nearest polygon under the start. */
  startPolygon?: number;
}

/** A walkability ray result. End Y is ignored; position is projected onto the reached surface. */
export interface NavRaycastHit {
  /** True when a wall stops the ray before its destination. */
  hit: boolean;
  /** Fraction of the XZ segment reached, 0..1 (1 for an unobstructed ray). */
  t: number;
  /** Reached surface position. */
  position: Vec3;
  /** Outward unit wall normal in XZ, or [0,0,0] with no hit. */
  normal: Vec3;
  /** Hit polygon edge endpoints, or null with no hit. */
  edge: readonly [Vec3, Vec3] | null;
  /** Polygon containing position. */
  polygon: number;
  /** Connected polygon corridor from the start to the result. */
  visited: number[];
}

/** Constrained local movement result. */
export interface NavMoveResult {
  /** Closest reachable surface point to the requested destination in the local search. */
  position: Vec3;
  /** Polygon containing position. */
  polygon: number;
  /** Connected polygon corridor from the start to the result. */
  visited: number[];
}

/** A complete or partial route to a reachable surface point. */
export interface NavPartialRoute extends NavRoute {
  /** True when the requested goal polygon is unreachable or the goal is outside the mesh. */
  partial: boolean;
  /** Reached polygon, disambiguating shared boundaries and overlapping floors. */
  polygon: number;
}

const EPS = 1e-8;
const squared = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2;
const interpolate = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const onSegment = (p: Vec3, a: Vec3, b: Vec3): Vec3 => {
  const d = squared(a, b),
    t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[2] - a[2]) * (b[2] - a[2])) / d)) : 0;
  return interpolate(a, b, t);
};
const corridor = (parent: Map<number, number>, last: number): number[] => {
  const path = [last];
  while (parent.has(last)) path.push((last = parent.get(last)!));
  return path.reverse();
};

/** Optional walkability and controller queries on ordinary and tiled navmeshes. No off-mesh jumps are taken. */
export class NavMeshQuery implements NavSurface {
  /** Surface queried live, including its area costs and rebuilt tiles. */
  readonly mesh: QueryMesh;
  /** Creates queries without copying polygons or changing the mesh. */
  constructor(mesh: QueryMesh) {
    this.mesh = mesh;
  }
  /** Live surface revision, allowing a Crowd to replan partial routes after a change. */
  get version(): number {
    return this.mesh.version;
  }
  /** Polygon under a finite point, choosing the nearest floor, or -1. */
  locate(position: Vec3): number {
    return this.mesh.locate(position);
  }
  /** Closest surface point, as for the underlying mesh. */
  closestPoint(position: Vec3): { point: Vec3; polygon: number } | null {
    return this.mesh.closestPoint(position);
  }
  /** Height of a polygon plane at world-space XZ. */
  heightAt(polygon: number, x: number, z: number): number {
    return this.mesh.heightAt(polygon, x, z);
  }
  /** Area number used by Crowd's filter. */
  polygonArea(polygon: number): number {
    return this.mesh.polygonArea(polygon);
  }
  /**
   * Plans a complete path, or a partial path to the nearest reachable point (XZ distance, then vertical distance).
   * Directed off-mesh links and area costs apply. Null means there is no allowed start polygon.
   * @throws RangeError for invalid points or filters; use finite points and multipliers >= 1.
   */
  route(start: Vec3, end: Vec3, filter?: NavFilter): NavPartialRoute | null {
    const from = this.start(start, end, { filter });
    if (from < 0) return null;
    const to = this.mesh.locate(end),
      queue = [from],
      seen = new Set(queue);
    let last = from,
      best = this.nearest(from, end),
      distance = squared(best, end),
      height = Math.abs(best[1] - end[1]);
    for (let at = 0; at < queue.length; at++) {
      const p = queue[at],
        q = this.nearest(p, end),
        d = squared(q, end),
        h = Math.abs(q[1] - end[1]);
      if (d < distance || (d === distance && h < height)) {
        best = q;
        last = p;
        distance = d;
        height = h;
      }
      for (const link of this.mesh.polygonLinks(p))
        if (!seen.has(link.to) && this.allowed(link.to, filter)) {
          seen.add(link.to);
          queue.push(link.to);
        }
    }
    const partial = !seen.has(to);
    if (!partial) {
      last = to;
      best = this.project(to, end);
    }
    const mesh = this.mesh,
      adjacency =
        'vertices' in mesh
          ? Array.from({ length: mesh.polygonCount }, (_, p) => mesh.polygonLinks(p))
          : mesh.graph().adjacency,
      costs = new Float64Array(adjacency.length).fill(Infinity);
    let links = 0;
    for (const p of queue) {
      costs[p] = mesh.areaCost(p) * (filter?.[mesh.polygonArea(p)] ?? 1);
      links += adjacency[p].length;
    }
    const search = new CorridorSearch();
    search.reserve(adjacency.length, links);
    const found = search.find(from, last, this.project(from, start), best, adjacency.length, adjacency, costs)!;
    return { ...routeThrough(found, this.project(from, start), best), partial, polygon: last };
  }
  /** Complete or partial route waypoints, or null without an allowed starting polygon. */
  path(start: Vec3, end: Vec3, filter?: NavFilter): Vec3[] | null {
    return this.route(start, end, filter)?.points ?? null;
  }
  /** Crowd hook: preserve an unsnapped goal so an outside destination stays flagged partial. */
  partialRoute(start: Vec3, end: Vec3, filter?: NavFilter): NavPartialRoute | null {
    return this.route(start, end, filter);
  }
  private vertices(p: number): readonly Vec3[] {
    const mesh = this.mesh;
    return 'vertices' in mesh ? mesh.polygonVertices(p).map((i) => mesh.vertices[i]) : mesh.polygonPoints(p);
  }
  private allowed(p: number, filter?: NavFilter): boolean {
    return this.mesh.areaCost(p) < Infinity && (filter?.[this.mesh.polygonArea(p)] ?? 1) < Infinity;
  }
  private start(start: Vec3, end: Vec3, options: NavQueryOptions): number {
    point(start);
    point(end);
    if (options.filter) checkFilter(options.filter);
    const p = options.startPolygon ?? this.mesh.locate(start);
    if (p >= 0 && !this.clip(p, start, start))
      throw new RangeError('Start is outside startPolygon; use locate(start) or a containing polygon.');
    return p >= 0 && this.allowed(p, options.filter) ? p : -1;
  }
  private project(p: number, v: Vec3): Vec3 {
    return [v[0], this.mesh.heightAt(p, v[0], v[2]) || 0, v[2]];
  }
  /** Cyrus-Beck half-plane interval, including every tied exit at a polygon vertex. */
  private clip(p: number, start: Vec3, end: Vec3): { enter: number; exit: number; edges: number[] } | null {
    const v = this.vertices(p),
      sign = Math.sign(cross(v[0], v[1], v[2]));
    let enter = 0,
      exit = 1,
      edges: number[] = [];
    for (let i = 0; i < v.length; i++) {
      const a = v[i],
        b = v[(i + 1) % v.length],
        s = cross(a, b, start) * sign,
        e = cross(a, b, end) * sign,
        delta = e - s;
      if (Math.abs(delta) <= Number.EPSILON) {
        if (s < -EPS) return null;
      } else if (delta > 0) enter = Math.max(enter, -s / delta);
      else {
        const t = -s / delta;
        if (t < exit - EPS) {
          exit = t;
          edges = [i];
        } else if (Math.abs(t - exit) <= EPS) edges.push(i);
      }
    }
    return enter <= exit + EPS && exit >= -EPS && enter <= 1 + EPS
      ? { enter: Math.max(0, enter), exit: Math.max(0, Math.min(1, exit)), edges }
      : null;
  }
  private nearest(p: number, target: Vec3): Vec3 {
    if (this.clip(p, target, target)) return this.project(p, target);
    const v = this.vertices(p);
    let best = v[0],
      d = Infinity;
    for (let i = 0; i < v.length; i++) {
      const q = onSegment(target, v[i], v[(i + 1) % v.length]),
        distance = squared(target, q);
      if (distance < d) {
        best = q;
        d = distance;
      }
    }
    return this.project(p, best);
  }
  /**
   * Casts an XZ walkability segment, reporting a wall edge and outward normal. Null if the start is off mesh or forbidden.
   * @throws RangeError for non-finite points, invalid filters or a start outside the chosen polygon; use finite points and costs >= 1.
   */
  raycast(start: Vec3, end: Vec3, options: NavQueryOptions = {}): NavRaycastHit | null {
    const from = this.start(start, end, options);
    if (from < 0) return null;
    const queue = [from],
      seen = new Set(queue),
      parent = new Map<number, number>();
    let last = from,
      far = -1,
      hitEdges: number[] = [];
    for (let at = 0; at < queue.length; at++) {
      const p = queue[at],
        interval = this.clip(p, start, end)!;
      if (interval.exit > far) {
        far = interval.exit;
        last = p;
        hitEdges = interval.edges;
      }
      if (interval.exit >= 1) {
        return {
          hit: false,
          t: 1,
          position: this.project(p, end),
          normal: [0, 0, 0],
          edge: null,
          polygon: p,
          visited: corridor(parent, p),
        };
      }
      const crossing = interpolate(start, end, interval.exit);
      for (const link of this.mesh.polygonLinks(p)) {
        if (link.offMesh !== undefined || seen.has(link.to) || !this.allowed(link.to, options.filter)) continue;
        if (squared(crossing, onSegment(crossing, link.left, link.right)) > EPS ** 2) continue;
        const next = this.clip(link.to, start, end);
        if (!next || next.enter > interval.exit + EPS || next.exit < interval.exit - EPS) continue;
        seen.add(link.to);
        parent.set(link.to, p);
        queue.push(link.to);
      }
    }
    const v = this.vertices(last),
      sign = Math.sign(cross(v[0], v[1], v[2]));
    // At a corner pick the tied edge opposing the motion most strongly.
    let edge = hitEdges[0],
      opposition = -Infinity;
    for (const i of hitEdges) {
      const a = v[i],
        b = v[(i + 1) % v.length],
        length = Math.sqrt(squared(a, b)),
        dot = (sign * ((b[2] - a[2]) * (end[0] - start[0]) - (b[0] - a[0]) * (end[2] - start[2]))) / length;
      if (dot > opposition) {
        opposition = dot;
        edge = i;
      }
    }
    const a = v[edge],
      b = v[(edge + 1) % v.length],
      length = Math.sqrt(squared(a, b));
    return {
      hit: true,
      t: far,
      position: this.project(last, interpolate(start, end, far)),
      normal: [(sign * (b[2] - a[2])) / length, 0, (-sign * (b[0] - a[0])) / length],
      edge: [copy(a), copy(b)],
      polygon: last,
      visited: corridor(parent, last),
    };
  }
  /**
   * Moves to the nearest reachable point in a local portal search, sliding along walls. The search disk has the
   * requested segment as diameter; use small controller steps. Projects the result onto its polygon plane.
   * @throws RangeError for invalid points, filters or startPolygon; use a containing polygon and costs >= 1.
   */
  moveAlongSurface(start: Vec3, end: Vec3, options: NavQueryOptions = {}): NavMoveResult | null {
    const from = this.start(start, end, options);
    if (from < 0) return null;
    const center = interpolate(start, end, 0.5),
      radius2 = squared(start, end) / 4 + EPS,
      queue = [from],
      seen = new Set(queue),
      parent = new Map<number, number>();
    let best = this.nearest(from, end),
      last = from,
      distance = squared(best, end);
    for (let at = 0; at < queue.length; at++) {
      const p = queue[at],
        q = this.nearest(p, end),
        d = squared(q, end);
      if (d < distance) {
        best = q;
        distance = d;
        last = p;
      }
      if (distance === 0) break;
      for (const link of this.mesh.polygonLinks(p)) {
        if (link.offMesh !== undefined || seen.has(link.to) || !this.allowed(link.to, options.filter)) continue;
        if (squared(center, onSegment(center, link.left, link.right)) > radius2) continue;
        seen.add(link.to);
        parent.set(link.to, p);
        queue.push(link.to);
      }
    }
    return { position: best, polygon: last, visited: corridor(parent, last) };
  }
}
