import { invertMatrixStable } from './mat4.js';
import type { Vec3Like } from './types.js';

/**
 * Anything with a column-major view-projection `matrix` of 16 numbers, such as core's `engine.camera`, whose matrix is
 * valid once it has been updated (the first frame, or `camera.update(aspect, webgpu)`).
 */
export interface ProjectionCamera {
  readonly matrix: ArrayLike<number>;
}

const inverse = new Float64Array(16),
  workspace = new Float64Array(52);

function matrixOf(camera: ProjectionCamera): ArrayLike<number> {
  const m = camera?.matrix;
  if (!m || m.length !== 16)
    throw new TypeError('camera must have a 16-element column-major view-projection matrix, such as engine.camera');
  return m;
}

/**
 * World `point` to normalized device coordinates in `out`: x and y run -1..1 across the view with +y up, z is the
 * camera's own depth (on WebGPU near = 1 and far = 0, on WebGL near = -1 and far = 1). Inside the view x and y are
 * within -1..1. Returns null, leaving `out` as it was, for a point on or behind the camera plane (clip w <= 0, or a
 * non-finite point): such a point has no place on screen, and dividing would mirror it. `out` may be `point`.
 * @throws TypeError when `camera` has no 16-element `matrix`.
 */
export function projectPoint<T extends Vec3Like>(point: Vec3Like, camera: ProjectionCamera, out: T): T | null {
  const e = matrixOf(camera),
    { x, y, z } = point,
    w = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (!(w > 0) || w === Infinity) return null;
  out.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
  out.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
  out.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
  return out;
}

/**
 * Normalized device coordinates (as {@link projectPoint} writes them) to a world point in `out`. Returns null, leaving
 * `out` as it was, when the coordinates lie at infinity (homogeneous w of 0). `out` may be `ndc`.
 * @throws TypeError when `camera` has no 16-element `matrix`.
 * @throws RangeError when the matrix has no inverse, as in a camera that has not been updated yet.
 */
export function unprojectPoint<T extends Vec3Like>(ndc: Vec3Like, camera: ProjectionCamera, out: T): T | null {
  const e = invertMatrixStable(matrixOf(camera), inverse, workspace);
  if (!e)
    throw new RangeError(
      'camera.matrix has no inverse; draw a frame or call camera.update(aspect, webgpu) before unprojecting',
    );
  const { x, y, z } = ndc,
    w = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (w === 0 || !Number.isFinite(w)) return null;
  out.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
  out.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
  out.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
  return out;
}

/**
 * World `point` to pixels in a `width` x `height` view: x right and y down from the top-left corner (the units are
 * whatever `width` and `height` are, CSS or device pixels), z the depth as in {@link projectPoint}. Returns null,
 * leaving `out` as it was, for a point on or behind the camera plane. `out` may be `point`.
 * @throws TypeError when `camera` has no 16-element `matrix`.
 */
export function worldToScreen<T extends Vec3Like>(
  point: Vec3Like,
  camera: ProjectionCamera,
  width: number,
  height: number,
  out: T,
): T | null {
  if (!projectPoint(point, camera, out)) return null;
  out.x = ((out.x + 1) * width) / 2;
  out.y = ((1 - out.y) * height) / 2;
  return out;
}

/**
 * Pixels `x`, `y` of a `width` x `height` view (as {@link worldToScreen} writes them) and `depth` (the camera's own, as
 * in {@link projectPoint}) to a world point in `out`. Returns null, leaving `out` as it was, at infinity.
 * @throws TypeError when `camera` has no 16-element `matrix`.
 * @throws RangeError when the matrix has no inverse, as in a camera that has not been updated yet.
 */
export function screenToWorld<T extends Vec3Like>(
  x: number,
  y: number,
  depth: number,
  camera: ProjectionCamera,
  width: number,
  height: number,
  out: T,
): T | null {
  return unprojectPoint({ x: (x / width) * 2 - 1, y: 1 - (y / height) * 2, z: depth }, camera, out);
}
