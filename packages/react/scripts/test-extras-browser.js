// React's multi-view (<Scene>, <RenderView>), <BatchedMesh>, <Voxels> and <Sky> on a real GPU: each mode is mounted in
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
const warnings = [];
page.on('console', (message) => {
  if (message.type() === 'warning') warnings.push(message.text());
  // React's own complaint about the <mesh> the hints check renders on purpose.
  if (message.type() === 'error' && !/is unrecognized in this browser.* mesh$/.test(message.text())) errors.push(message.text());
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
  // A frame count is not readiness: on a slower GPU the first 30 frames can show only the clear colour while the
  // batched mesh's pipelines compile (the audit saw only the dark background). So after 30 frames the screenshot is taken
  // again, five frames apart, until `drawn` holds for it or 30 s have passed (the assertion below then reports what the
  // last picture showed).
  const shot = async (mode, drawn = () => true) => {
    await page.evaluate((mode) => window.extras.mount(mode), mode);
    await page.waitForFunction(() => window.extras.state.frames >= 30, null, { timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const image = await decodePNG(
        await page.locator('#app canvas').screenshot({ path: `test-results/react-extras-${mode}.png` }),
      );
      if (drawn(image) || Date.now() > deadline) return image;
      const frames = await page.evaluate(() => window.extras.state.frames);
      await page.waitForFunction((n) => window.extras.state.frames >= n + 5, frames, { timeout: 30_000 });
    }
  };

  let image = await shot('views', (i) => dominant(sample(i, 0.25, 0.5), 0) && dominant(sample(i, 0.75, 0.5), 1));
  const left = sample(image, 0.25, 0.5),
    right = sample(image, 0.75, 0.5);
  assert.ok(dominant(left, 0), `the main view shows the red box, got ${left}`);
  assert.ok(dominant(right, 1), `the hud view shows its scene's green box, got ${right}`);
  result.checks.push({ name: 'View + Scene: two views, two scenes, side by side', left, right });

  const greenPixels = (image) => {
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (dominant(image.data.slice(i, i + 3), 1)) count++;
    return count;
  };
  image = await shot('grid-scene', (image) => greenPixels(image) > 0);
  const gridPixels = greenPixels(image);
  assert.ok(gridPixels > 0, 'a view drawing only the secondary Scene must show its Grid');
  result.checks.push({ name: 'Grid draws in its enclosing secondary Scene', gridPixels });

  image = await shot('batched', (i) => dominant(sample(i, 0.35, 0.5), 0) && dominant(sample(i, 0.65, 0.5), 2));
  const first = sample(image, 0.35, 0.5),
    second = sample(image, 0.65, 0.5);
  assert.ok(dominant(first, 0), `the first batched item is red, got ${first}`);
  assert.ok(dominant(second, 2), `the second batched item is blue, got ${second}`);
  result.checks.push({ name: 'BatchedMesh: two items, one batch, own colours and places', first, second });

  image = await shot('helpers', (i) => dominant(sample(i, 0.5, 0.5), 0) && dominant(sample(i, 0.5, 0.7), 0));
  const framed = [sample(image, 0.5, 0.5), sample(image, 0.5, 0.7)];
  for (const rgb of framed) assert.ok(dominant(rgb, 0), `Bounds frames the far box, got ${rgb}`);
  const panels = await page.evaluate(
    () =>
      new Promise((done) =>
        setTimeout(
          () =>
            done(
              document.documentElement.innerHTML.length &&
                [...document.querySelectorAll('*')]
                  .flatMap((e) =>
                    e.shadowRoot ? [...e.shadowRoot.querySelectorAll('.name')] : [...(e.matches('.name') ? [e] : [])],
                  )
                  .map((n) => n.textContent),
            ),
          1000,
        ),
      ),
  );
  assert.ok(
    panels.some((name) => /^Red in App$/.test(name)),
    `the inspector tree names the Red component, got ${panels}`,
  );
  result.checks.push({
    name: 'Bounds, Float, Billboard, Grid and DevTools on a real engine',
    framed,
    panels: panels.length,
  });

  image = await shot('voxels', (i) => dominant(sample(i, 0.5, 0.5), 0));
  const block = sample(image, 0.5, 0.5),
    corner = sample(image, 0.03, 0.05);
  assert.ok(dominant(block, 0), `the voxel world draws its red stone, got ${block}`);
  assert.ok(!dominant(corner, 0), `the corner shows the background, got ${corner}`);
  result.checks.push({ name: 'Voxels: a VoxelWorld meshed in workers and lit by VoxelLighting', block, corner });

  // A metal sphere under Sky-only light: the sky's fallback environment lights it; without it the metal is black.
  const brightness = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;
  image = await shot('sky-metal-off');
  const unlit = sample(image, 0.5, 0.5, 10);
  image = await shot('sky-metal', (i) => brightness(sample(i, 0.5, 0.5, 10)) > 40);
  const metal = sample(image, 0.5, 0.5, 10);
  assert.ok(brightness(unlit) < 30, `without the fallback the metal sphere is black, got ${unlit}`);
  assert.ok(brightness(metal) > 40, `a metal sphere under Sky-only light is not black, got ${metal}`);
  assert.ok(
    brightness(metal) > 3 * brightness(unlit),
    `the fallback environment lights the metal, ${unlit} -> ${metal}`,
  );
  result.checks.push({ name: 'Sky: a metal sphere lit only by the sky is not black', unlit, metal });

  // The hints' guard needs no global `process`: Vite replaces the expression and defines none (the page proves it).
  assert.equal(await page.evaluate(() => typeof process), 'undefined');
  await shot('hints');
  assert.ok(
    warnings.some((text) => /<mesh> is a DOM element/.test(text)),
    `the lowercase tag hint prints, got ${warnings}`,
  );
  await shot('hints-webgl2');
  assert.ok(
    warnings.some((text) => /never fire on the WebGL2 fallback/.test(text)),
    `the picking hint prints, got ${warnings}`,
  );
  result.checks.push({ name: 'Development hints print on a page served by Vite' });

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
