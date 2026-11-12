// Real-GPU check for KB3148d and KB3148e: every order-independent pass (OIT plain and with `blending`, ExactOIT,
// MomentOIT, PeelOIT, PreciseOIT) takes blendSpace 'linear' materials (materials meshes and glTF) and composites their
// pixels in linear light, 1x and 4x; 'display' keeps the encoded blend, and ExactOIT and PeelOIT keep a linear layer in
// front of a display one in order. From the repository root, after building packages:
// node packages/oit/test/gpu/linear-check.mjs (MARGO_COMPAT=1 for the WebGL2 layer, where ExactOIT refuses by design).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  names = ['oit', 'blending', 'exact', 'moments', 'peel', 'precise'];
const release = await acquire({ owner: 'oit-linear' });
const browser = await openBrowser({ startPath: '/packages/oit/test/gpu/linear.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const encode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055),
  decode = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const centre = async (png) => {
  const picture = await decodePNG(Buffer.from(png.split(',')[1], 'base64'));
  const offset = (Math.floor(picture.height / 2) * picture.width + Math.floor(picture.width / 2)) * 4;
  return Array.from(picture.data.slice(offset, offset + 3));
};
// The sorted reference: each layer out = a*src + (1-a)*dst, src red 0.5 linear, a 0.5, over black, far to near, in
// linear light (linear) or on encoded values (display); 'mixed' is a display layer, then a linear one in front.
const over = (layers, space) => {
  let red = 0;
  for (let i = 0; i < layers; i++) {
    const linear = space === 'linear' || (space === 'mixed' && i === layers - 1);
    red = linear ? encode(0.25 + 0.5 * decode(red)) : 0.5 * encode(0.5) + 0.5 * red;
  }
  return Math.round(255 * red);
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const { rows, errors: gpuErrors } = await page.evaluate((list) => window.linearOIT(list), names);
  let checked = 0;
  for (const row of rows) {
    const name = `${row.pass} ${row.samples}x ${row.gltf ? 'glTF' : 'materials'} ${row.layers} ${row.space}${row.late ? ' late' : ''}`;
    if (row.refused) {
      // ExactOIT needs fragment storage buffers, which the WebGL2 layer does not have (README "Exact layers").
      assert.ok(compat && row.pass === 'exact' && row.refused === 'unsupported', `${name}: refused ${row.refused}`);
      continue;
    }
    const actual = await centre(row.png),
      expected = over(row.layers, row.space);
    console.log({ ...row, png: undefined, before: undefined, actual, expected });
    assert.ok(row.taken > 0, `${name}: the layers drew in the order-independent pass`);
    assert.ok(Math.abs(actual[0] - expected) <= 1 && actual[1] <= 1 && actual[2] <= 1, `${name}: ${actual} vs ${expected}`);
    if (row.late) {
      const before = await centre(row.before);
      assert.ok(
        Math.abs(before[0] - over(row.layers, 'display')) <= 1,
        `${name}: the first frame drew the display blend, ${before} vs ${over(row.layers, 'display')}`,
      );
    }
    checked++;
  }
  for (const pass of names)
    assert.ok(
      rows.some((row) => row.pass === pass && (row.png || (compat && pass === 'exact'))),
      `${pass}: no case ran`,
    );
  assert.deepEqual([...errors, ...gpuErrors], []);
  console.log('oit linear-check: ok', checked, 'cases');
} finally {
  await browser.close();
  await release();
}
