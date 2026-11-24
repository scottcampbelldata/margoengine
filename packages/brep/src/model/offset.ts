// Face offset, shell and draft on bodies of planes, cylinders, cones, spheres and tori. Offsetting moves chosen faces
// along their outward normals by a distance each, every surface staying the same kind (a plane moves, a cylinder's,
// sphere's or cone's radius and a torus's tube grow or shrink); their neighbours stay on their own surfaces and the
// body is re-solved round them: each vertex is where its faces' surfaces now meet (the nearest such point, so a vertex
// on a seam stays on its meridian), each edge the line between its new ends or the circle about its old axis through
// them. Where the moved surfaces no longer meet in the same pattern (an edge would shrink to nothing or turn round, a
// vertex's surfaces no longer meet in one point, a face would shrink to nothing, an edge would no longer lie on both
// its faces as where a circle would turn into another curve) the topology would have to change, and the operation
// refuses with a RangeError naming the edge, vertex or face. A shell is two offsets and a Boolean: inward, the body
// less a copy offset inward (the open faces offset outward, so the cut opens them); outward, a copy offset outward
// (the open faces kept) less a copy with only the open faces offset outward. With no open face the hollow is a cavity
// (a hollow sphere). A draft turns faces about the lines where they meet a neutral plane, on the same re-solving core;
// a drafted cylinder or cone about an axis along the pull becomes a cone through its circle on the neutral plane.
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { boolean } from './boolean.js';
import { checkBody } from './check.js';
import { curveEvaluator, frameOf, sliceCurve, type CurveDef, type Frame, type SurfaceDef } from './geometry.js';
import { intersectSurfaces } from './intersect.js';
import { Body, Edge, Face, Vertex, type History, type Name } from './topology.js';
import { edgeParameters } from './validate.js';

/** A face's plane with its outward normal: points x with n . x = c. */
interface Plane {
  readonly n: XYZ;
  readonly c: number;
}

/** The plane of a planar face, its normal out of the material; throws for a face on any other surface. */
function planeOf(face: Face, operation: string): Plane {
  if (face.surface.kind !== 'plane')
    throw new RangeError(
      `${operation}: face ${face.name} is on a ${face.surface.kind}; offsets support bodies of planar faces so far`,
    );
  const n = scale(face.surface.frame.z, face.sense ? 1 : -1);
  return { n, c: dot(n, face.surface.frame.origin) };
}

/** A planar face's new surface on `p` (normal out of the material): its old frame's origin moved onto it, its natural
 * normal the outward one's way for the face's sense. */
function planeSurface(face: Face, p: Plane): SurfaceDef {
  const frame = (face.surface as { readonly frame: Frame }).frame,
    shift = p.c - dot(p.n, frame.origin);
  return { kind: 'plane', frame: frameOf(add(frame.origin, scale(p.n, shift)), scale(p.n, face.sense ? 1 : -1), frame.x) };
}

/** The point where three or more planes meet (least squares over all of them), or undefined when they do not fix one. */
function meet(planes: readonly Plane[], near: XYZ): { point: XYZ; spread: number } | undefined {
  // Normal equations A^T A x = A^T b, solved about `near` for conditioning: A = normals, b = c - n . near.
  const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    r = [0, 0, 0];
  for (const { n, c } of planes) {
    const b = c - dot(n, near);
    for (let i = 0; i < 3; i++) {
      r[i] += n[i] * b;
      for (let j = 0; j < 3; j++) m[i][j] += n[i] * n[j];
    }
  }
  const det = dot(m[0], cross(m[1], m[2]));
  // Two planes (or parallel ones) leave a line: the point on it nearest the old vertex.
  if (Math.abs(det) <= 1e-12) {
    if (planes.length < 2) return undefined;
    const [p, q] = planes,
      d = unit(cross(p.n, q.n));
    if (!d) return undefined;
    // On both planes, square to d through `near`: solve in the basis n_p, n_q.
    const pp = dot(p.n, p.n),
      pq = dot(p.n, q.n),
      qq = dot(q.n, q.n),
      bp = p.c - dot(p.n, near),
      bq = q.c - dot(q.n, near),
      den = pp * qq - pq * pq,
      a = (bp * qq - bq * pq) / den,
      b = (bq * pp - bp * pq) / den,
      point: XYZ = [
        near[0] + a * p.n[0] + b * q.n[0],
        near[1] + a * p.n[1] + b * q.n[1],
        near[2] + a * p.n[2] + b * q.n[2],
      ];
    return { point, spread: Math.max(...planes.map((pl) => Math.abs(dot(pl.n, point) - pl.c))) };
  }
  // Cramer's rule.
  const col = (k: number): number[][] => m.map((row, i) => row.map((x, j) => (j === k ? r[i] : x))),
    det3 = (a: number[][]) => dot(a[0], cross(a[1], a[2])),
    x: XYZ = [det3(col(0)) / det, det3(col(1)) / det, det3(col(2)) / det],
    point: XYZ = [near[0] + x[0], near[1] + x[1], near[2] + x[2]];
  return { point, spread: Math.max(...planes.map((pl) => Math.abs(dot(pl.n, point) - pl.c))) };
}

