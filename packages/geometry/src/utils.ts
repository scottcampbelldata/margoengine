import type { GeometryData, GeometryGroup } from './data.js';
import type { MutableVec3 } from './math.js';
import { splitTangents } from './tangent-split.js';

const clone = (data: GeometryData, changes: Partial<GeometryData>): GeometryData => {
  const out: GeometryData = {
    positions: data.positions,
    normals: data.normals,
    uvs: data.uvs,
    indices: data.indices,
    ...changes,
  };
  if (!('tangents' in changes) && data.tangents) out.tangents = data.tangents;
  if (!('groups' in changes) && data.groups) out.groups = data.groups.map((g) => ({ ...g }));
  if (!out.tangents) delete out.tangents;
  if (!out.groups) delete out.groups;
  return out;
};

/**
 * Concatenates geometries. Tangents survive only when every input
 * has them. With `useGroups`, each input becomes one group whose `materialIndex` is its position in the list;
 * otherwise input groups are kept with their offsets shifted.
 */
export function mergeGeometries(list: readonly GeometryData[], useGroups = false): GeometryData {
  let vertices = 0,
    indexCount = 0;
  for (const g of list) {
    vertices += g.positions.length / 3;
    indexCount += g.indices.length;
  }
  const withTangents = list.length > 0 && list.every((g) => g.tangents);
  const positions = new Float32Array(vertices * 3),
    normals = new Float32Array(vertices * 3),
    uvs = new Float32Array(vertices * 2),
    indices = new Uint32Array(indexCount);
  const tangents = withTangents ? new Float32Array(vertices * 4) : undefined;
  const groups: GeometryGroup[] = [];
  let v = 0,
    i = 0;
  list.forEach((g, n) => {
    positions.set(g.positions, v * 3);
    normals.set(g.normals, v * 3);
    uvs.set(g.uvs, v * 2);
    if (tangents) tangents.set(g.tangents!, v * 4);
    for (let k = 0; k < g.indices.length; k++) indices[i + k] = g.indices[k] + v;
    if (useGroups) groups.push({ start: i, count: g.indices.length, materialIndex: n });
    else for (const group of g.groups ?? []) groups.push({ ...group, start: group.start + i });
    v += g.positions.length / 3;
    i += g.indices.length;
  });
  const out: GeometryData = { positions, normals, uvs, indices };
  if (tangents) out.tangents = tangents;
  if (groups.length) out.groups = groups;
  return out;
}

/** Options for `mergeVertices`. */
export interface MergeVerticesOptions {
  /** Maximum per-component difference for two vertices to merge. Default 1e-4. */
  tolerance?: number;
  /** Merge on position alone, keeping the first vertex's normal, UV and tangent. Default false (all attributes must match). */
  positionOnly?: boolean;
  /** Drop triangles that collapse to a line or point after welding. Default false. */
  removeDegenerate?: boolean;
}

/**
 * Welds vertices that are within `tolerance`. Uses a spatial hash with
 * neighbor-cell lookup, so vertices on either side of a cell boundary still merge. Triangle order is preserved.
 */
