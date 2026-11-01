// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/tilemap/test/browser-check.mjs
// Under exactSize [64, 32] each frame reads back byte for byte against an image composed on the CPU: a 4 x 4 map of 2 x 2
// tiles, one edit changing exactly 4 pixels, all eight flips, animation, margin and spacing, two tilesets, oversize tiles,
// layer settings, a camera, chunks and culling, a caller target, a device loss. Results: test-results/tilemap-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/tilemap/test/browser-check.html', port: 5342 }),
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
  await writeFile('test-results/tilemap-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU image');
  assert.equal(result.edit.changed, 4, 'one tile edit changes exactly 4 pixels');
  assert.equal(result.edit.uploadedBytes, 16384, 'one tile edit uploads one chunk');
  assert.equal(result.culling.draws, 1, 'a camera in one corner draws one chunk of four');
  assert.equal(result.culling.allDraws, 4, 'a camera on the chunk corner draws all four');
  assert.equal(result.idleUpload, 0, 'a frame with no edit uploads nothing');
  assert.equal(result.animatedUpload, 0, 'an animated tile sends no cells');
  assert.equal(result.lostPlainAtlas, 'state', 'a plain GPUTexture atlas names its fix after a device loss');
  assert.equal(result.collection, 'unsupported', 'an image collection tileset says so');
  assert.equal(result.validation, null, 'no validation errors');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log(
    'ok tilemap:',
    Object.keys(result.checks).length,
    'exact-pixel checks, 0 wrong pixels, 0 validation errors',
  );
} finally {
  await context.close();
}
