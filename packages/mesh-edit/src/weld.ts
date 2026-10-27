import { MargoError, type MutableVec2 } from '@margoengine/math';
import { assertOptions, remappedEdgeResult } from './edit-support.js';
import { assertPolygonMesh, polygonGeometryError } from './polygon.js';
import { loopFaces, projectLoop } from './polygon-split.js';
import { compactVertices, createMeshEditResult, faceIdFactory } from './result.js';
import type { ComponentEditResult, MeshEditOptions, PolygonFace, PolygonMesh } from './types.js';

/** Options for {@link weldMeshVertices}. */
export interface WeldOptions extends MeshEditOptions {
  /** Merge vertices at most this far apart (local units, inclusive). Default 0.0001; 0 merges exact duplicates only. */
  distance?: number;
  /** Only these vertex indices may merge (default: every vertex a face uses). */
  vertices?: readonly number[];
}

/** Result of {@link weldMeshVertices}: the edit plus how many vertices merged away. */
export interface WeldResult extends ComponentEditResult {
  /** Number of vertices merged into another one. */
  welded: number;
}

/**
 * Merge vertices closer than `distance` ("merge by distance"). Candidates are taken in index order; each unmerged
 * one keeps its position and absorbs every later unmerged candidate within `distance` of it (no chaining, so a
 * long run of close points never collapses to one). Corner UVs never weld: seams stay seams. A face that loses
 * corners drops the repeated ones; one that pinches splits at the pinch; one left with no area is removed and
 * named in `diagnostics`. Faces the moved corners make nonplanar or concave are split into valid convex pieces
 * (the first keeps the face ID). Merged-away vertices are removed and the rest renumbered.
 * @throws RangeError for a negative or non-finite distance or a vertex index outside the mesh; TypeError for bad
 * options; MargoError `failed` when a moved face folds over itself.
 */
