import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';

// The caller holds one shared GPU slot, across native WebGPU and the WebGL2 compatibility layer.
for (const backend of ['native', 'compat']) {
  const browser = await openBrowser({
    startPath: `/packages/stage/test/gpu/gltf.html${backend === 'compat' ? '?compat' : ''}`,
    port: 5347,
  });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => window.check, null, { timeout: 60000 });
    for (const [url, animated] of [
      ['/packages/exporters/tests/fixtures/BoxTextured.glb', false],
      ['/examples/assets/khronos/RiggedFigure/RiggedFigure.glb', true],
      ['/examples/assets/khronos/MorphStressTest/MorphStressTest.glb', true],
    ]) {
      const result = await browser.page.evaluate(
        ([url, animated]) => window.check.load(url, animated),
        [url, animated],
      );
      const a = await decodePNG(await browser.page.locator('#a').screenshot()),
        b = await decodePNG(await browser.page.locator('#b').screenshot());
      assert.equal(Buffer.compare(a.data, b.data), 0, `${backend}: one call equals direct PBR + deformation: ${url}`);
      let visible = 0;
      for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== a.data[0] || a.data[i + 1] !== a.data[1]) visible++;
      assert.ok(visible > 100, `${backend}: model is visible`);
      assert.equal(result.animation, animated);
      if (!animated) assert.ok(result.shadowFar < 100, `${backend}: static PBR retains fitted cascade detail`);
      await browser.page.evaluate(() => window.check.drop());
      console.log(`${backend}: ${url}: identical pixels, ${result.primitives} primitives`);
    }
    assert.deepEqual(await browser.page.evaluate(() => window.check.close()), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
