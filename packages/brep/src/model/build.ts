// Making solids: extrusion of a closed planar profile of lines and arcs (box and cylinder are extrusions), and the
// cone, sphere and torus. Every face, edge and vertex is named after the operation and what made it, and each
// operation records its names in the History it is given.
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { frameOf, surfaceEvaluator, type CurveDef, type Frame, type SurfaceDef } from './geometry.js';
import { Body, Edge, Face, Vertex, type History, type Name } from './topology.js';

/** One piece of a profile: a line to `to`, or an arc to `to` about `center` (counter-clockwise about the profile normal unless `clockwise`). */
export interface ProfileSegment {
  readonly kind: 'line' | 'arc';
  readonly to: XYZ;
  readonly center?: XYZ;
  readonly clockwise?: boolean;
  /** The name the side face made from this segment takes after the operation's name. */
  readonly name?: Name;
}

/** A closed planar profile: from `start`, segment by segment, back to `start`. */
export interface Profile {
  readonly name: Name;
  readonly start: XYZ;
  /** Normal of the profile's plane. */
  readonly normal: XYZ;
  readonly segments: readonly ProfileSegment[];
}

const same = (a: XYZ, b: XYZ, tolerance: number) => length(sub(a, b)) <= tolerance;

/** The angle an arc from `at` turns about `n`: positive counter-clockwise, a whole turn when it ends where it starts. */
function sweepOf(at: XYZ, s: ProfileSegment, n: XYZ): number {
  const a0 = sub(at, s.center!),
    a1 = sub(s.to, s.center!),
    sweep0 = Math.atan2(dot(cross(a0, a1), n), dot(a0, a1));
  return s.clockwise
    ? sweep0 > 0
      ? sweep0 - 2 * Math.PI
      : sweep0 || -2 * Math.PI
    : sweep0 < 0
      ? sweep0 + 2 * Math.PI
      : sweep0 || 2 * Math.PI;
}

/** Signed area of a profile about `n` (counter-clockwise positive), arcs included. */
function signedArea(profile: Profile, n: XYZ): number {
  let area = 0,
    at = profile.start;
  for (const s of profile.segments) {
    area += dot(cross(at, s.to), n) / 2;
    if (s.kind === 'arc') {
      // The circular segment the arc adds to its chord (positive when it turns counter-clockwise).
      const r = length(sub(at, s.center!)),
        sweep = sweepOf(at, s, n);
      area += (r * r * (sweep - Math.sin(sweep))) / 2;
    }
    at = s.to;
  }
  return area;
}

/**
 * Throws a RangeError when a profile crosses or touches itself anywhere but where one segment meets the next (arcs
 * are followed as chords of 1/128 turn), or turns straight back on itself.
 */
function refuseSelfContact(profile: Profile, n: XYZ, tolerance: number) {
  // The profile as a cycle of short straight pieces in its plane's (x, y).
  const x = unit(sub(profile.segments[0].to, profile.start)) ?? unit(cross(n, [1, 0, 0])) ?? unit(cross(n, [0, 1, 0]))!,
    y = cross(n, x),
    flat = (q: XYZ): [number, number] => [dot(q, x), dot(q, y)],
    points: [number, number][] = [];
  let at = profile.start;
  for (const s of profile.segments) {
    points.push(flat(at));
    if (s.kind === 'arc') {
      const a0 = sub(at, s.center!),
        b0 = cross(n, a0),
        sweep = sweepOf(at, s, n),
        steps = Math.ceil(Math.abs(sweep) / (Math.PI / 64));
      for (let k = 1; k < steps; k++) {
        const t = (sweep * k) / steps;
        points.push(flat(add(s.center!, add(scale(a0, Math.cos(t)), scale(b0, Math.sin(t))))));
      }
    }
    at = s.to;
  }
  const count = points.length,
    piece = (k: number) => [points[k], points[(k + 1) % count]] as const,
    order = [...points.keys()].sort(
      (i, j) => Math.min(piece(i)[0][0], piece(i)[1][0]) - Math.min(piece(j)[0][0], piece(j)[1][0]),
    ),
    where = (k: number) => {
      const [u, v] = piece(k)[0];
      return add(scale(x, u), scale(y, v));
    };
  for (let a = 0; a < count; a++) {
    const i = order[a],
      [p0, p1] = piece(i),
      right = Math.max(p0[0], p1[0]) + tolerance;
    for (let b = a + 1; b < count; b++) {
      const j = order[b],
        [q0, q1] = piece(j);
      if (Math.min(q0[0], q1[0]) > right) break;
      const gap = (j - i + count) % count;
      if (gap === 1 || gap === count - 1) {
        // Neighbours meet at a point; they must not run back along each other.
        const [first, second] = gap === 1 ? [piece(i), piece(j)] : [piece(j), piece(i)],
          d0 = [first[1][0] - first[0][0], first[1][1] - first[0][1]],
          d1 = [second[1][0] - second[0][0], second[1][1] - second[0][1]],
          l0 = Math.hypot(d0[0], d0[1]),
          l1 = Math.hypot(d1[0], d1[1]);
        if (d0[0] * d1[0] + d0[1] * d1[1] < 0 && Math.abs(d0[0] * d1[1] - d0[1] * d1[0]) <= 1e-9 * l0 * l1)
          throw new RangeError(
            `profile ${profile.name} turns straight back on itself at ${fmt(where(gap === 1 ? j : i))}`,
          );
        continue;
      }
      if (gap === 0) continue;
      if (segmentGap(p0, p1, q0, q1) <= tolerance)
        throw new RangeError(`profile ${profile.name} crosses or touches itself near ${fmt(where(i))}`);
    }
  }
}

