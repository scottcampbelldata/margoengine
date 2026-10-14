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
      const n = faceNormal(source, triangles[t], triangles[t + 1], triangles[t + 2]), nx = n[0], ny = n[1], nz = n[2];
      for (let k = 0; k < 3; k++) {
        const v = triangles[t + k] * 3, o = (t + k) * 3;
        positions[o] = source[v]; positions[o + 1] = source[v + 1]; positions[o + 2] = source[v + 2];
        normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz; indices[t + k] = t + k;
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
  const finite = new Uint32Array(total);
  let kept = 0, minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < total; i++) {
    const x = source[i * 3], y = source[i * 3 + 1], z = source[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    finite[kept++] = i;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  if (!kept) throw new LoaderError(F, 'range', 'the point cloud has no finite points');
  const size = options.size ?? (Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.004 || 0.01);
  if (!(size > 0) || !Number.isFinite(size)) throw new LoaderError(F, 'range', 'size must be a positive number');
  const count = Math.min(kept, maxPoints), step = kept / count;
  // Octahedron corners in the order +x -x +y -y +z -z; each corner moves one axis by `size` and its normal is that axis.
  const faces = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  const positions = new Float32Array(count * 18), normals = new Float32Array(count * 18), indices = new Uint32Array(count * 24);
  for (let p = 0; p < count; p++) {
    const i = finite[Math.floor(p * step)] * 3, x = source[i], y = source[i + 1], z = source[i + 2], o = p * 18;
    for (let d = 0; d < 18; d += 3) {positions[o + d] = x; positions[o + d + 1] = y; positions[o + d + 2] = z;}
    positions[o] = x + size; positions[o + 3] = x - size; positions[o + 7] = y + size; positions[o + 10] = y - size; positions[o + 14] = z + size; positions[o + 17] = z - size;
    normals[o] = 1; normals[o + 3] = -1; normals[o + 7] = 1; normals[o + 10] = -1; normals[o + 14] = 1; normals[o + 17] = -1;
    for (let k = 0; k < 24; k++) indices[p * 24 + k] = p * 6 + faces[k];
  }
  return build(positions, normals, indices);
}
