import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';

for (const backend of ['native', 'compat']) {
  const browser = await openBrowser({
      startPath: `/packages/stage/test/gpu/viewer-extras.html${backend === 'compat' ? '?compat' : ''}`,
      port: 5358,
    }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => window.check, null, { timeout: 60000 });
    const equalPixels = async () => {
      const a = await decodePNG(await browser.page.locator('#a').screenshot()),
        b = await decodePNG(await browser.page.locator('#b').screenshot());
      assert.equal(Buffer.compare(a.data, b.data), 0, `${backend}: extras equal direct viewer and animation`);
      let visible = 0;
      for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== a.data[0] || a.data[i + 1] !== a.data[1]) visible++;
      assert.ok(visible > 100, `${backend}: real model visible`);
      return a.data;
    };
    for (const [url, animated] of [
      ['/packages/exporters/tests/fixtures/BoxTextured.glb', false],
      ['/examples/assets/khronos/RiggedFigure/RiggedFigure.glb', true],
      ['/examples/assets/khronos/MorphStressTest/MorphStressTest.glb', true],
      ['/examples/assets/khronos/MaterialsVariantsShoe/MaterialsVariantsShoe.glb', false],
    ]) {
      const result = await browser.page.evaluate(
        ([url, animated]) => window.check.load(url, animated),
        [url, animated],
      );
      assert.equal(result.manual, true);
      assert.equal(result.playing, false);
      const initial = await equalPixels();
      let previous = initial;
      if (animated) assert.equal(await browser.page.evaluate(() => window.check.play()), true);
      for (const variant of result.variants) {
        await browser.page.evaluate((variant) => window.check.variant(variant), variant);
        const changed = await equalPixels();
        // The first named variant may be the default material. Distinct named variants must differ.
        if (variant !== result.variants[0])
          assert.notEqual(Buffer.compare(previous, changed), 0, `${backend}: named variants visibly differ`);
        previous = changed;
      }
      if (url.includes('BoxTextured')) {
        assert.deepEqual(await browser.page.evaluate(() => window.check.pick()), { own: true, miss: true });
        const hotspot = await browser.page.evaluate(() => window.check.hotspot());
        assert.equal(hotspot.visible, true);
        assert.equal(hotspot.moved, true);
        assert.ok(Math.abs(hotspot.screen[0] - 160) < 1 && Math.abs(hotspot.screen[1] - 160) < 1);
      }
      assert.deepEqual(await browser.page.evaluate(() => window.check.drop()), { restored: true, posters: 0 });
      console.log(`${backend}: ${url}: exact pixels and interaction passed`);
    }
    assert.deepEqual(await browser.page.evaluate(() => window.check.element()), {
      manual: true,
      variant: true,
      replaced: true,
      restored: true,
      reconnected: true,
    });
    const ar = await browser.page.evaluate(() => window.check.ar());
    assert.equal(ar.mode, 'immersive-ar');
    assert.equal(ar.disabled, true);
    assert.ok(ar.reason);
    assert.deepEqual(await browser.page.evaluate(() => window.check.close()), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
