import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
export async function checkModifiers(page) {
  const r = await page.evaluate(() => window.check.modify());
  assert.deepEqual(r.repeat, r.first, 'the same seek never accumulates a previous displacement or tint');
  assert.equal(r.sourceAlpha, 0, 'opacity hooks update cloud.read alpha');
  assert.equal(r.sourceSHMatches, true, 'full source SH remains unchanged');
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, label + ': ' + a + ' vs ' + b),
    delta = 0.4 * Math.sin(0.4);
  for (let i = 0; i < 4; i++) {
    const x = -0.6 + i * 0.4 + delta,
      z = -2.9,
      dirZ = z / Math.hypot(x, z),
      sh = 0.1057855469 * (35 * dirZ ** 4 - 30 * dirZ ** 2 + 3);
    near(r.first[i * 4], x, 'warped centre');
    near(r.first[i * 4 + 2], 0.1, 'z displacement');
    near(r.first[i * 4 + 3], i === 1 ? 0 : 0.8, 'reveal opacity');
    near(r.first[16 + i * 4], (0.2 + sh * 0.05) * 0.5, 'highlight acts on degree-4 SH');
    near(r.first[16 + i * 4 + 1], 0.65, 'highlight green');
    near(r.first[16 + i * 4 + 2], 0.2, 'highlight blue');
    near(r.disabled[i * 4], -0.6 + i * 0.4, 'disable restores canonical centre');
    near(r.disposed[i * 4], -0.4 + i * 0.4, 'dispose restores replaced canonical centre');
  }
  near(r.revealed[7], 1.5, 'reveal recovers extended canonical opacity');
  assert.deepEqual(r.restored, r.rebound, 'device restoration retains canonical source and clock');
  assert.deepEqual(r.afterDuplicate, r.restored, 'duplicate owner rejection leaves the first modifier intact');
  assert.equal(r.duplicate, 'attached');
  near(r.elapsed, 2 / 60, 'clock advances once per frame');
  const real = await page.evaluate(() => window.check.modify(true));
  const before = await decodePNG(Buffer.from(real.before.split(',')[1], 'base64')),
    modified = await decodePNG(Buffer.from(real.modified.split(',')[1], 'base64')),
    after = await decodePNG(Buffer.from(real.after.split(',')[1], 'base64'));
  assert.deepEqual(after.data, before.data, 'disposal restores real capture pixel for pixel');
  let changed = 0;
  before.data.forEach((v, i) => {
    if (v !== modified.data[i]) changed++;
  });
  assert.ok(changed > 1000, 'the real capture visibly warps/highlights');
  console.log(JSON.stringify({ modifier: { changed, extendedOpacity: r.revealed[7], clockDelta: r.elapsed } }));
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/modify-check.mjs')) {
  const context = await openBrowser({ startPath: '/packages/splats/test/gpu/splats.html', port: 'free' });
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    await checkModifiers(context.page);
  } finally {
    await context.close();
  }
}
