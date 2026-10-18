// Boolean operations on solids (union, subtract, intersect), the classical way: intersect every pair of faces exactly,
// split edges and faces along the intersections, classify each piece of face as inside, outside or on the other solid,
// and stitch the pieces the operation keeps. Regions of a split face are traced in 3D (at each vertex the next edge
// is the sharpest left turn about the face normal), so seams and periodic surfaces need no special cases; loops are
// grouped into faces by which side of every loop a point inside each lies. Inside/outside comes from rays cast
// against the other solid's exact faces (three directions, majority), not from a mesh.
import { cross, dot, length, scale, sub, unit, type V3 } from '../geometry/vec.js';
import { curveEvaluator, surfaceEvaluator, type CurveDef } from './geometry.js';
import { FaceUV, gaps, leftOf, shiftV, vRange, type UV, type UVLoop } from './faces.js';
import { curveSurfaceCrossings, intersectSurfaces, signedDistance } from './intersect.js';
import type { Box3 } from './march.js';
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
  /** A piece of the other solid lying along this one: the result keeps that one (flip: it runs the other way). */
  alias?: { piece: Piece; flip: boolean };
}

/** The piece that stands for `p` in the result, and whether it runs the other way. */
function canon(p: Piece): { piece: Piece; flip: boolean } {
  let flip = false;
  while (p.alias) {
    flip = flip !== p.alias.flip;
    p = p.alias.piece;
  }
  return { piece: p, flip };
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
 * cylinders, cones, spheres and tori in any position: faces on one surface, edges along edges and vertices on faces
 * meet within 1e-6 of the model; faces left on one surface facing the same way, and edges split along one curve,
 * are joined. Throws a RangeError for what is not supported yet (tangential contact, loops through a pole, spline
 * surfaces) and when the result is not a valid solid.
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
  const merge = 1e-9 * size,
    // Points within `touch` of each other, of a curve or of a surface are taken to meet there (1e-6 of the model): a
    // crossing found a hair from a vertex (a curve touching a face tangentially) is that vertex.
    touch = 1e3 * merge;

  // --- vertices: one per point, within the merge tolerance ----------------------------------------------------------
  const vertices: Vertex[] = [],
    original = new Map<Vertex, Vertex>();
  let vertexCount = 0;
  const vertexAt = (p: V3, keep?: Vertex): Vertex => {
    for (const v of vertices) if (length(sub(v.point, p)) <= touch) return v;
    const v = new Vertex(keep?.name ?? `${name}/vertex:${vertexCount++}`, p, keep?.tolerance);
    vertices.push(v);
    return v;
  };
  for (const v of [...a.vertices, ...b.vertices]) original.set(v, vertexAt(v.point, v));

  // --- contacts: where each edge crosses the other solid's faces, edges or vertices, or lies in its faces --------------
  const splits = new Map<Edge, { t: number; vertex: Vertex }[]>(),
    split = (e: Edge, t: number, vertex: Vertex) => splits.set(e, [...(splits.get(e) ?? []), { t, vertex }]),
    lying: [Edge, Face][] = [];
  /** The parameter of `p` on edge `e` when it lies on the edge (within touch, inside its range), else undefined. */
  const onEdge = (e: Edge, p: V3): number | undefined => {
    const c = curveEvaluator(e.curve),
      [t0, t1] = edgeParameters(e, 1),
      lo = Math.min(t0, t1),
      hi = Math.max(t0, t1);
    let t = c.parameter(p);
    if (c.period) t = lo + ((((t - lo) % c.period) + c.period) % c.period);
    if (t < lo - 1e-12 * (hi - lo) || t > hi + 1e-12 * (hi - lo)) return undefined;
    return length(sub(c.at(t).slice(0, 3) as V3, p)) <= touch ? t : undefined;
  };
  const contacts = (edges: Edge[], others: Face[], otherVertices: Vertex[]) => {
    for (const e of edges) {
      const [t0, t1] = edgeParameters(e, 1),
        c = curveEvaluator(e.curve),
        start = original.get(e.start)!,
        end = original.get(e.end)!;
      for (const g of others) {
        // An edge lying in the face's surface: it may cut the face (below), and crosses nothing there.
        const samples = edgeParameters(e, 6).slice(1, -1);
        if (samples.every((t) => Math.abs(signedDistance(g.surface, c.at(t).slice(0, 3) as V3)) <= touch)) {
          lying.push([e, g]);
          continue;
        }
        for (const t of curveSurfaceCrossings(e.curve, g.surface, Math.min(t0, t1), Math.max(t0, t1))) {
          const p = c.at(t).slice(0, 3) as V3;
          // On the face's boundary (tested first: the inside test is not reliable there): the edge crosses one of its
          // edges, and both are cut.
          let onBoundary = false;
          for (const loop of g.loops)
            for (const co of loop.coedges) {
              const th = onEdge(co.edge, p);
              if (th === undefined) continue;
              const v = vertexAt(p);
              split(e, t, v);
              split(co.edge, th, v);
              onBoundary = true;
            }
          if (!onBoundary && uvOf.get(g)!.contains(p)) split(e, t, vertexAt(p));
        }
      }
      // The other solid's vertices on this edge cut it.
      for (const v of otherVertices) {
        if (v === start || v === end) continue;
        const t = onEdge(e, v.point);
        if (t !== undefined) split(e, t, v);
      }
    }
  };
  const vertsA = [...new Set(a.vertices.map((v) => original.get(v)!))],
    vertsB = [...new Set(b.vertices.map((v) => original.get(v)!))];
  contacts(a.edges, faces.b, vertsB);
  contacts(b.edges, faces.a, vertsA);

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

  // --- pieces of the two solids lying along each other become one edge ---------------------------------------------
  const ends = (p: Piece) => {
      const x = vertices.indexOf(p.start),
        y = vertices.indexOf(p.end);
      return x < y ? `${x},${y}` : `${y},${x}`;
    },
    middle = (p: Piece) =>
      curveEvaluator(p.curve)
        .at((p.t0 + p.t1) / 2)
        .slice(0, 3) as V3,
    /** Whether piece p runs along piece q (same ends, p's middle on q within its range). */
    along = (p: Piece, q: Piece) => {
      const m = middle(p),
        c = curveEvaluator(q.curve),
        lo = Math.min(q.t0, q.t1),
        hi = Math.max(q.t0, q.t1);
      let t = c.parameter(m);
      if (c.period) t = lo + ((((t - lo) % c.period) + c.period) % c.period);
      return (
        t >= lo - 1e-9 * (hi - lo) && t <= hi + 1e-9 * (hi - lo) && length(sub(c.at(t).slice(0, 3) as V3, m)) <= touch
      );
    },
    byEnds = new Map<string, Piece[]>();
  for (const e of a.edges) for (const p of piecesOf.get(e)!) byEnds.set(ends(p), [...(byEnds.get(ends(p)) ?? []), p]);
  for (const e of b.edges)
    for (const p of piecesOf.get(e)!)
      for (const q of byEnds.get(ends(p)) ?? [])
        if (along(p, q)) {
          const flip =
            p.start === p.end
              ? dot(tangent({ piece: p, forward: true }, false), tangent({ piece: q, forward: true }, false)) < 0
              : p.start !== q.start;
          p.alias = { piece: q, flip };
          break;
        }
  /** A face's boundary pieces as the result keeps them. */
  const boundary = new Map<Face, Set<Piece>>();
  const boundaryOf = (f: Face) => {
    let set = boundary.get(f);
    if (!set) {
      set = new Set();
      for (const loop of f.loops)
        for (const co of loop.coedges) for (const p of piecesOf.get(co.edge)!) set.add(canon(p).piece);
      boundary.set(f, set);
    }
    return set;
  };
  const inner = new Map<Face, Piece[]>();
  const addInner = (f: Face, p: Piece) => {
    const list = inner.get(f) ?? [];
    if (!list.includes(p) && !boundaryOf(f).has(p)) inner.set(f, [...list, p]);
  };
  // Edges lying in the other solid's faces cut them where they lie inside (faces on one surface overlap there).
  for (const [e, g] of lying)
    for (const p of piecesOf.get(e)!) {
      const c = canon(p).piece;
      if (!boundaryOf(g).has(c) && uvOf.get(g)!.contains(middle(c))) addInner(g, c);
    }

  // --- intersection curves of each pair of faces, kept where they lie inside both -----------------------------------
  const boxes = new Map([...faces.a, ...faces.b].map((f) => [f, faceBox(uvOf.get(f)!, merge)]));
  for (const fa of faces.a)
    for (const fb of faces.b) {
      const box = overlap(boxes.get(fa)!, boxes.get(fb)!);
      if (!box) continue;
      const meet = intersectSurfaces(fa.surface, fb.surface, box);
      if (meet.kind === 'none') continue;
      // Faces on one surface: their edges lying in each other cut them (above), and no curve runs between them.
      if (meet.kind === 'coincident') continue;
      let k = 0;
      for (const curve of meet.curves) {
        const c = curveEvaluator(curve),
          period = c.period,
          closed = period > 0,
          // Where either face's edges cross the other face, on this curve: the ends of its stretches inside both.
          stops: { t: number; vertex: Vertex }[] = [];
        for (const f of [fa, fb])
          for (const loop of f.loops)
            for (const co of loop.coedges)
              for (const s of splits.get(co.edge) ?? []) {
                if (stops.some((x) => x.vertex === s.vertex)) continue;
                const t = c.parameter(s.vertex.point);
                if (length(sub(c.at(t).slice(0, 3) as V3, s.vertex.point)) <= touch)
                  stops.push({ t, vertex: s.vertex });
              }
        // Where two curves cross (the surfaces touch tangentially there): a vertex on each. At a corner the faces share
        // (fillets meeting) that is all; inside both faces the faces would meet in a cusp, which is not supported yet.
        for (const x of meet.crossings ?? []) {
          const onEdges = [fa, fb].some((f) =>
            f.loops.some((l) => l.coedges.some((co) => onEdge(co.edge, x) !== undefined)),
          );
          if (!onEdges && uvOf.get(fa)!.contains(x) && uvOf.get(fb)!.contains(x))
            throw new RangeError(
              `faces ${fa.name} and ${fb.name} touch tangentially where their curves cross: Booleans there are not supported yet`,
            );
          const t = c.parameter(x);
          if (length(sub(c.at(t).slice(0, 3) as V3, x)) > touch) continue;
          const v = vertexAt(x);
          if (!stops.some((y) => y.vertex === v)) stops.push({ t, vertex: v });
        }
        // Vertices of either face on the curve (a corner touching the other face) break it too.
        for (const f of [fa, fb])
          for (const loop of f.loops)
            for (const co of loop.coedges) {
              const v = original.get(co.start)!;
              if (stops.some((x) => x.vertex === v)) continue;
              const t = c.parameter(v.point);
              if (length(sub(c.at(t).slice(0, 3) as V3, v.point)) <= touch) stops.push({ t, vertex: v });
            }
        stops.sort((x, y) => x.t - y.t);
        /** A boundary piece of `f` between these vertices that the stretch runs along, if any. */
        const onBoundary = (f: Face, start: Vertex, end: Vertex, m: V3) => {
          for (const q of boundaryOf(f))
            if (
              ((q.start === start && q.end === end) || (q.start === end && q.end === start)) &&
              length(sub(middle(q), m)) <= touch
            )
              return q;
          return undefined;
        };
        const push = (t0: number, t1: number, start: Vertex, end: Vertex) => {
          const m = c.at((t0 + t1) / 2).slice(0, 3) as V3,
            onA = onBoundary(fa, start, end, m),
            onB = onBoundary(fb, start, end, m);
          // Along an edge of either face: that edge, cutting the other face where it lies inside it.
          if (onA && onB) return;
          if (onA) {
            if (uvOf.get(fb)!.contains(m)) addInner(fb, onA);
            return;
          }
          if (onB) {
            if (uvOf.get(fa)!.contains(m)) addInner(fa, onB);
            return;
          }
          if (!uvOf.get(fa)!.contains(m) || !uvOf.get(fb)!.contains(m)) return;
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
          const t0 = c.domain[0],
            p0 = c.at(t0).slice(0, 3) as V3;
          if (uvOf.get(fa)!.contains(p0) && uvOf.get(fb)!.contains(p0)) {
            const v = vertexAt(p0);
            push(t0, t0 + period, v, v);
          }
          continue;
        }
        for (let i = 0; i < stops.length - (closed ? 0 : 1); i++) {
          const s = stops[i],
            e = closed && i === stops.length - 1 ? { t: stops[0].t + period, vertex: stops[0].vertex } : stops[i + 1];
          if (s.vertex !== e.vertex || closed) push(s.t, e.t, s.vertex, e.vertex);
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
          for (const p of co.forward ? pieces : [...pieces].reverse()) {
            const c = canon(p);
            halves.push({ piece: c.piece, forward: co.forward !== c.flip });
          }
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

  // --- kept regions on one surface that meet along an edge, facing the same way, become one face -------------------
  // (two boxes united side by side: their top faces and the edges between them go). Loops are traced again from the
  // halves left once the shared pieces are dropped.
  const facing = kept.map(({ region, flip }) => ({
      region,
      sense: flip ? !region.face.sense : region.face.sense,
      halves: region.loops.flat().map((h) => ({ piece: h.piece, forward: flip ? !h.forward : h.forward })),
    })),
    uses = new Map<Piece, { i: number; forward: boolean }[]>(),
    group = facing.map((_, i) => i);
  const top = (i: number): number => (group[i] === i ? i : (group[i] = top(group[i])));
  facing.forEach(({ halves }, i) => {
    for (const h of halves) uses.set(h.piece, [...(uses.get(h.piece) ?? []), { i, forward: h.forward }]);
  });
  for (const [piece, list] of uses) {
    if (list.length !== 2 || list[0].i === list[1].i || list[0].forward === list[1].forward) continue;
    const [x, y] = [facing[list[0].i], facing[list[1].i]];
    if (top(list[0].i) !== top(list[1].i) && sameSide(x.region.face, x.sense, y.region.face, y.sense, piece))
      group[top(list[1].i)] = top(list[0].i);
  }
  const members = new Map<number, number[]>();
  facing.forEach((_, i) => members.set(top(i), [...(members.get(top(i)) ?? []), i]));
  /** Each result face: the input face it is named from, its sense, its loops, a point inside it, and its other sources. */
  const outputs: { face: Face; sense: boolean; loops: Half[][]; point: V3; sources: Face[] }[] = [];
  for (const list of members.values()) {
    const first = facing[list[0]],
      sources = [...new Set(list.map((i) => facing[i].region.face))];
    if (list.length === 1) {
      const { region } = first,
        flip = first.sense !== region.face.sense;
      outputs.push({
        face: region.face,
        sense: first.sense,
        loops: region.loops.map((cycle) =>
          (flip ? [...cycle].reverse() : cycle).map((h) => ({
            piece: h.piece,
            forward: flip ? !h.forward : h.forward,
          })),
        ),
        point: region.point,
        sources,
      });
      continue;
    }
    const inside = new Set(list),
      halves = list
        .flatMap((i) => facing[i].halves)
        .filter((h) => {
          const u = uses.get(h.piece)!;
          return !(u.length === 2 && u[0].i !== u[1].i && inside.has(u[0].i) && inside.has(u[1].i));
        })
        .map((h) => ({ piece: h.piece, forward: h.forward })),
      host = new Face(first.region.face.name, first.region.face.surface, first.sense);
    for (const r of splitFace(host, new FaceUV(host), halves))
      outputs.push({ face: first.region.face, sense: first.sense, loops: r.loops, point: r.point, sources });
  }

  // --- pieces that continue one another (one curve, the same two faces) at a vertex nothing else meets join again -----
  joinPieces(
    outputs.map((o) => o.loops),
    touch,
  );

  // --- the result ---------------------------------------------------------------------------------------------------
  const counts = new Map<Face, number>(),
    index = new Map<Face, number>(),
    generated: [Name, Name[]][] = [],
    modified: [Name, Name][] = [],
    made: Face[] = [],
    pointOf = new Map<Face, V3>();
  for (const { face } of outputs) counts.set(face, (counts.get(face) ?? 0) + 1);
  const edgeOf = (p: Piece) => {
    if (!p.edge) {
      p.edge = new Edge(p.name, p.curve, p.start, p.end, p.t1 >= p.t0);
      // A split edge continues as its pieces; an intersection edge is new, made from the two faces.
      if (p.from.length > 1) generated.push([p.name, p.from]);
      else if (p.name !== p.from[0]) modified.push([p.from[0], p.name]);
    }
    return p.edge;
  };
  for (const output of outputs) {
    const f = output.face,
      k = index.get(f) ?? 0;
    index.set(f, k + 1);
    const faceName = counts.get(f) === 1 ? f.name : `${f.name}#${k}`,
      face = new Face(faceName, f.surface, output.sense);
    for (const cycle of output.loops) {
      const loop = face.loop();
      for (const h of cycle) loop.use(edgeOf(h.piece), h.forward);
    }
    if (faceName !== f.name) modified.push([f.name, faceName]);
    // Faces merged into this one continue as it.
    for (const other of output.sources) if (other !== f) modified.push([other.name, faceName]);
    made.push(face);
    pointOf.set(face, output.point);
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
  const keptFaces = new Set(outputs.flatMap((x) => x.sources)),
    keptEdges = new Set(made.flatMap((f) => f.loops.flatMap((l) => l.coedges.map((c) => c.edge.name)))),
    deleted = [
      ...[...faces.a, ...faces.b].filter((f) => !keptFaces.has(f)).map((f) => f.name),
      ...[...a.edges, ...b.edges]
        .filter((e) => !piecesOf.get(e)!.some((p) => keptEdges.has(canon(p).piece.name)))
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
        chord = reverse ? 3 * Math.PI : clockwise(backChord, sub(nearEnd(o, false), v.point), normal);
      let angle = reverse ? 3 * Math.PI : clockwise(back, tangent(o, false), normal);
      // A cusp: the half leaves along the way back (a rounding tangent to the edge it meets). Which side it bends to
      // decides, from its chord: just past 0 or just short of a full turn.
      if (!reverse && (angle < 1e-6 || angle > TWO_PI - 1e-6)) angle = chord;
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
  // A torus is cut open round its tube where no cycle crosses, so v runs over one period from the cut; the region
  // the cut runs through is then in two parts, joined below.
  const vPeriod = fuv.surface.vPeriod,
    cut = vPeriod ? gaps(loops.map(vRange), vPeriod)[0] : undefined;
  if (vPeriod && cut === undefined)
    throw new RangeError(`splitting face ${f.name}: a loop goes round a torus's tube: not supported yet`);
  const open = cut === undefined ? loops : loops.map((l) => shiftV(l, cut, vPeriod)),
    vBounds: readonly [number, number] = cut === undefined ? fuv.surface.vDomain : [cut, cut + vPeriod],
    sides = ([u, v]: UV) => open.map((l) => (leftOf(l, fuv.period, u, v) ? '1' : '0')).join('');
  // Cycles bound one region when a point inside next to each lies on the same side of every cycle.
  const points = open.map((l) => probe(fuv, l, open, vBounds)),
    groups = new Map<string, number[]>();
  points.forEach((q, i) => {
    const key = sides(q);
    if (key[i] !== '1') throw new RangeError(`splitting face ${f.name}: a loop does not bound a region on its left`);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  if (cut !== undefined) {
    const u = open[0].points[0][0],
      low = sides([u, cut + 1e-9 * vPeriod]),
      high = sides([u, cut + vPeriod * (1 - 1e-9)]);
    if (low !== high && groups.has(low) && groups.has(high)) {
      groups.set(low, [...groups.get(low)!, ...groups.get(high)!]);
      groups.delete(high);
    }
  }
  return [...groups.values()].map((group) => ({
    face: f,
    loops: group.map((i) => cycles[i]),
    point: fuv.at(points[group[0]]),
  }));
}

/** A point inside the region left of a loop: halfway from the middle of the loop's longest segment to the next loop (or surface end) on its left. */
function probe(fuv: FaceUV, loop: UVLoop, all: UVLoop[], vBounds: readonly [number, number]): UV {
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
    [v0, v1] = vBounds;
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

/**
 * Joins pairs of pieces meeting at a vertex no other piece touches, where one continues the other's curve and every loop
 * that uses one uses the other next to it (the same two faces on both sides): the split a Boolean left in an edge that
 * came through whole on the result (two boxes united side by side: their common top edge in three pieces).
 */
function joinPieces(faces: Half[][][], touch: number): void {
  for (let changed = true; changed; ) {
    changed = false;
    const at = new Map<Vertex, Set<Piece>>();
    for (const loops of faces)
      for (const loop of loops)
        for (const h of loop)
          for (const v of [h.piece.start, h.piece.end]) at.set(v, (at.get(v) ?? new Set()).add(h.piece));
    for (const [v, pieces] of at) {
      if (pieces.size !== 2) continue;
      const [p, q] = [...pieces];
      if (p.start === p.end || q.start === q.end || (p.start === q.start && p.end === q.end)) continue;
      const joined = join(p, q, v, touch);
      if (!joined) continue;
      // Every use of p must sit next to a use of q in the same loop, run the same way.
      let ok = true,
        found = 0;
      const plans: [Half[], number][] = [];
      for (const loops of faces)
        for (const loop of loops)
          loop.forEach((h, i) => {
            if (h.piece !== p) return;
            found++;
            const next = loop[(i + 1) % loop.length],
              prev = loop[(i - 1 + loop.length) % loop.length],
              endsAtV = (h.forward ? p.end : p.start) === v,
              other = endsAtV ? next : prev;
            if (other.piece !== q || loop.length < 3) ok = false;
            else plans.push([loop, endsAtV ? i : (i - 1 + loop.length) % loop.length]);
          });
      if (!ok || !found) continue;
      // Highest index first in each loop, so earlier indices stay valid (a seam piece is used twice in one loop).
      plans.sort((x, y) => y[1] - x[1]);
      for (const [loop, i] of plans) {
        const first = loop[i],
          forward = (first.forward ? first.piece.start : first.piece.end) === joined.start,
          half = { piece: joined, forward };
        if (i + 1 < loop.length) loop.splice(i, 2, half);
        else {
          loop.splice(i, 1, half);
          loop.splice(0, 1);
        }
      }
      changed = true;
      break;
    }
  }
}

/** One piece for p then q (or q then p) through their common vertex v, when q continues p's curve; else undefined. */
function join(p: Piece, q: Piece, v: Vertex, touch: number): Piece | undefined {
  const c = curveEvaluator(p.curve),
    far = q.start === v ? q.end : q.start,
    pFar = p.start === v ? p.end : p.start,
    tv = p.start === v ? p.t0 : p.t1,
    tp = p.start === v ? p.t1 : p.t0,
    // q's middle and far end must lie on p's curve, beyond v from p.
    qMid = curveEvaluator(q.curve)
      .at((q.t0 + q.t1) / 2)
      .slice(0, 3) as V3;
  for (const point of [qMid, far.point]) {
    const t = c.parameter(point);
    if (length(sub(c.at(t).slice(0, 3) as V3, point)) > touch) return undefined;
  }
  // Continue past v the way p runs away from its far end.
  const dir = Math.sign(tv - tp) || 1,
    period = c.period;
  let tf = c.parameter(far.point, tv);
  if (period) while ((tf - tv) * dir <= 0) tf += dir * period;
  if ((tf - tv) * dir <= 0) return undefined;
  if (period && Math.abs(tf - tp) >= period - 1e-12) return undefined;
  const [start, end, t0, t1] = p.start === v ? [far, pFar, tf, tp] : [pFar, far, tp, tf];
  return { curve: p.curve, start, end, t0, t1, name: p.name, from: p.from };
}

/** Whether two faces lie on one surface and face the same way where they meet along `piece`. */
function sameSide(f: Face, fSense: boolean, g: Face, gSense: boolean, piece: Piece): boolean {
  if (f.surface !== g.surface) {
    try {
      if (intersectSurfaces(f.surface, g.surface).kind !== 'coincident') return false;
    } catch {
      return false;
    }
  }
  const m = curveEvaluator(piece.curve)
      .at((piece.t0 + piece.t1) / 2)
      .slice(0, 3) as V3,
    normal = (s: Face, sense: boolean) => {
      const e = surfaceEvaluator(s.surface),
        [u, v] = e.parameters(m),
        n = e.normal(u, v);
      return sense ? n : scale(n, -1);
    };
  return dot(normal(f, fSense), normal(g, gSense)) > 0;
}

/**
 * A box round a face, generous rather than tight: its boundary samples, and on a curved surface a grid over its
 * (u, v) bounds as well (the face can bulge past its boundary); a sphere or torus is boxed whole.
 */
function faceBox(fuv: FaceUV, merge: number): Box3 {
  const s = fuv.face.surface,
    points: V3[] = [];
  if (s.kind === 'sphere' || s.kind === 'torus') {
    const r = s.kind === 'sphere' ? s.radius : s.major + s.minor,
      o = s.frame.origin;
    return { min: [o[0] - r, o[1] - r, o[2] - r], max: [o[0] + r, o[1] + r, o[2] + r] };
  }
  for (const l of fuv.loops) for (const q of l.points) points.push(fuv.at(q));
  if (s.kind !== 'plane') {
    const [u0, u1, v0, v1] = fuv.box;
    for (let i = 0; i <= 16; i++)
      for (let j = 0; j <= 16; j++) points.push(fuv.at([u0 + ((u1 - u0) * i) / 16, v0 + ((v1 - v0) * j) / 16]));
  }
  const min: V3 = [Infinity, Infinity, Infinity],
    max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  const pad = 0.02 * length(sub(max, min)) + 1e3 * merge;
  return { min: [min[0] - pad, min[1] - pad, min[2] - pad], max: [max[0] + pad, max[1] + pad, max[2] + pad] };
}

/** The common part of two boxes, or undefined when they are apart. */
function overlap(a: Box3, b: Box3): Box3 | undefined {
  const min: V3 = [0, 0, 0],
    max: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.max(a.min[k], b.min[k]);
    max[k] = Math.min(a.max[k], b.max[k]);
    if (min[k] > max[k]) return undefined;
  }
  return { min, max };
}
