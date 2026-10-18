// Fillets and chamfers, made with the Booleans: for each edge, the strip of material between the edge and the rounding
// (or the bevel) is built as a solid and taken away from a convex edge, or added at a concave one. The strip's flat
// sides lie in the edge's two faces and its round side touches them along its tangent lines, cases the Booleans take
// (faces on one surface, edges in faces). Every strip is built from the body as given, then applied in turn:
// - an end no other blended edge meets runs on past the end (a convex strip) so it cuts clean through the face there;
// - where two blended edges meet, each strip stops at the mitre plane between them (their roundings meet in a crease
//   along it, as two equal cylinders do);
// - where three convex edges meet at right angles with one radius (a box's corner), the strips stop where a ball of
//   that radius would roll off them, and the corner is rounded by the ball (a sphere patch).
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { boolean } from './boolean.js';
import { box, extrude, revolve, sphere, type ProfileSegment } from './build.js';
import { FaceUV } from './faces.js';
import { frameOf } from './geometry.js';
import { Body, History, type Edge, type Face, type Name, type Vertex } from './topology.js';

type Blend = { kind: 'fillet'; radius: number } | { kind: 'chamfer'; distance: number };

/**
 * Rounds the named edges of `body` to `radius` (metres): straight edges between two planar faces, convex or concave,
 * at any angle between the faces; corners where three rounded edges meet at right angles get a sphere. Returns a new
 * solid `name`; `history` gets each step (the rounding of edge `<edge>` is `<name>:<edge>/face:round`). Throws a
 * RangeError for an edge it cannot find or round.
 */
export function fillet(
  name: Name,
  body: Body,
  edges: readonly Name[],
  radius: number,
  options: { history?: History } = {},
): Body {
  if (!(radius > 0)) throw new RangeError('fillet radius must be positive');
  return blend(name, body, edges, { kind: 'fillet', radius }, options.history);
}

/**
 * Bevels the named edges of `body` by `distance` (metres) along each of its two faces: straight edges between two
 * planar faces, convex or concave. The bevel of edge `<edge>` is `<name>:<edge>/face:bevel`.
 */
export function chamfer(
  name: Name,
  body: Body,
  edges: readonly Name[],
  distance: number,
  options: { history?: History } = {},
): Body {
  if (!(distance > 0)) throw new RangeError('chamfer distance must be positive');
  return blend(name, body, edges, { kind: 'chamfer', distance }, options.history);
}

/** One edge to blend, as the body gives it. */
interface Selected {
  name: Name;
  edge: Edge;
  /** Into each of its two faces from the edge, across it, and those faces. */
  u1: XYZ;
  u2: XYZ;
  f1: Face;
  f2: Face;
  angle: number;
  convex: boolean;
}

function blend(name: Name, body: Body, edgeNames: readonly Name[], how: Blend, history?: History): Body {
  if (body.kind !== 'solid') throw new RangeError('fillets and chamfers take a solid');
  const selected = edgeNames.map((n) => {
      const edge = body.edges.find((e) => e.name === n);
      if (!edge) throw new RangeError(`${name}: no edge ${n} in ${body.name}`);
      return describe(body, edge, n);
    }),
    at = new Map<Vertex, Selected[]>();
  for (const s of selected) for (const v of [s.edge.start, s.edge.end]) at.set(v, [...(at.get(v) ?? []), s]);
  const size = how.kind === 'fillet' ? how.radius : how.distance,
    tools: { body: Body; convex: boolean }[] = [];
  // Corners rounded by a ball: three convex edges at right angles (fillets only).
  const balls = new Map<Vertex, XYZ>();
  if (how.kind === 'fillet')
    for (const [v, list] of at) {
      if (list.length !== 3 || !list.every((s) => s.convex)) continue;
      const d = list.map((s) => away(s.edge, v));
      if (Math.abs(dot(d[0], d[1])) > 1e-9 || Math.abs(dot(d[1], d[2])) > 1e-9 || Math.abs(dot(d[0], d[2])) > 1e-9)
        continue;
      const centre = add(v.point, scale(add(add(d[0], d[1]), d[2]), how.radius));
      balls.set(v, centre);
      // The corner block between the vertex and the ball's centre, less the ball.
      // x, then the third direction as y = z x x: a right-handed frame along the three edges.
      const x = dot(cross(d[0], d[1]), d[2]) < 0 ? d[1] : d[0],
        block = box(`${name}:corner:${v.name}`, [how.radius, how.radius, how.radius], frameOf(v.point, d[2], x)),
        // Its poles along the corner's diagonal, off the three planes that cut it.
        ball = sphere(`${name}:ball:${v.name}`, how.radius, frameOf(centre, add(add(d[0], d[1]), d[2]), x));
      tools.push({ body: boolean(`${name}:corner:${v.name}`, 'subtract', block, ball), convex: true });
    }
  for (const s of selected) {
    // A full circle: its ring, which has no ends.
    if (s.edge.curve.kind === 'circle') {
      tools.push({ body: ring(`${name}:${s.name}`, s, how), convex: s.convex });
      continue;
    }
    const ends: [number, number] = [0, 0],
      mitres: { at: Vertex; other: Selected }[] = [],
      len = length(sub(s.edge.end.point, s.edge.start.point)),
      reach = how.kind === 'fillet' ? how.radius / Math.tan(s.angle / 2) : how.distance,
      extend = s.convex ? 2 * (reach + size) : 0;
    [s.edge.start, s.edge.end].forEach((v, k) => {
      const ball = balls.get(v);
      // Signed distance the strip reaches past this end (negative: it stops short of it).
      if (ball) ends[k] = -dot(sub(ball, v.point), away(s.edge, v));
      else {
        ends[k] = extend;
        for (const other of at.get(v) ?? []) if (other !== s) mitres.push({ at: v, other });
      }
    });
    let tool = strip(`${name}:${s.name}`, s, how, ends, len);
    for (const { at: v, other } of mitres)
      tool = boolean(
        `${name}:${s.name}`,
        'subtract',
        tool,
        beyondMitre(`${name}:${s.name}:mitre:${other.name}`, s, other, v, len + size * 8),
      );
    tools.push({ body: tool, convex: s.convex });
  }
  let current = body;
  tools.forEach((tool, k) => {
    current = boolean(
      k === tools.length - 1 ? name : `${name}/${k}`,
      tool.convex ? 'subtract' : 'union',
      current,
      tool.body,
      {
        history,
      },
    );
  });
  return current;
}

