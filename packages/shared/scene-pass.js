// One render pass on a frame pass context's scene colour and depth, for a pass that `joins` (core FramePass.joins).

/**
 * Points `color` and `depth` (attachment objects the caller keeps, so a frame allocates nothing) at the context's
 * scene targets, set to load and store (stencil too when the depth format has one), hands them to `attach` as the
 * pass's last render pass, and begins the render pass.
 */
export function beginScenePass(c, color, depth) {
  const stencil = c.descriptor.depthStencil.format.includes('stencil');
  color.view = c.color;
  color.loadOp = 'load';
  color.storeOp = 'store';
  color.resolveTarget = undefined;
  depth.view = c.depth;
  depth.depthLoadOp = 'load';
  depth.depthStoreOp = 'store';
  depth.stencilLoadOp = stencil ? 'load' : undefined;
  depth.stencilStoreOp = stencil ? 'store' : undefined;
  c.attach?.(color, depth, true);
  return c.encoder.beginRenderPass({ colorAttachments: [color], depthStencilAttachment: depth });
}
