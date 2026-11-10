import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/effects-extra-browser.html' });
const { page } = browser, errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => window.effectsProof);
  for (const mode of ['stars', 'sparkles', 'trail', 'edges', 'decal']) {
    await page.evaluate(mode => window.effectsProof.mount(mode), mode);
    await page.waitForFunction(() => window.effectsProof.state.ready.every(Boolean) && window.effectsProof.state.frames.every(n => n > 20));
    const left = await decodePNG(await page.locator('[data-side="0"] canvas').screenshot()), right = await decodePNG(await page.locator('[data-side="1"] canvas').screenshot());
    assert.deepEqual(right.data, left.data, `${mode}: exact native pixels`);
    assert.deepEqual(await page.evaluate(() => window.effectsProof.state.errors), []); console.log(mode, 'pixels exact');
  }
  await page.evaluate(() => window.effectsProof.unmount()); await page.waitForFunction(() => window.effectsProof.state.engines.every(e => e.disposed)); assert.deepEqual(errors, []);
} finally { await browser.close(); }
