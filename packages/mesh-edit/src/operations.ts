import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { add, scale } from '@margoengine/math/vec3';
import { assertPolygonMesh, centroid, edgeId, newellNormal, faceGeometryError } from './polygon.js';
import { meshTileUV } from './primitives.js';
import { clonePolygonMesh, createMeshEditResult, faceIdFactory, identityFaceMap, identityVertexMap } from './result.js';
import { triangulateLoop } from './polygon-split.js';
import { typeError } from '../../shared/errors.js';
import type { PolygonFace, PolygonMesh, MeshEditOptions, MeshEditResult } from './types.js';

const amountInRange = (amount: number, min: number, max: number) => {
  if (!Number.isFinite(amount) || amount < min || amount > max)
    throw new RangeError(`Edit amount must be finite and between ${min} and ${max}; choose a supported amount.`);
};
const faceAt = (mesh: PolygonMesh, id: string): PolygonFace => {
  const face = mesh.faces.find((face) => face.id === id);
  if (!face) throw new TypeError('Selected face does not exist; select an existing face before editing.');
  return face;
};
function sideUV(face: PolygonFace): MutableVec2[] {
  const us = face.uv.map((uv) => uv[0]),
    vs = face.uv.map((uv) => uv[1]);
  const left = Math.max(0, Math.min(1 - 1 / 128, Math.min(...us))),
    top = Math.max(0, Math.min(1 - 1 / 128, Math.min(...vs)));
  const right = Math.min(1, Math.max(left + 1 / 128, Math.max(...us))),
    bottom = Math.min(1, Math.max(top + 1 / 128, Math.max(...vs)));
  return [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ];
}

/** Replace one face's corners with placed copies and wall the gap with one quad per edge (extrude and inset). */
function ringFace(
  mesh: PolygonMesh,
  faceId: string,
  options: MeshEditOptions,
  place: (points: MutableVec3[]) => MutableVec3[],
): MeshEditResult {
  const next = clonePolygonMesh(mesh),
    face = faceAt(next, faceId),
    original = [...face.vertices],
    createId = faceIdFactory(mesh, options),
    vertexMap = identityVertexMap(mesh),
    faceMap = identityFaceMap(mesh),
    ring = place(original.map((i) => next.vertices[i])).map((point, corner) => {
      vertexMap[original[corner]].push(next.vertices.length);
      return next.vertices.push(point) - 1;
    });
  face.vertices = ring;
  const uv = sideUV(face);
  for (let i = 0; i < original.length; i++) {
    const j = (i + 1) % original.length,
      id = createId();
    next.faces.push({
      id,
      vertices: [original[i], original[j], ring[j], ring[i]],
      uv: uv.map((p) => [...p] as MutableVec2),
    });
    faceMap[faceId].push(id);
  }
  assertPolygonMesh(next);
  return createMeshEditResult(mesh, next, {
    vertexMap,
    faceMap,
    createdVertices: ring,
    removedVertices: [],
    affectedFaces: faceMap[faceId],
  });
}

/** Extrude one face by a local-space normal distance, retaining its ID/UVs and adding independently owned wall corners. */
export function extrudeMeshFace(
  mesh: PolygonMesh,
  faceId: string,
  amount = 0.18,
  options: MeshEditOptions = {},
): MeshEditResult {
  assertPolygonMesh(mesh);
  amountInRange(amount, -100, 100);
  return ringFace(mesh, faceId, options, (points) => {
    const offset = scale(newellNormal(points), amount);
    return points.map((point) => add(point, offset));
  });
}

/** Inset one face by its centroid fraction, retaining the original face UVs rather than an equal-width offset. */
export function insetMeshFace(
  mesh: PolygonMesh,
  faceId: string,
  amount = 0.24,
  options: MeshEditOptions = {},
): MeshEditResult {
  assertPolygonMesh(mesh);
  amountInRange(amount, 0.001, 0.95);
  return ringFace(mesh, faceId, options, (points) => {
    const middle = scale(centroid(points), amount);
    return points.map((point) => add(scale(point, 1 - amount), middle));
  });
}

/** Bisect a polygon between opposite-edge midpoints, propagating shared geometry and independent incident UV interpolation. */
export function cutMeshFace(mesh: PolygonMesh, faceId: string, options: MeshEditOptions = {}): MeshEditResult {
  assertPolygonMesh(mesh);
  const next = clonePolygonMesh(mesh),
    face = faceAt(next, faceId),
    indices = [...face.vertices],
    uv = face.uv.map((point) => [...point] as MutableVec2);
  const edgeB = Math.floor(indices.length / 2),
    edges = [
      [indices[0], indices[1]],
      [indices[edgeB], indices[(edgeB + 1) % indices.length]],
    ];
  const createId = faceIdFactory(mesh, options),
    newId = createId();
  const midpoints = edges.map(([a, b]) => {
    next.vertices.push(scale(add(next.vertices[a], next.vertices[b]), 0.5));
    return next.vertices.length - 1;
  });
  const midpointUV = (a: MutableVec2, b: MutableVec2): MutableVec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const midUV = [midpointUV(uv[0], uv[1]), midpointUV(uv[edgeB], uv[(edgeB + 1) % uv.length])],
    affected = new Set([faceId, newId]);
  for (const neighbor of next.faces) {
    if (neighbor.id === faceId) continue;
    const vertices: number[] = [],
      uvs: MutableVec2[] = [];
    neighbor.vertices.forEach((a, i) => {
      const j = (i + 1) % neighbor.vertices.length,
        b = neighbor.vertices[j];
      vertices.push(a);
      uvs.push(neighbor.uv[i]);
      const edgeIndex = edges.findIndex(([p, q]) => (a === p && b === q) || (a === q && b === p));
      if (edgeIndex !== -1) {
        vertices.push(midpoints[edgeIndex]);
        uvs.push(midpointUV(neighbor.uv[i], neighbor.uv[j]));
        affected.add(neighbor.id);
      }
    });
    neighbor.vertices = vertices;
    neighbor.uv = uvs;
  }
  face.vertices = [indices[0], midpoints[0], midpoints[1], ...indices.slice(edgeB + 1)];
  face.uv = [uv[0], midUV[0], midUV[1], ...uv.slice(edgeB + 1)];
  next.faces.push({
    id: newId,
    vertices: [midpoints[0], ...indices.slice(1, edgeB + 1), midpoints[1]],
    uv: [[...midUV[0]], ...uv.slice(1, edgeB + 1), [...midUV[1]]],
  });
  assertPolygonMesh(next);
  const faceMap = identityFaceMap(mesh);
  faceMap[faceId].push(newId);
  return createMeshEditResult(mesh, next, {
    vertexMap: identityVertexMap(mesh),
    faceMap,
    createdVertices: midpoints,
    removedVertices: [],
    affectedFaces: next.faces.filter((face) => affected.has(face.id)).map((face) => face.id),
  });
}

