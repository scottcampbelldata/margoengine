// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/sky-ambient.browser.mjs
// KB-TERRAIN-SKYAMBIENT1, on WebGPU and on the WebGL2 compatibility layer (`@margoengine/webgl2-compat`): terrain's
// ambient was a flat white `lighting.radiance[3]` that ignored `lighting.ambient` and the sky's light, and
// `Sky.add(terrain)` threw. Flat grey ground seen from above (sky-ambient.html): with no sun, `lighting.ambient`
// [1, 0.5, 0.25] colours it red over green over blue where [1, 1, 1] leaves it grey; under a clear noon sky, adding the
// sky's light to the terrain turns it bluer than the same scene without. Each case matches between the backends by the
// layer roadmap's measure (at most 0.1% of pixels with d > 2, mean d at most 0.25).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25,
  cases = ['white', 'coloured', 'skyOff', 'sky'];
// This fixture selects both backends itself; the outer forced-backend shim must not replace its native baseline.
const context = await openBrowser({
    startPath: '/packages/terrain/test/sky-ambient.html',
    port: 'free',
    compat: false,
  }),
  { page, hardware } = context;
const origin = new URL(page.url()).origin,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
async function render(mode, name) {
  await page.goto(`${origin}/packages/terrain/test/sky-ambient.html?mode=${mode}&case=${name}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  assert.deepEqual((await page.evaluate(() => window.check.info())).errors, [], `${mode} ${name}: page errors`);
  await page.evaluate(() => window.check.settle());
  const image = await decodePNG(await page.locator('canvas').screenshot());
  const info = await page.evaluate(() => window.check.info());
  assert.deepEqual(info.errors, [], `${mode} ${name}: page errors`);
  assert.equal(info.vendor === 'margo-webgl2', mode === 'compat', `${mode} ${name}: adapter vendor ${info.vendor}`);
  assert.equal(info.gl, 0, `${mode} ${name}: WebGL2 reported a GL error`);
  return image;
}
// The mean colour of the middle half of the picture (all ground).
function mean(image) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = image.height >> 2; y < (image.height * 3) >> 2; y++)
    for (let x = image.width >> 2; x < (image.width * 3) >> 2; x++) {
      const o = (y * image.width + x) * 4;
      for (let k = 0; k < 3; k++) sum[k] += image.data[o + k];
      count++;
    }
  return sum.map((v) => v / count);
}
function compare(a, b) {
  let over = 0,
    sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4,
      d = Math.max(
        Math.abs(a.data[o] - b.data[o]),
        Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2]),
      );
    if (d > 2) over++;
    sum += d;
  }
  return { share: over / n, mean: sum / n };
}
await runSuite(
  async () => {
    const native = {},
      out = {};
    for (const mode of ['native', 'compat']) {
      const colours = {};
      for (const name of cases) {
        const image = await render(mode, name);
        colours[name] = mean(image);
        if (mode === 'native') native[name] = image;
        else {
          const m = compare(native[name], image);
          colours[name + ' against native'] = m;
          assert.ok(
            m.share <= MAX_SHARE && m.mean <= MAX_MEAN,
            `${name}: the layer's pixels differ from native: ${JSON.stringify(m)}`,
          );
        }
      }
      out[mode] = colours;
      console.log(`terrain sky ambient ${mode}: ${JSON.stringify(colours)}`);
      const { white: w, coloured: c, skyOff: off, sky } = colours;
      assert.ok(
        w[0] > 20 && Math.abs(w[0] - w[1]) <= 2 && Math.abs(w[1] - w[2]) <= 2,
        `${mode}: white ambient is grey: ${w}`,
      );
      assert.ok(c[0] - c[1] > 10 && c[1] - c[2] > 10, `${mode}: lighting.ambient colours the ground: ${c}`);
      // The sky's light is blue: the ground under it is bluer than with the sky's flat white floor.
      assert.ok(
        sky[2] / sky[0] - off[2] / off[0] > 0.04,
        `${mode}: the sky's light tints the ground: ${sky} against ${off}`,
      );
    }
    assert.deepEqual(pageErrors, []);
    await writeFile('test-results/terrain-sky-ambient.json', JSON.stringify({ hardware, out }, null, 1));
    console.log('ok terrain sky ambient');
  },
  () => context.close(),
);
watchExit();
