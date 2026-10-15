// Delaunay triangulation (2D) and tetrahedralization (3D) by Bowyer-Watson, Voronoi cells clipped from the bounds by the
// bisectors of each site's Delaunay neighbours, and mesh fracture along the 3D cells.
import {Geometry} from '@margoengine/core';
import {triangulate} from '@margoengine/geometry';

/** minX, minY, maxX, maxY. */
export type Bounds2 = readonly [number, number, number, number];
/** minX, minY, minZ, maxX, maxY, maxZ. */
export type Bounds3 = readonly [number, number, number, number, number, number];
/** Delaunay triangulation of flat x, y points. Duplicate points are left out (no triangles, no neighbours). */
export interface Delaunay2 {/** Counter-clockwise point indices, three per triangle. */ readonly triangles: Uint32Array; /** Sorted Delaunay neighbours per point. */ readonly neighbors: readonly (readonly number[])[]}
/** Delaunay tetrahedralization of flat x, y, z points. Duplicate points are left out. */
export interface Delaunay3 {/** Positively oriented point indices, four per tetrahedron. */ readonly tetrahedra: Uint32Array; /** Sorted Delaunay neighbours per point. */ readonly neighbors: readonly (readonly number[])[]}
/** One 2D Voronoi cell inside the bounds (empty for a duplicate site or a site whose cell misses the bounds). */
export interface VoronoiCell2 {
  /** Counter-clockwise polygon, x, y per vertex. */ readonly polygon: Float64Array;
  /** Per polygon edge k (vertex k to k + 1): the site across it, or -1 on the bounds. */ readonly edgeSites: Int32Array;
  /** Sites sharing an edge with this cell, sorted. */ readonly neighbors: Int32Array;
}
/** 2D Voronoi diagram: cells per site, every edge once, and the Delaunay triangulation it came from. */
export interface Voronoi2 {
  readonly cells: readonly VoronoiCell2[];
  /** x0, y0, x1, y1 per Voronoi edge. */ readonly edges: Float64Array;
  /** The two sites per edge (the second is -1 on the bounds). */ readonly edgeCells: Int32Array;
  readonly delaunay: Delaunay2;
}
/** One 3D Voronoi cell: a convex polyhedron inside the bounds (no faces for a duplicate site or a cell outside the bounds). */
export interface VoronoiCell3 {
  /** x, y, z per vertex. */ readonly vertices: Float64Array;
  /** Vertex loops, counter-clockwise seen from outside; their sides are the cell's edges. */ readonly faces: readonly (readonly number[])[];
  /** Per face: the site across it, or -1 on the bounds. */ readonly faceSites: Int32Array;
  /** Sites sharing a face with this cell, sorted. */ readonly neighbors: Int32Array;
  readonly volume: number;
}
/** 3D Voronoi diagram: cells per site and the Delaunay tetrahedralization they came from. */
export interface Voronoi3 {readonly cells: readonly VoronoiCell3[]; readonly delaunay: Delaunay3}
/** `fractureMesh` settings. */
export interface FractureOptions {/** Seed for generated sites when `sites` is a count (default 1). */ seed?: number}
/** One fractured piece: the part of the mesh inside `site`'s Voronoi cell, closed with flat caps along the cuts. */
export interface FractureChunk {readonly site: number; readonly center: readonly [number, number, number]; readonly geometry: Geometry}

const MAX_POINTS = 100_000;
function readPoints(points: ArrayLike<number>, dimensions: number): number {
  const count = points.length / dimensions;
  if (!Number.isInteger(count) || count < 1 || count > MAX_POINTS) throw new RangeError(`Expected 1..${MAX_POINTS} points of ${dimensions} coordinates`);
  for (let i = 0; i < points.length; i++) if (!Number.isFinite(points[i])) throw new RangeError('Points must be finite');
  return count;
}
function readBounds(bounds: readonly number[], dimensions: number): void {
  if (bounds.length !== dimensions * 2 || !bounds.every(Number.isFinite) || bounds.some((v, i) => i < dimensions && v >= bounds[i + dimensions])) throw new RangeError('Invalid bounds');
}
const neighborLists = (count: number, pairs: Set<number>, stride: number): number[][] => {
  const lists: number[][] = Array.from({length: count}, () => []);
  for (const key of pairs) {const a = Math.floor(key / stride), b = key % stride; lists[a].push(b); lists[b].push(a);}
  for (const list of lists) list.sort((a, b) => a - b);
  return lists;
};

