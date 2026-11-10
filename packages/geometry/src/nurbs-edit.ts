// Clean-room homogeneous knot refinement and Bezier degree elevation; see docs/clean-room.md, batch 219.
import { NurbsCurve, NurbsSurface } from './nurbs.js';
import type { Vec, MutableVec2, MutableVec3 } from './math.js';
import { geometryData, type GeometryData } from './data.js';
import { polygonIntersection, type PolygonInput } from './polygon.js';
import { triangulateConstrained } from './delaunay.js';

type Net = { degree: number; knots: number[]; control: number[][] };

function times(value: number, label: string, zero = false): void {
  if (!Number.isInteger(value) || value < (zero ? 0 : 1))
    throw new RangeError(`Invalid ${label}; pass an integer >= ${zero ? 0 : 1}`);
}

function curveNet<V extends Vec>(curve: NurbsCurve<V>): Net {
  return { degree: curve.degree, knots: [...curve.knots], control: curve.points.map((p, i) => [...p.map(x => x * curve.weights[i]), curve.weights[i]]) };
}

function fromNet<V extends Vec>(net: Net): NurbsCurve<V> {
  return new NurbsCurve({ degree: net.degree, knots: net.knots,
    points: net.control.map(p => p.slice(0, -1).map(x => x / p[p.length - 1]) as V),
    weights: net.control.map(p => p[p.length - 1]) });
}

function insert(net: Net, u: number): Net {
  const { degree: p, knots: U, control: P } = net, n = P.length - 1;
  if (!(u >= U[p] && u <= U[n + 1])) throw new RangeError('Invalid insertion parameter; use the active knot range');
  const s = U.filter(k => k === u).length;
  if (s >= p + 1) throw new RangeError('Knot multiplicity would exceed degree + 1; insert fewer knots');
  // At the active upper endpoint of an unclamped vector the span can be beyond n.
  let k = U.lastIndexOf(u);
  if (k < 0) { k = p; while (U[k + 1] < u) k++; }
  const Q: number[][] = [];
  for (let i = 0; i <= n + 1; i++) {
    if (i <= k - p) Q.push(P[i].slice());
    else if (i >= k - s + 1) Q.push(P[i - 1].slice());
    else {
      const a = (u - U[i]) / (U[i + p] - U[i]);
      Q.push(a === 0 ? P[i - 1].slice() : P[i].map((x, j) => a * x + (1 - a) * P[i - 1][j]));
    }
  }
  return { degree: p, knots: [...U.slice(0, k + 1), u, ...U.slice(k + 1)], control: Q };
}

/** Return a new curve with a knot inserted `count` times (default 1), preserving its rational shape. */
export function insertNurbsKnot<V extends Vec>(curve: NurbsCurve<V>, knot: number, count = 1): NurbsCurve<V> {
  times(count, 'insertion count', true);
  let net = curveNet(curve);
  for (let i = 0; i < count; i++) net = insert(net, knot);
  return fromNet<V>(net);
}

// Restrict an unclamped vector to its active domain without reparameterizing it.
function clamp(net: Net): Net {
  const p = net.degree, a = net.knots[p], b = net.knots[net.control.length];
  for (const u of [a, b]) while (net.knots.filter(k => k === u).length < p + 1) net = insert(net, u);
  const first = net.knots.indexOf(a), last = net.knots.lastIndexOf(b);
  return { degree: p, knots: net.knots.slice(first, last + 1), control: net.control.slice(first, last - p) };
}

// Invert one insertion in homogeneous coordinates. Solve from the better conditioned end of each row.
function remove(net: Net, u: number): Net {
  const U = net.knots.slice();
  U.splice(U.lastIndexOf(u), 1);
  const p = net.degree, Q = net.control, s = U.filter(k => k === u).length, k = U.lastIndexOf(u),
    P: number[][] = new Array(Q.length - 1);
  for (let i = 0; i <= k - p; i++) P[i] = Q[i].slice();
  for (let i = k - s; i < P.length; i++) P[i] = Q[i + 1].slice();
  let lo = k - p + 1, hi = k - s - 1;
  while (lo <= hi) {
    const a = (u - U[lo]) / (U[lo + p] - U[lo]),
      b = (u - U[hi + 1]) / (U[hi + p + 1] - U[hi + 1]);
    if (a >= 1 - b) {
      P[lo] = Q[lo].map((x, j) => (x - (1 - a) * P[lo - 1][j]) / a); lo++;
    } else {
      P[hi] = Q[hi + 1].map((x, j) => (x - b * P[hi + 1][j]) / (1 - b)); hi--;
    }
  }
  return { degree: p, knots: U, control: P };
}

