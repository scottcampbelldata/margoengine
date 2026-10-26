import { hexColor } from '@margoengine/math/color';
import type { Easing } from './index.js';

/** Writes `a + (b - a) * t` into `out` for every component. `out` may be `a` or `b`. Use for positions and colours. */
export function lerpArray(
  out: number[] | Float32Array | Float64Array,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  t: number,
): void {
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
}

/**
 * Spherical interpolation of unit quaternions `[x, y, z, w]` along the shortest arc. `out` may be `a` or `b`.
 * Falls back to a normalized lerp when the quaternions are nearly parallel.
 */
export function slerpArray(
  out: number[] | Float32Array | Float64Array,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  t: number,
): void {
  let bx = b[0],
    by = b[1],
    bz = b[2],
    bw = b[3],
    cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0 = 1 - t,
    s1 = t;
  if (cos < 0.9995) {
    const angle = Math.acos(cos),
      sin = Math.sin(angle);
    s0 = Math.sin((1 - t) * angle) / sin;
    s1 = Math.sin(t * angle) / sin;
  }
  const x = s0 * a[0] + s1 * bx,
    y = s0 * a[1] + s1 * by,
    z = s0 * a[2] + s1 * bz,
    w = s0 * a[3] + s1 * bw,
    n = 1 / (Math.hypot(x, y, z, w) || 1);
  out[0] = x * n;
  out[1] = y * n;
  out[2] = z * n;
  out[3] = w * n;
}

/**
 * Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into `[r, g, b, a]` in 0..1, as written (sRGB-encoded).
 * @throws TypeError for any other string.
 */
export function parseHexColor(hex: string): [number, number, number, number] {
  const color = hexColor(hex);
  if (!color) throw new TypeError('Invalid colour; use #rgb, #rrggbb or #rrggbbaa');
  return color;
}

/** Hex string `#rrggbb` (or `#rrggbbaa` when alpha is below 1) of an `[r, g, b, a?]` colour in 0..1. */
export function toHexColor(c: ArrayLike<number>): string {
  const byte = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(c[0])}${byte(c[1])}${byte(c[2])}${c.length > 3 && c[3] < 1 ? byte(c[3]) : ''}`;
}

/**
 * A smooth path through `points` (uniform Catmull-Rom, passing through every point) as a function of progress 0..1.
 * Points are arrays of the same length (2D, 3D, any). Pass it to `Tween.path` or call it yourself.
 * @throws RangeError for fewer than 2 points or points of different lengths.
 */
export function catmullRomPath(
  points: readonly ArrayLike<number>[],
  { closed = false }: { closed?: boolean } = {},
): (t: number, out?: number[]) => number[] {
  const n = points.length;
  if (n < 2 || points.some((p) => p.length !== points[0].length || p.length === 0))
    throw new RangeError('A path needs at least 2 points of the same, non-zero length; pass arrays like [x, y, z]');
  const dim = points[0].length,
    segments = closed ? n : n - 1;
  const at = (i: number) => points[closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i))];
  return (t, out = new Array<number>(dim)) => {
    const u = Math.min(1, Math.max(0, t)) * segments,
      i = Math.min(segments - 1, Math.floor(u)),
      f = u - i,
      f2 = f * f,
      f3 = f2 * f,
      p0 = at(i - 1),
      p1 = at(i),
      p2 = at(i + 1),
      p3 = at(i + 2);
    for (let d = 0; d < dim; d++)
      out[d] =
        0.5 *
        (2 * p1[d] +
          (p2[d] - p0[d]) * f +
          (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * f2 +
          (3 * p1[d] - p0[d] - 3 * p2[d] + p3[d]) * f3);
    return out;
  };
}

export type { Easing };
