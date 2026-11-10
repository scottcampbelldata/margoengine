import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { waitReady, watchPage } from './page-ready.mjs';
const context = await openBrowser({ startPath: '/packages/cutscene/tests/scroll-browser.html', port: 'free' }),
  { page } = context;
page.setDefaultTimeout(30000);
try {
  const errors = await watchPage(page);
  await waitReady(page, errors);
  await page.locator('#scroll').hover();
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => window.proof.player.time > 2);
  const result = await page.evaluate(() => ({ time: window.proof.player.time, offset: window.proof.source.scrollTop }));
  assert.equal(result.time, 2 + (6 * result.offset) / 1000);
  await page.evaluate(() => {
    window.proof.source.scrollTop = 1000;
  });
  await page.waitForFunction(() => window.proof.player.time === 8);
  await page.evaluate(async () => {
    const { ScrollPlayback } = await import('../src/scroll.ts');
    const p = window.proof;
    p.binding.dispose();
    p.player.seek(0);
    p.binding = new ScrollPlayback(p.player, { source: p.source, scrub: 0.02 });
  });
  await page.waitForFunction(() => window.proof.player.time > 9.999);
  await page.evaluate(() => window.proof.binding.dispose());
  const before = await page.evaluate(() => window.proof.player.time);
  await page.evaluate(() => {
    window.proof.source.scrollTop = 0;
    window.proof.source.dispatchEvent(new Event('scroll'));
  });
  assert.equal(await page.evaluate(() => window.proof.player.time), before);
  assert.deepEqual(errors, []);
  console.log('ok scroll: real wheel scrubbing, endpoints, requestAnimationFrame smoothing and cleanup');
} finally {
  await context.close();
}
