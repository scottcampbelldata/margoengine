// Real-GPU proof of @margoengine/sprites/shader (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sprites/tests/shader-check.mjs
// Under exactSize [64, 32], shaded layers read back against values worked out here: a flash mixes toward white by its
// params, an outline fills exactly the ring of texels around opaque ones, a dissolve keeps all at 0 and drops all at 1,
// a palette swap turns red to blue only, the layer's time reaches the shader, and a shader runs in filter 'linear'.
// Results: test-results/sprites-shader-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/sprites/tests/shader-check.html', port: 5274 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sprites-shader-browser.json', JSON.stringify({ hardware, result: r }, null, 1));
  assert.deepEqual(r.flash[0], r.P, 'flash 0 draws the texels as they are');
  assert.deepEqual(
    r.flash[1],
    r.P.map(() => [255, 255, 255]),
    'flash 1 draws white',
  );
  // Half way: c + (255 - c) / 2 in bytes, rounded either way.
  r.flash['0.5'].forEach((p, i) =>
    p.forEach((v, c) => assert.ok(Math.abs(v - (r.P[i][c] + 255) / 2) <= 1, `flash 0.5 texel ${i}: ${p}`)),
  );
  // Rect O: red at texels 2 and 3; the ring 1 to 4 around it turns yellow, the outer ring stays background.
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 6; x++) {
      const red = x >= 2 && x <= 3 && y >= 2 && y <= 3,
        ring = !red && x >= 1 && x <= 4 && y >= 1 && y <= 4;
      assert.deepEqual(
        r.outline.on[y * 6 + x],
        red ? [255, 0, 0] : ring ? [255, 255, 0] : [0, 0, 0],
        `outline ${x}, ${y}`,
      );
      assert.deepEqual(r.outline.off[y * 6 + x], red ? [255, 0, 0] : [0, 0, 0], `outline off ${x}, ${y}`);
    }
  assert.deepEqual(r.dissolve.whole, r.P, 'dissolve 0 keeps every texel');
  assert.deepEqual(
    r.dissolve.gone,
    r.P.map(() => [0, 0, 0]),
    'dissolve 1 drops every texel',
  );
  assert.deepEqual(r.palette, [[0, 0, 255], ...r.P.slice(1)], 'palette swaps red to blue only');
  assert.ok(Math.abs(r.time - 63.75) <= 1, `time 0.25 reaches the shader: ${r.time}`);
  for (const p of r.smooth) assert.deepEqual(p, [255, 255, 255], 'a shader runs in filter linear');
  assert.equal(r.validation, null, 'no validation errors');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok sprite shaders: flash, outline, dissolve, palette, time, filter linear; 0 validation errors');
} finally {
  await context.close();
}
