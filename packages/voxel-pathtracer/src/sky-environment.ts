import type { HillaireEnvironmentOptions } from '@margoengine/sky/hillaire';
import type { TraceEnvironment } from './types.js';

export type { HillaireEnvironmentOptions } from '@margoengine/sky/hillaire';

/**
 * Bake multiple-scattered daylight, ozone and a stable stylized night to the tracer's
 * importance-sampled environment. The separate sun carries atmospheric transmittance;
 * its disc is excluded from the map. No core, stage or tracer shader change is needed.
 * Baking needs WebGPU (including its WebGL2 compatibility device); the returned floats
 * survive device loss and can be reused by any tracer on a restored device.
 */
export async function traceSkyEnvironment(
  device: GPUDevice,
  options: HillaireEnvironmentOptions = {},
): Promise<TraceEnvironment> {
  const { bakeHillaireEnvironment } = await import('@margoengine/sky/hillaire');
  const { width, height, data, sunDirection, sunColor, sunIntensity } = await bakeHillaireEnvironment(device, options);
  return { map: { width, height, data }, sunDirection, sunColor, sunIntensity, sunAngularSize: 0.009306 };
}
