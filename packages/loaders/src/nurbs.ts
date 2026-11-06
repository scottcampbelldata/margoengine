// NURBS held as plain data, the numbers a CAD file hands over: this entry checks them, fills in end knots a file leaves
// out and tessellates. The maths is the one evaluator of @margoengine/geometry/nurbs.
import { NurbsCurve as CurveEvaluator, NurbsSurface as SurfaceEvaluator } from '@margoengine/geometry/nurbs';
import { computeVertexNormals } from './normals.js';
import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { limits } from './util.js';

const F = 'NURBS';

/** A NURBS curve as plain data. `knots` may leave out the two end knots, as Rhino files do. */
export interface NurbsCurve {
  degree: number;
  /** Non-decreasing, `points + degree + 1` long, or `points + degree - 1` without the end knots. */
  knots: ArrayLike<number>;
  /** xyz per control point. */
  points: ArrayLike<number>;
  /** One positive weight per control point. Default all 1, a plain B-spline. */
  weights?: ArrayLike<number>;
}

/** A NURBS surface as plain data: control points row by row, v fastest. */
export interface NurbsSurface {
  degreeU: number;
  degreeV: number;
  knotsU: ArrayLike<number>;
  knotsV: ArrayLike<number>;
  /** Control points along u. */
  countU: number;
  /** Control points along v. */
  countV: number;
  /** xyz per control point; point (i, j) starts at `(i * countV + j) * 3`. */
  points: ArrayLike<number>;
  /** One positive weight per control point. Default all 1. */
  weights?: ArrayLike<number>;
}

/** Options of {@link tessellateNurbsCurve}. */
export interface NurbsCurveOptions {
  /** Most distance between the curve and a chord. Default 0.1% of the control polygon's size. */
  tolerance?: number;
  /** Most points returned. Default 100,000. */
  maxPoints?: number;
}

/** Options of {@link tessellateNurbsSurface}. */
export interface NurbsSurfaceOptions extends ParseLimits {
  /** Quads across each knot span along u. Default 4 times `degreeU`. */
  segmentsU?: number;
  /** Quads across each knot span along v. Default 4 times `degreeV`. */
  segmentsV?: number;
}

/** A surface point with its unit normal, zero at a pole where the surface has none. */
export interface NurbsSurfacePoint {
  position: [number, number, number];
  normal: [number, number, number];
}

/** Checks a knot vector and gives it its end knots when the file left them out. */
function knotVector(source: ArrayLike<number>, count: number, degree: number, name: string): Float64Array {
  if (!Number.isSafeInteger(degree) || degree < 1) throw new LoaderError(F, 'range', `${name} degree must be 1 or more`);
  if (count <= degree)
    throw new LoaderError(F, 'range', `${name} needs more than ${degree} control points, got ${count}`);
  let knots = Float64Array.from(source);
  if (knots.length === count + degree - 1) {
    const full = new Float64Array(knots.length + 2);
    full.set(knots, 1);
    full[0] = knots[0];
    full[full.length - 1] = knots[knots.length - 1];
    knots = full;
  }
  if (knots.length !== count + degree + 1)
    throw new LoaderError(F, 'range', `${name} has ${knots.length} knots, expected ${count + degree + 1}`);
  for (let i = 0; i < knots.length; i++)
    if (!Number.isFinite(knots[i]) || (i && knots[i] < knots[i - 1]))
      throw new LoaderError(F, 'range', `${name} knots must be finite and non-decreasing`);
  if (!(knots[degree] < knots[count])) throw new LoaderError(F, 'range', `${name} has an empty domain`);
  return knots;
}

/** Checks the control points and weights and gives them the evaluator's shape. */
function controlPoints(
  points: ArrayLike<number>,
  weights: ArrayLike<number> | undefined,
  count: number,
): { net: [number, number, number][]; weights: number[] } {
  if (points.length !== count * 3)
    throw new LoaderError(F, 'range', `${points.length} coordinates for ${count} control points`);
  if (weights && weights.length !== count)
    throw new LoaderError(F, 'range', `${weights.length} weights for ${count} control points`);
  const net: [number, number, number][] = [],
    out: number[] = [];
  for (let i = 0; i < count; i++) {
    const w = weights ? weights[i] : 1;
    if (!(w > 0) || !Number.isFinite(w)) throw new LoaderError(F, 'range', `weight ${i} must be positive`);
    const point: [number, number, number] = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
    if (!point.every(Number.isFinite)) throw new LoaderError(F, 'range', `control point ${i} is not finite`);
    net.push(point);
    out.push(w);
  }
  return { net, weights: out };
}

