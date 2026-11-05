// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/repeat.browser.mjs
// A still scatter scene at 4x MSAA draws the same bits every frame: lit `Scatter` boxes on three LOD meshes, thin
// grass blades and `ScatterTiles` records, six frames each with no time step, every value of the linear HDR scene compared. Before the
// cull kept candidate order (src/order.ts), its rings held each frame's instances in the order the GPU's threads ran,
// and an Apple M6 (Metal) drew other edge pixels every frame (docs/known-bugs.md, fixed table).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/scatter/test/repeat.html', port: 'free' }),
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
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/scatter-repeat-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    for (const kind of ['scatter', 'blades', 'tiles']) {
      assert.ok(r[kind].covered > 0.2, `${kind}: the instances cover the frame (${r[kind].covered})`);
      assert.equal(
        r[kind].differ,
        0,
        `${kind}: ${r.frames} still frames at 4x MSAA draw the same bits (${r[kind].pixels} pixels differ)`,
      );
    }
    console.log('ok scatter frame repeat', JSON.stringify(r));
  },
  () => context.close(),
);
watchExit();