/**
 * Bowyer-Watson insertion shared by 2D and 3D: `simplex` vertices per cell (3 or 4), each new cell is a cavity boundary
 * facet joined to the point. A facet the point does not strictly see (rounding near co-circular input) drops its cell
 * from the cavity, so the result never overlaps; a point left with no cavity (a duplicate) is skipped.
 */
function bowyerWatson(P: Float64Array, count: number, dimensions: 2 | 3, superCells: number[]): {cells: number[]; inserted: Uint8Array} {
  const simplex = dimensions + 1, N = count + simplex;
  const cells: number[] = [...superCells], spheres: number[] = [], alive: number[] = [], inserted = new Uint8Array(count);
  const sphere = (c: number): void => {
    const v = cells.slice(c * simplex, c * simplex + simplex).map(i => i * dimensions), a = v[0];
    if (dimensions === 2) {
      const bx = P[v[1]] - P[a], by = P[v[1] + 1] - P[a + 1], cx = P[v[2]] - P[a], cy = P[v[2] + 1] - P[a + 1], d = 2 * (bx * cy - by * cx), b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      const ux = (cy * b2 - by * c2) / d, uy = (bx * c2 - cx * b2) / d;
      spheres.push(P[a] + ux, P[a + 1] + uy, 0, ux * ux + uy * uy);
    } else {
      const r = [1, 2, 3].map(k => [P[v[k]] - P[a], P[v[k] + 1] - P[a + 1], P[v[k] + 2] - P[a + 2]]), [b, c, e] = r, l = r.map(x => x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
      const cross = (x: number[], y: number[]) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
      const ce = cross(c, e), eb = cross(e, b), bc = cross(b, c), d = 2 * (b[0] * ce[0] + b[1] * ce[1] + b[2] * ce[2]);
      const u = [0, 1, 2].map(k => (l[0] * ce[k] + l[1] * eb[k] + l[2] * bc[k]) / d);
      spheres.push(P[a] + u[0], P[a + 1] + u[1], P[a + 2] + u[2], u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
    }
    alive.push(1);
  };
  // Facets of a positively oriented cell, each listed so that the opposite vertex is on its positive side (the cavity side).
  const facets = dimensions === 2 ? [[0, 1], [1, 2], [2, 0]] : [[0, 1, 2], [0, 3, 1], [1, 3, 2], [0, 2, 3]];
  // Orientation of the cell (facet..., p): positive when p is strictly on the facet's positive side.
  const orient = (f: number[], p: number): number => {
    const a = f[0] * dimensions, d = (v: number, k: number) => P[v * dimensions + k] - P[a + k];
    if (dimensions === 2) return d(f[1], 0) * d(p, 1) - d(f[1], 1) * d(p, 0);
    const [x, y, z] = [f[1], f[2], p].map(v => [0, 1, 2].map(k => d(v, k)));
    return x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0]);
  };
  const key = (f: number[]): number => {const s = [...f].sort((a, b) => a - b); return dimensions === 2 ? s[0] * N + s[1] : (s[0] * N + s[1]) * N + s[2];};
  sphere(0);
  let live = 1;
  // ponytail: every insertion scans all cells (O(n^2)); a walk from the last cell is the upgrade past ~20k points.
  for (let p = 0; p < count; p++) {
    const q = p * dimensions, bad = new Set<number>();
    for (let c = 0; c < alive.length; c++) if (alive[c]) {
      let d = 0; for (let k = 0; k < dimensions; k++) {const x = P[q + k] - spheres[c * 4 + k]; d += x * x;}
      if (d < spheres[c * 4 + 3]) bad.add(c);
    }
    let boundary: number[][] = [];
    for (let repaired = false; !repaired && bad.size;) {
      const seen = new Map<number, number[] | null>();
      for (const c of bad) for (const f of facets) {
        const facet = f.map(k => cells[c * simplex + k]), k = key(facet);
        seen.set(k, seen.has(k) ? null : [...facet, c]);
      }
      boundary = [...seen.values()].filter((f): f is number[] => f !== null);
      repaired = true;
      for (const f of boundary) if (!(orient(f.slice(0, dimensions), p) > 0)) {bad.delete(f[dimensions]); repaired = false;}
    }
    if (!bad.size) continue;
    inserted[p] = 1;
    for (const c of bad) alive[c] = 0;
    live -= bad.size;
    for (const f of boundary) {for (let k = 0; k < dimensions; k++) cells.push(f[k]); cells.push(p); sphere(alive.length); live++;}
    if (alive.length > 4 * live + 64) {
      // Compact dead cells so the scan stays proportional to the live mesh.
      let w = 0;
      for (let c = 0; c < alive.length; c++) if (alive[c]) {for (let k = 0; k < simplex; k++) cells[w * simplex + k] = cells[c * simplex + k]; for (let k = 0; k < 4; k++) spheres[w * 4 + k] = spheres[c * 4 + k]; w++;}
      cells.length = w * simplex; spheres.length = w * 4; alive.length = w; alive.fill(1);
    }
  }
  return {cells: cells.filter((_, i) => alive[Math.floor(i / simplex)]), inserted};
}
function points64(points: ArrayLike<number>, count: number, dimensions: 2 | 3): {P: Float64Array; superCells: number[]} {
  const P = new Float64Array((count + dimensions + 1) * dimensions);
  P.set(Array.from(points));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let k = 0; k < dimensions; k++) {min[k] = Math.min(min[k], P[i * dimensions + k]); max[k] = Math.max(max[k], P[i * dimensions + k]);}
  const size = Math.max(...max.slice(0, dimensions).map((v, k) => v - min[k])) || 1, far = 100 * size;
  const corners = dimensions === 2 ? [[-1, -1], [1, -1], [0, 1]] : [[1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1]];
  corners.forEach((c, i) => c.forEach((v, k) => {P[(count + i) * dimensions + k] = (min[k] + max[k]) / 2 + v * far * (dimensions === 2 ? 2 : 1);}));
  return {P, superCells: corners.map((_, i) => count + i)};
}

