import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const isolated = {
  name: 'rail-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, hardware, close } = await openBrowser({
  startPath: '/packages/physics/tests/rail.html',
  port: 'free',
  plugins: [isolated],
});
const errors = [];
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const output = 'test-results/dyn05-browser';

function markerCenter(image, [cx, cy]) {
  let pixels = 0;
  let moment = 0;
  const left = Math.max(0, Math.round(cx) - 14);
  const top = Math.max(0, Math.round(cy) - 14);
  for (let y = top; y <= Math.min(image.height - 1, cy + 14); y++) {
    for (let x = left; x <= Math.min(image.width - 1, cx + 14); x++) {
      const i = 4 * (y * image.width + x);
      const [r, g, b] = image.data.subarray(i, i + 3);
      if (g > 1.55 * r && b > 1.27 * r && g > 1.05 * b) {
        pixels++;
        moment += x;
      }
    }
  }
  assert(pixels > 7, `The accepted car must display its survey marker at ${cx.toFixed(1)}, ${cy.toFixed(1)}`);
  return moment / pixels;
}

async function curveFrame(frame, index, file, action) {
  const pose = await page.evaluate((args) => window.curveFrame(args), { frame, index, action });
  const data = await page.locator('canvas').screenshot();
  if (file) await writeFile(`${output}/${backend.toLowerCase()}-curve-${file}.png`, data);
  return { ...pose, image: await decodePNG(data) };
}

page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.railFrame === 'function', null, { timeout: 20000 });
  const first = await page.evaluate(() => window.railFrame(1));
  const before = await decodePNG(await page.locator('canvas').screenshot());
  const last = await page.evaluate(() => window.railFrame(61));
  const screenshot = await page.locator('canvas').screenshot();
  const after = await decodePNG(screenshot);
  const moved = last.distance - first.distance;
  assert.ok(first.shared && last.shared);
  assert.ok(Math.abs(moved - 4) < 1e-9);
  assert.ok(Math.abs(last.wheelTravel - first.wheelTravel - moved) < 1e-9);
  assert.ok(last.headHeight > 4.5 && Math.abs(last.headHeight - first.headHeight) > 0.002);
  assert.deepEqual([...errors, ...first.errors, ...last.errors], []);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta > 25) changed++;
  }
  assert.ok(changed > 2000, `Rendered wagon moved only ${changed} pixels`);
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/${hardware?.compat ? 'webgl2' : 'webgpu'}.png`, screenshot);
  console.log(JSON.stringify({ backend, moved, changed, ...last }));

  const { cue, end, match, station, trackRadius, wheelRadius, speed, outside } = await page.evaluate(() =>
    window.beginCurveTake(),
  );
  const ready = await curveFrame(0, 0);
  assert.deepEqual(await curveFrame(cue - 1, 0), ready);
  const forward = await curveFrame(cue + match, 0, 'forward', 'save');
  const reverse = await curveFrame(cue + match, 1, 'reverse');
  const terminal = await curveFrame(cue + end, 0);
  assert.deepEqual(await curveFrame(cue + end + 17, 0), terminal);
  assert.deepEqual(await curveFrame(cue + match, 0, 'forward-restored', 'restore'), forward);
  assert.deepEqual(await curveFrame(cue + match, 1, 'reverse-restored'), reverse);
  assert.deepEqual(await curveFrame(cue + end, 0), terminal);
  assert.deepEqual(await page.evaluate(() => window.closeRail()), { validation: null, errors: [] });
  assert.deepEqual([...errors, ...forward.errors, ...reverse.errors], []);

  const cars = [forward, reverse];
  const measures = [];
  const lateralAcceleration = (speed * speed) / trackRadius;
  assert.equal(forward.hash, reverse.hash, 'both directions share one accepted world tick');
  assert.ok(Math.abs(forward.car.distance - reverse.car.distance) < 0.02);
  assert.ok(Math.abs(forward.car.roll - reverse.car.roll) < 1e-6);
  assert.ok(Math.abs(forward.car.sway - reverse.car.sway) < 1e-6);
  for (const [i, take] of cars.entries()) {
    const car = take.car;
    const initial = i === 0 ? ready.car : ready.other.car;
    const heading = i === 0 ? 1 : -1;
    assert(take.wetness > 0.99);
    assert(Math.abs(car.distance - station) < 0.012);
    assert(heading * car.speed > 7.98);
    assert(take.railSide > 0.99 && outside[2] < -0.99);
    assert(Math.abs(Math.abs(take.curvature) - 1 / trackRadius) < 1e-9);
    assert(car.roll > 0.04 && take.outward > 0.17, JSON.stringify({ roll: car.roll, outward: take.outward }));
    assert(car.lateralForce < -1000 && car.lostSupport === 0 && !car.derailment);
    assert(car.bogieYaw.some((yaw) => Math.abs(yaw) > 0.0005));
    const activeLoad = car.wheelsets.reduce((total, w) => total + w.leftLoad + w.rightLoad, 0);
    assert(Math.abs(car.longitudinalForce) < 0.121 * activeLoad);
    assert(car.longitudinalForce * car.speed < 0);
    const travel = car.distance - initial.distance;
    for (const axle of car.wheelsets) {
      assert(axle.leftLoad > 0 && axle.rightLoad > 0);
      assert(axle.angle * heading > 0);
      assert(Math.abs(axle.angle * wheelRadius - travel) < 0.005);
      assert(Math.abs(axle.angularVelocity * wheelRadius - car.speed) < 0.005);
    }
    const observed = markerCenter(take.image, take.marker) - take.neutral[0];
    const projected = take.marker[0] - take.neutral[0];
    assert(
      Math.abs(projected) > 5 && Math.abs(observed - projected) < 4,
      JSON.stringify({ observed, projected, marker: take.marker, neutral: take.neutral }),
    );
    measures.push({
      speed: car.speed,
      station: car.distance,
      roll: (180 * car.roll) / Math.PI,
      sway: car.sway,
      outward: take.outward,
      observed,
      lateral: car.lateralForce,
    });
  }
  assert.equal(Math.sign(measures[0].observed), Math.sign(measures[1].observed));
  console.log(JSON.stringify({ backend, lateralAcceleration, measures, replay: forward.hash }));
} finally {
  await close();
}
