import { Curve, sampleCount } from './curve.js';
import { CubicBezierCurve, EllipseCurve, LineCurve, QuadraticBezierCurve, SplineCurve } from './curves.js';
import { equals, type MutableVec2, type Vec } from './math.js';

/**
 * A chain of curves treated as one curve. `getPoint(t)` is already arc-length parameterized: `t` is the fraction of
 * the total length, located in the sub-curve that covers it. Sub-curve lengths are cached; call `updateArcLengths()`
 * after editing any sub-curve.
 */
export class CurvePath<V extends Vec = MutableVec2> extends Curve<V> {
  /** The sub-curves, in order. */
  curves: Curve<V>[] = [];
  /** When true, `getPoints` and `getSpacedPoints` end with a copy of the first point. */
  autoClose = false;
  private cumulative: number[] | null = null;

  /** Appends a curve. */
  add(curve: Curve<V>): this {
    this.curves.push(curve);
    this.cumulative = null;
    return this;
  }

  /** Appends a straight line from the last curve's end back to the first curve's start, when they differ. */
  closePath(): this {
    const curves = this.curves;
    if (curves.length === 0) return this;
    const start = curves[0].getPoint(0),
      end = curves[curves.length - 1].getPoint(1);
    if (!equals(start, end)) this.add(new LineCurve<V>(end, start));
    return this;
  }

  /** The point a fraction `t` of the total length along the path. Throws a RangeError on an empty path. */
  getPoint(t: number): V {
    const curves = this.curves;
    if (curves.length === 0) throw new RangeError('CurvePath has no curves; add a curve before sampling it');
    const distance = t * this.getLength(),
      lengths = this.getCurveLengths();
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] < distance) continue;
      const curve = curves[i],
        length = curve.getLength();
      return curve.getPointAt(length === 0 ? 0 : 1 - (lengths[i] - distance) / length);
    }
    // Rounding carried the distance past the end.
    return curves[curves.length - 1].getPoint(1);
  }

  /** Sum of the sub-curve lengths (0 for an empty path). */
  override getLength(): number {
    const lengths = this.getCurveLengths();
    return lengths.length === 0 ? 0 : lengths[lengths.length - 1];
  }

  /** Drops this path's cached lengths and every sub-curve's arc-length table. */
  override updateArcLengths(): void {
    super.updateArcLengths();
    this.cumulative = null;
    for (const curve of this.curves) curve.updateArcLengths();
  }

  /** Cumulative sub-curve lengths: entry `i` is the length of curves `0..i`. Cached until the curve count changes. */
  getCurveLengths(): number[] {
    if (this.cumulative && this.cumulative.length === this.curves.length) return this.cumulative;
    const lengths: number[] = [];
    let sum = 0;
    for (const curve of this.curves) lengths.push((sum += curve.getLength()));
    this.cumulative = lengths;
    return lengths;
  }

  /** `divisions + 1` points at equal distances along the path, plus a copy of the first when `autoClose`. */
  override getSpacedPoints(divisions = 40): V[] {
    sampleCount('getSpacedPoints', divisions);
    const points: V[] = [];
    for (let i = 0; i <= divisions; i++) points.push(this.getPoint(i / divisions));
    if (this.autoClose && points.length > 0) points.push(points[0].slice() as V);
    return points;
  }

  /**
   * Outline points: each sub-curve sampled by its own parameter, joints emitted once. Straight lines give just their
   * end points, Bezier curves `divisions` steps, ellipses and arcs twice that, and splines `divisions` per spline
   * point. With `autoClose`, the first point is repeated at the end when the outline is not already closed.
   */
  override getPoints(divisions = 12): V[] {
    sampleCount('getPoints', divisions);
    const points: V[] = [];
    let previous: V | undefined;
    for (const curve of this.curves) {
      // Sampling density per kind (category c): curvature is spread over an ellipse's whole sweep and over every
      // span of a spline, so those get more steps than a single Bezier span.
      const steps =
        curve instanceof LineCurve
          ? 1
          : curve instanceof EllipseCurve
            ? divisions * 2
            : curve instanceof SplineCurve
              ? divisions * curve.points.length
              : divisions;
      for (const point of curve.getPoints(steps)) {
        if (previous && equals(previous, point)) continue;
        points.push(point);
        previous = point;
      }
    }
    if (this.autoClose && points.length > 1 && !equals(points[points.length - 1], points[0]))
      points.push(points[0].slice() as V);
    return points;
  }
}

/**
 * A 2D path drawn with a pen, like a canvas path. `currentPoint` is the pen: `moveTo` lifts it to a new place without
 * drawing; `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `splineThru` and the arc builders add a curve starting at
 * the pen and leave the pen at the curve's end. An arc that does not start at the pen is joined to it by a straight
 * line, unless the path has no curves yet. Every builder returns the path. Each curve keeps its own copies of its
 * points.
 */
