// Exact shortest any-angle paths on a navmesh, clean room from the papers: M. Cui, D. D. Harabor and A. Grastien,
// "Compromise-free pathfinding on a navigation mesh", IJCAI 2017 (Polyanya), which extends the interval search of
// D. Harabor, A. Grastien, D. Öz and V. Aksakalli, "Optimal any-angle pathfinding in practice", JAIR 56, 2016 (Anya).
// Sources and Margo's own choices: docs/clean-room.md, "navmesh exact any-angle search".
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { NavFilter, NavSurface } from './index.js';
import { checkFilter, copy, crossing, heuristicScale, point, type Link, type NavRoute } from './search.js';

/** What the search reads of a mesh: `NavMesh`, `TiledNavMesh`, `VoxelNavMesh` and their like all do. */
export interface AnyAngleSurface {
  /** Counts changes that can change a path. */
  readonly version: number;
  /** Polygon under a position, or -1. */
  locate(position: Vec3): number;
  /** Corners of a polygon in winding order. */
  polygonPoints: NonNullable<NavSurface['polygonPoints']>;
  /** The ways out of a polygon: shared-edge portals, then off-mesh links. */
  polygonLinks: NonNullable<NavSurface['polygonLinks']>;
  /** Area number of a polygon, for filters. */
  polygonArea(index: number): number;
  /** Area cost multiplier of a polygon; only 1 and Infinity (blocked) can be searched exactly. Default 1. */
  areaCost?(index: number): number;
}

/** Options of one {@link AnyAngleSearch.route}. */
export interface AnyAngleOptions {
  /**
   * Cost per area number, as for `NavMesh.route`, here only 1 (walk it) or Infinity (a wall): the shortest path is
   * measured in distance. Default no filter.
   */
  filter?: NavFilter;
  /** Most search nodes one call may make before it gives up with a `MargoError`. Default 1,000,000. */
  maxNodes?: number;
}

/** The shortest path: its corners, its off-mesh crossings and its length. */
export interface AnyAngleRoute extends NavRoute {
  /**
   * Length in the ground plane (XZ) of the walked segments, plus the cost of each off-mesh link crossed. No path over
   * the mesh is shorter.
   */
  length: number;
  /** Search nodes taken from the open list: a work count that is the same on every machine. */
  expanded: number;
}

/** A position in the search: a copy of the mesh's own corner, or a point cut on a portal. */
interface Spot {
  p: Vec3;
  /** A taut path may bend here: a mesh corner on a wall. */
  corner: boolean;
}

/** One walkable way across a polygon's boundary. */
interface Door {
  /** Number among the doors of one layout. */
  id: number;
  to: number;
  a: Spot;
  b: Spot;
}

interface Jump {
  /** Index among all jumps, for the best cost found to its take-off. */
  id: number;
  to: number;
  start: Vec3;
  end: Vec3;
  cost: number;
}

/** A path so far: the last bend, and the bends before it. */
interface Trail {
  p: Vec3;
  previous: Trail | null;
  /** Set when the segment from `previous` to here is an off-mesh crossing. */
  jump: boolean;
}

/**
 * A search node (I, r): every point of the interval a..b on a portal is seen from the root r, and the path goes on
 * through it into `polygon`. `g` is the length to the root. Two more kinds end or restart a search: a finished path,
 * and an off-mesh crossing about to be taken.
 */
interface Node {
  f: number;
  g: number;
  order: number;
  trail: Trail;
  polygon: number;
  /** The portal the interval lies on, and the interval's ends. */
  door: Door | null;
  a: Spot | null;
  b: Spot | null;
  jump: Jump | null;
}

/** Lengths below this count as zero (mesh units): coincident points, a root on a line. */
const EPS = 1e-9;
/** How far off a polygon edge a portal end or a point may be and still lie on it (mesh units). */
const ON = 1e-6;

const side = (o: Vec3, a: Vec3, p: Vec3) => (a[0] - o[0]) * (p[2] - o[2]) - (a[2] - o[2]) * (p[0] - o[0]);
const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const between = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
/** Squared XZ distance from p to the segment a..b. */
function gap2(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0],
    dz = b[2] - a[2],
    length2 = dx * dx + dz * dz,
    t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / length2)) : 0;
  return (p[0] - a[0] - t * dx) ** 2 + (p[2] - a[2] - t * dz) ** 2;
}
const touches = (p: Vec3, a: Vec3, b: Vec3) => gap2(p, a, b) <= ON * ON;
/** Whether p lies on the endless line through a and b. */
const inLine = (p: Vec3, a: Vec3, b: Vec3) => Math.abs(side(a, b, p)) <= ON * flat(a, b);

