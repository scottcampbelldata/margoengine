// Faces on closed surfaces as STEP readers expect them (OpenCascade's mesher among them): a face that goes round its
// surface (a band round a cylinder, a cap over a sphere's pole, a sphere or torus with holes in it) is cut open along
// the surface's seam, where its parameter wraps, by seam edges the face uses twice, once each way; on a sphere the
// seam runs on to a vertex on each pole the face covers (the degenerate pole edge, which STEP leaves out). The
// modeler's faces need no seam (they are traced in 3D), so this is done as they are written: the surface's frame is
// turned about its axis so the seam meets the face's loops at a vertex or misses them, and an edge it crosses between
// vertices is written as two pieces, for both of its faces. A cap on a sphere smaller than a hemisphere is written
// instead with the sphere's axis turned across it, so it covers no pole and needs no seam. Faces that already have a
// seam (a cylinder made by extrusion), patches that do not go round, planes and splines are written as they are.
// Edges are also split where they run across the start of a closed B-spline (a traced intersection loop): STEP writes
// the spline as an open one from that point round to it, and an edge cannot run across it.
import type { Surface } from '../geometry/surfaces.js';
import { add, dot, scale, sub, type XYZ } from '../geometry/vec.js';
import { curveEvaluator, frameOf, surfaceEvaluator, type CurveDef, type Frame, type SurfaceDef } from './geometry.js';
import { gaps } from './faces.js';
import { Vertex, type Edge, type Face, type Name } from './topology.js';
import { edgeParameters } from './validate.js';

/** An edge as written: a modeler edge, a piece of one between the points a seam splits it at, or a seam. */
export interface WrittenEdge {
  readonly name: Name;
  readonly curve: CurveDef;
  readonly start: Vertex;
  readonly end: Vertex;
  readonly sameSense: boolean;
}

/** One use of a written edge by a face loop, along it or against it. */
export interface WrittenUse {
  readonly edge: WrittenEdge;
  readonly forward: boolean;
}

/** How faces are written: each one's surface (its frame turned to put the seam where the face is cut) and loops. */
export interface WrittenFaces {
  surface(face: Face): SurfaceDef;
  loops(face: Face): WrittenUse[][];
}

const TAU = 2 * Math.PI;

type UV = [number, number];

/** A coedge run between fractions `f0` and `f1` of its edge (0 at the edge's start vertex, 1 at its end). */
interface Run {
  readonly edge: Edge;
  readonly forward: boolean;
  readonly f0: number;
  readonly f1: number;
}

type Step = Run | WrittenUse;

/** The whole of a coedge as a run. */
const whole = (c: { edge: Edge; forward: boolean }): Run => ({
  edge: c.edge,
  forward: c.forward,
  f0: c.forward ? 0 : 1,
  f1: c.forward ? 1 : 0,
});

/** A point of an edge where the face's loop crosses a seam: at a vertex or splitting the edge. */
interface Crossing {
  /** The coedge it is on, by index in its loop, and the fraction of its edge. */
  readonly at: number;
  readonly f: number;
  readonly vertex: Vertex;
  /** Which seam: across u (0) or across v (1, a torus's outer equator). */
  readonly seam: 0 | 1;
  /** +1 when the loop crosses towards increasing u' (seam 0) or v (seam 1). */
  readonly dir: 1 | -1;
  /** Where on the seam: v for seam 0, u' for seam 1 (in the cut face's cell where the seam is closed). */
  readonly pos: number;
}

/** A point of the face cut open, on one side of the cut (one seam point is two nodes, one on each side). */
interface Node {
  readonly vertex: Vertex;
  out?: Segment;
  in?: Segment;
}

/** A directed piece of a cut face's boundary: a run of the face's loop, or a seam use (none at a pole). */
interface Segment {
  readonly from: Node;
  readonly to: Node;
  readonly steps: Step[];
}

