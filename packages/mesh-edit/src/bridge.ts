import { MargoError, type MutableVec3 } from '@margoengine/math';
import { componentEdgeResult } from './components.js';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import { meshTileUV } from './primitives.js';
import { clonePolygonMesh, createMeshEditResult, faceIdFactory, identityFaceMap, identityVertexMap } from './result.js';
import type { ComponentEditResult, MeshEditOptions, PolygonMesh } from './types.js';

/** Options for {@link bridgeMeshEdgeLoops}. */
export interface BridgeOptions extends MeshEditOptions {
  /** Rows of faces between the loops, 1 to 64 (default 1); rows above one add evenly spaced vertex rings. */
  segments?: number;
}

/** A selected boundary loop or chain, in its boundary direction. */
function boundaryPath(mesh: PolygonMesh, ids: unknown, label: string): { vertices: number[]; closed: boolean } {
  if (!Array.isArray(ids) || !ids.length)
    throw new TypeError(`${label} needs a nonempty array of boundary edge IDs; select an open edge loop.`);
  const edges = new Map(collectPolygonEdges(mesh).map((edge) => [edge.id, edge])),
    next = new Map<number, number>(),
    incoming = new Set<number>();
  for (const id of new Set(ids)) {
    const edge = typeof id === 'string' ? edges.get(id) : undefined;
    if (!edge) throw new TypeError(`${label} edge ${String(id)} does not exist; select existing edge IDs.`);
    if (edge.incidences.length !== 1)
      throw new TypeError(`${label} edge ${id} is not on an open boundary; select boundary edges only.`);
    const { from, to } = edge.incidences[0];
    // The bridge runs against the boundary face's direction, so walk the boundary the face's way.
    if (next.has(from) || incoming.has(to))
      throw new TypeError(`${label} branches at a vertex; select one simple boundary loop or chain.`);
    next.set(from, to);
    incoming.add(to);
  }
  const heads = [...next.keys()].filter((v) => !incoming.has(v));
  if (heads.length > 1) throw new TypeError(`${label} is not one connected chain; select one loop or chain.`);
  const closed = heads.length === 0,
    start = closed ? Math.min(...next.keys()) : heads[0],
    vertices = [start];
  let at = start;
  while (next.has(at)) {
    at = next.get(at)!;
    if (at === start) break;
    vertices.push(at);
  }
  if ((closed ? vertices.length : vertices.length - 1) !== next.size)
    throw new TypeError(`${label} is not one connected chain; select one loop or chain.`);
  return { vertices, closed };
}

/**
 * Join two open boundary loops (or two open boundary chains) with a band of new faces, as when connecting two
 * tubes or closing the gap between two sheets. Both selections must have the same number of edges. Closed loops are
 * paired at the rotation with the smallest summed squared distance; chains are paired end to end. The band follows
 * the loops' winding, so the result stays consistently oriented, and a mesh whose only holes were the two loops
 * comes out closed. Band faces get the default tile UVs (allocate islands with `allocateMeshFaceUV` before
 * painting); nonplanar band quads are split into triangles.
 * @throws TypeError for non-boundary, branching, unequal, overlapping or mixed loop/chain selections; RangeError
 * for segments outside 1 to 64; MargoError `failed` when a band face would have no area.
 */
export function bridgeMeshEdgeLoops(
  mesh: PolygonMesh,
  first: readonly string[],
  second: readonly string[],
  options: BridgeOptions = {},
): ComponentEditResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Bridge');
  const segments = options.segments ?? 1;
  if (!Number.isInteger(segments) || segments < 1 || segments > 64)
    throw new RangeError('Bridge segments must be an integer from 1 to 64; choose fewer segments.');
  const a = boundaryPath(mesh, first, 'Bridge first loop'),
    b = boundaryPath(mesh, second, 'Bridge second loop');
  if (a.closed !== b.closed)
    throw new TypeError('Bridge needs two closed loops or two open chains; select matching boundaries.');
  const edgeCount = (path: typeof a) => (path.closed ? path.vertices.length : path.vertices.length - 1);
  if (edgeCount(a) !== edgeCount(b))
    throw new TypeError('Bridge loops need the same number of edges; cut or dissolve edges so the counts match.');
  if (a.vertices.some((v) => b.vertices.includes(v)))
    throw new TypeError('Bridge loops share a vertex; select two separate boundaries.');
  const n = a.vertices.length,
    P = mesh.vertices;
  // partner[i]: the vertex of b paired with a[i]; b runs the opposite way, so pairs walk b backwards.
  let partner: number[];
  if (a.closed) {
    let best = 0,
      bestCost = Infinity;
    for (let k = 0; k < n; k++) {
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const p = P[a.vertices[i]],
          q = P[b.vertices[(((k - i) % n) + n) % n]];
        cost += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    partner = a.vertices.map((_, i) => b.vertices[(((best - i) % n) + n) % n]);
  } else partner = a.vertices.map((_, i) => b.vertices[n - 1 - i]);
  const next = clonePolygonMesh(mesh),
    createId = faceIdFactory(mesh, options),
    createdVertices: number[] = [],
    rings: number[][] = [a.vertices];
  for (let s = 1; s < segments; s++) {
    const t = s / segments;
    rings.push(
      a.vertices.map((v, i) => {
        const p = P[v],
          q = P[partner[i]],
          index = next.vertices.length;
        next.vertices.push([
          p[0] + (q[0] - p[0]) * t,
          p[1] + (q[1] - p[1]) * t,
          p[2] + (q[2] - p[2]) * t,
        ] as MutableVec3);
        createdVertices.push(index);
        return index;
      }),
    );
  }
  rings.push(partner);
  const quads = a.closed ? n : n - 1,
    uv = meshTileUV(0, 4),
    affectedFaces: string[] = [];
  for (let s = 0; s < segments; s++)
    for (let i = 0; i < quads; i++) {
      const j = (i + 1) % n,
        loop = [rings[s][j], rings[s][i], rings[s + 1][i], rings[s + 1][j]],
        id = createId(),
        pieces = loopFaces(next.vertices, loop, uv, id, createId);
      if (!pieces)
        throw new MargoError(
          'failed',
          'Bridge face would have no area; move the loops apart or pair them differently.',
        );
      next.faces.push(...pieces);
      for (const piece of pieces) affectedFaces.push(piece.id);
    }
  assertPolygonMesh(next);
  return componentEdgeResult(
    mesh,
    createMeshEditResult(mesh, next, {
      vertexMap: identityVertexMap(mesh),
      faceMap: identityFaceMap(mesh),
      createdVertices,
      removedVertices: [],
      affectedFaces,
    }),
  );
}
