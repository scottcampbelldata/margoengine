import { MargoError, type MutableVec2, type MutableVec3 } from '@margoengine/math';
import { assertOptions, direction, manifoldEdges, remappedEdgeResult, selectedEdges } from './edit-support.js';
import { assertPolygonMesh, edgeId, faceGeometryError, meshPolygonNormal } from './polygon.js';
import { faceUVAt, loopFaces } from './polygon-split.js';
import { meshTileUV } from './primitives.js';
import { compactVertices, createMeshEditResult, faceIdFactory } from './result.js';
import type { ComponentEditResult, MeshEditOptions, PolygonFace, PolygonMesh } from './types.js';

/** A new bevel vertex: its position and, when it lies on an edge from the beveled vertex, where on that edge. */
interface BevelPoint {
  index: number;
  position: MutableVec3;
  along?: { to: number; t: number };
}

const crossLength = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);

/**
 * Bevel (chamfer) selected edges with one flat row of faces each. Every face beside a beveled edge is cut back so its
 * new edge runs parallel to the old one, `width` away inside that face; the gap becomes a strip face. Where three or
 * more beveled edges meet, a corner face fills the gap; where a beveled chain ends, the cut slides along the
 * neighboring edges (on a cube corner the end faces become pentagons). The faces cut back keep their IDs and
 * interpolate their own UVs; strips and corners get the default tile UVs (allocate islands with
 * `allocateMeshFaceUV` before painting). Nonplanar strips or corners are split into planar pieces. Vertices the
 * bevel replaces are removed and the rest renumbered.
 * @throws RangeError for a width that is not positive and finite, or one that reaches past a neighboring edge or
 * folds a face; TypeError for unknown, boundary or nonmanifold edges, a beveled vertex on an open boundary, or a
 * straight-angle corner beside a beveled edge; MargoError `failed` when a corner gap cannot be traced.
 */