export function mergeVertices(data: GeometryData, options: MergeVerticesOptions = {}): GeometryData {
  const tolerance = options.tolerance ?? 1e-4,
    positionOnly = options.positionOnly ?? false;
  const count = data.positions.length / 3,
    cell = Math.max(tolerance, 1e-12) * 2;
  const P = data.positions,
    N = data.normals,
    UV = data.uvs,
    T = data.tangents;
  // Buckets are keyed by an integer hash of the cell. Each kept vertex remembers its exact cell, so vertices from
  // other cells that share a hash are skipped and the candidates seen are the same as with one bucket per cell.
  const buckets = new Map<number, number[]>(),
    remap = new Uint32Array(count),
    kept: number[] = [],
    keptX: number[] = [],
    keptY: number[] = [],
    keptZ: number[] = [];
  const near = (a: Float32Array, i: number, j: number, size: number) => {
    for (let k = 0; k < size; k++) if (Math.abs(a[i * size + k] - a[j * size + k]) > tolerance) return false;
    return true;
  };
  const sameCell = (a: number, b: number) => a === b || (a !== a && b !== b);
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(P[i * 3] / cell),
      cy = Math.floor(P[i * 3 + 1] / cell),
      cz = Math.floor(P[i * 3 + 2] / cell);
    let match = -1;
    search: for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const x = cx + dx,
          y = cy + dy,
          hash = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
        for (let dz = -1; dz <= 1; dz++) {
          const z = cz + dz,
            bucket = buckets.get(hash ^ Math.imul(z, 83492791));
          if (!bucket) continue;
          for (let n = 0; n < bucket.length; n++) {
            const j = bucket[n],
              original = kept[j];
            if (!sameCell(keptX[j], x) || !sameCell(keptY[j], y) || !sameCell(keptZ[j], z) || !near(P, i, original, 3))
              continue;
            if (
              !positionOnly &&
              (!near(N, i, original, 3) || !near(UV, i, original, 2) || (T && !near(T, i, original, 4)))
            )
              continue;
            match = j;
            break search;
          }
        }
      }
    if (match < 0) {
      match = kept.length;
      kept.push(i);
      keptX.push(cx);
      keptY.push(cy);
      keptZ.push(cz);
      const key = Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791),
        bucket = buckets.get(key);
      if (bucket) bucket.push(match);
      else buckets.set(key, [match]);
    }
    remap[i] = match;
  }
  const pick = (a: Float32Array, size: number) => {
    const out = new Float32Array(kept.length * size);
    for (let n = 0; n < kept.length; n++) {
      const o = kept[n] * size;
      for (let k = 0; k < size; k++) out[n * size + k] = a[o + k];
    }
    return out;
  };
  let indices = new Uint32Array(data.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[data.indices[i]];
  let groups = data.groups?.map((g) => ({ ...g }));
  if (options.removeDegenerate) {
    const keep: number[] = [];
    const newGroups = groups?.map((g) => ({ ...g, start: 0, count: 0 }));
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t],
        b = indices[t + 1],
        c = indices[t + 2];
      if (a === b || b === c || a === c) continue;
      if (newGroups && groups)
        groups.forEach((g, gi) => {
          if (t >= g.start && t < g.start + g.count) newGroups[gi].count += 3;
        });
      keep.push(a, b, c);
    }
    if (newGroups) {
      let s = 0;
      for (const g of newGroups) {
        g.start = s;
        s += g.count;
      }
      groups = newGroups;
    }
    indices = Uint32Array.from(keep);
  }
  const out: GeometryData = { positions: pick(P, 3), normals: pick(N, 3), uvs: pick(UV, 2), indices };
  if (T) out.tangents = pick(T, 4);
  if (groups) out.groups = groups;
  return out;
}

/** Expands indexed geometry so every triangle corner has its own vertex; indices become sequential. */
export function toNonIndexed(data: GeometryData): GeometryData {
  const n = data.indices.length,
    positions = new Float32Array(n * 3),
    normals = new Float32Array(n * 3),
    uvs = new Float32Array(n * 2),
    indices = new Uint32Array(n);
  const tangents = data.tangents ? new Float32Array(n * 4) : undefined;
  const P = data.positions,
    N = data.normals,
    UV = data.uvs,
    T = data.tangents;
  // Vertices every attribute fully covers are copied element by element; an index past the end keeps the partial-copy path.
  const covered = Math.min(
    Math.floor(P.length / 3),
    Math.floor(N.length / 3),
    Math.floor(UV.length / 2),
    T ? Math.floor(T.length / 4) : Infinity,
  );
  for (let i = 0; i < n; i++) {
    const v = data.indices[i],
      s = v * 3,
      d = i * 3;
    indices[i] = i;
    if (v < covered) {
      positions[d] = P[s];
      positions[d + 1] = P[s + 1];
      positions[d + 2] = P[s + 2];
      normals[d] = N[s];
      normals[d + 1] = N[s + 1];
      normals[d + 2] = N[s + 2];
      uvs[i * 2] = UV[v * 2];
      uvs[i * 2 + 1] = UV[v * 2 + 1];
      if (tangents) {
        tangents[i * 4] = T![v * 4];
        tangents[i * 4 + 1] = T![v * 4 + 1];
        tangents[i * 4 + 2] = T![v * 4 + 2];
        tangents[i * 4 + 3] = T![v * 4 + 3];
      }
      continue;
    }
    positions.set(P.subarray(s, s + 3), d);
    normals.set(N.subarray(s, s + 3), d);
    uvs.set(UV.subarray(v * 2, v * 2 + 2), i * 2);
    if (tangents) tangents.set(T!.subarray(v * 4, v * 4 + 4), i * 4);
  }
  return clone(data, { positions, normals, uvs, indices, tangents });
}

