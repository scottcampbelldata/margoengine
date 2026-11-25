// Real-GPU check of KB3108: each fixture document of fixtures/materialx-reference, converted by toGraph and drawn by
// the node material, against the MaterialX 1.39.5 GLSL bake of the same document (oracle/materialx-bake.py) drawn the
// same way under the same light. The bake stores 8-bit sRGB, so the pictures may differ by rounding only; the light and
// the lit model are Margo's on both sides (no claim of parity with MaterialXView's lighting). Prints the largest and the
// mean channel difference per case, then asserts the bound. Run from the repository root
// after building packages, natively and with MARGO_COMPAT=1:
//   node packages/loaders/tests/materialx-reference-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const cases = [
    'image-srgb',
    'image-linear',
    'multiply',
    'add-subtract',
    'mix',
    'weight',
    'gltf-image',
    'preview-image',
  ],
  compat = compatRun();
const context = await openBrowser({ startPath: '/packages/loaders/tests/materialx-reference.html', port: 5291 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const shot = async (name, file) => {
    const skipped = await page.evaluate((args) => window.check.draw(...args), [name, file]);
    assert.deepEqual(skipped, [], `${name}/${file} skipped ${skipped}`);
    return decodePNG(await page.locator('#a').screenshot());
  };
  const failures = [];
  for (const name of cases) {
    const ours = await shot(name, 'source.mtlx'),
      theirs = await shot(name, 'baked.mtlx');
    assert.equal(ours.data.length, theirs.data.length);
    let max = 0,
      sum = 0,
      count = 0,
      lit = 0;
    for (let k = 0; k < ours.data.length; k += 4)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(ours.data[k + c] - theirs.data[k + c]);
        max = Math.max(max, d);
        sum += d;
        count++;
        if (ours.data[k + c] > 8) lit++;
      }
    const mean = sum / count;
    console.log(
      `${name}${compat ? ' (compat)' : ''}: max ${max}, mean ${mean.toFixed(4)} of 255, lit ${((lit / count) * 100).toFixed(1)}%`,
    );
    // The picture is drawn (gltf_pbr defaults to metal, so its plane is the darkest: 50% of channels lit), and the
    // bake's picture differs from ours by the 8-bit sRGB rounding of a baked texel only: measured at most 1 code on
    // the A6000, natively and on the WebGL2 layer (2026-11-11).
    if (lit / count < 0.4) failures.push(`${name}: only ${lit} of ${count} channels lit`);
    if (max > 1) failures.push(`${name}: max ${max} codes apart`);
  }
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failures, []);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
console.log('loader MaterialX reference check passed');
