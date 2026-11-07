import type { Vec3 } from '@margoengine/math';
import {
  CorridorSearch,
  checkFilter,
  copy,
  cross,
  distance,
  point,
  routeThrough,
  type Link,
  type NavRoute,
} from './search.js';

export type { Vec3 };
export type { NavRoute };
/** One way out of a polygon ({@link NavMesh.polygonLinks}): a portal, or an off-mesh link when `offMesh` is set. */
export type NavLink = Readonly<Link>;

/** Options of {@link NavMesh.addOffMeshLink}. */
export interface OffMeshLinkOptions {
  /** Also usable from `end` back to `start` (default true; false for a drop down a ledge). */
  bidirectional?: boolean;
  /** Path cost of crossing the link, in distance units (default the distance from `start` to `end`). */
  cost?: number;
}

/**
 * What an agent may walk on: its cost multiplier per polygon area number (1 or more, `Infinity` for ground it cannot
 * enter; a number not listed costs 1). It multiplies the polygon's area cost.
 */
export type NavFilter = ArrayLike<number>;

/** What a {@link Crowd} needs of the surface its agents walk on: a {@link NavMesh} or a tiled mesh. */
export interface NavSurface {
  /** Counts changes that can change a route, so a crowd knows to plan again. */
  readonly version: number;
  locate(position: Vec3): number;
  closestPoint(position: Vec3): { point: Vec3; polygon: number } | null;
  heightAt(index: number, x: number, z: number): number;
  route(start: Vec3, end: Vec3, filter?: NavFilter): NavRoute | null;
  polygonArea(index: number): number;
}
interface Polygon {
  vertices: readonly number[];
  center: Vec3;
  links: Link[];
  plane: readonly [number, number, number, number];
}
/** Convex planar walkable polygons, linked by shared vertex-index edges. */
export class NavMesh implements NavSurface {
  /** Copies of the vertex positions given to the constructor. */
  readonly vertices: readonly Vec3[];
  private readonly polygons: Polygon[] = [];
  /** Flat copies for the hot loops: per polygon its winding sign, per edge the XZ start and direction. */
  private readonly signs: Float64Array;
  private readonly edgeStart: Int32Array;
  private readonly edges: Float64Array;
  private readonly search = new CorridorSearch();
  private readonly adjacency: Link[][];
  /** Area number per polygon. */
  private readonly areas: Uint8Array;
  /** Per polygon cost of the route being planned with a filter. */
  private filtered: Float64Array | null = null;
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
    this.search.reserve(count, linkCount);
    this.adjacency = this.polygons.map((p) => p.links);
    this.costs = new Float64Array(count).fill(1);
    this.areas = new Uint8Array(count);
  }
  /** Number of polygons. */
  get polygonCount(): number {
    return this.polygons.length;
  }
  /** Counts changes that can change a route (area costs, off-mesh links), so a crowd knows to plan again. */
  get version(): number {
    return this.changes;
  }
  /** Vertex indices of polygon `index`, in winding order. */
  polygonVertices(index: number): readonly number[] {
    return this.polygon(index).vertices;
  }
  /** The ways out of polygon `index`: shared-edge portals, then off-mesh links. Read only. */
  polygonLinks(index: number): readonly NavLink[] {
    return this.polygon(index).links;
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
  /**
   * Sets the area number of polygon `index`, 0 to 255, for route filters: what kind of ground it is. `./build` sets it
   * from its `areas` boxes.
   * @throws RangeError for an index out of range or another number.
   */
  setPolygonArea(index: number, area: number): this {
    this.polygon(index);
    if (!Number.isInteger(area) || area < 0 || area > 255)
      throw new RangeError('Polygon area must be a whole number from 0 to 255.');
    if (this.areas[index] !== area) {
      this.areas[index] = area;
      this.changes++;
    }
    return this;
  }
  /** Area number of polygon `index` (0 by default). */
  polygonArea(index: number): number {
    this.polygon(index);
    return this.areas[index];
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
        cost,
        offMesh: id,
        start: copy(s),
        end: copy(e),
      });
    };
    add(from, to, start, end);
    if (options.bidirectional ?? true) add(to, from, end, start);
    this.search.reserve(this.polygons.length, this.linkCount());
    this.changes++;
    return id;
  }
  /** Removes an off-mesh link by the id {@link NavMesh.addOffMeshLink} returned; false when there is none. */
  removeOffMeshLink(id: number): boolean {
    let found = false;
    for (const { links } of this.polygons)
      for (let i = links.length - 1; i >= 0; i--)
        if (links[i].offMesh === id) {
          links.splice(i, 1);
          found = true;
        }
    if (found) this.changes++;
    return found;
  }
  /** Area costs with `filter` applied, in a buffer kept for the next route. */
  private filter(filter: NavFilter): Float64Array {
    checkFilter(filter);
    const costs = (this.filtered ??= new Float64Array(this.costs.length)),
      { areas } = this;
    for (let p = 0; p < costs.length; p++) costs[p] = this.costs[p] * (filter[areas[p]] ?? 1);
    return costs;
  }
  private linkCount(): number {
    let links = 0;
    for (const polygon of this.polygons) links += polygon.links.length;
    return links;
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
  path(start: Vec3, end: Vec3, filter?: NavFilter): Vec3[] | null {
    return this.route(start, end, filter)?.points ?? null;
  }
  /**
   * {@link NavMesh.path} with the off-mesh crossings marked: the waypoints, and the indices where a segment crosses
   * an off-mesh link. Area costs and `filter` steer the search; a blocked end polygon has no route.
   * @throws RangeError when a point is not a finite 3D point.
   */
  route(start: Vec3, end: Vec3, filter?: NavFilter): NavRoute | null {
    const from = this.locate(start),
      to = this.locate(end),
      costs = filter ? this.filter(filter) : this.costs;
    if (from < 0 || to < 0 || !(costs[to] < Infinity)) return null;
    if (from === to) return { points: [copy(start), copy(end)], offMesh: [] };
    const corridor = this.search.find(from, to, start, end, this.polygons.length, this.adjacency, costs);
    return corridor && routeThrough(corridor, start, end);
  }
}
export { avoid, type Agent } from './orca.js';
export { Crowd, CrowdAgent } from './crowd.js';
export type { CrowdOptions, CrowdAgentOptions, CrowdAgentState, CrowdObstacle, CrowdEventMap } from './crowd.js';
