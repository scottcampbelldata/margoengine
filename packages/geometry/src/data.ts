import {Geometry} from '@margoengine/core';

/** A draw range sharing one material, in index units (same meaning as Three.js `BufferGeometry.groups`). */
export interface GeometryGroup {start: number; count: number; materialIndex: number}

/**
 * Plain CPU geometry. Every primitive returns this shape. `indices` is always present: Three.js primitives that are
 * non-indexed (polyhedra, extrude) get sequential indices so vertex counts still match Three.js.
 */
export interface GeometryData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** xyzw per vertex, w is the bitangent sign. Present after `computeTangents`. */
  tangents?: Float32Array;
  groups?: GeometryGroup[];
}

export function geometryData(positions: ArrayLike<number>, normals: ArrayLike<number>, uvs: ArrayLike<number>, indices: ArrayLike<number>, groups?: GeometryGroup[]): GeometryData {
  const data: GeometryData = {positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices)};
  if (groups && groups.length) data.groups = groups.map(g => ({...g}));
  return data;
}

export function sequentialIndices(count: number): Uint32Array {
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return indices;
}

/** Converts to a core `Geometry` (positions, normals and indices only; core has no UVs or tangents). */
export function toGeometry(data: GeometryData): Geometry {
  return new Geometry(data.positions, data.normals, data.indices);
}