const angles = new Float64Array(3);
/**
 * Interior angles of triangle (a, b, c) at each corner, written to `angles`. Each edge is measured once and shared
 * by the two corners it touches; a zero-length edge gives its corners an angle of 0.
 */
function corners(P: ArrayLike<number>, a: number, b: number, c: number): void {
  const ux = P[b * 3] - P[a * 3],
    uy = P[b * 3 + 1] - P[a * 3 + 1],
    uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3],
    vy = P[c * 3 + 1] - P[a * 3 + 1],
    vz = P[c * 3 + 2] - P[a * 3 + 2];
  const wx = P[c * 3] - P[b * 3],
    wy = P[c * 3 + 1] - P[b * 3 + 1],
    wz = P[c * 3 + 2] - P[b * 3 + 2];
  const lu = Math.hypot(ux, uy, uz),
    lv = Math.hypot(vx, vy, vz),
    lw = Math.hypot(wx, wy, wz);
  angles[0] = !lu || !lv ? 0 : Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / (lu * lv))));
  // At b the edges are w and -u; at c they are -v and -w.
  angles[1] = !lw || !lu ? 0 : Math.acos(Math.min(1, Math.max(-1, -(wx * ux + wy * uy + wz * uz) / (lw * lu))));
  angles[2] = !lv || !lw ? 0 : Math.acos(Math.min(1, Math.max(-1, (vx * wx + vy * wy + vz * wz) / (lv * lw))));
}

/**
 * Smooth vertex normals, each face normal weighted by the triangle's angle at that corner (less sensitive to
 * tessellation than area weighting). Vertices are not welded first; weld with `mergeVertices` for smooth
 * shading across UV seams.
 */
export function computeVertexNormals(data: GeometryData): GeometryData {
  const P = data.positions,
    I = data.indices,
    acc = new Float64Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t],
      b = I[t + 1],
      c = I[t + 2];
    const e1x = P[b * 3] - P[a * 3],
      e1y = P[b * 3 + 1] - P[a * 3 + 1],
      e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3],
      e2y = P[c * 3 + 1] - P[a * 3 + 1],
      e2z = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (!l) continue;
    nx /= l;
    ny /= l;
    nz /= l;
    corners(P, a, b, c);
    for (let k = 0; k < 3; k++) {
      const v = I[t + k] * 3,
        w = angles[k];
      acc[v] += nx * w;
      acc[v + 1] += ny * w;
      acc[v + 2] += nz * w;
    }
  }
  const normals = new Float32Array(P.length);
  for (let v = 0; v < P.length; v += 3) {
    const l = Math.hypot(acc[v], acc[v + 1], acc[v + 2]);
    if (l) {
      normals[v] = acc[v] / l;
      normals[v + 1] = acc[v + 1] / l;
      normals[v + 2] = acc[v + 2] / l;
    } else {
      normals[v] = data.normals[v];
      normals[v + 1] = data.normals[v + 1];
      normals[v + 2] = data.normals[v + 2];
    }
  }
  return clone(data, { normals });
}

/** Options for `creasedNormals`. */
export interface CreasedNormalsOptions {
  /** Triangle vertex indices. Omitted, every three vertices form a triangle (one vertex per corner). */
  indices?: ArrayLike<number> | null;
  /** Faces whose normals differ by more than this many degrees keep separate normals: 0 is flat, 180 fully smooth. Default 180. */
  angle?: number;
  /** One smoothing group id per triangle; only triangles with equal ids smooth together. Omitted, all share one group. */
  groups?: ArrayLike<number> | null;
  /** Maximum per-component difference for two corners to count as the same position. Default 1e-4. */
  tolerance?: number;
}

