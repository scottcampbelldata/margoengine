/** Fills mip levels 1 to `levels - 1` (default all) of `texture` from level 0; array and cube layers each get a chain. */
export function generateMipmaps(device: GPUDevice, texture: GPUTexture, levels?: number, sampler?: GPUSampler): void;
