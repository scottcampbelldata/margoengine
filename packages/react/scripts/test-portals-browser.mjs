import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/portals-browser.html' });
const { page } = browser, errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => window.portalsProof);
  for (const mode of ['texture', 'hud', 'stacked']) {
    await page.evaluate(mode => window.portalsProof.mount(mode), mode);
    await page.waitForFunction(() => window.portalsProof.state.frames.every(n => n > 20));
    const left = await decodePNG(await page.locator('[data-side="0"] canvas').screenshot()), right = await decodePNG(await page.locator('[data-side="1"] canvas').screenshot());
    assert.deepEqual(right.data, left.data, `${mode} matches direct native rendering exactly`);
    assert.deepEqual(await page.evaluate(() => window.portalsProof.state.errors), []);
    console.log(mode, 'pixels exact');
  }
  await page.evaluate(() => window.portalsProof.unmount()); await page.waitForFunction(() => window.portalsProof.state.engines.every(e => e.disposed)); assert.deepEqual(errors, []);
} finally { await browser.close(); }
