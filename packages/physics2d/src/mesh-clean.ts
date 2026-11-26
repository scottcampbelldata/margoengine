// Triangle mesh clean-up before the kernel builds a 2D mesh: Rapier's `TriMeshFlags` MERGE_DUPLICATE_VERTICES,
// DELETE_DEGENERATE_TRIANGLES, DELETE_DUPLICATE_TRIANGLES and DELETE_BAD_TOPOLOGY_TRIANGLES. Each is off by default, as in
// Rapier, and they apply in that order. Exact comparisons only (no tolerance), so the same mesh always gives the same result.
import type { Vec2D } from './shapes.js';

/** Which clean-up steps to run. */
export interface MeshClean2D {
  /** Joins vertices at the same position into one, so triangles that met at a seam share it. */
  mergeDuplicateVertices?: boolean;
  /** Drops triangles with a repeated vertex or no area (kept, they collide along their line, as in Rapier). */
  deleteDegenerateTriangles?: boolean;
  /** Drops a triangle whose three vertices another triangle already has, whatever its winding. */
  deleteDuplicateTriangles?: boolean;
  /** Drops triangles that would make an edge belong to more than two triangles, later ones first. */
  deleteBadTopologyTriangles?: boolean;
}

/** The triangles (three indices each) after the steps asked for, as indices into the returned vertices. */
export function cleanTrimesh2D(
  vertices: readonly Vec2D[],
  indices: ArrayLike<number>,
  options: MeshClean2D,
): { vertices: Vec2D[]; triangles: number[] } {
  let points: Vec2D[] = vertices.map((v) => [v[0], v[1]]);
  let triangles = Array.from(indices);
  if (options.mergeDuplicateVertices) {
    const seen = new Map<string, number>(),
      remap: number[] = [],
      kept: Vec2D[] = [];
    for (const [x, y] of points) {
      // -0 and 0 are one position; NaN never joins another.
      const key = `${x + 0},${y + 0}`;
      let at = Number.isNaN(x) || Number.isNaN(y) ? undefined : seen.get(key);
      if (at === undefined) {
        at = kept.length;
        seen.set(key, at);
        kept.push([x + 0, y + 0]);
      }
      remap.push(at);
    }
    points = kept;
    triangles = triangles.map((index) => remap[index]!);
  }
  const area2 = (a: number, b: number, c: number): number => {
    const [p, q, r] = [points[a]!, points[b]!, points[c]!];
    return (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
  };
  const keep = (test: (a: number, b: number, c: number) => boolean): void => {
    const kept: number[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
      if (test(a, b, c)) kept.push(a, b, c);
    }
    triangles = kept;
  };
  if (options.deleteDegenerateTriangles) keep((a, b, c) => a !== b && b !== c && a !== c && area2(a, b, c) !== 0);
  if (options.deleteDuplicateTriangles) {
    const seen = new Set<string>();
    keep((a, b, c) => {
      const key = [a, b, c].sort((x, y) => x - y).join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (options.deleteBadTopologyTriangles) {
    const edges = new Map<string, number>();
    const edge = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
    keep((a, b, c) => {
      const sides = [edge(a, b), edge(b, c), edge(c, a)];
      if (sides.some((side) => (edges.get(side) ?? 0) >= 2)) return false;
      for (const side of sides) edges.set(side, (edges.get(side) ?? 0) + 1);
      return true;
    });
  }
  return { vertices: points, triangles };
}