function parameter(t: number, knots: Float64Array, degree: number, count: number): number {
  if (!Number.isFinite(t) || t < knots[degree] || t > knots[count])
    throw new LoaderError(F, 'range', `parameter ${t} is outside ${knots[degree]}..${knots[count]}`);
  return t;
}

interface PreparedCurve {
  degree: number;
  count: number;
  knots: Float64Array;
  evaluator: CurveEvaluator;
}

function prepareCurve(curve: NurbsCurve): PreparedCurve {
  const count = Math.floor(curve.points.length / 3),
    knots = knotVector(curve.knots, count, curve.degree, 'the curve'),
    { net, weights } = controlPoints(curve.points, curve.weights, count);
  return {
    degree: curve.degree,
    count,
    knots,
    evaluator: new CurveEvaluator({ points: net, degree: curve.degree, knots, weights }),
  };
}

const curvePoint = ({ evaluator }: PreparedCurve, t: number): [number, number, number] =>
  evaluator.evaluate(t) as [number, number, number];

/**
 * The point of a NURBS curve at parameter `t`.
 *
 * @param curve The degree, knots, control points and weights.
 * @param t A parameter inside the curve's domain.
 * @returns The point, `[x, y, z]`.
 * @throws LoaderError with code `range` for a malformed curve or a parameter outside the domain.
 *
 * @example
 * ```ts
 * import { evaluateNurbsCurve } from '@margoengine/loaders/nurbs';
 *
 * const line = { degree: 1, knots: [0, 0, 1, 1], points: [0, 0, 0, 2, 0, 0] };
 * console.log(evaluateNurbsCurve(line, 0.5));
 * ```
 */
export function evaluateNurbsCurve(curve: NurbsCurve, t: number): [number, number, number] {
  const prepared = prepareCurve(curve);
  return curvePoint(prepared, parameter(t, prepared.knots, prepared.degree, prepared.count));
}

function distanceToChord(p: number[], a: number[], b: number[]): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    e = [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
    length = d[0] * d[0] + d[1] * d[1] + d[2] * d[2],
    s = length > 0 ? Math.min(1, Math.max(0, (e[0] * d[0] + e[1] * d[1] + e[2] * d[2]) / length)) : 0;
  return Math.hypot(e[0] - s * d[0], e[1] - s * d[1], e[2] - s * d[2]);
}

/** The distinct knots inside the domain, each span cut `pieces` times when asked. */
function breaks(knots: Float64Array, degree: number, count: number, pieces = 1): number[] {
  const out: number[] = [];
  for (let i = degree; i < count; i++) {
    if (knots[i] === knots[i + 1]) continue;
    for (let k = 0; k < pieces; k++) out.push(knots[i] + ((knots[i + 1] - knots[i]) * k) / pieces);
  }
  out.push(knots[count]);
  return out;
}

/**
 * Turns a NURBS curve into a polyline that stays within `tolerance` of it: each knot span is split until the curve at
 * quarter points of a piece is close to its chord, so straight runs stay cheap and tight bends get more points.
 *
 * @param curve The degree, knots, control points and weights.
 * @param options The chord tolerance and the point limit.
 * @returns xyz per point in order: `mode: 'strip'` of `@margoengine/lines`.
 * @throws LoaderError with code `range` for a malformed curve or `limit` past `maxPoints`.
 *
 * @example
 * ```ts
 * import { tessellateNurbsCurve } from '@margoengine/loaders/nurbs';
 *
 * const arc = { degree: 2, knots: [0, 0, 0, 1, 1, 1], points: [1, 0, 0, 1, 1, 0, 0, 1, 0], weights: [1, Math.SQRT1_2, 1] };
 * console.log(tessellateNurbsCurve(arc, { tolerance: 0.001 }).length / 3);
 * ```
 */
