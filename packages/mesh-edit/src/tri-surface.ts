// A triangle surface for topology-changing passes, shared by remeshing and dynamic-topology sculpting: split long
// edges, collapse short ones, flip toward even valence and relax (Botsch and Kobbelt, 2004). Corner UVs and source
// faces travel with the triangles. Each pass runs over a snapshot of the edges and skips anything already touched, so
// its adjacency stays true without incremental bookkeeping.
import type { MutableVec2, MutableVec3, Vec3 } from '@margoengine/math';
import { compilePolygonMesh } from './polygon.js';
import type { PolygonFace, PolygonMesh } from './types.js';

/** One triangle: corners, the UV at each, and the input face it descends from. */
export interface SurfaceTri {
  v: [number, number, number];
  uv: [MutableVec2, MutableVec2, MutableVec2];
  source: string;
}

/** Vertices, triangles and the edges that must survive (open, sharp or seam edges), as `lower:higher` keys. */
export interface TriSurface {
  points: MutableVec3[];
  tris: SurfaceTri[];
  sharp: Set<string>;
}

/** Which edges a pass may touch: both ends are checked. Default every edge. */
export type EdgeFilter = (a: number, b: number) => boolean;

/**
 * Runs a pass on part of a big surface, for sculpting: the pass reads only `faces`, leaves a removed triangle's slot
 * `null` so ids stay stable, and reports what it changes. Output is the same as a whole-surface pass.
 */
export interface SurfaceWatch {
  /** The triangles to read, ascending. Every face of every edge the filter allows must be here. */
  readonly faces: readonly number[];
  /** Faces around each vertex, as they stood when the pass began. */
  readonly around: readonly (readonly number[])[];
  /** Called before `points[v]` is replaced, and after a new point is added. */
  point(v: number): void;
  /** Called before `tris[f]` changes, and after a new triangle is added. */
  face(f: number): void;
  /** Called before an edge joins or leaves `sharp`. */
  edge(key: string): void;
}

export const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

const sub = (p: Vec3, q: Vec3): MutableVec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];

