// NURBS curves and surfaces, written from the definitions in Piegl and Tiller, "The NURBS Book" (1997): the Cox-de Boor
// recurrence for the basis, the derivative of a basis function as a difference of two lower-degree ones, and the
// quotient rule on homogeneous coordinates for rational derivatives.
import { Curve, sampleCount } from './curve.js';
import type { GeometryData } from './data.js';
import { normalize, to3, type MutableVec3, type Vec } from './math.js';

/** How far a degenerate point (a pole) looks inward for its normal, as a fraction of the parameter range. */
const inset = 1e-4;

/** Options of {@link NurbsCurve}. */
export interface NurbsCurveOptions<V extends Vec = MutableVec3> {
  /** Control points, all `[x, y]` or all `[x, y, z]`; at least `degree + 1`. */
  points: readonly V[];
  /** Polynomial degree, an integer of at least 1. Default 3, or the highest the point count allows. */
  degree?: number;
  /** Non-decreasing knots, `points.length + degree + 1` of them. Default clamped and uniform on [0, 1]. */
  knots?: ArrayLike<number>;
  /** One positive weight per control point. Default all 1. */
  weights?: ArrayLike<number>;
}

/** Options of {@link NurbsSurface}. */
export interface NurbsSurfaceOptions {
  /** Control net: `points[i][j]` is `[x, y, z]`, `i` along u and `j` along v. Every row has the same length. */
  points: readonly (readonly MutableVec3[])[];
  /** Degree along u. Default 3, or the highest the net allows. */
  degreeU?: number;
  /** Degree along v. Default 3, or the highest the net allows. */
  degreeV?: number;
  /** Knots along u, `points.length + degreeU + 1` of them. Default clamped and uniform on [0, 1]. */
  knotsU?: ArrayLike<number>;
  /** Knots along v, `points[0].length + degreeV + 1` of them. Default clamped and uniform on [0, 1]. */
  knotsV?: ArrayLike<number>;
  /** `weights[i][j]`, positive, the same shape as `points`. Default all 1. */
  weights?: readonly (readonly number[])[];
}

/** A surface point and its first partial derivatives with respect to the knot parameters. */
export interface NurbsSurfaceDerivatives {
  point: MutableVec3;
  du: MutableVec3;
  dv: MutableVec3;
}

function checkDegree(label: string, degree: number, count: number): number {
  if (!Number.isInteger(degree) || degree < 1)
    throw new RangeError(`NURBS ${label} ${degree} is invalid; pass an integer of at least 1`);
  if (count < degree + 1)
    throw new RangeError(`NURBS ${label} ${degree} needs ${degree + 1} control points, got ${count}; add points`);
  return degree;
}

function clampedKnots(count: number, degree: number): Float64Array {
  const knots = new Float64Array(count + degree + 1),
    inner = count - degree;
  for (let i = 0; i < knots.length; i++) knots[i] = Math.min(1, Math.max(0, (i - degree) / inner));
  return knots;
}

function checkKnots(given: ArrayLike<number> | undefined, count: number, degree: number): Float64Array {
  if (given === undefined) return clampedKnots(count, degree);
  if (given.length !== count + degree + 1)
    throw new RangeError(
      `NURBS knots hold ${given.length} values; pass ${count + degree + 1} (control points + degree + 1)`,
    );
  const knots = Float64Array.from(given);
  let run = 1;
  for (let i = 0; i < knots.length; i++) {
    if (!Number.isFinite(knots[i])) throw new RangeError('NURBS knots must be finite; pass finite numbers');
    if (i === 0) continue;
    if (knots[i] < knots[i - 1]) throw new RangeError('NURBS knots must not decrease; sort them');
    run = knots[i] === knots[i - 1] ? run + 1 : 1;
    if (run > degree + 1) throw new RangeError(`NURBS knot ${knots[i]} repeats ${run} times; use at most degree + 1`);
  }
  if (!(knots[degree] < knots[count]))
    throw new RangeError('NURBS knots leave an empty parameter range; make knots[degree] < knots[points.length]');
  return knots;
}

