import type { Vec3 } from '@margoengine/math';

export type { Vec3 };
interface Link {
  to: number;
  left: Vec3;
  right: Vec3;
  cost: number;
  /** Off-mesh link id, for a jump, ladder or teleport link; undefined for a shared-edge portal. */
  offMesh?: number;
  /** Off-mesh link ends: where the agent leaves this polygon and where it lands. */
  start?: Vec3;
  end?: Vec3;
}

/** Options of {@link NavMesh.addOffMeshLink}. */
export interface OffMeshLinkOptions {
  /** Also usable from `end` back to `start` (default true; false for a drop down a ledge). */
  bidirectional?: boolean;
  /** Path cost of crossing the link, in distance units (default the distance from `start` to `end`). */
  cost?: number;
}

/** A path with the waypoints where off-mesh links start ({@link NavMesh.route}). */
export interface NavRoute {
  /** Corner points from the start to the end, both included. */
  points: Vec3[];
  /** Indices `i` into `points` where the segment from `points[i]` to `points[i + 1]` crosses an off-mesh link. */
  offMesh: number[];
}
interface Polygon {
  vertices: readonly number[];
  center: Vec3;
  links: Link[];
  plane: readonly [number, number, number, number];
}
const cross = (a: Vec3, b: Vec3, c: Vec3) => (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
/** Same point within the point-equality floor (1e-8 per axis, our own choice). */
const same = (a: Vec3, b: Vec3) =>
  a === b || (Math.abs(a[0] - b[0]) <= 1e-8 && Math.abs(a[1] - b[1]) <= 1e-8 && Math.abs(a[2] - b[2]) <= 1e-8);
const copy = (v: Vec3) => [v[0], v[1], v[2]] as unknown as Vec3;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function point(value: Vec3): void {
  if (value.length !== 3 || value.some((v) => !Number.isFinite(Math.fround(v))))
    throw new RangeError('Point must be finite [x, y, z]; pass numbers.');
}

/** Convex planar walkable polygons, linked by shared vertex-index edges. */
export class NavMesh {
  /** Copies of the vertex positions given to the constructor. */
  readonly vertices: readonly Vec3[];
  private readonly polygons: Polygon[] = [];
  /** Flat copies for the hot loops: per polygon its winding sign, per edge the XZ start and direction. */
  private readonly signs: Float64Array;
  private readonly edgeStart: Int32Array;
  private readonly edges: Float64Array;
  /** Search state reused by every path call; the heap holds one entry per improved polygon cost. */
  private readonly g: Float64Array;
  private readonly f: Float64Array;
  private readonly h: Float64Array;
  private readonly parent: Int32Array;
  private readonly state: Uint8Array;
  private heapKey: Float64Array;
  private heapNode: Int32Array;
  /** Link (index into the parent polygon's links) the search arrived by, per polygon. */
  private readonly parentLink: Int32Array;
  /** Area cost multiplier per polygon: 1 by default, Infinity when blocked. */
  private readonly costs: Float64Array;
  private nextLink = 1;
  /** Bumped by every change that can change a route: area costs and off-mesh links. */
  private changes = 0;
  /**
   * Builds the mesh from world-space vertices and polygons given as vertex-index lists (3..32 each).
   * @throws RangeError for fewer than 3 or more than 100,000 vertices, no or more than 4096 polygons, non-finite
   * vertices, or polygons that are not strictly convex and planar or have no XZ extent.
   * @throws TypeError for out-of-range, repeated or non-integer polygon indices.
   */
  constructor(vertices: readonly Vec3[], polygons: readonly (readonly number[])[]) {
    if (vertices.length < 3 || vertices.length > 100_000 || !polygons.length || polygons.length > 4096)
      throw new RangeError('Navmesh needs 3-100000 vertices and 1-4096 polygons; split bigger levels.');
    this.vertices = vertices.map((v) => {
      point(v);
      return [...v] as unknown as Vec3;
    });
    const edges = new Map<string, { polygon: number; a: number; b: number; linked: boolean }>();
    for (const indices of polygons) {
      if (
        indices.length < 3 ||
        indices.length > 32 ||
        new Set(indices).size !== indices.length ||
        indices.some((id) => !Number.isInteger(id) || id < 0 || id >= vertices.length)
      )
        throw new TypeError('Polygons need 3+ distinct vertex indices; fix them.');
      const a = this.vertices[indices[0]],
        b = this.vertices[indices[1]],
        c = this.vertices[indices[2]],
        ux = b[0] - a[0],
        uy = b[1] - a[1],
        uz = b[2] - a[2],
        vx = c[0] - a[0],
        vy = c[1] - a[1],
        vz = c[2] - a[2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx,
        length = Math.hypot(nx, ny, nz),
        plane: [number, number, number, number] = [
          nx / length,
          ny / length,
          nz / length,
          -(nx * a[0] + ny * a[1] + nz * a[2]) / length,
        ];
      if (!length || Math.abs(plane[1]) < 1e-6) throw new RangeError('Walkable polygons need a nonzero XZ projection');
      const sign = Math.sign(cross(a, b, c));
      for (let i = 0; i < indices.length; i++) {
        const p = this.vertices[indices[i]],
          q = this.vertices[indices[(i + 1) % indices.length]],
          r = this.vertices[indices[(i + 2) % indices.length]];
        if (
          cross(p, q, r) * sign <= 1e-10 ||
          Math.abs(plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] + plane[3]) > 1e-4
        )
          throw new RangeError('Navmesh polygons must be strictly convex and planar');
        for (const id of indices)
          if (cross(p, q, this.vertices[id]) * sign < -1e-10)
            throw new RangeError('Navmesh polygons must be strictly convex and planar');
      }
      const center: [number, number, number] = [0, 0, 0];
      for (const id of indices)
        for (let axis = 0; axis < 3; axis++) center[axis] += this.vertices[id][axis] / indices.length;
      const polygon = this.polygons.length;
      this.polygons.push({ vertices: [...indices], center, plane, links: [] });
      for (let i = 0; i < indices.length; i++) {
        const a = indices[i],
          b = indices[(i + 1) % indices.length],
          key = `${Math.min(a, b)}:${Math.max(a, b)}`,
          edge = edges.get(key);
        if (!edge) {
          edges.set(key, { polygon, a, b, linked: false });
          continue;
        }
        if (edge.linked) throw new TypeError('Edge shared by 3+ polygons; keep at most two.');
        edge.linked = true;
        for (const [from, to] of [
          [polygon, edge.polygon],
          [edge.polygon, polygon],
        ]) {
          // The source polygon is strictly on one side of its edge. Center-to-center rays may miss the portal.
          const leftFirst = cross(this.polygons[from].center, this.vertices[a], this.vertices[b]) < 0;
          this.polygons[from].links.push({
            to,
            left: this.vertices[leftFirst ? a : b],
            right: this.vertices[leftFirst ? b : a],
            cost: distance(this.polygons[from].center, this.polygons[to].center),
          });
        }
      }
    }
    const count = this.polygons.length;
    let edgeCount = 0,
      linkCount = 0;
    for (const p of this.polygons) {
      edgeCount += p.vertices.length;
      linkCount += p.links.length;
    }
    this.signs = new Float64Array(count);
    this.edgeStart = new Int32Array(count + 1);
    this.edges = new Float64Array(edgeCount * 4);
    for (let i = 0, at = 0; i < count; i++) {
      const ids = this.polygons[i].vertices;
      this.signs[i] = Math.sign(cross(this.vertices[ids[0]], this.vertices[ids[1]], this.vertices[ids[2]]));
      for (let edge = 0; edge < ids.length; edge++, at += 4) {
        const a = this.vertices[ids[edge]],
          b = this.vertices[ids[(edge + 1) % ids.length]];
        this.edges[at] = a[0];
        this.edges[at + 1] = a[2];
        this.edges[at + 2] = b[0] - a[0];
        this.edges[at + 3] = b[2] - a[2];
      }
      this.edgeStart[i + 1] = at >> 2;
    }
    this.g = new Float64Array(count);
    this.f = new Float64Array(count);
    this.h = new Float64Array(count);
    this.parent = new Int32Array(count);
    this.parentLink = new Int32Array(count);
    this.state = new Uint8Array(count);
    this.heapKey = new Float64Array(linkCount + 1);
    this.heapNode = new Int32Array(linkCount + 1);
    this.costs = new Float64Array(count).fill(1);
  }
  /** Number of polygons. */
  get polygonCount(): number {
    return this.polygons.length;
  }
  /** Counts changes that can change a route (area costs, off-mesh links), so a crowd knows to plan again. */
  get version(): number {
    return this.changes;
  }
  /** Centre of polygon `index` (the mean of its vertices). */
  polygonCenter(index: number): Vec3 {
    return copy(this.polygon(index).center);
  }
  private polygon(index: number): Polygon {
    if (!Number.isInteger(index) || index < 0 || index >= this.polygons.length)
      throw new RangeError(
        `Polygon index ${index} is out of range; pass 0 to ${this.polygons.length - 1} (see locate).`,
      );
    return this.polygons[index];
  }
  /**
   * Sets the area cost of polygon `index`: path cost through it is multiplied by `cost` (1 or more; 1 by default), so
   * routes avoid mud, water or a hazard unless the detour costs more. `Infinity` blocks it (a closed door).
   * @throws RangeError for an index out of range or a cost below 1.
   */
  setAreaCost(index: number, cost: number): this {
    this.polygon(index);
    if (!(cost >= 1))
      throw new RangeError('Area cost must be 1 or more (Infinity blocks the polygon); pass a multiplier.');
    if (this.costs[index] !== cost) {
      this.costs[index] = cost;
      this.changes++;
    }
    return this;
  }
  /** Area cost multiplier of polygon `index` (1 by default, Infinity when blocked). */
  areaCost(index: number): number {
    this.polygon(index);
    return this.costs[index];
  }
  /** Height of polygon `index`'s plane at (x, z). */
  heightAt(index: number, x: number, z: number): number {
    const plane = this.polygon(index).plane;
    return -(plane[0] * x + plane[2] * z + plane[3]) / plane[1];
  }
  /**
   * The point of the mesh nearest to `position` (by XZ distance, then height), with its polygon: the point itself,
   * moved onto the surface, when it is above or below a polygon. Null only for an empty mesh.
   * @throws RangeError when `position` is not a finite 3D point.
   */
  closestPoint(position: Vec3): { point: Vec3; polygon: number } | null {
    const inside = this.locate(position);
    if (inside >= 0)
      return { point: [position[0], this.heightAt(inside, position[0], position[2]), position[2]], polygon: inside };
    let best: { point: Vec3; polygon: number } | null = null,
      bestDistance = Infinity;
    for (let p = 0; p < this.polygons.length; p++) {
      const ids = this.polygons[p].vertices;
      for (let i = 0; i < ids.length; i++) {
        const a = this.vertices[ids[i]],
          b = this.vertices[ids[(i + 1) % ids.length]],
          ex = b[0] - a[0],
          ez = b[2] - a[2],
          t = Math.min(1, Math.max(0, ((position[0] - a[0]) * ex + (position[2] - a[2]) * ez) / (ex * ex + ez * ez))),
          x = a[0] + t * ex,
          z = a[2] + t * ez,
          y = a[1] + t * (b[1] - a[1]),
          d = (x - position[0]) ** 2 + (z - position[2]) ** 2 + 1e-6 * (y - position[1]) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = { point: [x, y, z], polygon: p };
        }
      }
    }
    return best;
  }
  /**
   * Adds an off-mesh link from `start` to `end` (a jump, a ladder, a teleporter): paths may cross from the polygon
   * under `start` to the polygon under `end`, and {@link NavMesh.route} marks the crossing. Returns its id.
   * @throws RangeError when an end is not above or below a polygon, or the cost is negative.
   */
  addOffMeshLink(start: Vec3, end: Vec3, options: OffMeshLinkOptions = {}): number {
    const from = this.locate(start),
      to = this.locate(end);
    if (from < 0 || to < 0)
      throw new RangeError('Off-mesh link ends must be on the navmesh; move start and end onto walkable polygons.');
    const cost = options.cost ?? distance(start, end);
    if (!(cost >= 0 && cost < Infinity))
      throw new RangeError('Off-mesh link cost must be a finite number of 0 or more.');
    const id = this.nextLink++;
    const add = (a: number, b: number, s: Vec3, e: Vec3) => {
      const polygon = this.polygons[a];
      polygon.links.push({
        to: b,
        left: copy(s),
        right: copy(s),
        // Centre to link start, the link itself, link end to the next centre: comparable with portal costs.
        cost: distance(polygon.center, s) + cost + distance(e, this.polygons[b].center),
        offMesh: id,
        start: copy(s),
        end: copy(e),
      });
    };
    add(from, to, start, end);
    if (options.bidirectional ?? true) add(to, from, end, start);
    this.growHeap();
    this.changes++;
    return id;
  }
  /** Removes an off-mesh link by the id {@link NavMesh.addOffMeshLink} returned; false when there is none. */
  removeOffMeshLink(id: number): boolean {
    let found = false;
    for (const polygon of this.polygons) {
      const before = polygon.links.length;
      polygon.links = polygon.links.filter((link) => link.offMesh !== id);
      if (polygon.links.length !== before) found = true;
    }
    if (found) this.changes++;
    return found;
  }
  private growHeap(): void {
    let links = 0;
    for (const polygon of this.polygons) links += polygon.links.length;
    if (this.heapKey.length < links + 1) {
      this.heapKey = new Float64Array(links + 1);
      this.heapNode = new Int32Array(links + 1);
    }
  }
  /**
   * Index of the polygon containing `position` in XZ, choosing the one vertically nearest when several
   * overlap, or -1 when none does.
   * @throws RangeError when `position` is not a finite 3D point.
   */
  locate(position: Vec3): number {
    point(position);
    let best = -1,
      height = Infinity;
    const signs = this.signs,
      edgeStart = this.edgeStart,
      edges = this.edges,
      px = position[0],
      pz = position[2];
    for (let i = 0, count = this.polygons.length; i < count; i++) {
      const sign = signs[i];
      let inside = true;
      // Same products as cross(a, b, position), with the edge direction b - a stored at construction.
      for (let o = edgeStart[i] * 4, end = edgeStart[i + 1] * 4; o < end; o += 4)
        if ((edges[o + 2] * (pz - edges[o + 1]) - edges[o + 3] * (px - edges[o])) * sign < -1e-8) {
          inside = false;
          break;
        }
      if (!inside) continue;
      const p = this.polygons[i],
        projected = -(p.plane[0] * position[0] + p.plane[2] * position[2] + p.plane[3]) / p.plane[1],
        delta = Math.abs(projected - position[1]);
      if (delta < height) {
        height = delta;
        best = i;
      }
    }
    return best;
  }
  /**
   * Waypoints from `start` to `end` across linked polygons, including both ends, or null when either point is
   * off the mesh or no route connects them.
   * @throws RangeError when a point is not a finite 3D point.
   */
  path(start: Vec3, end: Vec3): Vec3[] | null {
    return this.route(start, end)?.points ?? null;
  }
  /**
   * {@link NavMesh.path} with the off-mesh crossings marked: the waypoints, and the indices where a segment crosses
   * an off-mesh link. Area costs steer the search; a blocked end polygon has no route.
   * @throws RangeError when a point is not a finite 3D point.
   */
  route(start: Vec3, end: Vec3): NavRoute | null {
    const from = this.locate(start),
      to = this.locate(end);
    if (from < 0 || to < 0 || !(this.costs[to] < Infinity)) return null;
    if (from === to) return { points: [copy(start), copy(end)], offMesh: [] };
    const polygons = this.polygons,
      { g, f, h, parent, parentLink, state, heapKey, heapNode, costs } = this,
      goal = polygons[to].center;
    g.fill(Infinity);
    state.fill(0);
    g[from] = 0;
    f[from] = h[from] = distance(polygons[from].center, goal);
    state[from] = 1;
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
      const links = polygons[current].links;
      for (let l = 0; l < links.length; l++) {
        const link = links[l],
          next = link.to;
        if (state[next] === 2 || !(costs[next] < Infinity)) continue;
        // Off-mesh links cost what they say; portals cost their length times the entered polygon's area cost.
        const candidate = g[current] + (link.offMesh === undefined ? link.cost * costs[next] : link.cost);
        if (candidate < g[next]) {
          if (state[next] === 0) h[next] = distance(polygons[next].center, goal);
          const key = candidate + h[next];
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
    const corridor = [to],
      via: number[] = [];
    for (let node = to; node !== from; ) {
      via.push(parentLink[node]);
      node = parent[node];
      corridor.push(node);
    }
    corridor.reverse();
    via.reverse();
    // Pull each stretch between off-mesh links taut on its own; a link joins two stretches end to start.
    const points: Vec3[] = [],
      offMesh: number[] = [];
    const append = (part: Vec3[]) => {
      for (const v of part) if (!points.length || !same(v, points[points.length - 1])) points.push(v);
    };
    let first = 0,
      origin: Vec3 = start;
    for (let i = 0; i < via.length; i++) {
      const link = polygons[corridor[i]].links[via[i]];
      if (link.offMesh === undefined) continue;
      append(this.pull(corridor.slice(first, i + 1), via.slice(first, i), origin, link.start!));
      offMesh.push(points.length - 1);
      points.push(copy(link.end!));
      origin = link.end!;
      first = i + 1;
    }
    const last = this.pull(corridor.slice(first), via.slice(first), origin, end);
    // The first point of the last stretch is the landing point already added.
    append(offMesh.length ? last.slice(1) : last);
    return { points, offMesh };
  }
  /** Funnel deque reused by `pull`: the left chain grows down from the apex slot, the right chain up. */
  private readonly funnel: Vec3[] = [];
  /**
   * Shortest XZ polyline from `start` to `end` through the corridor's portals: the funnel of D. T. Lee and
   * F. P. Preparata (Networks 14, 1984), as used by J. Hershberger and J. Snoeyink (CGTA 4, 1994). The deque holds
   * the shortest paths from the apex to the latest left and right portal ends; the left chain only turns
   * counter-clockwise, the right one only clockwise. A new end point pops the vertices of its own chain it can see
   * past; when it crosses the other chain, the apex walks along that chain and every vertex passed is a corner.
   */
  private pull(corridor: readonly number[], via: readonly number[], start: Vec3, end: Vec3): Vec3[] {
    const result: Vec3[] = [copy(start)],
      polygons = this.polygons,
      portals = corridor.length - 1,
      middle = portals + 2,
      deque = this.funnel;
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
    for (let i = 0; i < portals; i++) {
      const link = polygons[corridor[i]].links[via[i]];
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
}
export { avoid, type Agent } from './orca.js';
export { Crowd, CrowdAgent } from './crowd.js';
export type { CrowdOptions, CrowdAgentOptions, CrowdAgentState, CrowdObstacle, CrowdEventMap } from './crowd.js';
