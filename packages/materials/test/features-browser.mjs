// Real-GPU checks of the optional material features (features.html draws, this judges the numbers).
// Run from the repository root after `npm run build:packages`: node packages/materials/test/features-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const only = process.argv[2],
  release = await acquire({ owner: 'materials-features' });
const context = await openBrowser({ startPath: '/packages/materials/test/features.html', port: 5271 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const check = (name, ...args) => page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
const near = (a, b, label, tolerance = 0.02) =>
  a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) <= tolerance, `${label}: ${a} should be ${b}`));
const jobs = {
  async layered() {
    const run = async (kind) => {
      const out = await page.evaluate((k) => window.check.layeredCheck(k), kind);
      for (const r of Array.isArray(out) ? out : [out]) assert.deepEqual(r.errors, [], kind);
      return out;
    };
    const blue = [0, 0, 1],
      red = [1, 0, 0],
      green = [0, 1, 0];
    let r = await run('mask');
    near(r.left, blue, 'mask keeps the material where it is black');
    near(r.right, red, 'mask shows the layer where it is white');
    r = await run('packed');
    near(r.left, blue, 'channel g of a packed mask');
    near(r.right, red, 'channel g of a packed mask');
    r = await run('opacity');
    near(r.left, [0.25, 0, 0.75], 'opacity mixes in linear light');
    r = await run('order');
    near(r.left, red, 'lower layer');
    near(r.right, green, 'upper layer covers the lower one');
    r = await run('vertex');
    assert.ok(r.left[0] < r.right[0], `vertex weight ramps: ${r.left} to ${r.right}`);
    near([r.left[0] + r.left[2], r.right[0] + r.right[2]], [1, 1], 'colours no longer tint: the two layers add to one');
    const [low, mid, high] = await run('height');
    near(low.left, blue, 'height at weight 0');
    near(low.right, blue, 'height at weight 0');
    near(mid.left, blue, 'low ground stays under at weight 0.5');
    near(mid.right, red, 'high ground shows first at weight 0.5');
    near(high.left, red, 'height at weight 1');
    near(high.right, red, 'height at weight 1');
    r = await run('array');
    near(r.left, green, 'layer 1 of the array');
    r = await run('shared');
    assert.equal(r.slots, 1, 'one texture used twice takes one slot');
    near(r.left, blue, 'shared mask');
    near(r.right, [0.5, 0.5, 0], 'shared mask');
    r = await run('tiling');
    assert.equal(r.steps, 7, 'tiling 4 draws four black and white pairs');
    r = await run('detail');
    near(r.grey, [0.5, 0.5, 0.5], 'grey detail leaves the surface', 0.02);
    near(r.dark, [0.25, 0.25, 0.25], 'detail darkens', 0.02);
    near(r.half, [0.375, 0.375, 0.375], 'strength halves it', 0.02);
    r = await run('surface');
    near(r.left, [0.8, 0, 0], 'surface numbers under the mask', 0.01);
    near(r.right, [0.25, 1, 0], 'layer roughness and metalness', 0.01);
    r = await run('normal');
    near(r.left, [0.5, 0.5, 1], 'normal under the mask', 0.02);
    assert.ok(r.right[0] > 0.9 && r.right[2] < 0.6, `layer normal points to +x: ${r.right}`);
    assert.ok(Math.abs(r.detail[1] - 0.5) > 0.3 && r.detail[0] < 0.55, `detail normal tilts along green: ${r.detail}`);
    assert.equal(Math.sign(r.detail[1] - 0.5), Math.sign(r.plain[1] - 0.5), `detail green as a normal map's: ${r.detail}, ${r.plain}`);
    r = await run('live');
    near(r.before, blue, 'live opacity 0');
    near(r.after, red, 'live opacity 1');
    console.log('layered: masks, packed channel, order, vertex, height, array, tiling, detail, surface, normals, live');
  },
  async alphaHash() {
    for (const instanced of [false, true])
      for (const alpha of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const { coverage, errors } = await check('hashCoverage', alpha, instanced);
        console.log(JSON.stringify({ label: 'hash coverage', instanced, alpha, coverage }));
        assert.deepEqual(errors, []);
        // 16,384 pixels: a binomial's standard deviation is 0.004 at most; correlated cells widen it.
        assert.ok(Math.abs(coverage - alpha) < 0.02, `alpha ${alpha} covers ${coverage}`);
      }
    const { same, errors } = await check('hashStable');
    console.log(JSON.stringify({ label: 'hash stays on the surface', same }));
    assert.deepEqual(errors, []);
    assert.ok(same > 0.99, `only ${same} of the pattern moved with the surface`);
    const off = await check('hashTAA', false),
      strict = await check('hashTAA', true),
      on = await check('hashTAA', 'stochastic');
    console.log(JSON.stringify({ label: 'hash and TAA', off, strict, on }));
    assert.deepEqual(off.errors, []);
    assert.deepEqual(on.errors, []);
    assert.ok(Math.abs(on.mean - off.mean) < 0.05, 'TAA keeps the mean');
    assert.ok(on.pixelSpread < off.pixelSpread * 0.7, `TAA leaves grain ${on.pixelSpread} of ${off.pixelSpread}`);
  },
  async ktx2() {
    for (const [name, kind, images] of [
      ['cube-uastc-zstd', 'cube', 6],
      ['array-uastc', 'array', 3],
      ['cube-etc1s', 'cube', 6],
    ]) {
      const got = await check('ktx2', name, kind);
      console.log(JSON.stringify({ label: `ktx2 ${name}`, ...got }));
      assert.deepEqual(got.errors, []);
      assert.equal(got.instance, true);
      assert.equal(got.images, images);
      assert.equal(got.depth, images);
      assert.equal(got.same, true, 'the GPU copy holds the decoded texels of every level');
      assert.equal(got.compressedLayers, images);
      assert.notEqual(got.format.replace('-srgb', ''), 'rgba8unorm');
      // The drawn colour against the four middle texels, mixed (8-bit output, 8-bit interpolation weights).
      for (const { got: shown, want } of got.shown)
        shown.forEach((v, c) => assert.ok(Math.abs(v - want[c]) <= 3, `${name}: drew ${shown}, texels mix to ${want}`));
    }
    const native = await check('ktx2Native');
    console.log(JSON.stringify({ label: 'ktx2 native', ...native }));
    assert.deepEqual(native.errors, []);
    assert.equal(native.instance, true);
    assert.ok(native.centre.some((v) => v > 0), 'the stored file lights the surface');
    assert.match(native.refused, /cube arrays have no material slot/);
  },
  async objectNormal() {
    const s = Math.SQRT1_2,
      wide = Math.hypot(0.5, 1);
    const want = {
      plain: [0, 0, 1],
      turned: [s, 0, s],
      sideways: [1, 0, 0],
      stretched: [0.5 / wide, 0, 1 / wide],
      mirrored: [-s, 0, s],
      instanced: [s, 0, s],
      zUp: [0, s, s],
      halfScale: [s, 0, s],
    };
    for (const [name, normal] of Object.entries(want)) {
      const got = await check('objectNormal', name);
      console.log(JSON.stringify({ label: `object normal ${name}`, ...got, want: normal.map((v) => +v.toFixed(2)) }));
      assert.deepEqual(got.errors, []);
      // 8-bit output: 2 / 255 per step, and an 8-bit map.
      got.normal.forEach((v, k) => assert.ok(Math.abs(v - normal[k]) < 0.03, `${name}: ${got.normal}`));
    }
  },
};
let failed = false;
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const [name, run] of Object.entries(jobs)) {
    if (only && only !== name) continue;
    await run();
    console.log(`ok ${name}`);
  }
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failed = true;
  console.error(error);
  console.error(pageErrors);
} finally {
  await context.close();
  await release();
}
process.exit(failed ? 1 : 0);
