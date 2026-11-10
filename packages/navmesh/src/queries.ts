// Clean-room convex clipping and local portal searches. Sources: docs/clean-room.md, batch 252.
import type { NavFilter, NavMesh, NavSurface, Vec3 } from './index.js';
import { createRandom } from '@margoengine/math/mathutils';
import { MargoError } from '@margoengine/math/errors';
import type { TiledNavMesh } from './tiles.js';
import {
  CorridorSearch,
  checkFilter,
  copy,
  cross,
  heuristicScale,
  point,
  routeThrough,
  type Link,
  type NavRoute,
} from './search.js';

/** Meshes supported by the optional surface queries. Tile polygon ids are valid only until a rebuild. */
export type QueryMesh = NavMesh | TiledNavMesh;

/** Query construction settings. */
export interface NavMeshQueryOptions {
  /** Seed of this query's independent random stream. Default 0. Must be a 32-bit integer. */
  seed?: number;
}

/** Settings for uniform surface sampling. */
export interface NavSampleOptions extends NavQueryOptions {
  /** One-shot seed instead of advancing the query's stream. Default use the stream. */
  seed?: number;
  /** Maximum rejection proposals for a strict-radius sample. Default 65536, positive integer. */
  maxSamples?: number;
}

/** A sampled point and its current polygon. */
export interface NavRandomPoint {
  /** Uniform surface-area sample. */
  point: Vec3;
  /** Polygon containing the point. */
  polygon: number;
}

/** Nearest reachable wall within a search radius. */
export interface NavWallHit {
  /** XZ distance, equal to the search radius when no wall was found. */
  distance: number;
  /** Surface point on the wall, or null without a wall in range. */
  position: Vec3 | null;
  /** Unit XZ direction from wall to center; inward wall normal at zero distance, zero without a hit. */
  normal: Vec3;
  /** Wall segment endpoints after subtracting open portal intervals, or null. */
  edge: readonly [Vec3, Vec3] | null;
  /** Polygon containing the wall, or -1 without a hit. */
  polygon: number;
}

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

const checkSeed = (seed: number) => {
  if (!Number.isInteger(seed) || seed < -2147483648 || seed > 4294967295)
    throw new RangeError('Seed must be a 32-bit integer; pass a value from -2147483648 to 4294967295.');
  return seed;
};
const checkRadius = (radius: number) => {
  if (!(radius >= 0)) throw new RangeError('Radius must be nonnegative; pass 0 or more, or Infinity.');
};
/** Clip a convex surface polygon to the radius bounding square, retaining interpolated heights. */
function squareClip(vertices: readonly Vec3[], center: Vec3, radius: number): readonly Vec3[] {
  let result = [...vertices];
  for (const axis of [0, 2])
    for (const sign of [-1, 1]) {
      const before = result;
      result = [];
      for (let i = 0; i < before.length; i++) {
        const a = before[i],
          b = before[(i + 1) % before.length],
          da = radius - sign * (a[axis] - center[axis]),
          db = radius - sign * (b[axis] - center[axis]);
        if (da >= 0) result.push(a);
        if (da >= 0 !== db >= 0) result.push(interpolate(a, b, da / (da - db)));
      }
    }
  return result;
}

