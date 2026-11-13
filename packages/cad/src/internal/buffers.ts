import { rangeError, typeError } from '../../../shared/errors.js';

/** One mesh's buffers in the layout core's Geometry stores: per vertex xyz then normal, uint32 triangle indices, and
 * the bounding sphere (float32 centre, radius rounded up so the kernel's cull never drops a stored vertex). */
export interface MeshBuffers {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: Float32Array;
}

/** Builds one mesh from flat positions, normals and triangle indices: core's Geometry on the page, {@link meshBuffers}
 * in the worker. */
export type MakeMesh<G extends MeshBuffers> = (
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  indices: ArrayLike<number>,
) => G;

/** The largest magnitude that stays finite as a float32. */
const F32_MAX = 3.4028235677973366e38;

/**
 * The worker's mesh: the buffers `new Geometry(positions, normals, indices)` makes, with the same checks, as a plain
 * object. The page wraps them in a Geometry without copying (cad-async.ts), so the worker bundles none of core: core's
 * build declares its class fields, which every other worker of the shared tsconfig keeps out (tests/class-fields.test.js).
 */
export function meshBuffers(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  indices: ArrayLike<number>,
): MeshBuffers {
  const count = positions.length / 3,
    corners = indices.length;
  if (!Number.isInteger(count) || count > 11_184_810 || (count === 0 ? corners !== 0 : count < 3 || !corners) || corners % 3)
    throw rangeError('Invalid geometry', 'geometry');
  for (const [values, label] of [
    [positions, 'Positions'],
    [normals, 'Normals'],
  ] as const) {
    if (values.length !== count * 3) throw typeError(`${label}: ${count * 3} values`, 'transform');
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (typeof value !== 'number' || !(Math.abs(value) < F32_MAX)) throw rangeError(`${label}: finite values`, 'transform');
    }
  }
  const out = new Uint32Array(corners);
  for (let i = 0; i < corners; i++) {
    const index = indices[i];
    if (!Number.isInteger(index) || index < 0 || index >= count) throw rangeError('Invalid geometry', 'geometry');
    out[i] = index;
  }
  const vertices = new Float32Array(count * 6),
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++)
    for (let axis = 0; axis < 3; axis++) {
      const p = positions[v * 3 + axis];
      vertices[v * 6 + axis] = p;
      vertices[v * 6 + 3 + axis] = normals[v * 3 + axis];
      low[axis] = Math.min(low[axis], p);
      high[axis] = Math.max(high[axis], p);
    }
  const bounds = new Float32Array(4);
  if (count) for (let axis = 0; axis < 3; axis++) bounds[axis] = (low[axis] + high[axis]) / 2;
  let radius = 0;
  for (let v = 0; v < count; v++)
    radius = Math.max(
      radius,
      Math.hypot(vertices[v * 6] - bounds[0], vertices[v * 6 + 1] - bounds[1], vertices[v * 6 + 2] - bounds[2]),
    );
  bounds[3] = radius;
  if (bounds[3] < radius) new Uint32Array(bounds.buffer)[3]++;
  for (let i = 0; i < 4; i++) if (!(Math.abs(bounds[i]) < F32_MAX)) throw rangeError('Bounds: finite values', 'transform');
  return { vertices, indices: out, bounds };
}
