// Lofting (skinning) a solid through closed planar sections of lines and arcs. Each section has as many segments as
// the others and its segments match theirs in order, from each section's start point. Between two consecutive sections
// each pair of matched segments is joined by a ruled face: the straight lines from one segment to the other at equal
// parameters. Two lines in one plane make a plane; two coaxial arcs of one turn in parallel planes make a cylinder or a
// cone; any other pair makes a ruled B-spline surface (two lines: bilinear; an arc on either side: rational, degree 2
// along the segment and 1 across, the arcs exact). The loft is ruled: position continuous (C0) across each inner
// section, where the side faces meet along the section's edges with a crease; smooth (curvature continuous) inside
// each span. Between parallel sections every cross-section's area is quadratic in height, so the volume of a span is
// exactly the prismatoid formula h/6 (A0 + 4 Am + A1), the closed form the tests hold it to.
//
// Refused with a RangeError: sections that differ in their number of segments, that are not closed, planar and
// simple, consecutive sections that are not apart (each must lie wholly on the far side of the other's plane), and
// sections twisted against each other so that the faces between them would cross (checked on intermediate sections).
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { profileSize, refuseSelfContact, reversed, signedArea, sweepOf, type Profile } from './build.js';
import { frameOf, surfaceEvaluator, type CurveDef, type SurfaceDef } from './geometry.js';
import { Body, Edge, Face, Vertex, type History, type Name } from './topology.js';

/** A section, oriented: its points, normal along the loft and segments counter-clockwise about it. */
interface Section {
  readonly profile: Profile;
  readonly normal: XYZ;
  readonly points: XYZ[];
}

/** Point of segment k of a section at fraction f along it (by angle on an arc). */
function pointAt(s: Section, k: number, f: number): XYZ {
  const g = s.profile.segments[k],
    from = s.points[k];
  if (g.kind === 'line') return add(from, scale(sub(g.to, from), f));
  const a0 = sub(from, g.center!),
    b0 = cross(s.normal, a0),
    t = sweepOf(from, g, s.normal) * f;
  return add(g.center!, add(scale(a0, Math.cos(t)), scale(b0, Math.sin(t))));
}

/** Direction of segment k of a section at fraction f, unscaled. */
function tangentAt(s: Section, k: number, f: number): XYZ {
  const g = s.profile.segments[k];
  if (g.kind === 'line') return sub(g.to, s.points[k]);
  const sw = sweepOf(s.points[k], g, s.normal);
  return scale(cross(s.normal, sub(pointAt(s, k, f), g.center!)), Math.sign(sw));
}

/** The boundary of a section as points, `per` to a segment. */
function outline(s: Section, per: number): XYZ[] {
  const out: XYZ[] = [];
  s.profile.segments.forEach((_, k) => {
    for (let i = 0; i < per; i++) out.push(pointAt(s, k, i / per));
  });
  return out;
}

/** Segment k of a section as a degree 2 B-spline of `pieces` spans on [0, 1] (rational for an arc). */
function quadratic(s: Section, k: number, pieces: number): { points: XYZ[]; weights: number[] } {
  const g = s.profile.segments[k],
    from = s.points[k],
    points: XYZ[] = [],
    weights: number[] = [];
  if (g.kind === 'line') {
    for (let m = 0; m <= 2 * pieces; m++) {
      points.push(add(from, scale(sub(g.to, from), m / (2 * pieces))));
      weights.push(1);
    }
    return { points, weights };
  }
  const sw = sweepOf(from, g, s.normal),
    half = sw / pieces / 2,
    w = Math.cos(half),
    a0 = sub(from, g.center!),
    b0 = cross(s.normal, a0),
    at = (t: number, r: number) => add(g.center!, add(scale(a0, r * Math.cos(t)), scale(b0, r * Math.sin(t))));
  for (let j = 0; j < pieces; j++) {
    const t0 = (sw * j) / pieces;
    points.push(at(t0, 1), at(t0 + half, 1 / w));
    weights.push(1, w);
  }
  points.push(g.to);
  weights.push(1);
  return { points, weights };
}

/** Whether two points are within `tolerance`. */
const same = (a: XYZ, b: XYZ, tolerance: number) => length(sub(a, b)) <= tolerance;

