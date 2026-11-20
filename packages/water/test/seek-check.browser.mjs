// Real-GPU proof of GAP-FILM-TIME for water (run from the repository root after building packages, with the GPU to
// itself where possible, KB-FILM-GPUSHARE1):
//   node scripts/run-with-timeout.mjs -- node packages/water/test/seek-check.browser.mjs
// The page builds three alike worlds, once with Water's Gerstner waves, WaterFlow and WaterRain rings and once with an
// FFTOcean (foam off): A draws n + 1 live frames; B is fresh, seeks n / fps with @margoengine/cutscene/seek and draws
// one live frame; C draws one frame with no seek. The HDR scene captures of A and B must be equal float for float; C
// must differ (the restart a film cut showed before the seek).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const url = 'http://127.0.0.1:5266/packages/water/test/seek-check.html',
  context = await openBrowser({ startPath: '/packages/water/test/seek-check.html', port: 5266 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  for (const kind of ['gerstner', 'fft'])
    for (const n of [1, 600]) {
      // Fresh worlds for each n: a seek needs clocks at 0.
      await page.goto(`${url}?kind=${kind}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
      const r = await page.evaluate((steps) => window.check.run(steps), n);
      assert.deepEqual(r.errors, [], `GPU errors, ${kind} at n = ${n}`);
      assert.equal(r.steps, n);
      for (const name of r.names)
        assert.ok(r.clocks.includes(name) && !r.unseekable.includes(name), `${name} is replayed: ${JSON.stringify(r)}`);
      assert.deepEqual(r.clocksB, r.clocksA, 'the clocks agree');
      assert.ok(r.lit > 0, 'the frame is lit');
      assert.equal(r.differ, 0, `${kind}: seeked and continuous frames differ in ${r.differ} of ${r.values} values at n = ${n}`);
      if (n === 600) assert.ok(r.fresh > 0, 'a fresh frame without the seek differs from the continuous one');
      console.log(`ok water seek ${kind} n = ${n}: ${r.values} values equal, fresh start differs in ${r.fresh}, not replayed ${r.unseekable}`);
    }
  assert.deepEqual(pageErrors, []);
  console.log('water seek check passed');
} finally {
  await context.close();
}
