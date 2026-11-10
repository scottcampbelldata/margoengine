import type { Stage } from './index.js';
import type { LoadedModel } from './model.js';
import { loadTarget, placeModel, stageSignal } from './feature.js';
import { gltfPackage, gltfRoute } from './gltf-route.js';

export type { LoadedModel } from './model.js';
/** Options for `addGLTF`. */
export interface AddGLTFOptions {
  /** Cancels the load; the stage's disposal cancels it too. */
  signal?: AbortSignal;
  /** Fit the camera to the loaded model. Default true. */
  fit?: boolean;
}

/**
 * Loads plain static geometry with `@margoengine/gltf`; textures and advanced features use `@margoengine/gltf-pro`.
 * Skins, morphs and clips also require `@margoengine/animation`. Only the selected packages load, on first use.
 * A missing package rejects with a coded feature-specific error. Aborting adds nothing.
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
  const route = await gltfRoute(target, abort);
  if (!route.feature) {
    const { loadGLTF } = await gltfPackage(
      '@margoengine/gltf',
      'static geometry',
      () => import('@margoengine/gltf'),
      abort,
    );
    return Object.assign(
      placeModel(stage, await loadGLTF(stage.engine, target, { signal: abort, fetch: route.fetch }), fit, abort),
      { animation: null },
    );
  }
  const { loadGLTF } = await gltfPackage(
      '@margoengine/gltf-pro',
      route.feature,
      () => import('@margoengine/gltf-pro'),
      abort,
    ),
    animation = route.animation
      ? await gltfPackage('@margoengine/animation', route.animation, () => import('@margoengine/animation'), abort)
      : null,
    pbr = await loadGLTF(stage.engine, target, { signal: abort, fetch: route.fetch });
  try {
    abort.throwIfAborted();
    const player = animation ? animation.Animation.attach(pbr) : null;
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