/** A loop of the face in the surface's (u', v): samples per coedge, with their curve parameters. */
interface LiftedLoop {
  readonly coedges: { t: number[]; uv: UV[] }[];
  readonly wrap: UV;
  readonly area: number;
}

/** The fraction along an edge (0 at its start vertex, 1 at its end) of curve parameter t. */
function fraction(edge: Edge, t: number): number {
  const [t0, t1] = edgeParameters(edge, 1);
  return t1 === t0 ? 0 : (t - t0) / (t1 - t0);
}

/** Samples per edge, enough not to step over two seam crossings at once. */
const sampleCount = (e: Edge) =>
  e.curve.kind === 'line' ? 1 : e.curve.kind === 'spline' ? Math.max(128, 4 * e.curve.knots[0].length) : 128;

/** The frame turned by `angle` about its z axis. */
const turned = (f: Frame, angle: number): Frame =>
  frameOf(f.origin, f.z, add(scale(f.x, Math.cos(angle)), scale(f.y, Math.sin(angle))));

/** Faces as written: those that need it cut open, and edges split where seams and spline starts cross them. */
export function writtenFaces(faces: readonly Face[]): WrittenFaces {
  const splits = new Map<Edge, { f: number; vertex: Vertex }[]>(),
    cuts = new Map<Face, { surface: SurfaceDef; loops: Step[][] }>(),
    split = (edge: Edge, f: number, vertex: Vertex) => {
      const list = splits.get(edge) ?? [];
      if (!list.some((x) => x.vertex === vertex)) list.push({ f, vertex });
      splits.set(edge, list);
    };
  // Edges running across the start of a closed B-spline, split there (see above).
  for (const edge of new Set(faces.flatMap((f) => f.loops.flatMap((l) => l.coedges.map((c) => c.edge))))) {
    const c = curveEvaluator(edge.curve);
    if (edge.curve.kind !== 'spline' || !c.period) continue;
    const [t0, t1] = edgeParameters(edge, 1),
      start = c.domain[0];
    for (let k = Math.ceil((Math.min(t0, t1) - start) / c.period); start + k * c.period < Math.max(t0, t1); k++) {
      const t = start + k * c.period,
        f = (t - t0) / (t1 - t0);
      if (f > 1e-9 && f < 1 - 1e-9)
        split(edge, f, new Vertex(`${edge.name}/vertex:spline-start`, c.at(t).slice(0, 3) as XYZ));
    }
  }
  for (const face of faces) {
    const cut = cutOpen(face, splits);
    if (!cut) continue;
    cuts.set(face, cut);
    for (const s of cut.splits) split(s.edge, s.f, s.vertex);
  }
  // Each edge as the pieces between its split points, in order from its start.
  const pieces = new Map<Edge, { f0: number; f1: number; edge: WrittenEdge }[]>();
  const piecesOf = (e: Edge) => {
    let list = pieces.get(e);
    if (list) return list;
    const points = [
      { f: 0, vertex: e.start },
      ...(splits.get(e) ?? []).sort((a, b) => a.f - b.f),
      { f: 1, vertex: e.end },
    ];
    list = points.slice(1).map((p, k) => ({
      f0: points[k].f,
      f1: p.f,
      edge: { name: e.name, curve: e.curve, start: points[k].vertex, end: p.vertex, sameSense: e.sameSense },
    }));
    pieces.set(e, list);
    return list;
  };
  const uses = (s: Step): WrittenUse[] => {
    if (!('f0' in s)) return [s];
    const lo = Math.min(s.f0, s.f1),
      hi = Math.max(s.f0, s.f1),
      inside = piecesOf(s.edge).filter((p) => p.f0 >= lo - 1e-12 && p.f1 <= hi + 1e-12);
    return s.forward
      ? inside.map((p) => ({ edge: p.edge, forward: true }))
      : inside.reverse().map((p) => ({ edge: p.edge, forward: false }));
  };
  return {
    surface: (face) => cuts.get(face)?.surface ?? face.surface,
    loops: (face) =>
      (cuts.get(face)?.loops ?? face.loops.map((l) => l.coedges.map(whole)))
        .map((l) => l.flatMap(uses))
        .filter((l) => l.length),
  };
}

