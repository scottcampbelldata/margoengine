/** Column-major 4x4 helpers only lines uses; shared ones come from `@margoengine/math/mat4`. */
import type { Mat4 } from '@margoengine/math';
import type { Camera } from '@margoengine/core';
import { lineTiles } from './tile-state.js';

export type { Mat4 };

export const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * The Frame uniform of the line shaders: `matrix`, the target size in pixels, CSS to target pixels, the camera's focal
 * length for a view `viewHeight` pixels tall and whether to encode sRGB.
 */
export function fillFrame(
  data: Float32Array,
  matrix: ArrayLike<number>,
  camera: Camera,
  width: number,
  height: number,
  ratio: number,
  viewHeight: number,
  encode: number,
): void {
  const tile = matrix === camera.matrix ? lineTiles.get(camera) : undefined;
  if (tile) {
    matrix = tile.matrix;
    ratio *= tile.fullWidth / width;
    width = tile.fullWidth;
    height = viewHeight = tile.fullHeight;
  }
  const m = tile ? tile.matrix : camera.matrix;
  data.set(matrix, 0);
  data[16] = width;
  data[17] = height;
  data[18] = ratio;
  // Pixels per world unit at clip w 1. Orthographic (clip w constant, e.g. @margoengine/cameras): from the y row's length.
  data[19] =
    m[3] || m[7] || m[11]
      ? (0.5 * viewHeight) / Math.tan((camera.fov * Math.PI) / 360)
      : 0.5 * viewHeight * Math.hypot(m[1], m[5], m[9]);
  data[20] = encode;
  data[21] = tile ? 1 : 0;
  if (data.length >= 28)
    data.set(
      tile
        ? [
            tile.fullWidth / tile.width,
            tile.fullHeight / tile.height,
            (tile.fullWidth - 2 * tile.x - tile.width) / tile.width,
            (2 * tile.y + tile.height - tile.fullHeight) / tile.height,
          ]
        : [1, 1, 0, 0],
      24,
    );
}

/** Writes M * (x, y, z, 1) divided by w into out at offset. */
export function transformPoint(
  out: Float32Array | number[],
  offset: number,
  m: Mat4,
  x: number,
  y: number,
  z: number,
): void {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[offset] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[offset + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[offset + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
}

/** Copies source into target and reports whether anything changed. */
export function copyIfChanged(target: Float32Array, source: Mat4): boolean {
  let changed = false;
  for (let i = 0; i < target.length; i++)
    if (target[i] !== source[i]) {
      target[i] = source[i];
      changed = true;
    }
  return changed;
}

export function finiteArray(values: ArrayLike<number>, label: string): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
      throw new RangeError(`${label} must be finite Float32 values`);
  }
}

/**
 * Validates up to 6 world-space planes `[a, b, c, d]` and returns them flat with unit normals. `label` names the
 * owner in messages. Throws TypeError for a malformed plane or a zero normal, RangeError for more than 6.
 */
export function clipPlanes(planes: readonly (readonly number[])[], label: string): number[] {
  if (!Array.isArray(planes)) throw new TypeError(`${label} clippingPlanes must be an array of [a, b, c, d] planes`);
  if (planes.length > 6) throw new RangeError(`${label} clippingPlanes holds at most 6 planes; pass fewer`);
  const flat: number[] = [];
  for (const p of planes) {
    if (
      !Array.isArray(p) ||
      p.length !== 4 ||
      !p.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x)))
    )
      throw new TypeError(`${label} clipping plane must be four finite numbers [a, b, c, d]`);
    const length = Math.hypot(p[0], p[1], p[2]);
    if (!length) throw new TypeError(`${label} clipping plane needs a non-zero normal [a, b, c]`);
    flat.push(p[0] / length, p[1] / length, p[2] / length, p[3] / length);
  }
  return flat;
}
