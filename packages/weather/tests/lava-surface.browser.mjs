import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close } = await openBrowser({
  startPath: '/packages/weather/tests/lava-check.html?samples=1',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20_000 });
  const r = await page.evaluate(() => window.check.runPhysical());
  const receipt = JSON.stringify(r);
  assert.equal(r.validation, null, receipt);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  assert.equal(r.compat, process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1');
  assert.equal(r.dryState.active, 0);
  assert.equal(r.dryDiff, 0);
  assert.ok(r.earlyGlow > 0 && r.movingGlow > 0, receipt);
  assert.ok(r.movingState.front > r.earlyState.front && r.motionDiff > 0, receipt);
  assert.ok(r.coldState.maxSkin < r.movingState.maxSkin && r.coldState.crusted > r.movingState.crusted, receipt);
  assert.ok(r.coldGlow === 0 && r.coldDiff > 0, receipt);
  assert.deepEqual(r.replayState, r.earlyState);
  assert.equal(r.replayPixelsEqual, true);
  assert.equal(r.disposedDiff, 0);
  console.log(
    `EARTH-10 ${r.compat ? 'WebGL2' : 'WebGPU'} accepted lava ${r.earlyState.hash}, hot/moving glow ${r.earlyGlow}/${r.movingGlow} px, cooled crust ${r.coldState.crusted} cells and ${r.coldDiff} visible pixels.`,
  );
} finally {
  await close();
}
