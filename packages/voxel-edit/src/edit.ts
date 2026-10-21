// Brushes (line, box, sphere footprints) and selections (flood, connected, face) on dense or sparse grids; mirrored
// stamps and clipboard paste are in stamp.ts, ellipsoid, cylinder, ring and line rasterizers in raster.ts.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { cellLimit, checkCell, checkGrid, checkPoint, type GridLimits, type VoxelGrid } from './grid.js';
import { SparseGrid } from './sparse.js';

export * from './raster.js';
export * from './stamp.js';

/** A dense grid or a sparse one; selections and picking take either. */
export type GridSource = VoxelGrid | SparseGrid;

const MAX_LINE = 4096,
  MAX_BOX = 16_777_216,
  MAX_RADIUS = 128;

function rounded(point: Vec3, subject: string): MutableVec3 {
  checkPoint(point, subject);
  return [Math.round(point[0]), Math.round(point[1]), Math.round(point[2])];
}

/** The cells of a straight line from `a` to `b` (rounded to cells), both ends included; at most 4,097 cells. */
export function lineCells(a: Vec3, b: Vec3): MutableVec3[] {
  const from = rounded(a, 'lineCells start'),
    to = rounded(b, 'lineCells end'),
    delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
    steps = Math.max(Math.abs(delta[0]), Math.abs(delta[1]), Math.abs(delta[2]));
  if (steps > MAX_LINE) throw new RangeError(`lineCells spans ${steps} cells, over ${MAX_LINE}; draw it in parts`);
  if (!steps) return [from];
  return Array.from({ length: steps + 1 }, (_, i) => [
    Math.round(from[0] + (delta[0] * i) / steps),
    Math.round(from[1] + (delta[1] * i) / steps),
    Math.round(from[2] + (delta[2] * i) / steps),
  ]);
}

/** Options of {@link boxCells}. */
export interface BoxOptions {
  /** Only the one-cell shell. Default false (solid). */
  hollow?: boolean;
}

/** The cells of the box between corners `a` and `b` (either order, both included); at most 16,777,216 cells. */
export function boxCells(a: Vec3, b: Vec3, options: BoxOptions = {}): MutableVec3[] {
  const p = rounded(a, 'boxCells corner'),
    q = rounded(b, 'boxCells corner'),
    lo = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])],
    hi = [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])],
    count = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1),
    hollow = options.hollow ?? false;
  if (typeof hollow !== 'boolean') throw new TypeError('boxCells hollow is not a boolean; pass true or false');
  if (count > MAX_BOX) throw new RangeError(`boxCells covers ${count} cells, over ${MAX_BOX}; use a smaller box`);
  const cells: MutableVec3[] = [];
  for (let y = lo[1]; y <= hi[1]; y++)
    for (let z = lo[2]; z <= hi[2]; z++)
      for (let x = lo[0]; x <= hi[0]; x++)
        if (!hollow || x === lo[0] || x === hi[0] || y === lo[1] || y === hi[1] || z === lo[2] || z === hi[2])
          cells.push([x, y, z]);
  return cells;
}

/** The cells whose centres lie within `radius` (0 to 128) of the cell `center` (rounded to cells). */
export function sphereCells(center: Vec3, radius: number): MutableVec3[] {
  const c = rounded(center, 'sphereCells center');
  if (!Number.isFinite(radius) || radius < 0 || radius > MAX_RADIUS)
    throw new RangeError(`sphereCells radius must be 0 to ${MAX_RADIUS}; pass one in range`);
  const reach = Math.ceil(radius),
    limit = radius * radius,
    cells: MutableVec3[] = [];
  for (let y = -reach; y <= reach; y++)
    for (let z = -reach; z <= reach; z++)
      for (let x = -reach; x <= reach; x++)
        if (x * x + y * y + z * z <= limit) cells.push([c[0] + x, c[1] + y, c[2] + z]);
  return cells;
}

const SIX = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
] as const;

/**
 * Breadth-first walk from `seed` over cells `accept` takes, stepping along `steps`. Returns cell indexes as a
 * Float64Array (sparse grids can pass 2^32 cells) in visiting order.
 */