/**
 * The knot span holding `u`: `knots[span] <= u < knots[span + 1]`, or with `left`, `knots[span] < u <= knots[span + 1]`
 * (the side a parameter is reached from matters at a repeated knot). The ends of the range stay inside it.
 */
function findSpan(knots: Float64Array, degree: number, count: number, u: number, left: boolean): number {
  let low = degree,
    high = count;
  if (!left && u >= knots[count]) {
    low = count - 1;
    while (low > degree && knots[low] === knots[low + 1]) low--;
    return low;
  }
  if (left && u <= knots[degree]) {
    while (low < count - 1 && knots[low] === knots[low + 1]) low++;
    return low;
  }
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (left ? u <= knots[middle] : u < knots[middle]) high = middle;
    else low = middle;
  }
  return low;
}

/**
 * The `degree + 1` basis functions that are not zero on `span`, and their derivatives: row `k` holds the k-th derivative
 * at `u`. Each table row `q` holds the degree-q functions, entry `r` being function `span - q + r`.
 */
function basis(knots: Float64Array, span: number, u: number, degree: number, order: number): number[][] {
  let table: number[][] = [[1]];
  for (let q = 1; q <= degree; q++) {
    const lower = table[q - 1],
      row: number[] = [];
    for (let r = 0; r <= q; r++) {
      const i = span - q + r,
        rising = r > 0 ? ((u - knots[i]) / (knots[i + q] - knots[i])) * lower[r - 1] : 0,
        falling = r < q ? ((knots[i + q + 1] - u) / (knots[i + q + 1] - knots[i + 1])) * lower[r] : 0;
      row.push(rising + falling);
    }
    table.push(row);
  }
  const rows = [table[degree]];
  for (let k = 1; k <= order; k++) {
    const next: number[][] = [[0]];
    for (let q = 1; q <= degree; q++) {
      const lower = table[q - 1],
        row: number[] = [];
      for (let r = 0; r <= q; r++) {
        const i = span - q + r,
          rising = r > 0 ? lower[r - 1] / (knots[i + q] - knots[i]) : 0,
          falling = r < q ? lower[r] / (knots[i + q + 1] - knots[i + 1]) : 0;
        row.push(q * (rising - falling));
      }
      next.push(row);
    }
    rows.push(next[degree]);
    table = next;
  }
  return rows;
}

function binomial(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
  return value;
}

function checkParameter(u: number, low: number, high: number): void {
  if (!(u >= low && u <= high))
    throw new RangeError(`NURBS parameter ${u} is outside [${low}, ${high}]; pass a value in the range`);
}

/**
 * A non-uniform rational B-spline curve in 2D or 3D. It is a {@link Curve}, so `getPoint`, `getPointAt`, `getLength`
 * and `computeFrenetFrames` work and `tubeGeometry` and `extrudeGeometry` accept it. `t` in [0, 1] maps linearly to the
 * knot range; `evaluate` and `derivatives` take the knot parameter itself. The curve is fixed once built: its control
 * data is copied in.
 */
export class NurbsCurve<V extends Vec = MutableVec3> extends Curve<V> {
  /** Polynomial degree. */
  readonly degree: number;
  /** The knot vector. */
  readonly knots: Float64Array;
  /** One weight per control point. */
  readonly weights: Float64Array;
  /** The control points. */
  readonly points: readonly V[];
  /** First knot parameter of the curve. */
  readonly start: number;
  /** Last knot parameter of the curve. */
  readonly end: number;
  private readonly size: number;
  /** Homogeneous control points: `w * x, w * y, [w * z,] w`. */
  private readonly control: Float64Array;

