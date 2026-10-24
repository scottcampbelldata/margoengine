import type { PaintGeometry } from './paint-types.js';
import type { MeshEditOptions, MeshEditResult, PolygonFace, PolygonMesh } from './types.js';

/** Explicit kernel provenance. No index-identity assumption is made during remapping. */
interface MeshEditProvenance {
  vertexMap: number[][];
  faceMap: Record<string, string[]>;
  createdVertices: number[];
  removedVertices: number[];
  affectedFaces?: string[];
  diagnostics?: string[];
}

/** Clone only geometry, excluding caller document metadata and avoiding shared arrays. Draft paint UVs copy as-is. */
export function clonePolygonMesh(mesh: PolygonMesh): PolygonMesh;
export function clonePolygonMesh(mesh: PaintGeometry): PaintGeometry;
export function clonePolygonMesh(mesh: PaintGeometry): PaintGeometry {
  return {
    vertices: mesh.vertices.map((point) => [...point]),
    faces: mesh.faces.map((face) => ({ id: face.id, vertices: [...face.vertices], uv: face.uv.map((uv) => [...uv]) })),
  };
}

/** Every input vertex maps to itself. */
export const identityVertexMap = (mesh: PolygonMesh): number[][] => mesh.vertices.map((_, index) => [index]);

/** Every input face maps to itself. */
export const identityFaceMap = (mesh: PolygonMesh): Record<string, string[]> =>
  Object.fromEntries(mesh.faces.map((face) => [face.id, [face.id]]));

/**
 * Face ID generator that rejects empty or reused IDs; `crypto.randomUUID` when `createId` is omitted.
 * @throws TypeError when `createId` is not a function, or later when it returns an empty or used ID.
 */
export function faceIdFactory(mesh: PolygonMesh, options: MeshEditOptions): () => string {
  if (options.createId !== undefined && typeof options.createId !== 'function')
    throw new TypeError('Face ID generator must be a function; supply createId or omit it.');
  const create = options.createId ?? (() => globalThis.crypto.randomUUID()),
    used = new Set(mesh.faces.map((face) => face.id));
  return () => {
    const id = create();
    if (typeof id !== 'string' || !id.length || used.has(id))
      throw new TypeError('Generated face ID must be nonempty and unique; fix the createId generator.');
    used.add(id);
    return id;
  };
}

/**
 * Build an edit result from its provenance, checking it against both meshes. Takes ownership of `output`, which
 * must share no array with `source` or between its own faces.
 */
export function createMeshEditResult(
  source: PolygonMesh,
  output: PolygonMesh,
  provenance: MeshEditProvenance,
): MeshEditResult {
  const mesh = output,
    oldFaces = new Set(source.faces.map((face) => face.id)),
    newFaces = new Set(mesh.faces.map((face) => face.id));
  if (provenance.vertexMap.length !== source.vertices.length)
    throw new TypeError('Vertex map must have one entry per input vertex; supply explicit old-to-new mappings.');
  for (const indices of provenance.vertexMap)
    if (
      !Array.isArray(indices) ||
      indices.some((index) => !Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
    )
      throw new TypeError('Vertex map references an invalid output vertex; repair the edit provenance.');
  for (const face of source.faces)
    if (!Object.hasOwn(provenance.faceMap, face.id) || provenance.faceMap[face.id].some((id) => !newFaces.has(id)))
      throw new TypeError(
        'Face map must reference existing output faces for every input face; repair the edit provenance.',
      );
  const check = (indices: number[], count: number) =>
    indices.every((index) => Number.isInteger(index) && index >= 0 && index < count);
  if (
    !check(provenance.createdVertices, mesh.vertices.length) ||
    !check(provenance.removedVertices, source.vertices.length)
  )
    throw new TypeError('Created or removed vertex identities are invalid; repair the edit provenance.');
  const affectedFaces = [...new Set(provenance.affectedFaces ?? [])];
  if (affectedFaces.some((id) => !newFaces.has(id)))
    throw new TypeError('Affected faces must reference output faces; repair the edit provenance.');
  return {
    mesh,
    vertexMap: provenance.vertexMap.map((indices) => [...indices]),
    faceMap: Object.fromEntries(source.faces.map((face) => [face.id, [...provenance.faceMap[face.id]]])),
    createdVertices: [...provenance.createdVertices],
    removedVertices: [...provenance.removedVertices],
    createdFaces: mesh.faces.filter((face) => !oldFaces.has(face.id)).map((face) => face.id),
    removedFaces: source.faces.filter((face) => !newFaces.has(face.id)).map((face) => face.id),
    affectedFaces,
    diagnostics: [...(provenance.diagnostics ?? [])],
  };
}

/** Input vertices that `before` faces used and `after` faces no longer use, ascending. */
export function newlyUnusedVertices(mesh: PolygonMesh, after: readonly PolygonFace[]): number[] {
  const used = new Uint8Array(mesh.vertices.length);
  for (const face of mesh.faces) for (const index of face.vertices) used[index] = 1;
  for (const face of after) for (const index of face.vertices) if (index < used.length) used[index] = 0;
  const removed: number[] = [];
  for (let index = 0; index < used.length; index++) if (used[index]) removed.push(index);
  return removed;
}

/** Drop `discard` vertices from `mesh` in place, renumbering face corners; returns old index to new index. */
export function compactVertices(mesh: PolygonMesh, discard: ReadonlySet<number>): Map<number, number> {
  const remap = new Map<number, number>();
  mesh.vertices = mesh.vertices.filter((_, index) => {
    if (discard.has(index)) return false;
    remap.set(index, remap.size);
    return true;
  });
  for (const face of mesh.faces) face.vertices = face.vertices.map((index) => remap.get(index)!);
  return remap;
}
