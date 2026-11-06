// Real-adapter check (run from the repository root after building packages): node packages/cameras/test/browser-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/cameras/test/browser-check.html', port: 5208 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
});
const shot = async () => {
  const image = await decodePNG(await page.locator('canvas').screenshot());
  return (x, y) => {
    const o = (y * image.width + x) * 4;
    return [...image.data.slice(o, o + 3)];
  };
};
const is = (rgb, channel) => rgb[channel] > 40 && rgb.every((v, i) => i === channel || v < rgb[channel] * 0.6);
const dark = (rgb) => rgb.every((v) => v < 30);
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  // Orthographic straight down, 8 world units over 400 px: 50 px per unit, +x right, -z up.
  let result = await page.evaluate(() => window.check.render('orthographic', 8));
  assert.equal(result.error, null);
  assert.deepEqual(result.errors, []);
  let px = await shot();
  assert.ok(
    is(px(200, 200), 1) && is(px(300, 200), 0) && is(px(200, 100), 2),
    `layout ${px(200, 200)} ${px(300, 200)} ${px(200, 100)}`,
  );
  // Box edges at x = 1.5 and 2.5 world units: pixels 275 and 325, independent of depth (parallel projection).
  assert.ok(
    is(px(278, 200), 0) && dark(px(271, 200)) && is(px(322, 200), 0) && dark(px(329, 200)),
    `ortho edges ${px(271, 200)} ${px(278, 200)} ${px(322, 200)} ${px(329, 200)}`,
  );
  assert.equal(await page.evaluate(() => window.check.pick(300, 200)), 'red');
  assert.equal(await page.evaluate(() => window.check.pick(200, 100)), 'blue');
  assert.equal(await page.evaluate(() => window.check.pick(100, 300)), null);
  console.log('ok orthographic top-down + pick');
  // View offset: the right half of the 400 x 400 image stretched over the canvas. The red box (pixels 275 to 325 of
  // the image) is centred, the green box (175 to 225) is cut by the left edge, and the blue box (above centre) is cut away.
  result = await page.evaluate(() => window.check.offset(true));
  assert.equal(result.error, null);
  px = await shot();
  assert.ok(
    is(px(200, 200), 0) && is(px(10, 200), 1) && dark(px(200, 330)),
    `view offset ${px(200, 200)} ${px(10, 200)}`,
  );
  assert.ok(dark(px(110, 200)) && dark(px(290, 200)), 'view offset edges');
  await page.evaluate(() => window.check.offset(false));
  console.log('ok view offset');
  result = await page.evaluate(() => window.check.render('perspective', undefined));
  assert.equal(result.error, null);
  px = await shot();
  assert.ok(is(px(200, 200), 1) && dark(px(10, 10)), 'perspective top-down');
  let x = 330;
  while (x > 200 && !is(px(x, 200), 0)) x--;
  assert.ok(x > 230 && x < 300, `perspective red at ${x}`);
  console.log('ok perspective top-down, red right edge', x);
  result = await page.evaluate(() => window.check.render('orthographic', undefined));
  px = await shot();
  assert.ok(is(px(200, 200), 1), 'distance-matched ortho');
  result = await page.evaluate(() => window.check.effects());
  assert.equal(result.error, null);
  assert.deepEqual(result.errors, []);
  px = await shot();
  assert.ok(is(px(300, 200), 0) && is(px(200, 100), 2), 'ortho with shadows and TAA');
  console.log('ok shadows + taa', px(300, 200), px(200, 200));
  // Off-axis: the 8 x 8 screen at y = 0 is a window, so the box centres at y = 0 stay put when the eye moves sideways.
  await page.reload();
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  for (const eyeX of [0, 2]) {
    result = await page.evaluate((x) => window.check.offAxis(x), eyeX);
    assert.equal(result.error, null);
    assert.deepEqual(result.errors, []);
    px = await shot();
    assert.ok(
      is(px(200, 200), 1) && is(px(300, 200), 0) && is(px(200, 100), 2),
      `off-axis eye ${eyeX}: ${px(200, 200)} ${px(300, 200)} ${px(200, 100)}`,
    );
  }
  console.log('ok off-axis window');
  // Oblique near plane: keeping y <= 1 shows the boxes (they reach y = 0.5); keeping y <= -1 clips all of them.
  result = await page.evaluate(() => window.check.offAxis(0, 1));
  px = await shot();
  assert.ok(result.error === null && is(px(200, 200), 1) && is(px(300, 200), 0), 'oblique plane above the boxes');
  result = await page.evaluate(() => window.check.offAxis(0, -1));
  assert.equal(result.error, null);
  px = await shot();
  assert.ok(
    dark(px(200, 200)) && dark(px(300, 200)) && dark(px(200, 100)),
    `oblique plane below the boxes ${px(200, 200)}`,
  );
  console.log('ok oblique near plane');
  assert.deepEqual(pageErrors, []);
  console.log('cameras browser check passed');
} finally {
  await context.close();
}
