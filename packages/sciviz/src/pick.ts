// Picking and selection maths, CPU only: data points projected to CSS pixels with the camera and figure transforms
// (the nearest within a radius is the hover pick; those inside a rectangle or lasso polygon are the selection), and a
// screen ray cast into a height field (stepped across the grid, then bisected to the crossing of the bilinear
// surface). Point-in-polygon uses the even-odd crossing rule (W. R. Franklin's formulation, after M. Shimrat,
// "Algorithm 112: Position of point relative to polygon", CACM 5(8), 1962).
import { invertMatrix, multiplyMatrices, projectPoint } from '@margoengine/math/mat4';

/** A screen region in CSS pixels relative to the canvas: a rectangle [x0, y0, x1, y1] or a polygon [x, y, x, y, ...]. */
export type SelectRegion =
  | { readonly rect: readonly [number, number, number, number] }
  | { readonly polygon: ArrayLike<number> };

/** True when (x, y) is inside the closed `polygon` [x0, y0, x1, y1, ...] (even-odd rule). */
export function pointInPolygon(x: number, y: number, polygon: ArrayLike<number>): boolean {
  let inside = false;
  const n = polygon.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2],
      yi = polygon[i * 2 + 1],
      xj = polygon[j * 2],
      yj = polygon[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when (x, y) lies in `region`. */
export function inRegion(x: number, y: number, region: SelectRegion): boolean {
  if ('rect' in region) {
    const [x0, y0, x1, y1] = region.rect;
    return x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && y >= Math.min(y0, y1) && y <= Math.max(y0, y1);
  }
  return pointInPolygon(x, y, region.polygon);
}

/**
 * The point (xyz per point in `positions`, data units) nearest the screen position (sx, sy) within `radius` CSS
 * pixels, under `matrix` (camera clip times data-to-scene). Ties within half a pixel go to the point nearest the eye.
 * Points behind the eye are skipped. Returns the index and its screen distance, or null.
 */
export function nearestPoint(
  matrix: ArrayLike<number>,
  positions: ArrayLike<number>,
  width: number,
  height: number,
  sx: number,
  sy: number,
  radius: number,
): { index: number; distance: number } | null {
  let best = -1,
    bestDistance = radius,
    bestDepth = Infinity;
  const p = { x: 0, y: 0, depth: 0, w: 0, inFront: false, inFrustum: false };
  for (let i = 0, n = positions.length / 3; i < n; i++) {
    projectPoint(matrix, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], width, height, 'webgpu', p);
    if (!p.inFront) continue;
    const d = Math.hypot(p.x - sx, p.y - sy);
    // projectPoint normalizes both backends to near=0, far=1.
    if (d < bestDistance - 0.5 || (d <= bestDistance + 0.5 && d <= radius && p.depth < bestDepth)) {
      best = i;
      bestDistance = d;
      bestDepth = p.depth;
    }
  }
  return best < 0 ? null : { index: best, distance: bestDistance };
}

/** Indices of the points (xyz per point, data units) whose screen positions under `matrix` fall inside `region`. */
export function selectPoints(
  matrix: ArrayLike<number>,
  positions: ArrayLike<number>,
  width: number,
  height: number,
  region: SelectRegion,
): Uint32Array {
  const out: number[] = [];
  const p = { x: 0, y: 0, depth: 0, w: 0, inFront: false, inFrustum: false };
  for (let i = 0, n = positions.length / 3; i < n; i++) {
    projectPoint(matrix, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], width, height, 'webgpu', p);
    if (p.inFront && inRegion(p.x, p.y, region)) out.push(i);
  }
  return Uint32Array.from(out);
}

/**
 * The ray in data units under the screen position (sx, sy): origin on the near plane and unit direction away from the
 * eye. `matrix` is camera clip times data-to-scene; null when it cannot be inverted.
 */
export function screenRay(
  matrix: ArrayLike<number>,
  width: number,
  height: number,
  sx: number,
  sy: number,
): { origin: [number, number, number]; direction: [number, number, number] } | null {
  const inverse = invertMatrix(matrix);
  if (!inverse) return null;
  const nx = (sx / width) * 2 - 1,
    ny = 1 - (sy / height) * 2;
  // WebGPU clip space is reversed-Z: depth 1 at the near plane, 0 at the far plane.
  const at = (z: number): [number, number, number] => {
    const m = inverse;
    const w = m[3] * nx + m[7] * ny + m[11] * z + m[15];
    return [
      (m[0] * nx + m[4] * ny + m[8] * z + m[12]) / w,
      (m[1] * nx + m[5] * ny + m[9] * z + m[13]) / w,
      (m[2] * nx + m[6] * ny + m[10] * z + m[14]) / w,
    ];
  };
  const near = at(1),
    far = at(0.5);
  const d: [number, number, number] = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const length = Math.hypot(d[0], d[1], d[2]);
  if (!(length > 0) || !near.every(Number.isFinite)) return null;
  return { origin: near, direction: [d[0] / length, d[1] / length, d[2] / length] };
}

