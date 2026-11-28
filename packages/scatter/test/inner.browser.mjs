// Real-GPU proof (run from the repository root after building packages):
//   node packages/scatter/test/inner.browser.mjs
// `inner` leaves a hole round the camera: the distribute pass's output holds no instance nearer than it, the instances
// beyond `inner + innerFade` are exactly those of a run without it, and the band between thins toward the camera.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/scatter/test/inner.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    for (const [name, c] of Object.entries(r.cases)) {
      assert.ok(c.baseInside > 300, `${name}: the run without inner draws inside the hole (${c.baseInside})`);
      assert.equal(c.inside, 0, `${name}: instances nearer than inner`);
      assert.ok(c.beyond > 2000, `${name}: instances beyond the band (${c.beyond})`);
      assert.equal(c.beyond, c.baseBeyond, `${name}: count beyond the band`);
      assert.equal(c.sameBeyond, true, `${name}: the same instances beyond the band`);
    }
    // Each instance starts at a uniform hash: a quarter of the band's inner half shows and three quarters of its outer half.
    for (const name of ['band', 'follow']) {
      const c = r.cases[name];
      assert.ok(Math.abs(c.nearShare - 0.25) < 0.08, `${name}: inner half of the band ${c.nearShare}`);
      assert.ok(Math.abs(c.farShare - 0.75) < 0.08, `${name}: outer half of the band ${c.farShare}`);
    }
    // edgeThin (KB-BIOMES-GRASSRING1): before the fix the option was unknown and the edge stayed a hard cut, so the outer
    // half of the band kept every instance.
    for (const [name, c] of Object.entries(r.edges)) {
      assert.ok(c.baseNearer > 2000 && c.bandBase > 2000, `${name}: enough instances (${c.baseNearer}, ${c.bandBase})`);
      assert.equal(c.nearer, c.baseNearer, `${name}: count nearer than the band`);
      assert.equal(c.sameNearer, true, `${name}: the same instances nearer than the band`);
      assert.equal(c.past, 0, `${name}: instances past the last LOD`);
      assert.equal(c.subset, true, `${name}: band instances are the base's, unmoved and unscaled`);
      assert.ok(Math.abs(c.innerShare - 0.75) < 0.06, `${name}: inner half of the band ${c.innerShare}`);
      assert.ok(Math.abs(c.outerShare - 0.25) < 0.06, `${name}: outer half of the band ${c.outerShare}`);
    }
    // With inner set too, the hole and its band are unchanged: two bands, two independent hashes.
    const both = r.edges.both.inner;
    assert.equal(both.inside, 0, 'both: instances nearer than inner');
    assert.ok(
      Math.abs(both.nearShare - 0.25) < 0.08 && Math.abs(both.farShare - 0.75) < 0.08,
      `both: inner band ${JSON.stringify(both)}`,
    );
    console.log('ok scatter inner', JSON.stringify(r.cases), JSON.stringify(r.edges));
  },
  () => context.close(),
);
watchExit();
