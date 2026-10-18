// Boolean operations on solids (union, subtract, intersect), the classical way: intersect every pair of faces exactly,
// split edges and faces along the intersections, classify each piece of face as inside, outside or on the other solid,
// and stitch the pieces the operation keeps. Regions of a split face are traced in 3D (at each vertex the next edge
// is the sharpest left turn about the face normal), so seams and periodic surfaces need no special cases; loops are
// grouped into faces by which side of every loop a point inside each lies. Inside/outside comes from rays cast
// against the other solid's exact faces (three directions, majority), not from a mesh.
import { cross, dot, length, scale, sub, unit, type V3 } from '../geometry/vec.js';
import { curveEvaluator, type CurveDef } from './geometry.js';
import { FaceUV, leftOf, type UV, type UVLoop } from './faces.js';
import { curveSurfaceCrossings, intersectSurfaces, signedDistance } from './intersect.js';
import { Body, Edge, Face, Vertex, type History, type Name } from './topology.js';
import { edgeParameters, validateBody } from './validate.js';

/** What a Boolean keeps: material in either solid, in the first but not the second, or in both. */
export type BooleanOperation = 'union' | 'subtract' | 'intersect';

/** A piece of an edge between two vertices: of an original edge split at crossings, or of an intersection curve. */
interface Piece {
  curve: CurveDef;
  start: Vertex;
  end: Vertex;
  /** Curve parameters at start and end (decreasing when the piece runs against the curve). */
  t0: number;
  t1: number;
  name: Name;
  /** Names it came from, for the history: the edge it was split from, or the two faces it was cut along. */
  from: Name[];
  edge?: Edge;
  samples?: V3[];
}

/** A piece used in one direction by a face. */
interface Half {
  piece: Piece;
  forward: boolean;
  next?: Half;
  used?: boolean;
}

/** One face of the result before it is made: the input face it is part of, its loops, and a point inside it. */
interface Region {
  face: Face;
  from: 'a' | 'b';
  loops: Half[][];
  point: V3;
}

const TWO_PI = 2 * Math.PI;

/** Three ray directions in general position (none along an axis or a diagonal). */
const RAYS = [
  [0.5773502691896258, 0.6411923197284924, 0.5058722339651233],
  [-0.4134217846547371, 0.7718923469342184, -0.4829483254102233],
  [0.8123659372189244, -0.3348123480912773, 0.4775129834719122],
].map((d) => unit(d)!);

/**
 * `op` of solids `a` and `b` into a new solid `name`, with persistent names: faces and edges that come through keep
 * theirs, a face split into several kept pieces gives `<face>#k`, a split edge `<edge>#k`, and intersection edges
 * `<name>/edge:<face of a>|<face of b>#k`; `history` records splits as modifications, intersection edges as
 * generated from their two faces, and what was removed as deleted. Supported: faces on planes,
 * cylinders, cones, spheres and tori meeting in general position, for the surface pairs `intersectSurfaces` takes.
 * Throws a RangeError for what is not supported yet (faces on one surface that overlap, loops through a pole) and
 * when the result is not a valid solid.
 */
