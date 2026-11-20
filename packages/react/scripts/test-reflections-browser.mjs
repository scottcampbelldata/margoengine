// Real-GPU checks of the reflection components and of Fog in a named Scene (`MARGO_COMPAT=1` for the WebGL2 layer).
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/reflections-browser.html' });
const { page } = browser,
  errors = [],
  rows = [];
page.setDefaultTimeout(30000);
page.on('pageerror', (error) => errors.push(error.message));
const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
const red = (p) => p[0] > 120 && p[1] < 40 && p[2] < 40;
const green = (p) => p[1] > 120 && p[0] < 40 && p[2] < 40;
const dark = (p) => p.every((v) => v < 30);
// Each mode: what the centre and the corner of the canvas must show.
const checks = {
  'cube-camera': { centre: red, corner: dark },
  'cube-camera-fog': { centre: green, corner: dark },
  'cube-camera-fog-off': { centre: red, corner: dark },
  'cube-camera-scene-fog': { centre: green, corner: dark },
  // The sky lights the mirror ball well above the default lighting's grey (about 100 summed).
  'cube-camera-env-map': { centre: (p) => p[0] + p[1] + p[2] > 150, corner: dark },
  'scene-fog': { centre: green, corner: dark },
  'no-env-map': { centre: (p) => !red(p), corner: dark },
  'mesh-reflector': { centre: red, corner: dark },
  'mesh-reflector-off': { centre: (p) => !red(p) && p[0] > 0, corner: dark },
  // The ball's left limb (toward the softbox) is red-lit; its right limb is not.
  lightformer: {
    centre: (p) => p[0] > 0,
    corner: dark,
    left: (p) => p[0] > p[1] + 40 && p[0] > p[2] + 40,
    right: (p) => p[0] < 100,
  },
  'lightformer-hidden': { centre: (p) => !green(p), corner: dark },
  'lightformer-outside': { centre: green, corner: dark },
};
try {
  await page.waitForFunction(() => window.reflections);
  const selected = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
  for (const mode of selected ? [selected] : Object.keys(checks)) {
    await page.evaluate((mode) => window.reflections.mount(mode), mode);
    await page.waitForFunction(() => window.reflections.state.frames > 20);
    assert.deepEqual(await page.evaluate(() => window.reflections.state.errors), [], mode);
    const image = await decodePNG(await page.locator('section canvas').screenshot()),
      centre = pixel(image, image.width >> 1, image.height >> 1),
      corner = pixel(image, 4, 4);
    assert.ok(checks[mode].centre(centre), `${mode}: centre ${centre}`);
    assert.ok(checks[mode].corner(corner), `${mode}: corner ${corner}`);
    // Left and right limbs of a ball 1 across at the origin: 0.6 of its radius either side of the centre.
    const limb = Math.round((image.width / 2) * (0.6 / (4 * Math.tan((25 * Math.PI) / 180)))),
      left = pixel(image, (image.width >> 1) - limb, image.height >> 1),
      right = pixel(image, (image.width >> 1) + limb, image.height >> 1);
    if (checks[mode].left) assert.ok(checks[mode].left(left), `${mode}: left ${left}`);
    if (checks[mode].right) assert.ok(checks[mode].right(right), `${mode}: right ${right}`);
    rows.push({ mode, centre, corner, left, right });
  }
  await page.evaluate(() => window.reflections.unmount());
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/react-reflections${compatRun() ? '-compat' : ''}.json`,
    JSON.stringify({ hardware: browser.hardware, rows }, null, 2),
  );
  console.log(JSON.stringify(rows));
} finally {
  await browser.close();
}
