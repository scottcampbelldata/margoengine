// Real-GPU check of wind-blown sand (run from the repository root after building packages; MARGO_COMPAT=1 for the
// WebGL2 compatibility layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/blown-sand-check.mjs
// Over a sand floor under a 12 m/s wind the sand changes the frame and adds one draw call; the same time draws the same
// pixels; a later time draws others; under a 3 m/s wind (below the 6.6 m/s threshold) the frame is the frame with no
// sand at all.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/blown-sand-check.html', port: 5301 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const shot = async (args, snow = false) => {
  const r = await page.evaluate(([a, physical]) => (physical ? window.snowStep(a) : window.step(a)), [args, snow]);
  assert.deepEqual(r.errors, [], JSON.stringify(args));
  return { ...r, image: await decodePNG(await page.locator('canvas').screenshot()) };
};
const differing = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      3
    )
      n++;
  return n;
};
try {
  console.log('device', hardware?.compat ? 'webgl2-compat layer' : 'webgpu', JSON.stringify(hardware?.webgpu ?? ''));
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const none = await shot({ wind: null, time: 0 }),
    blowing = await shot({ wind: 12, time: 20 }),
    again = await shot({ wind: 12, time: 20 }),
    later = await shot({ wind: 12, time: 20.4 }),
    calm = await shot({ wind: 3, time: 20 });
  const changed = differing(none.image, blowing.image),
    total = none.image.width * none.image.height;
  console.log(`sand at 12 m/s changes ${changed} of ${total} pixels, ${blowing.particles} particles`);
  assert.ok(changed > total * 0.02, `the sand shows: ${changed} pixels`);
  assert.equal(blowing.drawCalls - none.drawCalls, 1, `one draw call more: ${none.drawCalls} -> ${blowing.drawCalls}`);
  assert.equal(differing(blowing.image, again.image), 0, 'the same time draws the same pixels');
  const moved = differing(blowing.image, later.image);
  assert.ok(moved > total * 0.01, `0.4 s later the sand has moved: ${moved} pixels`);
  assert.equal(differing(none.image, calm.image), 0, 'below the threshold no sand moves');

  const ridge = await shot({ frame: 0, time: 0, draw: true }, true);
  const after = await shot({ frame: 180, time: 3, draw: true }, true);
  const againAfter = await shot({ frame: 180, time: 3, draw: true }, true);
  const noPlume = await shot({ frame: 180, time: 3, draw: false }, true);
  const snowPixels = differing(after.image, noPlume.image);
  console.log(`TREE-5 ridge plume changes ${snowPixels} pixels, ${after.particles} particles`);
  assert.equal(ridge.particles, 0, 'the initially stationary snow gives the renderer no particles');
  assert.ok(after.crest.mass > 0 && after.crest.velocity[1] > 0 && after.exposedHeight < ridge.exposedHeight);
  assert.ok(snowPixels > 0, 'the transported snow appears on screen');
  assert.equal(
    differing(after.image, againAfter.image),
    0,
    'the same solver revision and clock produce the same pixels',
  );
  assert.deepEqual(pageErrors, []);
  console.log('blown sand check passed');
} finally {
  await context.close();
}
