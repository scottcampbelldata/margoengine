// Analytic depth/alpha transport on real WebGPU and on the full WebGL2 compatibility layer (--compat).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/packages/oit/test/gpu/exact.html', port: 'free' });
const { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const delta = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const over = (under, layers) =>
  layers.reduce((c, [rgb, alpha]) => c.map((v, i) => rgb[i] * alpha + v * (1 - alpha)), under);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const build = async (options) => {
    await page.evaluate((o) => window.check.build({ mode: 'peel', ...o }), options);
    const url = await page.evaluate(() => window.check.shot());
    return decodePNG(Buffer.from(url.split(',')[1], 'base64'));
  };
  const at = (image, x = image.width / 2, y = image.height / 2) => [
    ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
  ];
  const layers = [
    [[255, 255, 0], 0.5],
    [[0, 0, 255], 0.6],
    [[0, 255, 0], 0.4],
    [[255, 0, 0], 0.5],
  ];
  const report = [];
  for (const samples of [1, 4]) {
    const image = await build({ samples }),
      wanted = over(at(image, 4, 4), layers);
    const error = delta(at(image), wanted);
    assert.ok(error <= 2.5, `four layers: ${at(image)} vs ${wanted}`);
    const permuted = await build({ samples, order: [3, 1, 0, 2] });
    assert.deepEqual(permuted.data, image.data, 'draw order changes no pixel');
    const limited = await build({ samples, layers: 2 });
    assert.ok(delta(at(limited), over(at(image, 4, 4), layers.slice(2))) <= 1.5, 'keeps the nearest two');
    const blocked = await build({ samples, blocker: true });
    assert.ok(delta(at(blocked), over([255, 255, 255], layers.slice(2))) <= 1.5, 'opaque depth hides far layers');
    const cross = await build({ samples, tilted: true });
    assert.ok(
      delta(
        at(cross, 104, 128),
        over(at(cross, 4, 4), [
          [[0, 0, 255], 0.5],
          [[255, 0, 0], 0.5],
        ]),
      ) <= 1.5,
    );
    assert.ok(
      delta(
        at(cross, 152, 128),
        over(at(cross, 4, 4), [
          [[255, 0, 0], 0.5],
          [[0, 0, 255], 0.5],
        ]),
      ) <= 1.5,
    );
    const sorted = await build({ samples, mode: 'sorted', post: true }),
      post = await build({ samples, post: true });
    assert.ok(delta(at(sorted), at(post)) <= 1, 'post stack preserves layer transport');
    const transparent = await build({ samples, transparent: true });
    const alpha = transparent.data[(128 * 256 + 128) * 4 + 3] / 255;
    assert.ok(Math.abs(alpha - (1 - 0.5 * 0.6 * 0.4 * 0.5)) <= 2 / 255, 'valid canvas alpha');
    report.push({ samples, error });
  }
  assert.deepEqual(errors.concat(await page.evaluate(() => window.check.errors)), [], 'no shader or GPU errors');
  // Existing openly licensed Khronos sample data, licensed and sourced in THIRD-PARTY-NOTICES.md.
  await page.goto(new URL('/packages/oit/test/gpu/real.html', page.url()).href);
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const info = await page.evaluate(() =>
    window.check.build({
      samples: 1,
      mode: 'peel',
      url: '/examples/assets/khronos-samples/GlassVaseFlowers.glb',
    }),
  );
  assert.ok(info.transparent > 0);
  assert.ok((await page.evaluate(() => window.check.turn(90))) > 0, 'real BLEND primitives reach the peel pass');
  assert.deepEqual(
    errors.concat(await page.evaluate(() => window.check.errors)),
    [],
    'real glTF has no shader or GPU errors',
  );
  console.log(JSON.stringify(report));
  console.log('oit peeling passed');
} finally {
  await browser.close();
}