/** The mesh as the search sees it under one filter: doors and jumps per polygon, built as polygons are reached. */
class Layout {
  private readonly doors = new Map<number, Door[]>();
  private readonly jumps = new Map<number, Jump[]>();
  private readonly walled = new Map<number, Vec3[]>();
  /** The connected region of each polygon already found, where no off-mesh link makes reach one way. */
  private readonly regions = new Map<number, ReadonlySet<number>>();
  private jumpCount = 0;
  private doorCount = 0;
  /** The A* estimate scale that keeps the straight line a lower bound with cheap off-mesh links. */
  scale = 1;

  constructor(
    private readonly mesh: AnyAngleSurface,
    private readonly filter: NavFilter | undefined,
  ) {}

  /**
   * Whether a polygon may be walked.
   * @throws RangeError for a finite area cost above 1, which a distance search cannot weigh.
   */
  open(p: number): boolean {
    const cost = (this.mesh.areaCost?.(p) ?? 1) * (this.filter?.[this.mesh.polygonArea(p)] ?? 1);
    if (cost === 1) return true;
    if (cost === Infinity) return false;
    throw new RangeError(
      'An exact any-angle path is the shortest in distance and cannot weigh area costs; use Infinity to forbid ' +
        'ground, or route() for weighted routes.',
    );
  }

  /** The walkable portals of a polygon. */
  doorsOf(p: number): Door[] {
    let doors = this.doors.get(p);
    if (doors) return doors;
    doors = [];
    const jumps: Jump[] = [];
    for (const link of this.mesh.polygonLinks(p) as readonly Link[]) {
      if (!this.open(link.to)) continue;
      if (link.offMesh !== undefined) {
        const cost = link.cost ?? 0;
        jumps.push({ id: this.jumpCount++, to: link.to, start: link.start!, end: link.end!, cost });
        this.scale = Math.min(this.scale, heuristicScale([{ start: link.start!, end: link.end!, cost }]));
        continue;
      }
      if (flat(link.left, link.right) <= EPS) continue;
      doors.push({
        id: this.doorCount++,
        to: link.to,
        a: { p: link.left, corner: this.isCorner(link.left, p) },
        b: { p: link.right, corner: this.isCorner(link.right, p) },
      });
    }
    this.doors.set(p, doors);
    this.jumps.set(p, jumps);
    return doors;
  }

  jumpsOf(p: number): Jump[] {
    this.doorsOf(p);
    return this.jumps.get(p)!;
  }

  /**
   * Whether a wall of any polygon around `v` ends there: only there can a shortest path bend. The walls of a vertex
   * may lie several polygons away from the portal that names it, so the whole fan is read.
   */
  private isCorner(v: Vec3, from: number): boolean {
    const fan = [from],
      seen = new Set(fan);
    for (let i = 0; i < fan.length; i++) {
      if (this.wallEnds(fan[i]).some((q) => Math.abs(q[0] - v[0]) <= ON && Math.abs(q[2] - v[2]) <= ON)) return true;
      for (const link of this.mesh.polygonLinks(fan[i]) as readonly Link[])
        if (link.offMesh === undefined && !seen.has(link.to) && touches(v, link.left, link.right)) {
          seen.add(link.to);
          if (this.open(link.to)) fan.push(link.to);
        }
    }
    return false;
  }

