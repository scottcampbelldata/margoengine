// Where a stage's subject is: a mesh, a fixed point or a function. Shared by the cinematic entries.
import type { Mesh } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';

/** What a stage follows: a mesh (its world position, read each update), a world point, or a function giving one. */
export type CameraTarget = Mesh | ArrayLike<number> | (() => ArrayLike<number>);

/**
 * Writes where `target` is to `out`.
 * @throws RangeError when a point is not three finite numbers.
 * @throws MargoError (code 'disposed') for a disposed mesh.
 */
export function readTarget(target: CameraTarget, out: Float64Array): Float64Array {
  const point = typeof target === 'function' ? target() : target;
  if (!('length' in point)) {
    const mesh = meshRuntime(point as Mesh);
    mesh.check();
    mesh.engine.store.tick(false);
    out[0] = mesh.matrix[12];
    out[1] = mesh.matrix[13];
    out[2] = mesh.matrix[14];
    return out;
  }
  if (point.length !== 3 || !(Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2])))
    throw new RangeError('Invalid camera target; pass a mesh, three finite numbers or a function giving them');
  out[0] = point[0];
  out[1] = point[1];
  out[2] = point[2];
  return out;
}
