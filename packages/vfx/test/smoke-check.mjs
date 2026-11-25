// Real-GPU proof of @margoengine/vfx/smoke (run from the repository root after building packages; MARGO_COMPAT=1 for
// the WebGL2 layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/smoke-check.mjs
// See smoke-check.html for what each step measures.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5291/packages/vfx/test/smoke-check.html',
  context = await openBrowser({ startPath: '/packages/vfx/test/smoke-check.html', port: 5291 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.goto(url);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const r of await page.evaluate(() => window.check.rise())) {
    assert.deepEqual(r.errors, [], `GPU errors at ${r.U} m/s`);
    assert.ok(r.count >= 90, `puffs alive at ${r.U} m/s: ${r.count}`);
    assert.ok(r.worstStep <= 0.01, `${r.U} m/s: heights against the CPU step ${r.worstStep}`);
    assert.ok(r.worstLaw <= 0.07, `${r.U} m/s: heights against the plume law ${r.worstLaw}`);
    assert.ok(r.worstLean <= 0.5, `${r.U} m/s: lean ${r.worstLean} degrees`);
    console.log(
      `ok smoke rise ${r.U} m/s: ${r.count} puffs, step ${(r.worstStep * 100).toFixed(3)}%, law ${(r.worstLaw * 100).toFixed(2)}%, lean ${r.worstLean.toFixed(3)} deg`,
    );
  }
  const repeat = await page.evaluate(() => window.check.repeat());
  assert.equal(repeat.differing, 0, `two runs differ: ${JSON.stringify(repeat)}`);
  console.log(`ok smoke repeat: ${repeat.floats} floats the same`);
  const live = await page.evaluate(() => window.check.live());
  assert.deepEqual(live.errors, []);
  assert.deepEqual(
    live.made,
    { pipelines: 0, buffers: 0, textures: 0 },
    `60 frames of every live row made GPU objects: ${JSON.stringify(live)}`,
  );
  console.log(`ok smoke settings: ${live.rows} live rows for 60 frames made no pipeline, buffer or texture`);
  const d = await page.evaluate(() => window.check.defaults());
  assert.equal(d.differing, 0, `the default rows change the frame: ${JSON.stringify(d)}`);
  // The column covers its plume's outline: the law's width 2 r(z) over its 10 s rise, seen from 220 m with a 60 degree
  // view on 192 rows (about 204 px). Before still air held the puffs (KB-FIRE-SMOKEVEIL1) their churn walked them out
  // of the column and it covered 493 px, 2.4 times its outline.
  const { buoyancyFlux, plumeRise } = await import('../dist/smoke.js');
  let outline = 0;
  for (let i = 1, F = buoyancyFlux(5e6), last = plumeRise(0, F, 0, 2); i <= 1000; i++) {
    const p = plumeRise(i / 100, F, 0, 2);
    outline += 2 * p.radius * (p.rise - last.rise);
    last = p;
  }
  outline *= (192 / (2 * 220 * Math.tan(Math.PI / 6))) ** 2;
  assert.ok(
    d.lit >= 0.5 * outline && d.lit <= 1.5 * outline,
    `the column shows over an empty scene, within half to one and a half times its plume's outline of ${outline.toFixed(0)} px: ${JSON.stringify(d)}`,
  );
  console.log(
    `ok smoke defaults frame exact; the column covers ${d.lit} pixels against its plume's outline of ${outline.toFixed(0)}`,
  );
  assert.deepEqual(pageErrors, []);
  console.log('smoke check passed');
} finally {
  await context.close();
}
