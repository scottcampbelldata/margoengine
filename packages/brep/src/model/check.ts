// The full check of a body, beyond validateBody's (which every operation runs on its result): each shell of a solid
// facing out of its material (a cavity's facing into the cavity), no two edges of a face crossing, and no edge passing
// through, or lying inside, a face it does not bound. It integrates each shell's volume and tests every edge against the faces near it, so it costs
// more than validateBody; files read into the modeler and tests run it. Two faces crossing in a closed curve that meets
// no edge of either are not found (an edge of one or the other crosses in every other case).
import { distance, type XYZ } from '../geometry/vec.js';
import { faceBox, overlap } from './boolean.js';
import { curveSurfaceCrossings } from './distance.js';
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
  if (body.kind === 'solid')
    for (const shell of body.shells) {
      if (!shell.faces.length) continue;
      const v = enclosedVolume(shell.faces);
      if (shell.outer ? v > 0 : v < 0)
        report(
          shell.faces[0].name,
          shell.outer
            ? `its cavity's shell faces out of the cavity (it encloses ${v.toExponential(3)} m^3, not less than 0)`
            : `its shell faces into its material (it encloses ${v.toExponential(3)} m^3, not more than 0)`,
        );
    }

  const faces = body.faces,
    uv = new Map(faces.map((f) => [f, new FaceUV(f)])),
    boxes = new Map(faces.map((f) => [f, faceBox(uv.get(f)!, 1e-9)]));
  for (const f of faces) {
    const crossing = loopCrossing(f, uv.get(f)!);
    if (crossing) report(f.name, crossing);
  }
  for (const e of body.edges) {
    const own = new Set(e.coedges.map((c) => c.loop.face)),
      box = edgeBox(e),
      touch = Math.max(1e-6, 10 * e.tolerance, 10 * e.start.tolerance, 10 * e.end.tolerance),
      c = curveEvaluator(e.curve),
      [t0, t1] = edgeParameters(e, 1),
      [lo, hi] = [Math.min(t0, t1), Math.max(t0, t1)];
    for (const f of faces) {
      if (own.has(f) || !overlap(box, boxes.get(f)!)) continue;
      const s = surfaceEvaluator(f.surface),
        gap = (t: number) => {
          const p = c.at(t).slice(0, 3) as XYZ,
            q = s.parameters(p);
          return distance(s.at(q[0], q[1]).slice(0, 3) as XYZ, p);
        },
        inside = (p: XYZ) => uv.get(f)!.contains(p) && boundaryDistance(f, p) > touch;
      // An edge lying in the face's surface crosses nothing there, and must not lie inside the face.
      if (edgeParameters(e, 6).every((t) => gap(t) <= touch)) {
        const mid = c.at(edgeParameters(e, 2)[1]).slice(0, 3) as XYZ;
        if (inside(mid)) report(e.name, `lies inside ${f.name}, which it does not bound`);
        continue;
      }
      for (const t of crossings(e, f, lo, hi)) {
        const p = c.at(t).slice(0, 3) as XYZ;
        if (gap(t) > touch || distance(p, e.start.point) <= touch || distance(p, e.end.point) <= touch) continue;
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
  // On a closed surface, each piece is also met a period to either side.
  const shifts = fuv.period ? [-fuv.period, 0, fuv.period] : [0],
    order = [...pieces.keys()].sort((i, j) => pieces[i].lo - pieces[j].lo);
  for (const shift of shifts)
    for (let x = 0; x < order.length; x++) {
      const p = pieces[order[x]];
      for (let y = shift ? 0 : x + 1; y < order.length; y++) {
        const q = pieces[order[y]];
        if (q.lo + shift > p.hi) break;
        if (q.co.edge === p.co.edge || q.hi + shift < p.lo) continue;
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

/**
 * Curve parameters in [lo, hi] where the edge crosses the face's surface: exactly on the analytic surfaces; on a
 * spline surface, sign changes of the distance along its normal between 64 samples, then bisection.
 */
function crossings(e: Edge, f: Face, lo: number, hi: number): number[] {
  if (f.surface.kind !== 'spline') return curveSurfaceCrossings(e.curve, f.surface, lo, hi);
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
    n = 64;
  let a = lo,
    fa = side(a);
  for (let k = 1; k <= n; k++) {
    const b = lo + ((hi - lo) * k) / n,
      fb = side(b);
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
    a = b;
    fa = fb;
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