  /**
   * @param options - See {@link NurbsCurveOptions}.
   * @throws TypeError when `points` is not a list of 2D or 3D points of one size.
   * @throws RangeError when the degree, knots, weights or a coordinate is invalid.
   */
  constructor(options: NurbsCurveOptions<V>) {
    super();
    const points = options?.points;
    if (!Array.isArray(points) || !points.length)
      throw new TypeError('NurbsCurve needs points; pass a list of [x, y] or [x, y, z] arrays');
    const size = (points[0] as V)?.length,
      count = points.length;
    if (size !== 2 && size !== 3)
      throw new TypeError('NurbsCurve points must be [x, y] or [x, y, z]; pass 2 or 3 numbers each');
    this.degree = checkDegree('degree', options.degree ?? Math.min(3, count - 1), count);
    this.knots = checkKnots(options.knots, count, this.degree);
    const weights = options.weights;
    if (weights !== undefined && weights.length !== count)
      throw new RangeError(`NurbsCurve has ${weights.length} weights; pass one per control point (${count})`);
    this.weights = weights ? Float64Array.from(weights) : new Float64Array(count).fill(1);
    this.size = size;
    this.control = new Float64Array(count * (size + 1));
    this.points = (points as V[]).map((point, i) => {
      const w = this.weights[i];
      if (!(w > 0 && w < Infinity)) throw new RangeError(`NurbsCurve weight ${w} is invalid; pass a finite value > 0`);
      if (point?.length !== size) throw new TypeError('NurbsCurve points must all have the same size; pass one kind');
      for (let k = 0; k < size; k++) {
        if (!Number.isFinite(point[k])) throw new RangeError('NurbsCurve points must be finite; pass finite numbers');
        this.control[i * (size + 1) + k] = point[k] * w;
      }
      this.control[i * (size + 1) + size] = w;
      return point.slice() as V;
    });
    this.start = this.knots[this.degree];
    this.end = this.knots[count];
  }

  /** The point at knot parameter `u`. */
  evaluate(u: number): V {
    return this.derivatives(u, 0)[0];
  }

  /**
   * The point at knot parameter `u` and its derivatives with respect to `u`: entry `k` is the k-th derivative, exact for
   * the rational curve. At a repeated knot the derivatives are the right-hand ones, or the left-hand ones with `left`.
   *
   * @throws RangeError when `u` is outside the knot range or `order` is not an integer of at least 0.
   */
  derivatives(u: number, order = 1, left = false): V[] {
    checkParameter(u, this.start, this.end);
    if (!Number.isInteger(order) || order < 0)
      throw new RangeError(`NurbsCurve derivative order ${order} is invalid; pass an integer >= 0`);
    const { degree, knots, size, control } = this,
      stride = size + 1,
      span = findSpan(knots, degree, this.points.length, u, left),
      rows = basis(knots, span, u, degree, Math.min(order, degree)),
      out: V[] = [],
      weight: number[] = [];
    for (let k = 0; k <= order; k++) {
      const row = rows[k],
        value = new Array<number>(size).fill(0);
      let w = 0;
      if (row)
        for (let r = 0; r <= degree; r++) {
          const at = (span - degree + r) * stride;
          for (let c = 0; c < size; c++) value[c] += row[r] * control[at + c];
          w += row[r] * control[at + size];
        }
      weight.push(w);
      for (let i = 1; i <= k; i++) {
        const factor = binomial(k, i) * weight[i],
          earlier = out[k - i];
        for (let c = 0; c < size; c++) value[c] -= factor * earlier[c];
      }
      for (let c = 0; c < size; c++) value[c] /= weight[0];
      out.push(value as V);
    }
    return out;
  }

  /** The point at `t` in [0, 1]. */
  getPoint(t: number): V {
    return this.evaluate(this.parameter(t));
  }

  /** Unit tangent at `t` from the exact derivative; where the derivative vanishes, from nearby points. */
  override getTangent(t: number): V {
    const d = this.derivatives(this.parameter(t), 1)[1];
    return d.some((x) => x !== 0) ? normalize(d) : super.getTangent(t);
  }

