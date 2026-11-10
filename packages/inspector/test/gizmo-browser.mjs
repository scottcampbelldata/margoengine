import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({
    startPath: '/packages/inspector/test/gizmo.html',
    port: 'free',
    viewport: { width: 1100, height: 650 },
  }),
  { page } = context,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  for (const backend of ['webgpu', 'webgl2']) {
    assert.equal(await page.evaluate((b) => window.setup(b), backend), backend);
    for (const mode of ['translate', 'rotate', 'scale']) {
      await page.mouse.move(900, 600);
      const { start, end } = await page.evaluate((m) => window.points(m), mode),
        box = await page.locator('canvas').boundingBox(),
        before = await page.evaluate(() => window.pose());
      assert.ok((await page.evaluate(() => window.redPixels())) > 30, 'gizmo red axis is rendered');
      await page.mouse.move(box.x + start[0], box.y + start[1]);
      await page.mouse.down();
      assert.equal(await page.evaluate(() => window.gizmo.controls.dragging), true);
      assert.equal(await page.evaluate(() => window.camera.enabled), false);
      await page.mouse.move(box.x + end[0], box.y + end[1], { steps: 6 });
      await page.mouse.up();
      const after = await page.evaluate(() => window.pose());
      assert.notDeepEqual(after, before, mode);
      assert.deepEqual(
        await page.evaluate(() => [
          window.inspector.selected === window.mesh,
          window.camera.enabled,
          window.inspector.history.undoCount,
        ]),
        [true, true, 1],
      );
      await page.evaluate(() => window.inspector.undo());
      assert.deepEqual(await page.evaluate(() => window.pose()), before);
      await page.evaluate(() => window.inspector.redo());
      assert.deepEqual(await page.evaluate(() => window.pose()), after);
      await page.evaluate(() => {
        window.inspector.undo();
        window.inspector.history.clear();
      });
      assert.deepEqual(errors, []);
      console.log(`${backend}: rendered ${mode}, selection, camera arbitration, undo and redo passed`);
    }
  }
  await page.evaluate(() => window.engine.dispose());
} finally {
  await context.close();
}
