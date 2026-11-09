import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const { page } = browser,
  errors = [],
  results = [];
const moduleURL = process.argv.find((a) => a.startsWith('--module='))?.slice(9) ?? '/packages/video/dist/index.js';
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  for (const target of ['default', 'secondary'])
    for (const mode of ['direct', 'owner']) {
      await page.evaluate(
        async ({ target, moduleURL }) => {
          const { EngineKernel } = await import('/packages/core/dist/index.js');
          const { engineRuntime } = await import('/packages/core/dist/extension.js');
          const { Video } = await import(moduleURL);
          const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
          document.body.replaceChildren();
          const canvas = document.createElement('canvas');
          document.body.append(canvas);
          const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [64, 32] });
          instance.stop();
          const engine = engineRuntime(instance),
            scene = target === 'default' ? engine.scene : engine.createScene('video-owner');
          const pixels = new OffscreenCanvas(8, 8),
            drawing = pixels.getContext('2d');
          drawing.fillStyle = '#ff0000';
          drawing.fillRect(0, 0, 8, 8);
          const frame = new VideoFrame(pixels, { timestamp: 0 });
          const video = new Video(frame);
          const view = {
            scene,
            camera: engine.camera,
            viewport: [0, 0, 32, 32],
            scissor: [0, 0, 16, 32],
            pixels: true,
          };
          // Swapchain textures do not retain a previous task's undrawn pixels.
          // Draw the neighboring background and overlay in the same frame.
          const views = [
            { scene: engine.createScene('background'), camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true },
            view,
          ];
          engine.gpu.pushErrorScope('validation');
          await waitForPipelines(async () => {
            engine.render({ views });
            await engine.gpu.queue.onSubmittedWorkDone();
          });
          engine.render();
          engine.render({ views });
          await engine.gpu.queue.onSubmittedWorkDone();
          window.videoOwner = { instance, engine, scene, frame, video, view, views };
        },
        { target, moduleURL },
      );
      const before = await decodePNG(await page.locator('canvas').screenshot());
      await page.evaluate(async () => {
        const s = window.videoOwner;
        s.scene.use(s.video);
        if (s.scene !== s.engine.scene) s.engine.use({ name: s.video.name, setup() {} });
        s.video.onDeviceRestored(s.engine);
        s.engine.render({ views: s.views });
        await s.engine.gpu.queue.onSubmittedWorkDone();
      });
      const overlay = await decodePNG(await page.locator('canvas').screenshot());
      let outside = 0,
        red = 0;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 64; x++) {
          const i = (y * 64 + x) * 4;
          if (x >= 16) for (let c = 0; c < 4; c++) outside += before.data[i + c] !== overlay.data[i + c];
          else if (overlay.data[i] > 240 && overlay.data[i + 1] < 10 && overlay.data[i + 2] < 10) red++;
        }
      assert.equal(outside, 0, 'overlay must preserve every component outside the view scissor');
      assert.equal(red, 16 * 32, 'overlay fills exactly the selected scissor');
      await page.evaluate(
        async ({ mode }) => {
          const s = window.videoOwner;
          if (mode === 'direct') s.video.dispose();
          else s.scene.removePlugin(s.video.name);
          if (s.engine.sceneOf(s.video)) throw new Error('Video registration retained after disposal');
          if (s.frame.displayWidth !== 8) throw new Error('Video closed the caller frame');
          const replacement = { name: s.video.name, setup() {} };
          s.scene.use(replacement);
          s.video.dispose();
          if (s.scene.plugins.get(s.video.name) !== replacement) throw new Error('replacement removed');
          s.engine.render({ views: s.views });
          await s.engine.gpu.queue.onSubmittedWorkDone();
          const error = await s.engine.gpu.popErrorScope();
          if (error) throw new Error(error.message);
        },
        { mode },
      );
      const after = await decodePNG(await page.locator('canvas').screenshot());
      assert.deepEqual(after.data, before.data, 'detached overlay leaves the original canvas');
      results.push({ target, mode, outside, red });
      await page.evaluate(() => {
        window.videoOwner.instance.dispose();
        window.videoOwner.frame.close();
      });
    }
  assert.deepEqual(errors, []);
  await writeFile('test-results/video-scene-owner-browser.json', JSON.stringify({ results, errors }, null, 2));
  console.log('Video scene owners and view PASS', JSON.stringify(results));
} finally {
  await browser.close();
}
