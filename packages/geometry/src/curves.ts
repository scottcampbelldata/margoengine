import { Curve, tangentStep } from './curve.js';
import { lerp, normalize, sub, type MutableVec2, type MutableVec3, type Vec } from './math.js';

// A new vector shaped like `like` (a plain array stays plain, a typed array keeps its type) holding
// a*wa + b*wb + c*wc + d*wd per component. Unused terms pass weight 0 and repeat a point.
function blend<V extends Vec>(like: V, a: V, wa: number, b: V, wb: number, c: V, wc: number, d: V, wd: number): V {
  const out = like.slice() as V;
  for (let k = 0; k < out.length; k++) out[k] = a[k] * wa + b[k] * wb + c[k] * wc + d[k] * wd;
  return out;
}

// Cubic Hermite segment from p1 to p2 with end derivatives m1 and m2 over the unit parameter range s in [0, 1].
function hermite<V extends Vec>(p1: V, p2: V, m1: V, m2: V, s: number): V {
  const s2 = s * s,
    s3 = s2 * s;
  return blend(p1, p1, 2 * s3 - 3 * s2 + 1, m1, s3 - 2 * s2 + s, p2, 3 * s2 - 2 * s3, m2, s3 - s2);
}

function needTwo(name: string, count: number): void {
  if (count < 2) throw new RangeError(`${name} has ${count} point(s); pass at least two points`);
}

/**
 * Straight segment from `v1` to `v2` (2D by default; see {@link LineCurve3}). Raw parameter and arc length coincide,
 * so `getPointAt(u)` equals `getPoint(u)`, and the tangent is the constant unit direction `v2 - v1`.
 * `getPoint(1)` is an exact copy of `v2`.
 */
export class LineCurve<V extends Vec = MutableVec2> extends Curve<V> {
  constructor(
    public v1: V,
    public v2: V,
  ) {
    super();
  }
  /** The point a fraction `t` of the way from `v1` to `v2`. */
  getPoint(t: number): V {
    return t === 1 ? (this.v2.slice() as V) : lerp(this.v1, this.v2, t);
  }
  /** Same as `getPoint(u)`: a line is already parameterized by arc length. */
  override getPointAt(u: number): V {
    return this.getPoint(u);
  }
  /** Unit direction from `v1` to `v2`. */
  override getTangent(): V {
    return normalize(sub(this.v2, this.v1));
  }
  /** Unit direction from `v1` to `v2`. */
  override getTangentAt(): V {
    return this.getTangent();
  }
}

/** {@link LineCurve} in 3D. */
export class LineCurve3 extends LineCurve<MutableVec3> {}

/** Quadratic Bezier curve from `v0` to `v2` with control point `v1` (Bernstein form). 2D by default. */
export class QuadraticBezierCurve<V extends Vec = MutableVec2> extends Curve<V> {
  constructor(
    public v0: V,
    public v1: V,
    public v2: V,
  ) {
    super();
  }
  /** `(1-t)^2 v0 + 2t(1-t) v1 + t^2 v2`. */
  getPoint(t: number): V {
    const r = 1 - t;
    return blend(this.v0, this.v0, r * r, this.v1, 2 * r * t, this.v2, t * t, this.v2, 0);
  }
}

/** {@link QuadraticBezierCurve} in 3D. */
export class QuadraticBezierCurve3 extends QuadraticBezierCurve<MutableVec3> {}

/** Cubic Bezier curve from `v0` to `v3` with control points `v1` and `v2` (Bernstein form). 2D by default. */
export class CubicBezierCurve<V extends Vec = MutableVec2> extends Curve<V> {
  constructor(
    public v0: V,
    public v1: V,
    public v2: V,
    public v3: V,
  ) {
    super();
  }
  /** `(1-t)^3 v0 + 3t(1-t)^2 v1 + 3t^2(1-t) v2 + t^3 v3`. */
  getPoint(t: number): V {
    const r = 1 - t;
    return blend(this.v0, this.v0, r * r * r, this.v1, 3 * r * r * t, this.v2, 3 * r * t * t, this.v3, t * t * t);
  }
}

/** {@link CubicBezierCurve} in 3D. */
export class CubicBezierCurve3 extends CubicBezierCurve<MutableVec3> {}

/**
 * Uniform Catmull-Rom spline through 2D `points` (Catmull and Rom 1974): `t` spreads evenly over the segments, so
 * `t = i / (n - 1)` is exactly point `i`. Each segment's end tangents are half the difference of its neighbours; a
 * missing neighbour past either end is the end point itself.
 */
