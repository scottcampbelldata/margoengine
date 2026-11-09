import type { Geometry } from '@margoengine/core';
import { fault } from '../../shared/errors.js';

/** A terrain elevation function in metres, compatible with terrain heightfieldGeometry. */
export type RoadHeightField = (x: number, z: number) => number;
/** Cut-and-fill settings for a triangulated road in world coordinates. */
export interface RoadTerrainOptions {
  /** Original ground elevation. Default flat ground at zero. Must return finite heights within +/-1,000,000 m. */
  base?: RoadHeightField;
  /** Shoulder blending distance outside the footprint, 0..1000 metres. Default 2. */
  shoulder?: number;
  /** Bed distance below the road, 0..100 metres. Default 0. */
  depth?: number;
  /** Cancels before and after lazy BVH loading. Default none. */
  signal?: AbortSignal;
}

/** Cut high ground and fill low ground to a road's triangle heights, fading back to base at the shoulder. */
export async function fitTerrain(
  geometry: Geometry,
  { base = () => 0, shoulder = 2, depth = 0, signal }: RoadTerrainOptions = {},
): Promise<RoadHeightField> {
  signal?.throwIfAborted();
  const invalid = () =>
    fault(
      'failed',
      'Terrain fit needs a bounded finite road mesh, shoulder 0..1000, depth 0..100 and a finite base height; pass valid world-space geometry and settings',
      'geometry',
    );
  if (
    typeof base !== 'function' ||
    !Number.isFinite(shoulder) ||
    shoulder < 0 ||
    shoulder > 1000 ||
    !Number.isFinite(depth) ||
    depth < 0 ||
    depth > 100
  )
    throw invalid();
  const vertices = geometry?.vertices,
    input = geometry?.indices;
  if (
    !vertices ||
    vertices.length % 6 ||
    vertices.length < 18 ||
    vertices.length > 6e6 ||
    !input?.length ||
    input.length % 3 ||
    input.length > 3e6
  )
    throw invalid();
  const positions = new Float32Array(vertices.length / 2),
    heights = new Float32Array(vertices.length / 6);
  for (let i = 0; i < heights.length; i++) {
    for (let a = 0; a < 3; a++)
      if (!Number.isFinite(vertices[i * 6 + a]) || Math.abs(vertices[i * 6 + a]) > 1e6) throw invalid();
    positions[i * 3] = vertices[i * 6];
    positions[i * 3 + 2] = vertices[i * 6 + 2];
    heights[i] = vertices[i * 6 + 1];
  }
  const kept: number[] = [];
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i],
      b = input[i + 1],
      c = input[i + 2];
    if (![a, b, c].every((v) => Number.isInteger(v) && v >= 0 && v < heights.length)) throw invalid();
    const area =
      (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 2] - positions[a * 3 + 2]) -
      (positions[b * 3 + 2] - positions[a * 3 + 2]) * (positions[c * 3] - positions[a * 3]);
    // Ignore only zero-area footprints. Banking can project curb walls over the driving surface.
    if (area !== 0) kept.push(a, b, c);
  }
  if (!kept.length) throw invalid();
  const indices = Uint32Array.from(kept);
  const { MeshBVH } = await import('@margoengine/bvh');
  signal?.throwIfAborted();
  const bvh = MeshBVH.build({ positions, indices });
  // A heightfield must stay below every surface above its XZ location. Use the lower envelope,
  // not the arbitrary first face returned by a flattened nearest-point tie.
  const envelope = (x: number, z: number, fallback = Infinity): number => {
    let bed = fallback;
    // A vertical ray tests barycentric footprint containment directly, without reconstructing
    // an XZ closest point and requiring its rounding error to have exactly zero length.
    for (const hit of bvh.raycast({origin:[x,1,z],direction:[0,-1,0]})) {
      let height = 0;
      for(let k=0;k<3;k++) height += heights[indices[hit.faceIndex*3+k]]*hit.barycoord[k];
      bed = Math.min(bed,height);
    }
    return bed;
  };
  return (x, z) => {
    if (![x, z].every((v) => Number.isFinite(v) && Math.abs(v) <= 1e6)) throw invalid();
    const original = base(x, z);
    if (!Number.isFinite(original) || Math.abs(original) > 1e6) throw invalid();
    const inside = envelope(x, z);
    if (inside !== Infinity) return inside - depth;
    if (shoulder === 0) return original;
    const hit = bvh.closestPointToPoint([x, 0, z], { maxDistance: shoulder });
    if (!hit) return original;
    let bed = 0;
    for (let k = 0; k < 3; k++) bed += heights[indices[hit.faceIndex * 3 + k]] * hit.barycoord[k];
    bed = envelope(hit.point[0], hit.point[2], bed) - depth;
    const t = Math.min(1, hit.distance / shoulder),
      blend = t * t * (3 - 2 * t);
    return bed + (original - bed) * blend;
  };
}
