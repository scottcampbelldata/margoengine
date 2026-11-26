import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close, hardware } = await openBrowser({
  startPath: '/packages/horses/test/strand-horse-render.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.runStrandHorse === 'function', null, { timeout: 20_000 });
  const proof = await page.evaluate(() => window.runStrandHorse());
  assert.deepEqual(proof.errors, []);
  assert.deepEqual(errors, []);
  assert.equal(proof.gait, 'trot');
  assert.equal(proof.joints, 58);
  assert.equal(proof.first, proof.replay);
  assert.equal(proof.poseEqual, true);
  assert.ok(proof.error < 1e-5, `all three skin tips must sit at the sampled coordinates: ${JSON.stringify(proof)}`);
  assert.ok(proof.tail > 0.06 && proof.mane > 0.02 && proof.forelock > 0.02, JSON.stringify(proof));
  assert.ok(proof.changed > 50, `the same camera must see the simulated tail and mane: ${JSON.stringify(proof)}`);
  console.log(
    `${hardware.compat ? 'WebGL2' : 'WebGPU'} HORSE-1/2: ${proof.changed} pixels, ${proof.tail.toFixed(4)} m tail movement, ${proof.mane.toFixed(4)} m mane, ${proof.forelock.toFixed(4)} m forelock, replay ${proof.first}.`,
  );
} finally {
  await close();
}
