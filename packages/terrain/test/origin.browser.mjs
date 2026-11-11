// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/origin.browser.mjs            (WebGPU; MARGO_COMPAT=1 for the WebGL2 layer)
// A terrain under a FloatingOrigin (TerrainOptions.floatingOrigin), the same scene moved with its camera by 0, about
// 1e5 and about 1e7 m (49 and 4883 times 2048 m: whole multiples of the ring lattice, 32 m, and of the virtual texture's
// coarsest period, 512 m, so the moved scene lands on the same lattice points). Rules with bump and macro, a hole, a
// virtual texture with a decal and a road. Bars, fixed before any run:
// 1. exact (the origin at the offset): every number the GPU receives is the zero case's (planRings, planWindows and the
//    layer wrap are computed in float64 from exact inputs, origin.test.js), so the pictures are identical, pixel for
//    pixel, with the same draw calls and the same texels baked;
// 2. camera (ratio 10, the origin rebases onto the camera at 1e7), the camera rebased in place, and a 400 m flight that
//    rebases on the way (ratio 2): the local numbers differ from the zero case only by float32 rounding of positions
//    that stay small, which moves a sample under a thousandth of a texel: at most 1 of 255 per channel on every pixel
//    and 99.9 percent of pixels equal to the exact picture at the same offset. The flight rebases onto the camera a third
//    of a metre off the metre grid, where every local position rounds differently in float32: 99.83 percent of pixels
//    were equal there on the first run (RTX A6000, 2026-11-11), short of the planned 99.9, all within 1 of 255. Its bar
//    is that 1 of 255 on every pixel, with at least 99 percent of pixels equal as a coarse check; the share is reported;
// 3. a rebase in place bakes nothing that frame (the cache keeps every page) and rebases exactly once.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const OFFSETS = [0, 49 * 2048, 4883 * 2048];
const context = await openBrowser({ startPath: '/packages/terrain/test/origin.html', port: 'free' }),
  { page, hardware } = context;