/** The face's loops in (u', v) of surface `s` (u' = -u when the face faces against the surface): undefined when a loop passes a pole. */
function lift(face: Face, s: Surface): LiftedLoop[] | undefined {
  const flip = !face.sense,
    out: LiftedLoop[] = [];
  for (const loop of face.loops) {
    const coedges: { t: number[]; uv: UV[] }[] = [];
    let hint: UV | undefined, first: UV | undefined;
    let area = 0;
    for (const c of loop.coedges) {
      const t = edgeParameters(c.edge, sampleCount(c.edge));
      if (!c.forward) t.reverse();
      const curve = curveEvaluator(c.edge.curve),
        uv: UV[] = [];
      for (const ti of t) {
        const p = curve.at(ti),
          raw = s.parameters(p, hint && [flip ? -hint[0] : hint[0], hint[1]]);
        if (s.singular(raw[0], raw[1])) return undefined;
        let u = flip ? -raw[0] : raw[0],
          v = raw[1];
        if (hint) {
          u += Math.round((hint[0] - u) / TAU) * TAU;
          if (s.vPeriod) v += Math.round((hint[1] - v) / TAU) * TAU;
          area += hint[0] * v - u * hint[1];
        }
        uv.push((hint = [u, v]));
        first ??= hint;
      }
      coedges.push({ t, uv });
    }
    if (!first || !hint) continue;
    const wrap: UV = [Math.round((hint[0] - first[0]) / TAU), s.vPeriod ? Math.round((hint[1] - first[1]) / TAU) : 0];
    // Closing the polygon back to its start point one wrap on adds nothing for a loop that does not wrap.
    out.push({ coedges, wrap, area: area / 2 });
  }
  return out;
}

/**
 * Face `face` cut open along its surface's seam, or undefined when it needs no cut (or cannot be cut cleanly, when
 * it is written as it is). `splits` holds the points already splitting edges, which a crossing reuses.
 */
