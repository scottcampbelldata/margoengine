import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { AnisotropicPainterly } = await import('/packages/creative/dist/paint-aniso.js');
    const { anisoReference } = await import('/packages/creative/tests/paint-aniso-reference.js');
    const { reference } = await import('/packages/creative/tests/paint-reference.js');
    let device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const errors = [];
    const watch = () => device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    watch();
    const check = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    let comparisons = 0,
      worst = 0;
    const fixture = (w, h, flat = false) =>
      Uint8Array.from({ length: w * h * 4 }, (_, i) =>
        flat ? [64, 128, 192, 173][i % 4] : (Math.imul(i, 37) + (i >> 3) * 53) % 256,
      );
    const make = (options) => {
      const effect = new AnisotropicPainterly(options),
        stage = effect.joinStack();
      effect.setup({ gpu: device, sceneOf: () => undefined });
      return { effect, stage };
    };
    const run = async (w, h, options = {}, settings = {}) => {
      const data = settings.data ?? fixture(w, h, settings.flat),
        format = settings.format ?? 'rgba8unorm',
        samples = settings.samples ?? 1;
      const input = device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: input }, data, { bytesPerRow: w * 4 }, [w, h]);
      const output = device.createTexture({
          size: [w, h],
          format,
          sampleCount: samples,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.COPY_SRC : 0),
        }),
        resolved =
          samples === 1
            ? output
            : device.createTexture({
                size: [w, h],
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
              });
      const row = Math.ceil((w * 4) / 256) * 256,
        buffer = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      const owned = !settings.pair,
        pair = settings.pair ?? make(options),
        rects = settings.views ?? [[0, 0, w, h]],
        view = input.createView(),
        out = output.createView();
      device.pushErrorScope('validation');
      for (let index = 0; index < rects.length; index++)
        pair.stage.render(
          {
            backend: 'webgpu',
            device,
            encoder,
            width: w,
            height: h,
            ...(settings.views ? { view: { id: index, index, viewport: rects[index] } } : {}),
          },
          view,
          { view: out, format, multisample: { count: samples }, hdr: false },
        );
      if (samples > 1)
        encoder
          .beginRenderPass({
            colorAttachments: [{ view: out, resolveTarget: resolved.createView(), loadOp: 'load', storeOp: 'store' }],
          })
          .end();
      encoder.copyTextureToBuffer({ texture: resolved }, { buffer, bytesPerRow: row }, [w, h]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(buffer.getMappedRange()),
        actual = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) actual.set(raw.subarray(y * row, y * row + w * 4), y * w * 4);
      if (format === 'bgra8unorm')
        for (let i = 0; i < actual.length; i += 4) [actual[i], actual[i + 2]] = [actual[i + 2], actual[i]];
      for (const rect of rects) {
        const expected = anisoReference(data, w, h, options, rect);
        for (let y = rect[1]; y < rect[1] + rect[3]; y++)
          for (let x = rect[0]; x < rect[0] + rect[2]; x++)
            for (let c = 0; c < 4; c++) {
              const i = (y * w + x) * 4 + c,
                delta = Math.abs(actual[i] - expected[i]);
              worst = Math.max(worst, delta);
              check(
                delta <= (c === 3 || options.strength === 0 || options.enabled === false ? 0 : 1),
                `aniso ${JSON.stringify(options)} ${w}x${h} pixel ${x},${y},${c}: ${actual[i]} != ${expected[i]}`,
              );
              comparisons++;
            }
      }
      buffer.unmap();
      buffer.destroy();
      input.destroy();
      output.destroy();
      if (resolved !== output) resolved.destroy();
      if (owned) pair.effect.dispose();
      const error = await device.popErrorScope();
      check(!error, error?.message);
      return { actual, data };
    };
    try {
      for (const radius of [1, 3, 8]) await run(13, 11, { radius });
      for (const options of [
        { strength: 0 },
        { enabled: false },
        { strength: 0.35 },
        { anisotropy: 0 },
        { sharpness: 1 },
      ])
        await run(13, 11, options);
      await run(13, 11, {}, { flat: true });
      await run(1, 1, { radius: 8 });
      await run(2, 3, { radius: 8 });
      await run(
        13,
        11,
        {},
        {
          views: [
            [0, 0, 6, 11],
            [6, 0, 7, 11],
          ],
        },
      );
      await run(13, 11, {}, { format: 'bgra8unorm', samples: 4 });
      const a = await run(13, 11),
        classic = reference(a.data, 13, 11, { mode: 'kuwahara', radius: 3 });
      check(
        a.actual.some((v, i) => Math.abs(v - classic[i]) > 5),
        'tensor filter differs from square quadrants',
      );
      const pair = make({ radius: 3 }),
        before = await run(9, 7, { radius: 3 }, { pair });
      const old = device;
      device = await (await navigator.gpu.requestAdapter()).requestDevice();
      watch();
      pair.effect.onDeviceRestored({ gpu: device, sceneOf: () => undefined });
      old.destroy();
      const after = await run(9, 7, { radius: 3 }, { pair });
      check(
        before.actual.every((v, i) => v === after.actual[i]),
        'replacement-device equality',
      );
      pair.effect.dispose();
      check(!errors.length, errors.join('\n'));
      return { comparisons, worst, errors };
    } finally {
      device.destroy();
    }
  });
  assert.ok(result.comparisons > 1000);
  assert.equal(result.errors.length, 0);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
