import {Curve} from './curve.js';
import {finiteNumber, lerp, normalize, sub, type Vec, type Vec2, type Vec3} from './math.js';

const quadratic = (t: number, p0: number, p1: number, p2: number) => {const k = 1 - t; return k * k * p0 + 2 * k * t * p1 + t * t * p2;};
const cubic = (t: number, p0: number, p1: number, p2: number, p3: number) => {const k = 1 - t; return k * k * k * p0 + 3 * k * k * t * p1 + 3 * k * t * t * p2 + t * t * t * p3;};
/** Uniform Catmull-Rom segment between p1 and p2 (Three.js `Interpolations.CatmullRom`). */
const catmullRom = (t: number, p0: number, p1: number, p2: number, p3: number) => {
  const v0 = (p2 - p0) * 0.5, v1 = (p3 - p1) * 0.5, t2 = t * t, t3 = t * t2;
  return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
};

/** Straight segment (Three.js `LineCurve` / `LineCurve3`). Arc length is exact. */
export class LineCurve<V extends Vec = Vec2> extends Curve<V> {
  constructor(public v1: V, public v2: V) {super();}
  getPoint(t: number): V {return t === 1 ? this.v2.slice() as V : lerp(this.v1, this.v2, t);}
  override getPointAt(u: number): V {return this.getPoint(u);}
  override getTangent(): V {return normalize(sub(this.v2, this.v1));}
  override getTangentAt(): V {return this.getTangent();}
}
export class LineCurve3 extends LineCurve<Vec3> {}

/** Quadratic Bezier (Three.js `QuadraticBezierCurve` / `QuadraticBezierCurve3`). */
export class QuadraticBezierCurve<V extends Vec = Vec2> extends Curve<V> {
  constructor(public v0: V, public v1: V, public v2: V) {super();}
  getPoint(t: number): V {
    const a = this.v0, b = this.v1, c = this.v2;
    // Plain 2D and 3D control points skip the per-call closure; other array types keep their own map().
    if (a.length === 2 && Array.isArray(a)) return [quadratic(t, a[0], b[0], c[0]), quadratic(t, a[1], b[1], c[1])] as V;
    if (a.length === 3 && Array.isArray(a)) return [quadratic(t, a[0], b[0], c[0]), quadratic(t, a[1], b[1], c[1]), quadratic(t, a[2]!, b[2]!, c[2]!)] as V;
    return this.v0.map((_, i) => quadratic(t, this.v0[i], this.v1[i], this.v2[i])) as V;
  }
}
export class QuadraticBezierCurve3 extends QuadraticBezierCurve<Vec3> {}

/** Cubic Bezier (Three.js `CubicBezierCurve` / `CubicBezierCurve3`). */
export class CubicBezierCurve<V extends Vec = Vec2> extends Curve<V> {
  constructor(public v0: V, public v1: V, public v2: V, public v3: V) {super();}
  getPoint(t: number): V {
    const a = this.v0, b = this.v1, c = this.v2, d = this.v3;
    if (a.length === 2 && Array.isArray(a)) return [cubic(t, a[0], b[0], c[0], d[0]), cubic(t, a[1], b[1], c[1], d[1])] as V;
    if (a.length === 3 && Array.isArray(a)) return [cubic(t, a[0], b[0], c[0], d[0]), cubic(t, a[1], b[1], c[1], d[1]), cubic(t, a[2]!, b[2]!, c[2]!, d[2]!)] as V;
    return this.v0.map((_, i) => cubic(t, this.v0[i], this.v1[i], this.v2[i], this.v3[i])) as V;
  }
}
export class CubicBezierCurve3 extends CubicBezierCurve<Vec3> {}

/** 2D uniform Catmull-Rom spline through points, clamped at the ends (Three.js `SplineCurve`). */
export class SplineCurve extends Curve<Vec2> {
  constructor(public points: Vec2[] = []) {super();}
  getPoint(t: number): Vec2 {
    const points = this.points, n = points.length, p = (n - 1) * t, i = Math.floor(p), w = p - i;
    const p0 = points[i === 0 ? i : i - 1], p1 = points[i], p2 = points[i > n - 2 ? n - 1 : i + 1], p3 = points[i > n - 3 ? n - 1 : i + 2];
    return [catmullRom(w, p0[0], p1[0], p2[0], p3[0]), catmullRom(w, p0[1], p1[1], p2[1], p3[1])];
  }
}

