import type { MutableVec3, Vec3 } from '@margoengine/math';
import { normalize, scale } from '@margoengine/math/vec3';
import type { PaintGeometry } from './paint-types.js';
import type { CompiledPolygonMesh, PolygonEdge, PolygonMesh } from './types.js';

// Scratch storage for polygonGeometryError: corners relative to the first and divided by the extent (N, xyz), the
// same corners projected to 2D (U, V) and each edge's projected length (L). Faces have at most 64 corners.
const N = new Float64Array(64 * 3),
  U = new Float64Array(64),
  V = new Float64Array(64),
  L = new Float64Array(64);

/** Signed 2D turn of corner c about the directed edge a-b, in the projected scratch polygon. */
const turnAt = (a: number, b: number, c: number): number =>
  (U[b] - U[a]) * (V[c] - V[a]) - (V[b] - V[a]) * (U[c] - U[a]);

/** Whether projected corner p lies on edge a-b (edge length `length`), within `epsilon`. */
const onEdge = (a: number, b: number, p: number, length: number, epsilon: number): boolean =>
  Math.abs(turnAt(a, b, p)) <= epsilon * length &&
  U[p] >= Math.min(U[a], U[b]) - epsilon &&
  U[p] <= Math.max(U[a], U[b]) + epsilon &&
  V[p] >= Math.min(V[a], V[b]) - epsilon &&
  V[p] <= Math.max(V[a], V[b]) + epsilon;

/**
 * Why a polygon is unsupported, or null when it is fine. Supported polygons have 3 to 64 finite corners and are
 * planar, simple and convex, in either winding. Collinear corners on an edge are allowed. Allocates nothing.
 */
