// Real-GPU check of wind-blown sand (run from the repository root after building packages; MARGO_COMPAT=1 for the
// WebGL2 compatibility layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/blown-sand-check.mjs
// Over a sand floor under a 12 m/s wind the sand changes the frame and adds one draw call; the same time draws the same
// pixels; a later time draws others; under a 3 m/s wind (below the 6.6 m/s threshold) the frame is the frame with no
// sand at all.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/blown-sand-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const output = process.env.MARGO_KEEP_SNOW_RIDGE_FRAMES === '1' ? 'packages/vfx/test-results/snow-ridge' : undefined;
if (output) await mkdir(output, { recursive: true });
const shot = async (args, name) => {
  const r = await page.evaluate(([a, snow]) => (snow ? window.snowStep(a) : window.step(a)), [args, !!name]);
  assert.deepEqual(r.errors, [], JSON.stringify(args));
  const image = await decodePNG(
    await page
      .locator('canvas')
      .screenshot(output && name ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );
  return { ...r, image };
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

  const ridge = await shot({ frame: 0, draw: true }, 'calm');
  const { cue, duration, bulkDensity } = ridge;
  const activeFrame = cue + 216;
  const movingFrame = cue + 300;
  const end = cue + duration;
  const heldStart = await shot({ frame: cue - 1, draw: true }, 'held-start');
  assert.deepEqual(heldStart, ridge);
  const exposed = await shot({ frame: activeFrame, draw: true, action: 'save' }, 'crest-gust');
  const bareAtPeak = await shot({ frame: activeFrame, draw: false }, 'crest-gust-bed');
  const migrating = await shot({ frame: movingFrame, draw: true }, 'lee-transport');
  const deposited = await shot({ frame: end, draw: true }, 'settled');
  assert.deepEqual(await shot({ frame: end + 15, draw: true }, 'held-end'), deposited);
  assert.deepEqual(await shot({ frame: activeFrame, draw: true, action: 'restore' }, 'restored-crest'), exposed);
  assert.deepEqual(await shot({ frame: movingFrame, draw: true }, 'replayed-transport'), migrating);
  assert.deepEqual(await shot({ frame: end, draw: true }, 'replayed-settled'), deposited);
  assert.equal(await page.evaluate(() => window.snowClose()), null);

  assert.equal(ridge.particles, 0, 'the initially stationary snow gives the renderer no particles');
  assert.equal(ridge.ledger.moving, 0);
  // A 17 by 4 square metre powder band, 5.5 cm thick at 120 kg/m³.
  assert(Math.abs(ridge.initialMass - 17 * 4 * 0.055 * bulkDensity) < 1e-8);
  // Half-wave distance of the certified one-cosine gust at the crest.
  const launch = exposed.gust;
  const phase = ((exposed.time - launch.start) * launch.speed + launch.origin[2]) / launch.length;
  const expectedVelocity = 0.5 * launch.amplitude[2] * (1 - Math.cos(2 * Math.PI * phase));
  assert(Math.abs(exposed.air[2] - expectedVelocity) < 1e-11);
  assert(exposed.air[2] > 12 && exposed.crest.velocity[1] > 0);
  assert(exposed.readAccepted && exposed.particles > 0 && exposed.snowDraws === 1);
  assert(exposed.crest.mass > 0.005 && exposed.crown < ridge.crown - 0.00005);
  assert(migrating.leeSaltation.mass > exposed.leeSaltation.mass * 0.75);
  assert(migrating.saltationCenter > exposed.saltationCenter + 0.6);
  assert(deposited.lee > ridge.lee + 0.00001);
  assert(deposited.ledger.moving < exposed.ledger.moving * 1e-4);
  assert(Math.abs(deposited.bedVolume * bulkDensity + deposited.ledger.moving) < 0.001);
  for (const phase of [ridge, exposed, migrating, deposited]) {
    const { mobileBed, moving, outflow, dust } = phase.ledger;
    assert.equal(outflow, 0);
    assert.equal(dust, 0);
    assert(Math.abs(mobileBed + moving - ridge.initialMass) < 1e-8);
    assert(Math.abs(moving - phase.areaMass) < 1e-8);
  }
  const snowPixels = differing(exposed.image, bareAtPeak.image);
  assert(snowPixels > 100, `Visible crest snow is expected, found ${snowPixels} pixels`);
  assert(differing(migrating.image, exposed.image) > 100, 'transport along the ridge must change the plume');
  assert(differing(deposited.image, ridge.image) > 30, 'rendered ridge must show redistributed bed snow');
  console.log(
    `  ${backend} TREE-5 ridge: ${exposed.ledger.moving.toFixed(3)} kg of saltation, ${((ridge.crown - exposed.crown) * 1000).toFixed(3)} mm crest erosion, ${((deposited.lee - ridge.lee) * 1000).toFixed(3)} mm lee gain, ${snowPixels} plume pixels, replay ${deposited.hash}`,
  );
  assert.deepEqual(pageErrors, []);
  console.log('blown sand check passed');
} finally {
  await context.close();
}
