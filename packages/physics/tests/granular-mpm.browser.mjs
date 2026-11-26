import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'granular-mpm-shared-memory',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close, hardware } = await openBrowser({
  startPath: '/packages/physics/tests/granular-mpm-render.html',
  port: 'free',
  plugins: [isolation],
});
const errors = [];
const assets = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const path = new URL(response.url()).pathname;
  if (path.includes('/granular-mpm-kernel') && response.ok()) assets.add(path.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runGranularMpm === 'function', null, { timeout: 20_000 });
  assert.equal(assets.size, 0);
  const proof = await page.evaluate(() => window.runGranularMpm());
  assert.deepEqual(proof.faults, []);
  assert.deepEqual(errors, []);
  assert.equal(proof.first, proof.shared);
  assert.equal(proof.first, proof.replay);
  assert.deepEqual([...assets].sort(), ['granular-mpm-kernel-shared.wasm', 'granular-mpm-kernel.wasm']);
  assert.ok(proof.changed > 500 && proof.drop > 0.08 && proof.nodes < 27 * proof.particles, JSON.stringify(proof));
  console.log(
    `${hardware.compat ? 'WebGL2' : 'WebGPU'} granular fixture: ${proof.particles} points, ${proof.nodes} occupied nodes, ${proof.changed} changed pixels, ${proof.drop.toFixed(4)} m drop, replay ${proof.first}.`,
  );
} finally {
  await close();
}
