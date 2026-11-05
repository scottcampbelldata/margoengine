// Real-GPU regression test: a package's render pass takes core's clear and resolves the frame, so the frame is one render
// pass, and the same bit for bit as with core's own passes. Empty passes around the package keep it from joining them,
// which is the way the frame was drawn before.
// Run from the repository root after `npm run build:packages`: node packages/culling/test/gpu/last-pass-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../..', import.meta.url)));
const page0 = '/packages/culling/test/gpu/last-pass.html';
const release = await acquire({ owner: 'culling-last-pass' });
const context = await openBrowser({ startPath: `${page0}?scene=none`, port: 5282 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const frame = async (query) => {
  await page.goto(new URL(`${page0}?${query}`, page.url()).href);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20_000 }).catch((e) => assert.fail(`${query}: ${pageErrors.join('; ') || e.message}`));
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  return { image: await decodePNG(await page.locator('canvas').screenshot()), passes: await page.evaluate(() => window.passes) };
};
try {
  // Colour passes a frame: one, or the old way core's clear, the package's pass and core's resolve.
  for (const [scene, last, tail] of [
    ['none', 1, 2],
    ['before', 1, 2],
    ['instanced', 1, 3],
    ['culled', 1, 3],
    ['pair', 1, 3],
    ['blended', 1, 3],
  ]) {
    const { image, passes } = await frame(`scene=${scene}`),
      { image: whole, passes: all } = await frame(`scene=${scene}&old=1`);
    let differing = 0,
      lit = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] !== image.data[0] || image.data[i + 1] !== image.data[1]) lit++;
      for (let k = 0; k < 4; k++)
        if (image.data[i + k] !== whole.data[i + k]) {
          differing++;
          break;
        }
    }
    console.log(`${scene}: ${passes} colour passes, ${all} the old way; ${lit} lit pixels, ${differing} differ`);
    assert.equal(passes, last, `${scene}: colour passes`);
    assert.equal(all, tail, `${scene}: colour passes the old way`);
    // 4x blending is not repeatable on the GPU itself (docs/known-bugs.md), so a blended frame may differ on its edges.
    if (scene === 'pair' || scene === 'blended') assert.ok(differing < lit / 100, `${scene}: ${differing} pixels differ`);
    else assert.equal(differing, 0, `${scene}: pixels differ`);
    if (scene !== 'none' && scene !== 'before') assert.ok(lit > 2000, `${scene}: the frame is nearly empty (${lit})`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('ok - the last pass resolves the frame, and the frame is unchanged');
} finally {
  await context.close();
  release();
}
