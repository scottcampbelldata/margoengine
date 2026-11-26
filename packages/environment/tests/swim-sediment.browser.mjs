import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const tunnel = process.argv.includes('--thruster');
const { page, hardware, close } = await openBrowser({
  startPath: `/packages/environment/tests/swim-sediment.html${tunnel ? '?thruster' : ''}`,
  port: process.argv.includes('--compat') ? 5415 : 5414,
});
const uncaught = [];
page.on('pageerror', (error) => uncaught.push(error.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 20000 });
  const frame = async (tick, show) => {
    const state = await page.evaluate(([tick, show]) => window.step(tick, show), [tick, show]);
    assert.deepEqual(state.errors, []);
    return { ...state, bytes: await page.locator('canvas').screenshot() };
  };
  const footprint = async (tick) => {
    const visible = await frame(tick, true);
    const plain = await frame(tick, false);
    const cloud = await decodePNG(visible.bytes);
    const clear = await decodePNG(plain.bytes);
    let total = 0,
      moment = 0,
      count = 0;
    for (let i = 0; i < cloud.data.length; i += 4) {
      const difference =
        Math.abs(cloud.data[i] - clear.data[i]) +
        Math.abs(cloud.data[i + 1] - clear.data[i + 1]) +
        Math.abs(cloud.data[i + 2] - clear.data[i + 2]);
      total += difference;
      moment += difference * ((i / 4) % cloud.width);
      if (difference > 6) count++;
    }
    return { ...visible, center: moment / total, count };
  };
  const inactive = await footprint(0);
  const lifted = await footprint(5);
  const downstream = await footprint(20);
  const settled = await footprint(180);
  assert.equal(inactive.count, 0);
  assert.equal(inactive.eroded, 0);
  assert.equal(inactive.minHeight, -0.5);
  assert.equal(inactive.maxHeight, -0.5);
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
  assert.deepEqual(uncaught, []);
  if (!tunnel && process.argv.includes('--preview') && !hardware?.compat) {
    await writeFile('test-results/ray-sand-puff.png', lifted.bytes);
  }
  console.log(
    `${hardware?.compat ? 'WebGL2 compatibility' : 'WebGPU'}: ${lifted.count} sand pixels at lift, ` +
      `${(downstream.center - lifted.center).toFixed(1)} px downstream, clear after settling, ` +
      `${((settled.maxHeight - settled.minHeight) * 1e6).toFixed(1)} µm bed relief`,
  );
} finally {
  await close();
}
