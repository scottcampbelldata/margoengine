import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, edgeId, faceGeometryError } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import { createMeshEditResult, faceIdFactory } from './result.js';
import type { MeshEditOptions, MeshEditResult, PolygonFace, PolygonMesh } from './types.js';

/** Options for {@link subdivideMesh}. */
export interface SubdivideOptions extends MeshEditOptions {
  /** Subdivision steps, 1 to 4 (default 1); each turns every n-gon into n quads. */
  levels?: number;
  /**
   * How corner UVs follow (default `'smooth'`): `'smooth'` smooths UVs inside each UV island like the surface and keeps
   * island borders (seams) and their corners exactly where they were; `'linear'` interpolates every face's own UVs.
   */
  uv?: 'smooth' | 'linear';
  /** Default `'smooth'`: open borders follow a cubic B-spline (corners stay); `'pinned'` keeps every border vertex fixed. */
  boundary?: 'smooth' | 'pinned';
  /** Checked before each level; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Catmull-Clark subdivision (Catmull and Clark, 1978) that keeps UVs. Each level puts a point at every face centroid
 * and on every edge, moves the old vertices, and replaces each n-gon with n quads. Open borders follow the cubic
 * B-spline border rule (two-edge corners stay put), or stay fixed with `boundary: 'pinned'`. UVs are subdivided as
 * their own face-varying mesh, so seams never blur. Faces must stay planar, so a curved quad is split into two
 * triangles (the first keeps the face's ID); flat regions keep quads. `faceMap` names every descendant of each input
 * face across all levels; old vertices keep their indices (moved), and new ones follow.
 * @throws RangeError for levels outside 1 to 4 or an output over the 200000 face limit; TypeError for bad options
 * or edges with more than two faces; the signal's reason when aborted.
 */
export function subdivideMesh(mesh: PolygonMesh, options: SubdivideOptions = {}): MeshEditResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Subdivide');
  const levels = options.levels ?? 1,
    uvMode = options.uv ?? 'smooth',
    boundary = options.boundary ?? 'smooth';
  if (!Number.isInteger(levels) || levels < 1 || levels > 4)
    throw new RangeError('Subdivide levels must be an integer from 1 to 4; choose fewer levels.');
  if (uvMode !== 'smooth' && uvMode !== 'linear')
    throw new TypeError("Subdivide uv must be 'smooth' or 'linear'; choose one or omit it.");
  if (boundary !== 'smooth' && boundary !== 'pinned')
    throw new TypeError("Subdivide boundary must be 'smooth' or 'pinned'; choose one or omit it.");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Subdivide signal must be an AbortSignal; pass controller.signal or omit it.');
  let corners = 0;
  for (const face of mesh.faces) corners += face.vertices.length;
  if (corners * 4 ** (levels - 1) * 2 > 200_000)
    throw new RangeError('Subdivided mesh would exceed 200000 faces; choose fewer levels or split the mesh.');
  for (const edge of collectPolygonEdges(mesh))
    if (edge.incidences.length > 2)
      throw new TypeError('Subdivide needs manifold edges; repair edges with more than two incident faces.');
  const createId = faceIdFactory(mesh, options);
  // Work on quads-as-loops between levels; planar splitting happens once at the end.
  let current = {
    vertices: mesh.vertices.map((p) => [...p] as MutableVec3),
    faces: mesh.faces.map((face) => ({
      source: face.id,
      vertices: [...face.vertices],
      uv: face.uv.map((uv) => [...uv] as MutableVec2),
    })),
  };
  const sourceCount = mesh.vertices.length;
  for (let level = 0; level < levels; level++) {
    options.signal?.throwIfAborted();
    current = subdivideOnce(current, uvMode, boundary);
  }
  const faces: PolygonFace[] = [],
    faceMap: Record<string, string[]> = Object.fromEntries(mesh.faces.map((face) => [face.id, []])),
    firstUse = new Set<string>();
  for (const face of current.faces) {
    const id = firstUse.has(face.source) ? createId() : face.source;
    firstUse.add(face.source);
    const pieces = faceGeometryError(current.vertices, face.vertices)
      ? loopFaces(current.vertices, face.vertices, face.uv, id, createId)
      : [{ id, vertices: face.vertices, uv: face.uv }];
    if (!pieces) throw new TypeError(`Subdivided face of ${face.source} has no area; repair the source face.`);
    faces.push(...pieces);
    faceMap[face.source].push(...pieces.map((piece) => piece.id));
  }
  const output: PolygonMesh = { vertices: current.vertices, faces };
  assertPolygonMesh(output);
  return createMeshEditResult(mesh, output, {
    vertexMap: mesh.vertices.map((_, v) => [v]),
    faceMap,
    createdVertices: output.vertices.map((_, v) => v).slice(sourceCount),
    removedVertices: [],
    affectedFaces: faces.map((face) => face.id),
  });
}

