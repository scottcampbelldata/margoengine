import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { componentEdgeResult } from './components.js';
import { assertPolygonMesh, edgeId, polygonMeshEdges } from './polygon.js';
import { clonePolygonMesh, createMeshEditResult, faceIdFactory, identityFaceMap, identityVertexMap } from './result.js';
import type { PolygonMesh, MeshEditOptions, QuadRing, QuadRingCutResult, QuadRingSeed } from './types.js';

type DirectedEdge = QuadRing['edges'][number];

/**
 * Trace the ring of quads that starts at the seed edge and crosses each quad to its opposite edge. Every edge in the
 * result points the same way as the seed. An open ring ends only at boundary edges.
 * @throws TypeError when the ring meets a non-quad face, a non-manifold or inconsistently wound edge, crosses itself,
 * or closes reversed; RangeError for a seed corner outside 0 to 3.
 */
export function traceMeshQuadRing(mesh: PolygonMesh, seed: QuadRingSeed): QuadRing {
  const edges = polygonMeshEdges(mesh),
    topology = new Map(edges.map((edge) => [edge.id, edge])),
    faces = new Map(mesh.faces.map((face) => [face.id, face]));
  if (edges.some((edge) => edge.incidences.length > 2))
    throw new TypeError('Quad ring needs manifold edges; repair edges with more than two incident faces.');
  for (const edge of edges) {
    if (edge.incidences.length === 2) {
      const [a, b] = edge.incidences;
      if (a.from !== b.to || a.to !== b.from)
        throw new TypeError('Quad ring needs consistent face winding; orient neighboring faces consistently.');
    }
  }
  if (!seed || typeof seed !== 'object' || typeof seed.faceId !== 'string' || !faces.has(seed.faceId))
    throw new TypeError('Quad ring seed face does not exist; select an existing quad face.');
  const firstFace = faces.get(seed.faceId)!;
  if (firstFace.vertices.length !== 4) throw new TypeError('Quad ring seed must be a quad; select a four-corner face.');
  if (!Number.isInteger(seed.corner) || seed.corner < 0 || seed.corner >= 4)
    throw new RangeError('Quad ring seed corner must be an integer from zero to three; select an existing edge.');
  const from = firstFace.vertices[seed.corner],
    to = firstFace.vertices[(seed.corner + 1) % 4],
    first: DirectedEdge = { id: edgeId(from, to), from, to },
    seenFaces = new Set<string>(),
    seenEdges = new Set([first.id]);

  const walk = (startFace: string, entry: DirectedEdge, allowClosure: boolean) => {
    const pathFaces: string[] = [],
      pathEdges: DirectedEdge[] = [];
    let faceId = startFace,
      incoming = entry;
    for (;;) {
      if (seenFaces.has(faceId))
        throw new TypeError('Quad ring crosses a previously visited face; choose a simple unbranched quad ring.');
      const face = faces.get(faceId)!;
      if (face.vertices.length !== 4)
        throw new TypeError(
          'Quad ring continues into a nonquad face; choose a ring ending only at geometric boundaries.',
        );
      seenFaces.add(faceId);
      pathFaces.push(faceId);
      const corner = face.vertices.findIndex((a, c) => edgeId(a, face.vertices[(c + 1) % 4]) === incoming.id);
      if (corner < 0) throw new TypeError('Quad ring incidence is inconsistent; repair the mesh topology.');
      const sameDirection = face.vertices[corner] === incoming.from,
        a = face.vertices[(corner + 3) % 4],
        b = face.vertices[(corner + 2) % 4],
        exit: DirectedEdge = { id: edgeId(a, b), from: sameDirection ? a : b, to: sameDirection ? b : a },
        incidence = topology.get(exit.id)!.incidences,
        neighbor = incidence.find((item) => item.faceId !== faceId);
      if (exit.id === first.id) {
        if (!allowClosure || neighbor?.faceId !== seed.faceId || exit.from !== first.from || exit.to !== first.to)
          throw new TypeError(
            'Quad ring closes with a crossing or reversed direction; choose an orientable simple ring.',
          );
        return { closed: true, faces: pathFaces, edges: pathEdges };
      }
      if (seenEdges.has(exit.id))
        throw new TypeError('Quad ring crosses a previously visited edge; choose a simple unbranched quad ring.');
      seenEdges.add(exit.id);
      pathEdges.push(exit);
      if (!neighbor) return { closed: false, faces: pathFaces, edges: pathEdges };
      faceId = neighbor.faceId;
      incoming = exit;
    }
  };
  const forward = walk(seed.faceId, first, true);
  if (forward.closed) return { closed: true, faces: forward.faces, edges: [first, ...forward.edges] };
  const other = topology.get(first.id)!.incidences.find((item) => item.faceId !== seed.faceId);
  if (!other) return { closed: false, faces: forward.faces, edges: [first, ...forward.edges] };
  const backward = walk(other.faceId, first, false);
  return {
    closed: false,
    faces: [...backward.faces.reverse(), ...forward.faces],
    edges: [...backward.edges.reverse(), first, ...forward.edges],
  };
}

