import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ port: 'free', startPath: '/packages/toon/test/outline.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
const green = ([r, g, b]) => g > 150 && r < 90 && b < 90;
// Runs of outline pixels along the middle row.
const bands = (image) => {
  const y = Math.floor(image.height / 2),
    runs = [];
  let count = 0;
  for (let x = 0; x < image.width; x++) {
    if (green(pixel(image, x, y))) count++;
    else if (count) {
      runs.push(count);
      count = 0;
    }
  }
  return runs;
};
const shot = async (options) => {
  const result = await context.page.evaluate((o) => window.check.run(o), options);
  assert.deepEqual(result.errors, []);
  return decodePNG(await context.page.locator('canvas').screenshot());
};
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  // Screen-space width holds at two distances, and under a mirrored matrix.
  for (const distance of [5, 10])
    for (const scaleX of [1, -1]) {
      const runs = bands(await shot({ thickness: 5, screenspace: true, distance, scaleX }));
      console.log({ distance, scaleX, runs });
      assert.equal(runs.length, 2, 'two silhouette bands');
      for (const width of runs) assert.ok(width >= 4 && width <= 6, `5 px requested, ${width} measured`);
    }
  // World width shrinks with distance: 0.1 units at 5 and at 10.
  const near = bands(await shot({ thickness: 0.1, distance: 5 })),
    far = bands(await shot({ thickness: 0.1, distance: 10 }));
  console.log({ near, far });
  assert.equal(near.length, 2);
  assert.equal(far.length, 2);
  assert.ok(near[0] > far[0] * 1.5, 'world-unit line thins with distance');
  // A box with angle pi keeps a closed band at its edges; transparent blends the line with the background.
  const box = await shot({ shape: 'box', thickness: 0.08, angle: Math.PI });
  assert.equal(bands(box).length, 2, 'closed hull around the box');
  const solid = await shot({ thickness: 6, screenspace: true }),
    blended = await shot({ thickness: 6, screenspace: true, transparent: true, opacity: 0.5 });
  const edge = (image) => {
    const y = Math.floor(image.height / 2);
    for (let i = 0; i < image.width; i++)
      if (pixel(image, i, y)[1] > 60 && pixel(image, i, y)[0] < 40) return pixel(image, i + 2, y);
    return null;
  };
  const a = edge(solid),
    b = edge(blended);
  console.log({ solid: a, blended: b });
  assert.ok(a && a[1] > 240, 'opaque line is full green');
  assert.ok(b && b[1] > 60 && b[1] < 230, 'half-transparent line is blended');
  assert.deepEqual(errors, []);
} finally {
  await context.close();
}
