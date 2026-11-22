/** Allocates a frame uniform buffer and its single-binding group. The caller owns the buffer. */
export function createFrameUniform(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  size: number,
  usage: GPUBufferUsageFlags,
): [GPUBuffer, GPUBindGroup];
