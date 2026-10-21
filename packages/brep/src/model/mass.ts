// Mass properties of a body from its exact faces, not a mesh: volume, area, centroid and inertia. The divergence
// theorem turns each volume integral into one over the faces, and Green's theorem turns each face's integral over its
// trimmed (u', v) domain into one along its loops of an inner integral in v:
//   integral over D of g du' dv = - loop integral of G du',   G(u', v) = integral from v* to v of g(u', t) dt.
// Seam lines (u' constant) then add nothing; a pole the face covers is taken as v*, so the line it collapses to adds
// nothing either (a second pole is added as its own line). Faces with no loops (a whole sphere or torus) are
// integrated over their full parameter rectangle. Quadrature is Gauss-Legendre of order 16 on pieces short enough
// for the integrands (a sixteenth of a turn on circles and angular parameters, knot spans on splines; along an edge on
// a spline face, split where its foot crosses a knot line and halved until the nodes follow it).
import type { Curve } from '../geometry/curves.js';
import type { XYZ } from '../geometry/vec.js';
import type { Surface } from '../geometry/surfaces.js';
import { FaceUV, type UV } from './faces.js';
import { curveEvaluator } from './geometry.js';
import type { Body, Face } from './topology.js';
import { edgeParameters } from './validate.js';

/** Mass properties of a solid of unit density. */
export interface MassProperties {
  /** Volume in m^3 (for a sheet body, the signed volume its faces would enclose). */
  readonly volume: number;
  /** Area of all faces in m^2. */
  readonly area: number;
  /** Centre of the volume. */
  readonly centroid: XYZ;
  /**
   * Inertia tensor about the centroid, unit density: [Ixx, Iyy, Izz, Ixy, Iyz, Izx], where Ixx is the integral of
   * y^2 + z^2 and Ixy is minus the integral of x y (the convention of a moment-of-inertia matrix).
   */
  readonly inertia: readonly [number, number, number, number, number, number];
}

/** Gauss-Legendre nodes on [-1, 1] and weights, order 16 (Newton on the Legendre polynomial). */
const GAUSS = (() => {
  const n = 16,
    x: number[] = [],
    w: number[] = [];
  for (let i = 1; i <= n; i++) {
    let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5)),
      dp = 0;
    for (let k = 0; k < 100; k++) {
      let p0 = 1,
        p1 = z;
      for (let j = 2; j <= n; j++) [p0, p1] = [p1, ((2 * j - 1) * z * p1 - (j - 1) * p0) / j];
      dp = (n * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-16) break;
    }
    // Ascending, so a piece is walked from its start to its end.
    x.unshift(z);
    w.unshift(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
})();

/** Components integrated per face: area, volume, three first moments, six second moments. */
const K = 11;

/** Integral over [a, b] (either order) of a vector function, split into `pieces` equal parts. */
function quad(f: (t: number) => Float64Array, a: number, b: number, pieces: number, into: Float64Array) {
  const h = (b - a) / pieces;
  for (let p = 0; p < pieces; p++) {
    const lo = a + p * h,
      mid = lo + h / 2;
    for (let i = 0; i < GAUSS.x.length; i++) {
      const g = f(mid + (h / 2) * GAUSS.x[i]),
        w = (h / 2) * GAUSS.w[i];
      for (let k = 0; k < K; k++) into[k] += w * g[k];
    }
  }
}

/**
 * Integral from a to b (either order) split at the knots between them, where a spline's derivatives may jump: at least
 * `pieces` parts in all, as many to each knot span. Without knots (or with very many between), `pieces` equal parts.
 */
function quadKnots(
  f: (t: number) => Float64Array,
  a: number,
  b: number,
  knots: readonly number[],
  pieces: number,
  into: Float64Array,
) {
  if (knots.length < 2) return quad(f, a, b, pieces, into);
  const lo = Math.min(a, b),
    hi = Math.max(a, b),
    inside = knots.filter((k) => k > lo && k < hi);
  if (inside.length > 512) return quad(f, a, b, pieces, into);
  const cuts = [a, ...(a < b ? inside : inside.reverse()), b],
    per = Math.max(1, Math.ceil(pieces / (cuts.length - 1)));
  for (let i = 0; i + 1 < cuts.length; i++) quad(f, cuts[i], cuts[i + 1], per, into);
}

/** Pieces for a parameter span: a sixteenth of a turn on an angle, one on a straight (linear) parameter. */
const piecesOf = (span: number, angular: boolean) =>
  angular ? Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 8))) : 1;

