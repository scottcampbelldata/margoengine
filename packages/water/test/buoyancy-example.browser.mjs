import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { demoPages } from '../../../scripts/support/site-routes.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
assert.ok(demoPages.includes('buoyancy'));
const browser = await openBrowser({
  port: 'free',
  startPath: '/examples/buoyancy.html',
  openPath: '/tests/modern-game.html',
});
const { page, hardware } = browser;
const backend = hardware.compat ? 'webgl2' : 'webgpu';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = process.env.MARGO_KEEP_BUOYANCY_FRAMES === '1' ? 'test-results' : undefined;
if (output) await mkdir(output, { recursive: true });

const capture = async (id) => {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const image = await page
    .locator('#viewport')
    .screenshot(output && id ? { path: output + '/buoyancy-' + backend + '-' + id + '.png' } : {});
  return decodePNG(image);
};

try {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(new URL('/examples/buoyancy.html', page.url()).href);
  await page.waitForSelector('#viewport[data-ready], #viewport[data-error], [data-no-webgpu]', { timeout: 25000 });
  assert.equal(
    await page.locator('#viewport').getAttribute('data-ready'),
    'true',
    await page.locator('#status').textContent(),
  );
  const state = () =>
    page.locator('#measurement').evaluate((out) => [Number(out.dataset.rise), Number(out.dataset.heel)]);
  const seek = (tick) =>
    page.locator('#time').evaluate((slider, value) => {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, tick);

  const initial = await state();
  const before = await capture('release');
  assert.equal(await page.locator('#play').textContent(), 'Play');
  const showLoads = page.locator('#show-loads');
  const readout = page.locator('#debug-loads');
  const loads = () => readout.evaluate((out) => JSON.parse(out.dataset.loads));
  const waitLoads = (values) =>
    page.waitForFunction(
      (want) => document.querySelector('#debug-loads')?.dataset.loads === want,
      JSON.stringify(values),
    );
  assert.equal(await readout.isVisible(), false);
  await showLoads.check();
  await page.waitForSelector('#debug-loads[data-loads]:not([hidden])');
  const initialLoads = await loads();
  const radius = 0.36;
  const cap = radius + 0.23;
  const displaced = 1000 * Math.PI * cap ** 2 * (radius - cap / 3);
  const dryMass = 82;
  // A sphere carries half the displaced water as added mass. The held force gives the same net acceleration
  // when applied with the body's dry inverse mass and gravity by RigidSolver.
  const heldLift = 9.80665 * (dryMass + ((displaced - dryMass) * dryMass) / (dryMass + 0.5 * displaced));
  assert.ok(Math.abs(initialLoads[0] - heldLift) < 0.001, JSON.stringify({ initialLoads, heldLift }));
  assert.ok(
    initialLoads[1] > 0 && initialLoads[2] < 0,
    'the heeled crate reports an upward load and a restoring torque',
  );
  const overlay = await capture('loads');
  const debugPixels = changedPixels(before, overlay);
  assert.ok(debugPixels > 50, 'the shared debug view draws force and torque arrows over the physical bodies');
  const releaseCyan = cyanLoadPixels(before);
  assert.ok(cyanLoadPixels(overlay) > releaseCyan + 50, 'the renderer draws the cyan load arrows');
  assert.deepEqual(await state(), initial, 'examining the held loads leaves the paused bodies at the same tick');

  await seek(360);
  const settled = await state();
  await page.waitForFunction(
    (release) => document.querySelector('#debug-loads')?.dataset.loads !== release,
    JSON.stringify(initialLoads),
  );
  const settledLoads = await loads();
  assert.ok(
    Math.abs(settledLoads[2]) < Math.abs(initialLoads[2]),
    'the measured righting torque falls as the box rights',
  );
  await showLoads.uncheck();
  assert.equal(await readout.isVisible(), false);
  const after = await capture('righted');
  await page.locator('#reset').click();
  assert.deepEqual(await state(), initial);
  assert.equal(
    cyanLoadPixels(await capture('reset-hidden')),
    releaseCyan,
    'hiding the diagnostic clears the load arrows',
  );
  await showLoads.check();
  await waitLoads(initialLoads);
  await seek(360);
  assert.deepEqual(await state(), settled);
  await waitLoads(settledLoads);
  assert.equal(await page.locator('#elapsed').textContent(), '6.00 s');
  assert.ok(settled[0] - initial[0] > 0.2, 'the real rigid sphere rises more than twenty centimetres');
  assert.ok(Math.abs(initial[1]) > 25 && Math.abs(settled[1]) < 4, 'the real rigid box returns toward upright');
  const changed = changedPixels(before, after);
  assert.ok(changed > 150, 'the physical motion changes the live rendered scene');
  assert.equal(await page.locator('#viewport').getAttribute('data-error'), null);
  console.log(JSON.stringify({ backend, initial, settled, changed, initialLoads, settledLoads, debugPixels }));

  await page.goto(new URL('/examples/cyprus-raft.html?qa=1', page.url()).href);
  await page.waitForSelector('#viewport[data-ready], #viewport[data-error], [data-no-webgpu]', { timeout: 25000 });
  const canvas = page.locator('#viewport');
  assert.equal(await canvas.getAttribute('data-ready'), 'true', await page.locator('#status').textContent());
  const raftState = () =>
    canvas.evaluate(({ dataset }) => ({
      tick: Number(dataset.tick),
      hash: dataset.hash,
      parts: Number(dataset.modelParts),
      pose: JSON.parse(dataset.body),
      surface: Number(dataset.surface),
      wake: Number(dataset.wake),
    }));
  const release = await raftState();
  const picture = await capture();
  assert.equal(release.tick, 0);
  assert.ok(release.parts > 0, 'the real authored raft is present');
  await seek(60);
  const afloat = await raftState();
  assert.equal(afloat.tick, 60);
  assert.ok(Math.abs(afloat.pose.position[1] - release.pose.position[1]) > 0.05, 'the closed float mesh heaves');
  assert.ok(Math.abs(afloat.pose.rotation[0]) > 0.02, 'the uneven water makes the raft heel');
  assert.ok(Math.abs(afloat.wake - release.wake) > 0.004, 'the live wake passes through the raft');
  assert.ok(changedPixels(picture, await capture()) > 150, 'the shared sea and loaded raft move in the rendered scene');
  await seek(0);
  assert.deepEqual(await raftState(), release);
  await seek(60);
  assert.deepEqual(await raftState(), afloat);
  assert.equal(await canvas.getAttribute('data-error'), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ backend, raft: { release, afloat } }));
} finally {
  await closeAll({ browser });
}

function changedPixels(before, after) {
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta > 20) changed++;
  }
  return changed;
}

function cyanLoadPixels(image) {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] < 160 && image.data[i + 1] > 190 && image.data[i + 2] > 220) count++;
  return count;
}
