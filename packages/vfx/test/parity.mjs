import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
if (process.argv.includes('--compat')) process.env.MARGO_COMPAT = '1';
const context = await openBrowser({ startPath: '/packages/vfx/test/parity.html', port: 'free' });
const { page } = context,
  pageErrors = [];
const check = (name) => process.argv.includes('--all') || process.argv.includes('--' + name);
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
  if (check('shapes')) {
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
  if (check('schedule')) {
    const r = await page.evaluate(() => window.checkSchedule());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    assert.ok(r.live > 2);
    assert.deepEqual(r.warm, r.manual);
    assert.deepEqual(r.warm, r.replay);
    console.log('ok schedule: prewarm equals five ordinary steps byte for byte, seeded bursts, exact reset');
  }
  if (check('json')) {
    const r = await page.evaluate(() => window.checkJSON());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    assert.equal(r.stable, true);
    assert.deepEqual(r.state, r.copy);
    assert.ok(r.image.some((n) => n > 0));
    assert.deepEqual(r.image, r.reloaded);
    console.log(
      'ok JSON: stable authoring roundtrip, exact simulated particles and rendered pixels, all four new features, typed texture and fog',
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('ok space: local/world, rigid rotation, velocity inheritance, eight spaced distance births');
  if (check('over-life')) {
    const r = await page.evaluate(() => window.checkOverLife());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (let i = 0; i < 5; i++) {
      const t = (i + 1) * 0.1,
        p = r.states[i];
      near(p[4], 4 * t);
      near(p[7], 0.1 * (1 + 2 * t));
      assert.equal(p[32 + 4], r.first[32 + 4], 'rotation.x stays the birth angle');
    }
    assert.deepEqual(r.first, r.replay);
    near(Math.hypot(...r.capped.slice(4, 7)), 2);
    near(r.rotated[4], 0);
    near(r.rotated[5], 0.8);
    console.log('ok over-life: zero-speed recovery, growth, fixed birth angle, speed cap, reset replay and local rotation');
    const s = await page.evaluate(() => window.checkDrawnSpin());
    assert.equal(s.error, null);
    assert.deepEqual(s.errors, []);
    // Ribbons, random atlas frames and mesh axes key on the birth angle: it never moves.
    assert.ok(s.birth.every((b) => b === s.birth[0]), `birth angle moved: ${s.birth}`);
    // Age 0.5 of a 1 s life: the curve 2 + 8t integrates to 2(0.5) + 4(0.25) = 2 rad.
    const turn = s.drawn - (s.birth[0] + 2),
      off = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
    assert.ok(off < 0.05, `drawn angle ${s.drawn} is ${off} rad from birth ${s.birth[0]} + 2`);
    assert.ok(s.meshLit, 'a mesh with a spin curve draws');
    console.log('ok over-life drawn spin: billboard turned by the integrated curve, mesh draws with it');
  }
} finally {
  await context.close();
}
