// Real-GPU check for @margoengine/materials/batched-lod: an item outside the view is collapsed by the batch's compute
// pass and comes back in view, a level switch swaps the geometry drawn, and both survive a device restore. Run from
// the repository root after building packages, on WebGPU and (with --compat) on the WebGL2 compatibility layer:
//   node packages/materials/test/batched-lod-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';

const compat = compatRun(),
  browser = await openBrowser({ startPath: '/packages/materials/test/batched-lod-check.html', port: 'free' }),
  pageErrors = [];
browser.page.on('pageerror', (e) => pageErrors.push(e.message));
const snap = async () => decodePNG(await browser.page.locator('canvas').screenshot());
const at = (im, x, y) => [...im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 3)];
const near = (a, b, label, tolerance = 2) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tolerance, `${label}: ${a} vs ${b}`));
const call = async (name, ...args) => {
  const r = await browser.page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  return r;
};
// A 60 degree view 240 px high: one world unit at the target plane is 240 / (2 tan 30 deg * distance) px.
const px = (x, distance, eye = 0) => [
  Math.round(160 + ((x - eye) * 240) / (2 * Math.tan(Math.PI / 6) * distance)),
  120,
];
const RED = [255, 0, 0],
  GREEN = [0, 255, 0],
  BLACK = [0, 0, 0];
// Batch items: 0 and 1 are the red item's fine and coarse levels, 2 the green item.
const shows = (r, want, label) =>
  assert.deepEqual(
    [0, 1, 2].map((id) => r.reach[id] > 0),
    want,
    `${label}: batch items the compute pass left in place (${JSON.stringify(r.reach)})`,
  );
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const close = async (label) => {
    const r = await call('frame', [0, 0, 5], [0, 0, 0]),
      image = await snap();
    assert.deepEqual(r.levels, [0, 0], label);
    shows(r, [true, false, true], label);
    assert.deepEqual([r.stats.drawn, r.stats.culled, r.stats.triangles], [2, 0, 4], label);
    near(at(image, ...px(-1, 5)), RED, `${label}: the red item's centre`);
    near(at(image, ...px(-1.45, 5)), RED, `${label}: the fine level reaches 0.6 from its centre`);
    near(at(image, ...px(2.5, 5)), GREEN, `${label}: the green item`);
    near(at(image, ...px(0.8, 5)), BLACK, `${label}: between the items`);
  };
  await close('close');
  // Past the switch distance of 8 the small coarse geometry is the one drawn.
  let r = await call('frame', [0, 0, 12], [0, 0, 0]),
    image = await snap();
  assert.deepEqual(r.levels, [1, 0]);
  shows(r, [false, true, true], 'far');
  near(at(image, ...px(-1, 12)), RED, 'far: the coarse level at the item centre');
  near(at(image, ...px(-1.45, 12)), BLACK, 'far: the coarse level ends 0.15 from its centre');
  near(at(image, ...px(2.5, 12)), GREEN, 'far: the green item');
  // Camera moved 3 to the left: the green item (x 2 to 3, 5 to 6 from the view axis, which reaches 3.85) is outside.
  r = await call('frame', [-3, 0, 5], [-3, 0, 0]);
  image = await snap();
  assert.deepEqual(r.levels, [0, -1]);
  shows(r, [true, false, false], 'turned away');
  assert.deepEqual([r.stats.drawn, r.stats.culled, r.stats.triangles], [1, 1, 2]);
  near(at(image, ...px(-1, 5, -3)), RED, 'turned away: the red item, fine again');
  near(at(image, ...px(-1.45, 5, -3)), RED, 'turned away: its fine level');
  await close('back');
  r = await call('frame', [0, 0, 12], [0, 0, 0]);
  r = await call('restore');
  image = await snap();
  assert.deepEqual(r.levels, [1, 0], 'after a device restore the levels stand');
  shows(r, [false, true, true], 'restored');
  near(at(image, ...px(-1, 12)), RED, 'restored: the coarse level');
  near(at(image, ...px(-1.45, 12)), BLACK, 'restored: not the fine one');
  near(at(image, ...px(2.5, 12)), GREEN, 'restored: the green item');
  r = await call('dispose');
  image = await snap();
  assert.equal(r.count, 0, 'disposing takes the items out of the batch');
  near(at(image, ...px(-1, 12)), BLACK, 'disposed: nothing drawn');
  near(at(image, ...px(2.5, 12)), BLACK, 'disposed: nothing drawn');
  assert.deepEqual(pageErrors, []);
  console.log(
    `batched-lod (${compat ? 'webgl2-layer' : 'webgpu'}): culled item collapsed and restored, level swap by distance, device restore and disposal passed`,
    JSON.stringify(browser.hardware),
  );
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