/** Optional routes, walkability, wall and sampling queries on ordinary and tiled navmeshes. */
export class NavMeshQuery implements NavSurface {
  /** Surface queried live, including its area costs and rebuilt tiles. */
  readonly mesh: QueryMesh;
  private readonly random: () => number;
  /** Creates queries without copying polygons or changing the mesh. */
  constructor(mesh: QueryMesh, options: NavMeshQueryOptions = {}) {
    this.mesh = mesh;
    this.random = createRandom(checkSeed(options.seed ?? 0));
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
    const offMesh: { start: Vec3; end: Vec3; cost: number }[] = [];
    for (const p of queue) {
      costs[p] = mesh.areaCost(p) * (filter?.[mesh.polygonArea(p)] ?? 1);
      links += adjacency[p].length;
      for (const link of adjacency[p] as readonly Link[])
        if (link.offMesh !== undefined && link.start && link.end)
          offMesh.push({ start: link.start, end: link.end, cost: link.cost ?? 0 });
    }
    const search = new CorridorSearch();
    search.reserve(adjacency.length, links);
    const found = search.find(
      from,
      last,
      this.project(from, start),
      best,
      adjacency.length,
      adjacency,
      costs,
      heuristicScale(offMesh),
    )!;
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
  private ids(): number[] {
    const mesh = this.mesh;
    return 'vertices' in mesh
      ? Array.from({ length: mesh.polygonCount }, (_, i) => i)
      : mesh.graph().owners.flatMap((owner, i) => (owner ? [i] : []));
  }
  private region(center: Vec3, radius: number, options: NavQueryOptions): number[] {
    const from = this.start(center, center, options);
    if (from < 0) return [];
    const queue = [from],
      seen = new Set(queue);
    for (let at = 0; at < queue.length; at++)
      for (const link of this.mesh.polygonLinks(queue[at])) {
        if (link.offMesh !== undefined || seen.has(link.to) || !this.allowed(link.to, options.filter)) continue;
        if (squared(center, onSegment(center, link.left, link.right)) > radius * radius) continue;
        seen.add(link.to);
        queue.push(link.to);
      }
    return queue;
  }
  /**
   * Uniform surface-area sample across all allowed polygons, including disconnected islands. Null if none are allowed.
   * @throws RangeError for an invalid filter or seed; use costs >= 1 and a 32-bit integer seed.
   */
  randomPoint(options: NavSampleOptions = {}): NavRandomPoint | null {
    if (options.filter) checkFilter(options.filter);
    return this.sample(
      this.ids().filter((p) => this.allowed(p, options.filter)),
      options,
    );
  }
  /**
   * Uniform surface-area sample strictly inside the XZ radius and the connected ground portal neighborhood.
   * No off-mesh links. Radius zero returns the start on its plane. Null without an allowed start.
   * @throws RangeError for invalid points, radius, filter, seed or maxSamples; use finite points and valid nonnegative bounds.
   * @throws MargoError `failed` if rejection proposals exhaust maxSamples; increase maxSamples for a grazing intersection.
   */
  randomPointAroundCircle(center: Vec3, radius: number, options: NavSampleOptions = {}): NavRandomPoint | null {
    checkRadius(radius);
    const ids = this.region(center, radius, options);
    if (!ids.length) return null;
    if (radius === 0) return { point: this.project(ids[0], center), polygon: ids[0] };
    return this.sample(ids, options, Number.isFinite(radius) ? { center, radius } : undefined);
  }
  private sample(
    ids: number[],
    options: NavSampleOptions,
    disk?: { center: Vec3; radius: number },
  ): NavRandomPoint | null {
    const random = options.seed === undefined ? this.random : createRandom(checkSeed(options.seed)),
      max = options.maxSamples ?? 65536,
      triangles: { a: Vec3; b: Vec3; c: Vec3; polygon: number; sum: number }[] = [];
    if (!Number.isInteger(max) || max < 1 || max > 10000000)
      throw new RangeError('maxSamples must be an integer from 1 to 10000000; pass a bounded proposal count.');
    let sum = 0;
    for (const polygon of ids) {
      const vertices = disk ? squareClip(this.vertices(polygon), disk.center, disk.radius) : this.vertices(polygon);
      for (let i = 1; i + 1 < vertices.length; i++) {
        const a = vertices[0],
          b = vertices[i],
          c = vertices[i + 1],
          ux = b[0] - a[0],
          uy = b[1] - a[1],
          uz = b[2] - a[2],
          vx = c[0] - a[0],
          vy = c[1] - a[1],
          vz = c[2] - a[2],
          area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        if (area > 0) triangles.push({ a, b, c, polygon, sum: (sum += area) });
      }
    }
    if (!triangles.length) return null;
    for (let proposal = 0; proposal < max; proposal++) {
      const pick = random() * sum;
      let low = 0,
        high = triangles.length - 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (pick < triangles[mid].sum) high = mid;
        else low = mid + 1;
      }
      const { a, b, c, polygon } = triangles[low],
        root = Math.sqrt(random()),
        v = random(),
        p: Vec3 = [
          a[0] * (1 - root) + root * ((1 - v) * b[0] + v * c[0]),
          a[1] * (1 - root) + root * ((1 - v) * b[1] + v * c[1]),
          a[2] * (1 - root) + root * ((1 - v) * b[2] + v * c[2]),
        ];
      if (!disk || squared(p, disk.center) <= disk.radius ** 2) return { point: p, polygon };
    }
    throw new MargoError(
      'failed',
      'Surface sampling exhausted maxSamples; increase the proposal bound for a grazing circle intersection.',
    );
  }
  /** Open portals are subintervals of edges, especially at tile seams. Their complement is the wall. */
  private walls(p: number, filter?: NavFilter): (readonly [Vec3, Vec3])[] {
    const v = this.vertices(p),
      walls: (readonly [Vec3, Vec3])[] = [];
    for (let i = 0; i < v.length; i++) {
      const a = v[i],
        b = v[(i + 1) % v.length],
        dx = b[0] - a[0],
        dz = b[2] - a[2],
        length = dx * dx + dz * dz,
        parameter = (q: Vec3) => ((q[0] - a[0]) * dx + (q[2] - a[2]) * dz) / length,
        intervals: [number, number][] = [];
      for (const link of this.mesh.polygonLinks(p)) {
        if (link.offMesh !== undefined || !this.allowed(link.to, filter)) continue;
        if (
          Math.abs(cross(a, b, link.left)) > EPS * Math.sqrt(length) ||
          Math.abs(cross(a, b, link.right)) > EPS * Math.sqrt(length)
        )
          continue;
        const l = parameter(link.left),
          r = parameter(link.right),
          low = Math.max(0, Math.min(l, r)),
          high = Math.min(1, Math.max(l, r));
        if (low < high) intervals.push([low, high]);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      let end = 0;
      for (const [low, high] of intervals) {
        if (low > end) walls.push([interpolate(a, b, end), interpolate(a, b, low)]);
        end = Math.max(end, high);
      }
      if (end < 1) walls.push([interpolate(a, b, end), copy(b)]);
    }
    return walls;
  }
  /**
   * Finds the nearest wall in the connected ground neighborhood, treating forbidden portals as walls.
   * @throws RangeError for invalid center, radius, filter or startPolygon; use finite points and nonnegative bounds.
   */
  distanceToWall(center: Vec3, maxRadius = Infinity, options: NavQueryOptions = {}): NavWallHit | null {
    checkRadius(maxRadius);
    const ids = this.region(center, maxRadius, options);
    if (!ids.length) return null;
    let best: NavWallHit = { distance: maxRadius, position: null, normal: [0, 0, 0], edge: null, polygon: -1 };
    for (const p of ids)
      for (const edge of this.walls(p, options.filter)) {
        const q = onSegment(center, edge[0], edge[1]),
          d = Math.sqrt(squared(center, q));
        if (d > best.distance || (d === best.distance && best.position)) continue;
        const v = this.vertices(p),
          sign = Math.sign(cross(v[0], v[1], v[2])),
          length = Math.sqrt(squared(edge[0], edge[1]));
        best = {
          distance: d,
          position: this.project(p, q),
          polygon: p,
          edge,
          normal:
            d > 0
              ? [(center[0] - q[0]) / d, 0, (center[2] - q[2]) / d]
              : [(-sign * (edge[1][2] - edge[0][2])) / length, 0, (sign * (edge[1][0] - edge[0][0])) / length],
        };
      }
    return best;
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
