import type { PostOptions, PostProcessing } from '@margoengine/creative/post';
import type { Stage } from './index.js';
import { attachPlugin } from './feature.js';

/**
 * Attaches `@margoengine/creative` post-processing and atmosphere (`PostProcessing`) to the stage, importing it on the
 * first call. Rejects with `Install @margoengine/creative` when it is missing, and with AbortError, attaching nothing,
 * when the stage is disposed first. Needs WebGPU.
 * @example const effects = await addEffects(stage, { grain: 0.02 });
 */
export function addEffects(stage: Stage, options: PostOptions = {}): Promise<PostProcessing> {
  return attachPlugin(
    stage,
    '@margoengine/creative',
    () => import('@margoengine/creative/post'),
    ({ PostProcessing }) => new PostProcessing(options),
  );
}
