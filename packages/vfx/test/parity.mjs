import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
if (process.argv.includes('--compat')) process.env.MARGO_COMPAT = '1';
const context = await openBrowser({ startPath: '/packages/vfx/test/parity.html', port: 'free' });
const { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const near = (a, b) => assert.ok(Math.abs(a - b) < 2e-5, `${a} != ${b}`);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.checkSpace());
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  near(r.results.local.old[0], 2);
  near(r.results.world.old[0], 0);
  for (const mode of ['local', 'world']) {
    near(r.results[mode].born[0], 3);
    near(r.results[mode].born[4], 10);
    for (let i = 0; i < 8; i++) near(r.results[mode].distance[i * 8], (i + 1) * 0.25);
  }
  near(r.results.rotated[0], 0);
  near(r.results.rotated[1], 1);
  if (process.argv.includes('--shapes')) {
    const r = await page.evaluate(() => window.checkShapes());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (const s of r.results) {
      assert.equal(s.bad, 0, JSON.stringify(s));
      assert.equal(s.repeat, true);
      assert.ok(s.normalError < 2e-5, JSON.stringify(s));
      if (['hemisphere', 'cylinder', 'torus'].includes(s.emitter.shape))
        assert.ok(Math.abs(s.radius - (s.emitter.shell ? 1 : 0.5)) < 0.035, JSON.stringify(s));
      if (s.emitter.shape === 'hemisphere') assert.ok(Math.abs(s.axial - 0.5) < 0.025);
      if (s.emitter.shape === 'cylinder') assert.ok(Math.abs(s.axial - 1 / 12) < 0.01);
      if (s.emitter.shape === 'torus' && s.emitter.shell) assert.ok(Math.abs(s.cos - 0.125) < 0.035, JSON.stringify(s));
      if (s.emitter.shape === 'rectangle-edge')
        for (let k = 0; k < 4; k++) assert.ok(Math.abs(s.sides[k] / 4096 - (k % 2 ? 1 / 6 : 1 / 3)) < 0.03);
      if (s.emitter.shape === 'grid') {
        assert.equal(Object.keys(s.cells).length, 24);
        assert.ok(Object.values(s.cells).every((n) => Math.abs(n - 4096 / 24) < 60));
      }
    }
    console.log(
      'ok shapes: 4096 births each, volume/shell moments, torus area correction, perimeter shares, grid occupancy, normals and exact reset',
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('ok space: local/world, rigid rotation, velocity inheritance, eight spaced distance births');
  if (process.argv.includes('--over-life')) {
    const r = await page.evaluate(() => window.checkOverLife());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (let i = 0; i < 5; i++) {
      const t = (i + 1) * 0.1,
        p = r.states[i];
      near(p[4], 4 * t);
      near(p[7], 0.1 * (1 + 2 * t));
      near(p[32 + 4], r.first[32 + 4] + 2 * (t * t - 0.01));
    }
    assert.deepEqual(r.first, r.replay);
    near(Math.hypot(...r.capped.slice(4, 7)), 2);
    near(r.rotated[4], 0);
    near(r.rotated[5], 0.8);
    console.log(
      'ok over-life: zero-speed recovery, growth, integrated spin, speed cap, reset replay and local rotation',
    );
  }
} finally {
  await context.close();
}
