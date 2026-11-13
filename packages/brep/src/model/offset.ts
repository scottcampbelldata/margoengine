// Face offset, shell and draft on bodies of planar faces. Offsetting moves chosen faces along their outward normals by a
// distance each; their neighbours stay on their own planes and the body is re-solved round them: each vertex is where
// its faces' planes now meet, each edge the line between its new ends. Where the moved planes no longer meet in the
// same pattern (an edge would shrink to nothing or turn round, a vertex's planes no longer meet in one point) the
// topology would have to change, and the operation refuses with a RangeError naming the edge or vertex. A shell is two
// offsets and a Boolean: inward, the body less a copy offset inward (the open faces offset outward, so the cut opens
// them); outward, a copy offset outward (the open faces kept) less a copy with only the open faces offset outward.
// A draft turns faces about the lines where they meet a neutral plane, on the same re-solving core.
import { cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { boolean } from './boolean.js';
import { checkBody } from './check.js';
import { frameOf, type Frame } from './geometry.js';
import { Body, Edge, Face, Vertex, type History, type Name } from './topology.js';

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

/**
 * The body with each face named in `distances` moved along its outward normal by its distance (metres; negative moves
 * it into the material), every face keeping its name. Throws a RangeError for a body with faces not on planes, a face
 * name the body does not have, and an offset that would change the body's topology or leave it invalid.
 */
export function offsetBody(name: Name, body: Body, distances: ReadonlyMap<Name, number>, operation = name): Body {
  if (body.kind !== 'solid') throw new RangeError(`${operation}: offsets take a solid`);
  const names = new Set(body.faces.map((f) => f.name));
  for (const [n, d] of distances) {
    if (!names.has(n)) throw new RangeError(`${operation}: the body has no face ${n}`);
    if (!Number.isFinite(d)) throw new RangeError(`${operation}: the offset of ${n} must be finite`);
  }
  return replanes(name, body, (f, p) => ({ ...p, c: p.c + (distances.get(f.name) ?? 0) }), operation);
}

/**
 * The body with each face's plane replaced by `planeFor` (given the face and its plane, the normal out of the
 * material), re-solved round the new planes: the core offsets and drafts share. Throws a RangeError for faces not on
 * planes, curved edges, and new planes that change the body's topology or leave it invalid.
 */
function replanes(name: Name, body: Body, planeFor: (face: Face, plane: Plane) => Plane, operation: string): Body {
  const faces = body.faces,
    old = new Map(faces.map((f) => [f, planeOf(f, operation)])),
    moved = new Map(faces.map((f) => [f, planeFor(f, old.get(f)!)])),
    points = body.vertices.flatMap((v) => [...v.point.map(Math.abs)]),
    size = Math.max(
      ...[0, 1, 2].map((k) => {
        const xs = body.vertices.map((v) => v.point[k]);
        return Math.max(...xs) - Math.min(...xs);
      }),
    ),
    far = Math.max(0, ...points),
    // Points meet within 1e-9 of the body's size (or 1e-15 of its distance from the origin, where larger).
    tolerance = Math.max(1e-9 * size, 4e-16 * far);
  // Each vertex where its faces' moved planes meet.
  const facesAt = new Map<Vertex, Set<Face>>();
  for (const f of faces)
    for (const l of f.loops)
      for (const c of l.coedges)
        for (const v of [c.start, c.end]) {
          let s = facesAt.get(v);
          if (!s) facesAt.set(v, (s = new Set()));
          s.add(f);
        }
  const newVertex = new Map<Vertex, Vertex>();
  for (const [v, around] of facesAt) {
    const planes = [...around].map((f) => moved.get(f)!),
      at = meet(planes, v.point);
    if (!at || at.spread > tolerance)
      throw new RangeError(
        `${operation}: the faces round vertex ${v.name} no longer meet in one point; the offset would change the body's topology`,
      );
    newVertex.set(v, new Vertex(v.name, at.point, v.tolerance));
  }
  // Each edge the line between its new ends, running the way it ran.
  const newEdge = new Map<Edge, Edge>();
  for (const e of body.edges) {
    if (e.curve.kind !== 'line')
      throw new RangeError(`${operation}: edge ${e.name} is a ${e.curve.kind}; offsets support straight edges so far`);
    const a = newVertex.get(e.start)!,
      b = newVertex.get(e.end)!,
      along = sub(b.point, a.point),
      was = sub(e.end.point, e.start.point),
      d = unit(along);
    if (!d || length(along) <= tolerance || dot(along, was) <= 0)
      throw new RangeError(
        `${operation}: edge ${e.name} would shrink to nothing or turn round; the offset would change the body's topology`,
      );
    newEdge.set(e, new Edge(e.name, { kind: 'line', origin: a.point, direction: d }, a, b, true, e.tolerance));
  }
  const out = new Body(name, 'solid');
  for (const shell of body.shells) {
    const s = out.shell();
    for (const f of shell.faces) {
      // The new plane through the old frame's origin moved onto it, its natural normal the outward one's way for the
      // face's sense.
      const p = moved.get(f)!,
        frame = (f.surface as { readonly frame: Frame }).frame,
        shift = p.c - dot(p.n, frame.origin),
        origin: XYZ = [
          frame.origin[0] + shift * p.n[0],
          frame.origin[1] + shift * p.n[1],
          frame.origin[2] + shift * p.n[2],
        ],
        face = s.add(
          new Face(f.name, { kind: 'plane', frame: frameOf(origin, scale(p.n, f.sense ? 1 : -1), frame.x) }, f.sense),
        );
      for (const l of f.loops) {
        const loop = face.loop();
        for (const c of l.coedges) loop.use(newEdge.get(c.edge)!, c.forward);
      }
    }
  }
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
    if (!body.faces.some((f) => f.name === n)) throw new RangeError(`shell ${name}: the body has no face ${n}`);
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
  if (body.kind !== 'solid') throw new RangeError(`${operation}: draft takes a solid`);
  const chosen = new Set(faces);
  for (const n of chosen)
    if (!body.faces.some((f) => f.name === n)) throw new RangeError(`${operation}: the body has no face ${n}`);
  const out = replanes(
    name,
    body,
    (f, plane) => {
      if (!chosen.has(f.name)) return plane;
      // The hinge: where the face's plane meets the neutral plane.
      const hinge = unit(cross(plane.n, N));
      if (!hinge) throw new RangeError(`${operation}: face ${f.name} is parallel to the neutral plane`);
      const m = unit(sub(plane.n, scale(p, dot(plane.n, p))));
      if (!m) throw new RangeError(`${operation}: face ${f.name} is square to the pull direction`);
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
        throw new RangeError(`${operation}: face ${f.name} meets the neutral plane along a line not square to the pull`);
      return { n, c: dot(n, on) };
    },
    operation,
  );
  history?.record({ operation: name, generated: [], modified: faces.map((f) => [f, f] as const), deleted: [] });
  return out;
}
