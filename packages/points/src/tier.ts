import { compatTier } from '../../shared/compat.js';

/**
 * Whether the WebGL2 layer rounds this device's r32float targets: below its full tier it stores them as r16float (and
 * on its ldr tier in 8 bits), whose rounding of a depth (about 0.004 at a depth of 4) moves the surfel blend window
 * and the eye-dome depth steps. Such a device gets its depths packed into rgba8unorm instead, exactly.
 */
export function roundsFloatTargets(device: GPUDevice): boolean {
  const tier = (device as { adapter?: { capabilities?: { tier?: string } } }).adapter?.capabilities?.tier;
  return compatTier(device) === 'webgl2' && tier !== 'full';
}