  /**
   * Points along the curve within `tolerance` of it, in the curve's units: every distinct knot, with each span halved
   * until its chords stay that close (12 halvings at most). Corners at repeated knots stay exact, which even steps in
   * `t` cannot promise.
   *
   * @throws RangeError when `tolerance` is not a finite number above 0.
   */
  tessellate(tolerance = 1e-3): V[] {
    if (!(tolerance > 0 && tolerance < Infinity))
      throw new RangeError(`NurbsCurve tolerance ${tolerance} is invalid; pass a finite number > 0`);
    const out: V[] = [this.evaluate(this.start)],
      deviation = (a: V, b: V, p: V, s: number): number => {
        let squared = 0;
        for (let c = 0; c < this.size; c++) squared += (p[c] - a[c] - (b[c] - a[c]) * s) ** 2;
        return Math.sqrt(squared);
      };
    // Halves [u0, u1] while the points at a quarter, half and three quarters leave the chord; one point alone can sit
    // on the chord of an S-shaped span.
    const refine = (u0: number, a: V, u1: number, b: V, depth: number): void => {
      const middle = (u0 + u1) / 2,
        m = this.evaluate(middle),
        q0 = this.evaluate((u0 + middle) / 2),
        q1 = this.evaluate((middle + u1) / 2),
        far = Math.max(deviation(a, b, m, 0.5), deviation(a, b, q0, 0.25), deviation(a, b, q1, 0.75));
      if (depth >= 12 || far <= tolerance) {
        out.push(b);
        return;
      }
      refine(u0, a, middle, m, depth + 1);
      refine(middle, m, u1, b, depth + 1);
    };
    const { knots, degree, end } = this;
    let from = this.start,
      a = out[0];
    for (let i = degree + 1; i <= this.points.length; i++) {
      if (knots[i] <= from) continue;
      const u = Math.min(knots[i], end),
        b = this.derivatives(u, 0, true)[0];
      refine(from, a, u, b, 0);
      from = u;
      a = b;
    }
    return out;
  }

  private parameter(t: number): number {
    return this.start + (this.end - this.start) * Math.min(1, Math.max(0, t));
  }
}

/** Basis values and first derivatives of one parameter line of a surface. */
interface SurfaceLine {
  span: number;
  values: number[];
  slopes: number[];
}

/**
 * A non-uniform rational B-spline surface in 3D. `getPoint` and `getNormal` take (u, v) in [0, 1], mapped linearly to
 * the two knot ranges; `evaluate` and `derivatives` take the knot parameters. Mesh it with {@link nurbsSurfaceGeometry}.
 * The surface is fixed once built: its control data is copied in.
 */
export class NurbsSurface {
  /** Degree along u. */
  readonly degreeU: number;
  /** Degree along v. */
  readonly degreeV: number;
  /** Knots along u. */
  readonly knotsU: Float64Array;
  /** Knots along v. */
  readonly knotsV: Float64Array;
  /** Control points along u. */
  readonly countU: number;
  /** Control points along v. */
  readonly countV: number;
  /** Homogeneous control net, `(i * countV + j) * 4`: `w * x, w * y, w * z, w`. */
  readonly control: Float64Array;

