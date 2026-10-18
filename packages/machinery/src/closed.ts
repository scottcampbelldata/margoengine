// Which geometries a section may cap: closed solids. A CAD body the Margo kernel meshes arrives as one geometry per
// face colour, and each piece alone is an open shell; re-meshed finely, its edges under 0.1 mm weld into one another
// in the generic test. The loader knows the body is closed (its faces share their edge samples bit for bit), so it
// marks the pieces, and the stencil cap, which counts faces across every mesh drawn, fills the cut of the whole.
import type { Geometry } from '@margoengine/core/extension';
import { featureEdges } from './edges.js';

const solidPieces = new WeakSet<Geometry>();

/** Marks geometries that together bound one closed solid. */
export function markSolidPieces(geometries: Iterable<Geometry>): void {
  for (const geometry of geometries) solidPieces.add(geometry);
}

/**
 * Whether sections cap a geometry (and packing may claim it): a piece of a closed solid a loader marked, or a mesh with
 * no edge that is not shared by exactly two consistently wound triangles (positions welded to 0.1 mm per unit).
 */
export function capsAsSolid(geometry: Geometry): boolean {
  return solidPieces.has(geometry) || featureEdges(geometry, 180).length === 0;
}
