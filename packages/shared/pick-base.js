// The per-draw ID base of a pick overlay (lines, points): a dynamic-offset uniform buffer and its bind group.

/** Grows `state.base`, with room to spare, to hold `bytes`, and rebinds `state.baseGroup` to it. */
export function ensurePickBase(device, state, bytes) {
  if ((state.base?.size ?? 0) >= bytes) return;
  state.base?.destroy();
  state.base = device.createBuffer({
    size: bytes * 2,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  state.baseGroup = device.createBindGroup({
    layout: state.baseLayout,
    entries: [{ binding: 0, resource: { buffer: state.base, size: 16 } }],
  });
}

/** Starts a pick overlay's pass over the tile the meshes drew into, with its frame at group 0. */
export function beginPickPass(context, frameGroup) {
  const pass = context.encoder.beginRenderPass({
    colorAttachments: [{ view: context.color, loadOp: 'load', storeOp: 'store' }],
    depthStencilAttachment: { view: context.depth, depthLoadOp: 'load', depthStoreOp: 'store' },
  });
  pass.setBindGroup(0, frameGroup);
  return pass;
}