export function boolean(
  name: Name,
  op: BooleanOperation,
  a: Body,
  b: Body,
  { history }: { history?: History } = {},
): Body {
  if (a.kind !== 'solid' || b.kind !== 'solid') throw new RangeError('Booleans take two solids');
  const faces = { a: a.faces, b: b.faces },
    uvOf = new Map<Face, FaceUV>();
  for (const f of [...faces.a, ...faces.b]) uvOf.set(f, new FaceUV(f));
  // Model size: the merge tolerance for points computed twice, and how far a ray must go to leave both solids.
  let size = 0;
  for (const f of [...faces.a, ...faces.b]) {
    const s = f.surface as { frame?: { origin: V3 }; radius?: number; major?: number; minor?: number };
    if (s.frame && (s.radius !== undefined || s.major !== undefined))
      size = Math.max(size, length(s.frame.origin) + (s.radius ?? (s.major ?? 0) + (s.minor ?? 0)));
  }
  for (const v of [...a.vertices, ...b.vertices]) size = Math.max(size, length(v.point));
  size = Math.max(size, 1e-6);
  const merge = 1e-9 * size;

  // --- vertices: one per point, within the merge tolerance ----------------------------------------------------------
  const vertices: Vertex[] = [],
    original = new Map<Vertex, Vertex>();
  let vertexCount = 0;
  const vertexAt = (p: V3, keep?: Vertex): Vertex => {
    for (const v of vertices) if (length(sub(v.point, p)) <= merge) return v;
    const v = new Vertex(keep?.name ?? `${name}/vertex:${vertexCount++}`, p, keep?.tolerance);
    vertices.push(v);
    return v;
  };
  for (const v of [...a.vertices, ...b.vertices]) original.set(v, vertexAt(v.point, v));

  // --- crossings of each edge with the other solid's faces ----------------------------------------------------------
  const splits = new Map<Edge, { t: number; vertex: Vertex; face: Face }[]>();
  const crossEdges = (edges: Edge[], others: Face[]) => {
    for (const e of edges) {
      const [t0, t1] = edgeParameters(e, 1),
        c = curveEvaluator(e.curve);
      for (const g of others)
        for (const t of curveSurfaceCrossings(e.curve, g.surface, Math.min(t0, t1), Math.max(t0, t1))) {
          const p = c.at(t).slice(0, 3) as V3;
          if (!uvOf.get(g)!.contains(p)) continue;
          const list = splits.get(e) ?? [];
          list.push({ t, vertex: vertexAt(p), face: g });
          splits.set(e, list);
        }
    }
  };
  crossEdges(a.edges, faces.b);
  crossEdges(b.edges, faces.a);

  // --- original edges cut into pieces at their crossings ------------------------------------------------------------
  const piecesOf = new Map<Edge, Piece[]>();
  for (const e of [...a.edges, ...b.edges]) {
    const [t0, t1] = edgeParameters(e, 1),
      start = original.get(e.start)!,
      end = original.get(e.end)!,
      cuts = (splits.get(e) ?? [])
        .filter((s) => s.vertex !== start && s.vertex !== end)
        .sort((x, y) => (t1 >= t0 ? x.t - y.t : y.t - x.t)),
      unique = cuts.filter((s, k) => k === 0 || s.vertex !== cuts[k - 1].vertex),
      stops = [{ t: t0, vertex: start }, ...unique, { t: t1, vertex: end }];
    piecesOf.set(
      e,
      stops.slice(0, -1).map((s, k) => ({
        curve: e.curve,
        start: s.vertex,
        end: stops[k + 1].vertex,
        t0: s.t,
        t1: stops[k + 1].t,
        name: unique.length ? `${e.name}#${k}` : e.name,
        from: [e.name],
      })),
    );
  }

  // --- intersection curves of each pair of faces, kept where they lie inside both -----------------------------------
  const inner = new Map<Face, Piece[]>();
  const addInner = (f: Face, p: Piece) => inner.set(f, [...(inner.get(f) ?? []), p]);
  for (const fa of faces.a)
    for (const fb of faces.b) {
      const meet = intersectSurfaces(fa.surface, fb.surface);
      if (meet.kind === 'none') continue;
      if (meet.kind === 'coincident') {
        if (overlaps(uvOf.get(fa)!, uvOf.get(fb)!))
          throw new RangeError(`faces ${fa.name} and ${fb.name} lie on one surface and overlap: not supported yet`);
        continue;
      }
      let k = 0;
      for (const curve of meet.curves) {
        const c = curveEvaluator(curve),
          closed = curve.kind === 'circle' || curve.kind === 'ellipse',
          // Where either face's edges cross the other face, on this curve: the ends of its stretches inside both.
          stops: { t: number; vertex: Vertex }[] = [];
        for (const [f, g] of [
          [fa, fb],
          [fb, fa],
        ] as const)
          for (const loop of f.loops)
            for (const co of loop.coedges)
              for (const s of splits.get(co.edge) ?? []) {
                if (s.face !== g || stops.some((x) => x.vertex === s.vertex)) continue;
                const t = c.parameter(s.vertex.point);
                if (length(sub(c.at(t).slice(0, 3) as V3, s.vertex.point)) <= 1e3 * merge)
                  stops.push({ t, vertex: s.vertex });
              }
        stops.sort((x, y) => x.t - y.t);
        const both = (t: number) => {
          const p = c.at(t).slice(0, 3) as V3;
          return uvOf.get(fa)!.contains(p) && uvOf.get(fb)!.contains(p);
        };
        const push = (t0: number, t1: number, start: Vertex, end: Vertex) => {
          const piece: Piece = {
            curve,
            start,
            end,
            t0,
            t1,
            name: `${name}/edge:${fa.name}|${fb.name}#${k++}`,
            from: [fa.name, fb.name],
          };
          addInner(fa, piece);
          addInner(fb, piece);
        };
        if (closed && !stops.length) {
          if (both(0)) {
            const v = vertexAt(c.at(0).slice(0, 3) as V3);
            push(0, TWO_PI, v, v);
          }
          continue;
        }
        for (let i = 0; i < stops.length - (closed ? 0 : 1); i++) {
          const s = stops[i],
            e = closed && i === stops.length - 1 ? { t: stops[0].t + TWO_PI, vertex: stops[0].vertex } : stops[i + 1];
          if (both((s.t + e.t) / 2)) push(s.t, e.t, s.vertex, e.vertex);
        }
      }
    }

  // --- each face split along its new edges into regions -------------------------------------------------------------
  const regions: Region[] = [];
  for (const [from, list] of [
    ['a', faces.a],
    ['b', faces.b],
  ] as const)
    for (const f of list) {
      const halves: Half[] = [];
      for (const loop of f.loops)
        for (const co of loop.coedges) {
          const pieces = piecesOf.get(co.edge)!;
          for (const p of co.forward ? pieces : [...pieces].reverse()) halves.push({ piece: p, forward: co.forward });
        }
      for (const p of inner.get(f) ?? []) halves.push({ piece: p, forward: true }, { piece: p, forward: false });
      for (const r of splitFace(f, uvOf.get(f)!, halves)) regions.push({ ...r, from });
    }

  // --- classification and selection ---------------------------------------------------------------------------------
  const kept: { region: Region; flip: boolean }[] = [];
  for (const r of regions) {
    const where = classify(r.point, uvOf.get(r.face)!, r.from === 'a' ? faces.b : faces.a, uvOf, merge, 4 * size);
    const keep =
      op === 'union'
        ? where === 'out' || (where === 'same' && r.from === 'a')
        : op === 'intersect'
          ? where === 'in' || (where === 'same' && r.from === 'a')
          : r.from === 'a'
            ? where === 'out' || where === 'opposite'
            : where === 'in';
    if (keep) kept.push({ region: r, flip: op === 'subtract' && r.from === 'b' });
  }

  // --- the result ---------------------------------------------------------------------------------------------------
  const counts = new Map<Face, number>(),
    index = new Map<Face, number>(),
    generated: [Name, Name[]][] = [],
    modified: [Name, Name][] = [],
    made: Face[] = [];
  for (const { region } of kept) counts.set(region.face, (counts.get(region.face) ?? 0) + 1);
  const edgeOf = (p: Piece) => {
    if (!p.edge) {
      p.edge = new Edge(p.name, p.curve, p.start, p.end, p.t1 >= p.t0);
      // A split edge continues as its pieces; an intersection edge is new, made from the two faces.
      if (p.from.length > 1) generated.push([p.name, p.from]);
      else if (p.name !== p.from[0]) modified.push([p.from[0], p.name]);
    }
    return p.edge;
  };
  for (const { region, flip } of kept) {
    const f = region.face,
      k = index.get(f) ?? 0;
    index.set(f, k + 1);
    const faceName = counts.get(f) === 1 ? f.name : `${f.name}#${k}`,
      face = new Face(faceName, f.surface, flip ? !f.sense : f.sense);
    for (const cycle of region.loops) {
      const loop = face.loop();
      for (const h of flip ? [...cycle].reverse() : cycle) loop.use(edgeOf(h.piece), flip ? !h.forward : h.forward);
    }
    if (faceName !== f.name) modified.push([f.name, faceName]);
    made.push(face);
  }
  // One shell per connected set of faces (a solid with a cavity has two; disjoint pieces make several).
  const body = new Body(name, 'solid'),
    parent = new Map<Face, Face>(made.map((f) => [f, f]));
  const root = (f: Face): Face => {
    while (parent.get(f) !== f) f = parent.get(f)!;
    return f;
  };
  for (const f of made)
    for (const l of f.loops)
      for (const c of l.coedges) for (const o of c.edge.coedges) parent.set(root(o.loop.face), root(f));
  const groups = new Map<Face, Face[]>();
  for (const f of made) groups.set(root(f), [...(groups.get(root(f)) ?? []), f]);
  const shells = [...groups.values()].map((group) => {
    const shell = body.shell();
    for (const f of group) shell.add(f);
    return shell;
  });
  // A shell inside an odd number of others is a cavity, of the innermost shell round it that is not one.
  if (shells.length > 1) {
    const resultUV = new Map(made.map((f) => [f, new FaceUV(f)])),
      pointOf = new Map(made.map((f, i) => [f, kept[i].region.point])),
      around = shells.map((s) =>
        shells.filter(
          (t) =>
            t !== s &&
            classify(pointOf.get(s.faces[0])!, resultUV.get(s.faces[0])!, t.faces, resultUV, merge, 4 * size) === 'in',
        ),
      ),
      cavity = around.map((list) => list.length % 2 === 1);
    shells.forEach((s, i) => {
      if (!cavity[i]) return;
      s.outer = around[i]
        .filter((t) => !cavity[shells.indexOf(t)])
        .sort((x, y) => around[shells.indexOf(y)].length - around[shells.indexOf(x)].length)[0];
    });
  }
  const keptFaces = new Set(kept.map((x) => x.region.face)),
    keptEdges = new Set(made.flatMap((f) => f.loops.flatMap((l) => l.coedges.map((c) => c.edge.name)))),
    deleted = [
      ...[...faces.a, ...faces.b].filter((f) => !keptFaces.has(f)).map((f) => f.name),
      ...[...a.edges, ...b.edges]
        .filter((e) => !piecesOf.get(e)!.some((p) => keptEdges.has(p.name)))
        .map((e) => e.name),
    ];
  history?.record({ operation: name, generated, modified, deleted });
  const problems = validateBody(body);
  if (problems.length)
    throw new RangeError(
      `${op} ${name}: the result is not a valid solid (${problems.length} problems; first: ${problems[0].name}: ${problems[0].problem})`,
    );
  return body;
}

