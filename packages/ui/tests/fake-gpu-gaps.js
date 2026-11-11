// The node adapter's fake GPU has no pipeline layouts, texture writes or texture limits; fill them in on every device a
// plugin sees (first setup and each restore), by the class so that `attach` is covered too.
export const fillGaps = (Plugin) => {
  for (const hook of ['setup', 'onDeviceRestored']) {
    const original = Plugin.prototype[hook];
    if (!original) continue;
    Plugin.prototype[hook] = function (engine, ...rest) {
      globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
      globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
      const canvas = engine.canvas, attributes = new Map();
      if (canvas && !canvas.hasAttribute) Object.assign(canvas, {
        hasAttribute: (name) => attributes.has(name),
        setAttribute: (name, value) => attributes.set(name, String(value)),
        removeAttribute: (name) => attributes.delete(name),
      });
      if (engine.gpu) {
        engine.gpu.createPipelineLayout ??= () => ({});
        engine.gpu.queue.writeTexture ??= () => {};
        engine.gpu.limits.maxTextureArrayLayers ??= 256;
        engine.gpu.limits.maxTextureDimension2D ??= 8192;
      }
      return original.call(this, engine, ...rest);
    };
  }
};
