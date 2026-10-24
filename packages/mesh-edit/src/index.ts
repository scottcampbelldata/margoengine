// @margoengine/mesh-edit: pure polygon modelling for editors. Indexed polygons with per-corner UVs, edit commands
// with explicit provenance, cleanup, surface queries, UV layout and editing, and RGBA8 atlas painting.
export type {
  PolygonFace,
  PolygonMesh,
  MeshEditOptions,
  MeshEditResult,
  PrimitiveMeshKind,
  PolygonEdgeIncidence,
  PolygonEdge,
  CompiledPolygonMesh,
  ComponentSelection,
  ComponentEditResult,
  ComponentTransformOptions,
  QuadRingSeed,
  QuadRing,
  QuadRingCutResult,
} from './types.js';
export { createPrimitiveMesh, meshTileUV } from './primitives.js';
export { extrudeMeshFace, insetMeshFace, cutMeshFace, bevelPolygonMesh } from './operations.js';
export { polygonGeometryError, polygonMeshEdges, compilePolygonMesh } from './polygon.js';
export { quantizePolygonMesh } from './quantize.js';
export { cleanupPolygonMeshes, isAtlasOpaque, type PolygonCleanupInput, type PolygonCleanupResult } from './cleanup.js';
export { meshSelectionVertices, transformMeshComponents } from './components.js';
export { deleteMeshComponents, type DeleteComponentsOptions, type DeleteComponentsResult } from './delete.js';
export { traceMeshQuadRing, cutMeshQuadRing } from './ring.js';
export { extrudeMeshRegion, type RegionExtrudeOptions, type RegionExtrudeResult } from './region.js';
export { insetMeshRegion, type RegionInsetOptions, type RegionInsetResult } from './inset.js';
export { MeshRegionInsetSession } from './inset-session.js';
export {
  MeshSurfaceQuery,
  type SurfaceRay,
  type SurfaceQueryOptions,
  type SurfaceHit,
  type SurfaceFrame,
  type SurfaceWorldFrame,
} from './surface-query.js';
export type { SurfaceSource, SurfaceTriangle } from './surface-source.js';
export {
  MeshRegionInsetPreview,
  type RegionInsetPreviewOptions,
  type RegionInsetPreviewResult,
} from './inset-preview.js';
export type {
  PaintFace,
  PaintGeometry,
  PaintObject,
  PaintTexture,
  PaintAtlas,
  PaintScene,
  PaintHit,
  PaintOptions,
  PaintUVResult,
  PaintPatch,
  PaintStroke,
} from './paint-types.js';
export { meshPaintTexel, paintMeshSurface, paintMeshAtlas, fillMeshPaintFaces, mirrorMeshPaintHit } from './paint.js';
export { MeshPaintSession } from './paint-session.js';
export { allocateMeshFaceUV, projectMeshUV, packMeshUV, resizeMeshPaintAtlas } from './uv.js';
export { meshUVTopology, meshSelectionUVCorners, transformMeshUVs, meshUVHits } from './uv-edit.js';
export type {
  UVCorner,
  UVIsland,
  UVTopology,
  UVSelection,
  UVTransform,
  UVEditResult,
  UVHitResult,
} from './uv-edit.js';
export {
  dominantMeshPaintColors,
  createMeshPaintPalette,
  applyMeshPaintPalette,
  type PaintPalettePreset,
} from './paint-palette.js';
