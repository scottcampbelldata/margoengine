import type { EngineKernel } from '@margoengine/core';
import type { Stage } from './index.js';
import type { LoadedModel, StageModel } from './model.js';
import { loadTarget, optionalPackage, placeModel, stageSignal } from './feature.js';

export type { LoadedModel } from './model.js';
/** Options for `addGLTF`. */
export interface AddGLTFOptions {
  /** Cancels the load; the stage's disposal cancels it too. */
  signal?: AbortSignal;
  /** Fit the camera to the loaded model. Default true. */
  fit?: boolean;
}

/**
 * Loads a glTF or GLB file with `@margoengine/gltf` (static, constant-colour geometry), adds it to the stage and fits
 * the camera to it. The package is imported on the first call. Rejects with `Install @margoengine/gltf` when it is
 * missing, and with AbortError, adding nothing, when `signal` aborts or the stage is disposed first.
 * @example const model = await addGLTF(stage, '/model.glb');
 */
export async function addGLTF(
  stage: Stage,
  url: string | URL,
  { fit = true, signal }: AddGLTFOptions = {},
): Promise<LoadedModel> {
  const target = loadTarget(url, fit),
    abort = stageSignal(stage, signal);
  abort.throwIfAborted();
  const gltf = (await optionalPackage('@margoengine/gltf', () => import('@margoengine/gltf'), abort)) as {
    loadGLTF(engine: EngineKernel, url: URL, options: { signal?: AbortSignal }): Promise<StageModel>;
  };
  return placeModel(stage, await gltf.loadGLTF(stage.engine, target, { signal: abort }), fit, abort);
}
