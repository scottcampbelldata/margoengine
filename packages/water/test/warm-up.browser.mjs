// KB-WATER-WARMUP1 regression: Water warms with @margoengine/quality/warm without a device reboot. The surface draw
// stored its depth texture and only then made its depth copy pipeline, keyed off that texture's change; a warm-up frame
// stopped at that pipeline (warmUp stops a frame at each pipeline it compiles with the async API) left the next frame
// with a depth texture that had not changed and so no copy pipeline, and `bindDepth` threw on it. warmUp then rebooted
// the device and made every remaining pipeline synchronously, which on the WebGL2 layer left
// demos/ten-thousand-trees with a 3 to 9 s first frame. Runs on WebGPU or (MARGO_COMPAT=1) the WebGL2 layer.
// KB-QUALITY-WARMSERIAL1: on the layer with KHR_parallel_shader_compile the warm frames run whole, held in the layer's
// queue until their programs link side by side, so no frame reads a link status the driver has not reported yet (the
// read that waits) and the frame after the warm-up makes no program.
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
      // On the layer: count LINK_STATUS reads the warm-up makes before the driver reports the link done. (The first
      // frame shown afterwards links the layer's own small present program at once, as it always has.)
      const gpu = engine.gpu,
        layer = !!gpu.programs,
        gl = gpu.gl,
        parallel = gpu.ext?.parallel;
      let early = 0,
        counting = true;
      if (layer && parallel) {
        const get = gl.getProgramParameter.bind(gl);
        gl.getProgramParameter = (program, name) => {
          if (counting && name === gl.LINK_STATUS && !get(program, parallel.COMPLETION_STATUS_KHR)) early++;
          return get(program, name);
        };
      }
      const report = await warmUp(engine),
        warmed = gpu.programs?.count;
      counting = false;
      // A frame after the warm-up uses the warmed pipelines.
      engine.render({ delta: 0.125 });
      await engine.gpu.queue.onSubmittedWorkDone();
      const programs = [warmed, gpu.programs?.count];
      water.dispose();
      engine.destroy?.();
      return { ...report, layer, parallel: !!parallel, early, programs };
    });
    console.log(JSON.stringify(result));
    assert.equal(result.rebooted, false, 'the warm-up finished without restoring the device');
    assert.equal(result.fallbacks, 0);
    assert.ok(result.pipelines >= 2, `the surface and its depth copy were warmed (${result.pipelines})`);
    if (result.layer && result.parallel) {
      assert.equal(result.early, 0, 'no link status was read before the driver reported it');
      assert.ok(result.rounds < result.pipelines + 2, `whole warm frames, not one per pipeline (${result.rounds})`);
      assert.equal(result.programs[1], result.programs[0], 'the frame after the warm-up made no program');
    }
    assert.deepEqual(errors, []);
    console.log(
      `water warm-up PASS: ${result.layer ? 'WebGL2 layer' : 'WebGPU'}, ${result.pipelines} pipelines in ${result.rounds} rounds, no reboot`,
    );
  } finally {
    await browser.close();
  }
}
