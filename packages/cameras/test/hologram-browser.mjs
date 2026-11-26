import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const browser = await openBrowser({ startPath: '/packages/cameras/test/hologram-check.html', port: 5209 });
const snap = async () => decodePNG(await browser.page.locator('canvas').screenshot());
const at = (im, x, y) => [...im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 3)];
const near = (a, b, label) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= 2, `${label}: ${a} vs ${b}`));
const SIDES = ['front', 'back', 'left', 'right'];
// Slot corner in canvas pixels for a square canvas of side S, gap g and view v (fractions of S).
const corner = (side, S, g, v) => {
  const c = S / 2,
    h = (v * S) / 2;
  return {
    front: [c - h, c + (g * S) / 2],
    back: [c - h, c - (g * S) / 2 - v * S],
    left: [c - (g * S) / 2 - v * S, c - h],
    right: [c + (g * S) / 2, c - h],
  }[side];
};
// Where texel (tx, ty) of a side's picture lands: mirror, then turn counter-clockwise on screen.
const place = (side, tx, ty, n, { rotation, mirror }, S, g, v) => {
  let x = (tx + 0.5) / n - 0.5,
    y = (ty + 0.5) / n - 0.5;
  if (mirror) x = -x;
  for (let k = 0; k < rotation / 90; k++) [x, y] = [y, -x];
  const [x0, y0] = corner(side, S, g, v);
  return [Math.floor(x0 + (x + 0.5) * v * S), Math.floor(y0 + (y + 0.5) * v * S)];
};
const inWedge = (side, x, y, S) => {
  const dx = x + 0.5 - S / 2,
    dy = y + 0.5 - S / 2,
    m = 3;
  return side === 'front' || side === 'back'
    ? Math.abs(dy) > Math.abs(dx) + m && (side === 'front') === dy > 0
    : Math.abs(dx) > Math.abs(dy) + m && (side === 'left') === dx < 0;
};
const DEFAULT = {
  front: { rotation: 180, mirror: true },
  back: { rotation: 0, mirror: true },
  left: { rotation: 90, mirror: true },
  right: { rotation: 270, mirror: true },
};
async function layout(options, orientation, label) {
  const result = await browser.page.evaluate((o) => window.check.render(o), options);
  assert.equal(result.validation, null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.updates, 1, 'one update for the four views');
  assert.deepEqual(result.position, [0, 0, 6], 'the source camera is not moved');
  const views = await browser.page.evaluate(() => window.check.views()),
    image = await snap(),
    S = 400,
    g = options.gap,
    v = (1 - g) / 2;
  // Each camera sees its own side's box in the middle of its picture.
  const expected = { front: [1, 0, 0], back: [0, 1, 0], right: [0, 0, 1], left: [1, 1, 1] };
  views.forEach((view, i) => {
    const c = at(view, view.width >> 1, view.height >> 1);
    expected[SIDES[i]].forEach((on, k) => assert.ok(on ? c[k] > 60 : c[k] < 30, `${label} ${SIDES[i]} centre ${c}`));
  });
  let compared = 0,
    marked = 0;
  views.forEach((view, i) => {
    const side = SIDES[i];
    for (let ty = 2; ty < view.height; ty += 5)
      for (let tx = 2; tx < view.width; tx += 5) {
        const [x, y] = place(side, tx, ty, view.width, orientation[side], S, g, v);
        if (!inWedge(side, x, y, S)) continue;
        const texel = at(view, tx, ty);
        near(at(image, x, y), texel, `${label} ${side} texel ${tx},${ty} at ${x},${y}`);
        compared++;
        if (texel[0] > 60 && texel[2] > 60 && texel[1] < 30) marked++;
      }
  });
  assert.ok(compared > 400, `${label}: ${compared} samples`);
  assert.ok(marked > 4, `${label}: the off-centre marker is among the samples (${marked})`);
  near(at(image, 200, 200), [0, 0, 0], `${label} centre square`);
  near(at(image, 3, 3), [0, 0, 0], `${label} corner`);
}
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  await layout({ gap: 0.2 }, DEFAULT, 'default');
  const turned = {
    front: { rotation: 0, mirror: false },
    back: { rotation: 90, mirror: false },
    left: { rotation: 270, mirror: true },
    right: { rotation: 180, mirror: false },
  };
  await layout({ gap: 0.5, views: turned }, turned, 'custom');
  await layout({ gap: 0.25, views: undefined, distance: 9 }, DEFAULT, 'distance');
  assert.deepEqual(await browser.page.evaluate(() => window.check.resize()), [600, 300, 113]);
  const restored = await browser.page.evaluate(() => window.check.restore());
  assert.equal(restored.validation, null);
  assert.deepEqual(restored.errors, []);
  assert.equal(await browser.page.evaluate(() => window.check.dispose()), 'disposed');
  console.log(
    'hologram: four views, wedges, turns, mirrors, gap, distance, one update, resize, device restore and disposal passed',
    JSON.stringify(browser.hardware),
  );
} finally {
  await browser.close();
}