export class Path extends CurvePath<MutableVec2> {
  /** The pen position; starts at the origin. */
  currentPoint: MutableVec2 = [0, 0];

  /** With `points`, starts at the first point and draws straight lines through the rest. */
  constructor(points?: MutableVec2[]) {
    super();
    if (points) this.setFromPoints(points);
  }

  /** Moves the pen to the first point and draws straight lines through the rest. */
  setFromPoints(points: MutableVec2[]): this {
    if (points.length === 0) return this;
    this.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) this.lineTo(points[i][0], points[i][1]);
    return this;
  }

  /** Moves the pen without drawing. */
  moveTo(x: number, y: number): this {
    this.currentPoint = [x, y];
    return this;
  }

  /** Straight line from the pen to (`x`, `y`). */
  lineTo(x: number, y: number): this {
    this.add(new LineCurve(this.pen(), [x, y]));
    this.currentPoint = [x, y];
    return this;
  }

  /** Quadratic Bezier from the pen to (`x`, `y`) with control point (`cx`, `cy`). */
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this {
    this.add(new QuadraticBezierCurve(this.pen(), [cx, cy], [x, y]));
    this.currentPoint = [x, y];
    return this;
  }

  /** Cubic Bezier from the pen to (`x`, `y`) with control points (`c1x`, `c1y`) and (`c2x`, `c2y`). */
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.add(new CubicBezierCurve(this.pen(), [c1x, c1y], [c2x, c2y], [x, y]));
    this.currentPoint = [x, y];
    return this;
  }

  /** Spline from the pen through `points`; the pen ends on the last point. */
  splineThru(points: MutableVec2[]): this {
    const through: MutableVec2[] = [this.pen()];
    for (const point of points) through.push([point[0], point[1]]);
    this.add(new SplineCurve(through));
    const last = through[through.length - 1];
    this.currentPoint = [last[0], last[1]];
    return this;
  }

  /** Circular arc centred at the pen plus (`aX`, `aY`). See {@link Path.absellipse}. */
  arc(aX: number, aY: number, radius: number, startAngle: number, endAngle: number, clockwise = false): this {
    const [x, y] = this.currentPoint;
    return this.absarc(aX + x, aY + y, radius, startAngle, endAngle, clockwise);
  }

  /** Circular arc centred at (`aX`, `aY`). See {@link Path.absellipse}. */
  absarc(aX: number, aY: number, radius: number, startAngle: number, endAngle: number, clockwise = false): this {
    return this.absellipse(aX, aY, radius, radius, startAngle, endAngle, clockwise, 0);
  }

  /** Ellipse arc centred at the pen plus (`aX`, `aY`). See {@link Path.absellipse}. */
  ellipse(
    aX: number,
    aY: number,
    xRadius: number,
    yRadius: number,
    startAngle: number,
    endAngle: number,
    clockwise = false,
    rotation = 0,
  ): this {
    const [x, y] = this.currentPoint;
    return this.absellipse(aX + x, aY + y, xRadius, yRadius, startAngle, endAngle, clockwise, rotation);
  }

  /**
   * Ellipse arc centred at (`aX`, `aY`) (an {@link EllipseCurve}). When the path already has curves and the arc does
   * not start at the pen, a straight line joins them first. The pen ends at the arc's end point.
   */
  absellipse(
    aX: number,
    aY: number,
    xRadius: number,
    yRadius: number,
    startAngle: number,
    endAngle: number,
    clockwise = false,
    rotation = 0,
  ): this {
    const curve = new EllipseCurve(aX, aY, xRadius, yRadius, startAngle, endAngle, clockwise, rotation);
    if (this.curves.length > 0) {
      const start = curve.getPoint(0);
      if (!equals(start, this.currentPoint)) this.lineTo(start[0], start[1]);
    }
    this.add(curve);
    this.currentPoint = curve.getPoint(1);
    return this;
  }

  private pen(): MutableVec2 {
    return [this.currentPoint[0], this.currentPoint[1]];
  }
}

/**
 * A closed 2D outline with `holes`, for `shapeGeometry` and `extrudeGeometry`. Rings are returned as drawn; those
 * builders fix the orientation (counter-clockwise outline, positive signed area in a y-up frame).
 */
export class Shape extends Path {
  /** Paths cut out of the shape. */
  holes: Path[] = [];

  /** Each hole's outline points (`Path.getPoints(divisions)`). */
  getPointsHoles(divisions = 12): MutableVec2[][] {
    return this.holes.map((hole) => hole.getPoints(divisions));
  }

  /** The outline points and each hole's points, sampled with `divisions`. */
  extractPoints(divisions = 12): { shape: MutableVec2[]; holes: MutableVec2[][] } {
    return { shape: this.getPoints(divisions), holes: this.getPointsHoles(divisions) };
  }
}
