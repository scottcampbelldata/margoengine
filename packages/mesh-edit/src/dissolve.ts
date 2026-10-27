import { MargoError, type MutableVec2 } from '@margoengine/math';
import { assertOptions, remappedEdgeResult } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, edgeId, faceGeometryError, polygonAreaVector } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import { compactVertices, createMeshEditResult, faceIdFactory } from './result.js';
import type { ComponentEditResult, MeshEditOptions, PolygonFace, PolygonMesh } from './types.js';

/** What {@link dissolveMeshComponents} removes: edges, vertices or the edges between faces. */
export type DissolveSelection =
  | { mode: 'edge'; edges: readonly string[] }
  | { mode: 'vertex'; vertices: readonly number[] }
  | { mode: 'face'; faces: readonly string[] };

/**
 * Dissolve components, keeping the surface closed: unlike deletion, no hole is left.
 * - `edge`: the two faces of each selected edge merge into one polygon (all edges inside a merged region go).
 * - `face`: connected selected faces merge into one polygon each.
 * - `vertex`: the faces around each selected flat vertex merge and the vertex goes; a selected vertex with only
 *   two edges (a corner on a straight run, or any two-edge corner) is removed from its faces.
 *
 * Faces merge only where they are coplanar, because every face stays planar; the shape never changes. An edge on a
 * fold (or a vertex that is not flat) is kept and counted in `diagnostics`. Merged polygons keep each corner's UV
 * from the face it came from, and the ID of the first merged face in mesh order. A concave merged polygon is split
 * into the fewest convex pieces the greedy merge finds (extra pieces get new IDs). Vertices left unused are removed
 * and the rest renumbered. Dissolving across a UV seam is allowed and noted in `diagnostics`.
 * @throws TypeError for unknown IDs, boundary or nonmanifold edges, or a vertex on an open boundary with more than
 * two edges; MargoError `unsupported` when a region would enclose a hole or touch itself at a vertex; MargoError
 * `failed` when a merged polygon folds over itself.
 */
