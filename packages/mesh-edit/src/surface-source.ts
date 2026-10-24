import type { Mat4, MutableVec2, MutableVec3 } from '@margoengine/math';
import { MeshBVH } from '@margoengine/bvh/tree';
import { affineMatrix, IDENTITY, transformPoint } from './matrix.js';
import { assertPolygonMesh, compilePolygonMesh } from './polygon.js';
import type { CompiledPolygonMesh, PolygonFace, PolygonMesh } from './types.js';

/** One mesh to capture for {@link MeshSurfaceQuery}: its ID, polygons, optional triangulation and world matrix. */
export interface SurfaceSource {
  objectId: string;
  mesh: PolygonMesh;
  /** Triangulation to query (from {@link compilePolygonMesh}, possibly with other diagonals); compiled when omitted. */
  compiled?: CompiledPolygonMesh;
  /** Affine local-to-world matrix; identity when omitted. Singular matrices are allowed. */
  worldMatrix?: Mat4;
}

/** One captured triangle: its object and face, world and local corners, and corner UVs. */
export interface SurfaceTriangle {
  objectId: string;
  faceId: string;
  /** Index of the triangle in the source's compiled index buffer. */
  triangleIndex: number;
  a: MutableVec3;
  b: MutableVec3;
  c: MutableVec3;
  local: [MutableVec3, MutableVec3, MutableVec3];
  uv: [MutableVec2, MutableVec2, MutableVec2];
  /** UV bounds of the whole source face: minU, minV, maxU, maxV. */
  bounds: [number, number, number, number];
}

/** One captured source: world points, its triangles, and a float64 BVH over them (null without triangles). */
export interface CapturedSurface {
  objectId: string;
  points: MutableVec3[];
  triangles: SurfaceTriangle[];
  bvh: MeshBVH | null;
}

/** Deep copy of a captured triangle; `points` maps captured corners to already-copied ones. */
export function copySurfaceTriangle(t: SurfaceTriangle, points?: Map<MutableVec3, MutableVec3>): SurfaceTriangle {
  return {
    objectId: t.objectId,
    faceId: t.faceId,
    triangleIndex: t.triangleIndex,
    a: points?.get(t.a) ?? [...t.a],
    b: points?.get(t.b) ?? [...t.b],
    c: points?.get(t.c) ?? [...t.c],
    local: [[...t.local[0]], [...t.local[1]], [...t.local[2]]],
    uv: [[...t.uv[0]], [...t.uv[1]], [...t.uv[2]]],
    bounds: [...t.bounds],
  };
}