export function polygonGeometryError(points: readonly Vec3[]): string | null {
  if (!Array.isArray(points) || points.length < 3 || points.length > 64) return 'needs between three and 64 corners';
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const point = points[i];
    if (!Array.isArray(point) || point.length !== 3) return 'needs finite three-component points';
    for (let axis = 0; axis < 3; axis++)
      if (!Number.isFinite(point[axis])) return 'needs finite three-component points';
  }
  // Work relative to the first corner and divided by the extent, so tolerances do not depend on scale or offset.
  const origin = points[0];
  let extent = 0,
    coordinateSize = 0;
  for (let i = 0; i < count; i++)
    for (let axis = 0; axis < 3; axis++) {
      const value = points[i][axis] - origin[axis];
      N[i * 3 + axis] = value;
      extent = Math.max(extent, Math.abs(value));
      coordinateSize = Math.max(coordinateSize, Math.abs(points[i][axis]));
    }
  if (!(extent > 0)) return 'has degenerate geometry';
  const epsilon = Math.max(1e-9, (coordinateSize * Number.EPSILON * 8) / extent),
    inverse = 1 / extent;
  for (let i = 0; i < count * 3; i++) N[i] *= inverse;
  for (let i = 0; i < count; i++)
    for (let j = i + 1; j < count; j++)
      if (Math.hypot(N[i * 3] - N[j * 3], N[i * 3 + 1] - N[j * 3 + 1], N[i * 3 + 2] - N[j * 3 + 2]) <= epsilon)
        return 'needs geometrically distinct corners (degenerate geometry)';
  // Plane normal: the longest corner vector crossed with the corner vector that gives the largest cross product.
  let far = 0,
    longest = Math.hypot(N[0], N[1], N[2]);
  for (let i = 1; i < count; i++) {
    const length = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    if (!(longest > length)) {
      far = i;
      longest = length;
    }
  }
  const ax = N[far * 3],
    ay = N[far * 3 + 1],
    az = N[far * 3 + 2];
  let nx = 0,
    ny = 0,
    nz = 0,
    magnitude = -1;
  for (let i = 0; i < count; i++) {
    const bx = N[i * 3],
      by = N[i * 3 + 1],
      bz = N[i * 3 + 2],
      cx = ay * bz - az * by,
      cy = az * bx - ax * bz,
      cz = ax * by - ay * bx,
      length = Math.hypot(cx, cy, cz);
    if (!(magnitude > length)) {
      nx = cx;
      ny = cy;
      nz = cz;
      magnitude = length;
    }
  }
  if (magnitude <= epsilon) return 'has degenerate area';
  const unit = 1 / magnitude;
  nx *= unit;
  ny *= unit;
  nz *= unit;
  for (let i = 0; i < count; i++)
    if (Math.abs(N[i * 3] * nx + N[i * 3 + 1] * ny + N[i * 3 + 2] * nz) > epsilon) return 'must be planar';
  // Project by dropping the normal's dominant axis, then test edge crossings and convexity in 2D.
  const absX = Math.abs(nx),
    absY = Math.abs(ny),
    absZ = Math.abs(nz),
    dropped = absX >= absY && absX >= absZ ? 0 : absY >= absZ ? 1 : 2,
    first = dropped === 0 ? 1 : 0,
    second = dropped === 2 ? 1 : 2;
  for (let i = 0; i < count; i++) {
    U[i] = N[i * 3 + first];
    V[i] = N[i * 3 + second];
  }
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    L[i] = Math.hypot(U[j] - U[i], V[j] - V[i]);
  }
  for (let i = 0; i < count; i++) {
    const b = (i + 1) % count;
    for (let j = i + 2; j < count; j++) {
      if (i === 0 && j === count - 1) continue;
      const d = (j + 1) % count,
        abC = turnAt(i, b, j),
        abD = turnAt(i, b, d),
        cdA = turnAt(j, d, i),
        cdB = turnAt(j, d, b),
        abEpsilon = epsilon * L[i],
        cdEpsilon = epsilon * L[j];
      if (
        (((abC > abEpsilon && abD < -abEpsilon) || (abC < -abEpsilon && abD > abEpsilon)) &&
          ((cdA > cdEpsilon && cdB < -cdEpsilon) || (cdA < -cdEpsilon && cdB > cdEpsilon))) ||
        onEdge(i, b, j, L[i], epsilon) ||
        onEdge(i, b, d, L[i], epsilon) ||
        onEdge(j, d, i, L[j], epsilon) ||
        onEdge(j, d, b, L[j], epsilon)
      )
        return 'must be simple, without intersecting or overlapping edges';
    }
  }
  let winding = 0;
  for (let i = 0; i < count; i++) {
    const b = (i + 1) % count,
      c = (i + 2) % count,
      value = turnAt(i, b, c);
    if (Math.abs(value) <= epsilon * (L[i] + L[b])) {
      if ((U[b] - U[i]) * (U[c] - U[b]) + (V[b] - V[i]) * (V[c] - V[b]) < 0)
        return 'must be simple, without backtracking edges';
      continue;
    }
    const sign = Math.sign(value);
    if (winding && winding !== sign) return 'must be convex';
    winding = sign;
  }
  return winding ? null : 'has degenerate area';
}

/** Reused corner lists, so validating a face allocates nothing. */
const corners: Vec3[] = [],
  flat: MutableVec3[] = Array.from({ length: 64 }, () => [0, 0, 0]);

/** {@link polygonGeometryError} for the face whose corners are `points[indices[i]]`. */
export function faceGeometryError(points: readonly Vec3[], indices: readonly number[]): string | null {
  corners.length = indices.length;
  for (let i = 0; i < indices.length; i++) corners[i] = points[indices[i]];
  const error = polygonGeometryError(corners);
  corners.length = 0;
  return error;
}

/** {@link polygonGeometryError} for a 2D polygon (z = 0). At most 64 corners. */
export function polygon2DError(points: readonly (readonly number[])[]): string | null {
  if (points.length > 64) return 'needs between three and 64 corners';
  corners.length = points.length;
  for (let i = 0; i < points.length; i++) {
    const corner = flat[i];
    corner[0] = points[i][0];
    corner[1] = points[i][1];
    corners[i] = corner;
  }
  const error = polygonGeometryError(corners);
  corners.length = 0;
  return error;
}

const finiteTriple = (point: unknown): boolean =>
  Array.isArray(point) &&
  point.length === 3 &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]) &&
  Number.isFinite(point[2]);

