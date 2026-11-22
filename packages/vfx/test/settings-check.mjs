// Real-GPU proof of @margoengine/vfx/settings (run from the repository root after building packages; MARGO_COMPAT=1 for
// the WebGL2 layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/settings-check.mjs
// Writing every live row each frame for 60 frames (applyVfxSettings on a smoke effect) makes no pipeline, buffer or
// texture and no GPU error, the wind rows set the effect's wind, and a panel's values read back as written.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5272/packages/vfx/test/settings-check.html',
  context = await openBrowser({ startPath: '/packages/vfx/test/settings-check.html', port: 5272 }),
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
  const r = await page.evaluate(() => window.check.run());
  assert.deepEqual(r.errors, [], 'GPU errors');
  assert.deepEqual(r.after, r.before, `60 frames of every live row made GPU objects: ${JSON.stringify(r)}`);
  assert.ok(Array.isArray(r.wind) && r.wind.length === 2, 'the wind rows set the wind');
  assert.ok(r.back, 'the values read back as written');
  const x = await page.evaluate(() => window.check.exact());
  const same = { differing: 0, max: 0 };
  assert.deepEqual(
    { ...x.repeat, lit: 0 },
    { ...same, lit: 0 },
    `two renders of one effect differ: ${JSON.stringify(x)}`,
  );
  assert.ok(
    x.apart.differing > 500 && x.apart.lit > 100,
    `the effect with options should draw differently and show: ${JSON.stringify(x)}`,
  );
  assert.deepEqual(
    { ...x.defaults, lit: 0 },
    { ...same, lit: 0 },
    `the default rows draw an unconfigured effect frame exact: ${JSON.stringify(x)}`,
  );
  assert.deepEqual(
    { ...x.written, lit: 0 },
    { ...same, lit: 0 },
    `written rows draw the frame of the same options built in: ${JSON.stringify(x)}`,
  );
  console.log(
    `ok vfx frame exact: defaults = unconfigured effect, rows = options built in, 40 frames, options change ${x.apart.differing} bytes`,
  );
  const sand = await page.evaluate(() => window.sand());
  assert.deepEqual(sand.errs, [], 'GPU errors on the sand scene');
  assert.deepEqual(
    sand.counts,
    { pipelines: 0, buffers: 0, textures: 0 },
    `60 frames of every live sand row made GPU objects: ${JSON.stringify(sand)}`,
  );
  assert.ok(sand.particles > 100, `the sand shows: ${JSON.stringify(sand)}`);
  assert.equal(sand.differing, 0, `the default sand rows draw the layer's own frame exact: ${JSON.stringify(sand)}`);
  console.log(
    `ok sand settings: ${sand.rows} live rows for 60 frames made no pipeline, buffer or texture; defaults frame exact (${sand.particles} particles)`,
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    `ok vfx settings: ${r.rows} live rows for 60 frames made no pipeline, buffer or texture (${JSON.stringify(r.after)})`,
  );
} finally {
  await context.close();
}
