import type { Camera } from '@margoengine/core';
import { EPS, madd } from './math.js';
import { basis } from './view.js';

/**
 * Largest elevation of the view direction above or below the horizon, in radians: a milliradian short of straight
 * up or down, so the world-up camera always has a defined screen frame.
 */
export const MAX_PITCH = Math.PI / 2 - 1e-3;

/**
 * Turns the camera by `yaw` radians around world +Y (positive turns left, counterclockwise seen from above) and
 * raises the view by `pitch` radians (positive looks up), with the elevation clamped to plus or minus
 * {@link MAX_PITCH}. The eye stays where it is and the target keeps its distance from it.
 */
export function turn(camera: Pick<Camera, 'position' | 'target' | 'fov'>, yaw: number, pitch: number): void {
  const p = camera.position,
    t = camera.target,
    distance = Math.max(Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]), EPS),
    view = basis(camera).forward;
  // Heading on the ground plane, then the yaw about +Y: a turn by `a` maps (x, z) to (x cos a + z sin a, z cos a - x sin a).
  let hx = view[0],
    hz = view[2],
    flat = Math.hypot(hx, hz);
  if (flat < 1e-12) {
    // Looking straight up or down: leave the pole toward the screen top (looking down) or bottom (looking up).
    const up = (camera as { up?: readonly number[] }).up,
      side = view[1] > 0 ? -1 : 1;
    hx = up ? up[0] * side : 0;
    hz = up ? up[2] * side : -1;
    flat = Math.hypot(hx, hz);
    if (flat < 1e-12) (hx = 0), (hz = -1), (flat = 1);
  }
  hx /= flat;
  hz /= flat;
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    x = hx * c + hz * s,
    z = hz * c - hx * s;
  const elevation = Math.asin(Math.max(-1, Math.min(1, view[1]))),
    next = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, elevation + pitch)),
    across = Math.cos(next);
  camera.target = [p[0] + x * across * distance, p[1] + Math.sin(next) * distance, p[2] + z * across * distance];
}

/** Moves the camera position and target together by `offset`. */
export function translate(camera: Pick<Camera, 'position' | 'target'>, offset: readonly number[]): void {
  camera.position = madd(camera.position, offset, 1);
  camera.target = madd(camera.target, offset, 1);
}

/** Largest change of any coordinate between two snapshots of position and target. */
export function moved(before: readonly number[], camera: Pick<Camera, 'position' | 'target'>): boolean {
  const now = [...camera.position, ...camera.target];
  for (let i = 0; i < 6; i++) if (Math.abs(now[i] - before[i]) > EPS) return true;
  return false;
}
