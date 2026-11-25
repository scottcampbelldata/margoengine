import type { VoxelTraceScene } from '@margoengine/voxel-pathtracer';

/** Geometry retained by the optional mesh builder for the current committed scene. */
export interface TraceMeshStats {
  /** Nonzero-area triangles retained in the current geometry. Zero without the mesh feature. */
  readonly meshTriangles: number;
  /** Exactly zero-area input triangles omitted from the current geometry. */
  readonly skippedDegenerateTriangles: number;
  /** Nodes in the current stackless triangle BVH. Zero for empty geometry. */
  readonly meshBvhNodes: number;
  /** Active nonempty explicit mesh instances. Zero for legacy world-space scenes. */
  readonly meshInstances: number;
  /** Shared BLAS builds during the last committed preparation. */
  readonly builtMeshBlases: number;
  /** Byte-identical BLAS results reused during the last committed preparation. */
  readonly reusedMeshBlases: number;
}

export function traceMeshStats(words: Uint32Array): TraceMeshStats {
  return {
    meshTriangles: words[2] ?? 0,
    skippedDegenerateTriangles: words[3] ?? 0,
    meshBvhNodes: words[1] === 0 ? (words[8] ?? 0) : (words[0] ?? 0),
    meshInstances: words[1] === 0 ? (words[4] ?? 0) : 0,
    builtMeshBlases: words[1] === 0 ? (words[6] ?? 0) : 0,
    reusedMeshBlases: words[1] === 0 ? (words[7] ?? 0) : 0,
  };
}

/** Whether a mesh packet holds a moving instance (two-level packets count them in word 11). */
export function traceMeshMoving(words: Uint32Array): boolean {
  return words[1] === 0 && words[9] === 0x4d494e53 && (words[11] ?? 0) > 0;
}

/** Validate optional factory settings before selecting defaults or allocating resources. */
export function validateFeatureOptions(options: unknown, name: string): void {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError(`${name} options must be an object`);
}

/** Optional tracer features, applied in this fixed order regardless of array order. */
export type VoxelTraceFeatureId = 'resampling' | 'mesh' | 'media' | 'guiding' | 'spectral';

/** Per-tracer geometry lifetime. Factories must return a fresh builder for each tracer. */
export interface TraceGeometryBuilder {
  /** Prepare owned storage; callers snapshot the scene before calling. */
  build(scene: VoxelTraceScene, signal?: AbortSignal): Promise<Uint32Array>;
  /** Release cached CPU geometry; idempotent. */
  dispose(): void;
  /** The motion interval error of the last built scene, which the tracer raises only when its shutter opens. */
  readonly motionError?: RangeError;
}

/** Holds a scene's motion interval error and raises it whenever the shutter is above 0 (as voxel instances do). */
export class MotionGate {
  error: RangeError | undefined;
  /** Throws `error` when `shutter` opens the shutter. */
  check(shutter: unknown, error = this.error): void {
    if (error && typeof shutter === 'number' && shutter > 0) throw error;
  }
}

/** A validated feature from an optional entry. Import only the features your scene needs. */
export interface VoxelTraceFeature {
  /** Feature identity; a composition accepts each identity at most once. */
  readonly id: VoxelTraceFeatureId;
  /** Pure specialization of the shared tracing kernel, also used after device replacement. */
  readonly source: (source: string) => string;
  /** Optional palette conversion, applied to each create/setScene snapshot before geometry preparation. */
  readonly scene?: (scene: VoxelTraceScene) => VoxelTraceScene;
  /** Optional geometry storage in the scene binding. Only the mesh feature owns this storage. */
  readonly geometry?: () => TraceGeometryBuilder;
}