/** Whether v is an angle on this surface (spheres, tori), so the inner integral is split by turn. */
const vAngular = (s: Surface) => s.vPeriod > 0 || (Number.isFinite(s.vDomain[0]) && Number.isFinite(s.vDomain[1]));

/** Pieces for the inner integral over a v span: by turn on angles; 16 on a spline surface (several knot spans). */
const vPieces = (face: Face, s: Surface, span: number) =>
  face.surface.kind === 'spline' ? 16 : piecesOf(span, vAngular(s));

/** The face's integrals of the K components, about the point c. */
function faceIntegrals(face: Face, c: XYZ): Float64Array {
  const fuv = new FaceUV(face),
    s = fuv.surface,
    flip = fuv.flip,
    sign = fuv.sense ? 1 : -1,
    out = new Float64Array(K),
    g = new Float64Array(K);
  /** The integrands at (u', v). */
  const integrand = (up: number, v: number): Float64Array => {
    const d = s.at(flip ? -up : up, v),
      x = d[0] - c[0],
      y = d[1] - c[1],
      z = d[2] - c[2],
      nx = d[4] * d[8] - d[5] * d[7],
      ny = d[5] * d[6] - d[3] * d[8],
      nz = d[3] * d[7] - d[4] * d[6],
      sx = sign * nx,
      sy = sign * ny,
      sz = sign * nz;
    g[0] = Math.sqrt(nx * nx + ny * ny + nz * nz);
    g[1] = (x * sx + y * sy + z * sz) / 3;
    g[2] = (x * x * sx) / 2;
    g[3] = (y * y * sy) / 2;
    g[4] = (z * z * sz) / 2;
    g[5] = (x * x * x * sx) / 3;
    g[6] = (y * y * y * sy) / 3;
    g[7] = (z * z * z * sz) / 3;
    g[8] = (x * x * y * sx) / 2;
    g[9] = (y * y * z * sy) / 2;
    g[10] = (z * z * x * sz) / 2;
    return g;
  };

  // A face with no loops covers its whole surface: integrate the parameter rectangle directly.
  if (!face.loops.length) {
    const [u0, u1] = s.uPeriod ? [0, s.uPeriod] : s.uDomain,
      [v0, v1] = s.vPeriod ? [0, s.vPeriod] : s.vDomain;
    if (![u0, u1, v0, v1].every(Number.isFinite)) throw new RangeError(`${face.name}: an unbounded face has no mass`);
    const row = new Float64Array(K);
    quad(
      (u) => {
        row.fill(0);
        quad((v) => integrand(u, v), v0, v1, vPieces(face, s, v1 - v0), row);
        return row;
      },
      u0,
      u1,
      piecesOf(u1 - u0, true),
      out,
    );
    return out;
  }

  // v*: a pole the face covers (its collapsed line then adds nothing); else where a torus's tube is cut open; else the
  // loops' lowest v.
  const covered: { side: 1 | -1; v: number }[] = [];
  for (const side of [1, -1] as const) {
    const pv = s.pole(side);
    // A pole a loop runs through is on the face's boundary: its line is integrated along with the loop below.
    if (pv === undefined || fuv.poleLines.some((l) => l.v === pv)) continue;
    if (fuv.contains(s.at(0, pv).slice(0, 3) as XYZ)) covered.push({ side, v: pv });
  }
  const vStar = covered.length ? covered[0].v : s.vPeriod ? fuv.vCut : fuv.box[2],
    inner = new Float64Array(K);
  // A spline's knots, in (u', v). One swept along many more spans of v than across u (a thread's flank: a ruling swept
  // round dozens of turns) is integrated across u' inside and along v outside, the short way, when nothing about it
  // wraps or collapses.
  const [uKnots, vKnots] = s.breaks?.() ?? [[], []],
    uKnotsP = fuv.flip ? uKnots.map((k) => -k).reverse() : uKnots,
    across =
      uKnots.length >= 2 &&
      vKnots.length > uKnots.length &&
      !s.uPeriod &&
      !s.vPeriod &&
      s.pole(1) === undefined &&
      s.pole(-1) === undefined &&
      s.uPole?.(1) === undefined &&
      s.uPole?.(-1) === undefined,
    uStar = fuv.box[0];
  /** G(u', v): the integral of the integrands from v* to v at u' (across: from u* to u' at v). */
  const G = (up: number, v: number): Float64Array => {
    inner.fill(0);
    if (across) quadKnots((t) => integrand(t, v), uStar, up, uKnotsP, 4, inner);
    else quadKnots((t) => integrand(up, t), vStar, v, vKnots, vPieces(face, s, v - vStar), inner);
    return inner;
  };

  // Along every loop: - integral of G du' (across: + integral of G dv), with (u', v) followed continuously from
  // FaceUV's own start of the loop. A spline edge is cut where it turns a sixteenth of a turn (a helix runs dozens of
  // turns): the sampler weighs turning only on pieces longer than a hundredth of its deflection, so that deflection is
  // the face's size. Lines and conics keep one piece per span, exact on analytic faces. On a spline face every piece
  // is cut again where the edge's foot crosses a knot line, and halved where its nodes still miss (pieceNodes). The
  // rates are the edge's foot's (an imported edge may lie a little off the face, or run a little past its surface's
  // edge).
  const size = face.loops.some((l) => l.coedges.some((co) => co.edge.curve.kind === 'spline')) ? faceSize(face) : 1,
    step = new Float64Array(K),
    walk: Walk = { fuv, lines: knotLines(fuv), bend: bendSteps(face, s), axis: across ? 1 : 0 },
    // Gaps under a millionth of a millionth of the face's extent change its integrals by less than that.
    small = 1e-12 * (across ? fuv.box[3] - fuv.box[2] : fuv.box[1] - fuv.box[0]);
  /**
   * From the end of one coedge's curve to the start of the next, straight in (u', v): an imported vertex a little off
   * its edges (within its tolerance) leaves their curves' ends apart, and the loop has to close for the integral not to
   * depend on v*. The faces either side of an edge bridge its ends alike, so pieces of a face add up to the face. At a
   * pole, the pole's line closes the loop (below).
   */
  const bridge = (from: UV, to: UV) => {
    const d = across ? to[1] - from[1] : to[0] - from[0];
    if (!(Math.abs(d) > small)) return;
    const gv = G((from[0] + to[0]) / 2, (from[1] + to[1]) / 2),
      w = across ? d : -d;
    for (let k = 0; k < K; k++) out[k] += gv[k] * w;
  };
  face.loops.forEach((loop, li) => {
    let hint: UV = fuv.loops[li].points[0] ?? fuv.near(loop.coedges[0].start.point),
      first: XYZ | undefined,
      last: UV | undefined;
    for (const co of loop.coedges) {
      const curve = curveEvaluator(co.edge.curve),
        [t0, t1] = edgeParameters(co.edge, 1),
        [a, b] = co.forward ? [t0, t1] : [t1, t0],
        breaks = curve.sample(a, b, co.edge.curve.kind === 'spline' ? size : Number.POSITIVE_INFINITY, Math.PI / 8),
        pole = fuv.poleOf(co.start.point) !== undefined;
      if (!pole) {
        const p = curve.at(a).slice(0, 3) as XYZ,
          uv = fuv.near(p, hint);
        if (co === loop.coedges[0]) first = p;
        else if (last) bridge(last, uv);
        hint = uv;
      }
      for (let i = 0; i + 1 < breaks.length; i++) {
        step.fill(0);
        const piece = pieceNodes(walk, curve, breaks[i], breaks[i + 1], hint);
        for (const n of piece.nodes) {
          const gv = G(n.uv[0], n.uv[1]),
            w = across ? n.rates[1] : -n.rates[0];
          for (let k = 0; k < K; k++) step[k] += n.w * (gv[k] * w);
        }
        hint = piece.end;
        for (let k = 0; k < K; k++) out[k] += step[k];
      }
      last = undefined;
      if (fuv.poleOf(co.end.point) === undefined) hint = last = fuv.near(curve.at(b).slice(0, 3) as XYZ, hint);
    }
    // Back to the first coedge's start, the short way (a loop round a cylinder ends a period on from where it began).
    if (first && last && fuv.poleOf(loop.coedges[0].start.point) === undefined) bridge(last, fuv.near(first, last));
  });

  // Where a loop runs through a pole: along its line from the u' it arrives with to the u' it leaves with, the meridians
  // its edges run along into and out of the pole, as the walk along them reaches them.
  for (const l of fuv.poleLines) {
    const line = new Float64Array(K);
    quad((up) => G(up, l.v), l.from, l.to, piecesOf(l.to - l.from, true), line);
    for (let k = 0; k < K; k++) out[k] -= line[k];
  }

  // A torus with holes, cut open round its tube inside the face: the cut's far side, run towards -u' with the face
  // below it (G is zero on its near side).
  if (fuv.cutInside) {
    const line = new Float64Array(K);
    quad((up) => G(up, fuv.vCut + s.vPeriod), 0, s.uPeriod, piecesOf(s.uPeriod, true), line);
    for (let k = 0; k < K; k++) out[k] += line[k];
  }

  // A second covered pole: its line, run with the face on its left (towards -u' at the high pole, +u' at the low).
  for (const pole of covered.slice(1)) {
    const line = new Float64Array(K);
    quad((up) => G(up, pole.v), 0, s.uPeriod, piecesOf(s.uPeriod, true), line);
    for (let k = 0; k < K; k++) out[k] += pole.side === 1 ? line[k] : -line[k];
  }
  return out;
}

