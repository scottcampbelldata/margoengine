// Test helper for the culling pixel checks with shadows: compares the two engines' shadow depth maps texel by texel.
// A caster drawn through the culling package and the same caster drawn as a core mesh must write the same depth bit for
// bit (both caster shaders declare their position @invariant): a depth one ulp apart moves the hard filter's bilinear
// comparison weight and shades a receiver one level apart, which the frame comparison sees only on a few pixels, if at
// all. Load it before the page module (module scripts run in order): it must see the maps being created. On the WebGL2
// compatibility layer (globalThis.__margoCompat) there is no GPUDevice to hook; shadowMapDiff returns null.
const maps = new Map(); // device -> live shadow maps in creation order
const devices = [];
const shadowMap = (d) =>
  d.format === 'depth32float' && (d.sampleCount ?? 1) === 1 && (d.usage & GPUTextureUsage.TEXTURE_BINDING) !== 0;
if (globalThis.GPUDevice && !globalThis.__margoCompat) {
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (d) {
    if (!shadowMap(d)) return createTexture.call(this, d);
    // Readable depth: copyTextureToBuffer needs COPY_SRC.
    const texture = createTexture.call(this, { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC });
    if (!maps.has(this)) {
      maps.set(this, []);
      devices.push(this);
    }
    maps.get(this).push(texture);
    return texture;
  };
  const destroy = GPUTexture.prototype.destroy;
  GPUTexture.prototype.destroy = function () {
    for (const list of maps.values()) {
      const k = list.indexOf(this);
      if (k >= 0) list.splice(k, 1);
    }
    return destroy.call(this);
  };
}
// Every texel of every layer of `texture` as float32.
async function read(device, texture) {
  const { width, height, depthOrArrayLayers: layers } = texture,
    bytesPerRow = Math.ceil((width * 4) / 256) * 256,
    back = device.createBuffer({
      size: bytesPerRow * height * layers,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, aspect: 'depth-only' }, { buffer: back, bytesPerRow, rowsPerImage: height }, [
    width,
    height,
    layers,
  ]);
  device.queue.submit([encoder.finish()]);
  await back.mapAsync(GPUMapMode.READ);
  const all = new Float32Array(back.getMappedRange().slice(0)),
    rowFloats = bytesPerRow / 4,
    data = new Float32Array(width * height * layers);
  for (let r = 0; r < height * layers; r++) data.set(all.subarray(r * rowFloats, r * rowFloats + width), r * width);
  back.unmap();
  back.destroy();
  return { width, height, layers, data };
}
/**
 * Texels of the first engine's newest live shadow map whose depth differs from the second engine's, with up to six
 * examples [x, y, layer, depth a, depth b] and the count of texels a caster covers (depth below 1) in each map; null
 * when fewer than two engines made a shadow map.
 */
window.shadowMapDiff = async () => {
  const live = devices.filter((d) => maps.get(d).length);
  if (live.length < 2) return null;
  const [x, y] = await Promise.all(live.slice(0, 2).map((d) => read(d, maps.get(d).at(-1))));
  if (x.width !== y.width || x.height !== y.height || x.layers !== y.layers) throw new Error('shadow map sizes differ');
  let differing = 0;
  const covered = [0, 0],
    at = [];
  for (let k = 0; k < x.data.length; k++) {
    if (x.data[k] < 1) covered[0]++;
    if (y.data[k] < 1) covered[1]++;
    if (Object.is(x.data[k], y.data[k])) continue;
    differing++;
    if (at.length < 6) {
      const texel = k % (x.width * x.height);
      at.push([
        texel % x.width,
        Math.floor(texel / x.width),
        Math.floor(k / (x.width * x.height)),
        x.data[k],
        y.data[k],
      ]);
    }
  }
  return { differing, at, texels: x.data.length, covered };
};