/** The outward offset of a face's surface by `d` (metres, negative into the material): the same kind of surface. */
function offsetSurface(face: Face, d: number, operation: string): SurfaceDef {
  const s = face.surface,
    // Along the surface's natural normal (away from the axis, the centre or the tube's centre).
    n = face.sense ? d : -d,
    shrunk = () =>
      new RangeError(`${operation}: face ${face.name} would shrink to nothing; the offset would change the body's topology`);
  switch (s.kind) {
    case 'plane':
      return { kind: 'plane', frame: { ...s.frame, origin: add(s.frame.origin, scale(s.frame.z, n)) } };
    case 'cylinder':
      if (!(s.radius + n > 0)) throw shrunk();
      return { ...s, radius: s.radius + n };
    case 'cone':
      if (!(s.radius + n / Math.cos(s.angle) > 0)) throw shrunk();
      return { ...s, radius: s.radius + n / Math.cos(s.angle) };
    case 'sphere':
      if (!(s.radius + n > 0)) throw shrunk();
      return { ...s, radius: s.radius + n };
    case 'torus':
      if (!(s.minor + n > 0 && s.minor + n < s.major)) throw shrunk();
      return { ...s, minor: s.minor + n };
    default:
      throw new RangeError(
        `${operation}: face ${face.name} is on a ${s.kind}; offsets support planes, cylinders, cones, spheres and tori`,
      );
  }
}

/** Signed distance from an analytic surface along its natural normal (exact near the surface). */
function distanceFrom(s: SurfaceDef, p: XYZ): number {
  if (s.kind === 'spline') return NaN;
  const r = sub(p, s.frame.origin),
    h = dot(r, s.frame.z),
    rho = length(sub(r, scale(s.frame.z, h)));
  switch (s.kind) {
    case 'plane':
      return h;
    case 'cylinder':
      return rho - s.radius;
    case 'cone':
      return (rho - s.radius - h * Math.tan(s.angle)) * Math.cos(s.angle);
    case 'sphere':
      return length(r) - s.radius;
    case 'torus':
      return Math.hypot(rho - s.major, h) - s.minor;
  }
}

/** Solves a small system by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length,
    M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = M[r][n];
    for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k];
    x[r] = v / M[r][r];
  }
  return x;
}

/**
 * The point nearest `near` on all the surfaces (Gauss-Newton with minimum-norm steps, so where the surfaces leave a
 * curve the point moves square to it: a vertex on a seam stays on its seam's meridian), and how far it is from the
 * farthest of them.
 */
