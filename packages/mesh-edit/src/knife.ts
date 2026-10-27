import { MargoError, type MutableVec2, type MutableVec3, type Vec3 } from '@margoengine/math';
import { componentEdgeResult } from './components.js';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, edgeId, faceGeometryError, polygonAreaVector } from './polygon.js';
import { faceUVAt, loopFaces } from './polygon-split.js';
import { clonePolygonMesh, createMeshEditResult, faceIdFactory, identityFaceMap, identityVertexMap } from './result.js';
import type { ComponentEditResult, MeshEditOptions, PolygonFace, PolygonMesh } from './types.js';

/** Options for {@link knifeMeshFaces}. */
export interface KnifeOptions extends MeshEditOptions {
  /** Cut only these faces (default: every face the cut crosses, front and back, like "cut through"). */
  faces?: readonly string[];
  /** Join the last point back to the first (default false). */
  closed?: boolean;
}

/** Result of {@link knifeMeshFaces}: the edit, plus the new edges along the cut. */
export interface KnifeResult extends ComponentEditResult {
  /** Output edges that lie on the cut, in no particular order. */
  cutEdges: string[];
}

interface Crossing {
  vertex: number;
  key: number; // position along the path: segment index + fraction
}

/**
 * Knife: cut faces along a drawn polyline, as seen along `direction` (the view direction). The polyline is swept
 * along `direction` into a cutting surface; every face it crosses is split along the cut, through new vertices
 * where it crosses edges and, inside a face, where the polyline bends. Cuts that end inside a face add nothing
 * there (a face splits only where the cut goes all the way across). Neighbors of cut edges gain the new edge
 * vertices as straight corners, so the mesh stays watertight. Split faces interpolate their own UVs; concave
 * pieces are split into convex ones; one piece of each face keeps its ID. Points and direction are in local units.
 * @throws TypeError for fewer than two finite points, a zero direction, unknown faces or bad options; RangeError for
 * a polyline segment parallel to `direction`; MargoError `failed` when a cut piece would fold.
 */
