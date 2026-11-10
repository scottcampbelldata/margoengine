// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/pixel/tests/scale-check.mjs
// A 7 x 5 picture drawn by PixelScale at 3.29x, stretched, at 2x and below 2x into textures and onto the canvas, each
// read back against the filter's maths worked out on the CPU: nearest byte for byte, sharp-bilinear and edge within one
// step of 255 where they mix, byte for byte where they do not; a live filter change, errors, a device loss.
// Results: test-results/pixel-scale-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/pixel/tests/scale-check.html', port: 5296 }),
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
  await writeFile('test-results/pixel-scale-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU reference');
  assert.equal(Object.keys(result.checks).length, 24);
  assert.equal(result.badFilter, true, 'an unknown filter is a RangeError');
  assert.equal(result.sameTexture, 'state', 'the same source and target name their fix');
  assert.equal(result.validation, null, 'no validation errors');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok pixel scale:', Object.keys(result.checks).length, 'checks, 0 wrong pixels, 0 validation errors');
} finally {
  await context.close();
}
