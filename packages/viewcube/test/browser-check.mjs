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
  // The home and roll buttons sit in a row above the cube: none of the front face's nine cells is covered (batch 109:
  // the first home button covered the top-left corner cell).
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1]) {
      const v = `${x},${y},1`;
      assert.ok(await page.evaluate((v) => window.check.cell(v), v), `front cell ${v} is hit`);
    }
  // Drag to orbit with the real mouse: 40 px right on the 80 px cube turns the camera one radian left; no click view.
  const start = await page.evaluate(() => window.check.cell('0,0,1'));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y, { steps: 4 });
  await page.mouse.move(start.x + 40, start.y, { steps: 4 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.check.settle());
  near(dragged.direction, [Math.sin(-1), 0, Math.cos(-1)], 'drag right orbits', 1e-6);
  assert.ok(!dragged.animating, 'the click ending a drag starts no view');
  console.log('ok drag to orbit');
  await page.evaluate(() => window.check.front());
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
  // The page sets home: true, so Home returns to the front view it attached with.
  near((await page.evaluate(() => window.check.settle())).direction, [0, 0, 1], 'Home key goes to the home view', 1e-6);
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
  // The home button with the real mouse: back to the camera the page attached with.
  const home = await page.evaluate(() => window.check.home());
  assert.ok(home, 'home button hit-tests');
  await page.mouse.click(home.x, home.y);
  near((await page.evaluate(() => window.check.settle())).direction, [0, 0, 1], 'home button', 1e-6);
  console.log('ok home button');
  // The counter-clockwise roll button with the real mouse: +X is up the screen, the camera did not move.
  const roll = await page.evaluate(() => window.check.button('roll'));
  assert.ok(roll, 'roll button hit-tests');
  await page.mouse.click(roll.x, roll.y);
  const rolled = await page.evaluate(() => window.check.settle());
  assert.equal(rolled.turns, 1);
  near(rolled.up, [1, 0, 0], 'rolled up', 1e-9);
  near(rolled.direction, [0, 0, 1], 'roll keeps the view', 1e-9);
  console.log('ok roll button');
  // Themes through the browser's own CSS: the faces read the custom properties; 'auto' follows the colour scheme.
  const dark = { background: 'rgba(36, 40, 47, 0.92)', color: 'rgb(230, 233, 238)' },
    light = { background: 'rgba(236, 238, 242, 0.92)', color: 'rgb(38, 42, 49)' };
  assert.deepEqual(await page.evaluate(() => window.check.theme('dark')), dark);
  assert.deepEqual(await page.evaluate(() => window.check.theme('high-contrast')), {
    background: 'rgb(0, 0, 0)',
    color: 'rgb(255, 255, 255)',
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.deepEqual(await page.evaluate(() => window.check.theme('auto')), dark, 'auto in a dark scheme');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.deepEqual(await page.evaluate(() => window.check.theme('auto')), light, 'auto in a light scheme');
  console.log('ok themes');
  // The axis triad (viewcube/axes) in the bottom-left corner, on the same camera, with the real mouse.
  await page.evaluate(() => window.check.front());
  await page.evaluate(() => window.check.settle());
  const ballX = await page.evaluate(() => window.check.ball('1,0,0')),
    ballY = await page.evaluate(() => window.check.ball('0,1,0'));
  assert.ok(ballX.hit && ballY.hit, 'the X and Y balls hit-test');
  near([ballX.dx, ballX.dy], [23, 0], 'X ball right of the centre', 0.5);
  near([ballY.dx, ballY.dy], [0, -23], 'Y ball above the centre', 0.5);
  await page.mouse.click(ballX.x, ballX.y);
  near((await page.evaluate(() => window.check.settle())).direction, [1, 0, 0], 'X ball click', 1e-6);
  console.log('ok axis triad');
  await page.evaluate(() => window.check.upCube());
  near((await page.evaluate(() => window.check.settle())).up, [0, 0, 1], 'Z-up front screen up');
  near((await click('0,1,1')).direction, [0, -s2, s2], 'Z-up front-top edge');
  near((await click('0,1,0')).direction, [0, 0, 1], 'Z-up top face', 1e-5);
  near((await page.evaluate(() => window.check.settle())).up, [0, 1, 0], 'Z-up pole screen up');
  console.log('ok Z-up CSS hit testing and rendered pole');
  assert.deepEqual(pageErrors, []);
  console.log('viewcube browser check passed');
} finally {
  await context.close();
}
