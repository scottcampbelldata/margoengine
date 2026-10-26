// Mesh connectivity for weight solving and painting. Render meshes split vertices along UV seams, normals and (on
// voxel meshes) every face, so vertices at the same position are welded first: diffusion and smoothing then cross the
// seams, and the duplicates of one point always get the same weights.

/** Triangle mesh input: xyz per vertex, and three vertex indices per triangle (omit for an unindexed list). */
export interface WeightMesh {
  readonly positions: ArrayLike<number>;
  readonly indices?: ArrayLike<number> | null;
}

/** Most vertices the package accepts in one mesh. */
const MAX_VERTICES = 1 << 24;

/** A welded mesh: unique points, the point each input vertex became, and triangles over the points. */
export interface Welded {
  /** Input vertex count. */
  readonly vertexCount: number;
  /** Unique point per input vertex. */
  readonly point: Int32Array;
  /** xyz per unique point. */
  readonly positions: Float64Array;
  /** Three points per triangle; triangles that collapse under welding are dropped. */
  readonly triangles: Uint32Array;
  /** Bounding-box diagonal of the points. */
  readonly size: number;
}

/**
 * Welds vertices closer than `tolerance` times the bounding-box diagonal (default 1e-6: only coincident points).
 * @throws TypeError for malformed input, RangeError for non-finite positions or out-of-range indices.
 */
export function weld(mesh: WeightMesh, tolerance = 1e-6): Welded {
  const positions = mesh?.positions,
    length = positions?.length;
  if (!Number.isSafeInteger(length) || length % 3 || length < 9 || length / 3 > MAX_VERTICES)
    throw new TypeError(`Mesh positions need xyz per vertex: 3 to ${MAX_VERTICES} vertices`);
  if (!(tolerance >= 0 && tolerance < 1)) throw new RangeError('Weld tolerance must be from 0 to below 1');
  const n = length / 3,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < length; i++) {
    const v = positions[i];
    if (!Number.isFinite(v)) throw new RangeError(`Mesh position ${i} is not finite; repair the mesh`);
    if (v < min[i % 3]) min[i % 3] = v;
    if (v > max[i % 3]) max[i % 3] = v;
  }
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
    cell = tolerance * size,
    keys = new Map<string, number>(),
    point = new Int32Array(n),
    unique: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2],
      key = cell > 0 ? `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}` : `${x},${y},${z}`;
    let id = keys.get(key);
    if (id === undefined) {
      keys.set(key, (id = unique.length / 3));
      unique.push(x, y, z);
    }
    point[i] = id;
  }
  const indices = mesh.indices,
    count = indices ? indices.length : n;
  if (count % 3) throw new TypeError('Mesh indices need three per triangle');
  const triangles: number[] = [];
  for (let t = 0; t < count; t += 3) {
    const a = indices ? indices[t] : t,
      b = indices ? indices[t + 1] : t + 1,
      c = indices ? indices[t + 2] : t + 2;
    for (const v of [a, b, c])
      if (!Number.isInteger(v) || v < 0 || v >= n)
        throw new RangeError(`Mesh index ${v} is outside the ${n} vertices; repair the index buffer`);
    const pa = point[a],
      pb = point[b],
      pc = point[c];
    if (pa !== pb && pb !== pc && pa !== pc) triangles.push(pa, pb, pc);
  }
  return {
    vertexCount: n,
    point,
    positions: Float64Array.from(unique),
    triangles: Uint32Array.from(triangles),
    size,
  };
}

/** Compressed sparse rows of a symmetric matrix over the welded points. */
export interface Sparse {
  readonly offsets: Int32Array;
  readonly columns: Int32Array;
  readonly values: Float64Array;
  readonly diagonal: Float64Array;
}

