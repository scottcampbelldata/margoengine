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
  const at = (layer, x, y) => [
    ...out.subarray(((layer * height + y) * width + x) * 4, ((layer * height + y) * width + x) * 4 + 4),
  ];
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
// Gauss-Jordan inverse of a column-major 4 x 4 matrix (test-only reference, independent of the package's invert).
export function invert(m, out) {
  const a = [];
  for (let r = 0; r < 4; r++) a.push([m[r], m[4 + r], m[8 + r], m[12 + r], ...[0, 1, 2, 3].map((c) => +(c === r))]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 8; k++) a[c][k] /= d;
    for (let r = 0; r < 4; r++)
      if (r !== c) {
        const f = a[r][c];
        for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k];
      }
  }
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r][4 + c];
  return out;
}
// World direction of the view ray through pixel (x, y) of a width x height target.
export function directionAt(camera, x, y, width, height) {
  const inverse = invert(camera.matrix, new Float64Array(16));
  const ndc = [((x + 0.5) / width) * 2 - 1, 1 - ((y + 0.5) / height) * 2, 0.5, 1],
    w = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) w[r] += inverse[c * 4 + r] * ndc[c];
  const p = [w[0] / w[3] - camera.position[0], w[1] / w[3] - camera.position[1], w[2] / w[3] - camera.position[2]],
    l = Math.hypot(...p);
  return p.map((v) => v / l);
}
// Records a background (anything with `record(context)`) into a size x size target cleared to (0.25, 0, 0.25, 1) with
// depth cleared to `depthClear`; returns `pixel(x, y)` as floats (rgba16float) or bytes (8-bit formats).
export async function renderBackground(device, background, { size, camera, format = 'rgba16float', depthClear = 0 }) {
  const color = device.createTexture({
    size: [size, size],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = device.createTexture({
    size: [size, size],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const encoder = device.createCommandEncoder(),
    colorView = color.createView(),
    depthView = depth.createView();
  encoder
    .beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0.25, 0, 0.25, 1] }],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: depthClear,
      },
    })
    .end();
  background.record({
    backend: 'webgpu',
    device,
    encoder,
    color: colorView,
    depth: depthView,
    format,
    camera,
    width: size,
    height: size,
    descriptor: { depthStencil: { format: 'depth32float' } },
  });
  const bpp = format === 'rgba16float' ? 8 : 4,
    row = align(size * bpp),
    buffer = device.createBuffer({ size: row * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture: color }, { buffer, bytesPerRow: row }, [size, size]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  color.destroy();
  depth.destroy();
  return (x, y) =>
    bpp === 8
      ? [...new Uint16Array(bytes.buffer, y * row + x * 8, 4)].map(halfToFloat)
      : [...bytes.subarray(y * row + x * 4, y * row + x * 4 + 4)];
}
