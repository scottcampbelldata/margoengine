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

/** Maximum local XZ distance from the origin, including asymmetric mesh lobes. */
export function footprintRadius(data: GeometryData): number {
  if (data.positions.length % 3 || !data.positions.every(Number.isFinite)) throw new RangeError('Invalid footprint positions');
  let radius = 0;
  for (let i = 0; i < data.positions.length; i += 3) radius = Math.max(radius,Math.hypot(data.positions[i],data.positions[i+2]));
  return radius;
}

/** Five vec4s per vertex: position, normal, tangent, UV0/UV1, and baked RGB occlusion. */
export function pbrVertexStream(data: GeometryData, occlusion?: (x: number, y: number, z: number) => number): Float32Array {
  const count = data.positions.length / 3;
  if (!Number.isInteger(count) || data.normals.length !== count*3 || data.uvs.length !== count*2 || data.tangents?.length !== count*4 || occlusion !== undefined && typeof occlusion !== 'function') throw new RangeError('Invalid PBR vertex attributes');
  const vertices = new Float32Array(count*20);
  for (let i = 0; i < count; i++) {
    vertices.set(data.positions.subarray(i*3,i*3+3),i*20); vertices[i*20+3] = 1;
    vertices.set(data.normals.subarray(i*3,i*3+3),i*20+4);
    vertices.set(data.tangents!.subarray(i*4,i*4+4),i*20+8);
    vertices.set(data.uvs.subarray(i*2,i*2+2),i*20+12);
    vertices.set(data.uvs.subarray(i*2,i*2+2),i*20+14);
    const ao = occlusion ? occlusion(data.positions[i*3],data.positions[i*3+1],data.positions[i*3+2]) : 1;
    if (!Number.isFinite(ao) || ao<0 || ao>1) throw new RangeError('Invalid baked vertex occlusion');
    vertices.fill(ao,i*20+16,i*20+19); vertices[i*20+19] = 1;
  }
  if (vertices.some(v => !Number.isFinite(v))) throw new RangeError('PBR vertex attributes must be finite');
  return vertices;
}