/**
 * Parameter steps (u, v) for differencing a surface's first derivatives: a millionth of an angle's turn, of a spline's
 * mean knot span, or of a metre along a straight parameter; none on a plane, which does not bend.
 */
function bendSteps(face: Face, s: Surface): [number, number] | undefined {
  if (face.surface.kind === 'plane') return undefined;
  const [uKnots, vKnots] = s.breaks?.() ?? [[], []],
    scale = (period: number, domain: readonly [number, number], knots: readonly number[]) =>
      knots.length >= 2
        ? (knots[knots.length - 1] - knots[0]) / (knots.length - 1)
        : period || (Number.isFinite(domain[1] - domain[0]) ? domain[1] - domain[0] : 1);
  return [1e-6 * scale(s.uPeriod, s.uDomain, uKnots), 1e-6 * scale(s.vPeriod, s.vDomain, vKnots)];
}

/**
 * (du'/dt, dv/dt) along a curve at (u', v), the foot on the surface of its point p: how fast that foot moves, u mirrored
 * where the face flips it. On the surface that is the curve's tangent split into Su and Sv (least squares). An imported
 * edge a little off its face (within its tolerance) moves faster or slower than its foot where the surface bends (round
 * a cylinder, by its distance from the axis over the radius), and its tangent's rates then add up to the wrong change
 * of u' along it: the face's integrals come out depending on where v* lies. So, with w = p - S the curve's offset, the
 * foot's rates solve (A - W)(du, dv) = (Su.p', Sv.p'), A the surface's first fundamental form and W_ij = w.S_ij, its
 * second derivatives found from one step of Su and Sv (`steps`, when the offset is large enough to matter). Where p
 * lies past an end of an open parameter (an imported edge may run a little past its surface's edge, within its
 * tolerance), its foot is held at that end and moves along it only: Su.(p - S) = 0 alone, (a - W_uu) du = Su.p' (or
 * the same in v). At a pole, where Su vanishes, both are taken as 0: the curve meets the pole's line at a point.
 */
