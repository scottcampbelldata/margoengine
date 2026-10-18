// Fillets and chamfers built in place, for the common case: straight edges between planar faces, each end of a blended
// edge at a corner of three planar faces where the blend
// - runs out through the third face (the free end), which gains the blend's cross-section;
// - meets one more blended edge sharing a face, mirror images of each other across the mitre plane between them (the
//   two blends meet in that plane);
// - meets two more at right angles, all convex, rounded with one radius (a ball rounds the corner).
// And full circles where a plane meets a coaxial cylinder (a boss top, a hole rim, a boss on a plate), the circle a loop
// of its own in the plane and the cylinder's seam line the only other edge at its vertex.
// The two faces of each edge are set back to the blend's tangent (or bevel) lines, or circles, the edges beside them
// shortened, and the new faces (a cylinder or plane along a straight edge, a torus or cone round a circle, a sphere at
// a ball corner) put in between, without the Booleans' search. Anything else, or a result whose planar faces would not
// be simple loops or which is not a valid solid, gives undefined, and the Booleans build it instead.
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import type { Blend, Selected } from './blend.js';
import { distanceGradient } from './distance.js';
import { curveEvaluator, frameOf, type CurveDef, type SurfaceDef } from './geometry.js';
import { Body, Edge, Face, type History, type Loop, type Name, type Shell, Vertex } from './topology.js';
import { edgeParameters, validateBody } from './validate.js';

/** The unit direction along an edge away from one of its vertices. */
export function away(edge: Edge, v: Vertex): XYZ {
  const other = edge.start === v ? edge.end : edge.start;
  return unit(sub(other.point, v.point))!;
}

/** A planar face's normal out of its solid. */
export function outward(f: Face): XYZ {
  if (f.surface.kind !== 'plane') throw new RangeError(`${f.name}: not planar`);
  const z = f.surface.frame.z;
  return f.sense ? z : scale(z, -1);
}

/** Where the line through p along d meets the plane through o with normal n (undefined when they are parallel). */
function meetPlane(p: XYZ, d: XYZ, o: XYZ, n: XYZ): XYZ | undefined {
  const den = dot(d, n);
  return Math.abs(den) < 1e-12 ? undefined : add(p, scale(d, dot(sub(o, p), n) / den));
}

/** The short circular arc about c from p to q (anticlockwise about its frame z). */
const arc = (c: XYZ, p: XYZ, q: XYZ, radius: number): CurveDef => ({
  kind: 'circle',
  frame: frameOf(c, cross(sub(p, c), sub(q, c)), sub(p, c)),
  radius,
});

/** One end of a blended edge: its new vertex in each of the edge's two faces, and the edge the blend ends in. */
interface End {
  readonly at: Map<Face, Vertex>;
  readonly curve: Edge;
}

/**
 * The blend of `selected` edges of `body` built in place (see above), or undefined when it is not that case. `balls`
 * holds the corners a ball rounds, with the ball's centre.
 */
