import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const tunnel = process.argv.includes('--thruster');
const transition = process.argv.includes('--transition');
const { page, hardware, close } = await openBrowser({
  startPath: `/packages/environment/tests/swim-sediment.html${tunnel ? '?thruster' : transition ? '?transition' : ''}`,
  port: 'free',
});
const uncaught = [];
page.on('pageerror', (error) => uncaught.push(error.message));
async function footprintOf(visible, hidden) {
  const [a, b] = await Promise.all([decodePNG(visible), decodePNG(hidden)]);
  let total = 0;
  let moment = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const difference =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    total += difference;
    moment += difference * ((i / 4) % a.width);
    if (difference > 6) count++;
  }
  return { center: moment / total, count };
}
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 20000 });
  const shot = await page.evaluate(() => window.shot);
  const active = (frame) => (tunnel ? frame : shot.start + frame);
  const frame = async (tick, show, action, showRay = true) => {
    const state = await page.evaluate(
      ([tick, show, action, showRay]) => window.step(tick, show, action, showRay),
      [tick, show, action, showRay],
    );
    assert.deepEqual(state.errors, []);
    return { ...state, bytes: await page.locator('canvas').screenshot() };
  };
  const footprint = async (tick, action) => {
    const visible = await frame(tick, true, action);
    const plain = await frame(tick, false);
    return { ...visible, ...(await footprintOf(visible.bytes, plain.bytes)) };
  };
  async function sameFrame(current, expected) {
    const { bytes: actual, ...state } = current;
    const { bytes: reference, ...accepted } = expected;
    const [image, original] = await Promise.all([decodePNG(actual), decodePNG(reference)]);
    assert.ok(
      image.data.every((byte, i) => byte === original.data[i]),
      `Frame ${state.physicalFrame} pixel replay changed`,
    );
    assert.deepEqual(state, accepted);
  }
  const inactive = await footprint(0);
  if (!tunnel) {
    const preTrigger = await footprint(shot.start - 1);
    await sameFrame(preTrigger, inactive);
    assert.equal(inactive.pose.finDisplacement, 0);
    assert.deepEqual(inactive.pose.pectoral.slice(3, 6), [0, 0, 0]);
  }
  const lifted = await footprint(active(5), tunnel ? undefined : 'save');
  async function rayFootprint() {
    const onlyRay = await frame(active(5), false);
    const noRay = await frame(active(5), false, undefined, false);
    return footprintOf(onlyRay.bytes, noRay.bytes);
  }
  const downstream = await footprint(active(20));
  const settled = await footprint(active(180));
  assert.equal(inactive.count, 0);
  assert.equal(inactive.eroded, 0);
  assert.equal(inactive.minHeight, transition ? -0.75 : -0.5);
  assert.equal(inactive.maxHeight, inactive.minHeight);
  assert.ok(lifted.mass > 0 && lifted.count > 40);
  assert.ok(lifted.minHeight < inactive.minHeight);
  assert.ok(Math.abs(lifted.bedVolume * (2650 * 0.6) + lifted.mass) < 1e-9);
  assert.ok(downstream.mass > 0 && downstream.count > 40);
  assert.ok(downstream.center - lifted.center > 8, 'the visible sand moves with the bottom current');
  assert.ok(settled.mass < 1e-12);
  assert.ok(settled.eroded > 0);
  assert.equal(settled.count, 0);
  assert.ok(settled.minHeight < inactive.minHeight && settled.maxHeight > inactive.maxHeight);
  assert.ok(Math.abs(settled.bedVolume - inactive.bedVolume) < 1e-12);
  if (!tunnel) {
    assert.ok(lifted.pose.pectoral[4] < 0, 'the accepted pectoral wake pushes water down toward the bed');
    assert.ok(lifted.pose.pectoral[7] > 0, 'the ray has wetted pectoral fins');
    assert.notDeepEqual(lifted.pose.orientation, inactive.pose.orientation);
    assert.ok(lifted.pose.position[1] > inactive.minHeight && lifted.pose.position[1] < 0);
    for (const state of [lifted, downstream]) {
      assert.equal(state.pose.tipHeights.length, 2);
      const expected = 0.2 * Math.sin((2 * Math.PI * state.physicalFrame) / 60);
      assert.ok(Math.abs(state.pose.finDisplacement - expected) < 1e-12);
      for (const rendered of state.pose.tipHeights) assert.equal(rendered, Math.fround(state.pose.finDisplacement));
    }
    assert.equal(settled.physicalFrame, shot.end);
    await sameFrame(await footprint(shot.start + shot.end + 18), settled);
    await sameFrame(await footprint(active(5), 'restore'), lifted);
    await sameFrame(await footprint(active(20)), downstream);
    await sameFrame(await footprint(active(180)), settled);
  }
  let silhouette;
  if (!tunnel) {
    // Isolate the ray from suspended sand after running the film timeline.
    await sameFrame(await footprint(active(5), 'restore'), lifted);
    silhouette = await rayFootprint();
    assert.ok(silhouette.count > 300, 'the accepted low-profile ray is visible above the sediment bed');
  }
  assert.deepEqual(await page.evaluate(() => window.finish()), { validation: null, errors: [] });
  assert.deepEqual(uncaught, []);
  if (!tunnel && !transition && process.argv.includes('--preview') && !hardware?.compat) {
    await writeFile('test-results/ray-sand-puff.png', lifted.bytes);
  }
  if (!tunnel && !transition && process.env.MARGO_KEEP_RAY_FRAMES === '1') {
    const directory = 'packages/environment/test-results/ray-cutaway';
    const renderer = hardware?.compat ? 'WebGL2' : 'WebGPU';
    await mkdir(directory, { recursive: true });
    for (const [name, { bytes }] of Object.entries({ inactive, lifted, downstream, settled }))
      await writeFile(`${directory}/${renderer}-${name}.png`, bytes);
  }
  console.log(
    `${hardware?.compat ? 'WebGL2 compatibility' : 'WebGPU'}: ${lifted.count} sand pixels at lift, ` +
      `${(downstream.center - lifted.center).toFixed(1)} px downstream, clear after settling, ` +
      `${((settled.maxHeight - settled.minHeight) * 1e6).toFixed(1)} µm bed relief` +
      (lifted.pose
        ? `, ${silhouette.count} ray pixels, ${(lifted.pose.finDisplacement * 100).toFixed(2)} cm fin tip, ${lifted.pose.pectoral[4].toFixed(5)} N·s down, replay ${settled.hash}`
        : ''),
  );
} finally {
  await close();
}
