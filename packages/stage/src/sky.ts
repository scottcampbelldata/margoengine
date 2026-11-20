import type { SkyMoon, SkyMoonConfig } from '@margoengine/sky/night-preset';
import type { Stage } from './index.js';
import { attachPlugin } from './feature.js';

/**
 * Attaches the `@margoengine/sky` sky (`SkyMoon`: sun, moon and stars) to the stage, importing it on the first
 * call. Rejects with `Install @margoengine/sky` when it is missing, and with AbortError, attaching nothing, when the
 * stage is disposed first. Needs WebGPU.
 * @example const sky = await addSky(stage, { moonPhase: 0.5 });
 */
export function addSky(stage: Stage, options: SkyMoonConfig = {}): Promise<SkyMoon> {
  return attachPlugin(
    stage,
    '@margoengine/sky',
    () => import('@margoengine/sky/night-preset'),
    ({ SkyMoon }) => new SkyMoon(options),
  );
}