function meetSurfaces(surfaces: readonly SurfaceDef[], near: XYZ, size: number): { point: XYZ; spread: number } {
  let x = near;
  const h = 1e-7 * size,
    residuals = (q: XYZ) => surfaces.map((s) => distanceFrom(s, q));
  for (let iteration = 0; iteration < 60; iteration++) {
    const r = residuals(x),
      J = surfaces.map((s) =>
        [0, 1, 2].map((k) => {
          const a = [...x] as XYZ,
            b = [...x] as XYZ;
          a[k] += h;
          b[k] -= h;
          return (distanceFrom(s, a) - distanceFrom(s, b)) / (2 * h);
        }),
      );
    // The independent rows (up to three): a row in the span of those kept adds nothing.
    const rows: number[] = [];
    for (let i = 0; i < J.length && rows.length < 3; i++) {
      const trial = [...rows, i].map((k) => J[k]),
        gram = trial.map((a) => trial.map((b) => dot(a, b))),
        det =
          trial.length === 1
            ? gram[0][0]
            : trial.length === 2
              ? gram[0][0] * gram[1][1] - gram[0][1] * gram[1][0]
              : dot(trial[0], cross(trial[1], trial[2])) ** 2;
      if (det > 1e-10 * trial.reduce((p, g) => p * dot(g, g), 1)) rows.push(i);
    }
    // Minimum-norm step: dx = -J^T (J J^T)^-1 r over the kept rows.
    const y = solve(
      rows.map((a) => rows.map((b) => dot(J[a], J[b]))),
      rows.map((k) => -r[k]),
    );
    let dx: XYZ = [0, 0, 0];
    rows.forEach((k, i) => {
      dx = add(dx, scale(J[k], y[i]));
    });
    x = add(x, dx);
    if (length(dx) <= 1e-15 * Math.max(size, length(x))) break;
  }
  return { point: x, spread: Math.max(...residuals(x).map(Math.abs)) };
}

/**
 * The body with each face named in `distances` moved along its outward normal by its distance (metres; negative moves
 * it into the material), every face keeping its name and kind of surface. Throws a RangeError for a body with faces
 * not on planes, cylinders, cones, spheres or tori, a face name the body does not have, and an offset that would
 * change the body's topology or leave it invalid.
 */
export function offsetBody(name: Name, body: Body, distances: ReadonlyMap<Name, number>, operation = name): Body {
  if (body.kind !== 'solid') throw new RangeError(`${operation}: offsets take a solid; pass a body of kind solid`);
  const names = new Set(body.faces.map((f) => f.name));
  for (const [n, d] of distances) {
    if (!names.has(n)) throw new RangeError(`${operation}: the body has no face ${n}; name a face of the body`);
    if (!Number.isFinite(d)) throw new RangeError(`${operation}: the offset of ${n} must be finite`);
  }
  return resurface(
    name,
    body,
    (f) => {
      const d = distances.get(f.name) ?? 0;
      return d ? offsetSurface(f, d, operation) : f.surface;
    },
    operation,
  );
}

/** Whether faces of this kind can be re-solved (and turn into `to`: a drafted cylinder becomes a cone). */
const analytic = (from: SurfaceDef, to: SurfaceDef) =>
  from.kind !== 'spline' && (from.kind === to.kind || (from.kind === 'cylinder' && to.kind === 'cone'));

/**
 * The body with each face's surface replaced by `surfaceFor`, re-solved round the new surfaces: each vertex where its
 * faces' new surfaces meet, each line edge the line between its new ends, each circle edge the circle about its old
 * axis through its new ends. The core offsets and drafts share. Throws a RangeError for faces on other surfaces,
 * edges on other curves, and new surfaces that change the body's topology or leave it invalid (an edge that would no
 * longer lie on both its faces, as where a circle would become another curve).
 */
