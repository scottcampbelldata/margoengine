const whites = new WeakMap();
/** Opaque white of `dimension` until a texture source has pixels (an unloaded image, video or cube face). */
export function whiteTexture(device, dimension = '2d') {
  let cache = whites.get(device);
  if (!cache) whites.set(device, (cache = new Map()));
  let white = cache.get(dimension);
  if (!white) {
    const layers = dimension === 'cube' ? 6 : 1,
      texture = device.createTexture({
        size: [1, 1, layers],
        dimension: dimension === '3d' ? '3d' : '2d',
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    device.queue.writeTexture({ texture }, new Uint8Array(4 * layers).fill(255), { bytesPerRow: 4, rowsPerImage: 1 }, [
      1,
      1,
      layers,
    ]);
    cache.set(dimension, (white = [texture.createView({ dimension }), device.createSampler()]));
  }
  return white;
}
