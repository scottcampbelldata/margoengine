// Picking: a camera ray through the pointer, the first filled cell along a ray, and the ground cell under it.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { invertMatrixStable } from '@margoengine/math/mat4';
import type { GridSource } from './edit.js';
import { checkGrid, checkPoint, type GridHit, MAX_CELLS, exposedNormal, unitDirection } from './grid.js';
import { SparseGrid } from './sparse.js';

/** A ray in a grid's local cells. */
export interface GridRay {
  /** Start point. */
  origin: Vec3;
  /** Direction; any nonzero length. */
  direction: Vec3;
}

/**
 * The ray under a pointer: `x` and `y` in normalized device coordinates (-1 to 1, y up) and `matrix` the camera's
 * view-projection (`engine.camera.matrix`, WebGPU reverse depth). The origin is on the near plane and the direction
 * unit length. Null when the matrix cannot be inverted. Transform it into a model's cells before casting.
 */
export function pickRay(matrix: ArrayLike<number>, x: number, y: number): GridRay | null {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new RangeError('pickRay x and y are not finite; pass NDC numbers');
  const inverse = invertMatrixStable(matrix, new Float64Array(16));
  if (!inverse) return null;
  const unproject = (z: number): MutableVec3 | null => {
    const w = inverse[3] * x + inverse[7] * y + inverse[11] * z + inverse[15];
    if (!w) return null;
    return [0, 1, 2].map(
      (r) => (inverse[r] * x + inverse[4 + r] * y + inverse[8 + r] * z + inverse[12 + r]) / w,
    ) as MutableVec3;
  };
  const near = unproject(1),
    far = unproject(0);
  if (!near || !far) return null;
  const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]],
    length = Math.hypot(d[0], d[1], d[2]);
  if (!length || !Number.isFinite(length)) return null;
  return { origin: near, direction: [d[0] / length, d[1] / length, d[2] / length] };
}

/**
 * The first filled cell along `ray` within `maxDistance` (measured along the normalized direction), or null. A ray
 * that only touches a cell's edge or corner misses it. Where a ray crosses an edge or corner of a filled cell, the
 * reported normal is the exposed face (the neighbour is empty), so Face Attach and faceCells see that surface;
 * among exposed faces, the one most head-on to the ray. Sparse grids visit only chunks the ray crosses.
 */
export function raycastGrid(source: GridSource, ray: GridRay, maxDistance = Infinity): GridHit | null {
  if (typeof ray !== 'object' || ray === null)
    throw new TypeError('raycastGrid ray is missing; pass {origin, direction}');
  if (source instanceof SparseGrid) return source.raycast(ray.origin, ray.direction, maxDistance);
  checkGrid(source, MAX_CELLS);
  checkPoint(ray.origin, 'raycastGrid origin');
  checkPoint(ray.direction, 'raycastGrid direction');
  if (!(maxDistance >= 0)) throw new RangeError('raycastGrid maxDistance is negative; pass 0 or more');
  const size = source.size,
    [sx, , sz] = size,
    o = ray.origin,
    d = unitDirection(ray.direction, 'raycastGrid'),
    at = (c: number[]) => source.voxels[c[0] + sx * (c[2] + sz * c[1])],
    inside = (c: number[]) => c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < size[0] && c[1] < size[1] && c[2] < size[2],
    start: MutableVec3 = [Math.floor(o[0]), Math.floor(o[1]), Math.floor(o[2])];
  if (inside(start) && at(start))
    return { cell: start, adjacent: [...start], normal: [0, 0, 0], value: at(start), distance: 0 };
  // Clip the ray to the grid box; `normal` is the face it enters through.
  let enter = 0,
    exit = maxDistance,
    normal: MutableVec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    if (!d[axis]) {
      if (o[axis] < 0 || o[axis] >= size[axis]) return null;
      continue;
    }
    const a = -o[axis] / d[axis],
      b = (size[axis] - o[axis]) / d[axis],
      near = Math.min(a, b);
    if (near > enter || (near === enter && !inside(start))) {
      enter = near;
      normal = [0, 0, 0];
      normal[axis] = -Math.sign(d[axis]);
    }
    exit = Math.min(exit, Math.max(a, b));
  }
  if (enter > exit) return null;
  const cell = [0, 1, 2].map((axis) => Math.floor(o[axis] + d[axis] * (enter + 1e-7))),
    step = d.map(Math.sign),
    span = d.map((v) => (v ? Math.abs(1 / v) : Infinity)),
    next = d.map((v, axis) => (v ? (cell[axis] + (v > 0 ? 1 : 0) - o[axis]) / v : Infinity));
  let distance = Math.max(0, enter); // never -0
  for (let n = 0; n <= size[0] + size[1] + size[2] + 3 && inside(cell); n++) {
    const value = at(cell);
    if (value)
      return {
        cell: [cell[0], cell[1], cell[2]],
        adjacent: [cell[0] + normal[0], cell[1] + normal[1], cell[2] + normal[2]],
        normal,
        value,
        distance,
      };
    const t = Math.min(next[0], next[1], next[2]);
    if (t > exit) break;
    distance = t;
    const tied: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
      if (next[axis] > t + 1e-8) continue;
      cell[axis] += step[axis];
      next[axis] += span[axis];
      tied.push(axis);
    }
    normal = exposedNormal(cell, tied, d, (x, y, z) => inside([x, y, z]) && at([x, y, z]) > 0);
  }
  return null;
}

/** The cell at y = 0 where `ray` meets the ground plane, inside a grid of `size` on x and z, or null. */
export function groundCell(size: Vec3, ray: GridRay): MutableVec3 | null {
  checkPoint(ray?.origin, 'groundCell origin');
  checkPoint(ray.direction, 'groundCell direction');
  if (!ray.direction[1]) return null;
  const t = -ray.origin[1] / ray.direction[1];
  if (t < 0) return null;
  const x = Math.floor(ray.origin[0] + ray.direction[0] * t),
    z = Math.floor(ray.origin[2] + ray.direction[2] * t);
  return x >= 0 && z >= 0 && x < size[0] && z < size[2] && size[1] > 0 ? [x, 0, z] : null;
}