interface Loops {
  vertices: MutableVec3[];
  faces: { source: string; vertices: number[]; uv: MutableVec2[] }[];
}

/** One Catmull-Clark step over position loops and their face-varying UVs. */
function subdivideOnce(mesh: Loops, uvMode: 'smooth' | 'linear', boundary: 'smooth' | 'pinned'): Loops {
  const P = mesh.vertices,
    V = P.length;
  // Edges: faces on each, keyed by canonical ID.
  const edgeFaces = new Map<string, number[]>();
  mesh.faces.forEach((face, f) =>
    face.vertices.forEach((a, c) => {
      const id = edgeId(a, face.vertices[(c + 1) % face.vertices.length]),
        list = edgeFaces.get(id);
      if (list) list.push(f);
      else edgeFaces.set(id, [f]);
    }),
  );
  const facePoint = mesh.faces.map((face) => average(face.vertices.map((v) => P[v])) as MutableVec3),
    out: MutableVec3[] = P.map((p) => [...p] as MutableVec3);
  // New vertex layout: old vertices, then face points, then edge points.
  for (const point of facePoint) out.push(point);
  const edgePoint = new Map<string, number>();
  for (const [id, faces] of edgeFaces) {
    const [a, b] = id.split(':').map(Number),
      point =
        faces.length === 2 ? average([P[a], P[b], facePoint[faces[0]], facePoint[faces[1]]]) : average([P[a], P[b]]);
    edgePoint.set(id, out.length);
    out.push(point as MutableVec3);
  }
  // Vertex points.
  const incidentFaces: number[][] = Array.from({ length: V }, () => []),
    incidentEdges: string[][] = Array.from({ length: V }, () => []);
  mesh.faces.forEach((face, f) => {
    for (const v of face.vertices) incidentFaces[v].push(f);
  });
  for (const id of edgeFaces.keys()) for (const v of id.split(':').map(Number)) incidentEdges[v].push(id);
  for (let v = 0; v < V; v++) {
    const edges = incidentEdges[v];
    if (!edges.length) continue;
    const border = edges.filter((id) => edgeFaces.get(id)!.length === 1);
    if (border.length) {
      if (boundary === 'pinned' || border.length !== 2 || edges.length === 2) continue;
      const [a, b] = border.map((id) => other(id, v));
      out[v] = P[v].map((x, axis) => (P[a][axis] + 6 * x + P[b][axis]) / 8) as MutableVec3;
      continue;
    }
    const n = edges.length,
      Q = average(incidentFaces[v].map((f) => facePoint[f])),
      R = average(edges.map((id) => average([P[v], P[other(id, v)]])));
    out[v] = P[v].map((x, axis) => (Q[axis] + 2 * R[axis] + (n - 3) * x) / n) as MutableVec3;
  }
  // Face-varying UVs: corners join a UV vertex when their faces share an edge with equal UVs at both ends.
  const cornerBase: number[] = [];
  let corners = 0;
  for (const face of mesh.faces) {
    cornerBase.push(corners);
    corners += face.vertices.length;
  }
  const parent = Array.from({ length: corners }, (_, i) => i),
    find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    },
    same = (x: readonly number[], y: readonly number[]) => x[0] === y[0] && x[1] === y[1],
    uvSeam = new Set<string>();
  for (const [id, faces] of edgeFaces) {
    if (faces.length !== 2) continue;
    const [a, b] = id.split(':').map(Number),
      [f, g] = faces,
      cf = (face: number, v: number) => mesh.faces[face].vertices.indexOf(v),
      fa = cf(f, a),
      fb = cf(f, b),
      ga = cf(g, a),
      gb = cf(g, b),
      U = (face: number, c: number) => mesh.faces[face].uv[c];
    if (uvMode === 'smooth' && same(U(f, fa), U(g, ga)) && same(U(f, fb), U(g, gb))) {
      parent[find(cornerBase[f] + fa)] = find(cornerBase[g] + ga);
      parent[find(cornerBase[f] + fb)] = find(cornerBase[g] + gb);
    } else uvSeam.add(id);
  }
  // Per UV vertex: its corners, and whether it sits on a UV border (seam or open edge).
  const uvAt = (f: number, c: number) => mesh.faces[f].uv[c],
    faceUV = mesh.faces.map((face) => average(face.uv)),
    smoothUV = new Map<number, MutableVec2>();
  if (uvMode === 'smooth') {
    const groups = new Map<number, { f: number; c: number }[]>();
    mesh.faces.forEach((face, f) =>
      face.vertices.forEach((_, c) => {
        const root = find(cornerBase[f] + c),
          list = groups.get(root);
        if (list) list.push({ f, c });
        else groups.set(root, [{ f, c }]);
      }),
    );
    for (const [root, list] of groups) {
      const { f, c } = list[0],
        v = mesh.faces[f].vertices[c],
        here = uvAt(f, c),
        edges = incidentEdges[v];
      // A UV vertex is interior only when every edge at v joins two faces of this UV vertex without a seam.
      const interior =
        edges.length > 0 &&
        edges.every((id) => {
          const faces = edgeFaces.get(id)!;
          return faces.length === 2 && !uvSeam.has(id) && faces.every((g) => list.some((item) => item.f === g));
        });
      if (!interior) {
        smoothUV.set(root, [...here] as MutableVec2);
        continue;
      }
      const n = edges.length,
        Q = average(list.map((item) => faceUV[item.f])),
        R = average(
          list.map((item) => {
            const face = mesh.faces[item.f],
              next = face.uv[(item.c + 1) % face.vertices.length];
            return average([here, next]);
          }),
        );
      smoothUV.set(root, here.map((x, axis) => (Q[axis] + 2 * R[axis] + (n - 3) * x) / n) as MutableVec2);
    }
  }
  const faces: Loops['faces'] = [];
  mesh.faces.forEach((face, f) => {
    const n = face.vertices.length,
      center = V + f,
      centerUV = faceUV[f] as MutableVec2;
    for (let c = 0; c < n; c++) {
      const v = face.vertices[c],
        next = face.vertices[(c + 1) % n],
        prev = face.vertices[(c + n - 1) % n],
        nextId = edgeId(v, next),
        prevId = edgeId(prev, v),
        uvHere = uvMode === 'smooth' ? smoothUV.get(find(cornerBase[f] + c))! : uvAt(f, c),
        edgeUV = (a: number, b: number, id: string): MutableVec2 => {
          const faces = edgeFaces.get(id)!,
            mid = average([uvAt(f, a), uvAt(f, b)]);
          if (uvMode !== 'smooth' || faces.length !== 2 || uvSeam.has(id)) return mid as MutableVec2;
          const g = faces[0] === f ? faces[1] : faces[0];
          return average([uvAt(f, a), uvAt(f, b), centerUV, faceUV[g]]) as MutableVec2;
        };
      faces.push({
        source: face.source,
        vertices: [v, edgePoint.get(nextId)!, center, edgePoint.get(prevId)!],
        uv: [
          [...uvHere] as MutableVec2,
          edgeUV(c, (c + 1) % n, nextId),
          [...centerUV] as MutableVec2,
          edgeUV((c + n - 1) % n, c, prevId),
        ],
      });
    }
  });
  return { vertices: out, faces };
}

const other = (id: string, v: number) => {
  const [a, b] = id.split(':').map(Number);
  return a === v ? b : a;
};

function average<T extends readonly number[]>(points: readonly T[]): number[] {
  const sum = new Array(points[0].length).fill(0);
  for (const p of points) for (let i = 0; i < sum.length; i++) sum[i] += p[i];
  return sum.map((x) => x / points.length);
}
