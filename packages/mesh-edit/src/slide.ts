import { MargoError, type MutableVec2, type MutableVec3 } from '@margoengine/math';
import { componentEdgeResult } from './components.js';
import { assertOptions, manifoldEdges, selectedEdges } from './edit-support.js';
import { assertPolygonMesh, faceGeometryError } from './polygon.js';
import { clampUV, faceUVAt, loopFaces } from './polygon-split.js';
import { clonePolygonMesh, createMeshEditResult, faceIdFactory, identityFaceMap, identityVertexMap } from './result.js';
import type { ComponentEditResult, MeshEditOptions, PolygonFace, PolygonMesh } from './types.js';

/** Options for {@link slideMeshEdges}. */
export interface EdgeSlideOptions extends MeshEditOptions {
  /** Default true: move each touched corner's UV with its vertex so the texture stays put; false keeps UVs. */
  correctUV?: boolean;
}

/**
 * Slide selected edges (an edge loop or chain, such as the ring {@link cutMeshQuadRing} makes) across the surface:
 * every vertex on them moves along its rail edge, the one edge on the chosen side that is not part of the
 * selection. `factor` in (-1, 1): positive slides toward the faces on the left of the chain (the faces whose
 * winding runs the same way as the chain), negative toward the right; 0.5 moves halfway along each rail.
 * Rails exist where loop vertices have one non-selected edge per side, as in quad loops. With `correctUV`, a
 * corner's UV follows its vertex along the rail in faces that hold the rail, and is extended from the face's own
 * UV mapping elsewhere (clamped to the atlas, noted in `diagnostics`). Faces left nonplanar or concave are split
 * into convex pieces; the first keeps the face ID.
 * @throws RangeError for a factor outside (-1, 1); TypeError for unknown or branching edges, a vertex without a
 * single rail on the chosen side, or nonmanifold edges; MargoError `failed` when a face would fold.
 */
