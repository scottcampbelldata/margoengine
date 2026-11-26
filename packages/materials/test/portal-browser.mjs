import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const browser = await openBrowser({ startPath: '/packages/materials/test/portal-check.html', port: 5211 });
const snap = async () => decodePNG(await browser.page.locator('canvas').screenshot());
const at = (im, x, y) => [...im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 3)];
const near = (a, b, label, tolerance = 2) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tolerance, `${label}: ${a} vs ${b}`));
const ok = (r) => {
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
};
const call = (name, ...args) => browser.page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
// Camera at z 5 with a 60 degree view: 1 world unit at z 0 is 240 / (2 tan 30 deg * 5) = 41.6 px.
const k = 240 / (2 * Math.tan(Math.PI / 6) * 5),
  px = (x, y, z = 0, w = 320, h = 240, scale = k * (5 / (5 - z))) => [
    Math.round(w / 2 + x * scale),
    Math.round(h / 2 - y * scale),
  ];
const RED = [255, 0, 0],
  GREEN = [0, 255, 0],
  BLACK = [0, 0, 0];
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  assert.deepEqual(await call('refs'), [1, 2], 'unique references in order');
  ok(await call('frame'));
  let image = await snap();
  near(at(image, ...px(-1, 0)), RED, 'inside window A: its red contents');
  near(at(image, ...px(1, 0)), GREEN, 'inside window B: its green contents');
  near(at(image, ...px(-1.3, 0.3)), RED, 'window A corner region');
  for (const [x, y] of [
    [0, 0],
    [-2.2, 0],
    [2.2, 0],
    [-1, 1],
    [1, -1],
  ])
    near(at(image, ...px(x, y)), BLACK, `outside both windows at ${x},${y}: the masks draw no colour`);
  ok(await call('inverse', true));
  image = await snap();
  near(at(image, ...px(-1, 0)), BLACK, 'inverse: nothing inside window A');
  near(at(image, ...px(0, 0)), RED, 'inverse: red outside window A');
  near(at(image, ...px(1, 0)), RED, 'inverse: red in front of green in window B');
  ok(await call('inverse', false));
  assert.deepEqual(await call('limit'), [3, 'state'], 'the third reference is the last; a fourth is refused');
  assert.equal(await call('shared'), 'state', 'a material already in a portal is refused');
  const removed = await call('remove');
  ok(removed);
  assert.deepEqual(removed.mask, [true, false, 0], 'mask material state and order restored');
  assert.deepEqual(removed.content, [false, 'always', 0], 'contents state and order restored');
  image = await snap();
  near(at(image, ...px(0, 1.5)), RED, 'after remove the red backdrop draws everywhere');
  near(at(image, ...px(-1, 0)), [255, 255, 255], 'after remove the mask draws its own colour');
  // Second-scene portal: the other scene, drawn with the same camera, shows on the window's surface only.
  ok(await call('scene'));
  const portal = await snap();
  assert.equal(await call('reference'), null);
  const reference = await snap();
  let inside = 0;
  for (let x = -0.9; x <= 0.9; x += 0.3)
    for (let y = -0.7; y <= 0.7; y += 0.35) {
      near(at(portal, ...px(x, y)), at(reference, ...px(x, y)), `scene portal at ${x},${y}`, 3);
      inside++;
    }
  assert.ok(inside >= 25);
  near(at(portal, ...px(0, 0)), at(reference, ...px(0, 0)), 'the other scene box shows through');
  assert.ok(at(reference, ...px(0, 0))[0] > 120, 'the reference centre is the lit yellow box');
  near(at(portal, ...px(-0.9, 0.7)), [0x33, 0x66, 0xcc], 'the other scene background shows inside', 3);
  near(at(portal, ...px(0, 1.5)), RED, 'outside the window the main scene draws');
  const resized = await call('resize');
  ok(resized);
  assert.deepEqual(resized.size, [400, 300], 'the picture follows the canvas size');
  ok(await call('restore'));
  assert.deepEqual(await call('dispose'), [true, 'disposed']);
  console.log(
    'portal: two windows, inverse, reference limit, shared refusal, restore on remove, second scene, resize, device restore and disposal passed',
    JSON.stringify(browser.hardware),
  );
} finally {
  await browser.close();
}
