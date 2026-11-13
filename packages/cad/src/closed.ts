// Which geometries packing may claim: closed solids, found by their edges.
import type { Geometry } from '@margoengine/core/extension';
import { edgesGeometry } from '@margoengine/geometry/utils';

/**
 * Whether a geometry is a closed solid: no edge that is not shared by exactly two consistently wound triangles
 * (positions welded as `edgesGeometry` welds them). The same test sections cap by.
 */
export function capsAsSolid(geometry: Geometry): boolean {
  const v = geometry.vertices,
    positions = new Float32Array(v.length / 2);
  for (let i = 0, j = 0; i < v.length; i += 6, j += 3) {
    positions[j] = v[i];
    positions[j + 1] = v[i + 1];
    positions[j + 2] = v[i + 2];
  }
  return (
    edgesGeometry({ positions, normals: positions, uvs: new Float32Array(0), indices: geometry.indices }, 180)
      .length === 0
  );
}