/** Delaunay triangulation of `points` (x, y pairs, up to 100,000). O(n^2): meant for level-sized inputs. */
export function delaunay2(points: ArrayLike<number>): Delaunay2 {
  const count = readPoints(points, 2), {P, superCells} = points64(points, count, 2), {cells} = bowyerWatson(P, count, 2, superCells);
  const triangles: number[] = [], pairs = new Set<number>();
  for (let c = 0; c < cells.length; c += 3) {
    const t = cells.slice(c, c + 3);
    for (let k = 0; k < 3; k++) {const a = t[k], b = t[(k + 1) % 3]; if (a < count && b < count) pairs.add(Math.min(a, b) * count + Math.max(a, b));}
    if (t.every(v => v < count)) triangles.push(...t);
  }
  return {triangles: Uint32Array.from(triangles), neighbors: neighborLists(count, pairs, count)};
}

/** Delaunay tetrahedralization of `points` (x, y, z triples, up to 100,000). O(n^2): meant for fracture-sized inputs. */
export function delaunay3(points: ArrayLike<number>): Delaunay3 {
  const count = readPoints(points, 3), {P, superCells} = points64(points, count, 3);
  // The super tetrahedron's corners are listed with positive orientation.
  const {cells} = bowyerWatson(P, count, 3, superCells);
  const tetrahedra: number[] = [], pairs = new Set<number>();
  for (let c = 0; c < cells.length; c += 4) {
    const t = cells.slice(c, c + 4);
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) if (t[a] < count && t[b] < count) pairs.add(Math.min(t[a], t[b]) * count + Math.max(t[a], t[b]));
    if (t.every(v => v < count)) tetrahedra.push(...t);
  }
  return {tetrahedra: Uint32Array.from(tetrahedra), neighbors: neighborLists(count, pairs, count)};
}