const fmt = (p: XYZ) => `(${p.map((v) => v.toPrecision(6)).join(', ')})`;

/** Distance between two segments in the plane (0 when they cross). */
function segmentGap(
  a0: readonly number[],
  a1: readonly number[],
  b0: readonly number[],
  b1: readonly number[],
): number {
  const orient = (p: readonly number[], q: readonly number[], r: readonly number[]) =>
      (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]),
    o1 = orient(a0, a1, b0),
    o2 = orient(a0, a1, b1),
    o3 = orient(b0, b1, a0),
    o4 = orient(b0, b1, a1);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
  const toSegment = (p: readonly number[], s0: readonly number[], s1: readonly number[]) => {
    const dx = s1[0] - s0[0],
      dy = s1[1] - s0[1],
      len2 = dx * dx + dy * dy,
      t = len2 ? Math.max(0, Math.min(1, ((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dy) / len2)) : 0;
    return Math.hypot(p[0] - s0[0] - t * dx, p[1] - s0[1] - t * dy);
  };
  return Math.min(toSegment(a0, b0, b1), toSegment(a1, b0, b1), toSegment(b0, a0, a1), toSegment(b1, a0, a1));
}

/** The same profile run the other way. */
function reversed(profile: Profile): Profile {
  const points = [profile.start, ...profile.segments.map((s) => s.to)],
    segments = profile.segments
      .map((s, k) => ({ ...s, to: points[k], clockwise: s.kind === 'arc' ? !s.clockwise : undefined }))
      .reverse();
  return { ...profile, segments };
}

/**
 * Extrudes a closed planar profile along `vector` into a solid named `name`: a bottom and top face, and a side face
 * per segment (a plane for a line; for an arc, a cylinder: arcs need `vector` along the profile normal). Throws a
 * RangeError for an open, degenerate or self-touching profile, and for arcs under an oblique extrusion.
 */
