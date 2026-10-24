// Small render-plugin pieces with no imports, so packages emitted by plain tsc can ship them alone: an overlay pass
// descriptor, the straight-alpha blend state, the mesh-attach check and a WebGPU-only frame-graph pass.

/**
 * A reusable pass descriptor that draws over the frame: colour loaded and stored, depth read only, or loaded and stored
 * with `depthWrites`, stencil read only. Set `colorAttachments[0].view` and `depthStencilAttachment.view` per frame.
 */
export const overlayPass = (depthWrites = false) => ({
  colorAttachments: [{ view: undefined, loadOp: 'load', storeOp: 'store' }],
  depthStencilAttachment: depthWrites
    ? { view: undefined, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true }
    : { view: undefined, depthReadOnly: true, stencilReadOnly: true },
});

/** Straight (non-premultiplied) alpha blending: colour by source alpha, alpha accumulating coverage. */
export const alphaBlend = Object.freeze({
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
});

/** `mesh` when it is null or a core mesh handle (checked live), for overlays that follow a mesh; else a TypeError. */
export function attachableMesh(mesh) {
  if (mesh !== null && (typeof mesh !== 'object' || typeof mesh.check !== 'function'))
    throw new TypeError('Expected a Margo Engine mesh');
  mesh?.check();
  return mesh;
}

/** A frame-graph pass `name` at `order` that runs `run(context)` on WebGPU frames only. */
export const webgpuPass = (name, order, run) => ({
  name,
  order,
  execute: (context) => {
    if (context.backend === 'webgpu') run(context);
  },
});

/** The WGSL `make(group)` builds for bind group `group`, made once per group and kept in `cache`. */
export function groupCode(cache, group, make) {
  let code = cache.get(group);
  if (code === undefined) cache.set(group, (code = make(group)));
  return code;
}
