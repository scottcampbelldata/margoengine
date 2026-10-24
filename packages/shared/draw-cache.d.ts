/** Core mesh vertex buffers: interleaved position and normal, then 96-byte instance records. */
export const coreMeshBuffers: GPUVertexBufferLayout[];
/** Bind group 0 of `pipeline` (`first`, then `bindings`), cached per pipeline until a binding changes. */
export function cachedBindGroup(
  cache: WeakMap<GPURenderPipeline, { bindings: GPUBindGroupEntry[]; group: GPUBindGroup }>,
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  first: GPUBindGroupEntry,
  bindings: GPUBindGroupEntry[],
): GPUBindGroup;
