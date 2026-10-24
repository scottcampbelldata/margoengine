// Small render-plugin pieces with no imports, so packages emitted by plain tsc can ship them alone: an overlay pass
// descriptor, the straight-alpha blend state, the mesh-attach check and a per-group WGSL memo.

/** A reusable pass descriptor that draws over the frame: colour loaded and stored, depth and stencil read only. Set
 * `colorAttachments[0].view` and `depthStencilAttachment.view` per frame. */
export const overlayPass = () => ({
  colorAttachments: [{ view: undefined, loadOp: 'load', storeOp: 'store' }],
  depthStencilAttachment: { view: undefined, depthReadOnly: true, stencilReadOnly: true },
});

/** {@link overlayPass} that also writes depth (loaded and stored), stencil read only. */
export const overlayDepthPass = () => ({
  colorAttachments: [{ view: undefined, loadOp: 'load', storeOp: 'store' }],
  depthStencilAttachment: { view: undefined, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
});

/** Straight (non-premultiplied) alpha blending: colour by source alpha, alpha accumulating coverage. */
export const alphaBlend = /* @__PURE__ */ Object.freeze({
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

/** The WGSL `make(group)` builds for bind group `group`, made once per group and kept in `cache`. */
export function groupCode(cache, group, make) {
  let code = cache.get(group);
  if (code === undefined) cache.set(group, (code = make(group)));
  return code;
}
