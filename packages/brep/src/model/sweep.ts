// Sweeping a closed planar profile along a path of lines and arcs. The profile is carried along the path in its
// rotation-minimising frame: along a line it is translated, round an arc it is turned about the arc's axis (on a path
// of lines and circular arcs the rotation-minimising frame is exactly this: it does not spin about the tangent). Every
// face is analytic: a line piece makes planes and cylinders, as an extrusion does; an arc piece makes planes,
// cylinders, cones, spheres and tori, as a revolution does. The profile's area A then sweeps out A times the length of
// the path its centroid follows (Pappus and Guldin), the closed form the tests hold the solids to.
//
// A sweep that would cross itself is refused with a RangeError, by name: an arc that curves tighter than the profile
// reaches towards its axis, and two pieces of the path whose tubes could meet (judged conservatively: every point of
// the solid lies within the profile's reach of the path, so two pieces farther apart than twice the reach cannot meet,
// and neither can two pieces a plane between them keeps apart).
import { add, cross, dot, length, modelSize, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import {
  fmt,
  profileSize,
  refuseSelfContact,
  reversed,
  signedArea,
  sweepOf,
  type Profile,
  type ProfileSegment,
} from './build.js';
import { frameOf, surfaceEvaluator, type CurveDef, type SurfaceDef } from './geometry.js';
import { Body, Edge, Face, Vertex, type History, type Name } from './topology.js';

/**
 * One piece of a path: a line to `to`, or an arc to `to` about `center`, turning counter-clockwise about `axis` (by
 * default the shorter way round; an arc of half a turn or a whole one needs its axis).
 */
export interface PathSegment {
  readonly kind: 'line' | 'arc';
  readonly to: XYZ;
  readonly center?: XYZ;
  readonly axis?: XYZ;
  /** The name the faces swept along this piece take after the profile segment's name. */
  readonly name?: Name;
}

/** A path from `start`, piece by piece, its tangent continuous where one piece meets the next. */
export interface Path {
  readonly name: Name;
  readonly start: XYZ;
  readonly segments: readonly PathSegment[];
}

/** A rigid motion x -> R x + t, R row-major. */
interface Rigid {
  readonly r: readonly number[];
  readonly t: XYZ;
}

const IDENTITY: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const turnV = (m: Rigid, v: readonly number[]): XYZ => [
  m.r[0] * v[0] + m.r[1] * v[1] + m.r[2] * v[2],
  m.r[3] * v[0] + m.r[4] * v[1] + m.r[5] * v[2],
  m.r[6] * v[0] + m.r[7] * v[1] + m.r[8] * v[2],
];
const moveP = (m: Rigid, p: readonly number[]): XYZ => add(turnV(m, p), m.t);
/** a after b. */
function compose(a: Rigid, b: Rigid): Rigid {
  const r: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r.push(a.r[i * 3] * b.r[j] + a.r[i * 3 + 1] * b.r[3 + j] + a.r[i * 3 + 2] * b.r[6 + j]);
  return { r, t: moveP(a, b.t) };
}
/** Turning by `angle` counter-clockwise about the line through `c` along unit `a` (Rodrigues). */
function rotation(c: XYZ, a: XYZ, angle: number): Rigid {
  const cs = Math.cos(angle),
    sn = Math.sin(angle),
    k = 1 - cs,
    [x, y, z] = a,
    r = [
      cs + x * x * k,
      x * y * k - z * sn,
      x * z * k + y * sn,
      y * x * k + z * sn,
      cs + y * y * k,
      y * z * k - x * sn,
      z * x * k - y * sn,
      z * y * k + x * sn,
      cs + z * z * k,
    ];
  const m = { r, t: [0, 0, 0] as XYZ };
  return { r, t: sub(c, turnV(m, c)) };
}
const translation = (d: XYZ): Rigid => ({ r: IDENTITY.r, t: d });

function moveProfile(p: Profile, m: Rigid): Profile {
  return {
    ...p,
    start: moveP(m, p.start),
    normal: turnV(m, p.normal),
    segments: p.segments.map((s) => ({ ...s, to: moveP(m, s.to), center: s.center && moveP(m, s.center) })),
  };
}

/** A piece of the path, resolved. */
interface Piece {
  readonly kind: 'line' | 'arc';
  readonly name: Name;
  readonly from: XYZ;
  readonly to: XYZ;
  /** Unit tangents at its two ends. */
  readonly t0: XYZ;
  readonly t1: XYZ;
  /** Line: its length. Arc: its centre, unit axis, radius and turn (0 to 2 pi]. */
  readonly length: number;
  readonly center?: XYZ;
  readonly axis?: XYZ;
  readonly radius?: number;
  readonly turn?: number;
  /** Which arc of the path this piece is (pieces of one arc never meet each other). */
  readonly source: number;
}

/** The motion that carries a section from the start of `piece` along it by the fraction `f`. */
function along(piece: Piece, f: number): Rigid {
  return piece.kind === 'line'
    ? translation(scale(piece.t0, piece.length * f))
    : rotation(piece.center!, piece.axis!, piece.turn! * f);
}

/** The path's pieces with their ends and tangents; throws for a degenerate piece or a corner. */
function resolvePath(path: Path, tolerance: number): Piece[] {
  if (!path.segments.length) throw new RangeError(`path ${path.name} has no segments; give the path at least one line or arc`);
  const pieces: Piece[] = [];
  let at = path.start;
  path.segments.forEach((s, k) => {
    const name = s.name ?? `p${k}`;
    if (s.kind === 'line') {
      const d = sub(s.to, at),
        l = length(d);
      if (!(l > tolerance)) throw new RangeError(`path ${path.name}: line ${name} has no length; remove the line or move its end`);
      const t = scale(d, 1 / l);
      pieces.push({ kind: 'line', name, from: at, to: s.to, t0: t, t1: t, length: l, source: k });
    } else {
      if (!s.center) throw new RangeError(`path ${path.name}: arc ${name} needs a center`);
      const c = s.center,
        a0 = sub(at, c),
        a1 = sub(s.to, c),
        r = length(a0);
      if (!(r > tolerance) || Math.abs(length(a1) - r) > tolerance)
        throw new RangeError(`path ${path.name}: arc ${name} does not keep one radius about its center`);
      const axis = s.axis ? unit(s.axis) : unit(cross(a0, a1));
      if (!axis)
        throw new RangeError(`path ${path.name}: arc ${name} needs an axis (its ends are opposite or the same)`);
      if (Math.abs(dot(a0, axis)) > tolerance || Math.abs(dot(a1, axis)) > tolerance)
        throw new RangeError(`path ${path.name}: arc ${name} does not lie in the plane across its axis; give the arc a centre in the plane of its ends`);
      let turn = Math.atan2(dot(cross(a0, a1), axis), dot(a0, a1));
      if (turn <= 0) turn += 2 * Math.PI;
      // Ends within the tolerance of each other: a whole turn.
      if (length(sub(s.to, at)) <= tolerance) turn = 2 * Math.PI;
      const t0 = unit(cross(axis, a0))!,
        t1 = unit(cross(axis, a1))!;
      pieces.push({ kind: 'arc', name, from: at, to: s.to, t0, t1, length: r * turn, center: c, axis, radius: r, turn, source: k });
    }
    at = s.to;
  });
  for (let k = 1; k < pieces.length; k++) {
    const a = pieces[k - 1].t1,
      b = pieces[k].t0;
    if (dot(a, b) <= 0 || length(cross(a, b)) > 1e-9)
      throw new RangeError(
        `path ${path.name} turns a corner at ${fmt(pieces[k].from)}: a sweep needs a path whose tangent is continuous`,
      );
  }
  return pieces;
}

/** Splits arcs into pieces of at most a quarter turn (for the self-crossing test). */
function quarters(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.kind === 'line') {
      out.push(p);
      continue;
    }
    const n = Math.ceil(p.turn! / (Math.PI / 2) - 1e-9),
      step = p.turn! / n;
    for (let i = 0; i < n; i++) {
      const m0 = rotation(p.center!, p.axis!, step * i),
        m1 = rotation(p.center!, p.axis!, step * (i + 1));
      out.push({
        ...p,
        from: moveP(m0, p.from),
        to: moveP(m1, p.from),
        t0: turnV(m0, p.t0),
        t1: turnV(m1, p.t0),
        turn: step,
        length: p.radius! * step,
      });
    }
  }
  return out;
}