/** Ellipse or elliptical arc in 2D (Three.js `EllipseCurve`). Angles in radians. */
export class EllipseCurve extends Curve<Vec2> {
  constructor(public aX = 0, public aY = 0, public xRadius = 1, public yRadius = 1, public aStartAngle = 0, public aEndAngle = Math.PI * 2, public aClockwise = false, public aRotation = 0) {super();}
  getPoint(t: number): Vec2 {
    const twoPi = Math.PI * 2;
    let delta = finiteNumber(this.aEndAngle - this.aStartAngle);
    const samePoints = Math.abs(delta) < Number.EPSILON;
    // Reduce full turns once: repeated subtraction can stop making progress for large finite angles.
    if (delta < 0 || delta > twoPi) delta %= twoPi;
    if (delta < 0) delta += twoPi;
    if (delta < Number.EPSILON) delta = samePoints ? 0 : twoPi;
    if (this.aClockwise && !samePoints) delta = delta === twoPi ? -twoPi : delta - twoPi;
    const angle = this.aStartAngle + t * delta;
    let x = this.aX + this.xRadius * Math.cos(angle), y = this.aY + this.yRadius * Math.sin(angle);
    if (this.aRotation !== 0) {
      const c = Math.cos(this.aRotation), s = Math.sin(this.aRotation), tx = x - this.aX, ty = y - this.aY;
      x = tx * c - ty * s + this.aX; y = tx * s + ty * c + this.aY;
    }
    return [x, y];
  }
}

/** Circular arc (Three.js `ArcCurve`). */
export class ArcCurve extends EllipseCurve {
  constructor(aX = 0, aY = 0, aRadius = 1, aStartAngle = 0, aEndAngle = Math.PI * 2, aClockwise = false) {super(aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise);}
}

/** `'catmullrom'` is the uniform parameterization; `'uniform'` is accepted as an alias. */
export type CatmullRomType = 'centripetal' | 'chordal' | 'catmullrom' | 'uniform';

/** Cubic Hermite polynomial c0 + c1 t + c2 t^2 + c3 t^3, evaluated at `t`. */
function hermite(x0: number, x1: number, t0: number, t1: number, t: number): number {
  const c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1, c3 = 2 * x0 - 2 * x1 + t0 + t1;
  return x0 + t0 * t + c2 * t * t + c3 * t * t * t;
}
const squaredDistance = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** 3D Catmull-Rom spline (Three.js `CatmullRomCurve3`), centripetal by default, optionally closed. */
export class CatmullRomCurve3 extends Curve<Vec3> {
  constructor(public points: Vec3[] = [], public closed = false, public curveType: CatmullRomType = 'centripetal', public tension = 0.5) {super();}
  getPoint(t: number): Vec3 {
    const points = this.points, l = points.length;
    const p = (l - (this.closed ? 0 : 1)) * t;
    let index = Math.floor(p), weight = p - index;
    if (this.closed) index += index > 0 ? 0 : (Math.floor(Math.abs(index) / l) + 1) * l;
    else if (weight === 0 && index === l - 1) {index = l - 2; weight = 1;}
    const p0: Vec3 = this.closed || index > 0 ? points[(index - 1) % l] : sub(points[0], sub(points[1], points[0]));
    const p1 = points[index % l], p2 = points[(index + 1) % l];
    const p3: Vec3 = this.closed || index + 2 < l ? points[(index + 2) % l] : sub(points[l - 1], sub(points[l - 2], points[l - 1]));
    const result: Vec3 = [0, 0, 0];
    if (this.curveType === 'centripetal' || this.curveType === 'chordal') {
      const power = this.curveType === 'chordal' ? 0.5 : 0.25;
      let dt0 = squaredDistance(p0, p1) ** power, dt1 = squaredDistance(p1, p2) ** power, dt2 = squaredDistance(p2, p3) ** power;
      if (dt1 < 1e-4) dt1 = 1;
      if (dt0 < 1e-4) dt0 = dt1;
      if (dt2 < 1e-4) dt2 = dt1;
      for (let a = 0; a < 3; a++) {
        const x0 = p0[a], x1 = p1[a], x2 = p2[a], x3 = p3[a];
        const m1 = ((x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1) * dt1;
        const m2 = ((x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2) * dt1;
        result[a] = hermite(x1, x2, m1, m2, weight);
      }
    } else {
      for (let a = 0; a < 3; a++) result[a] = hermite(p1[a], p2[a], this.tension * (p2[a] - p0[a]), this.tension * (p3[a] - p1[a]), weight);
    }
    return result;
  }
}
