import type { ShadowOptions, Shadows } from '@margoengine/shadows';
import type { Stage } from './index.js';
import { attachPlugin } from './feature.js';

/**
 * Attaches `@margoengine/shadows` cascaded shadows for the stage's directional light, importing the package on the
 * first call. Meshes present now cast; add later ones with `shadows.add(mesh)`. Rejects with
 * `Install @margoengine/shadows` when it is missing, and with AbortError, attaching nothing, when the stage is disposed
 * first. Needs WebGPU.
 * @example const shadows = await addShadows(stage, { resolution: 2048 });
 */
export async function addShadows(stage: Stage, options: ShadowOptions = {}): Promise<Shadows> {
  const shadows = await attachPlugin(
    stage,
    '@margoengine/shadows',
    () => import('@margoengine/shadows'),
    ({ Shadows }) => new Shadows(options),
  );
  for (const mesh of stage.engine.scene.meshes.values()) shadows.add(mesh);
  return shadows;
}