/** Points along a piece, at most `step` apart. */
function samples(p: Piece, step: number): XYZ[] {
  const n = Math.min(4096, Math.max(2, Math.ceil(p.length / step)));
  const out: XYZ[] = [];
  for (let i = 0; i <= n; i++) out.push(moveP(along(p, i / n), p.from));
  return out;
}

/** Least and greatest of (x - o) . n over a piece's points (exact: an arc's extremes are found in closed form). */
function spanAlong(p: Piece, o: XYZ, n: XYZ): [number, number] {
  const f = (q: XYZ) => dot(sub(q, o), n);
  if (p.kind === 'line') {
    const a = f(p.from),
      b = f(p.to);
    return [Math.min(a, b), Math.max(a, b)];
  }
  // x(t) = c + r (cos t u + sin t w): f = A cos t + B sin t + C.
  const u = scale(sub(p.from, p.center!), 1 / p.radius!),
    w = cross(p.axis!, u),
    A = p.radius! * dot(u, n),
    B = p.radius! * dot(w, n),
    C = f(p.center!),
    values = [A + C, A * Math.cos(p.turn!) + B * Math.sin(p.turn!) + C];
  const t = Math.atan2(B, A);
  for (const s of [t, t + Math.PI, t - Math.PI, t + 2 * Math.PI])
    if (s > 0 && s < p.turn!) values.push(A * Math.cos(s) + B * Math.sin(s) + C);
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Throws when two pieces of the path could carry the profile into each other. `reach` bounds the distance of every
 * point of a section from its path point; arcs come in pieces of at most a quarter turn, each of which (like a line)
 * lies wholly ahead of the plane across its start and behind the plane across its end.
 */
function refuseSelfCrossing(path: Path, pieces: readonly Piece[], reach: number, closed: boolean, tolerance: number) {
  const q = quarters(pieces),
    n = q.length,
    step = reach / 16,
    pts = q.map((p) => samples(p, step)),
    stepOf = (i: number) => q[i].length / (pts[i].length - 1),
    // Each piece's box (from its samples, grown by half a step): pieces whose boxes are twice the reach apart are.
    boxes = pts.map((list, i) => {
      const lo = [0, 1, 2].map((k) => Math.min(...list.map((p) => p[k])) - stepOf(i) / 2),
        hi = [0, 1, 2].map((k) => Math.max(...list.map((p) => p[k])) + stepOf(i) / 2);
      return { lo, hi };
    }),
    boxGap = (i: number, j: number) =>
      Math.hypot(
        ...[0, 1, 2].map((k) => Math.max(0, boxes[j].lo[k] - boxes[i].hi[k], boxes[i].lo[k] - boxes[j].hi[k])),
      );
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (closed && i === 0 && j === n - 1) continue;
      if (q[i].source === q[j].source && q[i].kind === 'arc') continue;
      // A plane between them: each piece lies between the planes across its two ends, so either plane keeps the other
      // piece's tube away when the other piece's path stays a reach beyond it.
      const apart = (a: Piece, b: Piece) =>
        spanAlong(b, a.to, a.t1)[0] >= reach - tolerance || spanAlong(b, a.from, a.t0)[1] <= -reach + tolerance;
      if (apart(q[i], q[j]) || apart(q[j], q[i]) || boxGap(i, j) > 2 * reach) continue;
      let least = Infinity;
      for (const a of pts[i]) for (const b of pts[j]) least = Math.min(least, length(sub(a, b)));
      // Sampled points are at most half a step from every point of their piece.
      if (least - (stepOf(i) + stepOf(j)) / 2 > 2 * reach) continue;
      throw new RangeError(
        `path ${path.name}: pieces ${q[i].name} and ${q[j].name} come within twice the profile's reach of each other ` +
          `(${(2 * reach).toPrecision(6)}): the sweep could cross itself`,
      );
    }
}

