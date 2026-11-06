import type { MutableVec2, MutableVec3, Vec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { FaceSink } from './face-sink.js';
import { assertPolygonMesh, collectPolygonEdges, newellNormal } from './polygon.js';
import { faceIdFactory } from './result.js';
import type { MeshEditOptions, MeshEditResult, PolygonMesh } from './types.js';

/** Options for {@link fillMeshHoles}. */
export interface FillHolesOptions extends MeshEditOptions {
  /** `'triangles'` covers a hole with triangles; `'grid'` with a quad grid (holes with an even edge count). Default `'triangles'`. */
  mode?: 'triangles' | 'grid';
  /** Leave holes with more edges than this open. Default no limit. */
  maxEdges?: number;
  /** Add vertices so fill triangles match the size of the border's edges. Default true. */
  refine?: boolean;
  /** Move added vertices so the fill continues the curvature around it. Default true. */
  fair?: boolean;
  /** Checked between holes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** One open border and what {@link fillMeshHoles} did with it. */
export interface FilledHole {
  /** The border's vertices, in the winding the fill uses. */
  vertices: number[];
  /** Faces added. Empty when the hole was left open. */
  faces: string[];
}

/** Result of {@link fillMeshHoles}. */
export interface FillHolesResult extends MeshEditResult {
  holes: FilledHole[];
}

/** Holes above this many edges start from a fan around their center: exact search costs edges cubed. */
const SEARCH_LIMIT = 256;

/**
 * Every open border of a mesh, as vertex loops wound the way a face filling the hole would be. A border that touches
 * itself at a vertex comes back as separate loops.
 * @throws TypeError for a bad mesh.
 */
export function meshBoundaryLoops(mesh: PolygonMesh): number[][] {
  assertPolygonMesh(mesh, false);
  const out = new Map<number, number[]>();
  for (const edge of collectPolygonEdges(mesh)) {
    if (edge.incidences.length !== 1) continue;
    const { from, to } = edge.incidences[0],
      list = out.get(to);
    if (list) list.push(from);
    else out.set(to, [from]);
  }
  const loops: number[][] = [];
  for (const start of out.keys())
    while (out.get(start)?.length) {
      const path = [start],
        at = new Map([[start, 0]]);
      for (;;) {
        const next = out.get(path[path.length - 1])?.pop();
        if (next === undefined) break;
        const seen = at.get(next);
        if (seen === undefined) {
          at.set(next, path.length);
          path.push(next);
          continue;
        }
        const loop = path.splice(seen);
        for (const v of loop) at.delete(v);
        if (loop.length >= 3) loops.push(loop);
        if (!path.length) break;
        at.set(next, path.length);
        path.push(next);
      }
    }
  return loops;
}

const sub = (p: Vec3, q: Vec3): MutableVec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const cross = (u: Vec3, v: Vec3): MutableVec3 => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];
const length = (u: Vec3): number => Math.hypot(u[0], u[1], u[2]);
const distance = (p: Vec3, q: Vec3): number => length(sub(p, q));

/** Unit normal of a triangle, or null when it has no area. */
function triangleNormal(a: Vec3, b: Vec3, c: Vec3): MutableVec3 | null {
  const n = cross(sub(b, a), sub(c, a)),
    size = length(n);
  return size > 0 ? [n[0] / size, n[1] / size, n[2] / size] : null;
}

/**
 * Lowest-cost triangulation of a closed loop by dynamic programming (Liepa, 2003, with one scalar cost): compact
 * triangles that fold little against their neighbors and the faces around the hole. `outside[i]` is the normal of
 * the face across loop edge i.
 */
function bestTriangles(points: readonly Vec3[], outside: readonly (Vec3 | null)[]): number[][] {
  const n = points.length,
    cost = new Float64Array(n * n),
    pick = new Int32Array(n * n).fill(-1),
    scale = points.reduce((sum, p, i) => sum + distance(p, points[(i + 1) % n]), 0) / n,
    invalid = 1e6 * scale * scale,
    normalOf = (i: number, j: number): MutableVec3 | null => {
      const k = pick[i * n + j];
      return k < 0 ? null : triangleNormal(points[i], points[k], points[j]);
    },
    fold = (normal: Vec3, other: Vec3 | null, p: Vec3, q: Vec3): number => {
      if (!other) return 0;
      const d = normal[0] * other[0] + normal[1] * other[1] + normal[2] * other[2],
        edge = distance(p, q);
      return (1 - d) * edge * edge * 4;
    };
  for (let span = 2; span < n; span++)
    for (let i = 0; i + span < n; i++) {
      const j = i + span;
      let best = Infinity;
      for (let k = i + 1; k < j; k++) {
        const a = points[i],
          b = points[k],
          c = points[j],
          normal = triangleNormal(a, b, c);
        let value = cost[i * n + k] + cost[k * n + j];
        if (!normal) value += invalid;
        else {
          const ab = distance(a, b),
            bc = distance(b, c),
            ca = distance(c, a),
            area = length(cross(sub(b, a), sub(c, a))) / 2;
          value += ab * ab + bc * bc + ca * ca;
          // A nearly flat triangle costs like an invalid one, in proportion to how thin it is.
          if (area < 1e-9 * Math.max(ab, bc, ca) ** 2) value += invalid;
          value += fold(normal, k === i + 1 ? outside[i] : normalOf(i, k), a, b);
          value += fold(normal, k === j - 1 ? outside[k] : normalOf(k, j), b, c);
          if (span === n - 1) value += fold(normal, outside[n - 1], c, a);
        }
        if (value < best) {
          best = value;
          pick[i * n + j] = k;
        }
      }
      cost[i * n + j] = best;
    }
  const out: number[][] = [],
    stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!,
      k = pick[i * n + j];
    if (k < 0) continue;
    out.push([i, k, j]);
    stack.push([i, k], [k, j]);
  }
  return out;
}

