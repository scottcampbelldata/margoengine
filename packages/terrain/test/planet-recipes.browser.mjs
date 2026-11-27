// Real-GPU check (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/terrain/test/planet-recipes.browser.mjs
//   MARGO_COMPAT=1 node scripts/run-with-timeout.mjs -- node packages/terrain/test/planet-recipes.browser.mjs
// `PlanetTerrain` draws every `planetPreset` (moon, mars, asteroid, ice) from orbit and from 3 km up (5% of the radius on the asteroid), 320 x 240 exact
// pixels: ground fills the view, the surface is lit with real relief (a deviation over 2 in the luminance), no validation
// error, and a second engine draws the same bytes (the picture is deterministic). A rayed crater then checks
// `PlanetTerrain`'s `brightness`.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/terrain/test/planet.html', port: 'free' }),
  { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
const recipe = (o) => page.evaluate((x) => window.planet.recipe(x), o);
await runSuite(
  async () => {
    const views = {
      orbit: { eye: [0, 0, 3], target: [0, 0, 0] },
      // 3 km above the ground on the +Y axis, looking across the surface.
      ground: { eye: [0, 1.0, 0], target: [0.0005, 1.0, 0] },
    };
    for (const name of ['moon', 'mars', 'asteroid', 'ice']) {
      for (const [view, v] of Object.entries(views)) {
        const body = { moon: 1737400, mars: 3389500, asteroid: 10000, ice: 1560800 }[name],
          up = 1 + Math.min(3000, body * 0.05) / body,
          o = view === 'ground' ? { eye: [0, up, 0], target: [0.05, up - 0.00005, 0] } : v,
          a = await recipe({ name, ...o }),
          b = await recipe({ name, ...o });
        console.log(`recipe ${name} ${view}: ${JSON.stringify(a)}`);
        assert.equal(a.error, null);
        assert.ok(a.ground > (view === 'orbit' ? 5000 : 10000), `${name} ${view} ground ${a.ground}`);
        assert.ok(a.mean > 5, `${name} ${view} lit ${a.mean}`);
        if (view === 'orbit') assert.ok(a.deviation > 2, `${name} ${view} relief ${a.deviation}`);
        assert.equal(a.hash, b.hash, `${name} ${view} deterministic`);
      }
    }
    // PlanetTerrain's brightness: nothing changes at 0, rays lighten only some ground, -1 turns the ground black.
    const shot = async (shade) => {
      const out = await page.evaluate((x) => window.planet.rays(x), { shade });
      assert.equal(out.error, null);
      return out.pixels;
    };
    const plain = await shot(),
      zero = await shot(0),
      rays = await shot('rays'),
      black = await shot(-1);
    assert.deepEqual(zero, plain);
    let ground = 0,
      lighter = 0,
      darker = 0,
      lit = 0;
    for (let i = 0; i < plain.length; i += 4) {
      if (plain[i] > 200 && plain[i + 1] < 60 && plain[i + 2] > 200) continue;
      ground++;
      const change = rays[i] + rays[i + 1] + rays[i + 2] - plain[i] - plain[i + 1] - plain[i + 2];
      if (change > 15) lighter++;
      if (change < -6) darker++;
      lit = Math.max(lit, black[i], black[i + 1], black[i + 2]);
    }
    console.log(`rays: ${JSON.stringify({ ground, lighter, darker, lit })}`);
    assert.ok(lighter > 100 && lighter < ground / 2, `rays lighten ${lighter} of ${ground}`);
    assert.equal(darker, 0);
    assert.equal(lit, 0);
    assert.deepEqual(pageErrors, []);
    console.log('ok planet recipes');
  },
  () => context.close(),
);
watchExit();