export class SplineCurve extends Curve<MutableVec2> {
  constructor(public points: MutableVec2[] = []) {
    super();
  }
  /** The spline point at `t`; throws a RangeError with fewer than two points. */
  getPoint(t: number): MutableVec2 {
    const points = this.points,
      n = points.length;
    needTwo('SplineCurve', n);
    const { index, local } = openSegment(t, n),
      p0 = points[index === 0 ? 0 : index - 1],
      p1 = points[index],
      p2 = points[index + 1],
      p3 = points[index + 2 < n ? index + 2 : n - 1];
    return hermite(
      p1,
      p2,
      blend(p1, p2, 0.5, p0, -0.5, p0, 0, p0, 0),
      blend(p1, p3, 0.5, p1, -0.5, p1, 0, p1, 0),
      local,
    );
  }
}

// Segment index and local parameter for an open curve over n points; t = 1 is the end of the last segment.
function openSegment(t: number, n: number): { index: number; local: number } {
  const scaled = (n - 1) * t;
  let index = Math.floor(scaled),
    local = scaled - index;
  if (index >= n - 1) {
    local += index - (n - 2);
    index = n - 2;
  } else if (index < 0) {
    local = scaled;
    index = 0;
  }
  return { index, local };
}

const fullTurn = Math.PI * 2;

/**
 * Ellipse arc centred on (`aX`, `aY`) with radii `xRadius` and `yRadius`, turned by `aRotation` radians
 * counter-clockwise about the centre. Angles are radians from +x toward +y. `getPoint(t)` is the point at angle
 * `aStartAngle + t * sweep`, where the sweep runs counter-clockwise (or clockwise with `aClockwise`) from start to
 * end: equal angles give a single point; otherwise the difference is reduced into (0, 2pi], so equal-modulo-2pi angles
 * give a full turn, and a clockwise sweep is the complementary arc. Throws a RangeError when the angle difference is
 * not finite.
 */
export class EllipseCurve extends Curve<MutableVec2> {
  constructor(
    public aX = 0,
    public aY = 0,
    public xRadius = 1,
    public yRadius = 1,
    public aStartAngle = 0,
    public aEndAngle = Math.PI * 2,
    public aClockwise = false,
    public aRotation = 0,
  ) {
    super();
  }
  /** The point at angle `aStartAngle + t * sweep`. */
  getPoint(t: number): MutableVec2 {
    const delta = this.aEndAngle - this.aStartAngle;
    if (!Number.isFinite(delta))
      throw new RangeError(
        `EllipseCurve angle range ${this.aStartAngle}..${this.aEndAngle} is not finite; pass finite start and end angles`,
      );
    let sweep = 0;
    if (Math.abs(delta) >= Number.EPSILON) {
      // One remainder keeps huge finite angles in bounded time and exact.
      sweep = delta % fullTurn;
      if (sweep < 0) sweep += fullTurn;
      if (sweep < Number.EPSILON) sweep = fullTurn;
      if (this.aClockwise) sweep = sweep === fullTurn ? -fullTurn : sweep - fullTurn;
    }
    const angle = this.aStartAngle + t * sweep;
    let x = this.xRadius * Math.cos(angle),
      y = this.yRadius * Math.sin(angle);
    if (this.aRotation !== 0) {
      const c = Math.cos(this.aRotation),
        s = Math.sin(this.aRotation);
      [x, y] = [x * c - y * s, x * s + y * c];
    }
    return [this.aX + x, this.aY + y];
  }
}

/** Circular arc: an {@link EllipseCurve} with both radii `aRadius` and no rotation. */
export class ArcCurve extends EllipseCurve {
  constructor(aX = 0, aY = 0, aRadius = 1, aStartAngle = 0, aEndAngle = Math.PI * 2, aClockwise = false) {
    super(aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise, 0);
  }
}

/**
 * Knot spacing of a {@link CatmullRomCurve3}: `'centripetal'` (|chord|^0.5, the default, no cusps or
 * self-intersections within a segment), `'chordal'` (|chord|^1), or `'catmullrom'` / `'uniform'` (equal spacing with
 * the curve's `tension`).
 */
export type CatmullRomType = 'centripetal' | 'chordal' | 'catmullrom' | 'uniform';

// Knot intervals below this count as coincident points (category c: any small positive floor catches duplicates).
const intervalFloor = 1e-6;

