// The full check of a body, beyond validateBody's (which every operation runs on its result): each shell of a solid
// facing out of its material (a cavity's facing into the cavity), no two edges of a face crossing, and no edge passing
// through, or lying inside, a face it does not bound. It integrates each shell's volume and tests every edge against the faces near it, so it costs
// more than validateBody; files read into the modeler and tests run it. Two faces crossing in a closed curve that meets
// no edge of either are not found (an edge of one or the other crosses in every other case).
import { knotVector } from '../geometry/nurbs.js';
import { distance, type XYZ } from '../geometry/vec.js';
import { faceBox, overlap } from './boolean.js';
import { curveSurfaceCrossings, speedBound } from './distance.js';
import { edgeSamples, FaceUV, type UV } from './faces.js';
import { curveEvaluator, surfaceEvaluator } from './geometry.js';
import type { Box3 } from './march.js';
import { enclosedVolume } from './mass.js';
import type { Body, Coedge, Edge, Face } from './topology.js';
import { edgeParameters, validateBody, type ValidityProblem } from './validate.js';

/**
 * Every problem with `body` that validateBody finds and, when it finds none, these too: a solid's shell facing into its
 * material (or a cavity's out of the cavity), two edges of a face crossing, and an edge passing through or lying inside
 * a face it does not bound. Empty when the body is valid.
 */
export function checkBody(body: Body): ValidityProblem[] {
  const problems = validateBody(body);
  // The tests below follow loops and faces, so they need sound topology.
  if (problems.length) return problems;
  const report = (name: string, problem: string) => {
    if (problems.length < 100) problems.push({ name, problem });
  };
  const faces = body.faces,
    uv = new Map(faces.map((f) => [f, new FaceUV(f)])),
    boxes = new Map(faces.map((f) => [f, faceBox(uv.get(f)!, 1e-9)])),
    cells = new Map<Face, Cells | undefined>();
  if (body.kind === 'solid')
    for (const shell of body.shells) {
      if (!shell.faces.length) continue;
      const v = enclosedVolume(shell.faces, uv);
      if (shell.outer ? v > 0 : v < 0)
        report(
          shell.faces[0].name,
          shell.outer
            ? `its cavity's shell faces out of the cavity (it encloses ${v.toExponential(3)} m^3, not less than 0)`
            : `its shell faces into its material (it encloses ${v.toExponential(3)} m^3, not more than 0)`,
        );
    }

  for (const f of faces) {
    const crossing = loopCrossing(f, uv.get(f)!);
    if (crossing) report(f.name, crossing);
  }
  for (const e of body.edges) {
    // How far a point of the edge may be from a face and still touch it: ten times the edge's tolerance along the edge,
    // and ten times a vertex's within that reach of the vertex. A vertex's tolerance is a ball round its point (its
    // edges' curves end somewhere in it), so it widens the test there, never along the whole edge.
    const own = new Set(e.coedges.map((c) => c.loop.face)),
      box = edgeBox(e),
      along = Math.max(1e-6, 10 * e.tolerance),
      ends = [e.start, e.end].map((v) => ({ point: v.point, reach: Math.max(along, 10 * v.tolerance) })),
      atEnd = (p: XYZ) => ends.some((v) => distance(p, v.point) <= v.reach),
      touchAt = (p: XYZ) => ends.reduce((r, v) => (distance(p, v.point) <= v.reach ? Math.max(r, v.reach) : r), along),
      // The most any point of the edge may be off a face it touches: what its pieces' boxes are padded by.
      touch = Math.max(along, ...ends.map((v) => v.reach)),
      c = curveEvaluator(e.curve),
      [t0, t1] = edgeParameters(e, 1),
      [lo, hi] = [Math.min(t0, t1), Math.max(t0, t1)];
    let track: Box3[] | undefined;
    for (const f of faces) {
      const fbox = boxes.get(f)!;
      if (own.has(f) || !overlap(box, fbox)) continue;
      // Every report below is of a point of the edge within `touch` of a point of the face, so in the face's box and,
      // on a spline face, in a box of one of its knot spans' control points: a face no piece of the edge comes near is
      // passed over, and the crossing search samples only the pieces that do.
      track ??= pieceBoxes(e, lo, hi, touch);
      if (!cells.has(f)) cells.set(f, splineCells(uv.get(f)!));
      const tree = cells.get(f),
        near = track.map((b) => !!overlap(b, fbox) && (!tree || hits(tree, b)));
      if (!near.includes(true)) continue;
      const s = surfaceEvaluator(f.surface),
        at = (t: number) => c.at(t).slice(0, 3) as XYZ,
        off = (p: XYZ) => {
          const q = s.parameters(p);
          return distance(s.at(q[0], q[1]).slice(0, 3) as XYZ, p) > touchAt(p);
        },
        inside = (p: XYZ) => uv.get(f)!.contains(p) && boundaryDistance(f, p) > touchAt(p);
      // An edge lying in the face's surface crosses nothing there, and must not lie inside the face.
      if (!edgeParameters(e, 6).some((t) => off(at(t)))) {
        const mid = at(edgeParameters(e, 2)[1]);
        if (inside(mid)) report(e.name, `lies inside ${f.name}, which it does not bound`);
        continue;
      }
      // A crossing within a vertex's reach is the edge meeting a face of its own there.
      for (const t of crossings(e, f, lo, hi, near)) {
        const p = at(t);
        if (off(p) || atEnd(p)) continue;
        if (inside(p)) {
          report(e.name, `passes through ${f.name} at (${p.map((x) => x.toPrecision(6)).join(', ')}) m`);
          break;
        }
      }
    }
  }
  return problems;
}

