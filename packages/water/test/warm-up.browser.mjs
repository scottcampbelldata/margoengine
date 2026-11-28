// KB-WATER-WARMUP1 regression: Water warms with @margoengine/quality/warm without a device reboot. The surface draw
// stored its depth texture and only then made its depth copy pipeline, keyed off that texture's change; a warm-up frame
// stopped at that pipeline (warmUp stops a frame at each pipeline it compiles with the async API) left the next frame
// with a depth texture that had not changed and so no copy pipeline, and `bindDepth` threw on it. warmUp then rebooted
// the device and made every remaining pipeline synchronously, which on the WebGL2 layer left
// demos/ten-thousand-trees with a 3 to 9 s first frame. Runs on WebGPU or (MARGO_COMPAT=1) the WebGL2 layer.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
  const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
    { page } = browser,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    const result = await page.evaluate(async () => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { warmUp } = await import('/packages/quality/dist/warm.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:64px;height:32px';
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [64, 32] });
      engine.stop();
      const water = new Water({ size: [16, 16], segments: 16 });
      engine.scene.use(water);
      const report = await warmUp(engine);
      // A frame after the warm-up uses the warmed pipelines.
      engine.render({ delta: 0.125 });
      await engine.gpu.queue.onSubmittedWorkDone();
      water.dispose();
      engine.destroy?.();
      return report;
    });
    console.log(JSON.stringify(result));
    assert.equal(result.rebooted, false, 'the warm-up finished without restoring the device');
    assert.equal(result.fallbacks, 0);
    assert.ok(result.pipelines >= 2, `the surface and its depth copy were warmed (${result.pipelines})`);
    assert.deepEqual(errors, []);
    console.log('water warm-up PASS: every pipeline warmed with the async API, no reboot');
  } finally {
    await browser.close();
  }
}
