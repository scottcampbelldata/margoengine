// Any-angle paths over weighted ground with a proven lower bound, clean room from the papers. The least weighted path
// cannot be computed exactly with arithmetic and roots (J.-L. De Carufel, C. Grimm, A. Maheshwari, M. Owen and
// M. Smid, "A note on the unsolvability of the weighted region shortest path problem", Comput. Geom. 47, 2014), so
// this search brackets it: a feasible path above, a relaxation over pieces of the portals below, both refined until
// they agree. Sources and Margo's own choices: docs/clean-room.md, "navmesh weighted any-angle search".
import type { Vec3 } from '@margoengine/math';
import type { NavFilter, NavSurface } from './index.js';
import { checkFilter, copy, heuristicScale, point, type Link, type NavRoute } from './search.js';

/** What the search reads of a mesh: `NavMesh`, `TiledNavMesh`, `VoxelNavMesh` and their like all do. */
export interface WeightedAnyAngleSurface {
  /** Counts changes that can change a path. */
  readonly version: number;
  /** Polygon under a position, or -1. */
  locate(position: Vec3): number;
  /** The ways out of a polygon: shared-edge portals, then off-mesh links. */
  polygonLinks: NonNullable<NavSurface['polygonLinks']>;
  /** Area number of a polygon, for filters. */
  polygonArea(index: number): number;
  /** Area cost multiplier of a polygon, 1 or more, `Infinity` when blocked. Default 1. */
  areaCost?(index: number): number;
}

/** Options of one {@link WeightedAnyAngleSearch.route}. */
export interface WeightedAnyAngleOptions {
  /** Cost per area number, 1 or more or `Infinity`, multiplied with the area cost, as for `NavMesh.route`. */
  filter?: NavFilter;
  /**
   * The search stops once `cost <= lowerBound * (1 + tolerance)`: the path is then proved to cost at most this share
   * more than the best one. Proving a smaller share takes about four times the work for each halving of it. Default
   * 0.05.
   */
  tolerance?: number;
  /**
   * Most arcs one call weighs before it stops raising the bound and answers with what it has; the first search, which
   * finds the path, always finishes. Default 5,000,000.
   */
  maxWork?: number;
}

/** A path over weighted ground and what is proved about it. */
export interface WeightedAnyAngleRoute extends NavRoute {
  /** Cost of the returned path: XZ length times the polygon's weight, plus the cost of each off-mesh link. */
  cost: number;
  /** No path over the mesh costs less than this (to float64 rounding). */
  lowerBound: number;
  /** Arcs weighed: a work count that is the same on every machine. */
  work: number;
}

/** A walkable portal, once for both polygons it joins. */
interface Portal {
  a: Vec3;
  b: Vec3;
  /** The polygons it lies on. A forbidden start polygon is not listed. */
  sides: number[];
}

/** Lengths below this are not split further, and points this near are one point (mesh units). */
const ON = 1e-6;
/** Where on each portal the first search for a path stands, as fractions of it. */
const SAMPLES = Array.from({ length: 9 }, (_, i) => i / 8);

/** Squared XZ distance from (x, z) to the segment from (ax, az) to (bx, bz). */
function gap2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax,
    dz = bz - az,
    length2 = dx * dx + dz * dz;
  let t = length2 ? ((x - ax) * dx + (z - az) * dz) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x - ax - t * dx,
    pz = z - az - t * dz;
  return px * px + pz * pz;
}
const touches = (p: Vec3, a: Vec3, b: Vec3) => gap2(p[0], p[2], a[0], a[2], b[0], b[2]) <= ON * ON;
const between = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** The mesh as the search sees it under one filter, read as polygons are reached. */
class Ground {
  readonly portals: Portal[] = [];
  private readonly known = new Map<string, number>();
  private readonly doors = new Map<number, { portal: number; to: number }[]>();
  private readonly jumps = new Map<number, Link[]>();

  constructor(
    private readonly mesh: WeightedAnyAngleSurface,
    private readonly filter: NavFilter | undefined,
  ) {}

  /** Cost per metre of a polygon; `Infinity` when it may not be walked. */
  weight(p: number): number {
    const weight = (this.mesh.areaCost?.(p) ?? 1) * (this.filter?.[this.mesh.polygonArea(p)] ?? 1);
    if (!(weight >= 1)) throw new RangeError('Area costs must be 1 or more, or Infinity; fix the mesh area costs.');
    return weight;
  }

