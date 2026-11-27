// Real-GPU check that loadOBJ draws a textured MTL material: quad.obj + quad.mtl + checker.png (red, green / blue,
// yellow) on a quad that fills the frame. Each quadrant of the picture must show its texel's colour, so the UVs, the
// `map_Kd` texture and its row order all reach the screen, and WebGPU must report no validation error.
// Run from the repository root after building packages, natively and with MARGO_COMPAT=1:
//   node packages/loaders/tests/mtl-gpu-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const compat = compatRun();
const context = await openBrowser({ startPath: '/packages/loaders/tests/mtl-gpu.html', port: 5293 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const info = await page.evaluate(() => window.check.draw());
  assert.deepEqual(info.warnings, []);
  const shot = await decodePNG(await page.locator('#a').screenshot()),
    at = (x, y) => Array.from(shot.data.slice((y * shot.width + x) * 4, (y * shot.width + x) * 4 + 3));
  // The first image row is the texture's top (v = 1): red, green on top, blue, yellow below.
  const expect = {
      topLeft: [32, 32, 'r'],
      topRight: [96, 32, 'g'],
      bottomLeft: [32, 96, 'b'],
      bottomRight: [96, 96, 'y'],
    },
    dominant = { r: [0], g: [1], b: [2], y: [0, 1] };
  for (const [name, [x, y, key]] of Object.entries(expect)) {
    const px = at(x, y),
      high = dominant[key],
      low = [0, 1, 2].filter((c) => !high.includes(c));
    console.log(`${name}${compat ? ' (compat)' : ''}: rgb ${px.join(',')}`);
    for (const c of high) assert.ok(px[c] > 120, `${name} channel ${c} is bright (${px})`);
    for (const c of low) assert.ok(px[c] < 60, `${name} channel ${c} is dark (${px})`);
  }
  // map_Ks, disp and a refl map of either kind compile and draw together.
  for (const cubed of [false, true]) {
    const maps = await page.evaluate((cube) => window.check.draw('quad-maps', cube), cubed);
    assert.deepEqual(maps.warnings, []);
    const frame = await decodePNG(await page.locator('#a').screenshot()),
      centre = Array.from(frame.data.slice((32 * frame.width + 32) * 4, (32 * frame.width + 32) * 4 + 3));
    console.log(`maps ${cubed ? 'cube' : 'sphere'}${compat ? ' (compat)' : ''}: rgb ${centre.join(',')}`);
    assert.ok(Math.max(...centre) > 60, `the quad with every map is drawn (${centre})`);
  }
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
console.log('loader MTL textured draw check passed');
