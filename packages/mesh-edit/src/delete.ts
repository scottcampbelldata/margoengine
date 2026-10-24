import { componentEdgeResult, meshSelectionVertices } from './components.js';
import { assertPolygonMesh, collectPolygonEdges, edgeId } from './polygon.js';
import { compactVertices, createMeshEditResult, newlyUnusedVertices } from './result.js';
import type { ComponentEditResult, ComponentSelection, PolygonMesh } from './types.js';

/** Component deletion policy. Explicitly selected vertices are always removed. */
export interface DeleteComponentsOptions {
  /** Default true: remove formerly used vertices made loose by this edit, preserving preexisting loose vertices. False keeps all unselected vertices. */
  pruneUnusedVertices?: boolean;
}

/** Owned deletion and exact provenance. Edge diagnostics describe output incidences, not global manifold validity. */
export interface DeleteComponentsResult extends ComponentEditResult {
  changed: boolean;
  /** Output edges with exactly one incident face. Open surfaces are retained, never filled. */
  boundaryEdges: string[];
  /** Output edges with more than two incident faces. */
  nonManifoldEdges: string[];
  /** Output two-face edges whose oriented incidences are not opposite. */
  windingConflicts: string[];
}

/**
 * Delete faces: those using a selected vertex, those on a selected edge, or the selected faces.
 * Faces are removed, never dissolved or rebuilt, so surviving corners, UVs and positions are exact. By default,
 * vertices left unused by this edit are dropped and the rest renumbered; vertices that were already loose stay
 * unless selected. An empty selection returns an unchanged copy, and an empty result mesh is valid.
 * Edge provenance follows the source endpoints, so `createdEdges` is always empty. Affected faces are the
 * survivors that shared an edge with a removed face. Open boundaries, edges with more than two faces and winding
 * conflicts are reported, not repaired.
 * @throws TypeError for object mode, bad options or unknown IDs; RangeError for a vertex index outside the mesh.
 */
export function deleteMeshComponents(
  mesh: PolygonMesh,
  selection: ComponentSelection,
  options: DeleteComponentsOptions = {},
): DeleteComponentsResult {
  const selectedVertices = new Set(meshSelectionVertices(mesh, selection));
  if (selection.mode === 'object')
    throw new TypeError('Component deletion needs vertex, edge or face mode; remove document objects in the host.');
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Deletion options need an object; supply pruneUnusedVertices or omit options.');
  if (options.pruneUnusedVertices !== undefined && typeof options.pruneUnusedVertices !== 'boolean')
    throw new TypeError('Prune unused vertices must be boolean; choose true, false or omit it.');
  const sourceEdges = collectPolygonEdges(mesh),
    removedFaces = new Set<string>(),
    selectedEdges = new Set(selection.mode === 'edge' ? selection.edges : []),
    selectedFaces = new Set(selection.mode === 'face' ? selection.faces : []);
  if (selection.mode === 'edge') {
    for (const edge of sourceEdges)
      if (selectedEdges.has(edge.id)) for (const incidence of edge.incidences) removedFaces.add(incidence.faceId);
  } else {
    for (const face of mesh.faces)
      if (
        selectedFaces.has(face.id) ||
        (selection.mode === 'vertex' && face.vertices.some((index) => selectedVertices.has(index)))
      )
        removedFaces.add(face.id);
  }
  const output: PolygonMesh = {
      vertices: mesh.vertices.map((point) => [...point]),
      faces: mesh.faces
        .filter((face) => !removedFaces.has(face.id))
        .map((face) => ({ id: face.id, vertices: [...face.vertices], uv: face.uv.map((uv) => [...uv]) })),
    },
    discard = new Set(options.pruneUnusedVertices === false ? [] : newlyUnusedVertices(mesh, output.faces));
  if (selection.mode === 'vertex') for (const index of selectedVertices) discard.add(index);
  const removedVertices = [...discard].sort((a, b) => a - b),
    remap = compactVertices(output, discard);
  assertPolygonMesh(output);
  const outputEdges = collectPolygonEdges(output),
    available = new Set(outputEdges.map((edge) => edge.id)),
    descendants = new Map<string, string[]>(),
    affected = new Set<string>();
  for (const edge of sourceEdges) {
    const a = remap.get(edge.vertices[0]),
      b = remap.get(edge.vertices[1]),
      id = a === undefined || b === undefined ? null : edgeId(a, b);
    descendants.set(edge.id, id !== null && available.has(id) ? [id] : []);
    if (edge.incidences.some((item) => removedFaces.has(item.faceId)))
      for (const item of edge.incidences) if (!removedFaces.has(item.faceId)) affected.add(item.faceId);
  }
  const boundaryEdges = outputEdges.filter((edge) => edge.incidences.length === 1).map((edge) => edge.id),
    nonManifoldEdges = outputEdges.filter((edge) => edge.incidences.length > 2).map((edge) => edge.id),
    windingConflicts = outputEdges
      .filter((edge) => {
        const [a, b] = edge.incidences;
        return edge.incidences.length === 2 && (a.from !== b.to || a.to !== b.from);
      })
      .map((edge) => edge.id);
  const result = componentEdgeResult(
    mesh,
    createMeshEditResult(mesh, output, {
      vertexMap: mesh.vertices.map((_, index) => (remap.has(index) ? [remap.get(index)!] : [])),
      faceMap: Object.fromEntries(mesh.faces.map((face) => [face.id, removedFaces.has(face.id) ? [] : [face.id]])),
      createdVertices: [],
      removedVertices,
      affectedFaces: mesh.faces.filter((face) => affected.has(face.id)).map((face) => face.id),
      diagnostics: [
        ...(boundaryEdges.length
          ? [`${boundaryEdges.length} boundary edges remain; open surfaces are preserved.`]
          : []),
        ...(nonManifoldEdges.length
          ? [
              `${nonManifoldEdges.length} edges have more than two face incidences; inspect before closed-volume operations.`,
            ]
          : []),
        ...(windingConflicts.length
          ? [`${windingConflicts.length} two-face edges have inconsistent winding; repair before region operations.`]
          : []),
      ],
    }),
    descendants,
  );
  return {
    ...result,
    changed: removedFaces.size > 0 || removedVertices.length > 0,
    createdEdges: [],
    removedEdges: sourceEdges.filter((edge) => !descendants.get(edge.id)!.length).map((edge) => edge.id),
    boundaryEdges,
    nonManifoldEdges,
    windingConflicts,
  };
}
