// Real-adapter check (run from the repository root after building packages): node packages/shader/test/lighting-check.mjs
// The lighting nodes against the lighting they read: sun visibility under a real shadow map, a lighting model in the graph
// against the same model as a material shading, and litColor, localLight and ambientLight against a plain Material with
// the same effects attached.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/lighting-check.html', port: 5223 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const grab = async (name) => {
  const { errors } = await page.evaluate((n) => window.check.run(n), name);
  assert.deepEqual(errors, [], name);
  const image = await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(() => window.check.clear());
  return (y, x) => {
    const o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4;
    return [...image.data.slice(o, o + 3)];
  };
};
const near = (actual, expected, label, tolerance = 2) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: ${actual} != ${expected}`,
  );
const same = async (a, b, points = [[0.5, 0.5], [0.5, 0.55], [0.42, 0.6], [0.35, 0.35], [0.6, 0.45]]) => {
  const left = await grab(a),
    right = await grab(b);
  for (const [y, x] of points) near(left(y, x), right(y, x), `${a} and ${b} at ${y}, ${x}`);
  return left;
};
// sRGB encoding of linear 0.5.
const half = 188,
  grey = [half, half, half],
  black = [0, 0, 0];
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  for (const [i, errors] of (await page.evaluate(() => window.check.variants())).entries())
    assert.deepEqual(errors, [], `shader variant ${i}`);
  console.log('ok variants');

  near((await grab('sunVisibility'))(0.5, 0.5), grey, 'sun with no shadow effect');
  const shadow = await grab('shadowed');
  near(shadow(0.5, 0.55), black, 'sunVisibility in the shadow');
  near(shadow(0.5, 0.38), grey, 'sunVisibility beside the shadow');
  console.log('ok sun visibility');
  near((await grab('sunDirection'))(0.5, 0.5), [0, half, 0], 'sunDirection');

  const stepped = await grab('stepped');
  assert.ok(stepped(0.5, 0.42)[0] > 100, `left of the step ${stepped(0.5, 0.42)}`);
  near(stepped(0.5, 0.58), black, 'right of the step');
  console.log('ok stage inputs in a light model');

  await same('lambertNodes', 'lambertPlain');
  console.log('ok a graph model equals the material model, sun and point light');
  await same('litNodes', 'litPlain');
  await same('localNodes', 'localPlain');
  await same('ambientNodes', 'ambientPlain');
  console.log('ok litColor, localLight and ambientLight equal a plain Material');

  // 0.5 of the gradient: 1 at the top, (0.35, 0.3, 0.25) at the bottom, sRGB encoded.
  near((await grab('skyUp'))(0.5, 0.5), grey, 'sky above');
  near((await grab('skyDown'))(0.5, 0.5), [116, 108, 99], 'sky below');
  await same('mirrorNodes', 'mirrorPlain', [[0.5, 0.5]]);
  console.log('ok environment');

  const varied = await grab('varying');
  assert.ok(varied(0.45, 0.6)[0] > varied(0.45, 0.4)[0], 'lightingNode varying grows to the right');
  assert.ok(varied(0.4, 0.5)[0] > varied(0.6, 0.5)[0], 'lightModel varying grows upwards');
  assert.deepEqual(pageErrors, []);
  console.log('lighting check passed');
} finally {
  await context.close();
}
