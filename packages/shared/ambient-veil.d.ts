import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Something blended over the scene that takes its coverage out of an ambient replay (see ambient-veil.js). */
export interface AmbientVeil {
  veil(context: Context, format: GPUTextureFormat): void;
}
/** Adds `veil` to `device`'s ambient veils; returns the remover. */
export function addAmbientVeil(device: GPUDevice, veil: AmbientVeil): () => void;
/** Draws every veil of `context.device` over `context.color`, a target of `format`, against `context.depth`. */
export function drawAmbientVeils(context: Context, format: GPUTextureFormat): void;