/**
 * Vertex normals with a crease angle and smoothing groups (Crocotile's Flat/Smooth vertex normals).
 * Each triangle corner averages, weighted by corner angle like `computeVertexNormals`, the face
 * normals of the triangles that touch the same position (within `tolerance`), are in the same smoothing group and are
 * within `angle` degrees of its own face. Made for meshes that store one vertex per corner (tiles); a vertex shared by
 * several triangles gets the average of its corners. Zero-area triangles add nothing, and a vertex used only by them
 * gets [0, 0, 0]. Works on plain arrays, so it serves `GeometryData` and any `{positions, indices?}` mesh.
 */
export function creasedNormals(positions: ArrayLike<number>, options: CreasedNormalsOptions = {}): Float32Array {
  const { indices, angle = 180, groups, tolerance = 1e-4 } = options,
    count = positions.length / 3,
    cornerCount = indices ? indices.length : count;
  if (!Number.isInteger(count) || cornerCount % 3)
    throw new RangeError('creasedNormals positions/indices must hold whole triangles; pass xyz per vertex, 3 per face');
  if (!(angle >= 0 && angle <= 180)) throw new RangeError('creasedNormals angle must be 0..180 degrees');
  if (!(tolerance >= 0 && tolerance < Infinity))
    throw new RangeError('creasedNormals tolerance must be finite and >= 0');
  const triangles = cornerCount / 3;
  if (groups && groups.length !== triangles)
    throw new RangeError('creasedNormals groups must have one id per triangle');
  const P = positions instanceof Float32Array ? positions : Float32Array.from(positions),
    vertexOf = new Uint32Array(cornerCount);
  for (let c = 0; c < cornerCount; c++) {
    const v = indices ? indices[c] : c;
    if (!(Number.isInteger(v) && v >= 0 && v < count))
      throw new RangeError('creasedNormals index out of range; indices must address positions');
    vertexOf[c] = v;
  }
  // Welding on position alone maps every corner to one id per distinct position.
  const welded = mergeVertices(
      { positions: P, normals: new Float32Array(0), uvs: new Float32Array(0), indices: vertexOf },
      { tolerance, positionOnly: true },
    ),
    weld = welded.indices,
    ids = welded.positions.length / 3;
  // Unit face normals (0 for zero-area faces) and corner angles.
  const face = new Float64Array(triangles * 3),
    weight = new Float64Array(cornerCount);
  for (let t = 0; t < triangles; t++) {
    const a = vertexOf[t * 3],
      b = vertexOf[t * 3 + 1],
      c = vertexOf[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3],
      uy = P[b * 3 + 1] - P[a * 3 + 1],
      uz = P[b * 3 + 2] - P[a * 3 + 2],
      vx = P[c * 3] - P[a * 3],
      vy = P[c * 3 + 1] - P[a * 3 + 1],
      vz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      l = Math.hypot(nx, ny, nz);
    // Collinear float32 corners leave rounding noise in the cross product, so zero area is relative to the edges.
    if (!(l > 1e-6 * Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz))) continue;
    face[t * 3] = nx / l;
    face[t * 3 + 1] = ny / l;
    face[t * 3 + 2] = nz / l;
    corners(P, a, b, c);
    weight[t * 3] = angles[0];
    weight[t * 3 + 1] = angles[1];
    weight[t * 3 + 2] = angles[2];
  }
  // Corners grouped by welded position (counting sort).
  const start = new Uint32Array(ids + 1),
    order = new Uint32Array(cornerCount);
  for (let c = 0; c < cornerCount; c++) start[weld[c] + 1]++;
  for (let i = 0; i < ids; i++) start[i + 1] += start[i];
  const fill = start.slice(0, ids);
  for (let c = 0; c < cornerCount; c++) order[fill[weld[c]]++] = c;
  // The small slack keeps exactly-at-threshold creases (and coplanar faces at angle 0) smooth despite rounding.
  const limit = Math.cos((angle * Math.PI) / 180) - 1e-6,
    acc = new Float64Array(count * 3);
  for (let c = 0; c < cornerCount; c++) {
    const t = (c / 3) | 0,
      fx = face[t * 3],
      fy = face[t * 3 + 1],
      fz = face[t * 3 + 2];
    if (!fx && !fy && !fz) continue;
    let sx = 0,
      sy = 0,
      sz = 0;
    for (let k = start[weld[c]]; k < start[weld[c] + 1]; k++) {
      const o = order[k],
        u = (o / 3) | 0,
        gx = face[u * 3],
        gy = face[u * 3 + 1],
        gz = face[u * 3 + 2];
      if ((groups && groups[u] !== groups[t]) || fx * gx + fy * gy + fz * gz < limit) continue;
      sx += gx * weight[o];
      sy += gy * weight[o];
      sz += gz * weight[o];
    }
    const l = Math.hypot(sx, sy, sz) || 1,
      v = vertexOf[c] * 3;
    acc[v] += sx / l;
    acc[v + 1] += sy / l;
    acc[v + 2] += sz / l;
  }
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(acc[v], acc[v + 1], acc[v + 2]);
    if (!l) continue;
    normals[v] = acc[v] / l;
    normals[v + 1] = acc[v + 1] / l;
    normals[v + 2] = acc[v + 2] / l;
  }
  return normals;
}

