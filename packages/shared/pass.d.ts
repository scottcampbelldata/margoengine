/** A reusable pass descriptor drawing over the frame: colour load/store, depth and stencil read only. */
export function overlayPass(): GPURenderPassDescriptor & {
  colorAttachments: [GPURenderPassColorAttachment];
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
/** {@link overlayPass} that also loads and stores depth. */
export function overlayDepthPass(): GPURenderPassDescriptor & {
  colorAttachments: [GPURenderPassColorAttachment];
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
/** Straight (non-premultiplied) alpha blending. */
export const alphaBlend: GPUBlendState;
/** `mesh` when it is null or a core mesh handle (checked live); else a TypeError. */
export function attachableMesh<M extends { check(): void } | null>(mesh: M): M;
/** The WGSL `make(group)` builds for bind group `group`, made once per group and kept in `cache`. */
export function groupCode(cache: Map<number, string>, group: number, make: (group: number) => string): string;
