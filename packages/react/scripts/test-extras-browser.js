// React's multi-view (<Scene>, <View>), <BatchedMesh> and <SectionPlanes> on a real GPU: each mode is mounted in
// StrictMode, left to render, and checked by the colours in its screenshot. Takes the GPU lock.
//   npm run test:browser:extras --workspace @margoengine/react
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'react-extras-browser' });
const browser = await openBrowser({ port: 5198, startPath: '/packages/react/tests/extras-browser.html' }),
  { page, hardware } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
// Mean colour of a square of the screenshot around (x, y), in fractions of its size.
const sample = (image, x, y, half = 6) => {
  const sum = [0, 0, 0];
  let count = 0;
  for (let j = -half; j <= half; j++)
    for (let i = -half; i <= half; i++) {
      const at = (Math.round(y * image.height + j) * image.width + Math.round(x * image.width + i)) * 4;
      for (let c = 0; c < 3; c++) sum[c] += image.data[at + c];
      count++;
    }
  return sum.map((value) => Math.round(value / count));
};
const dominant = (rgb, channel) =>
  rgb[channel] > 60 && rgb[channel] > 1.6 * Math.max(...rgb.filter((_, c) => c !== channel));
const result = { hardware, checks: [] };
try {
  await page.waitForFunction(() => window.extras);
  const shot = async (mode) => {
    await page.evaluate((mode) => window.extras.mount(mode), mode);
    await page.waitForFunction(() => window.extras.state.frames >= 30, null, { timeout: 30_000 });
    return decodePNG(await page.locator('canvas').screenshot({ path: `test-results/react-extras-${mode}.png` }));
  };

  let image = await shot('views');
  const left = sample(image, 0.25, 0.5),
    right = sample(image, 0.75, 0.5);
  assert.ok(dominant(left, 0), `the main view shows the red box, got ${left}`);
  assert.ok(dominant(right, 1), `the hud view shows its scene's green box, got ${right}`);
  result.checks.push({ name: 'View + Scene: two views, two scenes, side by side', left, right });

  image = await shot('batched');
  const first = sample(image, 0.35, 0.5),
    second = sample(image, 0.65, 0.5);
  assert.ok(dominant(first, 0), `the first batched item is red, got ${first}`);
  assert.ok(dominant(second, 2), `the second batched item is blue, got ${second}`);
  result.checks.push({ name: 'BatchedMesh: two items, one batch, own colours and places', first, second });

  image = await shot('section');
  const kept = sample(image, 0.42, 0.5),
    cut = sample(image, 0.58, 0.5);
  assert.ok(dominant(kept, 0), `the left half of the box stays, got ${kept}`);
  assert.ok(!dominant(cut, 0), `the right half is cut away, got ${cut}`);
  result.checks.push({ name: 'SectionPlanes: one plane cuts away half the box', kept, cut });

  await page.evaluate(() => window.extras.unmount());
  assert.deepEqual(await page.evaluate(() => window.extras.state.errors), []);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/react-extras-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  release();
}
