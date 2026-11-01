// Real-GPU check of hierarchicalLOD and autoLOD: past the distance, one far mesh per cell replaces its boxes, so the meshes drawn
// fall to the number of cells; close by, and after remove(), every box draws again.
// Run from the repository root after `npm run build:packages`: node packages/lod/test/auto-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'lod-auto' });
const context = await openBrowser({ startPath: '/packages/lod/test/auto-check.html', port: 5277 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('lod auto-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.equal(r.cells, 16);
  assert.equal(r.farMeshes, 16);
  assert.equal(r.close, r.near, 'close by, the boxes draw as before');
  assert.ok(r.far <= r.cells && r.far > 0, `far away, a mesh per cell: ${r.far}`);
  assert.equal(r.restored, r.near, 'remove() brings the boxes back');
  assert.ok(r.triangles[1] < r.triangles[0] && r.triangles[2] < r.triangles[1], `levels shrink: ${r.triangles}`);
  assert.equal(r.ballNear, 0);
  assert.equal(r.ballFar, 2);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  clearTimeout(timer);
  await context.close?.();
  await release?.();
}
