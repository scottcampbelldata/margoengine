import type { Spline } from './index.js';

export const segmentCount = (spline: Spline): number =>
  spline.kind === 'bezier' ? (spline.points.length / 3 - 1) / 3 : spline.points.length / 3 - (spline.closed ? 0 : 1);

// Reconstruct the exact cubic, not a finite difference. This also supports the root's private Hermite tangents.
export function controls(spline: Spline, segment: number): Float64Array {
  if (spline.kind === 'bezier') return spline.points.slice(segment * 9, segment * 9 + 12);
  const n = segmentCount(spline),
    samples = [0, 1 / 3, 2 / 3, 1].map((u) => spline.at((segment + u) / n, new Float64Array(3)));
  const p = new Float64Array(12);
  for (let axis = 0; axis < 3; axis++) {
    const [a, b, c, d] = samples.map((v) => v[axis]);
    p[axis] = a;
    p[axis + 3] = (-5 * a + 18 * b - 9 * c + 2 * d) / 6;
    p[axis + 6] = (2 * a - 9 * b + 18 * c - 5 * d) / 6;
    p[axis + 9] = d;
  }
  return p;
}

export function evaluate(p: Float64Array, t: number, order: number, out = new Float64Array(3)): Float64Array {
  const v = 1 - t;
  for (let a = 0; a < 3; a++) {
    const x = p[a],
      y = p[a + 3],
      z = p[a + 6],
      w = p[a + 9];
    out[a] =
      order === 0
        ? v * v * v * x + 3 * v * v * t * y + 3 * v * t * t * z + t * t * t * w
        : order === 1
          ? 3 * (v * v * (y - x) + 2 * v * t * (z - y) + t * t * (w - z))
          : order === 2
            ? 6 * (v * (z - 2 * y + x) + t * (w - 2 * z + y))
            : 6 * (w - 3 * z + 3 * y - x);
  }
  return out;
}

export function cross(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  return new Float64Array([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
}

export function checkVector(v: ArrayLike<number>): void {
  if (v.length !== 3 || ![v[0], v[1], v[2]].every(Number.isFinite))
    throw new RangeError('Invalid vector; pass three finite components.');
}
