// Real-GPU proof for @margoengine/scatter/states. Run from the repository root after building packages, through
// scripts/run-with-timeout.mjs: node packages/scatter/test/states.browser.mjs (MARGO_COMPAT=1 for the WebGL2
// compatibility layer).
// 1. Compose: the map holds Van Wagner's scorch height, Byram's flame length, the intensity and ash from a burn texel;
//    the high-water mark, Manning shear velocity, hazard-rating debris, wetness and flow direction from a flood; the
//    scaled covers of changed ground; and keeps each cell's peak when a weaker fire or flow follows.
// 2. A map with no sources draws the tree byte for byte as a Scatter without states.
// 3. Fire: a surface fire scorches the crown below the scorch height and chars the trunk below the flame length, for a
//    Scatter and a ScatterTiles record; a crown fire strips the crown (the silhouette shrinks); ground char does the same.
// 4. Flood: mud below the high-water mark, green above it; a fast flow lays the tree flat downstream (+X), and its
//    shadow leaves the floor where the upright crown's shadow fell.
// 5. Paint: a painted colour tints the instance.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
import { scorchHeight, flameLength, shearVelocity } from '../dist/states.js';

const browser = await openBrowser({ startPath: '/packages/scatter/test/states.html', port: 'free' });
const pageErrors = [];
browser.page.on('pageerror', (e) => pageErrors.push(e.message));
await runSuite(
  async () => {
    const { page } = browser;
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const show = async (kind, spec, frames = 1) => {
      assert.deepEqual(await page.evaluate(([k, s, f]) => window.check.show(k, s, f), [kind, spec, frames]), []);
      return decodePNG(await page.locator('canvas').screenshot());
    };
    const feed = async (key, texel) =>
      assert.deepEqual(await page.evaluate(([k, t]) => window.check.feed(k, t), [key, texel]), []);
    const map = () => page.evaluate(() => window.check.map());
    const at = async (png, point) => {
      const [u, v] = await page.evaluate((p) => window.check.pixel(p), point),
        i = (Math.round(v * (png.height - 1)) * png.width + Math.round(u * (png.width - 1))) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const green = (c) => c[1] > c[0] * 1.5 && c[1] > c[2] * 1.5;
    const cell = 8 * 16 + 8,
      layer = (m, l) => m.slice(8 + (l * 256 + cell) * 4, 8 + (l * 256 + cell) * 4 + 4);
    const close = (a, b, what) =>
      assert.ok(Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

    const plain = await show('scatter', null);
    const idle = await show('scatter', {});
    assert.equal(plain.data.length, idle.data.length);
    let differ = 0;
    for (let i = 0; i < plain.data.length; i++) if (plain.data[i] !== idle.data[i]) differ++;
    assert.equal(differ, 0, 'a map with nothing in it draws the tree unchanged');
    const trunkLow = [0, 0.5, 0.16],
      trunkHigh = [0, 1.45, 0.16],
      crownLow = [0, 2.8, 1.01],
      crownHigh = [0, 4.4, 1.01];
    assert.ok(green(await at(plain, crownLow)) && green(await at(plain, trunkLow)), 'the untouched tree is green');

    const moving = await show('scatter', { motion: 0.6 });
    assert.ok(green(await at(moving, [1.25, 4.4, 0])), 'modal crown moves onto its downwind side');
    assert.ok(!green(await at(moving, [-0.85, 4.4, 0])), 'the upwind edge has moved with the crown');
    assert.ok(green(await at(moving, trunkLow)), 'the root remains planted');
    const movingTile = await show('tiles', { motion: 0.6 });
    assert.ok(green(await at(movingTile, [1.25, 4.4, 0])), 'tiled scatter uses the same solved shape');
    const failed = await show('scatter', { motion: 0.6, failed: true });
    assert.ok(
      !green(await at(failed, trunkLow)) && !green(await at(failed, [1.25, 4.4, 0])),
      'failed tree leaves the standing scatter',
    );

    // 1 and 3: a surface fire of 300 kW/m (state 2, burnt).
    const surface = await show('scatter', { fire: [0, 10, 0.3, 2] });
    const burn = layer(await map(), 0),
      hs = scorchHeight(300),
      fl = flameLength(300);
    close(burn[0], hs, 'scorch height');
    close(burn[1], fl, 'flame length');
    close(burn[2], 0.3, 'intensity MW/m');
    assert.equal(burn[3], 1, 'ash after the burn');
    assert.ok(hs > 3 && hs < 4.4 && fl > 0.6 && fl < 1.7, `the case sits inside the tree: ${hs} ${fl}`);
    const scorched = await at(surface, crownLow),
      kept = await at(surface, crownHigh),
      charred = await at(surface, trunkLow),
      bark = await at(surface, trunkHigh);
    assert.ok(
      scorched[0] > scorched[1] && scorched[1] > scorched[2],
      `crown below the scorch height is scorched ${scorched}`,
    );
    assert.ok(green(kept), `crown above the scorch height stays green ${kept}`);
    assert.ok(luma(charred) < 12, `trunk below the flame length is charred ${charred}`);
    assert.ok(luma(bark) > luma(charred) * 2 && green(bark), `trunk above the char line is not ${bark}`);
    // A weaker fire after it leaves the peak.
    await feed('fire', [0, 10, 0.05, 2]);
    close(layer(await map(), 0)[0], hs, 'the scorch height keeps its peak');
    // The same through a ScatterTiles record (biome trees).
    const tiled = await show('tiles', { fire: [0, 10, 0.3, 2] });
    const ts = await at(tiled, crownLow);
    assert.ok(ts[0] > ts[1] && ts[1] > ts[2], `tiles: scorched crown ${ts}`);
    assert.ok(luma(await at(tiled, trunkLow)) < 12, 'tiles: charred trunk');

    // Crown fire: 2 MW/m is past twice the initiation intensity of a 2 m crown base.
    const crown = await show('scatter', { fire: [0, 10, 2, 2] });
    const strip = await at(crown, [0.9, 3.4, 0.9]);
    assert.ok(!green(strip), `the stripped crown no longer reaches its old edge ${strip}`);
    const core = await at(crown, [0, 3.4, 0.3]);
    assert.ok(luma(core) < 20, `what is left of the crown is charred ${core}`);

    // Ground char from a GroundChange cover (char byte 255): scorch 4 m and char 1 m by default.
    const ground = await show('scatter', { covers: [0, 0, 255, 0] });
    const g = layer(await map(), 0);
    close(g[0], 4, 'ground scorch');
    close(g[1], 1, 'ground char');
    assert.ok(luma(await at(ground, trunkLow)) < 12, 'ground char blackens the trunk');

    // 4: a still flood 1.2 m deep, then a 3 m/s flow.
    const still = await show('scatter', { wet: [1.2, 0, 1, 0] });
    const w = layer(await map(), 1);
    close(w[0], 1.2, 'high-water mark');
    close(w[3], 1, 'wetness just after');
    const mud = await at(still, [0, 0.6, 0.16]);
    assert.ok(mud[0] > mud[2] && !green(mud), `mud below the water mark ${mud}`);
    assert.ok(green(await at(still, crownLow)), 'green above the water mark');
    const flat = await show('scatter', { wet: [1.2, 0, 1, 0], flow: [3, 0, 3, 1.2] });
    const f = layer(await map(), 1),
      d = layer(await map(), 2);
    close(f[1], shearVelocity(1.2, 3), 'peak shear velocity');
    close(f[2], 1, 'debris at hazard rating 4.35');
    close(d[0], 1, 'flow direction x');
    close(d[1], 0, 'flow direction z');
    await feed('flow', [1, 0, 1, 1.2]);
    close(layer(await map(), 1)[1], shearVelocity(1.2, 3), 'shear keeps its peak');
    // Laid flat toward +X: nothing stands at 4.2 m, and the shadow leaves the floor at x -3.5.
    const flatPx = await at(flat, [-3.5, 0, 0]),
      uprightPx = await at(plain, [-3.5, 0, 0]);
    assert.ok(
      luma(flatPx) > luma(uprightPx) * 1.3,
      `the flattened tree's shadow left x -3.5: ${flatPx} vs ${uprightPx}`,
    );
    const top = await at(flat, [0, 4.2, 0]);
    assert.ok(!green(top), `nothing of the tree stands at 4.2 m once flattened ${top}`);
    const lying = await at(flat, [3, 0.4, 0]);
    assert.ok(luma(lying) !== luma(await at(plain, [3, 0.4, 0])), 'the tree lies along +X');

    // 5: paint.
    const painted = await show('scatter', { paint: { rect: [-1, -1, 1, 1], color: [0.6, 0.5, 0.1], amount: 1 } });
    const p = await at(painted, crownHigh);
    assert.ok(p[0] > p[2] * 2 && !green(p), `painted crown takes the paint ${p}`);
    assert.deepEqual(pageErrors, []);
    console.log('scatter plant states: compose, fire, crown fire, ground, flood, flatten, shadow and paint verified');
  },
  () => browser.close(),
);
watchExit();
