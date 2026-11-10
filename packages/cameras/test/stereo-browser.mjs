import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const browser = await openBrowser({ startPath: '/packages/cameras/test/stereo-check.html', port: 5208 });
const snap = async () => decodePNG(await browser.page.locator('canvas').screenshot());
const at = (im, x, y) => [...im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 3)];
const near = (a, b, label) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= 2, `${label}: ${a} vs ${b}`));
const linear = (x) => (x / 255 <= 0.04045 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4);
const srgb = (x) => {
  x = Math.max(0, Math.min(1, x));
  return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
};
const dubois = (l, r) => {
  const a = l.map(linear),
    b = r.map(linear),
    lm = [
      [0.437, 0.449, 0.164],
      [-0.062, -0.062, -0.024],
      [-0.048, -0.05, -0.017],
    ],
    rm = [
      [-0.011, -0.032, -0.007],
      [0.377, 0.761, 0.009],
      [-0.026, -0.093, 1.234],
    ];
  return lm.map((row, i) => srgb(row.reduce((s, v, c) => s + v * a[c] + rm[i][c] * b[c], 0)));
};
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  for (const mode of ['side-by-side', 'top-bottom', 'anaglyph', 'parallax-barrier']) {
    const eyes = [];
    for (const side of ['left', 'right']) {
      await browser.page.evaluate(([side, mode]) => window.check.eye(side, mode), [side, mode]);
      eyes.push(await snap());
    }
    const [l, r] = eyes;
    for (const swap of [false, true]) {
      const result = await browser.page.evaluate(([m, s]) => window.check.render(m, s), [mode, swap]);
      assert.equal(result.validation, null);
      assert.deepEqual(result.errors, []);
      assert.equal(result.updates, 1);
      assert.deepEqual(result.position, [0, 0, 0]);
      const image = await snap(),
        left = swap ? r : l,
        right = swap ? l : r;
      let colored = 0;
      // Grid samples stay inside constant-colour box faces, away from raster edges.
      for (const [x, y] of [
        [120, 90],
        [160, 90],
        [150, 90],
        [170, 90],
        [200, 90],
        [240, 90],
        [100, 75],
        [220, 110],
        [20, 20],
      ]) {
        const a = at(left, x, y),
          b = at(right, x, y);
        if (a.some((v) => v > 80) || b.some((v) => v > 80)) colored++;
        if (mode === 'side-by-side') {
          near(at(image, Math.floor(x / 2), y), a, mode + ' left');
          near(at(image, 160 + Math.floor(x / 2), y), b, mode + ' right');
        } else if (mode === 'top-bottom') {
          near(at(image, x, Math.floor(y / 2)), a, mode + ' top');
          near(at(image, x, 90 + Math.floor(y / 2)), b, mode + ' bottom');
        } else if (mode === 'anaglyph') near(at(image, x, y), dubois(a, b), 'Dubois linear projection');
        else near(at(image, x, y), x % 2 ? b : a, 'barrier columns');
      }
      assert.ok(colored >= 2, `${mode}: the scene reference contains visible coloured geometry (${colored})`);
    }
    if (mode === 'parallax-barrier') {
      for (const axis of ['columns', 'rows'])
        for (const phase of [0, 1]) {
          const result = await browser.page.evaluate(
            ([axis, phase]) => window.check.render('parallax-barrier', false, axis, phase),
            [axis, phase],
          );
          assert.equal(result.validation, null);
          const image = await snap();
          for (const [x, y] of [
            [119, 90],
            [120, 91],
            [160, 90],
            [161, 91],
            [200, 90],
          ])
            near(at(image, x, y), at(((axis === 'rows' ? y : x) + phase) % 2 ? r : l, x, y), `${axis} phase ${phase}`);
        }
    }
  }
  assert.deepEqual(await browser.page.evaluate(() => window.check.resize()), [400, 200]);
  const restored = await browser.page.evaluate(() => window.check.restore());
  assert.equal(restored.validation, null);
  assert.deepEqual(restored.errors, []);
  assert.equal(await browser.page.evaluate(() => window.check.dispose()), 'disposed');
  console.log(
    'stereo: four modes, swap, focus, parity, one update per pair, resize, device restore and disposal passed',
    JSON.stringify(browser.hardware),
  );
} finally {
  await browser.close();
}
