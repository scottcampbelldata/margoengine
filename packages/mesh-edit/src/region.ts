import type { MutableVec3 } from '@margoengine/math';
import { cross, sub } from '@margoengine/math/vec3';
import { meshSelectionVertices } from './components.js';
import { replaceRegionCaps } from './region-topology.js';
import type { ComponentEditResult, PolygonFace, PolygonMesh, MeshEditOptions } from './types.js';

/** Options for {@link extrudeMeshRegion}, in the mesh's local coordinates. */
export interface RegionExtrudeOptions extends MeshEditOptions {
  /** Direction to extrude along (normalized); by default each region's area-weighted normal. */
  direction?: readonly [number, number, number];
}

/** Result of a region extrusion: provenance, the cap and wall faces, and each region's offset. */
export interface RegionExtrudeResult extends ComponentEditResult {
  changed: boolean;
  capFaces: string[];
  sideFaces: { faceId: string; sourceFaceId: string; sourceEdgeId: string }[];
  /** One entry per edge-connected region: its faces, boundary edges and the offset applied. */
  regions: { faces: string[]; boundaryEdges: string[]; offset: MutableVec3 }[];
}

/** Unit direction; scales by the largest component first so huge finite inputs cannot overflow the length. */
function unitDirection(value: readonly number[]): MutableVec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
    throw new TypeError('Region direction needs three finite numbers; supply a local direction or omit it.');
  const magnitude = Math.max(...value.map(Math.abs));
  if (!magnitude) throw new RangeError('Region direction must be finite and nonzero; choose a supported local axis.');
  const scaled = value.map((v) => v / magnitude),
    length = Math.hypot(...scaled);
  return scaled.map((v) => v / length) as MutableVec3;
}

function regionDirection(mesh: PolygonMesh, faces: string[], byId: ReadonlyMap<string, PolygonFace>): MutableVec3 {
  const selected = faces.map((id) => byId.get(id)!),
    origin = mesh.vertices[selected[0].vertices[0]];
  let extent = 0;
  for (const face of selected)
    for (const index of face.vertices) extent = Math.max(extent, Math.hypot(...sub(mesh.vertices[index], origin)));
  const normal: MutableVec3 = [0, 0, 0];
  let area = 0;
  for (const face of selected) {
    const first = mesh.vertices[face.vertices[0]];
    for (let i = 1; i + 1 < face.vertices.length; i++) {
      const a = sub(mesh.vertices[face.vertices[i]], first).map((v) => v / extent) as MutableVec3,
        b = sub(mesh.vertices[face.vertices[i + 1]], first).map((v) => v / extent) as MutableVec3,
        value = cross(a, b);
      area += Math.hypot(...value);
      for (let axis = 0; axis < 3; axis++) normal[axis] += value[axis];
    }
  }
  if (Math.hypot(...normal) <= area * 1e-12)
    throw new RangeError('Selected region normals cancel; supply a direction or choose a smaller coherent region.');
  return unitDirection(normal);
}

/**
 * Extrude each edge-connected group of selected faces by `distance` along its area-weighted normal, or along
 * `direction`. Each group gets one shared cap; walls are built only along its boundary, holes included. Caps keep
 * their face IDs and corner UVs. Walls copy the UVs of the edge they come from, so give them their own islands with
 * `allocateMeshFaceUV` before painting. Interior vertices that become unused are removed and the rest renumbered.
 * Groups that touch only at a point get separate caps. Input arrays are never changed. Output polygons are
 * validated, but the mesh is not checked for self-intersection.
 * @throws TypeError for bad IDs, options or output faces; RangeError for a bad direction or distance;
 * MargoError `unsupported` for a closed selection or a touched non-manifold or inconsistently wound edge.
 */
export function extrudeMeshRegion(
  mesh: PolygonMesh,
  faceIds: readonly string[],
  distance = 0.2,
  options: RegionExtrudeOptions = {},
): RegionExtrudeResult {
  meshSelectionVertices(mesh, { mode: 'face', faces: faceIds });
  if (!Number.isFinite(distance))
    throw new RangeError('Region distance must be finite; choose a finite local distance.');
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Region options need an object; supply direction/createId or omit the options.');
  const direction = options.direction === undefined ? undefined : unitDirection(options.direction),
    byFace = new Map(mesh.faces.map((face) => [face.id, face]));
  return replaceRegionCaps(mesh, faceIds, options, distance === 0, ({ faces, vertices }) => {
    const axis = direction ?? regionDirection(mesh, faces, byFace),
      offset = axis.map((v) => v * distance) as MutableVec3;
    return {
      offset,
      positions: vertices.map((vertex) => mesh.vertices[vertex].map((v, a) => v + offset[a]) as MutableVec3),
    };
  });
}
