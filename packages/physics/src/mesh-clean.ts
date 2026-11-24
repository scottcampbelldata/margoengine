// Triangle mesh clean-up before the kernel builds a mesh: Rapier's `TriMeshFlags` MERGE_DUPLICATE_VERTICES,
// DELETE_DEGENERATE_TRIANGLES, DELETE_DUPLICATE_TRIANGLES and DELETE_BAD_TOPOLOGY_TRIANGLES. Each is off by default, as in
// Rapier, and they apply in that order. Exact comparisons only (no tolerance), so the same mesh always gives the same result.

/** Which clean-up steps to run. */
export interface MeshCleanOptions {
  /** Joins vertices at the same position into one, so triangles that met at a seam share it. */
  mergeDuplicateVertices?: boolean;
  /** Drops triangles with a repeated vertex or no area. */
  deleteDegenerateTriangles?: boolean;
  /** Drops a triangle whose three vertices another triangle already has, whatever its winding. */
  deleteDuplicateTriangles?: boolean;
  /** Drops triangles that would make an edge belong to more than two triangles, later ones first. */
  deleteBadTopologyTriangles?: boolean;
}

/** True when any step is asked for. */
export function wantsClean(options: MeshCleanOptions): boolean {
  return !!(
    options.mergeDuplicateVertices ||
    options.deleteDegenerateTriangles ||
    options.deleteDuplicateTriangles ||
    options.deleteBadTopologyTriangles
  );
}

/**
 * The mesh after the steps asked for. Vertices no triangle uses stay unless merging joins them.
 * @throws RangeError for an index outside the vertices.
 */
export function cleanTrimesh(
  vertices: Float32Array,
  indices: Uint32Array,
  options: MeshCleanOptions,
): { vertices: Float32Array; indices: Uint32Array } {
  const count = vertices.length / 3;
  for (let i = 0; i < indices.length; i++)
    if (indices[i]! >= count)
      throw new RangeError(
        `Trimesh index ${indices[i]} is out of range; keep every index below the ${count} vertices.`,
      );
  let points = vertices,
    triangles = Array.from(indices);
  if (options.mergeDuplicateVertices) {
    const seen = new Map<string, number>(),
      remap = new Uint32Array(count),
      kept: number[] = [];
    for (let v = 0; v < count; v++) {
      // -0 and 0 are one position; NaN never joins another.
      const x = points[3 * v]! + 0,
        y = points[3 * v + 1]! + 0,
        z = points[3 * v + 2]! + 0,
        key = `${x},${y},${z}`;
      let at = seen.get(key);
      if (at === undefined) {
        at = kept.length / 3;
        seen.set(key, at);
        kept.push(x, y, z);
      }
      remap[v] = at;
    }
    points = Float32Array.from(kept);
    triangles = triangles.map((index) => remap[index]!);
  }
  const corner = (index: number): [number, number, number] => [
    points[3 * index]!,
    points[3 * index + 1]!,
    points[3 * index + 2]!,
  ];
  if (options.deleteDegenerateTriangles) {
    const kept: number[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
      if (a === b || b === c || a === c) continue;
      const [p, q, r] = [corner(a), corner(b), corner(c)],
        u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]],
        v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]],
        n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
      kept.push(a, b, c);
    }
    triangles = kept;
  }
  if (options.deleteDuplicateTriangles) {
    const seen = new Set<string>(),
      kept: number[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const trio = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!],
        key = [...trio].sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(...trio);
    }
    triangles = kept;
  }
  if (options.deleteBadTopologyTriangles) {
    const edges = new Map<string, number>(),
      kept: number[] = [];
    const edge = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!],
        sides = [edge(a, b), edge(b, c), edge(c, a)];
      if (sides.some((side) => (edges.get(side) ?? 0) >= 2)) continue;
      for (const side of sides) edges.set(side, (edges.get(side) ?? 0) + 1);
      kept.push(a, b, c);
    }
    triangles = kept;
  }
  return { vertices: points, indices: Uint32Array.from(triangles) };
}
