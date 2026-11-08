// The lowercase tags of @margoengine/react/jsx-runtime on a real GPU: a page compiled with jsxImportSource
// '@margoengine/react' draws <mesh>, <group>, <boxGeometry>, <meshStandardMaterial>, <directionalLight> and an extend()
// tag, checked by the colours of its screenshot. Takes the GPU lock.
//   npm run test:browser:tags --workspace @margoengine/react
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'react-tags-browser' });
const browser = await openBrowser({ port: 5381, startPath: '/packages/react/tests/tags-browser.html' }),
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
  await page.waitForFunction(() => window.tags);
  // After 30 frames the screenshot is taken again, five frames apart, until `drawn` holds or 30 s have passed.
  const shot = async (mode, drawn) => {
    await page.evaluate((mode) => window.tags.mount(mode), mode);
    await page.waitForFunction(() => window.tags.state.frames >= 30, null, { timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const image = await decodePNG(
        await page.locator('#app canvas').screenshot({ path: `test-results/react-tags-${mode}.png` }),
      );
      if (drawn(image) || Date.now() > deadline) return image;
      const frames = await page.evaluate(() => window.tags.state.frames);
      await page.waitForFunction((n) => window.tags.state.frames >= n + 5, frames, { timeout: 30_000 });
    }
  };
  const image = await shot('tags', (i) => dominant(sample(i, 0.3, 0.5), 0) && dominant(sample(i, 0.7, 0.5), 2));
  const box = sample(image, 0.3, 0.5),
    sphere = sample(image, 0.7, 0.5),
    gap = sample(image, 0.5, 0.5);
  assert.ok(dominant(box, 0), `<mesh><boxGeometry><meshStandardMaterial> draws the red box, got ${box}`);
  assert.ok(dominant(sphere, 2), `the extend() tag <sphereGeometry> draws the blue sphere, got ${sphere}`);
  assert.ok(!dominant(gap, 0) && !dominant(gap, 2), `nothing is drawn between them, got ${gap}`);
  assert.equal(await page.locator('#app mesh, #app group, #app sphereGeometry').count(), 0, 'no tag reached the DOM');
  result.checks.push({ name: 'Lowercase tags and an extend() tag draw on a real engine', box, sphere, gap });

  await page.evaluate(() => window.tags.unmount());
  assert.deepEqual(await page.evaluate(() => window.tags.state.errors), []);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/react-tags-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  release();
}
