import type { Vec3 } from '@margoengine/math';

export type { Vec3 };
interface Link {
  to: number;
  left: Vec3;
  right: Vec3;
  cost: number;
}
interface Polygon {
  vertices: readonly number[];
  center: Vec3;
  links: Link[];
  plane: readonly [number, number, number, number];
}
const cross = (a: Vec3, b: Vec3, c: Vec3) => (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
const area = (a: Vec3, b: Vec3, c: Vec3) => -cross(a, b, c);
const same = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-8;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function point(value: Vec3): void {
  if (value.length !== 3 || value.some((v) => !Number.isFinite(Math.fround(v))))
    throw new RangeError('Expected finite 3D point');
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
  private readonly heapKey: Float64Array;
  private readonly heapNode: Int32Array;
  /**
   * Builds the mesh from world-space vertices and polygons given as vertex-index lists (3..32 each).
   * @throws RangeError for fewer than 3 or more than 100,000 vertices, no or more than 4096 polygons, non-finite
   * vertices, or polygons that are not strictly convex and planar or have no XZ extent.
   * @throws TypeError for out-of-range, repeated or non-integer polygon indices.
   */
  constructor(vertices: readonly Vec3[], polygons: readonly (readonly number[])[]) {
    if (vertices.length < 3 || vertices.length > 100_000 || !polygons.length || polygons.length > 4096)
      throw new RangeError('Navmesh size exceeded');
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
        throw new TypeError('Invalid polygon indices');
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
        if (edge.linked) throw new TypeError('Non-manifold navmesh edge');
        edge.linked = true;
        for (const [from, to] of [
          [polygon, edge.polygon],
          [edge.polygon, polygon],
        ]) {
          const leftFirst = cross(this.polygons[from].center, this.polygons[to].center, this.vertices[a]) > 0;
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
    this.state = new Uint8Array(count);
    this.heapKey = new Float64Array(linkCount + 1);
    this.heapNode = new Int32Array(linkCount + 1);
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
    const from = this.locate(start),
      to = this.locate(end);
    if (from < 0 || to < 0) return null;
    if (from === to) return [[...start] as unknown as Vec3, [...end] as unknown as Vec3];
    const polygons = this.polygons,
      { g, f, h, parent, state, heapKey, heapNode } = this,
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
        if (state[next] === 2) continue;
        const candidate = g[current] + link.cost;
        if (candidate < g[next]) {
          if (state[next] === 0) h[next] = distance(polygons[next].center, goal);
          const key = candidate + h[next];
          parent[next] = current;
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
    const corridor = [to];
    for (let node = to; node !== from; ) {
      node = parent[node];
      corridor.push(node);
    }
    corridor.reverse();
    const portals: { left: Vec3; right: Vec3 }[] = [{ left: start, right: start }];
    for (let i = 0; i + 1 < corridor.length; i++) {
      const links = polygons[corridor[i]].links,
        next = corridor[i + 1];
      let l = 0;
      while (links[l].to !== next) l++;
      portals.push(links[l]);
    }
    portals.push({ left: end, right: end });
    const result: Vec3[] = [[...start] as unknown as Vec3];
    let apex = start,
      left = start,
      right = start,
      apexIndex = 0,
      leftIndex = 0,
      rightIndex = 0;
    for (let i = 1; i < portals.length; i++) {
      const portal = portals[i];
      if (area(apex, right, portal.right) <= 0) {
        if (same(apex, right) || area(apex, left, portal.right) > 0) {
          right = portal.right;
          rightIndex = i;
        } else {
          result.push([...left] as unknown as Vec3);
          apex = left;
          apexIndex = leftIndex;
          left = right = apex;
          leftIndex = rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }
      if (area(apex, left, portal.left) >= 0) {
        if (same(apex, left) || area(apex, right, portal.left) < 0) {
          left = portal.left;
          leftIndex = i;
        } else {
          result.push([...right] as unknown as Vec3);
          apex = right;
          apexIndex = rightIndex;
          left = right = apex;
          leftIndex = rightIndex = apexIndex;
          i = apexIndex;
        }
      }
    }
    if (!same(result.at(-1)!, end)) result.push([...end] as unknown as Vec3);
    return result;
  }
}
export { avoid, type Agent } from './orca.js';