/** The unit direction along an edge away from one of its vertices. */
function away(edge: Edge, v: Vertex): XYZ {
  const other = edge.start === v ? edge.end : edge.start;
  return unit(sub(other.point, v.point))!;
}

/** An edge's faces, the directions into them across it, the angle between those, and whether it is convex. */
function describe(body: Body, edge: Edge, name: Name): Selected {
  const faces = [...new Set(edge.coedges.map((c) => c.loop.face).filter((f) => body.faces.includes(f)))];
  if (faces.length !== 2) throw new RangeError(`${name}: an edge between two faces is needed`);
  if (edge.curve.kind === 'circle') return describeRound(edge, name, faces);
  if (edge.curve.kind !== 'line')
    throw new RangeError(`${name}: only straight edges and full circles can be blended so far`);
  for (const f of faces)
    if (f.surface.kind !== 'plane')
      throw new RangeError(`${name}: only edges between planar faces can be blended so far`);
  const p0 = edge.start.point,
    p1 = edge.end.point,
    len = length(sub(p1, p0)),
    d = unit(sub(p1, p0))!,
    mid = scale(add(p0, p1), 0.5),
    into = (f: Face): XYZ => {
      const u = unit(cross(d, outward(f)))!;
      return new FaceUV(f).contains(add(mid, scale(u, 1e-6 * len))) ? u : scale(u, -1);
    },
    [f1, f2] = faces,
    u1 = into(f1),
    u2 = into(f2),
    angle = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (!(angle > 1e-6 && angle < Math.PI - 1e-6))
    throw new RangeError(`${name}: its faces meet flat or fold back; nothing to blend`);
  // Convex: face 2 runs away from face 1's outside (the strip between them is material); concave: towards it.
  return { name, edge, u1, u2, f1, f2, angle, convex: dot(outward(f1), u2) < 0 };
}

/**
 * A full circle where a plane meets a cylinder on the circle's axis (a hole's or a boss's rim): the directions into the
 * two faces from the circle's vertex, in the plane through the axis, at right angles.
 */
function describeRound(edge: Edge, name: Name, faces: Face[]): Selected {
  if (edge.curve.kind !== 'circle' || !edge.closed)
    throw new RangeError(`${name}: only full circles can be blended so far`);
  const { frame } = edge.curve,
    plane = faces.find((f) => f.surface.kind === 'plane'),
    wall = faces.find((f) => f.surface.kind === 'cylinder');
  if (!plane || !wall || wall.surface.kind !== 'cylinder')
    throw new RangeError(`${name}: only circles between a plane and a cylinder can be blended so far`);
  const axis = wall.surface.frame.z,
    off = sub(frame.origin, wall.surface.frame.origin);
  if (length(cross(axis, frame.z)) > 1e-9 || length(cross(off, axis)) > 1e-9 * (1 + length(off)))
    throw new RangeError(`${name}: the circle is not on its cylinder's axis`);
  const e = edge.start.point,
    radial = unit(sub(e, frame.origin))!,
    step = 1e-6 * edge.curve.radius,
    into = (f: Face, u: XYZ): XYZ => (new FaceUV(f).contains(add(e, scale(u, step))) ? u : scale(u, -1)),
    u1 = into(plane, radial),
    u2 = into(wall, frame.z);
  return { name, edge, u1, u2, f1: plane, f2: wall, angle: Math.PI / 2, convex: dot(outward(plane), u2) < 0 };
}