export function setBack(
  name: Name,
  body: Body,
  selected: readonly Selected[],
  how: Blend,
  balls: ReadonlyMap<Vertex, XYZ>,
  history?: History,
): Body | undefined {
  const straight = selected.filter((s) => s.edge.curve.kind === 'line'),
    circles = selected.filter((s) => s.edge.curve.kind === 'circle');
  if (straight.length + circles.length !== selected.length) return undefined;
  const fillet = how.kind === 'fillet',
    r = fillet ? how.radius : 0,
    edgesAt = new Map<Vertex, Edge[]>(),
    blended = new Map<Edge, Selected>(selected.map((s) => [s.edge, s])),
    at = new Map<Vertex, Selected[]>(),
    generated: [Name, Name[]][] = [];
  for (const e of body.edges)
    for (const v of e.closed ? [e.start] : [e.start, e.end]) edgesAt.set(v, [...(edgesAt.get(v) ?? []), e]);
  for (const s of selected) for (const v of [s.edge.start, s.edge.end]) at.set(v, [...(at.get(v) ?? []), s]);
  let size = 0;
  for (const v of body.vertices) size = Math.max(size, length(v.point));
  const tiny = 1e-9 * Math.max(size, 1e-6),
    vertexName = (...faces: Face[]) => `${name}/vertex:${faces.map((f) => f.name).join('|')}`,
    edge = (a: Face, b: Face, curve: CurveDef, start: Vertex, end: Vertex) => {
      const n = `${name}/edge:${a.name}|${b.name}`;
      generated.push([n, [a.name, b.name]]);
      return new Edge(n, curve, start, end);
    };

  // Each blended edge: its direction, how far its faces are set back, its new face.
  const along = new Map<Selected, { d: XYZ; set: number; face: Face; axis: XYZ }>();
  for (const s of straight) {
    const p0 = s.edge.start.point,
      d = unit(sub(s.edge.end.point, p0))!,
      b = unit(add(s.u1, s.u2))!,
      set = fillet ? r / Math.tan(s.angle / 2) : how.distance,
      // The rounding's axis (its circle's centre) lies on the bisector; the seam of its cylinder faces away from it.
      axis = add(p0, scale(b, r / Math.sin(s.angle / 2)));
    let surface: SurfaceDef;
    if (fillet) surface = { kind: 'cylinder', frame: frameOf(axis, d, b), radius: r };
    else {
      // The bevel faces the edge it replaces at a convex edge, away from it at a concave one.
      const n = unit(cross(d, sub(s.u2, s.u1)))!;
      surface = {
        kind: 'plane',
        frame: frameOf(add(p0, scale(s.u1, set)), dot(n, b) > 0 === s.convex ? scale(n, -1) : n, d),
      };
    }
    // A convex rounding has the material on its axis's side, a concave one away from it.
    const face = new Face(`${name}:${s.name}/face:${fillet ? 'round' : 'bevel'}`, surface, !fillet || s.convex);
    generated.push([face.name, [s.name]]);
    along.set(s, { d, set, face, axis });
  }
  /** The blend's tangent (or bevel) line on face f of edge s: a point on it and its direction. */
  const tangent = (s: Selected, f: Face): [XYZ, XYZ] => {
    const { d, set } = along.get(s)!;
    return [add(s.edge.start.point, scale(f === s.f1 ? s.u1 : s.u2, set)), d];
  };

  // --- the ends ------------------------------------------------------------------------------------------------------
  /** Edges of the body met at a blended edge's end move their end there to the new vertex. */
  const trims = new Map<Edge, Map<Vertex, Vertex>>(),
    trim = (e: Edge, v: Vertex, to: Vertex) => trims.set(e, (trims.get(e) ?? new Map()).set(v, to));
  /** The arc (or line) a free end adds to the third face, after the coedge ending at the corner. */
  const freeEnds = new Map<Vertex, { face: Face; curve: Edge }>(),
    ballFaces = new Map<Vertex, Face>(),
    touches = new Map<Vertex, Map<Face, Vertex>>(),
    mitres = new Map<Vertex, { h: Vertex; k: Vertex; curve: Edge }>();
  const facesAt = (v: Vertex) => [...new Set(edgesAt.get(v)!.flatMap((e) => e.coedges.map((c) => c.loop.face)))];
  const endOf = (s: Selected, v: Vertex): End | undefined => {
    const edges = edgesAt.get(v)!,
      faces = facesAt(v);
    if (edges.length !== 3 || faces.length !== 3 || faces.some((f) => f.surface.kind !== 'plane')) return undefined;
    const { d, face: round, axis } = along.get(s)!,
      list = at.get(v)!,
      inFace = (f: Face) => edges.find((e) => e !== s.edge && e.coedges.some((c) => c.loop.face === f));

    // A ball: the round meets it in a quarter circle about its centre, between the points it touches the two faces.
    const centre = balls.get(v);
    if (centre) {
      let ball = ballFaces.get(v);
      if (!ball) {
        const dirs = list.map((x) => away(x.edge, v)),
          x = dot(cross(dirs[0], dirs[1]), dirs[2]) < 0 ? dirs[1] : dirs[0],
          frame = frameOf(centre, add(add(dirs[0], dirs[1]), dirs[2]), x);
        ball = new Face(`${name}:ball:${v.name}/face:surface`, { kind: 'sphere', frame, radius: r }, true);
        generated.push([ball.name, list.map((x) => x.name)]);
        ballFaces.set(v, ball);
        touches.set(v, new Map());
      }
      const touch = (f: Face) => {
        const known = touches.get(v)!;
        let t = known.get(f);
        if (!t) {
          t = new Vertex(`${name}:ball:${v.name}/vertex:${f.name}`, add(centre, scale(outward(f), r)));
          known.set(f, t);
        }
        return t;
      };
      const a = touch(s.f1),
        b = touch(s.f2);
      return {
        at: new Map([
          [s.f1, a],
          [s.f2, b],
        ]),
        curve: edge(round, ball, arc(centre, a.point, b.point, r), a, b),
      };
    }

    // A free end: the blend's cross-section in the third face, which must be square to the edge for a rounding.
    if (list.length === 1) {
      const g = faces.find((f) => f !== s.f1 && f !== s.f2)!,
        k1 = inFace(s.f1),
        k2 = inFace(s.f2),
        n = outward(g);
      if (!k1 || !k2 || k1.curve.kind !== 'line' || k2.curve.kind !== 'line') return undefined;
      if (fillet && Math.abs(dot(d, n)) < 1 - 1e-9) return undefined;
      const p1 = meetPlane(...tangent(s, s.f1), v.point, n),
        p2 = meetPlane(...tangent(s, s.f2), v.point, n),
        c = meetPlane(axis, d, v.point, n);
      if (!p1 || !p2 || !c) return undefined;
      const a = new Vertex(vertexName(s.f1, g, round), p1),
        b = new Vertex(vertexName(s.f2, g, round), p2),
        curve = edge(
          g,
          round,
          fillet ? arc(c, p1, p2, r) : { kind: 'line', origin: p1, direction: unit(sub(p2, p1))! },
          a,
          b,
        );
      trim(k1, v, a);
      trim(k2, v, b);
      freeEnds.set(v, { face: g, curve });
      return {
        at: new Map([
          [s.f1, a],
          [s.f2, b],
        ]),
        curve,
      };
    }

    // A mitre: the blends meet in the plane through the corner holding their shared face's normal and the bisector of
    // the two edges, where the third edge is cut.
    if (list.length !== 2) return undefined;
    const t = list.find((x) => x !== s)!,
      h = [s.f1, s.f2].find((f) => f === t.f1 || f === t.f2);
    if (!h) return undefined;
    const f = s.f1 === h ? s.f2 : s.f1,
      k = edges.find((e) => e !== s.edge && e !== t.edge)!;
    let known = mitres.get(v);
    if (!known) {
      if (k.curve.kind !== 'line' || s.convex !== t.convex || Math.abs(s.angle - t.angle) > 1e-9) return undefined;
      const d1 = away(s.edge, v),
        d2 = away(t.edge, v),
        m = unit(cross(outward(h), add(d1, d2)));
      if (!m) return undefined;
      const mirror = (x: XYZ) => sub(x, scale(m, 2 * dot(x, m))),
        fOther = t.f1 === h ? t.f2 : t.f1;
      if (length(sub(mirror(d1), d2)) > 1e-9 || length(sub(mirror(outward(f)), outward(fOther))) > 1e-9)
        return undefined;
      const ph = meetPlane(...tangent(s, h), v.point, m),
        pk = meetPlane(...tangent(s, f), v.point, m),
        c = meetPlane(axis, d, v.point, m);
      if (!ph || !pk || !c) return undefined;
      const [first, second] = [s, t].sort((x, y) => (x.name < y.name ? -1 : 1)).map((x) => along.get(x)!.face),
        vh = new Vertex(vertexName(h, first, second), ph),
        vk = new Vertex(vertexName(f, fOther, first, second), pk);
      let curve: CurveDef;
      if (fillet) {
        // The rounding's cylinder cut by the mitre plane: an ellipse, its minor axis r across the cylinder's axis.
        const cos = Math.abs(dot(d, m)),
          major = unit(sub(d, scale(m, dot(d, m))))!,
          z = dot(cross(sub(pk, c), sub(ph, c)), m) < 0 ? scale(m, -1) : m;
        curve = { kind: 'ellipse', frame: frameOf(c, z, major), a: r / cos, b: r };
      } else curve = { kind: 'line', origin: pk, direction: unit(sub(ph, pk))! };
      known = { h: vh, k: vk, curve: edge(first, second, curve, vk, vh) };
      mitres.set(v, known);
      trim(k, v, vk);
    }
    return {
      at: new Map([
        [h, known.h],
        [f, known.k],
      ]),
      curve: known.curve,
    };
  };
  const ends = new Map<Selected, [End, End]>();
  for (const s of straight) {
    const e0 = endOf(s, s.edge.start),
      e1 = endOf(s, s.edge.end);
    if (!e0 || !e1) return undefined;
    ends.set(s, [e0, e1]);
  }

  // --- full circles: the plane's circle moves out (a hole's rim) or in (a boss top), the wall's along the axis ---------
  /** The new edges of each blended edge, by the face they bound. */
  const lines = new Map<Selected, Map<Face, Edge>>(),
    rings: {
      face: Face;
      shell: Shell;
      inPlane: Edge;
      onWall: Edge;
      across: Edge;
      planeUse: boolean;
      wallUse: boolean;
    }[] = [];
  for (const s of circles) {
    const e = s.edge,
      v = e.start,
      around = edgesAt.get(v)!,
      seam = around.find((x) => x !== e),
      c1 = e.coedges.find((c) => c.loop.face === s.f1),
      c2 = e.coedges.find((c) => c.loop.face === s.f2);
    if (e.curve.kind !== 'circle' || !e.closed || !c1 || !c2 || c1.loop.coedges.length !== 1) return undefined;
    if (around.length !== 2 || !seam || seam.curve.kind !== 'line' || seam.coedges.some((c) => c.loop.face !== s.f2))
      return undefined;
    const { frame, radius } = e.curve,
      set = fillet ? r : how.distance,
      out = unit(sub(v.point, frame.origin))!,
      grow = dot(s.u1, out) > 0 ? set : -set,
      shift = scale(s.u2, set),
      wallCentre = add(frame.origin, shift),
      p1 = add(v.point, scale(s.u1, set)),
      p2 = add(v.point, shift);
    if (!(radius + grow > tiny)) return undefined;
    let surface: SurfaceDef, meridian: CurveDef, mid: XYZ;
    if (fillet) {
      // A torus about the axis through the rounding's centre circle; a spindle torus (major <= minor) is left out.
      if (!(radius + grow > r)) return undefined;
      const centre = add(add(v.point, scale(s.u1, r)), shift);
      surface = { kind: 'torus', frame: frameOf(wallCentre, frame.z, out), major: radius + grow, minor: r };
      meridian = arc(centre, p1, p2, r);
      mid = sub(centre, scale(unit(add(s.u1, s.u2))!, r));
    } else {
      // A cone from the smaller circle towards the larger, so its angle is positive.
      const [o, z, r0, r1] =
        grow < 0 ? [frame.origin, s.u2, radius + grow, radius] : [wallCentre, scale(s.u2, -1), radius, radius + grow];
      surface = { kind: 'cone', frame: frameOf(o, z, out), radius: r0, angle: Math.atan2(r1 - r0, set) };
      meridian = { kind: 'line', origin: p1, direction: unit(sub(p2, p1))! };
      mid = scale(add(p1, p2), 0.5);
    }
    // The face's normal points to the edge it replaces at a convex edge, away from it at a concave one.
    const face = new Face(
        `${name}:${s.name}/face:${fillet ? 'round' : 'bevel'}`,
        surface,
        dot(distanceGradient(surface, mid), sub(v.point, mid)) > 0 === s.convex,
      ),
      a = new Vertex(vertexName(s.f1, face), p1),
      b = new Vertex(vertexName(s.f2, face), p2),
      inPlane = edge(
        s.f1,
        face,
        { kind: 'circle', frame: frameOf(frame.origin, frame.z, out), radius: radius + grow },
        a,
        a,
      ),
      onWall = edge(s.f2, face, { kind: 'circle', frame: frameOf(wallCentre, frame.z, out), radius }, b, b),
      across = new Edge(`${face.name}/edge:seam`, meridian, a, b);
    // The new circles run the way the old one did, so the plane's and the wall's loops keep their direction.
    inPlane.sameSense = onWall.sameSense = e.sameSense;
    generated.push([face.name, [s.name]], [across.name, [s.name]]);
    trim(seam, v, b);
    lines.set(
      s,
      new Map([
        [s.f1, inPlane],
        [s.f2, onWall],
      ]),
    );
    rings.push({ face, shell: s.f1.shell!, inPlane, onWall, across, planeUse: c1.forward, wallUse: c2.forward });
  }

  // --- edges -----------------------------------------------------------------------------------------------------------
  const vertices = new Map<Vertex, Vertex>(),
    copy = (v: Vertex) => {
      let n = vertices.get(v);
      if (!n) vertices.set(v, (n = new Vertex(v.name, v.point, v.tolerance)));
      return n;
    },
    edges = new Map<Edge, Edge>();
  for (const e of body.edges) {
    if (blended.has(e)) continue;
    const cut = trims.get(e);
    if (cut && (e.curve.kind !== 'line' || e.closed)) return undefined;
    const a = cut?.get(e.start) ?? copy(e.start),
      b = cut?.get(e.end) ?? copy(e.end);
    if (cut) {
      // Shortened, not lengthened or turned round: both ends on the edge, in order.
      const dir = sub(e.end.point, e.start.point),
        len2 = dot(dir, dir),
        t = (p: XYZ) => dot(sub(p, e.start.point), dir) / len2,
        off = (p: XYZ) => length(sub(p, add(e.start.point, scale(dir, t(p)))));
      if (!(t(a.point) >= -1e-9 && t(b.point) <= 1 + 1e-9 && (t(b.point) - t(a.point)) * Math.sqrt(len2) > tiny))
        return undefined;
      if (off(a.point) > 1e3 * tiny || off(b.point) > 1e3 * tiny) return undefined;
    }
    edges.set(e, new Edge(e.name, e.curve, a, b, e.sameSense, e.tolerance));
  }
  for (const s of straight) {
    const [e0, e1] = ends.get(s)!,
      { d, face } = along.get(s)!,
      byFace = new Map<Face, Edge>();
    for (const f of [s.f1, s.f2]) {
      const a = e0.at.get(f)!,
        b = e1.at.get(f)!;
      if (!(dot(sub(b.point, a.point), d) > tiny)) return undefined;
      byFace.set(f, edge(f, face, { kind: 'line', origin: a.point, direction: d }, a, b));
    }
    lines.set(s, byFace);
  }

  // --- faces -----------------------------------------------------------------------------------------------------------
  const out = new Body(name, 'solid'),
    shells = new Map<Shell, Shell>();
  for (const sh of body.shells) shells.set(sh, out.shell());
  for (const [sh, n] of shells) if (sh.outer) n.outer = shells.get(sh.outer);
  for (const f of body.faces) {
    const n = shells.get(f.shell!)!.add(new Face(f.name, f.surface, f.sense));
    for (const loop of f.loops) {
      const l = n.loop();
      for (const c of loop.coedges) {
        const s = blended.get(c.edge);
        l.use(s ? lines.get(s)!.get(f)! : edges.get(c.edge)!, c.forward);
        const free = freeEnds.get(c.end);
        if (free && free.face === f) {
          const reached = l.coedges[l.coedges.length - 1].end;
          l.use(free.curve, free.curve.start === reached);
        }
      }
    }
  }
  for (const { face, shell, inPlane, onWall, across, planeUse, wallUse } of rings) {
    // Round the band: the plane's circle, across, the wall's circle, back; each circle the other way from its face's use.
    shells.get(shell)!.add(face);
    const l = face.loop();
    l.use(inPlane, !planeUse);
    l.use(across, true);
    l.use(onWall, !wallUse);
    l.use(across, false);
  }
  for (const s of straight) {
    const { face } = along.get(s)!,
      [e0, e1] = ends.get(s)!,
      l1 = lines.get(s)!.get(s.f1)!,
      l2 = lines.get(s)!.get(s.f2)!,
      // Each tangent line is used the other way round from its planar face's use (which runs as the edge does there).
      forward = s.edge.coedges.find((c) => c.loop.face === s.f1)!.forward;
    shells.get(s.f1.shell!)!.add(face);
    if (
      !chain(
        face.loop(),
        forward ? [l1, e0.curve, l2, e1.curve] : [l1, e1.curve, l2, e0.curve],
        forward ? l1.end : l1.start,
      )
    )
      return undefined;
  }
  for (const [v, ball] of ballFaces) {
    // Each quarter circle the other way round from its rounding's use.
    const uses = at.get(v)!.map((s) => {
      const curve = ends.get(s)![s.edge.start === v ? 0 : 1].curve;
      return { edge: curve, forward: !curve.coedges[0].forward };
    });
    const order = [uses[0]];
    while (order.length < uses.length) {
      const last = order[order.length - 1],
        reached = last.forward ? last.edge.end : last.edge.start,
        next = uses.find((u) => !order.includes(u) && (u.forward ? u.edge.start : u.edge.end) === reached);
      if (!next) return undefined;
      order.push(next);
    }
    shells.get(at.get(v)![0].f1.shell!)!.add(ball);
    const l = ball.loop();
    for (const u of order) l.use(u.edge, u.forward);
  }
  for (const f of out.faces) if (f.surface.kind === 'plane' && !simplePlanar(f, tiny)) return undefined;
  if (validateBody(out).length) return undefined;
  history?.record({ operation: name, generated, modified: [], deleted: selected.map((s) => s.name) });
  return out;
}

