import { Geometry } from '@margoengine/core';

/** A draw range sharing one material, in index units (same meaning as Three.js `BufferGeometry.groups`). */
export interface GeometryGroup {
  start: number;
  count: number;
  materialIndex: number;
}

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

export function geometryData(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  uvs: ArrayLike<number>,
  indices: ArrayLike<number>,
  groups?: GeometryGroup[],
): GeometryData {
  const data: GeometryData = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
  if (groups && groups.length) data.groups = groups.map((g) => ({ ...g }));
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

/** Maximum local XZ distance from the origin, including asymmetric mesh lobes. */
export function footprintRadius(data: GeometryData): number {
  if (data.positions.length % 3 || !data.positions.every(Number.isFinite))
    throw new RangeError('Invalid footprint positions');
  let radius = 0;
  for (let i = 0; i < data.positions.length; i += 3)
    radius = Math.max(radius, Math.hypot(data.positions[i], data.positions[i + 2]));
  return radius;
}

/** Five vec4s per vertex: position, normal, tangent, UV0/UV1, and RGB tint / alpha ambient occlusion. */
export function pbrVertexStream(
  data: GeometryData,
  occlusion?: (x: number, y: number, z: number) => number,
): Float32Array {
  const count = data.positions.length / 3;
  if (
    !Number.isInteger(count) ||
    data.normals.length !== count * 3 ||
    data.uvs.length !== count * 2 ||
    data.tangents?.length !== count * 4 ||
    (occlusion !== undefined && typeof occlusion !== 'function')
  )
    throw new RangeError('Invalid PBR vertex attributes');
  const vertices = new Float32Array(count * 20),
    P = data.positions,
    N = data.normals,
    UV = data.uvs,
    T = data.tangents!;
  for (let i = 0; i < count; i++) {
    const o = i * 20,
      p = i * 3,
      t = i * 4;
    vertices[o] = P[p];
    vertices[o + 1] = P[p + 1];
    vertices[o + 2] = P[p + 2];
    vertices[o + 3] = 1;
    vertices[o + 4] = N[p];
    vertices[o + 5] = N[p + 1];
    vertices[o + 6] = N[p + 2];
    vertices[o + 8] = T[t];
    vertices[o + 9] = T[t + 1];
    vertices[o + 10] = T[t + 2];
    vertices[o + 11] = T[t + 3];
    vertices[o + 12] = vertices[o + 14] = UV[i * 2];
    vertices[o + 13] = vertices[o + 15] = UV[i * 2 + 1];
    const ao = occlusion ? occlusion(P[p], P[p + 1], P[p + 2]) : 1;
    if (!Number.isFinite(ao) || ao < 0 || ao > 1) throw new RangeError('Invalid baked vertex occlusion');
    vertices[o + 16] = vertices[o + 17] = vertices[o + 18] = 1;
    vertices[o + 19] = ao;
  }
  for (let i = 0; i < vertices.length; i++)
    if (!Number.isFinite(vertices[i])) throw new RangeError('PBR vertex attributes must be finite');
  return vertices;
}
