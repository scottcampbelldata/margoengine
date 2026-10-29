// Real-GPU proof of B6 (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/objects-check.mjs
// The zero-configuration biome world draws trees, shrubs, rocks and grass over its terrain, lit and varied.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/biomes/tests/objects-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/biomes-objects-check.json', JSON.stringify({ hardware, result: r }, null, 1));
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  assert.ok(r.objects > 10000, `objects streamed: ${r.objects}`);
  assert.equal(r.held.error, null, `holding ${r.held.far} tiles of trees and ${r.held.near} of small plants`);
  // The places that meet the most tiles (more than the 100 and 25 slots the objects had).
  assert.ok(r.held.far > 98 && r.held.near > 25, `tiles held: ${JSON.stringify(r.held)}`);
  // Objects cover a good share of the frame and add contrast (lit crowns, shadowed sides, trunks).
  assert.ok(r.changed > 0.1, `share of pixels the objects change: ${r.changed}`);
  assert.ok(r.full.sd > 0.015 && r.full.mean > 0.01, `lit and varied: ${JSON.stringify(r.full)}`);
  assert.ok(Math.abs(r.afterDispose.mean - r.full.mean) > 1e-3, 'a disposed view draws nothing');
  console.log(
    'ok biomes objects:',
    r.objects,
    'objects,',
    (r.bytes / 1048576).toFixed(1),
    'MB on the GPU, changed',
    r.changed.toFixed(3),
    'luma',
    r.full.mean.toFixed(3),
    r.full.sd.toFixed(3),
  );
} finally {
  await context.close();
}
