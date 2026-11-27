import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { demoPages } from '../../../scripts/support/site-routes.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
assert.ok(demoPages.includes('buoyancy'));
const browser = await openBrowser({
  port: 'free',
  startPath: '/examples/buoyancy.html',
  openPath: '/tests/modern-game.html',
});
const { page, hardware } = browser;
const backend = hardware.compat ? 'webgl2' : 'webgpu';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = process.env.MARGO_KEEP_BUOYANCY_FRAMES === '1' ? 'test-results' : undefined;
if (output) await mkdir(output, { recursive: true });

const capture = async (id) => {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const image = await page
    .locator('#viewport')
    .screenshot(output ? { path: output + '/buoyancy-' + backend + '-' + id + '.png' } : {});
  return decodePNG(image);
};

try {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(new URL('/examples/buoyancy.html', page.url()).href);
  await page.waitForSelector('#viewport[data-ready], #viewport[data-error], [data-no-webgpu]', { timeout: 25000 });
  assert.equal(
    await page.locator('#viewport').getAttribute('data-ready'),
    'true',
    await page.locator('#status').textContent(),
  );
  const state = () =>
    page.locator('#measurement').evaluate((out) => [Number(out.dataset.rise), Number(out.dataset.heel)]);
  const seek = (tick) =>
    page.locator('#time').evaluate((slider, value) => {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, tick);

  const initial = await state();
  const before = await capture('release');
  assert.equal(await page.locator('#play').textContent(), 'Play');
  await seek(360);
  const settled = await state();
  const after = await capture('righted');
  await page.locator('#reset').click();
  assert.deepEqual(await state(), initial);
  await seek(360);
  assert.deepEqual(await state(), settled);
  assert.equal(await page.locator('#elapsed').textContent(), '6.00 s');
  assert.ok(settled[0] - initial[0] > 0.2, 'the real rigid sphere rises more than twenty centimetres');
  assert.ok(Math.abs(initial[1]) > 25 && Math.abs(settled[1]) < 4, 'the real rigid box returns toward upright');
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta > 20) changed++;
  }
  assert.ok(changed > 150, 'the physical motion changes the live rendered scene');
  assert.equal(await page.locator('#viewport').getAttribute('data-error'), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ backend, initial, settled, changed }));
} finally {
  await closeAll({ browser });
}
