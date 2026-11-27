// Real-GPU proof (run from the repository root after building packages; --compat or MARGO_COMPAT=1 for the WebGL2
// compatibility layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/scatter/test/grass-shadow.browser.mjs
// GrassScatter's shadow pass builds the same blades as its colour pass. The shadow is read from the picture, as the
// floor pixels that darken when `shadows.add(grass)` is called:
// 1. One upright blade, h tall and tapering to a point, under a sun 45 degrees up: its shadow reaches h along the floor
//    and narrows as the blade does, sqrt(1 - d / h) of its root width at distance d (the blade's spine climbs as
//    h (1 - (1 - t)^2) while its width falls as 1 - t). The ring mesh the pose starts from is a straight band of one
//    width, so a pass that skipped the pose would not narrow.
// 2. Twice the height casts twice as far.
// 3. Sixteen blades a clump shade far more floor than one.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/grass-shadow.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const luma = (image, k) => 0.2126 * image.data[k * 4] + 0.7152 * image.data[k * 4 + 1] + 0.0722 * image.data[k * 4 + 2];
const frame = async (grass, cast) => {
  const errors = await page.evaluate(([g, c]) => window.check.show(g, c), [grass, cast]);
  assert.deepEqual(errors, [], JSON.stringify({ grass, cast }));
  const png = await page.locator('canvas').screenshot();
  return { png, image: await decodePNG(png) };
};
/** The shadow the grass casts: its pixel mask, read at floor points, and its area in pixels. */
const shadow = async (grass, keep) => {
  const lit = await frame(grass, false),
    cast = await frame(grass, true);
  if (keep) await writeFile(`test-results/${keep}.png`, cast.png);
  const { width, height } = lit.image,
    mask = new Uint8Array(width * height);
  let area = 0,
    brighter = 0;
  for (let k = 0; k < mask.length; k++) {
    const before = luma(lit.image, k),
      after = luma(cast.image, k);
    if (before > 40 && after < 0.75 * before) {
      mask[k] = 1;
      area++;
    }
    if (after > before + 8) brighter++;
  }
  assert.ok(brighter < 20, `casting a shadow brightens nothing (${brighter} pixels)`);
  // The camera looks straight down, so the floor maps onto the picture affinely.
  const [o, x, z] = await page.evaluate(() =>
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
    ].map((p) => window.check.pixel(p)),
  );
  const at = (px, pz) => {
    const u = o[0] + px * (x[0] - o[0]) + pz * (z[0] - o[0]),
      v = o[1] + px * (x[1] - o[1]) + pz * (z[1] - o[1]);
    return mask[Math.floor(v * height) * width + Math.floor(u * width)] === 1;
  };
  /** Metres of the floor line `distance` from the root, away from the sun, that lie in shadow. */
  const across = (distance) => {
    let hit = 0;
    for (let pz = -3; pz <= 3; pz += 0.01) if (at(-distance, pz)) hit++;
    return hit * 0.01;
  };
  let reach = 0;
  for (let d = 0.05; d <= 7; d += 0.05) if (across(d) > 0) reach = d;
  return { area, across, reach };
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const blade = {
        blades: 1,
        width: 1.5,
        heightVariance: 0,
        radius: 0,
        lean: 0,
        round: 0,
        segments: [16, 16, 16],
      },
      low = await shadow({ ...blade, height: 2 }, 'grass-shadow-blade-2m'),
      tall = await shadow({ ...blade, height: 4 }, 'grass-shadow-blade-4m'),
      near = tall.across(1),
      far = tall.across(3),
      narrowing = far / near,
      expected = Math.sqrt(1 / 3);
    const many = await shadow({ ...blade, height: 2, width: 0.15, radius: 1, blades: 16 }, 'grass-shadow-16'),
      one = await shadow({ ...blade, height: 2, width: 0.15, radius: 1, blades: 1 });
    const results = {
      reach: [low.reach, tall.reach].map((v) => +v.toFixed(2)),
      across: [near, far].map((v) => +v.toFixed(2)),
      narrowing: +narrowing.toFixed(3),
      area: { one: one.area, sixteen: many.area },
    };
    console.log(JSON.stringify(results));
    assert.ok(near > 0.25, `the blade's shadow has width 1 m out (${near} m)`);
    // The blade is a point at its tip, so the last of its shadow is under a pixel wide.
    assert.ok(tall.reach > 3.4 && tall.reach <= 4.15, `a 4 m blade casts about 4 m (${tall.reach})`);
    assert.ok(low.reach > 1.7 && low.reach <= 2.15, `a 2 m blade casts about 2 m (${low.reach})`);
    assert.ok(
      Math.abs(narrowing - expected) < 0.1,
      `width 3 m out over width 1 m out is ${narrowing}, the blade's own ${expected.toFixed(3)}`,
    );
    assert.ok(one.area > 20 && many.area > 4 * one.area, `16 blades shade ${many.area} pixels, one ${one.area}`);
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter grass shadows', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