function rates(s: Surface, flip: boolean, uv: UV, p: number[], steps?: [number, number]): [number, number] {
  const u = flip ? -uv[0] : uv[0],
    v = uv[1],
    d = s.at(u, v),
    su = [d[3], d[4], d[5]],
    sv = [d[6], d[7], d[8]],
    tan = [p[3], p[4], p[5]],
    ru = su[0] * tan[0] + su[1] * tan[1] + su[2] * tan[2],
    rv = sv[0] * tan[0] + sv[1] * tan[1] + sv[2] * tan[2];
  let a = su[0] * su[0] + su[1] * su[1] + su[2] * su[2],
    b = su[0] * sv[0] + su[1] * sv[1] + su[2] * sv[2],
    e = sv[0] * sv[0] + sv[1] * sv[1] + sv[2] * sv[2];
  if (!(Math.abs(a * e - b * b) > 1e-30 * (a * e + 1e-300))) return [0, 0];
  const [holdU, holdV] = holds(s, u, v, d, p, a, b, e);
  if (holdU && holdV) return [0, 0];
  if (steps) {
    const w = [p[0] - d[0], p[1] - d[1], p[2] - d[2]],
      // A step's length on the surface is a millionth of the distance over which it bends: an offset under a millionth
      // of that changes the rates by under 1e-12.
      reach = 1e-6 * Math.min(Math.sqrt(a) * steps[0], Math.sqrt(e) * steps[1]);
    if (w[0] * w[0] + w[1] * w[1] + w[2] * w[2] > reach * reach) {
      // Forward steps, back from a domain end (a spline clamps there).
      const hu = !s.uPeriod && u + steps[0] > s.uDomain[1] ? -steps[0] : steps[0],
        hv = !s.vPeriod && v + steps[1] > s.vDomain[1] ? -steps[1] : steps[1],
        du = s.at(u + hu, v),
        dv = s.at(u, v + hv),
        along = (q: number[], k: number) =>
          w[0] * (q[k] - d[k]) + w[1] * (q[k + 1] - d[k + 1]) + w[2] * (q[k + 2] - d[k + 2]);
      a -= along(du, 3) / hu;
      b -= (along(du, 6) / hu + along(dv, 3) / hv) / 2;
      e -= along(dv, 6) / hv;
    }
  }
  if (holdV) {
    const du = ru / a;
    return [flip ? -du : du, 0];
  }
  if (holdU) return [0, rv / e];
  const det = a * e - b * b,
    du = (ru * e - rv * b) / det;
  return [flip ? -du : du, (a * rv - b * ru) / det];
}