function resurface(name: Name, body: Body, surfaceFor: (face: Face) => SurfaceDef, operation: string): Body {
  const faces = body.faces;
  for (const f of faces)
    if (f.surface.kind === 'spline')
      throw new RangeError(
        `${operation}: face ${f.name} is on a spline; offsets support planes, cylinders, cones, spheres and tori`,
      );
  const moved = new Map(faces.map((f) => [f, surfaceFor(f)]));
  for (const f of faces)
    if (!analytic(f.surface, moved.get(f)!))
      throw new RangeError(`${operation}: face ${f.name} cannot turn from a ${f.surface.kind} into a ${moved.get(f)!.kind}; use a smaller offset or a different face`);
  const corners = body.vertices.map((v) => v.point),
    radii = faces.flatMap((f) => {
      const s = f.surface;
      return s.kind === 'sphere' || s.kind === 'cylinder' || s.kind === 'cone'
        ? [s.radius]
        : s.kind === 'torus'
          ? [s.major + s.minor]
          : [];
    }),
    size = Math.max(
      ...[0, 1, 2].map((k) =>
        corners.length ? Math.max(...corners.map((q) => q[k])) - Math.min(...corners.map((q) => q[k])) : 0,
      ),
      ...radii.map((r) => 2 * Math.abs(r)),
    ),
    far = Math.max(0, ...corners.flatMap((q) => q.map(Math.abs))),
    // Points meet within 1e-9 of the body's size (or 1e-15 of its distance from the origin, where larger).
    tolerance = Math.max(1e-9 * size, 4e-16 * far);
  // Each vertex where its faces' new surfaces meet.
  const facesAt = new Map<Vertex, Set<Face>>(),
    facesOf = new Map<Edge, Face[]>();
  for (const f of faces)
    for (const l of f.loops)
      for (const c of l.coedges) {
        facesOf.set(c.edge, [...(facesOf.get(c.edge) ?? []), f]);
        for (const v of [c.start, c.end]) {
          let s = facesAt.get(v);
          if (!s) facesAt.set(v, (s = new Set()));
          s.add(f);
        }
      }
  const newVertex = new Map<Vertex, Vertex>();
  for (const [v, around] of facesAt) {
    const surfaces = [...around].map((f) => moved.get(f)!),
      at = surfaces.every((s) => s.kind === 'plane')
        ? meet(
            surfaces.map((s) => {
              const frame = (s as { readonly frame: Frame }).frame;
              return { n: frame.z, c: dot(frame.z, frame.origin) };
            }),
            v.point,
          )
        : meetSurfaces(surfaces, v.point, size);
    if (!at || at.spread > tolerance)
      throw new RangeError(
        `${operation}: the faces round vertex ${v.name} no longer meet in one point; the offset would change the body's topology`,
      );
    newVertex.set(v, new Vertex(v.name, at.point, v.tolerance));
  }
  // Each edge through its new ends, on both its faces' new surfaces, running the way it ran.
  const changed = (e: Edge) =>
    new RangeError(
      `${operation}: edge ${e.name} would shrink to nothing or turn round; the offset would change the body's topology`,
    );
  const newEdge = new Map<Edge, Edge>();
  /** The new edge from a to b on its two faces' new surfaces, where it is no line or circle: traced, as a Boolean does. */
  const retrace = (e: Edge, a: Vertex, b: Vertex): { curve: CurveDef; sense: boolean; inside: XYZ[] } | undefined => {
    const [f1, f2] = facesOf.get(e) ?? [];
    if (!f1 || !f2 || f1 === f2) return undefined;
    const s1 = moved.get(f1)!,
      s2 = moved.get(f2)!,
      old = curveEvaluator(e.curve),
      along = edgeParameters(e, 32).map((t) => old.at(t).slice(0, 3) as XYZ),
      // The new curve lies within a few times the faces' moves of the old one, where its surfaces cross at an angle.
      shift = Math.max(
        length(sub(a.point, e.start.point)),
        length(sub(b.point, e.end.point)),
        ...along.flatMap((p) => [Math.abs(distanceFrom(s1, p)), Math.abs(distanceFrom(s2, p))]),
      ),
      pad = 4 * shift + tolerance,
      min = [0, 1, 2].map((k) => Math.min(...along.map((p) => p[k]), a.point[k], b.point[k]) - pad) as XYZ,
      max = [0, 1, 2].map((k) => Math.max(...along.map((p) => p[k]), a.point[k], b.point[k]) + pad) as XYZ,
      met = intersectSurfaces(s1, s2, { min, max }, tolerance);
    if (met.kind !== 'curves') return undefined;
    const middle = along[16],
      ahead = sub(along[1], along[0]);
    let best: { curve: CurveDef; sense: boolean; off: number } | undefined;
    for (const curve of met.curves) {
      const c = curveEvaluator(curve),
        ta = c.parameter(a.point),
        tb = e.closed ? ta : c.parameter(b.point, ta);
      if (length(sub(c.at(ta).slice(0, 3) as XYZ, a.point)) > tolerance) continue;
      if (length(sub(c.at(tb).slice(0, 3) as XYZ, b.point)) > tolerance) continue;
      const sense = dot(c.at(ta).slice(3, 6) as XYZ, ahead) > 0,
        off = length(sub(c.at(c.parameter(middle)).slice(0, 3) as XYZ, middle));
      if (!best || off < best.off) best = { curve, sense, off };
    }
    if (!best) return undefined;
    let { curve } = best;
    const c = curveEvaluator(curve);
    // A traced curve may run past the edge's ends (out of the box, or round a loop): only the edge's own stretch.
    if (!e.closed && curve.kind === 'spline') {
      const ta = c.parameter(a.point),
        tb = c.parameter(b.point, ta);
      if ((tb > ta) !== best.sense) return undefined;
      curve = sliceCurve(curve, Math.min(ta, tb), Math.max(ta, tb));
    }
    const edge = new Edge(e.name, curve, a, b, best.sense, e.tolerance),
      inside = edgeParameters(edge, 4)
        .slice(1, -1)
        .map((t) => curveEvaluator(curve).at(t).slice(0, 3) as XYZ);
    return { curve, sense: best.sense, inside };
  };
  for (const e of body.edges) {
    const a = newVertex.get(e.start)!,
      b = newVertex.get(e.end)!;
    let curve: CurveDef | undefined, inside: XYZ[] = [];
    if (e.curve.kind === 'line') {
      const along = sub(b.point, a.point),
        d = unit(along);
      if (!d || length(along) <= tolerance || dot(along, sub(e.end.point, e.start.point)) <= 0) throw changed(e);
      curve = { kind: 'line', origin: a.point, direction: d };
      inside = [0.25, 0.5, 0.75].map((t) => add(a.point, scale(along, t)));
    } else if (e.curve.kind === 'circle') {
      // About the old axis: the centre where the new start's level meets it.
      const f0 = e.curve.frame,
        center = add(f0.origin, scale(f0.z, dot(sub(a.point, f0.origin), f0.z))),
        radius = length(sub(a.point, center));
      if (!(radius > tolerance)) throw changed(e);
      const frame: Frame = { ...f0, origin: center },
        angleOf = (fr: Frame, q: XYZ) => {
          const r = sub(q, fr.origin);
          return Math.atan2(dot(r, fr.y), dot(r, fr.x));
        },
        turnOf = (fr: Frame, p: XYZ, q: XYZ) => {
          if (e.closed) return 2 * Math.PI;
          let t = (angleOf(fr, q) - angleOf(fr, p)) * (e.sameSense ? 1 : -1);
          while (t <= 0) t += 2 * Math.PI;
          return t;
        },
        before = turnOf(f0, e.start.point, e.end.point),
        after = turnOf(frame, a.point, b.point);
      // Its new end off the circle through its new start: the edge becomes another curve, traced below.
      if (Math.abs(length(sub(b.point, center)) - radius) <= tolerance) {
        if (Math.abs(after - before) >= Math.PI / 2 || after * radius <= tolerance) throw changed(e);
        curve = { kind: 'circle', frame, radius };
        const t0 = angleOf(frame, a.point),
          sign = e.sameSense ? 1 : -1;
        inside = [0.25, 0.5, 0.75].map((t) => {
          const u = t0 + sign * after * t;
          return add(center, add(scale(f0.x, radius * Math.cos(u)), scale(f0.y, radius * Math.sin(u))));
        });
      }
    }
    const off = (points: readonly XYZ[]) =>
      (facesOf.get(e) ?? []).find((f) => points.some((q) => Math.abs(distanceFrom(moved.get(f)!, q)) > tolerance));
    let sense = e.sameSense,
      leaves = curve ? off(inside) : undefined;
    // A line or circle that no longer lies on both faces (a plane moved off a torus's axis cuts it in no circle), and
    // an edge on another curve (a spline a Boolean traced): the new faces' own intersection between the new ends.
    if (!curve || leaves) {
      const traced = retrace(e, a, b);
      if (traced) {
        ({ curve, sense } = traced);
        leaves = off(traced.inside);
      }
    }
    if (!curve || leaves)
      throw new RangeError(
        `${operation}: edge ${e.name} would leave face ${(leaves ?? (facesOf.get(e) ?? [])[0])?.name} and no curve of its faces' new surfaces runs between its new ends; the offset would change the body's topology`,
      );
    newEdge.set(e, new Edge(e.name, curve, a, b, sense, e.tolerance));
  }
  const out = new Body(name, 'solid');
  for (const shell of body.shells) {
    const s = out.shell();
    for (const f of shell.faces) {
      const face = s.add(new Face(f.name, moved.get(f)!, f.sense));
      for (const l of f.loops) {
        const loop = face.loop();
        for (const c of l.coedges) loop.use(newEdge.get(c.edge)!, c.forward);
      }
    }
  }
  body.shells.forEach((shell, i) => {
    if (shell.outer) out.shells[i].outer = out.shells[body.shells.indexOf(shell.outer)];
  });
  // Moved this far, a face can cross another one: the full check, not only the topology.
  const problems = checkBody(out);
  if (problems.length)
    throw new RangeError(
      `${operation}: the offset body is not valid (${problems.length} problems; ${problems[0].name}: ${problems[0].problem})`,
    );
  return out;
}