/** Elevate the degree by `count` (default 1), preserving shape, knot parameters and interior continuity. */
export function elevateNurbsDegree<V extends Vec>(curve: NurbsCurve<V>, count = 1): NurbsCurve<V> {
  times(count, 'degree elevation count', true);
  if (!count) return fromNet<V>(curveNet(curve));
  let net = clamp(curveNet(curve));
  const p = net.degree, original = [...new Set(net.knots)].map(u => [u, net.knots.filter(k => k === u).length]),
    inner = original.slice(1, -1);
  for (const [u, m] of inner) for (let i = m; i < p; i++) net = insert(net, u);
  const knots: number[] = [], control: number[][] = [], q = p + count;
  for (let k = p; k < net.control.length; k++) {
    if (net.knots[k] === net.knots[k + 1]) continue;
    let B = net.control.slice(k - p, k + 1).map(v => v.slice());
    for (let d = p; d < q; d++) B = [B[0], ...Array.from({length: d}, (_, j) => {
      const i = j + 1, a = i / (d + 1);
      return B[i].map((x, c) => a * B[i - 1][c] + (1 - a) * x);
    }), B[d]];
    const disconnected = !control.length || net.knots.filter(u => u === net.knots[k]).length === p + 1;
    control.push(...B.slice(disconnected ? 0 : 1));
    if (!knots.length) knots.push(...new Array(q + 1).fill(net.knots[k]));
    const end = k + 1 === net.control.length,
      multiplicity = net.knots.filter(u => u === net.knots[k + 1]).length;
    knots.push(...new Array(end || multiplicity === p + 1 ? q + 1 : q).fill(net.knots[k + 1]));
  }
  net = { degree: q, knots, control };
  for (const [u, m] of inner) for (let i = m; i < p; i++) net = remove(net, u);
  return fromNet<V>(net);
}

function surfaceLines(surface: NurbsSurface, direction: 'u' | 'v', edit: (curve: NurbsCurve<MutableVec3>) => NurbsCurve<MutableVec3>): NurbsSurface {
  if (direction !== 'u' && direction !== 'v') throw new RangeError('Invalid direction; pass u or v');
  const u = direction === 'u', curves: NurbsCurve<MutableVec3>[] = [];
  for (let j = 0; j < (u ? surface.countV : surface.countU); j++) {
    const points: MutableVec3[] = [], weights: number[] = [];
    for (let i = 0; i < (u ? surface.countU : surface.countV); i++) {
      const at = ((u ? i : j) * surface.countV + (u ? j : i)) * 4, w = surface.control[at + 3];
      points.push([surface.control[at] / w, surface.control[at + 1] / w, surface.control[at + 2] / w]); weights.push(w);
    }
    curves.push(edit(new NurbsCurve({points, weights, degree: u ? surface.degreeU : surface.degreeV, knots: u ? surface.knotsU : surface.knotsV})));
  }
  const first = curves[0], rows = u ? first.points.length : curves.length, columns = u ? curves.length : first.points.length;
  return new NurbsSurface({
    degreeU: u ? first.degree : surface.degreeU, degreeV: u ? surface.degreeV : first.degree,
    knotsU: u ? first.knots : surface.knotsU, knotsV: u ? surface.knotsV : first.knots,
    points: Array.from({length: rows}, (_, i) => Array.from({length: columns}, (_, j) => (u ? curves[j].points[i] : curves[i].points[j]))),
    weights: Array.from({length: rows}, (_, i) => Array.from({length: columns}, (_, j) => (u ? curves[j].weights[i] : curves[i].weights[j]))),
  });
}

/** Insert a surface knot along u or v without changing its geometry. Returns a new surface. */
export function insertNurbsSurfaceKnot(surface: NurbsSurface, direction: 'u' | 'v', knot: number, count = 1): NurbsSurface {
  return surfaceLines(surface, direction, curve => insertNurbsKnot(curve, knot, count));
}

/** Elevate one surface degree without changing geometry or the other parameter direction. */
export function elevateNurbsSurfaceDegree(surface: NurbsSurface, direction: 'u' | 'v', count = 1): NurbsSurface {
  return surfaceLines(surface, direction, curve => elevateNurbsDegree(curve, count));
}

/** A closed polygon or rational trimming curve in normalized [0,1] UV coordinates. */
export type NurbsTrimLoop = readonly MutableVec2[] | NurbsCurve<MutableVec2>;
/** One retained region and its holes. Multiple regions may be passed to the tessellator. */
export interface NurbsTrimRegion {
  contour: NurbsTrimLoop;
  holes?: readonly NurbsTrimLoop[];
}
/** Trimming tessellation controls. Surface resolution is explicit, not a model-space error guarantee. */
export interface NurbsTrimOptions {
  /** Uniform intervals along u, plus every active knot. Default 32. */
  slices?: number;
  /** Uniform intervals along v, plus every active knot. Default 32. */
  stacks?: number;
  /** UV chord tolerance when sampling rational trim curves. Default 0.0001. */
  trimTolerance?: number;
}

