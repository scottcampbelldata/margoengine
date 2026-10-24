// CSS 3D transform strings for CSS3D objects (CSS Transforms Module Level 1 and 2).
//
// Margo matrices are 4x4 column-major (index = column * 4 + row), world space is right-handed with +Y up and the
// camera looks down its local -Z. CSS space is +X right, +Y down, +Z toward the viewer, and `matrix3d()` lists its
// sixteen values column by column, the same order as Margo matrices. A transform list composes left to right by
// post-multiplication and is applied about the element's transform-origin (its centre by default).
import type { Backend } from '@margoengine/math/mat4';
export type { Backend };

export type Vec3 = readonly [number, number, number];

// Rounding grid for every number written into a transform string: fine enough for sub-micro-pixel placement, coarse
// enough that float noise between frames does not change the string (the renderer skips DOM writes on equal strings).
const GRID = 1e6;

/** Plain-decimal text for `value` on a 1e-6 grid; negative zero prints as 0. */
function num(value: number): string {
  const rounded = Math.round(value * GRID) / GRID;
  return rounded === 0 ? '0' : String(rounded);
}

/** Comma-separated text of a 16-number column-major matrix. */
function matrixText(m: ArrayLike<number>): string {
  let text = num(m[0]);
  for (let i = 1; i < 16; i++) text += `,${num(m[i])}`;
  return text;
}

/**
 * Right-handed look-at view matrix (column-major), the same matrix core's `Camera` builds.
 *
 * The camera's local Z points from `target` back to `position`, X = up x Z and Y = Z x X; the rotation rows are X, Y
 * and Z, and the translation is the rotated position negated.
 *
 * @param position - Eye position in world space.
 * @param target - Point the camera looks at.
 * @param out - Destination, written and returned (default: a new Float64Array(16)).
 * @param up - World up direction (default +Y).
 * @throws RangeError when `position` equals `target`, or when the view direction is parallel to `up`.
 */
export function lookAtView(
  position: Vec3,
  target: Vec3,
  out: Float64Array = new Float64Array(16),
  up: Vec3 = [0, 1, 0],
): Float64Array {
  let zx = position[0] - target[0],
    zy = position[1] - target[1],
    zz = position[2] - target[2];
  const zLength = Math.hypot(zx, zy, zz);
  if (zLength === 0) throw new RangeError('Camera position equals target; move the camera or its target apart');
  zx /= zLength;
  zy /= zLength;
  zz /= zLength;
  // X = up x Z.
  let xx = up[1] * zz - up[2] * zy,
    xy = up[2] * zx - up[0] * zz,
    xz = up[0] * zy - up[1] * zx;
  const xLength = Math.hypot(xx, xy, xz);
  if (xLength === 0)
    throw new RangeError('Camera is parallel to its up vector; choose an up vector not along the view direction');
  xx /= xLength;
  xy /= xLength;
  xz /= xLength;
  // Y = Z x X (already unit length: Z and X are orthonormal).
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * position[0] + xy * position[1] + xz * position[2]);
  out[13] = -(yx * position[0] + yy * position[1] + yz * position[2]);
  out[14] = -(zx * position[0] + zy * position[1] + zz * position[2]);
  out[15] = 1;
  return out;
}

/**
 * CSS `perspective` length in pixels that reproduces a vertical field of view on a viewport.
 *
 * Pinhole geometry: half the viewport height over the tangent of half the field of view.
 *
 * @param fov - Vertical field of view in degrees.
 * @param height - Viewport height in CSS pixels.
 */
export const cssPerspective = (fov: number, height: number): number => height / 2 / Math.tan((fov * Math.PI) / 360);

/**
 * CSS transform for the camera element (sized `width` x `height`) under a perspective camera.
 *
 * The list pushes the scene back by the viewer's perspective distance, applies the view matrix with its Y row negated
 * (world Y up to CSS Y down), then moves the origin to the element's centre. Use with the viewer element's
 * `perspective` set to the same `perspective` length.
 *
 * @param view - Column-major view matrix, e.g. from {@link lookAtView}.
 * @param perspective - The viewer's CSS perspective in pixels, from {@link cssPerspective}.
 * @param width - Viewport width in CSS pixels.
 * @param height - Viewport height in CSS pixels.
 */
export function cameraCSSTransform(
  view: ArrayLike<number>,
  perspective: number,
  width: number,
  height: number,
): string {
  let rows = '';
  for (let i = 0; i < 16; i++) rows += (i ? ',' : '') + num(i % 4 === 1 ? -view[i] : view[i]);
  return `translateZ(${num(perspective)}px) matrix3d(${rows}) translate(${num(width / 2)}px,${num(height / 2)}px)`;
}

