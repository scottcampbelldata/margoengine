// Real-GPU proof of GAP-FILM-TIME for the sky (run from the repository root after building packages, with the GPU to
// itself where possible, KB-FILM-GPUSHARE1):
//   node scripts/run-with-timeout.mjs -- node packages/sky/test/seek-check.mjs
// The page builds three alike worlds (sheet clouds and stars at dusk with a moving clock, temporal volumetric clouds,
// rain with seeded lightning, a wind change on the way): A draws n + 1 live frames; B is fresh, seeks n / fps with
// @margoengine/cutscene/seek and draws one live frame; C draws one frame with no seek. The HDR scene captures of A and
// B must be equal float for float; C must differ (the restart a film cut showed before the seek).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/sky/test/seek-check.html', port: 5223 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  for (const n of [1, 600]) {
    // Fresh worlds for each n: a seek needs clocks at 0.
    await page.goto('http://127.0.0.1:5223/packages/sky/test/seek-check.html');
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const r = await page.evaluate((steps) => window.check.run(steps), n);
    assert.deepEqual(r.errors, [], `GPU errors at n = ${n}`);
    assert.equal(r.steps, n);
    for (const name of ['sky', 'sky:volumetric-clouds', 'weather'])
      assert.ok(r.clocks.includes(name) && !r.unseekable.includes(name), `${name} is replayed: ${JSON.stringify(r)}`);
    assert.deepEqual(r.clocksB, r.clocksA, 'the clocks agree');
    assert.deepEqual(r.amount[1], r.amount[0]);
    assert.deepEqual(r.wet[1], r.wet[0]);
    assert.ok(r.lit > 0, 'the frame is lit');
    assert.equal(r.differ, 0, `seeked and continuous frames differ in ${r.differ} of ${r.values} values at n = ${n}`);
    if (n === 600) assert.ok(r.fresh > 0, 'a fresh frame without the seek differs from the continuous one');
    console.log(
      `ok sky seek n = ${n}: ${r.values} values equal, fresh start differs in ${r.fresh}, strikes ${r.strikes}, not replayed ${r.unseekable}`,
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('sky seek check passed');
} finally {
  await context.close();
}
