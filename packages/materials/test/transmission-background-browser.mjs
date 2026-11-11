import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const records = [];
await mkdir('test-results/batch184', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({
    startPath: '/packages/materials/test/transmission-background.html',
    port: 5268,
    compat,
  });
  const { page } = browser,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    for (const single of [false, true]) {
      if (single) await page.goto('http://127.0.0.1:5268/packages/materials/test/transmission-background.html?single');
      await page.waitForFunction(() => window.backgroundFixture);
      const capture = async (options, label) => {
        await page.evaluate((o) => window.backgroundFixture.render(o), options);
        const bytes = await page.locator('canvas').screenshot();
        await writeFile(`test-results/batch184/layers-${compat}-${single}-${label}.png`, bytes);
        return decodePNG(bytes);
      };
      const diff = (a, b) => {
        let max = 0,
          changed = 0;
        for (let y = 40; y < 152; y++)
          for (let x = 40; x < 152; x++)
            for (let c = 0; c < 3; c++) {
              const d = Math.abs(a.data[(y * a.width + x) * 4 + c] - b.data[(y * b.width + x) * 4 + c]);
              max = Math.max(max, d);
              changed += +(d > 2);
            }
        return { max, changed };
      };
      for (const mode of ['sorted', 'weighted']) {
        const reference = await capture({ mode, glass: false }, mode + '-reference');
        const clear = await capture({ mode }, mode + '-glass');
        const identity = diff(clear, reference);
        assert.ok(
          identity.max <= 2,
          `${mode} IOR 1 must transmit each layer exactly once: ${JSON.stringify(identity)}`,
        );
        const refracted = await capture({ mode, ior: 1.5 }, mode + '-bent');
        const bend = diff(refracted, clear);
        assert.ok(bend.changed > 100, `${mode} refracts background boundaries`);
        const reversed = await capture({ mode, reverse: true }, mode + '-reverse');
        assert.ok(diff(reversed, clear).max <= 2, `${mode} follows depth, independent of registration order`);
        const frontReference = await capture({ mode, glass: false, front: true }, mode + '-front-reference');
        const front = await capture({ mode, front: true }, mode + '-front');
        assert.ok(diff(front, frontReference).max <= 2, 'foreground remains outside the refraction capture');
        const blockedReference = await capture({ mode, occluder: true, glass: false }, mode + '-occluded-reference');
        const blocked = await capture({ mode, occluder: true }, mode + '-occluded');
        const center = (96 * blocked.width + 96) * 4;
        assert.deepEqual(
          [...blocked.data.slice(center, center + 3)],
          [...blockedReference.data.slice(center, center + 3)],
          'opaque occluder is unchanged by glass',
        );
        assert.ok(blocked.data[center] > 200 && blocked.data[center + 1] > 200, 'occluder is the yellow surface');
        const before = await capture({ mode, ior: 1.5 }, mode + '-restore-before');
        assert.equal(await page.evaluate(() => window.backgroundFixture.restore()), true);
        const after = await decodePNG(await page.locator('canvas').screenshot());
        assert.ok(diff(after, before).max <= 2, 'background list and capture survive device restoration');
        records.push({ compat, samples: single ? 1 : 4, mode, identity, bend });
      }
      // Odd-size scene copy: each mip level is the area filter of the one above (a 2x2 box from texel 2p dropped the
      // last odd column and row and drifted by up to a texel across the level). worst is in units of the tolerance.
      const mips = await page.evaluate(() => window.backgroundFixture.mips());
      assert.ok(mips.spread > 0.05, `the odd-size scene has detail to filter: ${JSON.stringify(mips)}`);
      assert.ok(mips.worst <= 1, `scene copy mips are the area filter of the level above: ${JSON.stringify(mips)}`);
      records.push({ compat, samples: single ? 1 : 4, mips });
      assert.deepEqual(await page.evaluate(() => window.backgroundFixture.errors), []);
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(() => window.backgroundFixture?.dispose()).catch(() => {});
    await browser.close();
  }
}
await writeFile('test-results/batch184/transmission-background.json', JSON.stringify(records, null, 2) + '\n');
console.log('Transmission backgrounds: 8 grids passed, sorted and weighted, native and compat, 1x and 4x.');