function cutOpen(
  face: Face,
  splits: ReadonlyMap<Edge, readonly { f: number; vertex: Vertex }[]>,
): { surface: SurfaceDef; loops: Step[][]; splits: { edge: Edge; f: number; vertex: Vertex }[] } | undefined {
  const def = face.surface;
  if (def.kind !== 'cylinder' && def.kind !== 'cone' && def.kind !== 'sphere' && def.kind !== 'torus') return undefined;
  // A face using an edge twice already has its seam.
  for (const l of face.loops)
    for (const c of l.coedges) if (c.edge.coedges.some((o) => o !== c && o.loop.face === face)) return undefined;
  const s = surfaceEvaluator(def),
    loops = lift(face, s);
  if (!loops) return undefined;
  const torus = def.kind === 'torus',
    wraps = loops.some((l) => l.wrap[0] || l.wrap[1]),
    // All holes and nothing round them: the face covers the whole surface but the holes.
    everywhere = !loops.length || (!wraps && !loops.some((l) => l.area > 0)),
    needU = everywhere || loops.some((l) => l.wrap[0]),
    needV = torus && (everywhere || loops.some((l) => l.wrap[1]));
  if (!needU && !needV) return undefined;
  const flip = !face.sense,
    sign = flip ? -1 : 1,
    frame = def.frame,
    uRanges = (ls: readonly LiftedLoop[]) =>
      ls.map((l) => {
        let lo = Infinity,
          hi = -Infinity;
        for (const c of l.coedges)
          for (const [u] of c.uv) {
            lo = Math.min(lo, sign * u);
            hi = Math.max(hi, sign * u);
          }
        return [lo, hi] as [number, number];
      });
  // A cap over a sphere's pole smaller than a hemisphere needs no seam with the sphere's axis turned across it: then
  // it is a patch clear of both poles, written with the seam clear of it too.
  if (def.kind === 'sphere' && !everywhere)
    for (const axis of [frame.x, frame.y]) {
      const across = frameOf(frame.origin, axis, frame.z),
        patch = lift(face, surfaceEvaluator({ ...def, frame: across }));
      if (!patch || patch.some((l) => l.wrap[0]) || !patch.some((l) => l.area > 0)) continue;
      const ranges = uRanges(patch);
      if (ranges.some(([lo, hi]) => hi - lo >= TAU)) continue;
      const gap = gaps(ranges, TAU)[0];
      return {
        surface: { ...def, frame: turned(across, gap) },
        loops: face.loops.map((l) => l.coedges.map(whole)),
        splits: [],
      };
    }
  // Where to put the seam (the angle the frame turns by): through a vertex of a loop going round, or clear of loops
  // (a whole sphere or torus keeps its frame).
  const angles: number[] = [];
  if (!loops.length) angles.push(0);
  else if (needU && loops.some((l) => l.wrap[0])) {
    // Vertices of loops going round, those at an angle more of the loops share first (one seam then crosses them all
    // at vertices).
    const counts: [number, number][] = [];
    face.loops.forEach((l, i) => {
      if (!loops[i].wrap[0]) return;
      for (const c of l.coedges) {
        const d = sub(c.start.point, frame.origin),
          a = Math.atan2(dot(d, frame.y), dot(d, frame.x)),
          seen = counts.find(([b]) => Math.abs(b - a) < 1e-12);
        if (seen) seen[1]++;
        else counts.push([a, 1]);
      }
    });
    angles.push(...counts.sort((a, b) => b[1] - a[1]).map(([a]) => a));
  } else if (needU) {
    const ranges = uRanges(loops);
    if (ranges.every(([lo, hi]) => hi - lo < TAU)) angles.push(...gaps(ranges, TAU));
  }
  if (needU) for (let k = 0; k < 12; k++) angles.push(0.1234 + (k * TAU) / 12);
  else angles.push(0);
  for (const angle of angles) {
    const cut = cutAt(face, loops, s, angle, needU, needV, splits);
    if (cut) return cut;
  }
  return undefined;
}

