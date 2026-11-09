import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const rows = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/staging/test/pathtrace-browser.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const { page } = context,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  const diff = (a, b) => {
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    return a.data.reduce((n, v, i) => n + (v !== b.data[i]), 0);
  };
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const triangles = await page.evaluate((c) => window.check.init(c), compat);
    assert(triangles > 1000);
    const raster = await shot();
    assert.equal(await page.evaluate(() => window.check.attach()), false);
    assert.equal(diff(await shot(), raster), 0, 'initial raster');
    assert.equal(await page.evaluate(() => window.check.waiting()), false);
    assert.deepEqual(await page.evaluate(() => window.check.converge()), { active: true, samples: 4 });
    const traced = await shot(),
      tracedDifference = diff(traced, raster);
    assert(tracedDifference > 1000);
    await page.evaluate(() => window.check.noProduct());
    const emptyLit = await shot();
    const center = (Math.floor(traced.height / 2) * traced.width + Math.floor(traced.width / 2)) * 4;
    const viewportSurface = {
      product: [...traced.data.subarray(center, center + 3)],
      empty: [...emptyLit.data.subarray(center, center + 3)],
    };
    assert.notDeepEqual(
      viewportSurface.product,
      viewportSurface.empty,
      'the product surface appears in the viewport, independently of background changes',
    );
    await page.evaluate(() => window.check.resetProduct());
    assert.equal(diff(await shot(), traced), 0, 'restoring product geometry restores every still pixel');
    assert.equal(await page.evaluate(() => window.check.move(0.1)), false);
    assert.equal(await page.evaluate(() => window.check.move(0)), false);
    assert.equal(diff(await shot(), raster), 0, 'motion restores the raster exactly');
    await page.evaluate(() => window.check.converge());
    assert.equal(diff(await shot(), traced), 0, 'repeat camera gives identical still');
    const images = await page.evaluate(() => window.check.images());
    assert(images.convergence.finite);
    assert(images.convergence.hitPixels > 100);
    assert(images.convergence.high < images.convergence.low, 'more samples reduce real-model image error');
    assert(images.replacedInactive);
    assert(images.emissionHits > 100);
    assert(images.maximumEmissionError < 1e-5, 'constant emission per real-geometry ray');
    const beforeRestore = await shot(),
      restored = await page.evaluate(() => window.check.restore());
    assert.deepEqual(restored, { newDevice: true, idle: true });
    assert.equal(diff(await shot(), raster), 0, 'device replacement returns to raster while idle timer restarts');
    await page.evaluate(() => window.check.converge());
    assert.equal(diff(await shot(), beforeRestore), 0, 'replacement restores all traced pixels');
    const empty = await page.evaluate(() => window.check.empty());
    assert(empty.black);
    assert(empty.cancelled);
    assert(empty.invalid);
    assert.equal(empty.pngType, 'image/png');
    assert(empty.pngBytes > 50);
    const finished = await page.evaluate(() => window.check.finish());
    assert.equal(diff(await shot(), raster), 0, 'disposal restores every raster pixel');
    assert(finished.detached);
    assert.equal(finished.refusal.code, 'unsupported');
    assert.match(finished.refusal.message, /https:\/\/margoengine.com\/errors#/);
    assert.deepEqual(finished.errors, []);
    assert.deepEqual(errors, []);
    const row = {
      compat,
      hardware: context.hardware,
      triangles,
      tracedDifference,
      viewportSurface,
      images,
      restored,
      empty,
      ...finished,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  } finally {
    await page.evaluate(() => window.check.dispose());
    await context.close();
  }
}
await writeFile('test-results/staging-pathtrace.json', JSON.stringify(rows, null, 2) + '\n');
console.log('idle path-traced real-model still passed native and compatibility');