export function knifeMeshFaces(
  mesh: PolygonMesh,
  points: readonly Vec3[],
  direction: Vec3,
  options: KnifeOptions = {},
): KnifeResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Knife');
  const finite = (p: unknown) => Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x));
  if (!Array.isArray(points) || points.length < 2 || !points.every(finite))
    throw new TypeError('Knife needs two or more finite [x, y, z] points; supply the drawn cut in local space.');
  if (!finite(direction))
    throw new TypeError('Knife direction needs a finite [x, y, z] vector; pass the view direction.');
  const dl = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(dl > 0)) throw new TypeError('Knife direction must be nonzero; pass the view direction.');
  const d = [direction[0] / dl, direction[1] / dl, direction[2] / dl],
    closed = options.closed === true,
    P = mesh.vertices,
    allowed = options.faces === undefined ? null : new Set<string>();
  if (options.closed !== undefined && typeof options.closed !== 'boolean')
    throw new TypeError('Knife closed must be boolean; choose true, false or omit it.');
  if (allowed) {
    if (!Array.isArray(options.faces))
      throw new TypeError('Knife faces need an array of face IDs; supply IDs or omit it.');
    const known = new Set(mesh.faces.map((face) => face.id));
    for (const id of options.faces) {
      if (typeof id !== 'string' || !known.has(id))
        throw new TypeError(`Knife face ${String(id)} does not exist; select existing face IDs.`);
      allowed.add(id);
    }
  }
  // Path segments: each sweeps a plane (normal n) and a lateral extent along u (the segment with d removed).
  let scale = 0;
  for (const p of [...P, ...points]) for (let a = 0; a < 3; a++) scale = Math.max(scale, Math.abs(p[a]));
  const eps = Math.max(scale, 1) * 1e-10,
    count = closed ? points.length : points.length - 1,
    segments = Array.from({ length: count }, (_, i) => {
      const a = points[i],
        b = points[(i + 1) % points.length],
        v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2],
        u = [v[0] - along * d[0], v[1] - along * d[1], v[2] - along * d[2]],
        uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
      if (!(Math.sqrt(uu) > eps))
        throw new RangeError('Knife segment runs along the view direction; draw the cut across the view.');
      const n = [u[1] * d[2] - u[2] * d[1], u[2] * d[0] - u[0] * d[2], u[0] * d[1] - u[1] * d[0]],
        nl = Math.hypot(n[0], n[1], n[2]);
      return { a, u, uu, n: n.map((x) => x / nl) };
    });
  const side = (s: (typeof segments)[number], p: readonly number[]) =>
    (p[0] - s.a[0]) * s.n[0] + (p[1] - s.a[1]) * s.n[1] + (p[2] - s.a[2]) * s.n[2];
  const lateral = (s: (typeof segments)[number], p: readonly number[]) =>
    ((p[0] - s.a[0]) * s.u[0] + (p[1] - s.a[1]) * s.u[1] + (p[2] - s.a[2]) * s.u[2]) / s.uu;
  const next = clonePolygonMesh(mesh),
    createdVertices: number[] = [],
    // Per directed-agnostic edge: crossings sorted by position from the lower vertex.
    edgeCuts = new Map<string, { t: number; crossing: Crossing }[]>(),
    vertexHits = new Map<number, number>(); // vertex -> path key
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    for (let v = 0; v < P.length; v++) {
      if (Math.abs(side(s, P[v])) > eps) continue;
      const t = lateral(s, P[v]);
      if (t >= -1e-12 && t <= 1 + 1e-12 && !vertexHits.has(v)) vertexHits.set(v, i + Math.min(1, Math.max(0, t)));
    }
  }
  for (const edge of collectPolygonEdges(mesh)) {
    const [a, b] = edge.vertices;
    if (vertexHits.has(a) && vertexHits.has(b)) continue;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i],
        da = side(s, P[a]),
        db = side(s, P[b]);
      if (Math.abs(da) <= eps || Math.abs(db) <= eps || da * db > 0) continue;
      const t = da / (da - db),
        x = P[a].map((value, axis) => value + (P[b][axis] - value) * t) as MutableVec3,
        l = lateral(s, x);
      if (l < -1e-12 || l > 1 + 1e-12) continue;
      const list = edgeCuts.get(edge.id) ?? [];
      if (list.some((item) => Math.abs(item.t - t) <= 1e-12)) continue;
      const index = next.vertices.length;
      next.vertices.push(x);
      createdVertices.push(index);
      list.push({ t, crossing: { vertex: index, key: i + Math.min(1, Math.max(0, l)) } });
      list.sort((p, q) => p.t - q.t);
      edgeCuts.set(edge.id, list);
    }
  }
  const faceMap = identityFaceMap(mesh),
    affectedFaces: string[] = [],
    cutEdges = new Set<string>(),
    descendants = new Map<string, string[]>(),
    createId = faceIdFactory(mesh, options),
    diagnostics: string[] = [];
  for (const [id, cuts] of edgeCuts) {
    const [low, high] = id.split(':').map(Number),
      chain = [low, ...cuts.map((item) => item.crossing.vertex), high];
    descendants.set(
      id,
      chain.slice(1).map((v, i) => edgeId(chain[i], v)),
    );
  }
  next.faces = mesh.faces.flatMap((face): PolygonFace[] => {
    // Boundary loop with the edge crossings inserted, each corner carrying its UV and path key (or none).
    const n = face.vertices.length,
      loop: { vertex: number; uv: MutableVec2; key: number | null }[] = [];
    for (let c = 0; c < n; c++) {
      const a = face.vertices[c],
        b = face.vertices[(c + 1) % n],
        uvA = face.uv[c],
        uvB = face.uv[(c + 1) % n];
      loop.push({ vertex: a, uv: [...uvA] as MutableVec2, key: vertexHits.get(a) ?? null });
      const cuts = edgeCuts.get(edgeId(a, b));
      if (!cuts) continue;
      const ordered = a < b ? cuts : [...cuts].reverse();
      for (const { t: raw, crossing } of ordered) {
        const t = a < b ? raw : 1 - raw;
        loop.push({
          vertex: crossing.vertex,
          uv: [uvA[0] + (uvB[0] - uvA[0]) * t, uvA[1] + (uvB[1] - uvA[1]) * t],
          key: crossing.key,
        });
      }
    }
    const touched = loop.length !== n;
    const keep = (): PolygonFace[] => {
      if (!touched)
        return [{ id: face.id, vertices: [...face.vertices], uv: face.uv.map((uv) => [...uv] as MutableVec2) }];
      affectedFaces.push(face.id);
      return [{ id: face.id, vertices: loop.map((item) => item.vertex), uv: loop.map((item) => item.uv) }];
    };
    if (allowed && !allowed.has(face.id)) return keep();
    const boundary = loop.filter((item) => item.key !== null);
    if (boundary.length < 2) return keep();
    // Face plane and the path's interior bends projected onto it along d.
    const corners = face.vertices.map((v) => P[v]),
      normal = polygonAreaVector(corners),
      nl = Math.hypot(normal[0], normal[1], normal[2]),
      fn = normal.map((x) => x / nl),
      o = corners[0],
      facing = fn[0] * d[0] + fn[1] * d[1] + fn[2] * d[2],
      project = (p: readonly number[]): number[] | null => {
        if (Math.abs(facing) < 1e-9) return null;
        const t = ((o[0] - p[0]) * fn[0] + (o[1] - p[1]) * fn[1] + (o[2] - p[2]) * fn[2]) / facing;
        return [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
      },
      inside = (p: readonly number[]): boolean => {
        // Strictly inside the convex face: on the inner side of every edge.
        for (let c = 0; c < n; c++) {
          const a = corners[c],
            b = corners[(c + 1) % n],
            e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
            cross = [e[1] * w[2] - e[2] * w[1], e[2] * w[0] - e[0] * w[2], e[0] * w[1] - e[1] * w[0]];
          if (cross[0] * fn[0] + cross[1] * fn[1] + cross[2] * fn[2] <= eps * Math.hypot(...e)) return false;
        }
        return true;
      };
    type Event = { key: number; corner: number | null; point?: number[] };
    const events: Event[] = boundary.map((item) => ({ key: item.key!, corner: loop.indexOf(item) }));
    for (let i = closed ? 0 : 1; i < points.length - (closed ? 0 : 1); i++) {
      const q = project(points[i]);
      if (q && inside(q)) events.push({ key: i, corner: null, point: q });
    }
    events.sort((p, q) => p.key - q.key || (p.corner === null ? 1 : 0) - (q.corner === null ? 1 : 0));
    const pathPoint = (key: number) => {
      const i = Math.min(Math.floor(key), segments.length - 1),
        f = key - i,
        a = points[i],
        b = points[(i + 1) % points.length];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    };
    // Chords: from a boundary event, through interior bends, to the next boundary event, when the path between
    // them runs inside the face (tested just after the first event).
    const order = closed ? rotateToBoundary(events) : events,
      chords: { from: number; to: number; through: number[][] }[] = [];
    // A closed path wraps: scanning may run one full turn past the start.
    const limit = closed ? order.length * 2 : order.length,
      at = (k: number) => order[k % order.length],
      unwrap = (k: number) => at(k).key + (k >= order.length ? segments.length : 0);
    for (let i = 0; i < order.length; i++) {
      const start = order[i];
      if (start.corner === null) continue;
      const through: number[][] = [];
      let j = i + 1;
      while (j < limit && j < i + order.length + 1 && at(j).corner === null) through.push(at(j++).point!);
      if (j >= limit || j >= i + order.length + 1 || (j % order.length === i && !closed)) continue;
      const end = at(j),
        endKey = unwrap(j),
        firstStop = through.length ? unwrap(i + 1) : endKey,
        sampleKey = Math.min(firstStop, Math.floor(start.key) + 1, endKey),
        sample = project(pathPoint(((start.key + sampleKey) / 2) % segments.length));
      // A face seen edge-on (parallel to the view) has no projection: the cut runs straight between the two
      // crossings when both lie on one path segment, and that chord is inside the convex face.
      const edgeOn =
        !sample &&
        Math.ceil(endKey) - Math.floor(start.key) <= 1 &&
        inside(average3(next.vertices[loop[start.corner].vertex], next.vertices[loop[end.corner!].vertex]));
      if (through.length || edgeOn || (sample && inside(sample)))
        chords.push({ from: start.corner, to: end.corner!, through });
    }
    if (!chords.length) return keep();
    // Split the loop chord by chord; each chord splits the piece holding both of its ends.
    type Corner = { vertex: number; uv: MutableVec2 };
    const pieces: Corner[][] = [loop.map((item) => ({ vertex: item.vertex, uv: item.uv }))];
    const loopVertex = (corner: number) => loop[corner].vertex;
    for (const chord of chords) {
      const a = loopVertex(chord.from),
        b = loopVertex(chord.to);
      if (a === b) continue;
      const p = pieces.findIndex((piece) => piece.some((c) => c.vertex === a) && piece.some((c) => c.vertex === b));
      if (p < 0) continue;
      const piece = pieces[p],
        ia = piece.findIndex((c) => c.vertex === a),
        ib = piece.findIndex((c) => c.vertex === b),
        m = piece.length;
      if (!chord.through.length && ((ia + 1) % m === ib || (ib + 1) % m === ia)) continue; // along an existing edge
      const interior: Corner[] = chord.through.map((point) => {
        const index = next.vertices.length;
        next.vertices.push(point as MutableVec3);
        createdVertices.push(index);
        const uv = faceUVAt(corners, face.uv, point as unknown as Vec3);
        if (!uv) throw new MargoError('failed', `Knife cannot map UVs inside face ${face.id}; repair the face.`);
        return { vertex: index, uv };
      });
      const walk = (from: number, to: number) => {
        const out: Corner[] = [];
        for (let k = from; ; k = (k + 1) % m) {
          out.push(piece[k]);
          if (k === to) break;
        }
        return out;
      };
      const first = [...walk(ia, ib), ...[...interior].reverse()],
        second = [...walk(ib, ia), ...interior];
      pieces.splice(p, 1, first, second);
      const path = [a, ...interior.map((c) => c.vertex), b];
      for (let k = 1; k < path.length; k++) cutEdges.add(edgeId(path[k - 1], path[k]));
    }
    if (pieces.length === 1) return keep();
    affectedFaces.push(face.id);
    const out: PolygonFace[] = [];
    pieces.forEach((piece, k) => {
      const id = k === 0 ? face.id : createId(),
        vertices = piece.map((c) => c.vertex),
        uv = piece.map((c) => [...c.uv] as MutableVec2);
      const valid = vertices.length <= 64 && !faceGeometryError(next.vertices, vertices),
        split = valid ? [{ id, vertices, uv }] : loopFaces(next.vertices, vertices, uv, id, createId);
      if (!split)
        throw new MargoError('failed', `Knife piece of face ${face.id} folds; draw the cut farther from corners.`);
      out.push(...split);
    });
    faceMap[face.id] = out.map((item) => item.id);
    for (const item of out) if (item.id !== face.id) affectedFaces.push(item.id);
    return out;
  });
  if (!cutEdges.size) diagnostics.push('The knife path crossed no face completely; nothing was split.');
  assertPolygonMesh(next);
  const result = componentEdgeResult(
    mesh,
    createMeshEditResult(mesh, next, {
      vertexMap: identityVertexMap(mesh),
      faceMap,
      createdVertices,
      removedVertices: [],
      affectedFaces,
      diagnostics,
    }),
    descendants,
  );
  const present = new Set(collectPolygonEdges(next).map((edge) => edge.id));
  return { ...result, cutEdges: [...cutEdges].filter((id) => present.has(id)) };
}

const average3 = (p: readonly number[], q: readonly number[]) => [
  (p[0] + q[0]) / 2,
  (p[1] + q[1]) / 2,
  (p[2] + q[2]) / 2,
];

/** Rotate a closed path's events so the list starts at a boundary event. */
function rotateToBoundary<T extends { corner: number | null }>(events: T[]): T[] {
  const start = events.findIndex((event) => event.corner !== null);
  return start <= 0 ? events : [...events.slice(start), ...events.slice(0, start)];
}