export { splitTangents, type SplitTangents } from './tangent-split.js';
export {
  bakeMorphTargets,
  bakeSkin,
  deinterleaveAttributes,
  estimateMemory,
  interleaveAttributes,
  mergeGroups,
  triangleFanToTriangles,
  triangleStripToTriangles,
  type InterleavedBuffer,
  type InterleaveInput,
  type MemoryEstimate,
  type MorphTargetData,
  type SkinData,
} from './mesh-utils.js';

/**
 * Per-vertex tangents (xyzw, w = bitangent sign) following the MikkTSpace recipe: per-triangle UV derivatives,
 * projected onto each vertex normal's plane, normalized and weighted by the corner angle, then Gram-Schmidt
 * orthogonalized. Matches MikkTSpace on meshes already split at UV seams and mirror lines (as glTF and all
 * primitives here are). With `split` it splits vertices where the tangent frame breaks, through {@link splitTangents},
 * so any mesh matches MikkTSpace; the result may then hold more vertices. `w` follows UVs with v up, as the primitives
 * have them; UVs stored v down, as in glTF files, give the opposite `w`.
 *
 * @param data - The mesh, with normals and UVs.
 * @param options - `split`: add vertices where the frame breaks. Default false.
 */
export function computeTangents(data: GeometryData, options: { split?: boolean } = {}): GeometryData {
  if (options.split) return splitTangents(data).data;
  const P = data.positions,
    N = data.normals,
    UV = data.uvs,
    I = data.indices,
    count = P.length / 3;
  const tan = new Float64Array(count * 3),
    bit = new Float64Array(count * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t],
      b = I[t + 1],
      c = I[t + 2];
    const e1x = P[b * 3] - P[a * 3],
      e1y = P[b * 3 + 1] - P[a * 3 + 1],
      e1z = P[b * 3 + 2] - P[a * 3 + 2],
      e2x = P[c * 3] - P[a * 3],
      e2y = P[c * 3 + 1] - P[a * 3 + 1],
      e2z = P[c * 3 + 2] - P[a * 3 + 2];
    const du1 = UV[b * 2] - UV[a * 2],
      dv1 = UV[b * 2 + 1] - UV[a * 2 + 1],
      du2 = UV[c * 2] - UV[a * 2],
      dv2 = UV[c * 2 + 1] - UV[a * 2 + 1];
    const r = du1 * dv2 - du2 * dv1;
    if (!r || !Number.isFinite(r)) continue;
    // s and q are the triangle's UV-space tangent and bitangent.
    const sx = (e1x * dv2 - e2x * dv1) / r,
      sy = (e1y * dv2 - e2y * dv1) / r,
      sz = (e1z * dv2 - e2z * dv1) / r,
      qx = (e2x * du1 - e1x * du2) / r,
      qy = (e2y * du1 - e1y * du2) / r,
      qz = (e2z * du1 - e1z * du2) / r;
    corners(P, a, b, c);
    for (let k = 0; k < 3; k++) {
      const v = I[t + k] * 3,
        w = angles[k];
      if (!w) continue;
      const nx = N[v],
        ny = N[v + 1],
        nz = N[v + 2];
      let d = sx * nx + sy * ny + sz * nz,
        px = sx - nx * d,
        py = sy - ny * d,
        pz = sz - nz * d,
        l = Math.hypot(px, py, pz);
      if (l) {
        tan[v] += (px / l) * w;
        tan[v + 1] += (py / l) * w;
        tan[v + 2] += (pz / l) * w;
      }
      d = qx * nx + qy * ny + qz * nz;
      px = qx - nx * d;
      py = qy - ny * d;
      pz = qz - nz * d;
      l = Math.hypot(px, py, pz);
      if (l) {
        bit[v] += (px / l) * w;
        bit[v + 1] += (py / l) * w;
        bit[v + 2] += (pz / l) * w;
      }
    }
  }
  const tangents = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const nx = N[v * 3],
      ny = N[v * 3 + 1],
      nz = N[v * 3 + 2];
    let tx = tan[v * 3],
      ty = tan[v * 3 + 1],
      tz = tan[v * 3 + 2];
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d;
    ty -= ny * d;
    tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-12) {
      // No UV gradient here: any unit vector perpendicular to the normal.
      if (Math.abs(nx) < 0.9) {
        tx = 0;
        ty = nz;
        tz = -ny;
      } else {
        tx = -nz;
        ty = 0;
        tz = nx;
      }
      const e = tx * nx + ty * ny + tz * nz;
      tx -= nx * e;
      ty -= ny * e;
      tz -= nz * e;
      l = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= l;
    ty /= l;
    tz /= l;
    const cx = ny * tz - nz * ty,
      cy = nz * tx - nx * tz,
      cz = nx * ty - ny * tx;
    const w = cx * bit[v * 3] + cy * bit[v * 3 + 1] + cz * bit[v * 3 + 2] < 0 ? -1 : 1;
    tangents[v * 4] = tx;
    tangents[v * 4 + 1] = ty;
    tangents[v * 4 + 2] = tz;
    tangents[v * 4 + 3] = w;
  }
  return clone(data, { tangents });
}

