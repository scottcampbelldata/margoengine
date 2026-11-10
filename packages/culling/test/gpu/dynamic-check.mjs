// Real-GPU check for @margoengine/culling's DynamicInstances: engine A draws boxes through it, engine B draws the same
// boxes as plain core meshes (each instance's matrix is read from B's mesh, so both draw the same floats). Every step's
// frames must be identical (moves, hides, deletes, adds, camera moves; then all again with shadows cast and received),
// compared sample by sample before the 4x resolve (msaa.mjs), the GPU must drop boxes in a partial view, and the
// instance pick must name the box engine.pick names. A box dropped from A alone must show as differing samples. A bulk
// list of 200,000 rows must compact the same rows in order with the look-back scan and with its fallback alone.
// Run from the repository root after building packages, holding a GPU slot:
//   node packages/culling/test/gpu/dynamic-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
import { frameDiff } from './msaa.mjs';

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
        a = await shot('a'),
        { differing, at, pixels, mode } = await frameDiff(page, shot);
      let lit = 0;
      for (let k = 0; k < a.data.length; k += 4) if (a.data[k] + a.data[k + 1] + a.data[k + 2] > 120) lit++;
      if (differing) console.log('differing pixels (x, y, instances, core):', JSON.stringify(at));
      console.log(
        `step ${i}: ${r.label}: ${differing} of ${pixels} pixels differ (${mode}), ${lit} lit; GPU drew ${r.drawn} of ${r.alive}`,
      );
      assert.equal(differing, 0, `${r.label}: instance frame differs from core meshes`);
      assert.ok(lit > 1500, `${r.label}: scene not visible`);
      assert.ok(r.drawn <= r.alive, `${r.label}: drawn count out of range`);
      if (r.drawn < r.alive * 0.5) partial++;
    }
    assert.ok(partial > 0, 'the GPU dropped boxes in a partial view');
    // Control: one box in view dropped from A alone, as a wrong cull would, must show; then it comes back.
    const dropped = await page.evaluate(() => window.check.drop(true)),
      control = await frameDiff(page, shot);
    console.log(`control: box ${dropped} dropped from the instances only: ${control.differing} pixels differ (${control.mode})`);
    assert.ok(dropped !== null && control.differing > 20, `a dropped box shows (${control.differing} pixels)`);
    await page.evaluate(() => window.check.drop(false));
    assert.equal((await frameDiff(page, shot)).differing, 0, 'the box back: frames equal again');
    if (!shadows) {
      const bulk = await page.evaluate(() => window.check.bulk());
      console.log('bulk compaction', JSON.stringify(bulk));
      assert.ok(bulk.counts[0] > 1000 && bulk.counts[0] < bulk.alive * 0.9, 'a partial view of the 200,000 rows');
      assert.equal(bulk.counts[1], bulk.counts[0], 'the look-back fallback keeps as many rows as the look-back');
      assert.ok(bulk.same, 'and the same records, byte for byte');
      assert.ok(bulk.ordered, 'kept rows in row order');
      assert.ok(bulk.shown, 'no hidden, deleted or non-finite row kept');
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
