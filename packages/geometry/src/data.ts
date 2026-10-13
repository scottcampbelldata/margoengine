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

/** Five vec4s per vertex: position, normal, tangent, UV0/UV1, and RGB tint / alpha ambient occlusion. */
export function pbrVertexStream(data: GeometryData, occlusion?: (x: number, y: number, z: number) => number): Float32Array {
  const count = data.positions.length / 3;
  if (!Number.isInteger(count) || data.normals.length !== count*3 || data.uvs.length !== count*2 || data.tangents?.length !== count*4 || occlusion !== undefined && typeof occlusion !== 'function') throw new RangeError('Invalid PBR vertex attributes');
  const vertices = new Float32Array(count*20);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {vertices[i*20+k] = data.positions[i*3+k]; vertices[i*20+4+k] = data.normals[i*3+k];}
    vertices[i*20+3] = 1;
    for (let k = 0; k < 4; k++) vertices[i*20+8+k] = data.tangents![i*4+k];
    for (let k = 0; k < 2; k++) vertices[i*20+12+k] = vertices[i*20+14+k] = data.uvs[i*2+k];
    const ao = occlusion ? occlusion(data.positions[i*3],data.positions[i*3+1],data.positions[i*3+2]) : 1;
    if (!Number.isFinite(ao) || ao<0 || ao>1) throw new RangeError('Invalid baked vertex occlusion');
    vertices.fill(1,i*20+16,i*20+19); vertices[i*20+19] = ao;
  }
  if (vertices.some(v => !Number.isFinite(v))) throw new RangeError('PBR vertex attributes must be finite');
  return vertices;
}
