import type { MutableVec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math';
import { componentEdgeResult, componentEdgesFromIds } from './components.js';
import { assertPolygonMesh, collectPolygonEdges, edgeId } from './polygon.js';
import {
  clonePolygonMesh,
  compactVertices,
  createMeshEditResult,
  faceIdFactory,
  identityFaceMap,
  identityVertexMap,
  newlyUnusedVertices,
} from './result.js';
import type { PolygonEdge, PolygonMesh, MeshEditOptions } from './types.js';
import type { RegionExtrudeResult } from './region.js';
/** One edge-connected selected region: its faces in mesh order, every edge it touches, its boundary and vertices. */
export interface CapRegion {
  faces: string[];
  edges: PolygonEdge[];
  boundary: PolygonEdge[];
  vertices: number[];
}

/**
 * Source-only topology for region commands, computed once per selection.
 * @throws MargoError `unsupported` for a touched nonmanifold or inconsistently wound edge, or a region without boundary.
 */
export function prepareRegionCaps(
  mesh: PolygonMesh,
  faceIds: readonly string[],
): { sourceEdges: PolygonEdge[]; regions: CapRegion[] } {
  const selected = new Set(faceIds),
    caps = mesh.faces.filter((face) => selected.has(face.id)).map((face) => face.id);
  const sourceEdges = collectPolygonEdges(mesh),
    adjacent = new Map(caps.map((id) => [id, [] as string[]]));
  for (const edge of sourceEdges) {
    const chosen = edge.incidences.filter((item) => selected.has(item.faceId));
    if (!chosen.length) continue;
    const [a, b] = edge.incidences;
    if (edge.incidences.length > 2 || (b && (a.from !== b.to || a.to !== b.from)))
      throw new MargoError(
        'unsupported',
        'Region touches a nonmanifold or inconsistently wound edge; repair that edge before editing the region.',
      );
    if (chosen.length === 2) {
      adjacent.get(chosen[0].faceId)!.push(chosen[1].faceId);
      adjacent.get(chosen[1].faceId)!.push(chosen[0].faceId);
    }
  }
  const capOrder = new Map(caps.map((id, index) => [id, index])),
    groups: string[][] = [],
    visited = new Set<string>();
  for (const id of caps) {
    if (visited.has(id)) continue;
    const queue = [id];
    visited.add(id);
    for (let i = 0; i < queue.length; i++)
      for (const neighbor of adjacent.get(queue[i])!)
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
    groups.push(queue.sort((a, b) => capOrder.get(a)! - capOrder.get(b)!));
  }
  const groupOf = new Map(groups.flatMap((faces, index) => faces.map((id) => [id, index] as const))),
    groupEdges = groups.map(() => [] as PolygonEdge[]);
  for (const edge of sourceEdges) {
    const incidence = edge.incidences.find((item) => selected.has(item.faceId));
    if (incidence) groupEdges[groupOf.get(incidence.faceId)!].push(edge);
  }
  const byFace = new Map(mesh.faces.map((face) => [face.id, face]));
  const regions = groups.map((faces, index): CapRegion => {
    const edges = groupEdges[index],
      boundary = edges.filter((edge) => edge.incidences.filter((item) => selected.has(item.faceId)).length === 1);
    if (!boundary.length)
      throw new MargoError(
        'unsupported',
        'Selected region has no boundary; select a patch or use Move for a complete closed surface.',
      );
    const vertices = [...new Set(faces.flatMap((id) => byFace.get(id)!.vertices))].sort((a, b) => a - b);
    return { faces, edges, boundary, vertices };
  });
  return { sourceEdges, regions };
}

/** Replace each selected region with a cap placed by `place`, wall its boundary, and record provenance. */
export function replaceRegionCaps(
  mesh: PolygonMesh,
  faceIds: readonly string[],
  options: MeshEditOptions,
  unchanged: boolean,
  place: (region: CapRegion, index: number) => { positions: MutableVec3[]; offset: MutableVec3 },
  preparation?: ReturnType<typeof prepareRegionCaps>,
): RegionExtrudeResult {
  const createId = faceIdFactory(mesh, options),
    selected = new Set(faceIds),
    caps = mesh.faces.filter((face) => selected.has(face.id)).map((face) => face.id),
    next = clonePolygonMesh(mesh),
    faceMap = identityFaceMap(mesh),
    vertexMap = identityVertexMap(mesh);
  if (!caps.length || unchanged)
    return {
      ...componentEdgeResult(
        mesh,
        createMeshEditResult(mesh, next, { vertexMap, faceMap, createdVertices: [], removedVertices: [] }),
      ),
      changed: false,
      capFaces: caps,
      sideFaces: [],
      regions: [],
    };
  const { sourceEdges, regions: prepared } = preparation ?? prepareRegionCaps(mesh, faceIds),
    byFace = new Map(next.faces.map((face) => [face.id, face])),
    sideFaces: RegionExtrudeResult['sideFaces'] = [],
    regions: RegionExtrudeResult['regions'] = [],
    created: number[] = [],
    descendants = new Map(sourceEdges.map((edge) => [edge.id, [edge.vertices] as (readonly [number, number])[]]));
  for (let regionIndex = 0; regionIndex < prepared.length; regionIndex++) {
    const region = prepared[regionIndex],
      { faces, boundary, vertices } = region,
      member = new Set(faces),
      placement = place(region, regionIndex),
      offset = placement.offset,
      cap = new Map<number, number>();
    for (let i = 0; i < vertices.length; i++) {
      const vertex = vertices[i],
        index = next.vertices.length;
      next.vertices.push(placement.positions[i]);
      cap.set(vertex, index);
      created.push(index);
      vertexMap[vertex].push(index);
    }
    for (const edge of region.edges)
      descendants.get(edge.id)!.push([cap.get(edge.vertices[0])!, cap.get(edge.vertices[1])!]);
    for (const edge of boundary) {
      const incidence = edge.incidences.find((item) => member.has(item.faceId))!,
        source = byFace.get(incidence.faceId)!,
        a = incidence.from,
        b = incidence.to,
        id = createId(),
        uvA = source.uv[incidence.corner],
        uvB = source.uv[(incidence.corner + 1) % source.uv.length];
      next.faces.push({ id, vertices: [a, b, cap.get(b)!, cap.get(a)!], uv: [[...uvA], [...uvB], [...uvB], [...uvA]] });
      faceMap[source.id].push(id);
      sideFaces.push({ faceId: id, sourceFaceId: source.id, sourceEdgeId: edge.id });
    }
    for (const id of faces) byFace.get(id)!.vertices = byFace.get(id)!.vertices.map((vertex) => cap.get(vertex)!);
    regions.push({ faces: [...faces], boundaryEdges: boundary.map((edge) => edge.id), offset: [...offset] });
  }
  const removed = newlyUnusedVertices(mesh, next.faces),
    remap = compactVertices(next, new Set(removed));
  assertPolygonMesh(next);
  const finalEdges = new Set(collectPolygonEdges(next).map((edge) => edge.id)),
    mappings = new Map<string, string[]>(),
    retainedOutput = new Set<string>(),
    retainedSource = new Set<string>();
  for (const edge of sourceEdges) {
    const pairs = descendants.get(edge.id)!,
      ids: string[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const a = remap.get(pairs[i][0]),
        b = remap.get(pairs[i][1]);
      if (a === undefined || b === undefined) continue;
      const id = edgeId(a, b);
      if (!finalEdges.has(id)) continue;
      if (!ids.includes(id)) ids.push(id);
      if (i === 0) {
        retainedOutput.add(id);
        retainedSource.add(edge.id);
      }
    }
    mappings.set(edge.id, ids);
  }
  const result = componentEdgesFromIds(
    sourceEdges.map((edge) => edge.id),
    [...finalEdges],
    createMeshEditResult(mesh, next, {
      vertexMap: vertexMap.map((list) => list.flatMap((index) => (remap.has(index) ? [remap.get(index)!] : []))),
      faceMap,
      createdVertices: created.map((index) => remap.get(index)!),
      removedVertices: removed,
      affectedFaces: [...caps, ...sideFaces.map((face) => face.faceId)],
    }),
    mappings,
  );
  return {
    ...result,
    createdEdges: [...finalEdges].filter((id) => !retainedOutput.has(id)),
    removedEdges: sourceEdges.filter((edge) => !retainedSource.has(edge.id)).map((edge) => edge.id),
    changed: true,
    capFaces: caps,
    sideFaces,
    regions,
  };
}
