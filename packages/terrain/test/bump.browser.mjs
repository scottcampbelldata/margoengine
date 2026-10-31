// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/bump.browser.mjs
// TerrainLayer.bump and macro (biome look plan round 2, item 3). Past about 50 m the layer textures' mips average every
// layer to its mean colour and the ground was lit by the vertex normal only, so rock and snow read as flat grey. `bump`
// lights the layer's own luma as relief (Mikkelsen 2010 derivative bump mapping) and `macro` adds the same layer at
// 1/24 of its scale. On flat ground with one grey noise texture (bump.html): leaving both out, or 0, draws the same
// pixels (the shader text is main's, checked in test/surface.test.js); bump 1 spreads the near ground's sRGB luma at
// least 4 times as wide (4.7 on an RTX A6000); macro 0.5 spreads the means of 32 px blocks of the view from 60 m, where
// the 4 m repeat averages out, at least 4 times as wide and over 2/255 (0.40 to 4.25). On main both options were
// ignored, so both checks failed there.
// Biome look plan round 3, item A4 and B2. Straight down from 1.52 km, where 96 m is 14 pixels, macro 1 tiled into a
// grid: the luma correlated 0.999 at that lag; now under 0.2 on both axes (0.12 and -0.03 on an RTX A6000). 20 degrees
// off a 55 degree face from 30 m, a pixel's long side covers about 1/10 of a repeat and bump 1 kept its full slope there;
// the luma spread over the unbumped one must stay under 1.6 times. The same view guards against streaks down the fall
// line: the correlation 8 pixels along it stays within 1.3 times the one across (main passed this too: the bump never
// drew those streaks; they are the relief's gullies, which flat colour without bump draws as well).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/terrain/test/bump.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const shots = [
      ['near', {}, 'near'],
      ['nearZero', { bump: 0, macro: 0 }, 'near'],
      ['nearBump', { bump: 1 }, 'near'],
      ['far', {}, 'far'],
      ['farMacro', { macro: 0.5 }, 'far'],
      ['nearWeighted', {}, 'near', true],
      ['nearBumpWeighted', { bump: 1 }, 'near', true],
      ['farMacroWeighted', { macro: 0.5 }, 'far', true],
      ['slopeOff', {}, 'slope'],
      ['slopeBump', { bump: 1 }, 'slope'],
      ['slopeBumpWeighted', { bump: 1 }, 'slope', true],
      ['high', { macro: 1 }, 'high'],
      ['highWeighted', { macro: 1 }, 'high', true],
    ];
    for (const [name, ...shot] of shots)
      assert.deepEqual(await page.evaluate((a) => window.check.show(...a), [name, ...shot]), [], name);
    const stats = {};
    for (const [name] of shots) stats[name] = await page.evaluate((n) => window.check.stats(n), name);
    const same = await page.evaluate(() => window.check.differ('near', 'nearZero')),
      // Painted weights of layer 0 alone draw what the rules (four identical layers) draw, with and without the options.
      weighted = await page.evaluate(() =>
        [
          ['near', 'nearWeighted'],
          ['nearBump', 'nearBumpWeighted'],
          ['farMacro', 'farMacroWeighted'],
        ].map(([a, b]) => window.check.differ(a, b)),
      ),
      result = {
        same,
        weighted,
        bumpRatio: stats.nearBump.deviation / stats.near.deviation,
        macroRatio: stats.farMacro.blocks / stats.far.blocks,
        slopeRatio: stats.slopeBump.deviation / stats.slopeOff.deviation,
        slopeWeightedRatio: stats.slopeBumpWeighted.deviation / stats.slopeOff.deviation,
        fallLine: await page.evaluate(() => [
          window.check.correlation('slopeBump', 0, 8),
          window.check.correlation('slopeBump', 8, 0),
        ]),
        tile: await page.evaluate(() =>
          ['high', 'highWeighted'].flatMap((n) => [
            window.check.correlation(n, 14, 0),
            window.check.correlation(n, 0, 14),
          ]),
        ),
        stats,
      };
    await mkdir('test-results/terrain-bump', { recursive: true });
    for (const [name] of shots) {
      const url = await page.evaluate((n) => window.check.png(n), name);
      await writeFile(`test-results/terrain-bump/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
    await writeFile('test-results/terrain-bump/result.json', JSON.stringify({ hardware, result }, null, 1));
    console.log(JSON.stringify(result));
    assert.deepEqual(pageErrors, []);
    assert.equal(same, 0, 'bump 0 and macro 0 draw what leaving them out draws');
    assert.ok(
      weighted.every((n) => n < 256 * 256 * 0.01),
      `painted weights draw what the rules draw, within 1% of pixels: ${weighted}`,
    );
    assert.ok(stats.near.mean > 40, `the ground is lit (${stats.near.mean})`);
    assert.ok(result.bumpRatio > 4, `bump 1 spreads the luma ${result.bumpRatio.toFixed(2)} times (over 4)`);
    assert.ok(
      result.macroRatio > 4 && stats.farMacro.blocks > 2,
      `macro 0.5 spreads the 32 px block means ${result.macroRatio.toFixed(2)} times (over 4), to ${stats.farMacro.blocks.toFixed(2)} (over 2)`,
    );
    assert.ok(
      result.tile.every((c) => c < 0.2),
      `macro 1 from 1.5 km draws no 96 m grid: correlation at the lag ${result.tile.map((c) => c.toFixed(3))} (under 0.2)`,
    );
    assert.ok(
      result.slopeRatio < 1.6 && result.slopeWeightedRatio < 1.6,
      `bump 1 fades with the footprint: spread x${result.slopeRatio.toFixed(2)}, weights x${result.slopeWeightedRatio.toFixed(2)} (under 1.6)`,
    );
    assert.ok(
      result.fallLine[0] <= 1.3 * Math.max(result.fallLine[1], 0.05),
      `no streaks down the fall line: correlation 8 px along ${result.fallLine[0].toFixed(3)}, across ${result.fallLine[1].toFixed(3)}`,
    );
    console.log(
      `ok terrain bump and macro: bump x${result.bumpRatio.toFixed(2)}, macro block spread x${result.macroRatio.toFixed(2)}, tile ${Math.max(...result.tile).toFixed(3)}, slope x${result.slopeRatio.toFixed(2)}`,
    );
  },
  () => context.close(),
);
watchExit();
