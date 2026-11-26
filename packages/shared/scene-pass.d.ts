import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** The attachment objects a pass that calls {@link beginScenePass} keeps for its life; beginScenePass sets every field. */
export function sceneAttachments(): {
  color: GPURenderPassColorAttachment;
  depth: GPURenderPassDepthStencilAttachment;
};
/**
 * Points `color` and `depth` at the context's scene targets (load and store, stencil too when the depth format has
 * one), hands them to `attach` as the pass's last render pass, and begins the render pass.
 */
export function beginScenePass(
  c: Context,
  color: GPURenderPassColorAttachment,
  depth: GPURenderPassDepthStencilAttachment,
): GPURenderPassEncoder;
