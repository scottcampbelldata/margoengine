// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/planet.browser.mjs
// Planet terrain (`@margoengine/terrain/planet`) at the Earth's size, 320 x 240 exact pixels, magenta sky:
// 1. from orbit (3 radii from the centre) the planet is a disc of the projected size: asin(1/3) seen through a 60 degree
//    field is a circle of 73.5 px radius, 16,970 px;
// 2. curvature: on a smooth planet 100 km up, looking level, the horizon dips by acos(R / (R + h)) = 10.1 degrees, to
//    row 120 + tan(10.1 deg) * 207.8 = 157.0 in the middle and lower toward the sides, within a pixel in every column;
// 3. near the ground (300 m up, default relief, 6,371 km from the world origin) no sky shows through the ground below
//    the horizon (skirts close the seams between levels), and the same view with a FloatingOrigin, which rebases the
//    camera to near zero, is the same picture (the layer roadmap's measure: at most 0.1% of pixels over 2, mean 0.25);
// 4. a flight of 41 frames from two radii up to 2 m above the ground, with a FloatingOrigin: every frame draws ground,
//    no validation error, and the patches reach level 18 or deeper.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const R = 6371000,
  W = 320,
  H = 240,
  K = H / 2 / Math.tan(Math.PI / 6);
const context = await openBrowser({ startPath: '/packages/terrain/test/planet.html', port: 'free' }),
  { page, hardware } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
const norm = (a) => {
  const l = Math.hypot(...a);
  return a.map((v) => v / l);
};
const shot = (options) => page.evaluate((o) => window.planet.shot(o), options);
await runSuite(
  async () => {
    const out = {};
    // 1. The disc from orbit.
    const orbit = await shot({ eye: [0, 0, 3 * R], target: [0, 0, 0] }),
      disc = Math.PI * (Math.tan(Math.asin(1 / 3)) * K) ** 2;
    out.orbit = { ground: orbit.ground, expected: disc, brightness: orbit.brightness, stats: orbit.stats };
    assert.equal(orbit.error, null);
    assert.ok(Math.abs(orbit.ground - disc) / disc < 0.02, `disc ${orbit.ground} px, expected ${disc.toFixed(0)}`);
    assert.ok(orbit.brightness > 30, `lit side: ${orbit.brightness}`);

    // 2. The horizon's dip from 100 km up.
    const h = 100000,
      eye = [0, R + h, 0],
      level = await shot({ eye, target: [1000, R + h, 0], flat: true }),
      row = H / 2 + Math.tan(Math.acos(R / (R + h))) * K,
      // Off the middle the level horizon circle projects lower, by 1 / cos of the column's angle from the middle.
      rowAt = (x) => H / 2 + ((row - H / 2) * Math.hypot(K, x + 0.5 - W / 2)) / K,
      worst = Math.max(...level.horizon.map((y, x) => Math.abs(y + 0.5 - rowAt(x))));
    out.horizon = { expected: row, middle: level.horizon[W / 2], worst, stats: level.stats };
    assert.equal(level.error, null);
    assert.ok(worst <= 1, `horizon rows ${JSON.stringify(level.horizon)}, expected ${row.toFixed(2)} in the middle`);
    assert.equal(level.gaps, 0);

    // 3. Near the ground, without and with a floating origin.
    const up = norm([0.3, 0.8, 0.52]),
      ahead = norm([up[1], -up[0], 0]),
      start = (await page.evaluate(
        async (u) => {
          const { PlanetTerrain } = await import('/packages/terrain/dist/planet.js');
          return new PlanetTerrain().heightAt(u);
        },
        up,
      )) + R + 300,
      near = up.map((v) => v * start),
      target = near.map((v, k) => v + ahead[k] * 2000 - up[k] * 400),
      plain = await shot({ eye: near, target }),
      floating = await shot({ eye: near, target, origin: true });
    let over = 0,
      sum = 0;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4,
        d = Math.max(...[0, 1, 2].map((c) => Math.abs(plain.pixels[o + c] - floating.pixels[o + c])));
      if (d > 2) over++;
      sum += d;
    }
    out.ground = {
      ground: plain.ground,
      gaps: [plain.gaps, floating.gaps],
      rebases: floating.rebases,
      share: over / (W * H),
      mean: sum / (W * H),
      stats: [plain.stats, floating.stats],
    };
    assert.equal(plain.error, null);
    assert.equal(floating.error, null);
    assert.ok(plain.ground > 0.4 * W * H, `ground fills the lower view: ${plain.ground}`);
    assert.deepEqual([plain.gaps, floating.gaps], [0, 0], 'no sky through the ground');
    assert.ok(floating.rebases >= 1, 'the floating origin rebased');
    assert.ok(over / (W * H) <= 0.001 && sum / (W * H) <= 0.25, `with a floating origin: ${JSON.stringify(out.ground)}`);

    // 4. Orbit to ground.
    const flight = await page.evaluate(() => window.planet.flight());
    out.flight = { rebases: flight.rebases, frames: flight.frames };
    assert.equal(flight.error, null);
    assert.ok(flight.rebases >= 1);
    for (const f of flight.frames) assert.ok(f.ground > 0 && f.drawn <= 1024, JSON.stringify(f));
    const last = flight.frames.at(-1);
    assert.ok(Math.abs(last.under - last.altitude) < 0.01, JSON.stringify(last));
    assert.ok(Math.max(...flight.frames.map((f) => f.level)) >= 18);
    assert.deepEqual(pageErrors, []);
    for (const k of ['orbit', 'horizon', 'ground', 'flight']) console.log(`planet ${k}: ${JSON.stringify(k === 'flight' ? { rebases: out.flight.rebases, last } : out[k])}`);
    await writeFile('test-results/terrain-planet.json', JSON.stringify({ hardware, out }, null, 1));
    console.log('ok planet terrain');
  },
  () => context.close(),
);
watchExit();
