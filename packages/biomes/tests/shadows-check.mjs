// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/shadows-check.mjs
// BiomeView's `shadows` option: a temperate forest at noon with the view's terrain and trees added to a Shadows darkens
// at least 5 percent of the frame by 20 percent or more against the same view without it, and brightens nothing. The
// view adds the terrain and every stored-object mesh, and removes them all on dispose. Before scatter could cast and
// the view could hand over its objects, trees cast nothing and were lit from a fixed direction without the sun.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/shadows-check.html', port: 'free' }),
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
    await writeFile('test-results/biomes-shadows-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(r.objects > 1000, `objects streamed: ${r.objects}`);
    assert.ok(r.lit > 0.9, `the frame is ground and trees, not sky: ${r.lit}`);
    // Terrain plus each species' parts (trunk and canopy) and the snags' parts.
    assert.ok(r.casters >= 3, `stored-object meshes: ${r.casters}`);
    assert.equal(r.added, r.casters + 1, 'the view adds its terrain and every stored-object mesh');
    assert.equal(r.removed, r.added, 'dispose removes every caster it added');
    assert.ok(r.darker >= 0.05, `share of pixels at least 20 percent darker with shadows: ${r.darker}`);
    assert.equal(r.brighter, 0, `shadows brighten nothing: [x, y, without, with] ${JSON.stringify(r.bright)}`);
    console.log(
      'ok biomes shadows:',
      r.casters,
      'casters,',
      (r.darker * 100).toFixed(1),
      'percent of pixels 20 percent darker, none brighter',
    );
  },
  () => context.close(),
);
watchExit();