export function slideMeshEdges(
  mesh: PolygonMesh,
  edges: readonly string[],
  factor: number,
  options: EdgeSlideOptions = {},
): ComponentEditResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Edge slide');
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= -1 || factor >= 1)
    throw new RangeError('Edge slide factor must be finite and strictly between -1 and 1; choose a smaller slide.');
  if (options.correctUV !== undefined && typeof options.correctUV !== 'boolean')
    throw new TypeError('Edge slide correctUV must be boolean; choose true, false or omit it.');
  const topology = manifoldEdges(mesh, 'Edge slide'),
    chosen = selectedEdges(topology, edges, 'Edge slide'),
    faces = new Map(mesh.faces.map((face) => [face.id, face])),
    createId = faceIdFactory(mesh, options),
    correct = options.correctUV !== false;
  const atVertex = new Map<number, number>();
  for (const edge of chosen) for (const v of edge.vertices) atVertex.set(v, (atVertex.get(v) ?? 0) + 1);
  for (const [v, count] of atVertex)
    if (count > 2)
      throw new TypeError(`Edge slide selection branches at vertex ${v}; select a simple loop or chain of edges.`);
  // Orient each chain: walk from an end (or any vertex of a closed loop) so every edge has a direction.
  const byVertex = new Map<number, (typeof chosen)[number][]>();
  for (const edge of chosen)
    for (const v of edge.vertices) {
      const list = byVertex.get(v);
      if (list) list.push(edge);
      else byVertex.set(v, [edge]);
    }
  const oriented = new Map<string, { from: number; to: number }>(),
    starts = [...byVertex.keys()].sort((a, b) => atVertex.get(a)! - atVertex.get(b)! || a - b);
  for (const start of starts) {
    let at = start;
    for (;;) {
      const next = byVertex.get(at)!.find((edge) => !oriented.has(edge.id));
      if (!next) break;
      const to = next.vertices[0] === at ? next.vertices[1] : next.vertices[0];
      oriented.set(next.id, { from: at, to });
      at = to;
    }
  }
  // Rails: for each loop vertex, the other neighbor of v in each side face of its selected edges.
  const side = factor > 0 ? 'left' : 'right',
    amount = Math.abs(factor),
    rails = new Map<number, number>();
  if (amount === 0) {
    const copy = clonePolygonMesh(mesh);
    return componentEdgeResult(
      mesh,
      createMeshEditResult(mesh, copy, {
        vertexMap: identityVertexMap(mesh),
        faceMap: identityFaceMap(mesh),
        createdVertices: [],
        removedVertices: [],
      }),
    );
  }
  for (const edge of chosen) {
    const { from, to } = oriented.get(edge.id)!,
      incidence = edge.incidences.find((item) => (side === 'left') === (item.from === from && item.to === to));
    if (!incidence)
      throw new TypeError(
        `Edge slide edge ${edge.id} has no face on the ${side}; slide the other way or select interior edges.`,
      );
    const face = faces.get(incidence.faceId)!,
      n = face.vertices.length;
    for (const v of [from, to]) {
      const corner = face.vertices.indexOf(v),
        before = face.vertices[(corner + n - 1) % n],
        after = face.vertices[(corner + 1) % n],
        other = v === from ? to : from,
        rail = before === other ? after : before,
        known = rails.get(v);
      if (known !== undefined && known !== rail)
        throw new TypeError(
          `Edge slide vertex ${v} has more than one rail on the ${side}; slide loops whose vertices join four edges.`,
        );
      if (atVertex.has(rail) && byVertex.get(rail)!.some((item) => item.vertices.includes(v)))
        throw new TypeError(`Edge slide vertex ${v} has no free rail on the ${side}; select a loop across quads.`);
      rails.set(v, rail);
    }
  }
  const next = clonePolygonMesh(mesh),
    diagnostics: string[] = [],
    moved = new Map<number, MutableVec3>();
  for (const [v, rail] of rails) {
    const p = mesh.vertices[v],
      q = mesh.vertices[rail];
    moved.set(v, [p[0] + (q[0] - p[0]) * amount, p[1] + (q[1] - p[1]) * amount, p[2] + (q[2] - p[2]) * amount]);
  }
  for (const [v, point] of moved) next.vertices[v] = point;
  const faceMap = identityFaceMap(mesh),
    affectedFaces: string[] = [];
  let clamped = 0;
  next.faces = mesh.faces.flatMap((face): PolygonFace[] => {
    if (!face.vertices.some((v) => moved.has(v)))
      return [{ id: face.id, vertices: [...face.vertices], uv: face.uv.map((uv) => [...uv] as MutableVec2) }];
    affectedFaces.push(face.id);
    const points = face.vertices.map((v) => mesh.vertices[v]),
      uv = face.uv.map((item, corner): MutableVec2 => {
        const v = face.vertices[corner];
        if (!correct || !moved.has(v)) return [...item] as MutableVec2;
        const railCorner = face.vertices.indexOf(rails.get(v)!);
        if (railCorner >= 0) {
          const target = face.uv[railCorner];
          return [item[0] + (target[0] - item[0]) * amount, item[1] + (target[1] - item[1]) * amount];
        }
        const mapped = faceUVAt(points, face.uv, moved.get(v)!) ?? ([...item] as MutableVec2);
        if (clampUV(mapped)) clamped++;
        return mapped;
      });
    if (!faceGeometryError(next.vertices, face.vertices)) return [{ id: face.id, vertices: [...face.vertices], uv }];
    const pieces = loopFaces(next.vertices, face.vertices, uv, face.id, createId);
    if (!pieces) throw new MargoError('failed', `Edge slide folds face ${face.id}; use a smaller slide factor.`);
    for (const piece of pieces.slice(1)) {
      faceMap[face.id].push(piece.id);
      affectedFaces.push(piece.id);
    }
    return pieces;
  });
  if (clamped) diagnostics.push(`${clamped} slid corner UVs left the atlas and were clamped; reallocate those UVs.`);
  assertPolygonMesh(next);
  return componentEdgeResult(
    mesh,
    createMeshEditResult(mesh, next, {
      vertexMap: identityVertexMap(mesh),
      faceMap,
      createdVertices: [],
      removedVertices: [],
      affectedFaces,
      diagnostics,
    }),
  );
}