/**
 * Where two edges of a face cross: its loops as FaceUV samples them in (u', v), each short piece tagged with its
 * coedge; a piece crossing another of a different edge is a candidate, confirmed where the two curves meet in 3D away
 * from their ends (the samples alone cut corners).
 */
function loopCrossing(f: Face, fuv: FaceUV): string | undefined {
  const pieces: { a: UV; b: UV; co: Coedge; lo: number; hi: number }[] = [];
  f.loops.forEach((loop, li) => {
    const { points, wrap } = fuv.loops[li];
    let k = 0;
    for (const co of loop.coedges)
      for (let i = 0; i < edgeSamples(co.edge); i++, k++) {
        const a = points[k],
          b: UV = k + 1 < points.length ? points[k + 1] : [points[0][0] + wrap * fuv.period, points[0][1]];
        pieces.push({ a, b, co, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) });
      }
  });
  // On a closed surface, each piece is also met a period to either side. The pairs are tried in the order a sweep along
  // u' meets them (each shift in turn; by rank in u' of the one piece, then of the other), each pair whose u' ranges
  // meet: found through a grid of cells over (u', v), as two pieces that cross share a cell (pieces lying along v, as
  // a seam's do, all meet in u' and are mostly far apart in v).
  const shifts = fuv.period ? [-fuv.period, 0, fuv.period] : [0],
    order = [...pieces.keys()].sort((i, j) => pieces[i].lo - pieces[j].lo),
    n = order.length,
    rank = new Int32Array(n);
  order.forEach((i, r) => {
    rank[i] = r;
  });
  let u0 = Infinity,
    u1 = -Infinity,
    v0 = Infinity,
    v1 = -Infinity;
  // (A piece with a coordinate not finite crosses nothing: properCrossing's orientations are not numbers.)
  const finite = (p: (typeof pieces)[number]) => [p.a[0], p.a[1], p.b[0], p.b[1]].every(Number.isFinite);
  for (const p of pieces) {
    if (!finite(p)) continue;
    u0 = Math.min(u0, p.lo);
    u1 = Math.max(u1, p.hi);
    v0 = Math.min(v0, p.a[1], p.b[1]);
    v1 = Math.max(v1, p.a[1], p.b[1]);
  }
  if (!n || ![u0, u1, v0, v1].every(Number.isFinite)) return undefined;
  const side = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(n)))),
    du = (u1 - u0) / side,
    dv = (v1 - v0) / side,
    // A margin past each range: a crossing found by rounding just past a range still shares a cell.
    margin = 1e-9 * (u1 - u0 + (v1 - v0)) + 1e-300,
    cell = (x: number, x0: number, d: number) =>
      d > 0 ? Math.max(0, Math.min(side - 1, Math.floor((x - x0) / d))) : 0,
    cells: number[][] = Array.from({ length: side * side }, () => []),
    range = (lo: number, hi: number, vlo: number, vhi: number, visit: (k: number) => void) => {
      if (hi < u0 - margin || lo > u1 + margin) return;
      const i0 = cell(lo - margin, u0, du),
        i1 = cell(hi + margin, u0, du),
        j0 = cell(vlo - margin, v0, dv),
        j1 = cell(vhi + margin, v0, dv);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) visit(i * side + j);
    };
  pieces.forEach((p, k) => {
    if (finite(p))
      range(p.lo, p.hi, Math.min(p.a[1], p.b[1]), Math.max(p.a[1], p.b[1]), (c) => {
        cells[c].push(k);
      });
  });
  const seen = new Int32Array(n).fill(-1);
  let stamp = 0;
  for (const shift of shifts)
    for (let x = 0; x < n; x++, stamp++) {
      const p = pieces[order[x]],
        ys: number[] = [];
      if (!finite(p)) continue;
      range(p.lo - shift, p.hi - shift, Math.min(p.a[1], p.b[1]), Math.max(p.a[1], p.b[1]), (c) => {
        for (const k of cells[c])
          if (seen[k] !== stamp) {
            seen[k] = stamp;
            if (shift || rank[k] > x) ys.push(rank[k]);
          }
      });
      for (const y of ys.sort((a, b) => a - b)) {
        const q = pieces[order[y]];
        if (q.lo + shift > p.hi || q.co.edge === p.co.edge || q.hi + shift < p.lo) continue;
        const qa: UV = [q.a[0] + shift, q.a[1]],
          qb: UV = [q.b[0] + shift, q.b[1]];
        if (!properCrossing(p.a, p.b, qa, qb)) continue;
        const at = meet(p.co.edge, q.co.edge, fuv.at(p.a));
        if (at)
          return `its edges ${p.co.edge.name} and ${q.co.edge.name} cross at (${at.map((v) => v.toPrecision(6)).join(', ')}) m`;
      }
    }
  return undefined;
}