export function dissolveMeshComponents(
  mesh: PolygonMesh,
  selection: DissolveSelection,
  options: MeshEditOptions = {},
): ComponentEditResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Dissolve');
  if (!selection || typeof selection !== 'object')
    throw new TypeError('Dissolve selection needs an edge, vertex or face mode; supply a valid selection.');
  const createId = faceIdFactory(mesh, options),
    edges = new Map(collectPolygonEdges(mesh).map((edge) => [edge.id, edge])),
    faceIndex = new Map(mesh.faces.map((face, i) => [face.id, i])),
    parent = mesh.faces.map((_, i) => i),
    inGroup = new Uint8Array(mesh.faces.length),
    diagnostics: string[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  // Faces merge only when coplanar (faces stay planar); an edge on a fold is kept and counted.
  let folds = 0;
  const union = (a: number, b: number): boolean => {
    if (!coplanar(mesh, a, b)) {
      folds++;
      return false;
    }
    inGroup[a] = inGroup[b] = 1;
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    return true;
  };
  const twoFaced = (id: string) => {
    const edge = edges.get(id)!;
    if (edge.incidences.length !== 2) return false;
    const [a, b] = edge.incidences;
    if (a.from !== b.to || a.to !== b.from)
      throw new TypeError('Dissolve needs consistent face winding; orient neighboring faces consistently.');
    return a.faceId !== b.faceId;
  };
  const removeVertices = new Set<number>();
  if (selection.mode === 'edge') {
    if (!Array.isArray(selection.edges))
      throw new TypeError('Dissolve edge selection needs an array of edge IDs; supply "low:high" edge IDs.');
    for (const id of selection.edges) {
      const edge = typeof id === 'string' ? edges.get(id) : undefined;
      if (!edge) throw new TypeError(`Dissolve edge ${String(id)} does not exist; select existing edge IDs.`);
      if (!twoFaced(id))
        throw new TypeError(`Dissolve edge ${id} is not between two faces; select interior manifold edges.`);
      union(faceIndex.get(edge.incidences[0].faceId)!, faceIndex.get(edge.incidences[1].faceId)!);
    }
  } else if (selection.mode === 'face') {
    if (!Array.isArray(selection.faces))
      throw new TypeError('Dissolve face selection needs an array of face IDs; supply existing face IDs.');
    const chosen = new Set<string>();
    for (const id of selection.faces) {
      if (typeof id !== 'string' || !faceIndex.has(id))
        throw new TypeError(`Dissolve face ${String(id)} does not exist; select existing face IDs.`);
      chosen.add(id);
    }
    for (const edge of edges.values())
      if (
        edge.incidences.length === 2 &&
        chosen.has(edge.incidences[0].faceId) &&
        chosen.has(edge.incidences[1].faceId) &&
        twoFaced(edge.id)
      )
        union(faceIndex.get(edge.incidences[0].faceId)!, faceIndex.get(edge.incidences[1].faceId)!);
  } else if (selection.mode === 'vertex') {
    if (!Array.isArray(selection.vertices))
      throw new TypeError('Dissolve vertex selection needs an array of indices; supply existing vertex indices.');
    const around = new Map<number, string[]>();
    for (const edge of edges.values())
      for (const v of edge.vertices) {
        const list = around.get(v);
        if (list) list.push(edge.id);
        else around.set(v, [edge.id]);
      }
    for (const v of selection.vertices) {
      if (!Number.isInteger(v) || v < 0 || v >= mesh.vertices.length)
        throw new RangeError('Dissolve vertex indices must exist in the mesh; select existing vertices.');
      const incident = around.get(v) ?? [];
      if (!incident.length) throw new TypeError(`Dissolve vertex ${v} is unused; select vertices that faces use.`);
      if (incident.length === 2) {
        removeVertices.add(v);
        continue;
      }
      for (const id of incident)
        if (!twoFaced(id))
          throw new TypeError(
            `Dissolve vertex ${v} is on an open or nonmanifold boundary with more than two edges; select interior vertices.`,
          );
      let flat = true;
      for (const id of incident) {
        const [a, b] = edges.get(id)!.incidences;
        if (!union(faceIndex.get(a.faceId)!, faceIndex.get(b.faceId)!)) flat = false;
      }
      if (!flat) diagnostics.push(`Vertex ${v} is not flat; it was kept and only its coplanar faces merged.`);
    }
  } else throw new TypeError('Dissolve selection mode is unsupported; choose edge, vertex or face.');

  if (folds)
    diagnostics.push(`${folds} selected edges join faces that are not coplanar and were kept; flatten them first.`);
  // Each group becomes one loop of its boundary half-edges; other faces keep their own loops.
  const groups = new Map<number, number[]>();
  mesh.faces.forEach((_, i) => {
    if (!inGroup[i]) return;
    const root = find(i),
      list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });
  type Loop = { id: string; sources: string[]; vertices: number[]; uv: MutableVec2[]; dirty: boolean };
  const loops: Loop[] = [];
  const groupLoop = new Map<number, Loop>();
  for (const [root, members] of groups) {
    const half = new Map<string, { from: number; to: number; uv: MutableVec2 }>();
    for (const f of members) {
      const face = mesh.faces[f];
      face.vertices.forEach((from, corner) => {
        const to = face.vertices[(corner + 1) % face.vertices.length];
        half.set(`${from}>${to}`, { from, to, uv: [...face.uv[corner]] as MutableVec2 });
      });
    }
    const outgoing = new Map<number, { from: number; to: number; uv: MutableVec2 }>();
    for (const item of half.values()) {
      if (half.has(`${item.to}>${item.from}`)) continue;
      if (outgoing.has(item.from))
        throw new MargoError(
          'unsupported',
          `Dissolve region touches itself at vertex ${item.from}; dissolve fewer components so each region stays a disk.`,
        );
      outgoing.set(item.from, item);
    }
    if (!outgoing.size)
      throw new MargoError(
        'unsupported',
        'Dissolve region covers a whole closed surface; leave at least one face out of the region.',
      );
    const start = Math.min(...outgoing.keys()),
      vertices: number[] = [],
      uv: MutableVec2[] = [];
    let at = start;
    do {
      const item = outgoing.get(at)!;
      vertices.push(item.from);
      uv.push(item.uv);
      at = item.to;
    } while (at !== start && vertices.length <= outgoing.size);
    if (vertices.length !== outgoing.size)
      throw new MargoError(
        'unsupported',
        'Dissolve region would enclose a hole; also dissolve the edges around the hole, or select a disk-shaped region.',
      );
    const sources = members.map((f) => mesh.faces[f].id),
      loop: Loop = { id: sources[0], sources, vertices, uv, dirty: true };
    groupLoop.set(root, loop);
  }
  const seen = new Set<number>();
  mesh.faces.forEach((face, i) => {
    if (!inGroup[i]) {
      loops.push({
        id: face.id,
        sources: [face.id],
        vertices: [...face.vertices],
        uv: face.uv.map((uv) => [...uv] as MutableVec2),
        dirty: false,
      });
      return;
    }
    const root = find(i);
    if (seen.has(root)) return;
    seen.add(root);
    loops.push(groupLoop.get(root)!);
  });
  // UV seams across dissolved edges: the two faces disagreed at an endpoint.
  let seams = 0;
  for (const edge of edges.values()) {
    if (edge.incidences.length !== 2) continue;
    const [a, b] = edge.incidences,
      fa = faceIndex.get(a.faceId)!,
      fb = faceIndex.get(b.faceId)!;
    if (!inGroup[fa] || find(fa) !== find(fb)) continue;
    const A = mesh.faces[fa],
      B = mesh.faces[fb],
      uvA0 = A.uv[a.corner],
      uvA1 = A.uv[(a.corner + 1) % A.vertices.length],
      uvB0 = B.uv[(b.corner + 1) % B.vertices.length],
      uvB1 = B.uv[b.corner];
    if (uvA0[0] !== uvB0[0] || uvA0[1] !== uvB0[1] || uvA1[0] !== uvB1[0] || uvA1[1] !== uvB1[1]) seams++;
  }
  if (seams) diagnostics.push(`${seams} dissolved edges were UV seams; reallocate UVs for the merged faces.`);

  // Remove selected vertices that are left with exactly two neighbors.
  if (removeVertices.size) {
    const neighbors = new Map<number, Set<number>>();
    for (const loop of loops)
      loop.vertices.forEach((v, i) => {
        if (!removeVertices.has(v)) return;
        const set = neighbors.get(v) ?? new Set<number>();
        set.add(loop.vertices[(i + 1) % loop.vertices.length]);
        set.add(loop.vertices[(i + loop.vertices.length - 1) % loop.vertices.length]);
        neighbors.set(v, set);
      });
    for (const [v, set] of neighbors)
      if (set.size !== 2)
        throw new TypeError(
          `Dissolve vertex ${v} still joins ${set.size} edges after merging; select vertices with two edges or interior vertices.`,
        );
    for (const loop of loops) {
      if (!loop.vertices.some((v) => removeVertices.has(v))) continue;
      const keep = loop.vertices.map((v) => !removeVertices.has(v));
      loop.uv = loop.uv.filter((_, i) => keep[i]);
      loop.vertices = loop.vertices.filter((_, i) => keep[i]);
      loop.dirty = true;
      if (loop.vertices.length < 3)
        throw new MargoError(
          'unsupported',
          `Dissolving vertices would collapse face ${loop.id}; dissolve its edges instead.`,
        );
    }
  }

  const faces: PolygonFace[] = [],
    faceMap: Record<string, string[]> = {},
    affectedFaces: string[] = [];
  for (const loop of loops) {
    let out: PolygonFace[];
    if (!loop.dirty) out = [{ id: loop.id, vertices: loop.vertices, uv: loop.uv }];
    else {
      const pieces =
        loop.vertices.length <= 64 && !faceGeometryError(mesh.vertices, loop.vertices)
          ? [{ id: loop.id, vertices: loop.vertices, uv: loop.uv }]
          : loopFaces(mesh.vertices, loop.vertices, loop.uv, loop.id, createId);
      if (!pieces)
        throw new MargoError(
          'failed',
          `Dissolved face ${loop.id} folds over itself; dissolve a smaller region or flatten it first.`,
        );
      out = pieces;
      for (const item of out) affectedFaces.push(item.id);
    }
    faces.push(...out);
    for (const source of loop.sources) faceMap[source] = out.map((item) => item.id);
  }
  const output: PolygonMesh = { vertices: mesh.vertices.map((p) => [...p] as typeof p), faces },
    usedBefore = new Uint8Array(mesh.vertices.length),
    usedAfter = new Uint8Array(mesh.vertices.length);
  for (const face of mesh.faces) for (const v of face.vertices) usedBefore[v] = 1;
  for (const face of faces) for (const v of face.vertices) usedAfter[v] = 1;
  const discard = new Set<number>();
  for (let v = 0; v < mesh.vertices.length; v++) if (usedBefore[v] && !usedAfter[v]) discard.add(v);
  const remap = compactVertices(output, discard);
  assertPolygonMesh(output);
  const result = createMeshEditResult(mesh, output, {
    vertexMap: mesh.vertices.map((_, v) => (remap.has(v) ? [remap.get(v)!] : [])),
    faceMap,
    createdVertices: [],
    removedVertices: [...discard].sort((a, b) => a - b),
    affectedFaces,
    diagnostics,
  });
  // A dissolved vertex's two edges join into one: name it as both edges' descendant.
  const overrides = new Map<string, string[]>();
  for (const v of removeVertices) {
    const ids = [...edges.values()].filter((edge) => edge.vertices.includes(v));
    if (ids.length !== 2) continue;
    const ends = ids.map((edge) => (edge.vertices[0] === v ? edge.vertices[1] : edge.vertices[0])),
      a = remap.get(ends[0]),
      b = remap.get(ends[1]);
    if (a === undefined || b === undefined) continue;
    for (const edge of ids) overrides.set(edge.id, [edgeId(a, b)]);
  }
  return remappedEdgeResult(mesh, result, (v) => remap.get(v), overrides);
}

/** Whether faces a and b lie in one plane, facing the same way (relative tolerance of the faces' extent). */
function coplanar(mesh: PolygonMesh, a: number, b: number): boolean {
  const A = mesh.faces[a].vertices.map((v) => mesh.vertices[v]),
    B = mesh.faces[b].vertices.map((v) => mesh.vertices[v]),
    na = polygonAreaVector(A),
    nb = polygonAreaVector(B),
    la = Math.hypot(na[0], na[1], na[2]),
    lb = Math.hypot(nb[0], nb[1], nb[2]);
  if (!(la > 0 && lb > 0) || na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] <= 0) return false;
  let extent = 0,
    size = 0;
  for (const p of [...A, ...B])
    for (let axis = 0; axis < 3; axis++) {
      extent = Math.max(extent, Math.abs(p[axis] - A[0][axis]));
      size = Math.max(size, Math.abs(p[axis]));
    }
  const tolerance = Math.max(1e-9 * extent, size * Number.EPSILON * 8),
    o = A[0];
  for (const p of B)
    if (Math.abs(((p[0] - o[0]) * na[0] + (p[1] - o[1]) * na[1] + (p[2] - o[2]) * na[2]) / la) > tolerance)
      return false;
  return true;
}
