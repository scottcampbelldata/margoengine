// Real-GPU test of virtual shadow feedback (row 21.6 stage 3).
//  1. A fixed camera asks for an exact page count per level (LEVEL_PAGES, recorded once from the first good run).
//  2. A page missing for a frame samples the coarser level: no pixel reads lit (visibility 1) where the cascades say deep
//     shade, on the very first frame of a new effect, on the frame after a camera jump, and with a budget too small for
//     the finest pages.
// Run from the repository root after `npm run build:packages`. Writes test-results/virtual-feedback.json.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

// Pages per level, finest first, for pose 'near' with the default 8 levels and distance 500.
const LEVEL_PAGES = [0, 40, 38, 27, 12, 0, 0, 4],
  // A deep-shade pixel has cascade shade within this many pixels all around, wider than a coarsest-level texel on screen.
  DEEP = 4;
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-virtual-feedback' });
const context = await openBrowser({ startPath: '/packages/shadows/test/virtual-feedback.html', port: 5269 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luma = (img) => {
  const out = new Float32Array(img.width * img.height);
  for (let p = 0; p < out.length; p++)
    out[p] =
      0.2126 * linear(img.data[p * 4]) + 0.7152 * linear(img.data[p * 4 + 1]) + 0.0722 * linear(img.data[p * 4 + 2]);
  return out;
};
const shot = async () => luma(await decodePNG(await page.locator('canvas').screenshot()));
const call = async (method, ...args) => {
  const out = await page.evaluate(([m, a]) => window.check[m](...a), [method, args]);
  assert.deepEqual(out.errors, [], `${method} ${args}`);
  return out.stats;
};
const W = 1280,
  H = 720;
/** The cascades' deep shade at a pose, as the pixels a test must not read lit, and open and dark for visibility. */
const reference = async (pose) => {
  await call('reference', pose, 'open');
  const open = await shot();
  await call('reference', pose, 'dark');
  const dark = await shot();
  await call('reference', pose, 'cascades');
  const cascades = await shot(),
    shade = new Uint8Array(W * H),
    deep = [];
  for (let p = 0; p < W * H; p++)
    if (open[p] - dark[p] > 0.02 && (cascades[p] - dark[p]) / (open[p] - dark[p]) < 0.02) shade[p] = 1;
  for (let y = DEEP; y < H - DEEP; y++)
    for (let x = DEEP; x < W - DEEP; x++) {
      if (!shade[y * W + x]) continue;
      let all = true;
      for (let j = -DEEP; all && j <= DEEP; j++)
        for (let i = -DEEP; all && i <= DEEP; i++) all = !!shade[(y + j) * W + x + i];
      if (all) deep.push(y * W + x);
    }
  return { open, dark, deep };
};
const holes = (image, { open, dark, deep }) => {
  let count = 0;
  for (const p of deep) if ((image[p] - dark[p]) / (open[p] - dark[p]) > 0.98) count++;
  return count;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const near = await reference('near'),
    far = await reference('far');
  assert.ok(near.deep.length > 2000 && far.deep.length > 500, `deep shade ${near.deep.length} ${far.deep.length}`);

  const first = await call('fresh', 'near', 1),
    firstHoles = holes(await shot(), near);
  const settled = await call('fresh', 'near', 6),
    settledHoles = holes(await shot(), near);
  const again = await call('jump', 'near', 2);
  const jumped = await call('jump', 'far', 1),
    jumpHoles = holes(await shot(), far);
  const jumpSettled = await call('jump', 'far', 5);
  const tight = await call('fresh', 'near', 6, { budgetPages: 12 }),
    tightHoles = holes(await shot(), near);
  const result = {
    deepNear: near.deep.length,
    deepFar: far.deep.length,
    first,
    firstHoles,
    settled,
    settledHoles,
    jumped,
    jumpHoles,
    jumpSettled,
    tight,
    tightHoles,
    pageErrors,
  };
  console.log(JSON.stringify(result));
  await writeFile('test-results/virtual-feedback.json', JSON.stringify(result, null, 2));
  assert.deepEqual(pageErrors, []);
  // Before any feedback only the caster's coarsest pages exist.
  assert.ok(first.levelPages.slice(0, -1).every((n) => n === 0) && first.levelPages.at(-1) > 0, 'first frame pages');
  assert.deepEqual(settled.levelPages, LEVEL_PAGES, 'pages per level at a fixed camera');
  assert.deepEqual(again.levelPages, settled.levelPages, 'a still camera keeps asking for the same pages');
  assert.equal(firstHoles, 0, 'first frame, feedback not back yet');
  assert.equal(settledHoles, 0, 'settled');
  assert.equal(jumpHoles, 0, 'frame after a camera jump');
  assert.ok(tight.overflow > 0 || tight.residentPages === 12, 'the budget must bind in this case');
  assert.ok(tight.residentPages <= 12);
  assert.equal(tightHoles, 0, 'budget smaller than the request');
  console.log('shadows virtual feedback: ok');
} finally {
  await context.close?.();
  await release?.();
}
