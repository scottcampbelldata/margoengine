import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';

await mkdir('test-results/core-parity-hooks', { recursive: true });
const browser = await openBrowser({ startPath: '/tests/core-parity-hooks.html', port: 5209 }),
  page = browser.page,
  errors = [],
  results = [];
page.on('pageerror', (error) => errors.push(error.message));
const pixel = (image, x, y) =>
  Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
async function capture(label) {
  const image = await decodePNG(
    await page.locator('canvas').screenshot({ path: `test-results/core-parity-hooks/${label}.png` }),
  );
  results.push({ label, center: pixel(image, image.width / 2, image.height / 2) });
  return image;
}
try {
  await page.waitForFunction(() => window.coreHooks);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  await page.evaluate(() => coreHooks.view(false));
  const primary = await capture('primary');
  assert.ok(pixel(primary, 160, 120)[0] > pixel(primary, 160, 120)[2] + 50);
  const alternateState = await page.evaluate(() => coreHooks.view(true)),
    alternate = await capture('alternate');
  assert.ok(pixel(alternate, 160, 120)[2] > pixel(alternate, 160, 120)[0] + 50);
  assert.deepEqual(alternateState, { visible: 1, primary: true });
  assert.equal(
    await page.evaluate(async () => (await coreHooks.engine.pick(160, 120)) === coreHooks.front),
    true,
    'Picking after an alternate view did not use the primary camera',
  );
  await page.evaluate(() => coreHooks.view(false));
  const restored = await capture('restored');
  assert.equal(Buffer.compare(primary.data, restored.data), 0, 'Alternate render changed the next primary view');
  const offscreen = [];
  for (const alternateView of [false, true]) {
    const state = await page.evaluate((alternateView) => coreHooks.offscreen(alternateView), alternateView);
    assert.equal(state.visible, 1);
    assert.equal(state.primary, true);
    assert.ok(
      state.pixel[alternateView ? 2 : 0] > state.pixel[alternateView ? 0 : 2] + 0.1,
      'Offscreen capture used the wrong camera',
    );
    offscreen.push(state);
  }
  for (let channel = 0; channel < 3; channel++) {
    const rgb = [0, 0, 0];
    rgb[channel] = 1;
    await page.evaluate((rgb) => coreHooks.ambient(rgb), rgb);
    const image = await capture('ambient-' + channel),
      center = pixel(image, 160, 120);
    assert.ok(center[channel] > 80, 'Requested ambient channel is dark');
    assert.ok(
      center.every((value, i) => i === channel || value <= 1),
      'Ambient leaked into another channel',
    );
  }
  await page.evaluate(() => coreHooks.ambient([1, 1, 1]));
  const white = await capture('ambient-white');
  await page.evaluate(() => coreHooks.baseline());
  const baseline = await capture('pre-hook-white-reference');
  assert.equal(Buffer.compare(white.data, baseline.data), 0, 'Default white ambient changed baseline pixels');
  await page.evaluate(() => coreHooks.ambient([1, 1, 1], 0));
  const black = await capture('ambient-zero');
  assert.ok(pixel(white, 160, 120).every((v) => v > 80));
  assert.deepEqual(pixel(black, 160, 120), [0, 0, 0]);
  for (const mode of ['viewport', 'scissor', 'both', 'clear']) {
    await page.evaluate((mode) => coreHooks.rectangles(mode), mode);
    const image = await capture(mode),
      left = pixel(image, 80, 120),
      right = pixel(image, 240, 120);
    if (mode === 'clear') assert.ok(left[0] < 80, 'Whole-attachment clear retained the earlier viewport');
    else assert.deepEqual(left, [255, 0, 0]);
    if (mode === 'both' || mode === 'clear') assert.deepEqual(right, [0, 0, 255]);
    else assert.ok(right[0] < 80, 'Rectangle changed pixels outside its extent');
  }
  await page.evaluate(() => coreHooks.ambient([1, 1, 1]));
  await page.evaluate(() => coreHooks.rectangles('reset'));
  const reset = await capture('rectangles-reset');
  assert.deepEqual(pixel(reset, 80, 120), pixel(reset, 240, 120), 'Rectangle state leaked into an ordinary draw');
  assert.ok(pixel(reset, 80, 120).every((value) => value > 80));
  assert.deepEqual(errors, []);
  const report = {
    hardware: browser.hardware,
    primaryPickRestored: true,
    changedPrimaryChannels: 0,
    changedBaselineChannels: 0,
    offscreen,
    captures: results.length,
    results,
  };
  await writeFile('test-results/core-parity-hooks/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await page.evaluate(() => window.coreHooks?.dispose()).catch(() => {});
  await browser.close();
}