  /** The walkable portals of a polygon. */
  doorsOf(p: number): { portal: number; to: number }[] {
    let doors = this.doors.get(p);
    if (doors) return doors;
    doors = [];
    const jumps: Link[] = [],
      open = this.weight(p) < Infinity;
    for (const link of this.mesh.polygonLinks(p) as readonly Link[]) {
      if (!(this.weight(link.to) < Infinity)) continue;
      if (link.offMesh !== undefined) {
        jumps.push(link);
        continue;
      }
      const { left, right } = link;
      if (Math.hypot(right[0] - left[0], right[2] - left[2]) <= ON) continue;
      const ends = [`${left[0]},${left[1]},${left[2]}`, `${right[0]},${right[1]},${right[2]}`].sort(),
        key = `${Math.min(p, link.to)}|${Math.max(p, link.to)}|${ends[0]}|${ends[1]}`;
      let portal = this.known.get(key);
      if (portal === undefined) {
        portal = this.portals.length;
        this.portals.push({ a: left, b: right, sides: [] });
        this.known.set(key, portal);
      }
      const { sides } = this.portals[portal];
      if (open && !sides.includes(p)) sides.push(p);
      if (!sides.includes(link.to)) sides.push(link.to);
      doors.push({ portal, to: link.to });
    }
    this.doors.set(p, doors);
    this.jumps.set(p, jumps);
    return doors;
  }

  jumpsOf(p: number): Link[] {
    this.doorsOf(p);
    return this.jumps.get(p)!;
  }

  /** `from` and every polygon reached from it through portals that hold the point `at`: where it stands. */
  around(at: Vec3, from: number): number[] {
    const found = [from],
      seen = new Set(found);
    for (let i = 0; i < found.length; i++)
      for (const { portal, to } of this.doorsOf(found[i]))
        if (!seen.has(to) && touches(at, this.portals[portal].a, this.portals[portal].b)) {
          seen.add(to);
          found.push(to);
        }
    return found;
  }

  /** Polygons that walking and off-mesh links can reach from `from`. */
  reachable(from: number): number[] {
    const found = [from],
      seen = new Set(found);
    const visit = (p: number) => {
      if (seen.has(p)) return;
      seen.add(p);
      found.push(p);
    };
    for (let i = 0; i < found.length; i++) {
      for (const { to } of this.doorsOf(found[i])) visit(to);
      for (const { to } of this.jumpsOf(found[i])) visit(to);
    }
    return found;
  }
}

/** A node of one round: a fixed point (`portal` -1) or the piece from t `low` to t `high` of a portal. */
interface Node {
  portal: number;
  low: number;
  high: number;
  a: Vec3;
  b: Vec3;
  polygons: number[];
}

const spot = (p: Vec3, polygons: number[]): Node => ({ portal: -1, low: 0, high: 0, a: p, b: p, polygons });

/** An off-mesh link between two point nodes. */
interface Jump {
  from: number;
  to: number;
  cost: number;
}

/** A feasible path: its corners, the crossings among them and what it costs. */
interface Walk {
  points: Vec3[];
  offMesh: number[];
  cost: number;
}

/**
 * Moves the free points of a chain along their segments to the least sum of `weight[i] * length` of the leg ending at
 * point i (0 for an off-mesh leg). The sum is convex in the segment parameters, and each leg couples two neighbours,
 * so a projected Newton method with a tridiagonal system solves it (D. P. Bertsekas, "Projected Newton methods for
 * optimization problems with simple constraints", SIAM J. Control Optim. 20, 1982), with each length smoothed by a
 * shrinking term where points meet. Any t gives a real path, so nothing proved depends on how far this gets.
 */
