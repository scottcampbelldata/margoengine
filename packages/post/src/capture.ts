import { compatibilityLevel } from '../../shared/compat.js';

/**
 * The HDR capture's format. Linear half floats, except where the capture is multisampled at WebGPU's compatibility level,
 * which cannot multisample them: there rg11b10ufloat, with less precision and no alpha. Shared by PostStack and the
 * effects that capture the scene alone (Bloom), so neither picks a format the level refuses.
 */
export const captureFormat = (d: GPUDevice, samples: number): GPUTextureFormat =>
  samples > 1 && compatibilityLevel(d) && d.features.has('rg11b10ufloat-renderable') ? 'rg11b10ufloat' : 'rgba16float';