  /** The ends of a polygon's walls: what its edges keep once the walkable portals are taken out. */
  private wallEnds(p: number): Vec3[] {
    let ends = this.walled.get(p);
    if (ends) return ends;
    ends = [];
    const corners = this.mesh.polygonPoints(p),
      links = this.mesh.polygonLinks(p) as readonly Link[];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i],
        b = corners[(i + 1) % corners.length],
        dx = b[0] - a[0],
        dz = b[2] - a[2],
        length2 = dx * dx + dz * dz,
        length = Math.sqrt(length2),
        covered: [number, number][] = [];
      for (const link of links) {
        if (link.offMesh !== undefined || !inLine(link.left, a, b) || !inLine(link.right, a, b)) continue;
        if (!this.open(link.to)) continue;
        const l = ((link.left[0] - a[0]) * dx + (link.left[2] - a[2]) * dz) / length2,
          r = ((link.right[0] - a[0]) * dx + (link.right[2] - a[2]) * dz) / length2,
          low = Math.max(0, Math.min(l, r)),
          high = Math.min(1, Math.max(l, r));
        if (low < high) covered.push([low, high]);
      }
      covered.sort((x, y) => x[0] - y[0]);
      let end = 0;
      const wall = (low: number, high: number) => {
        if ((high - low) * length <= ON) return;
        ends!.push(between(a, b, low), between(a, b, high));
      };
      for (const [low, high] of covered) {
        wall(end, low);
        end = Math.max(end, high);
      }
      wall(end, 1);
    }
    this.walled.set(p, ends);
    return ends;
  }

  /** Polygons that walking and off-mesh links can reach from `from`; this also settles the estimate's scale. */
  reachable(from: number): ReadonlySet<number> {
    const known = this.regions.get(from);
    if (known) return known;
    const found = [from],
      seen = new Set(found);
    let oneWay = !this.open(from);
    const visit = (p: number) => {
      if (seen.has(p)) return;
      seen.add(p);
      found.push(p);
    };
    for (let i = 0; i < found.length; i++) {
      for (const door of this.doorsOf(found[i])) visit(door.to);
      for (const jump of this.jumpsOf(found[i])) {
        oneWay = true;
        visit(jump.to);
      }
    }
    // Portals lead both ways, so a region without links answers for every polygon in it.
    if (!oneWay) for (const p of found) this.regions.set(p, seen);
    return seen;
  }

  /** `from` and every polygon reached from it through portals that hold the point `at`: where it stands. */
  around(at: Vec3, from: number): number[] {
    const found = [from],
      seen = new Set(found);
    for (let i = 0; i < found.length; i++)
      for (const door of this.doorsOf(found[i]))
        if (!seen.has(door.to) && touches(at, door.a.p, door.b.p)) {
          seen.add(door.to);
          found.push(door.to);
        }
    return found;
  }
}

/** One query: the open list, the best length to each root and the goal. */
class Query {
  private readonly open: Node[] = [];
  private made = 0;
  /** Best length found to each root: a node that reaches its root by a longer way is never shortest. */
  private readonly roots = new Map<string, number>();
  /**
   * Best length at which a root's view of a polygon, or a bend's view of a portal, has been put on the open list. The
   * same view comes up again from every portal that holds the root and from every way of equal length, and without
   * this each copy would grow its own copy of everything behind it.
   */
  private readonly views = new Map<string, number>();
  private readonly taken: number[] = [];

  constructor(
    private readonly layout: Layout,
    private readonly end: Vec3,
    private readonly goals: ReadonlySet<number>,
    private readonly scale: number,
    private readonly maxNodes: number,
  ) {}

  private push(node: Omit<Node, 'order'>): void {
    if (this.made >= this.maxNodes)
      throw new MargoError('failed', 'Any-angle search passed maxNodes; raise it, or use route() on this mesh.');
    const { open } = this,
      next: Node = { ...node, order: this.made++ };
    let i = open.length;
    open.push(next);
    for (let up = (i - 1) >> 1; i > 0 && before(next, open[up]); i = up, up = (i - 1) >> 1) open[i] = open[up];
    open[i] = next;
  }

  private pop(): Node | undefined {
    const { open } = this,
      top = open[0],
      last = open.pop();
    if (!last || !open.length) return top;
    let i = 0;
    for (let child = 1; child < open.length; child = i * 2 + 1) {
      if (child + 1 < open.length && before(open[child + 1], open[child])) child++;
      if (before(last, open[child])) break;
      open[i] = open[child];
      i = child;
    }
    open[i] = last;
    return top;
  }

  /** Keeps the best length to a root; false when it was reached by a shorter way before. */
  private reach(p: Vec3, g: number): boolean {
    const spotted = name(p),
      best = this.roots.get(spotted);
    if (best !== undefined && g > best + EPS * (1 + best)) return false;
    if (best === undefined || g < best) this.roots.set(spotted, g);
    return true;
  }

  /** Whether a view is new, or reached by a shorter way than before; it is kept when so. */
  private first(view: string, g: number): boolean {
    const best = this.views.get(view);
    if (best !== undefined && g >= best - EPS * (1 + best)) return false;
    this.views.set(view, g);
    return true;
  }