function pull(a: Vec3[], b: Vec3[], weight: number[], t: Float64Array): void {
  const n = a.length,
    ex = Float64Array.from(a, (p, i) => b[i][0] - p[0]),
    ez = Float64Array.from(a, (p, i) => b[i][2] - p[2]),
    gradient = new Float64Array(n),
    diagonal = new Float64Array(n),
    coupling = new Float64Array(n),
    step = new Float64Array(n),
    pivot = new Float64Array(n),
    trial = new Float64Array(n);
  let reach = 0;
  for (let i = 1; i < n; i++) reach = Math.max(reach, Math.hypot(a[i][0] - a[0][0], a[i][2] - a[0][2]));
  const value = (at: Float64Array, soft: number) => {
    let sum = 0;
    for (let i = 1; i < n; i++) {
      if (!weight[i]) continue;
      const dx = a[i][0] + at[i] * ex[i] - a[i - 1][0] - at[i - 1] * ex[i - 1],
        dz = a[i][2] + at[i] * ez[i] - a[i - 1][2] - at[i - 1] * ez[i - 1];
      sum += weight[i] * Math.sqrt(dx * dx + dz * dz + soft * soft);
    }
    return sum;
  };
  for (let soft = (reach || 1) * 0.1; soft > (reach || 1) * 1e-10; soft *= 0.1) {
    let now = value(t, soft);
    for (let round = 0; round < 40; round++) {
      gradient.fill(0);
      diagonal.fill(0);
      coupling.fill(0);
      for (let i = 1; i < n; i++) {
        const w = weight[i];
        if (!w) continue;
        const j = i - 1,
          dx = a[i][0] + t[i] * ex[i] - a[j][0] - t[j] * ex[j],
          dz = a[i][2] + t[i] * ez[i] - a[j][2] - t[j] * ez[j],
          r = Math.sqrt(dx * dx + dz * dz + soft * soft),
          u = dx * ex[i] + dz * ez[i],
          v = dx * ex[j] + dz * ez[j];
        gradient[i] += (w * u) / r;
        gradient[j] -= (w * v) / r;
        diagonal[i] += w * ((ex[i] * ex[i] + ez[i] * ez[i]) / r - (u * u) / r ** 3);
        diagonal[j] += w * ((ex[j] * ex[j] + ez[j] * ez[j]) / r - (v * v) / r ** 3);
        coupling[i] = -w * ((ex[i] * ex[j] + ez[i] * ez[j]) / r - (u * v) / r ** 3);
      }
      // A parameter at an end that the slope pushes outward stays; the rest solve the tridiagonal Newton system.
      const held = (i: number) =>
        (!ex[i] && !ez[i]) || (t[i] <= 0 && gradient[i] > 0) || (t[i] >= 1 && gradient[i] < 0);
      for (let i = 0; i < n; i++) {
        if (held(i)) {
          pivot[i] = 0;
          step[i] = 0;
          continue;
        }
        const link = i && pivot[i - 1] ? coupling[i] / pivot[i - 1] : 0,
          own = diagonal[i] * (1 + 1e-9) + 1e-9;
        pivot[i] = Math.max(own - (link ? link * coupling[i] : 0), own * 1e-9);
        step[i] = -gradient[i] - (link ? link * step[i - 1] : 0);
      }
      for (let i = n - 1; i >= 0; i--) {
        if (!pivot[i]) continue;
        const next = i + 1 < n && pivot[i + 1] ? coupling[i + 1] * step[i + 1] : 0;
        step[i] = (step[i] - next) / pivot[i];
      }
      let better = Infinity;
      for (let size = 1; size > 1e-9; size *= 0.5) {
        let slope = 0;
        for (let i = 0; i < n; i++) {
          trial[i] = Math.max(0, Math.min(1, t[i] + size * step[i]));
          slope += gradient[i] * (trial[i] - t[i]);
        }
        const next = value(trial, soft);
        if (next <= now + 1e-4 * Math.min(0, slope) && next < now) {
          better = next;
          break;
        }
      }
      if (!(better < now)) break;
      const gain = now - better;
      t.set(trial);
      now = better;
      if (gain <= 1e-13 * now) break;
    }
  }
}

/** One round: the nodes, who shares a polygon with whom, and Dijkstra's searches from either end. */
class Round {
  private readonly members = new Map<number, number[]>();
  private readonly out = new Map<number, Jump[]>();
  private readonly into = new Map<number, Jump[]>();
  /** XZ ends of every node: ax, az, bx, bz. */
  private readonly ends: Float64Array;
  /** A lower bound of the cost still to walk from each node. */
  readonly ahead: Float64Array;
  work = 0;