/**
 * Cut a quad ring with a new edge loop, `fraction` (strictly between 0 and 1) of the way along each crossed edge.
 * Each crossed edge gets one shared new vertex; each face interpolates its own corner UVs. One half of every cut quad
 * keeps its face ID. `ring` lists the new loop's vertices and edges in order.
 * @throws RangeError for a fraction outside (0, 1); TypeError for options or a ring {@link traceMeshQuadRing} rejects.
 */
export function cutMeshQuadRing(
  mesh: PolygonMesh,
  seed: QuadRingSeed,
  fraction: number,
  options: MeshEditOptions = {},
): QuadRingCutResult {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)
    throw new RangeError(
      'Quad ring fraction must be finite and strictly between zero and one; choose an interior cut.',
    );
  if (!options || typeof options !== 'object')
    throw new TypeError('Quad ring options need an object; supply createId or omit the options.');
  const trace = traceMeshQuadRing(mesh, seed),
    createId = faceIdFactory(mesh, options),
    next = clonePolygonMesh(mesh),
    splits = new Map<string, { edge: DirectedEdge; vertex: number }>(),
    descendants = new Map<string, string[]>(),
    createdVertices: number[] = [];
  for (const edge of trace.edges) {
    const a = mesh.vertices[edge.from],
      b = mesh.vertices[edge.to],
      index = next.vertices.length;
    next.vertices.push(a.map((value, axis) => value * (1 - fraction) + b[axis] * fraction) as MutableVec3);
    createdVertices.push(index);
    splits.set(edge.id, { edge, vertex: index });
    const low = Math.min(edge.from, edge.to),
      high = Math.max(edge.from, edge.to);
    descendants.set(edge.id, [edgeId(low, index), edgeId(index, high)]);
  }
  const affected = new Set(trace.faces),
    affectedFaces: string[] = [],
    faceMap = identityFaceMap(mesh);
  next.faces = next.faces.flatMap((face) => {
    if (!affected.has(face.id)) return [face];
    const corners = face.vertices.flatMap((a, corner) =>
      splits.has(edgeId(a, face.vertices[(corner + 1) % 4])) ? [corner] : [],
    );
    if (corners.length !== 2 || (corners[0] + 2) % 4 !== corners[1])
      throw new TypeError('Quad ring crosses a face more than once; choose a simple quad ring.');
    const c = corners[0],
      vertex = (offset: number) => face.vertices[(c + offset) % 4],
      uv = (offset: number) => face.uv[(c + offset) % 4];
    const splitAt = (offset: number) => {
      const a = vertex(offset),
        b = vertex(offset + 1),
        split = splits.get(edgeId(a, b))!,
        t = split.edge.from === a ? fraction : 1 - fraction,
        fromUV = uv(offset),
        toUV = uv(offset + 1);
      return { vertex: split.vertex, uv: fromUV.map((value, axis) => value * (1 - t) + toUV[axis] * t) as MutableVec2 };
    };
    const a = splitAt(0),
      b = splitAt(2),
      id = createId();
    faceMap[face.id].push(id);
    affectedFaces.push(face.id, id);
    return [
      { id: face.id, vertices: [vertex(0), a.vertex, b.vertex, vertex(3)], uv: [uv(0), a.uv, b.uv, uv(3)] },
      { id, vertices: [a.vertex, vertex(1), vertex(2), b.vertex], uv: [[...a.uv], uv(1), uv(2), [...b.uv]] },
    ];
  });
  assertPolygonMesh(next);
  const ringEdges = createdVertices
    .slice(0, trace.faces.length)
    .map((vertex, index) => edgeId(vertex, createdVertices[(index + 1) % createdVertices.length]));
  return {
    ...componentEdgeResult(
      mesh,
      createMeshEditResult(mesh, next, {
        vertexMap: identityVertexMap(mesh),
        faceMap,
        createdVertices,
        removedVertices: [],
        affectedFaces,
      }),
      descendants,
    ),
    ring: { closed: trace.closed, vertices: [...createdVertices], edges: ringEdges },
  };
}
