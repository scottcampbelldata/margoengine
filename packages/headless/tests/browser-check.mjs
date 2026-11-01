// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/headless/tests/browser-check.mjs
// Renders one cube on a page canvas and through the stand-in canvas, then compares the page's screenshot with the PNG
// bytes at the visual check's limits. Proves the padding, swizzle, row order and encoder on a real device.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compare } from '../../../scripts/support/visual-image.js';
import { decodePNG } from '../../../tests/support/png.js';

// The bit-exact allowance of scripts/visual-regression.js (ALLOWANCE): no tolerance of its own.
const LIMITS = { changed: 0.0005, hot: 0.0002 };

const context = await openBrowser({ startPath: '/packages/headless/tests/browser-check.html', port: 5274 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  await page.evaluate(() => window.check.page());
  const seen = await decodePNG(new Uint8Array(await page.locator('#page').screenshot())),
    { png, format, errors } = await page.evaluate(() => window.check.headless()),
    read = await decodePNG(new Uint8Array(png));
  assert.deepEqual(errors, [], 'no validation errors');
  assert.deepEqual([read.width, read.height], [256, 192]);
  assert.deepEqual([seen.width, seen.height], [256, 192]);
  const metrics = compare(seen, read);
  assert.ok(metrics.changed <= LIMITS.changed, `changed ${metrics.changed}`);
  assert.ok(metrics.hot <= LIMITS.hot, `hot ${metrics.hot}`);
  let drawn = 0;
  for (let i = 0; i < read.data.length; i += 4)
    if (Math.abs(read.data[i] - read.data[0]) + Math.abs(read.data[i + 1] - read.data[1]) > 16) drawn++;
  assert.ok(drawn > 1000, `the cube drew (${drawn} pixels differ from the corner)`);
  assert.deepEqual(pageErrors, []);
  console.log(`ok headless: ${format}, changed ${metrics.changed}, hot ${metrics.hot}, mean ${metrics.mean}`);
} finally {
  await context.close();
}
