import type { Mat4, MutableVec3, Vec3 } from '@margoengine/math';
import { dot, normalize, sub } from '@margoengine/math/vec3';
import { affineMatrix, transformPoints } from './matrix.js';
import { assertPolygonMesh, centroid, edgeId, faceGeometryError, polygonAreaVector, signedVolume } from './polygon.js';
import { positionKey } from './quantize.js';
import { clonePolygonMesh, createMeshEditResult, identityVertexMap } from './result.js';
import type { PolygonMesh, MeshEditResult } from './types.js';

/** One mesh for {@link cleanupPolygonMeshes}, with its world matrix and what cleanup may do with it. */
export interface PolygonCleanupInput {
  mesh: PolygonMesh;
  worldMatrix: Mat4;
  canEdit: boolean;
  canOcclude: boolean;
  motionGroup: string;
}

/** One edit result per input, plus how many faces were removed and vertices welded in total. */
export interface PolygonCleanupResult {
  results: MeshEditResult[];
  removed: number;
  welded: number;
}

const epsilon = 1e-6;
type ConvexSolid = { planes: { origin: Vec3; normal: Vec3 }[]; min: MutableVec3; max: MutableVec3 };

function convexSolid(mesh: PolygonMesh, vertices: MutableVec3[]): ConvexSolid | null {
  if (mesh.faces.length < 4 || mesh.vertices.length < 4) return null;
  const middle = centroid(vertices),
    edges = new Map<string, { face: number; from: number; to: number }[]>();
  const min: MutableVec3 = [Infinity, Infinity, Infinity],
    max: MutableVec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of vertices)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  if (max.some((value, axis) => value - min[axis] < 1e-7)) return null;
  const planes: ConvexSolid['planes'] = [];
  for (const [faceIndex, face] of mesh.faces.entries()) {
    const indices = face.vertices,
      origin = vertices[indices[0]];
    if (faceGeometryError(vertices, indices)) return null;
    // Orient the plane outward from the solid's centroid, then require every vertex on its inner side.
    const normal = normalize(polygonAreaVector(vertices, indices));
    if (Math.hypot(normal[0], normal[1], normal[2]) < 0.5) return null;
    let side = 0;
    for (const index of indices) side += dot(normal, sub(vertices[index], middle));
    if (side < 0) for (let axis = 0; axis < 3; axis++) normal[axis] = -normal[axis];
    for (const point of vertices) {
      const height = dot(normal, sub(point, origin));
      if (height > epsilon) return null;
    }
    for (const index of indices) if (Math.abs(dot(normal, sub(vertices[index], origin))) > epsilon) return null;
    planes.push({ origin, normal });
    for (let corner = 0; corner < indices.length; corner++) {
      const from = indices[corner],
        to = indices[(corner + 1) % indices.length],
        key = edgeId(from, to),
        incidences = edges.get(key);
      if (incidences) incidences.push({ face: faceIndex, from, to });
      else edges.set(key, [{ face: faceIndex, from, to }]);
    }
  }
  const volume = signedVolume(mesh.faces, vertices);
  // Edge counts alone admit doubled open sheets. Every edge needs opposite directed
  // incidences, and all faces must belong to one closed component enclosing volume.
  const neighbors = mesh.faces.map(() => [] as number[]);
  for (const incidences of edges.values()) {
    if (incidences.length !== 2) return null;
    const [first, second] = incidences;
    if (first.face === second.face || first.from !== second.to || first.to !== second.from) return null;
    neighbors[first.face].push(second.face);
    neighbors[second.face].push(first.face);
  }
  const visited = new Set([0]),
    pending = [0];
  while (pending.length) {
    const face = pending.pop()!;
    for (const neighbor of neighbors[face])
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        pending.push(neighbor);
      }
  }
  const boundsVolume = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  if (visited.size !== mesh.faces.length || !Number.isFinite(volume) || Math.abs(volume) <= boundsVolume * 1e-12)
    return null;
  return { planes, min, max };
}

