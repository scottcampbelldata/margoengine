// Shared readback helpers for the environment entry browser checks.
import { halfToFloat } from '../dist/index.js';

export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const align = (n) => Math.ceil(n / 256) * 256;

// Same conventions as the shaders: equirect center faces -Z, row 0 is +Y; cube faces in WebGPU layer order.
export function equirectDirection(u, v) {
  const phi = 2 * Math.PI * (u - 0.5),
    theta = Math.PI * v;
  return [Math.sin(theta) * Math.sin(phi), Math.cos(theta), -Math.sin(theta) * Math.cos(phi)];
}
export function faceDirection(face, u, v) {
  const d = [
      [1, -v, -u],
      [-1, -v, u],
      [u, 1, v],
      [u, -1, -v],
      [u, -v, 1],
      [-u, -v, -1],
    ][face],
    l = Math.hypot(...d);
  return d.map((x) => x / l);
}
// Inverse of faceDirection: the face and texel holding direction d on a cube of `size` texels.
export function cubeTexel(d, size) {
  const [x, y, z] = d,
    ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z);
  let face, u, v;
  if (ax >= ay && ax >= az) [face, u, v] = x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
  else if (ay >= az) [face, u, v] = y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
  else [face, u, v] = z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
  const tx = Math.min(size - 1, Math.floor(((u + 1) / 2) * size)),
    ty = Math.min(size - 1, Math.floor(((v + 1) / 2) * size));
  return [face, tx, ty];
}
export function equirect(width, height, radiance) {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set([...radiance(equirectDirection((x + 0.5) / width, (y + 0.5) / height)), 1], (y * width + x) * 4);
  return { width, height, data };
}
export const rotateY = (d, angle) => {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]];
};
export async function readBuffer(device, source, size) {
  const buffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, buffer, 0, size);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return out;
}
// An rgba16float texture mip as floats: `at(layer, x, y)` is [r, g, b, a].
export async function readTexture(device, texture, mip = 0) {
  const width = Math.max(1, texture.width >> mip),
    height = Math.max(1, texture.height >> mip),
    layers = texture.depthOrArrayLayers,
    row = align(width * 8);
  const buffer = device.createBuffer({
    size: row * height * layers,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, mipLevel: mip }, { buffer, bytesPerRow: row, rowsPerImage: height }, [
    width,
    height,
    layers,
  ]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bits = new Uint16Array(buffer.getMappedRange().slice(0)),
    out = new Float32Array(width * height * layers * 4);
  buffer.unmap();
  buffer.destroy();
  for (let l = 0; l < layers; l++)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width * 4; x++)
        out[(l * height + y) * width * 4 + x] = halfToFloat(bits[((l * height + y) * row) / 2 + x]);
  const at = (layer, x, y) => [...out.subarray(((layer * height + y) * width + x) * 4, ((layer * height + y) * width + x) * 4 + 4)];
  return { width, height, layers, data: out, at };
}
// Opens a device that records validation and uncaptured errors; `finish()` asserts there were none.
export async function openDevice() {
  const adapter = await navigator.gpu?.requestAdapter();
  assert(adapter, 'WebGPU adapter unavailable');
  const device = await adapter.requestDevice(),
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const finish = async () => {
    await device.queue.onSubmittedWorkDone();
    const validation = await device.popErrorScope();
    assert(!validation && !errors.length, `validation: ${validation?.message ?? errors.join('; ')}`);
  };
  return { adapter, device, finish };
}
export const hardware = (adapter) => ({
  vendor: adapter.info?.vendor,
  architecture: adapter.info?.architecture,
  fallback: adapter.info?.isFallbackAdapter,
});
