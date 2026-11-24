// Where a head's upper lid crosses its eyeball, for `eye()`'s `lid`. The eye material shades the ball under the lid's
// margin (`@margoengine/materials/eye`), so it must know where the margin is: a fixed margin above the axis would put the
// shading under the skin on a hooded eye or over the open white on a wide one. Seen along the eye's axis, a point of
// the ball is under the lid when a ray from it out of the eye meets the head's skin (Moller and Trumbore, "Fast, Minimum
// Storage Ray-Triangle Intersection", JGT 1997). Walking up the ball from the axis in columns across it, the first such
// point is the margin there, found by bisection; a parabola fitted to the columns by least squares is the margin's
// height, tilt and curve, the shape the eye material reads. An adult upper lid margin is close to such an arc over the
// cornea and the white either side of it (the margin reflex distance and lid contour, Putterman 2012). The lower lid is
// found the same way walking down the ball, for `eye()`'s `lowerLid`.

import { parabolaFit } from '../../shared/parabola-fit.js';

/** The eyeball {@link eyeLidMargin} measures: centre, unit axis and radius, in the skin's space. */
export interface EyeBall {
  center: readonly number[];
  axis: readonly number[];
  radius: number;
  /** The head's up in the same space. Default [0, 1, 0]. */
  up?: readonly number[];
}
/** The upper lid's margin over the eye, in eyeball radii: height + tilt s + curve s^2 at s radii toward the eye's right. */
export interface EyeLidMargin {
  height: number;
  tilt: number;
  curve: number;
  /** Columns that met the lid. */
  columns: number;
  /** The lower lid's margin the same way (its height below the axis is negative), when three columns met it. */
  lower?: { height: number; tilt: number; curve: number; columns: number };
}

const sub = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: readonly number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? a.map((c) => c / l) : undefined;
};
const COLUMNS = [-0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6];

/**
 * The upper lid's margin over `ball`, from the head's `skin` (xyz per vertex and a triangle list, in the ball's space),
 * or undefined when fewer than three columns meet the lid. Pass the result as `eye({lid})`.
 * @example
 * const lid = eyeLidMargin({center, axis, radius}, {positions: head.positions, indices: head.indices});
 * const feature = eye({center, axis, lid});
 */
export function eyeLidMargin(
  ball: EyeBall,
  skin: { positions: ArrayLike<number>; indices: ArrayLike<number> },
): EyeLidMargin | undefined {
  const { center, radius } = ball,
    axis = unit(ball.axis),
    lifted = ball.up ?? [0, 1, 0];
  if (!axis || !(radius > 0) || center.length < 3) return undefined;
  const up = unit(sub(lifted, axis.map((c) => c * dot(lifted, axis))));
  if (!up) return undefined;
  const right = cross(up, axis);
  // The skin within three radii of the ball.
  const near: number[][][] = [];
  for (let t = 0; t + 2 < skin.indices.length; t += 3) {
    const tri = [0, 1, 2].map((k) => {
      const i = 3 * skin.indices[t + k];
      return [skin.positions[i], skin.positions[i + 1], skin.positions[i + 2]];
    });
    if (tri.some((p) => Math.hypot(...sub(p, center)) < 3 * radius)) near.push(tri);
  }
  const hidden = (p: number[]): boolean => {
    for (const [a, b, c] of near) {
      const e1 = sub(b, a),
        e2 = sub(c, a),
        q = cross(axis, e2),
        det = dot(e1, q);
      if (Math.abs(det) < 1e-30) continue;
      const s = sub(p, a),
        u = dot(s, q) / det;
      if (u < 0 || u > 1) continue;
      const r = cross(s, e1),
        v = dot(axis, r) / det;
      if (v < 0 || u + v > 1) continue;
      if (dot(e2, r) / det > 1e-6 * radius) return true;
    }
    return false;
  };
  const at = (side: number, h: number) => {
    const z = Math.sqrt(Math.max(0, 1 - h * h - side * side));
    return [0, 1, 2].map((k) => center[k] + radius * (axis[k] * z + up[k] * h + right[k] * side));
  };
  // Each column walked from the axis up (sign 1) or down (sign -1) to the first point the skin hides, then a parabola.
  const margin = (sign: number) => {
    const xs: number[] = [],
      ys: number[] = [];
    for (const side of COLUMNS) {
      const top = Math.sqrt(1 - side * side);
      if (hidden(at(side, 0))) continue;
      let low = 0,
        high = NaN;
      for (let h = 0.02; h < top; h += 0.02) {
        if (hidden(at(side, sign * h))) {
          high = h;
          break;
        }
        low = h;
      }
      if (!(high === high)) continue;
      for (let step = 0; step < 14; step++) {
        const mid = (low + high) / 2;
        if (hidden(at(side, sign * mid))) high = mid;
        else low = mid;
      }
      xs.push(side);
      ys.push((sign * (low + high)) / 2);
    }
    return xs.length < 3 ? undefined : fit(xs, ys);
  };
  const upper = margin(1);
  if (!upper) return undefined;
  const lower = margin(-1);
  return lower ? { ...upper, lower } : upper;
}

/** The parabola of the columns, as the eye material reads a lid margin. */
function fit(xs: number[], ys: number[]): { height: number; tilt: number; curve: number; columns: number } | undefined {
  const c = parabolaFit(xs, ys);
  if (!c) return undefined;
  const clamp = (v: number, a: number) => Math.min(a, Math.max(-a, v));
  return { height: clamp(c[0], 1), tilt: clamp(c[1], 2), curve: clamp(c[2], 2), columns: xs.length };
}
