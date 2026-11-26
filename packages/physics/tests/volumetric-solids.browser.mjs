import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close } = await openBrowser({
  startPath: '/packages/physics/tests/volumetric-solids.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.renderRung === 'function', null, { timeout: 20_000 });
  const bare = await page.evaluate(() => window.renderRung({ loaded: false }));
  const before = await page.locator('canvas').screenshot();
  const loaded = await page.evaluate(() => window.renderRung({ loaded: true }));
  const after = await page.locator('canvas').screenshot();
  assert.ok(loaded.y < bare.y && loaded.support > 0);
  assert.ok(loaded.visible >= 5 && bare.visible === loaded.visible);
  assert.notDeepEqual(after, before, 'the lone change at equal framing is the rendered rung geometry');
  const replay = await page.evaluate(() => window.renderRung({ loaded: true, showBoot: true }));
  assert.equal(replay.hash, loaded.hash);
  assert.deepEqual(errors, []);
  console.log(
    `LH-4 browser sag ${((bare.y - loaded.y) * 1000).toFixed(2)} mm, reaction ${loaded.support.toFixed(2)} N, ${loaded.hash}`,
  );
} finally {
  await close();
}
