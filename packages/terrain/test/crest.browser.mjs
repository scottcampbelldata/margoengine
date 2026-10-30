// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/crest.browser.mjs
// TerrainLayer.bump on edge-on crest slivers (crest.html). With bump 1 on every layer, biome shot 05 (alpine mountains)
// drew dotted lines of near-black pixels along its crests. Derivative bump mapping (Mikkelsen 2010) solves for the
// relief's slope from its change across one pixel in x and in y; where a crest is seen edge-on, the two screen axes
// land on nearly the same direction on the surface (det near 0 once both are unit length), so the 2x2 solve divides
// the relief derivatives by det. Those derivatives carry errors there (the quad's helper lanes lie past the crest
// edge, where the interpolated normal, the triplanar blend and the layer weights are extrapolated), and the division
// made them slopes of 1.5 to over 8 that tipped the normal away from the noon sun. The shader caps the slope at
// min(1, 4 det). Here, on the same crests and camera: with bump 1 the frame keeps within 4 dark specks of bump off,
// drawn by rules and by painted weights (0 and 0 on an RTX A6000); the formula without the cap draws over 10 more in
// both (21 and 14), so the scene still has the slivers.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/terrain/test/crest.html', port: 'free' }),
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
    const shots = {
        off: [{}, false],
        bump: [{ bump: 1 }, false],
        uncapped: [{ bump: 1 }, false, true],
        weightedOff: [{}, true],
        weightedBump: [{ bump: 1 }, true],
        weightedUncapped: [{ bump: 1 }, true, true],
      },
      result = {};
    for (const [name, shot] of Object.entries(shots)) {
      result[name] = await page.evaluate((a) => window.check.show(...a), shot);
      assert.deepEqual(result[name].errors, [], name);
    }
    await mkdir('test-results/terrain-crest', { recursive: true });
    await writeFile('test-results/terrain-crest/result.json', JSON.stringify({ hardware, result }, null, 1));
    const counts = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.specks]));
    console.log(JSON.stringify(counts));
    assert.deepEqual(pageErrors, []);
    for (const [name, r] of Object.entries(result))
      assert.ok(r.ground > 1440 * 900 * 0.1, `${name}: the crests fill the frame (${r.ground} ground pixels)`);
    assert.ok(result.uncapped.patched && result.weightedUncapped.patched, 'the uncapped formula replaced terrainBump');
    for (const [off, bump, uncapped] of [
      ['off', 'bump', 'uncapped'],
      ['weightedOff', 'weightedBump', 'weightedUncapped'],
    ]) {
      assert.ok(
        counts[uncapped] > counts[off] + 10,
        `${uncapped}: the scene has edge-on slivers (${counts[uncapped]} specks uncapped, ${counts[off]} without bump)`,
      );
      assert.ok(
        counts[bump] <= counts[off] + 4,
        `${bump}: bump 1 draws no dark specks along the crests (${counts[bump]} against ${counts[off]} without bump, at most 4 more)`,
      );
    }
    console.log(
      `ok terrain bump crests: specks rules ${counts.off}/${counts.bump} (uncapped ${counts.uncapped}), weights ${counts.weightedOff}/${counts.weightedBump} (uncapped ${counts.weightedUncapped})`,
    );
  },
  () => context.close(),
);
watchExit();