/** Adds `edges` to `loop` end to end from vertex `from`, each the way that continues the chain; false unless it closes. */
function chain(loop: Loop, edges: Edge[], from: Vertex): boolean {
  let reached = from;
  for (const e of edges) {
    const forward = e.start === reached;
    if (!forward && e.end !== reached) return false;
    loop.use(e, forward);
    reached = forward ? e.end : e.start;
  }
  return reached === from;
}

/**
 * Whether a planar face's loops are what a face's should be: one outer loop anticlockwise about the face normal, holes
 * clockwise inside it, and no two of their segments (curves in a few chords) crossing.
 */
function simplePlanar(f: Face, tiny: number): boolean {
  if (f.surface.kind !== 'plane') return true;
  const { origin, x } = f.surface.frame,
    z = outward(f),
    y = cross(z, x),
    loops = f.loops.map((l) => {
      const points: [number, number][] = [];
      for (const c of l.coedges) {
        const ts = edgeParameters(c.edge, c.edge.curve.kind === 'line' ? 1 : 8),
          curve = curveEvaluator(c.edge.curve);
        if (!c.forward) ts.reverse();
        for (let k = 0; k + 1 < ts.length; k++) {
          const p = sub(curve.at(ts[k]).slice(0, 3) as XYZ, origin);
          points.push([dot(p, x), dot(p, y)]);
        }
      }
      return points;
    }),
    area = (p: [number, number][]) =>
      p.reduce((sum, a, i) => {
        const b = p[(i + 1) % p.length];
        return sum + a[0] * b[1] - a[1] * b[0];
      }, 0) / 2,
    areas = loops.map(area),
    outer = areas.findIndex((a) => a > 0);
  if (outer < 0 || areas.some((a, i) => i !== outer && !(a < 0))) return false;
  const eps = tiny * tiny * 1e6,
    orient = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    side = (v: number) => (v > eps ? 1 : v < -eps ? -1 : 0),
    segments = loops.flatMap((p, li) => p.map((a, i) => ({ a, b: p[(i + 1) % p.length], li, i, n: p.length })));
  for (let i = 0; i < segments.length; i++)
    for (let j = i + 1; j < segments.length; j++) {
      const s = segments[i],
        t = segments[j];
      // Neighbours in one loop share a point.
      if (s.li === t.li && (t.i === s.i + 1 || (s.i === 0 && t.i === s.n - 1))) continue;
      const d1 = side(orient(t.a, t.b, s.a)),
        d2 = side(orient(t.a, t.b, s.b)),
        d3 = side(orient(s.a, s.b, t.a)),
        d4 = side(orient(s.a, s.b, t.b));
      if (d1 * d2 < 0 && d3 * d4 < 0) return false;
    }
  // Each hole inside the outer loop (a point of it: crossings of a ray to +x).
  const ring = loops[outer];
  for (let li = 0; li < loops.length; li++) {
    if (li === outer) continue;
    const [px, py] = loops[li][0];
    let inside = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      if (a[1] > py !== b[1] > py && px < a[0] + ((py - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
    }
    if (!inside) return false;
  }
  return true;
}
