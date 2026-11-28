// Real-GPU proof (run from the repository root after building packages):
//   node packages/scatter/test/contact.browser.mjs        (and with --compat for the WebGL2 layer)
// One upright 4 m card as scatter, read down its middle column in linear light:
// - `skyOcclusion: { depth: 1.5, height: 3 }` keeps exp(-1.5 (1 - h / 3)) of the sky's light h metres above the ground,
//   within 5 percent, also when `sink` puts a metre of the card underground (the ground line, not the mesh's foot);
// - `base: { height: 1, shade: 0.6 }` keeps 0.4 at the ground line and everything above 1.67 m, a red `tint` turns the
//   foot red, and the sun's beam alone draws the same bytes with them as without;
// - a textured part's occlusion map dims the light of a Sky too. Before the fix it dimmed only core's flat ambient,
//   which a Sky replaces, so an occlusion of 128/255 left a Sky-lit part as bright as 255 (KB-SCATTER-SKYAO1).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/contact.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/** Core's display curve undone for a pixel below its shoulder: linear light per channel. */
const linear = (image, x, y) => {
  const k = (y * image.width + x) * 4,
    mapped = [0, 1, 2].map((c) => {
      const v = image.data[k + c] / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }),
    low = Math.min(...mapped),
    offset = low < 0.04 ? Math.sqrt(low / 6.25) - low : 0.04;
  return mapped.map((v) => v + offset);
};
/** Rows of the card in the middle column, and the height above its mesh foot of a row's centre. */
const card = (image) => {
  const x = image.width >> 1,
    background = image.data.slice(0, 3),
    rows = [];
  for (let y = 0; y < image.height; y++) {
    const k = (y * image.width + x) * 4;
    if ([0, 1, 2].some((c) => Math.abs(image.data[k + c] - background[c]) > 3)) rows.push(y);
  }
  const top = rows[0],
    bottom = rows.at(-1) + 1;
  return {
    x,
    top,
    bottom,
    rowAt: (h) => Math.round(bottom - 0.5 - (h / 4) * (bottom - top)),
    heightAt: (y) => ((bottom - y - 0.5) / (bottom - top)) * 4,
  };
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? 'WebGL2 layer' : 'WebGPU');
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const draw = async (settings) => {
      const errors = await page.evaluate((s) => window.check.show(s), settings);
      assert.deepEqual(errors, [], JSON.stringify(settings));
      const png = await page.locator('canvas').screenshot();
      return { png, image: await decodePNG(png) };
    };
    const results = {};
    for (const kind of ['tiles', 'scatter']) {
      const plain = await draw({ kind }),
        c = card(plain.image);
      assert.ok(c.bottom - c.top > 80, `${kind}: the card spans the view (${c.top}..${c.bottom})`);
      const ratio = (image, h) => linear(image, c.x, c.rowAt(h))[1] / linear(plain.image, c.x, c.rowAt(h))[1];
      const canopy = await draw({ kind, look: { skyOcclusion: { depth: 1.5, height: 3 } } });
      results[kind] = [0.4, 1.2, 2.2, 3.6].map((h) => {
        const want = Math.exp(-1.5 * (1 - Math.min(c.heightAt(c.rowAt(h)) / 3, 1))),
          got = ratio(canopy.image, h);
        assert.ok(
          Math.abs(got / want - 1) < 0.05,
          `${kind}: sky light at ${h} m is ${got.toFixed(3)}, ${want.toFixed(3)}`,
        );
        return +got.toFixed(3);
      });
      const foot = await draw({ kind, look: { base: { height: 1, shade: 0.6 } } }),
        low = ratio(foot.image, 0.03),
        high = ratio(foot.image, 2);
      assert.ok(Math.abs(low - 0.4) < 0.03, `${kind}: the ground line keeps 0.4 of the sky's light (${low.toFixed(3)})`);
      assert.ok(Math.abs(high - 1) < 0.01, `${kind}: above the band nothing changes (${high.toFixed(3)})`);
      const red = await draw({ kind, look: { base: { height: 1, shade: 0, tint: [0.5, 0.05, 0.05], amount: 1 } } }),
        [r, g] = linear(red.image, c.x, c.rowAt(0.03)),
        [r2, g2] = linear(red.image, c.x, c.rowAt(2.5));
      assert.ok(r > 4 * g && Math.abs(r2 / g2 - 1) < 0.02, `${kind}: the foot turns to the tint (${(r / g).toFixed(1)})`);
      const lit = await draw({ kind, light: 'sun' }),
        under = await draw({
          kind,
          light: 'sun',
          look: { base: { height: 1, shade: 0.6 }, skyOcclusion: { depth: 1.5, height: 3 } },
        });
      assert.ok(lit.png.equals(under.png), `${kind}: the sun's beam is untouched`);
      // Every lit route compiles with the contact stages: maps, clusters, the two together and translucent blades.
      for (const settings of [
        { occlusion: 255 },
        { look: { variation: { value: 0.2 }, clusters: 0.5 } },
        { occlusion: 255, look: { variation: { value: 0.2 }, clusters: 0.5 } },
        { look: { blades: { translucency: 0.5 } } },
      ])
        await draw({ kind, ...settings, look: { ...settings.look, base: { height: 1 } } });
    }
    // The ground line follows sink: with a metre under, the card's row h above its foot stands h - 1 above the ground.
    const sunk = await draw({ kind: 'tiles', look: { sink: 1 } }),
      s = card(sunk.image),
      shaded = await draw({ kind: 'tiles', look: { sink: 1, skyOcclusion: { depth: 1.5, height: 3 } } }),
      y = s.rowAt(2.2),
      want = Math.exp(-1.5 * (1 - (s.heightAt(y) - 1) / 3)),
      got = linear(shaded.image, s.x, y)[1] / linear(sunk.image, s.x, y)[1];
    assert.ok(Math.abs(got / want - 1) < 0.05, `sunk: sky light ${got.toFixed(3)}, ${want.toFixed(3)}`);
    const centre = async (settings) => linear((await draw(settings)).image, 128, 128)[1],
      open = await centre({ light: 'sky', occlusion: 255 }),
      occluded = await centre({ light: 'sky', occlusion: 128 }),
      kept = occluded / open;
    assert.ok(Math.abs(kept - 128 / 255) < 0.03, `the occlusion map dims a Sky's light (${kept.toFixed(3)}, 0.502)`);
    assert.deepEqual(pageErrors, []);
    console.log(
      'ok scatter contact',
      JSON.stringify({ ...results, sunk: +got.toFixed(3), skyMap: +kept.toFixed(3), sky: +open.toFixed(3) }),
    );
  },
  () => context.close(),
);
watchExit();
