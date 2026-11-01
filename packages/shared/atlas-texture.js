// Makes the texture of a 2D atlas: straight-alpha RGBA8 pixels or an ImageBitmap go up to an rgba8unorm texture the caller
// owns and can make again; a GPUTexture or a function returning one stays outside the caller's care.
export function atlasTexture(device, atlas, invalid) {
  if (typeof atlas === 'function') return { texture: atlas(device), owned: false };
  if ('createView' in atlas) return { texture: atlas, owned: false };
  const { width, height } = atlas,
    pixels = 'data' in atlas ? atlas : undefined;
  if (pixels && (!(width > 0) || !(height > 0) || pixels.data.length !== width * height * 4)) throw invalid();
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  if (pixels) device.queue.writeTexture({ texture }, pixels.data, { bytesPerRow: width * 4 }, [width, height]);
  else device.queue.copyExternalImageToTexture({ source: atlas }, { texture }, [width, height]);
  return { texture, owned: true };
}