const unitPair = (uv: unknown): boolean =>
  Array.isArray(uv) &&
  uv.length === 2 &&
  Number.isFinite(uv[0]) &&
  Number.isFinite(uv[1]) &&
  uv[0] >= 0 &&
  uv[0] <= 1 &&
  uv[1] >= 0 &&
  uv[1] <= 1;

/**
 * Check a mesh's structure: at most 200000 finite vertices and faces, unique face IDs, 3 to 64 valid corner indices
 * and one UV pair in [0, 1] per corner. With `geometry`, every face must also pass {@link polygonGeometryError}
 * (cleanup turns this off for legacy welds). With `draftUV`, corner UVs only need to be arrays, so paint and UV
 * commands can repair them.
 * @throws TypeError for bad structure or geometry; RangeError over the size limit.
 */
export function assertPolygonMesh(mesh: PolygonMesh | PaintGeometry, geometry = true, draftUV = false): void {
  if (!mesh || typeof mesh !== 'object' || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.faces))
    throw new TypeError('Polygon mesh needs vertices and faces arrays; supply editable polygon data.');
  const { vertices, faces } = mesh;
  if (vertices.length > 200_000 || faces.length > 200_000)
    throw new RangeError('Polygon mesh exceeds 200000 vertices or faces; split it into smaller meshes.');
  for (let i = 0; i < vertices.length; i++)
    if (!finiteTriple(vertices[i]))
      throw new TypeError('Polygon mesh vertices need finite XYZ triples; repair the vertex data.');
  const ids = new Set<string>();
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    if (!face || typeof face !== 'object' || typeof face.id !== 'string' || !face.id.length || ids.has(face.id))
      throw new TypeError('Polygon face IDs must be nonempty and unique; repair the face identities.');
    ids.add(face.id);
    const indices = face.vertices,
      uvs = face.uv;
    if (!Array.isArray(indices) || indices.length < 3 || indices.length > 64)
      throw new TypeError('Polygon face vertices need 3 to 64 valid indices; repair the face corners.');
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (!Number.isInteger(index) || index < 0 || index >= vertices.length)
        throw new TypeError('Polygon face vertices need 3 to 64 valid indices; repair the face corners.');
    }
    if (!Array.isArray(uvs) || (!draftUV && uvs.length !== indices.length))
      throw new TypeError('Polygon face UVs need one finite normalized pair per corner; repair the corner UVs.');
    for (let i = 0; i < uvs.length; i++)
      if (draftUV ? !Array.isArray(uvs[i]) : !unitPair(uvs[i]))
        throw new TypeError(
          draftUV
            ? 'Polygon face draft UVs need an array of coordinate arrays; repair the corner UVs.'
            : 'Polygon face UVs need one finite normalized pair per corner; repair the corner UVs.',
        );
    if (geometry) {
      const error = faceGeometryError(vertices, indices);
      if (error) throw new TypeError(`Polygon face ${face.id} ${error}; repair its geometry before editing.`);
    }
  }
}

/** Axis of the largest absolute component (the first on ties): the axis a planar projection drops. */
export function dominantAxis(v: Vec3): 0 | 1 | 2 {
  const x = Math.abs(v[0]),
    y = Math.abs(v[1]),
    z = Math.abs(v[2]);
  return x >= y && x >= z ? 0 : y >= z ? 1 : 2;
}

/** Canonical edge identity `${lower}:${higher}`. */
export const edgeId = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Twice the polygon's vector area, summed relative to its first corner for precision far from the origin.
 * Corners are `points[indices[i]]` when `indices` is given, else `points[i]`. Writes into `out` when given.
 */
export function polygonAreaVector(
  points: readonly Vec3[],
  indices?: readonly number[],
  out: MutableVec3 = [0, 0, 0],
): MutableVec3 {
  const count = indices ? indices.length : points.length,
    origin = points[indices ? indices[0] : 0];
  out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < count; i++) {
    const p = points[indices ? indices[i] : i],
      q = points[indices ? indices[(i + 1) % count] : (i + 1) % count],
      ax = p[0] - origin[0],
      ay = p[1] - origin[1],
      az = p[2] - origin[2],
      bx = q[0] - origin[0],
      by = q[1] - origin[1],
      bz = q[2] - origin[2];
    out[0] += ay * bz - az * by;
    out[1] += az * bx - ax * bz;
    out[2] += ax * by - ay * bx;
  }
  return out;
}