/** Whether a point is strictly inside a convex solid, by more than `epsilon` from its box and every plane. */
function strictlyInside(point: Vec3, { min, max, planes }: ConvexSolid): boolean {
  for (let axis = 0; axis < 3; axis++)
    if (!(point[axis] > min[axis] + epsilon && point[axis] < max[axis] - epsilon)) return false;
  for (const { normal, origin } of planes)
    if (
      !(
        normal[0] * (point[0] - origin[0]) + normal[1] * (point[1] - origin[1]) + normal[2] * (point[2] - origin[2]) <
        -epsilon
      )
    )
      return false;
  return true;
}

/** Merge vertices with identical positions, unless that would repeat a vertex within one face. */
function weld(mesh: PolygonMesh): {
  mesh: PolygonMesh;
  vertexMap: number[][];
  removedVertices: number[];
  welded: number;
  affectedFaces: string[];
  diagnostics: string[];
} {
  const used = new Set(mesh.faces.flatMap((face) => face.vertices)),
    positions = new Map<string, number>();
  const vertexMap = mesh.vertices.map(() => [] as number[]),
    vertices: MutableVec3[] = [],
    removedVertices: number[] = [];
  let welded = 0;
  mesh.vertices.forEach((point, index) => {
    if (!used.has(index)) {
      removedVertices.push(index);
      return;
    }
    const key = positionKey(point),
      existing = positions.get(key);
    if (existing !== undefined) {
      vertexMap[index] = [existing];
      removedVertices.push(index);
      welded++;
    } else {
      vertexMap[index] = [vertices.length];
      positions.set(key, vertices.length);
      vertices.push([...point]);
    }
  });
  if (
    mesh.faces.some(
      (face) => new Set(face.vertices.map((vertex) => vertexMap[vertex][0])).size !== face.vertices.length,
    )
  )
    return {
      mesh,
      vertexMap: identityVertexMap(mesh),
      removedVertices: [],
      welded: 0,
      affectedFaces: [],
      diagnostics: [
        'Skipped welding because coincident corners would repeat a face vertex; repair the face before welding.',
      ],
    };
  const affectedFaces = mesh.faces
    .filter((face) => face.vertices.some((vertex) => vertexMap[vertex][0] !== vertex))
    .map((face) => face.id);
  return {
    mesh: {
      vertices,
      faces: mesh.faces.map((face) => ({ ...face, vertices: face.vertices.map((vertex) => vertexMap[vertex][0]) })),
    },
    vertexMap,
    removedVertices,
    welded,
    affectedFaces,
    diagnostics: [],
  };
}

/**
 * Remove hidden faces between closed convex solids.
 * A face goes when it lies fully inside another solid of the same motion group, or when two editable solids share
 * it back to back. The caller decides which meshes may be edited and which may hide others: a locked solid can hide
 * faces, but a shared face is removed only when both solids are editable. Partial overlaps are left alone.
 * With `weld`, vertices at identical positions merge within each editable mesh, and corner UVs stay separate. A mesh
 * whose weld would repeat a vertex within a face is left unwelded, with a diagnostic. Every result owns its arrays.
 * @throws TypeError for malformed inputs or options; RangeError for more than 2048 meshes or a projective matrix.
 */
