export { SphereVolume, CapsuleVolume, closestPointsBetweenSegments, measureSegmentClearance } from './volumes.js';
export { AvoidanceSolver, SolveStatus } from './AvoidanceSolver.js';
export type { Vec3View, MutableVec3View, ConstraintVolume } from './types.js';
export type { SegmentDistanceResult, SphereVolumeOptions, CapsuleVolumeOptions } from './volumes.js';
export type {
  SolveOptions,
  AvoidanceSolverOptions,
  SolveResult,
  TargetResult,
  PoleClearanceResult,
  ElbowEvaluator,
} from './AvoidanceSolver.js';
