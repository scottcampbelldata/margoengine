const empty = new WeakMap<GPUDevice, GPUBindGroup>();

/**
 * Bind group `index` of an auto-layout pipeline. With no entries it is one empty group of an explicit layout: WebKit gives
 * an invalid layout for a group past the last one the shader uses, which a material without textures reaches, and the
 * draw then fails. Every browser accepts the explicit empty group at any index.
 */
export function pipelineGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  index: number,
  entries: GPUBindGroupEntry[],
): GPUBindGroup {
  if (entries.length) return device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries });
  let group = empty.get(device);
  if (!group) {
    group = device.createBindGroup({ layout: device.createBindGroupLayout({ entries: [] }), entries: [] });
    empty.set(device, group);
  }
  return group;
}
