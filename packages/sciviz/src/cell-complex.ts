// Pulling triangulation, Beck and Sanyal (2018), section 5.7. Global point IDs order every face.
import { rangeError } from '../../shared/errors.js';
import type { UnstructuredGrid } from './grids.js';

/** @internal Convex VTK cells, including surface triangles and quads. */
const cellFaces: Readonly<Record<number, readonly (readonly number[])[]>> = {
  5: [[0, 1, 2]], 9: [[0, 1, 2, 3]],
  10: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
  12: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
  13: [[0, 2, 1], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]],
  14: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
};
const widths: Readonly<Record<number, number>> = { 5: 3, 9: 4, 10: 4, 12: 8, 13: 6, 14: 5 };

/** @internal Validation shared by optional scientific filters, without changing the grid renderer. */
export function checkComplex(grid: UnstructuredGrid): void {
  if (!grid || !grid.points || !grid.connectivity || !grid.offsets || !grid.types ||
    grid.points.length % 3 || grid.types.length !== grid.offsets.length)
    throw rangeError('Analysis grid needs xyz points, connectivity, cell end offsets and VTK types', 'sciviz');
  let start = 0;
  for (let c = 0; c < grid.types.length; c++) {
    const end = grid.offsets[c];
    if (!widths[grid.types[c]] || end - start !== widths[grid.types[c]])
      throw rangeError(`Analysis cell ${c} must be a triangle, quad, tetrahedron, hexahedron, wedge or pyramid`, 'sciviz');
    const seen = new Set<number>();
    for (let k = start; k < end; k++) {
      const id = grid.connectivity[k];
      if (!Number.isSafeInteger(id) || id < 0 || id >= grid.points.length / 3 || seen.has(id))
        throw rangeError(`Analysis cell ${c} has an invalid or repeated point index`, 'sciviz');
      seen.add(id);
    }
    start = end;
  }
  if (start !== grid.connectivity.length || (grid.pointData && grid.pointData.length !== grid.points.length / 3) ||
    (grid.cellData && grid.cellData.length !== grid.types.length))
    throw rangeError('Analysis grid connectivity and scalar arrays must match their point and cell counts', 'sciviz');
}

/** @internal Consistent fan on a shared face, independent of either cell's local winding. */
function* faceTriangles(ids: readonly number[]): Generator<number[]> {
  const at = ids.indexOf(Math.min(...ids));
  for (let k = 1; k < ids.length - 1; k++) yield [ids[at], ids[(at + k) % ids.length], ids[(at + k + 1) % ids.length]];
}

/** @internal No added vertices: restriction of each pulling triangulation agrees on shared faces. */
export function* simplices(grid: UnstructuredGrid): Generator<{ ids: number[]; cell: number }> {
  let start = 0;
  for (let cell = 0; cell < grid.types.length; cell++) {
    const ids = Array.from({ length: grid.offsets[cell] - start }, (_, k) => grid.connectivity[start + k]);
    start = grid.offsets[cell];
    if (grid.types[cell] === 5 || grid.types[cell] === 9) {
      for (const tri of faceTriangles(ids)) yield { ids: tri, cell };
    } else {
      const apex = Math.min(...ids);
      for (const face of cellFaces[grid.types[cell]]) {
        const global = face.map(k => ids[k]);
        if (!global.includes(apex)) for (const tri of faceTriangles(global)) yield { ids: [apex, ...tri], cell };
      }
    }
  }
}

/** @internal */
export const cross3 = (a: readonly number[], b: readonly number[]): number[] =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @internal */
export const dot3 = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, k) => s + x * b[k], 0);
/** @internal */
export const sub3 = (a: readonly number[], b: readonly number[]): number[] => a.map((x, k) => x - b[k]);
