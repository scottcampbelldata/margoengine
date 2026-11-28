/**
 * The colour and depth attachments of a render pass that draws into what the frame already holds: both load their
 * contents and both are stored. The caller sets `color.view` and `depth.view` (and the stencil ops, when the depth
 * format has a stencil) before each pass and keeps the pair for the life of the effect, so a frame allocates nothing.
 * @returns {{ color: GPURenderPassColorAttachment, depth: GPURenderPassDepthStencilAttachment }}
 */
export function loadAttachments() {
  return {
    color: { view: undefined, loadOp: 'load', storeOp: 'store' },
    depth: { view: undefined, depthLoadOp: 'load', depthStoreOp: 'store' },
  };
}
