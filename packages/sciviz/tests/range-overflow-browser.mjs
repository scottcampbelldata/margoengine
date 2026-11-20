// Regression: a surface, mesh or graph colour range past the float32 limit coloured every value NaN on the GPU (the
// range reached the shader as float32, so [-1e308, 1e308] became [-Infinity, Infinity]). Values of 0 sit halfway along
// [-1, 1] and [-1e308, 1e308]: both captures must match, on WebGPU and on the WebGL2 compatibility layer. From the
// repository root:
//   node scripts/run-with-timeout.mjs -- node packages/sciviz/tests/range-overflow-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/range-overflow.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => window.ready);
    const capture = (o) => browser.page.evaluate((options) => window.capture(options), o);
    for (const kind of ['surface', 'mesh', 'graph']) {
      const near = await capture({ kind, range: [-1, 1] }),
        far = await capture({ kind, range: [-1e308, 1e308] });
      let drawn = 0,
        differing = 0;
      for (let i = 0; i < near.length; i += 4) {
        if (near[i] !== near[0] || near[i + 1] !== near[1] || near[i + 2] !== near[2]) drawn++;
        if (Math.max(...[0, 1, 2].map((c) => Math.abs(near[i + c] - far[i + c]))) > 1) differing++;
      }
      console.log(compat ? 'webgl2' : 'webgpu', kind, JSON.stringify({ drawn, differing }));
      assert.ok(drawn > 500, `${kind} draws: ${drawn} pixels`);
      assert.equal(differing, 0, `${kind} with range [-1e308, 1e308] colours 0 as [-1, 1] does`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
console.log('sciviz range past float32 check passed');
