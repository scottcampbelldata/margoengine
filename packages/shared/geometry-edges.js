// The edges of a core Geometry whose faces meet above an angle, plus open boundaries, as index pairs: what cad's
// capsAsSolid (an angle of 180 leaves only open and inconsistently wound edges) and machinery's featureEdges read.
// Positions are taken out of the interleaved vertices (position, normal) and welded as edgesGeometry welds them.
import { edgesGeometry } from '@margoengine/geometry/utils';

export function geometryEdges(geometry, angle) {
  const v = geometry.vertices,
    positions = new Float32Array(v.length / 2);
  for (let i = 0, j = 0; i < v.length; i += 6, j += 3) {
    positions[j] = v[i];
    positions[j + 1] = v[i + 1];
    positions[j + 2] = v[i + 2];
  }
  return edgesGeometry({ positions, normals: positions, uvs: new Float32Array(0), indices: geometry.indices }, angle);
}
