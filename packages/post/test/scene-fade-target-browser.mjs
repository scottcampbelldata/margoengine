// Real-GPU check of KB-FADE-TARGETVIEW1, built packages, on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/scene-fade-target-browser.mjs
// SceneFade fades the canvas only. A view with a `target` texture (1 sample, its own format and size) drawn in the same
// frame keeps the pixels it has without a fade, before or after the canvas view, or alone, and raises no GPU error.
// Before the fix its pass ran there too, with the canvas pipeline: WebGPU refused the whole command buffer.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-scene-fade-target',
  5462,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { SceneFade } = await import('/packages/post/dist/scene-fade.js');
      window.t = {
        // One frame of `order` ('canvas' and 'target' views) after the box moved from the left to the right; with
        // `fade` it is half way through the fade from the captured left frame.
        async draw(order, format, fade) {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
          engine.stop();
          const device = engine.gpu;
          let now = 0;
          const effect = fade ? SceneFade.attach(engine, 1000, () => now) : undefined;
          const mesh = engine
            .createMesh()
            .setGeometry(box(1, 1, 1))
            .setMaterial(new PbrMaterial({ color: '#e0a050', roughness: 1 }))
            .setPosition([-0.7, 0, 0]);
          engine.render({ delta: 1 / 60 });
          if (effect) {
            effect.capture();
            await effect.warm();
            effect.start();
            now = 500;
          }
          mesh.setPosition([0.7, 0, 0]);
          const color = device.createTexture({
              size: [64, 32],
              format,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            }),
            view = { camera: engine.camera, viewport: [0, 0, 1, 1] };
          device.pushErrorScope('validation');
          engine.render({
            delta: 1 / 60,
            views: order.map((id) => (id === 'target' ? { ...view, id, target: { color } } : { ...view, id })),
          });
          const bytes = format === 'rgba16float' ? 8 : 4,
            row = Math.ceil((64 * bytes) / 256) * 256,
            buffer = device.createBuffer({
              size: row * 32,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }),
            encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture: color }, { buffer, bytesPerRow: row }, [64, 32]);
          device.queue.submit([encoder.finish()]);
          const error = await device.popErrorScope();
          await buffer.mapAsync(GPUMapMode.READ);
          const target = [...new Uint8Array(buffer.getMappedRange())];
          await device.queue.onSubmittedWorkDone();
          this.engine = engine;
          return { target, error: error?.message ?? null };
        },
        dispose() {
          this.engine.dispose();
        },
      };
    });
    const run = async (order, format, fade) => {
      const drawn = await page.evaluate((a) => window.t.draw(...a), [order, format, fade]);
      const canvas = order.includes('canvas') ? (await shot()).data : undefined;
      await page.evaluate(() => window.t.dispose());
      return { ...drawn, canvas };
    };
    const preferred = await page.evaluate(() => navigator.gpu.getPreferredCanvasFormat());
    const wrong = [];
    for (const format of [preferred, 'rgba16float'])
      for (const order of [['canvas', 'target'], ['target', 'canvas'], ['target']]) {
        const label = `${format}, views ${order.join(' then ')}`,
          plain = await run(order, format, false),
          faded = await run(order, format, true);
        assert.equal(plain.error, null, `${label}: the frame without a fade`);
        assert.ok(plain.target.some(Boolean), `${label}: the target view drew`);
        const changed = faded.target.filter((v, i) => v !== plain.target[i]).length;
        // The canvas still fades: the captured box shows on the left.
        const fadedPixels = plain.canvas?.filter((v, i) => Math.abs(v - faded.canvas[i]) > 20).length;
        const ok = faded.error === null && changed === 0 && (fadedPixels === undefined || fadedPixels > 2000);
        console.log(
          `${ok ? 'ok' : 'WRONG'} ${label}: ${changed} target bytes changed, ${fadedPixels ?? 'no'} faded canvas ` +
            `bytes, error ${faded.error}`,
        );
        if (!ok) wrong.push(label);
      }
    assert.deepEqual(wrong, []);
    console.log(`ok SceneFade leaves target views alone on ${compatRun() ? 'the WebGL2 layer' : 'WebGPU'}`);
  },
  { seconds: 180 },
);
