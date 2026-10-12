import type {GeometryData, GeometryGroup} from './data.js';
import type {Vec3} from './math.js';

const clone = (data: GeometryData, changes: Partial<GeometryData>): GeometryData => {
  const out: GeometryData = {positions: data.positions, normals: data.normals, uvs: data.uvs, indices: data.indices, ...changes};
  if (!('tangents' in changes) && data.tangents) out.tangents = data.tangents;
  if (!('groups' in changes) && data.groups) out.groups = data.groups.map(g => ({...g}));
  if (!out.tangents) delete out.tangents;
  if (!out.groups) delete out.groups;
  return out;
};

/**
 * Concatenates geometries (Three.js `BufferGeometryUtils.mergeGeometries`). Tangents survive only when every input
 * has them. With `useGroups`, each input becomes one group whose `materialIndex` is its position in the list;
 * otherwise input groups are kept with their offsets shifted.
 */
export function mergeGeometries(list: readonly GeometryData[], useGroups = false): GeometryData {
  let vertices = 0, indexCount = 0;
  for (const g of list) {vertices += g.positions.length / 3; indexCount += g.indices.length;}
  const withTangents = list.length > 0 && list.every(g => g.tangents);
  const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3), uvs = new Float32Array(vertices * 2), indices = new Uint32Array(indexCount);
  const tangents = withTangents ? new Float32Array(vertices * 4) : undefined;
  const groups: GeometryGroup[] = [];
  let v = 0, i = 0;
  list.forEach((g, n) => {
    positions.set(g.positions, v * 3); normals.set(g.normals, v * 3); uvs.set(g.uvs, v * 2);
    if (tangents) tangents.set(g.tangents!, v * 4);
    for (let k = 0; k < g.indices.length; k++) indices[i + k] = g.indices[k] + v;
    if (useGroups) groups.push({start: i, count: g.indices.length, materialIndex: n});
    else for (const group of g.groups ?? []) groups.push({...group, start: group.start + i});
    v += g.positions.length / 3; i += g.indices.length;
  });
  const out: GeometryData = {positions, normals, uvs, indices};
  if (tangents) out.tangents = tangents;
  if (groups.length) out.groups = groups;
  return out;
}

export interface MergeVerticesOptions {
  /** Maximum per-component difference for two vertices to merge. Default 1e-4. */
  tolerance?: number;
  /** Merge on position alone, keeping the first vertex's normal, UV and tangent. Default false (all attributes must match). */
  positionOnly?: boolean;
  /** Drop triangles that collapse to a line or point after welding. Default false. */
  removeDegenerate?: boolean;
}

/**
 * Welds vertices that are within `tolerance` (Three.js `BufferGeometryUtils.mergeVertices`). Uses a spatial hash with
 * neighbor-cell lookup, so vertices on either side of a cell boundary still merge. Triangle order is preserved.
 */
export function mergeVertices(data: GeometryData, options: MergeVerticesOptions = {}): GeometryData {
  const tolerance = options.tolerance ?? 1e-4, positionOnly = options.positionOnly ?? false;
  const count = data.positions.length / 3, cell = Math.max(tolerance, 1e-12) * 2;
  const P = data.positions, N = data.normals, UV = data.uvs, T = data.tangents;
  const buckets = new Map<string, number[]>(), remap = new Uint32Array(count), kept: number[] = [];
  const near = (a: Float32Array, i: number, j: number, size: number) => {for (let k = 0; k < size; k++) if (Math.abs(a[i * size + k] - a[j * size + k]) > tolerance) return false; return true;};
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(P[i * 3] / cell), cy = Math.floor(P[i * 3 + 1] / cell), cz = Math.floor(P[i * 3 + 2] / cell);
    let match = -1;
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        const original = kept[j];
        if (!near(P, i, original, 3)) continue;
        if (!positionOnly && (!near(N, i, original, 3) || !near(UV, i, original, 2) || (T && !near(T, i, original, 4)))) continue;
        match = j; break search;
      }
    }
    if (match < 0) {
      match = kept.length; kept.push(i);
      const key = `${cx},${cy},${cz}`, bucket = buckets.get(key);
      if (bucket) bucket.push(match); else buckets.set(key, [match]);
    }
    remap[i] = match;
  }
  const pick = (a: Float32Array, size: number) => {const out = new Float32Array(kept.length * size); kept.forEach((o, n) => {for (let k = 0; k < size; k++) out[n * size + k] = a[o * size + k];}); return out;};
  let indices = Uint32Array.from(data.indices, i => remap[i]);
  let groups = data.groups?.map(g => ({...g}));
  if (options.removeDegenerate) {
    const keep: number[] = [];
    const newGroups = groups?.map(g => ({...g, start: 0, count: 0}));
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      if (a === b || b === c || a === c) continue;
      if (newGroups && groups) groups.forEach((g, gi) => {if (t >= g.start && t < g.start + g.count) newGroups[gi].count += 3;});
      keep.push(a, b, c);
    }
    if (newGroups) {let s = 0; for (const g of newGroups) {g.start = s; s += g.count;} groups = newGroups;}
    indices = Uint32Array.from(keep);
  }
  const out: GeometryData = {positions: pick(P, 3), normals: pick(N, 3), uvs: pick(UV, 2), indices};
  if (T) out.tangents = pick(T, 4);
  if (groups) out.groups = groups;
  return out;
}

