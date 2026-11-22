// Real-GPU proof of @margoengine/vfx/gunfire (run from the repository root after building packages; MARGO_COMPAT=1 for
// the WebGL2 layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/gunfire-check.mjs
// See gunfire-check.html for what each step measures.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5410/packages/vfx/test/gunfire-check.html',
  context = await openBrowser({ startPath: '/packages/vfx/test/gunfire-check.html', port: 5410 }),
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
  const f = await page.evaluate(() => window.check.flash());
  assert.deepEqual(f.errors, []);
  assert.equal(f.fired, 1);
  assert.ok(f.before === 0 && f.at >= 100 && f.later <= 1, `the flash shows on its frame only: ${JSON.stringify(f)}`);
  console.log(
    `ok gunfire flash: ${f.before} pixels the flash changes before, ${f.at} on the shot frame, ${f.later} a third of a second on`,
  );
  const b = await page.evaluate(() => window.check.bank());
  assert.deepEqual(b.errors, []);
  assert.ok(
    b.lit >= 0.4 * b.disc && b.lit <= 2.5 * b.disc,
    `the bank covers about its projected disc of ${b.disc.toFixed(0)} px: ${JSON.stringify(b)}`,
  );
  assert.ok(
    Math.hypot(b.mx - b.cx, b.my - b.cy) <= 0.35 * Math.sqrt(b.disc / Math.PI) + 3,
    `the drawn bank sits where Battery puts it: ${JSON.stringify(b)}`,
  );
  assert.ok(
    Math.abs(b.drift - b.along - 4 * (b.time - 0.1)) < 1e-3,
    `its centre is its path plus the wind drift: ${JSON.stringify(b)}`,
  );
  console.log(
    `ok gunfire bank: ${b.lit} px against its ${b.disc.toFixed(0)} px disc, centroid off by ${Math.hypot(b.mx - b.cx, b.my - b.cy).toFixed(1)} px`,
  );
  const h = await page.evaluate(() => window.check.hull());
  assert.deepEqual(h.errors, []);
  assert.ok(h.flames >= 30 && h.dark >= 200, `a burning hull draws flames and dark smoke: ${JSON.stringify(h)}`);
  console.log(
    `ok gunfire hull: ${h.flames} flame pixels, ${h.dark} dark smoke pixels above, ${(h.heat / 1e6).toFixed(1)} MW`,
  );
  const sp = await page.evaluate(() => window.check.sparks());
  assert.deepEqual(sp.errors, []);
  assert.ok(sp.lit >= 15 && sp.beyond >= 10, `burning grains fly out past the flash: ${JSON.stringify(sp)}`);
  console.log(`ok gunfire sparks: ${sp.lit} pixels the grains light, ${sp.beyond} beyond the flash ball`);
  const st = await page.evaluate(() => window.check.strike());
  assert.deepEqual(st.errors, []);
  assert.deepEqual(st.hits, ['through', 'exit']);
  assert.ok(st.near >= 10, `a strike throws splinters at the side: ${JSON.stringify(st)}`);
  console.log(`ok gunfire strike: ${st.near} splinter pixels over the five frames after the ball holed the side`);
  const ch = await page.evaluate(() => window.check.char());
  assert.deepEqual(ch.errors, []);
  assert.ok(
    ch.inside < 0.5 * ch.outside &&
      Math.abs(ch.inside - ch.expected) < 0.12 * ch.expected &&
      Math.abs(ch.keel - ch.outside) < 0.1 * ch.outside,
    `the char is drawn where the fire has been, as its CPU twin: ${JSON.stringify(ch)}`,
  );
  console.log(
    `ok gunfire char: the deck edge ${ch.inside.toFixed(0)} (twin ${ch.expected.toFixed(0)}) inside the fire's ${ch.reach} m reach against ${ch.outside.toFixed(0)} beyond, keel ${ch.keel}`,
  );
  const r = await page.evaluate(() => window.check.repeat());
  assert.equal(r.differing, 0, `two runs differ: ${JSON.stringify(r)}`);
  console.log(`ok gunfire repeat: ${r.bytes} bytes the same`);
  const live = await page.evaluate(() => window.check.live());
  assert.deepEqual(live.errors, []);
  assert.deepEqual(
    live.made,
    { pipelines: 0, buffers: 0, textures: 0 },
    `60 frames of every live row made GPU objects: ${JSON.stringify(live)}`,
  );
  console.log(
    `ok gunfire settings: ${live.rows} live rows and ${live.fired} shots over 60 frames made no pipeline, buffer or texture`,
  );
  assert.deepEqual(pageErrors, []);
  console.log('gunfire check passed');
} finally {
  await context.close();
}
