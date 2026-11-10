import { rangeError } from '../../shared/errors.js';
import type { UnstructuredGrid } from './grids.js';
import type { Bounds } from './layer.js';

/** @internal Snapshotted cells, inverse barycentric planes and a stackless spatial tree. */
export interface TetMeshData {
  readonly bounds: Bounds;
  readonly cells: Float32Array;
  readonly nodes: Float32Array;
  readonly adjacency: Int32Array;
  readonly count: number;
  readonly range: readonly [number, number];
  readonly reference: number;
}
const cross = (a: number[], b: number[]): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]): number => a.reduce((v, x, i) => v + x * b[i], 0);
/** @internal Validate geometry, build opposite-vertex neighbours, normalize scalars and invert each cell. */
export function buildTetMesh(
  grid: UnstructuredGrid,
  association: 'point' | 'cell' = 'point',
  givenRange?: readonly [number, number],
  geometryOnly = false,
): TetMeshData {
  const points = Float64Array.from(grid.points),
    indices = Uint32Array.from(grid.connectivity),
    count = grid.types.length,
    np = points.length / 3;
  if (
    !count ||
    !Number.isInteger(np) ||
    np < 4 ||
    !points.every(Number.isFinite) ||
    count > 8388607 ||
    grid.offsets.length !== count ||
    indices.length !== count * 4 ||
    Array.from(grid.connectivity).some((v) => !Number.isInteger(v) || v < 0 || v >= np) ||
    Array.from(grid.types).some((v) => v !== 10) ||
    Array.from(grid.offsets).some((v, i) => v !== (i + 1) * 4)
  )
    throw rangeError(
      'Tetrahedral volume needs finite xyz, VTK type 10 cells, four distinct valid node indices per cell and end offsets 4,8,...',
      'sciviz',
    );
  const values = association === 'point' ? grid.pointData : grid.cellData;
  if (
    !geometryOnly &&
    (!values ||
      values.length !== (association === 'point' ? np : count) ||
      Array.from(values).some((v) => !Number.isFinite(v) && !Number.isNaN(v)))
  )
    throw rangeError('Tetrahedral volume needs one finite scalar or NaN mask per associated point/cell', 'sciviz');
  let low = Infinity,
    high = -Infinity;
  if (values)
    for (let i = 0; i < values.length; i++)
      if (Number.isFinite(values[i])) {
        low = Math.min(low, values[i]);
        high = Math.max(high, values[i]);
      }
  if (geometryOnly) {
    low = 0;
    high = 1;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high))
    throw rangeError('Tetrahedral volume needs at least one finite scalar', 'sciviz');
  let range = givenRange ?? ([low, high] as const);
  if (range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1])
    throw rangeError('Tetrahedral classifier range must be finite and increasing', 'sciviz');
  if (range[0] === range[1]) range = [range[0] - 0.5, range[1] + 0.5];
  const bounds: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) {
    const a = i % 3;
    bounds[a * 2] = Math.min(bounds[a * 2], points[i]);
    bounds[a * 2 + 1] = Math.max(bounds[a * 2 + 1], points[i]);
  }
  const span = [0, 1, 2].map((a) => bounds[a * 2 + 1] - bounds[a * 2]);
  if (span.some((v) => !(v > 0) || !Number.isFinite(v)))
    throw rangeError('Tetrahedral volume must span three physical axes', 'sciviz');
  const adjacency = new Int32Array(count * 4).fill(-1),
    faces = new Map<string, { cell: number; face: number; opposite: number }>(),
    sealed = new Set<string>();
  const cells = new Float32Array(count * 24),
    cellBounds: { id: number; low: number[]; high: number[] }[] = [];
  let reference = Infinity;
  for (let cell = 0; cell < count; cell++) {
    const ids = Array.from(indices.subarray(cell * 4, cell * 4 + 4));
    if (new Set(ids).size !== 4) throw rangeError('Tetrahedral cells need four distinct node IDs', 'sciviz');
    const physical = ids.map((id) => [points[id * 3], points[id * 3 + 1], points[id * 3 + 2]]),
      p = physical.map((v) => v.map((n, a) => (n - bounds[a * 2]) / span[a]));
    const edges = [1, 2, 3].map((i) => p[i].map((v, a) => v - p[0][a]));
    const det = dot(edges[0], cross(edges[1], edges[2])),
      product = edges.reduce((v, e) => v * Math.hypot(...e), 1);
    if (!Number.isFinite(det) || Math.abs(det) <= product * 1e-10 || !product)
      throw rangeError('Tetrahedral cells must have nonzero well-conditioned volume', 'sciviz');
    const inverse = [cross(edges[1], edges[2]), cross(edges[2], edges[0]), cross(edges[0], edges[1])].map((e) =>
      e.map((v) => v / det),
    );
    for (let a = 0; a < 3; a++) cells.set([...inverse[a], -dot(inverse[a], p[0])], cell * 24 + a * 4);
    let valid = true;
    for (let k = 0; k < 4; k++) {
      const value = geometryOnly ? 0 : values![association === 'point' ? ids[k] : cell];
      valid &&= Number.isFinite(value);
      cells[cell * 24 + 12 + k] = Number.isFinite(value)
        ? Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])))
        : 0;
    }
    const scalar = Array.from(cells.subarray(cell * 24 + 12, cell * 24 + 16));
    const gradient = [0, 1, 2].map(
      (a) =>
        (inverse[0][a] * (scalar[1] - scalar[0]) +
          inverse[1][a] * (scalar[2] - scalar[0]) +
          inverse[2][a] * (scalar[3] - scalar[0])) /
        span[a],
    );
    cells.set([...gradient, valid ? 1 : 0], cell * 24 + 20);
    const lo = [0, 1, 2].map((a) => Math.min(...p.map((v) => v[a]))),
      hi = [0, 1, 2].map((a) => Math.max(...p.map((v) => v[a])));
    cellBounds.push({ id: cell, low: lo, high: hi });
    for (let a = 0; a < 4; a++)
      for (let b = a + 1; b < 4; b++)
        reference = Math.min(reference, Math.hypot(...physical[a].map((v, k) => v - physical[b][k])));
    for (let face = 0; face < 4; face++) {
      const vertices = ids.filter((_, i) => i !== face).sort((a, b) => a - b),
        key = vertices.join(',');
      if (sealed.has(key))
        throw rangeError('Tetrahedral volume has a nonmanifold face shared by more than two cells', 'sciviz');
      const other = faces.get(key);
      if (other) {
        const a = vertices.map((id) => [points[id * 3], points[id * 3 + 1], points[id * 3 + 2]]),
          n = cross(
            a[1].map((v, k) => v - a[0][k]),
            a[2].map((v, k) => v - a[0][k]),
          );
        const side = dot(
            n,
            physical[face].map((v, k) => v - a[0][k]),
          ),
          opposite = [points[other.opposite * 3], points[other.opposite * 3 + 1], points[other.opposite * 3 + 2]];
        if (
          side *
            dot(
              n,
              opposite.map((v, k) => v - a[0][k]),
            ) >=
          0
        )
          throw rangeError('Adjacent tetrahedral cells must lie on opposite sides of their shared face', 'sciviz');
        adjacency[cell * 4 + face] = other.cell;
        adjacency[other.cell * 4 + other.face] = cell;
        faces.delete(key);
        sealed.add(key);
      } else faces.set(key, { cell, face, opposite: ids[face] });
    }
  }
  for (let cell = 0; cell < count; cell++) cells.set(adjacency.subarray(cell * 4, cell * 4 + 4), cell * 24 + 16);
  const nodes: number[] = [];
  function tree(list: typeof cellBounds): void {
    const at = nodes.length,
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const c of list)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], c.low[a]);
        hi[a] = Math.max(hi[a], c.high[a]);
      }
    nodes.push(...lo, 0, ...hi, list.length === 1 ? list[0].id + 1 : 0);
    if (list.length > 1) {
      const widths = hi.map((v, a) => v - lo[a]),
        axis = widths.indexOf(Math.max(...widths));
      list.sort((a, b) => a.low[axis] + a.high[axis] - b.low[axis] - b.high[axis]);
      const mid = list.length >> 1;
      tree(list.slice(0, mid));
      tree(list.slice(mid));
    }
    nodes[at + 3] = nodes.length / 8;
  }
  tree(cellBounds);
  return { bounds, cells, nodes: Float32Array.from(nodes), adjacency, count, range, reference };
}
/** Opposite-vertex face neighbours for a conforming VTK tetrahedral grid. Boundary faces are -1. Validates geometry and manifoldness. */
export function tetrahedralAdjacency(grid: UnstructuredGrid): Int32Array {
  return buildTetMesh(grid, 'point', undefined, true).adjacency;
}