function walk(
  source: GridSource,
  seed: Vec3,
  limits: GridLimits,
  name: string,
  accept: (read: (x: number, y: number, z: number) => number, x: number, y: number, z: number) => boolean,
  steps: readonly (readonly number[])[] = SIX,
): Float64Array {
  if (typeof limits !== 'object' || limits === null)
    throw new TypeError(`${name} limits are not an object; pass {maxCells}`);
  const limit = cellLimit(limits);
  checkCell(seed, `${name} seed`);
  const sparse = source instanceof SparseGrid;
  if (!sparse) checkGrid(source, limit);
  const [sx, sy, sz] = source.size,
    plane = sx * sz,
    voxels = sparse ? undefined : source.voxels,
    read = (x: number, y: number, z: number): number =>
      x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz
        ? 0
        : voxels
          ? voxels[x + sx * (z + sz * y)]
          : (source as SparseGrid).get(x, y, z);
  const [x0, y0, z0] = seed;
  if (x0 < 0 || y0 < 0 || z0 < 0 || x0 >= sx || y0 >= sy || z0 >= sz || !accept(read, x0, y0, z0))
    return new Float64Array();
  if (sparse && !read(x0, y0, z0) && sx * sy * sz > limit)
    throw new RangeError(`${name} would flood the air of a grid larger than maxCells; select within a window instead`);
  const seen = voxels ? new Uint8Array(voxels.length) : undefined,
    seenSparse = voxels ? undefined : new Set<number>(),
    start = x0 + sx * (z0 + sz * y0),
    queue = [start];
  if (seen) seen[start] = 1;
  else seenSparse!.add(start);
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head],
      y = Math.floor(index / plane),
      rest = index - y * plane,
      z = Math.floor(rest / sx),
      x = rest - z * sx;
    for (const [dx, dy, dz] of steps) {
      const nx = x + dx,
        ny = y + dy,
        nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
      const next = nx + sx * (nz + sz * ny);
      if (seen ? seen[next] : seenSparse!.has(next)) continue;
      if (!accept(read, nx, ny, nz)) continue;
      if (queue.length >= limit)
        throw new RangeError(`${name} exceeds maxCells (${limit}); select less or raise maxCells`);
      if (seen) seen[next] = 1;
      else seenSparse!.add(next);
      queue.push(next);
    }
  }
  return Float64Array.from(queue);
}

/**
 * The face-connected cells holding the same palette index as `seed` (air included), as cell indexes
 * ({@link cellAt} turns one back into x, y, z). An empty array when `seed` is outside the grid.
 */
export function floodCells(source: GridSource, seed: Vec3, limits: GridLimits = {}): Float64Array {
  let value = -1;
  return walk(source, seed, limits, 'floodCells', (read, x, y, z) => {
    const v = read(x, y, z);
    if (value < 0) value = v;
    return v === value;
  });
}

/** The face-connected filled cells reachable from a filled `seed`, whatever their palette index, as cell indexes. */
export function connectedCells(source: GridSource, seed: Vec3, limits: GridLimits = {}): Float64Array {
  return walk(source, seed, limits, 'connectedCells', (read, x, y, z) => read(x, y, z) !== 0);
}

/**
 * The exposed face region around `seed`: filled cells in the seed's layer whose `normal` side is air (or the grid's
 * edge), joined through edges within that layer, whatever their palette index. `normal` is a unit axis vector.
 */
export function faceCells(source: GridSource, seed: Vec3, normal: Vec3, limits: GridLimits = {}): Float64Array {
  if (
    !Array.isArray(normal) ||
    normal.length !== 3 ||
    !Array.from(normal).every(Number.isInteger) ||
    Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]) !== 1
  )
    throw new RangeError('faceCells normal is not a unit axis vector; pass e.g. [0, 1, 0]');
  const steps = SIX.filter((step) => step.every((v, axis) => !v || !normal[axis]));
  return walk(
    source,
    seed,
    limits,
    'faceCells',
    (read, x, y, z) => read(x, y, z) !== 0 && !read(x + normal[0], y + normal[1], z + normal[2]),
    steps,
  );
}
