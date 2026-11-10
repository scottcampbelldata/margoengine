import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ port: 'free', startPath: '/packages/toon/test/screen-outline.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
const green = (image, x, y) => {
  const i = (y * image.width + x) * 4,
    p = image.data;
  return p[i + 1] > 150 && p[i] < 90 && p[i + 2] < 90;
};
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const kind of ['core', 'mesh'])
    for (const ortho of [false, true])
      for (const distance of [5, 10]) {
        const result = await context.page.evaluate((a) => window.check.run(...a), [kind, distance, 5, ortho]);
        assert.deepEqual(result.errors, []);
        const image = await decodePNG(await context.page.locator('canvas').screenshot());
        const y = Math.floor(image.height / 2),
          runs = [];
        let count = 0;
        for (let x = 0; x < image.width; x++) {
          if (green(image, x, y)) count++;
          else if (count) {
            runs.push(count);
            count = 0;
          }
        }
        console.log({ kind, ortho, distance, runs });
        assert.equal(runs.length, 2, 'two silhouette bands');
        for (const width of runs) assert.ok(width >= 4 && width <= 6, `5 px requested, ${width} measured`);
      }
  for (const pose of [0.1, 0.6]) {
    const result = await context.page.evaluate((p) => window.check.run('fox', 5, 5, false, p), pose);
    assert.deepEqual(result.errors, []);
    const image = await decodePNG(await context.page.locator('canvas').screenshot());
    let ink = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) ink += +green(image, x, y);
    assert.ok(ink > 500, 'real animated Fox has an outline');
    console.log({ pose, ink });
  }
  assert.deepEqual(errors, []);
} finally {
  await context.close();
}