export function weldMeshVertices(mesh: PolygonMesh, options: WeldOptions = {}): WeldResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Weld');
  const distance = options.distance ?? 0.0001;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0)
    throw new RangeError('Weld distance must be finite and zero or more; choose a merge distance in local units.');
  const used = new Uint8Array(mesh.vertices.length);
  for (const face of mesh.faces) for (const index of face.vertices) used[index] = 1;
  let candidates: number[];
  if (options.vertices !== undefined) {
    if (!Array.isArray(options.vertices))
      throw new TypeError('Weld vertices need an array of indices; supply existing vertex indices or omit it.');
    for (const index of options.vertices)
      if (!Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
        throw new RangeError('Weld vertex indices must exist in the mesh; select existing vertices.');
    candidates = [...new Set(options.vertices)].sort((a, b) => a - b);
  } else candidates = mesh.vertices.map((_, i) => i).filter((i) => used[i]);
  const createId = faceIdFactory(mesh, options);
  // Spatial hash with cells of the weld distance; distance 0 hashes exact positions.
  const cell = distance > 0 ? distance : 1,
    key = (x: number, y: number, z: number) => `${x},${y},${z}`,
    cellOf = (p: readonly number[]) => (distance > 0 ? p.map((value) => Math.floor(value / cell)) : [p[0], p[1], p[2]]),
    grid = new Map<string, number[]>();
  for (const index of candidates) {
    const [x, y, z] = cellOf(mesh.vertices[index]),
      k = key(x, y, z),
      list = grid.get(k);
    if (list) list.push(index);
    else grid.set(k, [index]);
  }
  const target = mesh.vertices.map((_, i) => i),
    merged = new Uint8Array(mesh.vertices.length);
  let welded = 0;
  for (const index of candidates) {
    if (merged[index]) continue;
    const p = mesh.vertices[index],
      [x, y, z] = cellOf(p),
      reach = distance > 0 ? 1 : 0;
    for (let dx = -reach; dx <= reach; dx++)
      for (let dy = -reach; dy <= reach; dy++)
        for (let dz = -reach; dz <= reach; dz++)
          for (const other of grid.get(key(x + dx, y + dy, z + dz)) ?? []) {
            if (other <= index || merged[other]) continue;
            const q = mesh.vertices[other];
            if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) > distance) continue;
            merged[other] = 1;
            target[other] = index;
            welded++;
          }
  }
  const faceMap: Record<string, string[]> = {},
    affectedFaces: string[] = [],
    diagnostics: string[] = [],
    faces: PolygonFace[] = [];
  for (const face of mesh.faces) {
    const changed = face.vertices.some((index) => merged[index]);
    if (!changed) {
      faces.push({ id: face.id, vertices: [...face.vertices], uv: face.uv.map((uv) => [...uv] as MutableVec2) });
      faceMap[face.id] = [face.id];
      continue;
    }
    // Drop repeated consecutive corners, then split the loop at any vertex it visits twice (a pinch).
    const loop: number[] = [],
      loopUV: MutableVec2[] = [];
    face.vertices.forEach((index, corner) => {
      const t = target[index];
      if (loop.length && loop[loop.length - 1] === t) return;
      loop.push(t);
      loopUV.push([...face.uv[corner]] as MutableVec2);
    });
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
      loop.pop();
      loopUV.pop();
    }
    const loops = splitPinches(loop, loopUV),
      out: PolygonFace[] = [];
    let first = true;
    for (const part of loops) {
      if (part.vertices.length < 3 || !hasArea(mesh, part.vertices)) continue;
      const id = first ? face.id : createId();
      first = false;
      const pieces =
        part.vertices.length <= 64 && !polygonGeometryError(part.vertices.map((i) => mesh.vertices[i]))
          ? [{ id, vertices: part.vertices, uv: part.uv }]
          : loopFaces(mesh.vertices, part.vertices, part.uv, id, createId);
      if (!pieces)
        throw new MargoError(
          'failed',
          `Weld folds face ${face.id} over itself; lower the weld distance or select fewer vertices.`,
        );
      out.push(...pieces);
    }
    if (!out.length) diagnostics.push(`Face ${face.id} collapsed to no area and was removed.`);
    faces.push(...out);
    faceMap[face.id] = out.map((item) => item.id);
    for (const item of out) affectedFaces.push(item.id);
  }
  const output: PolygonMesh = { vertices: mesh.vertices.map((p) => [...p] as typeof p), faces },
    discard = new Set<number>();
  for (let i = 0; i < mesh.vertices.length; i++) if (merged[i]) discard.add(i);
  const remap = compactVertices(output, discard);
  assertPolygonMesh(output);
  const vertexMap = mesh.vertices.map((_, i) => [remap.get(target[i])!]);
  const result = createMeshEditResult(mesh, output, {
    vertexMap,
    faceMap,
    createdVertices: [],
    removedVertices: [...discard],
    affectedFaces,
    diagnostics,
  });
  return { ...remappedEdgeResult(mesh, result, (v) => remap.get(target[v])), welded };
}

/** Split a corner loop wherever it revisits a vertex, so each part is a simple cycle. */
function splitPinches(loop: number[], uv: MutableVec2[]): { vertices: number[]; uv: MutableVec2[] }[] {
  const parts: { vertices: number[]; uv: MutableVec2[] }[] = [],
    stack: { vertex: number; uv: MutableVec2 }[] = [],
    position = new Map<number, number>();
  for (let i = 0; i < loop.length; i++) {
    const at = position.get(loop[i]);
    if (at !== undefined) {
      const cut = stack.splice(at + 1);
      for (const item of cut) position.delete(item.vertex);
      parts.push({
        vertices: [loop[i], ...cut.map((item) => item.vertex)],
        uv: [stack[at].uv, ...cut.map((item) => item.uv)],
      });
      continue;
    }
    position.set(loop[i], stack.length);
    stack.push({ vertex: loop[i], uv: uv[i] });
  }
  parts.unshift({ vertices: stack.map((item) => item.vertex), uv: stack.map((item) => item.uv) });
  return parts;
}

/** Whether the loop encloses a measurable area (not all its corners on one line). */
function hasArea(mesh: PolygonMesh, loop: readonly number[]): boolean {
  const points = loop.map((i) => mesh.vertices[i]),
    flat = projectLoop(points);
  if (!flat) return false;
  let area = 0,
    extent = 0;
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i],
      q = flat[(i + 1) % flat.length];
    area += p[0] * q[1] - p[1] * q[0];
    extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  }
  return Math.abs(area) > extent * extent * 1e-9;
}
