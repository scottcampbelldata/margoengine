export { MeshBVH, NOT_INTERSECTED, INTERSECTED, CONTAINED } from './bvh.js';
export type {
  Vec3,
  GeometryLike,
  TriangleSource,
  Ray,
  RaycastOptions,
  BVHHit,
  ClosestPointOptions,
  ClosestPointResult,
  Box3Like,
  ShapecastBox,
  ShapecastTriangle,
  ShapecastCallbacks,
  SerializedBVH,
} from './bvh.js';
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
export { frustumPlanes, multiply as multiplyMatrices, invert as invertMatrix } from './math.js';
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