/**
 * One Gauss-Newton step (du, dv) from the surface point d = [S, Su, Sv] towards the foot of p, a, b and e the first
 * fundamental form there: zero where d is p's own foot; past the surface's edge, as far again as p lies beyond it.
 */
function stepTowards(d: readonly number[], p: readonly number[], a: number, b: number, e: number): [number, number] {
  const w0 = p[0] - d[0],
    w1 = p[1] - d[1],
    w2 = p[2] - d[2],
    gu = d[3] * w0 + d[4] * w1 + d[5] * w2,
    gv = d[6] * w0 + d[7] * w1 + d[8] * w2,
    det = a * e - b * b;
  return [(gu * e - gv * b) / det, (a * gv - b * gu) / det];
}

/**
 * Whether the foot d = S(u, v) of p is held at an end of u, of v, as the projection holds it: where its step towards
 * p's foot (stepTowards) leads out past an end it sits on, it stays there and the other parameter moves alone; at a
 * corner it stays when both steps lead out, or one does and the other's own way, Su.(p - S) or Sv.(p - S), does too.
 */
function holds(
  s: Surface,
  u: number,
  v: number,
  d: readonly number[],
  p: readonly number[],
  a: number,
  b: number,
  e: number,
): [boolean, boolean] {
  // +1 at the high end of an open range, -1 at the low end: the way out.
  const eu = s.uPeriod ? 0 : u <= s.uDomain[0] ? -1 : u >= s.uDomain[1] ? 1 : 0,
    ev = s.vPeriod ? 0 : v <= s.vDomain[0] ? -1 : v >= s.vDomain[1] ? 1 : 0;
  if (!eu && !ev) return [false, false];
  const [ou, ov] = stepTowards(d, p, a, b, e),
    outU = eu * ou > 0,
    outV = ev * ov > 0;
  if (!eu || !ev) return [outU, outV];
  const w0 = p[0] - d[0],
    w1 = p[1] - d[1],
    w2 = p[2] - d[2],
    wayU = eu * (d[3] * w0 + d[4] * w1 + d[5] * w2) > 0,
    wayV = ev * (d[6] * w0 + d[7] * w1 + d[8] * w2) > 0,
    both = (outU && outV) || (outU && wayV) || (outV && wayU);
  return both ? [true, true] : [outU, outV];
}

/**
 * Where the foot uv of p stands for crossing knot lines and the surface's edges: the foot itself, carried on past an
 * open parameter's end as far as p lies beyond it (stepTowards; zero inside, where the foot is p's own). Undefined at
 * a pole, where u has no meaning.
 */
function past(s: Surface, flip: boolean, uv: UV, p: readonly number[]): UV | undefined {
  const d = s.at(flip ? -uv[0] : uv[0], uv[1]),
    a = d[3] * d[3] + d[4] * d[4] + d[5] * d[5],
    b = d[3] * d[6] + d[4] * d[7] + d[5] * d[8],
    e = d[6] * d[6] + d[7] * d[7] + d[8] * d[8];
  if (!(Math.abs(a * e - b * b) > 1e-30 * (a * e + 1e-300))) return undefined;
  const [ou, ov] = stepTowards(d, p, a, b, e);
  return [uv[0] + (flip ? -ou : ou), uv[1] + ov];
}

