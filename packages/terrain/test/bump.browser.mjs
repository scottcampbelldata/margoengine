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
    console.log(
      `ok terrain bump and macro: bump x${result.bumpRatio.toFixed(2)}, macro block spread x${result.macroRatio.toFixed(2)}`,
    );
  },
  () => context.close(),
);
watchExit();
