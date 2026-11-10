import type { GeometryData } from './data.js';

// Quickhull in 3D (Barber, Dobkin and Huhdanpaa, "The Quickhull Algorithm for Convex Hulls", ACM TOMS 22(4), 1996):
// start from a tetrahedron of extreme points, give every outside point to the face it lies farthest above, then
// repeatedly take a face's farthest point (the eye), remove every face it can see, and fan new faces from the eye to the
// horizon. Points within `tolerance` of a face count as on it, so duplicate and coplanar points never become vertices.

class HalfEdge {
  next!: HalfEdge;
  prev!: HalfEdge;
  twin!: HalfEdge;
  constructor(
    /** The vertex this edge points to; its tail is `prev.head`. */
    readonly head: number,
    readonly face: Face,
  ) {}
}

class Face {
  edge!: HalfEdge;
  nx = 0;
  ny = 0;
  nz = 0;
  offset = 0;
  /** Outside points this face owns. */
  outside: number[] = [];
  /** The outside point farthest above this face (the first of equals), kept as points are assigned. */
  farPoint = -1;
  farDistance = -Infinity;
  /** 0 on the hull, 1 seen from the current eye (being removed), 2 removed. */
  mark = 0;
  distance(points: Float64Array, i: number): number {
    return this.nx * points[i * 3] + this.ny * points[i * 3 + 1] + this.nz * points[i * 3 + 2] - this.offset;
  }
}

function face(points: Float64Array, a: number, b: number, c: number): Face {
  const f = new Face(),
    ab = new HalfEdge(b, f),
    bc = new HalfEdge(c, f),
    ca = new HalfEdge(a, f);
  ab.next = bc;
  bc.next = ca;
  ca.next = ab;
  ab.prev = ca;
  bc.prev = ab;
  ca.prev = bc;
  f.edge = ab;
  const ax = points[a * 3],
    ay = points[a * 3 + 1],
    az = points[a * 3 + 2],
    ux = points[b * 3] - ax,
    uy = points[b * 3 + 1] - ay,
    uz = points[b * 3 + 2] - az,
    vx = points[c * 3] - ax,
    vy = points[c * 3 + 1] - ay,
    vz = points[c * 3 + 2] - az,
    nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx,
    length = Math.hypot(nx, ny, nz);
  if (!(length > 0)) throw degenerate();
  f.nx = nx / length;
  f.ny = ny / length;
  f.nz = nz / length;
  // Offset through the centroid, which rounds better than through one corner.
  f.offset = (f.nx * (3 * ax + ux + vx) + f.ny * (3 * ay + uy + vy) + f.nz * (3 * az + uz + vz)) / 3;
  return f;
}

const degenerate = () =>
  new RangeError(
    'convexGeometry could not close the hull because these points are nearly degenerate; remove near-duplicate points',
  );

function link(a: HalfEdge, b: HalfEdge): void {
  a.twin = b;
  b.twin = a;
}

/** Copies points given as [x, y, z] arrays or as flat xyz numbers into a Float64Array, rejecting bad input. */
function readPoints(input: ArrayLike<number> | readonly ArrayLike<number>[]): Float64Array {
  if (!input || typeof input !== 'object' || typeof input.length !== 'number')
    throw new TypeError('convexGeometry needs points: an array of [x, y, z] or flat x, y, z numbers');
  const nested = input.length > 0 && typeof input[0] === 'object';
  if (!nested && input.length % 3)
    throw new RangeError(`convexGeometry got ${input.length} numbers; pass three (x, y, z) per point`);
  const count = nested ? input.length : input.length / 3,
    points = new Float64Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let c = 0; c < 3; c++) {
      const point = nested ? (input as readonly ArrayLike<number>[])[i] : undefined;
      if (nested && (!point || point.length !== 3))
        throw new TypeError(`convexGeometry point ${i} needs three numbers; pass [x, y, z]`);
      const value = point ? point[c] : (input as ArrayLike<number>)[i * 3 + c];
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new RangeError(`convexGeometry point ${i} is not finite; pass finite coordinates`);
      points[i * 3 + c] = value;
    }
  return points;
}

