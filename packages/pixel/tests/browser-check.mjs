// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/pixel/tests/browser-check.mjs
// Under exactSize [64, 32] each frame reads back byte for byte against an image composed on the CPU: layers at 4x, quarter
// turns of a 1-pixel line, 30 degrees (only source colours), scrolling by parts of a pixel, parallax, smooth scroll,
// blends, opacity, order, views, targets drawn by a frame-graph pass, a core view and sprites, Tonemap order, MSAA and a
// device loss. Results: test-results/pixel-browser.json.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/pixel/tests/browser-check.html', port: 5272 }),
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
  await writeFile('test-results/pixel-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU image');
  assert.ok(result.checks['30 degrees: only source colours'].drawn > 500, 'the turned layer drew');
  assert.notDeepEqual(result.gradedAtOrder30, [48, 80, 204], 'a Tonemap grades a composite at the default order');
  assert.equal(result.validation, null, 'no validation errors');
  assert.deepEqual(result.errors, []);
  assert.equal(result.msaa.validation, null, 'MSAA engine: no validation error');
  assert.ok(result.msaa.samples > 1, `the MSAA engine has ${result.msaa.samples} samples`);
  // Sprites live in their own package: once it is in this tree the check with real sprites must have run.
  if (existsSync('packages/sprites/package.json'))
    assert.ok(result.checks['real sprite layer'], 'the sprites package is here, so its check ran');
  assert.deepEqual(pageErrors, []);
  console.log(
    'ok pixel:',
    Object.keys(result.checks).length,
    'exact-pixel checks, 0 wrong pixels, 0 validation errors',
    result.checks['real sprite layer'] ? '(real sprites included)' : '(no sprites package here)',
  );
} finally {
  await context.close();
}
