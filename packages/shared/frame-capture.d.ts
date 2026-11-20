/**
 * Core's lit shader `shader`, with every surface patch kept, rebound to a Frame at `binding` of group 0 and ending in
 * `tail` (a WGSL statement in the fragment's `i`, `frame` and `linear`).
 * @throws MargoError `unsupported` when core's shader was replaced (no Frame at binding 0 or no tone-mapped return).
 */
export function frameCapture(shader: string, binding: number, tail: string, feature: string): string;
/**
 * The render pipeline that draws a capture: WGSL `code` (from {@link frameCapture}) with core's vertex `buffers`, one
 * `rgba16float` target, depth in `depthFormat` (reversed Z, as core draws), no culling (a capture sees back faces).
 */
export function capturePipeline(
  device: GPUDevice,
  code: string,
  buffers: Iterable<GPUVertexBufferLayout | null> | undefined,
  depthFormat: GPUTextureFormat,
): GPURenderPipeline;
