// Real-adapter check (run from the repository root after building packages): node packages/shader/test/pass-check.mjs
// Extra outputs and scene passes read back as pixels: occlusion in the pass, an output from a graph, the lit colour, the
// screen behind a pane, a NodePass that reads an output, camera velocity, and a canvas resize.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/pass-check.html', port: 5231 }),
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
  return {
    width: image.width,
    at(y, x) {
      const o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4;
      return [...image.data.slice(o, o + 3)];
    },
  };
};
const near = (actual, expected, label, tolerance = 3) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: ${actual} != ${expected}`,
  );
const encode = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  const glow = await grab('glow');
  near(glow.at(0.5, 0.45), [255, 255, 0], 'both outputs of the material');
  near(glow.at(0.5, 0.55), [0, 0, 0], 'a plain mesh in the pass hides what it covers');
  near(glow.at(0.1, 0.1), [0, 0, 0], 'nothing drawn stays transparent black');
  console.log('ok glow');

  const graph = await grab('graph'),
    centre = graph.at(0.5, 0.5);
  near(centre, [encode(0.5), encode(0.5), 0], 'an output written by a graph');
  console.log('ok graph');

  const direct = await grab('direct'),
    lit = await grab('litColor');
  near(lit.at(0.5, 0.25), direct.at(0.5, 0.25), 'the lit colour matches the picture');
  near(lit.at(0.5, 0.75), direct.at(0.5, 0.75), 'the lit colour matches the picture');
  console.log('ok litColor');

  for (const [name, reference] of [['sunColor', 'sunDirect'], ['toneColor', 'toneDirect']]) {
    const want = (await grab(reference)).at(0.5, 0.5);
    assert.ok(want[0] > 40, `${reference} is lit: ${want}`);
    near((await grab(name)).at(0.5, 0.5), want, `${name} is encoded and tone mapped once`);
    console.log('ok', name, want);
  }

  near((await grab('emissive')).at(0.5, 0.5), [encode(0.5), 0, 0], "the material's final emissive");
  near((await grab('uniformOutput')).at(0.5, 0.5), [0, encode(0.5), 0], 'a live uniform, in an output named with a WGSL word');
  console.log('ok emissive, uniform');

  const moved = await grab('moved');
  near(moved.at(0.5, 0.5), [0, 0, 0], 'a moved mesh has left in the same frame');
  near(moved.at(0.5, 0.75), [255, 0, 0], 'and is in its new place');
  console.log('ok moved');

  const refraction = await grab('refraction');
  near(refraction.at(0.5, 0.4), [0, 0, 255], 'the pane shows the wall a quarter to its right');
  near(refraction.at(0.5, 0.1), [255, 0, 0], 'the wall itself is unchanged');
  console.log('ok refraction');

  const alone = await grab('alone');
  near(alone.at(0.5, 0.5), [0, 0, 255], 'a PassMaterial in no pass');
  console.log('ok alone');

  const post = await grab('post');
  near(post.at(0.5, 0.5), [0, 255, 0], 'a NodePass adds the output');
  near(post.at(0.1, 0.1), alone.at(0.1, 0.1), 'and leaves the background');
  console.log('ok post');

  // The viewer shows -x + 0.25 and y + 0.5: the wall slides left as the camera steps right.
  const velocity = await grab('velocity'),
    { step } = await page.evaluate(() => window.check.camera());
  near(velocity.at(0.5, 0.5), [encode(0.25 + step), encode(0.5), 0], 'the camera step in UV units', 4);
  console.log('ok velocity', step);

  const resized = await grab('resized');
  assert.equal(resized.width, 300, 'the canvas did change size');
  near(resized.at(0.5, 0.5), [255, 0, 0], 'a resized canvas reads the new targets');
  console.log('ok resized');

  assert.deepEqual(pageErrors, []);
  console.log('pass check passed');
} finally {
  await context.close();
}