/** The ring between a circular edge and its rounding or bevel: the corner's cross-section turned round the axis. */
function ring(name: Name, s: Selected, how: Blend): Body {
  if (s.edge.curve.kind !== 'circle') throw new RangeError(`${s.name}: not a circle`);
  const { frame } = s.edge.curve,
    e = s.edge.start.point,
    reach = how.kind === 'fillet' ? how.radius : how.distance,
    t1 = add(e, scale(s.u1, reach)),
    t2 = add(e, scale(s.u2, reach)),
    normal = cross(s.u1, s.u2),
    segments: ProfileSegment[] = [{ kind: 'line', to: t1, name: 'side1' }];
  if (how.kind === 'fillet')
    segments.push({
      kind: 'arc',
      to: t2,
      center: add(e, scale(add(s.u1, s.u2), how.radius)),
      // The short way round, on the edge's side of the centre.
      clockwise: true,
      name: 'round',
    });
  else segments.push({ kind: 'line', to: t2, name: 'bevel' });
  segments.push({ kind: 'line', to: e, name: 'side2' });
  return revolve(
    name,
    { name: `${name}/profile`, start: e, normal, segments },
    { origin: frame.origin, direction: frame.z },
  );
}

/** The solid between an edge and its rounding or bevel, from `ends[0]` past its start to `ends[1]` past its end. */
function strip(name: Name, s: Selected, how: Blend, ends: [number, number], len: number): Body {
  const d = unit(sub(s.edge.end.point, s.edge.start.point))!,
    reach = how.kind === 'fillet' ? how.radius / Math.tan(s.angle / 2) : how.distance,
    start = sub(s.edge.start.point, scale(d, ends[0])),
    t1 = add(start, scale(s.u1, reach)),
    t2 = add(start, scale(s.u2, reach)),
    segments: ProfileSegment[] = [{ kind: 'line', to: t1, name: 'side1' }];
  if (how.kind === 'fillet') {
    const center = add(start, scale(unit(add(s.u1, s.u2))!, how.radius / Math.sin(s.angle / 2))),
      // The arc on the edge's side of the centre: the short way from t1 to t2.
      clockwise = dot(cross(sub(t1, center), sub(t2, center)), d) < 0;
    segments.push({ kind: 'arc', to: t2, center, clockwise, name: 'round' });
  } else segments.push({ kind: 'line', to: t2, name: 'bevel' });
  segments.push({ kind: 'line', to: start, name: 'side2' });
  const length2 = len + ends[0] + ends[1];
  if (!(length2 > 0))
    throw new RangeError(`${s.name}: too short for this ${how.kind === 'fillet' ? 'radius' : 'distance'}`);
  return extrude(name, { name: `${name}/profile`, start, normal: d, segments }, scale(d, length2));
}

/**
 * A large block on the far side of the mitre plane between edge `s` and edge `other` at their common vertex: the plane
 * through the vertex holding their shared face's normal and the bisector of the two edges.
 */
function beyondMitre(name: Name, s: Selected, other: Selected, v: Vertex, big: number): Body {
  const shared = [s.f1, s.f2].find((f) => f === other.f1 || f === other.f2);
  if (!shared)
    throw new RangeError(`${s.name} and ${other.name} meet at a vertex but share no face: not supported yet`);
  const d1 = away(s.edge, v),
    d2 = away(other.edge, v),
    n = outward(shared),
    m0 = unit(cross(n, add(d1, d2)))!,
    // The block lies on the side away from this edge.
    m = dot(m0, d1) > 0 ? scale(m0, -1) : m0,
    x = unit(add(d1, d2))!,
    y = cross(m, x),
    origin = sub(v.point, scale(add(x, y), big / 2));
  return box(name, [big, big, big], frameOf(origin, m, x));
}

/** A planar face's normal out of its solid. */
function outward(f: Face): XYZ {
  if (f.surface.kind !== 'plane') throw new RangeError(`${f.name}: not planar`);
  const z = f.surface.frame.z;
  return f.sense ? z : scale(z, -1);
}
