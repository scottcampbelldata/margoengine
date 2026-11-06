// Simplifies gltf-pro's packed 20-float vertices (position, normal, tangent, UV0, UV1, colour) with mesh-edit's
// quadric collapses. A collapse keeps one end of an edge, so every level is a subset of the source's own vertices:
// each one keeps its normal, tangent, UVs and colour exactly, and nothing has to be interpolated.
import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import type { meshLODChain } from '@margoengine/mesh-edit/modeling';

/** Packed triangles: 20 floats per vertex, gltf-pro's layout. */
export interface PackedGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  /** On a simplified level: the source vertex each vertex is. Absent when the level is the source itself. */
  sources?: Uint32Array;
}
/** What the simplifying needs from `@margoengine/mesh-edit/modeling`. */
export interface Modeling {
  meshLODChain: typeof meshLODChain;
}

/**
 * The matrix that carries normals under the 4x4 column-major `m`, as three columns in nine numbers: the cofactors of its
 * upper 3x3 (the inverse transpose times the determinant), negated when `m` mirrors so a normal still points out.
 * `n' = a * c[0..2] + b * c[3..5] + e * c[6..8]` before normalising. `mirrored` tells the caller to rewind triangles.
 */
export function normalMatrix(m: ArrayLike<number>): { c: number[]; mirrored: boolean } {
  const c = [
      m[5] * m[10] - m[6] * m[9],
      m[6] * m[8] - m[4] * m[10],
      m[4] * m[9] - m[5] * m[8],
      m[9] * m[2] - m[10] * m[1],
      m[10] * m[0] - m[8] * m[2],
      m[8] * m[1] - m[9] * m[0],
      m[1] * m[6] - m[2] * m[5],
      m[2] * m[4] - m[0] * m[6],
      m[0] * m[5] - m[1] * m[4],
    ],
    mirrored = m[0] * c[0] + m[1] * c[1] + m[2] * c[2] < 0;
  return { c: mirrored ? c.map((v) => -v) : c, mirrored };
}

const STRIDE = 20,
  /** Sheets of coincident faces welded apart from each other before a triangle stands alone. */
  SHEETS = 4,
  /** Separates vertices that share a position and UV but differ elsewhere; far below any texel. */
  NUDGE = 2 ** -36,
  /** A level this far over its ratio missed it. */
  MISSED = 1.5,
  /** Share of a mesh's triangles that must be flat for it to count as flat shaded. */
  FLAT_SHARE = 0.9,
  /** Below this a flat-shaded part keeps its hard edges: a box is its corners. */
  FLAT_FACES = 64;