export function tessellateNurbsCurve(curve: NurbsCurve, options: NurbsCurveOptions = {}): Float32Array {
  const prepared = prepareCurve(curve),
    { points } = curve,
    maxPoints = options.maxPoints ?? 100_000;
  let tolerance = options.tolerance;
  if (tolerance === undefined) {
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i++) {
      low[i % 3] = Math.min(low[i % 3], points[i]);
      high[i % 3] = Math.max(high[i % 3], points[i]);
    }
    tolerance = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) * 0.001 || 1e-6;
  }
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new LoaderError(F, 'range', 'tolerance must be positive');
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 2)
    throw new LoaderError(F, 'range', 'maxPoints must be an integer of 2 or more');
  const out: number[] = [],
    stops = breaks(prepared.knots, prepared.degree, prepared.count),
    add = (p: number[]): void => {
      if (out.length / 3 >= maxPoints)
        throw new LoaderError(F, 'limit', `the curve needs more than ${maxPoints} points at this tolerance`);
      out.push(p[0], p[1], p[2]);
    };
  const split = (t0: number, p0: number[], t1: number, p1: number[], depth: number): void => {
    const middle = (t0 + t1) / 2,
      pm = curvePoint(prepared, middle),
      quarter = curvePoint(prepared, (t0 + middle) / 2),
      threeQuarter = curvePoint(prepared, (middle + t1) / 2),
      far = Math.max(
        distanceToChord(pm, p0, p1),
        distanceToChord(quarter, p0, p1),
        distanceToChord(threeQuarter, p0, p1),
      );
    if (far > tolerance && depth < 24) {
      split(t0, p0, middle, pm, depth + 1);
      split(middle, pm, t1, p1, depth + 1);
    } else add(p1);
  };
  let previous = curvePoint(prepared, stops[0]);
  add(previous);
  for (let i = 1; i < stops.length; i++) {
    const next = curvePoint(prepared, stops[i]);
    split(stops[i - 1], previous, stops[i], next, 0);
    previous = next;
  }
  return Float32Array.from(out);
}

interface PreparedSurface {
  degreeU: number;
  degreeV: number;
  countU: number;
  countV: number;
  knotsU: Float64Array;
  knotsV: Float64Array;
  evaluator: SurfaceEvaluator;
}

function prepareSurface(surface: NurbsSurface): PreparedSurface {
  const { degreeU, degreeV, countU, countV } = surface;
  if (!Number.isSafeInteger(countU) || !Number.isSafeInteger(countV))
    throw new LoaderError(F, 'range', 'countU and countV must be integers');
  const knotsU = knotVector(surface.knotsU, countU, degreeU, 'the surface along u'),
    knotsV = knotVector(surface.knotsV, countV, degreeV, 'the surface along v'),
    { net, weights } = controlPoints(surface.points, surface.weights, countU * countV),
    rows = <T>(list: T[]) => Array.from({ length: countU }, (_, i) => list.slice(i * countV, (i + 1) * countV));
  return {
    degreeU,
    degreeV,
    countU,
    countV,
    knotsU,
    knotsV,
    evaluator: new SurfaceEvaluator({ points: rows(net), degreeU, degreeV, knotsU, knotsV, weights: rows(weights) }),
  };
}

/** Writes the point and unit normal at (u, v) into `position` and `normal`. */
function surfacePoint(s: PreparedSurface, u: number, v: number, position: number[], normal: number[]): void {
  const { point, du: su, dv: sv } = s.evaluator.derivatives(u, v);
  position[0] = point[0];
  position[1] = point[1];
  position[2] = point[2];
  const x = su[1] * sv[2] - su[2] * sv[1],
    y = su[2] * sv[0] - su[0] * sv[2],
    z = su[0] * sv[1] - su[1] * sv[0],
    length = Math.hypot(x, y, z),
    scale = Math.hypot(...su) * Math.hypot(...sv);
  // Against the two tangents' own size: at a pole one tangent vanishes and this cross product is rounding noise.
  if (length > 1e-12 * scale && length > 0) {
    normal[0] = x / length;
    normal[1] = y / length;
    normal[2] = z / length;
  } else normal[0] = normal[1] = normal[2] = 0;
}

/**
 * The point and unit normal of a NURBS surface at (u, v). The normal is zero where the surface has none, as at a pole.
 *
 * @param surface The degrees, knots, control grid and weights.
 * @param u A parameter inside the u domain.
 * @param v A parameter inside the v domain.
 * @returns The position and normal.
 * @throws LoaderError with code `range` for a malformed surface or a parameter outside the domain.
 *
 * @example
 * ```ts
 * import { evaluateNurbsSurface } from '@margoengine/loaders/nurbs';
 *
 * const patch = { degreeU: 1, degreeV: 1, knotsU: [0, 0, 1, 1], knotsV: [0, 0, 1, 1], countU: 2, countV: 2,
 *   points: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0] };
 * console.log(evaluateNurbsSurface(patch, 0.5, 0.5));
 * ```
 */
