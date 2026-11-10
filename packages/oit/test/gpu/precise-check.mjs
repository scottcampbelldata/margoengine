import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/packages/oit/test/gpu/precise.html', port: 'free' });
const { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const build = (o) => page.evaluate((options) => window.check.build(options), o);
  const report = [];
  for (const samples of [1, 4]) {
    const got = await build({ samples }),
      wanted = [1000, 500, 250].map((v) => v * (1 - 0.5 ** 8));
    for (let i = 0; i < 3; i++)
      assert.ok(Number.isFinite(got[i]) && Math.abs(got[i] - wanted[i]) <= 0.5, `${samples}x HDR: ${got} vs ${wanted}`);
    const reordered = await build({ samples, reverse: true });
    assert.deepEqual(reordered, got, 'reordering identical radiance changes no result');
    const half = await build({ samples, mode: 'half' });
    assert.ok(
      half.slice(0, 3).some((v, i) => !Number.isFinite(v) || Math.abs(v - wanted[i]) > 100),
      'the same scene overflows half-float accumulation',
    );
    const low = await build({ samples, brightness: 0.5 }),
      old = await build({ samples, brightness: 0.5, mode: 'half' });
    assert.ok(
      low.every((v, i) => Math.abs(v - old[i]) <= 0.001),
      'ordinary radiance agrees with OIT',
    );
    const blocked = await build({ samples, blocker: true });
    assert.deepEqual(blocked.slice(0, 3), [0.25, 0.5, 0.75], 'scene depth occludes bright accumulation');
    const shot = async () =>
      decodePNG(Buffer.from((await page.evaluate(() => window.check.shot())).split(',')[1], 'base64'));
    await build({ samples, brightness: 0.5, edge: true });
    const edge = await shot();
    await build({ samples, brightness: 0.5, edge: true, mode: 'half' });
    const oldEdge = await shot();
    let moved = 0;
    for (let i = 0; i < edge.data.length; i++) moved = Math.max(moved, Math.abs(edge.data[i] - oldEdge.data[i]));
    assert.ok(moved <= 1, `${samples}x edge coverage matches OIT, worst ${moved}`);
    report.push({ samples, got, half });
  }
  assert.deepEqual(errors.concat(await page.evaluate(() => window.check.errors)), [], 'no GPU/shader errors');
  await page.goto(new URL('/packages/oit/test/gpu/real.html', page.url()).href);
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const info = await page.evaluate(() =>
    window.check.build({ samples: 4, mode: 'precise', url: '/examples/assets/khronos-samples/GlassVaseFlowers.glb' }),
  );
  assert.ok(info.transparent > 0);
  assert.ok((await page.evaluate(() => window.check.turn(90))) > 0, 'real PBR BLEND primitives accumulate');
  assert.deepEqual(
    errors.concat(await page.evaluate(() => window.check.errors)),
    [],
    'real PBR has no shader/GPU errors',
  );
  console.log(JSON.stringify(report));
  console.log('oit precise passed');
} finally {
  await browser.close();
}