function ring(loop: NurbsTrimLoop, tolerance: number): MutableVec2[] {
  const points = loop instanceof NurbsCurve ? loop.tessellate(tolerance) : loop.map(p => p.slice() as MutableVec2);
  if (points.length < 3 || points.some(p => p.length !== 2 || p.some(x => !Number.isFinite(x))))
    throw new RangeError('Invalid trim loop; pass at least three finite UV points or a closed 2D curve');
  if (loop instanceof NurbsCurve && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) > tolerance)
    throw new RangeError('Open trim curve; close the curve before trimming');
  return points;
}

function grid(knots: Float64Array, p: number, count: number, steps: number): number[] {
  const a = knots[p], b = knots[count];
  return [...new Set([...Array.from({length: steps + 1}, (_, i) => i / steps), ...knots.slice(p, count + 1).map(x => (x - a) / (b - a))])].sort((a, b) => a - b);
}

/** Tessellate retained UV regions and holes, clipping boundaries to each knot-aware surface cell before mapping to 3D. */
export function trimmedNurbsSurfaceGeometry(surface: NurbsSurface, regions: NurbsTrimRegion | readonly NurbsTrimRegion[], options: NurbsTrimOptions = {}): GeometryData {
  const {slices = 32, stacks = 32, trimTolerance = 1e-4} = options;
  times(slices, 'slices'); times(stacks, 'stacks');
  if (!(trimTolerance > 0 && Number.isFinite(trimTolerance))) throw new RangeError('Invalid trim tolerance; pass a finite positive value');
  const list: readonly NurbsTrimRegion[] = Array.isArray(regions) ? regions : [regions as NurbsTrimRegion];
  const input: PolygonInput = list.map(r => ({contour: ring(r.contour, trimTolerance), holes: (r.holes ?? []).map(h => ring(h, trimTolerance))})),
    us = grid(surface.knotsU, surface.degreeU, surface.countU, slices), vs = grid(surface.knotsV, surface.degreeV, surface.countV, stacks),
    positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let j = 0; j < vs.length - 1; j++) for (let i = 0; i < us.length - 1; i++) {
    const a = us[i], b = us[i + 1], c = vs[j], d = vs[j + 1],
      cell: MutableVec2[] = [[a,c],[b,c],[b,d],[a,d]];
    for (const region of polygonIntersection(input, cell)) {
      const mesh = triangulateConstrained(region.contour, region.holes), points = [...mesh.contour, ...mesh.holes.flat(), ...mesh.points], base = positions.length / 3;
      for (const [rawU, rawV] of points) {
        // Snap-rounded clipping can move a cell edge by half a grid unit. Restore that exact knot boundary first.
        const u = Math.max(a, Math.min(b, rawU)), v = Math.max(c, Math.min(d, rawV)),
          minU = surface.knotsU[surface.degreeU], minV = surface.knotsV[surface.degreeV],
          frame = surface.derivatives(minU + u * (surface.knotsU[surface.countU] - minU), minV + v * (surface.knotsV[surface.countV] - minV), u === b, v === d),
          {du, dv} = frame, normal = [du[1]*dv[2]-du[2]*dv[1],du[2]*dv[0]-du[0]*dv[2],du[0]*dv[1]-du[1]*dv[0]], length = Math.hypot(...normal);
        positions.push(...frame.point); uvs.push(u, v);
        if (length > 1e-12 * Math.hypot(...du) * Math.hypot(...dv)) normals.push(...normal.map(x => x / length));
        else normals.push(...surface.getNormal(a+(b-a)*1e-4+(u-a)*(1-2e-4), c+(d-c)*1e-4+(v-c)*(1-2e-4)));
      }
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const ids = mesh.indices.slice(t, t + 3).map(k => base + k), [x, y, z] = ids.map(k => positions.slice(k * 3, k * 3 + 3)),
          area = Math.hypot((y[1]-x[1])*(z[2]-x[2])-(y[2]-x[2])*(z[1]-x[1]), (y[2]-x[2])*(z[0]-x[0])-(y[0]-x[0])*(z[2]-x[2]), (y[0]-x[0])*(z[1]-x[1])-(y[1]-x[1])*(z[0]-x[0]));
        if (area > 0) indices.push(...ids);
      }
    }
  }
  return geometryData(positions, normals, uvs, indices);
}
