import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
for (const kind of ['meshes', 'models', 'dynamic']) {
  const context = await openBrowser({
      startPath: '/packages/culling/test/gpu/bounds-extended.html?kind=' + kind,
      port: 'free',
    }),
    errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 45000 });
    for (let i = 0; i < 4; i++) {
      const result = await context.page.evaluate((n) => window.check.step(n), i);
      const a = await decodePNG(await context.page.locator('#a').screenshot()),
        b = await decodePNG(await context.page.locator('#b').screenshot());
      assert.deepEqual(a.data, b.data, `${kind}, frame ${i}: pixels differ`);
      if (i === 0) assert.equal(result.drawn, 0, 'thin boxes outside the frustum must drop despite large spheres');
      if (i === 1 || i === 3) assert.ok(result.drawn >= 24, 'moving the camera or hiding the wall reveals every rod');
      if (i === 2 && kind === 'meshes') assert.ok(result.drawn < 15, 'oriented boxes behind the wall must drop');
      if (i === 2 && kind === 'models' && !result.compat)
        assert.ok(result.drawn < 15, 'native model Hi-Z uses the oriented box');
      console.log('box bounds', kind, i, result);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