  /**
   * @param options - See {@link NurbsSurfaceOptions}.
   * @throws TypeError when `points` is not a rectangular net of `[x, y, z]`.
   * @throws RangeError when a degree, knot vector, weight or coordinate is invalid.
   */
  constructor(options: NurbsSurfaceOptions) {
    const points = options?.points;
    if (!Array.isArray(points) || !points.length || !Array.isArray(points[0]) || !points[0].length)
      throw new TypeError('NurbsSurface needs a control net; pass points[i][j] as [x, y, z] arrays');
    const countU = points.length,
      countV = points[0].length,
      weights = options.weights;
    this.countU = countU;
    this.countV = countV;
    this.degreeU = checkDegree('degreeU', options.degreeU ?? Math.min(3, countU - 1), countU);
    this.degreeV = checkDegree('degreeV', options.degreeV ?? Math.min(3, countV - 1), countV);
    this.knotsU = checkKnots(options.knotsU, countU, this.degreeU);
    this.knotsV = checkKnots(options.knotsV, countV, this.degreeV);
    if (weights !== undefined && (weights.length !== countU || weights.some((row) => row?.length !== countV)))
      throw new RangeError(`NurbsSurface weights must be ${countU} rows of ${countV}; match the control net`);
    this.control = new Float64Array(countU * countV * 4);
    for (let i = 0; i < countU; i++) {
      if (points[i]?.length !== countV)
        throw new TypeError('NurbsSurface rows must have the same length; pass a rectangular net');
      for (let j = 0; j < countV; j++) {
        const point = points[i][j],
          w = weights ? weights[i][j] : 1,
          at = (i * countV + j) * 4;
        if (point?.length !== 3) throw new TypeError('NurbsSurface points must be [x, y, z]; pass 3 numbers each');
        if (!point.every(Number.isFinite))
          throw new RangeError('NurbsSurface points must be finite; pass finite numbers');
        if (!(w > 0 && w < Infinity))
          throw new RangeError(`NurbsSurface weight ${w} is invalid; pass a finite value > 0`);
        this.control[at] = point[0] * w;
        this.control[at + 1] = point[1] * w;
        this.control[at + 2] = point[2] * w;
        this.control[at + 3] = w;
      }
    }
  }

  /** The point at knot parameters (u, v). */
  evaluate(u: number, v: number): MutableVec3 {
    return this.derivatives(u, v).point;
  }

  /**
   * The point at knot parameters (u, v) and its exact first partial derivatives.
   *
   * @throws RangeError when a parameter is outside its knot range.
   */
  derivatives(u: number, v: number): NurbsSurfaceDerivatives {
    checkParameter(u, this.knotsU[this.degreeU], this.knotsU[this.countU]);
    checkParameter(v, this.knotsV[this.degreeV], this.knotsV[this.countV]);
    const out = new Float64Array(9);
    frame(this, lineU(this, u, false), lineV(this, v, false), out);
    return { point: [out[0], out[1], out[2]], du: [out[3], out[4], out[5]], dv: [out[6], out[7], out[8]] };
  }

  /** The point at (u, v) in [0, 1]. */
  getPoint(u: number, v: number): MutableVec3 {
    return this.evaluate(unitU(this, u), unitV(this, v));
  }

  /**
   * The unit normal at (u, v) in [0, 1], `dS/du x dS/dv`. At a pole, where the derivatives cannot span a plane, it is
   * taken a small step inside the parameter square; a surface with no area there gives `[0, 0, 1]`.
   */
  getNormal(u: number, v: number): MutableVec3 {
    const out = new Float64Array(9),
      normal: MutableVec3 = [0, 0, 1];
    frame(this, lineU(this, unitU(this, u), false), lineV(this, unitV(this, v), false), out);
    if (!writeNormal(out, normal, 0)) inwardNormal(this, u, v, normal, 0);
    return normal;
  }
}

/** Knot parameter of `u` in [0, 1] along u. */
function unitU(surface: NurbsSurface, u: number): number {
  const low = surface.knotsU[surface.degreeU];
  return low + (surface.knotsU[surface.countU] - low) * Math.min(1, Math.max(0, u));
}

/** Knot parameter of `v` in [0, 1] along v. */
function unitV(surface: NurbsSurface, v: number): number {
  const low = surface.knotsV[surface.degreeV];
  return low + (surface.knotsV[surface.countV] - low) * Math.min(1, Math.max(0, v));
}

function line(knots: Float64Array, degree: number, count: number, u: number, left: boolean): SurfaceLine {
  const span = findSpan(knots, degree, count, u, left),
    [values, slopes] = basis(knots, span, u, degree, 1);
  return { span, values, slopes };
}

const lineU = (s: NurbsSurface, u: number, left: boolean): SurfaceLine => line(s.knotsU, s.degreeU, s.countU, u, left);
const lineV = (s: NurbsSurface, v: number, left: boolean): SurfaceLine => line(s.knotsV, s.degreeV, s.countV, v, left);

