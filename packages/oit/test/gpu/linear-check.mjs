// Real-GPU check for KB3148d: OIT takes blendSpace 'linear' materials (materials meshes and glTF) and composites their
// pixels in linear light, plain and with `blending`, 1x and 4x; 'display' keeps the encoded blend. From the repository
// root, after building packages: node packages/oit/test/gpu/linear-check.mjs (MARGO_COMPAT=1 for the WebGL2 layer).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'oit-linear' });
const browser = await openBrowser({ startPath: '/packages/oit/test/gpu/linear.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const encode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
const centre = async (png) => {
  const picture = await decodePNG(Buffer.from(png.split(',')[1], 'base64'));
  const offset = (Math.floor(picture.height / 2) * picture.width + Math.floor(picture.width / 2)) * 4;
  return Array.from(picture.data.slice(offset, offset + 3));
};
// The sorted reference: each layer out = a*src + (1-a)*dst, src red 0.5 linear, a 0.5, over black, in linear light
// (linear) or on encoded values (display). Equal layers make the weighted average exact, so OIT must match it.
const over = (layers, linear) => {
  let red = 0;
  for (let i = 0; i < layers; i++) red = linear ? 0.25 + 0.5 * red : 0.5 * encode(0.5) + 0.5 * red;
  return Math.round(255 * (linear ? encode(red) : red));
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const { rows, errors: gpuErrors } = await page.evaluate(() => window.linearOIT());
  for (const row of rows) {
    const actual = await centre(row.png),
      expected = over(row.layers, row.space === 'linear'),
      name = `${row.blending ? 'blending ' : ''}${row.samples}x ${row.gltf ? 'glTF' : 'materials'} ${row.layers} ${row.space}${row.late ? ' late' : ''}`;
    console.log({ ...row, png: undefined, before: undefined, actual, expected });
    assert.ok(row.taken > 0, `${name}: the layers drew in the OIT pass`);
    assert.ok(Math.abs(actual[0] - expected) <= 1 && actual[1] <= 1 && actual[2] <= 1, `${name}: ${actual} vs ${expected}`);
    if (row.late) {
      const before = await centre(row.before);
      assert.ok(Math.abs(before[0] - over(row.layers, false)) <= 1, `${name}: the first frame drew the display blend`);
    }
  }
  assert.deepEqual([...errors, ...gpuErrors], []);
  console.log('oit linear-check: ok', rows.length, 'cases');
} finally {
  await browser.close();
  await release();
}
