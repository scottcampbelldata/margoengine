// Real-GPU proof of the borrowed-object rule for RawShaderMaterial textures and storage buffers across a device restore
// (KB-RESTORE-BORROWED1). Run from the repository root after building packages, under the lock:
// node scripts/run-with-timeout.mjs --max=10 -- node packages/shader/test/raw-restore-browser-check.mjs
// (MARGO_COMPAT=1 for the WebGL2 compatibility layer.) Yellow (a red texture plus a green buffer) turns white after the
// restore (the texture's white stand-in plus the buffer's zeroed one), with no validation error and one 'state' report
// for each, and is yellow again with a new texture and buffer, and with function forms made once per device.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/shader/test/raw-restore-browser-check.html', port: 5266 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const centre = async () => {
  const png = await decodePNG(await page.locator('canvas').screenshot()),
    o = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
  return [...png.data.slice(o, o + 3)];
};
const is = (actual, expected, label) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= 2),
    `${label}: [${actual}] vs [${expected}]`,
  );
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const step = (name) => page.evaluate((n) => window.check.step(n), name);
  await step('frames');
  await step('build');
  is(await centre(), [255, 255, 0], 'a texture given at construction plus the green buffer');
  assert.deepEqual(
    await page.evaluate(() => window.check.errors()),
    [],
    'a texture given at construction binds (KB-COMPAT-RAWFIRST1)',
  );
  await step('plain');
  is(await centre(), [255, 255, 0], 'the red texture plus the green buffer');
  assert.ok(await step('restore'), 'the engine restored a new device');
  is(await centre(), [255, 255, 255], 'lost plain ones read white plus zero');
  const reported = await page.evaluate(() => window.check.reported());
  assert.equal(reported.length, 2, `one report each: ${JSON.stringify(reported)}`);
  assert.match(reported[0], /^state RawShaderMaterial texture lost with the device.*#borrowed-lost/);
  assert.match(reported[1], /^state RawShaderMaterial storage buffer lost with the device.*#borrowed-lost/);
  await step('fresh');
  is(await centre(), [255, 255, 0], 'new ones bring yellow back');
  await step('function');
  is(await centre(), [255, 255, 0], 'function forms draw yellow');
  assert.ok(await step('restore'), 'a second restore');
  is(await centre(), [255, 255, 0], 'function forms are back after the restore');
  assert.equal(await page.evaluate(() => window.check.made()), 2, 'the texture function is made once per device');
  assert.deepEqual(await page.evaluate(() => window.check.errors()), [], 'no validation error or throw');
  assert.equal((await page.evaluate(() => window.check.reported())).length, 2, 'no report for the function forms');
  assert.deepEqual(pageErrors, []);
  console.log('raw shader restore browser check passed');
} finally {
  await context.close();
}
