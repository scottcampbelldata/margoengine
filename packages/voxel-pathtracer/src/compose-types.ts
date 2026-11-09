import type { VoxelTraceScene } from '@margoengine/voxel-pathtracer';

/** Validate optional factory settings before selecting defaults or allocating resources. */
export function validateFeatureOptions(options: unknown, name: string): void {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError(`${name} options must be an object`);
}

/** Optional tracer features, applied in this fixed order regardless of array order. */
export type VoxelTraceFeatureId = 'resampling' | 'mesh' | 'media' | 'guiding' | 'spectral';

/** A validated feature from an optional entry. Import only the features your scene needs. */
export interface VoxelTraceFeature {
  /** Feature identity; a composition accepts each identity at most once. */
  readonly id: VoxelTraceFeatureId;
  /** Pure specialization of the shared tracing kernel, also used after device replacement. */
  readonly source: (source: string) => string;
  /** Optional palette conversion, applied to each create/setScene snapshot before geometry preparation. */
  readonly scene?: (scene: VoxelTraceScene) => VoxelTraceScene;
  /** Optional geometry storage in the scene binding. Only the mesh feature owns this storage. */
  readonly geometry?: (scene: VoxelTraceScene, signal?: AbortSignal) => Promise<Uint32Array>;
}
