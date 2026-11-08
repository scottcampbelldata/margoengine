// Real-GPU proof of @margoengine/voxel/smooth (run from the repository root after building packages, one GPU job at a
// time: node scripts/gpu-lock.mjs run --owner=voxel-smooth -- node packages/voxel/tests/smooth-browser-check.mjs): a
// smooth terrain drawn by SmoothTerrainView as core meshes, green grass on top, beside a VoxelRenderer stone tower in
// the same frame; carving a ball out of the hill re-meshes only the chunks it touches and changes the picture there;
// no WebGPU validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/smooth-browser-check.html',
  port = 5229,
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
  assert.equal(r.stats.chunks, 9);
  assert.equal(r.meshed[0], 9);
  const [gr, gg, gb] = r.grass;
  assert.ok(gg > 40 && gg > 1.3 * gr && gg > 1.3 * gb, `the hill top should be green: ${r.grass}`);
  const [tr, tg, tb] = r.tower;
  assert.ok(tr > 20 && Math.max(tr, tg, tb) - Math.min(tr, tg, tb) < 20, `the block tower should be grey: ${r.tower}`);
  assert.ok(r.carved > 500, `carved ${r.carved} cells`);
  assert.ok(
    r.dirty >= 1 && r.dirty <= 4 && r.meshed[1] === r.dirty,
    `re-meshed ${r.meshed[1]} of ${r.dirty} dirty chunks`,
  );
  const [h0, h1] = r.hill,
    change = Math.max(...h0.map((v, i) => Math.abs(v - h1[i])));
  assert.ok(change > 10, `the carved hill should look different: ${h0} then ${h1}`);
  console.log(
    `ok smooth terrain: grass [${r.grass.map(Math.round)}], tower [${r.tower.map(Math.round)}], carved ${r.carved} cells`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-smooth-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel smooth terrain browser check passed');
} finally {
  await context.close();
}
