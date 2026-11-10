// Test helper for the culling pixel checks: compares two canvases' 4x multisample colour samples before the resolve.
// The resolve (the average of a pixel's four samples) rounds a .5 average differently with the draw history on the
// Radeon 680M, and core draws the same meshes in another order once a mesh is hidden (docs/work-lists/amd-gpu-hunt.md),
// so two engines with bit-identical samples can resolve 1 level apart. The samples are what the draws wrote: equal
// samples mean an equal frame on every GPU, and a culling error (a box dropped, moved or drawn twice) changes them.
// Load it before the page module (module scripts run in order): it must see the engines' textures being created.
// On the WebGL2 compatibility layer (globalThis.__margoCompat) there is no GPUDevice to hook; msaaDiff returns null.
const multisampled = (d) => d.sampleCount === 4 && !String(d.format).startsWith('depth') && !String(d.format).startsWith('stencil');
const deviceOf = new WeakMap(),
  textureOfView = new WeakMap(),
  canvasOf = new WeakMap(),
  latest = new Map();
if (globalThis.GPUDevice && !globalThis.__margoCompat) {
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (d) {
    // Readable samples: the colour attachment is also bound as a multisampled texture for the read below.
    const texture = createTexture.call(this, multisampled(d) ? { ...d, usage: d.usage | GPUTextureUsage.TEXTURE_BINDING } : d);
    if (multisampled(d)) deviceOf.set(texture, this);
    return texture;
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (...args) {
    const view = createView.apply(this, args);
    textureOfView.set(view, this);
    return view;
  };
  const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    const texture = getCurrentTexture.call(this);
    canvasOf.set(texture, this.canvas.id);
    return texture;
  };
  const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (d) {
    for (const c of d.colorAttachments ?? []) {
      if (!c?.resolveTarget) continue;
      const id = canvasOf.get(textureOfView.get(c.resolveTarget)),
        samples = textureOfView.get(c.view);
      if (id === undefined || !deviceOf.has(samples)) continue;
      // Keep the samples past the resolve (core discards them): the resolved canvas is the same either way.
      c.storeOp = 'store';
      latest.set(id, samples);
    }
    return beginRenderPass.call(this, d);
  };
}
// Every sample of the texture as 8-bit rgb packed in a u32 (the canvas format is 8-bit, so this is exact).
async function read(texture) {
  const device = deviceOf.get(texture),
    { width, height } = texture,
    n = width * height * 4;
  const module = device.createShaderModule({
    code: `
@group(0) @binding(0) var t: texture_multisampled_2d<f32>;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let size = textureDimensions(t);
  if (g.x >= size.x || g.y >= size.y) { return; }
  for (var s = 0u; s < 4u; s++) {
    let c = vec3u(round(clamp(textureLoad(t, vec2i(g.xy), s).rgb, vec3f(0.0), vec3f(1.0)) * 255.0));
    o[(g.y * size.x + g.x) * 4u + s] = c.r | (c.g << 8u) | (c.b << 16u);
  }
}`,
  });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
    out = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    back = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: out } },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
  pass.end();
  encoder.copyBufferToBuffer(out, 0, back, 0, n * 4);
  device.queue.submit([encoder.finish()]);
  await back.mapAsync(GPUMapMode.READ);
  const data = new Uint32Array(back.getMappedRange().slice(0));
  back.unmap();
  out.destroy();
  back.destroy();
  return { width, height, data };
}
/**
 * Pixels of canvas `a` whose four samples differ from canvas `b`'s, with up to six examples [x, y, samples a,
 * samples b] (each sample as [r, g, b]); null when no multisampled colour was seen for either canvas.
 */
window.msaaDiff = async (a = 'a', b = 'b') => {
  const ta = latest.get(a),
    tb = latest.get(b);
  if (!ta || !tb) return null;
  const [x, y] = [await read(ta), await read(tb)];
  if (x.width !== y.width || x.height !== y.height) throw new Error(`canvas sizes differ: ${x.width}x${x.height}, ${y.width}x${y.height}`);
  const rgb = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
  let differing = 0;
  const at = [];
  for (let p = 0; p < x.width * x.height; p++) {
    let same = true;
    for (let s = 0; s < 4; s++) if (x.data[p * 4 + s] !== y.data[p * 4 + s]) same = false;
    if (same) continue;
    differing++;
    if (at.length < 6)
      at.push([p % x.width, Math.floor(p / x.width), [...x.data.subarray(p * 4, p * 4 + 4)].map(rgb), [...y.data.subarray(p * 4, p * 4 + 4)].map(rgb)]);
  }
  return { differing, at, pixels: x.width * x.height };
};
