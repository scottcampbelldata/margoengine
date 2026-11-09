// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/pixel/tests/crt-check.mjs
// A 7 x 5 picture drawn by CRT with the default, flat, strongest and all-off looks into textures and onto the canvas,
// each read back against the CRT maths worked out on the CPU within one step of 255; looks changed live, errors, a
// device loss.
// Results: test-results/pixel-crt-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/pixel/tests/crt-check.html', port: 5298 }),
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
  await writeFile('test-results/pixel-crt-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU reference');
  assert.equal(Object.keys(result.checks).length, 16);
  assert.equal(result.checks['all off'].skipped, 0, 'all-off includes exact source boundaries');
  assert.equal(result.checks['all-off rational nearest sweep'].tested, 154);
  for (const [name, check] of Object.entries(result.checks))
    assert.ok(check.skipped * 20 < 23 * 17, `${name}: few pixels sit on a texel edge`);
  assert.equal(result.badSetting, true, 'a look setting out of range is a RangeError');
  assert.equal(result.sameTexture, 'state', 'the same source and target name their fix');
  assert.equal(result.validation, null, 'no validation errors');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok pixel crt:', Object.keys(result.checks).length, 'checks, 0 wrong pixels, 0 validation errors');
} finally {
  await context.close();
}
