// Real-GPU proof of @margoengine/sprites/skeletal (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sprites/tests/skeletal-check.mjs
// Under exactSize [64, 32]: a skinned strip in its bind pose and turned a quarter about its root matches the CPU image
// byte for byte; bent at its tip, the top half stays, the bottom half swings out; tint and alpha blend.
// Results: test-results/sprites-skeletal-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/sprites/tests/skeletal-check.html', port: 5291 }),
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
  await writeFile('test-results/sprites-skeletal-browser.json', JSON.stringify({ hardware, result: r }, null, 1));
  assert.deepEqual(r.rigid, { count: 0, first: null }, 'bind pose and a quarter turn match byte for byte');
  assert.ok(r.bent.topKept, 'bending at the tip leaves the top half');
  assert.deepEqual(r.bent.swungBefore, r.background, 'the swing point was empty before');
  // The bent bottom triangle has corners (4, 4), (-4, 8), (-4, 4) with uvs (4, 4), (4, 8), (0, 8); pixel (47, 7) has its
  // centre at (-2.5, 5.5) from the strip's origin, which is uv (2.25, 7.25): texel (2, 7).
  assert.deepEqual(r.bent.swung, r.texel27, 'the bottom half swings left of the strip, texel (2, 7) at pixel (47, 7)');
  assert.deepEqual(r.bent.bottomGone, r.background, 'and leaves where it was');
  // Red tint, alpha 0.5: red channel (texel red * 0.5 + background * 0.5), green and blue the background's half.
  const expected = [r.texel0[0] * 0.5 + r.background[0] * 0.5, r.background[1] * 0.5, r.background[2] * 0.5];
  r.tinted.forEach((v, c) => assert.ok(Math.abs(v - expected[c]) <= 1, `tinted ${r.tinted} vs ${expected}`));
  assert.equal(r.validation, null, 'no validation errors');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok skeletal sprites: bind pose and quarter turn exact, bend, tint; 0 validation errors');
} finally {
  await context.close();
}