/** The hull's faces as point index triples, counter-clockwise seen from outside. */
function quickhull(
  points: Float64Array,
  allowEmpty = false,
  signal?: AbortSignal,
): { faces: Face[]; tolerance: number } {
  const count = points.length / 3;
  if (count < 4 && allowEmpty) return { faces: [], tolerance: 0 };
  if (count < 4)
    throw new RangeError(`convexGeometry got ${count} points; pass at least four points that are not in one plane`);
  // Roundoff bound for plane distances, scaled by the coordinates' magnitude.
  let scale = 0;
  for (let c = 0; c < 3; c++) {
    let max = 0;
    for (let i = 0; i < count; i++) max = Math.max(max, Math.abs(points[i * 3 + c]));
    scale += max;
  }
  const tolerance = scale * 1e-10;
  const at = (i: number, c: number) => points[i * 3 + c];
  // Initial simplex: the farthest pair of axis extremes, the point farthest from their line, then from their plane.
  const extremes: number[] = [];
  for (let c = 0; c < 3; c++) {
    let lo = 0,
      hi = 0;
    for (let i = 1; i < count; i++) {
      if (at(i, c) < at(lo, c)) lo = i;
      if (at(i, c) > at(hi, c)) hi = i;
    }
    extremes.push(lo, hi);
  }
  let v0 = 0,
    v1 = 0,
    best = -1;
  for (let i = 0; i < extremes.length; i++)
    for (let j = i + 1; j < extremes.length; j++) {
      const a = extremes[i],
        b = extremes[j],
        d = Math.hypot(at(a, 0) - at(b, 0), at(a, 1) - at(b, 1), at(a, 2) - at(b, 2));
      if (d > best) [best, v0, v1] = [d, a, b];
    }
  if (!(best > tolerance)) {
    if (allowEmpty) return { faces: [], tolerance };
    throw new RangeError('convexGeometry points all coincide; pass points that span a volume');
  }
  const dx = at(v1, 0) - at(v0, 0),
    dy = at(v1, 1) - at(v0, 1),
    dz = at(v1, 2) - at(v0, 2),
    dl = Math.hypot(dx, dy, dz);
  let v2 = -1;
  best = tolerance;
  for (let i = 0; i < count; i++) {
    const px = at(i, 0) - at(v0, 0),
      py = at(i, 1) - at(v0, 1),
      pz = at(i, 2) - at(v0, 2),
      d = Math.hypot(py * dz - pz * dy, pz * dx - px * dz, px * dy - py * dx) / dl;
    if (d > best) [best, v2] = [d, i];
  }
  if (v2 < 0) {
    if (allowEmpty) return { faces: [], tolerance };
    throw new RangeError('convexGeometry points are all on one line; pass points that span a volume');
  }
  const base = face(points, v0, v1, v2);
  let v3 = -1;
  best = tolerance;
  for (let i = 0; i < count; i++) {
    const d = Math.abs(base.distance(points, i));
    if (d > best) [best, v3] = [d, i];
  }
  if (v3 < 0) {
    if (allowEmpty) return { faces: [], tolerance };
    throw new RangeError('convexGeometry points are all in one plane; pass points that span a volume');
  }
  // Orient the base so the fourth point is behind it.
  if (base.distance(points, v3) > 0) [v1, v2] = [v2, v1];
  const faces = [
    face(points, v0, v1, v2),
    face(points, v3, v1, v0),
    face(points, v3, v2, v1),
    face(points, v3, v0, v2),
  ];
  const edges = new Map<string, HalfEdge>();
  for (const f of faces)
    for (let e = f.edge, k = 0; k < 3; k++, e = e.next) {
      const twin = edges.get(e.head + ',' + e.prev.head);
      if (twin) link(e, twin);
      else edges.set(e.prev.head + ',' + e.head, e);
    }
  const assign = (candidates: readonly Face[], point: number) => {
    let owner: Face | undefined,
      far = tolerance;
    for (const f of candidates) {
      if (f.mark) continue;
      const d = f.distance(points, point);
      if (d > far) [far, owner] = [d, f];
    }
    if (!owner) return;
    owner.outside.push(point);
    // Strictly greater keeps the first of equally distant points, as a scan of the outside list in order would.
    if (far > owner.farDistance) {
      owner.farDistance = far;
      owner.farPoint = point;
    }
  };
  for (let i = 0; i < count; i++) if (i !== v0 && i !== v1 && i !== v2 && i !== v3) assign(faces, i);

  // Faces only gain points when created, so one pass over the growing list visits every face that has any.
  const horizon: HalfEdge[] = [],
    visible: Face[] = [],
    stack: { edge: HalfEdge; stop: HalfEdge; started: boolean }[] = [];
  for (let index = 0; index < faces.length; index++) {
    signal?.throwIfAborted();
    const current = faces[index];
    if (current.mark || !current.outside.length) continue;
    const eye = current.farPoint;
    // Depth-first walk over the faces the eye sees, collecting the horizon in counter-clockwise order.
    horizon.length = visible.length = 0;
    current.mark = 1;
    visible.push(current);
    stack.push({ edge: current.edge, stop: current.edge, started: false });
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.started && frame.edge === frame.stop) {
        stack.pop();
        continue;
      }
      frame.started = true;
      const edge = frame.edge,
        other = edge.twin.face;
      frame.edge = edge.next;
      if (other.mark) continue;
      if (other.distance(points, eye) > tolerance) {
        other.mark = 1;
        visible.push(other);
        stack.push({ edge: edge.twin.next, stop: edge.twin.next, started: false });
      } else horizon.push(edge);
    }
    for (let i = 0; i < horizon.length; i++)
      if (horizon[i].head !== horizon[(i + 1) % horizon.length].prev.head) throw degenerate();
    const created: Face[] = [];
    for (const edge of horizon) {
      const f = face(points, edge.prev.head, edge.head, eye);
      link(f.edge, edge.twin);
      created.push(f);
    }
    for (let i = 0; i < created.length; i++) link(created[i].edge.next, created[(i + 1) % created.length].edge.prev);
    for (const f of visible) {
      f.mark = 2;
      for (const p of f.outside) if (p !== eye) assign(created, p);
      f.outside = [];
    }
    faces.push(...created);
  }
  return { faces: faces.filter((f) => !f.mark), tolerance };
}

