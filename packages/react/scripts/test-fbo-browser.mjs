// useFBO on a real GPU: a fixed-size target, a canvas-sized one and one with a depth texture each match the same
// scene drawn into a hand-made texture with core views, pixel for pixel.
// Run it natively and on the WebGL2 compatibility layer:
//   npm run test:browser:fbo --workspace @margoengine/react
//   MARGO_COMPAT=1 npm run test:browser:fbo --workspace @margoengine/react
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/fbo-browser.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(60000);
try {
  await page.waitForFunction(() => window.fboProof);
  for (const mode of ['fixed', 'canvas', 'depth']) {
    await page.evaluate((mode) => window.fboProof.mount(mode), mode);
    await page.waitForFunction(
      () => window.fboProof.state.errors.length > 0 || window.fboProof.state.frames.every((n) => n > 30),
    );
    const { errors: reported, sizes, depth } = await page.evaluate(() => window.fboProof.state);
    assert.deepEqual(reported, [], mode);
    const canvas = await page.evaluate(() => {
      const element = document.querySelector('[data-side="1"] canvas');
      return [element.width, element.height];
    });
    for (const side of [0, 1]) assert.deepEqual(sizes[side], mode === 'canvas' ? canvas : [64, 64], `${mode}: target size`);
    if (mode === 'depth') assert.match(depth[1], /^depth[\w-]+x[14]$/, `${mode}: a depth texture in the scene's format`);
    else assert.equal(depth[1], '', `${mode}: no depth texture`);
    const [left, right] = await Promise.all(
      [0, 1].map(async (side) => decodePNG(await page.locator(`[data-side="${side}"] canvas`).screenshot())),
    );
    let red = 0;
    for (let i = 0; i < right.data.length; i += 4) if (right.data[i] > 150 && right.data[i + 1] < 120) red++;
    assert.ok(red > 500, `${mode}: the cube shows on the plane (${red} red pixels)`);
    assert.deepEqual(right.data, left.data, `${mode}: matches core views drawing into a texture exactly`);
    console.log(mode, 'pixels exact');
  }
  await page.evaluate(() => window.fboProof.unmount());
  await page.waitForFunction(() => window.fboProof.state.engines.every((engine) => engine.disposed));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