/** The simplifier refuses faces with no area, on its own scale-free test: corners within a hair, or nearly in line. */
function solid(p: readonly number[], q: readonly number[], r: readonly number[]): boolean {
  const ux = q[0] - p[0],
    uy = q[1] - p[1],
    uz = q[2] - p[2],
    vx = r[0] - p[0],
    vy = r[1] - p[1],
    vz = r[2] - p[2],
    extent = Math.max(Math.abs(ux), Math.abs(uy), Math.abs(uz), Math.abs(vx), Math.abs(vy), Math.abs(vz)),
    size = Math.max(...p.map(Math.abs), ...q.map(Math.abs), ...r.map(Math.abs));
  if (!(extent > 0)) return false;
  const tolerance = Math.max(1e-8, (size * Number.EPSILON * 16) / extent),
    wx = (q[0] - r[0]) / extent,
    wy = (q[1] - r[1]) / extent,
    wz = (q[2] - r[2]) / extent;
  return (
    Math.hypot(ux, uy, uz) / extent > tolerance &&
    Math.hypot(vx, vy, vz) / extent > tolerance &&
    Math.hypot(wx, wy, wz) > tolerance &&
    Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / (extent * extent) > tolerance
  );
}
const sameRecord = (v: Float32Array, a: number, b: number, from: number) => {
  for (let k = from; k < STRIDE; k++) if (v[a * STRIDE + k] !== v[b * STRIDE + k]) return false;
  return true;
};
/** True when nearly every triangle has one normal on all its corners: flat shading, where every edge is a hard one. */
function faceted(v: Float32Array, indices: Uint32Array): boolean {
  let flat = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * STRIDE, indices[t + 1] * STRIDE, indices[t + 2] * STRIDE];
    let same = true;
    for (let k = 4; k < 7; k++) same &&= Math.abs(v[a + k] - v[b + k]) < 1e-3 && Math.abs(v[a + k] - v[c + k]) < 1e-3;
    if (same) flat++;
  }
  return flat >= (indices.length / 3) * FLAT_SHARE;
}
/** A level's triangles as flat shading has them: three vertices each, on the triangle's own normal. */
function flatLevel(
  v: Float32Array,
  faces: readonly (readonly [number, number, number])[],
): Pick<PackedGeometry, 'vertices' | 'indices' | 'sources'> {
  const vertices = new Float32Array(faces.length * 3 * STRIDE),
    sources = new Uint32Array(faces.length * 3);
  faces.forEach((corners, f) => {
    const [a, b, c] = corners.map((i) => i * STRIDE),
      ux = v[b] - v[a],
      uy = v[b + 1] - v[a + 1],
      uz = v[b + 2] - v[a + 2],
      wx = v[c] - v[a],
      wy = v[c + 1] - v[a + 1],
      wz = v[c + 2] - v[a + 2],
      nx = uy * wz - uz * wy,
      ny = uz * wx - ux * wz,
      nz = ux * wy - uy * wx,
      size = Math.hypot(nx, ny, nz);
    corners.forEach((from, k) => {
      const o = (f * 3 + k) * STRIDE;
      sources[f * 3 + k] = from;
      vertices.set(v.subarray(from * STRIDE, (from + 1) * STRIDE), o);
      if (!size) return;
      const x = nx / size,
        y = ny / size,
        z = nz / size;
      vertices[o + 4] = x;
      vertices[o + 5] = y;
      vertices[o + 6] = z;
      // The tangent stays in the new face's plane.
      const along = vertices[o + 8] * x + vertices[o + 9] * y + vertices[o + 10] * z,
        tx = vertices[o + 8] - along * x,
        ty = vertices[o + 9] - along * y,
        tz = vertices[o + 10] - along * z,
        length = Math.hypot(tx, ty, tz);
      if (!length) return;
      vertices[o + 8] = tx / length;
      vertices[o + 9] = ty / length;
      vertices[o + 10] = tz / length;
    });
  });
  return { vertices, indices: Uint32Array.from(sources, (_, i) => i), sources };
}

/**
 * Levels of one packed primitive, one per ratio, each with only the vertices it uses. Vertices that share a position
 * are welded, so UV seams and hard edges cannot open: mesh-edit treats two corners with different UVs as a seam, and
 * a corner that differs in any other attribute gets a UV a hair away, which makes that edge a seam too. Faces that
 * would break the manifold the simplifier needs (a third face on an edge, a flipped neighbour) go on a separate sheet.
 * `apart` names how a vertex deforms: two vertices at one position it tells apart stay apart, as a closed mouth's lips do.
 * A flat-shaded mesh has only hard edges, so nothing could collapse: when a level misses its ratio on one, normals stop
 * counting as a seam and each kept triangle takes its own normal, the one thing in such a level that is not the source's.
 * @throws RangeError past mesh-edit's 200,000 vertices or faces; the `signal`'s reason when it aborts.
 */
