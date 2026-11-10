import { triangulateConstrained } from '@margoengine/geometry/delaunay';
import { MargoError, type MutableVec2, type MutableVec3, type Vec3 } from '@margoengine/math';
import { assertSolid } from './boolean.js';
import { assertOptions } from './edit-support.js';
import { meshBoundaryLoops } from './holes.js';
import { assertPolygonMesh, polygonAreaVector } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import { faceIdFactory } from './result.js';
import type { MeshEditOptions, PolygonFace, PolygonMesh } from './types.js';

/** Plane `normal dot position = offset`; normal need not be unit length. */
export interface MeshSectionPlane {
  normal: Vec3;
  offset: number;
}

/** Plane section options. All distances use the mesh's local units. */
export interface MeshSectionOptions extends MeshEditOptions {
  /** Cooperative cancellation, checked between faces and caps. */
  signal?: AbortSignal;
}

/** A filled section region, counter-clockwise outside and clockwise holes in the returned basis. */
export interface MeshSectionPolygon {
  contour: MutableVec2[];
  holes: MutableVec2[][];
}

/** Owned polygons and an orthonormal basis; position = origin + u*x + v*y. */
export interface MeshSection {
  origin: MutableVec3;
  u: MutableVec3;
  v: MutableVec3;
  normal: MutableVec3;
  polygons: MeshSectionPolygon[];
}

/** Both closed half-solids, with independent storage and source face provenance. */
export interface MeshPlaneSplit {
  positive: PolygonMesh;
  negative: PolygonMesh;
  /** Source face IDs to surviving faces on each side. Caps have no source. */
  faceMap: { positive: Record<string, string[]>; negative: Record<string, string[]> };
  caps: { positive: string[]; negative: string[] };
  section: MeshSection;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): MutableVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const area = (ring: MutableVec2[]): number =>
  ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + p[0] * q[1] - p[1] * q[0];
  }, 0);

function contains(ring: MutableVec2[], p: MutableVec2): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Split a closed, outward solid by an arbitrary plane, retaining interpolated corner UVs and capped holes.
 * Empty sides are valid empty meshes. Pure tangency creates no zero-volume solid.
 * @throws TypeError for invalid input; MargoError for an unresolved section; abort reason on cancellation.
 */