export function evaluateNurbsSurface(surface: NurbsSurface, u: number, v: number): NurbsSurfacePoint {
  const s = prepareSurface(surface),
    position: [number, number, number] = [0, 0, 0],
    normal: [number, number, number] = [0, 0, 0];
  surfacePoint(
    s,
    parameter(u, s.knotsU, s.degreeU, s.countU),
    parameter(v, s.knotsV, s.degreeV, s.countV),
    position,
    normal,
  );
  return { position, normal };
}

/**
 * Turns a NURBS surface into a triangle grid with exact normals. Grid lines fall on every distinct knot, so creases stay
 * sharp in position. `uvs` run 0 to 1 across the domain. Trim curves are not applied: this is the whole surface.
 *
 * @param surface The degrees, knots, control grid and weights.
 * @param options Quads per knot span and the shared size limits.
 * @returns A mesh with positions, normals, uvs and indices.
 * @throws LoaderError with code `range` for a malformed surface or `limit` past the size limits.
 *
 * @example
 * ```ts
 * import { tessellateNurbsSurface } from '@margoengine/loaders/nurbs';
 *
 * const patch = { degreeU: 1, degreeV: 1, knotsU: [0, 0, 1, 1], knotsV: [0, 0, 1, 1], countU: 2, countV: 2,
 *   points: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0] };
 * console.log(tessellateNurbsSurface(patch, { segmentsU: 2, segmentsV: 2 }).indices?.length);
 * ```
 */
export function tessellateNurbsSurface(surface: NurbsSurface, options: NurbsSurfaceOptions = {}): LoadedGeometry {
  const s = prepareSurface(surface),
    { maxVertices, maxTriangles } = limits(options, F),
    segmentsU = options.segmentsU ?? 4 * s.degreeU,
    segmentsV = options.segmentsV ?? 4 * s.degreeV;
  if (!Number.isSafeInteger(segmentsU) || segmentsU < 1 || !Number.isSafeInteger(segmentsV) || segmentsV < 1)
    throw new LoaderError(F, 'range', 'segmentsU and segmentsV must be positive integers');
  const us = breaks(s.knotsU, s.degreeU, s.countU, segmentsU),
    vs = breaks(s.knotsV, s.degreeV, s.countV, segmentsV),
    columns = vs.length,
    rows = us.length,
    vertices = rows * columns,
    triangles = (rows - 1) * (columns - 1) * 2;
  if (vertices > maxVertices) throw new LoaderError(F, 'limit', `${vertices} vertices exceed the limit of ${maxVertices}`);
  if (triangles > maxTriangles)
    throw new LoaderError(F, 'limit', `${triangles} triangles exceed the limit of ${maxTriangles}`);
  const positions = new Float32Array(vertices * 3),
    normals = new Float32Array(vertices * 3),
    uvs = new Float32Array(vertices * 2),
    indices = new Uint32Array(triangles * 3),
    position = [0, 0, 0],
    normal = [0, 0, 0],
    u0 = us[0],
    uSize = us[rows - 1] - u0,
    v0 = vs[0],
    vSize = vs[columns - 1] - v0;
  let poles = false;
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < columns; j++) {
      const at = i * columns + j;
      surfacePoint(s, us[i], vs[j], position, normal);
      positions.set(position, at * 3);
      normals.set(normal, at * 3);
      if (!normal[0] && !normal[1] && !normal[2]) poles = true;
      uvs[at * 2] = (us[i] - u0) / uSize;
      uvs[at * 2 + 1] = (vs[j] - v0) / vSize;
    }
  let t = 0;
  for (let i = 0; i + 1 < rows; i++)
    for (let j = 0; j + 1 < columns; j++) {
      const a = i * columns + j,
        b = a + columns;
      indices.set([a, b, b + 1, a, b + 1, a + 1], t);
      t += 6;
    }
  if (poles) {
    // A pole has no normal of its own: it takes the one the triangles around it agree on.
    const smooth = computeVertexNormals(positions, indices);
    for (let v = 0; v < vertices; v++)
      if (!normals[v * 3] && !normals[v * 3 + 1] && !normals[v * 3 + 2])
        normals.set(smooth.subarray(v * 3, v * 3 + 3), v * 3);
  }
  return { kind: 'mesh', positions, normals, uvs, indices };
}
