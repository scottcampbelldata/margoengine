import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close } = await openBrowser({ startPath: '/packages/physics/tests/tissue.html', port: 'free' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.renderTissue === 'function', null, { timeout: 20_000 });
  const rest = await page.evaluate(() => window.renderTissue([0, 0, 0]));
  const restImage = await page.locator('canvas').screenshot();
  const pushed = await page.evaluate(() => window.renderTissue([0, 0, 0.125]));
  const pushedImage = await page.locator('canvas').screenshot();
  assert.ok(pushed.vertex[2] > rest.vertex[2]);
  assert.equal(pushed.visible, rest.visible);
  assert.ok(pushed.visible >= 1);
  assert.notDeepEqual(pushedImage, restImage);
  const lateral = await page.evaluate(() => window.renderTissue([0.5, 0, 0.125]));
  assert.deepEqual(lateral.vertex, pushed.vertex);
  assert.deepEqual(await page.locator('canvas').screenshot(), pushedImage);
  assert.deepEqual(await page.evaluate(() => window.renderTissue([0, 0, 0.125])), pushed);
  assert.deepEqual(await page.locator('canvas').screenshot(), pushedImage);
  assert.deepEqual(errors, []);
  console.log('Tissue apex', pushed.vertex[2], 'm, state', pushed.hash);
} finally {
  await close();
}