/** Voronoi diagram of `points` (x, y pairs) clipped to `bounds`. */
export function voronoi2(points: ArrayLike<number>, bounds: Bounds2): Voronoi2 {
  readBounds(bounds, 2);
  const delaunay = delaunay2(points), count = points.length / 2, [x0, y0, x1, y1] = bounds, eps = 1e-10 * Math.hypot(x1 - x0, y1 - y0);
  const edges: number[] = [], edgeCells: number[] = [];
  const cells = delaunay.neighbors.map((neighbors, i): VoronoiCell2 => {
    let poly = count > 1 && !neighbors.length ? [] : [x0, y0, x1, y0, x1, y1, x0, y1], tags = [-1, -1, -1, -1];
    const px = points[i * 2], py = points[i * 2 + 1];
    for (const j of neighbors) {
      let nx = points[j * 2] - px, ny = points[j * 2 + 1] - py; const length = Math.hypot(nx, ny); nx /= length; ny /= length;
      const d = nx * (px + points[j * 2]) / 2 + ny * (py + points[j * 2 + 1]) / 2, out: number[] = [], outTags: number[] = [], n = poly.length / 2;
      const dist = (k: number) => poly[k * 2] * nx + poly[k * 2 + 1] * ny - d;
      for (let k = 0; k < n; k++) {
        const m = (k + 1) % n, a = dist(k), b = dist(m), ina = a <= eps, inb = b <= eps;
        const cut = () => {const t = a / (a - b); return [poly[k * 2] + (poly[m * 2] - poly[k * 2]) * t, poly[k * 2 + 1] + (poly[m * 2 + 1] - poly[k * 2 + 1]) * t];};
        if (ina && !inb) {if (a >= -eps) {out.push(poly[k * 2], poly[k * 2 + 1]); outTags.push(j);} else {out.push(poly[k * 2], poly[k * 2 + 1], ...cut()); outTags.push(tags[k], j);}}
        else if (ina) {out.push(poly[k * 2], poly[k * 2 + 1]); outTags.push(tags[k]);}
        else if (inb && b < -eps) {out.push(...cut()); outTags.push(tags[k]);}
      }
      poly = out.length >= 6 ? out : []; tags = outTags;
      if (!poly.length) break;
    }
    const n = poly.length / 2, polygon = new Float64Array(poly), edgeSites = Int32Array.from(poly.length ? tags : []);
    for (let k = 0; k < n; k++) {const t = edgeSites[k], m = (k + 1) % n; if (t < 0 || i < t) {edges.push(poly[k * 2], poly[k * 2 + 1], poly[m * 2], poly[m * 2 + 1]); edgeCells.push(i, t);}}
    return {polygon, edgeSites, neighbors: Int32Array.from(new Set([...edgeSites].filter(t => t >= 0))).sort()};
  });
  return {cells, edges: new Float64Array(edges), edgeCells: Int32Array.from(edgeCells), delaunay};
}

interface Poly {verts: number[]; faces: number[][]; tags: number[]}
/** Clips a convex polyhedron to `n . x <= d` (n unit); the cut face is tagged `tag`. */
function clipPoly(poly: Poly, n: readonly number[], d: number, tag: number, eps: number): Poly {
  const {verts, faces, tags} = poly, count = verts.length / 3, dist = new Float64Array(count);
  let outside = 0;
  for (let v = 0; v < count; v++) {dist[v] = verts[v * 3] * n[0] + verts[v * 3 + 1] * n[1] + verts[v * 3 + 2] * n[2] - d; if (dist[v] > eps) outside++;}
  if (!outside) return poly;
  if (outside === count) return {verts: [], faces: [], tags: []};
  const next: number[] = [], index = new Int32Array(count).fill(-1), cuts = new Map<number, number>(), cap = new Map<number, number>();
  const keep = (v: number) => {if (index[v] < 0) {index[v] = next.length / 3; next.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);} return index[v];};
  const cut = (a: number, b: number): number => {
    const inside = dist[a] > eps ? b : a; if (dist[inside] >= -eps) return keep(inside);
    const lo = Math.min(a, b), hi = Math.max(a, b), k = lo * count + hi; let id = cuts.get(k);
    if (id === undefined) {const t = dist[lo] / (dist[lo] - dist[hi]); id = next.length / 3; for (let c = 0; c < 3; c++) next.push(verts[lo * 3 + c] + (verts[hi * 3 + c] - verts[lo * 3 + c]) * t); cuts.set(k, id);}
    return id;
  };
  const outFaces: number[][] = [], outTags: number[] = [];
  faces.forEach((loop, f) => {
    const out: number[] = []; let exit = -1, entry = -1;
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length], oa = dist[a] > eps, ob = dist[b] > eps;
      if (!oa) out.push(keep(a));
      if (oa !== ob) {const x = cut(a, b); if (oa) {entry = x; if (x !== keep(b)) out.push(x);} else {exit = x; if (x !== out.at(-1)) out.push(x);}}
    }
    if (exit >= 0 && entry >= 0 && exit !== entry) cap.set(entry, exit);
    const loopOut = out.filter((v, k) => v !== out[(k + 1) % out.length]);
    if (loopOut.length >= 3) {outFaces.push(loopOut); outTags.push(tags[f]);}
  });
  if (cap.size >= 3) {
    const start = cap.keys().next().value!, loop = [start];
    for (let v = cap.get(start); v !== undefined && v !== start && loop.length <= cap.size; v = cap.get(v)) loop.push(v);
    if (loop.length >= 3) {outFaces.push(loop); outTags.push(tag);}
  }
  return {verts: next, faces: outFaces, tags: outTags};
}
function volumeOf({verts: v, faces}: Poly): number {
  let volume = 0;
  for (const loop of faces) for (let k = 1; k + 1 < loop.length; k++) {
    const a = loop[0] * 3, b = loop[k] * 3, c = loop[k + 1] * 3;
    volume += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return volume / 6;
}
const box = ([x0, y0, z0, x1, y1, z1]: Bounds3): Poly => ({
  verts: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
  faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]], tags: [-1, -1, -1, -1, -1, -1],
});
const bisector = (P: ArrayLike<number>, i: number, j: number): [number[], number] => {
  const n = [0, 1, 2].map(k => P[j * 3 + k] - P[i * 3 + k]), length = Math.hypot(...n), unit = n.map(v => v / length);
  return [unit, [0, 1, 2].reduce((s, k) => s + unit[k] * (P[i * 3 + k] + P[j * 3 + k]) / 2, 0)];
};

