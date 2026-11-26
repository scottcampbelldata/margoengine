import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'strands-shared-memory',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close, hardware } = await openBrowser({
  startPath: '/packages/physics/tests/strands-render.html',
  port: 'free',
  plugins: [isolation],
});
const errors = [];
const assets = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const path = new URL(response.url()).pathname;
  if (path.includes('/strand-kernel') && response.ok()) assets.add(path.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runStrands === 'function', null, { timeout: 20_000 });
  assert.deepEqual([...assets], [], 'loading the scene does not fetch a strand kernel');
  const proof = await page.evaluate(() => window.runStrands());
  assert.deepEqual(proof.faults, []);
  assert.deepEqual(errors, []);
  assert.equal(proof.first, proof.shared);
  assert.equal(proof.first, proof.replay);
  assert.deepEqual([...assets].sort(), ['strand-kernel-shared.wasm', 'strand-kernel.wasm']);
  assert.ok(proof.drawChange > 500 && proof.windChange > 500, JSON.stringify(proof));
  assert.ok(proof.tipMove > 0.06, JSON.stringify(proof));
  console.log(
    `${hardware.compat ? 'WebGL2' : 'WebGPU'} strand fixture: ${proof.points} points, ${proof.windChange} wind-driven pixels, ${proof.tipMove.toFixed(4)} m tip movement, replay ${proof.first}.`,
  );
} finally {
  await close();
}
