import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/inspector/test/textures.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  const list = await page.evaluate(() => window.setup());
  assert.equal(list.length, 8);
  assert.equal(list[0].label, 'Before viewer');
  assert.deepEqual([list[0].width, list[0].height, list[0].depthOrArrayLayers, list[0].mipLevelCount], [8, 4, 2, 3]);
  const pixel = (name, options) =>
    page.evaluate(([name, options]) => window.pixel(window[name].id, options), [name, options]);
  assert.deepEqual(await pixel('test', { mip: 1, layer: 1 }), {
    width: 4,
    height: 2,
    first: [100, 160, 120, 160],
    last: [100, 160, 120, 160],
  });
  for (const [channel, value] of [
    ['r', 160],
    ['g', 160],
    ['b', 120],
    ['a', 160],
  ]) {
    const p = await pixel('test', { mip: 2, layer: 1, channel });
    assert.deepEqual(p.first, [value, value, value, 255]);
  }
  const integer = await pixel('integer', { range: [0, 100], channel: 'r' });
  assert.deepEqual(integer.first, [64, 64, 64, 255]);
  assert.deepEqual(integer.last, [255, 255, 255, 255]);
  assert.deepEqual((await pixel('volume', { layer: 1 })).first, [0, 255, 0, 255]);
  assert.deepEqual((await pixel('one')).last, [100, 110, 120, 255]);
  assert.deepEqual((await pixel('srgb')).first, [64, 128, 192, 255]);
  assert.deepEqual((await pixel('depth')).first, [64, 64, 64, 255]);
  assert.deepEqual((await pixel('depth', { aspect: 'stencil-only', range: [0, 255] })).first, [64, 64, 64, 255]);
  assert.deepEqual((await pixel('depth')).first, [64, 64, 64, 255], 'depth sampling is restored after stencil');
  assert.deepEqual((await pixel('ms')).first, [51, 102, 153, 255]);
  const real = await pixel('real');
  assert.equal(real.width, 1024);
  assert.equal(real.height, 1024);
  assert.notDeepEqual(real.first, real.last);
  await page.getByRole('combobox', { name: 'Texture', exact: true }).selectOption(String(list[0].id));
  await page.getByRole('spinbutton', { name: 'Mip level', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: 'Mip level', exact: true }).press('Tab');
  await page.getByRole('combobox', { name: 'Texture channel', exact: true }).selectOption('r');
  await page.waitForFunction(() => window.viewer.canvas.width === 2 && window.viewer.canvas.height === 1);
  await page.waitForFunction(() => document.querySelector('output').textContent === '');
  assert.equal(await page.evaluate(() => window.capture.list().length), 8);
  await page.evaluate(() => window.test.texture.destroy());
  assert.equal(await page.evaluate(() => window.capture.list().length), 7);
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  assert.deepEqual(errors, []);
  console.log(
    'Startup capture, exact mips/channels, arrays/volume/1D, uint, sRGB, depth/stencil, MSAA, CC0 real texture and UI passed',
  );
} finally {
  await page.evaluate(() => {
    window.viewer?.dispose();
    window.capture?.dispose();
    window.device?.destroy();
  });
  await context.close();
}
