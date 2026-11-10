import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { BlendLayer } from '/packages/sprites/dist/blend.js';
const canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [16, 16] }),
  engine = engineRuntime(instance),
  device = engine.gpu,
  errors = [];
device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const read = async (texture) => {
  const buffer = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [4, 4]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const p = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
  buffer.unmap();
  buffer.destroy();
  return p;
};
const composite = (src, back, mode) => {
  const a = src[3],
    b = back[3],
    p = src.slice(0, 3).map((c) => c * a);
  const rgb = p.map((c, k) =>
    mode === 'add'
      ? c + back[k]
      : mode === 'screen'
        ? c + back[k] * (1 - c)
        : mode === 'multiply'
          ? c * (1 - b) + back[k] * (1 - a) + c * back[k]
          : c + back[k] * (1 - a),
  );
  return [...rgb.map((c) => Math.min(1, c)), Math.min(1, mode === 'add' ? a + b : a + b * (1 - a))];
};
const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const stored = (color, srgb) => color.map((v, k) => Math.round((srgb && k < 3 ? encode(v) : v) * 255));
window.check = async () => {
  device.pushErrorScope('validation');
  let cases = 0,
    maximumError = 0;
  for (const format of ['rgba8unorm', 'rgba8unorm-srgb'])
    for (const filter of ['nearest', 'linear'])
      for (const mode of ['normal', 'add', 'multiply', 'screen'])
        for (const background of [
          [0, 0, 0, 0],
          [0.1, 0.2, 0.3, 0.5],
          [0.1, 0.2, 0.3, 1],
        ])
          for (const alpha of [0, 128, 255]) {
            const target = device.createTexture({
              size: [4, 4],
              format,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            });
            const layer = BlendLayer.attach(instance, {
              atlas: { width: 1, height: 1, data: new Uint8Array([160, 80, 200, alpha]) },
              filter,
              target,
              clear: background,
            });
            layer.addBlend({ scaleX: 4, scaleY: 4, alpha: 0.5, blendMode: mode });
            instance.render({ delta: 0 });
            const actual = await read(target),
              srgb = format.endsWith('-srgb'),
              back = stored(background, srgb).map((c, k) => (srgb && k < 3 ? decode(c / 255) : c / 255)),
              src = [160 / 255, 80 / 255, 200 / 255, (alpha / 255) * (128 / 255)],
              blendSource = src.map((c, k) => (srgb && filter === 'linear' && k < 3 ? decode(c) : c)),
              expected = stored(composite(blendSource, back, mode), srgb);
            for (let k = 0; k < 4; k++) maximumError = Math.max(maximumError, Math.abs(actual[k] - expected[k]));
            if (actual.some((c, k) => Math.abs(c - expected[k]) > 1))
              throw new Error(`${format} ${filter} ${mode} alpha=${alpha} bg=${background}: ${actual} != ${expected}`);
            cases++;
            layer.dispose();
            target.destroy();
          }
  // Every operator occurs after a nonzero firstInstance. Adjacent equal runs,
  // nonadjacent repeats and overlapping multiply passes must preserve order.
  for (const filter of ['nearest', 'linear']) {
    const target = device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const layer = BlendLayer.attach(instance, {
      atlas: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
      filter,
      target,
    });
    const modes = ['normal', 'screen', 'screen', 'multiply', 'multiply', 'normal', 'add'];
    const colors = [0x8050c0, 0x40a080, 0x604020, 0xa060b0, 0x6080a0, 0x204060, 0x402010];
    let expected = [0, 0, 0, 0];
    for (let i = 0; i < modes.length; i++) {
      layer.addBlend({ scaleX: 4, scaleY: 4, tint: colors[i], alpha: 0.5, blendMode: modes[i] });
      const src = [(colors[i] >> 16) / 255, ((colors[i] >> 8) & 255) / 255, (colors[i] & 255) / 255, 128 / 255];
      // Quantize the independent reference after each logical sprite, as an
      // RGBA8 render target does. Multiply's extra rounding is checked below.
      expected = composite(src, expected, modes[i]).map((c) => Math.round(c * 255) / 255);
    }
    layer.addBlend({ visible: false, blendMode: 'add' });
    instance.render({ delta: 0 });
    const actual = await read(target),
      bytes = expected.map((c) => Math.round(c * 255));
    for (let k = 0; k < 4; k++) maximumError = Math.max(maximumError, Math.abs(actual[k] - bytes[k]));
    if (actual.some((c, k) => Math.abs(c - bytes[k]) > 1))
      throw new Error(`${filter} mixed overlap: ${actual} != ${bytes}`);
    cases++;
    layer.dispose();
    target.destroy();
  }
  const validation = await device.popErrorScope();
  instance.dispose();
  return { cases, maximumError, validation: validation?.message ?? null, errors };
};
window.ready = true;
