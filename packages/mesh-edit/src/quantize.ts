import type { Mat4, MutableVec3, Vec3 } from '@margoengine/math';
import { dot } from '@margoengine/math/vec3';
import { affineMatrix, invertAffine, transformPoints } from './matrix.js';
import { assertPolygonMesh, faceGeometryError, polygonAreaVector, signedVolume } from './polygon.js';
import { clonePolygonMesh, createMeshEditResult, identityFaceMap, identityVertexMap } from './result.js';
import type { PolygonMesh, MeshEditResult } from './types.js';

/** Exact position key; -0 and 0 coincide. */
export const positionKey = (point: Vec3): string =>
  `${point[0] === 0 ? 0 : point[0]},${point[1] === 0 ? 0 : point[1]},${point[2] === 0 ? 0 : point[2]}`;

/** Whether every edge, matched by exact end positions, is shared by exactly two faces. */
function closed(mesh: PolygonMesh): boolean {
  const edges = new Map<string, number>();
  for (const face of mesh.faces)
    face.vertices.forEach((vertex, corner) => {
      const key = [
        positionKey(mesh.vertices[vertex]),
        positionKey(mesh.vertices[face.vertices[(corner + 1) % face.vertices.length]]),
      ]
        .sort()
        .join('|');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    });
  return edges.size > 0 && [...edges.values()].every((count) => count === 2);
}

/**
 * Snap every vertex to a world-space grid of `step` units (1/1024 to 1).
 * Local geometry, UVs and face IDs are kept. The edit is all or nothing: it throws if any face would collapse,
 * flip or warp, or if a closed mesh would lose its volume. Locking and transform policy belong to the caller.
 * @throws RangeError for an unsupported step, a singular or projective matrix, or a step that breaks the mesh.
 */
export function quantizePolygonMesh(mesh: PolygonMesh, worldMatrix: Mat4, step: number): MeshEditResult {
  assertPolygonMesh(mesh);
  if (!Number.isFinite(step) || step < 1 / 1024 || step > 1)
    throw new RangeError('Grid step must be finite and between 1/1024 and 1 world unit; choose a supported grid.');
  const matrix = affineMatrix(worldMatrix, 'World matrix'),
    inverse = invertAffine(matrix, 'World matrix'),
    before = transformPoints(matrix, mesh.vertices, 'World matrix');
  const snapped = before.map((point) => point.map((value) => Math.round(value / step) * step) as MutableVec3);
  for (const point of snapped)
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(point[2]))
      throw new RangeError('Grid snapping produces nonfinite vertices; reduce the coordinate magnitude.');
  const tolerance = step * 1e-7,
    oldArea: MutableVec3 = [0, 0, 0],
    newArea: MutableVec3 = [0, 0, 0];
  for (const { vertices } of mesh.faces) {
    for (let corner = 0; corner < vertices.length; corner++)
      for (let other = corner + 1; other < vertices.length; other++) {
        const p = snapped[vertices[corner]],
          q = snapped[vertices[other]];
        if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tolerance)
          throw new RangeError('This grid step collapses a face edge; choose a finer grid.');
      }
    polygonAreaVector(before, vertices, oldArea);
    polygonAreaVector(snapped, vertices, newArea);
    if (Math.hypot(newArea[0], newArea[1], newArea[2]) < tolerance * tolerance || dot(oldArea, newArea) <= 0)
      throw new RangeError('This grid step collapses or flips a face; choose a finer grid.');
  }
  if (closed(mesh)) {
    const previous = signedVolume(mesh.faces, before),
      next = signedVolume(mesh.faces, snapped);
    if (Math.abs(previous) > 1e-15 && (Math.abs(next) < step ** 3 * 1e-9 || previous * next <= 0))
      throw new RangeError('This grid step collapses the mesh volume; choose a finer grid.');
  }
  for (const face of mesh.faces) {
    const error = faceGeometryError(snapped, face.vertices);
    if (error) throw new RangeError(`This grid step produces a face that ${error}; choose a finer grid.`);
  }
  const output = clonePolygonMesh(mesh);
  output.vertices = transformPoints(inverse, snapped, 'World matrix inverse');
  for (const face of output.faces) {
    const error = faceGeometryError(output.vertices, face.vertices);
    if (error) throw new RangeError(`This grid step produces local geometry that ${error}; choose a finer grid.`);
  }
  const moved = new Set(
    before.flatMap((point, index) => (point.some((value, axis) => value !== snapped[index][axis]) ? [index] : [])),
  );
  return createMeshEditResult(mesh, output, {
    vertexMap: identityVertexMap(mesh),
    faceMap: identityFaceMap(mesh),
    createdVertices: [],
    removedVertices: [],
    affectedFaces: mesh.faces.filter((face) => face.vertices.some((index) => moved.has(index))).map((face) => face.id),
  });
}
