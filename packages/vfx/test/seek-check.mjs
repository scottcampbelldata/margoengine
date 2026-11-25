// Real-GPU bound of GAP-FILM-TIME for particles (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/seek-check.mjs
// Particles are world history on the GPU (class B in docs/limits.md): a seek replays the effect's counters, and the
// scene's prewarm (P = 150 frames, longer than the longest lifetime) rebuilds the particles. A runs n + 1 live frames;
// B seeks (n - P) / fps and draws P + 1; C draws P + 1 with no seek. A and B must upload the same simulate uniform in
// the last frame (clock, step number, births budget: births per step equal exactly) and agree on the live count within
// 5 % on a 2,000 particle fixture; C's step numbers restart (the restart a film cut showed before the seek). Births are
// seeded by step and birth number, not slot (GAP-FILM-VFXSEED), so B holds exactly the particles A holds: every live
// slot's 64 bytes, sorted, are equal (before the fix about none were shared). Then A is reset and drawn beside a fresh
// D: the same uniform and the same live particles, bit for bit (GAP-FILM-RESET).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
// A whole n = 1800 run takes about 10 s on the RTX A6000; each run gets 10 minutes, and every GPU wait inside the page
// 30 s, so a stall fails naming its phase (KB-VFX-SEEKHANG1: one local CI run sat here until the 120-minute step limit).
const RUN_MS = 10 * 60_000;
const context = await openBrowser({ startPath: '/packages/vfx/test/seek-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  for (const n of [600, 1800]) {
    await page.goto(new URL('/packages/vfx/test/seek-check.html', page.url()).href, { timeout: 120000 });
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const started = Date.now();
    let timer;
    const r = await Promise.race([
      page.evaluate((steps) => window.check.run(steps), n),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          // The page's main thread is free while it waits on the GPU, so it can still say where it is.
          const phase = await Promise.race([
            page.evaluate(() => window.check.phase),
            new Promise((done) => setTimeout(() => done('unknown (the page did not answer)'), 10000)),
          ]);
          reject(new Error(`vfx seek n = ${n} did not finish within ${RUN_MS / 60000} min; it stopped at ${phase}`));
        }, RUN_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(r.errors, [], `GPU errors at n = ${n}`);
    assert.deepEqual(r.zero, [0, 0, 0, 0], 'warm-up frames move no clock');
    assert.equal(r.steps, n - 150);
    assert.ok(
      r.clocks.includes(r.name) && !r.unseekable.includes(r.name),
      `the effect is replayed: ${JSON.stringify(r)}`,
    );
    assert.ok(Object.is(r.timeB, r.timeA), `clocks ${r.timeA} and ${r.timeB}`);
    assert.ok(r.uniformEqual, 'the last simulate uniform is equal');
    assert.equal(r.birthsB, r.birthsA, 'births per step equal');
    assert.equal(r.stepB, r.stepA);
    assert.notEqual(r.stepC, r.stepA, 'without the seek the step numbers restart');
    const off = Math.abs(r.liveB - r.liveA) / r.liveA;
    assert.ok(r.liveA > 500, `the fixture keeps particles alive: ${r.liveA}`);
    assert.ok(off <= 0.05, `live counts ${r.liveA} and ${r.liveB} differ by ${(off * 100).toFixed(2)} %`);
    assert.equal(r.keptB, r.keptA, `live slots read back: ${r.keptA} continuous, ${r.keptB} after the seek`);
    assert.ok(
      r.sameParticles,
      `${r.shared} of ${r.keptA} live particles equal after the seek and warm-up (GAP-FILM-VFXSEED)`,
    );
    // GAP-FILM-RESET: the effect reset after its run, drawn beside a fresh one, holds the same particles.
    assert.equal(r.resetTime, 0, 'resetTime puts the clock at 0');
    assert.ok(r.resetUniform, 'the reset effect uploads the uniform of a fresh one');
    assert.equal(r.resetLive[0], r.resetLive[1], 'live counts after the reset');
    assert.ok(r.resetLive[0] > 100, `the reset run keeps particles alive: ${r.resetLive[0]}`);
    assert.deepEqual(r.resetKept[0], r.resetKept[1], 'live slots after the reset');
    assert.ok(
      r.resetSame,
      `${r.resetShared} of ${r.resetKept[0]} live particles equal a fresh effect's after the reset`,
    );
    console.log(
      `ok vfx seek n = ${n} (${((Date.now() - started) / 1000).toFixed(1)} s): births ${r.birthsA} equal, live ${r.liveA} continuous, ${r.liveB} after seek and prewarm (${(off * 100).toFixed(2)} %), ${r.liveC} prewarm alone; ${r.shared} of ${r.keptA} particles equal bit for bit`,
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('vfx seek check passed');
} finally {
  await context.close();
}
