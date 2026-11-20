// Real-GPU proof of GAP-FILM-TIME for the weather (run from the repository root after building packages, with the GPU
// to itself where possible, KB-FILM-GPUSHARE1):
//   node scripts/run-with-timeout.mjs -- node packages/weather/tests/seek-check.mjs
// The page builds three alike worlds (a WeatherDrive stepping a machine whose schedule changes the wind and the hail on
// the way, Hail, Puddles with rain rings): A draws n + 1 live frames; B is fresh, seeks n / fps with
// @margoengine/cutscene/seek and draws one live frame; C draws one frame with no seek. The HDR scene captures of A and
// B must be equal float for float; C must differ (the restart a film cut showed before the seek).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5264/packages/weather/tests/seek-check.html',
  context = await openBrowser({ startPath: '/packages/weather/tests/seek-check.html', port: 5264 }),
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
    await page.goto(url);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const r = await page.evaluate((steps) => window.check.run(steps), n);
    assert.deepEqual(r.errors, [], `GPU errors at n = ${n}`);
    assert.equal(r.steps, n);
    for (const name of ['weather-drive', 'hail', 'weather-puddles'])
      assert.ok(r.clocks.includes(name) && !r.unseekable.includes(name), `${name} is replayed: ${JSON.stringify(r)}`);
    assert.deepEqual(r.clocksB, r.clocksA, 'the clocks agree');
    assert.ok(r.lit > 0, 'the frame is lit');
    assert.ok(r.stones > 0, 'hail falls');
    assert.equal(r.differ, 0, `seeked and continuous frames differ in ${r.differ} of ${r.values} values at n = ${n}`);
    if (n === 600) {
      assert.ok(r.wetness > 0.1, `the ground is wet: ${r.wetness}`);
      assert.ok(r.fresh > 0, 'a fresh frame without the seek differs from the continuous one');
    }
    console.log(`ok weather seek n = ${n}: ${r.values} values equal, fresh start differs in ${r.fresh}, stones ${r.stones}, wetness ${r.wetness.toFixed(3)}, not replayed ${r.unseekable}`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('weather seek check passed');
} finally {
  await context.close();
}
