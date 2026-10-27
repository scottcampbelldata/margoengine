import type { SkyMoon, SkyMoonConfig } from '@margoengine/scenery/sky';
import type { Stage } from './index.js';
import { attachPlugin } from './feature.js';

/**
 * Attaches the `@margoengine/scenery` sky (`SkyMoon`: sun, moon and stars) to the stage, importing it on the first
 * call. Rejects with `Install @margoengine/scenery` when it is missing, and with AbortError, attaching nothing, when the
 * stage is disposed first. Needs WebGPU.
 * @example const sky = await addSky(stage, { moonPhase: 0.5 });
 */
export function addSky(stage: Stage, options: SkyMoonConfig = {}): Promise<SkyMoon> {
  return attachPlugin(
    stage,
    '@margoengine/scenery',
    () => import('@margoengine/scenery/sky'),
    ({ SkyMoon }) => new SkyMoon(options),
  );
}
