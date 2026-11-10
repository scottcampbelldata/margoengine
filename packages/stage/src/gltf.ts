import type { Stage } from './index.js';
import type { LoadedModel } from './model.js';
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
 * Loads a glTF or GLB file with `@margoengine/gltf-pro`, including textures, skins, morphs and clips, and fits
 * the camera to it. Packages load on first use. Rejects with `Install @margoengine/gltf-pro` when it is
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
  const { loadGLTF } = await optionalPackage('@margoengine/gltf-pro', () => import('@margoengine/gltf-pro'), abort),
    pbr = await loadGLTF(stage.engine, target, { signal: abort });
  try {
    abort.throwIfAborted();
    const needsAnimation =
      !!pbr.asset.doc.animations?.length ||
      pbr.primitives.some(
        (primitive) => primitive.weights.length > 0 || pbr.asset.doc.nodes?.[primitive.nodeIndex]?.skin !== undefined,
      );
    const player = needsAnimation
      ? (
          await optionalPackage('@margoengine/animation', () => import('@margoengine/animation'), abort)
        ).Animation.attach(pbr)
      : null;
    if (player) player.playing = false;
    return Object.assign(
      placeModel(
        stage,
        {
          root: pbr.root,
          meshes: [...new Set([...pbr.primitives, ...pbr.pointsAndLines].map((primitive) => primitive.node))],
          dispose: () => pbr.dispose(),
        },
        fit,
        abort,
      ),
      { pbr, animation: player },
    );
  } catch (error) {
    pbr.dispose();
    throw error;
  }
}