/** Expands indexed geometry so every triangle corner has its own vertex; indices become sequential. */
export function toNonIndexed(data: GeometryData): GeometryData {
  const n = data.indices.length, positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2), indices = new Uint32Array(n);
  const tangents = data.tangents ? new Float32Array(n * 4) : undefined;
  for (let i = 0; i < n; i++) {
    const v = data.indices[i];
    positions.set(data.positions.subarray(v * 3, v * 3 + 3), i * 3); normals.set(data.normals.subarray(v * 3, v * 3 + 3), i * 3);
    uvs.set(data.uvs.subarray(v * 2, v * 2 + 2), i * 2);
    if (tangents) tangents.set(data.tangents!.subarray(v * 4, v * 4 + 4), i * 4);
    indices[i] = i;
  }
  return clone(data, {positions, normals, uvs, indices, tangents});
}

const corner = (P: Float32Array, a: number, b: number, c: number): number => {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
  if (!lu || !lv) return 0;
  return Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / (lu * lv))));
};

/**
 * Smooth vertex normals, each face normal weighted by the triangle's angle at that corner (less sensitive to
 * tessellation than Three.js area weighting). Vertices are not welded first; weld with `mergeVertices` for smooth
 * shading across UV seams.
 */
export function computeVertexNormals(data: GeometryData): GeometryData {
  const P = data.positions, I = data.indices, acc = new Float64Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (!l) continue;
    nx /= l; ny /= l; nz /= l;
    for (const [v, w] of [[a, corner(P, a, b, c)], [b, corner(P, b, c, a)], [c, corner(P, c, a, b)]]) {acc[v * 3] += nx * w; acc[v * 3 + 1] += ny * w; acc[v * 3 + 2] += nz * w;}
  }
  const normals = new Float32Array(P.length);
  for (let v = 0; v < P.length; v += 3) {
    const l = Math.hypot(acc[v], acc[v + 1], acc[v + 2]);
    if (l) {normals[v] = acc[v] / l; normals[v + 1] = acc[v + 1] / l; normals[v + 2] = acc[v + 2] / l;}
    else {normals[v] = data.normals[v]; normals[v + 1] = data.normals[v + 1]; normals[v + 2] = data.normals[v + 2];}
  }
  return clone(data, {normals});
}

/**
 * Per-vertex tangents (xyzw, w = bitangent sign) following the MikkTSpace recipe: per-triangle UV derivatives,
 * projected onto each vertex normal's plane, normalized and weighted by the corner angle, then Gram-Schmidt
 * orthogonalized. Matches MikkTSpace on meshes already split at UV seams and mirror lines (as glTF and all
 * primitives here are); it does not split vertices itself.
 */
