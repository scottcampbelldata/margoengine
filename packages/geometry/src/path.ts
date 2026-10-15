import { Curve } from './curve.js';
import { CubicBezierCurve, EllipseCurve, LineCurve, QuadraticBezierCurve, SplineCurve } from './curves.js';
import { equals, finiteNumber, type Vec, type MutableVec2 } from './math.js';

/** A chain of curves treated as one curve by arc length (Three.js `CurvePath`). */
export class CurvePath<V extends Vec = MutableVec2> extends Curve<V> {
  curves: Curve<V>[] = [];
  autoClose = false;
  private curveLengths: number[] | null = null;

  add(curve: Curve<V>): this {
    this.curves.push(curve);
    this.curveLengths = null;
    return this;
  }

  /** Adds a straight segment back to the start when the path is open. */
  closePath(): this {
    if (!this.curves.length) return this;
    const start = this.curves[0].getPoint(0),
      end = this.curves[this.curves.length - 1].getPoint(1);
    if (!equals(start, end)) this.add(new LineCurve<V>(end, start) as unknown as Curve<V>);
    return this;
  }

  getPoint(t: number): V {
    const d = t * this.getLength(),
      lengths = this.getCurveLengths();
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] >= d) {
        const curve = this.curves[i],
          segment = curve.getLength(),
          diff = lengths[i] - d;
        return curve.getPointAt(segment === 0 ? 0 : 1 - diff / segment);
      }
    }
    return this.curves[this.curves.length - 1].getPoint(1);
  }

  override getLength(): number {
    const l = this.getCurveLengths();
    return l.length ? l[l.length - 1] : 0;
  }

  override updateArcLengths(): void {
    super.updateArcLengths();
    this.curveLengths = null;
    for (const c of this.curves) c.updateArcLengths();
  }

  /** Cumulative length at the end of each sub-curve. */
  getCurveLengths(): number[] {
    if (this.curveLengths && this.curveLengths.length === this.curves.length) return this.curveLengths;
    let sum = 0;
    return (this.curveLengths = this.curves.map((c) => (sum += c.getLength())));
  }

  override getSpacedPoints(divisions = 40): V[] {
    finiteNumber(divisions);
    // getPoint is already arc-length parameterized for a curve path.
    const points: V[] = [];
    for (let i = 0; i <= divisions; i++) points.push(this.getPoint(i / divisions));
    if (this.autoClose && points.length) points.push(points[0].slice() as V);
    return points;
  }

  /**
   * Samples each sub-curve at its own resolution like Three.js: lines once, ellipses at `2 * divisions`, splines at
   * `divisions * points`, everything else at `divisions`. Consecutive duplicates are dropped.
   */
  override getPoints(divisions = 12): V[] {
    finiteNumber(divisions);
    const points: V[] = [];
    let last: V | undefined;
    for (const curve of this.curves) {
      const resolution =
        curve instanceof EllipseCurve
          ? divisions * 2
          : curve instanceof LineCurve
            ? 1
            : curve instanceof SplineCurve
              ? divisions * curve.points.length
              : divisions;
      for (const point of curve.getPoints(resolution)) {
        if (last && equals(last, point)) continue;
        points.push(point);
        last = point;
      }
    }
    if (this.autoClose && points.length > 1 && !equals(points[points.length - 1], points[0])) points.push(points[0]);
    return points;
  }
}

/** 2D path builder with a pen position (Three.js `Path`). */
export class Path extends CurvePath<MutableVec2> {
  currentPoint: MutableVec2 = [0, 0];

  constructor(points?: MutableVec2[]) {
    super();
    if (points) this.setFromPoints(points);
  }

  setFromPoints(points: MutableVec2[]): this {
    this.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) this.lineTo(points[i][0], points[i][1]);
    return this;
  }
  moveTo(x: number, y: number): this {
    this.currentPoint = [x, y];
    return this;
  }
  lineTo(x: number, y: number): this {
    return this.push(new LineCurve<MutableVec2>(this.currentPoint, [x, y]), [x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this {
    return this.push(new QuadraticBezierCurve<MutableVec2>(this.currentPoint, [cx, cy], [x, y]), [x, y]);
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    return this.push(new CubicBezierCurve<MutableVec2>(this.currentPoint, [c1x, c1y], [c2x, c2y], [x, y]), [x, y]);
  }
  splineThru(points: MutableVec2[]): this {
    return this.push(
      new SplineCurve([this.currentPoint, ...points.map((p) => p.slice() as MutableVec2)]),
      points[points.length - 1].slice() as MutableVec2,
    );
  }
  /** Arc centered relative to the current point. */
  arc(aX: number, aY: number, radius: number, startAngle: number, endAngle: number, clockwise = false): this {
    return this.absarc(aX + this.currentPoint[0], aY + this.currentPoint[1], radius, startAngle, endAngle, clockwise);
  }
  absarc(aX: number, aY: number, radius: number, startAngle: number, endAngle: number, clockwise = false): this {
    return this.absellipse(aX, aY, radius, radius, startAngle, endAngle, clockwise);
  }
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
    return this.absellipse(
      aX + this.currentPoint[0],
      aY + this.currentPoint[1],
      xRadius,
      yRadius,
      startAngle,
      endAngle,
      clockwise,
      rotation,
    );
  }
  /** Adds an ellipse arc, joined to the pen by a straight line when it does not start there. */
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
    if (this.curves.length) {
      const first = curve.getPoint(0);
      if (!equals(first, this.currentPoint)) this.lineTo(first[0], first[1]);
    }
    return this.push(curve, curve.getPoint(1));
  }
  private push(curve: Curve<MutableVec2>, end: MutableVec2): this {
    this.add(curve);
    this.currentPoint = end;
    return this;
  }
}

/** A closed 2D outline with optional holes (Three.js `Shape`). */
export class Shape extends Path {
  holes: Path[] = [];
  getPointsHoles(divisions = 12): MutableVec2[][] {
    return this.holes.map((h) => h.getPoints(divisions));
  }
  extractPoints(divisions = 12): { shape: MutableVec2[]; holes: MutableVec2[][] } {
    return { shape: this.getPoints(divisions), holes: this.getPointsHoles(divisions) };
  }
}
