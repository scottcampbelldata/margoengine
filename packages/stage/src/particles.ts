import type { GPUParticles, ParticleOptions } from '@margoengine/creative/particles';
import type { Stage } from './index.js';
import { attachPlugin } from './feature.js';

/**
 * Attaches `@margoengine/creative` GPU particles to the stage, importing them on the first call. Rejects with
 * `Install @margoengine/creative` when it is missing, and with AbortError, attaching nothing, when the stage is disposed
 * first. Needs WebGPU.
 * @example const sparks = await addParticles(stage, { count: 2000 });
 */
export function addParticles(stage: Stage, options: ParticleOptions = {}): Promise<GPUParticles> {
  return attachPlugin(
    stage,
    '@margoengine/creative',
    () => import('@margoengine/creative/particles'),
    ({ GPUParticles }) => new GPUParticles(options),
  );
}
