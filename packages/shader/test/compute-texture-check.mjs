// Real-adapter check (run from the repository root after building packages): node packages/shader/test/compute-texture-check.mjs
// Ping-pong generations against a CPU run, a material following the swapping pair, every storage format through a second
// pass, a blur that samples in compute, in-place r32float, and data coming back after dispose.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({
  startPath: '/packages/shader/test/compute-texture-check.html',
  port: 5219,
});
const { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const { seed, size } = await page.evaluate(() => ({ seed: window.check.seed(), size: window.check.size }));
  let cells = Array.from({ length: size * size }, (_, i) => seed[i * 4] > 127);
  for (let g = 0; g < 8; g++) {
    const next = cells.map((alive, i) => {
      const x = i % size,
        y = (i - x) / size;
      let n = 0;
      for (let dy = -1; dy < 2; dy++)
        for (let dx = -1; dx < 2; dx++)
          if ((dx || dy) && cells[((y + dy + size) % size) * size + ((x + dx + size) % size)]) n++;
      return n === 3 || (n === 2 && alive);
    });
    cells = next;
  }
  const life = await page.evaluate(() => window.check.life());
  assert.equal(life.error, null);
  assert.deepEqual(life.errors, []);
  const got = Array.from({ length: size * size }, (_, i) => life.texels[i * 4] > 127);
  assert.deepEqual(got, cells, 'eight generations match the CPU');
  assert.ok(cells.some(Boolean), 'the pattern is still alive');
  console.log('ok life');

  const { shots, errors } = await page.evaluate(() => window.check.follows());
  assert.deepEqual(errors, []);
  const centre = async (url) => {
    const image = await decodePNG(Buffer.from(url.split(',')[1], 'base64')),
      o = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    return [...image.data.slice(o, o + 3)];
  };
  const colours = await Promise.all(shots.map(centre));
  console.log('ok follows', JSON.stringify(colours));
  assert.ok(colours[0][0] > 200 && colours[0][1] < 30, 'red frame ' + colours[0]);
  assert.ok(colours[1][1] > 200 && colours[1][0] < 30, 'green frame ' + colours[1]);
  assert.ok(colours[2][2] > 200 && colours[2][1] < 30, 'blue frame ' + colours[2]);

  const formats = [
    ['rgba8unorm', [1, 0, 0.2, 1], [1, 0, 0.2, 1], 0.003],
    ['rgba8snorm', [-1, 0.5, 0, 1], [-1, 0.5, 0, 1], 0.01],
    ['rgba8uint', [200, 1, 2, 3], [200, 1, 2, 3], 0],
    ['rgba8sint', [-100, 1, 2, 3], [-100, 1, 2, 3], 0],
    ['rgba16float', [2.5, -3, 0.25, 1], [2.5, -3, 0.25, 1], 0],
    ['rgba16uint', [60000, 1, 2, 3], [60000, 1, 2, 3], 0],
    ['rgba16sint', [-30000, 1, 2, 3], [-30000, 1, 2, 3], 0],
    ['r32float', [1.5, 9, 9, 9], [1.5, 0, 0, 1], 0],
    ['r32uint', [4000000000, 9, 9, 9], [4000000000, 0, 0, 1], 0],
    ['r32sint', [-2000000000, 9, 9, 9], [-2000000000, 0, 0, 1], 0],
    ['rg32float', [1.5, -2.5, 9, 9], [1.5, -2.5, 0, 1], 0],
    ['rg32uint', [7, 8, 9, 9], [7, 8, 0, 1], 0],
    ['rg32sint', [-7, 8, 9, 9], [-7, 8, 0, 1], 0],
    ['rgba32float', [1e6, -2, 3, 4], [1e6, -2, 3, 4], 0],
    ['rgba32uint', [4000000000, 2, 3, 4], [4000000000, 2, 3, 4], 0],
    ['rgba32sint', [-2000000000, 2, 3, 4], [-2000000000, 2, 3, 4], 0],
  ];
  const stored = await page.evaluate((list) => window.check.formats(list), formats.map((f) => [f[0], f[1]]));
  assert.deepEqual(stored.errors, []);
  for (const [format, , expected, tolerance] of formats) {
    const { error, first } = stored.out[format];
    assert.equal(error, null, format);
    first.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tolerance, `${format}: ${first} != ${expected}`));
  }
  console.log('ok formats', formats.length);

  const blur = await page.evaluate(() => window.check.blur());
  assert.equal(blur.error, null);
  assert.deepEqual(blur.errors, []);
  blur.row.forEach((v, x) =>
    assert.ok(Math.abs(v - ([3, 4, 5].includes(x) ? 1 / 3 : 0)) < 0.002, `blur at ${x}: ${blur.row}`),
  );
  console.log('ok blur');

  const inPlace = await page.evaluate(() => window.check.inPlace());
  if (inPlace.skipped) console.log('in-place skipped: the browser lacks the WGSL feature');
  else {
    assert.equal(inPlace.error, null);
    assert.deepEqual(inPlace.errors, []);
    assert.deepEqual(inPlace.values, Array(16).fill(3));
    console.log('ok in place');
  }
  const restored = await page.evaluate(() => window.check.restored());
  assert.deepEqual(restored.before, [1, 2, 3, 4]);
  assert.deepEqual(restored.after, [1, 2, 3, 4]);
  assert.deepEqual(pageErrors, []);
  console.log('compute texture check passed');
} finally {
  await context.close();
}
