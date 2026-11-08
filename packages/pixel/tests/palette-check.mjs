// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/pixel/tests/palette-check.mjs
// A 16 x 4 gradient quantized to a 4-colour palette matches the CPU matcher byte for byte for each dither mode and both
// distances; palette swap, a swap set live with no new texture, alpha, a device loss. Results: test-results/palette-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/pixel/tests/palette-check.html', port: 5343 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const result = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/palette-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU reference');
  assert.ok(result.distinct > 1, 'the dithered gradient shows more than one colour in a row');
  assert.equal(result.sameTexture, 'state', 'the same source and target name their fix');
  assert.equal(result.swapTextures, 0, 'setSwap makes no texture');
  assert.equal(result.validation, null, 'no validation errors');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok palette:', Object.keys(result.checks).length, 'exact checks, 0 wrong pixels, 0 validation errors');
} finally {
  await context.close();
}
