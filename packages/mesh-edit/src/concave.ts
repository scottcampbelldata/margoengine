import type { MutableVec2, Vec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, faceGeometryError } from './polygon.js';
import { convexLoopPieces, loopFaces, triangulateLoop } from './polygon-split.js';
import { createMeshEditResult, faceIdFactory } from './result.js';
import type { MeshEditOptions, MeshEditResult, PolygonFace, PolygonMesh } from './types.js';

const finitePoints = (points: unknown, label: string): readonly Vec3[] => {
  if (
    !Array.isArray(points) ||
    points.length < 3 ||
    points.some((p) => !Array.isArray(p) || p.length !== 3 || !p.every((x) => Number.isFinite(x)))
  )
    throw new TypeError(`${label} needs three or more finite [x, y, z] points; supply the polygon's corners in order.`);
  if (points.length > 4096) throw new RangeError(`${label} has more than 4096 corners; split the outline first.`);
  return points as Vec3[];
};

/**
 * Triangulate a simple polygon, convex or concave, by ear clipping in its own plane. Every corner is kept, collinear
 * ones included, and each triangle lists corner indices in the polygon's winding. A nonplanar outline is
 * triangulated in its best-fit (Newell) plane.
 * @throws TypeError for fewer than three finite points, or an outline that crosses itself or has no area;
 * RangeError above 4096 corners.
 */
export function triangulatePolygon(points: readonly Vec3[]): number[][] {
  const triangles = triangulateLoop(finitePoints(points, 'Triangulate'));
  if (!triangles) throw new TypeError('Triangulate outline crosses itself or has no area; supply a simple polygon.');
  return triangles;
}

/**
 * Split a simple polygon (concave allowed) into few convex planar pieces: ear clipping, then dropping each diagonal
 * whose two sides still form a valid convex face (Hertel and Mehlhorn, 1983: at most four times the optimum count).
 * Each piece has 3 to 64 corner indices in the polygon's winding. A convex planar input comes back as one piece.
 * @throws TypeError for fewer than three finite points, or an outline that crosses itself or has no area;
 * RangeError above 4096 corners.
 */
export function convexPolygonPieces(points: readonly Vec3[]): number[][] {
  const pieces = convexLoopPieces(finitePoints(points, 'Convex split'));
  if (!pieces) throw new TypeError('Convex split outline crosses itself or has no area; supply a simple polygon.');
  return pieces;
}

/**
 * Make a mesh with concave or nonplanar faces editable: each such face (3 to 64 corners, simple in its best-fit
 * plane) is split into convex planar pieces that keep its corners and UVs; the first piece keeps the face ID. Faces
 * that are already valid are kept as they are. Use it on imported n-gons before the other commands.
 * @throws TypeError for bad structure, or a face that crosses itself or has no area.
 */
export function splitMeshConcaveFaces(mesh: PolygonMesh, options: MeshEditOptions = {}): MeshEditResult {
  assertPolygonMesh(mesh, false);
  assertOptions(options, 'Concave split');
  const createId = faceIdFactory(mesh, options),
    faces: PolygonFace[] = [],
    faceMap: Record<string, string[]> = {},
    affectedFaces: string[] = [];
  let split = 0;
  for (const face of mesh.faces) {
    const uv = face.uv.map((item) => [...item] as MutableVec2);
    if (!faceGeometryError(mesh.vertices, face.vertices)) {
      faces.push({ id: face.id, vertices: [...face.vertices], uv });
      faceMap[face.id] = [face.id];
      continue;
    }
    const pieces = loopFaces(mesh.vertices, face.vertices, uv, face.id, createId);
    if (!pieces)
      throw new TypeError(`Face ${face.id} crosses itself or has no area; repair its outline before splitting.`);
    split++;
    faces.push(...pieces);
    faceMap[face.id] = pieces.map((piece) => piece.id);
    for (const piece of pieces) affectedFaces.push(piece.id);
  }
  const output: PolygonMesh = { vertices: mesh.vertices.map((p) => [...p] as typeof p), faces };
  assertPolygonMesh(output);
  return createMeshEditResult(mesh, output, {
    vertexMap: mesh.vertices.map((_, v) => [v]),
    faceMap,
    createdVertices: [],
    removedVertices: [],
    affectedFaces,
    diagnostics: split ? [`${split} concave or nonplanar faces were split into convex pieces.`] : [],
  });
}
