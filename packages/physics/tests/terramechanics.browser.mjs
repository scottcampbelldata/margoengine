import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolated = {
  name: 'terramechanics-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/packages/physics/tests/terramechanics.html',
  port: 'free',
  plugins: [isolated],
});
const errors = [];
const assets = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('terramechanics-kernel') && response.ok()) assets.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runTerramechanics === 'function', null, { timeout: 20_000 });
  assert.deepEqual([...assets], []);
  const { plain, shared } = await page.evaluate(() => window.runTerramechanics());
  assert.ok(plain.min < 0 && plain.max > 0 && plain.mass > 0);
  assert.deepEqual(plain, shared);
  assert.deepEqual([...assets].sort(), ['terramechanics-kernel-shared.wasm', 'terramechanics-kernel.wasm']);
  assert.deepEqual(errors, []);
  console.log(`Browser EARTH-05 native replay ${plain.hash}, rut ${plain.min} m, lofted ${plain.mass} kg.`);
} finally {
  await close();
}
