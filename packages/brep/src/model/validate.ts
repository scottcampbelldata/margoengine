// Checks a body's topology and geometry: loops that close, edges of a solid used twice in opposite directions, each
// shell one connected piece whose counts Euler-Poincare allows, vertices on their edges' curves and edges on their
// faces' surfaces, each within its own tolerance. Every operation runs it on its result, so an invalid shape is
// reported where it is made, not where it is next used. checkBody (check.ts) adds the costlier geometric checks.
import { cross, distance, dot, length, sub, type XYZ } from '../geometry/vec.js';
import { curveEvaluator, surfaceEvaluator, type CurveDef, type SurfaceDef } from './geometry.js';
import type { Body, Edge, Face, Name, Vertex } from './topology.js';

/** One problem, with the persistent name of the entity it concerns. */
export interface ValidityProblem {
  readonly name: Name;
  readonly problem: string;
}

/**
 * What is known about an edge while its curve, ends and sense stay the same: its parameter range; how far its vertices
 * lie from its curve, once asked; and the surfaces it was measured to lie on within its tolerance (measureTolerances).
 */
interface EdgeRecord {
  readonly curve: Edge['curve'];
  readonly start: XYZ;
  readonly end: XYZ;
  readonly sense: boolean;
  readonly t0: number;
  readonly t1: number;
  /** The start's parameter as projected, before a closed edge takes its curve's whole domain. */
  readonly a: number;
  offsets?: [number, number];
  measured?: { readonly tolerance: number; readonly surfaces: readonly SurfaceDef[] };
}
const records = new WeakMap<Edge, EdgeRecord>();

function recordOf(edge: Edge): EdgeRecord {
  // Projecting the ends is costly on a spline (the end from the start's parameter is a far guess), and every pass over
  // a face asks again: kept per edge while its curve, ends and sense stay the same.
  let r = records.get(edge);
  if (
    !r ||
    r.curve !== edge.curve ||
    r.start !== edge.start.point ||
    r.end !== edge.end.point ||
    r.sense !== edge.sameSense
  ) {
    const c = curveEvaluator(edge.curve),
      a = c.parameter(edge.start.point);
    let t0 = a,
      t1 = edge.closed ? t0 : c.parameter(edge.end.point, t0);
    // A closed edge on a curve that does not repeat (a loop cut from a curve that crosses itself) is all of it.
    if (edge.closed && !c.period && Number.isFinite(c.domain[0]) && Number.isFinite(c.domain[1]))
      [t0, t1] = edge.sameSense ? [c.domain[0], c.domain[1]] : [c.domain[1], c.domain[0]];
    if (c.period) {
      if (edge.sameSense && t1 <= t0 + 1e-12) t1 += c.period;
      if (!edge.sameSense && t1 >= t0 - 1e-12) t1 -= c.period;
    }
    r = { curve: edge.curve, start: edge.start.point, end: edge.end.point, sense: edge.sameSense, t0, t1, a };
    records.set(edge, r);
  }
  return r;
}

/** Curve parameters of points along an edge, start to end (a closed edge goes once round). */
export function edgeParameters(edge: Edge, count: number): number[] {
  const { t0, t1 } = recordOf(edge);
  return Array.from({ length: count + 1 }, (_, k) => t0 + ((t1 - t0) * k) / count);
}

/** How far an edge's start and end vertices lie from its curve (each projected onto it), found once. */
function vertexOffsets(edge: Edge): [number, number] {
  const r = recordOf(edge);
  if (!r.offsets) {
    const c = curveEvaluator(edge.curve),
      start = distance(c.at(r.a), edge.start.point);
    r.offsets = [start, edge.closed ? start : distance(c.at(c.parameter(edge.end.point)), edge.end.point)];
  }
  return r.offsets;
}

/** v less its part along the unit vector z. */
const across = (v: readonly number[], z: readonly number[]): XYZ => {
  const k = dot(v, z);
  return [v[0] - k * z[0], v[1] - k * z[1], v[2] - k * z[2]];
};

/**
 * An upper bound on the distance from a line or circle edge (its curve from t0 to t1) to a plane, cylinder, cone or
 * sphere, as their projections measure it (along the normal; radially for a cone); Infinity for other pairs. Where it
 * is well inside an edge's tolerance, the edge is not sampled.
 */
