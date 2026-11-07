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
  const { levels, farNear, farAway } = r.textured;
  assert.deepEqual(levels.map((l) => l.level), [0, 1, 2], 'a materials mesh walks its levels');
  for (const l of levels) assert.ok(l.red > 0 && l.green > 0, `every level keeps the texture: ${JSON.stringify(l)}`);
  assert.equal(farNear.visible, true);
  assert.equal(farAway.visible, false);
  assert.equal(farAway.meshes, 1, 'one material, one far mesh');
  assert.ok(farAway.red > 0 && farAway.green > 0, `the far mesh keeps the texture: ${JSON.stringify(farAway)}`);
  const model = r.loaded;
  assert.ok(model.triangles[0] < model.before * 0.65 && model.triangles[1] < model.triangles[0], `levels shrink: ${model.triangles}`);
  assert.deepEqual(model.views.map((v) => v.level), [0, 1, 2], 'a loaded model walks its levels');
  for (const v of model.views)
    assert.ok(v.pixels > 0 && Math.max(...v.colour) > 40 && v.spread > 8, `lit and textured: ${JSON.stringify(v)}`);
  assert.ok(model.views[0].pixels > model.views[1].pixels && model.views[1].pixels > model.views[2].pixels);
  assert.equal(model.near.shown, true);
  assert.equal(model.far.shown, false);
  assert.ok(
    model.far.meshes === 1 && model.far.pixels > 0 && model.far.spread > 8,
    `the far model draws: ${JSON.stringify(model.far)}`,
  );
  for (const [name, { level, triangles, plain, baked }] of Object.entries(r.baked)) {
    assert.equal(level, 1, `${name}: the check looks at a level`);
    assert.ok(triangles < 3000, `${name}: a tenth of the triangles: ${triangles}`);
    assert.ok(plain.rms > 4, `${name}: without a map the level has lost the lumps: ${JSON.stringify(plain)}`);
    assert.ok(baked.rms < plain.rms * 0.6, `${name}: with one it keeps them: ${JSON.stringify({ plain, baked })}`);
  }
  assert.ok(r.moving.after > r.moving.before + 20, `a far mesh follows its source: ${JSON.stringify(r.moving)}`);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  clearTimeout(timer);
  await context.close?.();
  await release?.();
}
