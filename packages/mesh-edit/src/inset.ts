import type { Mat4 } from '@margoengine/math';
import { meshSelectionVertices } from './components.js';
import { affineMatrix, invertAffine } from './matrix.js';
import { prepareInsetRegionPlacement } from './inset-plane.js';
import { replaceRegionCaps } from './region-topology.js';
import type { RegionExtrudeResult } from './region.js';
import type { MeshEditOptions, PolygonMesh } from './types.js';

/** Options for {@link insetMeshRegion}. */
export interface RegionInsetOptions extends MeshEditOptions {
  /** Matrix the width is measured through; pass the object's world matrix for a world-space width. */
  worldMatrix?: Mat4;
}
/** Result of an inset: the extrude-style provenance, the new border faces, and per-region loops and width. */
export interface RegionInsetResult extends Omit<RegionExtrudeResult, 'sideFaces' | 'regions'> {
  borderFaces: RegionExtrudeResult['sideFaces'];
  regions: { faces: string[]; boundaryEdges: string[]; boundaryLoops: string[][]; width: number }[];
}

/**
 * Inset each edge-connected planar group of selected faces by an equal `width`.
 * Concave outlines, holes, collinear corners and interior vertices are supported. Boundary corners move along their
 * miters; interior vertices follow smoothly. Caps keep their face IDs and corner UVs. Border faces are built only
 * along boundary edges and copy that edge's UVs, so give them their own islands with `allocateMeshFaceUV` before
 * painting. With `worldMatrix`, the width is measured in world space, through rotation, mirroring and
 * non-uniform scale. Width 0 or an empty selection returns an unchanged copy. Unused vertices are removed and the
 * rest renumbered. A width that collapses, crosses or folds the region throws; it is never clamped. Curved regions
 * and straight-skeleton events are not supported.
 * @throws TypeError for bad input, options or IDs; RangeError for a bad width or matrix, or collapsed geometry;
 * MargoError `unsupported` for a non-planar or ambiguous region.
 */
export function insetMeshRegion(
  mesh: PolygonMesh,
  faceIds: readonly string[],
  width = 0.1,
  options: RegionInsetOptions = {},
): RegionInsetResult {
  meshSelectionVertices(mesh, { mode: 'face', faces: faceIds });
  if (!Number.isFinite(width) || width < 0)
    throw new RangeError(
      'Inset width must be finite and nonnegative; choose a positive metric width or zero for no change.',
    );
  const { world, inverse } = resolveInsetMetric(options);
  const loops: string[][][] = [];
  const result = replaceRegionCaps(mesh, faceIds, options, width === 0, (region) => {
    const placement = prepareInsetRegionPlacement(mesh, region, world, inverse)(width);
    loops.push(placement.loops);
    return { positions: placement.positions, offset: [0, 0, 0] };
  });
  return insetResult(result, loops, width);
}

/**
 * Turn a region-cap result into an inset result: side faces become border faces, and each region gains its
 * boundary loops and the width.
 */
export function insetResult(
  { sideFaces, regions, ...rest }: RegionExtrudeResult,
  loops: readonly string[][][],
  width: number,
): RegionInsetResult {
  return {
    ...rest,
    borderFaces: sideFaces,
    regions: regions.map((region, i) => ({
      faces: region.faces,
      boundaryEdges: region.boundaryEdges,
      boundaryLoops: loops[i],
      width,
    })),
  };
}

/**
 * Checked copy of the inset world matrix and its inverse; both are undefined without `worldMatrix`.
 * @throws TypeError for a non-object options value; TypeError or RangeError for a bad matrix.
 */
export function resolveInsetMetric(options: RegionInsetOptions): { world?: Float64Array; inverse?: Float64Array } {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Inset options need an object; supply worldMatrix/createId or omit options.');
  if (options.worldMatrix === undefined) return {};
  const world = affineMatrix(options.worldMatrix, 'Inset world matrix');
  return { world, inverse: invertAffine(world, 'Inset world matrix') };
}
