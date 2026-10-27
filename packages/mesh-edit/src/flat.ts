import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, newellNormal, polygonGeometryError } from './polygon.js';
import { createMeshEditResult } from './result.js';
import type { MeshEditResult, PolygonMesh } from './types.js';

type UVMap = (p: readonly number[]) => [number, number];

/** The affine map from positions in a face's plane to UV, fitted by least squares to its corners; null without area. */
function affineUV(
  points: readonly (readonly number[])[],
  uvs: readonly (readonly number[])[],
  n: readonly number[],
): UVMap | null {
  const o = points[0];
  let x = [0, 0, 0];
  for (const p of points) {
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    if (Math.hypot(d[0], d[1], d[2]) > Math.hypot(x[0], x[1], x[2])) x = d;
  }
  const lx = Math.hypot(x[0], x[1], x[2]);
  if (!(lx > 0)) return null;
  x = x.map((c) => c / lx);
  const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]],
    flat = (p: readonly number[]) => {
      const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      return [(d[0] * x[0] + d[1] * x[1] + d[2] * x[2]) / lx, (d[0] * y[0] + d[1] * y[1] + d[2] * y[2]) / lx];
    };
  // Normal equations of uv = A [s, t, 1], coordinates scaled by the face size for conditioning.
  const m = new Float64Array(9),
    r = [new Float64Array(3), new Float64Array(3)];
  points.forEach((p, i) => {
    const [s, t] = flat(p),
      row = [s, t, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) m[3 * a + b] += row[a] * row[b];
      r[0][a] += row[a] * uvs[i][0];
      r[1][a] += row[a] * uvs[i][1];
    }
  });
  const det3 = (c: ArrayLike<number>) =>
    c[0] * (c[4] * c[8] - c[5] * c[7]) - c[1] * (c[3] * c[8] - c[5] * c[6]) + c[2] * (c[3] * c[7] - c[4] * c[6]);
  const det = det3(m);
  if (!(Math.abs(det) > 1e-12)) return null;
  const solve = (rhs: Float64Array) =>
    [0, 1, 2].map((col) => {
      const c = Float64Array.from(m);
      for (let row = 0; row < 3; row++) c[3 * row + col] = rhs[row];
      return det3(c) / det;
    });
  const a = solve(r[0]),
    b = solve(r[1]);
  return (p) => {
    const [s, t] = flat(p);
    return [a[0] * s + a[1] * t + a[2], b[0] * s + b[1] * t + b[2]];
  };
}

