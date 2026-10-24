import type { Mat4, MutableVec2, MutableVec3 } from '@margoengine/math';
import { affineDeterminant, affineMatrix, IDENTITY, invertAffine, transformPoint } from './matrix.js';
import {
  assertPolygonMesh,
  collectPolygonEdges,
  dominantAxis,
  faceGeometryError,
  meshPolygonNormal,
  polygonGeometryError,
} from './polygon.js';
import { clonePolygonMesh, createMeshEditResult, faceIdFactory, identityFaceMap, identityVertexMap } from './result.js';
import type {
  ComponentEditResult,
  ComponentSelection,
  ComponentTransformOptions,
  PolygonFace,
  PolygonMesh,
  MeshEditResult,
} from './types.js';

/**
 * Vertex indices of a selection, deduplicated and ascending. Object mode selects every vertex.
 * @throws TypeError for an unknown mode or ID; RangeError for a vertex index outside the mesh.
 */
export function meshSelectionVertices(mesh: PolygonMesh, selection: ComponentSelection): number[] {
  assertPolygonMesh(mesh);
  if (!selection || typeof selection !== 'object')
    throw new TypeError('Component selection needs an object, vertex, edge or face mode; supply a valid selection.');
  const selected = new Set<number>();
  if (selection.mode === 'object') return mesh.vertices.map((_, index) => index);
  if (selection.mode === 'vertex') {
    if (!Array.isArray(selection.vertices))
      throw new TypeError('Vertex selection needs an indices array; supply existing vertex indices.');
    for (const index of selection.vertices) {
      if (!Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
        throw new RangeError('Vertex selection indices must exist in the mesh; select existing vertices.');
      selected.add(index);
    }
  } else if (selection.mode === 'edge' || selection.mode === 'face') {
    const edgeMode = selection.mode === 'edge',
      identities = edgeMode ? selection.edges : selection.faces,
      available = edgeMode
        ? new Map(collectPolygonEdges(mesh).map((edge) => [edge.id, edge.vertices]))
        : new Map(mesh.faces.map((face) => [face.id, face.vertices]));
    if (!Array.isArray(identities))
      throw new TypeError('Component selection needs an identities array; supply existing component IDs.');
    for (const id of identities) {
      const vertices = typeof id === 'string' ? available.get(id) : undefined;
      if (!vertices) throw new TypeError('Selected component identity does not exist; select existing component IDs.');
      for (const index of vertices) selected.add(index);
    }
  } else throw new TypeError('Component selection mode is unsupported; choose object, vertex, edge or face.');
  return [...selected].sort((a, b) => a - b);
}

/** Add edge provenance to an edit result. Both meshes must already be validated. */
export function componentEdgeResult(
  source: PolygonMesh,
  result: MeshEditResult,
  descendants: ReadonlyMap<string, readonly string[]> = new Map(),
): ComponentEditResult {
  const oldEdges = collectPolygonEdges(source).map((edge) => edge.id),
    newEdges = collectPolygonEdges(result.mesh).map((edge) => edge.id);
  return componentEdgesFromIds(oldEdges, newEdges, result, descendants);
}

/** Add edge provenance from lists of edge IDs before and after the edit. */
export function componentEdgesFromIds(
  oldEdges: readonly string[],
  newEdges: readonly string[],
  result: MeshEditResult,
  descendants: ReadonlyMap<string, readonly string[]> = new Map(),
): ComponentEditResult {
  const oldIds = new Set(oldEdges),
    newIds = new Set(newEdges);
  const edgeMap = Object.fromEntries(
    oldEdges.map((id) => [id, [...(descendants.get(id) ?? (newIds.has(id) ? [id] : []))]]),
  );
  if (Object.values(edgeMap).some((ids) => ids.some((id) => !newIds.has(id))))
    throw new TypeError('Edge map references a missing output edge; repair the component provenance.');
  return {
    ...result,
    edgeMap,
    createdEdges: newEdges.filter((id) => !oldIds.has(id)),
    removedEdges: oldEdges.filter((id) => !newIds.has(id)),
  };
}

// Use the output's own dominant normal, never a comparison with its old normal: a half-turn is valid.
function convexProjection(points: MutableVec3[]): MutableVec3[] {
  const dropped = dominantAxis(meshPolygonNormal(points));
  return points.map((point) => point.map((value, axis) => (axis === dropped ? 0 : value)) as MutableVec3);
}

// Deterministic source-space ears keep the same diagonal through a warp and keep every corner, collinear ones
// included (a general ear clipper such as @margoengine/geometry's drops collinear corners, which would orphan them).
function sourceTriangles(mesh: PolygonMesh, face: PolygonFace): number[][] {
  const points = face.vertices.map((index) => mesh.vertices[index]),
    dropped = dominantAxis(meshPolygonNormal(points)),
    [x, y] = dropped === 0 ? [1, 2] : dropped === 1 ? [0, 2] : [0, 1],
    remaining = face.vertices.map((_, corner) => corner),
    triangles: number[][] = [];
  const turn = (a: number, b: number, c: number) => {
    const p = points[a],
      q = points[b],
      r = points[c];
    return (q[x] - p[x]) * (r[y] - p[y]) - (q[y] - p[y]) * (r[x] - p[x]);
  };
  let extent = 0;
  for (const point of points)
    extent = Math.max(extent, Math.abs(point[x] - points[0][x]), Math.abs(point[y] - points[0][y]));
  const epsilon = extent * extent * 1e-12;
  while (remaining.length > 3) {
    let removed = false;
    for (let step = 1; step <= remaining.length; step++) {
      const i = step % remaining.length,
        a = remaining[(i + remaining.length - 1) % remaining.length],
        b = remaining[i],
        c = remaining[(i + 1) % remaining.length],
        area = turn(a, b, c),
        winding = Math.sign(area);
      if (Math.abs(area) <= epsilon) continue;
      if (
        remaining.some(
          (v) =>
            v !== a &&
            v !== b &&
            v !== c &&
            turn(a, b, v) * winding >= -epsilon &&
            turn(b, c, v) * winding >= -epsilon &&
            turn(c, a, v) * winding >= -epsilon,
        )
      )
        continue;
      triangles.push([a, b, c]);
      remaining.splice(i, 1);
      removed = true;
      break;
    }
    if (!removed) throw new TypeError(`Polygon face ${face.id} cannot be triangulated; repair its source geometry.`);
  }
  triangles.push([...remaining]);
  return triangles;
}

/**
 * Move the selected vertices by an affine world-space delta. Unselected vertices and all corner UVs are unchanged.
 * `snapStep` snaps only the moved vertices, in world space. A face that becomes non-planar is split into triangles
 * along fixed diagonals (or rejected with `nonPlanarFaces: 'reject'`); one triangle keeps the face ID. Any face
 * that would collapse, cross itself or turn concave makes the whole edit throw. Mirrored object matrices work;
 * a mirroring delta does not.
 * @throws TypeError for a bad selection, options or resulting face; RangeError for a mirroring, singular or
 * projective matrix, a bad snap step or non-finite results.
 */
export function transformMeshComponents(
  mesh: PolygonMesh,
  selection: ComponentSelection,
  worldDelta: Mat4,
  options: ComponentTransformOptions = {},
): ComponentEditResult {
  const selected = new Set(meshSelectionVertices(mesh, selection));
  if (!options || typeof options !== 'object')
    throw new TypeError('Component options need an object; supply supported transform options or omit it.');
  const delta = affineMatrix(worldDelta, 'World delta'),
    determinant = affineDeterminant(delta);
  if (!(determinant > 0))
    throw new RangeError(
      determinant < 0
        ? 'World delta reflection is unsupported; use a positive-determinant edit transform.'
        : 'World delta must be invertible; use nonzero finite scales.',
    );
  const world = affineMatrix(options.worldMatrix ?? IDENTITY, 'Object world matrix'),
    inverse = invertAffine(world, 'Object world matrix');
  const snap = options.snapStep;
  if (snap !== undefined && (!Number.isFinite(snap) || snap <= 0))
    throw new RangeError('Snap step must be positive and finite; choose a world-space grid step or omit it.');
  if (
    options.nonPlanarFaces !== undefined &&
    options.nonPlanarFaces !== 'triangulate' &&
    options.nonPlanarFaces !== 'reject'
  )
    throw new TypeError('Nonplanar face policy is unsupported; choose triangulate or reject.');
  const createId = faceIdFactory(mesh, options),
    next = clonePolygonMesh(mesh),
    faceMap = identityFaceMap(mesh),
    affectedFaces: string[] = [],
    diagnostics: string[] = [];
  const label = 'Component transform';
  for (const index of selected) {
    const point = transformPoint(delta, transformPoint(world, mesh.vertices[index], label), label);
    if (snap !== undefined) for (let axis = 0; axis < 3; axis++) point[axis] = Math.round(point[axis] / snap) * snap;
    next.vertices[index] = transformPoint(inverse, point, label);
  }
  next.faces = next.faces.flatMap((face, fi) => {
    if (!face.vertices.some((index) => selected.has(index))) return [face];
    affectedFaces.push(face.id);
    const points = face.vertices.map((index) => next.vertices[index]),
      error = polygonGeometryError(points);
    if (!error) return [face];
    if (error !== 'must be planar' || options.nonPlanarFaces === 'reject')
      throw new TypeError(`Transformed face ${face.id} ${error}; reduce the transform or choose triangulation.`);
    const projection = convexProjection(points),
      projectionError = polygonGeometryError(projection);
    if (projectionError)
      throw new TypeError(
        `Transformed face ${face.id} has an invalid folded projection (${projectionError}); reduce the transform.`,
      );
    diagnostics.push(`Transformed face ${face.id} was triangulated to preserve nonplanar geometry and corner UVs.`);
    return sourceTriangles(mesh, mesh.faces[fi]).map((corners, index) => {
      const triangleError = faceGeometryError(projection, corners);
      if (triangleError)
        throw new TypeError(`Transformed face ${face.id} has a collapsed or folded triangle; reduce the transform.`);
      const id = index === 0 ? face.id : createId();
      if (index > 0) {
        faceMap[face.id].push(id);
        affectedFaces.push(id);
      }
      return {
        id,
        vertices: corners.map((corner) => face.vertices[corner]),
        uv: corners.map((corner) => [...face.uv[corner]] as MutableVec2),
      };
    });
  });
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
