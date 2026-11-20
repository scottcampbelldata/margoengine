// Real-GPU check of Scatter `textures` (KB-SCATTER-TEX1): a cut-out card drawn through the base colour map, its alpha
// cut-out in the colour pass and in the shadow casters, and the normal map, for `Scatter` and `ScatterTiles`. Before
// the fix the maps were ignored: the card drew one flat colour over its whole face and cast a whole square shadow.
// Run: node packages/scatter/test/maps.browser.mjs (MARGO_COMPAT=1 for the WebGL2 compatibility layer), through
// scripts/run-with-timeout.mjs.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/packages/scatter/test/maps.html', port: 'free' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
await runSuite(
  async () => {
    const { page } = browser;
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const draw = async (kind, maps, view) => {
      assert.deepEqual(await page.evaluate(([k, m, v]) => window.check.show(k, m, v), [kind, maps, view]), []);
      return await decodePNG(await page.locator('canvas').screenshot());
    };
    const at = async (png, point) => {
      const [u, v] = await page.evaluate((p) => window.check.pixel(p), point),
        x = Math.round(u * (png.width - 1)),
        y = Math.round(v * (png.height - 1)),
        i = (y * png.width + x) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    for (const kind of ['scatter', 'tiles']) {
      // Colour pass: the opaque half shows the green map, the cut half shows what is behind it.
      const front = await draw(kind, 'cut', 'front'),
        solid = await at(front, [0, 2, 1]),
        cut = await at(front, [0, 2, -1]);
      assert.ok(solid[1] > solid[0] * 2 && solid[1] > solid[2] * 2, `${kind}: opaque half is the green map ${solid}`);
      assert.ok(!(cut[1] > cut[0] * 2 && cut[1] > cut[2] * 2), `${kind}: cut half is not drawn ${cut}`);
      // Normal map: the tilted normal faces away from the sun, so the opaque half darkens.
      const tilted = await at(await draw(kind, 'tilted', 'front'), [0, 2, 1]);
      assert.ok(luma(tilted) < luma(solid) * 0.8, `${kind}: normal map shades the card ${tilted} vs ${solid}`);
      // Shadow pass: the opaque half shadows the floor behind it, the cut half does not.
      const top = await draw(kind, 'cut', 'top'),
        shade = luma(await at(top, [-2.5, 0, 1])),
        lit = luma(await at(top, [-2.5, 0, -1])),
        open = luma(await at(top, [-2.5, 0, -6]));
      assert.ok(shade < open * 0.75, `${kind}: opaque half casts a shadow ${shade} vs open floor ${open}`);
      assert.ok(lit > open * 0.9, `${kind}: cut half casts none ${lit} vs open floor ${open}`);
      // Without maps the whole card casts (the plain path is unchanged).
      const plain = luma(await at(await draw(kind, undefined, 'top'), [-2.5, 0, -1]));
      assert.ok(plain < open * 0.75, `${kind}: an untextured card shadows both halves ${plain} vs ${open}`);
    }
    assert.deepEqual(errors, []);
    console.log('scatter maps: colour cut-out, normal map and cut-out shadows hold for Scatter and ScatterTiles');
  },
  () => browser.close(),
);
watchExit();