  /** Offers the finished path and the off-mesh crossings that start in a polygon seen from the root through a..b. */
  private arrive(polygon: number, trail: Trail, g: number, a: Vec3, b: Vec3): void {
    if (this.goals.has(polygon)) {
      const via = bend(trail, this.end, a, b),
        total = g + via.length;
      this.push({ f: total, g: total, trail: via.trail, polygon: -1, door: null, a: null, b: null, jump: null });
    }
    for (const jump of this.layout.jumpsOf(polygon)) {
      const via = bend(trail, jump.start, a, b),
        total = g + via.length + jump.cost,
        best = this.taken[jump.id];
      if (best !== undefined && total >= best) continue;
      this.taken[jump.id] = total;
      this.push({
        f: total + this.scale * flat(jump.end, this.end),
        g: total,
        trail: via.trail,
        polygon: -1,
        door: null,
        a: null,
        b: null,
        jump,
      });
    }
  }

  /** Puts the interval a..b of a portal on the open list, seen from the end of `trail`. */
  private interval(trail: Trail, g: number, a: Spot, b: Spot, door: Door): void {
    if (flat(a.p, b.p) <= ON) return;
    const r = trail.p,
      t = crossing(r[0], r[2], a.p, b.p, this.end[0], this.end[2]),
      x = between(a.p, b.p, t);
    this.push({
      f: g + this.scale * (flat(r, x) + flat(x, this.end)),
      g,
      trail,
      polygon: door.to,
      door,
      a,
      b,
      jump: null,
    });
  }

  /**
   * Stands at the end of `trail`, a point of `from`: every polygon around the point is in plain view, so each of their
   * other portals is a whole interval seen from there.
   */
  stand(trail: Trail, g: number, from: number): void {
    const at = trail.p;
    if (!this.reach(at, g)) return;
    for (const polygon of this.layout.around(at, from)) {
      if (!this.first(`${name(at)}|${polygon}`, g)) continue;
      this.arrive(polygon, trail, g, at, at);
      for (const door of this.layout.doorsOf(polygon))
        if (!touches(at, door.a.p, door.b.p)) this.interval(trail, g, door.a, door.b, door);
    }
  }

  run(): { trail: Trail; length: number; expanded: number } | null {
    let expanded = 0;
    for (let node = this.pop(); node; node = this.pop()) {
      expanded++;
      if (node.jump) {
        if (node.g > this.taken[node.jump.id]) continue;
        const landed: Trail = { p: node.jump.end, previous: node.trail, jump: true };
        this.stand(landed, node.g, node.jump.to);
        continue;
      }
      if (!node.door) return { trail: node.trail, length: node.g, expanded };
      this.expand(node);
    }
    return null;
  }

  /** The successors of an interval node: what is seen on through it, and what a bend at either end opens up. */
  private expand(node: Node): void {
    const { trail, g, polygon } = node,
      { a: left, b: right } = node.door!,
      r = trail.p;
    let a = node.a!,
      b = node.b!;
    if (g > this.roots.get(name(r))! + EPS * (1 + g)) return;
    if (inLine(r, left.p, right.p)) {
      // The root sees along the portal: the way through it bends at the root itself, or at the nearer end.
      if (touches(r, a.p, b.p)) this.stand(trail, g, polygon);
      else {
        const near = flat(r, a.p) <= flat(r, b.p) ? a.p : b.p;
        this.stand({ p: near, previous: trail, jump: false }, g + flat(r, near), polygon);
      }
      return;
    }
    // From the root, a is the left end and b the right: side(r, a, b) < 0.
    if (side(r, a.p, b.p) > 0) [a, b] = [b, a];
    this.arrive(polygon, trail, g, a.p, b.p);
    for (const door of this.layout.doorsOf(polygon)) {
      if (this.deadEnd(door)) continue;
      if (inLine(door.a.p, left.p, right.p) && inLine(door.b.p, left.p, right.p)) {
        this.along(trail, g, node.door!, a, b, door);
        continue;
      }
      const p = door.a.p,
        q = door.b.p,
        // Positive left of the left ray, and positive right of the right ray; each is linear along the portal.
        l0 = side(r, a.p, p),
        l1 = side(r, a.p, q),
        r0 = -side(r, b.p, p),
        r1 = -side(r, b.p, q);
      const seen = cut(cut([0, 1], l0, l1, false), r0, r1, false);
      if (seen) this.interval(trail, g, spot(door, seen[0]), spot(door, seen[1]), door);
      if (a.corner) this.turn(trail, g, a.p, door, cut([0, 1], l0, l1, true));
      if (b.corner) this.turn(trail, g, b.p, door, cut([0, 1], r0, r1, true));
    }
  }

