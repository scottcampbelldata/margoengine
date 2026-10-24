// Depth-only caster drawing shared by @margoengine/shadows (cascades), @margoengine/clustered (local and clustered
// shadow maps), @margoengine/staging (contact shadows) and @margoengine/selection (picking): the vertex layout of core
// (24-byte) and gltf-pro (80-byte) geometry, the displacement bind group, the per-draw uniform and the draw itself.
import { instanceLayout } from './instances.js';

/**
 * Vertex buffers of a caster with `stride` 24 (core: position) or 80 (gltf-pro: position, uv for `displaced`,
 * skin joints and weights), plus the per-instance matrices when `instanced`.
 */
export function casterBuffers(stride, displaced = false, instanced = false) {
  return [
    {
      arrayStride: stride,
      attributes:
        stride === 80
          ? [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              ...(displaced ? [{ shaderLocation: 1, offset: 16, format: 'float32x4' }] : []),
              { shaderLocation: 3, offset: 48, format: 'float32x4' },
              { shaderLocation: 4, offset: 64, format: 'float32x4' },
            ]
          : [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    },
    ...(instanced ? [instanceLayout] : []),
  ];
}

/** The bind group of a displaced caster (shared/displacement.js): its feature uniform, map and sampler; else undefined. */
export const displacementGroup = (device, layout, displacement) =>
  displacement
    ? device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: displacement.buffer } },
          { binding: 1, resource: displacement.view },
          { binding: 2, resource: displacement.sampler },
        ],
      })
    : undefined;

/** A cleared depth-only pass descriptor; set `depthStencilAttachment.view` before each use. */
export const depthPassDescriptor = () => ({
  colorAttachments: [],
  depthStencilAttachment: { view: undefined, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
});

/**
 * Writes one caster draw's uniform (`values`: 36 floats, 44 with an alpha `transform`): the light's `view` matrix, the
 * node matrix, alpha, cutoff and texture coordinate set, then uploads it to `uniform` and draws primitive `p`.
 */
export function drawCaster(pass, device, pipeline, group, uniform, values, view, p, transform, displaced, instances) {
  values.set(view);
  values.set(p.node.matrix, 16);
  values[32] = p.alpha ?? 1;
  values[33] = p.cutoff ?? 0;
  values[34] = p.texCoord ?? 0;
  if (transform) values.set(transform, 36);
  device.queue.writeBuffer(uniform, 0, values);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  if (displaced) pass.setBindGroup(1, displaced);
  pass.setVertexBuffer(0, p.vertex);
  pass.setIndexBuffer(p.index, 'uint32');
  if (instances) {
    pass.setVertexBuffer(1, instances.upload(device));
    pass.drawIndexed(p.count, instances.count);
  } else pass.drawIndexed(p.count);
}
