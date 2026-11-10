import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { waitReady, watchPage } from './page-ready.mjs';
const context = await openBrowser({
    startPath: '/packages/cutscene/tests/nested-browser.html',
    port: 'free',
    viewport: { width: 1200, height: 1100 },
  }),
  { page } = context;
page.setDefaultTimeout(30000);
try {
  const errors = await watchPage(page);
  await waitReady(page, errors);
  await page.locator('.mtl-item[data-track="nest"]').dblclick();
  assert.equal(await page.locator('.margo-nested-pane').count(), 1);
  const child = '.margo-nested-pane .mtl';
  await page.evaluate(() => window.proof.editor.seek(3));
  assert.equal(await page.evaluate(() => window.proof.nested.editors[0].time), 3);
  await page.locator(child + ' .mtl-item[data-track="value"][data-index="0"]').click();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page.evaluate(() => window.proof.editor.model.document.timelines.child.tracks[0].keys[0].time),
    0.1,
  );
  assert.equal(
    await page.evaluate(() => window.proof.editor.model.history.undoCount),
    1,
    'child input acts only once with shared root undo',
  );
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => window.proof.nested.editors[0].model.document.tracks[0].keys[0].time), 0);
  await page.evaluate(() => window.proof.nested.editors[0].seek(5));
  assert.equal(await page.evaluate(() => window.proof.editor.time), 4);
  await page.locator('[aria-label="Discrete track"]').selectOption('flag');
  await page.locator('[aria-label="Boolean key value"]').uncheck();
  await page.getByRole('button', { name: 'Key value at playhead', exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => window.proof.editor.model.document.timelines.child.tracks[1].keys.find((k) => k.time === 5).value,
    ),
    false,
  );
  await page.locator('[aria-label="Discrete track"]').selectOption('label');
  await page.locator('[aria-label="String key value"]').fill('authored');
  await page.getByRole('button', { name: 'Key value at playhead', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.proof.discreteOf(window.proof.editor.model.cutscene().evaluate(4)).box.text),
    'authored',
  );
  await page.locator(child + ' .mtl-item[data-track="tone"]').click();
  assert.deepEqual(errors, [], 'outer curve edge handlers ignore child clips');
  await page.locator(child + ' .mtl-item[data-track="inner"]').dblclick();
  assert.equal(await page.locator('.margo-nested-pane').count(), 2);
  await page.evaluate(() => window.proof.nested.editors[1].seek(2));
  assert.equal(await page.evaluate(() => window.proof.editor.time), 3);
  await page.evaluate(() => {
    const p = window.proof;
    p.nested.close();
    p.nested.open({ track: 'nest', index: 0 }, p.editor);
  });
  assert.equal(
    await page.evaluate(
      () => window.proof.nested.editors[0].model.document.tracks[2].keys.find((k) => k.time === 5).value,
    ),
    'authored',
  );
  await page.evaluate(() => {
    const p = window.proof;
    p.nested.dispose();
    p.graph.dispose();
    p.editor.dispose();
  });
  assert.deepEqual(errors, []);
  console.log(
    'ok nested: inline double-click, two levels, local/global playheads, shared undo, boolean/string keying, graph isolation, reopen and cleanup',
  );
} finally {
  await context.close();
}
