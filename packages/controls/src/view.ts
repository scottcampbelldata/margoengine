import type {Camera} from '@margoengine/core';
import {EPS, cross, dot, madd, normalize, sub, type V3} from './math.js';

/** The camera frame Margo Engine renders with: forward from position to target, right from forward x world +Y, no roll. */
export interface Basis {position: V3; forward: V3; right: V3; up: V3; distance: number; tanHalf: number}

export function basis(camera: Pick<Camera, 'position' | 'target' | 'fov'>): Basis {
  const position = [...camera.position] as V3, offset = sub(camera.target, position), distance = Math.hypot(...offset);
  const forward = distance ? normalize(offset) : [0, 0, -1] as V3;
  let right = cross(forward, [0, 1, 0]);
  right = Math.hypot(...right) > EPS ? normalize(right) : [1, 0, 0];
  return {position, forward, right, up: cross(right, forward), distance, tanHalf: Math.tan(camera.fov * Math.PI / 360)};
}

/** Projects a world point to CSS pixels inside a viewport. `depth` is the view-space distance along forward. */
export function project(b: Basis, point: readonly number[], width: number, height: number): {x: number; y: number; depth: number} {
  const d = sub(point, b.position), depth = dot(d, b.forward), aspect = width / height;
  const nx = dot(d, b.right) / (depth * b.tanHalf * aspect), ny = dot(d, b.up) / (depth * b.tanHalf);
  return {x: (nx + 1) / 2 * width, y: (1 - ny) / 2 * height, depth};
}

/** World-space ray through a CSS pixel. */
export function ray(b: Basis, x: number, y: number, width: number, height: number): {origin: V3; direction: V3} {
  const nx = x / width * 2 - 1, ny = 1 - y / height * 2, aspect = width / height;
  return {origin: b.position, direction: normalize(madd(madd(b.forward, b.right, nx * b.tanHalf * aspect), b.up, ny * b.tanHalf))};
}

/** Ray-plane intersection, or null when parallel or behind the ray origin. */
export function intersectPlane(r: {origin: V3; direction: V3}, point: readonly number[], normal: readonly number[]): V3 | null {
  const denominator = dot(r.direction, normal);
  if (Math.abs(denominator) < 1e-9) return null;
  const t = dot(sub(point, r.origin), normal) / denominator;
  return t < 0 ? null : madd(r.origin, r.direction, t);
}