/**
 * Transforms by a column-major 4x4 matrix. Normals use the inverse-transpose of the upper 3x3 and are renormalized;
 * tangents use the upper 3x3. A mirroring matrix (negative determinant) also flips triangle winding and the tangent
 * sign so faces stay outward-facing.
 */
export function applyMatrix4(data: GeometryData, m: ArrayLike<number>): GeometryData {
  if (m.length !== 16) throw new RangeError('Expected a 4x4 matrix with 16 values');
  // Row r, column c of the column-major matrix is m[c * 4 + r].
  const m00 = m[0],
    m10 = m[1],
    m20 = m[2],
    m30 = m[3],
    m01 = m[4],
    m11 = m[5],
    m21 = m[6],
    m31 = m[7],
    m02 = m[8],
    m12 = m[9],
    m22 = m[10],
    m32 = m[11],
    m03 = m[12],
    m13 = m[13],
    m23 = m[14],
    m33 = m[15];
  // cRC is the cofactor C(r, c) of the upper 3x3; inverse-transpose = C / det.
  const c00 = m11 * m22 - m12 * m21,
    c01 = m12 * m20 - m10 * m22,
    c02 = m10 * m21 - m11 * m20;
  const c10 = m02 * m21 - m01 * m22,
    c11 = m00 * m22 - m02 * m20,
    c12 = m01 * m20 - m00 * m21;
  const c20 = m01 * m12 - m02 * m11,
    c21 = m02 * m10 - m00 * m12,
    c22 = m00 * m11 - m01 * m10;
  const det = m00 * c00 + m01 * c01 + m02 * c02;
  if (!det || !Number.isFinite(det))
    throw new RangeError('Matrix upper 3x3 is singular; pass a matrix with a non-zero determinant');
  const positions = new Float32Array(data.positions.length),
    normals = new Float32Array(data.normals.length),
    P = data.positions,
    N = data.normals;
  for (let i = 0; i < positions.length; i += 3) {
    const x = P[i],
      y = P[i + 1],
      z = P[i + 2];
    const w = m30 * x + m31 * y + m32 * z + m33 || 1;
    positions[i] = (m00 * x + m01 * y + m02 * z + m03) / w;
    positions[i + 1] = (m10 * x + m11 * y + m12 * z + m13) / w;
    positions[i + 2] = (m20 * x + m21 * y + m22 * z + m23) / w;
    const nx = N[i],
      ny = N[i + 1],
      nz = N[i + 2];
    const n0 = (c00 * nx + c01 * ny + c02 * nz) / det,
      n1 = (c10 * nx + c11 * ny + c12 * nz) / det,
      n2 = (c20 * nx + c21 * ny + c22 * nz) / det,
      l = Math.hypot(n0, n1, n2) || 1;
    normals[i] = n0 / l;
    normals[i + 1] = n1 / l;
    normals[i + 2] = n2 / l;
  }
  let tangents: Float32Array | undefined;
  if (data.tangents) {
    const T = data.tangents,
      sign = Math.sign(det);
    tangents = new Float32Array(T.length);
    for (let i = 0; i < tangents.length; i += 4) {
      const x = T[i],
        y = T[i + 1],
        z = T[i + 2],
        t0 = m00 * x + m01 * y + m02 * z,
        t1 = m10 * x + m11 * y + m12 * z,
        t2 = m20 * x + m21 * y + m22 * z,
        l = Math.hypot(t0, t1, t2) || 1;
      tangents[i] = t0 / l;
      tangents[i + 1] = t1 / l;
      tangents[i + 2] = t2 / l;
      tangents[i + 3] = T[i + 3] * sign;
    }
  }
  let indices = data.indices;
  if (det < 0) {
    indices = Uint32Array.from(data.indices);
    for (let t = 0; t < indices.length; t += 3) {
      const s = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = s;
    }
  }
  return clone(data, { positions, normals, indices, tangents });
}

