// Real-adapter check of attribute() (run from the repository root after building packages), on WebGPU and (--compat or
// MARGO_COMPAT=1) the WebGL2 layer: node packages/shader/test/attribute-check.mjs
// Meshes whose colour and shape come from named geometry attributes against the same meshes built on the CPU: two
// meshes sharing one material with their own data (also instanced, in the shadow pass, and with a position graph that
// reads none), integer attributes in the fragment stage, live full and ranged setGeometry, a material swap, SSAO and
// TAA velocity passes, and the geometry a material refuses.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/attribute-check.html', port: 5459 }),
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
  return image;
};
// Fraction of pixels that differ, and of pixels that are not the background, so an empty picture cannot pass.
const compare = (a, b) => {
  let different = 0,
    drawn = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] + a.data[i + 1] + a.data[i + 2] > 30) drawn++;
    if ([0, 1, 2].some((k) => Math.abs(a.data[i + k] - b.data[i + k]) > 8)) different++;
  }
  return { different: different / (a.data.length / 4), drawn: drawn / (a.data.length / 4) };
};
const same = async (name, reference) => {
  const { different, drawn } = compare(await grab(reference), await grab(name));
  assert.ok(drawn > 0.05, `${reference} draws something: ${drawn}`);
  assert.ok(different < 0.004, `${name} matches ${reference}: ${different} of the pixels differ`);
  console.log('ok', name, different.toFixed(5), drawn.toFixed(3));
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? 'compat' : '');
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  await same('pair', 'cpuPair');
  await same('instanced', 'cpuPair');
  await same('edited', 'cpuPair');
  await same('swapped', 'cpuPair');
  await same('shadow', 'cpuShadow');
  await same('colourOnly', 'cpuColourOnly');
  await same('integers', 'cpuIntegers');
  await grab('passes');
  console.log('ok passes');
  const messages = await page.evaluate(() => window.check.refused());
  assert.match(messages[0], /no attribute 'tint'/);
  assert.match(messages[1], /is f32, and its material reads it as vec3f/);
  assert.match(messages[2], /needs 867 values \(289 vertices of vec3f\), not 3/);
  assert.deepEqual(pageErrors, []);
  console.log('attribute check passed');
} finally {
  await context.close();
}
