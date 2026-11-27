// Which geometries packing may claim: closed solids, found by their edges.
import type { Geometry } from '@margoengine/core/extension';
import { geometryEdges } from '../../shared/geometry-edges.js';

/**
 * Whether a geometry is a closed solid: no edge that is not shared by exactly two consistently wound triangles
 * (positions welded as `edgesGeometry` welds them). The same test sections cap by.
 */
export function capsAsSolid(geometry: Geometry): boolean {
  return geometryEdges(geometry, 180).length === 0;
}