/** Whether two segments cross at a point inside both (not at an end, not along each other). */
function properCrossing(a0: UV, a1: UV, b0: UV, b1: UV): boolean {
  const orient = (p: UV, q: UV, r: UV) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]),
    la = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]),
    lb = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]),
    eps = 1e-9 * la * lb,
    o1 = orient(a0, a1, b0),
    o2 = orient(a0, a1, b1),
    o3 = orient(b0, b1, a0),
    o4 = orient(b0, b1, a1);
  return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
}

/**
 * Where two edges meet near `p`, away from their ends: closest points found by projecting back and forth from p
 * (they converge on a crossing), within both edges' spans and within their tolerance of each other.
 */
function meet(e: Edge, g: Edge, p: XYZ): XYZ | undefined {
  const ce = curveEvaluator(e.curve),
    cg = curveEvaluator(g.curve),
    touch = Math.max(1e-6, 10 * e.tolerance, 10 * g.tolerance),
    within = (edge: Edge, t: number, period: number) => {
      const [t0, t1] = edgeParameters(edge, 1),
        lo = Math.min(t0, t1),
        hi = Math.max(t0, t1);
      if (period) t = lo + ((((t - lo) % period) + period) % period);
      return t >= lo && t <= hi;
    };
  let te = ce.parameter(p),
    tg = cg.parameter(p),
    pe = ce.at(te).slice(0, 3) as XYZ,
    pg = cg.at(tg).slice(0, 3) as XYZ;
  for (let i = 0; i < 50 && distance(pe, pg) > 1e-12; i++) {
    tg = cg.parameter(pe, tg);
    pg = cg.at(tg).slice(0, 3) as XYZ;
    te = ce.parameter(pg, te);
    pe = ce.at(te).slice(0, 3) as XYZ;
  }
  if (distance(pe, pg) > touch || !within(e, te, ce.period) || !within(g, tg, cg.period)) return undefined;
  for (const v of [e.start, e.end, g.start, g.end]) if (distance(v.point, pe) <= touch) return undefined;
  return pe;
}

