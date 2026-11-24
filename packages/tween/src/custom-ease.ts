import { bezierSolver } from './bezier.js';
import type { Easing } from './index.js';

/** One `[x, y]` point of a curve: x is the time 0..1, y the eased progress. */
export type EasePoint = readonly [number, number];

/**
 * A custom ease as data, ready for `JSON.stringify`. x runs from exactly 0 to exactly 1 and only ever forward; y is free,
 * so a curve can overshoot, wiggle, or end away from 1.
 * - `smooth`: a curve through the points that does not overshoot between them (monotone cubic).
 * - `linear`: straight lines between the points, like CSS `linear()`.
 * - `bezier`: what a curve editor draws. The points are anchor, handle, handle, anchor, handle, handle, anchor, so 3n + 1
 *   of them; a handle's x stays between the two anchors of its segment.
 */
export interface EaseCurve {
  version: 1;
  kind: 'smooth' | 'linear' | 'bezier';
  points: readonly EasePoint[];
}

/** An {@link Easing} that also carries its data; `JSON.stringify` writes the {@link EaseCurve}. */
export interface CustomEase extends Easing {
  readonly curve: EaseCurve;
  toJSON(): EaseCurve;
}

const bad = (why: string): RangeError => new RangeError(`Invalid ease curve: ${why}`);

/** Slopes of the monotone cubic through the points (Fritsch and Carlson, 1980). */
function monotoneSlopes(xs: Float64Array, ys: Float64Array): Float64Array {
  const n = xs.length,
    secant = new Float64Array(n - 1),
    out = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) secant[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  out[0] = secant[0];
  out[n - 1] = secant[n - 2];
  for (let i = 1; i < n - 1; i++) out[i] = secant[i - 1] * secant[i] <= 0 ? 0 : (secant[i - 1] + secant[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (secant[i] === 0) {
      out[i] = out[i + 1] = 0;
      continue;
    }
    const a = out[i] / secant[i],
      b = out[i + 1] / secant[i],
      size = Math.hypot(a, b);
    // Inside a circle of radius 3 the cubic on this interval stays monotone.
    if (size > 3) {
      out[i] = (3 * a * secant[i]) / size;
      out[i + 1] = (3 * b * secant[i]) / size;
    }
  }
  return out;
}

/** Index of the last of `xs` at or before `x`, stopping one short of the end. */
function segmentOf(xs: ArrayLike<number>, x: number): number {
  let low = 0,
    high = xs.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (xs[mid] <= x) low = mid;
    else high = mid;
  }
  return low;
}

function check(curve: EaseCurve): void {
  if (curve === null || typeof curve !== 'object') throw bad('pass an object or its JSON text');
  if (curve.version !== 1) throw bad('this version reads version 1');
  if (!['smooth', 'linear', 'bezier'].includes(curve.kind)) throw bad("kind must be 'smooth', 'linear' or 'bezier'");
  const { points } = curve;
  if (!Array.isArray(points) || points.length < 2) throw bad('it needs at least 2 points');
  for (const p of points)
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) throw bad('points are [x, y] finite numbers');
  if (points[0][0] !== 0 || points.at(-1)![0] !== 1) throw bad('x must run from 0 to 1');
  if (curve.kind === 'bezier') {
    if ((points.length - 1) % 3) throw bad('a bezier has 3n + 1 points: anchor, handle, handle, anchor');
    for (let i = 0; i + 3 < points.length; i += 3) {
      const low = points[i][0],
        high = points[i + 3][0];
      if (!(high > low)) throw bad('anchors must move forward in x');
      for (const handle of [points[i + 1][0], points[i + 2][0]])
        if (handle < low || handle > high) throw bad('a handle must stay between its anchors in x');
    }
  } else
    for (let i = 1; i < points.length; i++) if (!(points[i][0] > points[i - 1][0])) throw bad('x must move forward');
}

/**
 * An easing from a curve, or from the JSON text of one.
 *
 * ```ts
 * const hop = customEase({version: 1, kind: 'smooth', points: [[0, 0], [0.4, 1], [0.7, 0.8], [1, 1]]});
 * tween.to(light, 'intensity', 3, {duration: 1, easing: hop});
 * localStorage.setItem('hop', JSON.stringify(hop));
 * ```
 * @throws RangeError for a curve that breaks the rules of {@link EaseCurve}.
 * @throws SyntaxError for text that is not JSON.
 */
