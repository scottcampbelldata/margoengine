/** Vertex buffers of a 24-byte (core) or 80-byte (gltf-pro) caster, plus instance matrices when `instanced`. */
export function casterBuffers(stride: number, displaced?: boolean, instanced?: boolean): GPUVertexBufferLayout[];
/** The bind group of a displaced caster: its feature uniform, map and sampler; else undefined. */
export function displacementGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  displacement: { buffer: GPUBuffer; view: GPUTextureView; sampler: GPUSampler } | undefined,
): GPUBindGroup | undefined;
/** A cleared depth-only pass descriptor; set `depthStencilAttachment.view` before each use. */
export function depthPassDescriptor(): GPURenderPassDescriptor & {
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
/** Writes one caster's uniform (view, node matrix, alpha, cutoff, uv set, alpha transform), uploads it and draws. */
export function drawCaster(
  pass: GPURenderPassEncoder,
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  group: GPUBindGroup,
  uniform: GPUBuffer,
  values: Float32Array<ArrayBuffer>,
  view: ArrayLike<number>,
  p: {
    node: { matrix: ArrayLike<number> };
    alpha?: number;
    cutoff?: number;
    texCoord?: number;
    vertex: GPUBuffer;
    index: GPUBuffer;
    count: number;
  },
  transform: ArrayLike<number> | undefined | null,
  displaced: GPUBindGroup | undefined,
  instances: { upload(device: GPUDevice): GPUBuffer; count: number } | undefined | null,
): void;
