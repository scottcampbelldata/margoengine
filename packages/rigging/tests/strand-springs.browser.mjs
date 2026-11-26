import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close, hardware } = await openBrowser({
  startPath: '/packages/rigging/tests/strand-springs-render.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.runAvatarStrands === 'function', null, { timeout: 20_000 });
  const proof = await page.evaluate(() => window.runAvatarStrands());
  assert.deepEqual(proof.errors, []);
  assert.deepEqual(errors, []);
  assert.equal(proof.hash, proof.snapshot);
  assert.ok(proof.tick > 0 && proof.error < 2e-6, JSON.stringify(proof));
  assert.ok(proof.tip > 0.02 && proof.changed > 30, JSON.stringify(proof));
  console.log(
    `${hardware.compat ? 'WebGL2' : 'WebGPU'} avatar ponytail: ${proof.changed} wind-driven pixels, ${proof.tip.toFixed(4)} m tip movement, ${proof.hash} snapshot.`,
  );
} finally {
  await close();
}
