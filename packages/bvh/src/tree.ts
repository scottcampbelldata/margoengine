// The `tree` entry: the triangle BVH alone, for engine-free code (editors, tools, workers). Neither its runtime
// nor its type declarations reference the engine core package. The main entry re-exports the same objects.
export { MeshBVH, NOT_INTERSECTED, INTERSECTED, CONTAINED } from './bvh.js';
export type {
  Vec3,
  GeometryLike,
  TriangleSource,
  BVHPositions,
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
export type { Side } from './math.js';
