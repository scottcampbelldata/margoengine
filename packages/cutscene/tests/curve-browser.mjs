import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { waitReady, watchPage } from './page-ready.mjs';
const context = await openBrowser({ startPath: '/packages/cutscene/tests/curve-browser.html', port: 'free' }),
  { page } = context;
page.setDefaultTimeout(30000);
try {
  const errors = await watchPage(page);
  await waitReady(page, errors);
  const drag = async (selector, dx, dy) => {
    const b = await page.locator(selector).boundingBox();
    assert.ok(b);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
  };
  const key = '.margo-curve-editor [data-kind="key"][data-index="1"]';
  await drag(key, 80, -20);
  const state = await page.evaluate(() => ({
    key: window.proof.editor.model.document.tracks[0].keys[1],
    undo: window.proof.editor.model.history.undoCount,
  }));
  assert.ok(state.key.time > 5);
  assert.ok(state.key.value > 5);
  assert.equal(state.undo, 1);
  await page.locator(key).focus();
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => window.proof.editor.model.document.tracks[0].keys[1].value), 5);
  await drag('.margo-curve-editor [data-kind="handle"][data-index="1"][data-handle="0"]', 15, -30);
  assert.ok(await page.evaluate(() => Array.isArray(window.proof.editor.model.document.tracks[0].keys[1].ease)));
  const clip = await page.locator('.mtl-item[data-kind="clip"]').boundingBox();
  await page.mouse.move(clip.x + clip.width - 2, clip.y + clip.height / 2);
  await page.mouse.down();
  await page.mouse.move(clip.x + clip.width + 98, clip.y + clip.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.proof.editor.model.document.tracks[1].clips[0].duration), 5);
  await page.locator(key).focus();
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => window.proof.editor.model.document.tracks[1].clips[0].duration), 4);
  await page.evaluate(() => {
    window.proof.graph.dispose();
    window.proof.editor.dispose();
  });
  assert.equal(await page.locator('.margo-curve-editor').count(), 0);
  assert.deepEqual(errors, []);
  console.log('ok curve graph: values, Bezier handles, edge trim, grouped undo, disposal');
} finally {
  await context.close();
}
