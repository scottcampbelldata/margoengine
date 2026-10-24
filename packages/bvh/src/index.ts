export { MeshBVH, NOT_INTERSECTED, INTERSECTED, CONTAINED } from './bvh.js';
export type {
  GeometryLike,
  TriangleSource,
  BVHPositions,
  RaycastOptions,
  SegmentOptions,
  BVHHit,
  ClosestPointOptions,
  ClosestPointResult,
  Box3Like,
  ShapecastBox,
  ShapecastTriangle,
  ShapecastCallbacks,
  SerializedBVH,
} from './bvh.js';
// One definition in @margoengine/math: readonly Vec3 for inputs, MutableVec3 for results the caller owns.
export type { Vec3, MutableVec3 } from '@margoengine/math';
export { buildBVH } from './build.js';
export type { BVHBuildOptions, BVHData } from './build.js';
export { buildAsync, terminateBVHWorker } from './async.js';
export type { AsyncBuildOptions } from './async.js';
export {
  Raycaster,
  getGeometryBVH,
  setGeometryBVH,
  hasGeometryBVH,
  computeGeometryBVHAsync,
  setMeshLayers,
  getMeshLayers,
} from './raycaster.js';
export type {
  RaycasterHit,
  RaycasterSide,
  IntersectOptions,
  PickingGeometry,
  DeformedPickingSource,
} from './raycaster.js';
export { frustumPlanes } from './math.js';
export type { Side } from './math.js';

export {
  getPrimitiveBVH,
  hasPrimitiveBVH,
  computePrimitiveBVHAsync,
  engineModels,
  engineProxies,
  isModel,
} from './raycaster.js';
export type { ModelLike, ModelPrimitiveLike, PickProxy } from './raycaster.js';
export { worldTriangles } from './triangles.js';
export type { WorldTriangles, WorldTrianglesOptions } from './triangles.js';
export { RaycastSnapshot } from './raycast-snapshot.js';
export type { RaycastSnapshotOptions } from './raycast-snapshot.js';
export type { RaycastDepthHit } from './raycast-snapshot.js';
export {
  RaycastProjection,
  type RaycastProjectedPoint,
  type RaycastProjectionOptions,
  type RaycastProjectedSegment,
  type RaycastProjectSegmentOptions,
} from './projection.js';
export type { RaycastSegmentPoint, RaycastScreenRectangle } from './screen-query.js';
export type {
  RaycastAlphaTexture,
  RaycastDepthSample,
  RaycastVisibilityOptions,
  RaycastVisibilityQuery,
} from './visibility-query.js';