/**
 * A spline face's knot lines in (u', v), where its integrands' derivatives may jump, ascending, with the ends of each
 * parameter's range (where an edge running past the surface's edge has its foot held, and its rates kink); on a closed
 * direction they repeat every period. `extent`: the face's extent in u' and v (its box's, or the knots' where that is
 * none). A foot within a ten-billionth of it of a line is on it: an edge along a line, or along the surface's edge
 * with its foot in and out of it by 1e-13, is not cut at each wobble.
 */
interface KnotLines {
  readonly u: readonly number[];
  readonly v: readonly number[];
  readonly periods: readonly [number, number];
  readonly extent: readonly [number, number];
}

/** The face's knot lines, or none on a surface without knots. */
function knotLines(fuv: FaceUV): KnotLines | undefined {
  const s = fuv.surface,
    [uKnots, vKnots] = s.breaks?.() ?? [[], []];
  if (uKnots.length < 2 && vKnots.length < 2) return undefined;
  const extent = (lo: number, hi: number, knots: readonly number[]) =>
    hi - lo || (knots.length >= 2 ? knots[knots.length - 1] - knots[0] : 1);
  return {
    u: fuv.flip ? uKnots.map((k) => -k).reverse() : uKnots,
    v: vKnots,
    periods: [s.uPeriod, s.vPeriod],
    extent: [extent(fuv.box[0], fuv.box[1], uKnots), extent(fuv.box[2], fuv.box[3], vKnots)],
  };
}

/** The lines among ascending `knots` (repeated every `period` when it is not 0) strictly between lo and hi. */
function linesBetween(knots: readonly number[], period: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  if (knots.length < 2 || !(hi > lo)) return out;
  if (!period) {
    // The first knot past lo by bisection (a thread's flank has hundreds), then on to hi.
    let i = 0,
      j = knots.length;
    while (i < j) {
      const m = (i + j) >> 1;
      if (knots[m] > lo) j = m;
      else i = m + 1;
    }
    for (; i < knots.length && knots[i] < hi; i++) out.push(knots[i]);
    return out;
  }
  // One period's knots (the last is the first a period on), shifted by whole periods to cover lo..hi.
  for (let m = Math.floor((lo - knots[0]) / period); knots[0] + m * period < hi; m++)
    for (let i = 0; i + 1 < knots.length; i++) {
      const k = knots[i] + m * period;
      if (k > lo && k < hi) out.push(k);
    }
  return out;
}

/** A Gauss node along an edge: its parameter t and weight, the edge's point and tangent, its foot and their rates. */
interface EdgeNode {
  readonly t: number;
  readonly w: number;
  readonly p: number[];
  readonly uv: UV;
  readonly rates: [number, number];
}

/** What pieceNodes needs of a face: its (u', v), knot lines, bend steps, and the coordinate its loop runs along. */
interface Walk {
  readonly fuv: FaceUV;
  readonly lines?: KnotLines;
  readonly bend?: [number, number];
  readonly axis: 0 | 1;
}

/**
 * The Gauss nodes of an edge's piece from t0 to t1, `hint` a foot near t0's, and the foot at t1: 16 nodes, with their
 * feet's rates. On a spline face (`lines`) the integrands' derivatives jump where the edge's foot crosses a knot line,
 * and the foot's rates where it passes the surface's edge and is held there: one Gauss piece across such kinks makes
 * the rates' integral miss the change of u' along the edge (by 2e-4 of the face on a line across 8 knot spans), and the
 * face's integrals then depend on v*. So wherever two consecutive feet (the piece's ends and nodes) lie either side of
 * a line, the crossing is found (regula falsi, Illinois) and the piece is split there. And a part whose nodes still
 * miss the change of its coordinates by over a millionth of a millionth of the face (`miss`: a span where the foot's
 * speed changes sixfold or more) is halved, up to 8 times, while that cuts its miss fourfold. Elsewhere the nodes are
 * one piece's.
 */