  /** Node 0 is the start and node 1 the end. */
  constructor(
    readonly nodes: Node[],
    jumps: Jump[],
    private readonly weights: ReadonlyMap<number, number>,
    /** The polygon the walker leaves though it is forbidden, or -1: only the start walks in it. */
    private readonly forbidden: number,
    scale: number,
  ) {
    this.ends = new Float64Array(nodes.length * 4);
    this.ahead = new Float64Array(nodes.length);
    const goal = nodes[1].a;
    nodes.forEach(({ a, b, polygons }, i) => {
      this.ends.set([a[0], a[2], b[0], b[2]], i * 4);
      this.ahead[i] = scale * Math.sqrt(gap2(goal[0], goal[2], a[0], a[2], b[0], b[2]));
      for (const p of polygons) {
        let list = this.members.get(p);
        if (!list) this.members.set(p, (list = []));
        list.push(i);
      }
    });
    for (const jump of jumps) {
      (this.out.get(jump.from) ?? this.out.set(jump.from, []).get(jump.from)!).push(jump);
      (this.into.get(jump.to) ?? this.into.set(jump.to, []).get(jump.to)!).push(jump);
    }
  }

  /** Least XZ distance between two nodes' segments, which lie on the rim of one convex polygon and so never cross. */
  private apart(x: number, y: number): number {
    const e = this.ends,
      i = x * 4,
      j = y * 4;
    return Math.sqrt(
      Math.min(
        gap2(e[i], e[i + 1], e[j], e[j + 1], e[j + 2], e[j + 3]),
        gap2(e[i + 2], e[i + 3], e[j], e[j + 1], e[j + 2], e[j + 3]),
        gap2(e[j], e[j + 1], e[i], e[i + 1], e[i + 2], e[i + 3]),
        gap2(e[j + 2], e[j + 3], e[i], e[i + 1], e[i + 2], e[i + 3]),
      ),
    );
  }

  /**
   * Dijkstra from the start, or with `back` from the end against the arcs. A node has two states, `2 * node` reached
   * across a polygon and `2 * node + 1` reached along its own portal, which may not go on along it: a path walks one
   * stretch of a portal straight, and without this a chain of touching pieces would walk any portal for nothing.
   * States whose cost so far plus `rest` passes `limit()` are left out: no path that cheap goes through them.
   * `arrive` is called when the end is reached and stops the search by answering true. Unreached states hold
   * Infinity. Null once the round's `work` passes `cap`.
   */
  search(
    back: boolean,
    limit: () => number,
    rest: (state: number) => number,
    cap: number,
    arrive?: (parent: Int32Array, through: Int32Array) => boolean,
  ): Float64Array | null {
    const count = this.nodes.length * 2,
      best = new Float64Array(count).fill(Infinity),
      settled = new Float64Array(count).fill(Infinity),
      done = new Uint8Array(count),
      parent = new Int32Array(count).fill(-1),
      through = new Int32Array(count).fill(-1),
      keys: number[] = [],
      heap: number[] = [],
      source = back ? 2 : 0;
    const push = (key: number, state: number) => {
      let i = keys.length;
      for (let up = (i - 1) >> 1; i > 0 && keys[up] > key; i = up, up = (i - 1) >> 1) {
        keys[i] = keys[up];
        heap[i] = heap[up];
      }
      keys[i] = key;
      heap[i] = state;
    };
    // Forwards, a node already reached across at no more cost does all it could do reached along.
    const beaten = (state: number) => !back && (state & 1) === 1 && done[state - 1] === 1;
    const offer = (from: number, to: number, cost: number, polygon: number) => {
      if (done[to] || beaten(to) || !(cost < best[to]) || !(cost + rest(to) <= limit())) return;
      best[to] = cost;
      parent[to] = from;
      through[to] = polygon;
      push(cost, to);
    };
    best[source] = 0;
    push(0, source);
    while (keys.length) {
      const key = keys[0],
        state = heap[0],
        lastKey = keys.pop()!,
        last = heap.pop()!;
      if (keys.length) {
        let i = 0;
        for (let child = 1; child < keys.length; child = i * 2 + 1) {
          if (child + 1 < keys.length && keys[child + 1] < keys[child]) child++;
          if (lastKey <= keys[child]) break;
          keys[i] = keys[child];
          heap[i] = heap[child];
          i = child;
        }
        keys[i] = lastKey;
        heap[i] = last;
      }
      if (done[state] || key > best[state] || beaten(state)) continue;
      done[state] = 1;
      settled[state] = key;
      if (!back && state === 2 && arrive?.(parent, through)) return settled;
      const x = state >> 1,
        along = state & 1,
        { portal, polygons } = this.nodes[x];
      for (const p of polygons) {
        // A forbidden start polygon may be walked from the start point only.
        if (p === this.forbidden && !back && x !== 0) continue;
        const weight = p === this.forbidden ? 1 : this.weights.get(p)!;
        for (const y of this.members.get(p)!) {
          if (y === x || (back && p === this.forbidden && y !== 0)) continue;
          const same = portal >= 0 && this.nodes[y].portal === portal;
          // Forwards, a state reached along goes nowhere along; backwards, only such a state was reached along.
          if (same ? along !== (back ? 1 : 0) : back && along === 1) continue;
          this.work++;
          const cost = key + weight * this.apart(x, y);
          if (!back) offer(state, 2 * y + (same ? 1 : 0), cost, p);
          else {
            offer(state, 2 * y, cost, p);
            if (!same) offer(state, 2 * y + 1, cost, p);
          }
        }
      }
      // An off-mesh link lands across: backwards it is undone from that state alone, for either state of its take-off.
      if (!back || !along)
        for (const jump of (back ? this.into : this.out).get(x) ?? []) {
          this.work++;
          const y = back ? jump.from : jump.to;
          offer(state, 2 * y, key + jump.cost, -1);
          if (back) offer(state, 2 * y + 1, key + jump.cost, -1);
        }
      if (this.work > cap) return null;
    }
    return settled;
  }

