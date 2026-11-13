import type { EngineKernel, Mesh } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf-pro';
import type { Animation } from '@margoengine/animation';
import type { GeometryBuffers } from '@margoengine/core/extension';
import { loadedModel as placedModel } from '../../shared/stage-model.js';

/** Root, meshes, and dispose. `loadedModel` reads only these fields. */
export interface StageModel {
  readonly root: Mesh;
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

/** A draw's buffers; an animated model's deformed vertices start `vertexOffset` bytes into `vertex` (default 0). */
type RawBuffers = Omit<GeometryBuffers, 'instance'> &
  Partial<Pick<GeometryBuffers, 'instance'>> & { readonly vertexOffset?: number };

/** What `addGLTF(stage, url)` returns: the imported meshes under one root, moved, rotated and scaled as one. */
export interface LoadedModel extends Pick<Mesh, 'position' | 'rotation' | 'scale'> {
  /** Full glTF material, texture and variant model, supplied by the glTF feature entry. */
  readonly pbr?: PBRModel;
  /** Clip player and skin/morph deformer; null for a static glTF. */
  readonly animation?: Animation | null;
  readonly root: Mesh;
  readonly meshes: readonly Mesh[];
  visible: boolean;
  readonly bounds: Float32Array;
  readonly raw: readonly RawBuffers[] | null;
  destroy(): void;
}

// The bounds, the wrapper and the load helpers are shared with @margoengine/cad's addCAD
// (packages/shared/stage-model.js; placeModel in ./feature.ts).
export { worldBounds } from '../../shared/stage-model.js';

/** Wraps an imported model as a `LoadedModel` (tests/modern-silent-facade-drops.test.js reads it from the build). */
export function loadedModel(engine: EngineKernel, model: StageModel): LoadedModel {
  return placedModel(engine, model);
}