/** Axis-aligned bounds of the positions. Empty geometry gives infinite min and negative-infinite max. */
export function computeBoundingBox(data: GeometryData): { min: MutableVec3; max: MutableVec3 } {
  const min: MutableVec3 = [Infinity, Infinity, Infinity],
    max: MutableVec3 = [-Infinity, -Infinity, -Infinity],
    P = data.positions;
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k]);
      max[k] = Math.max(max[k], P[i + k]);
    }
  return { min, max };
}

/** Bounding sphere centered on the box center. */
export function computeBoundingSphere(data: GeometryData): { center: MutableVec3; radius: number } {
  const { min, max } = computeBoundingBox(data),
    P = data.positions;
  if (!P.length) return { center: [0, 0, 0], radius: 0 };
  const center: MutableVec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < P.length; i += 3)
    r2 = Math.max(r2, (P[i] - center[0]) ** 2 + (P[i + 1] - center[1]) ** 2 + (P[i + 2] - center[2]) ** 2);
  return { center, radius: Math.sqrt(r2) };
}

/** Translates so the bounding box center is at the origin; returns new data. */
export function center(data: GeometryData): GeometryData {
  const { min, max } = computeBoundingBox(data),
    c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2),
    positions = Float32Array.from(data.positions);
  if (positions.length)
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] -= c[k];
  return clone(data, { positions });
}

/**
 * Feature edges of a triangle mesh: every edge whose two faces meet at an angle of at least `thresholdAngle` degrees
 * (faces exactly at the threshold count), plus every boundary edge (used by one face). Vertex positions are welded
 * on a 1e-4 grid (rounded to four decimal places), so meshes split at UV or normal seams still pair their faces.
 * Faces with two corners at the same welded point are skipped. Reads only `data.positions` and `data.indices`.
 * Returns line index pairs into `data.positions`; never throws.
 *
 * Non-manifold rule: an edge pairs its first face with the next face that uses it in the opposite direction; a face
 * repeating the direction of a still-open edge is ignored for that edge, and a face on an already-paired edge opens
 * a new entry, which ends up as a boundary if nothing closes it.
 */
