// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/browser-check.mjs
// A biome world draws as terrain with its ground layer (temperate grass), painting the desert biome turns the painted
// ground to the desert's sand, clearing the paint brings the grass back, a disposed view leaves no terrain, and with all
// 8 presets (15 ground materials) painted desert is still sand. Then the look of far rock and snow (shot 05) and of a
// painted edge (shot 08).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/browser-check.html', port: 'free' }),
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
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.materials.slice(0, 3), ['grass', 'leaf-litter', 'rock']);
    const [br, bg, bb] = r.before,
      [ar, ag, ab] = r.after;
    // Grass is green-dominant; the desert's sand is red over blue and much brighter.
    assert.ok(bg > br && bg > bb, `grass before painting: ${r.before}`);
    assert.ok(ar > ag * 0.95 && ar > ab * 1.3, `sand after painting: ${r.after}`);
    assert.ok(ar + ag + ab > (br + bg + bb) * 1.5, `sand is brighter than grass: ${r.after} vs ${r.before}`);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(r.cleared[c] - r.before[c]) < 1e-3, `cleared paint: ${r.cleared} vs ${r.before}`);
    assert.ok(
      r.afterDispose.every((v, c) => Math.abs(v - r.before[c]) > 1e-3),
      'a disposed view draws no terrain',
    );
    // All 8 presets (15 materials, 4 weight textures): painted desert ground is sand, red over green (main: grass).
    assert.equal(r.allMaterials.length, 15);
    const [dr, dg, db] = r.allDesert;
    assert.ok(dr > dg && dr > db * 1.3, `desert ground with all 8 presets is sand: ${r.allDesert}`);
    // The default temperate ground at noon, as the canvas shows it: bright enough and varied (main: luma 0.31 and spread
    // 0.008, one dark olive; the palette of 2026-10-30: 0.42 and 0.016).
    assert.ok(r.noon.luma > 0.25, `temperate noon ground luma (sRGB): ${r.noon.luma}`);
    assert.ok(r.noon.spread > 0.012, `temperate noon ground colour spread (sRGB): ${r.noon.spread}`);
    // Landing E (biome look plan 2, item 3): shot 05's camera on the alpine world, 720 x 450 under a noon Sky. Rock above
    // 2,600 m: the spread of its own light and dark with the lighting divided out (see alpine() in the page); BASE
    // b88424755 (one flat grey at that distance) 0.0415 on an RTX A6000, now 0.158 (bump, macro, detail 0.6). Snow: BASE
    // had no pixel where snow outweighs rock (alpine snow and rock shared steep high ground half and half, a grey peak);
    // the alpine preset's snow now has weight 3, over 1 percent of the frame. Its brightness is read against the same
    // pixels with pure white snow, 0.90 when set (0.55 of 0.61; the old limit of 0.5 was 0.82 of that white, so 0.82 stays the limit): how far a steep peak's faces take the noon sun depends on
    // which peak the seed makes, so an absolute luma would measure the peak and not the snow.
    const alpine = r.alpine;
    assert.deepEqual(alpine.errors, []);
    assert.equal(alpine.saturated, 0, 'the mask look stays under 255 red');
    assert.ok(alpine.rock > 0.005, `rock above 2,600 m in the frame: ${alpine.rock}`);
    assert.ok(alpine.rockSd > 3 * 0.0415, `rock light and dark above 3x BASE's 0.0415: ${alpine.rockSd}`);
    assert.ok(alpine.snow > 0.01, `snow outweighs rock on over 1 percent of the frame: ${alpine.snow}`);
    assert.ok(
      alpine.snowLuma > 0.82 * alpine.snowWhite,
      `snow mean sRGB luma ${alpine.snowLuma} over 0.82 of pure white on the same pixels ${alpine.snowWhite}`,
    );
    // Landing F's painted edge (ecotone, default 24 m) at shot 08's camera: no neighbouring-pixel jump above 60 where
    // the row crosses the painted patch's edge (41 to 42 on the A6000); with ecotone 0 the one-cell step is back (154 to
    // 214), which the same measure must catch.
    assert.deepEqual([...r.edge.errors, ...r.edgeOff.errors], []);
    assert.ok(r.edge.last - r.edge.first > 100, `the row crosses the painted patch: ${r.edge.first}..${r.edge.last}`);
    assert.ok(r.edge.jump <= 60, `painted edge, ecotone 24: largest jump ${r.edge.jump}`);
    assert.ok(r.edgeOff.jump > 60, `painted edge, ecotone 0: largest jump ${r.edgeOff.jump}`);
    // Finding 1 (biome look plan 3, A1): the default clipmap reaches the whole world. On the base (6 rings, 992 m) the
    // frame differed from the 12-ring frame; now it is the same frame, and a clipmap that reaches less than the radius
    // is a RangeError.
    assert.deepEqual(r.clip.errors, []);
    assert.ok(
      r.clip.autoVsFull < 0.001,
      `default clipmap draws what 12 rings draw: ${r.clip.autoVsFull} of pixels differ`,
    );
    assert.match(r.clip.error ?? '', /clipmap reaches 496 m but radius is 1600 m/);
    assert.deepEqual(pageErrors, []);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-browser-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    console.log(
      'ok biomes view: grass',
      r.before.map((v) => v.toFixed(3)),
      'painted sand',
      r.after.map((v) => v.toFixed(3)),
      'all presets desert',
      r.allDesert.map((v) => v.toFixed(3)),
      'noon ground luma',
      r.noon.luma.toFixed(3),
      'spread',
      r.noon.spread.toFixed(4),
      'rock',
      r.alpine.rockSd.toFixed(3),
      'snow',
      r.alpine.snowLuma.toFixed(3),
      'edge jump',
      r.edge.jump,
      'ecotone 0',
      r.edgeOff.jump,
    );
  },
  () => context.close(),
);
// A suite still alive after its last step names what it left open (biomes test:gpu once sat until killed at 600 s).
watchExit();