/** Signed volume of closed polygon faces over `points`, fanned from each face's first corner about their centroid. */
export function signedVolume(faces: readonly { vertices: readonly number[] }[], points: readonly Vec3[]): number {
  if (!points.length) return 0;
  const [ox, oy, oz] = centroid(points);
  let volume = 0;
  for (const { vertices } of faces) {
    const a = points[vertices[0]],
      ax = a[0] - ox,
      ay = a[1] - oy,
      az = a[2] - oz;
    for (let corner = 1; corner < vertices.length - 1; corner++) {
      const b = points[vertices[corner]],
        c = points[vertices[corner + 1]],
        bx = b[0] - ox,
        by = b[1] - oy,
        bz = b[2] - oz,
        cx = c[0] - ox,
        cy = c[1] - oy,
        cz = c[2] - oz;
      volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    }
  }
  return volume;
}

/** Unit polygon normal from {@link polygonAreaVector}; [0, 0, 0] for a degenerate polygon. */
export const meshPolygonNormal = (points: readonly Vec3[]): MutableVec3 => normalize(polygonAreaVector(points));

/** Unit Newell normal (the edit commands' and painter's established operand order); [0, 0, 0] when degenerate. */
export function newellNormal(points: readonly Vec3[]): MutableVec3 {
  const n: MutableVec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize(n);
}

/** Centroid of the points (sum, then one scale); [0, 0, 0] for none. */
export const centroid = (points: readonly Vec3[]): MutableVec3 => {
  const sum: MutableVec3 = [0, 0, 0];
  for (const point of points) for (let axis = 0; axis < 3; axis++) sum[axis] += point[axis];
  return scale(sum, 1 / (points.length || 1));
};

/** Signed 2D turn of c about the directed line a-b (twice the triangle area). */
export const turn2 = (a: readonly number[], b: readonly number[], c: readonly number[]): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Canonical numeric edge identities and oriented incidence; nonmanifold edges retain all incidences. */
export function polygonMeshEdges(mesh: PolygonMesh): PolygonEdge[] {
  assertPolygonMesh(mesh);
  return collectPolygonEdges(mesh);
}

/** Internal incidence enumeration for a mesh already validated within the same synchronous operation. */
export function collectPolygonEdges(mesh: PolygonMesh): PolygonEdge[] {
  const edges = new Map<string, PolygonEdge>();
  for (const face of mesh.faces)
    face.vertices.forEach((from, corner) => {
      const to = face.vertices[(corner + 1) % face.vertices.length],
        id = edgeId(from, to);
      let edge = edges.get(id);
      if (!edge) {
        edge = { id, vertices: from < to ? [from, to] : [to, from], incidences: [] };
        edges.set(id, edge);
      }
      edge.incidences.push({ faceId: face.id, corner, from, to });
    });
  return [...edges.values()];
}

/** Expand polygon corners with flat normals, fan triangles and explicit source identities; empty meshes are supported. */
export function compilePolygonMesh(mesh: PolygonMesh): CompiledPolygonMesh {
  assertPolygonMesh(mesh);
  const result: CompiledPolygonMesh = {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    faceSizes: [],
    triangleFaces: [],
    cornerVertices: [],
  };
  for (const face of mesh.faces) {
    const start = result.positions.length / 3,
      points = face.vertices.map((index) => mesh.vertices[index]),
      normal = meshPolygonNormal(points);
    points.forEach((point, index) => {
      result.positions.push(...point);
      result.normals.push(...normal);
      result.uvs.push(...face.uv[index]);
      result.cornerVertices.push(face.vertices[index]);
    });
    for (let corner = 1; corner < points.length - 1; corner++) {
      result.indices.push(start, start + corner, start + corner + 1);
      result.triangleFaces.push(face.id);
      if (points.length !== 4) result.faceSizes.push(3);
    }
    if (points.length === 4) result.faceSizes.push(4);
  }
  return result;
}