export function extrude(
  name: Name,
  profile: Profile,
  vector: XYZ,
  { history, bottom = 'bottom', top = 'top' }: { history?: History; bottom?: Name; top?: Name } = {},
): Body {
  const along = unit(vector),
    height = length(vector);
  if (!along || !(height > 0)) throw new RangeError('extrude vector must not be zero');
  let n = unit(profile.normal);
  if (!n) throw new RangeError('profile normal must not be zero');
  if (Math.abs(dot(n, along)) < 1e-9) throw new RangeError('extrude vector must not lie in the profile plane');
  if (dot(n, along) < 0) n = scale(n, -1);
  const size = Math.max(...[profile.start, ...profile.segments.map((s) => s.to)].map((p) => length(p))),
    tolerance = 1e-9 * Math.max(size, 1);
  if (!profile.segments.length || !same(profile.segments[profile.segments.length - 1].to, profile.start, tolerance))
    throw new RangeError(`profile ${profile.name} does not end where it starts`);
  const area = signedArea(profile, n);
  if (Math.abs(area) <= tolerance * tolerance) throw new RangeError(`profile ${profile.name} encloses no area`);
  refuseSelfContact(profile, n, tolerance);
  // Counter-clockwise about the extrusion side, so side faces face out.
  const p = area > 0 ? profile : reversed(profile),
    count = p.segments.length,
    points = [p.start, ...p.segments.slice(0, -1).map((s) => s.to)],
    perpendicular = Math.abs(dot(n, along)) > 1 - 1e-12;
  for (const s of p.segments)
    if (s.kind === 'arc' && !perpendicular)
      throw new RangeError('arcs extrude only along the profile normal (an oblique arc side is not supported yet)');
  const body = new Body(name, 'solid'),
    shell = body.shell(),
    d = scale(along, height),
    segName = (k: number) => p.segments[k].name ?? `e${k}`,
    bottomV = points.map((q, k) => new Vertex(`${name}/vertex:${bottom}:${k}`, q)),
    topV = points.map((q, k) => new Vertex(`${name}/vertex:${top}:${k}`, add(q, d)));
  // Curves of the profile segments, at the bottom and moved up by the extrusion.
  const segmentCurve = (k: number, shift: XYZ): { curve: CurveDef; sameSense: boolean } => {
    const s = p.segments[k],
      from = add(points[k], shift),
      to = add(s.to, shift);
    if (s.kind === 'line')
      return { curve: { kind: 'line', origin: from, direction: unit(sub(to, from))! }, sameSense: true };
    const c = add(s.center!, shift),
      r = length(sub(from, c));
    return { curve: { kind: 'circle', frame: frameOf(c, n, sub(from, c)), radius: r }, sameSense: !s.clockwise };
  };
  const bottomE = points.map((_, k) => {
      const { curve, sameSense } = segmentCurve(k, [0, 0, 0]);
      return new Edge(`${name}/edge:${bottom}:${segName(k)}`, curve, bottomV[k], bottomV[(k + 1) % count], sameSense);
    }),
    topE = points.map((_, k) => {
      const { curve, sameSense } = segmentCurve(k, d);
      return new Edge(`${name}/edge:${top}:${segName(k)}`, curve, topV[k], topV[(k + 1) % count], sameSense);
    }),
    sideE = points.map(
      (q, k) =>
        new Edge(`${name}/edge:side:${k}`, { kind: 'line', origin: q, direction: along }, bottomV[k], topV[k], true),
    );
  // A single closed arc (a disc profile) keeps one vertex: its seam edge is used twice by the one side face.
  const generated: [Name, Name[]][] = [];
  const bottomFace = shell.add(
    faceOf(`${name}/face:${bottom}`, {
      kind: 'plane',
      frame: frameOf(points[0], scale(n, -1), sub(p.segments[0].to, points[0])),
    }),
  );
  const bl = bottomFace.loop();
  for (let k = count - 1; k >= 0; k--) bl.use(bottomE[k], false);
  const topFace = shell.add(
    faceOf(`${name}/face:${top}`, {
      kind: 'plane',
      frame: frameOf(add(points[0], d), n, sub(p.segments[0].to, points[0])),
    }),
  );
  const tl = topFace.loop();
  for (let k = 0; k < count; k++) tl.use(topE[k], true);
  generated.push([bottomFace.name, [`${profile.name}`]], [topFace.name, [`${profile.name}`]]);
  for (let k = 0; k < count; k++) {
    const s = p.segments[k],
      from = points[k],
      to = s.to,
      face =
        s.kind === 'line'
          ? faceOf(`${name}/face:${segName(k)}`, {
              kind: 'plane',
              frame: frameOf(from, cross(sub(to, from), along), sub(to, from)),
            })
          : faceOf(
              `${name}/face:${segName(k)}`,
              {
                kind: 'cylinder',
                frame: frameOf(s.center!, n, sub(from, s.center!)),
                radius: length(sub(from, s.center!)),
              },
              !s.clockwise,
            );
    shell.add(face);
    const loop = face.loop();
    loop.use(bottomE[k], true);
    loop.use(sideE[(k + 1) % count], true);
    loop.use(topE[k], false);
    loop.use(sideE[k], false);
    generated.push([face.name, [`${profile.name}/${segName(k)}`]]);
  }
  history?.record({ operation: name, generated, modified: [], deleted: [] });
  return body;
}

const faceOf = (name: Name, surface: SurfaceDef, sense = true) => new Face(name, surface, sense);

/** A box of the given sizes from `frame`'s origin along its x, y and z axes, faces named -x, +x, -y, +y, -z, +z. */
export function box(
  name: Name,
  size: XYZ,
  frame: Frame = frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  history?: History,
): Body {
  const [sx, sy, sz] = size;
  if (!(sx > 0 && sy > 0 && sz > 0)) throw new RangeError('box sizes must be positive');
  const at = (u: number, v: number) => add(frame.origin, add(scale(frame.x, u), scale(frame.y, v)));
  return extrude(
    name,
    {
      name: `${name}/profile`,
      start: at(0, 0),
      normal: frame.z,
      segments: [
        { kind: 'line', to: at(sx, 0), name: '-y' },
        { kind: 'line', to: at(sx, sy), name: '+x' },
        { kind: 'line', to: at(0, sy), name: '+y' },
        { kind: 'line', to: at(0, 0), name: '-x' },
      ],
    },
    scale(frame.z, sz),
    { history, bottom: '-z', top: '+z' },
  );
}

