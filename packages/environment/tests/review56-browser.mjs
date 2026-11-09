import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/environment/tests/review56-browser.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  for (const kind of ['unscoped-floor', 'floor', 'color', 'image'])
    for (const scissor of [false, true]) {
      await page.evaluate(() => window.check.init());
      // Match the partial frame's clear and view layout before adding the surface.
      assert.deepEqual(await page.evaluate((s) => window.check.draw('control', s), scissor), []);
      const before = await shot();
      assert.deepEqual(
        await page.evaluate(
          ({ kind, scissor }) =>
            window.check.draw(kind === 'unscoped-floor' ? 'floor' : kind, scissor, kind === 'unscoped-floor'),
          { kind, scissor },
        ),
        [],
      );
      const after = await shot();
      let inside = 0,
        outside = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 128; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * 128 + x) * 4 + c;
            if (before.data[i] !== after.data[i]) {
              if (x < (scissor ? 32 : 64)) inside++;
              else outside++;
            }
          }
      assert(inside > 100, `${kind} draws within its view`);
      if (kind === 'unscoped-floor') assert(outside > 100, 'negative control exposes an unscoped surface');
      else assert.equal(outside, 0, `${kind} preserves every component outside viewport/scissor`);
    }
  for (const kind of ['Reflector', 'Refractor', 'CubeCamera']) {
    const row = await page.evaluate((kind) => window.check.owner(kind), kind);
    assert(row.captured, `${kind} captures`);
    assert(row.red > 100, `${kind} captures owner background`);
    assert(row.green > 30, `${kind} captures owner product`);
    assert.equal(row.blue, 0, `${kind} excludes default scene`);
    assert(row.detached && row.isolated && row.replaced, `${kind} detaches, isolates names and permits replacement`);
    assert.deepEqual(row.errors, []);
    console.log(kind, JSON.stringify(row));
  }
  const studio = await page.evaluate(() => window.check.finiteStudio());
  assert.deepEqual(studio.outputs[1], studio.outputs[0], 'extreme studio retains every GPU cube texel');
  assert.deepEqual(studio.outputs[2], studio.outputs[0], 'subnormal studio retains every GPU cube texel');
  assert(
    studio.outputs[0].some((v, i) => i % 4 !== 3 && v > 0),
    'studio softbox emits',
  );
  assert.deepEqual(studio.errors, []);
  assert.deepEqual(await page.evaluate(() => window.check.dispose()), []);
  assert.deepEqual(errors, []);
  console.log(
    'environment half-canvas and independent scissor: 6 exact view cases, 3 owner captures and exact finite studio cube pixels passed',
  );
} finally {
  await context.close();
}
