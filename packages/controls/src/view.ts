import type { Camera } from '@margoengine/core';
import { EPS, madd, type V3 } from './math.js';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';

/**
 * The camera frame Margo Engine renders with: forward from position to target, right from forward x world +Y, no roll.
 * `ortho` is the visible half-height in world units when `camera.matrix` is orthographic (`@margoengine/cameras`); then
 * `position` is moved back by `camera.far` so rays and depths cover an orthographic depth range that starts behind the eye.
 */
export interface Basis {
  position: V3;
  forward: V3;
  right: V3;
  up: V3;
  distance: number;
  tanHalf: number;
  ortho?: number;
}

export function basis(
  camera: Pick<Camera, 'position' | 'target' | 'fov'> & Partial<Pick<Camera, 'matrix' | 'far'>>,
): Basis {
  let position = [...camera.position] as V3;
  const offset = sub(camera.target, position),
    distance = Math.hypot(...offset);
  const forward = distance ? normalize(offset) : ([0, 0, -1] as V3);
  let right = cross(forward, [0, 1, 0]);
  right = Math.hypot(...right) > EPS ? normalize(right) : [1, 0, 0];
  // ponytail: assumes a frustum centred on the view axis (cameras' default); off-centre left/right/top/bottom are not read.
  const m = camera.matrix,
    scaleY = m && !m[3] && !m[7] && !m[11] && m[15] ? Math.hypot(m[1], m[5], m[9]) : 0,
    ortho = scaleY ? 1 / scaleY : undefined;
  if (ortho) position = madd(position, forward, -(camera.far ?? distance));
  return {
    position,
    forward,
    right,
    up: cross(right, forward),
    distance,
    tanHalf: Math.tan((camera.fov * Math.PI) / 360),
    ortho,
  };
}

/** Projects a world point to CSS pixels inside a viewport. `depth` is the view-space distance along forward. */
export function project(
  b: Basis,
  point: readonly number[],
  width: number,
  height: number,
): { x: number; y: number; depth: number } {
  const d = sub(point, b.position),
    depth = dot(d, b.forward),
    aspect = width / height,
    half = b.ortho ?? depth * b.tanHalf;
  const nx = dot(d, b.right) / (half * aspect),
    ny = dot(d, b.up) / half;
  return { x: ((nx + 1) / 2) * width, y: ((1 - ny) / 2) * height, depth };
}

/** World-space ray through a CSS pixel (parallel rays from the moved-back eye plane when orthographic). */
export function ray(b: Basis, x: number, y: number, width: number, height: number): { origin: V3; direction: V3 } {
  const nx = (x / width) * 2 - 1,
    ny = 1 - (y / height) * 2,
    aspect = width / height;
  if (b.ortho)
    return { origin: madd(madd(b.position, b.right, nx * b.ortho * aspect), b.up, ny * b.ortho), direction: b.forward };
  return {
    origin: b.position,
    direction: normalize(madd(madd(b.forward, b.right, nx * b.tanHalf * aspect), b.up, ny * b.tanHalf)),
  };
}

/** Ray-plane intersection, or null when parallel or behind the ray origin. */
export function intersectPlane(
  r: { origin: V3; direction: V3 },
  point: readonly number[],
  normal: readonly number[],
): V3 | null {
  const denominator = dot(r.direction, normal);
  if (Math.abs(denominator) < 1e-9) return null;
  const t = dot(sub(point, r.origin), normal) / denominator;
  return t < 0 ? null : madd(r.origin, r.direction, t);
}
