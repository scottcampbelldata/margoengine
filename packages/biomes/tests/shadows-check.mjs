// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/shadows-check.mjs [--msaa]
// BiomeView's `shadows` option: a temperate forest at noon with the view's terrain and trees added to a Shadows darkens
// at least 5 percent of the frame by 20 percent or more against the same view without it, and brightens nothing. The
// view adds the terrain and every stored-object mesh, and removes them all on dispose. Before scatter could cast and
// the view could hand over its objects, trees cast nothing and were lit from a fixed direction without the sun.
// The control comes first: two views without shadows, each built and streamed from scratch, must draw the same bits, so
// a pixel that changes with shadows changes because of them. The frames are single-sampled: on an Apple M6 a 4x MSAA
// frame's edge pixels follow the order scatter's GPU cull appends instances in, which changes every frame, and the old
// check, at 4x MSAA with no control, put 52 to 60 such pixels down to the shadows ("shadows brighten nothing"). With
// `--msaa` the scene keeps 4x MSAA: the repro of "Apple GPUs: 4x MSAA edges of scatter instances" in
// docs/known-bugs.md, which fails at the control on that GPU.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const msaa = process.argv.includes('--msaa'),
  context = await openBrowser({
    startPath: `/packages/biomes/tests/shadows-check.html${msaa ? '?msaa' : ''}`,
    port: 'free',
  }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu), msaa ? '4x MSAA' : 'single-sampled');
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-shadows-check.json', JSON.stringify({ hardware, msaa, result: r }, null, 1));
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(r.objects > 1000, `objects streamed: ${r.objects}`);
    assert.ok(r.lit > 0.9, `the frame is ground and trees, not sky: ${r.lit}`);
    assert.equal(r.control, 0, `two views without shadows draw the same bits: ${r.control} values differ`);
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
      'percent of pixels 20 percent darker, none brighter; two views without shadows drew the same bits',
    );
  },
  () => context.close(),
);
watchExit();
