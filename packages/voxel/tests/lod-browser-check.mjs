// Real-GPU proof of VoxelRenderer `scale` and @margoengine/voxel/lod (run from the repository root after building
// packages, one GPU job at a time: node scripts/gpu-lock.mjs run --owner=voxel-lod -- node
// packages/voxel/tests/lod-browser-check.mjs):
// - a world drawn at scale 2 from twice the eye, near and far gives the image it gives at scale 1, up to samples on
//   quad edges (positions in float32 round differently once doubled): under 1% of the drawn pixels, no 2 x 2 block;
// - four far levels of noiseTerrainLod, one scaled renderer each, draw terrain to the horizon from 90 blocks up;
// - no WebGPU validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/lod-browser-check.html',
  port = 5223,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const s = await page.evaluate(() => window.check.scaled());
  report.results.scaled = s;
  assert.equal(s.repeat.differing, 0, `scale 1 drawn twice differs: ${JSON.stringify(s.repeat)}`);
  assert.ok(s.scaled.lit > 20000, `too little drawn: ${JSON.stringify(s.scaled)}`);
  assert.ok(s.scaled.differing <= s.scaled.lit / 100 && s.scaled.blocks === 0, `scale 2: ${JSON.stringify(s.scaled)}`);
  assert.equal(s.stats[0].quads, s.stats[1].quads);
  console.log(`ok scale 2 against scale 1: ${s.scaled.differing} of ${s.scaled.lit} drawn pixels on quad edges`);
  const f = await page.evaluate(() => window.check.far());
  report.results.far = f;
  assert.ok(
    f.chunks.every((n) => n > 0),
    `a level drew nothing: ${JSON.stringify(f)}`,
  );
  assert.ok(f.drawn > f.total * 0.4 && f.top < 110, `far levels: ${JSON.stringify(f)}`);
  console.log(
    `ok far levels: nodes ${f.nodes}, quads ${f.quads}, ${f.drawn} of ${f.total} pixels, horizon row ${f.top}`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-lod-browser-check.json', JSON.stringify(report, null, 1));
  console.log('voxel lod browser check passed');
} finally {
  await context.close();
}
