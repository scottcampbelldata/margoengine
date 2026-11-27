// examples/floating.html on the GPU (SEA-12, parity bar P12): the page comes up on WebGPU (or the WebGL2 layer with
// --compat), every body floats (partly under water, finite, near the surface) after five seconds of swell, a click on the
// water makes a ripple the bodies ride, and the debug view draws over the scene and goes away again.
//   node packages/physics/tests/floating-example.browser.mjs [--compat]
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { demoPages } from '../../../scripts/support/site-routes.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
assert.ok(demoPages.includes('floating'), 'the page is built into the site');
const browser = await openBrowser({
  port: 'free',
  startPath: '/examples/floating.html',
  openPath: '/tests/modern-game.html',
});
const { page, hardware } = browser;
const backend = hardware.compat ? 'webgl2' : 'webgpu';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

// MARGO_KEEP_FLOATING_FRAMES=1 keeps the frames in test-results to look at.
const keep = process.env.MARGO_KEEP_FLOATING_FRAMES === '1';
const capture = async (id) => {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const path = keep ? `test-results/floating-${backend}-${id}.png` : undefined;
  return decodePNG(await page.locator('#viewport').screenshot(path ? { path } : {}));
};
const changed = (a, b) => {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      20
    )
      count++;
  return count;
};

try {
  // Reduced motion starts paused, so the test steps the scene itself, frame by frame.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(new URL('/examples/floating.html', page.url()).href);
  await page
    .waitForSelector('#viewport[data-ready], #viewport[data-error], [data-no-webgpu]', { timeout: 90000 })
    .catch(async (error) => {
      throw new Error(`${error.message}; status: ${await page.locator('#status').textContent()}; errors: ${errors}`);
    });
  assert.equal(
    await page.locator('#viewport').getAttribute('data-ready'),
    'true',
    await page.locator('#status').textContent(),
  );
  assert.equal(await page.locator('#play').textContent(), 'Play');
  const steps = (count) =>
    page.evaluate((n) => {
      for (let i = 0; i < n; i++) window.floatingDemo.step();
    }, count);
  const state = () =>
    page.locator('#measurement').evaluate((out) => ({
      wet: JSON.parse(out.dataset.wet),
      heights: JSON.parse(out.dataset.heights),
      frame: Number(out.dataset.frame),
    }));
  await steps(300);
  const afloat = await state();
  assert.equal(afloat.frame, 300);
  assert.equal(afloat.wet.length, 5);
  for (const [i, wet] of afloat.wet.entries()) {
    assert.ok(wet > 0.05 && wet < 0.95, `body ${i} floats partly under water: ${wet}`);
    assert.ok(Number.isFinite(afloat.heights[i]) && Math.abs(afloat.heights[i]) < 1, `body ${i} is near the surface`);
  }
  // A click on the water in front of the camera makes a ripple.
  const box = await page.locator('#viewport').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7);
  assert.equal(await page.locator('#viewport').getAttribute('data-ripples'), '1');
  await steps(30);
  const plain = await capture('afloat');
  await page.locator('#debug').check();
  await page.waitForFunction(() => !document.querySelector('#debug').disabled);
  const drawn = await capture('debug');
  const overlay = changed(plain, drawn);
  assert.ok(overlay > 200, `the debug view draws over the bodies (${overlay} pixels)`);
  await page.locator('#debug').uncheck();
  const cleared = changed(plain, await capture('cleared'));
  assert.ok(cleared < overlay / 4, `the debug view goes away (${cleared} pixels left)`);
  assert.equal(await page.locator('#viewport').getAttribute('data-error'), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ backend, afloat, overlay, cleared }));
} finally {
  await closeAll({ browser });
}