/** Copy and validate one source, transform it to world space in float64, and build its BVH. */
export function captureSurfaceSource(source: SurfaceSource): CapturedSurface {
  const objectId = source?.objectId;
  if (typeof objectId !== 'string' || !objectId.length)
    throw new TypeError('Surface source needs a nonempty objectId; supply a stable source identity.');
  const original = source.mesh;
  if (!original || !Array.isArray(original.vertices) || !Array.isArray(original.faces))
    throw new TypeError('Surface source needs editable vertices and faces arrays; supply a polygon mesh.');
  const mesh: PolygonMesh = {
    vertices: Array.from(original.vertices, (p) => (Array.isArray(p) ? ([...p] as MutableVec3) : p)),
    faces: Array.from(
      original.faces,
      (f) =>
        f && {
          id: f.id,
          vertices: Array.isArray(f.vertices) ? [...f.vertices] : f.vertices,
          uv: Array.isArray(f.uv) ? Array.from(f.uv, (p) => (Array.isArray(p) ? ([...p] as MutableVec2) : p)) : f.uv,
        },
    ),
  };
  assertPolygonMesh(mesh);
  const elements = affineMatrix(
      source.worldMatrix === undefined ? IDENTITY : source.worldMatrix,
      'Surface world matrix',
    ),
    points = mesh.vertices.map((p) => transformPoint(elements, p, 'Surface world matrix'));
  const supplied = source.compiled;
  const compiled = supplied === undefined ? compilePolygonMesh(mesh) : copyCompiled(supplied);
  const count = compiled.cornerVertices.length;
  if (
    compiled.positions.length !== count * 3 ||
    compiled.uvs.length !== count * 2 ||
    compiled.indices.length % 3 ||
    compiled.triangleFaces.length !== compiled.indices.length / 3
  )
    throw new TypeError('Surface compiled buffers have inconsistent lengths; compile the current source mesh again.');
  const cornerUVs: MutableVec2[] = [];
  for (let c = 0; c < count; c++) {
    const v = compiled.cornerVertices[c],
      point = mesh.vertices[v],
      u = compiled.uvs[c * 2],
      w = compiled.uvs[c * 2 + 1];
    if (
      !Number.isInteger(v) ||
      !point ||
      point[0] !== compiled.positions[c * 3] ||
      point[1] !== compiled.positions[c * 3 + 1] ||
      point[2] !== compiled.positions[c * 3 + 2] ||
      !Number.isFinite(u) ||
      !Number.isFinite(w)
    )
      throw new TypeError(
        'Surface compiled corners disagree with source vertices or UVs; compile the current mesh again.',
      );
    cornerUVs.push([u, w]);
  }
  const faces = new Map(mesh.faces.map((f) => [f.id, f]));
  const bounds = new Map<string, SurfaceTriangle['bounds']>();
  for (const face of mesh.faces) {
    const box: SurfaceTriangle['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const uv of face.uv) {
      box[0] = Math.min(box[0], uv[0]);
      box[1] = Math.min(box[1], uv[1]);
      box[2] = Math.max(box[2], uv[0]);
      box[3] = Math.max(box[3], uv[1]);
    }
    bounds.set(face.id, box);
  }
  const triangles: SurfaceTriangle[] = [],
    indices = new Uint32Array(compiled.indices.length);
  for (let i = 0; i < compiled.indices.length; i += 3) {
    const faceId = compiled.triangleFaces[i / 3],
      face = faces.get(faceId);
    const first = compiled.indices[i],
      second = compiled.indices[i + 1],
      third = compiled.indices[i + 2];
    if (
      !face ||
      !surfaceCornerMatches(face, first, compiled.cornerVertices, cornerUVs) ||
      !surfaceCornerMatches(face, second, compiled.cornerVertices, cornerUVs) ||
      !surfaceCornerMatches(face, third, compiled.cornerVertices, cornerUVs)
    )
      throw new TypeError(
        'Surface triangle has invalid source face/corner provenance; compile the current mesh again.',
      );
    const a = compiled.cornerVertices[first],
      b = compiled.cornerVertices[second],
      c = compiled.cornerVertices[third];
    indices[i] = a;
    indices[i + 1] = b;
    indices[i + 2] = c;
    triangles.push({
      objectId,
      faceId,
      triangleIndex: i / 3,
      a: points[a],
      b: points[b],
      c: points[c],
      local: [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]],
      uv: [cornerUVs[first], cornerUVs[second], cornerUVs[third]],
      bounds: bounds.get(faceId)!,
    });
  }
  const positions = new Float64Array(points.length * 3);
  points.forEach((point, index) => positions.set(point, index * 3));
  const bvh = triangles.length
    ? MeshBVH.build({ positions, indices, stride: 3, precision: 'float64' }, { maxLeafTriangles: 8 })
    : null;
  return { objectId, points, triangles, bvh };
}

function surfaceCornerMatches(face: PolygonFace, corner: number, vertices: number[], uv: MutableVec2[]): boolean {
  if (!Number.isInteger(corner) || corner < 0 || corner >= vertices.length) return false;
  const vertex = vertices[corner],
    point = uv[corner];
  for (let i = 0; i < face.vertices.length; i++)
    if (face.vertices[i] === vertex && face.uv[i][0] === point[0] && face.uv[i][1] === point[1]) return true;
  return false;
}

function copyCompiled(
  c: CompiledPolygonMesh,
): Pick<CompiledPolygonMesh, 'positions' | 'uvs' | 'indices' | 'triangleFaces' | 'cornerVertices'> {
  if (
    !c ||
    !['positions', 'uvs', 'indices', 'triangleFaces', 'cornerVertices'].every((key) =>
      Array.isArray(c[key as keyof CompiledPolygonMesh]),
    )
  )
    throw new TypeError('Surface compiled data needs array buffers and provenance; use compilePolygonMesh.');
  return {
    positions: [...c.positions],
    uvs: [...c.uvs],
    indices: [...c.indices],
    triangleFaces: [...c.triangleFaces],
    cornerVertices: [...c.cornerVertices],
  };
}
