// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
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
    console.log('ok scatter inner', JSON.stringify(r.cases));
  },
  () => context.close(),
);
watchExit();
