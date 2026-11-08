// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/compat.browser.mjs
// The clipmap terrain on the WebGL2 compatibility layer (`@margoengine/webgl2-compat`, install({force: true})): each
// case (rules only; painted weights and a hole; a runtime virtual texture) draws the same scene natively and on the
// layer, in exact-pixel mode on the same GPU and browser, and the canvases are compared with the layer roadmap's
// measure (decision 4: at most 0.1% of pixels with d > 2, mean d at most 0.25, d the largest RGB difference). Neither
// side may report a page error, the layer no GL error. The cost on the layer is counted, not timed: a frame's GL calls
// and GL draws against the engine's draw calls.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;
const context = await openBrowser({ startPath: '/packages/terrain/test/compat.html', port: 'free' }),
  { page, hardware } = context;
const origin = new URL(page.url()).origin,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
async function render(mode, name) {
  await page.goto(`${origin}/packages/terrain/test/compat.html?mode=${mode}&case=${name}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  assert.deepEqual((await page.evaluate(() => window.check.info())).errors, [], `${mode} ${name}: page errors`);
  const cost = await page.evaluate(() => window.check.cost());
  const image = await decodePNG(await page.locator('canvas').screenshot());
  const info = await page.evaluate(() => window.check.info());
  assert.deepEqual(info.errors, [], `${mode} ${name}: page errors`);
  assert.equal(info.vendor === 'margo-webgl2', mode === 'compat', `${mode} ${name}: adapter vendor ${info.vendor}`);
  assert.equal(info.gl, 0, `${mode} ${name}: WebGL2 reported a GL error`);
  return { image, cost };
}
function compare(a, b) {
  let over = 0,
    sum = 0,
    max = 0,
    ground = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4,
      d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
    if (d > 2) over++;
    sum += d;
    max = Math.max(max, d);
    if (b.data[o] + b.data[o + 1] + b.data[o + 2] > 60) ground++;
  }
  return { share: over / n, mean: sum / n, max, ground };
}
await runSuite(
  async () => {
    const out = {};
    for (const name of ['clipmap', 'weights', 'rvt']) {
      const native = await render('native', name),
        compat = await render('compat', name),
        m = compare(native.image, compat.image);
      out[name] = { ...m, native: native.cost, compat: compat.cost };
      console.log(`terrain compat ${name}: ${JSON.stringify(out[name])}`);
      assert.ok(m.ground > 20000, `${name}: the terrain fills the view: ${m.ground}`);
      assert.ok(m.share <= MAX_SHARE && m.mean <= MAX_MEAN, `${name}: the layer's pixels differ from native: ${JSON.stringify(m)}`);
      assert.equal(compat.cost.drawCalls, native.cost.drawCalls, `${name}: the same draws on both`);
      assert.ok(compat.cost.glDraws >= compat.cost.drawCalls, `${name}: every draw reaches GL: ${JSON.stringify(compat.cost)}`);
      // The virtual texture baked its cache on the layer, as many texels as natively; the other cases have none.
      assert.equal(compat.cost.baked, native.cost.baked, `${name}: the same texels baked on both`);
      assert.equal(compat.cost.baked > 0, name === 'rvt', `${name}: texels baked: ${compat.cost.baked}`);
    }
    assert.deepEqual(pageErrors, []);
    await writeFile('test-results/terrain-compat.json', JSON.stringify({ hardware, out }, null, 1));
    console.log('ok terrain compat');
  },
  () => context.close(),
);
watchExit();
