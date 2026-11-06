/** Opaque white of `dimension` until a texture source has pixels (an unloaded image, video or cube face). */
export function whiteTexture(device: GPUDevice, dimension?: GPUTextureViewDimension): [GPUTextureView, GPUSampler];