/** Voronoi diagram of `points` (x, y, z triples) clipped to `bounds`: convex cells with faces, face sites and volume. */
export function voronoi3(points: ArrayLike<number>, bounds: Bounds3): Voronoi3 {
  readBounds(bounds, 3);
  const delaunay = delaunay3(points), count = points.length / 3, eps = 1e-10 * Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
  const cells = delaunay.neighbors.map((neighbors, i): VoronoiCell3 => {
    let poly: Poly = count > 1 && !neighbors.length ? {verts: [], faces: [], tags: []} : box(bounds);
    for (const j of neighbors) {if (!poly.faces.length) break; const [n, d] = bisector(points, i, j); poly = clipPoly(poly, n, d, j, eps);}
    const faceSites = Int32Array.from(poly.tags);
    return {vertices: new Float64Array(poly.verts), faces: poly.faces, faceSites, neighbors: Int32Array.from(new Set([...faceSites].filter(t => t >= 0))).sort(), volume: volumeOf(poly)};
  });
  return {cells, delaunay};
}

interface Piece {ids: number[]; normals: number[]}
/** Cuts a closed triangle mesh to `n . x <= d`, closing each cut loop with a flat cap (holes supported). */
function clipMesh(piece: Piece, pos: number[], n: readonly number[], d: number, eps: number): Piece {
  const dist = new Map<number, number>(), at = (id: number) => {let v = dist.get(id); if (v === undefined) {v = pos[id * 3] * n[0] + pos[id * 3 + 1] * n[1] + pos[id * 3 + 2] * n[2] - d; dist.set(id, v);} return v;};
  const ids: number[] = [], normals: number[] = [], cuts = new Map<number, number>(), capEdges: number[] = [];
  // Points on the plane by rounded position: collinear edges (a sliver from an earlier cap) cross the plane at one point,
  // and must share one vertex there or the cap loop gets two ids for it.
  // ponytail: rounding can split two points within eps across a grid line; a neighbourhood lookup is the upgrade.
  const onPlane = new Map<string, number>(), spot = (id: number): number => {
    const k = `${Math.round(pos[id * 3] / eps)},${Math.round(pos[id * 3 + 1] / eps)},${Math.round(pos[id * 3 + 2] / eps)}`, known = onPlane.get(k);
    if (known !== undefined) return known; onPlane.set(k, id); return id;
  };
  for (const id of piece.ids) if (Math.abs(at(id)) <= eps) spot(id);
  for (let t = 0; t < piece.ids.length; t += 3) {
    const corner = (k: number) => ({id: piece.ids[t + k], n: piece.normals.slice((t + k) * 3, (t + k) * 3 + 3)});
    const out = [0, 1, 2].map(k => at(piece.ids[t + k]) > eps);
    if (!out.some(Boolean)) {ids.push(...piece.ids.slice(t, t + 3)); normals.push(...piece.normals.slice(t * 3, t * 3 + 9)); continue;}
    if (out.every(Boolean)) continue;
    const poly: {id: number; n: number[]}[] = []; let exit = -1, entry = -1;
    for (let k = 0; k < 3; k++) {
      const a = corner(k), b = corner((k + 1) % 3), oa = out[k], ob = out[(k + 1) % 3];
      if (!oa) poly.push(a);
      if (oa === ob) continue;
      const inside = oa ? b : a; let x = inside;
      if (at(inside.id) < -eps) {
        const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id), key = lo * 67108864 + hi, ta = at(a.id) / (at(a.id) - at(b.id));
        let id = cuts.get(key);
        if (id === undefined) {
          const t = at(lo) / (at(lo) - at(hi)); id = pos.length / 3; for (let c = 0; c < 3; c++) pos.push(pos[lo * 3 + c] + (pos[hi * 3 + c] - pos[lo * 3 + c]) * t);
          const same = spot(id); if (same !== id) {pos.length -= 3; id = same;} else dist.set(id, 0);
          cuts.set(key, id);
        }
        const m = [0, 1, 2].map(c => a.n[c] + (b.n[c] - a.n[c]) * ta), length = Math.hypot(...m) || 1;
        x = {id, n: m.map(v => v / length)};
      }
      if (oa) {entry = x.id; if (x.id !== b.id) poly.push(x);} else {exit = x.id; if (x.id !== a.id) poly.push(x);}
    }
    if (exit >= 0 && entry >= 0 && exit !== entry) capEdges.push(entry, exit);
    for (let k = 1; k + 1 < poly.length; k++) {
      const tri = [poly[0], poly[k], poly[k + 1]]; if (tri[0].id === tri[1].id || tri[1].id === tri[2].id || tri[0].id === tri[2].id) continue;
      for (const c of tri) {ids.push(c.id); normals.push(...c.n);}
    }
  }
  // Cap: chain the cut edges into loops, cancelling edge pairs that run both ways (a face lying in the plane).
  const edges = new Map<number, number[]>(), remove = (a: number, b: number) => {const list = edges.get(a), k = list?.indexOf(b) ?? -1; if (k < 0) return false; list!.splice(k, 1); return true;};
  for (let e = 0; e < capEdges.length; e += 2) {const [a, b] = [capEdges[e], capEdges[e + 1]]; if (!remove(b, a)) edges.set(a, [...edges.get(a) ?? [], b]);}
  const loops: number[][] = [];
  for (const [start, list] of edges) while (list.length) {
    const loop = [start]; let v = list.shift()!;
    while (v !== start && loop.length <= capEdges.length) {loop.push(v); const nextList = edges.get(v); if (!nextList?.length) break; v = nextList.shift()!;}
    if (v === start && loop.length >= 3) loops.push(loop);
  }
  if (!loops.length) return {ids, normals};
  const u = Math.abs(n[0]) < 0.9 ? [0, n[2], -n[1]] : [-n[2], 0, n[0]], ul = Math.hypot(...u), U = u.map(x => x / ul), V = [n[1] * U[2] - n[2] * U[1], n[2] * U[0] - n[0] * U[2], n[0] * U[1] - n[1] * U[0]];
  const flat = (id: number): [number, number] => [pos[id * 3] * U[0] + pos[id * 3 + 1] * U[1] + pos[id * 3 + 2] * U[2], pos[id * 3] * V[0] + pos[id * 3 + 1] * V[1] + pos[id * 3 + 2] * V[2]];
  const area = (loop: number[]) => loop.reduce((s, id, k) => {const [ax, ay] = flat(id), [bx, by] = flat(loop[(k + 1) % loop.length]); return s + ax * by - bx * ay;}, 0) / 2;
  const contains = (loop: number[], [px, py]: [number, number]) => {
    let inside = false;
    for (let k = 0, j = loop.length - 1; k < loop.length; j = k++) {const [ax, ay] = flat(loop[k]), [bx, by] = flat(loop[j]); if (ay > py !== by > py && px < (bx - ax) * (py - ay) / (by - ay) + ax) inside = !inside;}
    return inside;
  };
  const outer = loops.filter(l => area(l) > 0).sort((a, b) => area(a) - area(b)), holes = new Map<number[], number[][]>(outer.map(l => [l, []]));
  for (const hole of loops.filter(l => area(l) < 0)) {const host = outer.find(l => contains(l, flat(hole[0]))); if (host) holes.get(host)!.push(hole);}
  for (const [ring, inner] of holes) {
    const all = [ring, ...inner].flat(), data = all.flatMap(flat), holeIndices: number[] = [];
    let offset = ring.length; for (const h of inner) {holeIndices.push(offset); offset += h.length;}
    const tris = triangulate(data, holeIndices), used = new Set(tris); // counter-clockwise, so the cap faces +n
    // The triangulator drops collinear loop points; split the triangle edge each one lies on, or the next cut meets a T-junction.
    for (let k = 0; k < all.length; k++) if (!used.has(k)) {
      const px = data[k * 2], py = data[k * 2 + 1];
      search: for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
        const a = tris[t + e], b = tris[t + (e + 1) % 3], c = tris[t + (e + 2) % 3], ex = data[b * 2] - data[a * 2], ey = data[b * 2 + 1] - data[a * 2 + 1], qx = px - data[a * 2], qy = py - data[a * 2 + 1], l2 = ex * ex + ey * ey, along = ex * qx + ey * qy;
        if (Math.abs(ex * qy - ey * qx) <= 1e-9 * l2 && along > 0 && along < l2) {tris.splice(t, 3, a, k, c); tris.push(k, b, c); break search;}
      }
    }
    for (const k of tris) {ids.push(all[k]); normals.push(n[0], n[1], n[2]);}
  }
  return {ids, normals};
}