/**
 * Moves the faces of `body` named in `faces` along their outward normals by `distance` metres (negative into the
 * material) and re-solves their neighbours, into a body named `name`. Throws a RangeError where `offsetBody` does.
 */
export function offsetFaces(
  name: Name,
  body: Body,
  faces: readonly Name[],
  distance: number,
  { history }: { history?: History } = {},
): Body {
  if (!faces.length) throw new RangeError('offset needs at least one face');
  const out = offsetBody(name, body, new Map(faces.map((f) => [f, distance])), `offset ${name}`);
  history?.record({ operation: name, generated: [], modified: faces.map((f) => [f, f] as const), deleted: [] });
  return out;
}

/**
 * Hollows `body` into walls `thickness` metres thick, open at the faces named in `open`: outside the body when
 * thickness is positive (the body's faces are the walls' inner faces), inside it when negative (its faces are their
 * outer faces). With no open face the hollow is a closed cavity. Throws a RangeError for a zero or non-finite
 * thickness, and where the offsets would change the body's topology (walls too thick for a face).
 */
export function shell(
  name: Name,
  body: Body,
  open: readonly Name[],
  thickness: number,
  { history }: { history?: History } = {},
): Body {
  if (!(thickness !== 0 && Number.isFinite(thickness))) throw new RangeError('shell thickness must be non-zero and finite');
  const t = Math.abs(thickness),
    opening = new Set(open),
    all = (inside: number, atOpen: number) =>
      new Map(body.faces.map((f) => [f.name, opening.has(f.name) ? atOpen : inside] as const));
  for (const n of opening)
    if (!body.faces.some((f) => f.name === n)) throw new RangeError(`shell ${name}: the body has no face ${n}; name a face of the body`);
  let out: Body;
  if (thickness < 0) {
    const inner = offsetBody(`${name}/inner`, body, all(-t, t), `shell ${name}`);
    out = boolean(name, 'subtract', body, inner, { history });
  } else {
    const outer = offsetBody(`${name}/outer`, body, all(t, 0), `shell ${name}`),
      cutter = offsetBody(`${name}/cutter`, body, all(0, t), `shell ${name}`);
    out = boolean(name, 'subtract', outer, cutter, { history });
  }
  return out;
}

