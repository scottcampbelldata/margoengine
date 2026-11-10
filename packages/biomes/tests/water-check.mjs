// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/water-check.mjs
// Biome look plan item 5: the wetland preset world runs down to a sea floor 40 m below sea level on its west side, and
// main drew no water there (shot 06: a dark shelf to the horizon). The default view (`water: 'auto'`) now draws the sea:
// looking west from the shore, over 10 percent of the lower third of the frame is water (blue over red). With
// `water: false` the same view shows the bare sea floor, under 10 percent. Then the sea's look (below).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/water-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.equal(r.auto.water, true, "water: 'auto' finds the sea below the wetland's west coast");
    assert.equal(r.off.water, false);
    assert.ok(r.auto.share > 0.1, `water in the lower third: ${r.auto.share}`);
    assert.ok(r.off.share < 0.1, `without water the sea floor shows: ${r.off.share}`);
    // Landing E (biome look plan 2, item 2): the sea from the biome shots' camera 06 under a noon Sky passed as `sky`.
    // Before (BASE b88424755, RTX A6000, 720 x 450): a flat dark teal plane, wave texture 0.0130 (sRGB luma less its
    // 5 x 5 mean, RMS), mean luma 0.266, no foam-white pixel in the shore band. Now: texture 0.0485, mean 0.74, shore band
    // 11 percent foam-white (the swell's crests break; the water's own shoreline term is at most 35 percent foam).
    const sea = r.sea;
    assert.deepEqual(sea.errors, []);
    assert.equal(sea.drawn, true);
    assert.ok(sea.share > 0.05, `sea pixels: ${sea.share}`);
    assert.ok(sea.texture > 3 * 0.013, `sea wave texture above 3x the flat plane's 0.013: ${sea.texture}`);
    assert.ok(sea.mean > 0.2, `sea mean sRGB luma above 0.2: ${sea.mean}`);
    assert.ok(
      sea.band > 500 && sea.foam > 0.02,
      `shore band (${sea.band} px) foam-white share above 2 percent: ${sea.foam}`,
    );
    // Biome look plan 3 L11: water in the rivers. 1.5 m over the ground along the line and rising with it: main drew
    // nothing above the sea, everywhere the sea plane.
    const river = r.river;
    assert.deepEqual(river.errors, []);
    assert.ok(river.share > 0.002, `river pixels from above: ${river.share}`);
    for (const p of river.points) {
      assert.ok(p.depth > 0.5, `water at line point ${p.k}: depth ${p.depth}`);
      assert.ok(
        Math.abs(p.surface - p.ground - 1.5) < 1,
        `line point ${p.k}: surface ${p.surface}, ground ${p.ground}`,
      );
    }
    const ends = [river.points[0], river.points[river.points.length - 1]];
    assert.ok(
      ends[1].surface - ends[0].surface > 10,
      `the surface rises upstream: ${ends[0].surface} to ${ends[1].surface}`,
    );
    // Job E: lakes at the hydrology's fill level and rivers along its channels, on the default world. Main drew neither
    // (lakes lived in data only, channels were never drawn).
    const lakes = r.lakes;
    assert.deepEqual(lakes.errors, []);
    assert.ok(lakes.lines >= 1, `hydrology channels: ${lakes.lines}`);
    assert.ok(lakes.lake.depth > 1, `water over the deepest lake cell: depth ${lakes.lake.depth}`);
    assert.ok(
      Math.abs(lakes.lake.surface - lakes.lake.level) < 0.5,
      `lake surface ${lakes.lake.surface} at the fill level ${lakes.lake.level}`,
    );
    assert.ok(lakes.lake.share > 0.01, `lake pixels from above: ${lakes.lake.share}`);
    assert.ok(lakes.river > 0.002, `hydrology river pixels from above: ${lakes.river}`);
    assert.deepEqual(pageErrors, []);
    // List 3 batch 63 job 2: with flow the river moves (cells change over 3 s, the inflow keeps more water than none); without
    // flow it stands.
    const flowing = r.flowing;
    assert.deepEqual(flowing.errors, []);
    assert.equal(flowing.still.changed, 0, `still river cells that changed: ${flowing.still.changed}`);
    assert.ok(flowing.moving.changed > 10, `flowing river cells that changed by over 1 cm: ${flowing.moving.changed}`);
    assert.ok(flowing.unfed.changed > 10, `river cells that drained without inflow: ${flowing.unfed.changed}`);
    // 3 s of 20 m^3/s per line is 60 m^3 per line; volumes are in m^3.
    assert.ok(
      flowing.moving.volume[1] - flowing.unfed.volume[1] > 30,
      `the inflow adds water: ${flowing.moving.volume[1]} m^3 against ${flowing.unfed.volume[1]} m^3 without it`,
    );
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-water-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    console.log(
      'ok biomes water: lower third water',
      r.auto.share.toFixed(3),
      'without',
      r.off.share.toFixed(3),
      'sea texture',
      sea.texture.toFixed(4),
      'mean luma',
      sea.mean.toFixed(3),
      'shore foam',
      sea.foam.toFixed(3),
    );
  },
  () => context.close(),
);
watchExit();
