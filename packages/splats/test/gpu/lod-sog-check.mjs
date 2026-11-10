import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
export async function checkStreamedSog(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.check.lod({ streamed: true, maxError: 0, reference: true }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.drawn, 8385);
  const image = await decodePNG(Buffer.from(r.url.split(',')[1], 'base64')),
    reference = await decodePNG(Buffer.from(r.reference.split(',')[1], 'base64'));
  assert.deepEqual(image.data, reference.data, 'streamed real SOG renders exactly as its resident pool');
  assert.ok(
    image.data.some((v, i) => i % 4 !== 3 && v > 30),
    'real capture draws',
  );
  const values = await page.evaluate(() => window.check.sogV3());
  assert.ok(
    Math.abs(values[0] - (0.5 + (0.2 * 3) / Math.sqrt(4 * Math.PI))) < 1e-6,
    'degree 4 zonal SH evaluated at negative z',
  );
  assert.equal(values[7], 1.5625, 'projection preserves extended opacity before fragment alpha cap');
  assert.deepEqual(errors.concat(await page.evaluate(() => window.check.errors)), []);
  console.log(JSON.stringify({ drawn: r.drawn, selected: r.selected, v3: values.slice(0, 4), opacity: values[7] }));
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/lod-sog-check.mjs')) {
  const context = await openBrowser({ startPath: '/packages/splats/test/gpu/splats.html', port: 'free' });
  try { await checkStreamedSog(context.page); } finally { await context.close(); }
}