export const pointDistance = (p: Vec3, q: Vec3): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** Area-scaled normal of a triangle. */
export function triNormal(a: Vec3, b: Vec3, c: Vec3): MutableVec3 {
  const u = sub(b, a),
    v = sub(c, a);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/** Build a surface from a polygon mesh by its own triangulation. */
export function triSurfaceOf(mesh: PolygonMesh): TriSurface {
  const compiled = compilePolygonMesh(mesh),
    byId = new Map(mesh.faces.map((face) => [face.id, face])),
    points: MutableVec3[] = mesh.vertices.map((p) => [p[0], p[1], p[2]]),
    tris: SurfaceTri[] = [];
  for (let t = 0; t < compiled.triangleFaces.length; t++) {
    const corners = [0, 1, 2].map((k) => compiled.indices[t * 3 + k]),
      source = compiled.triangleFaces[t];
    tris.push({
      v: corners.map((c) => compiled.cornerVertices[c]) as [number, number, number],
      uv: corners.map((c): MutableVec2 => [compiled.uvs[c * 2], compiled.uvs[c * 2 + 1]]) as SurfaceTri['uv'],
      source,
    });
    if (!byId.has(source)) throw new TypeError('Compiled triangle names no face; repair the mesh identities.');
  }
  return { points, tris, sharp: new Set() };
}

/** Faces around each edge, of the faces in `only` when given. */
export function edgeFaces(tris: readonly (SurfaceTri | null)[], only?: readonly number[]): Map<string, number[]> {
  const out = new Map<string, number[]>(),
    add = (tri: SurfaceTri | null, f: number): void => {
      if (!tri) return;
      for (let c = 0; c < 3; c++) {
        const key = edgeKey(tri.v[c], tri.v[(c + 1) % 3]),
          list = out.get(key);
        if (list) list.push(f);
        else out.set(key, [f]);
      }
    };
  if (only) for (const f of only) add(tris[f], f);
  else tris.forEach(add);
  return out;
}

/** Faces around each vertex. */
function vertexFaces(surface: TriSurface): number[][] {
  const out: number[][] = surface.points.map(() => []);
  surface.tris.forEach((tri, f) => {
    for (const v of tri.v) out[v].push(f);
  });
  return out;
}

const sameUV = (p: readonly number[], q: readonly number[]): boolean =>
  Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;

/** Mark open edges, edges with a dihedral angle above `sharpAngle` (radians), and optionally UV seams. */
export function markSharpEdges(surface: TriSurface, sharpAngle: number, seams: boolean): void {
  const { points, tris, sharp } = surface,
    cos = Math.cos(sharpAngle);
  for (const [key, faces] of edgeFaces(tris)) {
    if (faces.length !== 2) {
      sharp.add(key);
      continue;
    }
    const [f, g] = faces.map((i) => tris[i]),
      n = triNormal(points[f.v[0]], points[f.v[1]], points[f.v[2]]),
      m = triNormal(points[g.v[0]], points[g.v[1]], points[g.v[2]]),
      size = Math.hypot(...n) * Math.hypot(...m);
    if (size > 0 && dot(n, m) / size < cos) {
      sharp.add(key);
      continue;
    }
    if (!seams) continue;
    const [a, b] = key.split(':').map(Number),
      uvAt = (tri: SurfaceTri, v: number) => tri.uv[tri.v.indexOf(v)];
    if (!sameUV(uvAt(f, a), uvAt(g, a)) || !sameUV(uvAt(f, b), uvAt(g, b))) sharp.add(key);
  }
}

const classOfCount = (count: number): number => (count === 0 ? 0 : count === 2 ? 1 : 2);

/** The class of one vertex from the faces around it, for a pass that must not visit the whole surface. */
function vertexClass(surface: TriSurface, around: readonly number[], v: number): number {
  if (!surface.sharp.size) return 0;
  const seen = new Set<number>();
  for (const f of around) for (const w of surface.tris[f]?.v ?? []) if (w !== v) seen.add(w);
  let count = 0;
  for (const w of seen) if (surface.sharp.has(edgeKey(v, w))) count++;
  return classOfCount(count);
}

/** 0 for a free vertex, 1 on a line of sharp edges, 2 at a corner of them or the end of one. */
function vertexClasses(surface: TriSurface): Uint8Array {
  const count = new Uint16Array(surface.points.length),
    out = new Uint8Array(surface.points.length);
  for (const key of surface.sharp) {
    const [a, b] = key.split(':').map(Number);
    count[a]++;
    count[b]++;
  }
  for (let v = 0; v < out.length; v++) out[v] = classOfCount(count[v]);
  return out;
}

const lerpUV = (p: readonly number[], q: readonly number[], t: number): MutableVec2 => [
  p[0] + (q[0] - p[0]) * t,
  p[1] + (q[1] - p[1]) * t,
];

/** Split every edge longer than `limit` at its middle, longest first. Returns how many were split. */
export function splitLongEdges(
  surface: TriSurface,
  limit: number,
  allow?: EdgeFilter,
  watch?: SurfaceWatch,
): number {
  const { points, tris, sharp } = surface,
    faces = edgeFaces(tris, watch?.faces),
    used = new Set<number>(),
    long: { a: number; b: number; key: string; size: number; around: number[] }[] = [];
  for (const [key, around] of faces) {
    if (around.length > 2) continue;
    const [a, b] = key.split(':').map(Number);
    if (allow && !allow(a, b)) continue;
    const size = pointDistance(points[a], points[b]);
    if (size > limit) long.push({ a, b, key, size, around });
  }
  long.sort((p, q) => q.size - p.size);
  let split = 0;
  for (const { a, b, key, around } of long) {
    if (around.some((f) => used.has(f))) continue;
    const m = points.length;
    points.push([0, 1, 2].map((k) => (points[a][k] + points[b][k]) / 2) as MutableVec3);
    watch?.point(m);
    for (const f of around) {
      const tri = tris[f],
        i = tri.v.findIndex((v, c) => (v === a && tri.v[(c + 1) % 3] === b) || (v === b && tri.v[(c + 1) % 3] === a)),
        j = (i + 1) % 3,
        k = (i + 2) % 3,
        mid = lerpUV(tri.uv[i], tri.uv[j], 0.5);
      watch?.face(f);
      tris[f] = { v: [tri.v[i], m, tri.v[k]], uv: [tri.uv[i], mid, tri.uv[k]], source: tri.source };
      used.add(f);
      used.add(tris.length);
      tris.push({
        v: [m, tri.v[j], tri.v[k]],
        uv: [[mid[0], mid[1]], tri.uv[j], [tri.uv[k][0], tri.uv[k][1]]],
        source: tri.source,
      });
      watch?.face(tris.length - 1);
    }
    if (sharp.has(key)) {
      for (const changed of [key, edgeKey(a, m), edgeKey(m, b)]) watch?.edge(changed);
      sharp.delete(key);
      sharp.add(edgeKey(a, m));
      sharp.add(edgeKey(m, b));
    }
    split++;
  }
  return split;
}

/**
 * Collapse every edge shorter than `low` where that keeps the surface sound: the two ends share only the vertices the
 * edge's own faces give them, no new edge passes `high`, and no triangle turns over. Returns how many collapsed.
 */
export function collapseShortEdges(
  surface: TriSurface,
  low: number,
  high: number,
  allow?: EdgeFilter,
  watch?: SurfaceWatch,
): number {
  const { points, sharp } = surface,
    around = watch ? watch.around : vertexFaces(surface),
    classes = watch ? null : vertexClasses(surface),
    classOf = (v: number): number => (classes ? classes[v] : vertexClass(surface, around[v], v)),
    faces = edgeFaces(surface.tris, watch?.faces),
    tris: (SurfaceTri | null)[] = surface.tris,
    used = new Set<number>(),
    short: { a: number; b: number; key: string; size: number }[] = [];
  for (const key of faces.keys()) {
    const [a, b] = key.split(':').map(Number);
    if (allow && !allow(a, b)) continue;
    const size = pointDistance(points[a], points[b]);
    if (size < low) short.push({ a, b, key, size });
  }
  short.sort((p, q) => p.size - q.size);
  let collapsed = 0;
  for (const edge of short) {
    let { a, b } = edge,
      classA = classOf(a),
      classB = classOf(b);
    // `a` goes away; the vertex with more constraints stays.
    if (classA > classB) {
      [a, b] = [b, a];
      [classA, classB] = [classB, classA];
    }
    if (classA === 2) continue;
    if (classA === 1 && !sharp.has(edge.key)) continue;
    if (classA === 0 && classB === 0 && sharp.has(edge.key)) continue;
    const shared = faces.get(edge.key)!;
    if (shared.length > 2) continue;
    const ring = [...new Set([...around[a], ...around[b]])];
    if (ring.some((f) => used.has(f) || !tris[f])) continue;
    const of = (v: number): Set<number> => new Set(around[v].flatMap((f) => tris[f]!.v).filter((x) => x !== v)),
      na = of(a),
      nb = of(b),
      common = [...na].filter((x) => nb.has(x));
    if (common.length !== shared.length) continue;
    const target: MutableVec3 =
        classA === 0 && classB === 0
          ? ([0, 1, 2].map((k) => (points[a][k] + points[b][k]) / 2) as MutableVec3)
          : [points[b][0], points[b][1], points[b][2]],
      moved = (v: number): Vec3 => (v === a || v === b ? target : points[v]);
    if ([...na, ...nb].some((v) => v !== a && v !== b && pointDistance(target, points[v]) > high)) continue;
    const turned = ring.some((f) => {
      const tri = tris[f]!;
      if (tri.v.includes(a) && tri.v.includes(b)) return false;
      const before = triNormal(points[tri.v[0]], points[tri.v[1]], points[tri.v[2]]),
        after = triNormal(moved(tri.v[0]), moved(tri.v[1]), moved(tri.v[2])),
        size = Math.hypot(...before) * Math.hypot(...after);
      return !(size > 0) || dot(before, after) / size < 0.2;
    });
    if (turned) continue;
    watch?.point(b);
    points[b] = target;
    for (const f of ring) {
      const tri = tris[f]!;
      watch?.face(f);
      used.add(f);
      if (tri.v.includes(a) && tri.v.includes(b)) {
        tris[f] = null;
        continue;
      }
      tri.v = tri.v.map((v) => (v === a ? b : v)) as SurfaceTri['v'];
    }
    // Every sharp edge at `a` ends at one of its neighbors.
    for (const other of na) {
      const key = edgeKey(a, other);
      if (!sharp.has(key)) continue;
      watch?.edge(key);
      sharp.delete(key);
      if (other === b) continue;
      watch?.edge(edgeKey(other, b));
      sharp.add(edgeKey(other, b));
    }
    collapsed++;
  }
  if (!watch) surface.tris = tris.filter((tri): tri is SurfaceTri => tri !== null);
  return collapsed;
}

/** Flip edges that bring both ends and both opposite vertices closer to six neighbors. Returns how many flipped. */
export function flipTowardValence(surface: TriSurface, allow?: EdgeFilter): number {
  const { points, tris, sharp } = surface,
    faces = edgeFaces(tris),
    valence = new Int32Array(points.length),
    used = new Set<number>();
  for (const key of faces.keys()) {
    const [a, b] = key.split(':').map(Number);
    valence[a]++;
    valence[b]++;
  }
  const boundary = vertexClasses(surface),
    ideal = (v: number): number => (boundary[v] ? 4 : 6);
  let flipped = 0;
  for (const [key, around] of faces) {
    if (around.length !== 2 || sharp.has(key) || around.some((f) => used.has(f))) continue;
    const [a, b] = key.split(':').map(Number);
    if (allow && !allow(a, b)) continue;
    const [f, g] = around.map((i) => tris[i]),
      c = f.v.find((v) => v !== a && v !== b)!,
      d = g.v.find((v) => v !== a && v !== b)!;
    if (c === d || faces.has(edgeKey(c, d))) continue;
    const off = (v: number, change: number): number => Math.abs(valence[v] + change - ideal(v)),
      before = off(a, 0) ** 2 + off(b, 0) ** 2 + off(c, 0) ** 2 + off(d, 0) ** 2,
      after = off(a, -1) ** 2 + off(b, -1) ** 2 + off(c, 1) ** 2 + off(d, 1) ** 2;
    if (after >= before) continue;
    // Keep each face's winding: f runs a to b (or is turned so), and the new faces share its direction.
    const i = f.v.indexOf(a),
      forward = f.v[(i + 1) % 3] === b,
      from = forward ? a : b,
      to = forward ? b : a,
      uvOf = (tri: SurfaceTri, v: number): MutableVec2 => {
        const uv = tri.uv[tri.v.indexOf(v)];
        return [uv[0], uv[1]];
      },
      one: SurfaceTri = {
        v: [c, from, d],
        uv: [uvOf(f, c), uvOf(f, from), uvOf(g, d)],
        source: f.source,
      },
      two: SurfaceTri = { v: [d, to, c], uv: [uvOf(g, d), uvOf(g, to), uvOf(f, c)], source: g.source },
      was = triNormal(points[f.v[0]], points[f.v[1]], points[f.v[2]]),
      n1 = triNormal(points[c], points[from], points[d]),
      n2 = triNormal(points[d], points[to], points[c]),
      size = Math.hypot(...was);
    if (dot(was, n1) <= 0.2 * size * Math.hypot(...n1) || dot(was, n2) <= 0.2 * size * Math.hypot(...n2)) continue;
    tris[around[0]] = one;
    tris[around[1]] = two;
    used.add(around[0]).add(around[1]);
    valence[a]--;
    valence[b]--;
    valence[c]++;
    valence[d]++;
    flipped++;
  }
  return flipped;
}

/** Move free vertices toward their neighbors' average within the tangent plane, then let `project` place them. */
export function relaxTangential(
  surface: TriSurface,
  amount: number,
  project?: (p: MutableVec3) => void,
  allow?: (v: number) => boolean,
): void {
  const { points, tris } = surface,
    classes = vertexClasses(surface),
    sum: MutableVec3[] = points.map(() => [0, 0, 0]),
    normal: MutableVec3[] = points.map(() => [0, 0, 0]),
    count = new Int32Array(points.length);
  for (const [key] of edgeFaces(tris)) {
    const [a, b] = key.split(':').map(Number);
    for (let k = 0; k < 3; k++) {
      sum[a][k] += points[b][k];
      sum[b][k] += points[a][k];
    }
    count[a]++;
    count[b]++;
  }
  for (const tri of tris) {
    const n = triNormal(points[tri.v[0]], points[tri.v[1]], points[tri.v[2]]);
    for (const v of tri.v) for (let k = 0; k < 3; k++) normal[v][k] += n[k];
  }
  const next = points.map((p, v): MutableVec3 => {
    if (classes[v] || !count[v] || (allow && !allow(v))) return p;
    const size = Math.hypot(...normal[v]) || 1,
      n = normal[v].map((x) => x / size),
      d = [0, 1, 2].map((k) => sum[v][k] / count[v] - p[k]),
      along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2],
      moved: MutableVec3 = [0, 1, 2].map((k) => p[k] + (d[k] - along * n[k]) * amount) as MutableVec3;
    project?.(moved);
    return moved;
  });
  surface.points = next;
}

/** The surface as a polygon mesh with used vertices only; `createId` names faces. */
export function polygonMeshOfSurface(surface: TriSurface, createId: (source: string) => string): PolygonMesh {
  const remap = new Int32Array(surface.points.length).fill(-1),
    vertices: MutableVec3[] = [],
    faces: PolygonFace[] = [];
  for (const tri of surface.tris) {
    faces.push({
      id: createId(tri.source),
      vertices: tri.v.map((v) => {
        if (remap[v] < 0) {
          remap[v] = vertices.length;
          vertices.push(surface.points[v]);
        }
        return remap[v];
      }),
      uv: tri.uv.map((uv): MutableVec2 => [Math.min(1, Math.max(0, uv[0])), Math.min(1, Math.max(0, uv[1]))]),
    });
  }
  return { vertices, faces };
}
