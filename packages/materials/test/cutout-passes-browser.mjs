// Real-GPU regression test: a materials cut-out holds in the passes that do not run its colour shader. A click through
// a hole misses, a contact shadow keeps the map's UV transform and alphaMap, TAA writes no velocity through a hole, and
// `vertexColors: false` keeps vertex alpha out of all of them. Shadow maps are cutout-casters-browser.mjs.
// Run from the repository root after `npm run build:packages`: node packages/materials/test/cutout-passes-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'materials-cutout-passes' });
const context = await openBrowser({ startPath: '/packages/materials/test/cutout-passes.html', port: 5269 }),
  { page } = context,
  pageErrors = [],
  failures = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
// Whether each half keeps its surface, per material.
const surface = {
  plain: { left: true, right: true },
  map: { left: true, right: false },
  transform: { left: false, right: true },
  alphaMap: { left: true, right: false },
  alphaOnly: { left: true, right: false },
  vertexOff: { left: true, right: true },
  vertexOn: { left: false, right: false },
};
const luminance = (image, [x, y]) => {
  let sum = 0;
  for (let j = y - 2; j <= y + 2; j++)
    for (let i = x - 2; i <= x + 2; i++) {
      const o = (j * image.width + i) * 4;
      sum += (image.data[o] + image.data[o + 1] + image.data[o + 2]) / 3;
    }
  return sum / 25;
};
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
const measure = (label, image, bare, points, want) => {
  const row = { label };
  for (const half of ['left', 'right']) {
    const ratio = (row[half] = +(luminance(image, points[half]) / luminance(bare, points[half])).toFixed(3));
    if (want[half] ? ratio > 0.8 : ratio < 0.98) failures.push(`${label} ${half}: ${ratio} of the bare floor`);
  }
  console.log(JSON.stringify(row));
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const [name, want] of Object.entries({ ...surface, blended: surface.map })) {
    const { left, right, errors } = await page.evaluate((n) => window.check.pick(n), name);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ label: `pick ${name}`, left, right }));
    if (left !== want.left || right !== want.right) failures.push(`pick ${name}: left ${left}, right ${right}`);
  }
  await page.evaluate(() => window.check.contact());
  const bare = await shot();
  for (const [name, want] of Object.entries(surface)) {
    const { points, errors } = await page.evaluate((n) => window.check.contact(n), name);
    assert.deepEqual(errors, []);
    measure(`contact ${name}`, await shot(), bare, points, want);
  }
  // A static shadow redraws an opacity-mapped caster, whose rows it cannot watch: the swapped map moves the shadow.
  {
    const { points } = await page.evaluate(() => window.check.contact('alphaMap', true));
    assert.deepEqual(await page.evaluate(() => window.check.swap()), []);
    measure('contact static swap', await shot(), bare, points, { left: false, right: true });
  }
  for (const [name, want] of Object.entries(surface)) {
    const row = await page.evaluate((n) => window.check.taa(n), name);
    assert.deepEqual(row.errors, []);
    console.log(JSON.stringify({ label: `taa ${name}`, left: row.left, right: row.right, moved: row.expected }));
    for (const half of ['left', 'right']) {
      const moved = Math.abs(row[half] - row.expected) < row.expected * 0.15,
        still = Math.abs(row[half]) < row.expected * 0.15;
      if (want[half] ? !moved : !still) failures.push(`taa ${name} ${half}: ${row[half]}, moved ${row.expected}`);
    }
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failures, []);
  console.log('cut-outs hold in picking, contact shadows and TAA velocity');
} finally {
  await context.close?.();
  await release();
}