/**
 * CSS transform for the camera element under an orthographic view-projection (viewer `perspective: none`).
 *
 * World points map straight to CSS pixels about the viewport centre through `matrix` itself, so zoom, offsets and
 * custom projections carry over. Depth is scaled so one world unit along the view axis is as long in CSS as one along
 * screen Y, with the sign chosen so nearer points get larger CSS z on either backend's depth convention.
 *
 * @param matrix - Column-major orthographic view-projection (clip matrix).
 * @param width - Viewport width in CSS pixels.
 * @param height - Viewport height in CSS pixels.
 * @param backend - Clip-space convention of `matrix` (default 'webgpu', reversed Z).
 */
export function orthographicCSSTransform(
  matrix: ArrayLike<number>,
  width: number,
  height: number,
  backend: Backend = 'webgpu',
): string {
  const halfWidth = width / 2,
    halfHeight = height / 2;
  const yRow = Math.hypot(matrix[1], matrix[5], matrix[9]);
  const zRow = Math.hypot(matrix[2], matrix[6], matrix[10]) || 1;
  // WebGPU uses reversed Z (larger clip z is nearer); WebGL2 clip z grows with distance.
  const depth = ((backend === 'webgl2' ? -halfHeight : halfHeight) * yRow) / zRow;
  const css = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  for (let column = 0; column < 4; column++) {
    const c = column * 4;
    css[c] = matrix[c] * halfWidth;
    css[c + 1] = -matrix[c + 1] * halfHeight;
    css[c + 2] = matrix[c + 2] * depth;
  }
  return `matrix3d(${matrixText(css)}) translate(${num(halfWidth)}px,${num(halfHeight)}px)`;
}

/**
 * CSS transform for a CSS3D object element from its world matrix.
 *
 * The element is first centred on its origin (-50% of its own box), then placed by the world matrix with CSS pixels
 * scaled to world units and CSS Y flipped to world Y: one pixel right is `pixelScale` along the matrix's X axis, one
 * pixel down is `-pixelScale` along its Y axis.
 *
 * @param world - Column-major world matrix.
 * @param pixelScale - World units per CSS pixel (default 1).
 */
export function objectCSSTransform(world: ArrayLike<number>, pixelScale = 1): string {
  let text = '';
  for (let i = 0; i < 16; i++) {
    const column = i >> 2;
    const scale = column === 3 ? 1 : column === 1 ? -pixelScale : pixelScale;
    text += (i ? ',' : '') + num(world[i] * scale);
  }
  return `translate(-50%,-50%) matrix3d(${text})`;
}

/**
 * World position of a point on a CSS3D object given in element pixels from the element centre (x right, y down).
 *
 * The inverse of the placement {@link objectCSSTransform} makes; useful for hit testing.
 *
 * @param world - Column-major world matrix of the object (affine).
 * @param pixelScale - World units per CSS pixel.
 * @param x - Pixels right of the element centre.
 * @param y - Pixels below the element centre.
 */
export function cssPointToWorld(
  world: ArrayLike<number>,
  pixelScale: number,
  x: number,
  y: number,
): [number, number, number] {
  const u = x * pixelScale,
    v = -y * pixelScale;
  return [
    world[0] * u + world[4] * v + world[12],
    world[1] * u + world[5] * v + world[13],
    world[2] * u + world[6] * v + world[14],
  ];
}

/**
 * Column-major translation-rotation-scale matrix.
 *
 * @param position - Translation.
 * @param quaternion - Rotation [x, y, z, w], normalised here; a zero quaternion gives no rotation (default identity).
 * @param scale - Scale per local axis (default [1, 1, 1]).
 * @param out - Destination, written and returned (default: a new Float64Array(16)).
 */
export function composeMatrix(
  position: Vec3,
  quaternion: readonly number[] = [0, 0, 0, 1],
  scale: Vec3 = [1, 1, 1],
  out: Float64Array = new Float64Array(16),
): Float64Array {
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]) || 1;
  const x = quaternion[0] / length,
    y = quaternion[1] / length,
    z = quaternion[2] / length,
    w = quaternion[3] / length;
  const sx = scale[0],
    sy = scale[1],
    sz = scale[2];
  // Rotation matrix of a unit quaternion (Hamilton convention), each column scaled by its axis scale.
  out[0] = (1 - 2 * (y * y + z * z)) * sx;
  out[1] = 2 * (x * y + w * z) * sx;
  out[2] = 2 * (x * z - w * y) * sx;
  out[3] = 0;
  out[4] = 2 * (x * y - w * z) * sy;
  out[5] = (1 - 2 * (x * x + z * z)) * sy;
  out[6] = 2 * (y * z + w * x) * sy;
  out[7] = 0;
  out[8] = 2 * (x * z + w * y) * sz;
  out[9] = 2 * (y * z - w * x) * sz;
  out[10] = (1 - 2 * (x * x + y * y)) * sz;
  out[11] = 0;
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  out[15] = 1;
  return out;
}
