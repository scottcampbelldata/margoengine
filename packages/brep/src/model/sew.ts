// Sewing: loose faces (or sheets) joined into one body along the edges they share within a tolerance. Vertices within
// the tolerance of each other become one; an edge whose curve passes within the tolerance of another face's vertex is
// split there (one edge against two); two edges between the same vertices whose curves lie within the tolerance of each
// other become one edge used by both faces, its tolerance the gap it closed; faces are turned over where a neighbour
// runs a shared edge the same way; and a shell that closes is turned to face out. The result is a solid only when every
// shell closed and the body passes checkBody; otherwise it is a sheet, and the report says what stayed open and why. The
// tolerance is a distance in metres, the largest gap the sewing may close; every gap it closes is reported. Closed
// shells nested in others are sorted by how many shells lie round each (rays from a point of it, crossings counted):
// one inside an odd number is a cavity of the innermost solid shell round it, turned to face into the cavity.
import { distance, dot, nearest, scale, unit, type XYZ } from '../geometry/vec.js';
import { checkBody } from './check.js';
import { curveSurfaceCrossings } from './distance.js';
import { FaceUV } from './faces.js';
import { curveEvaluator, surfaceEvaluator, type CurveDef } from './geometry.js';
import { enclosedVolume } from './mass.js';
import { Body, Edge, Face, Vertex, type History, type Name } from './topology.js';
import { edgeParameters, measureTolerances, type ValidityProblem } from './validate.js';

/** Three directions in general position, for counting how often rays from a point cross a shell. */
const RAYS = [
  [0.6234898018587335, 0.5384693101056831, 0.5667004719618033],
  [-0.3826834323650898, 0.8314696123025452, -0.4029733920661247],
  [0.7933533402912352, -0.4067366430758002, 0.4524424391035483],
].map((d) => unit(d)!);

/** What sewing did and what it could not do. */
export interface SewReport {
  /** The sewn body: a solid when `closed`, otherwise a sheet. */
  readonly body: Body;
  /** Whether every shell closed, faces agree on their sides, and the body passed checkBody: a valid solid. */
  readonly closed: boolean;
  /** Pairs of edges joined into one, with the largest distance between them (0 where they were the same curve). */
  readonly joined: readonly { readonly edges: readonly [Name, Name]; readonly gap: number }[];
  /** Vertices joined into one, with the largest distance of any of them from the point they became. */
  readonly merged: readonly { readonly vertices: readonly Name[]; readonly gap: number }[];
  /**
   * Edges shorter than the tolerance (both their ends became one vertex) and faces left with no boundary by them (a
   * sliver within the tolerance), removed.
   */
  readonly dropped: readonly Name[];
  /** Edges split where another face's vertex lies on them, and the names of their pieces. */
  readonly split: readonly { readonly edge: Name; readonly into: readonly Name[] }[];
  /** Edges left with one face, each with the nearest other such edge and how far it is (Infinity when there is none). */
  readonly open: readonly { readonly edge: Name; readonly nearest?: Name; readonly gap: number }[];
  /** Faces turned over so that each shared edge is run one way by one face and the other way by the other. */
  readonly flipped: readonly Name[];
  /** Everything else that kept the body from being a valid solid. */
  readonly problems: readonly ValidityProblem[];
}

/** An edge being sewn: its curve, its ends (indices of joined vertices) and the loops that use it. */
interface Sewn {
  name: Name;
  curve: CurveDef;
  sameSense: boolean;
  start: number;
  end: number;
  closed: boolean;
  tolerance: number;
  uses: Use[];
  /** The edge with the joined vertices, for sampling. */
  probe?: Edge;
}
interface Use {
  edge: Sewn;
  forward: boolean;
}
interface LooseFace {
  name: Name;
  face: Face;
  loops: Use[][];
}

/**
 * Sews `faces` (faces, or every face of sheets and solids) into one body named `name`, closing gaps of at most
 * `tolerance` metres. The faces' surfaces and curves are shared with the inputs, which are not changed. Throws a
 * RangeError for a tolerance that is not positive and finite, and for no faces.
 */