/** Point, dS/du and dS/dv where two parameter lines cross, into `out`. */
function frame(surface: NurbsSurface, alongU: SurfaceLine, alongV: SurfaceLine, out: Float64Array): void {
  const { control, countV, degreeU, degreeV } = surface;
  let x = 0,
    y = 0,
    z = 0,
    w = 0,
    xu = 0,
    yu = 0,
    zu = 0,
    wu = 0,
    xv = 0,
    yv = 0,
    zv = 0,
    wv = 0;
  for (let a = 0; a <= degreeU; a++) {
    const row = (alongU.span - degreeU + a) * countV + alongV.span - degreeV,
      n = alongU.values[a],
      dn = alongU.slopes[a];
    for (let b = 0; b <= degreeV; b++) {
      const at = (row + b) * 4,
        value = n * alongV.values[b],
        slopeU = dn * alongV.values[b],
        slopeV = n * alongV.slopes[b],
        cx = control[at],
        cy = control[at + 1],
        cz = control[at + 2],
        cw = control[at + 3];
      x += value * cx;
      y += value * cy;
      z += value * cz;
      w += value * cw;
      xu += slopeU * cx;
      yu += slopeU * cy;
      zu += slopeU * cz;
      wu += slopeU * cw;
      xv += slopeV * cx;
      yv += slopeV * cy;
      zv += slopeV * cz;
      wv += slopeV * cw;
    }
  }
  const px = x / w,
    py = y / w,
    pz = z / w;
  out[0] = px;
  out[1] = py;
  out[2] = pz;
  out[3] = (xu - wu * px) / w;
  out[4] = (yu - wu * py) / w;
  out[5] = (zu - wu * pz) / w;
  out[6] = (xv - wv * px) / w;
  out[7] = (yv - wv * py) / w;
  out[8] = (zv - wv * pz) / w;
}

/** The unit `du x dv` of a frame into `target`; false when the derivatives cannot span a plane. */
function writeNormal(point: Float64Array, target: MutableVec3 | Float32Array, at: number): boolean {
  const ux = point[3],
    uy = point[4],
    uz = point[5],
    vx = point[6],
    vy = point[7],
    vz = point[8],
    nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx,
    length = Math.hypot(nx, ny, nz);
  if (!(length > 1e-12 * Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz))) return false;
  target[at] = nx / length;
  target[at + 1] = ny / length;
  target[at + 2] = nz / length;
  return true;
}

/** The normal one small step inside the parameter square from (u, v) in [0, 1], or +z where there is none. */
function inwardNormal(
  surface: NurbsSurface,
  u: number,
  v: number,
  target: MutableVec3 | Float32Array,
  at: number,
): void {
  const out = new Float64Array(9);
  frame(
    surface,
    lineU(surface, unitU(surface, u + Math.sign(0.5 - u) * inset), false),
    lineV(surface, unitV(surface, v + Math.sign(0.5 - v) * inset), false),
    out,
  );
  if (writeNormal(out, target, at)) return;
  target[at] = target[at + 1] = 0;
  target[at + 2] = 1;
}

/** One grid line of a mesh: where it runs, its [0, 1] coordinate and which side of a repeated knot it belongs to. */
interface GridLine {
  knot: number;
  coordinate: number;
  left: boolean;
}

/**
 * The parameter lines of one direction: `divisions` even steps plus every distinct inner knot, so mesh edges follow the
 * surface's own seams. A knot repeated `degree` times is where the surface may crease, so it gets two lines, one for
 * each side, sharing positions but each with its own normals.
 */