/** A box round an edge: its samples, padded for the bulge between them. */
function edgeBox(e: Edge): Box3 {
  const c = curveEvaluator(e.curve),
    min: XYZ = [Infinity, Infinity, Infinity],
    max: XYZ = [-Infinity, -Infinity, -Infinity];
  for (const t of edgeParameters(e, e.curve.kind === 'line' ? 1 : 64)) {
    const p = c.at(t);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  const pad = 0.02 * distance(min, max) + 1e-6;
  return { min: [min[0] - pad, min[1] - pad, min[2] - pad], max: [max[0] + pad, max[1] + pad, max[2] + pad] };
}

/** A tree of boxes over a spline face's knot spans: each leaf the box of one span's control points. */
interface Cells {
  box: Box3;
  kids?: [Cells, Cells];
}

/**
 * The knot spans of a spline face's surface that its loops' (u, v) range meets (every span along a closed direction or
 * one with a pole), each as the box of its control points: a span's patch lies in their convex hull (its weights all
 * positive), so every point of the face lies in one of these boxes. Undefined for other surfaces, where a weight is
 * not positive, and where u and v are swapped (FaceUV.swapped).
 */
function splineCells(fuv: FaceUV): Cells | undefined {
  const def = fuv.face.surface,
    s = fuv.surface;
  if (def.kind !== 'spline' || fuv.swapped || def.weights?.some((w) => !(w > 0))) return undefined;
  const [p, q] = def.degrees,
    [nu, nv] = def.counts,
    U = knotVector(def.knots[0], def.multiplicities[0]),
    V = knotVector(def.knots[1], def.multiplicities[1]);
  let [u0, u1, v0, v1] = fuv.box;
  if (fuv.flip) [u0, u1] = [-u1, -u0];
  const uAll = s.uPeriod > 0 || s.uPole?.(1) !== undefined || s.uPole?.(-1) !== undefined || !(u0 <= u1),
    vAll = s.vPeriod > 0 || s.pole(1) !== undefined || s.pole(-1) !== undefined || !(v0 <= v1),
    spans = (K: readonly number[], degree: number, n: number, all: boolean, lo: number, hi: number) => {
      const out: number[] = [];
      for (let i = degree; i < n; i++) if (K[i] < K[i + 1] && (all || (K[i + 1] >= lo && K[i] <= hi))) out.push(i);
      // A range wholly past the domain (the evaluator holds a parameter at the domain's end): the end's span.
      if (!out.length) out.push(lo > K[n] ? n - 1 : degree);
      return out;
    },
    us = spans(U, p, nu, uAll, u0, u1),
    vs = spans(V, q, nv, vAll, v0, v1);
  const leaf = (i: number, j: number): Cells => {
    const min: XYZ = [Infinity, Infinity, Infinity],
      max: XYZ = [-Infinity, -Infinity, -Infinity];
    for (let a = i - p; a <= i; a++)
      for (let b = j - q; b <= j; b++) {
        const c = def.points[b * nu + a];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], c[k]);
          max[k] = Math.max(max[k], c[k]);
        }
      }
    return { box: { min, max } };
  };
  // Halving the longer run of spans at each level.
  const build = (a0: number, a1: number, b0: number, b1: number): Cells => {
    if (a1 - a0 === 1 && b1 - b0 === 1) return leaf(us[a0], vs[b0]);
    const am = (a0 + a1) >> 1,
      bm = (b0 + b1) >> 1,
      kids: [Cells, Cells] =
        a1 - a0 >= b1 - b0
          ? [build(a0, am, b0, b1), build(am, a1, b0, b1)]
          : [build(a0, a1, b0, bm), build(a0, a1, bm, b1)],
      [x, y] = [kids[0].box, kids[1].box],
      min: XYZ = [Math.min(x.min[0], y.min[0]), Math.min(x.min[1], y.min[1]), Math.min(x.min[2], y.min[2])],
      max: XYZ = [Math.max(x.max[0], y.max[0]), Math.max(x.max[1], y.max[1]), Math.max(x.max[2], y.max[2])];
    return { box: { min, max }, kids };
  };
  return build(0, us.length, 0, vs.length);
}

/** Whether a box meets a leaf of the tree. */
function hits(c: Cells, b: Box3): boolean {
  if (!overlap(c.box, b)) return false;
  return !c.kids || hits(c.kids[0], b) || hits(c.kids[1], b);
}

/** Pieces the crossing search splits an edge's span into (`crossings`, `pieceBoxes`). */
const PIECES = 64;

/**
 * A box round each of the PIECES equal pieces of an edge's span [lo, hi]: its ends and three points between, padded by
 * the longest step between those points (a piece's curve lies within half its own length of one of them, and a
 * piece a 256th of the edge long bends little) and by `touch`. A line's piece is its segment, padded by `touch` alone.
 */