/** Options for {@link mergeFlatFaces}. */
export interface MergeFlatOptions {
  /** Only these faces may merge (default every face). */
  faces?: readonly string[];
  /** How far (local units) a corner may sit off its neighbor's plane or line and still count as flat. Default 1e-6
   * times the mesh's bounding-box diagonal. */
  tolerance?: number;
  /** `'match'` (default) merges only faces whose UVs are one affine map, so texturing is unchanged; `'ignore'` merges
   * on geometry alone, for meshes you will unwrap again. */
  uv?: 'match' | 'ignore';
  /** Checked as the work goes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Result of {@link mergeFlatFaces}. */
export interface MergeFlatResult extends MeshEditResult {
  /** Faces merged into another one. */
  merged: number;
}

/**
 * Flat-tile merging: join neighboring coplanar faces into larger convex polygons, as a tile or voxel editor's grid of
 * unit quads becomes a few large faces. Faces merge across any shared run of edges when the union is one planar,
 * convex polygon of at most 64 corners; with `uv: 'match'` their UVs must also be one affine map of position, so the
 * merged face renders exactly as before. Corners left in the middle of a straight side drop out when no other face
 * uses their vertex (so no T-junction is made); vertices no face uses any more are removed and the rest renumbered.
 * The merged face keeps the ID of its first face in mesh order. Nonmanifold or inconsistently wound edges never merge.
 * @throws TypeError for bad structure, options or face IDs; RangeError for a bad tolerance; the signal's reason when
 * aborted.
 */
export function mergeFlatFaces(mesh: PolygonMesh, options: MergeFlatOptions = {}): MergeFlatResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Merge flat faces');
  const P = mesh.vertices,
    F = mesh.faces,
    uvMode = options.uv ?? 'match';
  if (uvMode !== 'match' && uvMode !== 'ignore')
    throw new TypeError("Merge flat faces uv must be 'match' or 'ignore'; choose one or omit it.");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Merge flat faces signal must be an AbortSignal; pass controller.signal or omit it.');
  let lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const p of P) {
    lo = lo.map((x, k) => Math.min(x, p[k]));
    hi = hi.map((x, k) => Math.max(x, p[k]));
  }
  const diagonal = P.length ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0,
    tolerance = options.tolerance ?? diagonal * 1e-6;
  if (typeof tolerance !== 'number' || !(tolerance >= 0) || !Number.isFinite(tolerance))
    throw new RangeError(
      'Merge flat faces tolerance must be a finite distance of zero or more; omit it for the default.',
    );
  const index = new Map(F.map((face, i) => [face.id, i])),
    allowed = new Uint8Array(F.length);
  if (options.faces === undefined) allowed.fill(1);
  else {
    if (!Array.isArray(options.faces))
      throw new TypeError('Merge flat faces needs an array of face IDs; supply face IDs or omit faces.');
    for (const id of options.faces) {
      const f = index.get(id);
      if (f === undefined)
        throw new TypeError(`Merge flat faces face ${String(id)} does not exist; select existing faces.`);
      allowed[f] = 1;
    }
  }
  const signal = options.signal;
  signal?.throwIfAborted();
  // Each group: its corner loop (vertex and UV per corner) and the plane and UV map of its first face.
  const normals = F.map((face) => newellNormal(face.vertices.map((v) => P[v])));
  const maps = F.map((face, f) =>
    uvMode === 'ignore'
      ? null
      : affineUV(
          face.vertices.map((v) => P[v]),
          face.uv,
          normals[f],
        ),
  );
  const fits = (map: UVMap | null, vertices: readonly number[], uv: readonly (readonly number[])[]) =>
    map !== null &&
    vertices.every((v, c) => {
      const [u, w] = map(P[v]);
      return Math.abs(u - uv[c][0]) <= 1e-9 && Math.abs(w - uv[c][1]) <= 1e-9;
    });
  const affine = F.map((face, f) => uvMode === 'ignore' || fits(maps[f], face.vertices, face.uv));
  const loops: ({ vertices: number[]; uv: MutableVec2[] } | null)[] = F.map((face) => ({
      vertices: [...face.vertices],
      uv: face.uv.map((uv) => [uv[0], uv[1]] as MutableVec2),
    })),
    groupOf = new Int32Array(F.length).map((_, i) => i),
    users = P.map(() => new Set<number>());
  F.forEach((face, f) => {
    for (const v of face.vertices) users[v].add(f);
  });
  // Mergeable neighbors: two faces wound oppositely on a two-face edge.
  const neighbors = F.map(() => new Set<number>());
  for (const edge of collectPolygonEdges(mesh)) {
    if (edge.incidences.length !== 2) continue;
    const [p, q] = edge.incidences;
    if (p.from !== q.to || p.to !== q.from) continue;
    const f = index.get(p.faceId)!,
      g = index.get(q.faceId)!;
    if (f === g || !allowed[f] || !allowed[g]) continue;
    neighbors[f].add(g);
    neighbors[g].add(f);
  }
  const flatWith = (group: number, other: number) => {
    const n = normals[group],
      o = P[F[group].vertices[0]],
      loop = loops[other]!;
    if (n[0] * normals[other][0] + n[1] * normals[other][1] + n[2] * normals[other][2] <= 0) return false;
    for (const v of loop.vertices) {
      const p = P[v];
      if (Math.abs(n[0] * (p[0] - o[0]) + n[1] * (p[1] - o[1]) + n[2] * (p[2] - o[2])) > tolerance) return false;
    }
    if (uvMode === 'ignore') return true;
    return affine[group] && affine[other] && fits(maps[group], loop.vertices, loop.uv);
  };
  /** Whether v lies strictly inside the segment u-w (within the tolerance). */
  const straight = (u: number, v: number, w: number) => {
    const a = P[u],
      b = P[w],
      p = P[v],
      d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      e = [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
      length = Math.hypot(d[0], d[1], d[2]);
    if (!(length > 0)) return false;
    const t = (d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) / length,
      off = Math.hypot(e[1] * d[2] - e[2] * d[1], e[2] * d[0] - e[0] * d[2], e[0] * d[1] - e[1] * d[0]) / length;
    return t > 0 && t < length && off <= tolerance;
  };
  /** The union of two groups' loops, or null when it is not one valid polygon. */
  const union = (a: number, b: number) => {
    const A = loops[a]!,
      B = loops[b]!,
      half = new Map<string, number>();
    const corners: { from: number; to: number; uv: MutableVec2 }[] = [];
    for (const loop of [A, B])
      loop.vertices.forEach((v, i) => {
        const w = loop.vertices[(i + 1) % loop.vertices.length];
        corners.push({ from: v, to: w, uv: loop.uv[i] });
      });
    corners.forEach((c, i) => half.set(`${c.from}>${c.to}`, i));
    const kept = corners.filter((c) => !half.has(`${c.to}>${c.from}`));
    if (kept.length === corners.length || kept.length < 3) return null;
    const next = new Map<number, (typeof corners)[number]>();
    for (const c of kept) {
      if (next.has(c.from)) return null; // the union touches itself at a vertex
      next.set(c.from, c);
    }
    const vertices: number[] = [],
      uv: MutableVec2[] = [];
    let c: (typeof corners)[number] | undefined = kept[0];
    while (c && vertices.length <= kept.length) {
      vertices.push(c.from);
      uv.push(c.uv);
      c = next.get(c.to);
      if (c === kept[0]) break;
    }
    if (vertices.length !== kept.length) return null; // more than one loop: a hole
    // Drop corners in the middle of a straight side that no other face uses.
    for (let changed = true; changed && vertices.length > 3; ) {
      changed = false;
      for (let i = 0; i < vertices.length && vertices.length > 3; i++) {
        const v = vertices[i];
        if ([...users[v]].some((f) => groupOf[f] !== a && groupOf[f] !== b)) continue;
        if (straight(vertices[(i + vertices.length - 1) % vertices.length], v, vertices[(i + 1) % vertices.length])) {
          vertices.splice(i, 1);
          uv.splice(i, 1);
          changed = true;
          i--;
        }
      }
    }
    if (vertices.length > 64 || polygonGeometryError(vertices.map((v) => P[v]))) return null;
    return { vertices, uv };
  };
  let merged = 0,
    steps = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let a = 0; a < F.length; a++) {
      if (!loops[a]) continue;
      for (const b of [...neighbors[a]].sort((x, y) => x - y)) {
        if (signal && ++steps % 256 === 0) signal.throwIfAborted();
        if (b === a || !loops[b] || !flatWith(a, b) || !flatWith(b, a)) continue;
        const loop = union(a, b);
        if (!loop) continue;
        // The group keeps its first face in mesh order.
        const keep = Math.min(a, b),
          drop = Math.max(a, b);
        loops[keep] = loop;
        loops[drop] = null;
        for (let f = 0; f < F.length; f++) if (groupOf[f] === drop) groupOf[f] = keep;
        for (const n of neighbors[drop])
          if (n !== keep) {
            neighbors[keep].add(n);
            neighbors[n].delete(drop);
            neighbors[n].add(keep);
          }
        neighbors[keep].delete(drop);
        neighbors[drop].clear();
        merged++;
        changed = true;
        if (keep !== a) break;
      }
    }
  }
  // Straight corners on a shared edge drop from both faces at once (and on a border from its one face), so the edge
  // stays shared and no T-junction appears.
  for (let changed = merged > 0; changed; ) {
    changed = false;
    const at = new Map<number, number[]>();
    loops.forEach((loop, g) => loop?.vertices.forEach((v) => at.set(v, [...(at.get(v) ?? []), g])));
    for (const [v, groups] of at) {
      if (groups.length > 2 || groups.some((g) => !allowed[g])) continue;
      let pair: string | null = null,
        ok = true;
      for (const g of groups) {
        const loop = loops[g]!,
          n = loop.vertices.length,
          i = loop.vertices.indexOf(v),
          u = loop.vertices[(i + n - 1) % n],
          w = loop.vertices[(i + 1) % n],
          key = u < w ? `${u}:${w}` : `${w}:${u}`;
        if (n <= 3 || !straight(u, v, w) || (pair !== null && pair !== key)) {
          ok = false;
          break;
        }
        pair = key;
      }
      if (!ok) continue;
      for (const g of groups) {
        const loop = loops[g]!,
          i = loop.vertices.indexOf(v);
        loop.vertices.splice(i, 1);
        loop.uv.splice(i, 1);
      }
      changed = true;
    }
  }
  // Output: renumber used vertices (loose input vertices stay), keep group order.
  const used = new Uint8Array(P.length),
    before = new Uint8Array(P.length);
  for (const face of F) for (const v of face.vertices) before[v] = 1;
  for (const loop of loops) if (loop) for (const v of loop.vertices) used[v] = 1;
  const remap = new Int32Array(P.length).fill(-1),
    vertices: MutableVec3[] = [];
  P.forEach((p, v) => {
    if (used[v] || !before[v]) {
      remap[v] = vertices.length;
      vertices.push([p[0], p[1], p[2]]);
    }
  });
  const faces = loops.flatMap((loop, f) =>
    loop
      ? [
          {
            id: F[f].id,
            vertices: loop.vertices.map((v) => remap[v]),
            uv: loop.uv.map((uv) => [uv[0], uv[1]] as MutableVec2),
          },
        ]
      : [],
  );
  const output: PolygonMesh = { vertices, faces };
  assertPolygonMesh(output);
  const removed = P.map((_, v) => v).filter((v) => remap[v] < 0);
  return {
    ...createMeshEditResult(mesh, output, {
      vertexMap: P.map((_, v) => (remap[v] < 0 ? [] : [remap[v]])),
      faceMap: Object.fromEntries(F.map((face, f) => [face.id, [F[groupOf[f]].id]])),
      createdVertices: [],
      removedVertices: removed,
      affectedFaces: [...new Set(F.flatMap((_, f) => (groupOf[f] !== f ? [F[groupOf[f]].id] : [])))],
      diagnostics: merged ? [`${merged} faces merged into flat neighbors.`] : [],
    }),
    merged,
  };
}
