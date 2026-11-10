import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/test-offscreen-browser.html' });
const { page } = browser, errors = [];
page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => window.testOffscreenProof);
  assert.deepEqual(await page.evaluate(() => window.testOffscreenProof.test()), { count: 1, frames: 2, clicked: 1 });
  let clicks = 0;
  for (const mode of ['worker', 'page', 'auto', 'no-offscreen', 'no-worker']) {
    await page.evaluate(mode => {
      window.savedWorker = window.Worker;
      window.savedTransfer = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
      if (mode === 'no-offscreen') delete HTMLCanvasElement.prototype.transferControlToOffscreen;
      if (mode === 'no-worker') window.Worker = undefined;
      return window.testOffscreenProof.mount(mode.startsWith('no-') ? 'auto' : mode);
    }, mode);
    await page.waitForFunction(() => window.testOffscreenProof.state.mode);
    assert.equal(await page.evaluate(() => window.testOffscreenProof.state.mode), mode === 'page' || mode.startsWith('no-') ? 'page' : 'worker');
    // Startup is not a render-complete fence; pick/readback in each scene proves its GPU submission before ready.
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#offscreen canvas'); return canvas?.width === 128 && canvas?.height === 128;
    });
    await page.evaluate(() => { window.Worker = window.savedWorker; Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', window.savedTransfer); });
    const left = await decodePNG(await page.locator('#test canvas').screenshot());
    const right = await decodePNG(await page.locator('#offscreen canvas').screenshot());
    const red = pixels => { let count = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 100 && pixels[i] > pixels[i + 2] * 2) count++; return count; };
    assert.ok(red(left.data) > 500, 'test renderer stage renders a red box');
    assert.ok(red(right.data) > 500, `${mode} canvas renders a red box`);
    assert.deepEqual(right.data, left.data, `${mode}: exact test/native pixels`);
    console.log(mode, 'red pixels', red(left.data), red(right.data));
    await page.evaluate(() => { window.IS_REACT_ACT_ENVIRONMENT = false; }); await page.locator('button').click(); clicks++; await page.waitForFunction(n => document.querySelector('button').textContent === 'React page ' + n, clicks);
    // Remount resets only scene inputs; React state remains on the page.
    if (mode !== 'auto') { await page.locator('button').click(); clicks++; }
  }
  await page.evaluate(() => window.testOffscreenProof.unmount());
  assert.deepEqual(await page.evaluate(() => ({ ...window.testOffscreenProof.state })), { mode: 'page', errors: [], frames: 2, clicked: 1, closed: true, stageClosed: true });
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
