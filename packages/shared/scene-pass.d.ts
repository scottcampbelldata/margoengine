import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/**
 * Points `color` and `depth` at the context's scene targets (load and store, stencil too when the depth format has
 * one), hands them to `attach` as the pass's last render pass, and begins the render pass.
 */
export function beginScenePass(
  c: Context,
  color: GPURenderPassColorAttachment,
  depth: GPURenderPassDepthStencilAttachment,
): GPURenderPassEncoder;
