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

/** Straight alpha blending that leaves the target's alpha channel unchanged: precipitation and other overlays drawn into a frame. */
export const overlayBlend = /* @__PURE__ */ Object.freeze({
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
});

/** `mesh` when it is null or a core mesh handle (checked live), for overlays that follow a mesh; else a TypeError. */
export function attachableMesh(mesh) {
  if (mesh !== null && (typeof mesh !== 'object' || typeof mesh.check !== 'function'))
    throw new TypeError('Expected a Margo Engine mesh');
  mesh?.check();
  return mesh;
}

/** The fragment entry `transparent` of an effect under a transparency hook: `inputs` are its parameters, the rest WGSL expressions. */
export function surfaceEntry(declarations, inputs, color, clip, depth) {
  const coverage = declarations.includes('var<private> margoCoverage:u32');
  return `\n@fragment fn transparent(${inputs}${coverage ? ',@builtin(sample_mask) margoMask:u32' : ''})->MargoTransparent {${coverage ? 'margoCoverage=margoMask;' : ''}return margoTransparentAt(${color},${clip},${depth});}\n`;
}

/** Holds an effect's transparency hook: `set` takes it and `released`, and returns the remover. */
export function transparencySlot() {
  return {
    hook: undefined,
    released: undefined,
    set(hook, released) {
      this.hook = hook;
      this.released = released;
      return () => {
        if (this.hook === hook) this.hook = this.released = undefined;
      };
    },
  };
}

/** `hook`'s pass with `pipeline` set, `group` at group 0 and the hook's bindings at group 1, for an effect with an auto layout. */
export function surfacePass(device, hook, pipeline, group) {
  const pass = hook.begin();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.setBindGroup(1, device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: hook.bindings() }));
  return pass;
}

/** The WGSL `make(group)` builds for bind group `group`, made once per group and kept in `cache`. */
export function groupCode(cache, group, make) {
  let code = cache.get(group);
  if (code === undefined) cache.set(group, (code = make(group)));
  return code;
}