function gapBound(curve: CurveDef, surface: SurfaceDef, t0: number, t1: number): number {
  if (surface.kind === 'spline' || surface.kind === 'torus') return Infinity;
  const { origin: o, z } = surface.frame;
  if (curve.kind === 'line') {
    const d = curve.direction,
      p0: XYZ = [curve.origin[0] + t0 * d[0], curve.origin[1] + t0 * d[1], curve.origin[2] + t0 * d[2]],
      p1: XYZ = [curve.origin[0] + t1 * d[0], curve.origin[1] + t1 * d[1], curve.origin[2] + t1 * d[2]];
    // The distance to a plane is linear along the line: largest at an end.
    if (surface.kind === 'plane') return Math.max(Math.abs(dot(sub(p0, o), z)), Math.abs(dot(sub(p1, o), z)));
    // The distance from the axis changes by at most the line's length across it.
    if (surface.kind === 'cylinder')
      return Math.abs(length(across(sub(p0, o), z)) - surface.radius) + length(across(d, z)) * Math.abs(t1 - t0);
    return Infinity;
  }
  if (curve.kind !== 'circle') return Infinity;
  // The circle: centre c, radius r, round its frame's z (m); its points c + r q, q a unit vector square to m.
  const { origin: c, x, y, z: m } = curve.frame,
    r = curve.radius,
    a = sub(c, o);
  if (surface.kind === 'plane') return Math.abs(dot(a, z)) + r * Math.sqrt(dot(x, z) ** 2 + dot(y, z) ** 2);
  if (surface.kind === 'sphere') {
    // |c + r q - o|^2 = |a|^2 + r^2 + 2 r q.a, and |q.a| is at most a's part square to m.
    const aa = dot(a, a) + r * r,
      lean = 2 * r * length(across(a, m)),
      far = Math.sqrt(aa + lean),
      near = Math.sqrt(Math.max(0, aa - lean));
    return Math.max(far - surface.radius, surface.radius - near);
  }
  // Cylinder or cone: the distance from the axis lies within r |q across z| -+ |a across z|, where |q.z| is at most
  // s = |m x z|; the height a.z + r q.z lies within s r of a.z, so the cone's radius there within s r |tan| of its
  // radius at a.z.
  const s = length(cross(m, z)),
    off = length(across(a, z)),
    farthest = r + off,
    nearest = r * Math.sqrt(Math.max(0, 1 - s * s)) - off,
    tan = surface.kind === 'cone' ? Math.tan(surface.angle) : 0,
    rho = surface.radius + dot(a, z) * tan,
    swing = s * r * Math.abs(tan);
  return Math.max(farthest - (rho - swing), rho + swing - nearest);
}

/**
 * Raises edge and vertex tolerances to the gaps a file's geometry has (a writer's spline fits leave edges a micrometre
 * off their faces, more than the accuracy it declares), half again for margin, where the gap is at most `cap` metres:
 * the tolerant edges a kernel keeps for an imported part. Larger gaps stay for validateBody to report.
 */
export function measureTolerances(body: Body, cap: number): void {
  // Where each surface's projections landed at each vertex: an edge's first projection starts there, not from a search
  // of the whole surface.
  const feet = new Map<SurfaceDef, Map<Vertex, [number, number]>>();
  for (const e of body.edges) {
    const c = curveEvaluator(e.curve),
      ts = edgeParameters(e, 16),
      surfaces: SurfaceDef[] = [];
    let points: XYZ[] | undefined,
      gap = 0;
    for (const co of e.coedges) {
      const def = co.loop.face.surface;
      surfaces.push(def);
      // A line or circle bounded well inside its tolerance of an analytic surface needs no samples (none could raise it).
      if (gapBound(e.curve, def, ts[0], ts[16]) <= e.tolerance / 2) continue;
      const s = surfaceEvaluator(def);
      let at = feet.get(def);
      if (!at) feet.set(def, (at = new Map()));
      points ??= ts.map((t) => c.at(t).slice(0, 3) as XYZ);
      let hint = at.get(e.start),
        prev: [number, number] | undefined;
      for (const p of points) {
        // On a spline, each projection starts a step on from the last two (not across a seam), so Newton has less to do.
        const du = hint && prev ? hint[0] - prev[0] : 0,
          dv = hint && prev ? hint[1] - prev[1] : 0,
          from: [number, number] | undefined =
            hint && def.kind === 'spline'
              ? [
                  hint[0] + (s.uPeriod && Math.abs(du) > s.uPeriod / 2 ? 0 : du),
                  hint[1] + (s.vPeriod && Math.abs(dv) > s.vPeriod / 2 ? 0 : dv),
                ]
              : hint;
        prev = hint;
        hint = s.parameters(p, from);
        if (p === points[0]) at.set(e.start, hint);
        gap = Math.max(gap, distance(s.at(hint[0], hint[1]), p));
      }
      if (hint) at.set(e.end, hint);
    }
    if (gap > e.tolerance && gap <= cap) e.tolerance = 1.5 * gap;
    if (gap <= e.tolerance) recordOf(e).measured = { tolerance: e.tolerance, surfaces };
    const offsets = vertexOffsets(e);
    [e.start, e.end].forEach((v, k) => {
      if (offsets[k] > Math.max(v.tolerance, e.tolerance) && offsets[k] <= cap) v.tolerance = 1.5 * offsets[k];
    });
  }
}

