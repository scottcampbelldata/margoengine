// Checks a body's topology and geometry: loops that close, edges of a solid used twice in opposite directions, each
// shell one connected piece whose counts Euler-Poincare allows, vertices on their edges' curves and edges on their
// faces' surfaces, each within its own tolerance. Every operation runs it on its result, so an invalid shape is
// reported where it is made, not where it is next used. checkBody (check.ts) adds the costlier geometric checks.
import { distance, type XYZ } from '../geometry/vec.js';
import { curveEvaluator, surfaceEvaluator } from './geometry.js';
import type { Body, Edge, Face, Name, Vertex } from './topology.js';

/** One problem, with the persistent name of the entity it concerns. */
export interface ValidityProblem {
  readonly name: Name;
  readonly problem: string;
}

/** Curve parameters of points along an edge, start to end (a closed edge goes once round). */
export function edgeParameters(edge: Edge, count: number): number[] {
  const c = curveEvaluator(edge.curve),
    t0 = c.parameter(edge.start.point);
  let t1 = edge.closed ? t0 : c.parameter(edge.end.point, t0);
  if (c.period) {
    if (edge.sameSense && t1 <= t0 + 1e-12) t1 += c.period;
    if (!edge.sameSense && t1 >= t0 - 1e-12) t1 -= c.period;
  }
  return Array.from({ length: count + 1 }, (_, k) => t0 + ((t1 - t0) * k) / count);
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
      while (parent.get(f) !== f) f = parent.get(f)!;
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
      tolerance = Math.max(e.tolerance, 1e-9);
    for (const v of [e.start, e.end]) {
      const t = c.parameter(v.point),
        gap = distance(c.at(t).slice(0, 3) as XYZ, v.point);
      if (gap > Math.max(v.tolerance, tolerance))
        report(v.name, `${gap.toExponential(2)} m off the curve of ${e.name}`);
    }
    const ts = edgeParameters(e, 4);
    for (const use of uses) {
      const s = surfaceEvaluator(use.loop.face.surface);
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