/**
 * Drafts the faces of `body` named in `faces` by `angle` radians for a mould pulled along `pull`: each turns about the
 * line where it meets the neutral plane (through `neutral.origin`, normal `neutral.normal`) until it makes `angle`
 * with the pull direction, a positive angle leaning its outward normal towards `pull` (the faces close in along it).
 * The other faces stay on their planes and the body is re-solved round the drafted ones. Throws a RangeError for an
 * angle not inside (-90, 90) degrees, a face parallel to the neutral plane or square to the pull, one meeting the
 * neutral plane along a line not square to the pull, and where the new planes would change the body's topology.
 */
export function draft(
  name: Name,
  body: Body,
  faces: readonly Name[],
  neutral: { readonly origin: XYZ; readonly normal: XYZ },
  pull: XYZ,
  angle: number,
  { history }: { history?: History } = {},
): Body {
  const operation = `draft ${name}`,
    p = unit(pull),
    N = unit(neutral.normal);
  if (!p || !N) throw new RangeError(`${operation}: the pull direction and the neutral plane's normal must not be zero`);
  if (!(Math.abs(angle) < Math.PI / 2))
    throw new RangeError(`${operation}: the draft angle must lie inside (-90, 90) degrees`);
  if (!faces.length) throw new RangeError(`${operation}: draft needs at least one face`);
  if (body.kind !== 'solid') throw new RangeError(`${operation}: draft takes a solid; pass a body of kind solid`);
  const chosen = new Set(faces);
  for (const n of chosen)
    if (!body.faces.some((f) => f.name === n)) throw new RangeError(`${operation}: the body has no face ${n}; name a face of the body`);
  const out = resurface(
    name,
    body,
    (f) => {
      if (!chosen.has(f.name)) return f.surface;
      const s = f.surface;
      if (s.kind === 'cylinder' || s.kind === 'cone') {
        // About its axis, which must run along the pull, square to the neutral plane: a cone through the circle where
        // the face meets the neutral plane, its radius shrinking along the pull for a boss (outward away from the
        // axis) and growing for a hole.
        const z = s.frame.z;
        if (length(cross(z, p)) > 1e-12 || length(cross(z, N)) > 1e-12)
          throw new RangeError(
            `${operation}: face ${f.name} is a ${s.kind} whose axis does not run along the pull, square to the neutral plane`,
          );
        const t = dot(sub(neutral.origin, s.frame.origin), N) / dot(z, N),
          radius = s.kind === 'cylinder' ? s.radius : s.radius + t * Math.tan(s.angle);
        if (!(radius > 0)) throw new RangeError(`${operation}: face ${f.name} does not reach the neutral plane; draft a face that crosses it`);
        return {
          kind: 'cone',
          frame: { ...s.frame, origin: add(s.frame.origin, scale(z, t)) },
          radius,
          angle: (f.sense ? -angle : angle) * Math.sign(dot(z, p)),
        };
      }
      const plane = planeOf(f, operation);
      // The hinge: where the face's plane meets the neutral plane.
      const hinge = unit(cross(plane.n, N));
      if (!hinge) throw new RangeError(`${operation}: face ${f.name} is parallel to the neutral plane; draft a face that crosses it`);
      const m = unit(sub(plane.n, scale(p, dot(plane.n, p))));
      if (!m) throw new RangeError(`${operation}: face ${f.name} is square to the pull direction; leave this face out of the draft`);
      // A point on the hinge: on both planes, in the span of their normals from the neutral plane's origin.
      const o = neutral.origin,
        a = dot(plane.n, plane.n),
        b = dot(plane.n, N),
        c = dot(N, N),
        bp = plane.c - dot(plane.n, o),
        den = a * c - b * b,
        x = (bp * c) / den,
        y = (-bp * b) / den,
        on: XYZ = [o[0] + x * plane.n[0] + y * N[0], o[1] + x * plane.n[1] + y * N[1], o[2] + x * plane.n[2] + y * N[2]],
        n = unit([
          Math.cos(angle) * m[0] + Math.sin(angle) * p[0],
          Math.cos(angle) * m[1] + Math.sin(angle) * p[1],
          Math.cos(angle) * m[2] + Math.sin(angle) * p[2],
        ])!;
      // The new plane holds the hinge only when its normal is square to it.
      if (Math.abs(dot(n, hinge)) > 1e-12)
        throw new RangeError(`${operation}: face ${f.name} meets the neutral plane along a line not square to the pull; choose a pull direction square to that line`);
      return planeSurface(f, { n, c: dot(n, on) });
    },
    operation,
  );
  history?.record({ operation: name, generated: [], modified: faces.map((f) => [f, f] as const), deleted: [] });
  return out;
}