function pieceBoxes(e: Edge, lo: number, hi: number, touch: number): Box3[] {
  const c = curveEvaluator(e.curve),
    sub = e.curve.kind === 'line' ? 1 : 4,
    at = (k: number) => c.at(lo + ((hi - lo) * k) / (PIECES * sub)),
    out: Box3[] = [];
  let prev = at(0);
  for (let k = 0; k < PIECES; k++) {
    const min: XYZ = [prev[0], prev[1], prev[2]],
      max: XYZ = [prev[0], prev[1], prev[2]];
    let step = 0;
    for (let j = 1; j <= sub; j++) {
      const p = at(k * sub + j);
      step = Math.max(step, distance(p, prev));
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], p[i]);
        max[i] = Math.max(max[i], p[i]);
      }
      prev = p;
    }
    const pad = (sub > 1 ? step : 0) + touch;
    out.push({ min: [min[0] - pad, min[1] - pad, min[2] - pad], max: [max[0] + pad, max[1] + pad, max[2] + pad] });
  }
  return out;
}

/**
 * Curve parameters in [lo, hi] where the edge crosses the face's surface, on the pieces `near` marks (those whose box
 * meets the face's; past the others the edge meets no point of the face): exactly on the analytic surfaces; on a
 * spline surface, sign changes of the distance along its normal between PIECES + 1 samples, then bisection.
 */
function crossings(e: Edge, f: Face, lo: number, hi: number, near: readonly boolean[]): number[] {
  const n = PIECES,
    ts = Array.from({ length: n + 1 }, (_, k) => (k ? lo + ((hi - lo) * k) / n : lo));
  if (f.surface.kind !== 'spline') {
    // Over each run of near pieces, to the resolution the whole span would take (a billionth of its length).
    if (near.every(Boolean)) return curveSurfaceCrossings(e.curve, f.surface, lo, hi);
    const out: number[] = [],
      resolution = 1e-9 * speedBound(e.curve) * (hi - lo);
    for (let k = 0; k < n; k++) {
      if (!near[k]) continue;
      let end = k + 1;
      while (end < n && near[end]) end++;
      out.push(...curveSurfaceCrossings(e.curve, f.surface, ts[k], ts[end], resolution));
      k = end;
    }
    return out;
  }
  const c = curveEvaluator(e.curve),
    s = surfaceEvaluator(f.surface);
  let hint: [number, number] | undefined;
  const side = (t: number) => {
    const p = c.at(t),
      q = s.parameters(p, hint),
      d = s.at(q[0], q[1]);
    hint = q;
    const n = [d[4] * d[8] - d[5] * d[7], d[5] * d[6] - d[3] * d[8], d[3] * d[7] - d[4] * d[6]];
    return (p[0] - d[0]) * n[0] + (p[1] - d[1]) * n[1] + (p[2] - d[2]) * n[2];
  };
  const out: number[] = [],
    values = new Float64Array(n + 1).fill(Number.NaN),
    value = (k: number) => (Number.isNaN(values[k]) ? (values[k] = side(ts[k])) : values[k]);
  for (let k = 1; k <= n; k++) {
    if (!near[k - 1]) continue;
    const a = ts[k - 1],
      fa = value(k - 1),
      b = ts[k],
      fb = value(k);
    if (fa < 0 !== fb < 0) {
      let x = a,
        y = b,
        fx = fa;
      for (let i = 0; i < 60 && y - x > 1e-15 * (hi - lo); i++) {
        const m = (x + y) / 2,
          fm = side(m);
        if (fx < 0 === fm < 0) [x, fx] = [m, fm];
        else y = m;
      }
      out.push((x + y) / 2);
    }
  }
  return out;
}

/** Distance from a point to the nearest edge bounding a face. */
function boundaryDistance(f: Face, p: XYZ): number {
  let best = Infinity;
  for (const l of f.loops)
    for (const co of l.coedges) {
      const e = co.edge,
        c = curveEvaluator(e.curve),
        [t0, t1] = edgeParameters(e, 1),
        lo = Math.min(t0, t1),
        hi = Math.max(t0, t1);
      let t = c.parameter(p);
      if (c.period) t = lo + ((((t - lo) % c.period) + c.period) % c.period);
      best = Math.min(
        best,
        t >= lo && t <= hi ? distance(c.at(t).slice(0, 3) as XYZ, p) : Infinity,
        distance(e.start.point, p),
        distance(e.end.point, p),
      );
    }
  return best;
}
