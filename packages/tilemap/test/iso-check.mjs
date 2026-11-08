// Real-GPU proof of @margoengine/tilemap/iso (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/tilemap/test/iso-check.mjs
// Isometric, x-staggered and hexagonal maps with tall tiles from a second tileset, flips, hex turns, zoom and scroll
// match images painted on the CPU from the layout rules, pixel for pixel. Results: test-results/tilemap-iso-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/tilemap/test/iso-check.html', port: 5295 }),
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
  await writeFile('test-results/tilemap-iso-browser.json', JSON.stringify({ hardware, result: r }, null, 1));
  for (const name of ['iso', 'staggered', 'hex', 'hexTurned']) {
    assert.equal(r[name].count, 0, `${name}: ${JSON.stringify(r[name].first)}`);
    assert.ok(r[name].checked > 2000, `${name} checks most pixels: ${r[name].checked}`);
  }
  // Walls and floor tiles of the second layer interleave in paint order: one draw per run of one tileset.
  assert.ok(r.iso.draws >= 3, `iso draws ${r.iso.draws}`);
  assert.equal(r.validation, null, 'no validation errors');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok grid tile maps: isometric, staggered, hexagonal, flips and turns pixel exact; 0 validation errors');
} finally {
  await context.close();
}
