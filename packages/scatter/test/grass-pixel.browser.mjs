// Real-GPU proof (run from the repository root after building packages; --compat or MARGO_COMPAT=1 for the WebGL2
// compatibility layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/scatter/test/grass-pixel.browser.mjs
// GrassScatter draws every blade by its prefiltered coverage of each pixel, so the field keeps its coverage without
// lone pixels (KB-SCATTER-SUBPIXEL1). Dune grass (1.6 cm leaves tapering to a point) to 230 m, drawn without multisampling:
// 1. Speckle (lone pixels 24 codes brighter or darker than all eight neighbours, as @margoengine/headless `speckle`
//    counts them) stays under 50 per million at 480 x 270, with the diffuse and the PBR shader. Before coverage the
//    blades broke into lone pixels past about 20 m.
// 2. Coverage holds: the frame's mean luma is within 2 codes of the same view drawn at 1920 x 1080 and averaged down
//    4 x 4, where the filter touches only blades four times as far.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/grass-pixel.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const luma = (image) => {
  const y = new Float64Array(image.width * image.height);
  for (let i = 0; i < y.length; i++)
    y[i] = 0.2126 * image.data[i * 4] + 0.7152 * image.data[i * 4 + 1] + 0.0722 * image.data[i * 4 + 2];
  return y;
};
const speckle = ({ width, height }, y) => {
  let n = 0,
    count = 0;
  for (let r = 1; r < height - 1; r++)
    for (let x = 1; x < width - 1; x++, count++) {
      const i = r * width + x;
      let low = Infinity,
        high = -Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx || dy) {
            const v = y[i + dy * width + dx];
            low = Math.min(low, v);
            high = Math.max(high, v);
          }
      if (y[i] >= high + 24 || y[i] <= low - 24) n++;
    }
  return (1e6 * n) / count;
};
const mean = (y) => y.reduce((a, b) => a + b, 0) / y.length;
const make = async (width, height, lit) => {
  await page.setViewportSize({ width, height });
  const { errors } = await page.evaluate(([w, h, l]) => window.check.make(w, h, l), [width, height, lit]);
  assert.deepEqual(errors, [], JSON.stringify({ width, height, lit }));
  const png = await page.locator('canvas').screenshot();
  const image = await decodePNG(png);
  assert.deepEqual([image.width, image.height], [width, height]);
  return { png, image, y: luma(image) };
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const results = {};
    for (const lit of [false, true]) {
      const small = await make(480, 270, lit);
      await writeFile(`test-results/grass-pixel-${lit ? 'pbr' : 'diffuse'}.png`, small.png);
      const big = await make(1920, 1080, lit);
      const down = new Float64Array(480 * 270);
      for (let r = 0; r < 1080; r++) for (let x = 0; x < 1920; x++) down[(r >> 2) * 480 + (x >> 2)] += big.y[r * 1920 + x] / 16;
      const row = {
        speckle: +speckle(small.image, small.y).toFixed(1),
        mean: +mean(small.y).toFixed(2),
        reference: +mean(down).toFixed(2),
      };
      results[lit ? 'pbr' : 'diffuse'] = row;
      console.log(lit ? 'pbr' : 'diffuse', JSON.stringify(row));
      assert.ok(row.speckle < 50, `speckle ${row.speckle} ppm, bound 50`);
      assert.ok(Math.abs(row.mean - row.reference) < 2, `mean luma ${row.mean} against ${row.reference} at 4 x 4`);
    }
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter grass pixel floor', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
