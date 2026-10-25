// Which geometries a section may cap: closed solids, found by their edges.
import type { Geometry } from '@margoengine/core/extension';
import { featureEdges } from './edges.js';

/**
 * Whether sections cap a geometry (and packing may claim it): a mesh with
 * no edge that is not shared by exactly two consistently wound triangles (positions welded to 0.1 mm per unit).
 */
export function capsAsSolid(geometry: Geometry): boolean {
  return featureEdges(geometry, 180).length === 0;
}