export function sew(
  name: Name,
  faces: readonly (Face | Body)[],
  tolerance: number,
  { history }: { history?: History } = {},
): SewReport {
  if (!(tolerance > 0 && Number.isFinite(tolerance))) throw new RangeError('sew tolerance must be positive');
  const input = [...new Set(faces.flatMap((f) => (f instanceof Body ? f.faces : [f])))];
  if (!input.length) throw new RangeError('sew needs at least one face');

  // Vertices within the tolerance of each other, joined (through a grid of tolerance-sized cells).
  const vertices: Vertex[] = [],
    index = new Map<Vertex, number>();
  for (const f of input)
    for (const l of f.loops)
      for (const c of l.coedges)
        for (const v of [c.edge.start, c.edge.end])
          if (!index.has(v)) {
            index.set(v, vertices.length);
            vertices.push(v);
          }
  const parent = vertices.map((_, i) => i),
    root = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    },
    cell = (p: readonly number[]) => p.map((x) => Math.floor(x / tolerance)),
    grid = new Map<string, number[]>();
  vertices.forEach((v, i) => {
    const [x, y, z] = cell(v.point);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? [])
            if (distance(v.point, vertices[j].point) <= tolerance) parent[root(i)] = root(j);
    const key = `${x},${y},${z}`;
    grid.set(key, [...(grid.get(key) ?? []), i]);
  });
  const clusters = new Map<number, number[]>();
  vertices.forEach((_, i) => {
    const r = root(i);
    clusters.set(r, [...(clusters.get(r) ?? []), i]);
  });
  const joinedVertex = new Map<number, Vertex>(),
    merged: { vertices: Name[]; gap: number }[] = [],
    chained: ValidityProblem[] = [];
  for (const [r, members] of clusters) {
    const points = members.map((i) => vertices[i].point),
      mean = scale(
        points.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]),
        1 / points.length,
      ) as XYZ,
      at = members.length === 1 ? vertices[members[0]].point : mean,
      gap = Math.max(...points.map((p) => distance(p, at))),
      v = new Vertex(
        vertices[members[0]].name,
        at,
        Math.max(...members.map((i) => vertices[i].tolerance + distance(vertices[i].point, at))),
      );
    joinedVertex.set(r, v);
    if (members.length > 1) merged.push({ vertices: members.map((i) => vertices[i].name), gap });
    // Joined through a chain of neighbours, a vertex can move more than the tolerance: not a gap sewing may close.
    if (gap > tolerance)
      chained.push({
        name: v.name,
        problem: `${members.length} vertices within the tolerance of their neighbours spread ${gap.toExponential(2)} m from where they meet, more than the tolerance`,
      });
  }
  const vertexOf = (v: Vertex) => root(index.get(v)!);

  // The faces' loops, over edges with the joined vertices. An edge whose two ends became one vertex, and that was not
  // closed, was shorter than the tolerance: it is dropped.
  const sewn = new Map<Edge, Sewn>(),
    dropped: Name[] = [];
  let loose: LooseFace[] = input.map((face) => ({
    name: face.name,
    face,
    loops: face.loops.map((l) => {
      const uses: Use[] = [];
      for (const c of l.coedges) {
        let e = sewn.get(c.edge);
        if (!e) {
          const start = vertexOf(c.edge.start),
            end = vertexOf(c.edge.end);
          e = {
            name: c.edge.name,
            curve: c.edge.curve,
            sameSense: c.edge.sameSense,
            start,
            end,
            closed: c.edge.closed,
            tolerance: c.edge.tolerance,
            uses: [],
          };
          sewn.set(c.edge, e);
          if (start === end && !e.closed) dropped.push(e.name);
        }
        if (e.start === e.end && !e.closed) continue;
        const use = { edge: e, forward: c.forward };
        e.uses.push(use);
        uses.push(use);
      }
      return uses;
    }),
  }));
  // A face whose loops all lost their edges was a sliver within the tolerance; a loop that did, a hole of one.
  loose = loose.filter((f) => {
    const kept = f.loops.filter((l) => l.length);
    if (f.face.loops.length && !kept.length) {
      dropped.push(f.name);
      return false;
    }
    f.loops = kept;
    return true;
  });
  const probe = (e: Sewn): Edge =>
    (e.probe ??= new Edge(e.name, e.curve, joinedVertex.get(e.start)!, joinedVertex.get(e.end)!, e.sameSense));
  const edgesNow = () => [...new Set(loose.flatMap((f) => f.loops.flatMap((l) => l.map((u) => u.edge))))];

  // One edge against two: an edge used once whose curve passes within the tolerance of a vertex of another edge used
  // once is split there, so the pieces can each meet an edge.
  const split: { edge: Name; into: Name[] }[] = [];
  {
    const free = edgesNow().filter((e) => e.uses.length === 1),
      ends = [...new Set(free.flatMap((e) => [e.start, e.end]))];
    for (const e of free) {
      if (e.closed) continue;
      const p = probe(e),
        c = curveEvaluator(e.curve),
        ts = edgeParameters(p, 16),
        [t0, t1] = [ts[0], ts[16]],
        lo = Math.min(t0, t1),
        hi = Math.max(t0, t1),
        points = ts.map((t) => c.at(t).slice(0, 3)),
        step = 2 * Math.max(...points.slice(1).map((q, k) => distance(q, points[k]))),
        cuts: { t: number; vertex: number }[] = [];
      for (const v of ends) {
        if (v === e.start || v === e.end) continue;
        const q = joinedVertex.get(v)!.point;
        // Nearest sample first, then onto the curve from there.
        let best = 0;
        points.forEach((s, k) => {
          if (distance(s, q) < distance(points[best], q)) best = k;
        });
        // Every point of the curve lies within a step (twice the longest chord, for curvature) of a sample.
        if (distance(points[best], q) > step + tolerance) continue;
        let t = c.parameter(q, ts[best]);
        if (c.period) t = nearest(t, ts[best], c.period);
        const margin = 1e-9 * (hi - lo);
        if (!(t > lo + margin && t < hi - margin)) continue;
        if (distance(c.at(t), q) <= tolerance) cuts.push({ t, vertex: v });
      }
      if (!cuts.length) continue;
      cuts.sort((a, b) => (t1 >= t0 ? a.t - b.t : b.t - a.t));
      const chain = [e.start, ...cuts.map((x) => x.vertex), e.end],
        pieces: Sewn[] = chain.slice(1).map((end, k) => ({
          name: `${e.name}:${k}`,
          curve: e.curve,
          sameSense: e.sameSense,
          start: chain[k],
          end,
          closed: false,
          tolerance: e.tolerance,
          uses: [],
        }));
      split.push({ edge: e.name, into: pieces.map((x) => x.name) });
      for (const f of loose)
        f.loops = f.loops.map((l) =>
          l.flatMap((u) => {
            if (u.edge !== e) return [u];
            const run = u.forward ? pieces : [...pieces].reverse();
            return run.map((piece) => {
              const use = { edge: piece, forward: u.forward };
              piece.uses.push(use);
              return use;
            });
          }),
        );
      e.uses = [];
    }
  }

  // Edges used once, between the same two vertices, whose curves lie within the tolerance of each other: one edge.
  const joined: { edges: [Name, Name]; gap: number }[] = [],
    problems: ValidityProblem[] = [...chained];
  {
    const byEnds = new Map<string, Sewn[]>();
    for (const e of edgesNow())
      if (e.uses.length === 1) {
        const key = e.start < e.end ? `${e.start},${e.end}` : `${e.end},${e.start}`;
        byEnds.set(key, [...(byEnds.get(key) ?? []), e]);
      }
    for (const group of byEnds.values()) {
      if (group.length < 2) continue;
      const matches = new Map<Sewn, { other: Sewn; gap: number }[]>(group.map((e) => [e, []]));
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const gap = Math.max(deviation(probe(group[i]), probe(group[j])), deviation(probe(group[j]), probe(group[i])));
          if (gap <= tolerance) {
            matches.get(group[i])!.push({ other: group[j], gap });
            matches.get(group[j])!.push({ other: group[i], gap });
          }
        }
      for (const [a, list] of matches) {
        if (list.length > 1) {
          problems.push({
            name: a.name,
            problem: `lies along ${list.length} other edges (${list.map((m) => m.other.name).join(', ')}); left open, as an edge of a solid joins 2 faces`,
          });
          continue;
        }
        if (list.length !== 1 || !a.uses.length) continue;
        const { other: b, gap } = list[0];
        if (matches.get(b)!.length !== 1 || !b.uses.length) continue;
        // b's uses move to a, the way round a runs.
        const same = a.closed ? sameWay(probe(a), probe(b)) : a.start === b.start;
        for (const u of b.uses) {
          u.edge = a;
          u.forward = u.forward === same;
          a.uses.push(u);
        }
        b.uses = [];
        a.tolerance = Math.max(a.tolerance, b.tolerance, gap);
        joined.push({ edges: [a.name, b.name], gap });
      }
    }
  }

  // Faces turned so each shared edge is run both ways; a shell whose faces cannot agree (one-sided) is reported.
  const faceOf = new Map<Use, number>();
  loose.forEach((f, i) => f.loops.forEach((l) => l.forEach((u) => faceOf.set(u, i))));
  const flip = loose.map(() => false),
    shellOf = loose.map(() => -1),
    shells: number[][] = [];
  let oneSided = false;
  loose.forEach((_, start) => {
    if (shellOf[start] >= 0) return;
    const members = [start],
      s = shells.length;
    shellOf[start] = s;
    for (let k = 0; k < members.length; k++) {
      const i = members[k];
      for (const l of loose[i].loops)
        for (const u of l)
          for (const w of u.edge.uses) {
            const j = faceOf.get(w)!;
            if (w === u) continue;
            // Run opposite ways once each face's turn is applied: j turns when it runs the edge the way i now does.
            const want = w.forward === (u.forward !== flip[i]);
            if (shellOf[j] < 0) {
              shellOf[j] = s;
              flip[j] = want;
              members.push(j);
            } else if (want !== flip[j] && !oneSided) {
              oneSided = true;
              problems.push({ name: u.edge.name, problem: 'the faces round it cannot agree on a side (a one-sided surface)' });
            }
          }
    }
    shells.push(members);
  });

  // The body: each connected set of faces one shell; a closed shell turned to face out.
  const closedShells = shells.map((members) =>
    members.every((i) => loose[i].loops.every((l) => l.every((u) => u.edge.uses.length === 2))),
  );
  const allClosed = shells.length > 0 && !oneSided && closedShells.every(Boolean) && !problems.length,
    body = new Body(name, allClosed ? 'solid' : 'sheet'),
    edgeOf = new Map<Sewn, Edge>(),
    finalEdge = (e: Sewn) => {
      let x = edgeOf.get(e);
      if (!x) {
        x = new Edge(e.name, e.curve, joinedVertex.get(e.start)!, joinedVertex.get(e.end)!, e.sameSense, e.tolerance);
        edgeOf.set(e, x);
      }
      return x;
    },
    build = (i: number, turned: boolean) => {
      const f = loose[i],
        face = new Face(f.name, f.face.surface, f.face.sense !== turned);
      for (const l of f.loops) {
        if (!l.length) continue;
        const loop = face.loop(),
          run = turned ? [...l].reverse() : l;
        for (const u of run) loop.use(finalEdge(u.edge), u.forward !== turned);
      }
      return face;
    };
  const flipped: Name[] = [];
  // A shell turned over: its faces built again the other way (their first build's uses let go).
  const turnOver = (members: number[], faces: Face[]) => {
    const old = new Set(faces);
    for (const e of edgeOf.values()) {
      const keep = e.coedges.filter((c) => !old.has(c.loop.face));
      e.coedges.length = 0;
      e.coedges.push(...keep);
    }
    for (const i of members) flip[i] = !flip[i];
    return members.map((i) => build(i, flip[i]));
  };
  const built = shells.map((members, s) => {
    const faces = members.map((i) => build(i, flip[i]));
    // A closed shell enclosing negative volume faces in: turned over.
    return closedShells[s] && !oneSided && enclosedVolume(faces) < 0 ? turnOver(members, faces) : faces;
  });
  // Closed shells nested in others: a shell inside an odd number of others is a cavity of the innermost one round it
  // that is not a cavity itself (a shell inside a cavity is a solid of its own there), turned to face into the cavity.
  const around = shells.map((): number[] => []),
    cavity = shells.map(() => false);
  if (allClosed && shells.length > 1) {
    const uv = new Map<Face, FaceUV>(),
      uvOf = (f: Face) => {
        let x = uv.get(f);
        if (!x) uv.set(f, (x = new FaceUV(f)));
        return x;
      },
      corners = built.flat().flatMap((f) =>
        f.loops.length
          ? f.loops.flatMap((l) => l.coedges.map((c) => c.start.point))
          : [f.surface.kind === 'spline' ? f.surface.points[0] : f.surface.frame.origin],
      ),
      box = boxOf(corners),
      radii = built.flat().map((f) => {
        const s = f.surface;
        return s.kind === 'sphere' || s.kind === 'cylinder' || s.kind === 'cone'
          ? s.radius
          : s.kind === 'torus'
            ? s.major + s.minor
            : 0;
      }),
      reach = 4 * (Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) + 2 * Math.max(0, ...radii)) + tolerance,
      // A point of a shell: a vertex, or a point of a face with no edges (a whole sphere or torus).
      pointOf = (faces: Face[]): XYZ => {
        for (const f of faces) for (const l of f.loops) for (const c of l.coedges) return c.start.point;
        return surfaceEvaluator(faces[0].surface).at(0, 0).slice(0, 3) as XYZ;
      },
      // Inside the faces when most of three rays from it cross them an odd number of times.
      inside = (p: XYZ, faces: Face[]) => {
        let odd = 0;
        for (const direction of RAYS) {
          const line: CurveDef = { kind: 'line', origin: p, direction },
            c = curveEvaluator(line);
          let crossings = 0;
          for (const g of faces)
            for (const t of curveSurfaceCrossings(line, g.surface, 0, reach))
              if (uvOf(g).contains(c.at(t).slice(0, 3) as XYZ)) crossings++;
          if (crossings % 2) odd++;
        }
        return odd >= 2;
      };
    built.forEach((faces, i) => {
      const p = pointOf(faces);
      built.forEach((others, j) => {
        if (j !== i && inside(p, others)) around[i].push(j);
      });
      cavity[i] = around[i].length % 2 === 1;
    });
    built.forEach((faces, i) => {
      if (cavity[i]) built[i] = turnOver(shells[i], faces);
    });
  }
  const bodyShells = built.map((faces, s) => {
    for (const i of shells[s]) if (flip[i]) flipped.push(loose[i].name);
    const shell = body.shell();
    for (const f of faces) shell.add(f);
    return shell;
  });
  bodyShells.forEach((shell, i) => {
    if (!cavity[i]) return;
    shell.outer = bodyShells[
      around[i].filter((j) => !cavity[j]).sort((x, y) => around[y].length - around[x].length)[0]
    ];
  });
  // Edges and vertices take the gaps they closed as their tolerance (half again, as on import), up to the tolerance.
  measureTolerances(body, tolerance);

  // What stayed open, and how far each open edge is from the nearest other one.
  const open: { edge: Name; nearest?: Name; gap: number }[] = [],
    loneEdges = [...edgeOf.entries()].filter(([, e]) => e.coedges.length === 1);
  for (const [s, e] of loneEdges) {
    let best: { edge: Name; gap: number } | undefined;
    const mid = midpoint(e);
    const near = loneEdges
      .filter(([, o]) => o !== e)
      .map(([os, o]) => ({ os, o, d: distance(mid, midpoint(o)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    for (const { o } of near) {
      const gap = Math.max(deviation(e, o), deviation(o, e));
      if (!best || gap < best.gap) best = { edge: o.name, gap };
    }
    open.push(best ? { edge: s.name, nearest: best.edge, gap: best.gap } : { edge: s.name, gap: Infinity });
  }

  let closed = body.kind === 'solid' && !problems.length;
  if (closed) {
    const found = checkBody(body);
    if (found.length) {
      problems.push(...found);
      closed = false;
    }
  }
  if (!closed && body.kind === 'solid') {
    // Never a solid that is not one: the same faces as a sheet.
    const sheet = new Body(name, 'sheet');
    for (const sh of body.shells) {
      const shell = sheet.shell();
      for (const f of [...sh.faces]) shell.add(f);
    }
    return finish(sheet);
  }
  return finish(body);

  function finish(result: Body): SewReport {
    history?.record({
      operation: name,
      generated: [],
      modified: [
        ...joined.map((j) => [j.edges[1], j.edges[0]] as const),
        ...split.flatMap((s) => s.into.map((to) => [s.edge, to] as const)),
      ],
      deleted: dropped,
    });
    return {
      body: result,
      closed: closed && result.kind === 'solid',
      joined,
      merged,
      dropped,
      split,
      open,
      flipped,
      problems,
    };
  }
}

/** The largest distance from points along edge `a` to the stretch of edge `b` between its ends. */
function deviation(a: Edge, b: Edge): number {
  const ca = curveEvaluator(a.curve),
    cb = curveEvaluator(b.curve),
    sb = edgeParameters(b, 16),
    lo = Math.min(sb[0], sb[16]),
    hi = Math.max(sb[0], sb[16]),
    pb = sb.map((t) => cb.at(t).slice(0, 3));
  let worst = 0;
  for (const t of edgeParameters(a, 8)) {
    const p = ca.at(t).slice(0, 3);
    let k = 0;
    pb.forEach((q, i) => {
      if (distance(q, p) < distance(pb[k], p)) k = i;
    });
    let s = cb.parameter(p, sb[k]);
    if (cb.period) s = nearest(s, sb[k], cb.period);
    s = Math.min(hi, Math.max(lo, s));
    worst = Math.max(worst, distance(cb.at(s), p));
  }
  return worst;
}

/** Whether two closed edges along one curve run the same way round (their directions of travel at a shared point). */
function sameWay(a: Edge, b: Edge): boolean {
  const ca = curveEvaluator(a.curve),
    cb = curveEvaluator(b.curve),
    ta = edgeParameters(a, 4),
    tb = edgeParameters(b, 16),
    t = ta[1],
    p = ca.at(t),
    da = scale(p.slice(3), Math.sign(ta[4] - ta[0]) || 1),
    pb = tb.map((x) => cb.at(x));
  let k = 0;
  pb.forEach((q, i) => {
    if (distance(q, p) < distance(pb[k], p)) k = i;
  });
  const s = cb.parameter(p.slice(0, 3), tb[k]),
    db = scale(cb.at(s).slice(3), Math.sign(tb[16] - tb[0]) || 1);
  return dot(da, db) > 0;
}

/** The point halfway along an edge. */
function midpoint(e: Edge): XYZ {
  const ts = edgeParameters(e, 2);
  return curveEvaluator(e.curve).at(ts[1]).slice(0, 3) as XYZ;
}

/** The box of some points: min x, y, z then max x, y, z. */
function boxOf(points: readonly (readonly number[])[]): number[] {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  return [...lo, ...hi];
}
