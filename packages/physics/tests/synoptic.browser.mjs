import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'synoptic-shared-memory',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/packages/physics/tests/synoptic-render.html',
  port: 'free',
  plugins: [isolation],
});
const notes = [];
const assets = new Set();
page.on('pageerror', ({ message }) => notes.push(message));
page.on('response', (response) => {
  const path = new URL(response.url()).pathname;
  if (path.includes('/synoptic-kernel') && response.ok()) assets.add(path.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runSynoptic === 'function', null, { timeout: 20_000 });
  assert.deepEqual([...assets], []);
  const proof = await page.evaluate(() => window.runSynoptic());
  assert.deepEqual(notes, []);
  assert.deepEqual(proof.errors, []);
  assert.equal(proof.plain, proof.shared);
  assert.deepEqual([...assets].sort(), ['synoptic-kernel-shared.wasm', 'synoptic-kernel.wasm']);
  assert.equal(proof.before.rain, 0);
  assert.ok(proof.after.rain > 0 && proof.after.cloud > proof.before.cloud);
  assert.ok(proof.after.rain > proof.after.snow && proof.cold.snow > proof.cold.rain);
  assert.ok(proof.layerSubsteps > 0 && proof.upper.velocity[0] > proof.after.wind + 5);
  assert.ok(proof.rendered.intensity > 0 && proof.rendered.cover > 0);
  assert.ok(proof.changed > 0, 'the physical cloud and precipitation visibly change the fixed-camera frame');
  console.log(`CF-1 regional precipitation: ${proof.changed} changed pixels, replay ${proof.plain}.`);
} finally {
  await close();
}