/** Samples of a piece in 3D from its start to its end (ends exactly at its vertices), shared by both its uses. */
function samplesOf(p: Piece): V3[] {
  if (p.samples) return p.samples;
  const c = curveEvaluator(p.curve),
    n = p.curve.kind === 'line' ? 1 : 128,
    out: V3[] = [];
  for (let k = 0; k <= n; k++)
    out.push(
      k === 0 ? p.start.point : k === n ? p.end.point : (c.at(p.t0 + ((p.t1 - p.t0) * k) / n).slice(0, 3) as V3),
    );
  p.samples = out;
  return out;
}

/** The unit direction of travel of a half at its start or its end. */
function tangent(h: Half, atEnd: boolean): V3 {
  const p = h.piece,
    d = curveEvaluator(p.curve).at(h.forward !== atEnd ? p.t0 : p.t1),
    sign = (p.t1 >= p.t0 ? 1 : -1) * (h.forward ? 1 : -1);
  return unit([d[3] * sign, d[4] * sign, d[5] * sign]) ?? [0, 0, 0];
}

/** A point a little way along a half from its start (or back from its end), to tell apart halves that leave a vertex tangent to each other. */
function nearEnd(h: Half, atEnd: boolean): V3 {
  const s = samplesOf(h.piece),
    k = Math.min(4, s.length - 1);
  return h.forward !== atEnd ? s[k] : s[s.length - 1 - k];
}