/** A cylinder of `radius` about `frame`'s z axis from its origin up `height`; faces side, -z, +z. */
export function cylinder(
  name: Name,
  radius: number,
  height: number,
  frame: Frame = frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  history?: History,
): Body {
  if (!(radius > 0 && height > 0)) throw new RangeError('cylinder radius and height must be positive');
  const start = add(frame.origin, scale(frame.x, radius));
  return extrude(
    name,
    {
      name: `${name}/profile`,
      start,
      normal: frame.z,
      segments: [{ kind: 'arc', to: start, center: frame.origin, name: 'side' }],
    },
    scale(frame.z, height),
    { history, bottom: '-z', top: '+z' },
  );
}

/** A solid sphere: one face with no edges. */
export function sphere(
  name: Name,
  radius: number,
  frame: Frame = frameOf([0, 0, 0], [0, 0, 1]),
  history?: History,
): Body {
  if (!(radius > 0)) throw new RangeError('sphere radius must be positive');
  const body = new Body(name, 'solid');
  body.shell().add(faceOf(`${name}/face:surface`, { kind: 'sphere', frame, radius }));
  history?.record({ operation: name, generated: [[`${name}/face:surface`, []]], modified: [], deleted: [] });
  return body;
}

/** A solid torus about `frame`'s z axis: one face with no edges. */
export function torus(
  name: Name,
  major: number,
  minor: number,
  frame: Frame = frameOf([0, 0, 0], [0, 0, 1]),
  history?: History,
): Body {
  if (!(major > minor && minor > 0)) throw new RangeError('torus needs major > minor > 0');
  const body = new Body(name, 'solid');
  body.shell().add(faceOf(`${name}/face:surface`, { kind: 'torus', frame, major, minor }));
  history?.record({ operation: name, generated: [[`${name}/face:surface`, []]], modified: [], deleted: [] });
  return body;
}

/**
 * Turns a closed planar profile of lines and arcs once round an axis lying in its plane, into a solid named `name`: a
 * face per segment (a plane, cylinder or cone for a line; a torus, or a sphere for an arc centred on the axis), each
 * closed by its own seam, and a circle at every profile point. The profile must stay off the axis. Throws a
 * RangeError for an open, degenerate or self-touching profile, one that leaves the axis's plane or touches the axis,
 * and an arc crossing it.
 */