function gridLines(knots: Float64Array, degree: number, count: number, divisions: number): GridLine[] {
  const low = knots[degree],
    high = knots[count],
    range = high - low,
    lines: GridLine[] = [],
    inner = new Map<number, number>();
  for (let i = degree + 1; i < count; i++)
    if (knots[i] > low && knots[i] < high) inner.set(knots[i], (inner.get(knots[i]) ?? 0) + 1);
  const stops = [...inner.keys()],
    near = range / divisions / 4;
  for (let i = 0; i <= divisions; i++) {
    const u = low + (range * i) / divisions;
    if (i === 0 || i === divisions || !stops.some((k) => inner.has(k) && Math.abs(k - u) < near)) stops.push(u);
  }
  stops.sort((a, b) => a - b);
  for (const knot of stops) {
    const coordinate = (knot - low) / range;
    if ((inner.get(knot) ?? 0) >= degree) lines.push({ knot, coordinate, left: true });
    lines.push({ knot, coordinate, left: false });
  }
  return lines;
}

/**
 * Meshes a surface: a grid of at least `(slices + 1) x (stacks + 1)` vertices, `u` across and `v` up, plus a line at
 * every inner knot. Positions and normals are exact evaluations, not differences, so a NURBS sphere's normals are
 * radial; the normal is `dS/du x dS/dv` and the triangles wind the same way. UVs are (u, v) in [0, 1] over the knot
 * ranges. Where a knot is repeated `degree` times the grid line is doubled with one-sided normals, so a crease stays
 * sharp. Triangles with two corners at one point (at a pole) are left out. Seams of closed surfaces are not welded;
 * `mergeVertices` does that.
 *
 * @param surface - The surface.
 * @param slices - Even steps along u, floored, at least 1. Default 32.
 * @param stacks - Even steps along v, floored, at least 1. Default 32.
 * @throws TypeError when `surface` is not a {@link NurbsSurface}.
 * @throws RangeError when a step count is not a finite number of at least 1.
 */
export function nurbsSurfaceGeometry(surface: NurbsSurface, slices = 32, stacks = 32): GeometryData {
  if (!(surface instanceof NurbsSurface))
    throw new TypeError('nurbsSurfaceGeometry needs a NurbsSurface; pass new NurbsSurface(options)');
  for (const value of [slices, stacks])
    if (sampleCount('nurbsSurfaceGeometry', value) < 1)
      throw new RangeError(`nurbsSurfaceGeometry got ${value} divisions; pass a finite number >= 1`);
  const across = gridLines(surface.knotsU, surface.degreeU, surface.countU, Math.floor(slices)),
    up = gridLines(surface.knotsV, surface.degreeV, surface.countV, Math.floor(stacks)),
    columns = across.length,
    rows = up.length,
    count = columns * rows,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2),
    point = new Float64Array(9),
    linesU = across.map((g) => lineU(surface, g.knot, g.left));
  for (let j = 0, k = 0; j < rows; j++) {
    const alongV = lineV(surface, up[j].knot, up[j].left);
    for (let i = 0; i < columns; i++, k++) {
      frame(surface, linesU[i], alongV, point);
      positions[k * 3] = point[0];
      positions[k * 3 + 1] = point[1];
      positions[k * 3 + 2] = point[2];
      uvs[k * 2] = across[i].coordinate;
      uvs[k * 2 + 1] = up[j].coordinate;
      if (!writeNormal(point, normals, k * 3))
        inwardNormal(surface, across[i].coordinate, up[j].coordinate, normals, k * 3);
    }
  }
  const same = (a: number, b: number): boolean =>
      positions[a * 3] === positions[b * 3] &&
      positions[a * 3 + 1] === positions[b * 3 + 1] &&
      positions[a * 3 + 2] === positions[b * 3 + 2],
    indices: number[] = [],
    triangle = (a: number, b: number, c: number): void => {
      if (!same(a, b) && !same(b, c) && !same(c, a)) indices.push(a, b, c);
    };
  for (let j = 0; j + 1 < rows; j++)
    for (let i = 0; i + 1 < columns; i++) {
      const p = j * columns + i,
        q = p + 1,
        r = q + columns,
        s = p + columns;
      triangle(p, q, s);
      triangle(q, r, s);
    }
  return { positions, normals, uvs, indices: Uint32Array.from(indices) };
}