function pieceNodes(walk: Walk, curve: Curve, t0: number, t1: number, hint: UV): { nodes: EdgeNode[]; end: UV } {
  type Foot = { t: number; p: number[]; uv: UV; x?: UV };
  const { fuv, lines, bend, axis } = walk,
    s = fuv.surface,
    foot = (t: number, near: UV): Foot => {
      const p = curve.at(t),
        uv = fuv.near(p.slice(0, 3) as XYZ, near);
      // Right after the projection, which leaves the surface evaluated there.
      return { t, p, uv, x: lines && past(s, fuv.flip, uv, p) };
    },
    gauss = (a: number, b: number, from: UV, feet?: Foot[]): EdgeNode[] => {
      const h = b - a,
        mid = a + h / 2,
        out: EdgeNode[] = [];
      for (let i = 0; i < GAUSS.x.length; i++) {
        const f = foot(mid + (h / 2) * GAUSS.x[i], from);
        from = f.uv;
        feet?.push(f);
        out.push({ t: f.t, w: (h / 2) * GAUSS.w[i], p: f.p, uv: f.uv, rates: rates(s, fuv.flip, f.uv, f.p, bend) });
      }
      return out;
    };
  if (!lines) {
    const nodes = gauss(t0, t1, hint);
    return { nodes, end: nodes[nodes.length - 1].uv };
  }
  const start = foot(t0, hint),
    feet: Foot[] = [start],
    nodes = gauss(t0, t1, start.uv, feet),
    end = foot(t1, nodes[nodes.length - 1].uv),
    extent = lines.extent,
    on = [1e-10 * extent[0], 1e-10 * extent[1]];
  feet.push(end);
  /** The foot between feet a and b where coordinate `along` of `past` meets the line k, fa and fb their misses. */
  const crossing = (along: 0 | 1, k: number, a: Foot, b: Foot, fa: number, fb: number): Foot => {
    let f = a,
      side = 0;
    for (let i = 0; i < 40; i++) {
      let t = (a.t * fb - b.t * fa) / (fb - fa);
      if (!(t > Math.min(a.t, b.t) && t < Math.max(a.t, b.t))) t = (a.t + b.t) / 2;
      f = foot(t, Math.abs(t - a.t) < Math.abs(t - b.t) ? a.uv : b.uv);
      if (!f.x) break;
      const miss = f.x[along] - k;
      if (Math.abs(miss) <= 1e-4 * on[along] || Math.abs(b.t - a.t) <= 1e-14 * Math.abs(t1 - t0)) break;
      // Illinois: the end kept twice running has its miss halved, so the other end moves too.
      if (miss * fa > 0) {
        [a, fa] = [f, miss];
        if (side < 0) fb /= 2;
        side = -1;
      } else {
        [b, fb] = [f, miss];
        if (side > 0) fa /= 2;
        side = 1;
      }
    }
    return f;
  };
  const cuts: Foot[] = [];
  for (let i = 0; i + 1 < feet.length; i++) {
    const xa = feet[i].x,
      xb = feet[i + 1].x;
    if (!xa || !xb) continue;
    for (const along of [0, 1] as const) {
      const lo = Math.min(xa[along], xb[along]),
        hi = Math.max(xa[along], xb[along]);
      for (const k of linesBetween(along ? lines.v : lines.u, lines.periods[along], lo, hi))
        if (Math.max(k - lo, hi - k) > on[along])
          cuts.push(crossing(along, k, feet[i], feet[i + 1], xa[along] - k, xb[along] - k));
    }
  }
  // Ascending from t0; cuts within a billionth of the piece of another or of an end are one.
  const at = (f: Foot) => (f.t - t0) / (t1 - t0),
    parts = [start];
  for (const c of cuts.sort((x, y) => at(x) - at(y)))
    if (at(c) > at(parts[parts.length - 1]) + 1e-9 && at(c) < 1 - 1e-9) parts.push(c);
  parts.push(end);
  /**
   * How far the nodes miss integrating z^k dz exactly, k = 0, 1, 2, z each coordinate about its middle between feet a
   * and b (z^(k+1) / (k + 1) between them, a part of the face's extent to the k + 1): k = 0 is the rates' closure, and
   * the rest whether the nodes follow the coordinate closely enough for an integrand varying along it (along a line
   * where the foot's speed varies fifteenfold in a span, G times the rate). The other coordinate counts in proportion
   * to how far the loop's coordinate changes (along u' constant, G du' is zero however v moves).
   */
  const miss = (ns: EdgeNode[], a: Foot, b: Foot) => {
      let worst = 0;
      for (const along of [axis, 1 - axis]) {
        const c = (a.uv[along] + b.uv[along]) / 2,
          h = (b.uv[along] - a.uv[along]) / 2,
          e = extent[along];
        let m0 = 0,
          m1 = 0,
          m2 = 0;
        for (const n of ns) {
          const z = n.uv[along] - c,
            r = n.w * n.rates[along];
          m0 += r;
          m1 += r * z;
          m2 += r * z * z;
        }
        const off = Math.max(
          Math.abs(m0 - 2 * h) / e,
          Math.abs(m1) / (e * e),
          Math.abs(m2 - (2 * h * h * h) / 3) / e ** 3,
        );
        worst = Math.max(
          worst,
          along === axis ? off : off * Math.min(1, Math.abs(b.uv[axis] - a.uv[axis]) / extent[axis]),
        );
      }
      return worst;
    },
    refine = (a: Foot, b: Foot, ns: EdgeNode[], depth: number): EdgeNode[] => {
      const m0 = miss(ns, a, b);
      if (m0 <= 1e-12 || depth >= 8 || !a.x || !b.x) return ns;
      const m = foot((a.t + b.t) / 2, ns[7].uv),
        left = gauss(a.t, m.t, a.uv),
        right = gauss(m.t, b.t, m.uv);
      // Halving a part the rule resolves cuts its miss several times over; where it does not, the miss is the feet's
      // own (found to about a millionth of a millionth of the surface's size), and the one part is kept.
      if (!(miss(left, a, m) + miss(right, m, b) < m0 / 4)) return ns;
      return [...refine(a, m, left, depth + 1), ...refine(m, b, right, depth + 1)];
    };
  if (parts.length === 2) return { nodes: refine(start, end, nodes, 0), end: end.uv };
  const split: EdgeNode[] = [];
  for (let i = 0; i + 1 < parts.length; i++)
    split.push(...refine(parts[i], parts[i + 1], gauss(parts[i].t, parts[i + 1].t, parts[i].uv), 0));
  return { nodes: split, end: end.uv };
}

