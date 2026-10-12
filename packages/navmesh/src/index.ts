export type Vec3 = readonly [number, number, number];
interface Link {to: number; left: Vec3; right: Vec3}
interface Polygon {vertices: readonly number[]; center: Vec3; links: Link[]; plane: readonly [number, number, number, number]}
const cross = (a: Vec3, b: Vec3, c: Vec3) => (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
const area = (a: Vec3, b: Vec3, c: Vec3) => -cross(a, b, c);
const same = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-8;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function point(value: Vec3): void {if (value.length !== 3 || value.some(v => !Number.isFinite(Math.fround(v)))) throw new RangeError('Expected finite 3D point');}

/** Convex planar walkable polygons, linked by shared vertex-index edges. */
export class NavMesh {
  readonly vertices: readonly Vec3[];
  private readonly polygons: Polygon[] = [];
  constructor(vertices: readonly Vec3[], polygons: readonly (readonly number[])[]) {
    if (vertices.length < 3 || vertices.length > 100_000 || !polygons.length || polygons.length > 4096) throw new RangeError('Navmesh size exceeded');
    this.vertices = vertices.map(v => {point(v); return [...v] as unknown as Vec3;});
    const edges = new Map<string, {polygon: number; a: number; b: number; linked: boolean}>();
    for (const indices of polygons) {
      if (indices.length < 3 || indices.length > 32 || new Set(indices).size !== indices.length || indices.some(id => !Number.isInteger(id) || id < 0 || id >= vertices.length)) throw new TypeError('Invalid polygon indices');
      const a = this.vertices[indices[0]], b = this.vertices[indices[1]], c = this.vertices[indices[2]], ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz), plane: [number, number, number, number] = [nx / length, ny / length, nz / length, -(nx * a[0] + ny * a[1] + nz * a[2]) / length];
      if (!length || Math.abs(plane[1]) < 1e-6) throw new RangeError('Walkable polygons need a nonzero XZ projection');
      const sign = Math.sign(cross(a, b, c));
      for (let i = 0; i < indices.length; i++) {
        const p = this.vertices[indices[i]], q = this.vertices[indices[(i + 1) % indices.length]], r = this.vertices[indices[(i + 2) % indices.length]];
        if (cross(p, q, r) * sign <= 1e-10 || Math.abs(plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] + plane[3]) > 1e-4) throw new RangeError('Navmesh polygons must be strictly convex and planar');
        for (const id of indices) if (cross(p, q, this.vertices[id]) * sign < -1e-10) throw new RangeError('Navmesh polygons must be strictly convex and planar');
      }
      const center: [number, number, number] = [0, 0, 0]; for (const id of indices) for (let axis = 0; axis < 3; axis++) center[axis] += this.vertices[id][axis] / indices.length;
      const polygon = this.polygons.length; this.polygons.push({vertices: [...indices], center, plane, links: []});
      for (let i = 0; i < indices.length; i++) {
        const a = indices[i], b = indices[(i + 1) % indices.length], key = `${Math.min(a, b)}:${Math.max(a, b)}`, edge = edges.get(key);
        if (!edge) {edges.set(key, {polygon, a, b, linked: false}); continue;}
        if (edge.linked) throw new TypeError('Non-manifold navmesh edge'); edge.linked = true;
        for (const [from, to] of [[polygon, edge.polygon], [edge.polygon, polygon]]) {
          const leftFirst = cross(this.polygons[from].center, this.polygons[to].center, this.vertices[a]) > 0;
          this.polygons[from].links.push({to, left: this.vertices[leftFirst ? a : b], right: this.vertices[leftFirst ? b : a]});
        }
      }
    }
  }
  locate(position: Vec3): number {
    point(position); let best = -1, height = Infinity;
    for (let i = 0; i < this.polygons.length; i++) {
      const p = this.polygons[i], ids = p.vertices, sign = Math.sign(cross(this.vertices[ids[0]], this.vertices[ids[1]], this.vertices[ids[2]])); let inside = true;
      for (let edge = 0; edge < ids.length; edge++) if (cross(this.vertices[ids[edge]], this.vertices[ids[(edge + 1) % ids.length]], position) * sign < -1e-8) {inside = false; break;}
      if (!inside) continue;
      const projected = -(p.plane[0] * position[0] + p.plane[2] * position[2] + p.plane[3]) / p.plane[1], delta = Math.abs(projected - position[1]);
      if (delta < height) {height = delta; best = i;}
    }
    return best;
  }
  path(start: Vec3, end: Vec3): Vec3[] | null {
    const from = this.locate(start), to = this.locate(end); if (from < 0 || to < 0) return null;
    if (from === to) return [[...start] as unknown as Vec3, [...end] as unknown as Vec3];
    const count = this.polygons.length, g = new Float64Array(count).fill(Infinity), f = new Float64Array(count).fill(Infinity), parent = new Int32Array(count).fill(-1), state = new Uint8Array(count);
    g[from] = 0; f[from] = distance(this.polygons[from].center, this.polygons[to].center); state[from] = 1;
    // shortcut: linear open-set scan, use a heap for navmeshes beyond a few thousand polygons.
    while (true) {
      let current = -1, cost = Infinity; for (let i = 0; i < count; i++) if (state[i] === 1 && f[i] < cost) {current = i; cost = f[i];}
      if (current < 0) return null; if (current === to) break; state[current] = 2;
      for (const link of this.polygons[current].links) {
        const next = link.to; if (state[next] === 2) continue;
        const candidate = g[current] + distance(this.polygons[current].center, this.polygons[next].center);
        if (candidate < g[next]) {parent[next] = current; g[next] = candidate; f[next] = candidate + distance(this.polygons[next].center, this.polygons[to].center); state[next] = 1;}
      }
    }
    const corridor = [to]; for (let node = to; node !== from;) {node = parent[node]; corridor.unshift(node);}
    const portals: {left: Vec3; right: Vec3}[] = [{left: start, right: start}];
    for (let i = 0; i + 1 < corridor.length; i++) portals.push(this.polygons[corridor[i]].links.find(link => link.to === corridor[i + 1])!);
    portals.push({left: end, right: end});
    const result: Vec3[] = [[...start] as unknown as Vec3]; let apex = start, left = start, right = start, apexIndex = 0, leftIndex = 0, rightIndex = 0;
    for (let i = 1; i < portals.length; i++) {
      const portal = portals[i];
      if (area(apex, right, portal.right) <= 0) {
        if (same(apex, right) || area(apex, left, portal.right) > 0) {right = portal.right; rightIndex = i;}
        else {result.push([...left] as unknown as Vec3); apex = left; apexIndex = leftIndex; left = right = apex; leftIndex = rightIndex = apexIndex; i = apexIndex; continue;}
      }
      if (area(apex, left, portal.left) >= 0) {
        if (same(apex, left) || area(apex, right, portal.left) < 0) {left = portal.left; leftIndex = i;}
        else {result.push([...right] as unknown as Vec3); apex = right; apexIndex = rightIndex; left = right = apex; leftIndex = rightIndex = apexIndex; i = apexIndex;}
      }
    }
    if (!same(result.at(-1)!, end)) result.push([...end] as unknown as Vec3); return result;
  }
}
export {avoid, type Agent} from './orca.js';
