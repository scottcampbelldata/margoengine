// Real-browser check (run from the repository root after building packages): node packages/viewcube/test/browser-check.mjs
// CSS 3D hit testing of faces, edges and corners with real mouse clicks, the animated views with a running engine and
// OrbitControls, keyboard focus and Home, the projection toggle, and the rendered top view.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/viewcube/test/browser-check.html', port: 5210 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
});
const near = (a, b, label, eps = 1e-3) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]) <= eps),
    `${label}: ${a} != ${b}`,
  );
const s2 = Math.SQRT1_2,
  s3 = 1 / Math.sqrt(3);
const click = async (view) => {
  const at = await page.evaluate((v) => window.check.cell(v), view);
  assert.ok(at, `no visible cell for ${view}`);
  await page.mouse.click(at.x, at.y);
  const r = await page.evaluate(() => window.check.settle());
  assert.deepEqual(r.errors, []);
  assert.ok(!r.animating, view + ' still animating');
  return r;
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  assert.equal(
    await page.evaluate(() => window.check.cell('0,1,0')),
    null,
    'top face is edge-on from the front and not hit',
  );
  near((await click('0,1,1')).direction, [0, s2, s2], 'front-top edge');
  near((await click('0,1,0')).direction, [0, 1, 0], 'top face', 1e-5);
  const shot = await decodePNG(await page.locator('canvas').screenshot()),
    px = (x, y) => {
      const o = (y * shot.width + x) * 4;
      return [...shot.data.slice(o, o + 3)];
    };
  const red = px(280, 200),
    blue = px(200, 120);
  assert.ok(
    red[0] > 60 && red[0] > 2 * red[2] && blue[2] > 60 && blue[2] > 2 * blue[0],
    `top view layout: right ${red}, above ${blue}`,
  );
  console.log('ok top view renders with X right and -Z up');
  near((await click('1,1,-1')).direction, [s3, s3, -s3], 'top-back-right corner');
  assert.deepEqual(
    await page.evaluate(() => window.check.focus()),
    { tabbable: ['Back view', 'Right view', 'Top view'], active: 'Top view' },
    'only visible faces are tabbable',
  );
  await page.keyboard.press('Home');
  near((await page.evaluate(() => window.check.settle())).direction, [s3, s3, s3], 'Home is isometric');
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => window.check.settle());
  await page.keyboard.press('Enter');
  near((await page.evaluate(() => window.check.settle())).direction, [0, 1, 0], 'Enter on the focused Top button');
  const toggle = await page.evaluate(() => window.check.toggle());
  await page.mouse.click(toggle.x, toggle.y);
  const r = await page.evaluate(() => window.check.settle());
  assert.equal(r.mode, 'orthographic');
  assert.ok(r.ortho, 'orthographic matrix');
  near((await click('-1,1,0')).direction, [-s2, s2, 0], 'top-left edge in orthographic');
  assert.deepEqual(pageErrors, []);
  console.log('viewcube browser check passed');
} finally {
  await context.close();
}
