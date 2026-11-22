// Real-GPU proof of @margoengine/vfx/fire-front (run from the repository root after building packages; MARGO_COMPAT=1 for
// the WebGL2 layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/fire-front-check.mjs
// See fire-front-check.html for what each step measures.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5292/packages/vfx/test/fire-front-check.html',
  context = await openBrowser({ startPath: '/packages/vfx/test/fire-front-check.html', port: 5292 }),
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
  const tex = await page.evaluate(() => window.check.texture());
  assert.deepEqual(tex.errors, [], `GPU errors: ${tex.errors}`);
  assert.equal(
    tex.differing,
    0,
    `the burn texture differs from the CPU grid in ${tex.differing} of ${tex.floats} values`,
  );
  assert.ok(
    tex.burning > 10 && tex.burnt > 10 && tex.unburnt > 100,
    `the texture holds a front: ${JSON.stringify(tex)}`,
  );
  console.log(
    `ok fire burn texture: ${tex.floats} floats equal the CPU grid (${tex.burning} burning, ${tex.burnt} burnt, ${tex.unburnt} unburnt cells)`,
  );
  const smoke = await page.evaluate(() => window.check.smoke());
  assert.deepEqual(smoke.errors, []);
  assert.equal(smoke.columns, 4);
  assert.ok(smoke.hot >= 2, `columns stand on the hottest segments: ${JSON.stringify(smoke)}`);
  assert.equal(smoke.worstHeat, 0, `column heat is the segment heat: ${JSON.stringify(smoke)}`);
  assert.ok(smoke.worstOff <= 1e-3, `column position is the segment position: ${smoke.worstOff}`);
  assert.ok(smoke.lit > 100, `smoke draws over an empty scene: ${smoke.lit} pixels`);
  console.log(`ok fire smoke: ${smoke.hot} columns on the front, heat and position exact, ${smoke.lit} pixels`);
  const live = await page.evaluate(() => window.check.live());
  assert.deepEqual(live.errors, []);
  assert.deepEqual(
    live.made,
    { pipelines: 0, buffers: 0, textures: 0 },
    `60 frames of every live row made GPU objects: ${JSON.stringify(live)}`,
  );
  console.log(`ok fire settings: ${live.rows} live rows for 60 frames made no pipeline, buffer or texture`);
  assert.deepEqual(pageErrors, []);
  console.log('fire-front check passed');
} finally {
  await context.close();
}
