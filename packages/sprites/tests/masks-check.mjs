// Real-GPU proof of SpriteLayer masks in @margoengine/sprites (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sprites/tests/masks-check.mjs
// Under exactSize [64, 32]: a rect mask through a zoomed camera and a circle mask outside, moved, flipped and removed
// frame by frame, a camera move and a shaded layer, each matching the image the mask rules give, pixel for pixel.
// Results: test-results/sprites-masks-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/sprites/tests/masks-check.html', port: 5292 }),
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
  await writeFile('test-results/sprites-masks-browser.json', JSON.stringify({ hardware, result: r }, null, 1));
  const exact = { count: 0, first: null };
  assert.deepEqual(r.shapes, exact, 'a rect inside and a circle outside');
  assert.deepEqual(r.moved, exact, 'masks are read each frame: moved and flipped');
  assert.deepEqual(r.none, exact, 'no mask draws everywhere; a circle inside');
  assert.deepEqual(r.camera, exact, 'the mask moves with the camera');
  assert.deepEqual(r.shaded, exact, 'a shaded layer is masked too');
  assert.equal(r.validation, null, 'no validation errors');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log(
    'ok sprite masks: rect, circle, inside and outside, per frame, camera, shader; pixel exact; 0 validation errors',
  );
} finally {
  await context.close();
}