export function computeTangents(data: GeometryData): GeometryData {
  const P = data.positions, N = data.normals, UV = data.uvs, I = data.indices, count = P.length / 3;
  const tan = new Float64Array(count * 3), bit = new Float64Array(count * 3);
  for (let t = 0; t < I.length; t += 3) {
    const tri = [I[t], I[t + 1], I[t + 2]], [a, b, c] = tri;
    const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]], e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const du1 = UV[b * 2] - UV[a * 2], dv1 = UV[b * 2 + 1] - UV[a * 2 + 1], du2 = UV[c * 2] - UV[a * 2], dv2 = UV[c * 2 + 1] - UV[a * 2 + 1];
    const r = du1 * dv2 - du2 * dv1;
    if (!r || !Number.isFinite(r)) continue;
    const s = [0, 1, 2].map(k => (e1[k] * dv2 - e2[k] * dv1) / r), q = [0, 1, 2].map(k => (e2[k] * du1 - e1[k] * du2) / r);
    for (let k = 0; k < 3; k++) {
      const v = tri[k], w = corner(P, v, tri[(k + 1) % 3], tri[(k + 2) % 3]);
      if (!w) continue;
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      for (const [src, dst] of [[s, tan], [q, bit]] as [number[], Float64Array][]) {
        const d = src[0] * nx + src[1] * ny + src[2] * nz, px = src[0] - nx * d, py = src[1] - ny * d, pz = src[2] - nz * d, l = Math.hypot(px, py, pz);
        if (!l) continue;
        dst[v * 3] += px / l * w; dst[v * 3 + 1] += py / l * w; dst[v * 3 + 2] += pz / l * w;
      }
    }
  }
  const tangents = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
    let tx = tan[v * 3], ty = tan[v * 3 + 1], tz = tan[v * 3 + 2];
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d; ty -= ny * d; tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-12) {
      // No UV gradient here: any unit vector perpendicular to the normal.
      if (Math.abs(nx) < 0.9) {tx = 0; ty = nz; tz = -ny;} else {tx = -nz; ty = 0; tz = nx;}
      const e = tx * nx + ty * ny + tz * nz; tx -= nx * e; ty -= ny * e; tz -= nz * e;
      l = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= l; ty /= l; tz /= l;
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    const w = cx * bit[v * 3] + cy * bit[v * 3 + 1] + cz * bit[v * 3 + 2] < 0 ? -1 : 1;
    tangents.set([tx, ty, tz, w], v * 4);
  }
  return clone(data, {tangents});
}

/**
 * Transforms by a column-major 4x4 matrix. Normals use the inverse-transpose of the upper 3x3 and are renormalized;
 * tangents use the upper 3x3. A mirroring matrix (negative determinant) also flips triangle winding and the tangent
 * sign so faces stay outward-facing (Three.js leaves the winding inverted).
 */
export function applyMatrix4(data: GeometryData, m: ArrayLike<number>): GeometryData {
  if (m.length !== 16) throw new RangeError('Expected a 4x4 matrix with 16 values');
  const a = (r: number, c: number) => m[c * 4 + r];
  const cof = [
    a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1), a(1, 2) * a(2, 0) - a(1, 0) * a(2, 2), a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0),
    a(0, 2) * a(2, 1) - a(0, 1) * a(2, 2), a(0, 0) * a(2, 2) - a(0, 2) * a(2, 0), a(0, 1) * a(2, 0) - a(0, 0) * a(2, 1),
    a(0, 1) * a(1, 2) - a(0, 2) * a(1, 1), a(0, 2) * a(1, 0) - a(0, 0) * a(1, 2), a(0, 0) * a(1, 1) - a(0, 1) * a(1, 0),
  ];
  const det = a(0, 0) * cof[0] + a(0, 1) * cof[1] + a(0, 2) * cof[2];
  if (!det || !Number.isFinite(det)) throw new RangeError('Matrix upper 3x3 is singular');
  // cof[r * 3 + c] is the cofactor C(r, c); inverse-transpose = C / det.
  const positions = new Float32Array(data.positions.length), normals = new Float32Array(data.normals.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = data.positions[i], y = data.positions[i + 1], z = data.positions[i + 2];
    const w = a(3, 0) * x + a(3, 1) * y + a(3, 2) * z + a(3, 3) || 1;
    for (let r = 0; r < 3; r++) positions[i + r] = (a(r, 0) * x + a(r, 1) * y + a(r, 2) * z + a(r, 3)) / w;
    const nx = data.normals[i], ny = data.normals[i + 1], nz = data.normals[i + 2], n = [0, 0, 0];
    for (let r = 0; r < 3; r++) n[r] = (cof[r * 3] * nx + cof[r * 3 + 1] * ny + cof[r * 3 + 2] * nz) / det;
    const l = Math.hypot(...n) || 1;
    normals.set([n[0] / l, n[1] / l, n[2] / l], i);
  }
  let tangents: Float32Array | undefined;
  if (data.tangents) {
    tangents = new Float32Array(data.tangents.length);
    for (let i = 0; i < tangents.length; i += 4) {
      const x = data.tangents[i], y = data.tangents[i + 1], z = data.tangents[i + 2], t = [0, 1, 2].map(r => a(r, 0) * x + a(r, 1) * y + a(r, 2) * z), l = Math.hypot(...t) || 1;
      tangents.set([t[0] / l, t[1] / l, t[2] / l, data.tangents[i + 3] * Math.sign(det)], i);
    }
  }
  let indices = data.indices;
  if (det < 0) {
    indices = Uint32Array.from(data.indices);
    for (let t = 0; t < indices.length; t += 3) {const s = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = s;}
  }
  return clone(data, {positions, normals, indices, tangents});
}

