import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

await mkdir('test-results/batch184/fur', { recursive: true });
const records = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/materials/test/fur.html', port: 'free', compat });
  const page = browser.page,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const base = page.url().split('?')[0];
    for (const single of [false, true]) {
      if (single) {
        await page.evaluate(() => window.furDraft.dispose());
        await page.goto(base + '?single');
      }
      await page.waitForFunction(() => window.furDraft);
      const image = async (label) => {
        const bytes = await page.locator('canvas').first().screenshot();
        await writeFile(
          `test-results/batch184/fur/${compat ? 'compat' : 'native'}-${single ? 1 : 4}x-${label}.png`,
          bytes,
        );
        return (await decodePNG(bytes)).data;
      };
      const render = async (options, label) => {
        await page.evaluate((o) => window.furDraft.render(o), options);
        return image(label);
      };
      const difference = (a, b) => {
        let changed = 0,
          max = 0;
        for (let k = 0; k < a.length; k++)
          if (k % 4 !== 3) {
            const d = Math.abs(a[k] - b[k]);
            changed += +(d > 2);
            max = Math.max(max, d);
          }
        return { changed, max };
      };
      // Root coverage: the share of a flat shell's area its strands cover is the coverage option, also above pi / 4
      // (where a disc no longer fits its cell) and near the cell edges (where the old jitter cut discs short).
      const covered = async (c) => {
        await page.evaluate(() => window.furDraft.coverage(0));
        const empty = (await decodePNG(await page.locator('#coverage').screenshot())).data;
        await page.evaluate((v) => window.furDraft.coverage(v), c);
        const shot = (await decodePNG(await page.locator('#coverage').screenshot())).data;
        let hit = 0;
        for (let k = 0; k < shot.length; k += 4)
          hit += +(
            Math.abs(shot[k] - empty[k]) + Math.abs(shot[k + 1] - empty[k + 1]) + Math.abs(shot[k + 2] - empty[k + 2]) >
            96
          );
        return hit / (shot.length / 4);
      };
      const coverage = { 0.3: await covered(0.3), 0.65: await covered(0.65), 1: await covered(1) };
      for (const [c, share] of Object.entries(coverage))
        assert.ok(Math.abs(share - Number(c)) < 0.015, `coverage ${c} covers ${share.toFixed(4)} of the shell`);
      const full = await render({ length: 0.3 }, 'full');
      const short = await render({ length: 0.05 }, 'short');
      const length = difference(full, short);
      assert.ok(length.changed > 500, 'length changes the shell silhouette');
      const sparse = await render({ length: 0.3, density: 8 }, 'density');
      const density = difference(full, sparse);
      assert.ok(density.changed > 500, 'density changes the strand field');
      const gravityImage = await render({ length: 0.3, gravity: [1, 0, 0] }, 'gravity');
      const gravity = difference(full, gravityImage);
      assert.ok(gravity.changed > 500, 'gravity bends the shell stack');
      const wind = await render({ length: 0.3, wind: [1, 0, 0], time: 0 }, 'wind');
      await page.evaluate(() => window.furDraft.time(0.25));
      const later = await image('wind-later');
      const motion = difference(wind, later);
      assert.ok(motion.changed > 500, 'time animates wind without rebuilding geometry');
      await page.evaluate(() => window.furDraft.time(0));
      const reset = await image('wind-reset');
      assert.deepEqual(Buffer.from(reset), Buffer.from(wind), 'resetting time restores every pixel');
      assert.equal(await page.evaluate(() => window.furDraft.restore()), true);
      const restored = await image('restored');
      assert.deepEqual(Buffer.from(restored), Buffer.from(wind), 'device restoration restores every pixel');
      await page.evaluate(() => window.furDraft.configure({ density: 0 }));
      const noStrands = await image('density-zero');
      assert.ok(difference(noStrands, wind).changed > 500, 'live zero density removes the outer strands');
      const coarse = await render({ length: 0.3, shells: 2 }, 'two-shells');
      assert.ok(
        difference(coarse, noStrands).changed > 100,
        'two-shell fur retains an outer shell below the fully tapered tip',
      );
      const mapped = await render({ length: 0.3, mapped: true }, 'real-texture');
      assert.ok(difference(mapped, full).changed > 500, 'real CC0 colour map reaches every shell');
      assert.deepEqual(await page.evaluate(() => window.furDraft.shadow()), []);
      const plainShadow = await image('caster-shadow');
      // KB5588b: shells with an inherited displacementMap cast through the fur record with the map applied, and TAA
      // draws their velocity with the fur patch (both used to fail pipeline creation or ignore the map).
      assert.deepEqual(await page.evaluate(() => window.furDraft.displaced()), []);
      const displaced = await image('displaced-shadow');
      assert.ok(difference(displaced, plainShadow).changed > 500, 'the displaced stack draws and casts');
      assert.deepEqual(await page.evaluate(() => window.furDraft.taa()), []);
      await image('taa-wind');
      assert.deepEqual(await page.evaluate(() => window.furDraft.errors), []);
      records.push({
        compat,
        samples: single ? 1 : 4,
        length,
        density,
        gravity,
        motion,
        resetExact: true,
        restoreExact: true,
        caster: true,
        coverage,
      });
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(() => window.furDraft?.dispose()).catch(() => {});
    await browser.close();
  }
}
await writeFile('test-results/batch184/fur/gpu.json', JSON.stringify(records, null, 2) + '\n');
console.log(
  'Fur: native/compat 1x/4x, density, length, gravity, wind, exact reset/restore, CC0 map and caster shadows passed.',
);
