// Core Geometry in and out of the polygon mesh that mesh-edit's booleans and modelling operations work on.
import { Geometry } from '@margoengine/core';
import { triangulatePolygon } from './concave.js';
import { type ImportMeshOptions, type ImportMeshResult, polygonMeshFromTriangles } from './import.js';
import { assertPolygonMesh } from './polygon.js';
import type { PolygonMesh } from './types.js';

/**
 * Turn a core {@link Geometry} into an editable {@link PolygonMesh}: positions are rejoined where the geometry splits
 * them for hard edges (identical positions weld), coplanar triangles merge back into polygons, and the UVs are made by
 * an unwrap because a core Geometry carries none. Options and the result are those of `polygonMeshFromTriangles`.
 * @throws TypeError for something that is not a Geometry; the errors of `polygonMeshFromTriangles` otherwise.
 */
export function toPolygonMesh(geometry: Geometry, options: ImportMeshOptions = {}): ImportMeshResult {
  if (!(geometry?.vertices instanceof Float32Array) || !(geometry.indices instanceof Uint32Array))
    throw new TypeError('toPolygonMesh needs a core Geometry; pass the result of box() or engine geometry.');
  const count = geometry.vertices.length / 6,
    positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) positions.set(geometry.vertices.subarray(i * 6, i * 6 + 3), i * 3);
  return polygonMeshFromTriangles({ positions, indices: geometry.indices }, { uv: 'unwrap', ...options });
}

/**
 * Turn a {@link PolygonMesh} (a boolean's result, a modelled shape) into a core {@link Geometry}: every face is
 * triangulated (concave ones by ear clipping) with a vertex per corner and the face's flat normal, so hard edges stay
 * hard. An empty mesh gives an empty Geometry.
 * @throws TypeError for a mesh that is malformed, has a face with no area or one that crosses itself; RangeError above 200000 vertices or faces.
 */
export function fromPolygonMesh(mesh: PolygonMesh): Geometry {
  assertPolygonMesh(mesh);
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (const face of mesh.faces) {
    const corners = face.vertices.map((v) => mesh.vertices[v]);
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let i = 0; i < corners.length; i++) {
      const p = corners[i],
        q = corners[(i + 1) % corners.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const length = Math.hypot(nx, ny, nz);
    const base = positions.length / 3;
    for (const p of corners) {
      positions.push(p[0], p[1], p[2]);
      normals.push(nx / length, ny / length, nz / length);
    }
    for (const t of corners.length === 3 ? [[0, 1, 2]] : triangulatePolygon(corners))
      indices.push(base + t[0], base + t[1], base + t[2]);
  }
  return new Geometry(positions, normals, indices);
}
