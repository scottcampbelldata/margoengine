// Real-GPU check of LODFade: halfway through a switch the two levels share the shape's pixels with no hole, and at the
// end only the new level draws, on core meshes, materials meshes, Geometry levels and a level that goes to nothing.
// Run from the repository root after `npm run build:packages`: node packages/lod/test/fade-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'lod-fade' });
const context = await openBrowser({ startPath: '/packages/lod/test/fade-check.html', port: 5279 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('lod fade-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
const near = (value, target, slack, label) =>
  assert.ok(Math.abs(value - target) <= slack, `${label}: ${value}, expected about ${target}`);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  for (const name of ['core', 'model']) {
    const { begun, left, start, middle, late, end, level } = r[name],
      total = start.red;
    assert.ok(total > 1000 && start.green === 0, `${name}: the first level alone: ${JSON.stringify(start)}`);
    assert.equal(begun, 1, `${name}: the switch starts a fade`);
    assert.equal(left, 0, `${name}: and it ends`);
    assert.equal(level, 1);
    // At 30 units the shape is smaller, so compare the shares with what the end frame covers.
    const covered = end.green;
    assert.ok(covered > 0 && end.red === 0, `${name}: the new level alone at the end: ${JSON.stringify(end)}`);
    near(middle.red + middle.green, covered, covered * 0.02, `${name}: no hole halfway`);
    near(middle.green / covered, 0.5, 0.12, `${name}: half and half halfway`);
    near(late.green / covered, 0.75, 0.12, `${name}: three quarters later`);
  }
  assert.equal(r.coreRestored, true, 'a core mesh gets its material back');
  assert.equal(r.coreHidden, true, 'the old level is hidden at the end');
  const g = r.geometry;
  assert.equal(g.shape, true, 'the anchor holds the new geometry');
  assert.equal(g.left, 0);
  assert.ok(g.during.green > 0 && g.after.green > 0);
  assert.equal(r.ghosts, 4, 'the shape, a keeper per geometry and one pooled ghost');
  assert.ok(r.none.middle.green > 0 && r.none.end.green === 0, `a level to nothing dissolves: ${JSON.stringify(r.none)}`);
  assert.equal(r.noneHidden, true);
  assert.equal(r.doomed, 0, 'a level disposed in its fade ends it quietly');
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  clearTimeout(timer);
  await context.close?.();
  await release?.();
}
