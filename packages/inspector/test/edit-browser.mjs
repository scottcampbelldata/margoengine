import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({
    startPath: '/packages/inspector/test/edit.html',
    port: 'free',
    viewport: { width: 1100, height: 750 },
  }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  for (const backend of ['webgpu', 'webgl2']) {
    assert.equal(await page.evaluate((b) => window.setup(b), backend), backend);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForFunction(() => window.engine.stats.drawCalls > 0);
    await page.getByRole('spinbutton', { name: 'position x', exact: true }).fill('1.5');
    await page.getByRole('spinbutton', { name: 'position x', exact: true }).press('Tab');
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await page.evaluate(() => {
      window.a = window.inspector.selected;
      window.b = window.editor.createPrimitive('sphere');
    });
    await page
      .getByRole('treeitem', { name: 'sphere', exact: true })
      .dragTo(page.getByRole('treeitem', { name: 'box copy', exact: true }));
    assert.equal(await page.evaluate(() => window.parentId(window.b) === window.a.id), true);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await page.evaluate(() => window.inspector.selected === window.b), true);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await page.evaluate(() => window.parentId(window.b)), -1);
    await page.evaluate(() => {
      window.inspector.history.clear();
      window.editor.delete(window.a);
      window.inspector.undo();
    });
    assert.equal(await page.evaluate(() => window.a.position.x), 1.5);
    await page.evaluate(() => {
      const p = window.editor.createPrimitive();
      p.setPosition([2, 0, 0]);
      const light = window.editor.createLight('ambient', { intensity: 0.2 }, p);
      window.editor.delete(light);
      window.inspector.undo();
    });
    if (backend === 'webgpu') {
      await page.evaluate(() => {
        for (const kind of ['point', 'spot', 'directional']) {
          const light = window.editor.createLight(kind, { intensity: 2 });
          light.setPosition([2, 3, 2]);
          window.editor.setLight(light, { intensity: 4 });
        }
        window.engine.render();
      });
      assert.equal(await page.evaluate(() => window.engine.scene.plugins.get('clustered').list.length), 2);
      assert.equal(await page.evaluate(() => window.engine.scene.plugins.get('clustered:directional').list.length), 1);
    }
    assert.deepEqual(errors, []);
    console.log(`${backend}: real tree drag, creation, duplication, deletion, light rendering and undo passed`);
  }
} finally {
  await page.evaluate(() => window.engine?.dispose());
  await context.close();
}