/** Options for the source-index hull API. */
export interface ConvexHullTriangleOptions {
  /** Cooperative cancellation during hull expansion. */
  signal?: AbortSignal;
}

/** Outward triangle indices into the original points, without float32 position conversion.
 * Coincident, collinear, coplanar and fewer-than-four point sets return no triangles.
 * Predicates run in a translated unit frame using the existing Quickhull tolerance.
 * @throws RangeError for nonfinite/overflowing points, TypeError for options, or the abort reason.
 */
export function convexHullTriangles(
  points: ArrayLike<number> | readonly ArrayLike<number>[],
  options: ConvexHullTriangleOptions = {},
): Uint32Array {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Hull options need an object; pass signal or omit options.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Hull signal must be an AbortSignal; pass controller.signal.');
  options.signal?.throwIfAborted();
  const source = readPoints(points);
  if (!source.length) return new Uint32Array();
  let extent = 0;
  for (let i = 0; i < source.length; i++) extent = Math.max(extent, Math.abs(source[i] - source[i % 3]));
  if (!Number.isFinite(extent))
    throw new RangeError('Hull coordinate span overflows; translate and rescale the points.');
  if (!extent) return new Uint32Array();
  const frame = source.map((x, i) => (x - source[i % 3]) / extent),
    { faces } = quickhull(frame, true, options.signal),
    indices: number[] = [];
  for (const f of faces) indices.push(f.edge.prev.head, f.edge.head, f.edge.next.head);
  options.signal?.throwIfAborted();
  return Uint32Array.from(indices);
}

/**
 * The convex hull of `points` (an array of `[x, y, z]`, or flat x, y, z numbers), built by
 * quickhull. Duplicate points and points inside the hull or on one of its faces or edges are dropped, so only
 * corners become vertices; coplanar hull triangles merge into one flat face that shares its vertices and normal. Triangles
 * are counter-clockwise seen from outside, normals are flat per face, and UVs project each face onto the bounding box
 * side its normal points to (0 to 1 across the box). Throws RangeError for fewer than four points or points that do
 * not span a volume (all coincident, on one line or in one plane).
 */