export function cleanupPolygonMeshes(
  inputs: readonly PolygonCleanupInput[],
  options: { weld?: boolean } = {},
): PolygonCleanupResult {
  if (!Array.isArray(inputs as unknown))
    throw new TypeError('Cleanup inputs need an array of mesh candidates; supply independent meshes.');
  if (inputs.length > 2048)
    throw new RangeError('Cleanup takes at most 2048 meshes; split the candidates into smaller batches.');
  for (let index = 0; index < inputs.length; index++)
    if (!Object.hasOwn(inputs, index))
      throw new TypeError('Cleanup inputs must be dense; supply a mesh candidate at every index.');
  if (!options || typeof options !== 'object' || (options.weld !== undefined && typeof options.weld !== 'boolean'))
    throw new TypeError('Cleanup weld must be a boolean; pass {weld: true} or omit it.');
  const world = inputs.map((input) => {
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.canEdit !== 'boolean' ||
      typeof input.canOcclude !== 'boolean'
    )
      throw new TypeError('Cleanup canEdit and canOcclude must be booleans; supply explicit caller eligibility.');
    if (typeof input.motionGroup !== 'string')
      throw new TypeError('Cleanup motionGroup must be a string; group only geometry with shared motion.');
    assertPolygonMesh(input.mesh, false);
    return transformPoints(affineMatrix(input.worldMatrix, 'World matrix'), input.mesh.vertices, 'World matrix');
  });
  const solids = inputs.map((input, index) => (input.canOcclude ? convexSolid(input.mesh, world[index]) : null));
  const shared = inputs.map(() => new Set<number>());
  type Boundary = { object: number; face: number; points: Vec3[]; normal: Vec3 };
  const boundaries = new Map<string, Boundary[]>();
  inputs.forEach((input, object) => {
    const solid = solids[object];
    if (!solid || !input.canEdit) return;
    input.mesh.faces.forEach((face, faceIndex) => {
      const points = face.vertices.map((index) => world[object][index]),
        cell = centroid(points).map((value) => Math.floor(value / epsilon));
      const prefix = `${JSON.stringify(input.motionGroup)}:${points.length}:`,
        normal = solid.planes[faceIndex].normal;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            for (const candidate of boundaries.get(`${prefix}${cell[0] + dx}:${cell[1] + dy}:${cell[2] + dz}`) ?? []) {
              if (candidate.object === object || dot(normal, candidate.normal) > -0.999999) continue;
              const matched = new Set<number>();
              const coincident = points.every((point) => {
                const index = candidate.points.findIndex(
                  (other, index) => !matched.has(index) && Math.hypot(...sub(point, other)) <= epsilon,
                );
                if (index === -1) return false;
                matched.add(index);
                return true;
              });
              if (coincident) {
                shared[object].add(faceIndex);
                shared[candidate.object].add(candidate.face);
              }
            }
          }
      const key = `${prefix}${cell.join(':')}`;
      const bucket = boundaries.get(key);
      if (bucket) bucket.push({ object, face: faceIndex, points, normal });
      else boundaries.set(key, [{ object, face: faceIndex, points, normal }]);
    });
  });
  let removed = 0,
    welded = 0;
  const results = inputs.map((input, index) => {
    let mesh = clonePolygonMesh(input.mesh);
    if (input.canEdit)
      mesh.faces = mesh.faces.filter((face, faceIndex) => {
        const enclosed =
          shared[index].has(faceIndex) ||
          solids.some(
            (solid, other) =>
              solid &&
              index !== other &&
              input.motionGroup === inputs[other].motionGroup &&
              face.vertices.every((vertex) => strictlyInside(world[index][vertex], solid)),
          );
        if (enclosed) removed++;
        return !enclosed;
      });
    let vertexMap = identityVertexMap(mesh),
      removedVertices: number[] = [],
      affectedFaces: string[] = [],
      diagnostics: string[] = [];
    if (input.canEdit && options.weld) {
      const result = weld(mesh);
      ({ mesh, vertexMap, removedVertices, affectedFaces, diagnostics } = result);
      welded += result.welded;
    }
    const faces = new Set(mesh.faces.map((face) => face.id));
    return createMeshEditResult(input.mesh, mesh, {
      vertexMap,
      faceMap: Object.fromEntries(input.mesh.faces.map((face) => [face.id, faces.has(face.id) ? [face.id] : []])),
      createdVertices: [],
      removedVertices,
      affectedFaces,
      diagnostics,
    });
  });
  return { results, removed, welded };
}
