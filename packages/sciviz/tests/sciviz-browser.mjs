// Real-GPU checks of @margoengine/sciviz (one GPU job at a time; from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sciviz/tests/sciviz-browser.mjs
// The page (sciviz-browser.js) draws each layer and reads the canvas back: surfaces coloured by height with contours
// and NaN holes, volumes (composite, maximum intensity, clip planes), slices, GPU isosurfaces with exactly the CPU
// table's triangles (from CPU data and from a GpuArray), a million-point scatter within its budget, and the axes,
// tick labels and colour bar. Results go to test-results/sciviz-browser.json; a screenshot to sciviz-browser.png.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

// The dev server serves the repository root, whichever folder `npm run test:browser` starts in.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 5243 });
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(600_000);
try {
  await page.waitForFunction(() => typeof window.runSciVizTests === 'function');
  const report = await page.evaluate(() => window.runSciVizTests());
  assert.deepEqual(errors, []);
  // A real mouse drag in box mode selects the points of the right half (data x > 1.5) and nothing else.
  const rect = await page.evaluate(() => window.setupDragTest());
  await page.mouse.move(rect.left + rect.width / 2, rect.top + 2);
  await page.mouse.down();
  await page.mouse.move(rect.left + rect.width * 0.75, rect.top + rect.height / 2, { steps: 4 });
  await page.mouse.move(rect.left + rect.width - 2, rect.top + rect.height - 2, { steps: 4 });
  await page.mouse.up();
  const drag = await page.evaluate(() => window.finishDragTest());
  assert.deepEqual(drag, { indices: [2, 3, 6, 7, 10, 11, 14, 15], mode: 'box' });
  report.checks.push('a real box drag selects the points under it');
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sciviz-browser.json', JSON.stringify({ hardware, ...report }, null, 2));
  // The site demos built on this package start, finish their first result and log no errors.
  for (const demo of ['sciviz-surface', 'sciviz-volume', 'sciviz-points']) {
    await page.goto(new URL(`/examples/${demo}.html`, page.url()).href);
    await page.waitForFunction(() => document.querySelector('#viewport')?.dataset.ready === 'true', null, {
      timeout: 120_000,
    });
    await page.waitForTimeout(500);
    const status = await page.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.deepEqual(errors, [], `${demo}: ${status}`);
    assert.doesNotMatch(status, /Could not/, `${demo}: ${status}`);
    report.checks.push(`demo ${demo} runs: ${status}`);
  }
  for (const name of report.checks) console.log(`ok - ${name}`);
  console.log(`${report.checks.length} sciviz browser checks passed`);
} finally {
  await context.close();
}
