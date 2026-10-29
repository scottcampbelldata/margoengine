// Pieces of core's mesh draw that plugins drawing core meshes the same way reuse: the instanced vertex layout of core
// geometry and the per-pipeline bind group cache keyed by the frame's extra bindings (core's renderer, selection's
// picking).

/** Core mesh vertex buffers: interleaved position and normal (24 bytes), then 96-byte instance records (6 vec4f). */
export const coreMeshBuffers = [
  {
    arrayStride: 24,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
    ],
  },
  {
    arrayStride: 96,
    stepMode: 'instance',
    attributes: Array.from({ length: 6 }, (_, i) => ({ shaderLocation: i + 2, offset: i * 16, format: 'float32x4' })),
  },
];

/**
 * The bind group 0 of `pipeline`: `first` (the frame uniform) then `bindings`, cached in `cache` per pipeline and made
 * again only when a binding changed (another buffer, offset or size, or another texture/sampler resource).
 */
export function cachedBindGroup(cache, device, pipeline, first, bindings) {
  let cached = cache.get(pipeline);
  if (
    !cached ||
    cached.bindings.length !== bindings.length ||
    bindings.some((entry, i) => {
      const previous = cached.bindings[i],
        resource = entry.resource,
        old = previous.resource;
      return (
        entry.binding !== previous.binding ||
        (resource.buffer
          ? resource.buffer !== old.buffer || resource.offset !== old.offset || resource.size !== old.size
          : resource !== old)
      );
    })
  ) {
    cached = {
      bindings: bindings.map(({ binding, resource }) => ({
        binding,
        resource: resource.buffer ? { ...resource } : resource,
      })),
      group: device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [first, ...bindings] }),
    };
    cache.set(pipeline, cached);
  }
  return cached.group;
}
