// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/shadow-cull.browser.mjs
// Scatter culls its instances per shadow cascade (prepareShadow) without changing the shadows:
// 1. Same output: for three scenes (LOD rings with fades, scales and wind; widened wind-bent grass blades; a tree trunk
//    and a raised canopy that shares its rings), the four-cascade shadow map is bit for bit the one drawn when every
//    cascade draws every camera-culled instance, and the frames match pixel for pixel.
// 2. Fewer draws: in the tree scene (49 trees near the camera, 49 more 300 m away, past the 120 m of shadows) the
//    indirect draws of each cascade name every instance whose bounds reach that cascade's light box and none whose
//    bounds lie outside it (classified on the CPU from Shadows' matrices), so the distant trees are drawn in no cascade.
// Before prepareShadow, every cascade drew every visible instance: 4 cascades cost 4 full redraws of every tree.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/shadow-cull.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const show = async (scene, mode) => {
  const errors = await page.evaluate(([scene, mode]) => window.check.show(scene, mode), [scene, mode]);
  assert.deepEqual(errors, [], `${scene} ${mode}`);
};
const frame = async () => decodePNG(await page.locator('canvas').screenshot());

/** Planes w + x, w - x, w + y, w - y, z, w - z of a column-major matrix, normalized (as scatter's cull pass). */
function planes(m) {
  const out = [];
  for (let k = 0; k < 6; k++) {
    const row = k < 4 ? k >> 1 : 2,
      sign = k === 4 || (k & 1) === 0 ? 1 : -1,
      w = k === 4 ? 0 : 1,
      p = [0, 1, 2, 3].map((j) => w * m[j * 4 + 3] + sign * m[j * 4 + row]),
      l = Math.hypot(p[0], p[1], p[2]);
    out.push(p.map((v) => v / l));
  }
  return out;
}

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const results = {};
    for (const scene of ['scatter', 'blades', 'tiles']) {
      await show(scene, 'new');
      await show(scene, 'full');
      await page.evaluate(() => window.check.depth('full'));
      const full = await frame();
      await show(scene, 'culled');
      const depth = await page.evaluate(() => window.check.depth('culled', 'full'));
      const culled = await frame();
      const counts = await page.evaluate(() => window.check.counts());
      assert.equal(depth.layers, 4);
      assert.ok(Math.min(...depth.covered) > 0.001, `${scene}: casters reach every cascade ${depth.covered}`);
      assert.equal(
        depth.mismatches,
        0,
        `${scene}: shadow map texels differ from drawing every instance (first ${depth.first})`,
      );
      let pixels = 0;
      for (let i = 0; i < full.data.length; i++) if (full.data[i] !== culled.data[i]) pixels++;
      assert.equal(pixels, 0, `${scene}: frame bytes differ`);
      for (const { camera, cascades } of counts) {
        const visible = camera[0] + camera[1] + camera[2];
        assert.ok(visible > 0, `${scene}: instances in view`);
        for (const ring of cascades)
          assert.ok(
            ring.every((n, r) => n <= camera[r]),
            `${scene}: a cascade lists more than the view`,
          );
      }
      results[scene] = { covered: depth.covered, counts: counts.map(({ camera, cascades }) => ({ camera, cascades })) };
      if (scene !== 'tiles') {
        // Wide scenes: the nearest cascade draws a small share of what the view holds.
        const [{ camera, cascades }] = counts,
          visible = camera[0] + camera[1] + camera[2],
          first = cascades[0][0] + cascades[0][1] + cascades[0][2];
        assert.ok(first < visible / 2, `${scene}: cascade 0 draws ${first} of ${visible}`);
        continue;
      }
      // Tree scene: classify every tree against every cascade on the CPU.
      const { near, far, matrices } = await page.evaluate(() => window.check.layout());
      for (const [k, { camera, cascades, radius }] of counts.entries()) {
        assert.equal(camera[0] + camera[1] + camera[2], near.length + far.length, 'every tree is in view');
        for (let c = 0; c < 4; c++) {
          const box = planes(matrices.slice(c * 16, c * 16 + 16));
          // Root at ground height 0, scale 1: the posed mesh stays within `radius` of it.
          const distances = (p) => box.map((q) => q[0] * p[0] + q[2] * p[1] + q[3]);
          let reach = 0,
            outside = 0,
            farDrawn = 0;
          for (const [i, p] of [...near, ...far].entries()) {
            const d = distances(p);
            if (d.every((v) => v > -radius * 0.999 + 1e-3)) reach++;
            else if (d.some((v) => v < -radius * 1.001 - 1e-3)) {
              outside++;
              if (i >= near.length) farDrawn++;
            }
          }
          const drawn = cascades[c][0] + cascades[c][1] + cascades[c][2];
          assert.equal(farDrawn, far.length, `mesh ${k} cascade ${c}: the distant trees lie outside it`);
          assert.ok(
            drawn >= reach && drawn <= near.length + far.length - outside,
            `mesh ${k} cascade ${c}: draws ${drawn}, ${reach} reach it, ${outside} lie outside`,
          );
          assert.ok(drawn <= near.length, `mesh ${k} cascade ${c}: no distant tree drawn`);
        }
        assert.ok(
          cascades.some((ring) => ring[0] + ring[1] + ring[2] > 0),
          `mesh ${k}: drawn in some cascade`,
        );
      }
    }
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter shadow culling', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