export function splitMeshByPlane(
  mesh: PolygonMesh,
  plane: MeshSectionPlane,
  options: MeshSectionOptions = {},
): MeshPlaneSplit {
  assertOptions(options, 'Mesh section');
  if (
    !plane ||
    !Array.isArray(plane.normal) ||
    plane.normal.length !== 3 ||
    !plane.normal.every(Number.isFinite) ||
    !Number.isFinite(plane.offset)
  )
    throw new TypeError('Section plane needs a finite normal and offset; supply normal dot position = offset.');
  const magnitude = Math.hypot(...plane.normal);
  if (!(magnitude > 0) || !Number.isFinite(magnitude))
    throw new TypeError('Section normal must be nonzero and finite; rescale the plane.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Section signal must be an AbortSignal; pass controller.signal.');
  options.signal?.throwIfAborted();
  assertPolygonMesh(mesh);
  if (mesh.faces.length) assertSolid(mesh, 'section');
  const createId = faceIdFactory(mesh, options),
    normal = plane.normal.map((x) => x / magnitude) as MutableVec3,
    offset = plane.offset / magnitude,
    origin = normal.map((x) => x * offset) as MutableVec3,
    helper: MutableVec3 = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0],
    rawU = cross(helper, normal),
    ul = Math.hypot(...rawU),
    u = rawU.map((x) => x / ul) as MutableVec3,
    v = cross(normal, u),
    section: MeshSection = { origin, u, v, normal, polygons: [] },
    vertices = mesh.vertices.map((p) => [...p] as MutableVec3),
    // Evaluate the caller's equation before normalization. Dividing its coefficients independently
    // can turn an exactly incident vertex into a tiny crossing and invent a zero-area sliver.
    distances = mesh.vertices.map((p) => (dot(plane.normal, p) - plane.offset) / magnitude),
    intersections = new Map<string, number>(),
    sides: [PolygonFace[], PolygonFace[]] = [[], []],
    maps = [
      Object.fromEntries(mesh.faces.map((f) => [f.id, [] as string[]])),
      Object.fromEntries(mesh.faces.map((f) => [f.id, [] as string[]])),
    ],
    project = (index: number): MutableVec2 => {
      const p = vertices[index].map((x, k) => x - origin[k]) as MutableVec3;
      return [dot(u, p), dot(v, p)];
    };
  if (!Number.isFinite(offset) || origin.some((x) => !Number.isFinite(x)) || distances.some((x) => !Number.isFinite(x)))
    throw new RangeError('Section coordinates overflow; translate and rescale the mesh and plane.');
  const cut = (a: number, b: number): number => {
    const lo = Math.min(a, b),
      hi = Math.max(a, b),
      key = `${lo}:${hi}`;
    let index = intersections.get(key);
    if (index === undefined) {
      const da = distances[lo],
        db = distances[hi],
        t = da / (da - db);
      index = vertices.length;
      vertices.push(vertices[lo].map((x, k) => x * (1 - t) + vertices[hi][k] * t) as MutableVec3);
      distances.push(0);
      intersections.set(key, index);
    }
    return index;
  };
  for (const face of mesh.faces) {
    options.signal?.throwIfAborted();
    const coplanar = face.vertices.every((i) => distances[i] === 0);
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      if (
        coplanar &&
        (dot(polygonAreaVector(face.vertices.map((i) => vertices[i])), normal) > 0 ? side === 0 : side === 1)
      )
        continue;
      const loop: number[] = [],
        uv: MutableVec2[] = [];
      for (let i = 0; i < face.vertices.length; i++) {
        const j = (i + 1) % face.vertices.length,
          a = face.vertices[i],
          b = face.vertices[j],
          da = distances[a],
          db = distances[b];
        if (da * sign >= 0) {
          loop.push(a);
          uv.push([...face.uv[i]]);
        }
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const index = cut(a, b),
            t = da / (da - db);
          loop.push(index);
          uv.push(face.uv[i].map((x, k) => Math.max(0, Math.min(1, x * (1 - t) + face.uv[j][k] * t))) as MutableVec2);
        }
      }
      if (loop.length < 3) continue;
      const pieces = loopFaces(vertices, loop, uv, face.id, createId);
      if (!pieces)
        throw new MargoError('failed', 'Section face is numerically unresolved; translate or rescale the input.');
      sides[side].push(...pieces);
      maps[side][face.id].push(...pieces.map((f) => f.id));
    }
  }
  const caps: [string[], string[]] = [[], []];
  let sectionRings: MutableVec2[][] = [];
  const finish = (side: number): PolygonMesh => {
    const faces = sides[side],
      open = { vertices, faces },
      loops = meshBoundaryLoops(open);
    if (loops.length) {
      const rings = loops.map((loop) => loop.map(project)),
        all = loops.flat(),
        flat = rings.flat(),
        triangles = triangulateConstrained(rings[0], rings.slice(1)).indices;
      if (!side) sectionRings = rings;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of flat) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
      for (let i = 0; i < triangles.length; i += 3) {
        options.signal?.throwIfAborted();
        const indices = triangles.slice(i, i + 3);
        if (!side) indices.reverse();
        const id = createId();
        faces.push({
          id,
          vertices: indices.map((k) => all[k]),
          uv: indices.map((k) => [(flat[k][0] - minX) / (maxX - minX), (flat[k][1] - minY) / (maxY - minY)]),
        });
        caps[side].push(id);
      }
    }
    const out: PolygonMesh = { vertices: [], faces: [] },
      remap = new Map<number, number>();
    for (const f of faces)
      out.faces.push({
        ...f,
        uv: f.uv.map((p) => [...p]),
        vertices: f.vertices.map((i) => {
          let at = remap.get(i);
          if (at === undefined) {
            at = out.vertices.length;
            remap.set(i, at);
            out.vertices.push([...vertices[i]]);
          }
          return at;
        }),
      });
    assertPolygonMesh(out);
    if (out.faces.length) assertSolid(out, 'section result');
    return out;
  };
  const positive = finish(0),
    negative = finish(1),
    rings = sectionRings
      .map((ring) => ({ ring, size: Math.abs(area(ring)), parent: -1, depth: 0 }))
      .sort((a, b) => b.size - a.size);
  for (let i = 0; i < rings.length; i++) {
    const item = rings[i];
    for (let j = i - 1; j >= 0; j--)
      if (contains(rings[j].ring, item.ring[0])) {
        item.parent = j;
        item.depth = rings[j].depth + 1;
        break;
      }
    if (area(item.ring) > 0 !== (item.depth % 2 === 0)) item.ring.reverse();
  }
  // Parent links must be complete before attaching holes.
  section.polygons = rings
    .filter((r) => !(r.depth % 2))
    .map((r) => ({
      contour: r.ring.map((p) => [...p]),
      holes: rings.filter((h) => h.parent === rings.indexOf(r)).map((h) => h.ring.map((p) => [...p])),
    }));
  options.signal?.throwIfAborted();
  return {
    positive,
    negative,
    faceMap: { positive: maps[0], negative: maps[1] },
    caps: { positive: caps[0], negative: caps[1] },
    section,
  };
}

/** Keep the half-solid in the plane normal's direction. @throws As {@link splitMeshByPlane}. */
export function trimMeshByPlane(
  mesh: PolygonMesh,
  plane: MeshSectionPlane,
  options: MeshSectionOptions = {},
): PolygonMesh {
  return splitMeshByPlane(mesh, plane, options).positive;
}

/** Slice a closed solid into filled 2D regions with holes. Tangential contacts have no section area.
 * @throws As {@link splitMeshByPlane}.
 */
export function sliceMesh(mesh: PolygonMesh, plane: MeshSectionPlane, options: MeshSectionOptions = {}): MeshSection {
  return splitMeshByPlane(mesh, plane, options).section;
}