export function simplifyPacked(
  modeling: Modeling,
  geometry: PackedGeometry,
  ratios: readonly number[],
  signal?: AbortSignal,
  apart?: (vertex: number) => string,
): PackedGeometry[] {
  const levels = levelChain(modeling, geometry, ratios, false, signal, apart),
    { vertices, indices } = geometry,
    faces = indices.length / 3,
    missed = levels.some((level, i) => level.indices.length / 3 > faces * ratios[i] * MISSED);
  return missed && faces >= FLAT_FACES && faceted(vertices, indices)
    ? levelChain(modeling, geometry, ratios, true, signal, apart)
    : levels;
}
function levelChain(
  modeling: Modeling,
  { vertices: v, indices }: PackedGeometry,
  ratios: readonly number[],
  flat: boolean,
  signal?: AbortSignal,
  apart?: (vertex: number) => string,
): PackedGeometry[] {
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  for (let i = 0; i < indices.length; i++) {
    const o = indices[i] * STRIDE;
    minU = Math.min(minU, v[o + 12]);
    maxU = Math.max(maxU, v[o + 12]);
    minV = Math.min(minV, v[o + 13]);
    maxV = Math.max(maxV, v[o + 13]);
  }
  // mesh-edit holds UVs in 0 to 1; tiled ones scale down, which keeps their orientation for its flip test.
  const su = 0.99 / (maxU - minU || 1),
    sv = 0.99 / (maxV - minV || 1),
    sheets: Map<string, number>[] = Array.from({ length: SHEETS }, () => new Map()),
    points: MutableVec3[] = [],
    edges = new Map<string, number>(),
    records = new Map<string, number[]>(),
    corners = new Map<string, number>(),
    faces: { id: string; vertices: number[]; uv: MutableVec2[] }[] = [];
  const point = (i: number) => [v[i * STRIDE], v[i * STRIDE + 1], v[i * STRIDE + 2]];
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  /** Bit 0 and 1: the a-to-b and b-to-a directions are taken. */
  const free = (a: number, b: number) => {
    const used = edges.get(edgeKey(a, b)) ?? 0;
    return a !== b && !(used & (a < b ? 1 : 2));
  };
  const claim = (a: number, b: number) => {
    const key = edgeKey(a, b);
    edges.set(key, (edges.get(key) ?? 0) | (a < b ? 1 : 2));
  };
  const corner = (welded: number, i: number): MutableVec2 => {
    const o = i * STRIDE,
      key = `${welded}|${v[o + 12]}|${v[o + 13]}`;
    let list = records.get(key);
    if (!list) records.set(key, (list = []));
    let k = list.findIndex((other) => sameRecord(v, other, i, flat ? 12 : 4));
    if (k < 0) k = list.push(i) - 1;
    const uv: MutableVec2 = [(v[o + 12] - minU) * su + k * NUDGE, (v[o + 13] - minV) * sv];
    corners.set(`${welded}|${uv[0]}|${uv[1]}`, list[k]);
    return uv;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const source = [indices[t], indices[t + 1], indices[t + 2]],
      [p, q, r] = source.map(point);
    if (!solid(p, q, r)) continue;
    const keys = [p, q, r].map((c, k) => (apart ? `${c.join()}|${apart(source[k])}` : c.join()));
    let ids: number[] | undefined;
    for (const sheet of sheets) {
      const trial = keys.map((key) => sheet.get(key) ?? -1 - keys.indexOf(key));
      if (free(trial[0], trial[1]) && free(trial[1], trial[2]) && free(trial[2], trial[0])) {
        ids = keys.map((key, k) => {
          let id = sheet.get(key);
          if (id === undefined) {
            sheet.set(key, (id = points.length));
            points.push(point(source[k]) as MutableVec3);
          }
          return id;
        });
        break;
      }
    }
    ids ??= source.map((i) => points.push(point(i) as MutableVec3) - 1);
    claim(ids[0], ids[1]);
    claim(ids[1], ids[2]);
    claim(ids[2], ids[0]);
    faces.push({ id: `f${t / 3}`, vertices: ids, uv: ids.map((id, k) => corner(id, source[k])) });
  }
  if (!faces.length) return ratios.map(() => ({ vertices: v, indices }));
  let welded = points.map((_, i) => i),
    last: PackedGeometry = { vertices: v, indices };
  return modeling
    .meshLODChain({ vertices: points, faces }, { ratios, mergeCoplanar: false, signal })
    .map(({ mesh, sourceVertices }) => {
      const ids = sourceVertices.map((i) => welded[i]);
      welded = ids;
      // A part too small to reach the ratio keeps its last triangles, so no level loses it.
      if (!mesh.faces.length) return last;
      if (flat)
        return (last = flatLevel(
          v,
          mesh.faces.map((face) => {
            const corner = (k: number) => corners.get(`${ids[face.vertices[k]]}|${face.uv[k][0]}|${face.uv[k][1]}`)!;
            return [corner(0), corner(1), corner(2)] as const;
          }),
        ));
      const remap = new Map<number, number>(),
        order: number[] = [],
        out = new Uint32Array(mesh.faces.length * 3);
      mesh.faces.forEach((face, f) =>
        face.vertices.forEach((id, k) => {
          const uv = face.uv[k],
            from = corners.get(`${ids[id]}|${uv[0]}|${uv[1]}`)!;
          let to = remap.get(from);
          if (to === undefined) {
            remap.set(from, (to = order.length));
            order.push(from);
          }
          out[f * 3 + k] = to;
        }),
      );
      const kept = new Float32Array(order.length * STRIDE);
      order.forEach((from, i) => kept.set(v.subarray(from * STRIDE, (from + 1) * STRIDE), i * STRIDE));
      return (last = { vertices: kept, indices: out, sources: Uint32Array.from(order) });
    });
}
