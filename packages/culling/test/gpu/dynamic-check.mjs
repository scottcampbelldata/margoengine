// Real-GPU check for @margoengine/culling's DynamicInstances: engine A draws boxes through it, engine B draws the same
// boxes as plain core meshes (each instance's matrix is read from B's mesh, so both draw the same floats). Every step's
// frames must be identical (moves, hides, deletes, adds, camera moves; then all again with shadows cast and received),
// the GPU must drop boxes in a partial view, and the instance pick must name the box engine.pick names.
// Run from the repository root after building packages, holding a GPU slot:
//   node packages/culling/test/gpu/dynamic-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';

for (const shadows of [false, true]) {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/index.html', port: 5281 }),
    { page, hardware } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  try {
    if (!shadows) console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const setup = await page.evaluate((s) => window.check.setup(s), shadows);
    console.log(shadows ? 'with shadows' : 'without shadows', JSON.stringify(setup));
    const steps = await page.evaluate(() => window.check.steps);
    let partial = 0;
    for (let i = 0; i < steps; i++) {
      const r = await page.evaluate((n) => window.check.step(n), i),
        [a, b] = [await shot('a'), await shot('b')];
      let differing = 0,
        lit = 0;
      const at = [];
      for (let k = 0; k < a.data.length; k += 4) {
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) {
          differing++;
          if (at.length < 6)
            at.push([
              (k / 4) % a.width,
              Math.floor(k / 4 / a.width),
              [...a.data.subarray(k, k + 3)],
              [...b.data.subarray(k, k + 3)],
            ]);
        }
        if (a.data[k] + a.data[k + 1] + a.data[k + 2] > 120) lit++;
      }
      if (differing) console.log('differing pixels (x, y, instances, core):', JSON.stringify(at));
      console.log(
        `step ${i}: ${r.label}: ${differing} of ${a.data.length / 4} pixels differ, ${lit} lit; GPU drew ${r.drawn} of ${r.alive}`,
      );
      assert.equal(differing, 0, `${r.label}: instance frame differs from core meshes`);
      assert.ok(lit > 1500, `${r.label}: scene not visible`);
      assert.ok(r.drawn <= r.alive, `${r.label}: drawn count out of range`);
      if (r.drawn < r.alive * 0.5) partial++;
    }
    assert.ok(partial > 0, 'the GPU dropped boxes in a partial view');
    if (!shadows) {
      const picks = await page.evaluate(() => window.check.picks()),
        hits = picks.filter(([p]) => p !== null).length;
      assert.deepEqual(
        picks.map(([p]) => p),
        picks.map(([, q]) => q),
        'the instance pick names the box engine.pick names',
      );
      assert.ok(hits > 10, `picks hit instances (${hits})`);
      console.log('picks', hits, 'of', picks.length, 'hit, the same box on both engines');
    }
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
}
console.log('dynamic instances pixel check passed');
