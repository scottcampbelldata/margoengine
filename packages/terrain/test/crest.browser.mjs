// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/crest.browser.mjs
// TerrainLayer.bump on edge-on crest slivers (crest.html). With bump 1 on every layer, biome shot 05 (alpine mountains)
// drew dotted lines of near-black pixels along its crests. Derivative bump mapping (Mikkelsen 2010) solves for the
// relief's slope from its change across one pixel in x and in y; where a crest is seen edge-on, the two screen axes
// land on nearly the same direction on the surface (det near 0 once both are unit length), so the 2x2 solve divides
// the relief derivatives by det. Those derivatives carry errors there (the quad's helper lanes lie past the crest
// edge, where the interpolated normal, the triplanar blend and the layer weights are extrapolated), and the division
// made them slopes of 1.5 to over 8 that tipped the normal away from the noon sun. The shader caps the slope at
// min(1, 4 det). Here, on the same crests from two cameras (biome shot 05's, and a low one from the east along the
// crests): with bump 1 each frame keeps within 4 dark specks of bump off, drawn by rules and by painted weights (0 and 0
// on an RTX A6000); the formula without the cap draws over 10 more in each path, so both paths see the slivers. Since
// the clipmap cells follow the crests (KB-TERRAIN-CRESTTEETH1) shot 05's camera alone shows the painted-weights path
// only 8 (85 by rules; 21 and 14 before), so the east camera adds crests that path sees edge-on (925 and 59).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const meta = JSON.parse(await readFile(new URL('./fixtures/alpine-crest.json', import.meta.url), 'utf8')),
  context = await openBrowser({ startPath: '/packages/terrain/test/crest.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    // Biome shot 05's camera (the fixture's) and a low camera east of the crests looking along them.
    const views = { shot05: meta.camera, east: { position: [-700, 2550, -1400], target: [-1800, 2950, -1350] } },
      shots = {
        off: [{}, false],
        bump: [{ bump: 1 }, false],
        uncapped: [{ bump: 1 }, false, true],
        weightedOff: [{}, true],
        weightedBump: [{ bump: 1 }, true],
        weightedUncapped: [{ bump: 1 }, true, true],
      },
      result = {};
    for (const [view, camera] of Object.entries(views))
      for (const [name, [layer, weighted, uncapped = false]] of Object.entries(shots)) {
        const r = await page.evaluate((a) => window.check.show(...a), [layer, weighted, uncapped, camera]);
        assert.deepEqual(r.errors, [], `${view} ${name}`);
        result[`${view}.${name}`] = r;
      }
    await mkdir('test-results/terrain-crest', { recursive: true });
    await writeFile('test-results/terrain-crest/result.json', JSON.stringify({ hardware, result }, null, 1));
    const specks = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.specks])),
      counts = Object.fromEntries(Object.keys(shots).map((k) => [k, Object.keys(views).reduce((t, v) => t + specks[`${v}.${k}`], 0)]));
    console.log(JSON.stringify(specks));
    assert.deepEqual(pageErrors, []);
    for (const [name, r] of Object.entries(result))
      assert.ok(r.ground > 1440 * 900 * 0.1, `${name}: the crests fill the frame (${r.ground} ground pixels)`);
    for (const view of Object.keys(views))
      assert.ok(
        result[`${view}.uncapped`].patched && result[`${view}.weightedUncapped`].patched,
        `${view}: the uncapped formula replaced terrainBump`,
      );
    for (const [off, bump, uncapped] of [
      ['off', 'bump', 'uncapped'],
      ['weightedOff', 'weightedBump', 'weightedUncapped'],
    ]) {
      assert.ok(
        counts[uncapped] > counts[off] + 10,
        `${uncapped}: the scene has edge-on slivers (${counts[uncapped]} specks uncapped, ${counts[off]} without bump)`,
      );
      for (const view of Object.keys(views))
        assert.ok(
          specks[`${view}.${bump}`] <= specks[`${view}.${off}`] + 4,
          `${view} ${bump}: bump 1 draws no dark specks along the crests (${specks[`${view}.${bump}`]} against ${specks[`${view}.${off}`]} without bump, at most 4 more)`,
        );
    }
    console.log(
      `ok terrain bump crests: specks rules ${counts.off}/${counts.bump} (uncapped ${counts.uncapped}), weights ${counts.weightedOff}/${counts.weightedBump} (uncapped ${counts.weightedUncapped})`,
    );
  },
  () => context.close(),
);
watchExit();