  /**
   * A portal on the same edge as the one the path came in by (a tile seam may put several on one edge). The one that
   * overlaps it leads back; one further along is reached by bending at the interval's end on that side and walking
   * the edge.
   */
  private along(trail: Trail, g: number, entry: Door, a: Spot, b: Spot, door: Door): void {
    const from = entry.a.p,
      dx = entry.b.p[0] - from[0],
      dz = entry.b.p[2] - from[2],
      place = (p: Vec3) => ((p[0] - from[0]) * dx + (p[2] - from[2]) * dz) / (dx * dx + dz * dz),
      middle = (place(door.a.p) + place(door.b.p)) / 2;
    if (middle > 0 && middle < 1) return;
    const [low, high] = place(a.p) <= place(b.p) ? [a, b] : [b, a];
    if (middle <= 0 && low.corner) this.turn(trail, g, low.p, door, [0, 1]);
    if (middle >= 1 && high.corner) this.turn(trail, g, high.p, door, [0, 1]);
  }

  /** The part of a portal that only a bend at `corner` opens up. */
  private turn(trail: Trail, g: number, corner: Vec3, door: Door, part: [number, number] | null): void {
    if (!part) return;
    const next: Trail = { p: corner, previous: trail, jump: false },
      length = g + flat(trail.p, corner),
      a = spot(door, part[0]),
      b = spot(door, part[1]);
    if (flat(a.p, b.p) <= ON || !this.reach(corner, length)) return;
    // What a bend shows of a portal depends only on where the path came from, the bend and the portal.
    if (!this.first(`${name(trail.p)}|${name(corner)}|${door.id}`, length)) return;
    this.interval(next, length, a, b, door);
  }

  /**
   * Whether a portal leads into a polygon with nowhere further to go and nothing to arrive at (the paper's dead end).
   */
  private deadEnd(door: Door): boolean {
    return (
      !this.goals.has(door.to) &&
      !this.layout.jumpsOf(door.to).length &&
      this.layout.doorsOf(door.to).every((d) => inLine(d.a.p, door.a.p, door.b.p) && inLine(d.b.p, door.a.p, door.b.p))
    );
  }
}

/** A point as a map key. */
const name = (p: Vec3) => `${p[0]},${p[1]},${p[2]}`;

/** Open list order: the least estimate, then the longer path so far (nearer the goal), then the older node. */
const before = (a: Node, b: Node) => a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.order < b.order)));

/** The point at t of a portal: its own end, with its corner flag, within the snap length. */
function spot(door: Door, t: number): Spot {
  const length = flat(door.a.p, door.b.p);
  if (t * length <= ON) return door.a;
  if ((1 - t) * length <= ON) return door.b;
  return { p: between(door.a.p, door.b.p, t), corner: false };
}

/**
 * The part of `range` where the line from v0 (at t = 0) to v1 (at t = 1) is at most 0, or with `above` greater
 * than 0; null when nothing is left.
 */
function cut(range: [number, number] | null, v0: number, v1: number, above: boolean): [number, number] | null {
  if (!range) return null;
  if (above) {
    v0 = -v0;
    v1 = -v1;
  }
  const from = v0 <= 0,
    to = v1 <= 0;
  let low = range[0],
    high = range[1];
  if (!from && !to) return null;
  if (from !== to) {
    const t = v0 / (v0 - v1);
    if (from) high = Math.min(high, t);
    else low = Math.max(low, t);
  }
  return high > low ? [low, high] : null;
}

/**
 * The shortest way from the root through the segment a..b to `target`, which lies beyond it in the same convex polygon:
 * straight, or bent at an end of the segment.
 */
function bend(trail: Trail, target: Vec3, a: Vec3, b: Vec3): { trail: Trail; length: number } {
  const r = trail.p,
    t = crossing(r[0], r[2], a, b, target[0], target[2]),
    x = between(a, b, t),
    first = flat(r, x),
    second = flat(x, target),
    // A crossing inside the segment is on the straight line; at an end it is a bend when the line turns there.
    turns = first > EPS && second > EPS && Math.abs(side(r, x, target)) > EPS * (first + second) && (t <= 0 || t >= 1);
  const corner: Trail = turns ? { p: t <= 0 ? a : b, previous: trail, jump: false } : trail;
  return {
    trail: { p: target, previous: corner, jump: false },
    length: turns ? first + second : flat(r, target),
  };
}

