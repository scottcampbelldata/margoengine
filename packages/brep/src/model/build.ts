// Making solids: extrusion of a closed planar profile of lines and arcs (box and cylinder are extrusions), and the
// cone, sphere and torus. Every face, edge and vertex is named after the operation and what made it, and each
// operation records its names in the History it is given.
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { frameOf, type CurveDef, type Frame, type SurfaceDef } from './geometry.js';
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

/** Signed area of a profile about `n` (counter-clockwise positive), arcs included. */
function signedArea(profile: Profile, n: XYZ): number {
  let area = 0,
    at = profile.start;
  for (const s of profile.segments) {
    if (s.kind === 'line') area += dot(cross(at, s.to), n) / 2;
    else {
      // The chord's share plus the circular segment the arc adds (positive when it turns counter-clockwise).
      const c = s.center!,
        r = length(sub(at, c)),
        a0 = sub(at, c),
        a1 = sub(s.to, c),
        sweep0 = Math.atan2(dot(cross(a0, a1), n), dot(a0, a1)),
        sweep = s.clockwise
          ? sweep0 > 0
            ? sweep0 - 2 * Math.PI
            : sweep0 || -2 * Math.PI
          : sweep0 < 0
            ? sweep0 + 2 * Math.PI
            : sweep0 || 2 * Math.PI;
      area += dot(cross(at, s.to), n) / 2 + (r * r * (sweep - Math.sin(sweep))) / 2;
    }
    at = s.to;
  }
  return area;
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