/** Problems with `body`, empty when it is valid. */
export function validateBody(body: Body): ValidityProblem[] {
  const problems: ValidityProblem[] = [],
    report = (name: Name, problem: string) => {
      if (problems.length < 100) problems.push({ name, problem });
    };
  for (const face of body.faces)
    for (const loop of face.loops) {
      const cs = loop.coedges;
      for (let k = 0; k < cs.length; k++) {
        const next = cs[(k + 1) % cs.length];
        if (cs[k].end !== next.start)
          report(
            face.name,
            `loop breaks after ${cs[k].edge.name}: it ends at ${cs[k].end.name}, the next starts at ${next.start.name}`,
          );
        if (cs[k].loop !== loop) report(cs[k].edge.name, 'a coedge does not belong to the loop that lists it');
      }
    }
  // Each shell: one piece (its faces joined through shared edges) and, when closed, counts a closed surface can have.
  // Euler-Poincare with faces of any number of loops: V - E + 2F - L = 2 - 2G for a closed shell of genus G (a face
  // that is a whole sphere or torus, with no loops, counts as 2), so even and at most 2.
  for (const shell of body.shells) {
    if (!shell.faces.length) continue;
    const vertices = new Set<Vertex>(),
      uses = new Map<Edge, number>(),
      first = new Map<Edge, Face>(),
      parent = new Map<Face, Face>(shell.faces.map((f) => [f, f]));
    const root = (f: Face): Face => {
      // Each step skips a level (path halving), so long chains of joined faces stay short.
      while (parent.get(f) !== f) {
        const up = parent.get(parent.get(f)!)!;
        parent.set(f, up);
        f = up;
      }
      return f;
    };
    let loops = 0;
    for (const f of shell.faces)
      for (const l of f.loops) {
        loops++;
        for (const c of l.coedges) {
          vertices.add(c.start).add(c.end);
          uses.set(c.edge, (uses.get(c.edge) ?? 0) + 1);
          const other = first.get(c.edge);
          if (other) parent.set(root(other), root(f));
          else first.set(c.edge, f);
        }
      }
    const name = shell.faces[0].name,
      pieces = new Set(shell.faces.map(root)).size;
    if (pieces > 1) report(name, `its shell is ${pieces} pieces that share no edge`);
    else if ([...uses.values()].every((n) => n === 2)) {
      const chi = vertices.size - uses.size + 2 * shell.faces.length - loops;
      if (chi % 2 !== 0 || chi > 2)
        report(name, `its shell has V - E + 2F - L = ${chi}; a closed surface has 2 - 2 x genus (Euler-Poincare)`);
    }
  }
  const edges = body.edges,
    faces = new Set(body.faces);
  for (const e of edges) {
    const uses = e.coedges.filter((c) => faces.has(c.loop.face));
    if (body.kind === 'solid') {
      if (uses.length !== 2) report(e.name, `used by ${uses.length} face loops; an edge of a solid has 2`);
      else if (uses[0].forward === uses[1].forward)
        report(e.name, 'both uses run the same way; faces disagree on orientation');
    }
    const c = curveEvaluator(e.curve),
      tolerance = Math.max(e.tolerance, 1e-9),
      offsets = vertexOffsets(e);
    [e.start, e.end].forEach((v, k) => {
      if (offsets[k] > Math.max(v.tolerance, tolerance))
        report(v.name, `${offsets[k].toExponential(2)} m off the curve of ${e.name}`);
    });
    const ts = edgeParameters(e, 4),
      { measured } = recordOf(e);
    for (const use of uses) {
      // Measured within this tolerance (at these points and more between), or bounded well inside it: no samples.
      const def = use.loop.face.surface;
      if (measured?.tolerance === e.tolerance && measured.surfaces.includes(def)) continue;
      if (gapBound(e.curve, def, ts[0], ts[4]) <= tolerance / 2) continue;
      const s = surfaceEvaluator(def);
      let hint: [number, number] | undefined;
      for (const t of ts) {
        const p = c.at(t).slice(0, 3) as XYZ,
          uv: [number, number] = s.parameters(p, hint),
          gap = distance(s.at(uv[0], uv[1]).slice(0, 3) as XYZ, p);
        hint = uv;
        if (gap > tolerance) {
          report(e.name, `${gap.toExponential(2)} m off the surface of ${use.loop.face.name}`);
          break;
        }
      }
    }
  }
  return problems;
}
