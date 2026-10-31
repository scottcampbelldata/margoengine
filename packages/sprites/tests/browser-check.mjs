// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sprites/tests/browser-check.mjs
// Under exactSize [64, 32] each frame reads back byte for byte against an image composed on the CPU: a 4 x 4 sprite at
// (10, 7), flips, tint, alpha, y-sort and add order, snapping, a camera, half-pixel pivots, quarter turns, buffer growth,
// layers, a caller target with its alpha, normals, views, and a device loss. Results: test-results/sprites-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/sprites/tests/browser-check.html', port: 5271 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  assert.deepEqual(
    await page.evaluate(() => window.check.size()),
    [64, 32],
    'exactSize holds under a 256 x 128 CSS box',
  );
  const result = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sprites-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU image');
  assert.ok(result.checks['30 degrees: only source colours'].drawn > 50, 'the turned sprite drew');
  assert.equal(result.validation, null, 'no validation errors');
  assert.deepEqual(result.errors, []);
  assert.equal(result.msaa.validation, null, 'MSAA engine: no validation error');
  assert.equal(result.msaa.normals, 'state', 'normals on an MSAA target name their fix');
  assert.ok(result.msaa.samples > 1, `the MSAA engine has ${result.msaa.samples} samples`);
  assert.equal(result.lostPlainAtlas, 'state', 'a plain GPUTexture atlas names its fix after a device loss');
  assert.deepEqual(pageErrors, []);
  console.log(
    'ok sprites:',
    Object.keys(result.checks).length,
    'exact-pixel checks, 0 wrong pixels, 0 validation errors',
  );
} finally {
  await context.close();
}
