// The node adapter's fake GPU has no pipeline layouts, texture writes or texture limits; fill them in on every device the
// layer sees (first setup and each restore).
const fillGaps = (Plugin) => {
  for (const hook of ['setup', 'onDeviceRestored']) {
    const original = Plugin.prototype[hook];
    if (!original) continue;
    Plugin.prototype[hook] = function (engine, ...rest) {
      globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
      globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
      if (engine.gpu) {
        engine.gpu.createPipelineLayout ??= () => ({});
        engine.gpu.queue.writeTexture ??= () => {};
        engine.gpu.limits.maxTextureDimension2D ??= 8192;
      }
      return original.call(this, engine, ...rest);
    };
  }
};
const bitmap = { cluster: 'A', width: 8, height: 12, left: 0, top: 10, color: false, data: new Uint8Array(96).fill(255) };
// A stand-in font: the node adapter has no rasterizer.
const font = { size: 16, radius: 8, cutoff: 0.25, revision: 0, load: async () => {}, advance: () => 0.5, kerning: () => 0,
  metrics: () => ({ ascent: 0.8, descent: 0.2 }), glyph: () => bitmap };

export async function fixtures(load = (entry) => import(entry)) {
  const { GPULabelLayer } = await load('../dist/gpu.js');
  fillGaps(GPULabelLayer);
  const labels = [{ text: 'A', position: [0, 0, 0.5] }, { text: 'A', position: [0.5, 0.5, 0.5] }];
  return [
    { name: 'GPULabelLayer', async create({ engine }) {
      const plugin = await GPULabelLayer.create({ font, declutter: false });
      plugin.setLabels(labels);
      return { plugin, dispose: () => plugin.dispose() };
    } },
    { name: 'GPULabelLayer.attach', async create({ engine }) {
      const plugin = await GPULabelLayer.attach(engine, { font, declutter: false });
      plugin.setLabels(labels);
      return { plugin, dispose: () => plugin.dispose() };
    } },
  ];
}
