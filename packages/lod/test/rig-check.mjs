// Real-GPU check of autoLOD on models that deform: every level of Fox.glb and MorphStressTest.glb, read back, sits where the
// source's own vertices sit at the same pose, and a hidden source stops deforming until it shows again.
// Run from the repository root after `npm run build:packages`: node packages/lod/test/rig-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'lod-rig' });
const context = await openBrowser({ startPath: '/packages/lod/test/rig-check.html', port: 5278 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('lod rig-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.deepEqual(r.errors, []);
  for (const [name, model] of [['Fox', r.fox], ['MorphStressTest', r.morph]]) {
    const [a, b] = model.levels;
    assert.ok(a.triangles < model.before * 0.65 && b.triangles < a.triangles, `${name} levels shrink: ${a.triangles}, ${b.triangles}`);
    for (const level of model.levels) {
      assert.ok(level.followers > 0, `${name}: the level deforms`);
      assert.equal(level.mapped, level.vertices, `${name}: every vertex of a level is one of the source's`);
    }
    assert.ok(model.moved > 0, `${name}: the pose moved the vertices`);
    assert.ok(model.worst < 1e-5, `${name}: a level sits on the source, ${model.worst} of the model's size away`);
    assert.equal(model.hiddenHeld, true, `${name}: a hidden source does not deform`);
    assert.equal(model.backMoved, true, `${name}: the source deforms again when it shows`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('lod rig-check: ok');
} finally {
  clearTimeout(timer);
  await context.close();
  release();
}
