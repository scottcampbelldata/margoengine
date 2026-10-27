import type { EnvironmentLighting } from '@margoengine/environment';
import type { Stage } from './index.js';
import { optionalPackage, stageSignal } from './feature.js';

type Load = typeof EnvironmentLighting.load;
/** Options for `addEnvironment`: the `EnvironmentLighting.load` options (intensity, decode, ...) and `signal`. */
export type AddEnvironmentOptions = NonNullable<Parameters<Load>[2]>;

/**
 * Lights every mesh with image-based lighting from `source` (an `.hdr`, `.exr` or UltraHDR `.jpg` URL, or a decoded
 * source) through `@margoengine/environment`'s `EnvironmentLighting.load`, importing the package on the first call.
 * The stage's disposal signal is combined with `options.signal` and forwarded. Rejects with
 * `Install @margoengine/environment` when it is missing, and with AbortError, attaching nothing, when the signal aborts
 * or the stage is disposed first. Needs WebGPU.
 * @example const lighting = await addEnvironment(stage, '/studio.hdr', { intensity: 1.5 });
 */
export async function addEnvironment(
  stage: Stage,
  source: Parameters<Load>[1],
  options?: AddEnvironmentOptions,
): Promise<EnvironmentLighting> {
  const { EnvironmentLighting } = await optionalPackage(
    '@margoengine/environment',
    () => import('@margoengine/environment'),
    stage.signal,
  );
  return EnvironmentLighting.load(stage.engine, source, { ...options, signal: stageSignal(stage, options?.signal) });
}
