// Real-adapter check (run from the repository root after building packages): node packages/shader/test/browser-check.mjs
// Node WGSL must compile and render: material colour/texture/varying/position nodes, a live uniform, Fn + loop, a NodePass
// reading colour and depth inside PostStack, a ComputePass whose storage buffer is read back and drawn, discard() in a
// NodeMaterial (the cut half shows the background) and a NodePass, and atomics (1000 invocations count, max, min, compact).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/browser-check.html', port: 5209 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
});
const pixel = async (y = 0.5, x = 0.5) => {
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4;
  return [...image.data.slice(o, o + 3)];
};
const near = (actual, expected, label, tolerance = 3) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: ${actual} != ${expected}`,
  );
const background = [5, 6, 9];
const expected = {
  uniform: [255, 128, 0],
  texture: [0, 255, 0],
  varying: [188, 188, 255],
  moved: background,
  loop: [0, 255, 255],
  post: [0, 127, 255],
  compute: [255, 188, 0],
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  for (const name of [
    'uniform',
    'gradient',
    'texture',
    'varying',
    'moved',
    'lit',
    'loop',
    'discard',
    'postDiscard',
    'atomics',
    'post',
    'compute',
  ]) {
    const result = await page.evaluate((n) => window.check.run(n), name),
      center = await pixel();
    assert.equal(result.error, null, name);
    assert.deepEqual(result.errors, [], name);
    if (expected[name]) near(center, expected[name], name);
    if (name === 'uniform') {
      const step = await page.evaluate(() => window.check.setTint('#00ff00'));
      assert.deepEqual(step.errors, []);
      assert.equal(step.newPipelines, 0, 'uniform change recompiled');
      near(await pixel(), [0, 255, 0], 'uniform update');
    }
    if (name === 'gradient') {
      near(await pixel(0.3), [0, 0, 255], 'uv.y > 0.5 at the top');
      near(await pixel(0.7), [255, 0, 0], 'uv.y < 0.5 at the bottom');
    }
    if (name === 'lit')
      assert.ok(
        center.some((v, i) => Math.abs(v - background[i]) > 20),
        'lit node material drew nothing',
      );
    if (name === 'post') near(await pixel(0.05, 0.05), [255, 0, 255], 'depth reads the cleared far plane');
    if (name === 'discard') {
      near(await pixel(0.5, 0.35), background, 'discarded half shows the background');
      near(await pixel(0.5, 0.65), [255, 255, 255], 'kept half');
    }
    if (name === 'postDiscard') {
      near(await pixel(0.5, 0.65), [255, 255, 255], 'kept post half');
      assert.ok(
        (await pixel(0.5, 0.35)).some((v) => v < 200),
        'discarded post half is not the scene',
      );
    }
    if (name === 'atomics') {
      const r = await page.evaluate(() => window.check.readAtomics());
      assert.deepEqual(r.counter, [1000, 999, 0, 500], 'atomic count, max, min, slots');
      assert.ok(r.evens, 'compacted even indices');
      console.log('atomics', JSON.stringify(r.counter));
    }
    if (name === 'compute')
      assert.deepEqual(
        await page.evaluate(() => window.check.readField()),
        [0, 2, 0, 1, 1, 2, 0, 1, 2, 2, 0, 1, 3, 2, 0, 1],
      );
    console.log('ok', name, center);
    await page.evaluate(() => window.check.clear());
  }
  assert.deepEqual(
    await page.evaluate(() => window.check.variants()),
    [[], []],
    'standard and physical gltf-pro variants compile with nodes',
  );
  console.log('ok variants');
  assert.deepEqual(pageErrors, []);
  console.log('shader browser check passed');
} finally {
  await context.close();
}
