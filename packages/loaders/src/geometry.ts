import {Geometry} from '@margoengine/core';
import {LoaderError, type LoadedGeometry, type LoadedGroup} from './types.js';
import {computeVertexNormals, faceNormal} from './normals.js';

const F = 'Geometry';
/** Vertex limit of a core `Geometry`. */
export const CORE_MAX_VERTICES = 1_000_000;

export interface ToGeometryOptions {
  /**
   * `'auto'` (default) uses the file's normals when present and smooth normals otherwise; `'smooth'` always
   * computes area-weighted vertex normals; `'flat'` splits vertices per triangle and uses face normals.
   */
  normals?: 'auto' | 'smooth' | 'flat';
  /** Build only this group (an entry of `loaded.groups`, or its index). */
  group?: number | LoadedGroup;
}

function selectTriangles(loaded: LoadedGeometry, group: ToGeometryOptions['group']): Uint32Array {
  const indices = loaded.indices;
  if (loaded.kind !== 'mesh' || !indices?.length) throw new LoaderError(F, 'unsupported', 'a point cloud has no triangles; use pointsToGeometry');
  if (group === undefined) return indices;
  const range = typeof group === 'number' ? loaded.groups?.[group] : group;
  if (!range) throw new LoaderError(F, 'range', `group ${String(group)} does not exist`);
  const {start, count} = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count <= 0 || count % 3 || start % 3 || start + count > indices.length) throw new LoaderError(F, 'range', `group range ${start}+${count} is not a triangle range inside ${indices.length} indices`);
  return indices.subarray(start, start + count);
}

/**
 * Converts a loaded mesh (or one of its groups) to a core `Geometry`, compacting unused vertices and computing
 * normals when the file has none. Colors and UVs are dropped because core geometry stores position and normal only.
 */
export function toGeometry(loaded: LoadedGeometry, options: ToGeometryOptions = {}): Geometry {
  const mode = options.normals ?? 'auto';
  if (mode !== 'auto' && mode !== 'smooth' && mode !== 'flat') throw new LoaderError(F, 'range', `unknown normals mode "${String(mode)}"`);
  const triangles = selectTriangles(loaded, options.group), source = loaded.positions, vertexCount = source.length / 3;
  for (let i = 0; i < triangles.length; i++) if (triangles[i] >= vertexCount) throw new LoaderError(F, 'range', `index ${triangles[i]} is outside 0..${vertexCount - 1}`);
  if (mode === 'flat') {
    if (triangles.length > CORE_MAX_VERTICES) throw new LoaderError(F, 'limit', `flat shading needs ${triangles.length} vertices, more than the core limit of ${CORE_MAX_VERTICES}`);
    const positions = new Float32Array(triangles.length * 3), normals = new Float32Array(triangles.length * 3), indices = new Uint32Array(triangles.length);
    for (let t = 0; t < triangles.length; t += 3) {
      const n = faceNormal(source, triangles[t], triangles[t + 1], triangles[t + 2]);
      for (let k = 0; k < 3; k++) {
        const v = triangles[t + k], o = (t + k) * 3;
        positions[o] = source[v * 3]; positions[o + 1] = source[v * 3 + 1]; positions[o + 2] = source[v * 3 + 2];
        normals.set(n, o); indices[t + k] = t + k;
      }
    }
    return build(positions, normals, indices);
  }
  // Compact to the vertices the triangles use.
  const remap = new Int32Array(vertexCount).fill(-1);
  let used = 0;
  for (let i = 0; i < triangles.length; i++) if (remap[triangles[i]] < 0) remap[triangles[i]] = used++;
  if (used > CORE_MAX_VERTICES) throw new LoaderError(F, 'limit', `${used} vertices exceed the core limit of ${CORE_MAX_VERTICES}`);
  const positions = new Float32Array(used * 3), indices = new Uint32Array(triangles.length);
  for (let v = 0; v < vertexCount; v++) {const r = remap[v]; if (r >= 0) {positions[r * 3] = source[v * 3]; positions[r * 3 + 1] = source[v * 3 + 1]; positions[r * 3 + 2] = source[v * 3 + 2];}}
  for (let i = 0; i < triangles.length; i++) indices[i] = remap[triangles[i]];
  let smooth: Float32Array | undefined, normals: Float32Array;
  if (mode === 'auto' && loaded.normals) {
    normals = new Float32Array(used * 3);
    for (let v = 0; v < vertexCount; v++) {
      const r = remap[v];
      if (r < 0) continue;
      const x = loaded.normals[v * 3], y = loaded.normals[v * 3 + 1], z = loaded.normals[v * 3 + 2], length = Math.hypot(x, y, z);
      if (length > 0 && Number.isFinite(length)) {normals[r * 3] = x / length; normals[r * 3 + 1] = y / length; normals[r * 3 + 2] = z / length;}
      else {
        smooth ??= computeVertexNormals(positions, indices);
        normals.set(smooth.subarray(r * 3, r * 3 + 3), r * 3);
      }
    }
  } else normals = computeVertexNormals(positions, indices);
  return build(positions, normals, indices);
}

function build(positions: Float32Array, normals: Float32Array, indices: Uint32Array): Geometry {
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new LoaderError(F, 'range', `vertex ${Math.floor(i / 3)} has a non-finite position`);
  if (positions.length < 9) throw new LoaderError(F, 'range', 'geometry needs at least 3 vertices');
  return new Geometry(positions, normals, indices);
}

export interface PointsToGeometryOptions {
  /** Half-size of each point marker in model units. Default 0.4% of the bounding box diagonal. */
  size?: number;
  /** Evenly subsample to at most this many points. Default 166,666 (6 vertices each, under the core limit). */
  maxPoints?: number;
}

/**
 * Turns a point cloud into one mesh of small octahedra, because core has no point primitive.
 * Per-point colors are dropped (core geometry has no vertex colors).
 */
export function pointsToGeometry(loaded: LoadedGeometry, options: PointsToGeometryOptions = {}): Geometry {
  const source = loaded.positions, total = Math.floor(source.length / 3);
  const maxPoints = options.maxPoints ?? Math.floor(CORE_MAX_VERTICES / 6);
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints * 6 > CORE_MAX_VERTICES) throw new LoaderError(F, 'range', `maxPoints must be 1 to ${Math.floor(CORE_MAX_VERTICES / 6)}`);
  const finite: number[] = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i++) {
    const x = source[i * 3], y = source[i * 3 + 1], z = source[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    finite.push(i);
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
  }
  if (!finite.length) throw new LoaderError(F, 'range', 'the point cloud has no finite points');
  const size = options.size ?? (Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 0.004 || 0.01);
  if (!(size > 0) || !Number.isFinite(size)) throw new LoaderError(F, 'range', 'size must be a positive number');
  const count = Math.min(finite.length, maxPoints), step = finite.length / count;
  const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const faces = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  const positions = new Float32Array(count * 18), normals = new Float32Array(count * 18), indices = new Uint32Array(count * 24);
  for (let p = 0; p < count; p++) {
    const i = finite[Math.floor(p * step)];
    for (let d = 0; d < 6; d++) for (let a = 0; a < 3; a++) {
      positions[p * 18 + d * 3 + a] = source[i * 3 + a] + directions[d][a] * size;
      normals[p * 18 + d * 3 + a] = directions[d][a];
    }
    for (let k = 0; k < 24; k++) indices[p * 24 + k] = p * 6 + faces[k];
  }
  return build(positions, normals, indices);
}