export function customEase(data: EaseCurve | string): CustomEase {
  const curve: EaseCurve = typeof data === 'string' ? JSON.parse(data) : data;
  check(curve);
  const stored: EaseCurve = {
    version: 1,
    kind: curve.kind,
    points: curve.points.map(([x, y]) => [x, y] as const),
  };
  const { points, kind } = stored,
    step = kind === 'bezier' ? 3 : 1,
    count = (points.length - 1) / step + 1,
    xs = Float64Array.from({ length: count }, (_, i) => points[i * step][0]),
    ys = Float64Array.from({ length: count }, (_, i) => points[i * step][1]),
    slopes = kind === 'smooth' ? monotoneSlopes(xs, ys) : undefined,
    solvers =
      kind === 'bezier'
        ? Array.from({ length: count - 1 }, (_, i) => {
            const width = xs[i + 1] - xs[i];
            return bezierSolver((points[i * 3 + 1][0] - xs[i]) / width, (points[i * 3 + 2][0] - xs[i]) / width);
          })
        : undefined;
  const ease = ((t: number): number => {
    if (t <= 0) return ys[0];
    if (t >= 1) return ys[count - 1];
    const i = segmentOf(xs, t),
      x0 = xs[i],
      x1 = xs[i + 1],
      y0 = ys[i],
      y1 = ys[i + 1];
    if (kind === 'linear') return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    if (kind === 'bezier') {
      const s = solvers![i]((t - x0) / (x1 - x0)),
        r = 1 - s;
      return r * r * r * y0 + 3 * r * r * s * points[i * 3 + 1][1] + 3 * r * s * s * points[i * 3 + 2][1] + s * s * s * y1;
    }
    const h = x1 - x0,
      u = (t - x0) / h,
      u2 = u * u,
      u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * y0 +
      (u3 - 2 * u2 + u) * h * slopes![i] +
      (3 * u2 - 2 * u3) * y1 +
      (u3 - u2) * h * slopes![i + 1]
    );
  }) as CustomEase;
  return Object.defineProperties(ease, {
    curve: { value: stored, enumerable: true },
    toJSON: { value: () => stored },
  });
}

/** Evenly spaced y values as a curve: value `i` of `n` sits at x = i / (n - 1). */
export function easeFromSamples(values: ArrayLike<number>, kind: 'smooth' | 'linear' = 'smooth'): CustomEase {
  const last = values.length - 1;
  return customEase({
    version: 1,
    kind,
    points: Array.from(values, (y, i) => [last ? i / last : 0, y] as const),
  });
}

/** Marks the points of a stroke that stay within `tolerance` of the line through the kept ones (Ramer, Douglas, Peucker). */
function keep(points: readonly EasePoint[], from: number, to: number, tolerance: number, kept: Uint8Array): void {
  const [ax, ay] = points[from],
    dx = points[to][0] - ax,
    dy = points[to][1] - ay,
    length = Math.hypot(dx, dy);
  let far = 0,
    index = -1;
  for (let i = from + 1; i < to; i++) {
    const distance = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / length;
    if (distance > far) {
      far = distance;
      index = i;
    }
  }
  if (far <= tolerance) return;
  kept[index] = 1;
  keep(points, from, index, tolerance, kept);
  keep(points, index, to, tolerance, kept);
}

/**
 * A curve from a stroke someone drew, in any units: `[x, y]` samples in the order drawn. x is scaled to 0..1 and y to the
 * stroke's first and last y (0 and 1), samples that go back in x are dropped, and the rest are thinned to the few that
 * keep the shape within `tolerance` in those 0..1 units. Default tolerance 0.005, half a percent of the curve's height.
 * @throws RangeError for fewer than 2 samples that move forward, a stroke that ends at the y it began, or a bad tolerance.
 */
export function easeFromStroke(samples: readonly EasePoint[], tolerance = 0.005): CustomEase {
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) throw bad('tolerance must be finite and >= 0');
  const forward: EasePoint[] = [];
  for (const point of samples) {
    if (!Array.isArray(point) || !point.every(Number.isFinite)) throw bad('samples are [x, y] finite numbers');
    if (!forward.length || point[0] > forward.at(-1)![0]) forward.push(point);
  }
  if (forward.length < 2) throw bad('a stroke needs at least 2 samples moving forward in x');
  const x0 = forward[0][0],
    y0 = forward[0][1],
    width = forward.at(-1)![0] - x0,
    height = forward.at(-1)![1] - y0;
  if (!height) throw bad('a stroke must end at another y than it began');
  const unit = forward.map(([x, y]) => [(x - x0) / width, (y - y0) / height] as const),
    kept = new Uint8Array(unit.length);
  kept[0] = kept[unit.length - 1] = 1;
  keep(unit, 0, unit.length - 1, tolerance, kept);
  return customEase({ version: 1, kind: 'smooth', points: unit.filter((_, i) => kept[i]) });
}