/** Clockwise angle from `from` to `to` about `normal`, in (0, 2 pi]. */
function clockwise(from: V3, to: V3, normal: V3): number {
  const a = -Math.atan2(dot(cross(from, to), normal), dot(from, to));
  return a <= 1e-12 ? a + TWO_PI : a;
}

/**
 * The regions a face is split into by its (split) boundary and the intersection pieces inside it, each used both
 * ways: each region's loops, and a point well inside it.
 */
function splitFace(f: Face, fuv: FaceUV, halves: Half[]): Omit<Region, 'from'>[] {
  if (!halves.length) return [{ face: f, loops: [], point: fuv.at([0, 0]) }];
  const outgoing = new Map<Vertex, Half[]>(),
    startOf = (h: Half) => (h.forward ? h.piece.start : h.piece.end),
    endOf = (h: Half) => (h.forward ? h.piece.end : h.piece.start);
  for (const h of halves) outgoing.set(startOf(h), [...(outgoing.get(startOf(h)) ?? []), h]);
  // At each vertex the next half is the sharpest left turn: the smallest clockwise angle from the way back.
  for (const h of halves) {
    const v = endOf(h),
      normal = fuv.normal(v.point),
      back = scale(tangent(h, true), -1),
      backChord = sub(nearEnd(h, true), v.point);
    let best: Half | undefined,
      bestAngle = Infinity,
      bestChord = Infinity;
    for (const o of outgoing.get(v) ?? []) {
      const reverse = o.piece === h.piece && o.forward !== h.forward,
        angle = reverse ? 3 * Math.PI : clockwise(back, tangent(o, false), normal),
        chord = reverse ? 3 * Math.PI : clockwise(backChord, sub(nearEnd(o, false), v.point), normal);
      if (angle < bestAngle - 1e-9 || (Math.abs(angle - bestAngle) <= 1e-9 && chord < bestChord)) {
        best = o;
        bestAngle = angle;
        bestChord = chord;
      }
    }
    h.next = best;
  }
  const cycles: Half[][] = [];
  for (const h of halves) {
    if (h.used) continue;
    const cycle: Half[] = [];
    let x: Half | undefined = h;
    while (x && !x.used) {
      x.used = true;
      cycle.push(x);
      x = x.next;
    }
    if (x !== h) throw new RangeError(`splitting face ${f.name} left an open chain of edges`);
    cycles.push(cycle);
  }
  // Each cycle in (u', v), continuous along it.
  const loops = cycles.map((cycle) => {
    const points: UV[] = [];
    let hint: UV | undefined;
    for (const h of cycle) {
      const s = samplesOf(h.piece),
        seq = h.forward ? s : [...s].reverse();
      for (let k = 0; k < seq.length - 1; k++) {
        const uv = fuv.near(seq[k], hint);
        points.push(uv);
        hint = uv;
      }
    }
    return fuv.close(points);
  });
  // Cycles bound one region when a point inside next to each lies on the same side of every cycle.
  const points = loops.map((l) => probe(fuv, l, loops)),
    groups = new Map<string, number[]>();
  points.forEach(([u, v], i) => {
    const key = loops.map((l) => (leftOf(l, fuv.period, u, v) ? '1' : '0')).join('');
    if (key[i] !== '1') throw new RangeError(`splitting face ${f.name}: a loop does not bound a region on its left`);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  return [...groups.values()].map((group) => ({
    face: f,
    loops: group.map((i) => cycles[i]),
    point: fuv.at(points[group[0]]),
  }));
}

/** A point inside the region left of a loop: halfway from the middle of the loop's longest segment to the next loop (or surface end) on its left. */
function probe(fuv: FaceUV, loop: UVLoop, all: UVLoop[]): UV {
  const period = fuv.period,
    segment = (l: UVLoop, i: number): [UV, UV] => [
      l.points[i],
      i + 1 < l.points.length ? l.points[i + 1] : [l.points[0][0] + l.wrap * period, l.points[0][1]],
    ];
  let best = 0,
    len = -1;
  for (let i = 0; i < loop.points.length; i++) {
    const [p, q] = segment(loop, i),
      l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l > len) {
      len = l;
      best = i;
    }
  }
  const [p0, q0] = segment(loop, best),
    m: UV = [(p0[0] + q0[0]) / 2, (p0[1] + q0[1]) / 2],
    d: UV = [-(q0[1] - p0[1]) / len, (q0[0] - p0[0]) / len],
    [v0, v1] = fuv.surface.vDomain;
  let s = Infinity;
  if (d[1] > 0 && Number.isFinite(v1)) s = (v1 - m[1]) / d[1];
  if (d[1] < 0 && Number.isFinite(v0)) s = (v0 - m[1]) / d[1];
  const eps = 1e-9 * len,
    shifts = period ? [-2, -1, 0, 1, 2] : [0];
  for (const l of all)
    for (let i = 0; i < l.points.length; i++) {
      const [p, q] = segment(l, i),
        e: UV = [q[0] - p[0], q[1] - p[1]],
        denom = d[0] * e[1] - d[1] * e[0];
      if (Math.abs(denom) <= 1e-15 * Math.hypot(e[0], e[1])) continue;
      for (const k of shifts) {
        const w: UV = [p[0] - (m[0] + k * period), p[1] - m[1]],
          hit = (w[0] * e[1] - w[1] * e[0]) / denom,
          r = (w[0] * d[1] - w[1] * d[0]) / denom;
        if (r >= 0 && r <= 1 && hit > eps && hit < s) s = hit;
      }
    }
  if (!Number.isFinite(s)) s = len;
  return [m[0] + (d[0] * s) / 2, m[1] + (d[1] * s) / 2];
}

/**
 * Where a point of a face lies against the solid bounded by `others`: on one of its faces facing the same way or
 * the opposite way, or in or out of it (rays in three directions, majority of their crossing counts).
 */
function classify(
  p: V3,
  fuv: FaceUV,
  others: Face[],
  uvOf: Map<Face, FaceUV>,
  merge: number,
  reach: number,
): 'in' | 'out' | 'same' | 'opposite' {
  for (const g of others) {
    if (Math.abs(signedDistance(g.surface, p)) > 1e3 * merge) continue;
    const guv = uvOf.get(g)!;
    if (!guv.contains(p)) continue;
    return dot(fuv.normal(p), guv.normal(p)) > 0 ? 'same' : 'opposite';
  }
  let inside = 0;
  for (const direction of RAYS) {
    const line: CurveDef = { kind: 'line', origin: p, direction },
      c = curveEvaluator(line);
    let count = 0;
    for (const g of others)
      for (const t of curveSurfaceCrossings(line, g.surface, 0, reach))
        if (uvOf.get(g)!.contains(c.at(t).slice(0, 3) as V3)) count++;
    if (count % 2) inside++;
  }
  return inside >= 2 ? 'in' : 'out';
}

/** Whether two faces on one surface overlap (a point of either's loops lies inside the other). */
function overlaps(x: FaceUV, y: FaceUV): boolean {
  for (const [f, g] of [
    [x, y],
    [y, x],
  ] as const)
    for (const loop of f.loops) for (const q of loop.points) if (g.contains(f.at(q))) return true;
  return false;
}