/** The diagonal of the box of points along a face's edges (9 per edge). */
function faceSize(face: Face): number {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const loop of face.loops)
    for (const co of loop.coedges) {
      const curve = curveEvaluator(co.edge.curve),
        [t0, t1] = edgeParameters(co.edge, 1);
      for (let i = 0; i <= 8; i++) {
        const p = curve.at(t0 + ((t1 - t0) * i) / 8);
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
      }
    }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
}

/** A point near some faces (the middle of their vertices' box): moments about it keep large coordinates from cancelling. */
function centreOf(faces: readonly Face[]): XYZ {
  const pts: XYZ[] = [];
  for (const f of faces) for (const l of f.loops) for (const co of l.coedges) pts.push(co.start.point);
  if (!pts.length) for (const f of faces) if ('frame' in f.surface) pts.push(f.surface.frame.origin);
  return [0, 1, 2].map((k) =>
    pts.length ? (Math.min(...pts.map((p) => p[k])) + Math.max(...pts.map((p) => p[k]))) / 2 : 0,
  ) as XYZ;
}

/** The volume some faces enclose, signed: positive when they face out of it (a solid's shell), negative for a cavity's. */
export function enclosedVolume(faces: readonly Face[]): number {
  const c = centreOf(faces);
  let volume = 0;
  for (const f of faces) volume += faceIntegrals(f, c)[1];
  return volume;
}

/**
 * Exact mass properties of a body of unit density (multiply volume and inertia by a density for mass): integrated
 * over its faces' surfaces within their edges, with no mesh. Faces of cavity shells face into the cavity, so their
 * contributions subtract.
 */
export function massProperties(body: Body): MassProperties {
  const c = centreOf(body.faces),
    sum = new Float64Array(K);
  for (const f of body.faces) {
    const r = faceIntegrals(f, c);
    for (let k = 0; k < K; k++) sum[k] += r[k];
  }
  const volume = sum[1],
    d: XYZ = volume ? [sum[2] / volume, sum[3] / volume, sum[4] / volume] : [0, 0, 0],
    // Second moments about c, then about the centroid (parallel axes).
    xx = sum[5] - volume * d[0] * d[0],
    yy = sum[6] - volume * d[1] * d[1],
    zz = sum[7] - volume * d[2] * d[2],
    xy = sum[8] - volume * d[0] * d[1],
    yz = sum[9] - volume * d[1] * d[2],
    zx = sum[10] - volume * d[2] * d[0];
  return {
    volume,
    area: sum[0],
    centroid: [c[0] + d[0], c[1] + d[1], c[2] + d[2]],
    inertia: [yy + zz, xx + zz, xx + yy, -xy, -yz, -zx],
  };
}