/**
 * Interpolating cubic spline through 3D `points`. Open curves spread `t` over `n - 1` segments (`t = i / (n - 1)` is
 * point `i`, `t = 1` the last point); closed curves over `n` segments, the last joining back to the first
 * (`t = i / n` is point `i`). Past the ends of an open curve the missing neighbour is the next point reflected through
 * the end point.
 *
 * `'centripetal'` and `'chordal'` are the non-uniform Catmull-Rom curves of Yuksel, Schaefer and Keyser (2011), knot
 * intervals |P(i+1) - P(i)|^alpha with alpha 0.5 and 1, evaluated exactly as cubic Hermite segments with the
 * Barry-Goldman derivatives at the knots. `'catmullrom'` / `'uniform'` use tangents `tension * (P(i+1) - P(i-1))`
 * (0.5 is the classic spline); `tension` affects only these two. Throws a RangeError from `getPoint` with fewer than
 * two points; exactly two give a straight segment.
 */
export class CatmullRomCurve3 extends Curve<MutableVec3> {
  constructor(
    public points: MutableVec3[] = [],
    public closed = false,
    public curveType: CatmullRomType = 'centripetal',
    public tension = 0.5,
  ) {
    super();
  }
  /** The spline point at `t`. */
  getPoint(t: number): MutableVec3 {
    const points = this.points,
      n = points.length;
    needTwo('CatmullRomCurve3', n);
    let index: number, local: number, p0: MutableVec3, p1: MutableVec3, p2: MutableVec3, p3: MutableVec3;
    if (this.closed) {
      const scaled = n * t;
      index = Math.floor(scaled);
      local = scaled - index;
      index = ((index % n) + n) % n;
      p0 = points[(index + n - 1) % n];
      p1 = points[index];
      p2 = points[(index + 1) % n];
      p3 = points[(index + 2) % n];
    } else {
      ({ index, local } = openSegment(t, n));
      p1 = points[index];
      p2 = points[index + 1];
      p0 = index > 0 ? points[index - 1] : blend(p1, p1, 2, p2, -1, p2, 0, p2, 0);
      p3 = index + 2 < n ? points[index + 2] : blend(p2, p2, 2, p1, -1, p1, 0, p1, 0);
    }
    const type = this.curveType;
    if (type === 'centripetal' || type === 'chordal') {
      const power = type === 'centripetal' ? 0.25 : 0.5; // applied to the squared distance
      let d0 = squaredDistance(p0, p1) ** power,
        d1 = squaredDistance(p1, p2) ** power,
        d2 = squaredDistance(p2, p3) ** power;
      if (d1 < intervalFloor) d1 = 1;
      if (d0 < intervalFloor) d0 = d1;
      if (d2 < intervalFloor) d2 = d1;
      // Barry-Goldman derivatives at the two inner knots, scaled from knot units to the segment's [0, 1].
      // m1 = d1 * ((p1 - p0) / d0 - (p2 - p0) / (d0 + d1) + (p2 - p1) / d1)
      const m1 = p1.slice() as MutableVec3;
      for (let k = 0; k < 3; k++)
        m1[k] = d1 * ((p1[k] - p0[k]) / d0 - (p2[k] - p0[k]) / (d0 + d1) + (p2[k] - p1[k]) / d1);
      const m2 = p1.slice() as MutableVec3;
      // m2 = d1 * ((p2 - p1) / d1 - (p3 - p1) / (d1 + d2) + (p3 - p2) / d2)
      for (let k = 0; k < 3; k++)
        m2[k] = d1 * ((p2[k] - p1[k]) / d1 - (p3[k] - p1[k]) / (d1 + d2) + (p3[k] - p2[k]) / d2);
      return hermite(p1, p2, m1, m2, local);
    }
    const s = this.tension;
    return hermite(p1, p2, blend(p1, p2, s, p0, -s, p0, 0, p0, 0), blend(p1, p3, s, p1, -s, p1, 0, p1, 0), local);
  }
  /**
   * Unit tangent at `t`. A closed curve takes its central difference across the seam (`getPoint` wraps), so the
   * tangents at `t = 0` and `t = 1` are the same and frames along it close without a twist.
   */
  override getTangent(t: number): MutableVec3 {
    if (!this.closed) return super.getTangent(t);
    return normalize(sub(this.getPoint(t + tangentStep), this.getPoint(t - tangentStep)));
  }
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let k = 0; k < a.length; k++) sum += (a[k] - b[k]) ** 2;
  return sum;
}