  /** The cheapest real path through the portals a relaxed path goes through. */
  realise(portals: readonly Portal[], parent: Int32Array, through: Int32Array): Walk {
    const states: number[] = [];
    for (let at = 2; at >= 0; at = parent[at]) states.push(at);
    states.reverse();
    const chain = states.map((state) => state >> 1);
    const a: Vec3[] = [],
      b: Vec3[] = [],
      weight: number[] = [],
      t = new Float64Array(chain.length);
    let crossings = 0;
    chain.forEach((id, i) => {
      const node = this.nodes[id],
        portal = node.portal < 0 ? null : portals[node.portal];
      a.push(portal ? portal.a : node.a);
      b.push(portal ? portal.b : node.a);
      t[i] = portal ? (node.low + node.high) / 2 : 0;
      const p = i ? through[states[i]] : -1;
      weight.push(i && p >= 0 ? (p === this.forbidden ? 1 : this.weights.get(p)!) : 0);
      // An off-mesh leg costs what its cheapest link between these two nodes says.
      if (i && p < 0)
        crossings += Math.min(
          ...this.out
            .get(chain[i - 1])!
            .filter((j) => j.to === id)
            .map((j) => j.cost),
        );
    });
    pull(a, b, weight, t);
    const all = a.map((p, i) => {
      const length = Math.hypot(b[i][0] - p[0], b[i][2] - p[2]);
      if (t[i] * length <= ON) return p;
      if ((1 - t[i]) * length <= ON) return b[i];
      return between(p, b[i], t[i]);
    });
    let cost = crossings;
    for (let i = 1; i < all.length; i++)
      cost += weight[i] * Math.hypot(all[i][0] - all[i - 1][0], all[i][2] - all[i - 1][2]);
    const points: Vec3[] = [copy(all[0])],
      offMesh: number[] = [];
    for (let i = 1; i < all.length; i++) {
      const jump = !weight[i] && through[states[i]] < 0,
        p = all[i];
      if (jump) offMesh.push(points.length - 1);
      else {
        // Drop a point met twice, and one in the middle of a straight stretch.
        const last = points[points.length - 1];
        if (near(last, p)) {
          if (i === all.length - 1 && points.length > 1 && !offMesh.includes(points.length - 2))
            points[points.length - 1] = copy(p);
          else if (i === all.length - 1) points.push(copy(p));
          continue;
        }
        const n = points.length;
        if (n > 1 && !offMesh.includes(n - 2) && straight(points[n - 2], last, p)) points.pop();
      }
      points.push(copy(p));
    }
    return { points, offMesh, cost };
  }
}

