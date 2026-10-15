import { composeMatrix as compose } from '@margoengine/math/mat4';

export type Vec3 = readonly [number, number, number];
export type Backend = 'webgpu' | 'webgl2';

export interface ScreenPoint {
  /** CSS pixels from the left edge of the canvas. */
  x: number;
  /** CSS pixels from the top edge of the canvas. */
  y: number;
  /** Normalized depth, 0 at the near plane and 1 at the far plane, on both backends. */
  depth: number;
  /** Clip-space w, the distance in front of the camera along its view axis. */
  w: number;
  /** w > 0: the point is in front of the camera. */
  inFront: boolean;
  /** Inside all six frustum planes. */
  inFrustum: boolean;
}

export const createScreenPoint = (): ScreenPoint => ({ x: 0, y: 0, depth: 0, w: 0, inFront: false, inFrustum: false });

/**
 * Projects a world point with a column-major view-projection matrix (Margo Engine `camera.matrix`) to CSS pixels.
 * WebGPU clip space is reversed-Z with z in 0..w (near maps to w); WebGL2 clip space has z in -w..w.
 */
export function projectPoint(
  matrix: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  backend: Backend = 'webgpu',
  out: ScreenPoint = createScreenPoint(),
): ScreenPoint {
  const m = matrix;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  out.w = cw;
  out.inFront = cw > 0;
  if (!out.inFront) {
    out.x = out.y = Number.NaN;
    out.depth = Number.NaN;
    out.inFrustum = false;
    return out;
  }
  const nx = cx / cw,
    ny = cy / cw,
    nz = cz / cw;
  out.depth = backend === 'webgpu' ? 1 - nz : (nz + 1) / 2;
  out.x = ((nx + 1) / 2) * width;
  out.y = ((1 - ny) / 2) * height;
  out.inFrustum = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1 && out.depth >= 0 && out.depth <= 1;
  return out;
}

/** Look-at view matrix (column-major), identical to the one Margo Engine's Camera builds; pass `camera.up` (default +Y). */
export function lookAtView(
  position: Vec3,
  target: Vec3,
  out: Float64Array = new Float64Array(16),
  up: Vec3 = [0, 1, 0],
): Float64Array {
  let zx = position[0] - target[0],
    zy = position[1] - target[1],
    zz = position[2] - target[2];
  const length = Math.hypot(zx, zy, zz);
  if (!length) throw new RangeError('Camera position equals target');
  zx /= length;
  zy /= length;
  zz /= length;
  const u = up;
  let xx = u[1] * zz - u[2] * zy,
    xy = u[2] * zx - u[0] * zz,
    xz = u[0] * zy - u[1] * zx;
  const side = Math.hypot(xx, xy, xz);
  if (!side) throw new RangeError('Camera is parallel to its up vector');
  xx /= side;
  xy /= side;
  xz /= side;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx,
    p = position;
  out.fill(0);
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[12] = -xx * p[0] - xy * p[1] - xz * p[2];
  out[13] = -yx * p[0] - yy * p[1] - yz * p[2];
  out[14] = -zx * p[0] - zy * p[1] - zz * p[2];
  out[15] = 1;
  return out;
}

/** CSS `perspective` in pixels that matches a vertical field of view (degrees) on a viewport `height` CSS pixels tall. */
export const cssPerspective = (fov: number, height: number): number => height / 2 / Math.tan((fov * Math.PI) / 360);

const number = (value: number): string => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

/**
 * Transform for the CSS3D camera element: move by the perspective distance, apply the view matrix with Y flipped
 * into CSS (Y down), and center the origin in the viewport. Same construction as THREE.CSS3DRenderer.
 */
export function cameraCSSTransform(
  view: ArrayLike<number>,
  perspective: number,
  width: number,
  height: number,
): string {
  const v = view;
  return `translateZ(${number(perspective)}px) matrix3d(${[v[0], -v[1], v[2], v[3], v[4], -v[5], v[6], v[7], v[8], -v[9], v[10], v[11], v[12], -v[13], v[14], v[15]].map(number).join(',')}) translate(${number(width / 2)}px,${number(height / 2)}px)`;
}

/**
 * Transform for the CSS3D camera element under an orthographic view-projection (clip w independent of position, e.g.
 * @margoengine/cameras), read from the clip matrix itself: world to CSS pixels from the viewport centre, Y down, with
 * Z scaled like Y so that CSS depth sorting follows the camera. Use it with `perspective: none` on the viewer, as
 * THREE.CSS3DRenderer does for an OrthographicCamera.
 */
export function orthographicCSSTransform(
  matrix: ArrayLike<number>,
  width: number,
  height: number,
  backend: Backend = 'webgpu',
): string {
  const m = matrix,
    x = width / 2,
    y = height / 2,
    z = ((backend === 'webgpu' ? y : -y) * Math.hypot(m[1], m[5], m[9])) / (Math.hypot(m[2], m[6], m[10]) || 1);
  return `matrix3d(${[0, 4, 8, 12]
    .flatMap((c) => [m[c] * x, -m[c + 1] * y, m[c + 2] * z, c === 12 ? 1 : 0])
    .map(number)
    .join(',')}) translate(${number(x)}px,${number(y)}px)`;
}

/** True when a column-major view-projection is orthographic: clip w does not depend on position. */
export const isOrthographic = (matrix: ArrayLike<number>): boolean => !(matrix[3] || matrix[7] || matrix[11]);

/**
 * Transform for a CSS3D object: center the element on its origin, scale CSS pixels to world units with `pixelScale`,
 * flip CSS Y down to world Y up, then apply the column-major world matrix.
 */
export function objectCSSTransform(world: ArrayLike<number>, pixelScale = 1): string {
  const w = world,
    s = pixelScale;
  return `translate(-50%,-50%) matrix3d(${[w[0] * s, w[1] * s, w[2] * s, w[3] * s, -w[4] * s, -w[5] * s, -w[6] * s, -w[7] * s, w[8] * s, w[9] * s, w[10] * s, w[11] * s, w[12], w[13], w[14], w[15]].map(number).join(',')})`;
}

/** World position of an element-local CSS point (pixels from the element center, Y down) on a CSS3D object. */
export function cssPointToWorld(
  world: ArrayLike<number>,
  pixelScale: number,
  x: number,
  y: number,
): [number, number, number] {
  const lx = x * pixelScale,
    ly = -y * pixelScale,
    w = world;
  return [w[0] * lx + w[4] * ly + w[12], w[1] * lx + w[5] * ly + w[13], w[2] * lx + w[6] * ly + w[14]];
}

/** Column-major world matrix from position, quaternion [x, y, z, w] and uniform or per-axis scale. */
export function composeMatrix(
  position: Vec3,
  quaternion: readonly number[] = [0, 0, 0, 1],
  scale: Vec3 = [1, 1, 1],
  out: Float64Array = new Float64Array(16),
): Float64Array {
  const [x, y, z, w] = quaternion,
    length = Math.hypot(x, y, z, w) || 1;
  return compose(position, [x / length, y / length, z / length, w / length], scale, out);
}
