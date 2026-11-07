// Real-GPU check of a leaf lit from behind. A shadow lookup offsets a receiver along its normal; on a leaf's far side that went
// away from the sun, behind the leaf, so the leaf shadowed its own back and glowed nowhere. Seen from under the real plant,
// leaves must keep the light that comes through them when shadows are on.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/transmission-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-transmission' });
const context = await openBrowser({ startPath: '/packages/shadows/test/transmission.html', port: 5277 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const show = async (colored) => {
  assert.deepEqual(await page.evaluate((c) => window.check.show(c), colored), []);
  return decodePNG(await page.locator('canvas').screenshot());
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const open = await show(undefined),
    blocking = await show(false),
    through = await show(true);
  // Red: the leaves' transmission colour is red in this file. Pixels the sun lights through a leaf with no shadows at all.
  let lit = 0,
    kept = 0,
    keptThrough = 0;
  for (let i = 0; i < open.width * open.height; i++) {
    if (open.data[i * 4] < 40) continue;
    lit++;
    kept += blocking.data[i * 4] / open.data[i * 4];
    keptThrough += through.data[i * 4] / open.data[i * 4];
  }
  const row = { lit, blocking: +(kept / lit).toFixed(3), through: +(keptThrough / lit).toFixed(3) };
  console.log(JSON.stringify(row));
  assert.ok(lit > 2000, 'too few leaf pixels to measure');
  // Leaves above other leaves do lose the light, so the share is under 1; a leaf shadowing itself leaves almost none.
  assert.ok(row.blocking > 0.3, `leaves kept ${row.blocking} of the light through them`);
  assert.ok(row.through >= row.blocking, 'leaves that pass light on must light the leaves below at least as much');
  assert.deepEqual(pageErrors, []);
  console.log('transmission: ok');
} finally {
  await context.close?.();
  await release();
}
