import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Something blended over the scene that takes its coverage out of an ambient replay (see ambient-veil.js). */
export interface AmbientVeil {
  /** Draws the veil; returns true when it drew into this frame's view. */
  veil(context: Context, format: GPUTextureFormat): boolean;
}
/** Adds `veil` to `device`'s ambient veils; returns the remover. */
export function addAmbientVeil(device: GPUDevice, veil: AmbientVeil): () => void;
/**
 * Draws every veil of `context.device` except those in `skip` over `context.color`, a target of `format`, against
 * `context.depth`; adds each veil that drew to `drew`.
 */
export function drawAmbientVeils(
  context: Context,
  format: GPUTextureFormat,
  skip?: ReadonlySet<AmbientVeil>,
  drew?: Set<AmbientVeil>,
): void;
/** Registers an effect that reads the surface under covered strips on `device`; returns the remover. */
export function wantUnder(device: GPUDevice): () => void;
/** True while an effect on `device` reads the surface under covered strips. */
export function underWanted(device: GPUDevice): boolean;
/** Marks that this frame's view holds its covered depth back until after the effects' `under` pass. */
export function markCover(context: Context): void;
/** True when `markCover` was called for this frame's view of `context`. */
export function coverMarked(context: Context): boolean;
