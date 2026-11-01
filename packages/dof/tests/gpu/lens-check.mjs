// Real-GPU check for Autofocus and DOFLens. Takes a GPU slot itself. From the repository root, after building packages:
//   node packages/dof/tests/gpu/lens-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'dof-lens' });
const context = await openBrowser({ startPath: '/packages/dof/tests/gpu/lens.html', port: 5283 }),
  { page } = context;
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  // Bright pixels: their extent from a centre in each direction, inside rows or columns near a band.
  const bright = (image, top = 0, bottom = image.height) => {
    let up = Infinity,
      down = -1,
      left = Infinity,
      right = -1,
      count = 0;
    for (let y = top; y < bottom; y++)
      for (let x = 0; x < image.width; x++)
        if (image.data[(y * image.width + x) * 4] > 12) {
          count++;
          up = Math.min(up, y);
          down = Math.max(down, y);
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
    return { up, down, left, right, count, height: down - up + 1, width: right - left + 1 };
  };

  const focus = await page.evaluate(() => window.check.autofocus());
  console.log('autofocus', JSON.stringify(focus));
  assert.ok(Math.abs(focus.middle - 5.5) < 0.1, `middle pixel focuses on the near box, got ${focus.middle}`);
  assert.ok(Math.abs(focus.side - 14.5) < 0.2, `side pixel focuses on the far box, got ${focus.side}`);
  assert.ok(Math.abs(focus.target - 3) < 1e-3, `world target focuses at its distance, got ${focus.target}`);

  await page.evaluate(() => window.check.blades(0));
  const round = bright(await shot());
  await page.evaluate(() => window.check.blades(3));
  const triangle = bright(await shot());
  const middle = 256;
  const lopsided = (s) => Math.abs(middle - s.up - (s.down - middle));
  console.log('round', JSON.stringify(round), 'triangle', JSON.stringify(triangle));
  assert.ok(round.width > 20, 'the near box is blurred');
  assert.ok(lopsided(round) <= 3, `a round disk is even, got ${lopsided(round)}`);
  assert.ok(lopsided(triangle) >= 6, `three blades are lopsided, got ${lopsided(triangle)}`);
  assert.ok(triangle.count < round.count, 'the polygon lies inside the disk');

  // Clip y of the boxes: 2.8 / (10 tan 25 degrees). The plane runs through the top box and recedes downwards, so the
  // bottom box lies in the near field, where blur spreads over the background.
  const clip = 2.8 / (10 * Math.tan((25 * Math.PI) / 180)),
    tilt = 0.5,
    t = Math.tan(tilt) * clip * Math.tan((25 * Math.PI) / 180),
    focal = 10 * (1 + t);
  await page.evaluate(([a, b]) => window.check.tilt(a, b), [tilt, focal]);
  const tilted = await shot();
  const topBox = bright(tilted, 0, 256),
    bottomBox = bright(tilted, 256, 512);
  console.log('tilt', JSON.stringify({ topBox, bottomBox, focal }));
  assert.ok(bottomBox.width > topBox.width + 10, 'the tilted plane holds the top box in focus, not the bottom one');
  await page.evaluate(([a, b]) => window.check.tilt(a, b), [0, focal]);
  const flat = await shot();
  const flatTop = bright(flat, 0, 256),
    flatBottom = bright(flat, 256, 512);
  console.log('flat', JSON.stringify({ flatTop, flatBottom }));
  assert.ok(Math.abs(flatTop.width - flatBottom.width) <= 2, 'no tilt: both boxes blur alike');
  assert.ok(flatTop.width > topBox.width + 5, 'no tilt: the top box is out of focus');

  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
  console.log('dof lens check passed');
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  await release();
}
