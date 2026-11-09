// Real-adapter check of the light tier's reading (run from the repository root after building packages):
// node packages/quality/test/browser-check.mjs
// The page draws one triangle, overdrawn so the timer can see it. The rule that read submit to done kept even this page light (the floor of presenting to a
// canvas), and needs no timestamps; this proves the real queries work, leave no validation errors and are removed.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { FAST_GPU_MS } from '../dist/index.js';
import { speedBudget } from '../../../scripts/speed/budgets.mjs';
import { speedEnabled } from '../../../scripts/support/speed-phase.mjs';

setTimeout(() => {
  console.error('quality browser check: stopped at its time limit');
  process.exit(124);
}, 120_000).unref();
const PATH = '/packages/quality/test/browser-check.html',
  context = await openBrowser({ startPath: PATH, port: 5211 }),
  { page, hardware } = context,
  problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
const key = `margoQuality:${PATH}`;
const visit = async (search) => {
  const query = new URLSearchParams(search);
  if (speedEnabled()) query.set('speed', '');
  await page.goto(new URL(`${PATH}?${query}`, page.url()).href);
  await page.waitForFunction(() => window.feature !== undefined, null, { timeout: 30_000 });
  return page.evaluate(async () => ({
    tier: window.tier,
    asking: window.asking,
    feature: window.feature,
    ...(await Promise.race([
      window.result,
      new Promise((_, fail) => setTimeout(() => fail(new Error('no reading in 30 s')), 30_000)),
    ])),
  }));
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  const offered = await page.evaluate(async () =>
    (await navigator.gpu.requestAdapter()).features.has('timestamp-query'),
  );
  await page.evaluate((name) => localStorage.removeItem(name), key);

  const none = await visit('?nofeature');
  assert.equal(none.tier, 'light');
  assert.equal(none.feature, false);
  assert.equal(none.milliseconds, null);
  assert.equal(none.stored, null, 'no timestamps: stays light, nothing stored');
  assert.equal(none.allBack, true);
  assert.deepEqual(none.errors, []);
  console.log('ok without timestamp-query');

  if (!offered) console.log('this adapter has no timestamp-query: the rest cannot run here');
  else {
    const first = await visit('');
    console.log('one triangle', JSON.stringify(first));
    assert.equal(first.tier, 'light');
    assert.equal(first.asking, true);
    assert.equal(first.feature, true);
    assert.ok(Number.isFinite(first.milliseconds) && first.milliseconds > 0, 'real timestamp reading');
    speedBudget('quality-triangle', { milliseconds: first.milliseconds });
    const promoted = first.milliseconds < FAST_GPU_MS;
    assert.equal(first.stored, promoted ? 'high' : null, 'storage follows the measured tier rule');
    assert.equal(first.allBack, true, 'everything wrapped is put back');
    assert.deepEqual(first.errors, [], 'no validation errors from the queries');

    await page.goto(new URL(PATH, page.url()).href);
    await page.waitForFunction(() => window.feature !== undefined, null, { timeout: 30_000 });
    const second = await page.evaluate(() => ({ tier: window.tier, asking: window.asking, feature: window.feature }));
    assert.deepEqual(
      second,
      {
        tier: promoted ? 'high' : 'light',
        asking: !promoted,
        feature: !promoted,
      },
      'next load follows storage and only an unmeasured light page asks',
    );
    if (speedEnabled())
      console.log('ok one triangle reads', first.milliseconds, 'ms; the old rule read', first.oldRule, 'ms');
  }
  await page.evaluate((name) => localStorage.removeItem(name), key);
  assert.deepEqual(problems, []);
  console.log('quality browser check passed');
} finally {
  await context.close();
}