/** Chamfer closed consistently wound faces by centroid fractions, splitting generated strips/caps into convex planar pieces. Open/nonmanifold edges return owned unchanged geometry with a diagnostic. */
export function bevelPolygonMesh(mesh: PolygonMesh, amount = 0.12, options: MeshEditOptions = {}): MeshEditResult {
  assertPolygonMesh(mesh);
  amountInRange(amount, 0.001, 0.45);
  const next = clonePolygonMesh(mesh),
    edgeMap = new Map<string, { face: number; a: number; b: number }[]>();
  mesh.faces.forEach((face, f) =>
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length],
        key = edgeId(a, b);
      const list = edgeMap.get(key);
      if (list) list.push({ face: f, a, b });
      else edgeMap.set(key, [{ face: f, a, b }]);
    }),
  );
  if (!edgeMap.size || [...edgeMap.values()].some((edges) => edges.length !== 2))
    return createMeshEditResult(mesh, next, {
      vertexMap: identityVertexMap(mesh),
      faceMap: identityFaceMap(mesh),
      createdVertices: [],
      removedVertices: [],
      diagnostics: ['Bevel requires a closed two-manifold mesh; close the boundary or repair nonmanifold edges.'],
    });
  const createId = faceIdFactory(mesh, options),
    corners = new Map<string, number>(),
    atVertex = new Map<number, number[]>(),
    vertexMap = mesh.vertices.map(() => [] as number[]),
    faceMap = identityFaceMap(mesh);
  next.vertices = [];
  next.faces = mesh.faces.map((face, fi) => {
    const middle = centroid(face.vertices.map((i) => mesh.vertices[i]));
    const vertices = face.vertices.map((vi) => {
      const index = next.vertices.length;
      next.vertices.push(add(scale(mesh.vertices[vi], 1 - amount), scale(middle, amount)));
      corners.set(`${fi}:${vi}`, index);
      const list = atVertex.get(vi);
      if (list) list.push(index);
      else atVertex.set(vi, [index]);
      vertexMap[vi].push(index);
      return index;
    });
    return { id: face.id, vertices, uv: face.uv.map((point) => [...point] as MutableVec2) };
  });
  const follows = new Map<number, number>();
  const addSurface = (vertices: number[], sources: string[]) => {
    const uv = meshTileUV(0, vertices.length),
      pieces = faceGeometryError(next.vertices, vertices)
        ? triangulateLoop(vertices.map((i) => next.vertices[i]))
        : [vertices.map((_, i) => i)];
    if (!pieces) throw typeError('Bevel outline crosses itself or has no area', 'arguments');
    for (const piece of pieces) {
      const id = createId();
      next.faces.push({ id, vertices: piece.map((i) => vertices[i]), uv: piece.map((i) => [...uv[i]]) });
      for (const source of new Set(sources)) faceMap[source].push(id);
    }
  };
  for (const [first, second] of edgeMap.values()) {
    const { a, b } = first;
    const fa = corners.get(`${first.face}:${a}`)!,
      fb = corners.get(`${first.face}:${b}`)!,
      sa = corners.get(`${second.face}:${a}`)!,
      sb = corners.get(`${second.face}:${b}`)!;
    // The strip opposes both inset face edges. Its end edges determine each vertex cap's winding.
    follows.set(sa, fa);
    follows.set(fb, sb);
    addSurface(
      [fb, fa, sa, sb],
      [mesh.faces[first.face].id, mesh.faces[second.face].id],
    );
  }
  for (const [vi, indices] of atVertex) {
    if (indices.length < 3) continue;
    const ring: number[] = [];
    let corner: number | undefined = indices[0];
    for (let i = 0; i < indices.length; i++) {
      if (corner === undefined) throw typeError('Bevel needs consistently wound faces', 'arguments');
      ring.push(corner);
      corner = follows.get(corner);
    }
    if (corner !== ring[0] || new Set(ring).size !== indices.length)
      throw typeError('Bevel vertex needs one closed face fan', 'arguments');
    addSurface(
      ring,
      mesh.faces.filter((face) => face.vertices.includes(vi)).map((face) => face.id),
    );
  }
  assertPolygonMesh(next);
  return createMeshEditResult(mesh, next, {
    vertexMap,
    faceMap,
    createdVertices: next.vertices.map((_, i) => i),
    removedVertices: mesh.vertices.map((_, i) => i),
    affectedFaces: next.faces.map((face) => face.id),
  });
}
