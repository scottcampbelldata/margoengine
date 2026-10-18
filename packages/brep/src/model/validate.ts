// Checks a body's topology and geometry: loops that close, edges of a solid used twice in opposite directions,
// vertices on their edges' curves and edges on their faces' surfaces, each within its own tolerance. Every operation
// runs it on its result, so an invalid shape is reported where it is made, not where it is next used.
import { distance, type V3 } from '../geometry/vec.js';
import { curveEvaluator, surfaceEvaluator } from './geometry.js';
import type { Body, Edge, Name } from './topology.js';

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
        gap = distance(c.at(t).slice(0, 3) as V3, v.point);
      if (gap > Math.max(v.tolerance, tolerance))
        report(v.name, `${gap.toExponential(2)} m off the curve of ${e.name}`);
    }
    const ts = edgeParameters(e, 4);
    for (const use of uses) {
      const s = surfaceEvaluator(use.loop.face.surface);
      let hint: [number, number] | undefined;
      for (const t of ts) {
        const p = c.at(t).slice(0, 3) as V3,
          uv: [number, number] = s.parameters(p, hint),
          gap = distance(s.at(uv[0], uv[1]).slice(0, 3) as V3, p);
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
