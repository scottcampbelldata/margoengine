// Real-GPU proof of SpriteLayer `filter: 'linear'` (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sprites/tests/smooth-check.mjs
// A white texel beside a transparent red one, magnified 16 times, must fade by the bilinear weight with no red fringe
// (premultiplied filtering), from bytes and from a caller's GPUTexture, on the 8-bit canvas and on an sRGB target; 64
// alternating columns drawn 8 pixels wide must average to linear 0.5 with mipmaps and alias to black without; tint and
// alpha multiply the filtered colour. Results: test-results/sprites-smooth-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/sprites/tests/smooth-check.html', port: 5273 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const decode = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4),
  encode = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
// Pixel i's centre is texel (i + 0.5) / 16, held half a texel inside the 2-texel rectangle: the transparent weight.
const weight = (i) => Math.min(1, Math.max(0, (i + 0.5) / 16 - 0.5));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sprites-smooth-browser.json', JSON.stringify({ hardware, result: r }, null, 1));
  r.edge.nearest.forEach(([red, green, blue], i) =>
    assert.deepEqual([red, green, blue], i < 16 ? [255, 255, 255] : [0, 0, 0], `nearest pixel ${i}`),
  );
  // On the 8-bit canvas the premultiplied white comes out as 255 * (1 - w) over black. Bound: the filter's weight is
  // exact to 1/256 in hardware (WebGPU leaves at least 8 bits of sub-texel precision), plus rounding: 2 levels.
  for (const source of ['linear', 'texture'])
    r.edge[source].forEach(([red, green, blue], i) => {
      const expected = 255 * (1 - weight(i));
      assert.ok(Math.abs(red - expected) <= 2, `${source} pixel ${i}: ${red}, expected ${expected}`);
      assert.ok(
        Math.abs(red - green) <= 1 && Math.abs(red - blue) <= 1,
        `${source} pixel ${i}: red fringe ${[red, green, blue]}`,
      );
    });
  assert.ok(new Set(r.edge.linear.map((p) => p[0])).size > 8, 'linear filtering makes a ramp');
  // An sRGB target stores linear light: decoded, the bytes give 1 - w to one storage step (at most 1/255 / 0.44 at 1)
  // plus the weight's 1/256.
  r.edge.srgbTarget.forEach(([red, green, blue, alpha], i) => {
    const expected = 1 - weight(i);
    assert.ok(Math.abs(decode(red / 255) - expected) <= 0.015, `sRGB target pixel ${i}: ${red}, expected ${expected}`);
    assert.ok(Math.abs(red - green) <= 1 && Math.abs(red - blue) <= 1, `sRGB target pixel ${i}: fringe`);
    assert.ok(Math.abs(alpha / 255 - expected) <= 0.006, `sRGB target pixel ${i}: alpha ${alpha}`);
  });
  // Mipmaps average in linear light: 0.5, encoded 187.5 on the 8-bit canvas. Without them each centre reads black.
  for (const [red, green, blue] of r.stripes.mipmaps)
    assert.ok(
      [red, green, blue].every((v) => Math.abs(v - 255 * encode(0.5)) <= 2),
      `mipmapped stripes ${[red, green, blue]}`,
    );
  for (const pixel of r.stripes.none) assert.deepEqual(pixel.slice(0, 3), [0, 0, 0], 'level 0 alone aliases');
  // White at alpha 0.5 under a red tint: (0.5, 0, 0) premultiplied, 127.5 on the canvas.
  assert.ok(Math.abs(r.tinted[0] - 127.5) <= 1 && r.tinted[1] === 0 && r.tinted[2] === 0, `tinted ${r.tinted}`);
  assert.equal(r.validation, null, 'no validation errors');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log(
    'ok smooth sprites: bilinear ramp with no fringe, caller texture, sRGB target, linear-light mipmaps, tint; 0 validation errors',
  );
} finally {
  await context.close();
}
