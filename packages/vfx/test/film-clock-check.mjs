// Real-GPU check of VFXOptions.clock (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/film-clock-check.mjs
//   MARGO_COMPAT=1 node scripts/run-with-timeout.mjs -- node packages/vfx/test/film-clock-check.mjs
// The same effect drawn at 24, 30, 60 and 5 fps, and a fresh one whose clock is set to 2 s and drawn once, must hold
// the same particle buffer, every byte, at 1 s and at 2 s: a FilmClock makes the particles a function of film time.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/film-clock-check.html', port: 5420 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check.run());
  assert.deepEqual(r.errors, []);
  for (const [time, rows] of Object.entries(r.at)) {
    for (const row of rows) assert.equal(row.time, Number(time), `${row.fps}: clock at ${time} s`);
    assert.ok(rows[0].live > 500, `the fixture keeps particles alive at ${time} s: ${rows[0].live}`);
    for (const row of rows.slice(1))
      assert.deepEqual(row, { ...rows[0], fps: row.fps }, `${row.fps} against ${rows[0].fps} fps at ${time} s`);
    console.log(
      `ok vfx film clock at ${time} s: ${rows.map((x) => x.fps).join(', ')} hold ${rows[0].live} particles, hash ${rows[0].hash}`,
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('vfx film clock check passed');
} finally {
  await context.close();
}
