// Real-GPU check that applyLookFamily reaches every drawing part (KB-SCENES-LOOKFAMILY-PARTS1), on WebGPU and
// (MARGO_COMPAT=1) the WebGL2 compatibility layer. One small scene (look-family-gpu.html) holds a sky, terrain colours,
// a Water, the volumetric air, a smoke column, GTAO, SSGI, bloom and a Tonemap with its Grade (the smoke
// column apart, see below). For each part alone:
// the frame with every part at `natural`, then the family `animatedFeature` on that part only, then `natural` again.
// The family must change the picture, and `natural` must give back the first frame (the clock is held, so the scene
// draws the same state the same way). No GPU error on any frame. Run from the repository root after building packages,
// under scripts/run-with-timeout.mjs:
//   node scripts/run-with-timeout.mjs 600 -- node packages/scenes/test/look-family-gpu.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scenes/test/look-family-gpu.html', port: 'free' }),
  { page } = context,
  origin = new URL(page.url()).origin,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
console.log('device', context.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
// Pixels whose summed RGB moved by more than 6 codes, and the largest move of any channel.
const compare = (a, b) => {
  let moved = 0,
    peak = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      sum += d;
      peak = Math.max(peak, d);
    }
    if (sum > 6) moved++;
  }
  return { moved, share: moved / (a.data.length / 4), peak };
};
const rows = {};
// One scene of the sky, terrain colours, water, air, grade and post passes, so the GTAO replays over TerrainColors (once
// a GPU validation error, KB-POST-GTAO-TERRAINLOOK1); the smoke apart. `check` are the parts checked in it.
const scene = async (skip, check) => {
  await page.goto(`${origin}/packages/scenes/test/look-family-gpu.html?skip=${skip}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
  const still = async () => {
    assert.deepEqual(await page.evaluate(() => window.check.draw()), [], 'no GPU error');
    return decodePNG(await page.locator('canvas').screenshot());
  };
  const parts = await page.evaluate(() => window.check.parts);
  for (const part of check) assert.ok(parts.includes(part), `${part} is drawn`);
  for (const part of parts) await page.evaluate((p) => window.check.family(p, 'natural'), part);
  const base = await still();
  for (const part of check) {
    await page.evaluate((p) => window.check.family(p, 'animatedFeature'), part);
    const feature = compare(base, await still());
    await page.evaluate((p) => window.check.family(p, 'natural'), part);
    const back = compare(base, await still());
    rows[part] = { feature: +(100 * feature.share).toFixed(2), back: back.moved, backPeak: back.peak };
    console.log(part, `animatedFeature moves ${rows[part].feature} % of pixels; natural leaves ${back.moved} moved (peak ${back.peak})`);
    assert.ok(feature.share > 0.001, `${part}: the family reaches the picture (${feature.moved} pixels moved)`);
    assert.equal(back.moved, 0, `${part}: natural gives back the frame of the defaults (peak ${back.peak})`);
  }
};
try {
  await scene('smoke', ['sky', 'terrain', 'water', 'environment', 'tonemap', 'post']);
  // The smoke column: its rows act on the puffs it lets go, so time runs (4 s) on columns that had one family from the
  // start. Two natural columns draw the same; the animatedFeature column draws another.
  const column = async (family) => {
    await page.goto(`${origin}/packages/scenes/test/look-family-gpu.html?skip=gtao,water,terrain&smokeFamily=${family}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
    assert.deepEqual(await page.evaluate(() => window.check.run(120)), [], 'no GPU error');
    return decodePNG(await page.locator('canvas').screenshot());
  };
  const plain = await column('natural'),
    again = compare(plain, await column('natural')),
    feature = compare(plain, await column('animatedFeature'));
  rows.smoke = { feature: +(100 * feature.share).toFixed(2), back: again.moved, backPeak: again.peak };
  console.log('smoke', `animatedFeature moves ${rows.smoke.feature} % of pixels; a second natural column ${again.moved} moved (peak ${again.peak})`);
  assert.equal(again.moved, 0, 'two natural columns draw the same');
  assert.ok(feature.share > 0.001, `smoke: the family reaches the column (${feature.moved} pixels moved)`);
  assert.deepEqual(Object.keys(rows).sort(), ['environment', 'post', 'sky', 'smoke', 'terrain', 'tonemap', 'water']);
  assert.deepEqual(pageErrors, []);
  console.log('look family gpu check passed', JSON.stringify(rows));
} finally {
  await context.close();
}
