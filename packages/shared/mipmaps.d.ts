/**
 * Fills mip levels 1 to `levels - 1` of the first `layers` (default 1) layers of a texture from level 0, with one
 * pipeline per format kept in `cache` and `sampler` (default: a linear one kept as `cache.sampler`).
 */
export function generateMipmaps(
  device: GPUDevice,
  texture: GPUTexture,
  levels: number,
  cache: Map<unknown, unknown> & { sampler?: GPUSampler },
  sampler?: GPUSampler,
  layers?: number,
): void;