/** Axis-aligned bounds of the positions. Empty geometry gives infinite min and negative-infinite max. */
export function computeBoundingBox(data: GeometryData): {min: Vec3; max: Vec3} {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity], P = data.positions;
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) {min[k] = Math.min(min[k], P[i + k]); max[k] = Math.max(max[k], P[i + k]);}
  return {min, max};
}

/** Bounding sphere centered on the box center (Three.js `computeBoundingSphere`). */
export function computeBoundingSphere(data: GeometryData): {center: Vec3; radius: number} {
  const {min, max} = computeBoundingBox(data), P = data.positions;
  if (!P.length) return {center: [0, 0, 0], radius: 0};
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < P.length; i += 3) r2 = Math.max(r2, (P[i] - center[0]) ** 2 + (P[i + 1] - center[1]) ** 2 + (P[i + 2] - center[2]) ** 2);
  return {center, radius: Math.sqrt(r2)};
}

/** Translates so the bounding box center is at the origin (Three.js `center()`); returns new data. */
export function center(data: GeometryData): GeometryData {
  const {min, max} = computeBoundingBox(data), c = [0, 1, 2].map(k => (min[k] + max[k]) / 2), positions = Float32Array.from(data.positions);
  if (positions.length) for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] -= c[k];
  return clone(data, {positions});
}

/**
 * Three.js `EdgesGeometry`: edges whose two faces meet at more than `thresholdAngle` degrees, plus boundary edges.
 * Positions are matched at 1e-4 precision, so split vertices along seams still pair up. Returns line index pairs
 * into `data.positions`.
 */
export function edgesGeometry(data: GeometryData, thresholdAngle = 1): Uint32Array {
  const P = data.positions, I = data.indices, threshold = Math.cos(thresholdAngle * Math.PI / 180), precision = 1e4;
  const hash = (v: number) => `${Math.round(P[v * 3] * precision)},${Math.round(P[v * 3 + 1] * precision)},${Math.round(P[v * 3 + 2] * precision)}`;
  const open = new Map<string, {a: number; b: number; n: Vec3}>(), out: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const tri = [I[t], I[t + 1], I[t + 2]], keys = tri.map(hash);
    if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) continue;
    const [a, b, c] = tri;
    const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]], e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...n) || 1;
    n[0] /= l; n[1] /= l; n[2] /= l;
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3, forward = `${keys[k]}_${keys[j]}`, reverse = `${keys[j]}_${keys[k]}`, other = open.get(reverse);
      if (other) {
        if (n[0] * other.n[0] + n[1] * other.n[1] + n[2] * other.n[2] <= threshold) out.push(other.a, other.b);
        open.delete(reverse);
      } else if (!open.has(forward)) open.set(forward, {a: tri[k], b: tri[j], n});
    }
  }
  for (const e of open.values()) out.push(e.a, e.b);
  return Uint32Array.from(out);
}

/** Three.js `WireframeGeometry`: every distinct triangle edge once, as line index pairs into `data.positions`. */
export function wireframe(data: GeometryData): Uint32Array {
  const seen = new Set<number>(), out: number[] = [], I = data.indices, n = data.positions.length / 3;
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = I[t + k], b = I[t + (k + 1) % 3], lo = Math.min(a, b), hi = Math.max(a, b), key = lo * n + hi;
    if (lo === hi || seen.has(key)) continue;
    seen.add(key); out.push(lo, hi);
  }
  return Uint32Array.from(out);
}