/**
 * Sweeps a closed planar profile of lines and arcs along a path of lines and arcs into a solid named `name`. The
 * profile's plane must pass through the path's start, across the path's tangent there; it is carried along the path
 * in its rotation-minimising frame (translated along lines, turned about the axis of arcs). The solid has a start and
 * an end face (planes) and a side face per profile segment and path piece, named `<piece>/<segment>` (pieces default
 * to p0, p1 and so on, segments to e0, e1 and so on). A path that ends where it starts, along its starting tangent,
 * makes a ring with no end faces.
 *
 * Throws a RangeError for an open, degenerate or self-touching profile, a profile not across the path's start, a path
 * with a corner or a degenerate piece, an arc curving tighter than the profile reaches towards its axis, a profile
 * segment that would turn into an unsupported surface (an arc reaching the axis of a path arc), and pieces of the path
 * close enough for the solid to cross itself (see the file header).
 */
export function sweep(name: Name, profile: Profile, path: Path, { history }: { history?: History } = {}): Body {
  const points0 = [profile.start, ...profile.segments.map((s) => s.to), path.start, ...path.segments.map((s) => s.to)],
    size = Math.max(
      profileSize(profile),
      modelSize(
        points0,
        path.segments.flatMap((s): [XYZ, number][] => (s.kind === 'arc' && s.center ? [[s.center, length(sub(s.to, s.center))]] : [])),
      ),
    ),
    tolerance = 1e-9 * Math.max(size, 1);
  const pieces = resolvePath(path, tolerance),
    T0 = pieces[0].t0;
  let n = unit(profile.normal);
  if (!n) throw new RangeError('profile normal must not be zero');
  if (length(cross(n, T0)) > 1e-9)
    throw new RangeError(`profile ${profile.name} must lie across the path's tangent at its start`);
  if (Math.abs(dot(sub(path.start, profile.start), n)) > tolerance)
    throw new RangeError(`profile ${profile.name} must lie in the plane through the path's start`);
  // The profile counter-clockwise about the path's start tangent, so the side faces face out.
  let p: Profile =
    dot(n, T0) < 0
      ? {
          ...profile,
          normal: T0,
          segments: profile.segments.map((s) => (s.kind === 'arc' ? { ...s, clockwise: !s.clockwise } : s)),
        }
      : { ...profile, normal: T0 };
  n = T0;
  const same = (a: XYZ, b: XYZ) => length(sub(a, b)) <= tolerance;
  if (!p.segments.length || !same(p.segments[p.segments.length - 1].to, p.start))
    throw new RangeError(`profile ${profile.name} does not end where it starts; pass a closed profile that does not cross itself`);
  const area = signedArea(p, n);
  if (Math.abs(area) <= tolerance * tolerance) throw new RangeError(`profile ${profile.name} encloses no area; pass a closed profile that does not cross itself`);
  refuseSelfContact(p, n, tolerance);
  if (area < 0) p = reversed(p);
  for (const s of [p.start, ...p.segments.map((s) => s.to), ...p.segments.flatMap((s) => (s.center ? [s.center] : []))])
    if (Math.abs(dot(sub(s, path.start), n)) > tolerance)
      throw new RangeError(`profile ${profile.name} is not planar; put every point and arc centre of the profile in one plane`);
  const count = p.segments.length,
    pointsOf = (q: Profile) => [q.start, ...q.segments.slice(0, -1).map((s) => s.to)];
  // How far the profile reaches from the path's start (an arc's whole circle bounds it).
  let reach = 0;
  {
    let at = p.start;
    for (const s of p.segments) {
      reach = Math.max(reach, length(sub(at, path.start)));
      if (s.kind === 'arc') reach = Math.max(reach, length(sub(s.center!, path.start)) + length(sub(at, s.center!)));
      at = s.to;
    }
  }
  // Sections at each joint of the path.
  const joints: Rigid[] = [IDENTITY];
  for (const piece of pieces) joints.push(compose(along(piece, 1), joints[joints.length - 1]));
  const m = pieces.length,
    last = pieces[m - 1],
    closed =
      same(last.to, path.start) &&
      length(cross(last.t1, T0)) <= 1e-9 &&
      dot(last.t1, T0) > 0;
  if (closed && !pointsOf(p).every((q) => same(moveP(joints[m], q), q)))
    throw new RangeError(`path ${path.name} closes but turns the profile: its ends would not meet; close the path where the profile can return to its start`);
  const sections = joints.map((j) => moveProfile(p, j));
  // Each arc must keep the whole profile on one side of its axis.
  pieces.forEach((piece, i) => {
    if (piece.kind !== 'arc') return;
    const c = piece.center!,
      x = unit(sub(piece.from, c))!,
      s = sections[i],
      rho = (q: XYZ) => dot(sub(q, c), x);
    let least = Infinity,
      at = s.start;
    for (const g of s.segments) {
      least = Math.min(least, rho(at));
      if (g.kind === 'arc') {
        // The arc's point nearest the axis (towards -x), if the arc passes it: at angle t from a0 towards b0.
        const r = length(sub(at, g.center!)),
          turn = sweepOf(at, g, s.normal),
          a0 = sub(at, g.center!),
          b0 = cross(s.normal, a0),
          towards = Math.atan2(-dot(b0, x), -dot(a0, x));
        let t = Math.sign(turn) * towards;
        while (t < 0) t += 2 * Math.PI;
        if (t <= Math.abs(turn)) least = Math.min(least, rho(g.center!) - r);
      }
      at = g.to;
    }
    if (!(least > tolerance))
      throw new RangeError(
        `path ${path.name}: arc ${piece.name} (radius ${piece.radius!.toPrecision(6)}) curves tighter than the ` +
          `profile reaches towards its axis: the sweep would cross itself; use a larger arc radius or a smaller profile`,
      );
  });
  refuseSelfCrossing(path, pieces, reach, closed, tolerance);

  const body = new Body(name, 'solid'),
    shell = body.shell(),
    segName = (k: number) => p.segments[k].name ?? `e${k}`,
    generated: [Name, Name[]][] = [],
    joinCount = closed ? m : m + 1,
    vertices = sections.slice(0, joinCount).map((s, j) => pointsOf(s).map((q, k) => new Vertex(`${name}/vertex:${j}:${k}`, q))),
    vertex = (j: number, k: number) => vertices[closed ? j % m : j][k % count];
  // Section edges: each profile segment at each joint.
  const sectionEdges = sections.slice(0, joinCount).map((s, j) => {
    const pts = pointsOf(s);
    return s.segments.map((g, k) => {
      const from = pts[k];
      let curve: CurveDef,
        sameSense = true;
      if (g.kind === 'line') curve = { kind: 'line', origin: from, direction: unit(sub(g.to, from))! };
      else {
        curve = { kind: 'circle', frame: frameOf(g.center!, s.normal, sub(from, g.center!)), radius: length(sub(from, g.center!)) };
        sameSense = !g.clockwise;
      }
      return new Edge(`${name}/edge:section:${j}:${segName(k)}`, curve, vertex(j, k), vertex(j, k + 1), sameSense);
    });
  });
  const sectionEdge = (j: number, k: number) => sectionEdges[closed ? j % m : j][k];
  pieces.forEach((piece, i) => {
    const s = sections[i],
      pts = pointsOf(s);
    // Edges along the piece from each profile point.
    const alongEdges = pts.map((q, k) => {
      let curve: CurveDef;
      if (piece.kind === 'line') curve = { kind: 'line', origin: q, direction: piece.t0 };
      else {
        const c = piece.center!,
          a = piece.axis!,
          level = add(c, scale(a, dot(sub(q, c), a)));
        curve = { kind: 'circle', frame: frameOf(level, a, sub(q, level)), radius: length(sub(q, level)) };
      }
      return new Edge(`${name}/edge:along:${piece.name}:${k}`, curve, vertex(i, k), vertex(i + 1, k), true);
    });
    const half = along(piece, 0.5),
      tangentMid = turnV(half, piece.t0);
    s.segments.forEach((g, k) => {
      const from = pts[k],
        to = g.to;
      let surface: SurfaceDef;
      if (piece.kind === 'line') {
        surface =
          g.kind === 'line'
            ? { kind: 'plane', frame: frameOf(from, cross(sub(to, from), piece.t0), sub(to, from)) }
            : { kind: 'cylinder', frame: frameOf(g.center!, piece.t0, sub(from, g.center!)), radius: length(sub(from, g.center!)) };
      } else {
        const c = piece.center!,
          a = piece.axis!,
          x = unit(sub(piece.from, c))!,
          rho = (q: XYZ) => dot(sub(q, c), x),
          h = (q: XYZ) => dot(sub(q, c), a),
          level = (q: XYZ) => add(c, scale(a, h(q)));
        if (g.kind === 'line') {
          const dr = rho(to) - rho(from),
            dh = h(to) - h(from);
          surface =
            Math.abs(dr) <= tolerance
              ? { kind: 'cylinder', frame: frameOf(c, a, x), radius: rho(from) }
              : Math.abs(dh) <= tolerance
                ? { kind: 'plane', frame: frameOf(level(from), a, x) }
                : { kind: 'cone', frame: frameOf(level(from), a, x), radius: rho(from), angle: Math.atan(dr / dh) };
        } else {
          const sc = g.center!,
            r = length(sub(from, sc));
          if (Math.abs(rho(sc)) <= tolerance) surface = { kind: 'sphere', frame: frameOf(level(sc), a, x), radius: r };
          else if (rho(sc) > r) surface = { kind: 'torus', frame: frameOf(level(sc), a, x), major: rho(sc), minor: r };
          else
            throw new RangeError(
              `profile ${profile.name}: segment ${segName(k)} is an arc reaching the axis of path arc ${piece.name}: not supported yet; keep the profile on one side of the path arc's axis`,
            );
        }
      }
      // Out of the solid at the middle of the face: right of the profile segment's direction, seen along the path.
      let mid: XYZ, tangent: XYZ;
      if (g.kind === 'line') {
        mid = scale(add(from, to), 0.5);
        tangent = sub(to, from);
      } else {
        const sw = sweepOf(from, g, s.normal),
          a0 = sub(from, g.center!),
          b0 = cross(s.normal, a0);
        mid = add(g.center!, add(scale(a0, Math.cos(sw / 2)), scale(b0, Math.sin(sw / 2))));
        tangent = scale(cross(s.normal, sub(mid, g.center!)), Math.sign(sw));
      }
      const midOut = moveP(half, mid),
        outward = cross(turnV(half, tangent), tangentMid),
        e = surfaceEvaluator(surface),
        [u, v] = e.parameters(midOut),
        face = shell.add(new Face(`${name}/face:${piece.name}/${segName(k)}`, surface, dot(e.normal(u, v), outward) > 0)),
        loop = face.loop();
      loop.use(sectionEdge(i, k), true);
      loop.use(alongEdges[(k + 1) % count], true);
      loop.use(sectionEdge(i + 1, k), false);
      loop.use(alongEdges[k], false);
      generated.push([face.name, [`${profile.name}/${segName(k)}`, `${path.name}/${piece.name}`]]);
    });
  });
  if (!closed) {
    const s0 = sections[0],
      sm = sections[m],
      p0 = pointsOf(s0),
      pm = pointsOf(sm),
      startFace = shell.add(
        new Face(`${name}/face:start`, { kind: 'plane', frame: frameOf(p0[0], scale(s0.normal, -1), sub(s0.segments[0].to, p0[0])) }, true),
      ),
      endFace = shell.add(
        new Face(`${name}/face:end`, { kind: 'plane', frame: frameOf(pm[0], sm.normal, sub(sm.segments[0].to, pm[0])) }, true),
      ),
      sl = startFace.loop(),
      el = endFace.loop();
    for (let k = count - 1; k >= 0; k--) sl.use(sectionEdge(0, k), false);
    for (let k = 0; k < count; k++) el.use(sectionEdge(m, k), true);
    generated.push([startFace.name, [profile.name]], [endFace.name, [profile.name]]);
  }
  history?.record({ operation: name, generated, modified: [], deleted: [] });
  return body;
}
