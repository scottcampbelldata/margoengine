import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/scene-owner-browser.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const center = async () => {
    const p = await decodePNG(await page.locator('canvas').screenshot()),
      i = (32 * p.width + 32) * 4;
    return [...p.data.slice(i, i + 3)];
  };
  for (const kind of ['ComputePass', 'ScenePass', 'RawShaders']) {
    const before = await page.evaluate((k) => window.check.attach(k), kind);
    assert.equal(before.attached, true);
    assert.deepEqual(before.errors, []);
    if (kind === 'ComputePass') assert.equal(before.computed, 1);
    if (kind === 'ScenePass') assert.equal(before.targets, 1);
    if (kind === 'RawShaders') {
      assert.equal(before.draws, 1);
      assert.deepEqual(await center(), [255, 0, 0]);
    }
    const after = await page.evaluate((k) => window.check.dispose(k), kind);
    assert.equal(after.detached, true, `${kind} remains registered`);
    assert.equal(after.isolated, true);
    assert.deepEqual(after.errors, []);
    if (kind === 'ComputePass') assert.equal(after.computed, 0, 'disposed pass still dispatches');
    if (kind === 'RawShaders') assert.deepEqual(await center(), [5, 6, 9], 'disposed pass still draws');
    console.log(kind, JSON.stringify({ before, after }));
  }
  assert.deepEqual(await page.evaluate(() => window.check.close()), []);
  assert.deepEqual(errors, []);
  console.log('shader owning-scene GPU dispatch, targets, pixels and disposal passed');
} finally {
  await context.close();
}