/** Whether two segments in the plane, [a0, a1] and [b0, b1], cross. */
function crosses(a0: number[], a1: number[], b0: number[], b1: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]),
    o1 = o(a0, a1, b0),
    o2 = o(a0, a1, b1),
    o3 = o(b0, b1, a0),
    o4 = o(b0, b1, a1);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * Lofts a solid named `name` through two or more closed planar sections of lines and arcs (see the file header). Each
 * section's segments are matched in order from its start point; a section given clockwise about the loft direction is
 * reversed about its start point. Faces: `start` and `end` (planes on the first and last section) and a side face per
 * span and segment, named `<span>/<segment>` (spans s0, s1 and so on; segments by the first section's names, e0, e1
 * and so on by default).
 */
export function loft(name: Name, sections: readonly Profile[], { history }: { history?: History } = {}): Body {
  if (sections.length < 2) throw new RangeError('loft needs at least two sections');
  const count = sections[0].segments.length;
  for (const p of sections) {
    if (p.segments.length !== count)
      throw new RangeError(
        `loft sections must have as many segments each: ${sections[0].name} has ${count}, ${p.name} ${p.segments.length}`,
      );
    for (const g of p.segments)
      if (g.kind === 'arc' && !g.center) throw new RangeError(`profile ${p.name}: an arc needs a center`);
  }
  const size = Math.max(...sections.map(profileSize)),
    tolerance = 1e-9 * Math.max(size, 1),
    pointsOf = (q: Profile) => [q.start, ...q.segments.slice(0, -1).map((s) => s.to)];
  // Rough centres (the mean of each section's points) give the loft's direction at each section.
  const centres = sections.map((p) => {
    const pts = pointsOf(p);
    return scale(
      pts.reduce((a, b) => add(a, b), [0, 0, 0] as XYZ),
      1 / pts.length,
    );
  });
  const oriented: Section[] = sections.map((p0, i) => {
    let n = unit(p0.normal);
    if (!n) throw new RangeError(`profile ${p0.name}: normal must not be zero`);
    const d = unit(i + 1 < sections.length ? sub(centres[i + 1], centres[i]) : sub(centres[i], centres[i - 1]));
    if (!d)
      throw new RangeError(
        `loft sections ${p0.name} and its neighbour lie at one place; give the sections different positions`,
      );
    if (Math.abs(dot(n, d)) < 1e-9)
      throw new RangeError(`profile ${p0.name} lies along the loft; put each section across the loft direction`);
    let p: Profile = p0;
    if (dot(n, d) < 0) {
      n = scale(n, -1);
      p = { ...p0, segments: p0.segments.map((s) => (s.kind === 'arc' ? { ...s, clockwise: !s.clockwise } : s)) };
    }
    p = { ...p, normal: n };
    if (!same(p.segments[count - 1].to, p.start, tolerance))
      throw new RangeError(
        `profile ${p0.name} does not end where it starts; pass a closed profile that does not cross itself`,
      );
    for (const q of [...pointsOf(p), ...p.segments.flatMap((s) => (s.center ? [s.center] : []))])
      if (Math.abs(dot(sub(q, p.start), n)) > tolerance)
        throw new RangeError(
          `profile ${p0.name} is not planar; put every point and arc centre of the profile in one plane`,
        );
    const area = signedArea(p, n);
    if (Math.abs(area) <= tolerance * tolerance)
      throw new RangeError(`profile ${p0.name} encloses no area; pass a closed profile that does not cross itself`);
    refuseSelfContact(p, n, tolerance);
    if (area < 0) p = reversed(p);
    return { profile: p, normal: n, points: pointsOf(p) };
  });
  // Consecutive sections apart, and no twist between them.
  const PER = 16;
  for (let i = 0; i + 1 < oriented.length; i++) {
    const a = oriented[i],
      b = oriented[i + 1],
      la = outline(a, PER),
      lb = outline(b, PER);
    if (
      !lb.every((q) => dot(sub(q, a.points[0]), a.normal) > tolerance) ||
      !la.every((q) => dot(sub(q, b.points[0]), b.normal) < -tolerance)
    )
      throw new RangeError(
        `loft sections ${a.profile.name} and ${b.profile.name} are not apart: each must lie beyond the other's plane`,
      );
    // The outline at fraction t between the sections, flattened across the mean normal there, and its doubled area.
    const flat = (t: number) => {
        const n = unit(add(scale(a.normal, 1 - t), scale(b.normal, t)))!,
          x = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))!,
          y = cross(n, x);
        return la.map((q, k) => {
          const r = add(scale(q, 1 - t), scale(lb[k], t));
          return [dot(r, x), dot(r, y)];
        });
      },
      areaOf = (poly: number[][]) => {
        let area = 0;
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k],
            q = poly[(k + 1) % poly.length];
          area += p[0] * q[1] - q[0] * p[1];
        }
        return area;
      },
      // Between parallel sections the area is quadratic in t: its least value inside is checked as well.
      [f0, fh, f1] = [0, 0.5, 1].map((t) => areaOf(flat(t))),
      curve = 2 * (f0 + f1) - 4 * fh,
      lowest = curve > 0 ? (3 * f0 - 4 * fh + f1) / (2 * curve) : -1,
      fractions = [1, 2, 3, 4, 5, 6, 7].map((s) => s / 8);
    if (lowest > 0 && lowest < 1) fractions.push(lowest);
    for (const t of fractions) {
      const poly = flat(t),
        m = poly.length;
      let crossed = areaOf(poly) <= 1e-9 * Math.min(Math.abs(f0), Math.abs(f1));
      if (crossed)
        throw new RangeError(
          `loft sections ${a.profile.name} and ${b.profile.name} twist against each other: the faces between them would cross`,
        );
    }
  }

  const body = new Body(name, 'solid'),
    shell = body.shell(),
    segName = (k: number) => sections[0].segments[k].name ?? `e${k}`,
    generated: [Name, Name[]][] = [],
    vertices = oriented.map((s, i) => s.points.map((q, k) => new Vertex(`${name}/vertex:${i}:${k}`, q))),
    sectionEdges = oriented.map((s, i) =>
      s.profile.segments.map((g, k) => {
        const from = s.points[k];
        const curve: CurveDef =
          g.kind === 'line'
            ? { kind: 'line', origin: from, direction: unit(sub(g.to, from))! }
            : {
                kind: 'circle',
                frame: frameOf(g.center!, s.normal, sub(from, g.center!)),
                radius: length(sub(from, g.center!)),
              };
        return new Edge(
          `${name}/edge:section:${i}:${segName(k)}`,
          curve,
          vertices[i][k],
          vertices[i][(k + 1) % count],
          g.kind === 'line' || !g.clockwise,
        );
      }),
    );
  for (let i = 0; i + 1 < oriented.length; i++) {
    const a = oriented[i],
      b = oriented[i + 1],
      span = `s${i}`,
      rulings = a.points.map(
        (q, k) =>
          new Edge(
            `${name}/edge:ruling:${span}:${k}`,
            { kind: 'line', origin: q, direction: unit(sub(b.points[k], q))! },
            vertices[i][k],
            vertices[i + 1][k],
          ),
      );
    for (let k = 0; k < count; k++) {
      const ga = a.profile.segments[k],
        gb = b.profile.segments[k],
        a0 = a.points[k],
        a1 = ga.to,
        b0 = b.points[k],
        b1 = gb.to;
      let surface: SurfaceDef | undefined;
      if (ga.kind === 'line' && gb.kind === 'line') {
        const n = unit(cross(sub(a1, a0), sub(b0, a0))) ?? unit(cross(sub(b1, b0), sub(b0, a0)));
        if (n && [a1, b0, b1].every((q) => Math.abs(dot(sub(q, a0), n)) <= tolerance))
          surface = { kind: 'plane', frame: frameOf(a0, n, sub(a1, a0)) };
      } else if (ga.kind === 'arc' && gb.kind === 'arc') {
        // Coaxial arcs of one turn in parallel planes: a cylinder or a cone.
        const ca = ga.center!,
          cb = gb.center!,
          axis = unit(sub(cb, ca)),
          ra = length(sub(a0, ca)),
          rb = length(sub(b0, cb)),
          ua = unit(sub(a0, ca))!,
          ub = unit(sub(b0, cb))!;
        if (
          axis &&
          length(cross(a.normal, b.normal)) <= 1e-12 &&
          length(cross(axis, a.normal)) <= 1e-12 &&
          length(sub(ua, ub)) <= 1e-12 &&
          Math.abs(sweepOf(a0, ga, a.normal) - sweepOf(b0, gb, b.normal)) <= 1e-12
        ) {
          const h = length(sub(cb, ca));
          surface =
            Math.abs(ra - rb) <= tolerance
              ? { kind: 'cylinder', frame: frameOf(ca, axis, ua), radius: ra }
              : { kind: 'cone', frame: frameOf(ca, axis, ua), radius: ra, angle: Math.atan((rb - ra) / h) };
        }
      }
      let face: Face;
      if (surface) {
        const ma = pointAt(a, k, 0.5),
          mb = pointAt(b, k, 0.5),
          mid = scale(add(ma, mb), 0.5),
          outward = cross(add(unit(tangentAt(a, k, 0.5))!, unit(tangentAt(b, k, 0.5))!), sub(mb, ma)),
          e = surfaceEvaluator(surface),
          [u, v] = e.parameters(mid);
        face = new Face(`${name}/face:${span}/${segName(k)}`, surface, dot(e.normal(u, v), outward) > 0);
      } else {
        // A ruled B-spline: u along the segment (counter-clockwise about the loft), v from section a to b, so its
        // natural normal, along u cross v, points out of the solid.
        const pieces = Math.max(
            ...[ga, gb].map((g, side) =>
              g.kind === 'arc'
                ? Math.ceil(Math.abs(sweepOf(side ? b0 : a0, g, side ? b.normal : a.normal)) / (Math.PI / 2) - 1e-9)
                : 1,
            ),
          ),
          bilinear = ga.kind === 'line' && gb.kind === 'line',
          qa = bilinear ? { points: [a0, a1], weights: [1, 1] } : quadratic(a, k, pieces),
          qb = bilinear ? { points: [b0, b1], weights: [1, 1] } : quadratic(b, k, pieces),
          knots = bilinear ? [0, 1] : Array.from({ length: pieces + 1 }, (_, j) => j / pieces),
          mults = bilinear ? [2, 2] : knots.map((_, j) => (j === 0 || j === pieces ? 3 : 2)),
          rational = !bilinear && [...qa.weights, ...qb.weights].some((w) => w !== 1),
          closedU = count === 1;
        surface = {
          kind: 'spline',
          degrees: [bilinear ? 1 : 2, 1],
          counts: [qa.points.length, 2],
          knots: [knots, [0, 1]],
          multiplicities: [mults, [2, 2]],
          points: [...qa.points, ...qb.points],
          ...(rational ? { weights: [...qa.weights, ...qb.weights] } : {}),
          ...(closedU ? { uClosed: true } : {}),
        };
        face = new Face(`${name}/face:${span}/${segName(k)}`, surface, true);
      }
      shell.add(face);
      const loop = face.loop();
      loop.use(sectionEdges[i][k], true);
      loop.use(rulings[(k + 1) % count], true);
      loop.use(sectionEdges[i + 1][k], false);
      loop.use(rulings[k], false);
      generated.push([face.name, [`${sections[i].name}/${segName(k)}`, `${sections[i + 1].name}/${segName(k)}`]]);
    }
  }
  const first = oriented[0],
    last = oriented[oriented.length - 1],
    startFace = shell.add(
      new Face(
        `${name}/face:start`,
        {
          kind: 'plane',
          frame: frameOf(first.points[0], scale(first.normal, -1), sub(first.profile.segments[0].to, first.points[0])),
        },
        true,
      ),
    ),
    endFace = shell.add(
      new Face(
        `${name}/face:end`,
        {
          kind: 'plane',
          frame: frameOf(last.points[0], last.normal, sub(last.profile.segments[0].to, last.points[0])),
        },
        true,
      ),
    ),
    sl = startFace.loop(),
    el = endFace.loop();
  for (let k = count - 1; k >= 0; k--) sl.use(sectionEdges[0][k], false);
  for (let k = 0; k < count; k++) el.use(sectionEdges[oriented.length - 1][k], true);
  generated.push([startFace.name, [sections[0].name]], [endFace.name, [sections[sections.length - 1].name]]);
  history?.record({ operation: name, generated, modified: [], deleted: [] });
  return body;
}