/** Neighbour lists (CSR offsets and columns) of the welded points, from the triangles' edges. */
export function neighbours(welded: Welded): { offsets: Int32Array; columns: Int32Array } {
  const m = welded.positions.length / 3,
    sets: Set<number>[] = Array.from({ length: m }, () => new Set()),
    t = welded.triangles;
  for (let i = 0; i < t.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = t[i + k],
        b = t[i + ((k + 1) % 3)];
      sets[a].add(b);
      sets[b].add(a);
    }
  const offsets = new Int32Array(m + 1);
  for (let i = 0; i < m; i++) offsets[i + 1] = offsets[i] + sets[i].size;
  const columns = new Int32Array(offsets[m]);
  sets.forEach((set, i) =>
    columns.set(
      [...set].sort((a, b) => a - b),
      offsets[i],
    ),
  );
  return { offsets, columns };
}

/**
 * The cotangent stiffness matrix L of the welded mesh (U. Pinkall and K. Polthier 1993; M. Meyer, M. Desbrun,
 * P. Schroder and A. H. Barr 2003): L_ij = -(cot a_ij + cot b_ij) / 2 over each edge's two opposite angles, L_ii = -sum
 * of the row. It is the finite-element Dirichlet energy of piecewise-linear functions, so it is symmetric and
 * positive semi-definite for any triangles. Also returns each point's barycentric area (a third of its triangles').
 */
export function cotangentLaplacian(welded: Welded): { matrix: Sparse; area: Float64Array } {
  const p = welded.positions,
    t = welded.triangles,
    m = p.length / 3,
    { offsets, columns } = neighbours(welded),
    values = new Float64Array(columns.length),
    diagonal = new Float64Array(m),
    area = new Float64Array(m);
  const at = (row: number, column: number): number => {
    let lo = offsets[row],
      hi = offsets[row + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (columns[mid] === column) return mid;
      if (columns[mid] < column) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  for (let i = 0; i < t.length; i += 3) {
    const v = [t[i], t[i + 1], t[i + 2]],
      cross = [0, 0, 0];
    // Twice the triangle area from the cross product of two edges.
    const e1 = [0, 1, 2].map((c) => p[v[1] * 3 + c] - p[v[0] * 3 + c]),
      e2 = [0, 1, 2].map((c) => p[v[2] * 3 + c] - p[v[0] * 3 + c]);
    cross[0] = e1[1] * e2[2] - e1[2] * e2[1];
    cross[1] = e1[2] * e2[0] - e1[0] * e2[2];
    cross[2] = e1[0] * e2[1] - e1[1] * e2[0];
    const double = Math.hypot(cross[0], cross[1], cross[2]);
    if (!(double > 1e-14 * welded.size * welded.size)) continue; // a sliver adds no stiffness and no area
    for (const k of v) area[k] += double / 6;
    for (let k = 0; k < 3; k++) {
      // The angle at corner k is opposite the edge between the other two corners.
      const o = v[k],
        a = v[(k + 1) % 3],
        b = v[(k + 2) % 3];
      let dot = 0;
      for (let c = 0; c < 3; c++) dot += (p[a * 3 + c] - p[o * 3 + c]) * (p[b * 3 + c] - p[o * 3 + c]);
      // cot = cos / sin = dot / |cross|; |cross| at every corner is twice the area.
      const w = (0.5 * dot) / double;
      values[at(a, b)] -= w;
      values[at(b, a)] -= w;
      diagonal[a] += w;
      diagonal[b] += w;
    }
  }
  return { matrix: { offsets, columns, values, diagonal }, area };
}

/** Connected component per welded point (union-find over the triangles). */
export function components(welded: Welded): Int32Array {
  const m = welded.positions.length / 3,
    parent = Int32Array.from({ length: m }, (_, i) => i),
    find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    },
    t = welded.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = find(t[i]);
    parent[find(t[i + 1])] = a;
    parent[find(t[i + 2])] = a;
  }
  for (let i = 0; i < m; i++) parent[i] = find(i);
  return parent;
}
