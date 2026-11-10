import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { waitReady, watchPage } from './page-ready.mjs';
const context = await openBrowser({
    startPath: '/packages/cutscene/tests/viewport-browser.html',
    port: 'free',
    viewport: { width: 1100, height: 900 },
  }),
  { page } = context;
page.setDefaultTimeout(30000);
try {
  const errors = await watchPage(page);
  await waitReady(page, errors);
  const canvas = await page.locator('canvas').boundingBox();
  await page.mouse.click(canvas.x + 300, canvas.y + 200);
  await page.waitForFunction(() => window.proof.inspector.selected === window.proof.mesh);
  for (const [i, mode] of ['translate', 'rotate', 'scale'].entries()) {
    await page.mouse.move(1000, 800);
    await page.evaluate(
      (t) => {
        window.proof.editor.time = t;
        window.proof.keying.gizmo.sync();
      },
      (i + 1) * 2,
    );
    const { start, end } = await page.evaluate((m) => window.points(m), mode);
    await page.mouse.move(canvas.x + start[0], canvas.y + start[1]);
    await page.mouse.down();
    assert.equal(await page.evaluate(() => window.proof.keying.gizmo.controls.dragging), true);
    await page.mouse.move(canvas.x + end[0], canvas.y + end[1], { steps: 5 });
    await page.mouse.up();
    const keys = await page.evaluate(() => window.proof.editor.model.document.tracks[0].keys);
    assert.equal(keys.length, i + 1);
    assert.equal(keys[i].time, (i + 1) * 2);
    assert.ok(keys[i].position && keys[i].rotation && keys[i].scale);
  }
  assert.notDeepEqual(
    await page.evaluate(() => window.proof.editor.model.document.tracks[0].keys[0].position),
    [0, 0, 0],
  );
  assert.notDeepEqual(
    await page.evaluate(() => window.proof.editor.model.document.tracks[0].keys[1].rotation),
    [0, 0, 0, 1],
  );
  assert.notDeepEqual(await page.evaluate(() => window.proof.editor.model.document.tracks[0].keys[2].scale), [1, 1, 1]);
  await page.locator('canvas').focus();
  await page.keyboard.press('k');
  assert.equal(await page.evaluate(() => window.proof.editor.model.document.tracks[0].keys.length), 3);
  await page.evaluate(() => {
    const p = window.proof;
    p.keying.dispose();
    p.editor.dispose();
    p.engine.dispose();
  });
  assert.equal(await page.locator('legend', { hasText: 'Viewport keying' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('ok viewport: real scene pick, translate/rotate/scale drags, auto keys, manual replacement, disposal');
} finally {
  await context.close();
}