export function bevelMeshEdges(
  mesh: PolygonMesh,
  edges: readonly string[],
  width: number,
  options: MeshEditOptions = {},
): ComponentEditResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Edge bevel');
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0)
    throw new RangeError('Edge bevel width must be positive and finite; choose a width in local units.');
  const topology = manifoldEdges(mesh, 'Edge bevel'),
    chosen = selectedEdges(topology, edges, 'Edge bevel'),
    beveled = new Set(chosen.map((edge) => edge.id)),
    createId = faceIdFactory(mesh, options),
    P = mesh.vertices;
  for (const edge of chosen)
    if (edge.incidences.length !== 2)
      throw new TypeError(`Edge bevel edge ${edge.id} is on an open boundary; select edges between two faces.`);
  const faceIndex = new Map(mesh.faces.map((face, i) => [face.id, i])),
    // owner[`${a}>${b}`]: the face holding directed edge a -> b.
    owner = new Map<string, number>();
  mesh.faces.forEach((face, f) =>
    face.vertices.forEach((a, c) => owner.set(`${a}>${face.vertices[(c + 1) % face.vertices.length]}`, f)),
  );
  const vertices: MutableVec3[] = P.map((p) => [...p] as MutableVec3),
    points: BevelPoint[] = [];
  const newPoint = (position: MutableVec3, along?: BevelPoint['along']): BevelPoint => {
    const point = { index: vertices.length, position, along };
    vertices.push(position);
    points.push(point);
    return point;
  };
  // replace[f] maps a corner vertex of face f to what takes its place, in winding order (null: the vertex itself).
  const replace = new Map<number, Map<number, (BevelPoint | null)[]>>(),
    setReplace = (f: number, v: number, value: (BevelPoint | null)[]) => {
      let map = replace.get(f);
      if (!map) replace.set(f, (map = new Map()));
      map.set(v, value);
    },
    descendants = new Map<number, number[]>(),
    // Points on plain edges, keyed `${edge}|${end vertex}`, for edge provenance.
    onEdge = new Map<string, number>(),
    // Strip ends that pass through the beveled vertex, keyed `${edge}|${vertex}`.
    throughVertex = new Set<string>();
  const touched = [...new Set(chosen.flatMap((edge) => edge.vertices))].sort((a, b) => a - b);
  for (const v of touched) {
    // Fan around v: F[i] is entered through edge E[i] (far end far[i]) and left through E[i + 1].
    const seed = chosen.find((edge) => edge.vertices.includes(v))!,
      startFace = owner.get(`${v}>${seed.vertices[0] === v ? seed.vertices[1] : seed.vertices[0]}`)!,
      F: number[] = [],
      far: number[] = [];
    let f = startFace;
    for (;;) {
      const face = mesh.faces[f],
        n = face.vertices.length,
        corner = face.vertices.indexOf(v),
        before = face.vertices[(corner + n - 1) % n],
        after = face.vertices[(corner + 1) % n];
      F.push(f);
      far.push(before);
      const twin = owner.get(`${after}>${v}`);
      if (twin === undefined)
        throw new TypeError(`Edge bevel vertex ${v} is on an open boundary; bevel edges whose vertices are interior.`);
      if (twin === startFace) break;
      if (F.length > mesh.faces.length)
        throw new TypeError(`Edge bevel vertex ${v} has a nonmanifold fan; repair the faces around it.`);
      f = twin;
    }
    const k = F.length,
      wrap = (i: number) => ((i % k) + k) % k,
      B = F.map((_, i) => i).filter((i) => beveled.has(edgeId(v, far[i])));
    if (k < 3) throw new TypeError(`Edge bevel vertex ${v} joins fewer than three edges; dissolve it first.`);
    const unit = (i: number) => direction(P[v], P[far[wrap(i)]])!,
      length = (i: number) => {
        const q = P[far[wrap(i)]];
        return Math.hypot(q[0] - P[v][0], q[1] - P[v][1], q[2] - P[v][2]);
      };
    // Distance along edge E[i] at which a point is `width` from beveled edge E[j] (measured in the face between).
    const offset = (i: number, j: number): number => {
      const s = crossLength(unit(i), unit(j));
      if (!(s > 1e-9))
        throw new TypeError(`Edge bevel at vertex ${v} meets a straight angle; dissolve the collinear vertex first.`);
      const t = width / s;
      if (!(t < length(i)))
        throw new RangeError(`Edge bevel width reaches past an edge at vertex ${v}; choose a smaller width.`);
      return t;
    };
    const pointOn = (i: number, t: number): BevelPoint => {
      const d = unit(i),
        p = P[v],
        to = far[wrap(i)],
        point = newPoint([p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t], { to, t: t / length(i) });
      onEdge.set(`${edgeId(v, to)}|${v}`, point.index);
      return point;
    };
    const created: BevelPoint[] = [];
    let keepsV = false;
    for (let b = 0; b < B.length; b++) {
      const s = B[b],
        e = b + 1 < B.length ? B[b + 1] : B[0] + k,
        m = e - s,
        face = (i: number) => F[wrap(i)];
      if (m === 1) {
        // One face between two beveled edges: the corner moves to where the two offset lines cross.
        const d1 = unit(s),
          d2 = unit(e),
          sine = crossLength(d1, d2),
          p = P[v];
        let position: MutableVec3;
        if (sine > 1e-9) {
          const scale = width / sine;
          position = [p[0] + (d1[0] + d2[0]) * scale, p[1] + (d1[1] + d2[1]) * scale, p[2] + (d1[2] + d2[2]) * scale];
        } else {
          // A straight corner: step inward, left of the incoming edge (far -> v) about the face normal.
          const n = meshPolygonNormal(mesh.faces[face(s)].vertices.map((i) => P[i])),
            inward = [-(n[1] * d1[2] - n[2] * d1[1]), -(n[2] * d1[0] - n[0] * d1[2]), -(n[0] * d1[1] - n[1] * d1[0])];
          position = [p[0] + inward[0] * width, p[1] + inward[1] * width, p[2] + inward[2] * width];
        }
        const point = newPoint(position);
        created.push(point);
        setReplace(face(s), v, [point]);
      } else if (m === 2) {
        // Two faces share one plain edge: one point on it, at the mean of the two offsets.
        const point = pointOn(s + 1, (offset(s + 1, s) + offset(s + 1, e)) / 2);
        created.push(point);
        setReplace(face(s), v, [point]);
        setReplace(face(s + 1), v, [point]);
      } else {
        const a = pointOn(s + 1, offset(s + 1, s)),
          c = pointOn(e - 1, offset(e - 1, e));
        created.push(a, c);
        setReplace(face(s), v, [a]);
        setReplace(face(e - 1), v, [c]);
        if (m === 3) setReplace(face(s + 1), v, [a, c]);
        else {
          keepsV = true;
          setReplace(face(s + 1), v, [a, null]);
          setReplace(face(e - 2), v, [null, c]);
          // A chain ending where its two side faces are coplanar: a, v and c line up, so instead of a corner face
          // with no area, the strip's end runs through v.
          const p = P[v],
            da = a.position.map((x, axis) => x - p[axis]),
            dc = c.position.map((x, axis) => x - p[axis]);
          if (B.length === 1 && crossLength(da, dc) <= 1e-9 * Math.hypot(...da) * Math.hypot(...dc))
            throughVertex.add(`${edgeId(v, far[s])}|${v}`);
        }
      }
    }
    descendants.set(v, [...(keepsV ? [v] : []), ...created.map((point) => point.index)]);
  }
  // Rebuild the touched faces, then add one strip per beveled edge.
  const faces: PolygonFace[] = [],
    faceMap: Record<string, string[]> = {},
    affectedFaces: string[] = [],
    cornerPoint = new Map<string, number>(); // `${face}:${v}:in|out` -> v's replacement next to that edge
  mesh.faces.forEach((face, f) => {
    const map = replace.get(f);
    faceMap[face.id] = [face.id];
    if (!map) {
      faces.push({ id: face.id, vertices: [...face.vertices], uv: face.uv.map((uv) => [...uv] as MutableVec2) });
      return;
    }
    affectedFaces.push(face.id);
    const corners = face.vertices.map((v) => P[v]),
      loop: number[] = [],
      uv: MutableVec2[] = [];
    face.vertices.forEach((v, corner) => {
      const value = map.get(v);
      if (!value) {
        loop.push(v);
        uv.push([...face.uv[corner]] as MutableVec2);
        return;
      }
      for (const item of value) {
        if (!item) {
          loop.push(v);
          uv.push([...face.uv[corner]] as MutableVec2);
          continue;
        }
        loop.push(item.index);
        const target = item.along ? face.vertices.indexOf(item.along.to) : -1;
        if (item.along && target >= 0) {
          const from = face.uv[corner],
            to = face.uv[target],
            t = item.along.t;
          uv.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
        } else {
          const mapped = faceUVAt(corners, face.uv, item.position);
          if (!mapped || mapped.some((x) => !(x >= 0 && x <= 1)))
            throw new RangeError(`Edge bevel width folds face ${face.id}; choose a smaller width.`);
          uv.push(mapped);
        }
      }
      const first = value[0],
        last = value[value.length - 1];
      if (first) cornerPoint.set(`${f}:${v}:in`, first.index);
      if (last) cornerPoint.set(`${f}:${v}:out`, last.index);
    });
    if (faceGeometryError(vertices, loop))
      throw new RangeError(`Edge bevel width folds face ${face.id}; choose a smaller width.`);
    faces.push({ id: face.id, vertices: loop, uv });
  });
  const tile = meshTileUV(0, 4);
  for (const edge of chosen) {
    const [l, r] = edge.incidences,
      L = faceIndex.get(l.faceId)!,
      R = faceIndex.get(r.faceId)!,
      // In L the edge runs from -> to: from's replacement nearest the edge is its last, to's its first.
      lv = cornerPoint.get(`${L}:${l.from}:out`)!,
      lw = cornerPoint.get(`${L}:${l.to}:in`)!,
      rv = cornerPoint.get(`${R}:${l.from}:in`)!,
      rw = cornerPoint.get(`${R}:${l.to}:out`)!,
      id = createId(),
      loop = [lw, lv, rv, rw],
      uv = tile.map((item) => [...item]);
    // Insert v between lv and rv, and w between rw and lw, where a strip end runs through its vertex.
    if (throughVertex.has(`${edge.id}|${l.to}`)) {
      loop.push(l.to);
      uv.push([...tile[0]]);
    }
    if (throughVertex.has(`${edge.id}|${l.from}`)) {
      loop.splice(2, 0, l.from);
      uv.splice(2, 0, [...tile[1]]);
    }
    const pieces = loopFaces(vertices, loop, uv, id, createId);
    if (!pieces)
      throw new MargoError('failed', `Edge bevel strip for edge ${edge.id} has no area; choose a larger width.`);
    faces.push(...pieces);
    for (const piece of pieces) affectedFaces.push(piece.id);
    for (const source of [l.faceId, r.faceId]) faceMap[source].push(...pieces.map((piece) => piece.id));
  }
  // Corner gaps: unmatched half-edges that touch a new or beveled vertex, traced into loops and filled.
  const half = new Set<string>();
  for (const face of faces)
    face.vertices.forEach((a, c) => half.add(`${a}>${face.vertices[(c + 1) % face.vertices.length]}`));
  const touchedSet = new Set(touched),
    open = new Map<number, number>();
  for (const key of half) {
    const [a, b] = key.split('>').map(Number);
    if (half.has(`${b}>${a}`)) continue;
    if (a < P.length && b < P.length && !touchedSet.has(a) && !touchedSet.has(b)) continue;
    if (open.has(b)) throw new MargoError('failed', 'Edge bevel corner gap branches; bevel fewer edges at one vertex.');
    open.set(b, a); // the corner face runs opposite to the gap's half-edges
  }
  while (open.size) {
    const start = Math.min(...open.keys()),
      loop = [start];
    let at = open.get(start)!;
    open.delete(start);
    while (at !== start) {
      const next = open.get(at);
      if (next === undefined) throw new MargoError('failed', 'Edge bevel corner gap is not closed; bevel fewer edges.');
      open.delete(at);
      loop.push(at);
      at = next;
    }
    if (loop.length < 3 || loop.length > 64)
      throw new MargoError(
        'failed',
        'Edge bevel corner gap has fewer than 3 or more than 64 sides; bevel fewer edges.',
      );
    const id = createId(),
      pieces = loopFaces(vertices, loop, meshTileUV(0, loop.length), id, createId);
    if (!pieces) throw new MargoError('failed', 'Edge bevel corner face has no area; choose a larger width.');
    faces.push(...pieces);
    for (const piece of pieces) affectedFaces.push(piece.id);
  }
  const output: PolygonMesh = { vertices, faces },
    used = new Uint8Array(vertices.length);
  for (const face of faces) for (const v of face.vertices) used[v] = 1;
  const discard = new Set(touched.filter((v) => !used[v])),
    remap = compactVertices(output, discard);
  assertPolygonMesh(output);
  const result = createMeshEditResult(mesh, output, {
    vertexMap: P.map((_, v) => (descendants.get(v) ?? [v]).map((index) => remap.get(index)!)),
    faceMap,
    createdVertices: points.map((point) => remap.get(point.index)!),
    removedVertices: [...discard],
    affectedFaces,
  });
  // Beveled edges become the two strip sides; plain edges ending at a beveled vertex now run to the point on them.
  const overrides = new Map<string, string[]>();
  for (const [key, point] of onEdge) {
    const [id, endText] = key.split('|'),
      end = Number(endText),
      [x, y] = id.split(':').map(Number),
      other = x === end ? y : x,
      otherEnd = onEdge.get(`${id}|${other}`) ?? other,
      ids = [edgeId(remap.get(point)!, remap.get(otherEnd)!)];
    if (remap.has(end)) ids.push(edgeId(remap.get(end)!, remap.get(point)!));
    overrides.set(id, [...new Set([...(overrides.get(id) ?? []), ...ids])]);
  }
  for (const edge of chosen) {
    const [l, r] = edge.incidences,
      side = (f: number, a: string, b: string) =>
        edgeId(remap.get(cornerPoint.get(`${f}:${a}`)!)!, remap.get(cornerPoint.get(`${f}:${b}`)!)!);
    overrides.set(edge.id, [
      side(faceIndex.get(l.faceId)!, `${l.from}:out`, `${l.to}:in`),
      side(faceIndex.get(r.faceId)!, `${r.from}:out`, `${r.to}:in`),
    ]);
  }
  return remappedEdgeResult(mesh, result, (v) => remap.get(v), overrides);
}