export function revolve(
  name: Name,
  profile: Profile,
  axis: { readonly origin: XYZ; readonly direction: XYZ },
  { history }: { history?: History } = {},
): Body {
  const z = unit(axis.direction),
    o = axis.origin;
  if (!z) throw new RangeError('revolve axis must not be the zero vector');
  const n0 = unit(profile.normal);
  if (!n0) throw new RangeError('profile normal must not be zero');
  if (Math.abs(dot(n0, z)) > 1e-9) throw new RangeError(`profile ${profile.name} must lie in a plane through the axis`);
  const rel = sub(profile.start, o),
    x = unit(sub(rel, scale(z, dot(rel, z))));
  if (!x) throw new RangeError(`profile ${profile.name} starts on the axis`);
  // Counter-clockwise in (distance from the axis, height) about m = x cross z, so the faces face out.
  const m = cross(x, z),
    size = Math.max(...[profile.start, ...profile.segments.map((s) => s.to)].map((p) => length(sub(p, o)))),
    tolerance = 1e-9 * Math.max(size, 1);
  let p: Profile =
    dot(n0, m) < 0
      ? {
          ...profile,
          normal: m,
          segments: profile.segments.map((s) => (s.kind === 'arc' ? { ...s, clockwise: !s.clockwise } : s)),
        }
      : { ...profile, normal: m };
  if (!p.segments.length || !same(p.segments[p.segments.length - 1].to, p.start, tolerance))
    throw new RangeError(`profile ${profile.name} does not end where it starts`);
  const area = signedArea(p, m);
  if (Math.abs(area) <= tolerance * tolerance) throw new RangeError(`profile ${profile.name} encloses no area`);
  refuseSelfContact(p, m, tolerance);
  if (area < 0) p = reversed(p);
  const count = p.segments.length,
    points = [p.start, ...p.segments.slice(0, -1).map((s) => s.to)],
    rho = (q: XYZ) => dot(sub(q, o), x),
    h = (q: XYZ) => dot(sub(q, o), z),
    level = (q: XYZ) => add(o, scale(z, h(q)));
  for (const q of [...points, ...p.segments.flatMap((s) => (s.center ? [s.center] : []))])
    if (Math.abs(dot(sub(q, o), m)) > tolerance)
      throw new RangeError(`profile ${profile.name} must lie in a plane through the axis`);
  for (const q of points)
    if (rho(q) <= tolerance) throw new RangeError(`profile ${profile.name} touches the axis: not supported yet`);
  const body = new Body(name, 'solid'),
    shell = body.shell(),
    segName = (k: number) => p.segments[k].name ?? `e${k}`,
    vertices = points.map((q, k) => new Vertex(`${name}/vertex:${k}`, q)),
    circles = points.map(
      (q, k) =>
        new Edge(
          `${name}/edge:round:${k}`,
          { kind: 'circle', frame: frameOf(level(q), z, x), radius: rho(q) },
          vertices[k],
          vertices[k],
          true,
        ),
    ),
    around = cross(z, x),
    generated: [Name, Name[]][] = [];
  for (let k = 0; k < count; k++) {
    const s = p.segments[k],
      from = points[k],
      to = points[(k + 1) % count];
    let seam: CurveDef,
      sameSense = true,
      surface: SurfaceDef,
      start: XYZ,
      mid: XYZ,
      midTangent: XYZ;
    if (s.kind === 'line') {
      const d = unit(sub(to, from))!,
        dr = rho(to) - rho(from),
        dh = h(to) - h(from);
      seam = { kind: 'line', origin: from, direction: d };
      start = midTangent = d;
      mid = scale(add(from, to), 0.5);
      surface =
        Math.abs(dr) <= tolerance
          ? { kind: 'cylinder', frame: frameOf(o, z, x), radius: rho(from) }
          : Math.abs(dh) <= tolerance
            ? { kind: 'plane', frame: frameOf(level(from), z, x) }
            : { kind: 'cone', frame: frameOf(level(from), z, x), radius: rho(from), angle: Math.atan(dr / dh) };
    } else {
      const c = s.center!,
        r = length(sub(from, c)),
        a0 = sub(from, c),
        a1 = sub(to, c),
        turn = Math.atan2(dot(cross(a0, a1), m), dot(a0, a1)),
        sweep = s.clockwise
          ? turn > 0
            ? turn - 2 * Math.PI
            : turn || -2 * Math.PI
          : turn < 0
            ? turn + 2 * Math.PI
            : turn || 2 * Math.PI,
        spin = (v: XYZ, t: number) => add(scale(v, Math.cos(t)), scale(cross(m, v), Math.sin(t))),
        sign = Math.sign(sweep);
      seam = { kind: 'circle', frame: frameOf(c, m, a0), radius: r };
      sameSense = !s.clockwise;
      start = unit(scale(cross(m, a0), sign))!;
      mid = add(c, spin(a0, sweep / 2));
      midTangent = unit(scale(cross(m, sub(mid, c)), sign))!;
      if (rho(c) <= tolerance) surface = { kind: 'sphere', frame: frameOf(level(c), z, x), radius: r };
      else if (rho(c) > r) surface = { kind: 'torus', frame: frameOf(level(c), z, x), major: rho(c), minor: r };
      else throw new RangeError(`profile ${profile.name}: an arc reaches the axis: not supported yet`);
    }
    // Out of the solid: right of the way round a counter-clockwise profile. The face's sense compares it with the
    // surface's own normal there; its loop runs so the face lies left of it seen from outside.
    const outward = cross(midTangent, m),
      e = surfaceEvaluator(surface),
      [u, v] = e.parameters(mid),
      sense = dot(e.normal(u, v), outward) > 0,
      face = shell.add(new Face(`${name}/face:${segName(k)}`, surface, sense)),
      edge = new Edge(`${name}/edge:${segName(k)}`, seam, vertices[k], vertices[(k + 1) % count], sameSense),
      loop = face.loop(),
      forward = dot(cross(cross(start, m), around), start) > 0;
    loop.use(circles[k], forward);
    loop.use(edge, true);
    loop.use(circles[(k + 1) % count], !forward);
    loop.use(edge, false);
    generated.push([face.name, [`${profile.name}/${segName(k)}`]]);
  }
  history?.record({ operation: name, generated, modified: [], deleted: [] });
  return body;
}
