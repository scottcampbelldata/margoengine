// Pixel comparison of flipbook on the WebGL2 compatibility layer (the features check's checkFlipbook, same page).
// The layer is installed by scripts/browser.js when MARGO_COMPAT=1, before the page's first requestAdapter.
// Run from the repository root, under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node packages/vfx/test/flipbook-webgl2.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

process.env.MARGO_COMPAT = '1';
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = '1';

const { openBrowser } = await import('../../../scripts/browser.js');
const context = await openBrowser({
  startPath: '/packages/vfx/test/features-check.html',
  port: 'free',
});
const { page, hardware } = context;
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const compat = await page.evaluate(() => globalThis.__margoCompat === true);
  assert.equal(compat, true, 'the page is not on the WebGL2 compatibility layer');
  const result = await page.evaluate(() => window.checkFlipbook());
  assert.equal(result.error, null, result.error ?? '');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(result.mismatches, [], JSON.stringify(result));
  const report = { hardware, compat: true, got: result.got, want: result.want };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/vfx-flipbook-webgl2.json', JSON.stringify(report, null, 1));
  console.log(
    `ok flipbook webgl2: got ${result.got.map((p) => p.join(',')).join(' | ')} want ${result.want.map((p) => p.join(',')).join(' | ')}`,
  );
} finally {
  await context.close();
}