/** A regular height-field grid: heights[j * nx + i] at x = x0 + i dx, y = y0 + j dy. */
export interface HeightGrid {
  readonly heights: ArrayLike<number>;
  readonly nx: number;
  readonly ny: number;
  readonly x0: number;
  readonly dx: number;
  readonly y0: number;
  readonly dy: number;
}

/** Bilinear height of `grid` at data (x, y); NaN outside the grid or next to a NaN height. */
export function heightAt(grid: HeightGrid, x: number, y: number): number {
  const u = (x - grid.x0) / grid.dx,
    v = (y - grid.y0) / grid.dy;
  if (!(u >= 0 && v >= 0 && u <= grid.nx - 1 && v <= grid.ny - 1)) return Number.NaN;
  const i = Math.min(Math.floor(u), grid.nx - 2),
    j = Math.min(Math.floor(v), grid.ny - 2),
    fu = u - i,
    fv = v - j,
    h = grid.heights,
    k = j * grid.nx + i;
  return (h[k] * (1 - fu) + h[k + 1] * fu) * (1 - fv) + (h[k + grid.nx] * (1 - fu) + h[k + grid.nx + 1] * fu) * fv;
}

/**
 * The first crossing of a ray (data units) with the bilinear surface of `grid`, or null. Steps at half the smaller
 * cell size through the grid's x-y extent, then bisects the step where the ray passes below the surface.
 */
export function rayHeightField(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  grid: HeightGrid,
): { x: number; y: number; z: number; t: number } | null {
  const x1 = grid.x0 + grid.dx * (grid.nx - 1),
    y1 = grid.y0 + grid.dy * (grid.ny - 1);
  // Clip the ray to the grid's x-y slab.
  let t0 = 0,
    t1 = Infinity;
  for (const [o, d, lo, hi] of [
    [origin[0], direction[0], Math.min(grid.x0, x1), Math.max(grid.x0, x1)],
    [origin[1], direction[1], Math.min(grid.y0, y1), Math.max(grid.y0, y1)],
  ]) {
    if (Math.abs(d) < 1e-30) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const a = (lo - o) / d,
      b = (hi - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (!(t1 >= t0)) return null;
  // Step in the ray's x-y travel, so a steep ray does not take millions of steps.
  const planar = Math.hypot(direction[0], direction[1]),
    cell = Math.min(Math.abs(grid.dx), Math.abs(grid.dy)) / 2,
    steps = planar > 1e-12 ? Math.min(1 << 20, Math.ceil(((t1 - t0) * planar) / cell) + 1) : 1,
    dt = steps > 1 ? (t1 - t0) / steps : 0;
  const above = (t: number): number => {
    const h = heightAt(grid, origin[0] + direction[0] * t, origin[1] + direction[1] * t);
    return h === h ? origin[2] + direction[2] * t - h : Number.NaN;
  };
  let tPrev = t0,
    fPrev = above(t0);
  if (steps === 1) {
    // Straight down (or up): the hit is the height under the ray.
    const h = heightAt(grid, origin[0], origin[1]);
    if (h !== h || Math.abs(direction[2]) < 1e-30) return null;
    const t = (h - origin[2]) / direction[2];
    return t >= 0 ? { x: origin[0], y: origin[1], z: h, t } : null;
  }
  for (let s = 1; s <= steps; s++) {
    const t = t0 + dt * s,
      f = above(t);
    if (fPrev === fPrev && f === f && fPrev > 0 !== f > 0) {
      let a = tPrev,
        b = t,
        fa = fPrev;
      for (let k = 0; k < 40; k++) {
        const m = (a + b) / 2,
          fm = above(m);
        if (fm !== fm) break;
        if (fa > 0 === fm > 0) {
          a = m;
          fa = fm;
        } else b = m;
      }
      const tHit = (a + b) / 2,
        x = origin[0] + direction[0] * tHit,
        y = origin[1] + direction[1] * tHit;
      return { x, y, z: heightAt(grid, x, y), t: tHit };
    }
    tPrev = t;
    fPrev = f;
  }
  return null;
}

/** The camera clip matrix times the figure's data-to-scene transform: data units to clip space. */
export const dataToClip = (clip: ArrayLike<number>, model: ArrayLike<number>): Float64Array =>
  multiplyMatrices(clip, model);
