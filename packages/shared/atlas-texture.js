import { lend } from './borrowed.js';
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

// An atlas held in a borrow slot (shared/borrowed.js): pixels and bitmaps are uploaded as above; a caller's texture or
// function goes through `lend`, so after a device restore a plain texture gives undefined (reported once) and a
// function makes the texture for the new device.
export function borrowedAtlas(slot, device, engine, invalid) {
  const atlas = slot.value;
  if (typeof atlas !== 'function' && !('createView' in atlas)) return atlasTexture(device, atlas, invalid);
  const texture = lend(slot, device, engine);
  return texture && { texture, owned: false };
}
