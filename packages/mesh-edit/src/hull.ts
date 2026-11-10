import { convexHullTriangles } from '@margoengine/geometry/hull';
import type { MutableVec2, MutableVec3, Vec3 } from '@margoengine/math';
import { batchBooleanMeshes } from './boolean-batch.js';
import { assertSolid } from './boolean.js';
import { assertOptions } from './edit-support.js';
import { convexCellsExact } from './exact-kernel.js';
import { assertPolygonMesh } from './polygon.js';
import { faceIdFactory } from './result.js';
import type { MeshEditOptions, PolygonMesh } from './types.js';

/** Options for mesh convex hulls. All generated faces get planar UVs. */
export interface MeshHullOptions extends MeshEditOptions {
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

/** Bounds on explicit nonconvex decomposition work, independent of machine timing. */
export interface MeshMinkowskiOptions extends MeshHullOptions {
  /** Maximum convex cells per operand. Default 2048. */
  maxCells?: number;
  /** Maximum cell pairs. Default 65536. */
  maxPairs?: number;
  /** Maximum enumerated plane triples per operand. Default 2000000. */
  maxPlaneTriples?: number;
}

/** Owned Minkowski boundary and deterministic decomposition counts. */
export interface MeshMinkowskiResult {
  mesh: PolygonMesh;
  cells: [number, number];
  convexPairs: number;
  planeTriples: number;
  collapsedFaces: number;
  diagnostics: string[];
}

function optionsOf(options: MeshHullOptions): void {
  assertOptions(options, 'Mesh hull');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Hull signal must be an AbortSignal; pass controller.signal.');
  options.signal?.throwIfAborted();
}

function hullOf(points: readonly Vec3[], createId: () => string, signal?: AbortSignal): PolygonMesh {
  const indices = convexHullTriangles(points, { signal }),
    mesh: PolygonMesh = { vertices: [], faces: [] },
    remap = new Map<number, number>();
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k], p[k]);
      high[k] = Math.max(high[k], p[k]);
    }
  for (let i = 0; i < indices.length; i += 3) {
    signal?.throwIfAborted();
    const ids = [...indices.slice(i, i + 3)],
      [a, b, c] = ids.map((j) => points[j]),
      u = b.map((x, k) => x - a[k]),
      v = c.map((x, k) => x - a[k]),
      n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      axis = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs))),
      axes = [0, 1, 2].filter((k) => k !== axis);
    mesh.faces.push({
      id: createId(),
      vertices: ids.map((j) => {
        let at = remap.get(j);
        if (at === undefined) {
          at = mesh.vertices.length;
          remap.set(j, at);
          mesh.vertices.push([...points[j]]);
        }
        return at;
      }),
      uv: ids.map(
        (j) => axes.map((k) => (high[k] > low[k] ? (points[j][k] - low[k]) / (high[k] - low[k]) : 0.5)) as MutableVec2,
      ),
    });
  }
  assertPolygonMesh(mesh);
  if (mesh.faces.length) assertSolid(mesh, 'hull');
  return mesh;
}

/** Convex hull of one mesh or a collection, including all supplied positions. Source double precision is retained.
 * Empty and lower-dimensional point sets return an empty solid. Faces/UVs are newly generated.
 * @throws TypeError for invalid meshes/options/IDs, RangeError for numerical limits, or the abort reason.
 */
export function convexMeshHull(
  input: PolygonMesh | readonly PolygonMesh[],
  options: MeshHullOptions = {},
): PolygonMesh {
  optionsOf(options);
  const meshes: readonly PolygonMesh[] = Array.isArray(input) ? input : [input as PolygonMesh];
  const points: MutableVec3[] = [];
  for (const mesh of meshes) {
    assertPolygonMesh(mesh);
    for (const p of mesh.vertices) points.push([...p]);
  }
  if (points.length > 200000) throw new RangeError('Mesh hull exceeds 200000 input points; partition the collection.');
  const createId = faceIdFactory({ vertices: [], faces: [] }, options);
  const result = hullOf(points, createId, options.signal);
  options.signal?.throwIfAborted();
  return result;
}

/** Minkowski sum of two closed outward solids, including nonconvex/disconnected solids and cavities.
 * Exact BSP cells cover each input; pairwise convex sums are united in one batch rather than convexifying the result.
 * Cell coordinates and additions are float64; this API makes no exact-output or elapsed-time promise.
 * @throws TypeError for invalid solids/options, RangeError for work/numeric limits, or the abort reason.
 */
export function minkowskiSumMeshes(
  a: PolygonMesh,
  b: PolygonMesh,
  options: MeshMinkowskiOptions = {},
): MeshMinkowskiResult {
  optionsOf(options);
  const maxCells = options.maxCells ?? 2048,
    maxPairs = options.maxPairs ?? 65536,
    maxTriples = options.maxPlaneTriples ?? 2000000;
  for (const value of [maxCells, maxPairs, maxTriples])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(
        'Minkowski work limits must be positive safe integers; choose explicit cell, pair and plane-triple budgets.',
      );
  assertPolygonMesh(a);
  assertPolygonMesh(b);
  const finalId = faceIdFactory({ vertices: [], faces: [] }, options);
  if (!a.faces.length || !b.faces.length)
    return {
      mesh: { vertices: [], faces: [] },
      cells: [0, 0],
      convexPairs: 0,
      planeTriples: 0,
      collapsedFaces: 0,
      diagnostics: ['The result is empty.'],
    };
  assertSolid(a, 'Minkowski a');
  assertSolid(b, 'Minkowski b');
  const A = convexCellsExact(a, maxCells, maxTriples, options.signal),
    B = convexCellsExact(b, maxCells, maxTriples, options.signal);
  if (!A.cells.length || !B.cells.length)
    throw new RangeError('Minkowski input has no resolved finite interior cells; repair or simplify the solid.');
  if (A.cells.length * B.cells.length > maxPairs)
    throw new RangeError('Minkowski cell-pair budget exceeded; raise maxPairs or simplify the solids.');
  const pieces: PolygonMesh[] = [];
  let serial = 0;
  const internalId = () => `sum-${serial++}`;
  for (const first of A.cells)
    for (const second of B.cells) {
      options.signal?.throwIfAborted();
      if (first.length * second.length > 200000)
        throw new RangeError('Minkowski cell pair exceeds 200000 vertex sums; simplify the convex cells.');
      const points: MutableVec3[] = [];
      for (const p of first) for (const q of second) points.push(p.map((x, k) => x + q[k]) as MutableVec3);
      const piece = hullOf(points, internalId, options.signal);
      if (!piece.faces.length)
        throw new RangeError('Minkowski cell is numerically too thin for a solid hull; simplify the input geometry.');
      pieces.push(piece);
    }
  const union = batchBooleanMeshes(pieces, 'union', { signal: options.signal, createId: internalId });
  for (const face of union.mesh.faces) {
    options.signal?.throwIfAborted();
    face.id = finalId();
  }
  options.signal?.throwIfAborted();
  return {
    mesh: union.mesh,
    cells: [A.cells.length, B.cells.length],
    convexPairs: pieces.length,
    planeTriples: A.planeTriples + B.planeTriples,
    collapsedFaces: union.collapsedFaces,
    diagnostics: union.diagnostics,
  };
}