const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= ON;
/** Whether b lies on the segment from a to c. */
function straight(a: Vec3, b: Vec3, c: Vec3): boolean {
  const d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    length2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (!length2) return false;
  const t = ((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1] + (b[2] - a[2]) * d[2]) / length2;
  return t >= 0 && t <= 1 && near(b, between(a, c, t));
}

/**
 * Any-angle paths over weighted ground (mud, roads, water) on a navmesh, bending where the weight pays for it and not
 * only along one corridor of polygons. The least cost cannot be computed exactly, so each answer carries a proven
 * lower bound beside the path's cost and the search refines until they differ by at most `tolerance`. For unweighted
 * ground use `AnyAngleSearch` of `./any-angle`, which is exact. Make one per mesh and reuse it; it reads the mesh again
 * when its `version` changes.
 */
export class WeightedAnyAngleSearch {
  private readonly grounds = new Map<string, Ground>();
  private version: number;

  /** @throws TypeError for a mesh without `polygonLinks` and `locate`. */
  constructor(readonly mesh: WeightedAnyAngleSurface) {
    if (typeof mesh?.polygonLinks !== 'function' || typeof mesh.locate !== 'function')
      throw new TypeError('Pass a NavMesh, a TiledNavMesh or another mesh with locate and polygonLinks.');
    this.version = mesh.version;
  }

  private ground(filter: NavFilter | undefined): Ground {
    if (this.mesh.version !== this.version) {
      this.grounds.clear();
      this.version = this.mesh.version;
    }
    if (filter) checkFilter(filter);
    let key = '';
    if (filter)
      for (let area = 0; area < filter.length; area++) if (filter[area] !== 1) key += `${area}:${filter[area]};`;
    let ground = this.grounds.get(key);
    if (!ground) {
      // A few filters (agent types) are kept; a stream of new ones does not grow without end.
      if (this.grounds.size >= 8) this.grounds.clear();
      ground = new Ground(this.mesh, key ? Array.from(filter!) : undefined);
      this.grounds.set(key, ground);
    }
    return ground;
  }

  /** Waypoints of a path from `start` to `end`, both included, or null: {@link WeightedAnyAngleSearch.route}. */
  path(start: Vec3, end: Vec3, options?: WeightedAnyAngleOptions): Vec3[] | null {
    return this.route(start, end, options)?.points ?? null;
  }