/** Layout of an exact rational quadratic arc: `2 * arcs + 1` control points, the middle weight and the knots. */
function arcLayout(sweep: number): { arcs: number; middle: number; knots: number[] } {
  const arcs = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)),
    knots = [0, 0, 0];
  for (let k = 1; k < arcs; k++) knots.push(k / arcs, k / arcs);
  knots.push(1, 1, 1);
  return { arcs, middle: Math.cos(sweep / arcs / 2), knots };
}

function checkSweep(label: string, sweep: number): void {
  if (!Number.isFinite(sweep) || sweep === 0 || Math.abs(sweep) > 2 * Math.PI + 1e-9)
    throw new RangeError(`${label} sweep ${sweep} is invalid; pass a finite angle, not 0, of at most 2 pi radians`);
}

/**
 * An exact circle or arc in the z = 0 plane, centred on the origin: rational quadratic spans of at most 90 degrees, so
 * every point is at `radius` to rounding, which no polynomial spline can do.
 *
 * @param radius - Radius. Default 1.
 * @param startAngle - Start, radians from +x towards +y. Default 0.
 * @param endAngle - End, radians; below `startAngle` runs clockwise. Default 2 pi, a full circle.
 * @throws RangeError when the radius is not above 0 or the sweep is 0 or over a full turn.
 */
export function nurbsCircle(radius = 1, startAngle = 0, endAngle = 2 * Math.PI): NurbsCurve<MutableVec3> {
  if (!(radius > 0 && radius < Infinity))
    throw new RangeError(`nurbsCircle radius ${radius} is invalid; pass a finite number > 0`);
  const sweep = endAngle - startAngle;
  checkSweep('nurbsCircle', sweep);
  const { arcs, middle, knots } = arcLayout(sweep),
    points: MutableVec3[] = [],
    weights: number[] = [];
  for (let k = 0; k <= 2 * arcs; k++) {
    const angle = startAngle + (sweep * k) / (2 * arcs),
      w = k % 2 ? middle : 1,
      r = radius / w;
    points.push([r * Math.cos(angle), r * Math.sin(angle), 0]);
    weights.push(w);
  }
  return new NurbsCurve<MutableVec3>({ degree: 2, points, knots, weights });
}

/**
 * Revolves a profile curve around the +y axis through the origin into an exact surface of revolution: `u` runs along
 * the profile and `v` around the axis, each profile point turning from +x towards +z. A profile rising along +y on the
 * +x side faces away from the axis.
 *
 * @param profile - The profile; 2D points are taken at z = 0.
 * @param angle - Sweep in radians. Default 2 pi, a full turn.
 * @throws TypeError when `profile` is not a {@link NurbsCurve}.
 * @throws RangeError when the sweep is 0 or over a full turn.
 */
export function nurbsRevolve(profile: NurbsCurve<Vec>, angle = 2 * Math.PI): NurbsSurface {
  if (!(profile instanceof NurbsCurve))
    throw new TypeError('nurbsRevolve needs a NurbsCurve; pass new NurbsCurve(options)');
  checkSweep('nurbsRevolve', angle);
  const { arcs, middle, knots } = arcLayout(angle),
    points: MutableVec3[][] = [],
    weights: number[][] = [];
  profile.points.forEach((point, i) => {
    const [x, y, z] = to3(point),
      row: MutableVec3[] = [],
      rowWeights: number[] = [];
    for (let k = 0; k <= 2 * arcs; k++) {
      const turn = (angle * k) / (2 * arcs),
        c = Math.cos(turn),
        s = Math.sin(turn),
        w = k % 2 ? middle : 1;
      row.push([(x * c - z * s) / w, y, (x * s + z * c) / w]);
      rowWeights.push(profile.weights[i] * w);
    }
    points.push(row);
    weights.push(rowWeights);
  });
  return new NurbsSurface({
    points,
    weights,
    degreeU: profile.degree,
    degreeV: 2,
    knotsU: profile.knots,
    knotsV: knots,
  });
}
