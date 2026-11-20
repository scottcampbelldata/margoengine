// Real-GPU proof of @margoengine/voxel/smooth-lod (run from the repository root after building packages, one GPU job at
// a time: node scripts/run-with-timeout.mjs -- node packages/voxel/tests/smooth-lod-browser-check.mjs):
// real smooth chunks with capped faces and three SmoothLod far levels seen from above against a magenta sky; with caps no
// sky pixel shows through the ground; no WebGPU validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/smooth-lod-browser-check.html',
  port = 5244,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.deepEqual(r.skirted.stats.lod.nodes.map((n) => n > 0), [true, true, true]);
  assert.ok(r.skirted.sky > 100, `the sky should show past the far levels: ${r.skirted.sky}`);
  assert.equal(r.skirted.holes, 0, `${r.skirted.holes} sky pixels show through the ground`);
  assert.ok(r.bare.holes > 0, "without caps the seams should let the sky through: the check would miss cracks");
  console.log(`ok smooth far levels: 0 holes with caps, ${r.bare.holes} without`);
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-smooth-lod-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel smooth far levels browser check passed');
} finally {
  await context.close();
}