/** The face cut open with its frame turned by `angle` (the seam where u was `angle`), or undefined when that seam does not cut it cleanly. */
function cutAt(
  face: Face,
  loops: readonly LiftedLoop[],
  s: Surface,
  angle: number,
  needU: boolean,
  needV: boolean,
  existing: ReadonlyMap<Edge, readonly { f: number; vertex: Vertex }[]>,
): { surface: SurfaceDef; loops: Step[][]; splits: { edge: Edge; f: number; vertex: Vertex }[] } | undefined {
  const def = face.surface as Exclude<SurfaceDef, { kind: 'plane' | 'spline' }>,
    flip = !face.sense,
    // The seams in (u', v): u' = level[0] and v = level[1], each mod 2 pi.
    level: UV = [flip ? -angle : angle, 0],
    need = [needU, needV],
    newSplits: { edge: Edge; f: number; vertex: Vertex }[] = [],
    cell = (x: number, k: 0 | 1) => (x - level[k]) / TAU,
    // Distance (radians) of coordinate k from its seam.
    off = (x: number, k: 0 | 1) => Math.abs(cell(x, k) - Math.round(cell(x, k))) * TAU;
  let named = 0;
  const vertexAt = (edge: Edge, f: number): { f: number; vertex: Vertex } => {
    if (f <= 1e-9) return { f: 0, vertex: edge.start };
    if (f >= 1 - 1e-9) return { f: 1, vertex: edge.end };
    for (const x of [...(existing.get(edge) ?? []), ...newSplits.filter((x) => x.edge === edge)])
      if (Math.abs(x.f - f) <= 1e-9) return x;
    const t = edgeParameters(edge, 1),
      p = curveEvaluator(edge.curve)
        .at(t[0] + (t[1] - t[0]) * f)
        .slice(0, 3) as XYZ,
      split = { edge, f, vertex: new Vertex(`${face.name}/vertex:seam:${named++}`, p) };
    newSplits.push(split);
    return split;
  };

  // --- where each loop crosses the seams, in order along it ---------------------------------------------------------
  const crossings: Crossing[][] = [];
  for (let li = 0; li < loops.length; li++) {
    const list: Crossing[] = [],
      loop = loops[li],
      coedges = face.loops[li].coedges;
    for (let ci = 0; ci < coedges.length; ci++) {
      const { t, uv } = loop.coedges[ci],
        edge = coedges[ci].edge,
        curve = curveEvaluator(edge.curve);
      for (let i = 0; i + 1 < t.length; i++)
        for (const k of [0, 1] as const) {
          if (!need[k]) continue;
          const a = cell(uv[i][k], k),
            b = cell(uv[i + 1][k], k);
          if (Math.floor(a) === Math.floor(b)) continue;
          if (Math.abs(Math.floor(a) - Math.floor(b)) > 1) return undefined;
          // Bisect for the curve parameter where coordinate k reaches the seam between the two samples.
          const target = level[k] + TAU * Math.max(Math.floor(a), Math.floor(b)),
            h = uv[i],
            value = (ti: number) => {
              const raw = s.parameters(curve.at(ti), [flip ? -h[0] : h[0], h[1]]),
                x = k ? raw[1] : flip ? -raw[0] : raw[0];
              return x + Math.round((h[k] - x) / TAU) * TAU - target;
            };
          let lo = t[i],
            hi = t[i + 1];
          const below = value(lo) < 0;
          for (let n = 0; n < 200; n++) {
            const mid = (lo + hi) / 2;
            if (mid === lo || mid === hi) break;
            if (value(mid) < 0 === below) lo = mid;
            else hi = mid;
          }
          const ti = (lo + hi) / 2,
            raw = s.parameters(curve.at(ti)),
            other = k ? (flip ? -raw[0] : raw[0]) : raw[1],
            { f, vertex } = vertexAt(edge, fraction(edge, ti)),
            // Where along the seam: v on the u seam, u' from the u seam on the v seam (mod 2 pi where periodic).
            pos = k || s.vPeriod ? (((other - (k ? level[0] : 0)) % TAU) + TAU) % TAU : other;
          // On a torus cut both ways, a loop through the corner where the seams meet is not cut cleanly.
          if (needU && needV && Math.min(pos, TAU - pos) < 1e-7) return undefined;
          list.push({ at: ci, f, vertex, seam: k, dir: b > a ? 1 : -1, pos });
        }
    }
    // A crossing at a vertex may be found at the end of one coedge or the start of the next: either is that vertex.
    list.sort((x, y) => x.at - y.at || (coedges[x.at].forward ? x.f - y.f : y.f - x.f));
    for (let i = 0; i < list.length; i++) {
      const next = list[(i + 1) % list.length];
      if (list.length > 1 && next.vertex === list[i].vertex && next.seam === list[i].seam) return undefined;
    }
    // Other samples keep clear of the seams: a loop touching one, or running along it, is not cut cleanly there.
    for (let ci = 0; ci < coedges.length; ci++) {
      const { uv } = loop.coedges[ci];
      for (let i = 0; i < uv.length; i++)
        for (const k of [0, 1] as const) {
          if (!need[k] || off(uv[i][k], k) >= 1e-7) continue;
          const end = i === 0 ? coedges[ci].start : i === uv.length - 1 ? coedges[ci].end : undefined;
          if (!end || !list.some((x) => x.seam === k && x.vertex === end)) return undefined;
        }
    }
    crossings.push(list);
  }

  // --- the cut face's boundary: runs of its loops between crossings ---------------------------------------------------
  const segments: Segment[] = [],
    segment = (from: Node, to: Node, steps: Step[]) => {
      if (from.out || to.in) return false;
      const sg = { from, to, steps };
      from.out = to.in = sg;
      segments.push(sg);
      return true;
    },
    // Each crossing is two nodes, one on each side of the cut (low: u' or v at the seam; high: one period on). A loop
    // crossing towards + arrives on the high side and leaves from the low one.
    sides = new Map<Crossing, [Node, Node]>(),
    kept: Step[][] = [];
  for (const x of crossings.flat()) sides.set(x, [{ vertex: x.vertex }, { vertex: x.vertex }]);
  const arrive = (x: Crossing) => sides.get(x)![x.dir > 0 ? 1 : 0],
    leave = (x: Crossing) => sides.get(x)![x.dir > 0 ? 0 : 1];
  for (let li = 0; li < loops.length; li++) {
    const list = crossings[li],
      coedges = face.loops[li].coedges,
      n = coedges.length,
      startOf = (ci: number) => (coedges[ci].forward ? 0 : 1),
      endOf = (ci: number) => (coedges[ci].forward ? 1 : 0),
      part = (steps: Run[], ci: number, f0: number, f1: number) => {
        if (Math.abs(f0 - f1) > 1e-12) steps.push({ edge: coedges[ci].edge, forward: coedges[ci].forward, f0, f1 });
      };
    if (!list.length) {
      kept.push(coedges.map(whole));
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i],
        b = list[(i + 1) % list.length],
        steps: Run[] = [];
      if (i + 1 < list.length && b.at === a.at) part(steps, a.at, a.f, b.f);
      else {
        part(steps, a.at, a.f, endOf(a.at));
        for (let ci = (a.at + 1) % n; ci !== b.at; ci = (ci + 1) % n) part(steps, ci, startOf(ci), endOf(ci));
        part(steps, b.at, startOf(b.at), b.f);
      }
      if (!segment(leave(a), arrive(b), steps)) return undefined;
    }
  }

  // --- and the sides of the cut: a stretch of seam inside the face is a seam edge, used along each side ---------------
  const frame = turned(def.frame, angle),
    { origin: o, x, y, z } = frame,
    pair = (vertex: Vertex): [Node, Node] => [{ vertex }, { vertex }];
  // A torus cut both ways: its four corners are one vertex. [low u' low v, high u' low v, low u' high v, high high].
  let corner: Node[] | undefined;
  if (def.kind === 'torus' && needU && needV) {
    const vertex = new Vertex(`${face.name}/vertex:seam`, add(o, scale(x, def.major + def.minor)));
    corner = [{ vertex }, { vertex }, { vertex }, { vertex }];
  }
  const seamCurve = (k: 0 | 1): CurveDef => {
    switch (def.kind) {
      case 'cylinder':
        return { kind: 'line', origin: add(o, scale(x, def.radius)), direction: z };
      case 'cone':
        return {
          kind: 'line',
          origin: add(o, scale(x, def.radius)),
          direction: add(scale(x, Math.sin(def.angle)), scale(z, Math.cos(def.angle))),
        };
      case 'sphere':
        return { kind: 'circle', frame: frameOf(o, scale(y, -1), x), radius: def.radius };
      case 'torus':
        return k
          ? { kind: 'circle', frame: frameOf(o, z, x), radius: def.major + def.minor }
          : { kind: 'circle', frame: frameOf(add(o, scale(x, def.major)), scale(y, -1), x), radius: def.minor };
    }
  };
  let seams = 0;
  for (const k of [0, 1] as const) {
    if (!need[k]) continue;
    const points = crossings
        .flat()
        .filter((c) => c.seam === k)
        .sort((a, b) => a.pos - b.pos),
      curve = seamCurve(k),
      // Whether the face lies on the higher side of a crossing along the seam (v on seam 0, u' on seam 1): a loop
      // crossing seam 0 towards +u' has the face on its left, above; one crossing seam 1 towards +v has it at -u'.
      above = (c: Crossing) => (k ? c.dir < 0 : c.dir > 0),
      sidesOf = (c: Crossing) => sides.get(c)!;
    // The seam's ends: a sphere's poles, the torus's corner, or none (a cylinder's line; a circle round a torus).
    let first: [Node, Node] | undefined, last: [Node, Node] | undefined;
    if (def.kind === 'sphere') {
      first = pair(new Vertex(`${face.name}/vertex:pole:-`, sub(o, scale(z, def.radius))));
      last = pair(new Vertex(`${face.name}/vertex:pole:+`, add(o, scale(z, def.radius))));
    } else if (corner) {
      first = k ? [corner[0], corner[2]] : [corner[0], corner[1]];
      last = k ? [corner[1], corner[3]] : [corner[2], corner[3]];
    }
    const cyclic = def.kind === 'torus' && !corner;
    // The stretch of seam from a to b (up the seam) as one edge, along the seam curve's direction: v on seam 0, u on
    // seam 1 (u' runs against u on a face facing against its surface). Seam 0's high side (u' one period on) runs up,
    // its low side down; seam 1's low side (v = 0, the face above it) runs along +u', its high side back.
    const stretch = (a: [Node, Node], b: [Node, Node]) => {
      const along = !k || !flip,
        edge: WrittenEdge = {
          name: `${face.name}/edge:seam:${seams++}`,
          curve,
          start: (along ? a : b)[0].vertex,
          end: (along ? b : a)[0].vertex,
          sameSense: true,
        };
      return k
        ? segment(a[0], b[0], [{ edge, forward: along }]) && segment(b[1], a[1], [{ edge, forward: !along }])
        : segment(a[1], b[1], [{ edge, forward: along }]) && segment(b[0], a[0], [{ edge, forward: !along }]);
    };
    let low: boolean, high: boolean;
    if (!points.length) {
      // No loop crosses this seam: it lies wholly in the face (which needs the cut), end to end.
      if (!first || !last || !stretch(first, last)) return undefined;
      low = high = true;
    } else {
      for (let i = 0; i + 1 < points.length; i++) {
        const inside = above(points[i]);
        if (inside === above(points[i + 1])) return undefined;
        if (inside && !stretch(sidesOf(points[i]), sidesOf(points[i + 1]))) return undefined;
      }
      low = !above(points[0]);
      high = above(points[points.length - 1]);
      if (cyclic) {
        if (low !== high) return undefined;
        if (high && !stretch(sidesOf(points[points.length - 1]), sidesOf(points[0]))) return undefined;
      } else if (!first || !last) {
        if (low || high) return undefined;
      } else {
        if (corner && low !== high) return undefined;
        if (low && !stretch(first, sidesOf(points[0]))) return undefined;
        if (high && !stretch(sidesOf(points[points.length - 1]), last)) return undefined;
      }
    }
    // A pole inside the face: the cut's side along it is a single point in 3D (no edge), from the high side to the low.
    if (def.kind === 'sphere') {
      if (low && !segment(first![0], first![1], [])) return undefined;
      if (high && !segment(last![1], last![0], [])) return undefined;
    }
  }

  // --- the loops of the cut face: from each segment, follow the way out of each node until back ----------------------
  for (const sg of segments) if (!sg.from.in || !sg.to.out) return undefined;
  const done = new Set<Segment>(),
    out: Step[][] = [];
  for (const sg of segments) {
    const steps: Step[] = [];
    for (let at: Segment | undefined = sg; at && !done.has(at); at = at.to.out) {
      done.add(at);
      steps.push(...at.steps);
    }
    if (steps.length) out.push(steps);
  }
  return { surface: { ...def, frame } as SurfaceDef, loops: [...out, ...kept], splits: newSplits };
}