/**
 * Splits a closed (watertight) mesh into Voronoi chunks: `sites` are x, y, z triples, or a count of seeded random sites
 * inside the mesh's bounding box. Each chunk keeps the mesh's normals on its outer surface and gets flat capped faces
 * along the cuts. Sites whose cell misses the mesh give no chunk. Chunks are not indexed (every corner is a vertex).
 */
export function fractureMesh(geometry: Geometry, sites: ArrayLike<number> | number, {seed = 1}: FractureOptions = {}): FractureChunk[] {
  const {vertices, indices} = geometry, count = vertices.length / 6, pos: number[] = [], weld = new Map<string, number>(), id = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    const k = `${vertices[v * 6]},${vertices[v * 6 + 1]},${vertices[v * 6 + 2]}`; let w = weld.get(k);
    if (w === undefined) {w = pos.length / 3; weld.set(k, w); pos.push(vertices[v * 6], vertices[v * 6 + 1], vertices[v * 6 + 2]);}
    id[v] = w;
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {min[i % 3] = Math.min(min[i % 3], pos[i]); max[i % 3] = Math.max(max[i % 3], pos[i]);}
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1, pad = size * 0.01;
  const bounds: Bounds3 = [min[0] - pad, min[1] - pad, min[2] - pad, max[0] + pad, max[1] + pad, max[2] + pad];
  let points: ArrayLike<number>;
  if (typeof sites === 'number') {
    if (!Number.isInteger(sites) || sites < 1 || sites > 4096 || !Number.isSafeInteger(seed)) throw new RangeError('Invalid fracture site count or seed');
    let state = seed >>> 0 || 1; const random = () => {state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296;};
    points = Array.from({length: sites * 3}, (_, i) => min[i % 3] + (max[i % 3] - min[i % 3]) * random());
  } else points = sites;
  const base: Piece = {ids: Array.from(indices, v => id[v]), normals: Array.from(indices, v => [vertices[v * 6 + 3], vertices[v * 6 + 4], vertices[v * 6 + 5]]).flat()};
  const welded = pos.length, eps = 1e-6 * size, chunks: FractureChunk[] = [];
  voronoi3(points, bounds).cells.forEach((cell, site) => {
    if (!cell.faces.length) return;
    pos.length = welded; // cut vertices belong to one chunk
    let piece = base;
    for (const j of cell.faceSites) {if (j < 0) continue; const [n, d] = bisector(points, site, j); piece = clipMesh(piece, pos, n, d, eps); if (!piece.ids.length) return;}
    const positions = new Float32Array(piece.ids.length * 3);
    piece.ids.forEach((v, k) => positions.set(pos.slice(v * 3, v * 3 + 3), k * 3));
    chunks.push({site, center: [points[site * 3], points[site * 3 + 1], points[site * 3 + 2]], geometry: new Geometry(positions, piece.normals, Uint32Array.from({length: piece.ids.length}, (_, k) => k))});
  });
  return chunks;
}
