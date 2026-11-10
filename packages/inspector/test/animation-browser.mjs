import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/inspector/test/animation.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  const clips = await page.evaluate(() => window.setup());
  assert.equal(clips.length, 3);
  await page.evaluate(() => {
    window.panel.set(window.animation, 0, { playing: false });
  });
  const before = await page.evaluate(() => window.pose());
  await page.getByRole('slider', { name: `${clips[0]} Time`, exact: true }).fill('0.5');
  const after = await page.evaluate(() => {
    window.engine.render();
    return window.pose();
  });
  assert.notDeepEqual(before, after);
  assert.equal(await page.evaluate(() => window.panel.state(window.animation, 0).playing), false);
  await page.getByRole('checkbox', { name: 'Skeleton', exact: true }).check();
  await page.evaluate(() => window.engine.render());
  assert.ok((await page.locator('svg[aria-label="Skeleton overlay"] path').getAttribute('d')).length > 100);
  await page.evaluate(() => {
    window.panel.set(window.animation, 1, { time: 0.5, weight: 0.5, playing: false });
    window.engine.render();
  });
  assert.notDeepEqual(await page.evaluate(() => window.pose()), after);
  await page.evaluate(() => {
    window.model.dispose();
    window.engine.render();
  });
  assert.equal(await page.locator('main fieldset').count(), 0);
  assert.deepEqual(errors, []);
  console.log('CC0 Fox: clip playback, UI scrub, weighted poses, skeleton and model disposal passed');
} finally {
  await page.evaluate(() => {
    window.panel?.dispose();
    window.engine?.dispose();
  });
  await context.close();
}
