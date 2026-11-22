// Real-GPU proof of the borrowed-object rule for Shadertoy texture channels across a device restore
// (KB-RESTORE-BORROWED1). Run from the repository root after building packages:
// node packages/shader/test/shadertoy-restore-browser-check.mjs (--compat for the WebGL2 compatibility layer). Yellow
// (a red 2D channel plus a green 3D channel made by a function) turns green after the restore (the lost red channel
// reads opaque black), with no validation error and one 'state' report naming iChannel0, and is yellow again after
// toy.setChannel, and with a function form made once per device.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({
    startPath: '/packages/shader/test/shadertoy-restore-browser-check.html',
    port: 5267,
  }),
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
  is(await centre(), [255, 255, 0], 'the red 2D channel plus the green 3D channel');
  assert.ok(await step('restore'), 'the engine restored a new device');
  is(await centre(), [0, 255, 0], 'the lost plain channel reads black; the function channel is back');
  const reported = await page.evaluate(() => window.check.reported());
  assert.equal(reported.length, 1, `one report: ${JSON.stringify(reported)}`);
  assert.match(
    reported[0],
    /^state Shadertoy iChannel0 lost with the device; pass a function or call toy\.setChannel\(0, texture\).*#borrowed-lost/,
  );
  await step('fresh');
  is(await centre(), [255, 255, 0], 'setChannel brings red back');
  await step('function');
  is(await centre(), [255, 255, 0], 'the function form draws red');
  assert.ok(await step('restore'), 'a second restore');
  is(await centre(), [255, 255, 0], 'function forms are back after the restore');
  assert.deepEqual(await page.evaluate(() => window.check.made()), [2, 3], 'each function is made once per device');
  assert.deepEqual(await page.evaluate(() => window.check.errors()), [], 'no validation error or throw');
  assert.equal((await page.evaluate(() => window.check.reported())).length, 1, 'no report for the function forms');
  assert.deepEqual(pageErrors, []);
  console.log('shadertoy restore browser check passed');
} finally {
  await context.close();
}