/**
 * Exact shortest any-angle paths over a navmesh: the path of least length in the ground plane, bending only at mesh
 * corners, not the shortest through one corridor of polygons as `route` gives. Make one per mesh and reuse it; it reads
 * the mesh again when its `version` changes.
 */
export class AnyAngleSearch {
  private readonly layouts = new Map<string, Layout>();
  private version: number;

  /** @throws TypeError for a mesh without `polygonPoints` and `polygonLinks`. */
  constructor(readonly mesh: AnyAngleSurface) {
    if (typeof mesh?.polygonPoints !== 'function' || typeof mesh.polygonLinks !== 'function')
      throw new TypeError('Pass a NavMesh, a TiledNavMesh or another mesh with polygonPoints and polygonLinks.');
    this.version = mesh.version;
  }

  private layout(filter: NavFilter | undefined): Layout {
    if (this.mesh.version !== this.version) {
      this.layouts.clear();
      this.version = this.mesh.version;
    }
    if (filter) checkFilter(filter);
    // Filters that forbid the same areas and weigh nothing else see the same walls.
    let key = '';
    if (filter)
      for (let area = 0; area < filter.length; area++) if (filter[area] !== 1) key += `${area}:${filter[area]};`;
    let layout = this.layouts.get(key);
    if (!layout) {
      // A few filters (agent types) are kept; a stream of new ones does not grow without end.
      if (this.layouts.size >= 8) this.layouts.clear();
      layout = new Layout(this.mesh, key ? Array.from(filter!) : undefined);
      this.layouts.set(key, layout);
    }
    return layout;
  }

  /** Waypoints of the shortest path from `start` to `end`, both included, or null: {@link AnyAngleSearch.route}. */
  path(start: Vec3, end: Vec3, options?: AnyAngleOptions): Vec3[] | null {
    return this.route(start, end, options)?.points ?? null;
  }

  /**
   * The shortest path from `start` to `end`, both included, with its off-mesh crossings and length, or null when an
   * end is off the mesh or forbidden, or no way connects them.
   * @throws RangeError for a point that is not finite, a filter below 1 or a finite area cost above 1.
   * @throws MargoError `failed` past `maxNodes`.
   */
  route(start: Vec3, end: Vec3, options: AnyAngleOptions = {}): AnyAngleRoute | null {
    const { filter, maxNodes = 1_000_000 } = options;
    if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError('maxNodes must be a positive whole number.');
    point(start);
    point(end);
    const from = this.mesh.locate(start),
      to = this.mesh.locate(end),
      layout = this.layout(filter);
    if (from < 0 || to < 0 || !layout.open(to)) return null;
    // A walker standing on forbidden ground may still leave it; weighted ground is refused here as anywhere.
    layout.open(from);
    const goals = new Set(layout.around(end, to));
    // The straight-line estimate needs the cheapest off-mesh link anywhere the search can go.
    const reachable = layout.reachable(from);
    if (![...goals].some((p) => reachable.has(p))) return null;
    const query = new Query(layout, copy(end), goals, layout.scale, maxNodes);
    query.stand({ p: copy(start), previous: null, jump: false }, 0, from);
    const found = query.run();
    if (!found) return null;
    const points: Vec3[] = [],
      offMesh: number[] = [],
      steps: Trail[] = [];
    for (let at: Trail | null = found.trail; at; at = at.previous) steps.push(at);
    for (let i = steps.length - 1; i >= 0; i--) {
      const { p, jump } = steps[i],
        last = points[points.length - 1];
      if (jump) offMesh.push(points.length - 1);
      else if (last && i > 0 && flat(last, p) <= ON && Math.abs(last[1] - p[1]) <= ON) continue;
      points.push(copy(p));
    }
    // A bend that lands on the end point leaves it twice.
    const n = points.length;
    if (n > 2 && flat(points[n - 2], points[n - 1]) <= ON && !offMesh.includes(n - 2)) points.splice(n - 2, 1);
    return { points, offMesh, length: found.length, expanded: found.expanded };
  }
}