export function edgesGeometry(data: GeometryData, thresholdAngle = 1): Uint32Array {
  const P = data.positions,
    I = data.indices,
    // Tiny slack so coplanar faces still count at a threshold of 0 despite rounding in the normals.
    limit = Math.cos((thresholdAngle * Math.PI) / 180) + 1e-9,
    weldOf = new Map<string, number>(),
    welded = new Uint32Array(P.length / 3);
  for (let v = 0; v < welded.length; v++) {
    const key = `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`;
    let id = weldOf.get(key);
    if (id === undefined) weldOf.set(key, (id = weldOf.size));
    welded[v] = id;
  }
  const span = weldOf.size,
    // Open edges by undirected welded key: [face, from vertex, to vertex, from welded id].
    open = new Map<number, [number, number, number, number]>(),
    normals: number[] = [],
    out: number[] = [];
  for (let t = 0, face = 0; t + 2 < I.length; t += 3) {
    const a = I[t],
      b = I[t + 1],
      c = I[t + 2],
      wa = welded[a],
      wb = welded[b],
      wc = welded[c];
    if (wa === wb || wb === wc || wc === wa || wa === undefined || wb === undefined || wc === undefined) continue;
    const ux = P[b * 3] - P[a * 3],
      uy = P[b * 3 + 1] - P[a * 3 + 1],
      uz = P[b * 3 + 2] - P[a * 3 + 2],
      vx = P[c * 3] - P[a * 3],
      vy = P[c * 3 + 1] - P[a * 3 + 1],
      vz = P[c * 3 + 2] - P[a * 3 + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      len = Math.hypot(nx, ny, nz) || 1;
    normals.push(nx / len, ny / len, nz / len);
    const corners = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const from = corners[k],
        to = corners[(k + 1) % 3],
        wf = welded[from],
        wt = welded[to],
        key = wf < wt ? wf * span + wt : wt * span + wf,
        entry = open.get(key);
      if (!entry) {
        open.set(key, [face, from, to, wf]);
        continue;
      }
      if (entry[3] === wf) continue; // same direction as the open face: not a manifold partner
      open.delete(key);
      const f = entry[0] * 3,
        g = face * 3,
        dot = normals[f] * normals[g] + normals[f + 1] * normals[g + 1] + normals[f + 2] * normals[g + 2];
      if (dot <= limit) out.push(entry[1], entry[2]);
    }
    face++;
  }
  for (const entry of open.values()) out.push(entry[1], entry[2]);
  return Uint32Array.from(out);
}

/** Every distinct triangle edge once, as line index pairs into `data.positions`. */
export function wireframe(data: GeometryData): Uint32Array {
  const seen = new Set<number>(),
    out: number[] = [],
    I = data.indices,
    n = data.positions.length / 3;
  for (let t = 0; t < I.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = I[t + k],
        b = I[t + ((k + 1) % 3)],
        lo = Math.min(a, b),
        hi = Math.max(a, b),
        key = lo * n + hi;
      if (lo === hi || seen.has(key)) continue;
      seen.add(key);
      out.push(lo, hi);
    }
  return Uint32Array.from(out);
}

/** Expands distinct triangle edges for line rendering with a vertical lift. */
export function wireframePositions(data: GeometryData, offsetY = 0): Float32Array {
  if (!Number.isFinite(offsetY)) throw new RangeError('Invalid wireframe offset; pass a finite number');
  const edges = wireframe(data),
    positions = new Float32Array(edges.length * 3);
  for (let i = 0; i < edges.length; i++) {
    const source = edges[i] * 3;
    positions[i * 3] = data.positions[source];
    positions[i * 3 + 1] = data.positions[source + 1] + offsetY;
    positions[i * 3 + 2] = data.positions[source + 2];
  }
  return positions;
}
// `@margoengine/geometry/utils` serves this module, so it carries the geometry data helpers too.
export type { GeometryData, GeometryGroup } from './data.js';
export { geometryData, toGeometry, pbrVertexStream, footprintRadius } from './data.js';