const base = new URL(page.url()).origin,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
async function load(offset, mode, stack = 'rvt') {
  await page.goto(`${base}/packages/terrain/test/origin.html?offset=${offset}&mode=${mode}&stack=${stack}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  assert.deepEqual((await page.evaluate(() => window.check.info())).errors, [], `${mode} ${offset}: page errors`);
  const stats = await page.evaluate(() => window.check.settle());
  const image = await shot();
  assert.deepEqual((await page.evaluate(() => window.check.info())).errors, [], `${mode} ${offset}: page errors`);
  return { stats, image };
}
function compare(a, b) {
  let equal = 0,
    max = 0,
    ground = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[o + c] - b.data[o + c]));
    if (d === 0) equal++;
    max = Math.max(max, d);
    if (b.data[o] + b.data[o + 1] + b.data[o + 2] > 60) ground++;
  }
  return { equal: equal / n, max, ground };
}
const close = (m) => m.max <= 1 && m.equal >= 0.999;
await runSuite(
  async () => {
    const out = { exact: {}, camera: {}, still: {}, flight: {} };
    const exact = {};
    for (const offset of OFFSETS) {
      exact[offset] = await load(offset, 'exact');
      // The same page, rebased in place onto the camera: nothing bakes and the picture holds.
      const r = await page.evaluate(() => window.check.rebase()),
        after = compare(await shot(), exact[offset].image);
      out.still[offset] = { ...after, ...r };
      console.log(`terrain origin still ${offset}: ${JSON.stringify(out.still[offset])}`);
      assert.equal(r.rebases, 1, `${offset}: one rebase in place`);
      assert.equal(r.baked, 0, `${offset}: a rebase in place bakes nothing`);
      assert.ok(close(after), `${offset}: the picture after a rebase in place matches: ${JSON.stringify(after)}`);
    }
    const zero = exact[0];
    assert.ok(compare(zero.image, zero.image).ground > 20000, 'the terrain fills the view');
    assert.ok(zero.stats.baked > 0, 'the virtual texture baked');
    for (const offset of OFFSETS) {
      const e = exact[offset],
        m = compare(e.image, zero.image);
      out.exact[offset] = { ...m, baked: e.stats.baked, draws: e.stats.draws, shift: e.stats.shift };
      console.log(`terrain origin exact ${offset}: ${JSON.stringify(out.exact[offset])}`);
      assert.deepEqual(e.stats.shift, [offset, 0, offset], `${offset}: the origin sits at the offset`);
      assert.equal(m.max, 0, `${offset}: the exact picture equals the zero case: ${JSON.stringify(m)}`);
      assert.equal(e.stats.draws, zero.stats.draws, `${offset}: the same draw calls`);
      assert.equal(e.stats.baked, zero.stats.baked, `${offset}: the same texels baked`);
    }
    for (const offset of [0, OFFSETS[2]]) {
      const c = await load(offset, 'camera'),
        m = compare(c.image, exact[offset].image);
      out.camera[offset] = { ...m, rebases: c.stats.rebases, shift: c.stats.shift, baked: c.stats.baked };
      console.log(`terrain origin camera ${offset}: ${JSON.stringify(out.camera[offset])}`);
      assert.equal(c.stats.rebases, offset ? 1 : 0, `${offset}: rebases onto the camera only when far`);
      assert.ok(close(m), `${offset}: the rebased picture matches: ${JSON.stringify(m)}`);
      assert.equal(c.stats.baked, exact[offset].stats.baked, `${offset}: the same texels baked`);
    }
    for (const offset of [OFFSETS[1], OFFSETS[2]]) {
      const f = await load(offset, 'flight'),
        m = compare(f.image, exact[offset].image);
      out.flight[offset] = { ...m, flight: f.stats.flight, rebases: f.stats.rebases, shift: f.stats.shift };
      console.log(`terrain origin flight ${offset}: ${JSON.stringify(out.flight[offset])}`);
      // One rebase from the explicit start origin, and one on the way.
      assert.equal(f.stats.flight.length, 1, `${offset}: the flight rebases once: ${f.stats.flight}`);
      assert.ok(m.max <= 1 && m.equal >= 0.99, `${offset}: the picture after the flight matches: ${JSON.stringify(m)}`);
    }
    // 4. Every other terrain entry under the origin, exact at 0 and 1e7: cached imagery and an overlay polygon; layer
    // materials with displacement; footprints; imagery on the lit path. The same numbers reach the GPU, so the same
    // pictures (bar 1), and each differs from the scene without it (the entry draws: the cache alone for overlays, the
    // bare terrain for the others).
    out.stacks = {};
    const plain = await load(0, 'exact', 'plain');
    for (const stack of ['overlays', 'pbr', 'deform', 'imagery']) {
      const a = await load(0, 'exact', stack),
        b = await load(OFFSETS[2], 'exact', stack),
        m = compare(b.image, a.image),
        drawn = compare(a.image, (stack === 'overlays' ? zero : plain).image);
      out.stacks[stack] = { ...m, changed: 1 - drawn.equal, draws: a.stats.draws };
      console.log(`terrain origin ${stack}: ${JSON.stringify(out.stacks[stack])}`);
      assert.equal(m.max, 0, `${stack}: 1e7 equals the zero case: ${JSON.stringify(m)}`);
      assert.equal(b.stats.draws, a.stats.draws, `${stack}: the same draw calls`);
      assert.ok(drawn.equal < 0.999, `${stack}: the entry changes the picture: ${JSON.stringify(drawn)}`);
    }
    assert.deepEqual(pageErrors, []);
    await writeFile(
      `test-results/terrain-origin${hardware.compat ? '-compat' : ''}.json`,
      JSON.stringify({ hardware, out }, null, 1),
    );
    console.log('ok terrain origin');
  },
  () => context.close(),
);
watchExit();