export function convexGeometry(points: ArrayLike<number> | readonly ArrayLike<number>[]): GeometryData {
  const source = readPoints(points),
    { faces, tolerance } = quickhull(source),
    id = new Map<Face, number>();
  faces.forEach((f, i) => id.set(f, i));
  // Merge coplanar neighbours (union-find over shared edges).
  const parent = faces.map((_, i) => i),
    root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (const f of faces)
    for (let e = f.edge, k = 0; k < 3; k++, e = e.next) {
      const g = e.twin.face,
        across = e.twin.next.head;
      if (f.nx * g.nx + f.ny * g.ny + f.nz * g.nz > 1 - 1e-9 && Math.abs(f.distance(source, across)) <= tolerance)
        parent[root(id.get(f)!)] = root(id.get(g)!);
    }
  const normal = new Map<number, number[]>();
  for (const f of faces) {
    const r = root(id.get(f)!),
      n = normal.get(r) ?? [0, 0, 0],
      e = f.edge,
      a = e.prev.head * 3,
      b = e.head * 3,
      c = e.next.head * 3,
      ux = source[b] - source[a],
      uy = source[b + 1] - source[a + 1],
      uz = source[b + 2] - source[a + 2],
      vx = source[c] - source[a],
      vy = source[c + 1] - source[a + 1],
      vz = source[c + 2] - source[a + 2];
    n[0] += uy * vz - uz * vy;
    n[1] += uz * vx - ux * vz;
    n[2] += ux * vy - uy * vx;
    normal.set(r, n);
  }
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const f of faces)
    for (let e = f.edge, k = 0; k < 3; k++, e = e.next)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], source[e.head * 3 + c]);
        max[c] = Math.max(max[c], source[e.head * 3 + c]);
      }
  const groups = new Map<number, Face[]>();
  for (const f of faces) {
    const r = root(id.get(f)!);
    const members = groups.get(r);
    if (members) members.push(f);
    else groups.set(r, [f]);
  }
  const at = (i: number, c: number) => source[i * 3 + c],
    // True when b lies on the segment's line from a to c, within the hull tolerance.
    straight = (a: number, b: number, c: number) => {
      const ux = at(b, 0) - at(a, 0),
        uy = at(b, 1) - at(a, 1),
        uz = at(b, 2) - at(a, 2),
        vx = at(c, 0) - at(a, 0),
        vy = at(c, 1) - at(a, 1),
        vz = at(c, 2) - at(a, 2);
      return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) <= tolerance * Math.hypot(vx, vy, vz);
    };
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (const [r, members] of groups) {
    const [x, y, z] = normal.get(r)!,
      length = Math.hypot(x, y, z),
      n = [x / length, y / length, z / length],
      abs = n.map(Math.abs),
      axis = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2,
      // The two other axes, ordered so the projection reads unmirrored from outside.
      [s, t] = n[axis] > 0 ? [(axis + 1) % 3, (axis + 2) % 3] : [(axis + 2) % 3, (axis + 1) % 3],
      vertex = new Map<number, number>(),
      add = (point: number) => {
        let index = vertex.get(point);
        if (index === undefined) {
          index = positions.length / 3;
          vertex.set(point, index);
          positions.push(at(point, 0), at(point, 1), at(point, 2));
          normals.push(n[0], n[1], n[2]);
          uvs.push(
            max[s] > min[s] ? (at(point, s) - min[s]) / (max[s] - min[s]) : 0.5,
            max[t] > min[t] ? (at(point, t) - min[t]) / (max[t] - min[t]) : 0.5,
          );
        }
        indices.push(index);
      };
    // The flat face's outline: its edges whose other side is another face, chained tail to head.
    const next = new Map<number, number>();
    let simple = true;
    for (const f of members)
      for (let e = f.edge, k = 0; k < 3; k++, e = e.next)
        if (root(id.get(e.twin.face)!) !== r) {
          if (next.has(e.prev.head)) simple = false;
          next.set(e.prev.head, e.head);
        }
    const loop: number[] = [];
    if (simple && next.size >= 3)
      for (let v: number | undefined = next.keys().next().value; v !== undefined && loop.length <= next.size; ) {
        loop.push(v);
        v = next.get(v);
        if (v === loop[0]) break;
      }
    // Points on an edge or inside the face are not corners: a convex outline without them fans into triangles.
    const corners = loop.filter(
      (v, i) => !straight(loop[(i + loop.length - 1) % loop.length], v, loop[(i + 1) % loop.length]),
    );
    if (loop.length === next.size && corners.length >= 3)
      for (let i = 1; i + 1 < corners.length; i++) {
        add(corners[0]);
        add(corners[i]);
        add(corners[i + 1]);
      }
    else for (const f of members) for (let e = f.edge, k = 0; k < 3; k++, e = e.next) add(e.head);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}
