// Real-GPU proof of several atlases in one SpriteLayer (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sprites/tests/pages-check.mjs
// Three same-size atlases, one of them a caller's GPUTexture, in one layer: each sprite draws its page's texels byte for
// byte, setAtlas reorders them, and filter 'linear', a shader and a one-atlas list work the same way; a page past the
// list and atlases of different sizes throw RangeError. Results: test-results/sprites-pages-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/sprites/tests/pages-check.html', port: 5275 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const texels = ([r, g, b]) => [
  [r, g, b],
  [r >> 1, g >> 1, b >> 1],
  [r >> 1, g >> 1, b >> 1],
];
const RED = [255, 0, 0],
  GREEN = [0, 254, 0],
  BLUE = [0, 0, 254];
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sprites-pages-browser.json', JSON.stringify({ hardware, result: r }, null, 1));
  // Uint8Array stores 127.5 as 127: the darker texels are each channel shifted right once.
  assert.deepEqual(r.nearest.first, [RED, GREEN, BLUE].map(texels), 'each sprite reads its own page exactly');
  assert.deepEqual(r.nearest.swapped, [BLUE, RED, GREEN].map(texels), 'setAtlas reorders the pages');
  // Through the sRGB copy and back: within 1 of the bytes.
  r.linear.forEach((p, i) =>
    p.forEach((v, c) => assert.ok(Math.abs(v - [RED, GREEN, BLUE][i][c]) <= 1, `filter 'linear' page ${i}: ${p}`)),
  );
  assert.deepEqual(
    r.shaded,
    [0, 1, 2].map(() => texels([255, 255, 255]).map(() => [255, 255, 255])),
    'a shader runs on every page',
  );
  assert.deepEqual(r.one, GREEN, 'a list of one atlas works');
  assert.equal(r.badPage, 'RangeError', 'a page past the list throws');
  assert.equal(r.badSize, 'RangeError', 'atlases of different sizes throw');
  assert.equal(r.validation, null, 'no validation errors');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log(
    'ok sprite pages: three atlases in one draw, reorder, linear, shader, one-atlas list, errors; 0 validation errors',
  );
} finally {
  await context.close();
}