/** Swap an edge shared by two triangles when that makes them closer to Delaunay. */
function flipEdges(tris: number[][], vertices: readonly Vec3[]): void {
  const angleAt = (p: Vec3, q: Vec3, r: Vec3): number => {
    const u = sub(q, p),
      v = sub(r, p);
    return Math.atan2(length(cross(u, v)), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
  };
  for (let round = 0; round < 16; round++) {
    let flipped = false;
    const owner = new Map<string, number>();
    const stale = new Set<number>();
    tris.forEach((t, f) => {
      for (let c = 0; c < 3; c++) {
        const a = t[c],
          b = t[(c + 1) % 3],
          g = owner.get(`${b}>${a}`);
        owner.set(`${a}>${b}`, f);
        if (g === undefined || stale.has(f) || stale.has(g)) continue;
        const other = tris[g],
          p = t[(c + 2) % 3],
          q = other.find((v) => v !== a && v !== b)!;
        if (owner.has(`${p}>${q}`) || owner.has(`${q}>${p}`)) continue;
        if (
          angleAt(vertices[p], vertices[a], vertices[b]) + angleAt(vertices[q], vertices[a], vertices[b]) <=
          Math.PI + 1e-9
        )
          continue;
        const left = triangleNormal(vertices[p], vertices[a], vertices[q]),
          right = triangleNormal(vertices[p], vertices[q], vertices[b]),
          before = triangleNormal(vertices[a], vertices[b], vertices[p]);
        if (!left || !right || !before) continue;
        if (left[0] * before[0] + left[1] * before[1] + left[2] * before[2] <= 0) continue;
        if (right[0] * before[0] + right[1] * before[1] + right[2] * before[2] <= 0) continue;
        tris[f] = [p, a, q];
        tris[g] = [p, q, b];
        stale.add(f).add(g);
        flipped = true;
        return;
      }
    });
    if (!flipped) return;
  }
}

/** Split fill triangles until they match `target`. Border edges never split, so the mesh around stays as it is. */
function refineTriangles(
  tris: number[][],
  vertices: MutableVec3[],
  border: ReadonlySet<string>,
  target: number,
): number[] {
  const added: number[] = [],
    limit = target * 1.5;
  flipEdges(tris, vertices);
  for (let round = 0; round < 24; round++) {
    let changed = false;
    const owner = new Map<string, number>(),
      used = new Set<number>();
    tris.forEach((t, f) => {
      t.forEach((v, c) => {
        owner.set(`${v}>${t[(c + 1) % 3]}`, f);
      });
    });
    const count = tris.length;
    for (let f = 0; f < count; f++) {
      if (used.has(f)) continue;
      const t = tris[f],
        sides = t.map((v, c) => distance(vertices[v], vertices[t[(c + 1) % 3]])),
        order = [0, 1, 2].sort((x, y) => sides[y] - sides[x]),
        c = order.find((k) => {
          const a = t[k],
            b = t[(k + 1) % 3];
          return sides[k] > limit && !border.has(`${a}>${b}`) && !border.has(`${b}>${a}`);
        });
      if (c !== undefined) {
        const a = t[c],
          b = t[(c + 1) % 3],
          g = owner.get(`${b}>${a}`);
        if (g === undefined || used.has(g)) continue;
        const other = tris[g],
          p = t[(c + 2) % 3],
          q = other.find((v) => v !== a && v !== b)!,
          m = vertices.length;
        vertices.push([0, 1, 2].map((k) => (vertices[a][k] + vertices[b][k]) / 2) as MutableVec3);
        added.push(m);
        tris[f] = [a, m, p];
        tris.push([m, b, p]);
        tris[g] = [b, m, q];
        tris.push([m, a, q]);
        used.add(f).add(g);
        changed = true;
        continue;
      }
      if (Math.min(...sides) > limit) {
        const m = vertices.length;
        vertices.push(
          [0, 1, 2].map((k) => (vertices[t[0]][k] + vertices[t[1]][k] + vertices[t[2]][k]) / 3) as MutableVec3,
        );
        added.push(m);
        tris[f] = [t[0], t[1], m];
        tris.push([t[1], t[2], m], [t[2], t[0], m]);
        used.add(f);
        changed = true;
      }
    }
    flipEdges(tris, vertices);
    if (!changed) break;
  }
  return added;
}

/**
 * Move `free` vertices to minimize bending: the discrete bi-Laplacian, relaxed as Kobbelt and others (1998) describe,
 * with the rings of the surrounding mesh held still so the fill leaves the border along the surface's own slope.
 */
function fairVertices(free: readonly number[], rings: readonly (readonly number[])[], vertices: MutableVec3[]): void {
  const umbrella = (v: number): MutableVec3 => {
    const ring = rings[v],
      out: MutableVec3 = [0, 0, 0];
    for (const n of ring) for (let k = 0; k < 3; k++) out[k] += vertices[n][k] - vertices[v][k];
    return [out[0] / ring.length, out[1] / ring.length, out[2] / ring.length];
  };
  const wanted = new Set(free);
  for (const v of free) for (const n of rings[v]) wanted.add(n);
  for (let pass = 0; pass < 200; pass++) {
    const first = new Map<number, MutableVec3>();
    for (const v of wanted) if (rings[v]?.length) first.set(v, umbrella(v));
    for (const v of free) {
      const ring = rings[v],
        second: MutableVec3 = [0, 0, 0];
      let weight = 1;
      for (const n of ring) {
        const u = first.get(n)!;
        for (let k = 0; k < 3; k++) second[k] += u[k] - first.get(v)![k];
        weight += 1 / (ring.length * rings[n].length);
      }
      for (let k = 0; k < 3; k++) vertices[v][k] -= (second[k] / ring.length / weight) * 0.8;
    }
  }
}

/** Corner UVs for new faces: the hole's own plane, scaled to the unit square. */
function planarUV(points: readonly Vec3[]): (p: Vec3) => MutableVec2 {
  const n = newellNormal(points),
    helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
    u = cross(n, helper),
    v = cross(n, u),
    project = (p: Vec3): [number, number] => [
      p[0] * u[0] + p[1] * u[1] + p[2] * u[2],
      p[0] * v[0] + p[1] * v[1] + p[2] * v[2],
    ],
    all = points.map(project),
    lo = [Math.min(...all.map((q) => q[0])), Math.min(...all.map((q) => q[1]))],
    hi = [Math.max(...all.map((q) => q[0])), Math.max(...all.map((q) => q[1]))];
  return (p) => {
    const [x, y] = project(p);
    return [
      Math.min(1, Math.max(0, (x - lo[0]) / (hi[0] - lo[0] || 1))),
      Math.min(1, Math.max(0, (y - lo[1]) / (hi[1] - lo[1] || 1))),
    ];
  };
}

/** A grid over an even loop by Coons interpolation of its four sides; returns quads and the vertices added. */
function gridFill(loop: readonly number[], vertices: MutableVec3[]): { quads: number[][]; added: number[] } {
  const n = loop.length,
    a = Math.max(1, Math.floor(n / 4)),
    b = n / 2 - a,
    turn = (i: number): number => {
      const p = vertices[loop[(i + n - 1) % n]],
        q = vertices[loop[i % n]],
        r = vertices[loop[(i + 1) % n]],
        u = sub(q, p),
        v = sub(r, q);
      return Math.atan2(length(cross(u, v)), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
    };
  let start = 0,
    sharpest = -1;
  for (let s = 0; s < n; s++) {
    const value = turn(s) + turn(s + a) + turn(s + a + b) + turn(s + 2 * a + b);
    if (value > sharpest + 1e-9) {
      sharpest = value;
      start = s;
    }
  }
  const at = (k: number): number => loop[(((start + k) % n) + n) % n],
    grid: number[][] = Array.from({ length: a + 1 }, () => new Array<number>(b + 1)),
    added: number[] = [];
  for (let i = 0; i <= a; i++) {
    grid[i][0] = at(i);
    grid[i][b] = at(2 * a + b - i);
  }
  for (let j = 0; j <= b; j++) {
    grid[a][j] = at(a + j);
    grid[0][j] = at(2 * a + 2 * b - j);
  }
  for (let i = 1; i < a; i++)
    for (let j = 1; j < b; j++) {
      const u = i / a,
        v = j / b,
        p = (x: number, y: number): Vec3 => vertices[grid[x][y]],
        point = [0, 1, 2].map(
          (k) =>
            (1 - v) * p(i, 0)[k] +
            v * p(i, b)[k] +
            (1 - u) * p(0, j)[k] +
            u * p(a, j)[k] -
            ((1 - u) * (1 - v) * p(0, 0)[k] + u * (1 - v) * p(a, 0)[k] + (1 - u) * v * p(0, b)[k] + u * v * p(a, b)[k]),
        );
      grid[i][j] = vertices.length;
      added.push(vertices.length);
      vertices.push(point as MutableVec3);
    }
  const quads: number[][] = [];
  for (let i = 0; i < a; i++)
    for (let j = 0; j < b; j++) quads.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
  return { quads, added };
}

/**
 * Fill open borders, for repairing imports and scans. `triangles` mode finds the lowest-cost triangulation of each
 * border, adds vertices to match the size of the edges around it, then moves them to continue the surrounding
 * curvature. `grid` mode lays a quad grid (Coons interpolation of the border) over holes with an even edge count and
 * uses triangles for the rest. The mesh around a hole does not change. New faces take UVs from the hole's own plane.
 * @throws TypeError for a bad mesh or options; RangeError for a bad `maxEdges`; the signal's reason when aborted.
 */
export function fillMeshHoles(mesh: PolygonMesh, options: FillHolesOptions = {}): FillHolesResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Fill holes');
  const { mode = 'triangles', maxEdges = Infinity, refine = true, fair = true, signal } = options;
  if (mode !== 'triangles' && mode !== 'grid')
    throw new TypeError("Fill holes mode must be 'triangles' or 'grid'; choose one.");
  if (!(maxEdges >= 3)) throw new RangeError('Fill holes maxEdges must be 3 or more; choose an edge count or omit it.');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('Fill holes signal must be an AbortSignal; pass controller.signal or omit it.');
  const createId = faceIdFactory(mesh, options),
    vertices: MutableVec3[] = mesh.vertices.map((p) => [p[0], p[1], p[2]]),
    sink = new FaceSink(mesh, vertices),
    normals = new Map<string, MutableVec3>(),
    rings: number[][] = mesh.vertices.map(() => []),
    holes: FilledHole[] = [],
    diagnostics: string[] = [];
  for (const face of mesh.faces) {
    sink.add(face.id, face.id, face.vertices, face.uv);
    const n = newellNormal(face.vertices.map((v) => mesh.vertices[v]));
    face.vertices.forEach((v, i) => {
      const w = face.vertices[(i + 1) % face.vertices.length];
      normals.set(`${w}>${v}`, n);
      if (!rings[v].includes(w)) rings[v].push(w);
      if (!rings[w].includes(v)) rings[w].push(v);
    });
  }
  for (const loop of meshBoundaryLoops(mesh)) {
    signal?.throwIfAborted();
    const n = loop.length,
      hole: FilledHole = { vertices: loop, faces: [] };
    holes.push(hole);
    if (n > maxEdges) {
      diagnostics.push(`A hole of ${n} edges was left open by maxEdges.`);
      continue;
    }
    const points = loop.map((v) => vertices[v]),
      uvOf = planarUV(points),
      mean = points.reduce((sum, p, i) => sum + distance(p, points[(i + 1) % n]), 0) / n;
    let polygons: number[][],
      added: number[] = [];
    if (mode === 'grid' && n % 2 === 0) {
      const { quads, added: created } = gridFill(loop, vertices);
      polygons = quads;
      added = created;
    } else {
      let tris: number[][];
      if (n > SEARCH_LIMIT) {
        const center = vertices.length;
        vertices.push([0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k], 0) / n) as MutableVec3);
        added.push(center);
        tris = loop.map((v, i) => [v, loop[(i + 1) % n], center]);
      } else {
        const outside = loop.map((v, i) => normals.get(`${v}>${loop[(i + 1) % n]}`) ?? null);
        tris = bestTriangles(points, outside).map((t) => t.map((c) => loop[c]));
      }
      if (refine) {
        const border = new Set(loop.map((v, i) => `${v}>${loop[(i + 1) % n]}`));
        added.push(...refineTriangles(tris, vertices, border, mean));
      }
      polygons = tris;
    }
    for (const polygon of polygons)
      polygon.forEach((v, i) => {
        const w = polygon[(i + 1) % polygon.length];
        rings[v] ??= [];
        rings[w] ??= [];
        if (!rings[v].includes(w)) rings[v].push(w);
        if (!rings[w].includes(v)) rings[w].push(v);
      });
    if (fair && added.length) fairVertices(added, rings, vertices);
    const before = sink.faces.length;
    for (const polygon of polygons)
      sink.add(
        null,
        createId(),
        polygon,
        polygon.map((v) => uvOf(vertices[v])),
      );
    hole.faces = sink.faces.slice(before).map((face) => face.id);
  }
  const result = sink.result(
    mesh,
    mesh.vertices.map((_, v) => [v]),
    diagnostics,
  );
  return {
    ...result,
    createdVertices: vertices.slice(mesh.vertices.length).map((_, i) => mesh.vertices.length + i),
    holes,
  };
}