  /**
   * A path from `start` to `end`, both included, with its off-mesh crossings, its cost and a lower bound of the least
   * cost, or null when an end is off the mesh, the end is forbidden or no way connects them. When `maxWork` runs out
   * first, `cost / lowerBound - 1` says how far apart the two still are.
   * @throws RangeError for a point that is not finite, a filter or area cost below 1 or a bad option.
   */
  route(start: Vec3, end: Vec3, options: WeightedAnyAngleOptions = {}): WeightedAnyAngleRoute | null {
    const { filter, tolerance = 0.05, maxWork = 5_000_000 } = options;
    if (!(tolerance >= 0 && tolerance < Infinity))
      throw new RangeError('tolerance must be a finite number, 0 or more.');
    if (!Number.isInteger(maxWork) || maxWork < 1) throw new RangeError('maxWork must be a positive whole number.');
    point(start);
    point(end);
    const from = this.mesh.locate(start),
      to = this.mesh.locate(end),
      ground = this.ground(filter);
    if (from < 0 || to < 0 || !(ground.weight(to) < Infinity)) return null;
    const forbidden = ground.weight(from) < Infinity ? -1 : from,
      reachable = ground.reachable(from),
      goals = ground.around(end, to);
    if (!goals.some((p) => reachable.includes(p))) return null;
    const weights = new Map(reachable.map((p) => [p, ground.weight(p)] as const)),
      nodes: Node[] = [spot(copy(start), ground.around(start, from)), spot(copy(end), goals)],
      jumps: Jump[] = [],
      used = new Set<number>();
    let scale = 1;
    for (const p of reachable) {
      for (const { portal } of ground.doorsOf(p)) used.add(portal);
      for (const link of ground.jumpsOf(p)) {
        const cost = link.cost ?? 0;
        scale = Math.min(scale, heuristicScale([{ start: link.start!, end: link.end!, cost }]));
        jumps.push({ from: nodes.length, to: nodes.length + 1, cost });
        nodes.push(
          spot(link.start!, ground.around(link.start!, p)),
          spot(link.end!, ground.around(link.end!, link.to)),
        );
      }
    }
    const fixed = nodes.length;
    let pieces: Node[] = [...used].map((portal) => {
      const { a, b, sides } = ground.portals[portal];
      // A portal of the forbidden start polygon still opens it from the start.
      const leaves = forbidden >= 0 && ground.doorsOf(forbidden).some((d) => d.portal === portal);
      return { portal, low: 0, high: 1, a, b, polygons: leaves ? [...sides, forbidden] : sides };
    });
    let best: Walk = { points: [], offMesh: [], cost: Infinity };
    /** Takes the real path along a relaxed one when it is the cheapest yet; `stop` ends the search there. */
    const keep = (round: Round, stop: boolean) => (parent: Int32Array, through: Int32Array) => {
      const walk = round.realise(ground.portals, parent, through);
      if (walk.cost < best.cost) best = walk;
      return stop;
    };
    // First a real path: Dijkstra between points on the portals (Lanthier, Maheshwari and Sack 2001), then pulled tight
    // in the portals it goes through.
    const samples = pieces.flatMap((piece) =>
        SAMPLES.map((t): Node => {
          const at = between(piece.a, piece.b, t);
          return { ...piece, low: t, high: t, a: at, b: at };
        }),
      ),
      seed = new Round([...nodes, ...samples], jumps, weights, forbidden, scale);
    seed.search(
      false,
      () => Infinity,
      () => 0,
      Infinity,
      keep(seed, true),
    );
    if (best.cost === Infinity) return null;
    // No path costs less than the straight line, scaled for cheap off-mesh links.
    let lower = seed.ahead[0],
      work = seed.work,
      round = new Round([...nodes, ...pieces], jumps, weights, forbidden, scale);
    // The bound still to be proved. Whatever is shown to cost this much or more can be left out of the search.
    const wanted = () => best.cost / (1 + tolerance);
    while (work < maxWork && best.cost - lower > tolerance * lower + 1e-9) {
      const here = round,
        forward = here.search(false, wanted, (state) => here.ahead[state >> 1], maxWork - work, keep(here, false));
      // Every path left out costs `wanted` or more, and every other costs at least its relaxed path.
      if (forward) lower = Math.max(lower, Math.min(forward[2], wanted()));
      const backward =
        forward &&
        best.cost - lower > tolerance * lower + 1e-9 &&
        // A state reached along that was beaten by the one reached across costs at least as much to reach: it keeps
        // that cost here, or the search from the end would lose the paths through it and drop their pieces.
        here.search(
          true,
          wanted,
          (state) => (state & 1 && forward[state] === Infinity ? forward[state - 1] : forward[state]),
          maxWork - work,
        );
      work += here.work;
      if (!forward || !backward) break;
      // A piece whose cheapest relaxed path already costs `wanted` has nothing left to prove and goes. The widest of
      // the others are split.
      const halves: { piece: Node; width: number }[] = [];
      let widest = 0;
      for (let i = fixed; i < here.nodes.length; i++) {
        const through = Math.min(forward[2 * i] + backward[2 * i], forward[2 * i + 1] + backward[2 * i + 1]);
        if (!(through < wanted())) continue;
        const piece = here.nodes[i],
          length = Math.hypot(piece.b[0] - piece.a[0], piece.b[2] - piece.a[2]);
        let width = 0;
        if (length > ON * 2) {
          for (const p of piece.polygons) if (p !== forbidden) width = Math.max(width, weights.get(p)! * length);
          widest = Math.max(widest, width);
        }
        halves.push({ piece, width });
      }
      if (!widest) break;
      pieces = halves.flatMap(({ piece, width }) => {
        if (width < widest / 2) return [piece];
        const middle = (piece.low + piece.high) / 2,
          { a, b } = ground.portals[piece.portal],
          at = between(a, b, middle);
        return [
          { ...piece, high: middle, b: at },
          { ...piece, low: middle, a: at },
        ];
      });
      round = new Round([...nodes, ...pieces], jumps, weights, forbidden, scale);
    }
    return { ...best, lowerBound: Math.min(lower, best.cost), work };
  }
}
