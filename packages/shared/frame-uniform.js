/** Allocates a frame uniform buffer and its single-binding group. The caller owns the buffer. */
export function createFrameUniform(device, layout, size, usage) {
  const buffer = device.createBuffer({ size, usage });
  try {
    return [buffer, device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] })];
  } catch (error) {
    buffer.destroy();
    throw error;
  }
}
